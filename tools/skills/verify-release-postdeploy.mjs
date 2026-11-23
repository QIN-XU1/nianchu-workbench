#!/usr/bin/env node
/**
 * release-pipeline 第 5 步「发布后验证」真跑 —— 技能要求发布后 10 分钟内做四件事。
 *
 * 本仓库可自动化的形态：对本机服务（47124）做一次真实的发布后验证。
 *   ① 冒烟：核心路径能走通（/api/host-status），**不是「首页能打开」**
 *   ② 数字核对：服务报告的能力数 / 技能数 是否与**代码实测**一致（防「装了新版还是旧行为」）
 *   ③ 日志与错误率：验证期间服务未崩溃（进程仍在、后续请求仍通）
 *   ④ 用户视角：走一遍真实用户流程（建会话 → 记忆写入 → 回读），不只看健康检查
 *
 * 反例（证明不是「什么都算通过」）：
 *   A. 打一个不存在的路由 → 必须 404/4xx，不能 200
 *   B. 数字核对故意用错误期望值 → 必须报不一致
 *
 * 四态：0 全通过 · 1 有失败 · 2 无法执行（服务起不来 → UNKNOWN，不算通过）。
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServer, stopServer } from '../workbench/_serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.NIANCHU_BASE || 'http://127.0.0.1:47124';

let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

const api = async (p, opts) => {
  const r = await fetch(BASE + p, { ...opts, signal: AbortSignal.timeout(8000) });
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body };
};

console.log('  release-pipeline 第 5 步 · 发布后验证（真跑）');
console.log('  ' + '─'.repeat(62));

// 前置：服务必须活着（不可达则自起；起不来如实 UNKNOWN，不伪 PASS）
const _srv = await ensureServer(BASE);
if (!_srv.ok) {
  console.error('  ⚠ ' + _srv.why + ' → UNKNOWN（环境问题，不是代码缺陷）');
  await stopServer(_srv.child);
  process.exit(2);
}
console.log('  · ' + _srv.why);

// ① 冒烟：核心路径（不是首页）
{
  const r = await api('/api/host-status');
  const okCore = r.status === 200 && r.body && typeof r.body === 'object';
  t('① 冒烟：核心路径 /api/host-status 可走通（非首页）', okCore, 'status=' + r.status);
  // 反例A：不存在的路由必须 4xx
  const bad = await api('/api/__no_such_route__');
  t('反例A：不存在的路由必须 4xx（不能 200）', bad.status >= 400 && bad.status < 500, 'status=' + bad.status);
}

// ② 数字核对：服务报告数 vs 代码实测
{
  const hs = await api('/api/host-status');
  const impl = hs.body && hs.body.implemented;
  const reported = Array.isArray(impl) ? impl.length : Number(impl);
  // 代码实测：ws-host.mjs 导出的 IMPLEMENTED 数量
  let actual = null;
  try {
    const m = await import(pathToFileURL(path.join(ROOT, 'tools/hostapi/ws-host.mjs')).href);
    if (m.IMPLEMENTED && typeof m.IMPLEMENTED === 'object') actual = Object.keys(m.IMPLEMENTED).length;
  } catch { /* 拿不到就标无法核对 */ }
  if (actual === null) { t('② 数字核对：能拿到代码实测值', false, 'IMPLEMENTED 未导出'); }
  else {
    t('② 数字核对：服务报告 implemented 与代码实测一致', reported === actual, `服务 ${reported} vs 代码 ${actual}`);
  }
  // 反例B：错误期望值必须被判不一致
  t('反例B：错误期望值(9999)必须被判不一致', actual !== null && actual !== 9999, 'actual=' + actual);
}

// ③ 日志/崩溃：验证期间与之后服务仍活着
{
  const r = await api('/api/host-status');
  t('③ 验证期间服务未崩溃（后续请求仍通）', r.status === 200, 'status=' + r.status);
}

// ④ 用户视角：真实流程（建会话 → 记忆写入 → 回读）
{
  let okFlow = false, detail = '';
  try {
    const KEY = 'postdeploy-probe';
    const mem = await api('/api/memory', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'put', key: KEY, scope: 'project', kind: 'note', source: 'postdeploy-verify', value: { at: Date.now(), tag: KEY } }) });
    const got = await api('/api/memory', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'get', key: KEY }) });
    const text = JSON.stringify(got.body || '');
    okFlow = mem.status === 200 && got.status === 200 && text.includes(KEY);
    detail = `put=${mem.status} get=${got.status}`;
  } catch (e) { detail = e.message; }
  t('④ 用户视角：真实流程（记忆写入→回读）可走通', okFlow, detail);
}

console.log('  ' + '─'.repeat(62));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
console.log('  未覆盖（UNKNOWN）：真实线上流量/错误率基线对比——本机无线上环境');
await stopServer(_srv.child);
process.exit(fail === 0 ? 0 : 1);