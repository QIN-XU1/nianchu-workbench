/**
 * 能力开关（Capability Switch）
 *
 * 用户原话：
 *   "MCP工具如果默认使用就会每轮使用固定消耗的token，可以做开关控制，不用的时候默认关闭"
 *   "例如让他操作Blender，操作我这台电脑，都是外挂默认关着，要用的时候才开"
 *
 * 核心设计：
 *   - 每个"外挂能力"（桥的每个站 / MCP / 插件）都有独立开关
 *   - **默认全关**
 *   - 开关状态落文件（capabilities.json），跨会话保持
 *   - 开启/关闭要留审计（谁在什么时候开的，为什么）
 *
 * 为什么必须落文件：会话会换、模型会换，写在对话里的开关等于没有。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const HERE = import.meta.dirname;
const FILE = join(HERE, 'capabilities.json');

/** 默认能力清单（全部默认关闭） */
const DEFAULTS = {
  bridge: {
    label: '桥（外包给免费网页 AI）',
    kind: 'bridge',
    defaultOn: false,
    sites: {
      deepseek: { label: 'DeepSeek 网页版', on: false, cost: '零 token（走浏览器）', latency: '约 5 秒/次' },
    },
    note: '一次问答、要一段文字；不适合批量或必须准时的任务',
  },
  mcp: {
    label: 'MCP 工具',
    kind: 'mcp',
    defaultOn: false,
    servers: {
      'cua-driver': { label: '电脑操作（CUA）', on: false, cost: '约 26.8k token/轮' },
      'blender': { label: 'Blender 操作', on: false, cost: '按需' },
    },
    note: '全开约 58k token/轮 —— 平时必须关着',
    // 实际可用的服务器来自 mcp-servers.json，会在渲染时动态合并
    dynamicFrom: 'mcp-servers.json',
  },
  plugins: {
    label: '外挂插件',
    kind: 'plugin',
    defaultOn: false,
    items: {},
    note: '按需启用，不用时关闭',
  },
};

function readState() {
  if (!existsSync(FILE)) return null;
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; }
}

function writeState(state) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** 初始化（只在缺失时创建，保留已有开关） */
export function initCapabilities() {
  const existing = readState();
  if (existing) return existing;

  const state = { version: 1, createdAt: new Date().toISOString(), ...DEFAULTS, audit: [] };
  writeState(state);
  return state;
}

/** 读当前状态（自动补缺失的默认项 + 动态合并 MCP 服务器） */
export function getCapabilities() {
  const state = initCapabilities();
  // 合并新默认项（老文件缺项时补齐，但不覆盖已有开关）
  let changed = false;
  for (const key of Object.keys(DEFAULTS)) {
    if (!state[key]) { state[key] = DEFAULTS[key]; changed = true; }
  }

  // ★动态合并 mcp-servers.json 里的服务器★（默认关，已开启的保留）
  try {
    const p = join(HERE, 'mcp-servers.json');
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      const servers = cfg.servers || {};
      if (!state.mcp) state.mcp = { ...DEFAULTS.mcp };
      if (!state.mcp.servers) state.mcp.servers = {};
      for (const name of Object.keys(servers)) {
        if (name.startsWith('__')) continue;   // 跳过内部测试项
        if (!state.mcp.servers[name]) {
          state.mcp.servers[name] = {
            label: servers[name].label || name,
            on: false,                          // ★新增的一律默认关★
            cost: servers[name].cost || '按需',
            command: servers[name].command,
            dynamic: true,
          };
          changed = true;
        }
      }
    }
  } catch { /* 配置坏了不影响其它开关 */ }

  if (changed) writeState(state);
  return state;
}

/**
 * 开关操作。
 * target 形如 'bridge.deepseek' / 'mcp.cua-driver' / 'bridge'（整组）
 */
export function toggle(target, on, { by = 'user', reason = '' } = {}) {
  const state = getCapabilities();
  const parts = String(target).split('.');
  const group = parts[0];
  const item = parts[1];

  if (!state[group]) {
    return { ok: false, error: `不认识的能力组：${group}（可用：${Object.keys(DEFAULTS).join(', ')}）` };
  }

  const g = state[group];
  const container = group === 'bridge' ? 'sites' : group === 'mcp' ? 'servers' : group === 'plugins' ? 'items' : null;

  if (!item) {
    // 整组开关
    g.on = !!on;
    if (container && g[container]) {
      for (const k of Object.keys(g[container])) g[container][k].on = !!on;
    }
    state.audit.push({ at: new Date().toISOString(), by, target, on: !!on, reason });
    writeState(state);
    return { ok: true, target, on: !!on, note: `整组 ${g.label} → ${on ? '开' : '关'}` };
  }

  if (!container || !g[container] || !g[container][item]) {
    const avail = container && g[container] ? Object.keys(g[container]).join(', ') : '(无)';
    return { ok: false, error: `不认识的项：${target}（${group} 下可用：${avail}）` };
  }

  g[container][item].on = !!on;
  state.audit.push({ at: new Date().toISOString(), by, target, on: !!on, reason });
  writeState(state);
  return {
    ok: true, target, on: !!on,
    cost: g[container][item].cost,
    latency: g[container][item].latency,
  };
}

/** 判断某个能力是否开着 */
export function isOn(target) {
  const state = getCapabilities();
  const [group, item] = String(target).split('.');
  const g = state[group];
  if (!g) return false;
  if (!item) return !!g.on;
  const container = group === 'bridge' ? 'sites' : group === 'mcp' ? 'servers' : 'items';
  return !!(g[container] && g[container][item] && g[container][item].on);
}

/** 当前所有"开着"的能力（用于首屏显示） */
export function activeCapabilities() {
  const state = getCapabilities();
  const active = [];
  for (const group of ['bridge', 'mcp', 'plugins']) {
    const g = state[group];
    const container = group === 'bridge' ? 'sites' : group === 'mcp' ? 'servers' : 'items';
    if (!g || !container || !g[container]) continue;
    for (const [k, v] of Object.entries(g[container])) {
      if (v.on) active.push({ group, key: k, label: v.label, cost: v.cost });
    }
  }
  return active;
}

/** 估算"每轮固定 token 消耗"（用于提醒） */
export function estimateFixedCost() {
  const state = getCapabilities();
  let est = 0;
  const detail = [];
  for (const group of ['mcp', 'plugins']) {
    const g = state[group];
    const container = group === 'mcp' ? 'servers' : 'items';
    if (!g || !g[container]) continue;
    for (const [k, v] of Object.entries(g[container])) {
      if (!v.on) continue;
      // 粗略估算：cua-driver 26.8k，其他按 5k 保守估
      const t = k === 'cua-driver' ? 26800 : 5000;
      est += t;
      detail.push({ key: k, tokens: t });
    }
  }
  return { tokens: est, detail };
}

// ---------------- CLI ----------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/capabilities.mjs');
if (isDirect) {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
  const [, , cmd, target, ...rest] = process.argv;

  if (cmd === 'list' || !cmd) {
    const s = getCapabilities();
    console.log(`${C.bold}能力开关${C.reset} · ${C.dim}默认全关${C.reset}\n`);
    for (const group of ['bridge', 'mcp', 'plugins']) {
      const g = s[group];
      const container = group === 'bridge' ? 'sites' : group === 'mcp' ? 'servers' : 'items';
      console.log(`${C.bold}${g.label}${C.reset}  ${C.dim}${g.note}${C.reset}`);
      if (g[container]) {
        for (const [k, v] of Object.entries(g[container])) {
          const mark = v.on ? `${C.green}● 开${C.reset}` : `${C.dim}○ 关${C.reset}`;
          const cost = v.cost ? `  ${C.dim}${v.cost}${C.reset}` : '';
          console.log(`  ${mark}  ${k.padEnd(14)} ${v.label}${cost}`);
        }
      }
      console.log('');
    }
    const active = activeCapabilities();
    const fixed = estimateFixedCost();
    if (active.length === 0) {
      console.log(`${C.dim}当前没有开着的额外能力（固定 token 消耗为 0）${C.reset}`);
    } else {
      console.log(`${C.yellow}当前开着 ${active.length} 项${C.reset}：${active.map(a => a.label).join(', ')}`);
      if (fixed.tokens > 0) console.log(`${C.dim}  每轮固定 token 约 ${fixed.tokens}${C.reset}`);
    }
    process.exit(0);
  }

  if (cmd === 'on' || cmd === 'off') {
    if (!target) { console.log('用法：node capabilities.mjs on <target>  例：on bridge.deepseek'); process.exit(2); }
    const r = toggle(target, cmd === 'on', { by: 'cli', reason: rest.join(' ') });
    if (!r.ok) { console.log(`${C.red}✗ ${r.error}${C.reset}`); process.exit(1); }
    console.log(`${C.green}✓${C.reset} ${r.target} → ${r.on ? '开' : '关'}${r.note ? '  ' + r.note : ''}`);
    if (r.cost) console.log(`${C.dim}  代价：${r.cost}${r.latency ? ' · ' + r.latency : ''}${C.reset}`);
    process.exit(0);
  }

  if (cmd === 'active') {
    const a = activeCapabilities();
    if (a.length === 0) { console.log('（无）'); process.exit(0); }
    for (const x of a) console.log(`${x.group}.${x.key}  ${x.label}`);
    process.exit(0);
  }

  console.log('用法：');
  console.log('  node capabilities.mjs list                列出所有开关');
  console.log('  node capabilities.mjs on  <target>        开启');
  console.log('  node capabilities.mjs off <target>        关闭');
  console.log('  node capabilities.mjs active              列出开着的');
  process.exit(2);
}
