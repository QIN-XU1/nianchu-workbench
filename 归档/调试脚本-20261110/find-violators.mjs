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

// 1. 确认 enforce CSS 真的加载了
const css = await cdp.eval(`(function(){
  var sheets = [];
  for (var s of document.styleSheets) {
    try { sheets.push(s.href ? s.href.split('/').pop() : '(inline)'); } catch(e) { sheets.push('?'); }
  }
  return sheets;
})()`);
console.log('已加载的样式表:', JSON.stringify(css));

// 2. 检查 enforce 规则是否存在
const ruleCheck = await cdp.eval(`(function(){
  var found = { textPrimaryRule: false, fontWeightRule: false, totalRules: 0 };
  for (var s of document.styleSheets) {
    try {
      var href = s.href || '';
      if (!href.includes('enforce')) continue;
      var rules = s.cssRules || s.rules;
      found.totalRules = rules.length;
      for (var r of rules) {
        if (r.selectorText && r.selectorText.includes('.panel-body')) found.textPrimaryRule = true;
        if (r.cssText && r.cssText.includes('font-weight')) found.fontWeightRule = true;
      }
    } catch(e) { found.error = String(e); }
  }
  return found;
})()`);
console.log('enforce 样式表规则:', JSON.stringify(ruleCheck));

// 3. 找那些"不合规"的元素，看它们是什么
const bad = await cdp.eval(`(function(){
  var out = { colors: {}, weights: {}, sizes: {} };
  var all = document.querySelectorAll('body[data-tui-mode="on"] *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!el.tagName || el.tagName === 'WEBVIEW' || el.tagName === 'SCRIPT') continue;
    var txt = (el.textContent || '').trim();
    if (!txt || el.children.length > 0) continue;
    var cs = getComputedStyle(el);
    var c = cs.color;
    if (!out.colors[c]) out.colors[c] = { count: 0, sample: [] };
    out.colors[c].count++;
    if (out.colors[c].sample.length < 3) {
      out.colors[c].sample.push({ tag: el.tagName, cls: String(el.className).slice(0, 30), text: txt.slice(0, 20) });
    }
    var w = cs.fontWeight;
    if (!out.weights[w]) out.weights[w] = { count: 0, sample: [] };
    out.weights[w].count++;
    if (out.weights[w].sample.length < 2) {
      out.weights[w].sample.push({ tag: el.tagName, cls: String(el.className).slice(0, 30), text: txt.slice(0, 20) });
    }
  }
  return out;
})()`);

console.log();
console.log('=== 文字色分布（谁在违反规则）===');
for (const [color, info] of Object.entries(bad.colors)) {
  console.log(`  ${color}  × ${info.count}`);
  for (const s of info.sample) console.log(`      ${s.tag} .${s.cls}  "${s.text}"`);
}

console.log();
console.log('=== 字重分布 ===');
for (const [w, info] of Object.entries(bad.weights)) {
  console.log(`  ${w}  × ${info.count}`);
  for (const s of info.sample) console.log(`      ${s.tag} .${s.cls}  "${s.text}"`);
}

cdp.close();
