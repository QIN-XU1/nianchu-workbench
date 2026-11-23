/**
 * 网关最终验证 —— 用最可靠的方式：直接调 HTTP 网关，再对比 DSH 会话
 *
 * 判据（三重，全部排除"自己发的内容"）：
 *   ① 网关本身能不能算对（直接 fetch 8326）
 *   ② DSH 会话能不能算对（读 zstd 存储）
 *   ③ 两个都不含我发的提问文本里的答案
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const GW = 'http://127.0.0.1:8326/v1';
const KEY = 'dqiBDBB69namrZoE1dOwPo1VTekHR2UMK-2wWAabcPY';
const MODEL = 'raccoon/sn-deepseek-v4-1-flash-1017';

// 提问里不出现答案
const A = 8379, B = 4612, EXPECT = String(A * B);

console.log('═══ ① 直接验证网关节点的能力 ═══');
console.log('  网关: ' + GW);
console.log('  模型: ' + MODEL);
console.log('  问题: ' + A + ' × ' + B + ' = ?（提问里不含答案）');
console.log('  预期: ' + EXPECT);
console.log();

try {
  const r = await fetch(`${GW}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: `计算 ${A} 乘以 ${B}，只输出纯数字。` }],
      max_tokens: 64,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || '';
  console.log('  HTTP ' + r.status);
  console.log('  回复: "' + content.trim() + '"');
  console.log('  用量: ' + JSON.stringify(j.usage || {}));
  console.log();
  const ok = content.includes(EXPECT);
  console.log('  ' + (ok ? '✅ 网关能算对' : '❌ 网关回复不含正确答案'));
  console.log('  完整回复对象: ' + JSON.stringify(j.choices?.[0]?.message || {}).slice(0, 300));
} catch (e) {
  console.log('  ❌ 网关调用失败: ' + e.message);
}
