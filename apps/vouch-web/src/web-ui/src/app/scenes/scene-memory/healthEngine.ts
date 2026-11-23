import type { Verdict } from './verdict';
import { validateMemory, validateProjectMemory } from './memoryEngine';
import { validateIndexRow, extractFingerprint } from './identityEngine';
import type { IdentityIndexRow } from './identityEngine';
import { verdictFromValidation, tally } from './verdict';

/**
 * 场景健康检查 —— 一次给出记忆 / 身份 / 索引三方面的合成四态
 *
 * 为什么需要：这三块原本分散在三个 tab 里，人要分别点开才拼得出全貌，
 * 于是「记忆说身份是 X，身份卡登记的却是 Y」这种矛盾很容易被漏掉。
 *
 * 合成规则（先立标准，且必须有反例盯着）：
 *   · 任一项 FAIL ⇒ FAIL（最坏的一项决定整体）
 *   · 任一项 UNKNOWN ⇒ UNKNOWN —— **判不了绝不许被平均成通过**
 *   · 任一项 WARN ⇒ WARN
 *   · 全部 PASS ⇒ PASS
 *
 * 注意顺序：UNKNOWN 优先于 WARN，因为「有东西判不了」比「有东西待补」更该被看见。
 */

export type HealthPart = {
  id: 'memory' | 'fingerprint' | 'index';
  label: string;
  verdict: Verdict;
  detail: string;
};

export type HealthResult = {
  verdict: Verdict;
  parts: HealthPart[];
  /** 拖后腿的项（非 PASS），按严重度排序 */
  blockers: HealthPart[];
  counts: Record<Verdict, number>;
};

/** 合成（纯函数，可单测） */
export function combineHealth(parts: readonly HealthPart[]): HealthResult {
  const counts = tally(parts.map((p) => p.verdict));
  if (parts.length === 0) {
    return { verdict: 'UNKNOWN', parts: [], blockers: [], counts };
  }
  const order: Record<Verdict, number> = { FAIL: 0, UNKNOWN: 1, WARN: 2, PASS: 3 };
  const verdict: Verdict = parts.some((p) => p.verdict === 'FAIL')
    ? 'FAIL'
    : parts.some((p) => p.verdict === 'UNKNOWN')
      ? 'UNKNOWN'
      : parts.some((p) => p.verdict === 'WARN')
        ? 'WARN'
        : 'PASS';
  const blockers = parts
    .filter((p) => p.verdict !== 'PASS')
    .slice()
    .sort((a, b) => order[a.verdict] - order[b.verdict]);
  return { verdict, parts: [...parts], blockers, counts };
}

/** 记忆部分判定 */
export function memoryPart(text: string): HealthPart {
  if (!text || text.trim() === '') {
    return { id: 'memory', label: '场景记忆', verdict: 'UNKNOWN', detail: '还没有内容 —— 判不了' };
  }
  const r = validateMemory(text);
  return {
    id: 'memory',
    label: '场景记忆',
    verdict: verdictFromValidation(r),
    detail: r.issues.length === 0 ? '无问题' : r.issues.map((i) => '[' + i.code + '] ' + i.message).join('；'),
  };
}

/** 项目记忆部分判定 */
export function projectMemoryPart(text: string): HealthPart {
  if (!text || text.trim() === '') {
    return { id: 'memory', label: '项目记忆', verdict: 'UNKNOWN', detail: '还没有内容 —— 判不了' };
  }
  const r = validateProjectMemory(text);
  return {
    id: 'memory',
    label: '项目记忆',
    verdict: verdictFromValidation(r),
    detail: r.issues.length === 0 ? '无问题' : r.issues.map((i) => '[' + i.code + '] ' + i.message).join('；'),
  };
}

/**
 * 身份指纹部分判定
 * 注意：这里只做**确定性比对**（登记指纹 vs 定位卡算出的指纹）。
 * 真正的 sha256 计算在 async 侧完成，调用方把算好的指纹传进来。
 */
export function fingerprintPart(args: {
  ctxCard: string;
  idCard: string;
  computed: string | null;
}): HealthPart {
  const registered = extractFingerprint(args.idCard);
  if (!args.ctxCard.trim() || !args.idCard.trim()) {
    return { id: 'fingerprint', label: '身份指纹', verdict: 'UNKNOWN', detail: '定位卡或身份卡为空 —— 判不了' };
  }
  if (!registered) {
    return { id: 'fingerprint', label: '身份指纹', verdict: 'FAIL', detail: '身份卡里没有登记指纹' };
  }
  if (!args.computed) {
    return { id: 'fingerprint', label: '身份指纹', verdict: 'UNKNOWN', detail: '还没算出定位卡指纹 —— 判不了' };
  }
  if (registered !== args.computed) {
    return {
      id: 'fingerprint',
      label: '身份指纹',
      verdict: 'FAIL',
      detail: '登记 ' + registered + ' ≠ 当前 ' + args.computed + '（卡改过，要跑 stamp）',
    };
  }
  return { id: 'fingerprint', label: '身份指纹', verdict: 'PASS', detail: '登记与当前一致 ' + registered };
}

/** 身份索引部分判定 */
export function indexPart(rows: readonly IdentityIndexRow[]): HealthPart {
  if (!rows || rows.length === 0) {
    return { id: 'index', label: '身份索引', verdict: 'UNKNOWN', detail: '一行都没有 —— 判不了（不是通过）' };
  }
  const verdicts = rows.map((r) => verdictFromValidation(validateIndexRow(r)));
  const v: Verdict = verdicts.some((x) => x === 'FAIL')
    ? 'FAIL'
    : verdicts.some((x) => x === 'UNKNOWN')
      ? 'UNKNOWN'
      : verdicts.some((x) => x === 'WARN')
        ? 'WARN'
        : 'PASS';
  const bad = rows
    .map((r, i) => ({ r, v: verdicts[i] }))
    .filter((x) => x.v !== 'PASS');
  return {
    id: 'index',
    label: '身份索引（' + rows.length + ' 行）',
    verdict: v,
    detail: bad.length === 0
      ? '全部 7 列齐全'
      : bad.slice(0, 3).map((x) => x.r.sceneId + '/' + x.r.panelId + '：' + x.v).join('；'),
  };
}

/** 从三个来源一次性算健康（便于 UI 直接调用） */
export function sceneHealth(args: {
  memoryText: string;
  isProject?: boolean;
  ctxCard: string;
  idCard: string;
  computedFingerprint: string | null;
  indexRows: readonly IdentityIndexRow[];
}): HealthResult {
  const mem = args.isProject ? projectMemoryPart(args.memoryText) : memoryPart(args.memoryText);
  const fp = fingerprintPart({
    ctxCard: args.ctxCard,
    idCard: args.idCard,
    computed: args.computedFingerprint,
  });
  const idx = indexPart(args.indexRows);
  return combineHealth([mem, fp, idx]);
}
