/**
 * 找出 9 个"路径失效"节点的确切身份
 * 方法：在页面里重建神经元 build 逻辑的节点列表，逐个 stat
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
  console.log(`${C.bold}神经元节点逐个体检${C.reset}\n`);

  // 读取原始数据，重建节点清单
  const r = await cdp.eval(`(async function(){
    var P = window.app.paths;
    var F = window.app.file;
    var MEM = P.memRoot;
    var ROOT = MEM + '\\\\_共享记忆';
    var SKILL = (P.skillDir || '') && (P.skillDir.replace(/\\\\\\\\/g,'\\\\')).replace(/^\\\\dsh$/, '');

    async function readJson(p) {
      try { var r = await F.read(p); return r && r.text ? JSON.parse(r.text) : null; } catch(e) { return null; }
    }
    async function statOk(p) {
      if (!p) return false;
      try { var r = await F.stat(p); if (!r || r.ok === false || r.exists === false) return false; return !!(r.isDir || r.size != null || r.stat); } catch(e) { return false; }
    }

    var out = { nodes: [], bad: [], stats: { memRoot: MEM, skillDir: P.skillDir } };

    // 1 索引.json 里的 areas
    var idx = await readJson(ROOT + '\\\\索引.json');
    // 2 项目.json
    var reg = await readJson(ROOT + '\\\\项目.json');
    // 3 记忆地图.json
    var map = await readJson(ROOT + '\\\\记忆地图.json');

    // 重建会带 path 的节点
    var withPath = [];

    // 固定文档节点（照代码）
    withPath.push({ id: 'core', kind: 'core', path: ROOT });
    withPath.push({ id: 'doc-todo', kind: 'doc', path: MEM + '\\\\_待办.md' });
    withPath.push({ id: 'doc-msg', kind: 'doc', path: MEM + '\\\\_跨场景通知.md' });
    withPath.push({ id: 'doc-conf', kind: 'doc', path: ROOT + '\\\\冲突.md' });

    // areas（索引.json）
    (idx && idx.areas || []).forEach(function(a){
      withPath.push({ id: 'area-' + a.name, kind: 'area', path: ROOT + '\\\\' + String(a.file || '').replace(/\\//g,'\\\\') });
    });

    // 项目（项目.json）
    (reg && reg.projects || []).forEach(function(pr){
      withPath.push({ id: 'proj-' + (pr.id || pr.name), kind: 'project', path: (Array.isArray(pr.paths) && pr.paths[0]) || '' });
    });

    // 私有记忆（记忆地图）
    (map && map.areas || []).forEach(function(a){
      (a.privateMemory || []).forEach(function(pm){
        withPath.push({ id: 'mem-' + a.panel + '-' + pm, kind: 'memory', path: MEM + '\\\\' + String(pm).replace(/\\//g,'\\\\') });
      });
    });

    // 技能（skills 目录）
    if (P.skillDir) {
      try {
        var lr = await (window.app.oa && window.app.oa.filesLocal ? window.app.oa.filesLocal(P.skillDir) : null);
        if (lr && lr.rows) {
          lr.rows.filter(function(it){ return it && it.isDir; }).forEach(function(it){
            withPath.push({ id: 'skill-' + it.name, kind: 'skill', path: P.skillDir + '\\\\' + it.name + '\\\\SKILL.md' });
          });
        }
      } catch(e) {}
    }

    // 逐个校验
    for (var n of withPath) {
      var ok = await statOk(n.path);
      n.ok = ok;
      n.pathShort = (n.path || '(空)').replace(MEM, '<mem>');
      out.nodes.push(n);
      if (!ok) out.bad.push(n);
    }

    out.counts = {
      total: withPath.length,
      bad: out.bad.length,
      byKind: {},
    };
    withPath.forEach(function(n){ out.counts.byKind[n.kind] = (out.counts.byKind[n.kind]||0)+1; });

    return out;
  })()`);

  console.log(`  节点总数: ${r.counts.total}  失效: ${r.counts.bad}`);
  console.log(`  按类型: ${JSON.stringify(r.counts.byKind)}`);
  console.log();

  if (r.bad.length) {
    console.log(`${C.bold}失效节点明细${C.reset}`);
    for (const b of r.bad) {
      console.log(`  ${C.red}X${C.reset} ${b.kind.padEnd(10)} ${String(b.id).padEnd(28)} ${b.pathShort}`);
    }
  } else {
    console.log(`${C.green}没有失效节点（可能与页面实际计数不同，因为页面含动态项）${C.reset}`);
  }

} finally {
  await cdp.close();
}
