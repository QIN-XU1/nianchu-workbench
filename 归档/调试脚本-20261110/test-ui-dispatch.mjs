const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 60000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 主 Agent UI 派单测试 ═══');
console.log();

// ① 确保主 Agent 展开
await cdp.eval(`(function(){ document.body.dataset.mainAgent = 'on'; return true; })()`);
await new Promise(r => setTimeout(r, 1200));

// ② 检查 UI 元素
const ui = await cdp.eval(`(function(){
  var p = document.getElementById('main-agent-panel');
  if (!p) return { error: 'no panel' };
  return {
    visible: p.getBoundingClientRect().width > 0,
    hasSelect: !!p.querySelector('#ma-target'),
    selectValue: (p.querySelector('#ma-target')||{value:''}).value,
    optionCount: (p.querySelector('#ma-target')||{options:[]}).options.length,
    hasTextarea: !!p.querySelector('#ma-task'),
    hasSendBtn: !!p.querySelector('#ma-send'),
    hasLog: !!p.querySelector('#ma-log'),
  };
})()`);
console.log('① UI 状态: ' + JSON.stringify(ui));

// ③ 选中 command 场景 + 填任务 + 点派发
const MARKER = 'UI-TEST-' + Date.now();
const setup = await cdp.eval(`(function(){
  var sel = document.getElementById('ma-target');
  var ta = document.getElementById('ma-task');
  if (!sel || !ta) return { error: 'no elements' };
  // 选 command
  for (var i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value === 'command') { sel.selectedIndex = i; break; }
  }
  ta.value = '请在回复里原样包含这串标记：${MARKER}。只输出标记本身。';
  return { selected: sel.value, text: ta.value.slice(0, 60) };
})()`);
console.log();
console.log('② 设置: ' + JSON.stringify(setup));

// ④ 点派发按钮
const clicked = await cdp.eval(`(function(){
  var btn = document.getElementById('ma-send');
  if (!btn) return { error: 'no btn' };
  btn.click();
  return { clicked: true };
})()`);
console.log('③ 点击派发: ' + JSON.stringify(clicked));

// ⑤ 等 8 秒看日志
await new Promise(r => setTimeout(r, 8000));

const log = await cdp.eval(`(function(){
  var l = document.getElementById('ma-log');
  if (!l) return '(无日志容器)';
  return Array.from(l.children).map(function(c){ return c.textContent; }).join(' | ');
})()`);
console.log();
console.log('④ 派单日志: ' + log);

// ⑥ 等 30 秒验证会话
console.log();
console.log('⑤ 等 30 秒验证执行…');
await new Promise(r => setTimeout(r, 30000));

const verify = await cdp.eval(`(async function(){
  // 用引擎 RPC 查会话是否有新内容
  try {
    var r = await window.app.engine.rpc('session/list', { _request: {} });
    return { ok: r.ok, hasItems: !!(r.value && r.value.items) };
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('   引擎查询: ' + JSON.stringify(verify));

cdp.close();
