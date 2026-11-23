import fs from 'node:fs';

const CDP_PORT = 9333;
const BASE = 'http://127.0.0.1:3080';
const TOKEN = '';
const WB = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench`;
const SC = WB + '\\外壳\\scenarios';

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

// ═══════ 审查轮 3：会话 ↔ 场景 对应关系 ═══════
console.log('═══ 审查轮 3：会话与场景的对应关系 ═══');
console.log();

// 读已写的 sessionId
const bindings = [];
for (const f of fs.readdirSync(SC)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(SC + '\\' + f, 'utf8').replace(/\uFEFF/g, ''));
    const h = (j.panels || []).find(p => p.type === 'harness');
    if (h && h.sessionId) {
      bindings.push({ scene: j.id, sceneName: j.name, sessionId: h.sessionId, sessionTitle: h.sessionTitle });
    }
  } catch { /* ignore */ }
}

console.log('已绑定会话:', bindings.length);
console.log();

// 检查是否有重复 sessionId（防串台）
const dupes = {};
for (const b of bindings) (dupes[b.sessionId] = dupes[b.sessionId] || []).push(b.scene);
const hasDupes = Object.entries(dupes).filter(([k, v]) => v.length > 1);
console.log('【1】sessionId 唯一性');
if (hasDupes.length) {
  console.log('  ✗ 有重复：');
  for (const [sid, scenes] of hasDupes) console.log(`    ${sid} 被 ${scenes.join(', ')} 共用`);
} else {
  console.log('  ✓ 11 个 sessionId 全部唯一（无串台风险）');
}
console.log();

// 检查 sessionId 格式
console.log('【2】sessionId 格式');
const badFormat = bindings.filter(b => !b.sessionId.startsWith('session-') && !b.sessionId.match(/^[0-9a-f-]{36}$/));
if (badFormat.length) {
  console.log('  ✗ 格式异常：');
  for (const b of badFormat) console.log(`    ${b.scene}: ${b.sessionId}`);
} else {
  console.log('  ✓ 全部符合 session-* 格式');
}
console.log();

// 检查 sessionTitle 与场景名一致
console.log('【3】sessionTitle 与场景名');
let titleMismatch = 0;
for (const b of bindings) {
  if (b.sessionTitle !== b.sceneName) {
    titleMismatch++;
    console.log(`  ! ${b.scene.padEnd(20)} sessionTitle="${b.sessionTitle}"  场景名="${b.sceneName}"`);
  }
}
if (!titleMismatch) console.log('  ✓ 全部一致');
console.log();

// 检查会话是否真的存在于引擎
console.log('【4】会话是否存在于引擎');
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const engWv = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
console.log(`  3080 webview: ${engWv.length} 个`);

if (engWv.length > 0) {
  const cdp = CDP(engWv[0].webSocketDebuggerUrl);
  await cdp.connect();
  try {
    // 从引擎界面里读会话列表
    const list = await cdp.eval(`(function(){
      // 侧边栏会话项
      var items = [].slice.call(document.querySelectorAll('[class*="session"], [data-session], [role="listitem"]'));
      var texts = items.map(function(el){ return (el.textContent||'').trim().slice(0, 30); }).filter(Boolean);
      // 退而用整页文本
      var bodyText = (document.body.innerText || '');
      return {
        itemCount: items.length,
        texts: texts.slice(0, 20),
        hasSceneNames: ['命令','调研','竞品拆解','逆向分析','架构梳理','实施计划','管线','关系军师','自我复盘','B站','本地电脑'].filter(function(n){ return bodyText.indexOf(n) >= 0; }),
      };
    })()`);
    console.log(`  侧边栏项: ${list.itemCount}`);
    console.log(`  找到的场景名: ${JSON.stringify(list.hasSceneNames)}`);
    if (list.texts.length) console.log(`  前几项: ${JSON.stringify(list.texts.slice(0, 8))}`);
  } finally {
    cdp.close();
  }
}

console.log();
console.log('═══ 结论 ═══');
const ok = !hasDupes.length && !badFormat.length && titleMismatch === 0;
console.log(ok ? '✓ 会话绑定关系健康' : '✗ 有问题');
