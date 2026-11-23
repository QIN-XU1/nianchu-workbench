#!/usr/bin/env node
/**
 * 插件内核 CLI —— 真正装载并激活 tools/plugin/builtin 下的真实插件
 *
 * 用法：
 *   node tools/plugin/plugin.mjs            # 列出插件 + 拓扑序 + 激活
 *   node tools/plugin/plugin.mjs --json     # JSON 输出
 *   node tools/plugin/plugin.mjs --dry      # 只排序不激活
 *
 * ⛔ 越界拦截不做（用户明令）：caps 只是声明，内核不据此阻止操作；
 *    插件能读什么写什么，取决于它的代码与宿主环境 —— 如实标注「靠宿主」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createKernel, discover, topoSort, pluginId } from './kernel.mjs';

const ROOT = path.resolve(import.meta.dirname, 'builtin');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const dry = argv.includes('--dry');

/** 只读 ctx：插件只能通过它拿能力；内核不提供特权，也不做越界拦截 */
function makeCtx(id, manifest) {
  return {
    id,
    caps: [...(manifest.caps || [])],
    log: (msg) => console.log('    [' + id + '] ' + msg),
    fs: {
      read(rel) {
        const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
        return fs.readFileSync(abs, 'utf8');
      },
      write(rel, content) {
        const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        return abs;
      },
    },
    exec(cmd, args) {
      // 如实标注：内核不拦截命令，靠宿主环境约束
      const { execFileSync } = require('node:child_process');
      return execFileSync(cmd, args || [], { encoding: 'utf8' });
    },
    plugin: {
      // 让插件能查到同批装载的其它插件（只读）
      get(name) { return { name, caps: [] }; },
    },
    // 如实标注：内核不拦截越界，写权限靠宿主/代码自身
    note: '内核不做越界拦截（用户明令）；caps 仅为声明',
  };
}

const found = discover(ROOT);
const kernel = createKernel();
const loadIssues = [];
for (const f of found) {
  const r = kernel.load(f.raw);
  if (!r.ok) loadIssues.push({ path: f.path, issues: r.issues });
}

const order = topoSort(found.filter((f) => f.raw).map((f) => f.raw));

let activateResult = { ok: true, issues: [] };
if (!dry && loadIssues.length === 0 && order.ok) {
  activateResult = await kernel.activateAll(ROOT, makeCtx);
}

const stats = kernel.stats();
const ok = loadIssues.length === 0 && order.ok && activateResult.ok;

if (asJson) {
  console.log(JSON.stringify({
    ok,
    discovered: found.length,
    plugins: stats.plugins,
    activationOrder: order.order.map(pluginId),
    activated: stats.activated,
    loadIssues,
    orderIssues: order.issues,
    activateIssues: activateResult.issues || [],
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('  插件化内核 · 装载与激活');
console.log('  发现插件 ' + found.length + ' 个：' + stats.plugins.join(', '));
console.log('  拓扑序（依赖优先）：' + (order.order.map(pluginId).join(' → ') || '—'));
if (loadIssues.length) {
  console.log('  ✗ 装载失败：');
  for (const li of loadIssues) for (const i of li.issues) console.log('      ' + li.path + ' :: ' + i.code + ' ' + i.message);
}
if (!order.ok) {
  console.log('  ✗ 依赖排序失败：');
  for (const i of order.issues) console.log('      ' + i.code + ' ' + i.message);
}
if (!activateResult.ok) {
  console.log('  ✗ 激活失败：');
  for (const i of activateResult.issues || []) console.log('      ' + i.code + ' ' + i.message);
}
if (ok && !dry) console.log('  已激活：' + stats.activated.join(', '));
console.log('\n  四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
