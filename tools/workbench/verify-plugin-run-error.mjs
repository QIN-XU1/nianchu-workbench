#!/usr/bin/env node
/**
 * /api/plugin-run 错误语义验证 —— 插件真的跑失败时，HTTP 必须是 500 + 外层 ok:false。
 *
 * 【背景】第 94 轮发现：`plugin-run-handler` 原来恒 send(200, { ok:true, result: out })，
 * 但 `run()` 的返回里 `kernelOk` 可为 false、`results[].ok` 也可为 false
 * （CLI 侧 tools/plugin/run.mjs 就是按 `!kernelOk || results.some(!ok)` 判 exit 1 的）。
 * 于是插件失败时 HTTP 仍说 200 + ok:true —— 外层成功、内层失败。
 *
 * 本文件用**桩函数**注入 run 的返回值，确定性地覆盖三条路径（不需要真弄坏插件）：
 *   ① kernelOk:false        → 必须 500 + ok:false + 错误含「内核未激活」
 *   ② 某插件 ok:false       → 必须 500 + ok:false + 错误含失败插件名
 *   ③ 全成功               → 必须 200 + ok:true
 *
 * 四态：0 全通过 · 1 有失败 · 2 工具自检失败
 */
import { createPluginRunHandler } from './plugin-run-handler.mjs';

let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

/** 造一个最小 res 桩，返回捕获到的状态码与 body */
function makeRes() {
  const out = { code: 0, body: '' };
  return {
    res: { writeHead(code) { out.code = code; }, end(b) { out.body = b; } },
    get: () => out,
  };
}

async function runCase(runOut) {
  const h = createPluginRunHandler({ run: async () => runOut });
  const { res, get } = makeRes();
  await h({ method: 'POST' }, res);
  const o = get();
  let json = null;
  try { json = JSON.parse(o.body); } catch { /* 非 JSON */ }
  return { code: o.code, json };
}

// 自检：桩本身要能工作
{
  const r = await runCase({ kernelOk: true, results: [] });
  if (!r.json || r.code !== 200) { console.error('  ✗ 自检失败：全成功路径应 200，实得 ' + r.code); process.exit(2); }
}

console.log('');
console.log('  /api/plugin-run 错误语义（失败必须 500 + ok:false）');
console.log('  ' + '─'.repeat(62));

{
  const r = await runCase({ kernelOk: false, results: [] });
  t('内核未激活 → 500 + ok:false + 原因', r.code === 500 && r.json && r.json.ok === false && /内核未激活/.test(String(r.json.error)),
    `HTTP ${r.code} ok=${r.json && r.json.ok} err=${r.json && r.json.error}`);
}
{
  const r = await runCase({ kernelOk: true, results: [{ plugin: 'a', ok: true }, { plugin: 'bad', ok: false }] });
  t('某插件失败 → 500 + ok:false + 指出失败插件', r.code === 500 && r.json && r.json.ok === false && /bad/.test(String(r.json.error)),
    `HTTP ${r.code} ok=${r.json && r.json.ok} err=${r.json && r.json.error}`);
}
{
  const r = await runCase({ kernelOk: true, results: [{ plugin: 'a', ok: true }] });
  t('全成功 → 200 + ok:true', r.code === 200 && r.json && r.json.ok === true, `HTTP ${r.code} ok=${r.json && r.json.ok}`);
}

console.log('  ' + '─'.repeat(62));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);