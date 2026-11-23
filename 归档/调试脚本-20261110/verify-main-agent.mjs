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

// ① 展开主 Agent
await cdp.eval(`(function(){
  document.body.dataset.mainAgent = 'on';
  var cb = document.getElementById('ma-collapse');
  if (cb) cb.textContent = '‹';
  return true;
})()`);
await new Promise(r => setTimeout(r, 1500));

const r = await cdp.eval(`(function(){
  var panel = document.getElementById('main-agent-panel');
  if (!panel) return { error: 'no panel' };
  var rc = panel.getBoundingClientRect();
  return {
    visible: document.body.dataset.mainAgent,
    x: Math.round(rc.x), w: Math.round(rc.width), h: Math.round(rc.height),
    sections: {
      chat: !!panel.querySelector('.ma-chat'),
      agents: !!panel.querySelector('.ma-agents'),
      dispatch: !!panel.querySelector('.ma-dispatch'),
    },
    agentRows: panel.querySelectorAll('.ma-agent-row').length,
    hasCollapseBtn: !!document.getElementById('ma-collapse'),
    webviewSrc: (panel.querySelector('#ma-webview') || {}).getAttribute ? (panel.querySelector('#ma-webview').getAttribute('src') || '') : '',
    // 场景视图是否让出了空间
    scenarioViewRight: Math.round((document.getElementById('scenario-view') || {getBoundingClientRect:()=>({right:0})}).getBoundingClientRect().right),
  };
})()`);

console.log('═══ 主 Agent 面板 ═══');
console.log('  状态: ' + r.visible);
console.log('  位置: x=' + r.x + ' 尺寸 ' + r.w + 'x' + r.h);
console.log('  区块: 对话 ' + (r.sections.chat ? '✓' : '✗') + ' | 子agent ' + (r.sections.agents ? '✓' : '✗') + ' | 派单 ' + (r.sections.dispatch ? '✓' : '✗'));
console.log('  子 agent 行: ' + r.agentRows);
console.log('  折叠按钮: ' + (r.hasCollapseBtn ? '✓' : '✗'));
console.log('  主控 webview: ' + (r.webviewSrc || '(空)'));
console.log('  场景区右边界: ' + r.scenarioViewRight + 'px（应 < 主 Agent x=' + r.x + '）');

cdp.close();
