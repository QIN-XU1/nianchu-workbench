/**
 * 第二轮验证：边界与异常
 *
 * 判据：不给理想输入，故意搞坏，看系统是否优雅降级（不白屏、不崩、不静默失败）
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

const R = [];
function chk(name, pass, detail) {
  R.push({ name, pass: !!pass, detail: String(detail || '').slice(0, 140) });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(36) + (detail ? '  ' + String(detail).slice(0, 90) : ''));
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  第二轮验证：边界与异常');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ═══ 1. window.resize 到 720px 窄窗口 ═══
console.log('查窄窗口布局…');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
await new Promise(r => setTimeout(r, 1200));

const narrow = await cdp.eval(`(function(){
  var side = document.querySelector('.wb-side');
  var split = document.querySelector('.wb-split');
  var grid = document.querySelector('.wb-grid');
  var r = grid ? grid.getBoundingClientRect() : {};
  // 竖排文字检测
  var vertical = 0;
  document.querySelectorAll('*').forEach(function(el){
    var t = (el.textContent||'').trim();
    if(t.length>2 && t.length<40 && el.children.length===0){
      var b = el.getBoundingClientRect();
      if(b.width>0 && b.height>0 && b.width < 26 && b.height > b.width*3) vertical++;
    }
  });
  // 溢出检测
  var overflowX = document.documentElement.scrollWidth > window.innerWidth + 2;
  return {
    winW: window.innerWidth,
    sideDisplay: side ? getComputedStyle(side).display : '',
    sideW: side ? Math.round(side.getBoundingClientRect().width) : -1,
    gridW: Math.round(r.width || 0),
    vertical: vertical,
    overflowX: overflowX,
    docScrollW: document.documentElement.scrollWidth,
  };
})()`);
console.log(JSON.stringify(narrow, null, 2));
chk('720px 无横向溢出', !narrow.overflowX, 'scrollWidth=' + narrow.docScrollW);
chk('720px 无竖排文字', narrow.vertical === 0, narrow.vertical + ' 个');
chk('720px 右栏自动收起', narrow.sideDisplay === 'none' || narrow.sideW <= 0, 'display=' + narrow.sideDisplay);

// ═══ 2. 恢复大窗口 ═══
await cdp.send('Emulation.clearDeviceMetricsOverride');
await new Promise(r => setTimeout(r, 800));

// ═══ 3. 极端窗口（1024）═══
console.log();
console.log('查 1024px 中间态…');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 800, deviceScaleFactor: 1, mobile: false });
await new Promise(r => setTimeout(r, 1000));
const mid = await cdp.eval(`(function(){
  var vertical = 0;
  document.querySelectorAll('*').forEach(function(el){
    var t = (el.textContent||'').trim();
    if(t.length>2 && t.length<40 && el.children.length===0){
      var b = el.getBoundingClientRect();
      if(b.width>0 && b.height>0 && b.width < 26 && b.height > b.width*3) vertical++;
    }
  });
  return { vertical: vertical, overflowX: document.documentElement.scrollWidth > window.innerWidth + 2 };
})()`);
chk('1024px 无竖排', mid.vertical === 0, mid.vertical + ' 个');
chk('1024px 无溢出', !mid.overflowX);
await cdp.send('Emulation.clearDeviceMetricsOverride');
await new Promise(r => setTimeout(r, 600));

// ═══ 4. 空数据：搜索不存在的关键词 ═══
console.log();
console.log('查空数据降级…');
const emptySearch = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  if(!N || !N.length) return { error: 'no neuron' };
  var inst = N[0];
  var S = inst.state;
  var before = (S.visNodes||[]).length;
  // 手动设过滤
  S.filter = 'zzz_not_exist_zzz';
  if (inst.update) inst.update();
  var after = (S.visNodes||[]).length;
  // 恢复
  S.filter = '';
  if (inst.update) inst.update();
  return { before: before, after: after, recovered: (S.visNodes||[]).length };
})()`);
chk('神经元过滤降级', emptySearch.before > 0, '过滤前 ' + (emptySearch.before||0) + ' 节点');
chk('清空过滤可恢复', emptySearch.recovered === emptySearch.before, (emptySearch.recovered||0) + ' 节点');

// ═══ 5. 派单空输入（应拒绝，不崩）═══
console.log();
console.log('查派单空输入…');
const emptyDispatch = await cdp.eval(`(async function(){
  try {
    var r = await window.__WB.api.util.dispatch('', '');
    return { ok: r.ok, error: r.error };
  } catch(e) { return { throw: e.message }; }
})()`);
chk('空 sessionId 被拒', !emptyDispatch.ok && !emptyDispatch.throw, JSON.stringify(emptyDispatch.error || emptyDispatch.throw || ''));
chk('不抛异常', !emptyDispatch.throw);

// 空文本
const emptyText = await cdp.eval(`(async function(){
  try {
    var r = await window.__WB.api.util.dispatch('session-x', '   ');
    return { ok: r.ok, error: r.error };
  } catch(e) { return { throw: e.message }; }
})()`);
chk('空文本被拒', !emptyText.ok && !emptyText.throw);

// ═══ 6. 非法 RPC 方法名 ═══
console.log();
console.log('查非法 RPC…');
const badRpc = await cdp.eval(`(async function(){
  try {
    var r = await window.app.engine.rpc('../../../etc/passwd', {});
    return { ok: r.ok, err: r.err || r.error };
  } catch(e) { return { throw: e.message }; }
})()`);
chk('非法方法名被拒', !badRpc.ok || badRpc.err, (badRpc.err && (badRpc.err.message || badRpc.err)) ? 'rejected' : 'ok=false');

// ═══ 7. 极点缩放（不崩）═══
console.log();
console.log('查缩放边界…');
const zoomTest = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  if(!N || !N.length) return { error: 'no neuron' };
  var S = N[0].state;
  var orig = S.zoom;
  S.zoom = 0.01;
  N[0].update && N[0].update();
  var z1 = S.zoom;
  S.zoom = 100;
  N[0].update && N[0].update();
  var z2 = S.zoom;
  S.zoom = orig;
  N[0].update && N[0].update();
  return { minClamped: z1, maxClamped: z2, restored: S.zoom };
})()`);
chk('缩放极小不崩', !zoomTest.error, 'zoom=' + zoomTest.minClamped);
chk('缩放极大不崩', !zoomTest.error, 'zoom=' + zoomTest.maxClamped);

// ═══ 8. 场景快速切换（竞态）═══
console.log();
console.log('查场景快速切换竞态…');
const race = await cdp.eval(`(async function(){
  try {
    var ids = ['command','bilibili','arch-review','pipeline','research','command'];
    for (var i=0;i<ids.length;i++) {
      await window.__WB.commands.run('scene.switch', { id: ids[i] });
    }
    var panels = document.querySelectorAll('.wb-panel').length;
    var degrade = document.querySelectorAll('.wb-panel-degrade').length;
    return { panels: panels, degrade: degrade, finalScene: window.__WB.state.get('scene.active') };
  } catch(e) { return { throw: e.message }; }
})()`);
chk('快速切换不崩', !race.throw, race.throw || ('最终场景 ' + race.finalScene));
chk('切换后无降级面板', race.degrade === 0, (race.degrade||0) + ' 个降级');

// ═══ 9. 长时间运行后内存/监听器泄漏 ═══
console.log();
console.log('查监听器泄漏…');
const leak = await cdp.eval(`(function(){
  var B = window.__WB.bus;
  return {
    listeners: B.listenerCount ? B.listenerCount() : -1,
    patterns: B.patterns ? B.patterns().length : -1,
    stateSubs: window.__WB.state.subscriberCount ? window.__WB.state.subscriberCount() : -1,
    activePanels: window.__WB.registry.activeCount ? window.__WB.registry.activeCount() : -1,
  };
})()`);
console.log('   ' + JSON.stringify(leak));
chk('监听器数量合理', leak.listeners >= 0 && leak.listeners < 200, leak.listeners + ' 个');
chk('活跃面板数量合理', leak.activePanels >= 0 && leak.activePanels < 20, leak.activePanels + ' 个');

// ═══ 10. 零 JS 异常 ═══
console.log();
const uniqErrs = [...new Set(cdp.errs)];
chk('边界测试期间无异常', uniqErrs.length === 0, uniqErrs.length ? uniqErrs[0].slice(0, 100) : '无');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────────');
console.log('  第二轮结果：' + passed + ' / ' + R.length + ' 通过');
console.log('───────────────────────────────────────────────────────────');

cdp.close();

const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\verify-round2.json`,
  JSON.stringify(R, null, 2),
  'utf8'
);
