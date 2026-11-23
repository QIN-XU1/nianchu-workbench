const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('连接失败')); });
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

console.log('═══ 11 个场景的会话绑定情况 ═══');
console.log();

const result = await cdp.eval(`(async function(){
  var out = [];
  var scenes = window.__WB.state.get('scenes') || [];
  for (var i = 0; i < scenes.length; i++) {
    var s = scenes[i];
    var r = await window.__WB.api.util.scene(s.id);
    if (!r.ok) { out.push({ id: s.id, name: s.name, error: 1 }); continue; }
    var panels = (r.scene && r.scene.panels) || [];
    var harnessList = panels.filter(function(p){ return p.type === 'harness' || p.type === 'embed'; });
    out.push({
      id: s.id,
      name: s.name,
      panels: panels.length,
      harness: harnessList.length,
      bindings: harnessList.map(function(p){
        return {
          type: p.type,
          sid: p.sessionId || p.session || '',
          title: p.title || '',
          keys: Object.keys(p).join(','),
        };
      }),
    });
  }
  return out;
})()`);

for (const r of result) {
  const bindStr = r.bindings ? r.bindings.map(b => b.type + ':' + (b.sid || '(空)')).join(' | ') : 'ERR';
  console.log('  ' + String(r.id).padEnd(16) + String(r.name).padEnd(10) + r.panels + ' 面板  ' + bindStr);
}

console.log();
const missing = result.filter(r => r.bindings && r.bindings.some(b => !b.sid) && (r.harness > 0));
console.log('缺少 sessionId 的场景: ' + (missing.length ? missing.map(m => m.id).join(', ') : '无'));

console.log();
console.log('═══ 第一个场景完整 panel 结构 ═══');
const detail = await cdp.eval(`(async function(){
  var r = await window.__WB.api.util.scene('bilibili');
  if (!r.ok) return {error:1};
  return r.scene.panels;
})()`);
console.log(JSON.stringify(detail, null, 2).slice(0, 900));

cdp.close();
