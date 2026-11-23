import fs from 'node:fs';

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const events = { console: [], exception: [] };
  return {
    events,
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.method === 'Runtime.consoleAPICalled') {
            const args = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type));
            events.console.push(m.params.type + ': ' + args.join(' ').slice(0, 200));
          }
          if (m.method === 'Runtime.exceptionThrown') {
            const ex = m.params.exceptionDetails;
            events.exception.push((ex.exception?.description || ex.text || '').slice(0, 400));
          }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 20000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

// 开启事件监听
await cdp.send('Runtime.enable');
await cdp.send('Log.enable').catch(() => {});

console.log('═══ 复现交互崩溃 ═══');
console.log();

// ① 切到 command 场景
await cdp.eval(`(async function(){ try { await window.loadScenario('command'); } catch(e){ return 'loadErr:'+e.message; } return 'ok'; })()`);
await new Promise(r => setTimeout(r, 4000));

// ② 检查 canvas 是否有内容 + 事件监听器状态
const before = await cdp.eval(`(function(){
  var body = document.querySelector('.panel-body[data-kind="neuron"]');
  if (!body) return { error: 'no neuron panel' };
  var cv = body.querySelector('canvas');
  if (!cv) return { error: 'no canvas' };
  var rc = cv.getBoundingClientRect();

  // 采样画布像素，判断是否有内容
  var ctx = cv.getContext('2d');
  var data = ctx.getImageData(0, 0, Math.min(50, cv.width), Math.min(50, cv.height)).data;
  var nonZero = 0;
  for (var i = 0; i < data.length; i += 4) if (data[i] > 20 || data[i+1] > 20 || data[i+2] > 20) nonZero++;

  return {
    canvasW: cv.width, canvasH: cv.height,
    clientW: Math.round(rc.width), clientH: Math.round(rc.height),
    x: Math.round(rc.x), y: Math.round(rc.y),
    sampleNonZero: nonZero,
    hasNeuron2: !!window.__NEURON2,
    rendererType: typeof window.APP_RENDERERS.neuron,
  };
})()`);
console.log('① 交互前: ' + JSON.stringify(before));
console.log();

// ③ 模拟鼠标事件序列
const X = before.x + Math.round(before.clientW / 2);
const Y = before.y + Math.round(before.clientH / 2);
console.log('目标坐标: (' + X + ', ' + Y + ')');

async function mouse(type, x, y, extra) {
  await cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', clickCount: 1 }, extra || {}));
}

try {
  console.log('  → mouseMoved');
  await mouse('mouseMoved', X, Y);
  await new Promise(r => setTimeout(r, 300));

  console.log('  → mousePressed');
  await mouse('mousePressed', X, Y);
  await new Promise(r => setTimeout(r, 200));

  console.log('  → mouseReleased');
  await mouse('mouseReleased', X, Y);
  await new Promise(r => setTimeout(r, 500));

  console.log('  → 再点一次（验证选中/取消）');
  await mouse('mousePressed', X + 50, Y + 30);
  await mouse('mouseReleased', X + 50, Y + 30);
  await new Promise(r => setTimeout(r, 500));

  console.log('  → 滚轮缩放');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: X, y: Y, deltaX: 0, deltaY: -100 });
  await new Promise(r => setTimeout(r, 500));

} catch (e) {
  console.log('  模拟失败: ' + e.message);
}

// ④ 交互后检查
const after = await cdp.eval(`(function(){
  var body = document.querySelector('.panel-body[data-kind="neuron"]');
  if (!body) return { error: 'PANEL GONE' };
  var cv = body.querySelector('canvas');
  if (!cv) return { error: 'canvas gone' };
  var rc = cv.getBoundingClientRect();
  var ctx = cv.getContext('2d');
  var data = ctx.getImageData(0, 0, Math.min(50, cv.width), Math.min(50, cv.height)).data;
  var nonZero = 0;
  for (var i = 0; i < data.length; i += 4) if (data[i] > 20 || data[i+1] > 20 || data[i+2] > 20) nonZero++;
  return {
    canvasW: cv.width, canvasH: cv.height,
    clientW: Math.round(rc.width), clientH: Math.round(rc.height),
    sampleNonZero: nonZero,
    bodyChildren: body.children.length,
    panelStillThere: !!document.querySelector('.panel-body[data-kind="neuron"]'),
  };
})()`);

console.log();
console.log('② 交互后: ' + JSON.stringify(after));

console.log();
console.log('═══ 控制台错误 ═══');
if (cdp.events.exception.length) {
  for (const e of cdp.events.exception) console.log('  ✗ ' + e);
} else {
  console.log('  (无异常)');
}

console.log();
console.log('═══ 控制台输出（最近 15 条）═══');
for (const c of cdp.events.console.slice(-15)) console.log('  ' + c);

cdp.close();
