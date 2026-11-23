/**
 * 精确找出哪 2 个节点的路径失效
 * 方法：在运行时逐个 stat 神经元会检查的所有候选路径
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
    return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + ' 超时')); } }, 30000); });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
    return r.result?.value;
  }
  async close() { const ws = this.ws; if (!ws) return; this.ws = null; try { await new Promise(r => { ws.addEventListener('close', r); ws.close(); setTimeout(r, 500); }); } catch { /* ignore */ } }
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

try {
  const r = await cdp.eval(`(async function(){
    var P = window.app.paths;
    var F = window.app.file;
    var MEM = P.memRoot;
    var ROOT = MEM + '\\\\_共享记忆';
    var out = { paths: [], ok: [], bad: [] };

    // 神经元会检查的所有固定节点路径（照 renderers.js 的代码）
    var candidates = [
      { id: 'core', label: 'DSH 记忆(根)', p: ROOT },
      { id: 'doc-todo', label: '待办', p: MEM + '\\\\_待办.md' },
      { id: 'doc-msg', label: '通知', p: MEM + '\\\\_跨场景通知.md' },
      { id: 'doc-conf', label: '冲突', p: ROOT + '\\\\冲突.md' },
      { id: 'idx', label: '索引.json', p: ROOT + '\\\\索引.json' },
      { id: 'proj', label: '项目.json', p: ROOT + '\\\\项目.json' },
      { id: 'map', label: '记忆地图.json', p: ROOT + '\\\\记忆地图.json' },
      { id: 'idxmd', label: '索引.md', p: ROOT + '\\\\索引.md' },
      { id: 'health', label: '体检结果.json', p: ROOT + '\\\\体检结果.json' },
      { id: 'chain', label: '提交链(目录)', p: ROOT + '\\\\提交链' },
    ];

    for (var c of candidates) {
      var st = null;
      try { st = await F.stat(c.p); } catch(e) { st = { ok:false, err:String(e).slice(0,60) }; }
      var exists = !!(st && st.ok !== false);
      out.paths.push({ id: c.id, label: c.label, path: c.p.replace(MEM, '<mem>'), exists: exists, err: st && st.err });
      if (exists) out.ok.push(c.id); else out.bad.push(c.id + ' / ' + c.label + ' / ' + c.p.replace(MEM, '<mem>'));
    }

    // 再查 skills 目录
    var SK = P.skillDir || '';
    if (SK) {
      try {
        var lr = await F.stat(SK);
        out.skillDir = { path: SK, ok: !!(lr && lr.ok !== false), err: lr && lr.err };
      } catch(e) { out.skillDir = { path: SK, err: String(e).slice(0,60) }; }
    }

    return out;
  })()`);

  console.log(`${C.bold}逐个路径 stat 结果${C.reset}\n`);
  console.log(`${'节点'.padEnd(16)} ${'路径'.padEnd(32)} 存在`);
  console.log('-'.repeat(64));
  for (const p of r.paths) {
    console.log(`${p.id.padEnd(16)} ${String(p.path).padEnd(32)} ${p.exists ? C.green + '是' + C.reset : C.red + '否' + C.reset}${p.err ? '  ' + p.err : ''}`);
  }

  if (r.skillDir) {
    console.log(`\nskills 目录: ${r.skillDir.path}  ${r.skillDir.ok ? C.green + '存在' + C.reset : C.red + '不存在' + C.reset}`);
  }

  console.log(`\n${C.bold}失效清单${C.reset}（${r.bad.length} 个）`);
  for (const b of r.bad) console.log('  ' + C.red + 'X' + C.reset + ' ' + b);

} finally {
  await cdp.close();
}
