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

console.log('═══ 五项验收 ═══');
console.log();

const r = await cdp.eval(`(function(){
  var out = {};

  // ① 窗口最小尺寸（读不到 Electron opts，改测当前能否缩到 900）
  out.window = { w: window.innerWidth, h: window.innerHeight };

  // ② 主题按钮
  out.themeButtons = document.querySelectorAll('.tui-theme-picker button').length;
  out.themePickerExists = !!document.querySelector('.tui-theme-picker');

  // ③ 集市 / 文件夹 / 三点
  out.marketBtn = !!document.getElementById('btn-market');
  var pills = [].slice.call(document.querySelectorAll('.tbs-pill'));
  out.pills = pills.map(function(p){ return (p.textContent || '').trim().slice(0, 10); });

  // ④ 余额
  out.balanceChip = document.querySelectorAll('.balance-chip').length;

  // ⑤ 底栏
  out.hintbar = !!document.getElementById('tui-hintbar');

  // 布局
  var grid = document.getElementById('grid');
  out.gridCols = grid ? getComputedStyle(grid).gridTemplateColumns : '?';
  out.overflowX = document.documentElement.scrollWidth > window.innerWidth;

  // 顶栏总高
  var tb = document.getElementById('titlebar');
  var sb = document.getElementById('scenebar');
  out.titlebarH = tb ? Math.round(tb.getBoundingClientRect().height) : 0;
  out.scenebarH = sb ? Math.round(sb.getBoundingClientRect().height) : 0;

  return out;
})()`);

console.log('【① 窗口】' + r.window.w + 'x' + r.window.h);
console.log('【② 主题按钮】' + r.themeButtons + ' 个（picker 容器存在: ' + r.themePickerExists + '）');
console.log('【③ 集市按钮】' + (r.marketBtn ? '⚠ 仍在' : '✓ 已删'));
console.log('     顶栏胶囊: ' + (r.pills.length ? r.pills.join(' / ') : '（无）'));
console.log('【④ 余额按钮】' + (r.balanceChip ? '⚠ 仍在' : '✓ 已删'));
console.log('【⑤ 底栏】' + (r.hintbar ? '⚠ 仍在' : '✓ 已删'));
console.log();
console.log('  顶栏高: titlebar ' + r.titlebarH + 'px + scenebar ' + r.scenebarH + 'px = ' + (r.titlebarH + r.scenebarH) + 'px');
console.log('  grid 列: ' + r.gridCols);
console.log('  横向溢出: ' + r.overflowX);

cdp.close();
