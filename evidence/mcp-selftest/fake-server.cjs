
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
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
  const err = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code, message } }) + '\n');
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
