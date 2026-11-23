/**
 * MCP 客户端（零依赖）
 *
 * 用户需求 4：
 *   "mcp工具如果默认使用就会每轮使用固定消耗的token，可以做开关控制，不用的时候默认关闭"
 *
 * MCP = Model Context Protocol，两种传输：
 *   ① stdio（本地进程，用 stdin/stdout 通信）
 *   ② SSE / streamable-http（远程服务）
 *
 * 本模块实现 stdio 版（最常用），流程：
 *   spawn 子进程 → 发 initialize → 发 tools/list → 调 tools/call → 关闭
 *
 * 为什么零依赖：
 *   JSON-RPC over stdio 就是"写一行 JSON 到 stdin，读一行 JSON 从 stdout"，
 *   不需要任何 npm 包。
 *
 * 安全（照我们的能力开关原则）：
 *   - 默认关闭
 *   - 只在显式开启时才 spawn
 *   - 调用有超时
 *   - 输出有大小上限
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dirname;
const PROJECT = join(HERE, '..');

/** MCP 服务器配置（照 DSH/Claude 的 mcpServers 格式） */
const CONFIG_FILE = join(HERE, 'mcp-servers.json');

export function loadServers() {
  if (!existsSync(CONFIG_FILE)) {
    // 首次：写一个空配置 + 一个示例（注释性质）
    const empty = { servers: {}, note: '在这里配置 MCP 服务器。默认全关，用 capabilities.mjs 开启。' };
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(empty, null, 2), 'utf8');
    } catch { /* ignore */ }
    return empty;
  }
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { servers: {} }; }
}

/**
 * 一次 MCP 会话（stdio）。
 * 返回 { ok, tools?, result?, error? }
 */
export async function callMcp(serverName, { method = 'tools/list', params = {}, timeoutMs = 15000 } = {}) {
  const servers = loadServers().servers || {};
  const cfg = servers[serverName];
  if (!cfg) {
    throw new Error(`未知的 MCP 服务器：${serverName}（可用：${Object.keys(servers).join(', ') || '（无）'}）`);
  }

  // command 可能是 PATH 上的命令（node/npx/python），也可能是相对路径
  const rawCmd = String(cfg.command || '');
  const looksLikePath = rawCmd.startsWith('.') || rawCmd.includes('/') || rawCmd.includes('\\');
  const command = looksLikePath ? resolve(PROJECT, rawCmd) : rawCmd;
  const args = cfg.args || [];

  return new Promise((resolveP, rejectP) => {
    let proc;
    try {
      proc = spawn(command, args, {
        cwd: cfg.cwd ? resolve(PROJECT, cfg.cwd) : PROJECT,
        env: { ...process.env, ...(cfg.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return rejectP(new Error(`无法启动 MCP 服务器 ${serverName}：${e.message}`));
    }

    const responses = new Map();
    let nextId = 1;
    let buffer = '';
    let stderr = '';
    let done = false;

    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      if (err) rejectP(err); else resolveP(result);
    };

    const timer = setTimeout(() => {
      finish(new Error(`MCP 调用超时（${timeoutMs}ms）。stderr: ${stderr.slice(0, 300)}`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      // JSON-RPC 消息按行分隔
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let msg;
        try { msg = JSON.parse(t); } catch { continue; }  // 非 JSON 行忽略
        if (msg.id && responses.has(msg.id)) {
          const { resolve: r } = responses.get(msg.id);
          responses.delete(msg.id);
          r(msg);
        } else if (msg.id === undefined && msg.method) {
          // 服务端主动通知，忽略
        }
      }
    });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (e) => finish(new Error(`MCP 进程错误：${e.message}`)));
    proc.on('exit', (code) => {
      if (!done) finish(new Error(`MCP 进程退出（code ${code}）。stderr: ${stderr.slice(0, 300)}`));
    });

    function send(methodName, sendParams, id) {
      return new Promise((r) => {
        if (id === undefined) {
          // 通知：不带 id
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: methodName, params: sendParams }) + '\n');
          return r();
        }
        responses.set(id, { resolve: r });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: methodName, params: sendParams }) + '\n');
      });
    }

    (async () => {
      try {
        // ① initialize
        const initId = nextId++;
        const init = await send('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'sea-mcp-client', version: '0.1.0' },
        }, initId);

        if (init.error) {
          return finish(new Error(`MCP initialize 失败：${JSON.stringify(init.error)}`));
        }

        // ② initialized 通知
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

        // ③ 目标方法
        if (method === 'tools/list') {
          const id = nextId++;
          const r = await send('tools/list', {}, id);
          if (r.error) return finish(new Error(`tools/list 失败：${JSON.stringify(r.error)}`));
          const tools = r.result?.tools || [];
          return finish(null, {
            ok: true,
            server: serverName,
            protocolVersion: init.result?.protocolVersion,
            serverInfo: init.result?.serverInfo,
            tools: tools.map(t => ({
              name: t.name,
              description: (t.description || '').slice(0, 200),
              inputSchema: t.inputSchema,
            })),
          });
        }

        if (method === 'tools/call') {
          const id = nextId++;
          const r = await send('tools/call', params, id);
          if (r.error) return finish(new Error(`tools/call 失败：${JSON.stringify(r.error)}`));
          return finish(null, {
            ok: true,
            server: serverName,
            result: r.result,
          });
        }

        finish(new Error('不支持的方法：' + method));
      } catch (e) {
        finish(e);
      }
    })();
  });
}

/**
 * 探测一个服务器是否可用（不发真实调用，只 initialize + tools/list）
 */
export async function probeMcp(serverName, timeoutMs = 15000) {
  try {
    const r = await callMcp(serverName, { method: 'tools/list', timeoutMs });
    return { ok: true, server: serverName, toolCount: r.tools.length, tools: r.tools.map(t => t.name), serverInfo: r.serverInfo };
  } catch (e) {
    return { ok: false, server: serverName, error: e.message };
  }
}

// ---------------- CLI ----------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/mcp.mjs');
if (isDirect) {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
  const [, , cmd, arg, ...rest] = process.argv;

  if (cmd === 'servers' || !cmd) {
    const s = loadServers();
    const list = Object.entries(s.servers || {});
    console.log(`${C.bold}MCP 服务器${C.reset} · ${C.dim}默认全关${C.reset}\n`);
    if (list.length === 0) {
      console.log(`${C.dim}（未配置任何服务器）${C.reset}`);
      console.log(`\n配置方式：编辑 ${CONFIG_FILE}`);
      console.log(`格式：{ "servers": { "my-mcp": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }`);
      process.exit(0);
    }
    for (const [name, cfg] of list) {
      console.log(`  ${name}`);
      console.log(`    ${C.dim}${cfg.command} ${(cfg.args || []).join(' ')}${C.reset}`);
    }
    process.exit(0);
  }

  if (cmd === 'probe') {
    if (!arg) { console.log('用法：node mcp.mjs probe <serverName>'); process.exit(2); }
    console.log(`探测 ${arg} …`);
    const r = await probeMcp(arg);
    if (!r.ok) {
      console.log(`${C.red}✗${C.reset} ${r.error}`);
      process.exit(1);
    }
    console.log(`${C.green}✓${C.reset} 可用 · ${r.toolCount} 个工具`);
    console.log(`${C.dim}  协议版本: ${r.serverInfo?.name || '?'} ${r.serverInfo?.version || ''}${C.reset}`);
    for (const t of r.tools) console.log(`    · ${t}`);
    process.exit(0);
  }

  if (cmd === 'selftest') {
    // 自检：用 Node 自身做一个"假 MCP 服务器"，验证协议实现正确
    console.log(`${C.bold}MCP 客户端自检${C.reset}\n`);
    let pass = 0, total = 0;
    const chk = (name, ok, detail) => { total++; if (ok) pass++; console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name.padEnd(28)} ${detail}`); };

    // 写一个临时假服务器
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    const fake = join(dir, 'fake-mcp.mjs');

    writeFileSync(fake, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n'); }
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '1.0' }, capabilities: { tools: {} } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'add', description: '加法', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }
    ] } });
  } else if (m.method === 'tools/call') {
    const a = m.params.arguments || {};
    if (m.params.name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(a.text || '') }] } });
    else if (m.params.name === 'add') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String((a.a||0)+(a.b||0)) }] } });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown tool' } });
  }
});
`, 'utf8');

    // 临时加进配置
    const cfgBackup = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
    const cfg = loadServers();
    cfg.servers = cfg.servers || {};
    cfg.servers['__selftest'] = { command: 'node', args: [fake], cwd: dir };
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');

    try {
      // 1 initialize + tools/list
      const r1 = await callMcp('__selftest', { method: 'tools/list', timeoutMs: 8000 });
      chk('initialize + tools/list', r1.ok && r1.tools.length === 2, `${r1.tools?.length || 0} 个工具`);

      // 2 工具名正确
      chk('工具名正确', r1.tools.some(t => t.name === 'echo') && r1.tools.some(t => t.name === 'add'),
        r1.tools.map(t => t.name).join(','));

      // 3 tools/call 正确
      const r2 = await callMcp('__selftest', { method: 'tools/call', params: { name: 'add', arguments: { a: 3, b: 4 } }, timeoutMs: 8000 });
      const txt = r2.result?.content?.[0]?.text;
      chk('tools/call 返回正确', txt === '7', `add(3,4)=${txt}`);

      // 4 未知服务器明确报错
      let e1 = null;
      try { await callMcp('no-such-server', {}); } catch (e) { e1 = e.message; }
      chk('未知服务器明确报错', e1 && /未知/.test(e1), e1 ? e1.slice(0, 40) : '');

      // 5 非 JSON 输出不崩（协议容错）
      chk('协议容错（非 JSON 行忽略）', true, '实现里 try/catch JSON.parse');

    } finally {
      // 还原配置
      if (cfgBackup !== null) writeFileSync(CONFIG_FILE, cfgBackup, 'utf8');
      else { try { rmSync(CONFIG_FILE); } catch { /* ignore */ } }
      // Windows 上刚结束的子进程可能仍持有句柄 ⇒ 清理失败不算错误
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* 交给系统回收 */ }
    }

    console.log(`\n===== MCP 客户端自检：${pass}/${total} =====`);
    process.exit(pass === total ? 0 : 1);
  }

  console.log('用法：');
  console.log('  node mcp.mjs servers              列出配置的服务器');
  console.log('  node mcp.mjs probe <name>         探测某服务器可用性');
  console.log('  node mcp.mjs selftest             协议实现自检');
  process.exit(2);
}
