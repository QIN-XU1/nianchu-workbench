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
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

// 给每个按钮挂一个探针，记录 click 是否被处理
console.log('═══ 逐按钮触发测试 ═══');
console.log();

const probe = await cdp.eval(`(function(){
  // 记录 modal 出现情况
  var before = document.querySelectorAll('.modal, .modal-mask, [class*="modal"]').length;
  return { modalBefore: before };
})()`);
console.log('  触发前 modal 数: ' + probe.modalBefore);
console.log();

const BID = ['btn-refresh', 'btn-plugins', 'btn-skills', 'btn-mcp', 'btn-tools'];

for (const bid of BID) {
  console.log('--- ' + bid + ' ---');
  try {
    const r = await cdp.eval(`(function(){
      var b = document.getElementById('${bid}');
      if (!b) return { error: 'not found' };
      var modalBefore = document.querySelectorAll('.modal, .modal-mask').length;
      b.click();
      return { clicked: true, modalBefore: modalBefore };
    })()`);
    if (r.error) { console.log('  ' + r.error); continue; }

    await new Promise(x => setTimeout(x, 1200));

    const after = await cdp.eval(`(function(){
      var modals = [].slice.call(document.querySelectorAll('.modal, .modal-mask'));
      var visible = modals.filter(function(m){
        var r = m.getBoundingClientRect();
        return r.width > 100 && r.height > 100;
      });
      var texts = visible.map(function(m){
        return (m.innerText || '').trim().slice(0, 80).replace(/\\n/g, ' | ');
      });
      return {
        modalCount: modals.length,
        visibleCount: visible.length,
        firstText: texts[0] || '(无)',
        bodyTextChange: (document.body.innerText || '').length,
      };
    })()`);
    console.log('  modal: ' + after.modalCount + '（可见 ' + after.visibleCount + '）');
    if (after.firstText !== '(无)') console.log('  内容: "' + after.firstText + '"');

    // 关掉
    await cdp.eval(`(function(){
      var closeBtn = document.querySelector('.modal-close, [class*="modal"] button[class*="close"], [aria-label*="关闭"]');
      if (closeBtn) { closeBtn.click(); return 'closed'; }
      // 退而按 Esc
      return 'no close btn';
    })()`);
    await new Promise(x => setTimeout(x, 800));
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); true`);
    await new Promise(x => setTimeout(x, 800));

  } catch (e) {
    console.log('  ERR: ' + e.message.slice(0, 60));
  }
}

console.log();
console.log('═══ 结果 ═══');
const final = await cdp.eval(`(function(){
  return { modals: document.querySelectorAll('.modal').length };
})()`);
console.log('  剩余 modal: ' + final.modals);

cdp.close();
