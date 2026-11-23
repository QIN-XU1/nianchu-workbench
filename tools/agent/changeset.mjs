#!/usr/bin/env node
/**
 * 念初 · 变更集（diff 预览 + 回滚）
 *
 * ══ 为什么必须有这一层 ═══════════════════════════════════════
 * 上一轮 agent 已经能真改文件了。但"能改"和"敢让它改"是两件事：
 *   · 改之前不知道它要改什么 → 需要一个 diff 预览
 *   · 改坏了退不回去 → 需要一次能整体回滚
 * 没有这两样，让人用 agent 动生产代码是不负责任的。
 *
 * ══ 怎么做的 ═════════════════════════════════════════════════
 * 不改工具本身：在 write/edit 真正落盘**之前**，把原内容抓下来存在内存变更集里。
 * 一次 agent 运行 = 一个变更集：
 *   beginSet → （每次写前 recordBefore）→ endSet（算 diff）→ 可选 rollback
 *
 * 回滚语义（明确写死，避免"以为回滚了其实没有"）：
 *   · 原来不存在的文件 → 回滚时**删除**
 *   · 原来存在的文件   → 回滚时**恢复原内容**（逐字节）
 *   · 回滚后校验：文件内容与 beginSet 时一致才算成功；不一致如实报 FAIL
 *
 * 边界如实说：变更集在**内存**里，进程退出即丢；没有持久化、没有跨进程回滚。
 * 只覆盖通过本工具集 write/edit 的改动；bash 里 `rm`/`git checkout` 之类的副作用管不了。
 */
import {
  existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { USER_DATA_DIR } from './runtime.mjs';
import {
  encryptText, decryptText, encryptBase64, decryptBase64, maskSecrets, looksSensitive, hasKey,
} from './secretbox.mjs';

const MAX_DIFF_LINES = 4000;
/** 单文件记录上限。2MB 实测容易把配置/源码挡在外面，提到 8MB；更大的仍如实报「无法回滚」 */
const MAX_DIFF_BYTES = 8 * 1024 * 1024;

/** 进行中的变更集：setId → { id, at, cwd, label, files: Map<abs, {before, after, existed}> } */
const SETS = new Map();

/**
 * 变更集落盘目录。
 *
 * 【为什么必须落盘】之前变更集只在内存里，进程一重启就没了 ——
 * 意味着「你刚才让 agent 改的那批文件，服务重启后回滚不了」。
 * 那不是"完整的功能"，是个隐患。现在每个变更集 endSet 时写一个 json，
 * 启动/查询时按需从磁盘加载。
 */
function changesetDir() {
  const d = join(USER_DATA_DIR, 'changesets');
  mkdirSync(d, { recursive: true });
  return d;
}

function serialize(set) {
  return {
    id: set.id, at: set.at, cwd: set.cwd, label: set.label,
    closed: set.closed === true, rolledBack: set.rolledBack === true,
    files: [...set.files.entries()].map(([path, rec]) => ({
      path, existed: rec.existed,
      /**
       * 落盘一律**加密**：变更集里是源码原文，可能含密钥/token/内网地址。
       * 加密而不是"脱敏后存" —— 脱敏会破坏回滚的字节精确性。
       * 如果密钥不可用（encryptText 返回 null），退回明文但要标出来，不假装加密了。
       */
      beforeEnc: encryptText(rec.before ?? null),
      afterEnc: encryptText(rec.after ?? null),
      beforeBase64Enc: encryptBase64(rec.beforeBase64 ?? null),
      encrypted: Boolean(encryptText(rec.before ?? null) || encryptText(rec.after ?? null) || encryptBase64(rec.beforeBase64 ?? null)),
      source: rec.source || 'tool',
      note: rec.note ?? null,
      tooBig: rec.tooBig === true, unreadable: rec.unreadable === true,
    })),
  };
}

function deserialize(obj) {
  if (!obj || !obj.id) return null;
  const set = {
    id: obj.id, at: obj.at, cwd: obj.cwd, label: obj.label,
    closed: obj.closed === true, rolledBack: obj.rolledBack === true,
    files: new Map(),
  };
  for (const f of obj.files || []) {
    set.files.set(f.path, {
      existed: f.existed,
      // 兼容旧格式（明文 before/after）与新格式（密文盒）
      before: f.before ?? null,
      after: f.after ?? null,
      beforeBase64: f.beforeBase64 ?? null,
      beforeEnc: f.beforeEnc ?? null,
      afterEnc: f.afterEnc ?? null,
      beforeBase64Enc: f.beforeBase64Enc ?? null,
      encrypted: f.encrypted === true,
      source: f.source || 'tool',
      note: f.note ?? null,
      tooBig: f.tooBig === true, unreadable: f.unreadable === true,
    });
  }
  return set;
}

function persist(set) {
  try {
    writeFileSync(join(changesetDir(), set.id + '.json'), JSON.stringify(serialize(set)) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 从磁盘按 id 找（内存里没有时用） */
function loadFromDisk(id) {
  try {
    const p = join(changesetDir(), id + '.json');
    if (!existsSync(p)) return null;
    const set = deserialize(JSON.parse(readFileSync(p, 'utf8')));
    if (set) SETS.set(set.id, set);
    return set;
  } catch {
    return null;
  }
}

export function beginSet({ cwd = process.cwd(), label = '' } = {}) {
  const id = 'cs-' + randomUUID().replace(/-/g, '').slice(0, 16);
  const set = { id, at: new Date().toISOString(), cwd, label, files: new Map(), closed: false, rolledBack: false };
  SETS.set(id, set);
  return set;
}

export function getSet(id) {
  return SETS.get(id) || loadFromDisk(id) || null;
}

export function listSets(limit = 30) {
  // 内存里的（含刚跑完还没关的）+ 磁盘上的（历史/重启前的）
  const seen = new Set();
  const all = [];
  for (const s of SETS.values()) { seen.add(s.id); all.push(s); }
  try {
    for (const f of readdirSync(changesetDir())) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      if (seen.has(id)) continue;
      const s = loadFromDisk(id);
      if (s) { seen.add(id); all.push(s); }
    }
  } catch { /* 目录还没建，忽略 */ }
  return all
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit)
    .map(summarize);
}

/** 给 toolkit 用的钩子：真正写盘前抓原内容（幂等：同一文件只记第一次） */
export function recordBefore(set, absPath) {
  if (!set || set.closed || set.files.has(absPath)) return;
  const existed = existsSync(absPath);
  let before = null;
  if (existed) {
    try {
      const buf = readFileSync(absPath);
      // 太大的不抓（避免撑爆内存），标记为不可回滚
      if (buf.length > MAX_DIFF_BYTES) {
        set.files.set(absPath, { existed: true, before: null, tooBig: true, after: null });
        return;
      }
      before = buf.toString('utf8');
    } catch {
      set.files.set(absPath, { existed: true, before: null, unreadable: true, after: null });
      return;
    }
  }
  set.files.set(absPath, { existed, before, after: null });
}

/** 写完之后记录新内容 */
export function recordAfter(set, absPath) {
  if (!set || set.closed) return;
  const rec = set.files.get(absPath);
  if (!rec) return;
  try {
    rec.after = readFileSync(absPath, 'utf8');
  } catch {
    rec.after = null;
  }
}

/** 逐行 LCS diff（只用于展示；文件太大就退化成"整体替换"提示） */
export function diffLines(before, after) {
  const a = (before ?? '').split('\n');
  const b = (after ?? '').split('\n');
  if (a.length + b.length > MAX_DIFF_LINES) {
    return [{ type: '!', text: `（文件过大，跳过逐行 diff：${a.length} → ${b.length} 行）` }];
  }
  // LCS 动态规划
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: '-', text: a[i] }); i++; }
    else { out.push({ type: '+', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: '-', text: a[i] }); i++; }
  while (j < m) { out.push({ type: '+', text: b[j] }); j++; }
  return out;
}

/** 生成一个变更集的可读 diff 数据（给界面用） */
/** 取记录的明文（内存里是明文；从磁盘加载的是密文，这里解密） */
function plainBefore(rec) {
  if (rec.before !== null && rec.before !== undefined) return rec.before;
  if (rec.beforeEnc) return decryptText(rec.beforeEnc) ?? '';
  return '';
}
function plainAfter(rec) {
  if (rec.after !== null && rec.after !== undefined) return rec.after;
  if (rec.afterEnc) return decryptText(rec.afterEnc) ?? '';
  return '';
}
function plainBeforeBase64(rec) {
  if (rec.beforeBase64) return rec.beforeBase64;
  if (rec.beforeBase64Enc) return decryptBase64(rec.beforeBase64Enc);
  return null;
}

export function computeDiff(set) {
  if (!set) return null;
  const files = [];
  for (const [abs, rec] of set.files) {
    if (rec.tooBig || rec.unreadable) {
      files.push({ path: abs, status: 'skipped', source: rec.source || 'tool', note: rec.tooBig ? '文件过大未记录' : '读取失败未记录' });
      continue;
    }
    const before = plainBefore(rec);
    const after = plainAfter(rec);
    if (rec.existed && before === after) continue; // 没有实际变化
    let status;
    if (!rec.existed && rec.after !== null) status = 'added';
    else if (rec.existed && rec.after === null) status = 'deleted';
    else status = 'modified';

    // 展示用行文本做脱敏；真实内容（密文）不受影响，回滚仍逐字节精确
    const rawLines = diffLines(before, after);
    const masked = looksSensitive(before) || looksSensitive(after);
    const lines = masked
      ? rawLines.map((l) => ({ ...l, text: maskSecrets(l.text) }))
      : rawLines;
    let added = 0;
    let removed = 0;
    for (const l of lines) { if (l.type === '+') added++; else if (l.type === '-') removed++; }
    files.push({ path: abs, status, added, removed, lines, masked, source: rec.source || 'tool', note: rec.note || undefined });
  }
  return { setId: set.id, label: set.label, cwd: set.cwd, at: set.at, files };
}

export function summarize(set) {
  if (!set) return null;
  const d = computeDiff(set);
  return {
    setId: set.id, label: set.label, cwd: set.cwd, at: set.at,
    files: (d?.files || []).length,
    added: (d?.files || []).reduce((a, f) => a + (f.added || 0), 0),
    removed: (d?.files || []).reduce((a, f) => a + (f.removed || 0), 0),
    rolledBack: set.rolledBack === true,
    closed: set.closed === true,
  };
}

/**
 * 登记一条**工具之外**的改动（bash / 脚本 / git 改的）。
 *
 * 和 recordBefore 的区别：那条是工具自己写盘前抓的；这条是跑完比对快照补记的。
 * beforeBase64 有值 → 回滚能逐字节恢复；为 null（文件太大没快照内容）→
 * 只能如实报「发现了但恢复不了」。
 */
export function addSnapshotRecord(set, { absPath, existed, beforeBase64 = null, afterBase64 = null, note = null }) {
  if (!set || set.closed || set.files.has(absPath)) return;
  set.files.set(absPath, {
    existed,
    before: null,
    after: null,
    beforeBase64,
    afterBase64,
    source: 'snapshot',
    note,
  });
}

/** 外部补记后重新落盘（快照记录是跑完之后才算出来的） */
export function saveSet(set) {
  return persist(set);
}

export function endSet(set) {
  if (!set) return null;
  set.closed = true;
  // 落盘失败不影响返回，但把结果标出来，别让人以为存住了
  const persisted = persist(set);
  const diff = computeDiff(set);
  return { ...diff, persisted };
}

/**
 * 回滚整个变更集，并**逐文件校验**。
 * 返回每个文件的处理结果 + 整体四态。
 */
export function rollbackSet(set) {
  if (!set) return { state: 'FAIL', reason: '变更集不存在' };
  if (set.rolledBack) return { state: 'WARN', reason: '这个变更集已经回滚过了', files: [] };

  const results = [];
  for (const [abs, rec] of set.files) {
    if (rec.tooBig || rec.unreadable) {
      results.push({ path: abs, ok: false, reason: '当初就没记录原内容，无法回滚' });
      continue;
    }
    const b64 = plainBeforeBase64(rec);
    const beforeText = plainBefore(rec);
    // 工具外改动若没抓到原内容，就不能假装修复
    if (rec.source === 'snapshot' && rec.existed && !b64) {
      results.push({ path: abs, ok: false, reason: '工具外改动，当初未快照内容，无法恢复' });
      continue;
    }
    try {
      if (rec.existed) {
        mkdirSync(dirname(abs), { recursive: true });
        if (b64) {
          writeFileSync(abs, Buffer.from(b64, 'base64'));
        } else {
          writeFileSync(abs, beforeText, 'utf8');
        }
      } else if (existsSync(abs)) {
        unlinkSync(abs);
      }
      const ok = rec.existed
        ? (existsSync(abs) && (b64
            ? Buffer.compare(readFileSync(abs), Buffer.from(b64, 'base64')) === 0
            : readFileSync(abs, 'utf8') === beforeText))
        : !existsSync(abs);
      results.push({
        path: abs, ok,
        action: rec.existed ? 'restored' : 'deleted',
        source: rec.source || 'tool',
        bytesExact: b64 ? ok : undefined,
      });
    } catch (e) {
      results.push({ path: abs, ok: false, reason: String(e && e.message) });
    }
  }

  const bad = results.filter((r) => !r.ok);
  set.rolledBack = bad.length === 0;
  persist(set);
  return {
    state: bad.length === 0 ? 'PASS' : 'FAIL',
    setId: set.id,
    files: results,
    reason: bad.length === 0 ? undefined : (bad.length + ' 个文件回滚失败'),
  };
}

/**
 * 清理旧变更集。
 *
 * 【为什么需要】每次 run_task 都留一个 json，且里面可能含 base64 原内容 ——
 * 不清理会一直涨。策略：按条数（默认保留最近 100 个）+ 按天数（默认 30 天）。
 * 返回删了什么，不静默。
 */
/**
 * 自动清理（节流）。
 *
 * 【为什么要自动】清理阈值有了，但没人会记得手动调 prune_changes。
 * 所以：宿主启动清一次；每次 run_task 结束后再看一眼，但**节流 10 分钟一次**，
 * 避免每跑一次就扫一遍目录。
 *
 * 可用环境变量控制：
 *   NIANCHU_CHANGESET_AUTOPRUNE=0   关掉
 *   NIANCHU_CHANGESET_KEEP=100      条数阈值
 *   NIANCHU_CHANGESET_DAYS=30       天数阈值
 *   NIANCHU_CHANGESET_PRUNE_INTERVAL_MS=600000  节流间隔
 */
let lastPruneAt = 0;

export function maybeAutoPrune({ force = false, nowMs = Date.now() } = {}) {
  if (process.env.NIANCHU_CHANGESET_AUTOPRUNE === '0') {
    return { ran: false, reason: 'disabled' };
  }
  const interval = Number(process.env.NIANCHU_CHANGESET_PRUNE_INTERVAL_MS) || 10 * 60 * 1000;
  if (!force && nowMs - lastPruneAt < interval) {
    return { ran: false, reason: 'throttled', waitMs: interval - (nowMs - lastPruneAt) };
  }
  lastPruneAt = nowMs;
  const maxCount = Number(process.env.NIANCHU_CHANGESET_KEEP) || 100;
  const maxAgeDays = Number(process.env.NIANCHU_CHANGESET_DAYS) || 30;
  const r = pruneSets({ maxCount, maxAgeDays });
  return { ran: true, ...r };
}

export function pruneSets({ maxCount = 100, maxAgeDays = 30 } = {}) {
  const removed = [];
  let kept = 0;
  try {
    const dir = changesetDir();
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const rows = [];
    for (const f of files) {
      const p = join(dir, f);
      let mtime = 0;
      try { mtime = statSync(p).mtimeMs; } catch { /* ignore */ }
      rows.push({ name: f, path: p, mtime });
    }
    // 新的在前
    rows.sort((a, b) => b.mtime - a.mtime);
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const tooMany = i >= maxCount;
      const tooOld = row.mtime < cutoff;
      if (!tooMany && !tooOld) { kept++; continue; }
      try {
        unlinkSync(row.path);
        // 内存里的也一并清掉，避免回滚一个已删记录
        SETS.delete(row.name.slice(0, -5));
        removed.push({ id: row.name.slice(0, -5), reason: tooMany ? 'count' : 'age' });
      } catch { /* ignore */ }
    }
  } catch { /* 目录不存在就算了 */ }
  return { removed: removed.length, kept, detail: removed.slice(0, 50) };
}

/** 变更集目录占用的字节数（给界面/运维看） */
export function changesetUsage() {
  try {
    const dir = changesetDir();
    let bytes = 0;
    let count = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { bytes += statSync(join(dir, f)).size; count++; } catch { /* ignore */ }
    }
    return { count, bytes, encrypted: Boolean(hasKey()) };
  } catch {
    return { count: 0, bytes: 0, encrypted: Boolean(hasKey()) };
  }
}

/** 给 toolkit 用的包装：createToolkit({ cwd, changeset: set }) */
export function makeChangesetHooks(set) {
  return {
    before: (absPath) => recordBefore(set, absPath),
    after: (absPath) => recordAfter(set, absPath),
  };
}

export function resolveAgainst(cwd, p) {
  return isAbsolute(p) ? p : resolve(cwd, p);
}