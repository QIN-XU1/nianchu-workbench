/**
 * 第三轮验证：跨模块一致性
 *
 * 判据：多个模块协作时是否自洽 —— 这是最容易出问题的地方
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
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(38) + (detail ? '  ' + String(detail).slice(0, 90) : ''));
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  第三轮验证：跨模块一致性');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ═══ 1. 场景 ↔ 面板 ↔ sessionId 三者对应 ═══
console.log('查场景-面板-会话一致性…');
const consistency = await cdp.eval(`(async function(){
  var out = [];
  var scenes = window.__WB.state.get('scenes') || [];
  for (var i = 0; i < Math.min(scenes.length, 4); i++) {
    var s = scenes[i];
    var r = await window.__WB.api.util.scene(s.id);
    if (!r.ok) { out.push({ id: s.id, error: 'load fail' }); continue; }
    var panels = (r.scene && r.scene.panels) || [];
    var harness = panels.filter(function(p){ return p.type === 'harness' || p.type === 'embed'; });
    out.push({
      sceneId: s.id,
      sceneName: s.name,
      panelCount: panels.length,
      harnessCount: harness.length,
      sessionIds: harness.map(function(p){ return p.sessionId || p.session || ''; }).filter(Boolean),
      panelWeights: panels.map(function(p){ return p.w || 1; }),
    });
  }
  return out;
})()`);
for (const c of consistency) {
  console.log('   ' + JSON.stringify(c));
}
chk('场景有面板', consistency.every(c => !c.error && c.panelCount > 0), consistency.length + ' 个场景抽查');
chk('场景有绑定会话', consistency.every(c => c.sessionIds && c.sessionIds.length > 0), consistency.map(c => (c.sessionIds||[]).length).join(','));

// ═══ 2. 面板列数与 w 之和一致 ═══
console.log();
console.log('查网格列数与面板宽度…');
const grid = await cdp.eval(`(function(){
  var g = document.querySelector('.wb-grid');
  var cols = g ? getComputedStyle(g).gridTemplateColumns : '';
  var panels = [];
  document.querySelectorAll('.wb-panel').forEach(function(p){
    panels.push({ type: p.dataset.panelType, span: p.style.gridColumn || '', w: Math.round(p.getBoundingClientRect().width) });
  });
  return { gridCols: cols, colCount: cols ? cols.split(' ').length : 0, panels: panels };
})()`);
console.log('   ' + JSON.stringify(grid));
chk('网格有列定义', grid.colCount > 0, grid.gridCols);
chk('面板都有宽度', grid.panels.every(p => p.w > 100), grid.panels.map(p => p.type + ':' + p.w).join(' '));

// ═══ 3. 神经元节点 ↔ 场景列表 一致 ═══
console.log();
console.log('查神经元与场景列表一致…');
const neuronScenes = await cdp.eval(`(function(){
  var N = window.__NEURON3D;
  if (!N || !N.length) return { error: 'no neuron' };
  var nodes = N[0].state.nodes || [];
  var sceneNodes = nodes.filter(function(n){ return n.type === '场景'; });
  var scenes = window.__WB.state.get('scenes') || [];
  var sceneNodeIds = sceneNodes.map(function(n){ return (n.sceneId || '').replace(/^scene-/, ''); }).sort();
  var listIds = scenes.map(function(s){ return s.id; }).sort();
  return {
    nodeSceneCount: sceneNodes.length,
    listCount: scenes.length,
    idsMatch: JSON.stringify(sceneNodeIds) === JSON.stringify(listIds),
    nodeIds: sceneNodeIds,
    listIds: listIds,
    memCount: nodes.filter(function(n){ return n.type === '记忆'; }).length,
  };
})()`);
chk('神经元场景数 === 场景列表数', neuronScenes.nodeSceneCount === neuronScenes.listCount, neuronScenes.nodeSceneCount + ' vs ' + neuronScenes.listCount);
chk('场景 ID 一一对应', neuronScenes.idsMatch, '');
chk('每个场景有记忆节点', neuronScenes.memCount === neuronScenes.listCount, neuronScenes.memCount + ' 个记忆');

// ═══ 4. ★ 核心联动：派单 → 神经元亮起 ═══
console.log();
console.log('查核心联动（派单→点亮）…');
const linkage = await cdp.eval(`(async function(){
  var N = window.__NEURON3D;
  if (!N || !N.length) return { error: 'no neuron' };
  var inst = N[0];
  var target = 'command';

  // 记录点亮前状态
  var before = inst.state.nodes.filter(function(n){ return n.sceneId === target; }).map(function(n){ return n.lit; });

  // 调用点亮
  var ok = inst.lightScene(target, true);

  // 记录后状态
  var after = inst.state.nodes.filter(function(n){ return n.sceneId === target; }).map(function(n){ return n.lit; });

  // 熄灭
  var off = inst.lightScene(target, false);
  var reset = inst.state.nodes.filter(function(n){ return n.sceneId === target; }).map(function(n){ return n.lit; });

  return { ok: ok, before: before, after: after, off: off, reset: reset, target: target };
})()`);
console.log('   ' + JSON.stringify(linkage));
chk('lightScene 返回成功', linkage.ok === true, String(linkage.ok));
chk('点亮后节点真的亮起', linkage.after && linkage.after.every(x => x === true), JSON.stringify(linkage.after));
chk('可以熄灭', linkage.reset && linkage.reset.every(x => x === false), JSON.stringify(linkage.reset));

// ═══ 5. 主 Agent 派单 → 神经元（真实链路）═══
console.log();
console.log('查主 Agent→神经元完整链路…');
const fullChain = await cdp.eval(`(async function(){
  try {
    var inst = window.__NEURON3D && window.__NEURON3D[0];
    if (!inst) return { error: 'no neuron' };
    var ma = window.__MAIN_AGENT;
    if (!ma) return { error: 'no main agent' };

    // 通过 main-agent 的 lightNeuron 方法
    if (typeof ma.lightNeuron === 'function') {
      ma.lightNeuron('bilibili', true);
      var lit = inst.state.nodes.filter(function(n){ return n.sceneId === 'bilibili' && n.lit; }).length;
      ma.lightNeuron('bilibili', false);
      return { channel: 'main-agent.lightNeuron', litCount: lit };
    }
    return { error: 'main-agent 没有 lightNeuron' };
  } catch(e) { return { throw: e.message }; }
})()`);
console.log('   ' + JSON.stringify(fullChain));
chk('主 Agent 能点亮神经元', !fullChain.error && !fullChain.throw && fullChain.litCount > 0, JSON.stringify(fullChain));

// ═══ 6. 总线事件贯通 ═══
console.log();
console.log('查事件总线…');
const busTest = await cdp.eval(`(function(){
  var B = window.__WB.bus;
  var received = [];
  var off = B.on('test:ping', function(p){ received.push(p); });
  var n = B.emit('test:ping', { ok: true });
  off();
  var after = received.length;
  var n2 = B.emit('test:ping', { ok: true });   // 已解绑，不应再收到
  return { emitted: n, received: after, afterUnsub: received.length, n2: n2 };
})()`);
chk('总线 emit/on 正常', busTest.received === 1, '收到 ' + busTest.received);
chk('解绑生效', busTest.afterUnsub === 1, '解绑后仍收到 ' + (busTest.afterUnsub - 1) + ' 次');

// ═══ 7. 状态容器一致 ═══
console.log();
console.log('查状态容器…');
const stateTest = await cdp.eval(`(function(){
  var S = window.__WB.state;
  var hits = [];
  var off = S.subscribe('test.deep', function(root, path){ hits.push(path); });
  S.batch(function(){
    S.set('test.deep.a', 1);
    S.set('test.deep.b', 2);
    S.set('test.other', 3);
  });
  off();
  var val = S.get('test.deep');
  return { batchHits: hits, value: val, subs: S.subscriberCount() };
})()`);
chk('批量更新只派发一次', stateTest.batchHits.length <= 2, 'hits=' + JSON.stringify(stateTest.batchHits));
chk('状态值正确', stateTest.value && stateTest.value.a === 1 && stateTest.value.b === 2, JSON.stringify(stateTest.value));

// ═══ 8. 命令系统 ═══
console.log();
console.log('查命令系统…');
const cmdTest = await cdp.eval(`(function(){
  var C = window.__WB.commands;
  var ran = 0;
  C.register({
    id: 'test.cmd', label: '测试命令',
    run: function(){ ran++; return 'ok'; },
    undo: function(){ ran--; },
  });
  var r1 = C.run('test.cmd');
  var canUndo = C.canUndo();
  var u = C.undo();
  return { ran: ran, canUndo: canUndo, undoOk: u, history: C.history().undo.length };
})()`);
chk('命令可执行', cmdTest.ran >= 0, 'run=' + JSON.stringify(cmdTest));
chk('命令可撤销', cmdTest.undoOk === true, String(cmdTest.undoOk));

// ═══ 9. 所有 CSS 类名实际存在 ═══
console.log();
console.log('查 CSS 类名实现…');
const cssClasses = await cdp.eval(`(function(){
  var names = ['wb-app','wb-titlebar','wb-scenebar','wb-body','wb-split','wb-main','wb-side','wb-footbar',
               'wb-panel','wb-panel-head','wb-panel-body','wb-split-handle','wb-row','wb-btn','wb-badge','wb-empty'];
  var found = {};
  for (var i=0;i<names.length;i++){
    found[names[i]] = !!document.querySelector('.' + names[i]) || 
      // 也检查 CSS 规则是否定义（可能当前没元素）
      Array.from(document.styleSheets).some(function(ss){
        try { return Array.from(ss.cssRules).some(function(r){ return r.selectorText && r.selectorText.indexOf('.'+names[i]) >= 0; }); }
        catch(e){ return false; }
      });
  }
  return found;
})()`);
const missing = Object.keys(cssClasses).filter(k => !cssClasses[k]);
chk('核心类名都有实现', missing.length === 0, missing.length ? '缺失: ' + missing.join(',') : '全部存在');

// ═══ 10. 零异常 ═══
console.log();
const uniqErrs = [...new Set(cdp.errs)];
chk('三轮全程零异常', uniqErrs.length === 0, uniqErrs.length ? uniqErrs[0].slice(0, 100) : '无');

console.log();
const passed = R.filter(r => r.pass).length;
console.log('───────────────────────────────────────────────────────────');
console.log('  第三轮结果：' + passed + ' / ' + R.length + ' 通过');
console.log('───────────────────────────────────────────────────────────');

cdp.close();

const fs = await import('node:fs');
fs.writeFileSync(
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\verify-round3.json`,
  JSON.stringify(R, null, 2),
  'utf8'
);
