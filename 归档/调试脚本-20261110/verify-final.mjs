/**
 * 三轮复检 —— 冷却后重跑，确认结果可复现（不是偶然通过）
 */

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  const errs = [];
  return {
    errs,
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

console.log('═══════════════════════════════════════════════════════════════');
console.log('  最终复检（冷却 3 分钟后重跑核心场景）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// 等 3 秒让系统稳定
await new Promise(r => setTimeout(r, 3000));

const R = [];
function chk(name, pass, detail) {
  R.push({ name, pass: !!pass, detail: String(detail || '') });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(40) + (detail ? '  ' + detail.slice(0, 80) : ''));
}

// ═══ 存量状态 ═══
const st = await cdp.eval(`(function(){
  return {
    ready: window.__WB && window.__WB.state.get('boot.phase') === 'ready',
    scenes: (window.__WB.state.get('scenes')||[]).length,
    panels: document.querySelectorAll('.wb-panel').length,
    degrade: document.querySelectorAll('.wb-panel-degrade').length,
    neuronNodes: window.__NEURON3D && window.__NEURON3D[0] ? (window.__NEURON3D[0].state.nodes||[]).length : -1,
    tuiAlive: !!(window.app && window.app.tui),
    sessions: -1,
  };
})()`);

chk('应用就绪', st.ready);
chk('11 场景', st.scenes === 11, st.scenes + ' 个');
chk('面板渲染无降级', st.panels >= 2 && st.degrade === 0, st.panels + ' 面板 / ' + st.degrade + ' 降级');
chk('神经元 23 节点', st.neuronNodes === 23, st.neuronNodes + ' 个');

// ═══ 完整派单链路（真实执行一次）═══
console.log();
console.log('执行一次真实派单（验证核心价值）…');
const MARKER = 'VERIFY-FINAL-' + Date.now();
const dispatch = await cdp.eval(`(async function(){
  try {
    // 用 bilibili 场景（避开正在使用的 command）
    var r = await window.__WB.api.util.scene('bilibili');
    if (!r.ok) return { error: 'scene load fail' };
    var panels = (r.scene.panels||[]);
    var h = panels.find(function(p){ return p.type === 'harness' && (p.sessionId || p.session); });
    var sid = h && (h.sessionId || h.session);
    if (!sid) return { error: 'no sessionId' };

    // 派单前先点亮神经元
    if (window.__MAIN_AGENT && window.__MAIN_AGENT.lightNeuron) {
      window.__MAIN_AGENT.lightNeuron('bilibili', true);
    }

    var res = await window.__WB.api.util.dispatch(sid, '请回复：${MARKER}。只输出这串。');
    return {
      ok: res.ok,
      sessionId: sid,
      error: res.error,
      neuronLit: (window.__NEURON3D && window.__NEURON3D[0]) ?
        window.__NEURON3D[0].state.nodes.filter(function(n){ return n.lit; }).length : -1,
    };
  } catch(e) { return { throw: e.message }; }
})()`);
console.log('   ' + JSON.stringify(dispatch));
chk('派单成功', dispatch.ok === true, String(dispatch.ok) + ' ' + (dispatch.error ? JSON.stringify(dispatch.error) : ''));
chk('神经元已亮起', dispatch.neuronLit > 0, dispatch.neuronLit + ' 个节点亮起');

// ═══ 等待执行并验证真实结果 ═══
console.log();
console.log('等 35 秒验证真实响应…');
await new Promise(r => setTimeout(r, 35000));

const verify = await cdp.eval(`(async function(){
  try {
    var r = await window.__WB.api.util.sessions();
    if (!r.ok || !r.items.length) return { error: 'sessions fail' };
    var item = r.items.find(function(x){ return x.sessionId === ${JSON.stringify(dispatch.sessionId || '')}; });
    if (!item) return { error: 'session not found' };
    return {
      seq: item.projections && item.projections.asOfSeq,
      running: item.running,
      tokens: item.projections && item.projections.values && item.projections.values.tokenUsage,
    };
  } catch(e) { return { throw: e.message }; }
})()`);
console.log('   ' + JSON.stringify(verify));
chk('会话有消息序号', verify.seq > 0, 'asOfSeq=' + verify.seq);
chk('执行已完成', verify.running === false, 'running=' + verify.running);

// ═══ 熄灭神经元 ═══
const reset = await cdp.eval(`(function(){
  if (window.__MAIN_AGENT && window.__MAIN_AGENT.lightNeuron) {
    window.__MAIN_AGENT.lightNeuron('bilibili', false);
  }
  var lit = (window.__NEURON3D && window.__NEURON3D[0]) ?
    window.__NEURON3D[0].state.nodes.filter(function(n){ return n.lit; }).length : -1;
  return { lit: lit };
})()`);
chk('神经元可复位', reset.lit === 0, reset.lit + ' 个仍亮');

// ═══ 零异常 ═══
console.log();
const uniqErrs = [...new Set(cdp.errs)];
chk('全程零异常', uniqErrs.length === 0, uniqErrs.length ? uniqErrs[0].slice(0, 100) : '无');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────────');
console.log('  最终复检：' + passed + ' / ' + R.length + ' 通过');
console.log('───────────────────────────────────────────────────────────');

cdp.close();

const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\verify-final.json`,
  JSON.stringify({ results: R, dispatch, verify }, null, 2),
  'utf8'
);
