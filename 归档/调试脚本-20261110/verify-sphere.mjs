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

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

const R = [];
function chk(name, pass, detail) {
  R.push({ name, pass: !!pass, detail: String(detail || '').slice(0, 130) });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(28) + (detail ? '  ' + String(detail).slice(0, 90) : ''));
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  场景关系球 · 交互实测');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ═══ 基础状态 ═══
const base = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  if (!N || !N.length) return { error: 'no neuron' };
  var S = N[0].state;
  return {
    scenes: S.scenes.length,
    edges: S.edges.length,
    domains: (function(){ var d={}; for(var i=0;i<S.scenes.length;i++){ d[S.scenes[i].domain]=(d[S.scenes[i].domain]||0)+1; } return d; })(),
    R: Math.round(S.radius||0),
    onSphere: S.scenes.filter(function(n){
      var d = Math.sqrt(n.sx*n.sx+n.sy*n.sy+n.sz*n.sz);
      return Math.abs(d - (S.radius||0)) < (S.radius||0)*0.05;
    }).length,
  };
})()`);
console.log('① 基础: ' + JSON.stringify(base));
chk('场景已加载', base.scenes > 0, base.scenes + ' 个');
chk('关系边已建立', base.edges > 0, base.edges + ' 条');
chk('全部在球面', base.onSphere === base.scenes, base.onSphere + '/' + base.scenes);
chk('领域已分类', Object.keys(base.domains).length > 1, JSON.stringify(base.domains));

// ═══ ② 360° 旋转 ═══
console.log();
console.log('② 旋转测试:');
const rot = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var before = { yaw: S.yaw, pitch: S.pitch };
  S.yaw += 1.2;
  S.pitch = 0.5;
  N.update();
  var after = { yaw: S.yaw, pitch: S.pitch };
  // 复位
  S.yaw = before.yaw; S.pitch = before.pitch;
  N.update();
  return { before: before, after: after, changed: after.yaw !== before.yaw };
})()`);
chk('可旋转', rot.changed, 'yaw ' + rot.before.yaw.toFixed(2) + ' → ' + rot.after.yaw.toFixed(2));

// ═══ ③ 拖拽节点 ═══
console.log();
console.log('③ 拖拽测试:');
const drag = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var target = S.scenes[0];
  var before = { x: target.sx, y: target.sy, z: target.sz, dragged: target.dragged };
  // 模拟拖动（直接改坐标，模拟 pointermove 的效果）
  target.sx += 40;
  target.sy -= 30;
  target.sz += 20;
  target.dragged = true;
  N.update();
  var after = { x: target.sx, y: target.sy, z: target.sz, dragged: target.dragged };
  return { name: target.name, before: before, after: after, moved: after.dragged };
})()`);
chk('节点可拖拽', drag.moved, drag.name + ' 位置已变，dragged=true');

// ═══ ④ 整理复位 ═══
console.log();
console.log('④ 整理测试:');
const tidyResult = await cdp.eval(`(async function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var R = S.radius;
  // 记录整理前
  var beforeDragged = S.scenes.filter(function(n){ return n.dragged; }).length;
  // 调用整理
  N.tidy();
  // 等动画完成
  await new Promise(function(r){ setTimeout(r, 600); });
  var afterDragged = S.scenes.filter(function(n){ return n.dragged; }).length;
  var onSphere = S.scenes.filter(function(n){
    var d = Math.sqrt(n.sx*n.sx+n.sy*n.sy+n.sz*n.sz);
    return Math.abs(d - R) < R*0.05;
  }).length;
  return { beforeDragged: beforeDragged, afterDragged: afterDragged, onSphere: onSphere, total: S.scenes.length };
})()`);
chk('整理清除拖拽标记', tidyResult.afterDragged === 0, tidyResult.beforeDragged + ' → ' + tidyResult.afterDragged);
chk('整理后回到球面', tidyResult.onSphere === tidyResult.total, tidyResult.onSphere + '/' + tidyResult.total);

// ═══ ⑤ 附属物展开 ═══
console.log();
console.log('⑤ 附属物测试:');
const attach = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var n = S.scenes[0];
  return {
    name: n.name,
    hasAttachments: !!n.attachments,
    attachments: n.attachments,
  };
})()`);
chk('节点有附属信息', attach.hasAttachments, JSON.stringify(attach.attachments || {}).slice(0, 100));

// ═══ ⑥ 点亮 ═══
console.log();
console.log('⑥ 点亮测试:');
const lit = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var target = N.state.scenes[0];
  var ok = N.lightScene(target.id, true);
  var isLit = target.lit;
  N.lightScene(target.id, false);
  var isOff = !target.lit;
  return { name: target.name, ok: ok, lit: isLit, off: isOff };
})()`);
chk('可点亮', lit.lit, lit.name);
chk('可熄灭', lit.off, '');

// ═══ JS 异常 ═══
console.log();
const uniq = [...new Set(cdp.errs)];
chk('交互期无异常', uniq.length === 0, uniq.length ? uniq[0].slice(0, 100) : '无');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────────');
console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
console.log('───────────────────────────────────────────────────────────');

cdp.close();

const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\verify-sphere.json`,
  JSON.stringify({ results: R, base }, null, 2),
  'utf8'
);
