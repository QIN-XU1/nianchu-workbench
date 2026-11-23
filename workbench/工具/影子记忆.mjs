#!/usr/bin/env node
/**
 * 影子记忆 —— 记忆的历史快照与前后对比
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1msWM6hEzB「系统级自我纠正」原文）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [03:45] 「第二个验证就是 10 天周期验证，
 *  > 就是我做了一个类似**影子记忆**的。
 *  > 比如说像这个私有记忆，他一周前是什么样子，一周后是什么样，
 *  > 他有个对比验证的。
 *  > 你看他到底是**进步了，还是记了一些乱七八糟的东西**。」
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么这是最缺的东西
 * ══════════════════════════════════════════════════════════════
 *
 *  在此之前，我的所有指标都在回答「现在能不能召回事实」。
 *  但**没有一个回答「记忆是在变好还是变坏」**。
 *
 *  记忆系统可以做到：
 *    · recall 1.00（能召回所有事实）
 *    · 体量不超限（≤25KB）
 *    · 章节唯一（无重复）
 *  但仍然可能是**在记一些乱七八糟的东西**。
 *
 *  影子记忆解决的就是这个问题：
 *    存下历史快照 → 定期对比 → 判断「进步 or 退步」
 *
 * ══════════════════════════════════════════════════════════════
 *  判断标准（不能只看体量）
 * ══════════════════════════════════════════════════════════════
 *
 *  朴素做法是「记忆变多了 = 变好了」，这是错的（灌水也能变多）。
 *
 *  这里用四个维度：
 *
 *    ① 密度（density）
 *       有效知识条目数 / 总字数
 *       灌水会让密度下降
 *
 *    ② 新鲜度（freshness）
 *       最近 N 天更新的条目占比
 *       长期不更新的记忆可能在腐烂
 *
 *    ③ 一致性（consistency）
 *       同一主题是否有多份并存（过期事实）
 *       并列版本多 = 一致性差
 *
 *    ④ 无冲突（noConflict）
 *       是否有作废标记指向仍存在的条目
 *
 *  综合分 = 加权总分，并给出「进步 / 停滞 / 退步」判定。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/影子记忆.mjs --snapshot              为所有场景存快照
 *  node 工具/影子记忆.mjs --snapshot --scene 架构梳理
 *  node 工具/影子记忆.mjs --compare               对比最近两次快照
 *  node 工具/影子记忆.mjs --compare --scene 架构梳理
 *  node 工具/影子记忆.mjs --trend                 看历史趋势
 *  node 工具/影子记忆.mjs --selftest              自测
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const MEM_ROOT = path.join(DATA_ROOT, '场景记忆');
const SHADOW_ROOT = path.join(DATA_ROOT, '影子记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

export const THRESHOLDS = {
  /** 综合分变化超过这个值算「有变化」 */
  CHANGE_EPSILON: 0.03,
  /** 低于这个算退步 */
  REGRESS: -0.03,
  /** 高于这个算进步 */
  PROGRESS: 0.03,
  /** 新鲜度窗口（天） */
  FRESH_DAYS: 30,
  /** 每个场景保留多少历史快照 */
  MAX_SNAPSHOTS: 30,
  /**
   * 快照最大允许陈旧天数（--check 用）
   *
   *  设计依据：这个工具宣称「10 天周期验证」。
   *  如果最后一次快照超过这个天数，说明「周期验证」根本没在跑 ——
   *  快照只有 1 个的场景永远比不出前后，工具等于装饰。
   *
   *  取 14 天 = 宣称的 10 天周期 + 4 天容错。
   */
  SNAPSHOT_STALE_DAYS: 14,
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  分析一份记忆的四个维度
// ══════════════════════════════════════════════════════════════
export function analyzeMemory(md, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const s = String(md || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = s.split('\n');

  // ── 提取知识条目 ──
  const items = [];
  let curSection = '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const h = t.match(/^#{2,3}\s+(.+)$/);
    if (h) { curSection = h[1].trim(); continue; }
    if (/^#{1,6}\s/.test(t)) continue;
    if (/^>\s/.test(t)) continue;
    if (/^[（(]?(无|待补|待填|空|只追加)[)）]?$/.test(t)) continue;
    if (/^[-=*]{3,}$/.test(t)) continue;
    if (/^\|/.test(t)) continue;
    if (t.length < 8) continue;
    items.push({ section: curSection, text: t });
  }

  const totalChars = s.replace(/\s/g, '').length;
  const totalItems = items.length;

  // ── ① 密度：有效条目 / 字数（按每千字条目数） ──
  const density = totalChars > 0 ? (totalItems / totalChars) * 1000 : 0;

  // ── ② 新鲜度：最近 FRESH_DAYS 天有更新的条目占比 ──
  const cut = now - THRESHOLDS.FRESH_DAYS * 86400000;
  let freshCount = 0;
  let datedCount = 0;
  for (const it of items) {
    const m = it.text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) continue;
    datedCount++;
    const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00Z');
    if (!Number.isNaN(t) && t >= cut) freshCount++;
  }
  // 没有日期标记的条目视为「无时间信息」，不计入分子也不计入分母
  const freshness = datedCount > 0 ? freshCount / datedCount : 0;

  // ── ③ 一致性：同一主题是否有**多份并存**（过期事实） ──
  //
  //  ⚠ 2026-11-12 修正（真实检查暴露的判据错误）
  //
  //  原判据：consistency = f(该场景「平均每节条目数」)
  //          —— 每节条目越多，一致性分越低（每节 10 条就扣到 0）。
  //
  //  错在哪：文档写的判据是「同一主题是否有多份并存（过期事实）」，
  //    但实现测的是「每节装了多少条」—— 这两件事不一样：
  //      · 一个场景在 §五 里老老实实追加 13 条**互不相同**的真实经验，
  //        是记忆在正常积累，不是「多份并存」；
  //      · 但按原判据，一致性从 0.686 掉到 0.559，综合分 -0.038 → 判「退步」。
  //    实测（架构梳理）：11-10 → 11-12 之间新增 13 条真实经验（都是不同主题），
  //    密度 25.84 → 13.57 看着像灌水，但逐条核对新增内容全是真经验
  //    （「机制清单滞后于工具目录」「反例能证伪格式却证伪不了实质真假」…）。
  //    把「正常积累」判成「退步」，这个信号就永远在喊狼来了。
  //
  //  修法：一致性改为测「**近似重复**的条目对」——
  //    两条条目如果标题高度相似（同一句话的两种说法），才是并列版本。
  //    用现有条目的标题做 2-gram 包含度比较：
  //      containment >= 0.8 且不是同一条 → 记一对重复
  //    一致性 = 1 - 重复对数 / 条目数（下限 0）
  const titleGrams = (s) => {
    const set = new Set();
    const str = String(s || '').replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, '');
    for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
    return set;
  };
  const titles = items.map((it) => {
    const m = String(it.text).match(/\*\*(.+?)\*\*/);
    return titleGrams(m ? m[1] : String(it.text).slice(0, 30));
  });
  let dupPairs = 0;
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      const a = titles[i];
      const b = titles[j];
      if (a.size === 0 || b.size === 0) continue;
      let hit = 0;
      for (const x of a) if (b.has(x)) hit++;
      const containment = hit / Math.min(a.size, b.size);
      if (containment >= 0.8) dupPairs++;
    }
  }
  const consistency = totalItems > 0
    ? Math.max(0, 1 - dupPairs / Math.max(totalItems, 1))
    : 0;

  // 按节统计（诊断用，不参与打分）
  const bySection = {};
  for (const it of items) {
    const k = it.section || '_无节';
    bySection[k] = (bySection[k] || 0) + 1;
  }

  // 保留「平均每节条目数」作为诊断信息（不再参与打分）
  const sectionCounts = Object.values(bySection).filter((n) => n > 0);
  const avgPerSection = sectionCounts.length > 0
    ? sectionCounts.reduce((a, b) => a + b, 0) / sectionCounts.length
    : 0;

  // ── ④ 无冲突：作废标记与实际条目的比例 ──
  const voidMarkers = (s.match(/已失效|已作废|不再适用|推翻|特此更正/g) || []).length;
  const noConflict = totalItems > 0
    ? Math.max(0, 1 - voidMarkers / Math.max(totalItems, 1))
    : 1;

  // ── 综合分 ──
  //
  //  权重依据：
  //    密度最重要（防灌水）    0.35
  //    一致性次之（防并列版本）0.30
  //    新鲜度（防腐烂）        0.20
  //    无冲突（防过期）        0.15
  //
  //  ⚠ 自测抓到的缺陷：空记忆时 noConflict=1、freshness 也算满分，
  //    导致 score=0.15 而不是 0 —— 空记忆不该有分数。
  //    修法：没有任何有效条目时直接返回 0。
  const empty = totalItems === 0;
  const score = empty ? 0 :
    Math.min(density / 8, 1) * 0.35 +
    consistency * 0.30 +
    freshness * 0.20 +
    noConflict * 0.15;

  return {
    totalChars,
    totalItems,
    density: +density.toFixed(3),
    freshness: +freshness.toFixed(3),
    consistency: +consistency.toFixed(3),
    noConflict: +noConflict.toFixed(3),
    avgPerSection: +avgPerSection.toFixed(2),
    sectionCount: sectionCounts.length,
    freshCount,
    datedCount,
    voidMarkers,
    score: +score.toFixed(4),
    hash: crypto.createHash('sha256').update(s).digest('hex').slice(0, 16),
  };
}

// ══════════════════════════════════════════════════════════════
//  快照
// ══════════════════════════════════════════════════════════════
export function takeSnapshot(sceneName, memPath, opts) {
  const md = readTextSafe(memPath);
  if (md === null) return { ok: false, error: '读不到: ' + memPath };

  const analysis = analyzeMemory(md, opts);
  const at = new Date().toISOString();

  const snap = {
    at,
    scene: sceneName,
    ...analysis,
    // 保留原文（便于事后核查「当时是什么样」）
    content: md,
  };

  return { ok: true, snapshot: snap, analysis };
}

/** 快照目录 */
function shadowDir(sceneName) {
  return path.join(SHADOW_ROOT, sceneName);
}

/** 读某场景所有快照 */
export function listSnapshots(sceneName) {
  const dir = shadowDir(sceneName);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const out = [];
  for (const f of files) {
    const j = readJsonSafe(path.join(dir, f));
    if (j) out.push({ file: f, ...j });
  }
  return out;
}

/**
 * 把历史快照里的分数按**当前公式**重算
 *
 * ⚠ 2026-11-12 新增（修正 consistency 判据后必须配套）
 *
 *  问题：快照文件里存的是「当时的 score」。
 *    2026-11-12 之前的一致性判据是「每节条目数的倒数映射」，
 *    现在是「近似重复条目对」。两种公式算出的分数不可比。
 *
 *    实测：架构梳理 11-10 的快照存 score=0.9143（旧公式），
 *    11-12 的新快照存 0.8762（新公式），直接相减得到 -0.038 → 判「退步」。
 *    但这个差完全是**公式换了**造成的，不是记忆变差了。
 *    拿两套标准算出来的数比大小 = 假信号。
 *
 *  修法：比较前，用快照里保存的 content 原文按当前公式重算各维度分。
 *    这样任何两次快照都是同一套标准算的，delta 才有意义。
 *    （快照保存了 content 全文正是为了这种事后重算——原本的设计意图）
 */
export function rescoreSnapshot(snap) {
  if (!snap || typeof snap.content !== 'string') return snap;
  const fresh = analyzeMemory(snap.content, { now: Date.parse(snap.at) || Date.now() });
  // ⚠ 2026-11-12 修（真缺陷：重算覆盖了原记录的 hash，导致自洽判据永远为真）
  //
  //   原来：hash: fresh.hash
  //          —— 用「从 content 重算出来的 hash」覆盖了「快照文件里记录的 hash」。
  //
  //   后果：--check 里的自洽判据
  //           expectHash = sha256(latest.content)
  //           if (latest.hash !== expectHash) 报错
  //         因为 latest.hash 已经被重算值覆盖，所以永远相等 → 永远不报。
  //         实测把快照 hash 改成 deadbeef… 后，检查照样 PASS。
  //
  //   修法：
  //     · hash        保留**文件里记录的原始值**（判据要拿它跟重算值比）
  //     · recomputedHash 存重算值（供其它用途）
  return {
    ...snap,
    recomputed: true,
    score: fresh.score,
    density: fresh.density,
    freshness: fresh.freshness,
    consistency: fresh.consistency,
    noConflict: fresh.noConflict,
    totalItems: fresh.totalItems,
    totalChars: fresh.totalChars,
    recomputedHash: fresh.hash,   // 重算值单独存
    // hash 保持 snap.hash 原样（不覆盖）
  };
}

/** 读快照并按当前公式重算（比较用） */
export function listSnapshotsRescored(sceneName) {
  return listSnapshots(sceneName).map(rescoreSnapshot);
}

/** 写入快照（保留最近 MAX_SNAPSHOTS 个） */
export function writeSnapshot(snap) {
  const dir = shadowDir(snap.scene);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = snap.at.replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, stamp + '.json');
  fs.writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8');

  // 清理超量
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length > THRESHOLDS.MAX_SNAPSHOTS) {
    for (const f of files.slice(0, files.length - THRESHOLDS.MAX_SNAPSHOTS)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
  }

  return { ok: true, file };
}

// ══════════════════════════════════════════════════════════════
//  对比两次快照
//
//  核心判断：「是进步了，还是记了一些乱七八糟的东西」
// ══════════════════════════════════════════════════════════════
export function compareSnapshots(older, newer) {
  const delta = {
    score: +(newer.score - older.score).toFixed(4),
    density: +(newer.density - older.density).toFixed(3),
    freshness: +(newer.freshness - older.freshness).toFixed(3),
    consistency: +(newer.consistency - older.consistency).toFixed(3),
    noConflict: +(newer.noConflict - older.noConflict).toFixed(3),
    items: newer.totalItems - older.totalItems,
    chars: newer.totalChars - older.totalChars,
  };

  let verdict;
  let reason;

  if (Math.abs(delta.score) < THRESHOLDS.CHANGE_EPSILON) {
    verdict = '停滞';
    reason = '综合分变化 ' + (delta.score >= 0 ? '+' : '') + delta.score + '，在容差内';
  } else if (delta.score >= THRESHOLDS.PROGRESS) {
    verdict = '进步';
    reason = '综合分 +' + delta.score;
  } else if (delta.score <= THRESHOLDS.REGRESS) {
    verdict = '退步';
    reason = '综合分 ' + delta.score;
  } else {
    verdict = '轻微变化';
    reason = '综合分 ' + (delta.score >= 0 ? '+' : '') + delta.score;
  }

  // 细节诊断：为什么会退步
  const warnings = [];
  if (delta.density < -0.5) {
    warnings.push('密度下降 ' + delta.density + '——可能是灌水（字数涨了但有效条目没涨）');
  }
  if (delta.items > 0 && delta.chars / Math.max(delta.items, 1) > 300) {
    warnings.push('新增条目平均 ' + Math.round(delta.chars / delta.items) + ' 字/条——条目过长，不够精炼');
  }
  if (delta.consistency < -0.1) {
    warnings.push('一致性下降 ' + delta.consistency + '——可能产生了并列版本（同一事实多份并存）');
  }
  if (delta.noConflict < -0.1) {
    warnings.push('冲突标记增多——有作废声明但旧条目未清理');
  }
  if (delta.freshness < -0.2) {
    warnings.push('新鲜度下降 ' + delta.freshness + '——最近没有更新');
  }

  return {
    older: { at: older.at, score: older.score, items: older.totalItems, chars: older.totalChars },
    newer: { at: newer.at, score: newer.score, items: newer.totalItems, chars: newer.totalChars },
    delta,
    verdict,
    reason,
    warnings,
    sameContent: older.hash === newer.hash,
  };
}

// ══════════════════════════════════════════════════════════════
//  真实检查（--check）
//
//  ⚠ 2026-11-12 新增。此前只有 --selftest（构造的 good/bloat 记忆），
//    真实数据上这个机制的实际情况是：
//      · 9 个场景里 1 个有 ≥2 个快照，其余 8 个只有 1 个 → 永远「快照不足」
//      · 有快照的那个（竞品拆解）最新一次也停在 2026-11-10
//    「10 天周期验证」从来没被任何调度器跑过 —— 与「设计一致性从未被调用」同构。
//
//  判据（对每个真实场景）：
//    ① 每个场景至少要有 1 个快照（0 个 = 从没开始验证）
//    ② 最近一次快照不能早于 SNAPSHOT_STALE_DAYS 天（否则周期验证停摆）
//    ③ 快照里的 hash 必须与当前记忆文件一致，或说明记忆确实变过
//       —— 不一致本身不是问题（记忆就该变），但「快照内容与当时文件不符」是问题：
//          快照 content 的 hash 必须等于快照记录的 hash（自洽）
//    ④ 最近两次快照若判「退步」，要报（这是这个工具存在的理由）
// ══════════════════════════════════════════════════════════════
export function checkReal(opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const problems = [];
  const rows = [];
  if (!fs.existsSync(MEM_ROOT)) {
    return { ok: false, checked: 0, rows, problems: ['记忆根目录不存在: ' + MEM_ROOT] };
  }

  const scenes = fs.readdirSync(MEM_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name);

  const staleMs = THRESHOLDS.SNAPSHOT_STALE_DAYS * 24 * 3600 * 1000;

  for (const name of scenes) {
    const memPath = path.join(MEM_ROOT, name, '场景私有记忆.md');
    if (!fs.existsSync(memPath)) {
      rows.push({ scene: name, skipped: true, why: '没有场景私有记忆.md' });
      continue;
    }

    // ⚠ 2026-11-12 修（真缺陷：重算覆盖了原记录的 hash，判据永远为真）
    //
    //   原来：const snaps = listSnapshotsRescored(name);
    //          —— rescoreSnapshot 会用 content 重算 hash 并覆盖 snap.hash。
    //          于是后面的自洽判据 `latest.hash !== expectHash` 永远为 false。
    //
    //   实测：把快照 hash 改成 deadbeef… 后，--check 照样 exit 0。
    //
    //   修法：判分用重算值（rescore），但**自洽校验必须用原始快照**。
    //        两套数据分开：snapsRaw 用于 hash 校验，snaps 用于评分。
    const snapsRaw = listSnapshots(name);
    const snaps = snapsRaw.map(rescoreSnapshot);
    if (snaps.length === 0) {
      problems.push(name + '：一个快照都没有（影子记忆从没对这个场景跑过）');
      rows.push({ scene: name, snaps: 0, staleDays: null, verdict: '—', regress: false });
      continue;
    }

    // ① 至少 2 个快照才能比出「进步/退步」
    //
    //  ⚠ 2026-11-12：这一条是「机制有没有真的在跑」的核心。
    //    只有 1 个快照时，--compare 永远输出「快照不足」，
    //    工具的全部价值（判断记忆是进步还是记乱了）为零。
    //    实测修前：9 个场景里 8 个只有 1 个快照。
    //    这不是「数据还没积累」，而是「周期任务从没被调度」——
    //    与「设计一致性从未被调用」同构，必须报出来而不是显示 ○ 就过。
    if (snaps.length < 2) {
      problems.push(name + '：只有 ' + snaps.length +
        ' 个快照，比不出前后（需要 ≥2 个；跑 --snapshot 存第 2 个）');
      rows.push({ scene: name, snaps: snaps.length, staleDays: null, verdict: '—', regress: false });
      continue;
    }

    // ② 新鲜度
    const latest = snaps[snaps.length - 1];
    const latestAt = Date.parse(latest.at);
    const ageDays = Number.isFinite(latestAt)
      ? Math.floor((now - latestAt) / 86400000)
      : null;

    if (ageDays === null) {
      problems.push(name + '：最近快照的 at 字段无法解析 —— ' + JSON.stringify(latest.at));
    } else if (ageDays > THRESHOLDS.SNAPSHOT_STALE_DAYS) {
      problems.push(name + '：最近一次快照是 ' + ageDays + ' 天前（超过 ' +
        THRESHOLDS.SNAPSHOT_STALE_DAYS + ' 天）—— 周期验证已停摆，快跑 --snapshot');
    }

    // ③ 快照自洽：content 的 hash 必须等于快照记录的 hash
    //
    //  这能抓到「快照文件被手工改过 / 写入时用了错的 hash」
    //
    //  ⚠ 2026-11-12 修：必须用**原始快照**（snapsRaw）做这个校验。
    //     如果用 rescore 后的快照，hash 已被重算值覆盖，判据永远为真。
    const latestRaw = snapsRaw[snapsRaw.length - 1];
    const expectHash = crypto.createHash('sha256')
      .update(String(latestRaw.content || '')).digest('hex').slice(0, 16);
    if (latestRaw.content !== undefined && latestRaw.hash !== expectHash) {
      problems.push(name + '：快照 ' + latestRaw.at + ' 的 hash 与 content 不符（记录 ' +
        latestRaw.hash + '，实际 ' + expectHash + '）—— 快照被改过或写错了');
    }
    // 也校验**所有**快照（不只最新的），防止旧快照被改
    for (const s of snapsRaw) {
      if (s.content === undefined) continue;
      const eh = crypto.createHash('sha256').update(String(s.content)).digest('hex').slice(0, 16);
      if (s.hash && s.hash !== eh && s !== latestRaw) {
        problems.push(name + '：历史快照 ' + s.at + ' 的 hash 不符（记录 ' +
          s.hash + '，实际 ' + eh + '）');
      }
    }

    // ④ 最近两次对比
    let verdict = '—';
    let regress = false;
    if (snaps.length >= 2) {
      const c = compareSnapshots(snaps[snaps.length - 2], latest);
      verdict = c.verdict;
      if (c.verdict === '退步') {
        regress = true;
        problems.push(name + '：最近一次对比判「退步」（' + (c.reason || '') + '）—— 记忆可能在灌水');
      }
    }

    rows.push({ scene: name, snaps: snaps.length, staleDays: ageDays, verdict, regress });
  }

  return { ok: problems.length === 0, checked: rows.filter((r) => !r.skipped).length, rows, problems };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  影子记忆 · 自测');
  console.log('═'.repeat(72));
  console.log();

  const now = Date.parse('2026-11-10T00:00:00Z');

  // ① 分析：小而精的记忆 → 高分
  const good = [
    '# 场景记忆',
    '',
    '## 核心职责',
    '',
    '- 负责：把三路输入合成架构方案',
    '- 不碰：不写代码',
    '',
    '## 坑与决策',
    '',
    '- 2026-11-09：**状态机末端状态要显式处理。**',
    '- 2026-11-10：**派单要真投递不能只标记。**',
  ].join('\n');
  const a1 = analyzeMemory(good, { now });
  chk('分析出条目数', a1.totalItems > 0, a1.totalItems + ' 条');
  chk('好记忆密度合理', a1.density > 0, 'density=' + a1.density);
  chk('有新鲜度', a1.freshness > 0, 'freshness=' + a1.freshness);
  chk('好记忆综合分较高', a1.score > 0.4, 'score=' + a1.score);

  // ② 分析：灌水记忆 → 密度低
  const bloat = good + '\n' + Array.from({ length: 50 }, (_, i) =>
    '\n- 这是一条很长的没什么信息量的记录，主要是在凑字数，内容空洞，重复啰嗦，' +
    '说了半天也没有实质内容，只是在填充篇幅而已，这已经是第 ' + (i + 1) + ' 条了。').join('');
  const a2 = analyzeMemory(bloat, { now });
  chk('灌水后条目变多', a2.totalItems > a1.totalItems, a2.totalItems + ' > ' + a1.totalItems);
  chk('灌水后密度下降', a2.density < a1.density, a2.density + ' < ' + a1.density);
  chk('灌水后综合分下降', a2.score < a1.score, a2.score + ' < ' + a1.score);

  // ③ 对比：进步
  const better = good + '\n- 2026-11-10：**新增一条真实经验，精炼。**';
  const a3 = analyzeMemory(better, { now });
  const c1 = compareSnapshots(
    { at: '2026-11-01', ...a1, hash: 'x' },
    { at: '2026-11-10', ...a3, hash: 'y' },
  );
  chk('对比能算 delta', typeof c1.delta.score === 'number', String(c1.delta.score));
  chk('对比有 verdict', ['进步', '退步', '停滞', '轻微变化'].includes(c1.verdict), c1.verdict);

  // ④ 对比：退步（灌水）必须判出来
  const c2 = compareSnapshots(
    { at: '2026-11-01', ...a1, hash: 'x' },
    { at: '2026-11-10', ...a2, hash: 'z' },
  );
  chk('灌水必须判退步', c2.verdict === '退步', c2.verdict + ' (' + c2.reason + ')');
  chk('退步时给出警告', c2.warnings.length > 0, c2.warnings[0] || '');

  // ⑤ 对比：内容相同 → 停滞
  const c3 = compareSnapshots(
    { at: '2026-11-01', ...a1, hash: 'same' },
    { at: '2026-11-10', ...a1, hash: 'same' },
  );
  chk('内容相同判停滞', c3.verdict === '停滞', c3.verdict);
  chk('识别出内容相同', c3.sameContent === true, String(c3.sameContent));

  // ⑥ 反例：空记忆不崩
  const a4 = analyzeMemory('', { now });
  chk('反例：空记忆不崩', a4.totalItems === 0 && a4.score === 0, 'score=' + a4.score);

  // ⑦ 反例：只有标题没有内容
  const a5 = analyzeMemory('# 标题\n\n## 一\n\n## 二\n', { now });
  chk('反例：只有标题条目为 0', a5.totalItems === 0, a5.totalItems + ' 条');

  // ⑧ 关键：这个检测必须能发现问题（不是摆设）
  chk('关键：灌水能被识别', a2.score < a1.score && c2.verdict === '退步',
      '这是影子记忆存在的唯一理由');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 真实检查 ──
  if (has('--check')) {
    const r = checkReal();
    console.log('═'.repeat(78));
    console.log('  影子记忆 · 真实检查（快照是否在跑、是否比出退步）');
    console.log('═'.repeat(78));
    console.log();
    console.log('  ' + '场景'.padEnd(12) + '快照数'.padEnd(8) + '最新距今'.padEnd(10) +
      '上次判定'.padEnd(8) + '状态');
    console.log('  ' + '─'.repeat(70));
    for (const row of r.rows) {
      if (row.skipped) {
        console.log('  ' + row.scene.padEnd(12) + '—  ' + row.why);
        continue;
      }
      const age = row.staleDays === null ? '—' : row.staleDays + ' 天';
      let status = '✓';
      if (row.snaps === 0) status = '✗ 从没快照';
      else if (row.snaps < 2) status = '○ 只有 1 个，比不出前后';
      else if (row.staleDays !== null && row.staleDays > THRESHOLDS.SNAPSHOT_STALE_DAYS) status = '✗ 停摆';
      if (row.regress) status = '✗ 退步';
      console.log('  ' + row.scene.padEnd(12) +
        String(row.snaps).padEnd(8) +
        age.padEnd(10) +
        String(row.verdict).padEnd(8) +
        status);
    }
    console.log('  ' + '─'.repeat(70));
    console.log('  检查了 ' + r.checked + ' 个场景');
    console.log();
    if (r.ok) {
      console.log('  ✓ 快照周期正常，最近对比无退步');
    } else {
      console.log('  ✗ ' + r.problems.length + ' 个问题:');
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    console.log('═'.repeat(78));
    process.exit(r.ok ? 0 : 1);
  }

  // ── 快照 ──
  if (has('--snapshot')) {
    const only = val('--scene');
    const scenes = only
      ? [only]
      : fs.readdirSync(MEM_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
        .map((d) => d.name);

    console.log('═'.repeat(72));
    console.log('  影子记忆 · 存快照');
    console.log('═'.repeat(72));
    console.log();

    let ok = 0;
    for (const name of scenes) {
      const memPath = path.join(MEM_ROOT, name, '场景私有记忆.md');
      const r = takeSnapshot(name, memPath);
      if (!r.ok) { console.log('  ✗ ' + name + ': ' + r.error); continue; }
      writeSnapshot(r.snapshot);
      ok++;
      const a = r.analysis;
      console.log('  ✓ ' + name.padEnd(12) +
        '分=' + String(a.score).padEnd(7) +
        '条目=' + String(a.totalItems).padStart(3) +
        ' 字数=' + String(a.totalChars).padStart(5) +
        ' 密度=' + a.density);
    }

    console.log();
    console.log('─'.repeat(72));
    console.log('  已存 ' + ok + ' / ' + scenes.length + ' 个场景的快照');
    console.log('  位置: ' + path.relative(WB, SHADOW_ROOT).replace(/\\/g, '/'));
    console.log('─'.repeat(72));
    process.exit(ok > 0 ? 0 : 1);
  }

  // ── 对比 ──
  if (has('--compare')) {
    const only = val('--scene');
    const scenes = only
      ? [only]
      : fs.existsSync(SHADOW_ROOT)
        ? fs.readdirSync(SHADOW_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [];

    console.log('═'.repeat(78));
    console.log('  影子记忆 · 前后对比（进步还是记乱了？）');
    console.log('═'.repeat(78));
    console.log();

    let regress = 0;
    let progress = 0;
    let total = 0;

    for (const name of scenes) {
      const snaps = listSnapshotsRescored(name);
      if (snaps.length < 2) {
        console.log('  ○ ' + name.padEnd(12) + '快照不足（' + snaps.length + ' 个，需 ≥2）');
        continue;
      }
      total++;
      const older = snaps[snaps.length - 2];
      const newer = snaps[snaps.length - 1];
      const c = compareSnapshots(older, newer);
      if (c.verdict === '退步') regress++;
      if (c.verdict === '进步') progress++;

      const mark = c.verdict === '进步' ? '↑' : c.verdict === '退步' ? '↓' : '→';
      console.log('  ' + mark + ' ' + name.padEnd(12) +
        c.older.score.toFixed(3) + ' → ' + c.newer.score.toFixed(3) +
        '  ' + c.verdict.padEnd(6) +
        '  条目 ' + (c.delta.items >= 0 ? '+' : '') + c.delta.items +
        '  字数 ' + (c.delta.chars >= 0 ? '+' : '') + c.delta.chars);
      if (c.warnings.length) {
        for (const w of c.warnings) console.log('      ⚠ ' + w);
      }
    }

    console.log();
    console.log('─'.repeat(78));
    console.log('  对比 ' + total + ' 个场景：进步 ' + progress + ' · 退步 ' + regress);
    if (regress > 0) {
      console.log('  ⚠ 有 ' + regress + ' 个场景退步，需要检查是不是灌水了');
    }
    console.log('─'.repeat(78));
    process.exit(regress > 0 ? 1 : 0);
  }

  // ── 趋势 ──
  if (has('--trend')) {
    console.log('═'.repeat(78));
    console.log('  影子记忆 · 历史趋势');
    console.log('═'.repeat(78));
    console.log();

    const dirs = fs.existsSync(SHADOW_ROOT)
      ? fs.readdirSync(SHADOW_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : [];

    for (const name of dirs) {
      const snaps = listSnapshots(name);
      if (snaps.length === 0) continue;
      console.log('  ' + name + '（' + snaps.length + ' 个快照）');
      for (const s of snaps) {
        const bar = '█'.repeat(Math.round(s.score * 20));
        console.log('    ' + s.at.slice(0, 19).replace('T', ' ') + '  ' +
          s.score.toFixed(3) + '  ' + bar.padEnd(20) + '  ' + s.totalItems + ' 条');
      }
      console.log();
    }
    process.exit(0);
  }

  console.log('用法:');
  console.log('  node 工具/影子记忆.mjs --snapshot [--scene X]   存快照');
  console.log('  node 工具/影子记忆.mjs --compare [--scene X]    前后对比');
  console.log('  node 工具/影子记忆.mjs --trend                  历史趋势');
  console.log('  node 工具/影子记忆.mjs --selftest               自测');
}
