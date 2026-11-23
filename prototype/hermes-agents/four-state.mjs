#!/usr/bin/env node
/**
 * 四态裁决：PASS / WARN / FAIL / UNKNOWN
 *
 * 抽成独立文件的两个理由：
 *   1. verify-goal.mjs 要用它算退出码；
 *   2. 体检器要能**快速**验证这套逻辑本身成立 —— 不能靠"读源码里有没有 UNKNOWN 这个词"。
 * 以前这两件事挤在一起，导致想验证机制就得跑完 8 条硬要求（几十秒）。
 *
 * ## 为什么必须有 UNKNOWN
 *
 * 两个独立参照系统各自收敛到同一概念：
 *   omp-studio docs/architecture.md:48
 *     "Runtime loss fences the old epoch and maps unresolved accepted work to outcome_unknown"
 *   Orca src/cli/specs/orchestration-worker-specs.ts:56
 *     "Failed or outcome_unknown exits 1 and JSON includes stage/failedStage, effects,
 *      residualResources, and recovery commands when needed"
 *
 * 没有第三态时，判不了只能塌缩到某一侧：塌到 PASS 是假绿，塌到 FAIL 是假红。
 * 本项目踩过假红：桌面端没起时星图验收报「没有 canvas」，看起来像星图坏了，
 * 真相是没人能看 —— 为此白排查了一轮。
 *
 * ## 退出码约定
 *
 *   0  全 PASS
 *   1  有 FAIL      —— 已验证「不达成」，真缺陷
 *   2  有 UNKNOWN   —— 判断不了，验证环境不在
 *   3  有 WARN      —— 已验证「不完整」，这是知识不是进度，也不许绿
 *
 * 三者优先级：FAIL > UNKNOWN > WARN。
 * 为什么 WARN 也不许绿：「8 条硬要求全过」这句话在有待补项时就是假绿。
 *
 * 用法：node four-state.mjs        自检（退出 0 = 机制成立）
 */

export const STATES = /** @type {const} */ (['PASS', 'WARN', 'FAIL', 'UNKNOWN']);

export const MEANING = {
  PASS: '已验证达成',
  WARN: '已验证「不完整」—— 这是知识，允许存在，但不许当绿',
  FAIL: '已验证「不达成」—— 真缺陷',
  UNKNOWN: '判断不了 —— 这是无知，不是不达标；必须阻断绿',
};

/**
 * 由各状态计数算出退出码。
 * @param {{pass?: number, warn?: number, fail?: number, unknown?: number}} counts
 * @returns {0|1|2|3}
 */
export function verdict(counts) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  if (n(counts.fail) > 0) return 1;
  if (n(counts.unknown) > 0) return 2;
  if (n(counts.warn) > 0) return 3;
  return 0;
}

/** 自检项：每条都是「如果没有第三态会怎样」的反面。 */
export const SELFTESTS = [
  ['全 PASS 才退出 0', verdict({ pass: 8 }), 0],
  ['全 WARN 不许退出 0（这是修掉过的真假绿洞）', verdict({ warn: 8 }), 3],
  ['有 UNKNOWN 退出 2', verdict({ pass: 7, unknown: 1 }), 2],
  ['有 FAIL 退出 1', verdict({ pass: 7, fail: 1 }), 1],
  ['FAIL 优先于 UNKNOWN', verdict({ fail: 1, unknown: 1 }), 1],
  ['UNKNOWN 与 FAIL 退出码必须不同', verdict({ unknown: 1 }) !== verdict({ fail: 1 }), true],
  ['UNKNOWN 不许被算成通过', verdict({ pass: 7, unknown: 1 }), 2],
  ['没有 fail/unknown/warn 时才是 0', verdict({}), 0],
];

/** 跑自检，返回不成立项数。 */
export function selfTest(log = console.log) {
  let bad = 0;
  for (const [label, got, want] of SELFTESTS) {
    const okk = got === want;
    if (!okk) bad++;
    log('  ' + (okk ? '✓' : '✗') + ' ' + label + '  期望 ' + want + ' 实际 ' + got);
  }
  log('  自检结论：' + (bad ? '✗ ' + bad + ' 项不成立' : '✓ 四态机制成立'));
  return bad;
}

// 直接运行时只跑自检（体检器会调这个，必须快）
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1]?.replace(/\\/g, '/').endsWith('/four-state.mjs')) {
  console.log('');
  console.log('  四态裁决自检：PASS / WARN / FAIL / UNKNOWN');
  const bad = selfTest();
  process.exit(bad ? 1 : 0);
}
