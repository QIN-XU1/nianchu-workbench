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
            errs.push((d.exception?.description || d.text || '').slice(0, 500));
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
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 500) };
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

console.log('═══ 诊断"未知面板类型" ═══');
console.log();

// ① registry 里到底注册了什么
const reg = await cdp.eval(`(function(){
  var R = window.__WB && window.__WB.registry;
  if (!R) return { error: 'no registry' };
  return {
    types: R.types ? R.types() : [],
    hasNeuron: R.has ? R.has('neuron') : '?',
    hasHarness: R.has ? R.has('harness') : '?',
  };
})()`);
console.log('① registry: ' + JSON.stringify(reg));

// ② 面板 DOM 实际状态
const dom = await cdp.eval(`(function(){
  var out = [];
  document.querySelectorAll('.wb-panel').forEach(function(p){
    out.push({
      type: p.dataset.panelType,
      childCount: p.children.length,
      firstChildTag: p.children[0] ? p.children[0].tagName : '',
      firstChildCls: p.children[0] ? String(p.children[0].className).slice(0,40) : '',
      text: (p.textContent || '').trim().slice(0, 60),
      hasDegrade: !!p.querySelector('.wb-panel-degrade'),
    });
  });
  return out;
})()`);
console.log();
console.log('② 面板 DOM:');
for (const d of dom) console.log('   ' + JSON.stringify(d));

// ③ 手动调用 registry.render 看错误
console.log();
console.log('③ 手动测试渲染:');
const test = await cdp.eval(`(async function(){
  try {
    var R = window.__WB.registry;
    if (!R) return { error: 'no registry' };
    var host = document.createElement('div');
    host.style.cssText = 'width:400px;height:300px;';
    document.body.appendChild(host);
    var inst = await R.render({ type: 'neuron', title: 'test' }, {
      state: window.__WB.state, bus: window.__WB.bus, api: window.__WB.api,
    });
    var r = {
      ok: true,
      elChildren: inst.el.children.length,
      text: (inst.el.textContent||'').trim().slice(0,80),
      hasCanvas: !!inst.el.querySelector('canvas'),
    };
    document.body.removeChild(host);
    return r;
  } catch(e) { return { error: e.message, stack: (e.stack||'').slice(0,300) }; }
})()`);
console.log('   ' + JSON.stringify(test, null, 2));

// ④ 看 index.js 注册时的实际情况
console.log();
console.log('④ 场景 panel 定义:');
const panels = await cdp.eval(`(async function(){
  try {
    var r = await window.__WB.api.util.scene('command');
    if (!r.ok) return { error: 'scene load failed' };
    return (r.scene.panels || []).map(function(p){
      return { type: p.type, title: p.title, w: p.w, hasSession: !!(p.sessionId || p.session) };
    });
  } catch(e) { return { error: e.message }; }
})()`);
console.log('   ' + JSON.stringify(panels, null, 2));

console.log();
console.log('═══ JS 错误 ═══');
const uniq = [...new Set(cdp.errs)];
if (uniq.length) for (const e of uniq.slice(0, 5)) console.log('  ✗ ' + e.replace(/\n/g, ' | ').slice(0, 200));
else console.log('  (无)');

cdp.close();
