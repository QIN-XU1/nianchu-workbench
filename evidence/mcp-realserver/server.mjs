/**
 * 真 MCP server —— 用官方 @modelcontextprotocol/sdk 1.32.2 起
 *
 * 目的：证明我们的 tools/mcp/client.mjs 能连**真实的** MCP 实现，
 * 而不是只能连自己写的假 server。
 *
 * 这个 server 提供的工具刻意覆盖三种返回：
 *   add      正常计算，返回文本
 *   reverse  正常，返回字符串反转
 *   fail     抛异常（验 SDK 怎么把它变成 isError）
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'nianchu-real-probe',
  version: '1.0.0',
});

server.tool(
  'add',
  '两数相加',
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
);

server.tool(
  'reverse',
  '反转字符串',
  { text: z.string() },
  async ({ text }) => ({
    content: [{ type: 'text', text: [...text].reverse().join('') }],
  }),
);

server.tool(
  'fail',
  '总是失败（验 isError 通路）',
  {},
  async () => {
    throw new Error('故意失败：这个工具永远报错');
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
