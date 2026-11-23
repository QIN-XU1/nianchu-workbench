import { fixEngineLayout, DIAG_SCRIPT } from './engine-layout-fix.mjs';

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 25000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const eng = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));

console.log('═══ 修复引擎页面布局 ═══');
console.log();

for (const t of eng) {
  const cdp = CDP(t.webSocketDebuggerUrl);
  try {
    await cdp.connect();

    const before = await cdp.eval(DIAG_SCRIPT);
    console.log('--- ' + (t.title || '').slice(0, 35) + ' ---');
    console.log('  修复前: ' + JSON.stringify(before));

    if (before.centerW < 300) {
      const fix = await cdp.eval(fixEngineLayout());
      console.log('  执行: ' + JSON.stringify(fix.actions));
      await new Promise(r => setTimeout(r, 800));
      const after = await cdp.eval(DIAG_SCRIPT);
      console.log('  修复后: ' + JSON.stringify(after));
      if (after.centerW >= 300) console.log('  ✅ 已修复');
      else console.log('  ⚠ 仍窄（' + after.centerW + 'px）');
    } else {
      console.log('  ✅ 本来就正常');
    }
  } catch (e) {
    console.log('  ERR: ' + e.message.slice(0, 60));
  } finally {
    cdp.close();
  }
  console.log();
}
