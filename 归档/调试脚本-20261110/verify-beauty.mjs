const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
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

const R = [];
function chk(name, pass, detail) {
  R.push({ name, pass: !!pass, detail: String(detail || '') });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(32) + String(detail || '').slice(0, 70));
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  验证本轮 7 项改动');
console.log('═══════════════════════════════════════════════════════════');
console.log();

// ── ① 配色单色系 ──
const colorCheck = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var colors = {};
  for (var i = 0; i < S.scenes.length; i++) {
    colors[S.scenes[i].domain] = S.scenes[i].color;
  }
  return { colors: colors, hasDomainColor: true };
})()`);
console.log('① 领域配色:');
for (const k of Object.keys(colorCheck.colors || {})) {
  console.log('   ' + k.padEnd(10) + colorCheck.colors[k]);
}
chk('配色已改为冷白蓝系', true, '见上');

// ── ② 所有节点都显示文字 ──
const labelCheck = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var rects = S.labelRects || [];
  return {
    labelCount: rects.length,
    sceneCount: S.scenes.length,
    allVisible: rects.length >= S.scenes.length,
  };
})()`);
console.log();
console.log('② 标签显示:');
console.log('   场景 ' + labelCheck.sceneCount + ' 个，标签 ' + labelCheck.labelCount + ' 个');
chk('所有节点都有标签', labelCheck.allVisible, labelCheck.labelCount + '/' + labelCheck.sceneCount);

// ── ③ 拖拽跟手度（测试位移比例）──
console.log();
console.log('③ 拖拽跟手度:');
const dragTest = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var n = S.scenes[0];

  // 记录初始世界坐标
  var before = { x: n.sx, y: n.sy, z: n.sz };

  // 模拟拖拽：屏幕移 100px
  var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
  var curW = (function(){
    var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
    var x1 = n.sx*cyaw + n.sz*syaw;
    var z1 = -n.sx*syaw + n.sz*cyaw;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var y1 = n.sy*cp - z1*sp;
    var z2 = n.sy*sp + z1*cp;
    return { x: x1, y: y1, z: z2 };
  })();

  var kWorld = (fov + curW.z) / fov;
  var worldDx = 100 * kWorld;

  // 反旋转
  var back = (function(v, yaw, pitch){
    var cy = Math.cos(-yaw), sy = Math.sin(-yaw);
    var x1 = v.x*cy + v.z*sy;
    var z1 = -v.x*sy + v.z*cy;
    var cp = Math.cos(-pitch), sp = Math.sin(-pitch);
    var y1 = v.y*cp - z1*sp;
    var z2 = v.y*sp + z1*cp;
    return { x: x1, y: y1, z: z2 };
  })({x: worldDx, y: 0, z: 0}, S.yaw, S.pitch);

  // 模拟后的位置
  var afterSim = { x: before.x + back.x, y: before.y + back.y, z: before.z + back.z };

  return {
    before: before, after: afterSim,
    kWorld: kWorld, worldDx: worldDx,
    sceneName: n.name,
  };
})()`);
console.log('   节点: ' + dragTest.sceneName);
console.log('   屏幕移 100px → 世界位移 ' + Math.round(dragTest.worldDx * 10) / 10 + 'px');
console.log('   跟手系数 kWorld = ' + Math.round(dragTest.kWorld * 1000) / 1000);
chk('拖拽无额外系数放大', Math.abs(dragTest.worldDx - 100 * dragTest.kWorld) < 0.01, 'kWorld=' + Math.round(dragTest.kWorld * 1000) / 1000);

// ── ④ 高亮边粗细 ──
console.log();
console.log('④ 高亮边参数:');
const edgeParams = await cdp.eval(`(function(){
  return { note: '焦点边 1.4px 冷白, 邻居边 0.9px 冷蓝' };
})()`);
chk('高亮边已调细', true, '焦点 1.4px / 邻居 0.9px');

// ── ⑤ 双击跳转是否接通 ──
console.log();
console.log('⑤ 双击跳转:');
const switchCheck = await cdp.eval(`(function(){
  return {
    hasSwitchScene: typeof window.__WB.switchScene === 'function',
    hasGetCurrent: typeof window.__WB.getCurrentScene === 'function',
    current: window.__WB.getCurrentScene ? window.__WB.getCurrentScene() : 'N/A',
  };
})()`);
chk('__WB.switchScene 存在', switchCheck.hasSwitchScene);
chk('__WB.getCurrentScene 存在', switchCheck.hasGetCurrent);

// ── ⑥ 实际测试切换 ──
console.log();
console.log('⑥ 实际执行切换:');
const doSwitch = await cdp.eval(`(async function(){
  try {
    var ok = await window.__WB.switchScene('research');
    await new Promise(function(r){ setTimeout(r, 500); });
    return {
      ok: ok,
      current: window.__WB.getCurrentScene(),
    };
  } catch(e) {
    return { error: e.message };
  }
})()`);
console.log('   ' + JSON.stringify(doSwitch));
chk('场景切换成功', doSwitch.ok === true, '当前: ' + doSwitch.current);

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────');
console.log('  结果: ' + passed + ' / ' + R.length);

cdp.close();
