#!/usr/bin/env node
/**
 * 拿 8 个真实样本 —— 为 C6 的 H-0003 提供足够样本量
 *
 * 为什么要真做：C2 要求样本量 ≥8 才许下判定。
 * 编 8 个 token 数字进台账是不诚实的，所以真发 8 次最小请求，
 * 每次都读真实 usage。
 *
 * 副作用（好的那种）：这同时在多个 provider 上测「响应回显的 model 与请求不同」
 * 这个解析层能不能覆盖住。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const GATEWAY = 'http://127.0.0.1:3425/v1/chat/completions';

/** 8 个不同 provider / 价位的模型（先用目录里确认有价的） */
const TARGETS = JSON.parse(process.argv[2] || 'null') || [
  'auto/claude-haiku-5-5',
  'auto/claude-sonnet-5-5',
  'auto/claude-opus-5-5',
  'fableaiapi/claude-haiku-5-5',
  'fableaiapi/claude-sonnet-5-5',
  'auto/claude-haiku-4-5',
  'fableaiapi/claude-haiku-4-5-20251001',
  'auto/claude-sonnet-5',
];

console.log('');
console.log('  拿真实样本（每次 max_tokens=1，最便宜的档）');
console.log('  ' + '─'.repeat(76));

const results = [];
for (const model of TARGETS) {
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
  let j = null, err = '';
  try {
    const out = execFileSync('curl', ['-s', '--max-time', '60', '-X', 'POST', GATEWAY,
      '-H', 'content-type: application/json', '-d', body],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 70000 });
    j = JSON.parse(out);
    if (j.error) { err = JSON.stringify(j.error).slice(0, 60); j = null; }
  } catch (e) {
    err = String(e.message).slice(0, 60);
  }

  if (!j || !j.usage) {
    console.log('  ✗ ' + model.padEnd(38) + (err || '没有 usage'));
    results.push({ model, ok: false, err });
    continue;
  }

  const u = j.usage;
  const input = u.prompt_tokens ?? u.input_tokens;
  const output = u.completion_tokens ?? u.output_tokens;
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
  const echoed = j.model || '';

  // 记账
  let rec = '';
  try {
    rec = execFileSync(process.execPath, ['tools/cost/meter.mjs', 'record',
      '--model', echoed, '--in', String(input), '--out', String(output),
      '--cacheRead', String(cacheRead), '--turn', 'real-sample'],
    { encoding: 'utf8', cwd: process.cwd(), timeout: 30000 });
  } catch (e) { rec = '记账失败'; }

  const usd = /金额\s+(\$[\d.]+|UNKNOWN[^\n]*)/.exec(rec);
  const ok = usd && usd[1].startsWith('$');
  console.log('  ' + (ok ? '✓' : '○') + ' ' + model.padEnd(38)
    + '回显 ' + echoed.padEnd(34) + 'in ' + input + '/out ' + output
    + '  ' + (usd ? usd[1].slice(0, 22) : '?'));
  results.push({ model, echoed, input, output, ok, usd: usd ? usd[1] : null });
}

const priced = results.filter((r) => r.ok).length;
console.log('  ' + '─'.repeat(76));
console.log('  成功 ' + results.length + '/' + TARGETS.length + ' · 其中算出金额 ' + priced);

// 台账条数
const L = 'evidence/cost/ledger.json';
if (fs.existsSync(L)) {
  const jl = JSON.parse(fs.readFileSync(L, 'utf8'));
  const real = jl.entries.filter((e) => e.usd !== null && e.usd !== undefined && e.tokens.input > 0);
  const total = real.reduce((a, e) => a + e.usd, 0);
  console.log('  台账真实记账 ' + real.length + ' 条 · 合计 $' + total.toFixed(8));
}
console.log('');