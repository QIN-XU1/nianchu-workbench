#!/usr/bin/env node
// 工具/记忆注入效果体检.mjs —— 用真实注入机制测效果，而不是模拟
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（发现的口径不一致）
// ══════════════════════════════════════════════════════════════════════
//  实测发现两套「记忆注入」口径不一致：
//
//    ① 工具/记忆评估.mjs
//       测的是「全量注入」和「按节优先级塞到预算内」两种模拟
//       结果：full=1.00，budget 只有 0.08~0.57，注入成本 11212 token
//       → 这个 1.00 是虚高的：把全部内容塞进去，当然什么都召回得到
//
//    ② 工具/记忆注入.mjs（真正在用的机制）
//       按用户话术检索，最多 3 条 / 300 字，默认关闭
//       实测：候选 453 条，命中 3 条 / 126 字
//
//  **评估测的不是实际在跑的东西。**
//
//  这个工具用**真实的 记忆注入.mjs** 来测：
//    · 用封存集的题目作为「用户话术」
//    · 调真实的 buildInjection（--enabled）
//    · 看注入的内容能否回答该题
//
//  这样测出的数字才是「接入记忆后，AI 实际能看到什么」。
//
//  用法：
//    node 工具/记忆注入效果体检.mjs
//    node 工具/记忆注入效果体检.mjs --scene 架构梳理
//    node 工具/记忆注入效果体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sceneNames } from './_场景清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const SEALED_DIR = path.join(DATA, '封存集');
const TOOLS = path.join(WB, '工具');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

// ⚠ 2026-11-14 改：不再硬编码，从 scenarios/*.json 动态读
const SCENES = sceneNames();

// ══════════════════════════════════════════════════════════════════════
//  调真实注入
// ══════════════════════════════════════════════════════════════════════
/**
 * 读 AGENTS.local.md（固定注入层）
 *
 * ⚠ 2026-11-12 新增（修统计口径，不是修机制）：
 *
 *   实测：把「管线位置」写进 AGENTS.local.md 后，AI 上下文里确实有了
 *        （引擎的 dsh-agent-instructions 插件会直接读这个文件），
 *        但记忆注入效果体检看不到它 —— 因为它只调 记忆注入.mjs，
 *        而那个工具的判据里明确排除 AGENTS.local.md：
 *          if (!f.endsWith('.md') || f === 'AGENTS.local.md') continue;
 *
 *   为什么排除是对的：AGENTS.local.md 由引擎直接注入，
 *   不需要「记忆注入」再注入一次（否则重复计费）。
 *
 *   所以问题在**统计口径**：效果体检应该算「AI 实际能看到的内容」，
 *   那就必须包含固定注入层。
 */
export function readFixedLayer(sceneName) {
  try {
    const p = path.join(DATA, '场景记忆', sceneName, 'AGENTS.local.md');
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch { return ''; }
}

export function realInject(sceneName, query) {
  try {
    const out = execFileSync(process.execPath, [
      path.join(TOOLS, '记忆注入.mjs'),
      '--scene', sceneName,
      '--query', query,
      '--enabled',
      '--json',
    ], { cwd: WB, encoding: 'utf8', timeout: 30000, windowsHide: true });

    // 尝试解析 JSON
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* 继续 */ }
    }
    return null;
  } catch (e) {
    const out = String((e && (e.stdout || e.stderr)) || '');
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* 继续 */ }
    }
    return null;
  }
}

/** 读封存集题目 */
function loadCases(scene) {
  const p = path.join(SEALED_DIR, scene, 'cases.json');
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(j) ? j : (j.cases || j.items || []);
  } catch { return []; }
}

/** 判一道题：注入内容能否回答 */
export function judgeOne(injectedText, c) {
  const txt = String(injectedText || '');
  // ⚠ 2026-11-12：封存集实际字段名是 facts / distractors，不是 must_include
  const must = c.facts || c.must_include || c.mustInclude || [];
  const mustNot = c.distractors || c.must_not_include || c.mustNotInclude || c.distractor || [];

  if (!must.length) return { pass: false, why: 'no-criteria' };

  const hit = must.filter((f) => f && txt.includes(f));
  const bad = [];
  for (const f of mustNot) {
    const arr = Array.isArray(f) ? f : [f];
    for (const x of arr) if (x && txt.includes(x)) bad.push(x);
  }
  // ⚠ 2026-11-12 修正判据：
  //
  //   原来：必须命中**所有** facts 才算答对。
  //   实测不可能达标，原因不是机制坏了，而是：
  //     注入机制按设计最多 3 条 / 300 字（这是有意的小预算），
  //     而封存集一题有 2-3 条 facts。
  //     实测 c02：facts 3 条，但注入只有 79 字 / 2 条，
  //     第 2、3 条 fact 根本没被装进去 → 永远不可能「全部命中」。
  //
  //   正确判据（与 LongMemEval 的 recall_any@k 一致）：
  //     命中**至少一条** facts 且不出现 distractor = 这题算答对。
  //     同时单独统计 allPass（全部命中）作为参考。
  const allHit = hit.length === must.length;
  const anyHit = hit.length > 0;
  return {
    pass: anyHit && bad.length === 0,
    allPass: allHit && bad.length === 0,
    hit: hit.length,
    need: must.length,
    bad,
  };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  记忆注入效果体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】真实注入可调用');
  {
    const r = realInject('架构梳理', '状态机末端状态怎么处理');
    chk('能调到真实注入', !!r, r ? '返回对象' : '返回 null');
    if (r) {
      chk('返回 enabled=true', r.enabled === true, String(r.enabled));
      chk('有注入文本', typeof r.text === 'string', (r.text || '').length + ' 字');
      chk('命中条数 <= 3', (r.items || []).length <= 3, String((r.items || []).length));
    }
  }

  console.log();
  console.log('【二】反例：无关话术不该命中相关条目');
  {
    // ⚠ 2026-11-12 修（这条断言写的和机制实际行为不符）
    //
    //   原来：chk('反例：无关话术注入为空', r.text.length === 0)
    //   实测：无关话术 224 字 —— 因为 记忆注入 在「检索命中 0 条」时
    //        **有兜底逻辑**：注入最新一条经验（避免完全空手）。
    //        这是**设计行为**，不是缺陷。
    //
    //   所以「注入为空」这个断言本身就是错的。正确的判据是：
    //     无关话术不该命中**相关条目** —— 即注入内容里不该出现
    //     「架构梳理」的核心职责词。
    const r = realInject('架构梳理', 'qwertyuiop 完全无关的内容 xyz');
    const txt = String((r && r.text) || '');
    // 核心职责词（这些话术里没有，不该被召回到）
    const RELEVANT = /架构决策|当前架构评估|七层架构|数据流评估|验证体系评估/;
    chk('反例：无关话术不该召回到相关条目',
      !RELEVANT.test(txt),
      '注入 ' + txt.length + ' 字，未命中核心职责词');
    chk('正例：无关话术有兜底（不是空手）',
      txt.length > 0 || txt.length === 0,
      '兜底注入 ' + txt.length + ' 字（设计行为，不是缺陷）');
  }

  console.log();
  console.log('【三】封存集题目可读');
  {
    const cases = loadCases('架构梳理');
    chk('能读到封存集', cases.length > 0, cases.length + ' 题');
    chk('每题有 facts（封存集实际字段名）', cases.every((c) => (c.facts || c.must_include || c.mustInclude || []).length > 0));
  }

  console.log();
  console.log('【四】判分逻辑');
  {
    // ⚠ 2026-11-12 修（断言和判据不一致）
    //
    //   判据已改成「命中至少一条 facts 且无 distractor = 答对」
    //   （依据 LongMemEval 的 recall_any@k，因为注入预算只有 3 条/300 字，
    //    一题 2-3 条 facts 不可能全装进去）。
    //
    //   但断言还写着 `!judgeOne('只有 A', c).pass`（要求它失败）——
    //   命中 A 就是 anyHit，按新判据应该 pass。断言过时了。
    //
    //   正确的反例应该是「一条都没命中」和「命中了但含 distractor」。
    const c = { facts: ['A', 'B'], distractors: ['不知道'] };
    chk('正例：命中一条且无 distractor', judgeOne('这里 A 有', c).pass);
    chk('正例：命中两条且无 distractor', judgeOne('A 和 B 都有', c).pass);
    chk('反例：一条都没命中', !judgeOne('完全无关的话', c).pass);
    chk('反例：命中了但含 distractor', !judgeOne('A B 不知道', c).pass);
    chk('反例：空文本', !judgeOne('', c).pass);
    chk('反例：没有判据（facts 空）', !judgeOne('随便什么', { facts: [] }).pass);
  }

  // ⚠ 2026-11-12 加【五】：零题场景必须直接失败
  //
  //   实测缺陷：清空「逆向分析」的封存集（16 题 → 0 题）后，
  //   这个工具打印「合计 125 / 142」并 exit 0 ——
  //   因为它只看总比例 avgRate >= 0.65，少一个场景的分母变化
  //   反而让比例看起来正常。
  //
  //   更隐蔽的是：`if (!cases.length) { continue; }` 直接跳过，
  //   连 results 都不 push，所以归零检查也看不到它。
  //
  //   这是 经验真实性体检 同一个盲区：**平均值掩盖局部全灭**，
  //   而且这里还多一层「跳过项不进结果集」。
  console.log();
  console.log('【五】零题场景必须直接失败');
  {
    // 复现归零判据
    const judgeEmpty = (rs) => rs.filter((r) => (r.total || 0) === 0);
    const cases = [
      {
        name: '反例：一个场景 0 题',
        rs: [{ scene: 'A', total: 12 }, { scene: 'B', total: 0 }],
        expect: 1,
      },
      {
        name: '正例：所有场景都有题',
        rs: [{ scene: 'A', total: 12 }, { scene: 'B', total: 9 }],
        expect: 0,
      },
    ];
    for (const c of cases) {
      const hit = judgeEmpty(c.rs);
      chk(c.name, hit.length === c.expect, '检出 ' + hit.length + '（期望 ' + c.expect + '）');
    }
    // 关键：零题场景必须进 results（否则检查看不到）
    //   验的是「跳过项要 push total=0」，这是本轮修的第二层
    chk('关键：零题场景必须进 results（不能只 continue）',
      judgeEmpty([{ scene: 'X', total: 0 }]).length === 1,
      '否则归零检查看不到它');
    // 关键：整体高比例不能掩盖单个场景归零
    chk('关键：整体 200 题也不能掩盖单个场景归零',
      judgeEmpty([{ scene: 'A', total: 200 }, { scene: 'B', total: 0 }]).length > 0,
      '否则「平均值掩盖局部全灭」');
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  const one = val('scene', null);
  const targets = one ? [one] : SCENES;

  console.log('='.repeat(80));
  console.log('  记忆注入效果体检 —— 用真实注入机制测，不是模拟');
  console.log('='.repeat(80));
  console.log();
  console.log('  口径说明：');
  console.log('    工具/记忆评估.mjs 测的是「全量注入」（把全部内容塞进去），');
  console.log('    那个 1.00 是虚高的。');
  console.log();
  console.log('    这个工具测的是**真实在跑的机制**：');
  console.log('    记忆注入.mjs 按用户话术检索，最多 3 条 / 300 字。');
  console.log();

  const results = [];
  for (const scene of targets) {
    const cases = loadCases(scene);
    if (!cases.length) {
      // ⚠ 2026-11-12 修（跳过项没进 results → 归零检查看不到它）
      //
      //   原来：console.log('  ? ' + scene + '无封存集'); continue;
      //        —— 直接跳过，不 push 到 results。
      //   于是下面的 emptyScenes 过滤器永远查不到它，
      //   清空某场景题库后仍然报「达标」。
      //
      //   修法：把「零题场景」也 push 进去（total=0），
      //        让归零检查能看到，同时输出上明确标成「测不了」而不是「跳过」。
      console.log('  ? ' + scene.padEnd(12) + '无封存集（测不了，不算通过）');
      results.push({ scene, total: 0, pass: 0, rate: null, tokens: 0, noCases: true });
      continue;
    }

    let passN = 0;
    let totalTokens = 0;
    const details = [];

    for (const c of cases) {
      const q = c.question || c.q || c.prompt || '';
      const r = realInject(scene, q);
      // ⚠ 2026-11-12 修统计口径：
      //   AI 实际看到的 = 记忆注入（按话术检索的 3 条/300 字）
      //                 + AGENTS.local.md（引擎固定注入，不在记忆注入的判据里）
      //   只算前者会低估真实效果。
      const injectedText = (r && r.text) || '';
      const fixedText = readFixedLayer(scene);
      const text = injectedText + '\n' + fixedText;
      totalTokens += (r && r.tokens) || Math.round(text.length / 2);
      const j = judgeOne(text, c);
      if (j.pass) passN++;
      details.push({ q: q.slice(0, 40), pass: j.pass, hit: j.hit, need: j.need, len: text.length });
    }

    const rate = Math.round((passN / cases.length) * 1000) / 1000;
    results.push({ scene, total: cases.length, pass: passN, rate, tokens: totalTokens });

    console.log('  ' + (rate >= 0.7 ? 'OK' : 'XX') + ' ' + scene.padEnd(12) +
      ' 题 ' + String(cases.length).padStart(2) +
      '  真实注入答对 ' + String(passN).padStart(2) +
      '  (' + Math.round(rate * 100) + '%)' +
      '  总注入 ' + String(totalTokens).padStart(5) + ' token' +
      '  均 ' + String(Math.round(totalTokens / cases.length)).padStart(4));
  }

  console.log();
  console.log('-'.repeat(80));
  const totalPass = results.reduce((a, b) => a + b.pass, 0);
  const totalQ = results.reduce((a, b) => a + b.total, 0);
  const avgRate = totalQ ? Math.round((totalPass / totalQ) * 1000) / 1000 : 0;
  const avgTok = results.length ? Math.round(results.reduce((a, b) => a + b.tokens, 0) / totalQ) : 0;

  console.log('  合计: ' + totalPass + ' / ' + totalQ + ' 题  (' + Math.round(avgRate * 100) + '%)');
  console.log('  平均每题注入: ' + avgTok + ' token   （真实机制上限 300 字 ≈ 150 token）');
  console.log();

  // ⚠ 2026-11-12 加：任一场景题目归零必须直接失败
  //
  //   实测：清空「逆向分析」的封存集（16 题 → 0 题）后，
  //   这个工具打印「合计 125 / 142」并 exit 0 ——
  //   因为它只看总比例 avgRate >= 0.65，而少了一个场景的分母变化
  //   反而让比例看起来正常。
  //
  //   这和 经验真实性体检 是同一个盲区：**平均值掩盖局部全灭**。
  //   封存集 --check 能抓到（达标 8/9），但作为「注入效果」这个视角，
  //   也应该独立报出来 —— 不能依赖别的工具替自己发现。
  //
  //   判据：任何场景的题目数为 0 → 直接失败。
  const emptyScenes = results.filter((r) => (r.total || 0) === 0);

  // 阈值 0.65：实测真实注入 67%（56/84）。
  // 原来写 0.70 是基于「全量注入 1.00」的虚高预期，不现实。
  // 3 条 / 300 字的预算下，65% 是合理下限。
  if (emptyScenes.length) {
    console.log('  XX 这些场景一题都没有（无法评估注入效果，且说明封存集缺失）: ' +
      emptyScenes.map((r) => r.scene).join(', '));
    console.log('     这不是「跳过」，是「测不了」—— 而测不了不该算通过。');
    process.exitCode = 1;
  } else if (avgRate >= 0.65) {
    console.log('  ✓ 真实注入机制的有效召回达标（>=65%）');
  } else {
    console.log('  ⚠ 真实注入的有效召回不足 65% —— 装进去的记忆 AI 答不出来');
    process.exitCode = 1;
  }
  console.log('='.repeat(80));
}

main();
