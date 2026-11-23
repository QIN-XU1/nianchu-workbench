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
const eng = targets.filter(t => t.type === 'webview' && t.url.includes('3080') && t.title.includes('命令'));

const cdp = CDP(eng[0].webSocketDebuggerUrl);
await cdp.connect();

console.log('=== 排查是哪条 CSS 规则把 grid 设成两列 ===');
const rules = await cdp.eval(`(function(){
  var frame = document.querySelector('[class*="frame"]');
  if (!frame) return { error: 'no frame' };

  var out = { inline: frame.style.gridTemplateColumns || '(空)', matched: [] };

  // 遍历所有 CSS 规则，找匹配 frame 且设置 grid-template-columns 的
  for (var s of document.styleSheets) {
    var rules;
    try { rules = s.cssRules || s.rules; } catch(e) { continue; }
    if (!rules) continue;
    for (var r of rules) {
      if (!r.selectorText) continue;
      var hasGrid = /grid-template-columns|gridTemplateColumns/.test(r.cssText || '');
      if (!hasGrid) continue;
      // 这个规则是否匹配 frame？
      try {
        if (frame.matches(r.selectorText)) {
          out.matched.push({
            selector: r.selectorText.slice(0, 80),
            css: r.cssText.slice(0, 120),
            href: s.href ? s.href.split('/').pop() : 'inline',
          });
        }
      } catch(e2) { /* 复杂选择器跳过 */ }
    }
  }

  // 也检查父级 grid
  out.parentChain = [];
  var cur = frame.parentElement;
  for (var d = 0; d < 3 && cur; d++) {
    var cs = getComputedStyle(cur);
    out.parentChain.push({ cls: String(cur.className).slice(0, 30), display: cs.display, tpl: cs.gridTemplateColumns });
    cur = cur.parentElement;
  }

  return out;
})()`);

console.log('  frame 内联样式: ' + rules.inline);
console.log('  匹配的 CSS 规则 (' + (rules.matched || []).length + ' 条):');
for (const r of (rules.matched || [])) {
  console.log('    [' + r.href + '] ' + r.selector);
  console.log('      ' + r.css);
}
console.log();
console.log('  父级链:');
for (const p of (rules.parentChain || [])) {
  console.log('    .' + p.cls + '  display=' + p.display + '  tpl=' + p.tpl);
}

cdp.close();
