/**
 * 最小可用的 MCP 服务器（只读文件系统）
 *
 * 这是给"能力开关 → 真实 MCP"这条链路做端到端验证用的。
 * 它实现三个工具：
 *   - list_dir   列出目录
 *   - read_file  读文件（限 64KB）
 *   - file_stat  文件信息
 *
 * 安全：
 *   - 只读，不写不删
 *   - 路径必须在项目根内（防穿越）
 *   - 单文件 ≤64KB
 *
 * 协议：JSON-RPC over stdio（MCP 标准）
 */

import readline from 'node:readline';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, normalize } from 'node:path';

const PROJECT = resolve(import.meta.dirname, '..');

function send(o) {
  process.stdout.write(JSON.stringify(o) + '\n');
}

function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

/** 把路径限制在项目根内 */
function safePath(p) {
  const norm = normalize(String(p || '.')).replace(/\\/g, '/');
  const abs = resolve(PROJECT, norm);
  const rel = relative(PROJECT, abs);
  if (rel.startsWith('..')) throw new Error('路径越界（只允许项目根内）');
  return abs;
}

const TOOLS = [
  {
    name: 'list_dir',
    description: '列出项目根内的一个目录（只读）',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对项目根的路径，默认 .' } },
    },
  },
  {
    name: 'read_file',
    description: '读项目根内的一个文本文件（只读，≤64KB）',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对项目根的文件路径' } },
      required: ['path'],
    },
  },
  {
    name: 'file_stat',
    description: '看文件/目录的基本信息（大小、修改时间）',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

function callTool(name, args) {
  if (name === 'list_dir') {
    const p = safePath(args.path || '.');
    if (!existsSync(p)) throw new Error('目录不存在：' + args.path);
    const st = statSync(p);
    if (!st.isDirectory()) throw new Error('不是目录：' + args.path);
    const entries = readdirSync(p, { withFileTypes: true }).slice(0, 200).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    }));
    return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
  }

  if (name === 'read_file') {
    const p = safePath(args.path);
    if (!existsSync(p)) throw new Error('文件不存在：' + args.path);
    const st = statSync(p);
    if (!st.isFile()) throw new Error('不是文件：' + args.path);
    if (st.size > 64 * 1024) throw new Error(`文件太大（${Math.round(st.size / 1024)}KB > 64KB）`);
    const text = readFileSync(p, 'utf8');
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'file_stat') {
    const p = safePath(args.path);
    if (!existsSync(p)) throw new Error('不存在：' + args.path);
    const st = statSync(p);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          path: args.path, dir: st.isDirectory(), bytes: st.size, mtime: st.mtimeMs,
        }, null, 2),
      }],
    };
  }

  throw new Error('未知工具：' + name);
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    ok(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'sea-fs-mcp', version: '0.1.0' },
      capabilities: { tools: {} },
    });
    return;
  }

  if (method === 'notifications/initialized') return;   // 通知，不回

  if (method === 'tools/list') {
    ok(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = callTool(params?.name, params?.arguments || {});
      ok(id, result);
    } catch (e) {
      err(id, -32603, e.message);
    }
    return;
  }

  if (method === 'ping') { ok(id, {}); return; }

  err(id, -32601, '不支持的方法：' + method);
});
