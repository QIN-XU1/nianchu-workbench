import fs from 'node:fs';

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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 20000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

// 深挖：哪些元素还没被终端化
const audit = await cdp.eval(`(function(){
  var out = { rounded: [], shadowed: [], fonts: [], neon: [] };
  var all = document.querySelectorAll('*');
  var seen = {};
  for (var i = 0; i < all.length && i < 3000; i++) {
    var el = all[i];
    if (!el.tagName || el.tagName === 'WEBVIEW') continue;
    var cs = getComputedStyle(el);
    var r = cs.borderTopLeftRadius;
    if (r && r !== '0px' && parseFloat(r) > 2) {
      var key = 'radius:' + r + ':' + (el.className || el.tagName);
      if (!seen[key]) { seen[key] = 1; out.rounded.push({ tag: el.tagName, cls: String(el.className).slice(0,34), radius: r }); }
    }
    var sh = cs.boxShadow;
    if (sh && sh !== 'none') {
      var key2 = 'shadow:' + (el.className || el.tagName);
      if (!seen[key2]) { seen[key2] = 1; out.shadowed.push({ tag: el.tagName, cls: String(el.className).slice(0,34), shadow: sh.slice(0, 50) }); }
    }
  }
  // 字体族统计
  var fams = {};
  for (var j = 0; j < Math.min(all.length, 500); j++) {
    var f = getComputedStyle(all[j]).fontFamily;
    fams[f] = (fams[f] || 0) + 1;
  }
  out.fonts = Object.entries(fams).sort(function(a,b){return b[1]-a[1];}).slice(0, 5).map(function(e){ return { family: e[0].slice(0,44), count: e[1] }; });
  return out;
})()`);

console.log('=== 未终端化的元素 ===');
console.log('\n【圆角未归零】' + audit.rounded.length + ' 类');
for (const r of audit.rounded.slice(0, 12)) console.log(`  ${r.tag.padEnd(8)} ${r.cls.padEnd(36)} radius=${r.radius}`);

console.log('\n【仍有阴影】' + audit.shadowed.length + ' 类');
for (const s of audit.shadowed.slice(0, 12)) console.log(`  ${s.tag.padEnd(8)} ${s.cls.padEnd(36)} ${s.shadow}`);

console.log('\n【字体族分布】');
for (const f of audit.fonts) console.log(`  ${String(f.count).padStart(3)} 个  ${f.family}`);

cdp.close();
