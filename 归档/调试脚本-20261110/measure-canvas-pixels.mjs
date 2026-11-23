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

console.log('═══════════════════════════════════════════════════════════════');
console.log('  画布像素占比实测 —— "交互感差"的真正原因');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

const m = await cdp.eval(`(function(){
  var cv = document.querySelector('[data-panel-type="neuron"] canvas');
  if (!cv) return { error: 'no canvas' };
  var ctx = cv.getContext('2d');
  var W = cv.width, H = cv.height;
  var d = ctx.getImageData(0, 0, W, H).data;

  var total = W * H;
  var levels = {
    black: 0,      // < 10  纯黑
    veryDark: 0,   // 10~30
    dark: 0,       // 30~60
    mid: 0,        // 60~120
    bright: 0,     // 120~200
    veryBright: 0, // > 200
  };

  var maxLevel = 0;
  for (var i = 0; i < d.length; i += 4) {
    var lum = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
    if (lum > maxLevel) maxLevel = lum;
    if (lum < 10) levels.black++;
    else if (lum < 30) levels.veryDark++;
    else if (lum < 60) levels.dark++;
    else if (lum < 120) levels.mid++;
    else if (lum < 200) levels.bright++;
    else levels.veryBright++;
  }

  function pct(n) { return Math.round(n / total * 1000) / 10; }

  return {
    W: W, H: H,
    total: total,
    maxLum: Math.round(maxLevel),
    pct: {
      black: pct(levels.black),
      veryDark: pct(levels.veryDark),
      dark: pct(levels.dark),
      mid: pct(levels.mid),
      bright: pct(levels.bright),
      veryBright: pct(levels.veryBright),
    },
    // 有效像素（亮度 > 30）= 用户能看见的东西
    visiblePct: pct(total - levels.black - levels.veryDark),
  };
})()`);

console.log('  画布: ' + m.W + '×' + m.H + '（' + m.total + ' 像素）');
console.log('  最大亮度: ' + m.maxLum + ' / 255');
console.log();
console.log('  亮度分布:');
console.log('    纯黑 (<10)       ' + m.pct.black + '%');
console.log('    极暗 (10-30)     ' + m.pct.veryDark + '%');
console.log('    暗   (30-60)     ' + m.pct.dark + '%');
console.log('    中   (60-120)    ' + m.pct.mid + '%');
console.log('    亮   (120-200)   ' + m.pct.bright + '%');
console.log('    很亮 (>200)      ' + m.pct.veryBright + '%');
console.log();
console.log('  ★ 有效可见像素: ' + m.visiblePct + '%');

console.log();
console.log('═══════════════════════════════════════════════════════════════');
console.log('  结论');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

if (m.visiblePct < 5) {
  console.log('  🔴 严重：只有 ' + m.visiblePct + '% 的像素可见');
  console.log('     用户在 1223×789 的画布上，只能看到零星几个光点。');
  console.log('     这就是"交互感差"的根本原因 —— 不是交互逻辑问题，是质量问题。');
} else if (m.visiblePct < 15) {
  console.log('  🟡 偏暗：' + m.visiblePct + '% 可见，画面太空');
} else {
  console.log('  ✓ 正常：' + m.visiblePct + '% 可见');
}

cdp.close();
