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
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 60000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const fs = await import('node:fs');
const path = await import('node:path');
const os = await import('node:os');
const zlib = await import('node:zlib');

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 端到端派单验证 ═══');
console.log();

// ① 取 command 场景的 sessionId
const sid = await cdp.eval(`(async function(){
  var sc = await window.app.getScenario('command');
  var h = (sc.panels || []).find(function(p){ return p.type === 'harness'; });
  return h ? h.sessionId : '';
})()`);
console.log('① 目标会话: ' + sid);

// ② 计算当前会话文件行数（派单前基线）
const SESS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
function findSessionFile(s) {
  for (const ws of fs.readdirSync(SESS_ROOT)) {
    const f = path.join(SESS_ROOT, ws, s, 'session.v4.jsonl.zstd');
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function decompressAll(buf) {
  const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
  let off = 0; const frames = [];
  while (off < buf.length) {
    const next = buf.indexOf(MAGIC, off + 1);
    const end = next < 0 ? buf.length : next;
    try { frames.push(zlib.zstdDecompressSync(buf.subarray(off, end))); } catch (e) { /* ignore */ }
    if (next < 0) break;
    off = next;
  }
  return Buffer.concat(frames).toString('utf8');
}

const f = findSessionFile(sid);
if (!f) { console.log('找不到会话文件'); process.exit(1); }
const beforeLines = decompressAll(fs.readFileSync(f)).split('\n').filter(Boolean).length;
console.log('② 派单前会话行数: ' + beforeLines);

// ③ 派单（用一个独一无二的标记，方便验证）
const MARKER = 'E2E-TEST-' + Date.now();
const TASK = '请在回复里原样包含这串标记：' + MARKER + '。只输出这个标记本身，不要别的。';
console.log();
console.log('③ 派单任务: ' + TASK);

const res = await cdp.eval(`(async function(){
  try {
    var r = await window.app.engine.prompt(${JSON.stringify(sid)}, ${JSON.stringify(TASK)});
    return r;
  } catch(e) { return { error: String(e) }; }
})()`);
console.log('   派单响应: ' + JSON.stringify(res).slice(0, 200));

// ④ 等 30 秒让它执行
console.log();
console.log('④ 等待 30 秒执行…');
await new Promise(r => setTimeout(r, 30000));

// ⑤ 读会话文件验证
const afterText = decompressAll(fs.readFileSync(f));
const afterLines = afterText.split('\n').filter(Boolean).length;
const hasMarker = afterText.includes(MARKER);

console.log();
console.log('⑤ 派单后:');
console.log('   会话行数: ' + beforeLines + ' → ' + afterLines);
console.log('   出现标记: ' + hasMarker);

// 找出含标记的上下文
if (hasMarker) {
  const idx = afterText.indexOf(MARKER);
  console.log('   上下文: ...' + afterText.slice(Math.max(0, idx - 60), idx + 60).replace(/\\n/g, ' ') + '...');
}

// ⑥ 也看看界面上的显示
const uiText = await cdp.eval(`(function(){
  var b = document.querySelector('.panel-body[data-kind="harness"]');
  return b ? (b.innerText || '').slice(0, 300) : '(无 harness 面板)';
})()`);
console.log();
console.log('⑥ harness 面板文本: "' + String(uiText).replace(/\n/g, ' | ').slice(0, 200) + '"');

console.log();
console.log('═══ 结论 ═══');
if (hasMarker) {
  console.log('  ✅ 派单链路完整可用：主 Agent → 主进程 → 引擎 RPC → 会话执行 → 回复落盘');
} else if (afterLines > beforeLines) {
  console.log('  ⚠ 会话有新内容但未见标记（可能还在执行或模型没照办）');
} else {
  console.log('  ❌ 派单未生效');
}

cdp.close();
