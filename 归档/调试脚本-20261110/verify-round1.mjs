/**
 * 三轮验证（Round 1: 功能可用性）
 *
 * 判据：每个核心功能是否真的活着 —— 不看代码，看实测
 */

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const errs = [];
  const logs = [];
  return {
    errs, logs,
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('连接失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            errs.push((d.exception?.description || d.text || '').slice(0, 300));
          }
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            logs.push('error: ' + (m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 200));
          }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 40000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch {} }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

const R = [];
function chk(name, pass, detail) {
  R.push({ name, pass: !!pass, detail: String(detail || '').slice(0, 120) });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(34) + (detail ? '  ' + String(detail).slice(0, 80) : ''));
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  第一轮验证：功能可用性');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ═══ 1. 基础架构 ═══
const base = await cdp.eval(`(function(){
  return {
    hasWB: !!window.__WB,
    phase: window.__WB && window.__WB.state.get('boot.phase'),
    titlebar: !!document.querySelector('.wb-titlebar'),
    scenebar: !!document.querySelector('.wb-scenebar'),
    split: !!document.querySelector('.wb-split'),
    side: document.querySelector('.wb-side') ? document.querySelector('.wb-side').getBoundingClientRect().width : 0,
  };
})()`);
chk('应用已初始化', base.hasWB && base.phase === 'ready', 'phase=' + base.phase);
chk('骨架三段式', base.titlebar && base.scenebar && base.split);
chk('右栏有宽度', base.side > 200, base.side + 'px');

// ═══ 2. 场景系统 ═══
const scenes = await cdp.eval(`(function(){
  return {
    tabs: document.querySelectorAll('.wb-scenetab').length,
    active: document.querySelector('.wb-scenetab[data-active="1"]')?.textContent || '',
    stateCount: (window.__WB.state.get('scenes')||[]).length,
  };
})()`);
chk('11 个场景标签', scenes.tabs === 11, scenes.tabs + ' 个');
chk('有激活场景', scenes.active.length > 0, scenes.active);

// ═══ 3. 面板渲染 ═══
const panels = await cdp.eval(`(function(){
  var out = [];
  document.querySelectorAll('.wb-panel').forEach(function(p){
    out.push({ type: p.dataset.panelType, degrade: !!p.querySelector('.wb-panel-degrade') });
  });
  return { count: out.length, list: out };
})()`);
chk('面板已渲染', panels.count >= 2, panels.count + ' 个');
chk('无降级卡片', panels.list.every(p => !p.degrade), panels.list.filter(p=>p.degrade).map(p=>p.type).join(',') || '全部正常');

// ═══ 4. 3D 神经元 ═══
const neu = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  if (!N || !N.length) return { error: 'no instance' };
  var S = N[0].state;
  var nodes = S.nodes || [];
  var xs = nodes.map(n=>n.x), ys = nodes.map(n=>n.y), zs = nodes.map(n=>n.z);
  var xr = [Math.min(...xs).toFixed(2), Math.max(...xs).toFixed(2)];
  var zr = [Math.min(...zs).toFixed(2), Math.max(...zs).toFixed(2)];
  var canvas = document.querySelector('[data-panel-type="neuron"] canvas');
  return {
    count: nodes.length,
    ready: S.ready,
    xRange: xr, zRange: zr,
    hasZ: Math.abs(parseFloat(zr[1]) - parseFloat(zr[0])) > 0.5,
    canvas: !!canvas,
    hasLightScene: typeof N[0].lightScene === 'function',
  };
})()`);
chk('神经元有实例', !neu.error, neu.error || '');
chk('神经元节点数', neu.count === 23, (neu.count||0) + ' 个');
chk('有 3D 深度（z 轴）', neu.hasZ, 'z range ' + (neu.zRange||[]).join('..'));
chk('canvas 存在', neu.canvas);
chk('点亮 API 可用', neu.hasLightScene);

// ═══ 5. 主 Agent ═══
const ma = await cdp.eval(`(function(){
  var p = document.getElementById('ma-panel');
  if (!p) return { error: 'no panel' };
  return {
    exists: true,
    agentRows: document.querySelectorAll('#ma-agents .wb-row').length,
    hasSelect: !!p.querySelector('#ma-target'),
    hasTextarea: !!p.querySelector('#ma-task'),
    hasSend: !!p.querySelector('#ma-send'),
    hasTui: !!p.querySelector('#ma-tui-frame canvas, #ma-tui-frame .xterm'),
    tuiText: (p.querySelector('#ma-tui-frame')?.textContent || '').slice(0, 40),
  };
})()`);
chk('主 Agent 面板存在', ma.exists, ma.error || '');
chk('11 个子 Agent', ma.agentRows === 11, ma.agentRows + ' 行');
chk('派发控件齐全', ma.hasSelect && ma.hasTextarea && ma.hasSend);
chk('dsh-TUI 已挂载', ma.hasTui, ma.tuiText.replace(/\s+/g,' ').slice(0, 40));

// ═══ 6. 派单链路（真实调用）═══
const dispatch = await cdp.eval(`(async function(){
  try {
    var r = await window.__WB.api.util.sessions();
    if (!r.ok) return { error: 'sessions failed: ' + (r.error && r.error.message) };
    return { ok: true, count: r.items.length };
  } catch(e) { return { error: e.message }; }
})()`);
chk('engine.rpc 通道', dispatch.ok, dispatch.error || (dispatch.count + ' 个会话'));

// ═══ 7. 对比度（从 CSS 实测）═══
const contrast = await cdp.eval(`(function(){
  var t1 = getComputedStyle(document.documentElement).getPropertyValue('--color-txt-1').trim();
  var base = getComputedStyle(document.documentElement).getPropertyValue('--color-base').trim();
  return { t1, base };
})()`);
chk('设计令牌生效', contrast.t1 && contrast.base, 'txt-1=' + contrast.t1 + ' base=' + contrast.base);

// ═══ 8. 零 JS 错误 ═══
const uniqErrs = [...new Set(cdp.errs)];
chk('控制台零异常', uniqErrs.length === 0, uniqErrs.length ? uniqErrs[0].slice(0, 80) : '无');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────────');
console.log('  第一轮结果：' + passed + ' / ' + R.length + ' 通过');
console.log('───────────────────────────────────────────────────────────');

cdp.close();

// 输出 JSON 供后续汇总
const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\verify-round1.json`,
  JSON.stringify(R, null, 2),
  'utf8'
);
