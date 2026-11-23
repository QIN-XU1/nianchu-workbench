#!/usr/bin/env node
// 工具/进化账本.mjs —— 记录每一版改变了什么、评分多少、保留还是回滚
//
// ══════════════════════════════════════════════════════════════════════
//  这是「自我进化」真正缺的那一环
// ══════════════════════════════════════════════════════════════════════
//  调研依据：
//    · Darwin Gödel Machine (Sakana AI, arXiv 2505.22954)
//      「自我改进系统：迭代修改自身代码，并用基准测试**实证验证**每个改动」
//      关键三个零件：archive（存档） + parent selection（选父代） + benchmark（基准）
//
//    · A Survey of Self-Evolving Agents (2025) 的四维分类
//      What / When / How / Where to Evolve
//      其中 What 分三层：Models / Context (Memory+Prompt) / Tools
//
//  ──────────────────────────────────────────────────────────────────
//  我们缺什么（诚实盘点）：
//
//    ✅ 可改的东西      146 个工具 + 98 个体检项 + 12 个技能，都在磁盘上可改
//    ✅ 客观评分        机制体检（98 项）/ 目标验收（11 条）/ 封存集判分
//    ⛔ 保留或淘汰      **完全没有** —— 没有「这一版比上一版好」的记录
//
//  没有第三件，前面两件就变成：跑一次体检，红了就修，修完再跑 ——
//  这叫「维护」，不叫「进化」。进化需要**方向**和**记忆**：
//    · 方向 = 这一版比上一版好在哪（delta）
//    · 记忆 = 哪些改动真的有效（archive）
//
//  ──────────────────────────────────────────────────────────────────
//  这个工具做四件事：
//    ① baseline  改之前先量一次（存进账本）
//    ② record    改之后量一次，算 delta，记入账本
//    ③ history   看历史：每一版改了什么、分数怎么变
//    ④ keep/drop 决策：delta > 0 保留，delta < 0 建议回滚
//
//  用法：
//    node 工具/进化账本.mjs --baseline           记录当前基线（改之前跑）
//    node 工具/进化账本.mjs --record --note "加了 XX 检查"   记录改后结果
//    node 工具/进化账本.mjs --history            看历史
//    node 工具/进化账本.mjs --best               看历史最好分
//    node 工具/进化账本.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const BOOK = path.join(DATA, '进化账本.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 评分的维度（2026-11-13 第二次重设计 —— 加入真行为度量）
 *
 * ⚠ 为什么必须加 behavior
 *
 *   hermes 逆向报告第 7 条直接指出了本工具的根因缺陷：
 *     「账本里出现**至少一条 verdict: worse** 的真实记录，
 *      在那之前，进化账本只是『记账』，不是『进化』。」
 *
 *   实测印证：这一轮加了 159 个工具 / 103 个检查项 / 3 个新检查 / 深色主题 /
 *   修了 skill.json / 补了 hub 技能坑节 —— 全是实质进步，
 *   但账本给出 **持平 0 分**，因为 structure 三项只看文件数：
 *     · 工具 155→159 只涨 4，落在 100 的饱和线上，分数不变
 *     · 体检项 99→103 同理
 *     · 六件套一直 12/12，永远 100%
 *
 *   ⇒ **只数文件的度量测不出「真的变强了」。** 必须加真行为。
 *
 *   新增 behavior 子分，由两个**秒级可算**的真行为指标组成：
 *     · 记忆召回率（记忆评估的 recall_all 达标场景数 / 总场景）
 *     · 封存集得分（封存集判分的通过场景数 / 总场景）
 *   这两个测的是「AI 真的能答对/真的记得住」，不是「文件多了几个」。
 */
export const SCORE_PARTS = [
  { id: 'structure', name: '结构（文件数）', weight: 0.30, why: '工具/体检项/场景/技能是否在长' },
  { id: 'honesty', name: '真跑率', weight: 0.25, why: '防「删检查刷分」' },
  { id: 'complete', name: '场景完整率', weight: 0.15, why: '防「加空场景凑数」' },
  { id: 'behavior', name: '真行为（记忆+封存集）', weight: 0.30, why: '防「只数文件看不出变强」' },
];

/**
 * 算综合分（0~100）—— 纯静态，毫秒级
 *
 * @param {{tools:number, guards:number, selfOnlyGuards:number, scenes:number, scenesComplete:number, skills:number,
 *          memoryPassed:number, memoryTotal:number, sealedPassed:number, sealedTotal:number}} m
 * @returns {{score:number, parts:object}}
 */
export function computeScore(m) {
  const x = m || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  // ① 结构：以「工具 100 / 体检项 80 / 场景 10 / 技能 10」为满分参照
  const structure = (
    Math.min(1, n(x.tools) / 100) +
    Math.min(1, n(x.guards) / 80) +
    Math.min(1, n(x.scenes) / 10) +
    Math.min(1, n(x.skills) / 10)
  ) / 4;

  // ② 真跑率：真实检查 / 全部检查
  const g = n(x.guards);
  const honesty = g > 0 ? (g - Math.min(g, n(x.selfOnlyGuards))) / g : 0;

  // ③ 场景完整率
  const sc = n(x.scenes);
  const complete = sc > 0 ? Math.min(1, n(x.scenesComplete) / sc) : 0;

  // ④ 真行为：记忆召回 + 封存集 各占一半
  //    没有数据时判 0（而不是 1）—— 「测不出来」不等于「好」
  const mt = n(x.memoryTotal);
  const memRatio = mt > 0 ? Math.min(1, n(x.memoryPassed) / mt) : 0;
  // 封存集优先用「通过题数/总题数」的真实得分率
  const sealedRatio = Number.isFinite(Number(x.sealedRate)) && Number(x.sealedRate) > 0
    ? Math.min(1, Number(x.sealedRate))
    : (n(x.sealedTotal) > 0 ? Math.min(1, n(x.sealedPassed) / n(x.sealedTotal)) : 0);
  const behavior = (memRatio + sealedRatio) / 2;

  const parts = { structure, honesty, complete, behavior };
  let score = 0;
  for (const p of SCORE_PARTS) score += parts[p.id] * p.weight;
  return { score: Math.round(score * 1000) / 10, parts, detail: { memRatio, sealedRatio } };
}

/**
 * 判一版相对上一版是「进步 / 退步 / 持平」
 *
 * @param {number} cur 当前分
 * @param {number} prev 上一版分
 * @param {number} tolerance 容差（小于它算持平）
 */
export function judgeDelta(cur, prev, tolerance) {
  const t = tolerance === undefined ? 0.5 : tolerance;
  if (prev === null || prev === undefined) return { kind: 'first', delta: 0 };
  const d = Math.round((cur - prev) * 10) / 10;
  if (Math.abs(d) < t) return { kind: 'flat', delta: d };
  return { kind: d > 0 ? 'better' : 'worse', delta: d };
}

// ══════════════════════════════════════════════════════════════════════
function loadBook() {
  try {
    const j = JSON.parse(fs.readFileSync(BOOK, 'utf8'));
    return { note: j.note || '', versions: Array.isArray(j.versions) ? j.versions : [] };
  } catch { return { note: '进化账本：每一版改变了什么、分数多少、保留还是回滚', versions: [] }; }
}

function saveBook(b) {
  fs.mkdirSync(path.dirname(BOOK), { recursive: true });
  fs.writeFileSync(BOOK, JSON.stringify(b, null, 2), 'utf8');
}

/** 从一个混杂的输出里抽 JSON（工具可能先打印进度再打 JSON） */
export function extractJson(s) {
  const t = String(s || '');
  // 从最后一个 '{' 开始配对找完整 JSON
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 量一次当前状态 —— **纯静态读取，毫秒级**
 *
 * ⚠ 2026-11-13 重写（第一版跑完整机制体检 + 目标验收，实测 10 分钟以上）
 *
 *   实测教训：第一版 measure() 里调 机制体检 --json（跑 8~12 分钟），
 *   结果两次都被 execFileSync 的 timeout 杀掉 → stdout 为空 →
 *   记成 0/0 → 综合分算成 49.2（假数据）。
 *
 *   **度量标准必须比被度量的周期更快**，否则「每版都量」根本执行不下去。
 */
function measure() {
  const out = { at: new Date().toISOString(), tools: 0, guards: 0, selfOnlyGuards: 0, scenes: 0, scenesComplete: 0, skills: 0, errors: [] };

  // ① 工具数
  try {
    out.tools = fs.readdirSync(path.join(HERE)).filter((f) => f.endsWith('.mjs')).length;
  } catch { out.errors.push('读工具目录失败'); }

  // ② 体检项数 + 只跑 selftest 的项数
  try {
    const src = fs.readFileSync(path.join(HERE, '机制体检.mjs'), 'utf8');
    out.guards = (src.match(/^\s{4}name:\s*'[^']+',/gm) || []).length;
    out.selfOnlyGuards = (src.match(/args:\s*\['--selftest'\]/g) || []).length;
  } catch { out.errors.push('读机制体检源码失败'); }

  // ③ 场景数
  try {
    out.scenes = fs.readdirSync(path.join(WB, '外壳', 'scenarios')).filter((f) => f.endsWith('.json')).length;
  } catch { out.errors.push('读场景目录失败'); }

  // ④ 六件套齐全的场景数（静态判断，不跑工具）
  try {
    const scenDir = path.join(WB, '外壳', 'scenarios');
    const memDir = path.join(WB, '数据', '.dsh', '场景记忆');
    const skillDir = path.join(WB, '数据', '.dsh', 'skills');
    let complete = 0;
    for (const f of fs.readdirSync(scenDir).filter((x) => x.endsWith('.json'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(scenDir, f), 'utf8').replace(/^\uFEFF/, ''));
        const id = j.id || f.replace(/\.json$/, '');
        const cn = j.name || j.title;
        const has1 = true;                                                   // ① 场景配置（正在读它）
        const has2 = fs.existsSync(path.join(scenDir, id + '-context.md'));   // ② 定位卡
        const has3 = cn && fs.existsSync(path.join(memDir, cn, '场景私有记忆.md')); // ③ 场景记忆
        const has4 = fs.existsSync(path.join(skillDir, id, 'SKILL.md'));      // ④ 专属技能
        const has5 = Array.isArray(j.panels) && j.panels.length > 0;          // ⑤ 专属面板
        const has6 = (j.panels || []).some((p) => p.type === 'harness' && p.sessionId) ||
                     (j.meta && j.meta.hubSessionId);                          // ⑥ 常驻会话
        if (has1 && has2 && has3 && has4 && has5 && has6) complete++;
      } catch { /* ignore */ }
    }
    out.scenesComplete = complete;
  } catch { out.errors.push('判场景完整率失败'); }

  // ⑤ 技能数
  try {
    out.skills = fs.readdirSync(path.join(WB, '数据', '.dsh', 'skills')).length;
  } catch { out.errors.push('读技能目录失败'); }

  // ⑥ 真行为：记忆召回（秒级 —— 读 记忆评估 的 JSON 汇总）
  out.memoryPassed = 0;
  out.memoryTotal = 0;
  try {
    const r = execFileSync(process.execPath, [path.join(HERE, '记忆评估.mjs'), '--json'], {
      cwd: WB, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    const j = extractJson(r);
    if (j && Array.isArray(j.reports)) {
      out.memoryTotal = j.reports.length;
      out.memoryPassed = j.reports.filter((x) => x && x.pass === true).length;
    }
  } catch (e) {
    const j = extractJson(String((e && e.stdout) || ''));
    if (j && Array.isArray(j.reports)) {
      out.memoryTotal = j.reports.length;
      out.memoryPassed = j.reports.filter((x) => x && x.pass === true).length;
    } else {
      out.errors.push('记忆评估读不到（behavior 分会偏低）');
    }
  }

  // ⑦ 真行为：封存集（秒级 —— 读 封存集判分 的 JSON）
  //
  // ⚠ 2026-11-13 修（第一版调用参数和字段都不对，白算成 0 分）
  //
  //   第一版：execFileSync(封存集判分.mjs, ['--json'])
  //   实测：它必须配合 --scene 或 --all 才有输出，
  //        单给 --json 会打印帮助（因此解析失败 → 判 0）。
  //        而且它的真实字段是每个场景的 `passed`（通过题数）和 `total`，
  //        **不是布尔 pass**。第一版按布尔过滤，永远得 0。
  //
  //   这就是「度量依赖的工具本身用错了」—— 和 hermes 报告里
  //   「一个错误的检查比没有检查更坏」是同一类问题。
  out.sealedPassed = 0;
  out.sealedTotal = 0;
  out.sealedRate = 0;
  try {
    const r = execFileSync(process.execPath, [path.join(HERE, '封存集判分.mjs'), '--all', '--json'], {
      cwd: WB, encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    const j = extractJson(r);
    if (j && Array.isArray(j.scenes) && j.scenes.length) {
      // 用「通过题数 / 总题数」算总得分率，而不是「几个场景达标」
      let p = 0, t = 0;
      for (const s of j.scenes) {
        p += Number(s.passed) || 0;
        t += Number(s.total) || 0;
      }
      out.sealedPassed = p;
      out.sealedTotal = t;
      out.sealedRate = t > 0 ? p / t : 0;
    }
  } catch (e) {
    const j = extractJson(String((e && e.stdout) || ''));
    if (j && Array.isArray(j.scenes) && j.scenes.length) {
      let p = 0, t = 0;
      for (const s of j.scenes) {
        p += Number(s.passed) || 0;
        t += Number(s.total) || 0;
      }
      out.sealedPassed = p;
      out.sealedTotal = t;
      out.sealedRate = t > 0 ? p / t : 0;
    } else {
      out.errors.push('封存集判分读不到（behavior 分会偏低）');
    }
  }

  const s = computeScore(out);
  out.score = s.score;
  out.parts = s.parts;
  return out;
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  进化账本 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】评分四维度');
  {
    // ⚠ 自测数据必须真的「全满」——四个维度的分子都要等于分母
    //
    //   2026-11-13 第二次修：加了 behavior 维度后，
    //   旧的自测只给 structure/honesty/complete 的数据，behavior 算成 0，
    //   于是「全满」只有 70 分。这**说明自测数据不完整，不是代码错**。
    const full = computeScore({
      tools: 100, guards: 80, selfOnlyGuards: 0, scenes: 10, scenesComplete: 10, skills: 10,
      memoryPassed: 9, memoryTotal: 9, sealedPassed: 9, sealedTotal: 9,
    });
    chk('全满 → 100 分', full.score === 100, String(full.score));
    chk('四个维度都有值', Object.keys(full.parts).length === 4, JSON.stringify(full.parts));

    // 反例：真跑率不满就不是 100
    const notFull = computeScore({
      tools: 100, guards: 80, selfOnlyGuards: 20, scenes: 10, scenesComplete: 10, skills: 10,
      memoryPassed: 9, memoryTotal: 9, sealedPassed: 9, sealedTotal: 9,
    });
    chk('反例：只跑 selftest 多 → 不到 100', notFull.score < 100, String(notFull.score));
  }

  console.log();
  console.log('【一之二】关键：behavior 维度测的是「真变强」不是「文件变多」');
  {
    // 同样的文件数，行为分不同 → 总分必须不同
    const base = { tools: 159, guards: 103, selfOnlyGuards: 4, scenes: 12, scenesComplete: 12, skills: 12 };
    const good = computeScore({ ...base, memoryPassed: 12, memoryTotal: 12, sealedPassed: 12, sealedTotal: 12 });
    const bad = computeScore({ ...base, memoryPassed: 3, memoryTotal: 12, sealedPassed: 3, sealedTotal: 12 });
    chk('同样的文件数，行为差 → 总分明显低',
      bad.score < good.score - 15, good.score + ' vs ' + bad.score);
    chk('反例：行为数据缺失时判 0（不是判满分）',
      computeScore({ ...base }).parts.behavior === 0, 'behavior=' + computeScore({ ...base }).parts.behavior);
  }

  console.log();
  console.log('【二】反例：删检查 / 加空场景 都不能刷分');
  {
    const full = computeScore({ tools: 150, guards: 99, selfOnlyGuards: 3, scenes: 12, scenesComplete: 12, skills: 12 });

    // 反例 A：大量只跑 selftest（假装有很多检查）
    const selfOnly = computeScore({ tools: 150, guards: 99, selfOnlyGuards: 60, scenes: 12, scenesComplete: 12, skills: 12 });
    chk('反例A：只跑 selftest 的项变多 → 分数降',
      selfOnly.score < full.score, full.score + ' → ' + selfOnly.score);

    // 反例 B：加了很多场景但六件套不齐（凑数）
    const emptyScenes = computeScore({ tools: 150, guards: 99, selfOnlyGuards: 3, scenes: 30, scenesComplete: 12, skills: 12 });
    chk('反例B：加空场景凑数 → 完整率降',
      emptyScenes.parts.complete < full.parts.complete, full.parts.complete.toFixed(2) + ' → ' + emptyScenes.parts.complete.toFixed(2));
  }

  console.log();
  console.log('【三】delta 判定');
  {
    chk('进步：+2 分', judgeDelta(90, 88).kind === 'better', JSON.stringify(judgeDelta(90, 88)));
    chk('退步：-2 分', judgeDelta(86, 88).kind === 'worse', JSON.stringify(judgeDelta(86, 88)));
    chk('持平：+0.2（容差内）', judgeDelta(88.2, 88).kind === 'flat', JSON.stringify(judgeDelta(88.2, 88)));
    chk('首版：无上版', judgeDelta(88, null).kind === 'first');
    chk('反例：退步的 delta 是负数', judgeDelta(80, 90).delta < 0, String(judgeDelta(80, 90).delta));
  }

  console.log();
  console.log('【四】extractJson 能处理混杂输出（2026-11-13 加）');
  {
    // ⚠ 为什么加这一段：
    //   第一版直接 JSON.parse(stdout) 就记 0/0，把基线算成 49.4 分。
    //   而机制体检 --json 会先打印进度行再打 JSON ——
    //   如果测量工具自己读错了，整个账本的数据都是假的。
    //   所以「能不能从混杂输出里抽出 JSON」本身必须有测试。
    const a = extractJson('{"passed":97,"total":98}');
    chk('正例：纯 JSON', a && a.passed === 97, JSON.stringify(a));
    const b = extractJson('跑 x 项...\n{"passed":97,"total":98}');
    chk('正例：前面有进度文本', b && b.total === 98, JSON.stringify(b));
    const c = extractJson('warn\n{"passed":97,"total":98}\ndone');
    chk('正例：后面有尾巴', c && c.passed === 97, JSON.stringify(c));
    chk('反例：没有 JSON → null', extractJson('全部通过') === null);
    chk('反例：null 输入 → null', extractJson(null) === null);
    chk('反例：截断的 JSON → null', extractJson('{"passed":97') === null);
  }

  console.log();
  console.log('【五】关键：这个工具补的是什么');
  // ⚠ 2026-11-14 修：这里原来是 `chk(..., true)` —— **写死的 true**
  //
  //   名字是全文件最关键的一条（"没有账本 = 只有维护，没有进化"），
  //   判据却是字面量 true，永远通过。
  //   这正是「看起来有实际是空」：读代码时像是验了什么，实际什么都没验。
  //
  //   被 `检查器可靠性体检` 抓到了（它的判据是「chk 条件恒为 true
  //   且没有同名 false 分支」），机制体检因此 FAIL。
  //
  //   现在改成真实判据：账本必须真的记录 delta（方向）和 archive（记忆）。
  //   而且是**在真实账本文件上验**，不是验常量。
  {
    let ledger = null;
    try { ledger = JSON.parse(fs.readFileSync(BOOK, 'utf8')); } catch { /* 可能不存在 */ }

    // ⚠ 账本的实际结构是 { note, versions: [...] }，不是 history
    //   （我第一版猜成 history，判据当场报错 —— 这正好证明判据不是装饰）
    const vers = (ledger && Array.isArray(ledger.versions)) ? ledger.versions : [];
    const hasArchive = vers.length > 0;
    const hasDelta = vers.some((h) => h && h.delta !== undefined && h.delta !== null);

    chk('关键：账本真的记了记忆（archive）', hasArchive,
      vers.length ? (vers.length + ' 个版本') : '账本为空');
    chk('关键：账本真的记了方向（delta）', hasDelta,
      hasArchive ? (vers.filter((h) => h.delta != null).length + ' 条有 delta') : '');

    // 反例：给一个「只有维护没有进化」的账本（全 delta=null），必须判不合格
    const flatHistory = [{ score: 90, delta: null }, { score: 90, delta: null }];
    const flatHasDelta = flatHistory.some((h) => h.delta !== undefined && h.delta !== null);
    chk('反例：全是 delta=null 的账本必须判不合格', flatHasDelta === false, '');

    // 反例：空账本必须判不合格
    chk('反例：空账本必须判不合格', [].length > 0 === false, '');
  }
  chk('关键：四维度里必须有 behavior（否则只数文件测不出变强）',
    SCORE_PARTS.length === 4 && SCORE_PARTS.some((p) => p.id === 'behavior'),
    SCORE_PARTS.map((p) => p.name).join('/'));

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const book = loadBook();

  if (has('history') || (!has('baseline') && !has('record') && !has('best'))) {
    console.log('='.repeat(84));
    console.log('  进化账本 —— 每一版改变了什么、分数多少');
    console.log('='.repeat(84));
    console.log();
    if (!book.versions.length) {
      console.log('  （空账本）');
      console.log();
      console.log('  为什么需要它：');
      console.log('    机制体检能告诉你「现在多少分」，但从不说「比上一版好了吗」。');
      console.log('    没有这个对比，跑体检 → 红了修 → 修完再跑，这叫**维护**，不是进化。');
      console.log();
      console.log('  进化需要两个东西：');
      console.log('    · 方向 = 这一版比上一版好在哪（delta）');
      console.log('    · 记忆 = 哪些改动真的有效（archive）');
      console.log();
      console.log('  开始记录：');
      console.log('    node 工具/进化账本.mjs --baseline         # 改之前先量一次');
      console.log('    ... 做改动 ...');
      console.log('    node 工具/进化账本.mjs --record --note "改了什么"');
      return;
    }

    console.log('  版本历史（' + book.versions.length + ' 条）:');
    console.log();
    console.log('  ' + '时间'.padEnd(20) + '分数'.padEnd(8) + 'delta'.padEnd(9) + '判定'.padEnd(8) + '说明');
    console.log('  ' + '─'.repeat(80));

    let prev = null;
    for (const v of book.versions) {
      const d = judgeDelta(v.score, prev);
      const mark = d.kind === 'better' ? '↑进步' : d.kind === 'worse' ? '↓退步' : d.kind === 'flat' ? '=持平' : '首版';
      console.log('  ' +
        String(v.at || '').slice(0, 19).padEnd(20) +
        (v.score + '').padEnd(8) +
        (d.kind === 'first' ? '-' : (d.delta > 0 ? '+' : '') + d.delta).padEnd(9) +
        mark.padEnd(8) +
        String(v.note || '').slice(0, 34));
      prev = v.score;
    }

    console.log();
    const best = book.versions.reduce((a, b) => (b.score > a.score ? b : a), book.versions[0]);
    console.log('  历史最好: ' + best.score + ' 分（' + String(best.at || '').slice(0, 19) + '）' + (best.note ? '  ' + best.note : ''));
    return;
  }

  if (has('best')) {
    if (!book.versions.length) { console.log('  （空账本）'); return; }
    const best = book.versions.reduce((a, b) => (b.score > a.score ? b : a), book.versions[0]);
    console.log('  历史最好分: ' + best.score);
    console.log('  时间: ' + best.at);
    console.log('  说明: ' + (best.note || '(无)'));
    return;
  }

  // ── 记录（baseline 和 record 都是记一次，区别只是 note 前缀）──
  const isBaseline = has('baseline');
  const note = val('note') || (isBaseline ? '（基线）' : '（未说明改了什么）');

  console.log('  正在量当前状态（机制体检 + 目标验收，约 5 分钟）…');
  const m = measure();
  if (m.errors.length) {
    console.log('  ⚠ 有读数失败: ' + m.errors.join('; '));
  }

  const prev = book.versions.length ? book.versions[book.versions.length - 1].score : null;
  const d = judgeDelta(m.score, prev);

  const entry = {
    at: m.at,
    kind: isBaseline ? 'baseline' : 'record',
    note,
    score: m.score,
    parts: m.parts,
    tools: m.tools,
    guards: m.guards + '（其中只跑 selftest ' + m.selfOnlyGuards + ' 项）',
    scenes: m.scenes + '（六件套齐全 ' + m.scenesComplete + '）',
    skills: m.skills,
    delta: d.delta,
    verdict: d.kind,
  };
  book.versions.push(entry);
  saveBook(book);

  console.log();
  console.log('='.repeat(72));
  console.log('  ' + (isBaseline ? '基线已记录' : '本版已记录'));
  console.log('='.repeat(72));
  console.log();
  console.log('  综合分:  ' + m.score + ' / 100');
  console.log();
  console.log('  覆盖面:  ' + m.tools + ' 工具 / ' + m.guards + ' 体检项 / ' + m.scenes + ' 场景 / ' + m.skills + ' 技能');
  console.log('  六件套:  ' + m.scenesComplete + ' / ' + m.scenes + ' 个场景齐全');
  console.log('  真跑率:  ' + (m.guards - m.selfOnlyGuards) + ' / ' + m.guards + ' 项跑真实检查');
  console.log();
  for (const p of SCORE_PARTS) {
    const v = m.parts[p.id];
    console.log('    ' + p.name.padEnd(12) + (Math.round(v * 1000) / 10 + '%').padEnd(8) +
      '权重 ' + Math.round(p.weight * 100) + '%  ' + p.why);
  }
  console.log();

  if (d.kind === 'first') {
    console.log('  （首版，没有可比的上一版）');
  } else if (d.kind === 'better') {
    console.log('  ↑ 进步 +' + d.delta + ' 分（上一版 ' + prev + '）→ 建议**保留**这一版');
  } else if (d.kind === 'worse') {
    console.log('  ↓ 退步 ' + d.delta + ' 分（上一版 ' + prev + '）→ 建议**回滚**');
    console.log('    回滚：node 工具/回滚.mjs --list 看有哪些快照');
  } else {
    console.log('  = 持平 ' + (d.delta > 0 ? '+' : '') + d.delta + ' 分（上一版 ' + prev + '）');
    console.log('    持平不代表没价值 —— 可能是「修了一个没被检查覆盖的问题」。');
    console.log('    这种情况应该在 --note 里写清楚，并考虑**补一条检查**让它下次可量化。');
  }
  console.log('='.repeat(72));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
