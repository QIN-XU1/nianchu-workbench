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
console.log('  连续 30 帧耗时采样（找慢帧原因）');
console.log('═══════════════════════════════════════════════════════════');
console.log();

const frames = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var times = [];
  for (var k = 0; k < 30; k++) {
    var t0 = performance.now();
    N.update();
    times.push(Math.round((performance.now() - t0) * 100) / 100);
  }
  return times;
})()`);

console.log('30 帧耗时(ms):');
console.log('  ' + frames.join(', '));

const sorted = [...frames].sort((a, b) => a - b);
const min = sorted[0];
const max = sorted[sorted.length - 1];
const med = sorted[Math.floor(sorted.length / 2)];
const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
const slow = frames.filter(t => t > 30).length;

console.log();
console.log('统计:');
console.log('  最小: ' + min + ' ms  (' + Math.round(1000/min) + ' fps)');
console.log('  中位: ' + med + ' ms  (' + Math.round(1000/med) + ' fps)');
console.log('  平均: ' + Math.round(avg) + ' ms  (' + Math.round(1000/avg) + ' fps)');
console.log('  最大: ' + max + ' ms  (' + Math.round(1000/max) + ' fps)');
console.log('  慢帧(>30ms): ' + slow + '/30');

console.log();
if (slow > 0) {
  console.log('★ 有 ' + slow + ' 个慢帧，说明有不稳定的开销');
  console.log('  可能是：Bloom 的离屏画布重建、GC、或标签 measureText');
} else if (med < 17) {
  console.log('✓ 帧率稳定在 60fps 以上');
} else {
  console.log('🟡 帧率偏低但稳定');
}

// 额外：测量 Bloom 单独耗时
console.log();
console.log('════ Bloom 单独测量 ════');
const bloomTime = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  // 无法直接调 applyBloom（闭包内），用总耗时 - 简单场景估算
  // 这里测：只做一次完整 render 但跳过 Bloom 的对比不好做
  // 退而求其次：测 drawImage 成本
  var tmp4 = document.createElement('canvas');
  tmp4.width = Math.round(cv.width / 4);
  tmp4.height = Math.round(cv.height / 4);
  var c4 = tmp4.getContext('2d');

  var tmp8 = document.createElement('canvas');
  tmp8.width = Math.round(cv.width / 8);
  tmp8.height = Math.round(cv.height / 8);
  var c8 = tmp8.getContext('2d');

  var t0 = performance.now();
  for (var i = 0; i < 10; i++) {
    c4.clearRect(0, 0, tmp4.width, tmp4.height);
    c4.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, tmp4.width, tmp4.height);
    c8.clearRect(0, 0, tmp8.width, tmp8.height);
    c8.drawImage(tmp4, 0, 0, tmp4.width, tmp4.height, 0, 0, tmp8.width, tmp8.height);
  }
  var downsample = (performance.now() - t0) / 10;

  var ctx = cv.getContext('2d');
  var t1 = performance.now();
  for (var i = 0; i < 10; i++) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.34;
    ctx.drawImage(tmp4, 0, 0, tmp4.width, tmp4.height, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 0.16;
    ctx.drawImage(tmp8, 0, 0, tmp8.width, tmp8.height, 0, 0, cv.width, cv.height);
    ctx.restore();
  }
  var upscale = (performance.now() - t1) / 10;

  return {
    downsample: Math.round(downsample * 100) / 100,
    upscale: Math.round(upscale * 100) / 100,
    total: Math.round((downsample + upscale) * 100) / 100,
  };
})()`);

console.log('降采样: ' + bloomTime.downsample + ' ms');
console.log('放大叠加: ' + bloomTime.upscale + ' ms');
console.log('Bloom 总计: ' + bloomTime.total + ' ms');

cdp.close();
