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
            errs.push((d.exception?.description || d.text || '').slice(0, 250));
          }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 30000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch {} }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

const R = [];
function chk(name, pass, detail) {
  R.push({ name, pass: !!pass, detail: String(detail || '') });
  console.log((pass ? '  OK ' : '  XX ') + name.padEnd(34) + String(detail || '').slice(0, 50));
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  国学落地验证（五行阶段 / 三才 / 国色）');
console.log('═══════════════════════════════════════════════════════════');
console.log();

// ── ① 检查 guoxue 模块是否被加载 ──
const gx = await cdp.eval(`(function(){
  var N = window.__NEURON3D && window.__NEURON3D[0];
  if (!N) return { error: 'no neuron' };
  // 无法直接访问闭包内的 import，但可以通过行为验证
  return {
    neuronExists: true,
    sceneCount: N.state.scenes.length,
  };
})()`);
console.log('神经元: ' + JSON.stringify(gx));

// ── ② 点击一个节点，看详情面板是否显示五行 ──
console.log();
console.log('【测试】点击节点 → 详情面板是否显示五行阶段');

await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  N.resetView();
  S.viewScale = 1; S.panX = 0; S.panY = 0;
  S.hover = null; S.sel = null;
  N.update();
  return true;
})()`);
await new Promise(r => setTimeout(r, 500));

// 找节点位置
const nodePos = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var rect = cv.getBoundingClientRect();
  var W = cv.clientWidth, H = cv.clientHeight;
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var n = S.scenes.find(function(x){ return x.name === '管线'; }) || S.scenes[0];
  var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
  var x1 = n.sx*cyaw + n.sz*syaw;
  var z1 = -n.sx*syaw + n.sz*cyaw;
  var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
  var y1 = n.sy*cp - z1*sp;
  var z2 = n.sy*sp + z1*cp;
  var denom = fov/(fov+z2);
  var vs = S.viewScale || 1, px = S.panX || 0, py = S.panY || 0;
  return {
    name: n.name,
    absX: rect.x + (W/2 + x1*denom) * vs + px,
    absY: rect.y + (H/2 + y1*denom) * vs + py,
  };
})()`);

console.log('  目标: ' + nodePos.name + ' @(' + Math.round(nodePos.absX) + ',' + Math.round(nodePos.absY) + ')');

// 点击
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodePos.absX, y: nodePos.absY, button: 'none' });
await new Promise(r => setTimeout(r, 200));
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nodePos.absX, y: nodePos.absY, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nodePos.absX, y: nodePos.absY, button: 'left', clickCount: 1 });
await new Promise(r => setTimeout(r, 500));

// 检查详情面板内容
const detail = await cdp.eval(`(function(){
  var panel = document.querySelector('[data-panel-type="neuron"]');
  if (!panel) return { error: 'no panel' };
  var divs = panel.querySelectorAll('div');
  var detail = null;
  for (var i = divs.length - 1; i >= 0; i--) {
    var s = getComputedStyle(divs[i]);
    if (s.position === 'absolute' && parseInt(s.zIndex || 0) >= 5 && divs[i].style.display !== 'none') {
      detail = divs[i];
      break;
    }
  }
  if (!detail) return { visible: false };
  var txt = detail.textContent || '';
  return {
    visible: true,
    textLen: txt.length,
    text: txt.slice(0, 300),
    hasWuxing: /木|火|土|金|水/.test(txt),
    hasPhase: /阶段/.test(txt),
  };
})()`);

console.log();
if (detail.visible) {
  console.log('  详情面板内容:');
  console.log('    ' + (detail.text || '').replace(/\s+/g, ' ').slice(0, 250));
  console.log();
  chk('详情面板可见', true, detail.textLen + ' 字符');
  chk('显示五行阶段', detail.hasWuxing && detail.hasPhase, detail.hasPhase ? '有"阶段"' : '无');
} else {
  chk('详情面板可见', false, '不可见');
}

// ── ③ 国色变量是否生效 ──
console.log();
console.log('【测试】国色 CSS 变量');
const cssVars = await cdp.eval(`(function(){
  var root = document.documentElement;
  var cs = getComputedStyle(root);
  var test = {};
  var names = ['--gu-xuan', '--gu-su', '--gu-qing', '--gu-chi', '--gu-huang'];
  for (var i = 0; i < names.length; i++) {
    test[names[i]] = cs.getPropertyValue(names[i]).trim();
  }
  return test;
})()`);
console.log('  ' + JSON.stringify(cssVars, null, 2));
chk('国色变量已生效', Object.values(cssVars).filter(v => v).length >= 4,
    Object.values(cssVars).filter(v => v).length + '/5 有值');

// ── ④ refined.css 的 --rf-* 是否解析成国色 ──
const rfCheck = await cdp.eval(`(function(){
  var cs = getComputedStyle(document.documentElement);
  return {
    rfVoid: cs.getPropertyValue('--rf-void').trim(),
    rfText: cs.getPropertyValue('--rf-text').trim(),
    rfJade: cs.getPropertyValue('--rf-jade').trim(),
  };
})()`);
console.log();
console.log('  refined 变量（应解析为国色）:');
console.log('    ' + JSON.stringify(rfCheck));

console.log();
console.log('JS 错误: ' + cdp.errs.length);
if (cdp.errs.length) {
  for (const e of [...new Set(cdp.errs)].slice(0, 3)) console.log('  XX ' + e.slice(0, 150));
}

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────');
console.log('  结果: ' + passed + ' / ' + R.length);

cdp.close();
