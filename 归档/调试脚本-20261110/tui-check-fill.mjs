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

// 专门查「面板高 vs 内容高」的差
const diag = await cdp.eval(`(function(){
  var out = { currentScene: null, panels: [] };
  // 找当前激活的场景标签
  var tabs = document.querySelectorAll('.tab, .scene-tab, [class*="scene-tab"]');
  for (var t of tabs) {
    if (t.classList.contains('active') || t.classList.contains('on')) {
      out.currentScene = t.textContent.trim().slice(0, 20);
      break;
    }
  }
  document.querySelectorAll('.panel').forEach(function(p){
    var body = p.querySelector('.panel-body');
    var pr = p.getBoundingClientRect();
    var br = body ? body.getBoundingClientRect() : { height: 0 };
    // 内容真实高度（把所有子元素的 scrollHeight 加起来）
    var contentH = 0;
    if (body) {
      for (var ch of body.children) {
        contentH += ch.getBoundingClientRect().height;
      }
    }
    out.panels.push({
      id: p.dataset.panelId,
      kind: (body || {}).dataset ? body.dataset.kind : '',
      panelH: Math.round(pr.height),
      bodyH: Math.round(br.height),
      contentH: Math.round(contentH),
      waste: Math.round(br.height - contentH),
      fillRatio: pr.height > 0 ? Math.round(contentH / pr.height * 100) : 0,
    });
  });
  // grid 信息
  var g = document.getElementById('grid');
  if (g) {
    var gcs = getComputedStyle(g);
    out.grid = {
      rows: gcs.gridTemplateRows,
      height: Math.round(g.getBoundingClientRect().height),
      autoRows: gcs.gridAutoRows,
    };
  }
  return out;
})()`);

console.log('当前场景:', diag.currentScene);
console.log('grid rows:', diag.grid ? diag.grid.rows : '?');
console.log('grid 高:', diag.grid ? diag.grid.height + 'px' : '?');
console.log();
console.log('面板填充率：');
for (const p of diag.panels) {
  const flag = p.fillRatio < 40 ? '  <- 大量留白' : (p.fillRatio < 70 ? '  <- 有留白' : '');
  console.log(`  ${String(p.id).padEnd(14)} kind=${String(p.kind).padEnd(12)} 面板 ${String(p.panelH).padStart(4)}px  body ${String(p.bodyH).padStart(4)}px  内容 ${String(p.contentH).padStart(4)}px  填充 ${String(p.fillRatio).padStart(3)}%${flag}`);
}

cdp.close();
