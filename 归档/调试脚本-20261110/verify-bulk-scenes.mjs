/**
 * 大量场景涌入时界面行为实测
 *
 * 用真实注册表塞入 200 个场景，验证：
 *   ① 界面是否崩溃
 *   ② 布局是否严重重叠
 *   ③ 规模降级是否生效
 *   ④ 刷新耗时
 *
 * 测试后完整清理回原始状态。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WB = path.join(ROOT, 'workbench');
const REG = path.join(WB, '引擎数据', '.dsh', '场景记忆', '_共享记忆', '索引.json');
const SCEN = path.join(WB, '外壳', 'scenarios');
const CONT = path.join(WB, 'sceneboard', 'scenes');

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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 60000); });
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
  R.push({ name, pass: !!pass, detail: String(detail || '').slice(0, 120) });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(30) + (detail ? '  ' + String(detail).slice(0, 90) : ''));
}

// ═══ 备份原始注册表 ═══
const regBackup = fs.readFileSync(REG, 'utf8');
const origAreas = JSON.parse(regBackup).areas;

console.log('═══════════════════════════════════════════════════════════════');
console.log('  大量场景涌入 · 界面行为实测');
console.log('═══════════════════════════════════════════════════════════════');
console.log();
console.log('  原始场景数: ' + origAreas.length);
console.log();

// ═══ 生成 N 个假场景并写入注册表 ═══
const DOMAINS_KW = [
  ['架构设计', 'eng'], ['文档编写', 'content'], ['磁盘清理', 'tool'],
  ['情感咨询', 'social'], ['八字排盘', 'mingli'], ['杂项处理', 'other'],
];

function injectScenes(n) {
  const j = JSON.parse(regBackup);
  const added = [];
  for (let i = 0; i < n; i++) {
    const id = 'bulk-' + i;
    const [roleName, dom] = DOMAINS_KW[i % DOMAINS_KW.length];
    added.push({ id, name: roleName + '#' + i, role: roleName, dom });
  }
  for (const a of added) {
    j.areas.push({
      id: a.id, name: a.name, owner: 'bulk-ai',
      memory: '场景记忆/' + a.name, file: 'areas/' + a.id + '.md',
      panel: 'bulk-chat',
    });
    // 也写场景定义（getScenario 需要）
    fs.writeFileSync(path.join(SCEN, a.id + '.json'), JSON.stringify({
      id: a.id, name: a.name,
      description: a.role,
      layout: 'grid', theme: 'dark',
      panels: [{ id: a.id + '-n', title: '记忆神经元', type: 'neuron', w: 2, h: 5, col: 1, row: 1 }],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(CONT, a.id + '.json'), JSON.stringify({
      id: a.id, name: a.name, role: a.role,
      description: a.role, inputs: [], outputs: [],
    }, null, 2), 'utf8');
  }
  fs.writeFileSync(REG, JSON.stringify(j, null, 2), 'utf8');
  return added;
}

function cleanup() {
  fs.writeFileSync(REG, regBackup, 'utf8');
  for (const f of fs.readdirSync(SCEN)) {
    if (f.startsWith('bulk-')) try { fs.unlinkSync(path.join(SCEN, f)); } catch (e) {}
  }
  for (const f of fs.readdirSync(CONT)) {
    if (f.startsWith('bulk-')) try { fs.unlinkSync(path.join(CONT, f)); } catch (e) {}
  }
}

// ═══ 连 CDP ═══
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

// ═══ 逐级加压 ═══
console.log('  场景数   刷新耗时  渲染耗时  节点数  降级模式  最小间距  重叠  结论');
console.log('  ' + '─'.repeat(84));

try {
  for (const N of [50, 100, 200, 500]) {
    // 注入
    cleanup();
    injectScenes(N);

    // 刷新
    const r = await cdp.eval(`(async function(){
      var t0 = performance.now();
      var N = window.__NEURON3D[0];
      var ch = await N.refresh();
      var dtRefresh = performance.now() - t0;

      var t1 = performance.now();
      N.update();
      var dtRender = performance.now() - t1;

      var S = N.state;
      // 计算最小间距
      var minGap = Infinity;
      var overlap = 0;
      for (var i = 0; i < S.scenes.length; i++) {
        for (var j = i+1; j < S.scenes.length; j++) {
          var a = S.scenes[i], b = S.scenes[j];
          var dx = a.sx-b.sx, dy = a.sy-b.sy, dz = a.sz-b.sz;
          var d = Math.sqrt(dx*dx+dy*dy+dz*dz);
          if (d < minGap) minGap = d;
          if (d < 10) overlap++;
        }
      }

      return {
        count: S.scenes.length,
        added: ch && ch.added ? ch.added.length : 0,
        dtRefresh: Math.round(dtRefresh),
        dtRender: Math.round(dtRender),
        minGap: minGap === Infinity ? 0 : Math.round(minGap * 10) / 10,
        overlap: overlap,
        scaleMode: S.scaleMode || '(未设置)',
        R: Math.round(S.radius || 0),
      };
    })()`);

    if (r.__exception) {
      console.log('  ' + String(N).padStart(6) + '   ERROR: ' + r.__exception.slice(0, 60));
      continue;
    }

    const verdict = r.overlap === 0 ? '✓' : (r.overlap < r.count * 0.05 ? '○' : '✗');
    console.log('  ' + String(r.count + origAreas.length - 1).padStart(6) +
      String(r.dtRefresh + 'ms').padStart(10) +
      String(r.dtRender + 'ms').padStart(10) +
      String(r.count).padStart(8) +
      String(r.scaleMode).padStart(10) +
      String(r.minGap).padStart(10) +
      String(r.overlap).padStart(6) +
      '   ' + verdict);

    R.push({
      name: N + ' 个批量场景',
      pass: r.dtRefresh < 3000 && r.overlap < r.count * 0.1,
      detail: '刷新 ' + r.dtRefresh + 'ms, 重叠 ' + r.overlap + '/' + r.count + ', 模式 ' + r.scaleMode,
    });
  }
} finally {
  // ═══ 清理 ═══
  cleanup();
  await cdp.eval(`(async function(){
    var N = window.__NEURON3D[0];
    await N.refresh();
    return true;
  })()`);
}

console.log();
console.log('  （已清理测试数据，注册表已恢复）');
console.log();

// ═══ 汇总 ═══
console.log('───────────────────────────────────────────────────────────');
chk('50 个批量场景可处理', R[0] ? R[0].pass : false, R[0] ? R[0].detail : '');
chk('100 个批量场景可处理', R[1] ? R[1].pass : false, R[1] ? R[1].detail : '');
chk('200 个批量场景可处理', R[2] ? R[2].pass : false, R[2] ? R[2].detail : '');
chk('500 个批量场景可处理', R[3] ? R[3].pass : false, R[3] ? R[3].detail : '');

const uniq = [...new Set(cdp.errs)];
chk('全程无 JS 异常', uniq.length === 0, uniq.length ? uniq[0].slice(0, 100) : '无');

// 验证恢复
const restored = await cdp.eval(`(function(){
  var S = window.__NEURON3D[0].state;
  return { count: S.scenes.length };
})()`);
chk('恢复原始场景数', restored.count === origAreas.filter(a=>!a.isHub).length,
    restored.count + ' 个');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');

cdp.close();

fs.writeFileSync(
  path.join(HERE, 'verify-bulk-scenes.json'),
  JSON.stringify({ results: R }, null, 2),
  'utf8'
);
