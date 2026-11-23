#!/usr/bin/env node
/**
 * /api/collab 反例测试 —— 每条都要能红。
 * 用法：node tools/collab/api-handler.test.mjs
 *
 * handler 是自包含签名 (req, res, done)：自己读 body、自己写响应。
 * 所以这里造假的 req（可读流）与 res（记录状态码/响应体）。
 */
import { Readable } from 'node:stream';
import { createCollabHandler } from './api-handler.mjs';

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

function call(body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.url = '/api/collab';
  req.method = 'POST';
  let code = null;
  let payload = null;
  const res = {
    writeHead(c) { code = c; },
    end(b) { try { payload = JSON.parse(b); } catch { payload = b; } },
    on() {},
  };
  const handler = createCollabHandler();
  return new Promise((resolve) => {
    handler(req, res, () => resolve({ code, payload }));
    setTimeout(() => resolve({ code, payload }), 300);
  });
}

// ── 正例 ──
{
  const r = await call({ action: 'ping' });
  t('正例：ping 返回协议标识', r.code === 200 && r.payload.protocol === 'cause_by', JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'run', roles: [{ name: 'a', task: 'x' }, { name: 'b', task: 'y' }] });
  t('正例：两个角色能跑完并收敛', r.code === 200 && ['drained', 'idle'].includes(r.payload.state), JSON.stringify(r.payload).slice(0, 120));
  t('正例：返回真实消息流水（不是空数组）', Array.isArray(r.payload.journal) && r.payload.journal.length >= 2, 'journal=' + (r.payload.journal || []).length);
}

// ── 反例（每条都必须红）──
{
  const r = await call({ action: 'nope' });
  t('★反例：未知 action ⇒ 400', r.code === 400, JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'run', roles: [] });
  t('★反例：空 roles ⇒ 400（不能默默返回成功）', r.code === 400, JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'run', roles: [{ task: 'no name' }] });
  t('★反例：角色缺 name ⇒ 400', r.code === 400, JSON.stringify(r.payload));
}
{
  const r = await call({ action: 'run', roles: [{ name: 'a', task: 'x' }, { name: 'b', task: 'y' }, { name: 'c', task: 'z' }], budget: 1 });
  // 【2026-11-18 修·独立审计 M9】原来只断言 state === 'budget_exhausted'。
  // 审计员把预算判据从 `>=` 改成 `>`（多处理一条），测试**仍然绿**。
  // 现在同时断言 handled 必须恰好等于预算 —— 差一条就能被抓到。
  t('★反例：预算 1 ⇒ budget_exhausted（预算闸真在跑）',
    r.code === 200 && r.payload.state === 'budget_exhausted', JSON.stringify(r.payload.state));
  t('★反例：预算 1 ⇒ handled 必须恰好是 1（把 >= 改成 > 要能被抓到）',
    r.payload.handled === 1, 'handled=' + String(r.payload.handled));
}
{
  const r = await call({ action: 'run', roles: [{ name: 'a', task: 'x' }], maxRounds: 0 });
  t('★反例：maxRounds=0 ⇒ 不能是 drained', r.code === 200 && r.payload.state !== 'drained', JSON.stringify(r.payload.state));
}
{
  const r = await call({ action: 'run', roles: [{ name: 'a', task: 'ping-a' }, { name: 'b', task: 'ping-b' }] });
  const causes = new Set((r.payload.journal || []).map((m) => m.causeBy));
  t('★反例：流水里必须出现 kickoff 与 ack 两种 cause（否则订阅是假的）',
    causes.has('kickoff') && causes.has('ack'), [...causes].join(','));
}

console.log('\n  /api/collab 反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
