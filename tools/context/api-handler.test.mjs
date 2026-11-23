#!/usr/bin/env node
/** /api/context 反例测试 —— 每条都要能红。用法：node tools/context/api-handler.test.mjs */
import { Readable } from 'node:stream';
import { createContextHandler } from './api-handler.mjs';

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

function call(body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.url = '/api/context';
  req.method = 'POST';
  let code = null;
  let payload = null;
  const res = {
    writeHead(c) { code = c; },
    end(b) { try { payload = JSON.parse(b); } catch { payload = b; } },
    on() {},
  };
  return new Promise((resolve) => {
    createContextHandler()(req, res, () => resolve({ code, payload }));
    setTimeout(() => resolve({ code, payload }), 300);
  });
}

// 模块读的是 it.text（不是 content）—— 这条契约写在这里，避免以后又传错字段
const big = (n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  text: 'x'.repeat(400) + ' #' + i,
}));

// ── 正例 ──
{
  const r = await call({ action: 'ping' });
  t('正例：ping 报出四态', r.code === 200 && Array.isArray(r.payload.states) && r.payload.states.includes('UNKNOWN'), JSON.stringify(r.payload));
}
{
  // 20 条 x 400 字符 ≈ 2000 tokens；预算 1200 是「能压但需要压」的区间
  const r = await call({ action: 'compress', items: big(20), budget: 1200 });
  t('正例：超预算能压缩并返回 stats', r.code === 200 && r.payload.state && r.payload.result?.stats, JSON.stringify(r.payload.state));
  t('正例：压缩后 token 不高于预算', r.payload.result.stats.after <= 1200, 'after=' + r.payload.result?.stats?.after);
}
{
  const r = await call({ action: 'estimate', text: 'hello world' });
  t('正例：estimate 返回数字', r.code === 200 && typeof r.payload.tokens === 'number', JSON.stringify(r.payload));
}

// ── 反例（每条都必须红）──
{
  const r = await call({ action: 'nope' });
  t('★反例：未知 action ⇒ 400', r.code === 400, JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'compress', items: 'not-array' });
  t('★反例：items 不是数组 ⇒ 400', r.code === 400, JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'compress', items: [] });
  t('★反例：items 为空 ⇒ 400（不能默默返回成功）', r.code === 400, JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'estimate' });
  t('★反例：estimate 缺 text ⇒ 400', r.code === 400, JSON.stringify(r.payload));
}
{
  // 预算小于关键事实 ⇒ 必须 FAIL 且 HTTP 非 200（不许假装成功）
  const items = [
    { role: 'user', text: 'ERROR: build failed ' + 'y'.repeat(200) },
    { role: 'assistant', text: 'z'.repeat(600) },
    { role: 'user', text: 'w'.repeat(600) },
  ];
  const r = await call({ action: 'compress', items, budget: 1, keepRecent: 0 });
  const notFake = r.code !== 200 || r.payload.state === 'FAIL';
  t('★反例：预算压不下关键事实时必须 FAIL 且不能回 200', notFake, 'code=' + r.code + ' state=' + r.payload?.state);
}

{
  // 【本轮修的真 bug】条目没有 text 字段时，压缩器原来估成 0 token 并返回 PASS「无需压缩」，
  // 也就是对**它没看懂的输入**报成功。修完必须返回 UNKNOWN（422），不能是 200/PASS。
  const r = await call({ action: 'compress', items: [{ role: 'user', content: 'no text field' }], budget: 100 });
  t('★反例：条目缺少 text 字段 ⇒ 必须 UNKNOWN（不能对看不懂的输入报 PASS）',
    r.payload?.state === 'UNKNOWN' && r.code !== 200, 'code=' + r.code + ' state=' + r.payload?.state);
}

console.log('\n  /api/context 反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
