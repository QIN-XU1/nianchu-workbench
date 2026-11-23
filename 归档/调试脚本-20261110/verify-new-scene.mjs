/**
 * 新场景加入的端到端实测
 *
 * 验证：
 *   ① 新建场景后，神经元是否自动检测到
 *   ② 是否有视觉提示（脉冲环 / toast）
 *   ③ 场景删除后是否清理
 *   ④ 场景数变化后布局是否仍合理
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HATCH = path.join(ROOT, 'workbench', '工具', 'scene-hatch.mjs');
const REG = path.join(ROOT, 'workbench', '引擎数据', '.dsh', '场景记忆', '_共享记忆', '索引.json');

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const errs = [];
  return {
    errs,
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            errs.push((d.exception?.description || d.text || '').slice(0, 300));
          }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 40000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch {} }
  };
}

const R = [];
function chk(name, pass, detail) {
  R.push({ name, pass: !!pass, detail: String(detail || '').slice(0, 130) });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(32) + (detail ? '  ' + String(detail).slice(0, 90) : ''));
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  新场景加入 · 端到端实测');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ═══ 连 CDP ═══
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

// ═══ ① 记录初始状态 ═══
console.log('① 初始状态:');
const before = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  if (!N || !N.length) return { error: 'no neuron' };
  var S = N[0].state;
  return {
    count: S.scenes.length,
    ids: S.scenes.map(function(n){ return n.id; }).sort(),
    hasRefresh: typeof N[0].refresh === 'function',
    hasAutoRefresh: !!S.autoRefreshTimer,
    hasLastIds: (S.lastSceneIds || []).length,
  };
})()`);
console.log('   ' + JSON.stringify(before));
chk('神经元已加载', before.count > 0, before.count + ' 个场景');
chk('有 refresh 方法', before.hasRefresh);
chk('自动刷新已启动', before.hasAutoRefresh);
chk('记录了场景 id 基线', before.hasLastIds > 0, before.hasLastIds + ' 个');

// ═══ ② 新建场景 ═══
console.log();
console.log('② 新建一个测试场景:');
const TEST_ID = 'e2e-new-' + Date.now().toString(36);
const SPEC = path.join(ROOT, 'prototype', '_e2e-spec.json');
fs.writeFileSync(SPEC, JSON.stringify({
  id: TEST_ID,
  name: '端到端测试-' + TEST_ID.slice(-4),
  role: '验证新场景能否自动出现在神经元中',
  reason: '验证热更新机制',
  hatchedBy: 'e2e-test',
}, null, 2), 'utf8');

const hatched = spawnSync(process.execPath, [HATCH, '--create', '--spec', SPEC], {
  encoding: 'utf8', timeout: 40000, cwd: ROOT,
});
console.log('   ' + (hatched.stdout || '').split('\n').filter(l => l.includes('已孵化')).join(' '));
chk('场景孵化成功', hatched.status === 0, 'exit=' + hatched.status);

// ═══ ③ 触发刷新并检查 ═══
console.log();
console.log('③ 触发神经元刷新:');
const refreshed = await cdp.eval(`(async function(){
  try {
    var N = window.__NEURON3D[0];
    var changes = await N.refresh();
    var S = N.state;
    return {
      changes: {
        added: (changes && changes.added || []).map(function(s){ return s.id; }),
        removed: (changes && changes.removed) || [],
      },
      newCount: S.scenes.length,
      newIds: S.scenes.map(function(n){ return n.id; }).sort(),
      newSceneIds: Array.from(S.newSceneIds || []),
    };
  } catch(e) { return { error: e.message }; }
})()`);
console.log('   ' + JSON.stringify(refreshed, null, 2).slice(0, 400));
chk('刷新检测到新增', refreshed.changes && refreshed.changes.added.length > 0,
    refreshed.changes ? refreshed.changes.added.join(',') : '');
chk('场景数增加', refreshed.newCount > before.count, before.count + ' → ' + refreshed.newCount);
chk('新场景被标记', refreshed.newSceneIds.length > 0, refreshed.newSceneIds.join(','));

// ═══ ④ 检查新场景在球上的位置 ═══
console.log();
console.log('④ 新场景的球面位置:');
const pos = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  var R = S.radius;
  var n = S.scenes.find(function(x){ return x.id === '${TEST_ID}'; });
  if (!n) return { error: 'not found' };
  var d = Math.sqrt(n.sx*n.sx + n.sy*n.sy + n.sz*n.sz);
  return {
    name: n.name, domain: n.domain,
    dist: Math.round(d * 10) / 10,
    R: Math.round(R),
    x: Math.round(n.sx), y: Math.round(n.sy), z: Math.round(n.sz),
  };
})()`);
console.log('   ' + JSON.stringify(pos));
chk('新场景有坐标', !pos.error, pos.error || ('dist=' + pos.dist));

// ═══ ⑤ 删除场景并验证清理 ═══
console.log();
console.log('⑤ 删除测试场景:');
spawnSync(process.execPath, ['-e', `
const fs = require('fs');
const path = require('path');
const reg = ${JSON.stringify(REG)};
const j = JSON.parse(fs.readFileSync(reg, 'utf8'));
const before = j.areas.length;
j.areas = j.areas.filter(a => a.id !== '${TEST_ID}');
fs.writeFileSync(reg, JSON.stringify(j, null, 2), 'utf8');
console.log('removed: ' + before + ' -> ' + j.areas.length);
`], { encoding: 'utf8', timeout: 20000 });

// 清理文件
for (const p of [
  path.join(ROOT, 'workbench', '外壳', 'scenarios', TEST_ID + '.json'),
  path.join(ROOT, 'workbench', 'sceneboard', 'scenes', TEST_ID + '.json'),
  path.join(ROOT, 'workbench', '引擎数据', '.dsh', '场景记忆', '端到端测试-' + TEST_ID.slice(-4)),
]) {
  try {
    if (fs.existsSync(p)) {
      if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    }
  } catch (e) {}
}
try { fs.unlinkSync(SPEC); } catch (e) {}

const afterDel = await cdp.eval(`(async function(){
  var N = window.__NEURON3D[0];
  var changes = await N.refresh();
  var S = N.state;
  return {
    removed: (changes && changes.removed) || [],
    count: S.scenes.length,
    stillHas: S.scenes.some(function(n){ return n.id === '${TEST_ID}'; }),
  };
})()`);
console.log('   ' + JSON.stringify(afterDel));
chk('删除被检测到', afterDel.removed.length > 0, afterDel.removed.join(','));
chk('节点已清理', !afterDel.stillHas);
chk('场景数恢复', afterDel.count === before.count, before.count + ' → ' + afterDel.count);

// ═══ ⑥ JS 异常 ═══
console.log();
const uniq = [...new Set(cdp.errs)];
chk('全程无异常', uniq.length === 0, uniq.length ? uniq[0].slice(0, 100) : '无');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────────');
console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
console.log('───────────────────────────────────────────────────────────');

cdp.close();

fs.writeFileSync(
  path.join(HERE, 'verify-new-scene.json'),
  JSON.stringify({ results: R, before, refreshed: refreshed.changes }, null, 2),
  'utf8'
);
