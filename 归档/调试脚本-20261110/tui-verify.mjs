/**
 * 终端模式界面验证 + 截图
 */

import fs from 'node:fs';
import path from 'node:path';

const CDP_PORT = 9333;
const OUT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens`;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

class CDP {
  constructor(u) { this.u = u; this.ws = null; this.id = 1; this.p = new Map(); }
  async connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.u); this.ws = ws;
      const t = setTimeout(() => rej(new Error('超时')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); res(); });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
      ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 30000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 500); }); } catch { /* ignore */ } }
}

let pass = 0, total = 0;
const fails = [];
function chk(n, ok, d = '') { total++; if (ok) pass++; else fails.push(n); console.log(`${ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${n.padEnd(36)} ${C.dim}${d}${C.reset}`); }

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.log('无主页面'); process.exit(1); }
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}终端模式界面验证${C.reset}\n`);

  // 1 API 就绪
  const api = await cdp.eval(`(function(){
    return {
      hasApi: typeof window.__tuiTerminal_API === 'object',
      state: window.__tuiTerminal_API ? window.__tuiTerminal_API.state() : null,
      tuiMode: document.body.dataset.tuiMode || '(未设置)',
      theme: document.body.dataset.tuiTheme || '(未设置)',
    };
  })()`);
  chk('API 已加载', api.hasApi, `hasApi=${api.hasApi}`);
  chk('终端模式已启用', api.tuiMode === 'on', `data-tui-mode=${api.tuiMode}`);
  chk('主题已应用', !!api.theme && api.theme !== '(未设置)', `data-tui-theme=${api.theme}`);

  // 2 状态栏
  const bar = await cdp.eval(`(function(){
    var s = document.getElementById('tui-statusbar');
    var h = document.getElementById('tui-hintbar');
    return {
      statusExists: !!s,
      statusText: s ? s.textContent.trim() : '',
      statusHeight: s ? Math.round(s.getBoundingClientRect().height) : 0,
      hintExists: !!h,
      hintText: h ? h.textContent.trim() : '',
      hintHeight: h ? Math.round(h.getBoundingClientRect().height) : 0,
      themePicker: document.querySelectorAll('.tui-theme-picker button').length,
    };
  })()`);
  chk('顶部状态栏存在', bar.statusExists, `${bar.statusHeight}px`);
  chk('状态栏有内容', bar.statusText.length > 10, `"${bar.statusText.slice(0, 70)}"`);
  chk('底部提示栏存在', bar.hintExists, `${bar.hintHeight}px`);
  chk('提示栏有内容', bar.hintText.length > 5, `"${bar.hintText.slice(0, 60)}"`);
  chk('主题选择器有 5 个按钮', bar.themePicker === 5, `${bar.themePicker} 个`);

  // 3 样式是否生效（关键：验证 CSS 变量）
  const styles = await cdp.eval(`(function(){
    var body = getComputedStyle(document.body);
    var panel = document.querySelector('.panel');
    var pcs = panel ? getComputedStyle(panel) : null;
    return {
      bodyBg: body.backgroundColor,
      bodyColor: body.color,
      panelBorder: pcs ? pcs.borderTopColor : '(无面板)',
      panelRadius: pcs ? pcs.borderTopLeftRadius : '(无)',
      panelShadow: pcs ? pcs.boxShadow : '(无)',
      accentVar: getComputedStyle(document.documentElement).getPropertyValue('--tui-accent').trim(),
    };
  })()`);
  console.log(`  样式实测：`);
  console.log(`    body 背景 = ${styles.bodyBg}`);
  console.log(`    body 文字 = ${styles.bodyColor}`);
  console.log(`    面板边框 = ${styles.panelBorder}`);
  console.log(`    面板圆角 = ${styles.panelRadius}`);
  console.log(`    面板阴影 = ${styles.panelShadow}`);
  console.log(`    --tui-accent = ${styles.accentVar}`);
  chk('CSS 变量已生效', styles.accentVar && styles.accentVar !== '', styles.accentVar);
  chk('面板圆角已归零', styles.panelRadius === '0px' || styles.panelRadius === '0', `实际 ${styles.panelRadius}`);
  chk('面板无阴影', styles.panelShadow === 'none', `实际 ${styles.panelShadow}`);

  // 4 切主题
  console.log(`\n${C.bold}【主题切换测试】${C.reset}`);
  for (const theme of ['dark', 'light', 'pink-night']) {
    await cdp.eval(`window.__tuiTerminal_API.theme('${theme}')`);
    await new Promise(r => setTimeout(r, 300));
    const s2 = await cdp.eval(`(function(){
      var b = getComputedStyle(document.body);
      return { theme: document.body.dataset.tuiTheme, bg: b.backgroundColor };
    })()`);
    console.log(`  ${theme.padEnd(12)} → data-tui-theme=${s2.theme}  bg=${s2.bg}`);
    chk(`切换到 ${theme}`, s2.theme === theme, s2.bg);
  }
  await cdp.eval(`window.__tuiTerminal_API.theme('auto')`);

  // 5 截图
  console.log(`\n${C.bold}【截图】${C.reset}`);
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  // 切到管线场景（有内容）
  await cdp.eval(`(async function(){ try { await window.loadScenario('pipeline'); } catch(e){} })()`);
  await new Promise(r => setTimeout(r, 3000));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    const f = path.join(OUT, 'tui-01-pipeline.png');
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log(`  已保存 ${f}`);
    chk('截图成功', true, `${fs.statSync(f).size} bytes`);
  }

  // 切关系军师
  await cdp.eval(`(async function(){ try { await window.loadScenario('relationship'); } catch(e){} })()`);
  await new Promise(r => setTimeout(r, 3000));
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (shot2 && shot2.data) {
    const f2 = path.join(OUT, 'tui-02-relationship.png');
    fs.writeFileSync(f2, Buffer.from(shot2.data, 'base64'));
    console.log(`  已保存 ${f2}`);
  }

  // 命令场景（神经元）
  await cdp.eval(`(async function(){ try { await window.loadScenario('command'); } catch(e){} })()`);
  await new Promise(r => setTimeout(r, 3000));
  const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (shot3 && shot3.data) {
    const f3 = path.join(OUT, 'tui-03-neuron.png');
    fs.writeFileSync(f3, Buffer.from(shot3.data, 'base64'));
    console.log(`  已保存 ${f3}`);
  }

} finally {
  await cdp.close();
}

console.log(`\n${C.bold}===== 终端模式验证：${pass}/${total} =====${C.reset}`);
if (pass === total) console.log(`${C.green}终端美学已生效${C.reset}`);
else console.log(`${C.yellow}未通过：${fails.join('；')}${C.reset}`);
process.exit(pass === total ? 0 : 1);
