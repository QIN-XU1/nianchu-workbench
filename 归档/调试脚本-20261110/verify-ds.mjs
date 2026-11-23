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

console.log('═══ 新设计系统验收 ═══');
console.log();

const r = await cdp.eval(`(function(){
  var out = {};

  // ① data-ds 是否启用
  out.dsEnabled = document.body.dataset.ds === 'on';

  // ② CSS 变量是否生效
  var root = getComputedStyle(document.documentElement);
  out.tokens = {
    canvas: root.getPropertyValue('--ds-canvas').trim(),
    surface: root.getPropertyValue('--ds-surface').trim(),
    text: root.getPropertyValue('--ds-text').trim(),
    accent: root.getPropertyValue('--ds-accent').trim(),
    mono: root.getPropertyValue('--ds-mono').trim().slice(0, 40),
  };

  // ③ 实际渲染的颜色
  var bodyCs = getComputedStyle(document.body);
  out.bodyStyle = {
    bg: bodyCs.backgroundColor,
    color: bodyCs.color,
    font: bodyCs.fontFamily.split(',')[0],
  };

  // ④ 顶栏高度
  ['titlebar','scenebar'].forEach(function(id){
    var el = document.getElementById(id);
    out[id] = el ? Math.round(el.getBoundingClientRect().height) : 0;
  });

  // ⑤ 旧系统残留
  out.oldResidue = {
    statusbar: !!document.getElementById('tui-statusbar'),
    hintbar: !!document.getElementById('tui-hintbar'),
    themePicker: document.querySelectorAll('.tui-theme-picker').length,
  };

  // ⑥ 主 Agent 面板
  out.mainAgent = {
    exists: !!document.getElementById('main-agent-panel'),
    visible: document.body.dataset.mainAgent === 'on',
    agentCount: document.getElementById('ma-agent-count') ? document.getElementById('ma-agent-count').textContent : '?',
  };

  // ⑦ 渲染器数量
  out.rendererCount = window.APP_RENDERERS ? Object.keys(window.APP_RENDERERS).length : 0;
  out.hasSfBoard = !!(window.APP_RENDERERS && window.APP_RENDERERS['sf-board']);
  out.neuron2 = !!window.__NEURON2;

  return out;
})()`);

console.log('① 设计系统启用: ' + (r.dsEnabled ? '✓' : '✗'));
console.log();
console.log('② 设计令牌:');
for (const [k, v] of Object.entries(r.tokens)) {
  console.log('    ' + k.padEnd(10) + v);
}
console.log();
console.log('③ 实际渲染:');
console.log('    背景  ' + r.bodyStyle.bg);
console.log('    文字  ' + r.bodyStyle.color);
console.log('    字体  ' + r.bodyStyle.font);
console.log();
console.log('④ 顶栏: titlebar ' + r.titlebar + 'px + scenebar ' + r.scenebar + 'px = ' + (r.titlebar + r.scenebar) + 'px');
console.log();
console.log('⑤ 旧系统残留:');
console.log('    状态栏  ' + (r.oldResidue.statusbar ? '⚠ 仍在' : '✓ 已清除'));
console.log('    底栏    ' + (r.oldResidue.hintbar ? '⚠ 仍在' : '✓ 已清除'));
console.log('    主题器  ' + (r.oldResidue.themePicker ? '⚠ 仍在' : '✓ 已清除'));
console.log();
console.log('⑥ 主 Agent:');
console.log('    面板存在  ' + (r.mainAgent.exists ? '✓' : '✗'));
console.log('    可见      ' + (r.mainAgent.visible ? '✓' : '✗'));
console.log('    子 agent  ' + r.mainAgent.agentCount);
console.log();
console.log('⑦ 渲染器: ' + r.rendererCount + ' 个 · sf-board ' + (r.hasSfBoard ? '✓' : '✗') + ' · neuron2 ' + (r.neuron2 ? '✓' : '✗'));

cdp.close();
