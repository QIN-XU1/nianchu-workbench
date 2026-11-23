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
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.log('无主页面'); process.exit(1); }
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const problems = [];
const info = {};

console.log('═══ 审查轮 2：运行时真实状态 ═══');
console.log();

// 1. 逐个场景切换，验证 AI 面板能连上
console.log('【1】逐场景切换 + AI 面板验证');
const scenes = ['command', 'research', 'competitor-analyze', 'reverse-eng', 'arch-review', 'build-plan', 'pipeline', 'relationship', 'self-review', 'bilibili', 'pc-cleanup'];

for (const sid of scenes) {
  await cdp.eval(`(async function(){ try { await window.loadScenario('${sid}'); } catch(e){} })()`);
  await new Promise(r => setTimeout(r, 2500));

  const st = await cdp.eval(`(function(){
    var p = [].slice.call(document.querySelectorAll('.panel')).find(function(x){
      return (x.querySelector('.panel-body')||{}).dataset?.kind === 'harness';
    });
    if (!p) return { noPanel: true };
    var body = p.querySelector('.panel-body');
    var wv = body.querySelector('webview');
    var pin = body.querySelector('[class*="pin"], [title*="钉"]');
    return {
      hasWv: !!wv,
      src: wv ? (wv.getAttribute('src')||'').slice(0, 50) : '',
      text: (body.innerText || '').slice(0, 60),
    };
  })()`);

  const ok = st.hasWv && st.src.includes('3080');
  if (!ok) problems.push({ scene: sid, issue: 'AI 面板异常', detail: st });
  console.log(`  ${ok ? '✓' : '✗'} ${sid.padEnd(20)} ${st.hasWv ? st.src : '无 webview'}${st.noPanel ? ' [无 AI 面板]' : ''}`);
}

console.log();

// 2. 检查 webview 数量与内存
console.log('【2】webview 与资源');
const res = await cdp.eval(`(function(){
  var wvs = [].slice.call(document.querySelectorAll('webview'));
  var mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null;
  return {
    wvCount: wvs.length,
    wvs: wvs.map(function(w){
      var r = w.getBoundingClientRect();
      return { src: (w.getAttribute('src')||'').slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) };
    }),
    dom: document.querySelectorAll('*').length,
    heapMB: mem,
  };
})()`);
console.log(`  webview: ${res.wvCount}  DOM: ${res.dom}  JS堆: ${res.heapMB}MB`);
for (const w of res.wvs) {
  console.log(`    ${String(w.w).padStart(4)}x${String(w.h).padEnd(5)} ${w.src}`);
}
const zeroWv = res.wvs.filter(w => w.w === 0 || w.h === 0).length;
if (zeroWv > 0) console.log(`  ${zeroWv} 个 webview 尺寸为 0`);

console.log();

// 3. 检查侧边栏栏状态
console.log('【3】顶栏状态');
const bar = await cdp.eval(`(function(){
  var s = document.getElementById('tui-statusbar');
  var h = document.getElementById('tui-hintbar');
  return {
    statusText: s ? s.textContent.trim() : '(无)',
    hintText: h ? h.textContent.trim() : '(无)',
    theme: document.body.dataset.tuiTheme,
    faultCount: window.__faultList ? window.__faultList().length : 0,
  };
})()`);
console.log(`  状态栏: ${bar.statusText}`);
console.log(`  提示栏: ${bar.hintText.slice(0, 80)}`);
console.log(`  主题  : ${bar.theme}`);
console.log(`  故障  : ${bar.faultCount}`);

console.log();

// 4. 检查面板填充率
console.log('【4】面板填充率');
const fill = await cdp.eval(`(function(){
  return [].slice.call(document.querySelectorAll('.panel')).map(function(p){
    var body = p.querySelector('.panel-body');
    var pr = p.getBoundingClientRect();
    var contentH = 0;
    if (body) for (var ch of body.children) contentH += ch.getBoundingClientRect().height;
    return {
      id: p.dataset.panelId,
      kind: body ? body.dataset.kind : '',
      panelH: Math.round(pr.height),
      contentH: Math.round(contentH),
      ratio: pr.height > 0 ? Math.round(contentH / pr.height * 100) : 0,
    };
  });
})()`);
for (const f of fill) {
  const flag = f.ratio < 50 ? '  ← 留白多' : '';
  console.log(`  ${String(f.id).padEnd(14)} ${String(f.kind).padEnd(10)} ${f.panelH}px / 内容 ${f.contentH}px  ${f.ratio}%${flag}`);
}

console.log();
console.log('═══ 审查结果 ═══');
if (problems.length === 0) {
  console.log('✓ 运行时状态健康');
} else {
  console.log(`✗ 发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log('  ' + p.scene + '  ' + p.issue);
}

fs.writeFileSync(String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\runtime-audit.json`,
  JSON.stringify({ at: new Date().toISOString(), problems, webview: res, bar, fill }, null, 2), 'utf8');

cdp.close();
