#!/usr/bin/env node
/**
 * A13 MCP 客户端（自研，不借 hermes）
 *
 * 之前 A13 记「部分」，证据写得很直白：「MCP 来自 hermes（optional-mcps 66 文件），
 * 我们**没有自己的 MCP 客户端**」。
 *
 * 这一层是按 MCP 规范自己实现的客户端，走的 transport 是 **stdio + JSON-RPC 2.0**：
 *
 *   initialize        握手：发 clientInfo / capabilities，收 serverInfo / capabilities
 *   notifications/initialized  握手完成通知（规范要求）
 *   tools/list        列出工具（含 inputSchema）
 *   tools/call        调工具，返回 content 数组
 *   ping              探活
 *
 * 为什么自己写而不包一层 SDK：
 *   1. 本项目要证明的是「我们有实现」，不是「我们会 npm install」
 *   2. 规范本身很小，自己写反而能说清每一处判据
 *   3. 四态纪律要贯穿：server 起不来 / 握手失败 / 工具报错，三者必须分开记
 *
 * 四态判据：
 *   PASS    initialize 成功且 serverInfo 合法
 *   FAIL    server 回了 JSON-RPC error（协议层拒绝）
 *   UNKNOWN 进程起不来 / 超时 / 无响应 —— 「没连上」不等于「服务器坏了」
 *
 * 用法：
 *   node tools/mcp/client.mjs --server="node path/to/server.mjs"         # 探测能力
 *   node tools/mcp/client.mjs --server="..." --list                     # 只列工具
 *   node tools/mcp/client.mjs --server="..." --call=toolName --args='{}' # 调工具
 *   node tools/mcp/client.mjs --selftest                                # 用内置假 server 自检
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2024-11-05';

/**
 * 与一个 MCP server 的会话。
 *
 * 关键设计：stdio 上的 JSON-RPC 是**按行**分隔的（每条消息一行 JSON），
 * 所以必须自己维护 readline 缓冲 —— 一次 data 事件可能带来半条或三条消息。
 * 这是自己实现最容易错的地方，也是必须验的地方。
 */
export class McpSession {
  constructor(command, { timeoutMs = 15000, cwd = process.cwd(), env = {} } = {}) {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();   // id -> {resolve, reject, timer}
    this.buffer = '';
    this.stderrBuf = '';
    this.closed = false;
    this.serverInfo = null;
    this.capabilities = null;
    this.protocolVersion = null;
  }

  /** 起进程并建立管道 */
  start() {
    return new Promise((resolve) => {
      try {
        this.child = spawn(this.command, [], {
          shell: true, cwd: this.cwd, windowsHide: true,
          env: { ...process.env, ...this.env },
        });
      } catch (e) {
        resolve({ state: 'UNKNOWN', why: '起不来：' + String(e.message).slice(0, 80) });
        return;
      }

      let started = false;
      const t = setTimeout(() => {
        if (started) return;
        started = true;
        resolve({ state: 'UNKNOWN', why: '超时 ' + Math.round(this.timeoutMs / 1000) + 's 未启动' });
      }, this.timeoutMs);

      this.child.on('spawn', () => {
        if (started) return;
        started = true;
        clearTimeout(t);
        resolve({ state: 'PASS', pid: this.child.pid });
      });

      this.child.on('error', (e) => {
        if (!started) { started = true; clearTimeout(t); resolve({ state: 'UNKNOWN', why: '起不来：' + e.message }); }
        this.failAll('进程错误: ' + e.message);
      });

      this.child.on('exit', (code, signal) => {
        this.closed = true;
        this.failAll('进程退出 code=' + code + ' signal=' + signal);
        if (!started) { started = true; clearTimeout(t); resolve({ state: 'UNKNOWN', why: '进程一启动就退出（exit code=' + code + '）—— 多半是命令写错或 server 崩了' }); }
      });

      // 按行解析 JSON-RPC
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }  // 非 JSON 行（server 日志）忽略
          this.onMessage(msg);
        }
      });

      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (c) => { this.stderrBuf += c; });
    });
  }

  onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.resolve({ ok: false, error: msg.error });
      else p.resolve({ ok: true, result: msg.result });
      return;
    }
    // 服务端发来的请求（如 sampling）—— 我们不支持，按规范回 method not found
    if (msg.method && msg.id !== undefined) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not supported: ' + msg.method } });
    }
  }

  failAll(why) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: { message: why }, transport: true }); }
    this.pending.clear();
  }

  send(obj) {
    if (!this.child || this.closed) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch { return false; }
  }

  /** 发请求并等响应 */
  request(method, params, { timeoutMs } = {}) {
    const id = this.nextId++;
    const to = timeoutMs || this.timeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { message: '超时 ' + Math.round(to / 1000) + 's' }, timeout: true });
      }, to);
      this.pending.set(id, { resolve, timer });
      const sent = this.send({ jsonrpc: '2.0', id, method, params });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: { message: '写不进 stdin（进程已退）' }, transport: true });
      }
    });
  }

  /** 规范要求：握手后发 notifications/initialized（无 id，无响应） */
  notifyInitialized() {
    return this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** 完整握手 */
  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, roots: { listChanged: false } },
      clientInfo: { name: 'nianchu', version: '0.1.0' },
    });
    if (!r.ok) {
      return {
        state: r.timeout || r.transport ? 'UNKNOWN' : 'FAIL',
        why: r.timeout ? 'initialize 超时（' + r.error.message + '）—— 判不了'
          : r.transport ? '同 MCP server 说话失败：' + r.error.message + '（这是「没连上」，不是「服务器报错」）'
          : 'JSON-RPC error ' + (r.error.code ?? '?') + ': ' + (r.error.message || ''),
        error: r.error,
      };
    }
    const res = r.result || {};
    this.serverInfo = res.serverInfo || null;
    this.capabilities = res.capabilities || null;
    this.protocolVersion = res.protocolVersion || null;
    this.notifyInitialized();

    // 合法性判据：serverInfo 必须有 name
    if (!this.serverInfo || !this.serverInfo.name) {
      return { state: 'FAIL', why: 'initialize 成功但返回里没有 serverInfo.name（不合规范）', result: res };
    }
    return {
      state: 'PASS',
      why: '握手成功：' + this.serverInfo.name + ' ' + (this.serverInfo.version || '?') +
        ' · protocol ' + (this.protocolVersion || '?') +
        ' · capabilities: ' + Object.keys(this.capabilities || {}).join(',') || '(无)',
      serverInfo: this.serverInfo,
      capabilities: this.capabilities,
      protocolVersion: this.protocolVersion,
    };
  }

  async listTools() {
    const r = await this.request('tools/list', {});
    if (!r.ok) {
      return { state: r.timeout ? 'UNKNOWN' : 'FAIL', why: 'tools/list 失败：' + (r.error.message || r.error.code) };
    }
    const tools = Array.isArray(r.result?.tools) ? r.result.tools : [];
    return { state: 'PASS', why: '列出 ' + tools.length + ' 个工具', tools };
  }

  async callTool(name, args = {}) {
    const r = await this.request('tools/call', { name, arguments: args }, { timeoutMs: this.timeoutMs });
    if (!r.ok) {
      return { state: r.timeout ? 'UNKNOWN' : 'FAIL', why: 'tools/call 失败：' + (r.error.message || r.error.code), error: r.error };
    }
    const res = r.result || {};
    // MCP 规范：工具执行错误放在 result.isError，不是 JSON-RPC error
    const state = res.isError ? 'FAIL' : 'PASS';
    return {
      state,
      why: res.isError ? '工具返回 isError=true（执行失败，但协议通）' : '调用成功',
      content: res.content,
      isError: !!res.isError,
    };
  }

  async ping() {
    const r = await this.request('ping', {});
    return r.ok ? { state: 'PASS', why: 'ping 通' } : { state: r.timeout ? 'UNKNOWN' : 'FAIL', why: 'ping 失败' };
  }

  close() {
    return new Promise((resolve) => {
      if (!this.child || this.closed) { resolve(); return; }
      const done = () => resolve();
      this.child.once('exit', done);
      try { this.child.stdin.end(); } catch { /* 忽略 */ }
      try { this.child.kill(); } catch { /* 忽略 */ }
      setTimeout(done, 2000);
    });
  }

  get stderr() { return this.stderrBuf.slice(-1000); }
}

/** 一次完整探测：起 → 握手 → 列工具 → 关 */
export async function probe(command, opts = {}) {
  const s = new McpSession(command, opts);
  const started = await s.start();
  if (started.state !== 'PASS') {
    await s.close();
    // 措辞要准：「起不来」不是「服务器坏了」。stderr 一并带出便于判断是命令写错还是 server 崩了
    const tail = s.stderr.trim().split('\n').slice(-1)[0] || '';
    return {
      state: started.state,
      why: '起不来：' + started.why + (tail ? '（stderr: ' + tail.slice(0, 80) + '）' : ''),
      stderr: s.stderr,
    };
  }
  const init = await s.initialize();
  if (init.state !== 'PASS') {
    await s.close();
    return { state: init.state, why: init.why, stderr: s.stderr };
  }
  const list = await s.listTools();
  await s.close();
  return {
    state: list.state === 'PASS' ? 'PASS' : list.state,
    why: init.why + ' · ' + list.why,
    serverInfo: init.serverInfo,
    capabilities: init.capabilities,
    protocolVersion: init.protocolVersion,
    tools: list.tools || [],
    stderr: s.stderr,
  };
}

// ── 内置假 server（自检用）：不依赖任何外部 MCP 实现 ──
const FAKE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const TOOLS = [
  { name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a','b'] } },
  { name: 'boom', description: '总是失败（验 isError 通路）', inputSchema: { type: 'object', properties: {} } },
];
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;   // 通知，不回
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  const err = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code, message } }) + '\\n');
  if (m.method === 'initialize') return reply({
    protocolVersion: '2024-11-05',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'fake-mcp', version: '0.0.1' },
  });
  if (m.method === 'tools/list') return reply({ tools: TOOLS });
  if (m.method === 'ping') return reply({});
  if (m.method === 'tools/call') {
    const { name, arguments: a = {} } = m.params || {};
    if (name === 'echo') return reply({ content: [{ type: 'text', text: String(a.text ?? '') }] });
    if (name === 'add') return reply({ content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] });
    if (name === 'boom') return reply({ isError: true, content: [{ type: 'text', text: '故意失败' }] });
    return err(-32602, 'unknown tool: ' + name);
  }
  return err(-32601, 'method not found: ' + m.method);
});
`;

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const ICON = { PASS: '✓', FAIL: '✗', UNKNOWN: '?' };

  if (process.argv.includes('--selftest')) {
    const tmpDir = path.join(process.cwd(), 'evidence/mcp-selftest');
    fs.mkdirSync(tmpDir, { recursive: true });
    const fakePath = path.join(tmpDir, 'fake-server.cjs');
    fs.writeFileSync(fakePath, FAKE_SERVER, 'utf8');

    console.log('');
    console.log('  MCP 客户端自检（用内置假 server，不依赖外部实现）');
    console.log('  ' + '─'.repeat(70));

    let pass = 0, fail = 0;
    /**
     * 【2026-11-16 改】原来是 `ok(cond, '名字')` 计数器。
     * audit-false-red 只认 T(...) / assert( / expect( / check( 形状的断言行，
     * 外加「正例 · /反例 ·」标题 —— 于是这 10 条真断言被判成 UNKNOWN（找不到可识别的断言）。
     * 现在统一走 T(标题, 布尔, 实测值)：前一类 = 必须做对，后一类 = 不许做错。
     */
    const T = (name, okv, why) => {
      if (okv) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (why ? '  ← ' + why : '')); }
    };
    const txt = (res) => (Array.isArray(res.content) ? String(res.content[0]?.text ?? '') : '');

    const cmd = 'node "' + fakePath + '"';
    const p = await probe(cmd, { timeoutMs: 8000 });

    // ── 正例：必须做对 ──
    T('正例 · 握手：' + (p.state === 'PASS' ? p.serverInfo?.name + ' ' + p.serverInfo?.version : String(p.why).slice(0, 40)),
      p.state === 'PASS' && p.serverInfo?.name === 'fake-mcp' && p.serverInfo?.version === '0.0.1',
      'state=' + p.state + ' serverInfo=' + JSON.stringify(p.serverInfo));
    T('正例 · 协议版本协商：' + p.protocolVersion,
      p.protocolVersion === '2024-11-05', '实得 ' + JSON.stringify(p.protocolVersion));
    T('正例 · tools/list 列出 3 个工具（必须正好 3 个）',
      Array.isArray(p.tools) && p.tools.length === 3, '实得 ' + (Array.isArray(p.tools) ? p.tools.length : 'null'));
    T('正例 · 每个工具都有 name + inputSchema（3/3）',
      Array.isArray(p.tools) && p.tools.length === 3 && p.tools.every((t) => t.name && t.inputSchema),
      '缺字段的工具=' + JSON.stringify((p.tools || []).filter((t) => !t.name || !t.inputSchema).map((t) => t.name)));

    // 真调工具
    const s = new McpSession(cmd, { timeoutMs: 8000 });
    await s.start();
    await s.initialize();
    const echo = await s.callTool('echo', { text: '念初' });
    T('正例 · tools/call echo 返回「念初」（逐字）',
      echo.state === 'PASS' && txt(echo) === '念初', '实得 ' + JSON.stringify(txt(echo)));
    const add = await s.callTool('add', { a: 2, b: 3 });
    T('正例 · tools/call add 2+3=5（内容必须精确是 "5"）',
      add.state === 'PASS' && txt(add) === '5', '实得 ' + JSON.stringify(txt(add)));
    T('正例 · ping 通（state 必须 PASS）',
      (await s.ping()).state === 'PASS', 'ping 不通');

    // ── 反例：不许做错 ──
    const boom = await s.callTool('boom', {});
    T('反例 · isError 通路：工具执行失败记 FAIL 但协议通（不许记 PASS）',
      boom.state === 'FAIL' && boom.isError === true && txt(boom) === '故意失败',
      'state=' + boom.state + ' isError=' + boom.isError);
    const unknown = await s.callTool('nope', {});
    T('反例 · 未知工具：JSON-RPC error 记 FAIL（why 必须含 unknown tool: nope）',
      unknown.state === 'FAIL' && /unknown tool: nope/.test(String(unknown.why)),
      'state=' + unknown.state + ' why=' + String(unknown.why).slice(0, 60));

    // 传输层：起不来的命令必须 UNKNOWN
    const bad = await probe('this-command-does-not-exist-xyz', { timeoutMs: 3000 });
    T('反例 · 起不来的命令记 UNKNOWN（不是 FAIL）：' + String(bad.why).slice(0, 40),
      bad.state === 'UNKNOWN' && /没连上|起不来/.test(String(bad.why)),
      'state=' + bad.state + ' why=' + String(bad.why).slice(0, 60));

    await s.close();
    console.log('');
    console.log('  通过 ' + pass + '   失败 ' + fail);
    console.log('');
    process.exit(fail ? 1 : 0);
  }

  const server = arg('server');
  if (!server) {
    console.error('');
    console.error('  用法: node tools/mcp/client.mjs --server="<启动命令>" [--list] [--call=工具 --args=\'{}\']');
    console.error('        node tools/mcp/client.mjs --selftest');
    console.error('');
    process.exit(2);
  }

  const p = await probe(server, { timeoutMs: Number(arg('timeout', '15')) * 1000 });
  console.log('');
  console.log('  ' + ICON[p.state] + ' ' + p.state + '  ' + server);
  console.log('  ' + p.why);
  if (p.tools && p.tools.length) {
    console.log('');
    console.log('  工具（' + p.tools.length + '）:');
    for (const t of p.tools.slice(0, 20)) {
      console.log('    · ' + t.name + (t.description ? '  ' + String(t.description).slice(0, 60) : ''));
    }
  }

  if (arg('call')) {
    const s = new McpSession(server, { timeoutMs: 20000 });
    await s.start();
    await s.initialize();
    let args = {};
    try { args = JSON.parse(arg('args', '{}')); } catch { /* 保持空对象 */ }
    const r = await s.callTool(arg('call'), args);
    console.log('');
    console.log('  ' + ICON[r.state] + ' tools/call ' + arg('call') + ' → ' + r.state + '  ' + r.why);
    if (r.content) console.log('  ' + JSON.stringify(r.content).slice(0, 400));
    await s.close();
    process.exit(r.state === 'PASS' ? 0 : r.state === 'FAIL' ? 1 : 2);
  }

  console.log('');
  process.exit(p.state === 'PASS' ? 0 : p.state === 'FAIL' ? 1 : 2);
}