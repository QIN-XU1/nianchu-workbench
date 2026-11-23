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
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 界面缺陷诊断（对照 edex-ui 的设计规范）═══');
console.log();

const diag = await cdp.eval(`(function(){
  var out = {};

  // ① 密度：内容占屏幕的比例
  var body = document.body;
  var totalH = window.innerHeight;
  var usedH = 0;
  // 三栏：statusbar + titlebar + scenebar + content + hintbar
  var parts = {};
  ['tui-statusbar','titlebar','scenebar','scenario-view','tui-hintbar'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) parts[id] = Math.round(el.getBoundingClientRect().height);
  });
  out.verticalLayout = parts;
  out.screenH = totalH;

  var headH = (parts['tui-statusbar']||0) + (parts['titlebar']||0) + (parts['scenebar']||0) + (parts['tui-hintbar']||0);
  out.chromeRatio = Math.round(headH / totalH * 100);
  out.contentRatio = Math.round((parts['scenario-view']||0) / totalH * 100);

  // ② 三层头部（重复）
  out.headerCount = ['tui-statusbar','titlebar','scenebar'].filter(function(id){
    return document.getElementById(id) && document.getElementById(id).getBoundingClientRect().height > 10;
  }).length;

  // ③ 字号与行高
  var sample = document.querySelector('.tui-line') || document.querySelector('.panel-body *');
  if (sample) {
    var cs = getComputedStyle(sample);
    out.typography = { fontSize: cs.fontSize, lineHeight: cs.lineHeight, fontFamily: cs.fontFamily.split(',')[0] };
  }

  // ④ 背景色层次
  var colors = {};
  [document.body, document.getElementById('grid'), document.querySelector('.panel'), document.querySelector('.panel-head'), document.querySelector('.panel-body')].forEach(function(el, i){
    if (!el) return;
    var c = getComputedStyle(el);
    colors['layer' + i] = { bg: c.backgroundColor, color: c.color };
  });
  out.colors = colors;

  // ⑤ 信息密度：每屏可见行数
  var lines = document.querySelectorAll('.tui-line');
  out.visibleLines = lines.length;

  // ⑥ 动词：有没有可点击的操作
  out.buttonCount = document.querySelectorAll('button').length;

  // ⑦ 字符画/装饰
  out.hasAsciiArt = !!document.querySelector('.tui-empty-art');
  out.hasCursor = false;
  out.hasContextBar = false;

  return out;
})()`);

console.log('【① 纵向布局】');
console.log('  屏幕高: ' + diag.screenH + 'px');
for (const [k, v] of Object.entries(diag.verticalLayout)) {
  console.log('    ' + k.padEnd(18) + v + 'px');
}
console.log('  框架占比: ' + diag.chromeRatio + '%  (edex-ui 通常 <15%)');
console.log('  内容占比: ' + diag.contentRatio + '%');
console.log();

console.log('【② 头部层数】' + diag.headerCount + ' 层');
if (diag.headerCount > 1) {
  console.log('  ⚠ 多重头部浪费垂直空间，edex-ui 通常只有 1 层');
}
console.log();

console.log('【③ 字体】');
console.log('  ' + JSON.stringify(diag.typography));
console.log();

console.log('【④ 背景层次】');
for (const [k, v] of Object.entries(diag.colors)) {
  console.log('  ' + k.padEnd(8) + ' bg=' + v.bg);
}
console.log();

console.log('【⑤ 信息密度】');
console.log('  可见 TUI 行: ' + diag.visibleLines);
console.log('  按钮数: ' + diag.buttonCount);
console.log('  字符画: ' + diag.hasAsciiArt);
console.log();

console.log('═══ 诊断结论 ═══');
const issues = [];
if (diag.headerCount > 1) issues.push('P0 头部重复 ' + diag.headerCount + ' 层，浪费 ' + diag.chromeRatio + '% 垂直空间');
if (diag.chromeRatio > 20) issues.push('P1 框架占比 ' + diag.chromeRatio + '% 过高');
if (diag.visibleLines < 10) issues.push('P2 信息密度低（可见行 ' + diag.visibleLines + '）');
if (!diag.hasAsciiArt) issues.push('P2 无字符画装饰（终端美学的标志）');
for (const i of issues) console.log('  ' + i);

cdp.close();
