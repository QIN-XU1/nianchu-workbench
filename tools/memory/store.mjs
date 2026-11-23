#!/usr/bin/env node
/**
 * A7 记忆治理（自研）—— 溯源 + 冲突检测 + TTL
 *
 * 之前 A7 记「部分」，证据只有一句「有经验真实性体检/记忆注入效果体检守卫，无 TTL」——
 * 那两张体检表是 hermes 侧的，TTL 完全没有。
 *
 * 这一层是自研的记忆存储，把「治理」做成可判定的三件事：
 *
 *   1. 溯源（provenance）
 *      每条记忆必须写清「从哪来的」：来源类型、来源位置、写入时间、写入者。
 *      没有来源的记忆不许写入 —— 这是防止「凭印象下结论」进到记忆里。
 *
 *   2. 冲突检测（conflict）
 *      同一 key 两次写入值不同 → 记冲突，两条都留着（不静默覆盖），
 *      并把旧的一条标 superseded。查询时默认只返回最新且未被推翻的，
 *      但**永远能查出历史**。
 *
 *   3. TTL（time-to-live）
 *      每条记忆可带 expiresAt。过期不是删除，是标 expired —— 过期项默认不进结果，
 *      但仍可查（因为「它曾经是什么」本身是信息）。
 *      过期判定基于注入的时钟，不依赖系统时间 —— 这样测试可复现。
 *
 * 四态纪律：
 *   fresh     有效
 *   superseded 被同 key 更新推翻
 *   expired   超过 TTL
 *   conflicted 同 key 存在未解决的分歧（值不同且都未过期）
 *
 * 用法：
 *   node tools/memory/store.mjs put --key=x --value=y --source="file:a.md:12" [--ttl=3600]
 *   node tools/memory/store.mjs get --key=x
 *   node tools/memory/store.mjs list [--all]
 *   node tools/memory/store.mjs gc                 # 清掉已过期+被推翻的（物理删除需显式）
 *   node tools/memory/store.mjs audit              # 治理体检：无源条目/TTL 缺失/冲突未解决
 *   node tools/memory/store.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '../..');
const STORE = path.join(REPO, 'evidence/memory/store.json');

/** 四态 */
export const M = {
  FRESH: 'fresh',
  SUPERSEDED: 'superseded',
  EXPIRED: 'expired',
  CONFLICTED: 'conflicted',
};

export function load() {
  if (!fs.existsSync(STORE)) {
    return { what: '念初记忆存储', rule: '每条必须有来源；同 key 更新不覆盖而是标 superseded；TTL 过期标 expired', at: new Date().toISOString(), entries: [] };
  }
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { what: '念初记忆存储', rule: '', at: new Date().toISOString(), entries: [] }; }
}
export function save(db) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  db.at = new Date().toISOString();
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2) + '\n', 'utf8');
}

function hash(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
}

/**
 * 写入一条记忆。
 *
 * 三条硬规则（不是建议，是拒绝写入的条件）：
 *   · 没有 source → 拒绝。凭印象的东西不许进记忆。
 *   · 同 key 同值 → 更新 lastSeen，不产生新条目（避免重复堆积）
 *   · 同 key 不同值 → 旧条目标 superseded，新条目标 fresh，并记下冲突对
 */
export function put(db, { key, value, source, ttlSec = null, now = new Date(), by = 'agent', onConflict = 'supersede', expectHash = null, disagreement = null }) {
  if (!key || !String(key).trim()) return { ok: false, why: 'key 不能为空' };
  if (value === undefined || value === null || String(value) === '') return { ok: false, why: 'value 不能为空' };
  if (!source || !String(source).trim()) {
    return { ok: false, why: '拒绝写入：没有来源（source）。凭印象的记忆不许进存储 —— 这是溯源底线' };
  }

  // 乐观并发检查（从 openclaw knowledge_correct 的 expectedRevision/expectedHash 借来）
  // 只有调用方显式传 expectHash 时才检查 —— 不传保持旧行为（向后兼容）
  if (expectHash) {
    const chk = checkExpectHash(db, String(key).trim(), expectHash, now);
    if (!chk.ok) return { ok: false, why: chk.why };
  }

  const k = String(key).trim();
  const v = String(value);
  const h = hash(v);
  db.entries = db.entries || [];

  const sameKey = db.entries.filter((e) => e.key === k);
  const liveSameKey = sameKey.filter((e) => e.state === M.FRESH || e.state === M.CONFLICTED);

  // 同 key 同值：只更新 lastSeen
  const identical = liveSameKey.find((e) => e.valueHash === h);
  if (identical) {
    identical.lastSeen = now.toISOString();
    identical.touchCount = (identical.touchCount || 1) + 1;
    return { ok: true, action: 'touch', id: identical.id, why: '同 key 同值，只更新最近确认时间（不产生重复条目）' };
  }

  /**
   * 同 key 不同值 —— 两种策略
   *
   * supersede（默认）：旧的标 superseded，新的赢。适合「明确的更正」。
   * flag：**不选边**。两条都留在 CONFLICTED，查询时 live=null、ambiguous=true。
   *       适合「两个可信来源不一致，需要人来判断」。
   *
   * 为什么要有 flag：默认策略下系统**记录不了分歧** —— 新的静默赢，
   * 查询时返回新的，没有任何地方记录「这里曾经有两个可信来源不一致」。
   */
  const expiresAt = ttlSec ? new Date(now.getTime() + ttlSec * 1000).toISOString() : null;
  const entry = {
    id: 'mem-' + crypto.randomBytes(5).toString('hex'),
    key: k,
    value: v,
    valueHash: h,
    source: String(source),
    by,
    createdAt: now.toISOString(),
    lastSeen: now.toISOString(),
    touchCount: 1,
    ttlSec: ttlSec || null,
    expiresAt,
    state: M.FRESH,
    supersededBy: null,
    supersededAt: null,
    conflictGroup: null,
    resolution: null,
    disagreement: null,
  };

  /**
   * 分歧类型判定（2026-11-15）
   *
   * 有同 key 不同值时，必须知道这是**哪种**分歧，因为处理方式不同：
   *   correction / temporal_change → 可自动取代（新的赢，旧的留历史）
   *   source_conflict              → 不许自动选边，必须 resolve
   *   未声明                       → 默认按 correction，但记 assumed:true
   *                                  （audit 会统计「假定的纠正」，便于回头补声明）
   */
  let disagreeKind = null;
  let disagreeAssumed = false;
  if (liveSameKey.length > 0) {
    if (disagreement) {
      if (!Object.values(DISAGREEMENT).includes(disagreement)) {
        return { ok: false, why: '未知的分歧类型：' + disagreement + '（可选：' + Object.values(DISAGREEMENT).join(' / ') + '）' };
      }
      disagreeKind = disagreement;
    } else {
      disagreeKind = DISAGREEMENT.CORRECTION;
      disagreeAssumed = true;
    }
  }

  // source_conflict 强制走「不选边」路径
  if (disagreeKind === DISAGREEMENT.SOURCE_CONFLICT) onConflict = 'flag';

  if (onConflict === 'flag' && liveSameKey.length > 0) {
    // 不选边：新条目和被撞的旧条目都标 conflicted
    // 【注意】必须有 liveSameKey.length > 0 才走这里 ——
    // 首次写入没有「旧条目」，那是 create 不是 conflict。
    const group = [entry.id, ...liveSameKey.map((e) => e.id)];
    entry.state = M.CONFLICTED;
    entry.disagreement = { kind: disagreeKind, assumed: disagreeAssumed };
    entry.conflictGroup = group;
    entry.conflictWith = liveSameKey.map((e) => ({ id: e.id, value: e.value, source: e.source }));
    for (const old of liveSameKey) {
      old.state = M.CONFLICTED;
      old.conflictGroup = group;
    }
    db.entries.push(entry);
    return {
      ok: true,
      action: 'conflict',
      id: entry.id,
      conflictWith: liveSameKey.map((e) => e.id),
      disagreement: { kind: disagreeKind, assumed: disagreeAssumed },
      why: '同 key 不同值：已记为**未解决冲突**（' + group.length + ' 条候选）。'
        + '查询返回 live=null · 必须用 resolve --key --choose --why 显式解决',
    };
  }

  // 默认策略：supersede
  let conflictWith = [];
  for (const old of liveSameKey) {
    if (old.valueHash !== h) {
      old.state = M.SUPERSEDED;
      old.supersededBy = null;   // 下面填
      old.supersededAt = now.toISOString();
      conflictWith.push(old.id);
    }
  }

  if (conflictWith.length) {
    entry.disagreement = { kind: disagreeKind, assumed: disagreeAssumed };
    entry.conflictGroup = [entry.id, ...conflictWith];
    for (const oldId of conflictWith) {
      const old = db.entries.find((e) => e.id === oldId);
      if (old) old.supersededBy = entry.id;
    }
  }
  db.entries.push(entry);
  return {
    ok: true,
    action: conflictWith.length ? 'supersede' : 'create',
    id: entry.id,
    disagreement: conflictWith.length ? { kind: disagreeKind, assumed: disagreeAssumed } : null,
    why: conflictWith.length
      ? '同 key 值不同：旧条目已标 superseded（' + conflictWith.join(',') + '），旧值仍可查'
      : '新建记忆',
    conflictWith,
  };
}
// 占位函数，仅用于让上面对象的字段初始化不报错（立即被覆盖）
function entry_placeholder_never_used() { return null; }

/** 计算某条在当前时刻的实际状态（TTL 是算出来的，不是存的） */
export function effectiveState(entry, now = new Date()) {
  if (entry.state === M.SUPERSEDED) return M.SUPERSEDED;
  if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= now.getTime()) return M.EXPIRED;
  // 冲突：同 key 有另一条 fresh 且值不同
  return entry.state === M.CONFLICTED ? M.CONFLICTED : M.FRESH;
}

/** 查一条 key 的当前值（默认只返回 fresh；--all 才看历史） */
export function get(db, key, { now = new Date(), includeHistory = false } = {}) {
  const all = (db.entries || []).filter((e) => e.key === key);
  const withState = all.map((e) => ({ ...e, effective: effectiveState(e, now) }));
  const live = withState.filter((e) => e.effective === M.FRESH);
  /**
   * 冲突候选 = 未解决的 conflicted 条目
   *
   * 【2026-11-15 修 · 自检抓到的真缺陷】
   * 原来 ambiguous 只看 `live.length > 1`。但冲突模式下 live 是 0 条
   * （所有条目都是 CONFLICTED）⇒ `ambiguous = false`。
   * 于是调用方看到的是「没有值、也没有歧义」—— **看不出这里有分歧**。
   * 那等于把冲突藏起来了，和「记录不了分歧」是同一个毛病换了个地方。
   *
   * 现在：有 conflicted 候选时 ambiguous 必须为 true，并把候选列出来。
   */
  const conflicted = withState.filter((e) => e.effective === M.CONFLICTED);
  return {
    key,
    live: live.length ? live[live.length - 1] : null,
    liveCount: live.length,
    ambiguous: live.length > 1 || conflicted.length > 0,
    conflict: conflicted.length
      ? {
        count: conflicted.length,
        candidates: conflicted.map((e) => ({ id: e.id, value: e.value, source: e.source, createdAt: e.createdAt })),
        hint: '未解决冲突：必须用 resolve --key ' + key + ' --choose <id> --why "<理由>" 显式解决',
      }
      : null,
    history: includeHistory ? withState.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))) : undefined,
  };
}

/** 治理体检：找出不达标的记忆 */
export function audit(db, { now = new Date(), soonSec = 86400 } = {}) {
  const entries = db.entries || [];
  const issues = {
    noSource: [],
    expired: [],
    superseded: [],
    unresolvedConflict: [],
  };
  const byKey = new Map();
  for (const e of entries) {
    if (!e.source || !String(e.source).trim()) issues.noSource.push(e.id);
    const st = effectiveState(e, now);
    if (st === M.EXPIRED) issues.expired.push(e.id);
    if (st === M.SUPERSEDED) issues.superseded.push(e.id);
    if (st === M.FRESH) {
      if (!byKey.has(e.key)) byKey.set(e.key, []);
      byKey.get(e.key).push(e);
    }
  }
  for (const [k, list] of byKey) {
    const hashes = new Set(list.map((e) => e.valueHash));
    if (hashes.size > 1) {
      issues.unresolvedConflict.push({ key: k, count: list.length, hashes: [...hashes] });
    }
  }
  // 「即将过期」：现在新鲜、但会在 soonSec 内到期 —— 事前预警（原 audit 只有事后的 expired）
  const soonMs = Number(soonSec) > 0 ? Number(soonSec) * 1000 : 0;
  const expiringSoon = soonMs
    ? entries.filter((e) => {
      if (effectiveState(e, now) !== M.FRESH) return false;
      if (!e.expiresAt) return false;
      const et = new Date(e.expiresAt).getTime();
      return Number.isFinite(et) && et > now.getTime() && et <= now.getTime() + soonMs;
    }).map((e) => ({ id: e.id, key: e.key, expiresAt: e.expiresAt }))
    : [];
  const total = entries.length;
  const fresh = entries.filter((e) => effectiveState(e, now) === M.FRESH).length;
  // 「假定的纠正」：调用方没声明分歧类型，系统按 correction 处理了
  // 这不是错，但值得回头补声明 —— 审计把它数出来。
  const assumedCorrections = entries.filter((e) => e.disagreement && e.disagreement.assumed === true).length;
  return {
    total,
    fresh,
    ...issues,
    assumedCorrections,
    expiringSoon,
    ok: issues.noSource.length === 0 && issues.unresolvedConflict.length === 0,
    at: now.toISOString(),
  };
}

/**
 * 物理清理：删掉「已过期 且 已被推翻」的（两者都满足才删）
 *
 * ⚠ 这里不能用 effectiveState 判过期 —— 它遇到 SUPERSEDED 就提前返回，
 *   永远看不清「被推翻的同时是否也过期」。第一版就是这样，导致 gc 一条都删不掉。
 *   所以单独算 isExpired。
 */
export function gc(db, { now = new Date() } = {}) {
  const before = (db.entries || []).length;
  const removed = [];
  const isExpired = (e) => !!(e.expiresAt && new Date(e.expiresAt).getTime() <= now.getTime());
  db.entries = (db.entries || []).filter((e) => {
    if (e.state === M.SUPERSEDED && isExpired(e)) { removed.push(e.id); return false; }
    return true;
  });
  return { removed: removed.length, ids: removed, before, after: db.entries.length };
}

/**
 * 记录冲突（不自动选边）
 *
 * ── 为什么需要这个（2026-11-15）──────────────────────────
 * 原来的 put() 遇到「同 key 不同值」**总是**把旧的标 superseded —— 新的静默赢。
 * 后果：系统**记录不了分歧**。
 *
 *   例：source A 说「端口是 8080」，source B 说「端口是 9090」。
 *   旧行为：后写的那条赢，前一条变 superseded，查询时返回后写的，
 *           **没有任何地方记录「这里曾经有两个可信来源不一致」**。
 *   这正是 22 个参照系统里多数记忆系统的通病：假装没有冲突。
 *
 * 新行为（显式选择）：
 *   put({ onConflict: 'flag' })  → 不选边，两条都留在 CONFLICTED，
 *                                  get() 返回 live=null + ambiguous=true + 候选列表
 *   要选边必须显式 `resolve()`，且必须写**为什么**选它 —— 留痕。
 *
 * 默认仍是 'supersede'（向后兼容），但这个选项让「记录分歧」成为可能。
 */
export function putConflict(db, { key, value, source, ttlSec = null, now = new Date(), by = 'agent' }) {
  return put(db, { key, value, source, ttlSec, now, by, onConflict: 'flag' });
}

/**
 * 显式解决冲突 —— 必须说明理由，留痕
 *
 * @param {string} chooseId  选哪一条作为有效值
 * @param {string} why       为什么选它（必填）—— 这是「判断类事情不机械化」的体现：
 *                           机制不替你决定，但要求你留下决定的理由
 */
export function resolve(db, { key, chooseId, why, now = new Date(), by = 'agent' }) {
  if (!key) return { ok: false, why: 'key 不能为空' };
  if (!chooseId) return { ok: false, why: '必须指定 chooseId（选哪一条）' };
  if (!why || !String(why).trim()) {
    return { ok: false, why: '必须写理由（why）—— 冲突解决不许无痕' };
  }
  const all = (db.entries || []).filter((e) => e.key === String(key).trim());
  const chosen = all.find((e) => e.id === chooseId);
  if (!chosen) return { ok: false, why: '找不到 ' + chooseId };
  if (effectiveState(chosen, now) === M.SUPERSEDED) {
    return { ok: false, why: '不能选一条已被推翻的条目' };
  }

  const others = all.filter((e) => e.id !== chooseId && effectiveState(e, now) === M.CONFLICTED);
  for (const o of others) {
    o.state = M.SUPERSEDED;
    o.supersededBy = chooseId;
    o.supersededAt = now.toISOString();
  }
  chosen.state = M.FRESH;
  chosen.resolution = {
    at: now.toISOString(),
    by,
    why: String(why),
    rejected: others.map((o) => ({ id: o.id, value: o.value, source: o.source })),
  };
  return { ok: true, chosen: chooseId, rejected: others.map((o) => o.id), why: String(why) };
}

/**
 * 四种分歧类型 —— 从 openclaw 的 knowledge-correct SKILL.md 借来的区分
 *
 * ── 原文（L25-26）────────────────────────────────────────
 *   "Distinguish an erroneous saved assertion from an unsupported answer,
 *    conflicting source statements, and a fact that changed over time.
 *    Contradiction alone does not authorize supersession"
 *
 * ── 为什么这个区分重要 ──────────────────────────────────
 * 我们原来的冲突状态只有一个笼统的 `CONFLICTED`。
 * 但「有冲突」不等于「都需要人来判断」：
 *
 *   correction       错误断言 → 直接纠正（新的赢，旧的留历史）
 *   temporal_change  事实随时间变化 → 不是冲突，是演进（新的赢，但两条都标明时间）
 *   source_conflict  两个可信来源互相矛盾 → **必须人来判断**，不许自动选边
 *   unsourced        新的说法没有来源 → 拒绝写入（已在 source 检查里拦掉）
 *
 * 把这四种混成一种，等于把判断责任推给使用者 ——
 * 他不知道该纠正、该等、还是该找人。
 *
 * 分开它们，才是「判不了就说判不了」的具体化：
 * **只有 source_conflict 是真的「判不了」，其余两种系统能判。**
 */
export const DISAGREEMENT = {
  CORRECTION: 'correction',
  TEMPORAL: 'temporal_change',
  SOURCE_CONFLICT: 'source_conflict',
  UNSOURCED: 'unsourced',
};

export const DISAGREEMENT_MEANING = {
  correction: '错误断言：新的是对旧错的纠正 → 可自动取代',
  temporal_change: '事实随时间变化：不是矛盾，是演进 → 可自动取代，但两条都标时间',
  source_conflict: '两个可信来源互相矛盾 → **必须显式 resolve**，不许自动选边',
  unsourced: '新的说法没有来源 → 拒绝写入',
};

export function revert(db, { key, toEntryId, why, now = new Date(), by = 'agent' }) {
  if (!key) return { ok: false, why: 'key 不能为空' };
  if (!toEntryId) return { ok: false, why: '必须指定 toEntryId（回到哪一条）' };
  if (!why || !String(why).trim()) return { ok: false, why: '必须写理由（why）—— 回滚也要留痕' };

  const all = (db.entries || []).filter((e) => e.key === String(key).trim());
  const target = all.find((e) => e.id === toEntryId);
  if (!target) return { ok: false, why: '找不到 ' + toEntryId };
  if (effectiveState(target, now) === M.EXPIRED) {
    return { ok: false, why: '目标条目已过期，不能回滚到它' };
  }

  const currentlyLive = all.filter((e) => e.id !== toEntryId
    && [M.FRESH, M.CONFLICTED].includes(effectiveState(e, now)));

  const revertedFrom = [];
  for (const e of currentlyLive) {
    e.state = M.SUPERSEDED;
    e.supersededBy = toEntryId;
    e.supersededAt = now.toISOString();
    revertedFrom.push({ id: e.id, value: e.value, source: e.source });
  }

  target.state = M.FRESH;
  target.revertedTo = {
    at: now.toISOString(),
    by,
    why: String(why),
    revertedFrom,
  };

  return { ok: true, to: toEntryId, revertedFrom: revertedFrom.map((x) => x.id), why: String(why) };
}

/**
 * 乐观并发检查 —— 防止「我以为当前值是 X，实际是 Y」的丢失更新
 *
 * ── 从哪学的 ──────────────────────────────────────────────
 * openclaw 的 knowledge_correct 要求 `expectedRevision` + `expectedHash`
 * （SKILL.md L36）。调用方必须声明「我看到的是哪个版本」，否则拒绝。
 *
 * 我们原来没有这个 —— put() 直接覆盖。两个 agent 同时改同一个 key 时，
 * 后写的会静默覆盖先写的，而前者以为自己成功了。
 *
 * 用法：put({ ..., expectHash }) —— 传了就强制校验，不传保持旧行为。
 */
export function checkExpectHash(db, key, expectHash, now = new Date()) {
  if (!expectHash) return { ok: true };
  const g = get(db, key, { now });
  if (!g.live) {
    // 没有当前值却声称知道 hash ⇒ 不一致
    return { ok: false, why: '声称当前 hash 是 ' + expectHash + '，但该 key 没有有效值' };
  }
  if (g.live.valueHash !== expectHash) {
    return {
      ok: false,
      why: '乐观并发失败：你期望 hash=' + expectHash + '，实际=' + g.live.valueHash
        + '（有人先改了）。请重读后再写。',
    };
  }
  return { ok: true };
}







// ── 自检（离线，用注入时钟保证可复现）──
export function selfTest() {
  const cases = [];
  // 统一断言入口（2026-11-16）：原文件用 T('名', 条件)，
  // 审计器扫不到标签。包一层 T，不改任何断言逻辑。
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const now0 = new Date('2026-01-01T00:00:00Z');
  const mk = () => ({ entries: [] });

  // 1) 无来源拒绝
  let db = mk();
  const r1 = put(db, { key: 'k', value: 'v', source: '', now: now0 });
  T('无来源拒绝写入', r1.ok === false && /没有来源/.test(r1.why));
  T('拒绝后存储为空', db.entries.length === 0);

  // 2) 正常写入
  db = mk();
  const r2 = put(db, { key: 'build.cmd', value: 'vite build', source: 'file:package.json:8', now: now0 });
  T('正例 · 有来源可写入', r2.ok === true && db.entries.length === 1);
  T('正例 · 记录来源', db.entries[0]?.source === 'file:package.json:8');
  T('正例 · 记写入时间', db.entries[0]?.createdAt === now0.toISOString());

  // 3) 同 key 同值 → touch 不新增
  const r3 = put(db, { key: 'build.cmd', value: 'vite build', source: 'file:package.json:8', now: new Date(now0.getTime() + 1000) });
  T('正例 · 同 key 同值只 touch', r3.action === 'touch' && db.entries.length === 1);
  T('正例 · touchCount 累加', db.entries[0]?.touchCount === 2);

  // 4) 同 key 不同值 → supersede，旧值仍可查
  const r4 = put(db, { key: 'build.cmd', value: 'vite build --minify', source: 'file:package.json:9', now: new Date(now0.getTime() + 2000) });
  T('同 key 不同值触发 supersede', r4.action === 'supersede' && db.entries.length === 2);
  const g4 = get(db, 'build.cmd', { now: new Date(now0.getTime() + 3000), includeHistory: true });
  T('正例 · 当前值是最新那条', g4.live && g4.live.value === 'vite build --minify');
  T('正例 · 历史仍可查', g4.history.length === 2);
  T('旧条目状态 superseded', g4.history.some((e) => e.effective === M.SUPERSEDED));

  // 5) TTL 过期
  db = mk();
  put(db, { key: 'temp.token', value: 'abc', source: 'api:/token', ttlSec: 60, now: now0 });
  const g5a = get(db, 'temp.token', { now: new Date(now0.getTime() + 30000) });
  const g5b = get(db, 'temp.token', { now: new Date(now0.getTime() + 61000) });
  T('TTL 内有效', g5a.live !== null);
  T('TTL 过期后不在结果里', g5b.live === null);
  T('过期不是删除（历史还在）', get(db, 'temp.token', { now: new Date(now0.getTime() + 61000), includeHistory: true }).history.length === 1);
  T('过期状态算得出来', effectiveState(db.entries[0], new Date(now0.getTime() + 61000)) === M.EXPIRED);

  // 6) 冲突检测
  db = mk();
  put(db, { key: 'port', value: '3425', source: 'file:a.md:1', now: now0 });
  // 手工造两条 fresh 同 key 不同值（模拟并发写入绕过 supersede）
  db.entries.push({ ...db.entries[0], id: 'mem-x', value: '8080', valueHash: hash('8080'), state: M.FRESH });
  const a6 = audit(db, { now: now0 });
  T('审计发现未解决冲突', a6.unresolvedConflict.length === 1);
  T('审计标记不达标', a6.ok === false);

  // 7) 审计无源条目
  db = mk();
  db.entries.push({ id: 'mem-y', key: 'k', value: 'v', valueHash: hash('v'), source: '', state: M.FRESH, createdAt: now0.toISOString() });
  const a7 = audit(db, { now: now0 });
  T('审计发现无源条目', a7.noSource.length === 1);

  // 8) gc 只删「过期且被推翻」
  db = mk();
  db.entries.push(
    { id: 'm1', key: 'a', value: '1', valueHash: hash('1'), source: 's', state: M.SUPERSEDED, expiresAt: new Date(now0.getTime() - 1000).toISOString(), createdAt: now0.toISOString() },
    { id: 'm2', key: 'b', value: '2', valueHash: hash('2'), source: 's', state: M.FRESH, expiresAt: new Date(now0.getTime() - 1000).toISOString(), createdAt: now0.toISOString() },
    { id: 'm3', key: 'c', value: '3', valueHash: hash('3'), source: 's', state: M.FRESH, createdAt: now0.toISOString() },
  );
  const g8 = gc(db, { now: now0 });
  T('gc 只删过期且被推翻的', g8.removed === 1 && db.entries.length === 2);
  T('gc 不删仅过期的（保历史）', db.entries.some((e) => e.id === 'm2'));
  T('gc 不删有效的', db.entries.some((e) => e.id === 'm3'));

  const bad = cases.filter(([, okv]) => !okv);
  return {
    pass: cases.length - bad.length,
    total: cases.length,
    ok: bad.length === 0,
    lines: cases.map(([n, okv]) => '  ' + (okv ? '✓' : '✗') + ' ' + n).join('\n'),
  };
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const flag = (n, d = null) => {
    const hit = process.argv.find((a) => a.startsWith('--' + n + '='));
    return hit ? hit.split('=').slice(1).join('=') : d;
  };
  const pos = (n) => process.argv.slice(2).filter((a) => !a.startsWith('--'))[n];
  const cmd = pos(0);

  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  A7 记忆治理 · 离线自检（注入时钟，可复现）');
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    console.log('  扩展自检（冲突/回滚/分歧类型）在 store.selftests.mjs：');
    console.log('      node tools/memory/store.selftests.mjs');
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const db = load();

  if (cmd === 'put') {
    const ttl = flag('ttl');
    const r = put(db, {
      key: flag('key'), value: flag('value'), source: flag('source'),
      ttlSec: ttl ? Number(ttl) : null,
      // --conflict=flag：不选边，记为未解决冲突（需要 resolve）
      onConflict: flag('conflict') === 'flag' ? 'flag' : 'supersede',
      // --disagreement=correction|temporal_change|source_conflict|unsourced
      //   有同 key 不同值时必须知道这是哪种分歧，处理方式不同
      disagreement: flag('disagreement') || null,
    });
    if (r.ok) save(db);
    console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + (r.why || ''));
    if (r.ok && r.disagreement) {
      console.log('    分歧类型: ' + r.disagreement.kind + (r.disagreement.assumed ? '（**未声明，系统假定**）' : '（已声明）'));
    }
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'revert') {
    const r = revert(db, {
      key: flag('key'), toEntryId: flag('to'), why: flag('why'),
    });
    if (r.ok) save(db);
    console.log('  ' + (r.ok ? '✓ 已回滚' : '✗ ' + r.why));
    if (r.ok) {
      console.log('    回到: ' + r.to);
      console.log('    推开: ' + (r.revertedFrom.length ? r.revertedFrom.join(', ') : '（无）'));
      console.log('    理由: ' + r.why);
    }
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'resolve') {
    const r = resolve(db, {
      key: flag('key'), chooseId: flag('choose'), why: flag('why'),
    });
    if (r.ok) save(db);
    console.log('  ' + (r.ok ? '✓ 已解决冲突' : '✗ ' + r.why));
    if (r.ok) {
      console.log('    选中: ' + r.chosen);
      console.log('    推翻: ' + (r.rejected.length ? r.rejected.join(', ') : '（无）'));
      console.log('    理由: ' + r.why);
    }
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'get') {
    const g = get(db, flag('key') || pos(1), { includeHistory: process.argv.includes('--all') });
    if (!g.live) {
      console.log('  （没有有效条目）' + (g.history && g.history.length ? ' 历史 ' + g.history.length + ' 条' : ''));
    } else {
      console.log('  ' + g.live.value);
      console.log('  来源: ' + g.live.source + '  写入: ' + g.live.createdAt);
      if (g.live.expiresAt) console.log('  过期: ' + g.live.expiresAt);
    }
    if (g.ambiguous) {
      // 【2026-11-15 修】原来用 g.liveCount（冲突时是 0），显示成「0 条有效记录（冲突）」
      // 应该报冲突候选数，并把候选列出来
      if (g.conflict) {
        console.log('  ⚠ 未解决冲突：' + g.conflict.count + ' 条候选（必须显式 resolve）');
        for (const c of g.conflict.candidates) {
          console.log('      · ' + c.id + '  ' + String(c.value).slice(0, 40) + '   来源 ' + c.source);
        }
      } else {
        console.log('  ⚠ 同 key 有 ' + g.liveCount + ' 条有效记录（冲突）');
      }
    }
    // 退出码语义：
    //   0 = 有有效值
    //   1 = 没有有效值（过期/被推翻）—— 但带 --all 且确实查到历史时仍是 1，
    //       因为「读不到当前值」这个事实不该被历史的存在掩盖
    //   2 = key 不存在（连历史都没有）
    const hasAny = g.history ? g.history.length > 0 : g.live !== null;
    process.exit(g.live ? 0 : hasAny ? 1 : 2);
  }

  if (cmd === 'list') {
    const showAll = process.argv.includes('--all');
    const rows = (db.entries || []).filter((e) => showAll || effectiveState(e) === M.FRESH);
    console.log('');
    console.log('  记忆条目（' + rows.length + ' 条' + (showAll ? '，含历史' : '，仅有效') + '）');
    console.log('  ' + '─'.repeat(70));
    for (const e of rows) {
      const st = effectiveState(e);
      console.log('  ' + (st === M.FRESH ? '✓' : st === M.EXPIRED ? '⌛' : st === M.SUPERSEDED ? '↩' : '✗') +
        ' ' + String(e.key).padEnd(24) + String(e.value).slice(0, 30).padEnd(32) + st);
      console.log('      ' + e.source);
    }
    console.log('');
    process.exit(0);
  }

  if (cmd === 'audit') {
    const a = audit(db);
    console.log('');
    console.log('  记忆治理体检');
    console.log('  ' + '─'.repeat(60));
    console.log('  总计 ' + a.total + ' 条 · 有效 ' + a.fresh);
    console.log('  无来源      ' + a.noSource.length);
    console.log('  已过期      ' + a.expired.length);
    // expiringSoon 必须在 CLI 真打出来 —— 只加返回值不显示 = 看起来有实际是空

    console.log('  即将过期    ' + (a.expiringSoon || []).length + (a.expiringSoon && a.expiringSoon.length ? '（24h 内，需复核/续期）' : ''));
    if (a.expiringSoon && a.expiringSoon.length) {
      for (const e of a.expiringSoon) console.log('    ! ' + e.key + '  ' + e.expiresAt);
    }
    console.log('  被推翻      ' + a.superseded.length);
    console.log('  未解决冲突  ' + a.unresolvedConflict.length);
    if (a.unresolvedConflict.length) {
      for (const c of a.unresolvedConflict) console.log('    ✗ ' + c.key + ' 有 ' + c.count + ' 条不同值');
    }
    console.log('');
    console.log('  ' + (a.ok ? '✓ 治理达标' : '✗ 治理不达标'));
    console.log('');
    process.exit(a.ok ? 0 : 1);
  }

  if (cmd === 'gc') {
    const r = gc(db);
    save(db);
    console.log('  ✓ 清掉 ' + r.removed + ' 条（' + r.before + ' → ' + r.after + '）');
    console.log('    只删「已过期且已被推翻」的；仅过期或仅被推翻的都保留（历史是信息）');
    process.exit(0);
  }

  console.error('');
  console.error('  用法: put/get/resolve/revert/list/audit/gc，或 --selftest');
  console.error('');
  process.exit(2);
}