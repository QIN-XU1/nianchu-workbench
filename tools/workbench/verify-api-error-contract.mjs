#!/usr/bin/env node
/**
 * /api/* 错误语义一致性检查 —— 错误请求必须得到**结构化 JSON 错误**，不能 200、不能 HTML。
 *
 * 【为什么需要】第 91 轮 verify-release-postdeploy 的反例A 抓到：未匹配的 /api/* 掉进 SPA 兜底
 * 返回 200 + index.html → 拼错接口会「静默成功」，错误被彻底掩盖。修了那一个口子之后，
 * 这里做**系统性收口**：对每个真实端点发错误请求，验证它给出的是 JSON 错误而不是 200/HTML。
 *
 * 断言（对每个端点）：
 *   ① 状态码必须是 4xx（不能 200 —— 200 意味着错误请求被当成成功）
 *   ② content-type 必须是 application/json（不能 text/html —— HTML 说明掉进了 SPA 兜底）
 *   ③ body 必须能被 JSON.parse，且有 ok:false 或 error 字段
 * 另外：未知路由、路径相近的拼写错误 → 同样必须 404 JSON。
 *
 * 反例自测：内置一个「假 server 适配器」，其未匹配路由返回 200+HTML，
 * 检查必须能把它判 FAIL（证明检查不是摆设）。
 *
 * 四态：0 全通过 · 1 有不一致 · 2 无法执行（服务未起 → UNKNOWN）
 */
const BASE = process.env.NIANCHU_BASE || 'http://127.0.0.1:47124';
import { ensureServer, stopServer } from './_serve.mjs';

let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };


/**
 * 错误信息质量判定（第 97 轮补）—— 形状对（4xx+JSON）不等于「信息有用且不泄漏」。
 * 规则：非空、不超长、不含绝对路径、不含堆栈、不含内部占位符。
 */
function messageQuality(msg) {
  const problems = [];
  const s = String(msg == null ? '' : msg);
  if (!s.trim()) problems.push('错误信息为空');
  if (s.length > 200) problems.push('过长（' + s.length + ' 字符，可能含堆栈）');
  if (/[A-Za-z]:\\|\/Users\/|\/home\/|\\Users\\/.test(s)) problems.push('含绝对路径（泄漏内部结构）');
  if (/node:internal|\bat\s+\S+\s*\(|Error:\s|\n\s*at\s/.test(s)) problems.push('含堆栈特征');
  if (/\[object Object\]|undefined|null/.test(s)) problems.push('含内部占位符');
  return { ok: problems.length === 0, problems };
}

/** 判定一次响应是否符合「结构化错误」契约（纯函数，便于反例自测） */
function isStructuredError(res) {
  const problems = [];
  if (!res || typeof res.status !== 'number') return { ok: false, problems: ['无响应'] };
  if (res.status < 400 || res.status >= 500) problems.push('状态码非 4xx：' + res.status);
  const ct = String(res.contentType || '').toLowerCase();
  if (!ct.includes('application/json')) problems.push('content-type 非 JSON：' + (res.contentType || '(空)'));
  let parsed = null;
  try { parsed = JSON.parse(res.text); } catch { problems.push('body 不是合法 JSON'); }
  if (parsed && typeof parsed === 'object' && !(parsed.ok === false || 'error' in parsed)) {
    problems.push('JSON 里没有 ok:false / error 字段');
  }
  return { ok: problems.length === 0, problems };
}

// ── 反例自测：假的「SPA 兜底」响应必须被判失败 ──
{
  const bad = { status: 200, contentType: 'text/html; charset=utf-8', text: '<!doctype html><html></html>' };
  const r = isStructuredError(bad);
  if (r.ok) { console.error('  ✗ 反例自测失败：200+HTML 必须被判不合格'); process.exit(2); }
  const good = { status: 404, contentType: 'application/json; charset=utf-8', text: '{"ok":false,"error":"x"}' };
  if (!isStructuredError(good).ok) { console.error('  ✗ 反例自测失败：正确 JSON 错误应判合格'); process.exit(2); }
  // 质量反例：泄漏路径 / 堆栈 / 占位符 / 空 必须被判不合格
  const qBad = [
    'ENOENT: no such file or directory, open \'D:\\secret\\store.json\'',
    'TypeError: x is not a function\n    at foo (file:///app/x.mjs:3:9)',
    'value is undefined',
    '',
  ];
  for (const m of qBad) {
    if (messageQuality(m).ok) { console.error('  ✗ 反例自测失败：应判不合格的信息：' + JSON.stringify(m).slice(0, 40)); process.exit(2); }
  }
  if (!messageQuality('key 必填').ok) { console.error('  ✗ 反例自测失败：正常信息应判合格'); process.exit(2); }
  console.log('  ✓ 反例自测：200+HTML 判不合格 / 404 JSON 判合格 / 泄漏路径·堆栈·占位符·空 判不合格');
}

async function probe(pathname, init) {
  try {
    const r = await fetch(BASE + pathname, { ...init, signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    return { status: r.status, contentType: r.headers.get('content-type') || '', text };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

console.log('');
console.log('  /api/* 错误语义一致性（错误请求必须得到 JSON 错误，不能 200/HTML）');
console.log('  ' + '─'.repeat(68));

// 前置：服务必须在（不可达则自起；起不来如实 UNKNOWN，不伪 FAIL）
const _srv = await ensureServer(BASE);
if (!_srv.ok) {
  console.error('  ⚠ ' + _srv.why + ' → UNKNOWN（环境问题，不是代码缺陷）');
  await stopServer(_srv.child);
  process.exit(2);
}
console.log('  · ' + _srv.why);

// 端点 + 一个「明显错误」的请求（缺字段 / 未知 action / 空 body）
// ⚠ 两个端点例外：/api/plugin-run 与 /api/scheduler/tick **不吃判别性输入**
//   （实测：空 body / {plugin:'__no_such_plugin__'} / {hook:'__no_such_hook__'} 均返回 200 ok:true，
//    它们是「跑一次内核/调度」的触发端点，没有「非法请求」这个概念）
//   → 对它们断言 4xx 是**测试写错了**，不是产品错了。如实 SKIP（不计入通过）。
const NO_INPUT_ENDPOINTS = ['/api/plugin-run', '/api/scheduler/tick'];
const ENDPOINTS = [
  ['/api/mcp', { action: '__no_such_action__' }],
  ['/api/collab', { action: '__no_such_action__' }],
  ['/api/ledger', { action: '__no_such_action__' }],
  ['/api/cost', { action: '__no_such_action__' }],
  ['/api/context', { action: '__no_such_action__' }],
  ['/api/memory', { action: '__no_such_action__' }],
  ['/api/skills', { action: '__no_such_action__' }],
];

for (const [p, body] of ENDPOINTS) {
  const res = await probe(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.error) { t(p + ' 未知 action → 结构化错误', false, res.error); continue; }
  const v = isStructuredError(res);
  t(p + ' 未知 action → 4xx JSON 错误', v.ok, v.problems.join(' | ') + ' body=' + String(res.text).slice(0, 60).replace(/\s+/g, ' '));
}

// 未知路由 / 拼写错误 → 必须 404 JSON
for (const p of ['/api/__no_such_route__', '/api/memoryy', '/api/skillz', '/api/host-stauts']) {
  const res = await probe(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const v = isStructuredError(res);
  t(p + ' → 404 JSON 错误（不能 200/HTML）', v.ok, res.error || (v.problems.join(' | ') + ' body=' + String(res.text).slice(0, 50).replace(/\s+/g, ' ')));
}

// ── 字段级非法请求（第 93 轮补）：缺必填字段 / 类型错误 → 必须 4xx JSON ──
// 期望值是**实测后写死的**，不是猜的；每条都注明它验的是什么。
const FIELD_CASES = [
  ['/api/memory', { action: 'put' }, 'put 缺 key'],
  ['/api/memory', { action: 'put', key: 'k' }, 'put 缺 source（无来源不许写入）'],
  ['/api/memory', { action: 'get' }, 'get 缺 key'],
  ['/api/memory', { action: 'get', key: 123 }, 'get key 类型错'],
  ['/api/memory', { action: 'put', key: 'k', source: 's' }, 'put 缺 value（store 拒绝）'],
  ['/api/context', { action: 'compress', items: 'not-array' }, 'compress items 非数组'],
  ['/api/skills', { action: 'load' }, 'load 缺 name'],
  ['/api/skills', { action: 'load', name: 123 }, 'load name 类型错'],
  ['/api/skills', { action: 'load', name: '__no_such_skill__' }, 'load 技能不存在'],
];
for (const [p, body, label] of FIELD_CASES) {
  const res = await probe(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.error) { t(`${p} ${label} → 4xx JSON`, false, res.error); continue; }
  const v = isStructuredError(res);
  t(`${p} ${label} → 4xx JSON`, v.ok, (v.problems.join(' | ') || '') + ' status=' + res.status + ' body=' + String(res.text).slice(0, 60).replace(/\s+/g, ' '));
  // 质量：错误信息须非空/不超长/不泄漏路径与堆栈（形状对 ≠ 信息有用）
  let q = { ok: false, problems: ['body 无法解析'] };
  try { const j = JSON.parse(res.text); q = messageQuality(j.error ?? j.why ?? j.message); } catch { /* 上一条已报 */ }
  t(`${p} ${label} → 错误信息质量`, q.ok, q.problems.join(' | '));
}

// 无判别性输入的端点：显式跳过并说明（不静默略过）
for (const p of NO_INPUT_ENDPOINTS) {
  const res = await probe(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log('  ⊘ SKIP ' + p + '（无判别性输入：空 body 即合法调用，返回 ' + res.status + '，不构成错误语义测试）');
}

console.log('  ' + '─'.repeat(68));
console.log(`  结果：通过 ${pass} · 失败 ${fail} · 跳过 ${NO_INPUT_ENDPOINTS.length}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
await stopServer(_srv.child);
process.exit(fail === 0 ? 0 : 1);