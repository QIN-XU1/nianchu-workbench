/**
 * 插件权限声明验证（Qoder 对等 · 2026-11-21）
 *
 * 【要证明什么】
 *  ① 声明了合法 permissions 的插件 → index.json 里带出 permissions
 *  ② ★反例：声明了**未知权限**的插件 → 被拒绝（进 rejected，不进 plugins），不静默放行
 *  ③ 未声明 permissions 的旧插件 → 仍能加载（向后兼容），permissions=[]
 *
 * 用法：node tools/workbench/verify-plugin-permissions.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServer, stopServer } from './_serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
// 用独立端口：避免命中「外部已在跑的旧代码服务」导致校验的是旧版本。自起即最新代码。
const BASE = process.env.NIANCHU_BASE || 'http://127.0.0.1:47128';
const PLUGINS = path.join(REPO, 'ui-plugins');
const BAD = path.join(PLUGINS, '__perm_bad_probe');
const OLD = path.join(PLUGINS, '__perm_old_probe');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const idx = async () => (await fetch(BASE + '/ui-plugins/index.json', { cache: 'no-store' })).json();

console.log('');
console.log('  插件权限声明验证 · ' + BASE);
console.log('  ' + '─'.repeat(68));

const _srv = await ensureServer(BASE);
if (!_srv.ok) {
  console.log('  ⚠ ' + _srv.why + ' → UNKNOWN（环境问题，不是代码缺陷）');
  await stopServer(_srv.child);
  process.exit(2);
}
console.log('  · ' + _srv.why);

try {
  // ① 合法声明
  const j1 = await idx();
  const sb = (j1.plugins || []).find((p) => p.id === 'status-bar');
  t('status-bar 声明了 permissions 且带出',
    Boolean(sb) && Array.isArray(sb.permissions) && sb.permissions.includes('ui.render') && sb.permissions.includes('ui.hostMethods'),
    JSON.stringify(sb && sb.permissions));

  // ② 反例：未知权限被拒
  fs.mkdirSync(BAD, { recursive: true });
  fs.writeFileSync(path.join(BAD, 'plugin.json'), JSON.stringify({
    id: 'perm-bad', name: '越权插件', slot: 'agent-bar', order: 99,
    permissions: ['ui.render', 'danger.exec'], entry: 'index.js',
  }), 'utf8');
  fs.writeFileSync(path.join(BAD, 'index.js'), 'export function mount() {}\n', 'utf8');
  const j2 = await idx();
  const inPlugins = (j2.plugins || []).some((p) => p.id === 'perm-bad');
  const rej = (j2.rejected || []).find((r) => r.id === 'perm-bad');
  t('★反例：声明未知权限 danger.exec → 被拒绝（不进 plugins）', !inPlugins);
  t('★反例：被拒原因里列出未知权限', Boolean(rej) && Array.isArray(rej.unknown) && rej.unknown.includes('danger.exec'),
    JSON.stringify(rej));

  // ③ 向后兼容：未声明 permissions 仍可加载
  fs.mkdirSync(OLD, { recursive: true });
  fs.writeFileSync(path.join(OLD, 'plugin.json'), JSON.stringify({
    id: 'perm-old', name: '旧插件', slot: 'agent-bar', order: 98, entry: 'index.js',
  }), 'utf8');
  fs.writeFileSync(path.join(OLD, 'index.js'), 'export function mount() {}\n', 'utf8');
  const j3 = await idx();
  const oldP = (j3.plugins || []).find((p) => p.id === 'perm-old');
  t('向后兼容：未声明 permissions 的旧插件仍加载，permissions=[]',
    Boolean(oldP) && Array.isArray(oldP.permissions) && oldP.permissions.length === 0,
    JSON.stringify(oldP && oldP.permissions));
} finally {
  fs.rmSync(BAD, { recursive: true, force: true });
  fs.rmSync(OLD, { recursive: true, force: true });
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 权限显式声明；未知权限被拒；旧插件向后兼容'
  : 'FAIL —— 有判据不满足'));
console.log('');
await stopServer(_srv.child);
process.exitCode = fails.length === 0 ? 0 : 1;
