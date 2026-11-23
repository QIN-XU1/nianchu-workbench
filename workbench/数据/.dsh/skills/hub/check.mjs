#!/usr/bin/env node
/**
 * --- · 技能验收脚本
 *
 * ══════════════════════════════════════════════════════════════
 *  这是技能的「可执行」部分（Voyager 判据）
 * ══════════════════════════════════════════════════════════════
 *
 *  Voyager（arXiv 2305.16291）的技能库判据是：
 *    **可执行代码 + 描述嵌入作为检索键**
 *
 *  只有 SKILL.md 的东西只算提示词。加上这个 check.mjs 才算技能。
 *
 * ══════════════════════════════════════════════════════════════
 *  这个技能负责的事（从 SKILL.md 提取）
 * ══════════════════════════════════════════════════════════════
 *
  //   （未提取到）
 *
 *  不碰的：
  //   （未提取到）
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node check.mjs <产物文件路径>
 *  node check.mjs --text "产物文本"
 *  node check.mjs --selftest      自测（含必然失败的反例）
 *
 *  返回：
 *    exit 0 = 通过
 *    exit 1 = 不通过（会打印具体问题）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCENE = 'hub';
const SCENE_NAME = '---';

function readText(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

/**
 * 通用检查（所有技能都适用）
 *
 * 这些检查不依赖具体业务，先保证底线。
 * 具体业务的检查需要按技能补充（见下方 TODO）。
 */
export function check(productText, opts) {
  const o = opts || {};
  const problems = [];
  const passed = [];
  const evidence = {};

  const t = String(productText || '');
  evidence.length = t.length;

  // ── 检查 1：产物非空 ──
  if (t.trim().length < 50) {
    problems.push('产物过短（' + t.trim().length + ' 字符 < 50），可能是空壳');
  } else {
    passed.push('产物非空（' + t.length + ' 字符）');
  }

  // ── 检查 2：不是纯模板残留 ──
  if (/（待补）|（待填）|\(TODO\)|TODO:/i.test(t)) {
    problems.push('产物里有未填的占位（待补/待填/TODO）');
  } else {
    passed.push('无占位残留');
  }

  // ── 检查 3：有结构（至少两个标题）──
  const headings = (t.match(/^#{1,4}\s+\S/gm) || []).length;
  evidence.headings = headings;
  if (headings < 2) {
    problems.push('产物结构太简单（只有 ' + headings + ' 个标题），应有分节');
  } else {
    passed.push('有 ' + headings + ' 个标题分节');
  }

  // ── 检查 4：不是纯复述任务 ──
  if (/^(用户要求|需要我|根据用户|按照要求)/.test(t.trim())) {
    problems.push('产物像是在复述需求，不像在交付结果');
  } else {
    passed.push('不是复述需求');
  }

  // ── 检查 5：有可验证的证据（路径/数字/引用）──
  const hasPath = /[\w\-]+\/[\w\-./]+\.\w{2,4}|[A-Z]:\\/.test(t);
  const hasNumber = /\d+[.\d]*\s*(%|个|条|次|B|KB|MB|行|秒|ms)?/.test(t);
  const hasQuote = /「[^」]+」|\[[^\]]+\]/.test(t);
  evidence.hasPath = hasPath;
  evidence.hasNumber = hasNumber;
  evidence.hasQuote = hasQuote;
  if (!hasPath && !hasNumber && !hasQuote) {
    problems.push('产物里没有任何可验证的证据（无路径/无数字/无引用）');
  } else {
    passed.push('有可验证证据');
  }

  // ══════════════════════════════════════════════════════════
  //  TODO: 这里是通用底线检查。
  //        请按「${SCENE_NAME}」的具体职责补充专有检查。
  //
  //  参考该技能应产出什么：
  //   （未提取到）
  // ══════════════════════════════════════════════════════════

  return {
    ok: problems.length === 0,
    scene: SCENE,
    sceneName: SCENE_NAME,
    problems,
    passed,
    evidence,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测（关键：必须有必然失败的反例）
// ══════════════════════════════════════════════════════════════
export function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(60));
  console.log('  ' + SCENE_NAME + ' · check 自测');
  console.log('═'.repeat(60));
  console.log();

  // ① 合格产物应该通过
  const good = `# 架构方案

## 一、总体分层
分为四层：接入层 / 业务层 / 数据层 / 基础层。

## 二、风险清单
- 风险1：并发量大时接入层可能成为瓶颈，实测压测 1200 QPS。
- 风险2：数据层缺少降级，参考 ../docs/risk.md

## 三、结论
推荐方案A，因为改动面最小（3 个文件，约 200 行）。
`;
  const r1 = check(good);
  chk('合格产物通过', r1.ok === true, r1.problems.join(';') || 'ok');
  chk('合格产物有分节', r1.evidence.headings >= 2, String(r1.evidence.headings));

  // ② 反例：空产物必须失败
  const r2 = check('');
  chk('反例：空产物必须失败', r2.ok === false, r2.problems[0] || '');

  // ③ 反例：过短必须失败
  const r3 = check('完成了');
  chk('反例：过短必须失败', r3.ok === false, r3.problems[0] || '');

  // ④ 反例：占位残留必须失败
  const r4 = check('# 标题\n\n## 一\n内容（待补）\n\n## 二\n还有 TODO: xxx 这里要补');
  chk('反例：占位残留必须失败', r4.ok === false,
      r4.problems.find((p) => p.includes('占位')) || r4.problems[0] || '');

  // ⑤ 反例：无结构必须失败
  const r5 = check('这是一段很长的文字'.repeat(20));
  chk('反例：无结构必须失败', r5.ok === false,
      r5.problems.find((p) => p.includes('结构')) || r5.problems[0] || '');

  // ⑥ 反例：无证据必须失败
  const noEvidence = '# 标题\n\n## 一\n就是很好非常不错\n\n## 二\n确实做得很棒';
  const r6 = check(noEvidence);
  chk('反例：无证据必须失败', r6.ok === false,
      r6.problems.find((p) => p.includes('证据')) || r6.problems[0] || '');

  // ⑦ 关键：这个 check 必须能失败
  const allFail = [r2, r3, r4, r5, r6].filter((r) => !r.ok).length;
  chk('5 个反例全部被判失败', allFail === 5, allFail + ' / 5');

  console.log();
  const n = R.filter(Boolean).length;
  console.log('─'.repeat(60));
  console.log('  自测结果: ' + n + ' / ' + R.length);
  console.log('─'.repeat(60));
  return R.every(Boolean);
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  let text = '';
  const ri = args.indexOf('--text');
  if (ri >= 0) {
    text = args[ri + 1] || '';
  } else if (args[0] && !args[0].startsWith('--')) {
    text = readText(args[0]) || '';
    if (!text) { console.error('✗ 读不到文件: ' + args[0]); process.exit(2); }
  } else {
    console.log('用法: node check.mjs <产物文件>  或  --text "..."  或  --selftest');
    process.exit(2);
  }

  const r = check(text);
  console.log('═'.repeat(60));
  console.log('  ' + SCENE_NAME + ' · 产物验收');
  console.log('═'.repeat(60));
  console.log();
  if (r.passed.length) {
    console.log('  通过项:');
    for (const p of r.passed) console.log('    ✓ ' + p);
    console.log();
  }
  if (r.problems.length) {
    console.log('  问题:');
    for (const p of r.problems) console.log('    ✗ ' + p);
    console.log();
  }
  console.log('  结论: ' + (r.ok ? '✅ 通过' : '❌ 不通过'));
  process.exit(r.ok ? 0 : 1);
}
