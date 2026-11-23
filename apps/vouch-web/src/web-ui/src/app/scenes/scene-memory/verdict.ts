/**
 * 四态判定层 —— 对应总目标 T3：PASS/WARN/FAIL/UNKNOWN 贯通；UNKNOWN 永不并入通过。
 *
 * 约定（诚实原则）：
 *  - PASS：判定成功且无问题
 *  - WARN：判定成功但有告警（不算绿）
 *  - FAIL：判定成功且发现问题（error）
 *  - UNKNOWN：**根本判不了**（读不到内容/无输入）——绝不折算成 PASS
 *
 * 只有 PASS 算「绿」；WARN/FAIL/UNKNOWN 都不绿。UNKNOWN 必须单独计数，不许被 pass 吞并。
 */
import { validateMemory, type ValidationResult } from './memoryEngine';

export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

/** 把校验结果映射成四态。传 null/undefined 表示「拿不到校验结果」⇒ UNKNOWN。 */
export function verdictFromValidation(v: ValidationResult | null | undefined): Verdict {
  if (!v) return 'UNKNOWN';
  const errors = v.issues.filter((i) => i.level === 'error').length;
  const warns = v.issues.filter((i) => i.level === 'warn').length;
  if (errors > 0) return 'FAIL';
  if (warns > 0) return 'WARN';
  return 'PASS';
}

/** 只有 PASS 是绿。 */
export function isGreen(v: Verdict): boolean {
  return v === 'PASS';
}

/**
 * 对一份场景记忆文本做四态判定。
 * 读不到/空白 ⇒ UNKNOWN（判不了），绝不当 PASS；否则按 validateMemory 映射。
 */
export function verdictForMemory(text: string | null | undefined): Verdict {
  if (text === null || text === undefined || text.trim() === '') return 'UNKNOWN';
  return verdictFromValidation(validateMemory(text));
}

/** 汇总多份判定：只要出现 UNKNOWN，报告里 UNKNOWN 必须单独出现（不被 pass 吞并）。 */
export function tally(verdicts: Verdict[]): Record<Verdict, number> {
  const t: Record<Verdict, number> = { PASS: 0, WARN: 0, FAIL: 0, UNKNOWN: 0 };
  for (const v of verdicts) t[v] += 1;
  return t;
}

/** 全绿 = 有至少一条且全部 PASS（UNKNOWN 未出现、无 WARN/FAIL）。 */
export function allGreen(verdicts: Verdict[]): boolean {
  return verdicts.length > 0 && verdicts.every((v) => v === 'PASS');
}
