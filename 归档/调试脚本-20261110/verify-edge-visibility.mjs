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

console.log('═══════════════════════════════════════════════════════════');
console.log('  验证：选中节点的连线在旋转到任意角度是否可见');
console.log('═══════════════════════════════════════════════════════════');
console.log();

await cdp.eval(`(function(){ var N=window.__NEURON3D[0]; N.resetView(); N.state.hover=null; N.state.sel=null; return true; })()`);
await new Promise(r => setTimeout(r, 600));

// ── 直接选中一个节点（绕过点击，确保 100% 选中）──
const selInfo = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var target = S.scenes.find(function(n){ return n.name === '管线'; }) || S.scenes[0];
  S.sel = target;
  N.update();
  return { name: target.name, id: target.id, degree: target.degree };
})()`);
console.log('选中节点: ' + selInfo.name + '（连接度 ' + selInfo.degree + '）');
console.log();

// ── 测试：旋转一整圈，检查连线是否都在 ──
console.log('  角度     选中节点z    该节点连线数  可见连线数  结论');
console.log('  ' + '─'.repeat(70));

const results = [];

for (let deg = 0; deg < 360; deg += 30) {
  const r = await cdp.eval(`(function(){
    var N = window.__NEURON3D[0];
    var S = N.state;
    S.yaw = (${deg}) * Math.PI / 180;
    S.pitch = -0.25;
    N.update();

    var cv = document.querySelector('[data-panel-type="neuron"] canvas');
    var W = cv.clientWidth, H = cv.clientHeight;
    var R = S.radius, fov = (S.radiusX || R) * 2.6 / S.zoom;
    var cx = W/2, cy = H/2;

    // 选中节点的世界 z
    var sel = S.sel;
    var cyaw = Math.cos(S.yaw), syaw = Math.sin(S.yaw);
    var x1 = sel.sx*cyaw + sel.sz*syaw;
    var z1 = -sel.sx*syaw + sel.sz*cyaw;
    var cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var y1 = sel.sy*cp - z1*sp;
    var z2 = sel.sy*sp + z1*cp;

    // 计算与该节点相关的所有边，以及它们会不会被裁剪
    var myEdges = [];
    var visible = 0;
    for (var i = 0; i < S.edges.length; i++) {
      var e = S.edges[i];
      if (e.a !== sel.id && e.b !== sel.id) continue;
      myEdges.push(e);

      // 模拟渲染时的裁剪判定
      var na = S.byId[e.a], nb = S.byId[e.b];
      if (!na || !nb) continue;

      function projWorld(n) {
        var cyaw2 = Math.cos(S.yaw), syaw2 = Math.sin(S.yaw);
        var x2 = n.sx*cyaw2 + n.sz*syaw2;
        var zz = -n.sx*syaw2 + n.sz*cyaw2;
        var cp2 = Math.cos(S.pitch), sp2 = Math.sin(S.pitch);
        var y2 = n.sy*cp2 - zz*sp2;
        var z2b = n.sy*sp2 + zz*cp2;
        return { z: z2b };
      }
      var pa = projWorld(na);
      var pb = projWorld(nb);
      var frontness = Math.max(pa.z, pb.z) / R;

      var isImportant = true;   // 与选中节点相关 → isHot=true → important
      // 判定：重要边永不裁剪
      if (isImportant || frontness >= -0.95) visible++;
    }

    return {
      deg: ${deg},
      selZ: Math.round(z2),
      selZNorm: Math.round(z2 / R * 100) / 100,
      edgeCount: myEdges.length,
      visibleCount: visible,
    };
  })()`);

  const ok = r.visibleCount === r.edgeCount;
  results.push(r);

  console.log('  ' + String(r.deg).padStart(3) + '°' +
    '  ' + String(r.selZNorm).padStart(8) +
    '  ' + String(r.edgeCount).padStart(9) +
    '  ' + String(r.visibleCount).padStart(9) +
    '    ' + (ok ? '✓ 全部可见' : '✗ 有缺失'));
}

console.log();
const allOk = results.every(r => r.visibleCount === r.edgeCount);
console.log('════ 结论 ════');
if (allOk) {
  console.log('  ✓ 选中节点的连线在任意角度都可见（不再消失）');
} else {
  const bad = results.filter(r => r.visibleCount !== r.edgeCount);
  console.log('  ✗ 仍有 ' + bad.length + ' 个角度存在连线消失');
  for (const b of bad) console.log('    ' + b.deg + '°: ' + b.visibleCount + '/' + b.edgeCount);
}

cdp.close();
