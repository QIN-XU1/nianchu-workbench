#!/usr/bin/env node
/**
 * 证据溯源审计（evidence provenance）—— 对手证据引的是对方源码，还是我们自己的分析？
 *
 * ══ 为什么必须做这个 ═════════════════════════════════════════
 * 目标原文：「每轮都要有可复算的证据（路径:行号…）…不得把『已写入』当『已验证』」。
 * 矩阵里大量对手证据引用的是**我们自己写的分析文档**（three.md / new3.md / hermes-ecc.md …），
 * 那是二手证据：即使当初读了代码，现在也无法复算。这个工具把「二手证据占比」变成可复算的数字。
 *
 * ══ 判定（保守）══
 *   REAL —— 引用的路径能在 D:/refs/<id> 下找到真实文件
 *   OWN  —— 只引我们自己的文档，或路径找不到
 *   NONE —— 没有证据文本
 *
 * ══ 单一来源 ═════════════════════════════════════════════════
 * 抽取/判定实现**只保留一份**在 tools/evolve/lib/evidence-provenance.mjs，
 * 本工具与 fair-compare 都 import 它。分叉是 bug 之母（2026-11-19 已吃过大亏）。
 *
 * 用法：node tools/evolve/audit-evidence-provenance.mjs [--json] [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPaths, classifyEvidence } from './lib/evidence-provenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/**
 * ══ 自检（2026-11-19 加的，因为我自己把正则改坏过两次）══
 * 改抽取/判定逻辑时，这组已知样本必须先通过；否则「工具坏了」会伪装成「证据不足」。
 */
{
  const probes = [
    ['packages/terminal-core/src/index.ts（终端）', 'packages/terminal-core/src/index.ts'],
    ['10-源码/会话与切换/sessions.mjs、换会话.mjs', '10-源码/会话与切换/sessions.mjs'],
    ['见 apps/renderer/src/styles/tokens.css:63 的注释', 'apps/renderer/src/styles/tokens.css'],
  ];
  const bad = [];
  for (const [text, want] of probes) {
    if (!extractPaths(text).includes(want)) bad.push({ want, got: extractPaths(text) });
  }
  if (bad.length) {
    console.error('');
    console.error('  ✗ 抽取自检失败 —— 判定工具本身坏了，本次结论不可信：');
    for (const b of bad) console.error('    want=' + b.want + ' got=' + JSON.stringify(b.got));
    process.exitCode = 2;
    process.exit(2);
  }
  if (!process.argv.includes('--quiet')) console.log('  ✓ 抽取自检通过（ASCII / 中文 / 带行号 三类样本均命中）');
}

/**
 * ══ 根目录自检（2026-11-20 加的）══
 * 背景：weknora / open-design / craft-anything / aionui / ecc / pi 的仓库解压成
 * `<名字>-main/` 嵌套结构，rootsOf 只返回外层目录 → 这些仓库的一切证据被判 OWN，
 * REAL 被人为压到 28.6%。修好 rootsOf 后 REAL 涨到 42.6%。
 *
 * 这组断言锁两件事：
 *   ① 真路径必须判 REAL（否则根目录解析又退化了）
 *   ② **假路径必须仍判 OWN**（否则这次修复变成放水）
 * 任何一条不满足都直接退出码 2 —— 与「证据不足」区分开。
 */
{
  const cases = [
    ['weknora', 'cli/cmd/mcp/mcp.go', 'REAL'],
    ['weknora', 'cli/cmd/mcp/__not_exist__.go', 'OWN'],
    ['open-design', 'apps/daemon/src/critique/conformance-history.ts', 'REAL'],
    ['craft-anything', 'crates/ai/src/context.rs', 'REAL'],
    ['craft-anything', 'crates/ai/src/__nope__.rs', 'OWN'],
    ['ecc', 'src/llm/tools/executor.py', 'REAL'],
    ['hermes', 'agent/context_breakdown.py', 'REAL'],
    ['hermes', 'agent/__nope__.py', 'OWN'],
    ['openclaw', 'extensions/browser/src/browser/extension-relay/relay-coexistence.e2e.test.ts', 'REAL'],
  ];
  const bad = [];
  for (const [id, rel, want] of cases) {
    const got = classifyEvidence(id, '`' + rel + '`');
    if (got !== want) bad.push({ id, rel, want, got });
  }
  if (bad.length) {
    console.error('');
    console.error('  ✗ 根目录自检失败 —— REAL 判定不可信，本次结论作废：');
    for (const b of bad) console.error(`    ${b.id} ${b.rel} want=${b.want} got=${b.got}`);
    process.exitCode = 2;
    process.exit(2);
  }
  if (!process.argv.includes('--quiet')) console.log('  ✓ 根目录自检通过（真路径→REAL · 假路径→OWN · 9 条样本）');
}

const mx = JSON.parse(readFileSync(join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));

/**
 * ══ 键名自检（2026-11-21 加的）══
 * 背景：矩阵里曾混入 `pi-main` / `WeKnora` 两个**重复列**（早期脚本用目录名当键）。
 * 它们对所有工具都不可见（classifyEvidence('pi-main') 找不到根 → 永远 OWN），
 * 于是 10 格证据既不计入 REAL、也不被 fair-compare 读到 —— **静默的数据丢失**。
 * 现在任何非规范对手键都直接报错退出，逼着修。
 */
{
  /**
   * 规范键名 —— 从 matrix.subjects 动态派生，不再硬编码。
   *
   * 为什么要改（第 132 轮）：
   *   原来是硬编码的 23 个键。目标要求 29 个参照项目，本轮加 metagpt 时
   *   自检立刻报「非规范对手键」—— 这是好事（自检起作用了），
   *   但根因是**清单有两处真相**：subjects 数组 + CANON 集合。
   *   两处真相必然漂移。改成单一权威源：CANON 从 subjects 派生。
   *
   * 同时保留「反向检查」：如果某格有 subjects 里没有的键，仍然报错。
   * 这样既不会漏，也不需要每次加项目都改两个地方。
   */
  const CANON = new Set(mx.subjects.map((s) => s.id));
  const bad = [];
  for (const g of mx.dimensions) {
    for (const it of g.items) {
      for (const k of Object.keys(it)) {
        if (k === 'id' || k === 'name' || k === 'desc' || k.startsWith('_')) continue;
        if (!CANON.has(k)) bad.push(it.id + '.' + k);
      }
    }
  }
  if (bad.length) {
    console.error('');
    console.error('  ✗ 键名自检失败 —— 存在非规范对手键（这些格的数据对工具不可见）：');
    for (const b of bad) console.error('    ' + b);
    console.error('    修法：把键名改成规范 id（如 pi-main→pi、WeKnora→weknora），或删除重复键。');
    process.exitCode = 2;
    process.exit(2);
  }
  if (!process.argv.includes('--quiet')) console.log('  ✓ 键名自检通过（无重复列 / 无非规范对手键）');
}

let real = 0, own = 0, none = 0, absent = 0, mixed = 0;
const perOpp = {};

/**
 * 缺席核验（ABSENT）—— 第四类，与 REAL/OWN/NONE 并列。
 *
 * ══ 为什么要单独一类（第 125 轮发现）══════════════════════════════
 * 之前 OWN 把「判无 + 做了缺席核验」也算进去，导致数字失真：
 *   solo-to-team-skills 的 23 格 OWN 里 20 格是「无」判定 ——
 *   它们**不可能**指向对方某个实现文件，因为那个文件不存在。
 *
 * 把它算作 OWN（「只引我们自己的分析文档」）是口径错误：
 * 它不是「证据不硬」，而是**证据的性质不同**。
 *
 * 缺席核验的可复算形式是「扫描命令 + 0 命中」，证据在**扫描过程**里，
 * 不在某个文件里。所以它既不该算 REAL（没有实现文件），
 * 也不该算 OWN（不是"没查"），更不该算 NONE（不是"没证据"）。
 *
 * 判据：判定为「无」或「判不了」，且证据里带缺席核验标志。
 */
/**
 * 缺席核验的两种形态：
 *  A. 强缺席（判「无」或「判不了」+ 扫描 0 命中 / 缺席核验 / 查了未找到）—— 证据在扫描过程里
 *  B. 弱缺席（判「判不了」+ 报告未提及）—— 我们没查到，如实标 UNKNOWN
 *
 * 两者都**不是**「只引我方文档」（OWN），因为它们的语义是「查了/查不到」，
 * 而不是「引了一份我们的分析当证据」。
 *
 * ══ 第 134 轮补（openhands 教训）══════════════════════════════════
 * openhands 是 Canvas UI，agent 运行时在**未 vendored 的外部依赖**里。
 * 于是 9 个格子只能判「判不了」，证据写「按 X 扫描未找到 / 本仓无从核验」。
 * 这些格没有一个实现文件可指 —— 但它们的证据是**扫描记录**，不是"只引我方文档"。
 * 补进 STRONG：查了没有 ≠ 循环论证。
 *
 * 但 B 类不能升级为 REAL —— 它只是诚实标了 UNKNOWN，不是核实过。
 */
const ABSENT_STRONG = /缺席核验|扫描 .*；关键词|实测 0 个|0 命中|无源码可核验|无 .* 实现|扫描.*0 命中|未找到|无从核验|无从判定|本仓无从|本仓未找到|未命中|无[^。]{0,14}可核/;
const ABSENT_WEAK = /报告未提及|报告未描述|未提及|未描述|无任何|不是消息通道|没有 IM/;

function isAbsentCheck(verdict, ev) {
  const text = String(ev);
  // A. 强缺席：判「无」或「判不了」+ 强标志
  if ((verdict === '无' || verdict === '判不了') && ABSENT_STRONG.test(text)) return true;
  // B. 弱缺席：**只有判「判不了」** 才认（判「部分/有」却只说"报告未提及"仍是 OWN —— 那是证据不足）
  if (verdict === '判不了' && ABSENT_WEAK.test(text)) return true;
  return false;
}

/**
 * 「有据可查的判定」vs「凭分析的判定」分开统计。
 *
 * 2026-11-21 加的（第 57 轮教训）：一个格子判「有/部分」但证据只是我们自己的分析文档，
 * 它和「判不了」在可信度上没差别 —— 只是它更容易被误读成「已核实」。
 * 所以单独列出来，作为**待办清单**，而不是混进 REAL 数字里。
 */
const unverifiedClaims = [];
for (const g of mx.dimensions) {
  for (const it of g.items) {
    for (const [k, v] of Object.entries(it)) {
      if (k === 'id' || k === 'name' || k === 'us') continue;
      if (!Array.isArray(v) || v.length < 2) continue;
      const st = classifyEvidence(k, v[1]);
      if (st === 'REAL') {
        real++;
        perOpp[k] = perOpp[k] || { REAL: 0, OWN: 0, NONE: 0, ABSENT: 0, MIXED: 0 };
        perOpp[k].REAL++;
      } else if (st === 'MIXED') {
        // 有对方真实路径，但也引了我方分析文档 → 半硬
        mixed++;
        perOpp[k] = perOpp[k] || { REAL: 0, OWN: 0, NONE: 0, ABSENT: 0, MIXED: 0 };
        perOpp[k].MIXED++;
      } else if (st === 'NONE') {
        none++;
        perOpp[k] = perOpp[k] || { REAL: 0, OWN: 0, NONE: 0, ABSENT: 0, MIXED: 0 };
        perOpp[k].NONE++;
      } else if (isAbsentCheck(v[0], v[1])) {
        // 判无 + 做了缺席核验：证据在扫描过程里，不在文件里
        absent++;
        perOpp[k] = perOpp[k] || { REAL: 0, OWN: 0, NONE: 0, ABSENT: 0, MIXED: 0 };
        perOpp[k].ABSENT++;
      } else {
        own++;
        perOpp[k] = perOpp[k] || { REAL: 0, OWN: 0, NONE: 0, ABSENT: 0, MIXED: 0 };
        perOpp[k].OWN++;
      }
      // 判了「有/部分」却没有可核验路径 → 未核实的断言
      // A10/A15 是**声明过的非目标**，它们本来就不是「实现对比」，不计入待办清单，避免噪音
      const NON_GOAL = new Set(['A10', 'A15']);
      if ((v[0] === '有' || v[0] === '部分') && st !== 'REAL' && !NON_GOAL.has(it.id)) {
        unverifiedClaims.push({ dim: it.id, opp: k, verdict: v[0], ev: String(v[1]).replace(/\s+/g, ' ').slice(0, 70) });
      }
    }
  }
}

const total = real + own + none + absent + mixed;
const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);

if (process.argv.includes('--write')) {
  const OUT = join(ROOT, 'prototype/hermes-agents/matrix-data.json');
  const cur = JSON.parse(readFileSync(OUT, 'utf8'));
  cur._evidenceProvenance = {
    at: new Date().toISOString(),
    tool: 'tools/evolve/audit-evidence-provenance.mjs --write',
    totalCells: total, real, own, none, absent, mixed,
    pctReal: pct(real), pctOwn: pct(own), pctAbsent: pct(absent),
    说明: '对手侧证据里 ' + pct(real) + '% 能复算到对方仓库真实路径；' +
      pct(absent) + '% 是「缺席核验」（判无 + 扫描 0 命中，证据在扫描过程而非文件里）；' +
      pct(own) + '% 只引用我们自己的分析文档（真实待办）。',
    影响: 'fair-compare 的领先/落后只能读作**暂定结论**，不是已核实。',
  };
  writeFileSync(OUT, JSON.stringify(cur, null, 2) + '\n', 'utf8');
  console.log('  ✓ 已回写 _evidenceProvenance：REAL ' + real + '/' + total + '（' + pct(real) + '%）');
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, real, own, none, absent, pctReal: pct(real), pctOwn: pct(own), pctAbsent: pct(absent), perOpp }, null, 2));
} else {
  console.log('');
  console.log('  证据溯源审计（对手证据引用的是对方源码，还是我们自己的分析文档）');
  console.log('  ' + '─'.repeat(78));
  console.log('  总证据格: ' + total);
  console.log('  REAL  （纯对方源码路径）: ' + real + '  (' + pct(real) + '%)');
  console.log('  MIXED （对方源码 + 我方分析文档混引）: ' + mixed + '  (' + pct(mixed) + '%)');
  console.log('  ABSENT（缺席核验：判无 + 扫描 0 命中，证据在过程里）: ' + absent + '  (' + pct(absent) + '%)');
  console.log('  OWN   （只引用我们自己的分析文档 / 路径找不到）: ' + own + '  (' + pct(own) + '%)');
  console.log('  NONE  （无证据）: ' + none + '  (' + pct(none) + '%)');
  console.log('');
  const sorted = Object.entries(perOpp).sort((a, b) => b[1].OWN - a[1].OWN);
  console.log('  ' + '对手'.padEnd(20) + 'REAL   MIXED  ABSENT    OWN  NONE');
  for (const [k, v] of sorted) {
    console.log('  ' + k.padEnd(20) + String(v.REAL).padStart(4) + String(v.MIXED || 0).padStart(8) +
      String(v.ABSENT || 0).padStart(8) + String(v.OWN).padStart(7) + String(v.NONE).padStart(5));
  }
  console.log('');
  const state = own === 0 ? 'PASS' : 'WARN';

  // ── 未核实断言清单（判「有/部分」但证据不可核验）──
  if (process.argv.includes('--strict') && unverifiedClaims.length > 0) {
    console.log('  ✗ 未核实断言（判「有/部分」但证据抽不出可核验路径）：' + unverifiedClaims.length + ' 格');
    for (const c of unverifiedClaims) {
      console.log('    · ' + c.dim + ' ' + c.opp.padEnd(20) + c.verdict + '  ' + c.ev);
    }
    console.log('');
  }

  console.log('  四态: ' + state + ' —— ' + (state === 'PASS' ? '全部对手证据均可复算到源码' :
    '仍有 ' + own + ' 格只引我方文档（真实待办）；' + absent + ' 格缺席核验属正常'));
  console.log('  未核实断言（判「有/部分」但证据抽不出路径）: ' + unverifiedClaims.length + ' 格'
    + (unverifiedClaims.length ? '  ← 这些是最该先补的（跑 --strict 看清单）' : ''));
  console.log('');
  if (process.argv.includes('--strict') && unverifiedClaims.length > 0) process.exitCode = 4;
  else process.exitCode = state === 'PASS' ? 0 : 3;
}
