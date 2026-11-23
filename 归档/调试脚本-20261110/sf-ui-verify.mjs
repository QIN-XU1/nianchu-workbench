/**
 * 验证 Sceneflow 面板在界面上真的能工作
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
function chk(n, ok, d = '') { total++; if (ok) pass++; else fails.push(n); console.log(`${ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${n.padEnd(38)} ${C.dim}${d}${C.reset}`); }

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.log('无主页面'); process.exit(1); }
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log(`${C.bold}Sceneflow 界面验证${C.reset}\n`);

  // 1 面板是否注册
  const reg = await cdp.eval(`(function(){
    return { has: !!(window.APP_RENDERERS && window.APP_RENDERERS['sf-board']), count: Object.keys(window.APP_RENDERERS||{}).length };
  })()`);
  chk('sf-board 渲染器已注册', reg.has, `共 ${reg.count} 种渲染器`);

  // 2 preload API
  const api = await cdp.eval(`(function(){
    return {
      board: typeof (window.app && window.app.sfBoard),
      pipes: typeof (window.app && window.app.sfPipelines),
      status: typeof (window.app && window.app.sfPipeStatus),
      claim: typeof (window.app && window.app.sfClaim),
    };
  })()`);
  chk('sfBoard API', api.board === 'function', api.board);
  chk('sfPipelines API', api.pipes === 'function', api.pipes);
  chk('sfPipeStatus API', api.status === 'function', api.status);
  chk('sfClaim API', api.claim === 'function', api.claim);

  // 3 IPC 真的返回数据
  const pipes = await cdp.eval(`(async function(){ try { return await window.app.sfPipelines(); } catch(e){ return {error:String(e)}; } })()`);
  chk('IPC 返回管线列表', pipes && Array.isArray(pipes) && pipes.length >= 2, `${Array.isArray(pipes) ? pipes.length : '?'} 条`);

  const st = await cdp.eval(`(async function(){ try { return await window.app.sfPipeStatus('build-software'); } catch(e){ return {error:String(e)}; } })()`);
  chk('IPC 返回管线状态', st && st.nodes && Object.keys(st.nodes).length === 5, `${st && st.nodes ? Object.keys(st.nodes).length : '?'} 节点`);

  const board = await cdp.eval(`(async function(){ try { return await window.app.sfBoard('competitor-analyze'); } catch(e){ return {error:String(e)}; } })()`);
  chk('IPC 返回产物看板', board && typeof board.artifactCount === 'number', `产物 ${board && board.artifactCount}`);

  // 4 切到管线场景，看面板是否真渲染
  console.log(`\n${C.bold}【切到「管线」场景】${C.reset}`);
  await cdp.eval(`(async function(){ try { await window.loadScenario('pipeline'); return 'ok'; } catch(e){ return 'err:'+e.message; } })()`);
  await new Promise(r => setTimeout(r, 3000));

  const rendered = await cdp.eval(`(function(){
    var panels = [].slice.call(document.querySelectorAll('.panel'));
    return panels.map(function(p){
      var body = p.querySelector('.panel-body');
      return {
        id: p.dataset.panelId,
        kind: body ? body.dataset.kind : '',
        text: body ? (body.textContent || '').slice(0, 120) : '',
        childCount: body ? body.children.length : 0,
      };
    });
  })()`);
  console.log(`  面板 ${rendered.length} 个:`);
  for (const p of rendered) {
    console.log(`    ${p.id.padEnd(14)} kind=${String(p.kind).padEnd(10)} 子元素=${p.childCount}  "${p.text.slice(0, 50)}"`);
  }

  const sfPanel = rendered.find(p => p.kind === 'sf-board');
  chk('sf-board 面板存在', !!sfPanel, sfPanel ? sfPanel.id : '无');
  chk('sf-board 有内容（非空白）', sfPanel && sfPanel.childCount > 0, sfPanel ? `${sfPanel.childCount} 子元素` : '');

  if (sfPanel) {
    const rich = await cdp.eval(`(function(){
      var p = [].slice.call(document.querySelectorAll('.panel')).find(function(x){ return (x.querySelector('.panel-body')||{}).dataset?.kind === 'sf-board'; });
      if (!p) return null;
      var body = p.querySelector('.panel-body');
      return {
        hasPipeline: body.textContent.includes('调研') || body.textContent.includes('research'),
        hasNodes: body.textContent.includes('竞品拆解') || body.textContent.includes('competitor'),
        hasInbox: body.textContent.includes('收件箱'),
        hasArtifacts: body.textContent.includes('产物'),
        textLen: body.textContent.length,
      };
    })()`);
    chk('面板显示管线节点', rich && rich.hasPipeline, rich ? 'textLen=' + rich.textLen : '');
    chk('面板显示收件箱区', rich && rich.hasInbox, '');
    chk('面板显示产物区', rich && rich.hasArtifacts, '');
  }

  // 5 场景数量
  const scenes = await cdp.eval(`(async function(){ try { return await window.app.listScenarios(); } catch(e){ return []; } })()`);
  chk('场景数 ≥10', scenes.length >= 10, `${scenes.length} 个: ${scenes.map(s => s.id).join(',')}`);

} finally {
  await cdp.close();
}

console.log(`\n${C.bold}===== 界面验证：${pass}/${total} =====${C.reset}`);
if (pass === total) console.log(`${C.green}Sceneflow 已接入界面并真实渲染${C.reset}`);
else console.log(`${C.yellow}未通过：${fails.join('；')}${C.reset}`);
process.exit(pass === total ? 0 : 1);
