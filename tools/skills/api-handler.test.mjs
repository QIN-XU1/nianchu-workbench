#!/usr/bin/env node
/**
 * /api/skills 处理器的反例测试（用假 req/res + 假 loader，不依赖真文件系统）。
 *
 * 反例：
 *  1. GET → 405（只接受 POST）
 *  2. 非法 JSON → 400
 *  3. action 缺失/未知 → 400
 *  4. load 不存在的技能 → ok:false（不是 500，不抛）
 *  5. load 路径穿越名 → 被 inject 层拒
 * 正例：
 *  6. catalog → count 与 state 正确
 *  7. load 有效名字 → 返回正文
 */
import { createSkillsHandler } from './api-handler.mjs';

let pass = 0, fail = 0;
const t = (n, ok, d) => { if (ok) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? '  ← ' + d : '')); } };

function fakeRes() {
  const r = { statusCode: 0, body: '', headers: {} };
  r.writeHead = (code, h) => { r.statusCode = code; r.headers = h || {}; };
  r.end = (b) => { r.body = b || ''; };
  r.on = () => {};
  return r;
}
const fakeReq = (method) => ({ method, on: () => {} });

const ITEMS = [
  { name: 'alpha', description: 'A 技能', body: 'ALPHA-BODY' },
  { name: 'beta', description: 'B 技能', body: 'BETA-BODY' },
];
const fakeLoader = {
  list: () => ITEMS.map((i) => ({ name: i.name, description: i.description })),
  load: (n) => { const v = ITEMS.find((x) => x.name === n); if (!v) throw new Error('技能不存在：' + n); return { name: n, description: v.description, body: v.body, path: '/f/' + n }; },
  stats: () => ({ count: ITEMS.length, names: ITEMS.map((i) => i.name), issues: [] }),
};

const call = async (method, bodyObjOrText) => {
  const h = createSkillsHandler({ loader: fakeLoader });
  const res = fakeRes();
  const text = typeof bodyObjOrText === 'string' ? bodyObjOrText : JSON.stringify(bodyObjOrText || {});
  await h(fakeReq(method), res, text);
  let json = null; try { json = JSON.parse(res.body); } catch { /* ignore */ }
  return { code: res.statusCode, json };
};

// 1
{ const r = await call('GET', { action: 'catalog' }); t('反例：GET → 405', r.code === 405, r.code); }
// 2
{ const r = await call('POST', '{ 坏 json'); t('反例：非法 JSON → 400', r.code === 400 && r.json && r.json.ok === false, JSON.stringify(r)); }
// 3
{ const r = await call('POST', {}); t('反例：action 缺失 → 400', r.code === 400, JSON.stringify(r)); }
{ const r = await call('POST', { action: 'rm -rf' }); t('反例：未知 action → 400', r.code === 400, JSON.stringify(r)); }
// 4
{ const r = await call('POST', { action: 'load', name: 'nope' }); t('反例：load 不存在 → ok:false（不 500、不抛）', r.code === 200 && r.json.ok === false, JSON.stringify(r.json)); }
// 5
{ const r = await call('POST', { action: 'load', name: '../../etc/passwd' }); t('反例：load 路径穿越 → 被拒', r.code === 200 && r.json.ok === false && /不合法/.test(r.json.error), JSON.stringify(r.json)); }
// 6
{ const r = await call('POST', { action: 'catalog' }); t('正例：catalog count=2 state=PASS', r.code === 200 && r.json.user === undefined && r.json.count === 2 && r.json.state === 'PASS', JSON.stringify({ count: r.json && r.json.count, state: r.json && r.json.state })); }
{ const r = await call('POST', { action: 'catalog' }); t('★反例：catalog 里**不含正文**', !/ALPHA-BODY|BETA-BODY/.test(r.json.catalog || ''), (r.json.catalog || '').slice(0, 80)); }
// 7
{ const r = await call('POST', { action: 'load', name: 'beta' }); t('正例：load beta → 返回正文', r.code === 200 && r.json.ok === true && /BETA-BODY/.test(r.json.body), JSON.stringify({ bytes: r.json && r.json.bytes })); }

console.log('');
console.log('  /api/skills 反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
