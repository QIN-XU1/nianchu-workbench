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

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══════════════════════════════════════════════════════════');
console.log('  档位切换实测（节点数量变化时的编排）');
console.log('═══════════════════════════════════════════════════════════');
console.log();

// 保存原始场景，测试完恢复
await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  window.__ORIG_SCENES = S.scenes.slice();
  window.__ORIG_EDGES = S.edges.slice();
  return true;
})()`);

const fs = await import('node:fs');
const ROOT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研`;

const results = [];

for (const N of [10, 24, 50, 120, 200, 600, 1000]) {
  // 生成模拟节点
  const r = await cdp.eval(`(function(){
    var N = window.__NEURON3D[0];
    var S = N.state;
    var orig = window.__ORIG_SCENES || [];
    var target = ${N};

    // 用原始场景为基础，不足的复制扩充
    var arr = [];
    for (var i = 0; i < target; i++) {
      var base = orig[i % orig.length] || orig[0];
      if (!base) return { error: 'no base' };
      var copy = Object.assign({}, base);
      copy.id = base.id + (i >= orig.length ? '-x' + i : '');
      copy.name = base.name + (i >= orig.length ? '#' + i : '');
      arr.push(copy);
    }
    S.scenes = arr;

    var t0 = performance.now();
    N.update();
    var dt = performance.now() - t0;

    var S2 = N.state;
    // 计算最小屏幕间距
    var cv = document.querySelector('[data-panel-type="neuron"] canvas');
    var W = cv.clientWidth, H = cv.clientHeight;
    var R = S2.radius, fov = (S2.radiusX || R) * 2.6 / S2.zoom;
    var cx = W/2, cy = H/2;
    var pts = [];
    for (var i = 0; i < S2.scenes.length; i++) {
      var n = S2.scenes[i];
      var cyaw = Math.cos(S2.yaw), syaw = Math.sin(S2.yaw);
      var x1 = n.sx*cyaw + n.sz*syaw;
      var z1 = -n.sx*syaw + n.sz*cyaw;
      var cp = Math.cos(S2.pitch), sp = Math.sin(S2.pitch);
      var y1 = n.sy*cp - z1*sp;
      var z2 = n.sy*sp + z1*cp;
      var denom = fov/(fov+z2);
      pts.push({ x: cx + x1*denom, y: cy + y1*denom });
    }
    var minGap = Infinity, overlap = 0;
    var lim = Math.min(pts.length, 400);   // 采样上限，避免 O(n²) 爆
    for (var i = 0; i < lim; i++) {
      for (var j = i+1; j < lim; j++) {
        var d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        if (d < minGap) minGap = d;
        if (d < 8) overlap++;
      }
    }

    return {
      count: target,
      tier: S2.tier,
      densityFactor: Math.round((S2.densityFactor || 1) * 100) / 100,
      dt: Math.round(dt * 10) / 10,
      minGap: minGap === Infinity ? 0 : Math.round(minGap * 10) / 10,
      overlap: overlap,
      labelCount: (S2.labelRects || []).length,
      rx: Math.round(S2.radiusX),
      ry: Math.round(S2.radiusY),
      spikes: S2.tierCfg ? S2.tierCfg.spikes : null,
    };
  })()`);

  if (r.__exception) {
    console.log('  n=' + N + '  ERROR: ' + r.__exception.slice(0, 60));
    continue;
  }
  results.push(r);
}

console.log('  节点数  tier  密度因子  渲染耗时  最小间距  重叠  标签数  芒  星域半径');
console.log('  ' + '─'.repeat(84));

for (const r of results) {
  console.log('  ' + String(r.count).padStart(5) +
    '   ' + r.tier.padEnd(4) +
    '  ' + String(r.densityFactor).padStart(6) +
    '  ' + String(r.dt + 'ms').padStart(8) +
    '  ' + String(r.minGap).padStart(8) +
    '  ' + String(r.overlap).padStart(5) +
    '  ' + String(r.labelCount).padStart(6) +
    '  ' + (r.spikes ? '有' : '无') +
    '    ' + r.rx + '×' + r.ry);
}

console.log();

// ── 截图对比（S 档 vs XL 档）──
console.log('════ 截图对比 ════');

for (const N of [200, 1000]) {
  await cdp.eval(`(function(){
    var N0 = window.__NEURON3D[0];
    var S = N0.state;
    var orig = window.__ORIG_SCENES || [];
    var target = ${N};
    var arr = [];
    for (var i = 0; i < target; i++) {
      var base = orig[i % orig.length];
      var copy = Object.assign({}, base);
      copy.id = base.id + (i >= orig.length ? '-x' + i : '');
      copy.name = base.name + (i >= orig.length ? '#' + i : '');
      arr.push(copy);
    }
    S.scenes = arr;
    N0.update();
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 300));

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 90, width: 1230, height: 800, scale: 1 },
  });
  fs.writeFileSync(ROOT + '\\prototype\\screens\\tier-' + N + '.png', Buffer.from(shot.data, 'base64'));
  console.log('  已保存 tier-' + N + '.png');
}

// ── 恢复原始状态 ──
await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  S.scenes = window.__ORIG_SCENES;
  S.edges = window.__ORIG_EDGES;
  N.resetView();
  return { restored: S.scenes.length };
})()`);
console.log();
console.log('  已恢复原始 10 个场景');

cdp.close();
