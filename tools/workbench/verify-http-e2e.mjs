#!/usr/bin/env node
/**
 * 念初工作台 端到端 HTTP 冒烟测试 —— 不是测内核函数，而是打**真实 HTTP 接口**。
 *
 * 为什么要它（第 75 轮）：对象目第一句「把念初自身完善」，我们一直测的是内核模块（verify-*.mjs），
 *   但**用户面对的是 workbench 的 HTTP/WS 接口**。内核全绿 ≠ 产品接口能用。
 *   本测试把产品当黑盒：起服务后逐端点发真实请求，断言响应；再发坏请求确认**报错而不是崩溃/静默**。
 *
 * 前置：`node tools/workbench/serve.mjs`（47124）。未起则本测试报 UNKNOWN 并退出 2（不假装 PASS）。
 */
const B = process.env.NIANCHU_BASE || 'http://127.0.0.1:47124';
import { ensureServer, stopServer } from './_serve.mjs';
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

async function get(p) { const r = await fetch(B + p); return { s: r.status, j: await r.json().catch(() => ({})) }; }
async function post(p, b) { const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json().catch(() => ({})) }; }

// 前置：服务必须可达（不可达则自起；起不来如实 UNKNOWN，不伪 FAIL）
const _srv = await ensureServer(B);
if (!_srv.ok) {
  console.error('  ⚠ ' + _srv.why + ' → UNKNOWN（环境问题，不是代码缺陷）');
  await stopServer(_srv.child);
  process.exit(2);
}
console.log('  · ' + _srv.why);

const hs = await get('/api/host-status');
t('host-status 200 且 ok', hs.s === 200 && hs.j.ok === true);
t('host-status 列出实现方法 ≥70', Array.isArray(hs.j.implemented) && hs.j.implemented.length >= 70, String(hs.j.implemented && hs.j.implemented.length));

const sk = await post('/api/skills', { action: 'catalog' });
// 不硬编码技能数：从 loader 实测取（第 91 轮发现硬编码 28 在技能涨到 30 后失效）
const { createSkillLoader } = await import('../skills/loader.mjs');
const { fileURLToPath } = await import('node:url');
const scenesDir = fileURLToPath(new URL('../../prototype/scenes/', import.meta.url));
const realSkillCount = createSkillLoader([scenesDir]).scanAll().list().length;
t('skills catalog 200 且 count=真实技能数(' + realSkillCount + ')', sk.s === 200 && sk.j.count === realSkillCount, JSON.stringify({ s: sk.s, c: sk.j.count }));
t('skills catalog 文本以 # Skills 开头', String(sk.j.catalog || '').startsWith('# Skills'));

const mp = await post('/api/memory', { action: 'ping' });
t('memory ping 治理含 source/conflict/ttl', mp.j.ok && ['source', 'conflict', 'ttl'].every((x) => (mp.j.governance || []).includes(x)), JSON.stringify(mp.j.governance));

const put = await post('/api/memory', { action: 'put', key: 'smoke-e2e', scope: 'project', kind: 'fact', value: 'hello-e2e', source: 'http-smoke' });
t('memory put 成功', put.s === 200 && put.j.ok && (put.j.result ? put.j.result.ok !== false : true), JSON.stringify(put.j).slice(0, 90));
const get1 = await post('/api/memory', { action: 'get', key: 'smoke-e2e' });
t('memory get 取回刚写入的值', get1.j.ok && get1.j.result && String(JSON.stringify(get1.j.result.live)).includes('hello-e2e'), JSON.stringify(get1.j.result).slice(0, 90));

const audit = await post('/api/memory', { action: 'audit' });
t('memory audit 200 且 total>0', audit.j.ok && audit.j.result && audit.j.result.total > 0, String(audit.j.result && audit.j.result.total));

const est = await post('/api/context', { action: 'estimate', text: 'hello world this is a test' });
t('context estimate 200 且 tokens>0', est.j.ok && est.j.tokens > 0, String(est.j.tokens));

const cmp = await post('/api/context', { action: 'compress', items: [{ role: 'system', text: 'SYS '.repeat(20) }, { role: 'user', text: 'USER '.repeat(20) }] });
t('context compress 200 且 state∈{PASS,WARN}', cmp.s === 200 && ['PASS', 'WARN'].includes(cmp.j.state), JSON.stringify({ s: cmp.s, st: cmp.j.state }));

const prices = await post('/api/cost', { action: 'prices' });
t('cost prices 200 且 priced>0', prices.j.ok && prices.j.priced > 0, String(prices.j.priced));

const led = await post('/api/ledger', { action: 'list' });
t('ledger list 200 且 entries 是数组', led.j.ok && Array.isArray(led.j.entries), JSON.stringify({ s: led.s, t: typeof led.j.entries }));

const collab = await post('/api/collab', { action: 'ping' });
t('collab ping 200 且 protocol=cause_by', collab.j.ok && collab.j.protocol === 'cause_by', JSON.stringify(collab.j));

const tick = await post('/api/scheduler/tick', {});
t('scheduler tick 200 且 ok', tick.s === 200 && tick.j.ok !== false, JSON.stringify({ s: tick.s }));

// ── 反例：坏请求必须「结构化报错」，不能崩溃/静默 ──
const badSkill = await post('/api/skills', { action: 'totally_bad' });
t('反例:skills 未知 action → 400 且 ok:false', badSkill.s === 400 && badSkill.j.ok === false, JSON.stringify({ s: badSkill.s, j: badSkill.j }).slice(0, 100));
const badCtx = await post('/api/context', { action: 'compress', items: 'not-an-array' });
t('反例:context compress items 非数组 → 4xx 且 ok:false（不崩）', badCtx.s >= 400 && badCtx.j.ok === false, JSON.stringify({ s: badCtx.s, j: badCtx.j }).slice(0, 100));

// 崩溃检测：打完所有请求后服务仍活
const hs2 = await get('/api/host-status');
t('全部请求后服务仍存活（无崩溃）', hs2.s === 200 && hs2.j.ok === true);

console.log(`\n  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
await stopServer(_srv.child);
process.exit(fail === 0 ? 0 : 1);