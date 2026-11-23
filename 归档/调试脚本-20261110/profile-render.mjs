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
console.log('  渲染性能剖析：78ms/帧 来自哪里');
console.log('═══════════════════════════════════════════════════════════');
console.log();

// 在页面里测量各阶段耗时
const profile = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var S = N.state;
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  var ctx = cv.getContext('2d');

  var timings = {};

  // 整体 render 耗时（多次采样）
  var renderTimes = [];
  for (var k = 0; k < 5; k++) {
    var t0 = performance.now();
    N.update();
    renderTimes.push(performance.now() - t0);
  }
  timings.render = renderTimes.map(function(t){ return Math.round(t * 10) / 10; });

  // 分项测量
  // ① 全画布填充
  var t1 = performance.now();
  for (var i = 0; i < 5; i++) {
    var g = ctx.createRadialGradient(cv.width/2, cv.height/2, 0, cv.width/2, cv.height/2, cv.width * 0.6);
    g.addColorStop(0, '#01030A');
    g.addColorStop(1, '#000003');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
  }
  timings.bgFill = Math.round((performance.now() - t1) / 5 * 10) / 10;

  // ② getImageData（Bloom 里会用）
  var t2 = performance.now();
  try {
    var imgData = ctx.getImageData(0, 0, cv.width, cv.height);
    timings.getImageData = Math.round(performance.now() - t2);
  } catch(e) {
    timings.getImageData = 'ERR: ' + e.message;
  }

  // ③ drawImage 降采样
  var tmp = document.createElement('canvas');
  tmp.width = Math.round(cv.width / 4);
  tmp.height = Math.round(cv.height / 4);
  var tctx = tmp.getContext('2d');
  var t3 = performance.now();
  for (var i = 0; i < 5; i++) {
    tctx.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, tmp.width, tmp.height);
  }
  timings.downsample = Math.round((performance.now() - t3) / 5 * 10) / 10;

  // ④ 星点数量
  timings.starCount = S.stars ? S.stars.length : 0;
  timings.sceneCount = S.scenes ? S.scenes.length : 0;
  timings.labelCount = S.labelRects ? S.labelRects.length : 0;

  // ⑤ 画布物理尺寸
  timings.canvasPhysical = cv.width + '×' + cv.height;
  timings.canvasCss = cv.clientWidth + '×' + cv.clientHeight;
  timings.dpr = window.devicePixelRatio;

  return timings;
})()`);

console.log('渲染耗时采样: ' + JSON.stringify(profile.render) + ' ms');
console.log();
console.log('分项耗时:');
console.log('  背景填充:     ' + profile.bgFill + ' ms');
console.log('  getImageData: ' + profile.getImageData + ' ms');
console.log('  降采样绘制:   ' + profile.downsample + ' ms');
console.log();
console.log('数据量:');
console.log('  星点:   ' + profile.starCount);
console.log('  场景:   ' + profile.sceneCount);
console.log('  标签:   ' + profile.labelCount);
console.log();
console.log('画布:');
console.log('  物理: ' + profile.canvasPhysical);
console.log('  CSS:  ' + profile.canvasCss);
console.log('  DPR:  ' + profile.dpr);

console.log();
console.log('════ 分析 ════');
const avgRender = profile.render.reduce((a, b) => a + b, 0) / profile.render.length;
console.log('平均渲染: ' + Math.round(avgRender) + ' ms  (' + Math.round(1000 / avgRender) + ' fps)');

if (typeof profile.getImageData === 'number' && profile.getImageData > 10) {
  console.log();
  console.log('★ getImageData 耗时 ' + profile.getImageData + ' ms — 这是性能瓶颈！');
  console.log('  Bloom 里如果有 getImageData 会极慢（同步读回 GPU 数据）');
}

// 检查 Bloom 是否用 getImageData
const bloomCheck = await cdp.eval(`(function(){
  var N = window.__NEURON3D[0];
  var src = N.__src || '';
  return {
    hasSeparateCanvas: typeof N === 'object',
    note: '需要检查 applyBloom 是否用 getImageData',
  };
})()`);
console.log();
console.log('Bloom 检查: ' + JSON.stringify(bloomCheck));

cdp.close();
