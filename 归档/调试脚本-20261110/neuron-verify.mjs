/**
 * 记忆神经元验证：它到底能不能读到数据、能不能写入
 */

const CDP_PORT = 9333;
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
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 25000); });
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
function chk(n, ok, d = '') { total++; if (ok) pass++; else fails.push(n); console.log(`${ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${n.padEnd(40)} ${C.dim}${d}${C.reset}`); }

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.log('无主页面'); process.exit(1); }
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}记忆神经元验证${C.reset}\n`);

  // 1 memRoot 是否修好
  const paths = await cdp.eval(`(function(){
    var p = (window.app && window.app.paths) || {};
    return { memRoot: p.memRoot || '', skillDir: p.skillDir || '' };
  })()`);
  chk('memRoot 已非空', !!paths.memRoot, paths.memRoot || '(空)');
  chk('memRoot 指向真实目录', paths.memRoot.includes('引擎数据'), paths.memRoot);

  // 2 切到命令场景（它用 neuron 面板）
  console.log(`\n${C.bold}【切到「命令」场景（含神经元面板）】${C.reset}`);
  await cdp.eval(`(async function(){ try { await window.loadScenario('command'); return 'ok'; } catch(e){ return 'err:'+e.message; } })()`);
  await new Promise(r => setTimeout(r, 4000));

  const rendered = await cdp.eval(`(function(){
    var panels = [].slice.call(document.querySelectorAll('.panel'));
    return panels.map(function(p){
      var body = p.querySelector('.panel-body');
      return {
        id: p.dataset.panelId,
        kind: body ? body.dataset.kind : '',
        textLen: body ? (body.textContent || '').length : 0,
        hasCanvas: body ? body.querySelectorAll('canvas').length : 0,
        hasSvg: body ? body.querySelectorAll('svg').length : 0,
        text: body ? (body.textContent || '').slice(0, 100) : '',
      };
    });
  })()`);
  console.log(`  面板 ${rendered.length} 个:`);
  for (const p of rendered) {
    console.log(`    ${p.id.padEnd(14)} kind=${String(p.kind).padEnd(10)} 文本=${String(p.textLen).padStart(4)} canvas=${p.hasCanvas} svg=${p.hasSvg}`);
    if (p.text) console.log(`      "${p.text.slice(0, 70)}"`);
  }

  const neuron = rendered.find(p => p.kind === 'neuron');
  chk('神经元面板存在', !!neuron, neuron ? neuron.id : '无');

  if (neuron) {
    chk('神经元有渲染产物（canvas/svg）', neuron.hasCanvas > 0 || neuron.hasSvg > 0 || neuron.textLen > 20,
      `canvas=${neuron.hasCanvas} svg=${neuron.hasSvg} 文本=${neuron.textLen}`);
    chk('神经元不是空白错误', !/读取失败|无法加载|不存在|no data/i.test(neuron.text), neuron.text.slice(0, 60));
  }

  // 3 深层探测：神经元内部状态
  const deep = await cdp.eval(`(function(){
    // 找 neuron 相关的全局状态
    var out = {};
    try {
      if (window.__neuronState) out.state = Object.keys(window.__neuronState);
      if (window.__kunNeuron) out.kunNeuron = Object.keys(window.__kunNeuron);
    } catch(e){ out.err = String(e); }
    // 找 canvas 上的节点数
    var p = [].slice.call(document.querySelectorAll('.panel')).find(function(x){
      return (x.querySelector('.panel-body')||{}).dataset?.kind === 'neuron';
    });
    if (p) {
      var body = p.querySelector('.panel-body');
      var cv = body.querySelector('canvas');
      if (cv) { out.canvasW = cv.width; out.canvasH = cv.height; }
      out.bodyText = (body.textContent || '').slice(0, 200);
      out.drawnText = body.innerText ? body.innerText.slice(0, 200) : '';
    }
    return out;
  })()`);
  console.log(`\n  ${C.bold}神经元内部:${C.reset} ${JSON.stringify(deep).slice(0, 300)}`);

  // 4 神经元读的数据源是否存在
  console.log(`\n${C.bold}【数据源检查】${C.reset}`);
  const dataCheck = await cdp.eval(`(async function(){
    try {
      var P = (window.app && window.app.paths) || {};
      var F = (window.app && window.app.file) || null;
      if (!F) return { error: '无 file API' };
      var root = P.memRoot;
      var res = {};
      // 试读几个关键文件
      for (var rel of ['\\\\_共享记忆\\\\索引.json', '\\\\_共享记忆\\\\记忆地图.json', '\\\\命令\\\\场景私有记忆.md']) {
        try {
          var r = await F.read(root + rel);
          res[rel] = r ? ('OK ' + String(r).length + ' bytes') : 'null';
        } catch(e) { res[rel] = 'ERR ' + e.message; }
      }
      return res;
    } catch(e) { return { error: String(e) }; }
  })()`);
  console.log(`  ${JSON.stringify(dataCheck, null, 2).slice(0, 500)}`);

} finally {
  await cdp.close();
}

console.log(`\n${C.bold}===== 神经元验证：${pass}/${total} =====${C.reset}`);
if (pass === total) console.log(`${C.green}神经元能读到真实数据${C.reset}`);
else console.log(`${C.yellow}未通过：${fails.join('；')}${C.reset}`);
process.exit(pass === total ? 0 : 1);
