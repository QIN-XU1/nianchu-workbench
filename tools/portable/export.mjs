#!/usr/bin/env node
/**
 * 跨工具可移植导出层 —— B3 自研实现
 *
 * 问题：我们"没有自己的协议实现"，跨工具靠 hermes 的 ACP。
 * 做法：把我们**真实存在的能力**导出成一份**自描述的标准化清单**（JSON + schema 版本），
 *      任何外部工具（编辑器/CI/其它 agent）都能读它来决定怎么调我们 —— 不依赖 hermes。
 *
 * 设计要点：
 *  - 清单内容**必须来自实测**：每条能力指向一个真实存在的文件，导出时逐个校验存在性；
 *    不存在 ⇒ 该条标 available:false 并记 issue（不静默当作有）。
 *  - schema 版本化（schemaVersion），外部工具可据此判断兼容性。
 *  - 四态：全部可用 ⇒ PASS；有缺失 ⇒ WARN；schema 非法/无法产出 ⇒ FAIL。
 *
 * ⛔ 不做越界拦截（用户明令）：本层只**声明**能力，不拦截任何调用；权限靠宿主。
 */
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = '1.0.0';

/** 我们对外声明的最小能力集（每条必须有真实文件支撑） */
export const CAPABILITIES = [
  { id: 'memory.validate', kind: 'verifier', entry: 'prototype/agent-ui/verify-memory.mjs', desc: '记忆治理验收器（溯源/冲突/TTL）' },
  { id: 'dispatch.ledger', kind: 'tool', entry: 'tools/dispatch/dispatch.mjs', desc: '派单/回执台账（状态机 + 未回执黑洞）' },
  { id: 'plugin.kernel', kind: 'kernel', entry: 'tools/plugin/kernel.mjs', desc: '无特权插件内核（发现/校验/拓扑排序/激活）' },
  { id: 'plugin.cli', kind: 'cli', entry: 'tools/plugin/plugin.mjs', desc: '插件装载与激活 CLI' },
  { id: 'mcp.client', kind: 'client', entry: 'tools/mcp/client.mjs', desc: 'MCP stdio + JSON-RPC 客户端' },
  { id: 'state.collect', kind: 'tool', entry: 'tools/state/collect.mjs', desc: '运行时状态六类采集' },
  { id: 'evolve.verify', kind: 'verifier', entry: 'prototype/agent-ui/verify-evolve.mjs', desc: 'L4 改进闭环验收器' },
  { id: 'plugin.verify', kind: 'verifier', entry: 'prototype/agent-ui/verify-plugin-kernel.mjs', desc: '插件内核验收器（16 项含 8 反例）' },
];

/** 生成可移植清单（repoRoot 下的相对路径） */
export function buildPortableManifest(repoRoot, existsFn) {
  const issues = [];
  const caps = CAPABILITIES.map((c) => {
    const abs = path.join(repoRoot, c.entry);
    let available = false;
    try { available = existsFn ? existsFn(abs) : fs.existsSync(abs); } catch { available = false; }
    if (!available) issues.push({ level: 'error', code: 'missing_entry', message: c.id + ' 的入口不存在：' + c.entry });
    return { ...c, available };
  });
  const okCount = caps.filter((c) => c.available).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: 'nianchu/portable-export',
    at: new Date().toISOString(),
    capabilities: caps,
    summary: { total: caps.length, available: okCount, missing: caps.length - okCount },
    issues,
  };
}

/** 校验一份清单是否可被外部工具消费（schema 自检） */
export function validateManifest(m) {
  const issues = [];
  if (!m || typeof m !== 'object') return { ok: false, issues: [{ level: 'error', code: 'not_object', message: '清单不是对象' }] };
  if (typeof m.schemaVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.schemaVersion)) {
    issues.push({ level: 'error', code: 'bad_schema', message: 'schemaVersion 必须形如 x.y.z' });
  }
  if (!Array.isArray(m.capabilities)) {
    issues.push({ level: 'error', code: 'bad_caps', message: 'capabilities 必须是数组' });
  } else {
    for (const c of m.capabilities) {
      if (!c || typeof c.id !== 'string' || !c.id) issues.push({ level: 'error', code: 'cap_no_id', message: '能力缺 id' });
      if (typeof c.available !== 'boolean') issues.push({ level: 'error', code: 'cap_no_avail', message: (c && c.id) + ' 缺 available 布尔' });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** 四态判定 */
export function verdict(m) {
  const v = validateManifest(m);
  if (!v.ok) return 'FAIL';
  if (m.summary.missing > 0) return 'WARN';
  return 'PASS';
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const REPO = path.resolve(import.meta.dirname, '../..');
  const out = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : null;
  const m = buildPortableManifest(REPO);
  const state = verdict(m);
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(m, null, 2) + '\n', 'utf8');
    console.log('  已导出：' + out);
  }
  console.log('  可移植清单 · schema ' + m.schemaVersion);
  console.log('  能力 ' + m.summary.available + '/' + m.summary.total + ' 可用');
  for (const c of m.capabilities) {
    console.log('    ' + (c.available ? '✓' : '✗') + ' ' + c.id.padEnd(18) + ' ' + c.entry);
  }
  for (const i of m.issues) console.log('    ✗ ' + i.message);
  console.log('\n  四态: ' + state);
  process.exit(state === 'FAIL' ? 1 : state === 'WARN' ? 3 : 0);
}
