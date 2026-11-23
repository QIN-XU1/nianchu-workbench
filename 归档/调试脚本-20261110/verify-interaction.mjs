const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const errs = [];
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.method === 'Runtime.exceptionThrown') {
            errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
          }
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            errs.push('console.error: ' + (m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 200));
          }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    errs,
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 20000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 300) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

// 测量画布内容的辅助函数
async function measure(label) {
  const m = await cdp.eval(`(function(){
    var body = document.querySelector('.panel-body[data-kind="neuron"]');
    if (!body) return { gone: true };
    var cv = body.querySelector('canvas');
    if (!cv) return { noCanvas: true };
    var ctx = cv.getContext('2d');
    var d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    var nb = 0;
    for (var i = 0; i < d.length; i += 4 * 300) {
      if (d[i] > 25 || d[i+1] > 25 || d[i+2] > 25) nb++;
    }
    var S = window.__NEURON_STATE || {};
    return {
      nonBlack: nb,
      visNodes: (S.visNodes||[]).length,
      allNodes: (S.allNodes||[]).length,
      zoom: S.zoom,
      panX: Math.round(S.panX||0),
      sel: S.sel ? S.sel.label : null,
      hover: S.hover ? S.hover.label : null,
    };
  })()`);
  console.log('  [' + label + '] ' + JSON.stringify(m));
  return m;
}

console.log('═══ 交互不崩溃验证 ═══');
console.log();

// 切到 command
await cdp.eval(`(async function(){ try { await window.loadScenario('command'); return 1; } catch(e){ return 0; } })()`);
await new Promise(r => setTimeout(r, 4000));

const base = await cdp.eval(`(function(){
  var cv = document.querySelector('.panel-body[data-kind="neuron"] canvas');
  if (!cv) return null;
  var rc = cv.getBoundingClientRect();
  return { x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height) };
})()`);

if (!base) { console.log('找不到画布'); process.exit(1); }
console.log('画布: ' + JSON.stringify(base));
console.log();

await measure('初始');

const CX = base.x + Math.round(base.w / 2);
const CY = base.y + Math.round(base.h / 2);

async function ev(type, x, y, extra) {
  await cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', clickCount: 1 }, extra || {}));
}

console.log();
console.log('① 悬停');
await ev('mouseMoved', CX, CY);
await new Promise(r => setTimeout(r, 400));
await measure('悬停后');

console.log();
console.log('② 点击（选中节点）');
await ev('mousePressed', CX, CY);
await ev('mouseReleased', CX, CY);
await new Promise(r => setTimeout(r, 500));
await measure('点击后');

console.log();
console.log('③ 拖动');
await ev('mousePressed', CX, CY);
for (let i = 1; i <= 4; i++) {
  await ev('mouseMoved', CX + i * 20, CY + i * 15);
  await new Promise(r => setTimeout(r, 60));
}
await ev('mouseReleased', CX + 80, CY + 60);
await new Promise(r => setTimeout(r, 500));
await measure('拖动后');

console.log();
console.log('④ 滚轮缩放');
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: CX, y: CY, deltaX: 0, deltaY: -120 });
await new Promise(r => setTimeout(r, 400));
await measure('缩放后');

console.log();
console.log('⑤ 点空白处平移');
await ev('mousePressed', base.x + 30, base.y + 30);
for (let i = 1; i <= 3; i++) {
  await ev('mouseMoved', base.x + 30 + i * 30, base.y + 30 + i * 20);
  await new Promise(r => setTimeout(r, 60));
}
await ev('mouseReleased', base.x + 120, base.y + 90);
await new Promise(r => setTimeout(r, 500));
await measure('平移后');

console.log();
console.log('═══ JS 错误 ═══');
if (cdp.errs.length) {
  const uniq = [...new Set(cdp.errs)];
  for (const e of uniq.slice(0, 8)) console.log('  ✗ ' + e);
} else {
  console.log('  (无)');
}

cdp.close();
