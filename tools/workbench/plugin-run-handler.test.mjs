#!/usr/bin/env node
/**
 * /api/plugin-run 处理器的反例测试（不需要起服务器）。
 *
 * 纪律：每个检查都要有「应当失败的反例」。
 * 这里验 6 条，其中 4 条是**必须被拒绝**的构造：
 *   1. GET        → 405（不是 200）
 *   2. PUT        → 405
 *   3. 并发第二次 → 429（不是两个都跑）
 *   4. 插件抛错   → 500 且带错误信息（不是假装 200）
 *   5. POST       → 200 且带 result（正例，防止「全拒绝」也算过）
 *   6. 请求体里带 path 字段 → **被忽略**，仍然只跑写死的根（防路径穿越）
 */
import { createPluginRunHandler, createViteMiddleware } from './plugin-run-handler.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ← ' + detail : '')); }
};

function fakeRes() {
  const r = { code: null, headers: null, body: null };
  r.writeHead = (code, headers) => { r.code = code; r.headers = headers || {}; };
  r.end = (b) => { r.body = b; };
  r.json = () => { try { return JSON.parse(r.body); } catch { return null; } };
  return r;
}

const okRun = async () => ({ kernelOk: true, order: ['probe-reader', 'probe-audit'], results: [{ plugin: 'probe-reader', ok: true }], evidencePath: 'evidence/plugin-probe/live-run.json' });

// 1) GET → 405
{
  const h = createPluginRunHandler({ run: okRun });
  const res = fakeRes();
  await h({ method: 'GET', url: '/api/plugin-run' }, res);
  t('反例：GET → 405', res.code === 405, 'code=' + res.code);
  t('  405 带 Allow: POST', res.headers && res.headers.allow === 'POST', JSON.stringify(res.headers));
}

// 2) PUT → 405
{
  const h = createPluginRunHandler({ run: okRun });
  const res = fakeRes();
  await h({ method: 'PUT', url: '/api/plugin-run' }, res);
  t('反例：PUT → 405', res.code === 405, 'code=' + res.code);
}

// 3) 并发第二次 → 429
{
  let release;
  const slow = () => new Promise((r) => { release = () => r({ kernelOk: true, results: [] }); });
  const h = createPluginRunHandler({ run: slow });
  const r1 = fakeRes();
  const p1 = h({ method: 'POST' }, r1);
  const r2 = fakeRes();
  await h({ method: 'POST' }, r2);
  t('反例：并发第二次 → 429（不是两个都跑）', r2.code === 429, 'code=' + r2.code);
  release();
  await p1;
  t('  第一次最终仍 200', r1.code === 200, 'code=' + r1.code);
}

// 4) 插件抛错 → 500
{
  const boom = async () => { throw new Error('模拟插件炸了'); };
  const h = createPluginRunHandler({ run: boom });
  const res = fakeRes();
  await h({ method: 'POST' }, res);
  t('反例：插件抛错 → 500 且带错误信息', res.code === 500 && /模拟插件炸了/.test(String(res.json()?.error)), JSON.stringify(res.json()));
}

// 5) POST 正例
{
  const h = createPluginRunHandler({ run: okRun });
  const res = fakeRes();
  await h({ method: 'POST' }, res);
  const j = res.json();
  t('正例：POST → 200 且带 result（防「全拒绝」也算过）',
    res.code === 200 && j && j.ok === true && Array.isArray(j.result.results), JSON.stringify(j).slice(0, 120));
}

// 6) 请求体带 path → 被忽略（根写死）
{
  let seenArgs = null;
  const spy = async (a) => { seenArgs = a; return { kernelOk: true, results: [] }; };
  const h = createPluginRunHandler({ run: spy });
  const res = fakeRes();
  await h({ method: 'POST', body: JSON.stringify({ root: '../../../etc', path: '/etc/passwd' }) }, res);
  t('反例：请求体带 root/path → 被忽略（只传 writeEvidence）',
    seenArgs && Object.keys(seenArgs).length === 1 && seenArgs.writeEvidence === true,
    JSON.stringify(seenArgs));
}

// 7) Vite 中间件：非本路径必须 next()
{
  const mw = createViteMiddleware({ run: okRun });
  let nexted = false;
  await mw({ method: 'POST', url: '/api/other' }, fakeRes(), () => { nexted = true; });
  t('Vite 中间件：非 /api/plugin-run → next()', nexted === true);

  const res = fakeRes();
  let nexted2 = false;
  await mw({ method: 'POST', url: '/api/plugin-run?x=1' }, res, () => { nexted2 = true; });
  t('Vite 中间件：带 query 的 /api/plugin-run → 处理且不 next()', nexted2 === false && res.code === 200, 'code=' + res.code);
}

console.log('');
console.log('  /api/plugin-run 反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
