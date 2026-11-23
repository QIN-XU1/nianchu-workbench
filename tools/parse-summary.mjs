/**
 * 解析验收器输出里的四态计数。
 *
 * 我们自己的脚本有三种汇总格式（历史演进留下的）：
 *   1) 通过 26  失败 0                    （verify-arch / verify-mechanisms）
 *   2) 通过 19  待补 0  失败 0              （verify-agent-ui）
 *   3) 通过 16  失败 0  无法判断 0          （verify-workbench / verify-s0 / verify-s1s2）
 * 第一版只认第 3 种，导致 4 个套件被记成「判不了 0/0/0」——
 * 那不是脚本没跑，是我的解析器瞎了。三种都要认。
 */
export const SUMMARY_PATTERNS = [
  { re: /通过\s+(\d+)\s+待补\s+(\d+)\s+失败\s+(\d+)/, order: ['pass', 'warn', 'fail'] },
  { re: /通过\s+(\d+)\s+失败\s+(\d+)\s+无法判断\s+(\d+)/, order: ['pass', 'fail', 'unknown'] },
  { re: /断言：通过\s+(\d+)\s+失败\s+(\d+)/, order: ['pass', 'fail'] },
];

export function parseSummary(out) {
  for (const { re, order } of SUMMARY_PATTERNS) {
    const m = out.match(re);
    if (!m) continue;
    const r = { pass: 0, warn: 0, fail: 0, unknown: 0 };
    order.forEach((k, i) => { r[k] = Number(m[i + 1]); });
    return r;
  }
  return null;
}
