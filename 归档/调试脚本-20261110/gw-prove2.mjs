const GW = 'http://127.0.0.1:8326/v1';
const KEY = 'dqiBDBB69namrZoE1dOwPo1VTekHR2UMK-2wWAabcPY';
const A = 8379, B = 4612, EXPECT = String(A * B);

const MODELS = [
  'raccoon/sn-deepseek-v4-1-flash-1017',
  'trae/deepseek-v4.1-flash',
  'deepseek-official/deepseek-flash',
];

console.log('═══ 网关能力验证（放宽 token 预算）═══');
console.log('  问题: ' + A + ' × ' + B + ' （答案 ' + EXPECT + ' 不在提问里）');
console.log();

for (const model of MODELS) {
  process.stdout.write('  ' + model.padEnd(42) + ' ');
  try {
    const r = await fetch(`${GW}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `计算 ${A} 乘以 ${B}，只输出纯数字，不要推理过程。` }],
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json();
    if (r.status !== 200) {
      console.log('HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 100));
      continue;
    }
    const msg = j.choices?.[0]?.message || {};
    const content = (msg.content || '').trim();
    const reasoning = (msg.reasoning_content || '').trim();
    const ok = content.includes(EXPECT);
    console.log((ok ? '✅' : '⚠️ ') + ' content="' + content.slice(0, 30) + '"' +
      (reasoning ? '  reasoning长度=' + reasoning.length : '') +
      '  tokens=' + (j.usage?.total_tokens || '?'));
  } catch (e) {
    console.log('❌ ' + e.message.slice(0, 60));
  }
}
