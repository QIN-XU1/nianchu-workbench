#!/usr/bin/env node
/**
 * L4 度量器 · 汇总计算（纯函数 + 反例自检）
 *
 * ── 为什么把这个抽出来 ────────────────────────────────────
 * 这是 L4 的核心判据。它出过两次**真错**：
 *   ① `--runs 1` 时数组只有一个元素，`every(v => v === recalls[0])` 恒为 true
 *      ⇒ **只跑一轮也打印「✓ 两次一致」**
 *   ② `fpr` 从来没被比对过 —— 措辞写着「两次一致」，读者以为 fpr 也验了
 *
 * 两处都已修，但当时**没有反例**把修复钉住。将来谁改回去不会有人发现。
 * 所以把计算抽成纯函数，配 8 条断言（1 正例 + 7 反例）。
 */

/**
 * @param {object} p
 * @param {number[]} p.recalls   每轮的 recall
 * @param {number[]} p.fprs      每轮的 fpr
 * @param {number}   p.runs      实际跑的轮数
 * @param {string[]} [p.unmeasured]  判 UNKNOWN 的用例 id
 * @param {boolean}  [p.anyInjectFail] 有故障注入失败
 */
export function summarize({ recalls, fprs, runs, unmeasured = [], anyInjectFail = false }) {
  const runsEnough = runs >= 2;
  const recallSame = runsEnough ? recalls.every((v) => v === recalls[0]) : null;
  const fprSame = runsEnough ? fprs.every((v) => v === fprs[0]) : null;
  const reproducible = runsEnough ? (recallSame === true && fprSame === true) : null;

  const recall = recalls[0];
  const fpr = fprs[0];

  const reproLabel = !runsEnough
    ? '✗ 单轮运行（--runs ' + runs + '）⇒ 可复算性未验证'
    : reproducible
      ? '✓ ' + runs + ' 轮一致（recall + fpr）'
      : '✗ 不一致（recall ' + (recallSame ? '同' : '异') + ' · fpr ' + (fprSame ? '同' : '异') + '）';

  let state, why;
  if (anyInjectFail) {
    state = 'UNKNOWN';
    why = '有故障注入失败，度量不完整';
  } else if (!runsEnough) {
    // 单轮 ⇒ 可复算性没验过，最高只能 WARN（不许拿一次结果当「可复算」）
    state = 'WARN';
    why = 'recall ' + recall.toFixed(3) + ' · fpr ' + fpr.toFixed(3)
      + ' · **只跑了 ' + runs + ' 轮，可复算性未验证** —— 要用 --runs 2 才算验过';
  } else if (!reproducible) {
    state = 'FAIL';
    why = '多轮结果不一致 —— 度量本身不可信（' + reproLabel.replace(/^[✓✗] /, '') + '）';
  } else if (unmeasured.length) {
    // 有测不了的用例 ⇒ 最高只能给 WARN。不许拿「剩下的都过了」当全过。
    state = 'WARN';
    why = 'recall ' + recall.toFixed(3) + ' · fpr ' + fpr.toFixed(3)
      + ' · 但有 ' + unmeasured.length + ' 项测不了（' + unmeasured.join(',') + '）—— 不许当全过';
  } else if (recall === 1 && fpr === 0) {
    state = 'PASS';
    why = 'recall 1.000 · fpr 0.000 · ' + reproLabel;
  } else {
    state = 'WARN';
    why = 'recall ' + recall.toFixed(3) + ' · fpr ' + fpr.toFixed(3) + ' · ' + reproLabel;
  }

  return { runsEnough, recallSame, fprSame, reproducible, recall, fpr, reproLabel, state, why };
}

/** 自检 —— 反例钉住两次真实错误 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 反例 1（真实 bug）：单轮绝不许声称可复算 ──
  const s1 = summarize({ recalls: [1.0], fprs: [0], runs: 1 });
  T('反例 · 单轮（runs=1）→ reproducible 必须是 null，不许 true',
    s1.reproducible === null && s1.state === 'WARN' && s1.why.includes('未验证'),
    'reproducible=' + String(s1.reproducible) + ' state=' + s1.state);

  // ── 反例 2：单轮的措辞里不许出现「✓ …一致」 ──
  T('反例 · 单轮措辞不许出现「✓ …一致」',
    !/✓[^\n]*一致/.test(s1.reproLabel), s1.reproLabel);

  // ── 反例 3（真实 bug）：fpr 不一致必须 FAIL（原来只比 recall）──
  const s2 = summarize({ recalls: [1.0, 1.0], fprs: [0.0, 0.077], runs: 2 });
  T('反例 · recall 同但 fpr 不同 → 必须判 FAIL',
    s2.reproducible === false && s2.state === 'FAIL' && s2.fprSame === false,
    'rep=' + String(s2.reproducible) + ' state=' + s2.state + ' fprSame=' + String(s2.fprSame));

  // ── 反例 4：recall 不一致也 FAIL ──
  const s3 = summarize({ recalls: [1.0, 0.9], fprs: [0, 0], runs: 2 });
  T('反例 · recall 不同 → FAIL', s3.state === 'FAIL' && s3.recallSame === false,
    'state=' + s3.state + ' recallSame=' + String(s3.recallSame));

  // ── 正例 1：两轮全同且 fpr=0 且无漏 → PASS ──
  const s4 = summarize({ recalls: [1.0, 1.0], fprs: [0, 0], runs: 2 });
  T('正例 · 两轮一致 + fpr 0 → PASS', s4.state === 'PASS' && s4.reproducible === true,
    'state=' + s4.state);

  // ── 反例 5：有测不了的项 → 最高 WARN（不许 PASS）──
  const s5 = summarize({ recalls: [1.0, 1.0], fprs: [0, 0], runs: 2, unmeasured: ['F07'] });
  T('反例 · 有 UNKNOWN 项 → 不许 PASS', s5.state === 'WARN' && s5.why.includes('测不了'),
    'state=' + s5.state);

  // ── 反例 6：注入失败 → UNKNOWN（不是 PASS/FAIL）──
  const s6 = summarize({ recalls: [1.0, 1.0], fprs: [0, 0], runs: 2, anyInjectFail: true });
  T('反例 · 注入失败 → UNKNOWN', s6.state === 'UNKNOWN', 'state=' + s6.state);

  // ── 反例 7：recall=1 但 fpr≠0 → 不许 PASS ──
  const s7 = summarize({ recalls: [1.0, 1.0], fprs: [0.077, 0.077], runs: 2 });
  T('反例 · recall 1 但 fpr 0.077 → 不许 PASS', s7.state !== 'PASS', 'state=' + s7.state);

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

// 直接运行时跑自检
import path from 'node:path';
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const r = selfTest();
  console.log('');
  console.log('  L4 度量器 · 汇总计算自检（1 正例 + 7 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}
