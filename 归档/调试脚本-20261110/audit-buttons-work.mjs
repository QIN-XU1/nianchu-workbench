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

console.log('═══ 顶栏按钮「可用性」实测 ═══');
console.log();

// 检查每个按钮是否有 click 监听器（用 getEventListeners 只有 DevTools 能看，改测触发行为）
const r = await cdp.eval(`(function(){
  var out = [];

  function hasListener(el) {
    // 无法直接读 listener，用 element.onclick / 已知 API 判断
    return {
      hasOnclick: typeof el.onclick === 'function',
      hasId: !!el.id,
      hasTitle: !!(el.title || '').trim(),
    };
  }

  // 检查每个按钮的 DOM
  var btns = [].slice.call(document.querySelectorAll('#titlebar button'));
  for (var b of btns) {
    var rect = b.getBoundingClientRect();
    if (rect.width < 5) continue;
    out.push({
      id: b.id || '(无id)',
      text: (b.textContent || '').trim().slice(0, 12),
      title: (b.title || '').slice(0, 40),
      w: Math.round(rect.width),
      x: Math.round(rect.x),
      hasOnclick: typeof b.onclick === 'function',
    });
  }
  return out;
})()`);

console.log('  可见顶栏按钮 ' + r.length + ' 个:');
for (const b of r) {
  console.log(`    x=${String(b.x).padStart(4)} ${b.id.padEnd(14)} "${b.text.padEnd(10)}" w=${b.w}  onclick=${b.hasOnclick}`);
}

console.log();
console.log('═══ 检查各按钮的实际功能入口 ═══');
const api = await cdp.eval(`(function(){
  var keys = Object.keys(window.app || {});
  return {
    hasPlugins: typeof window.app?.plugins,
    hasSkills: typeof window.app?.skills,
    hasTools: typeof window.app?.tools,
    hasModels: typeof window.app?.models,
    hasRefresh: typeof window.__refreshCurrentScene,
    appKeys: keys,
  };
})()`);
console.log('  window.app 有 plugins: ' + api.hasPlugins);
console.log('  window.app 有 skills : ' + api.hasSkills);
console.log('  window.app 有 tools  : ' + api.hasTools);
console.log('  window.app 有 models : ' + api.hasModels);
console.log('  refresh 函数: ' + api.hasRefresh);

cdp.close();
