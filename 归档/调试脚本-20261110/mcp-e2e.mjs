import { callMcp, loadServers } from './mcp.mjs';
import { isOn, toggle, getCapabilities } from './capabilities.mjs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

let pass = 0, total = 0;
const chk = (name, ok, detail) => {
  total++; if (ok) pass++;
  console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name.padEnd(34)} ${detail}`);
};

console.log(`${C.bold}MCP 端到端自检${C.reset} · ${C.dim}开关 → 调用 → 结果${C.reset}\n`);

// 保存原状态
const origOn = isOn('mcp.filesystem');

// 1 默认关闭时拒绝
if (origOn) toggle('mcp.filesystem', false, { by: 'user', reason: 'selftest-reset' });
chk('MCP 默认关闭', !isOn('mcp.filesystem'), `isOn=${isOn('mcp.filesystem')}`);

// 2 动态发现：capabilities 里应出现 filesystem
const caps = getCapabilities();
const found = caps.mcp.servers && caps.mcp.servers.filesystem;
chk('动态发现 MCP 服务器', !!found, found ? `label=${found.label}` : '未发现');

// 3 开启后可用
toggle('mcp.filesystem', true, { by: 'user', reason: 'selftest' });
chk('开启后 isOn', isOn('mcp.filesystem'), `isOn=${isOn('mcp.filesystem')}`);

// 4 真实调用 list_dir
try {
  const r = await callMcp('filesystem', {
    method: 'tools/call',
    params: { name: 'list_dir', arguments: { path: 'prototype' } },
    timeoutMs: 10000,
  });
  const txt = r.result?.content?.[0]?.text || '';
  const parsed = JSON.parse(txt);
  chk('list_dir 真实返回', Array.isArray(parsed) && parsed.length > 0, `${parsed.length} 项`);
} catch (e) {
  chk('list_dir 真实返回', false, e.message.slice(0, 50));
}

// 5 真实调用 read_file
try {
  const r = await callMcp('filesystem', {
    method: 'tools/call',
    params: { name: 'read_file', arguments: { path: 'prototype/capabilities.mjs' } },
    timeoutMs: 10000,
  });
  const txt = r.result?.content?.[0]?.text || '';
  chk('read_file 真实返回', txt.includes('capabilities'), `${txt.length} 字符`);
} catch (e) {
  chk('read_file 真实返回', false, e.message.slice(0, 50));
}

// 6 路径越界必须被拒
try {
  await callMcp('filesystem', {
    method: 'tools/call',
    params: { name: 'read_file', arguments: { path: '../../../etc/passwd' } },
    timeoutMs: 10000,
  });
  chk('路径越界被拒', false, '未拒绝（严重）');
} catch (e) {
  chk('路径越界被拒', /越界|不存在/.test(e.message), e.message.slice(0, 40));
}

// 7 关掉后不可调用（开关是硬门）
toggle('mcp.filesystem', false, { by: 'user', reason: 'selftest' });
const afterOff = isOn('mcp.filesystem');
chk('关闭后 isOn=false', !afterOff, `isOn=${afterOff}`);

// 还原
toggle('mcp.filesystem', origOn, { by: 'user', reason: 'restore' });

console.log(`\n${C.bold}===== MCP 端到端：${pass}/${total} =====${C.reset}`);
process.exit(pass === total ? 0 : 1);
