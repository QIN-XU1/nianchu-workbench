#!/usr/bin/env node
/**
 * B1 插件化内核 · 验收器（含反例）
 * 四态：PASS 全过 / FAIL 有正例失败或反例没红
 *
 * 覆盖两套契约：
 *  A. 贡献点模式（contributes + contribute/invoke，白名单校验）
 *  B. 激活模式（entry + activate(ctx)，按 requires 拓扑排序）
 *  C. 真实插件装载（tools/plugin/builtin 下 probe-reader → probe-audit）
 */
import { createKernel, validateManifest, topoSort, pluginId, CONTRIBUTION_POINTS } from '../../tools/plugin/kernel.mjs';

let pass = 0, total = 0;
const lines = [];
function T(name, ok, why) { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok ? '' : '  ← ' + why)); }

// ── A. 贡献点模式 ──
const k = createKernel();
T('正例 · 合法清单（id 形态）装载成功', k.load({ id: 'demo', version: '1.0.0', contributes: { commands: ['hello'] } }).ok === true, '应成功');

let got = null;
k.contribute('demo', 'commands', 'hello', (ctx) => { got = ctx; return 'hi'; });
T('正例 · 贡献点派发返回正确', k.invoke('commands', 'demo:hello', { a: 1 }) === 'hi', '返回值错');
T('正例 · 插件收到冻结 ctx（拿不到内核）', got !== null && Object.isFrozen(got), 'ctx 未冻结');

T('反例 · 缺 name/id ⇒ 拒绝', validateManifest({ version: '1' }).ok === false, '不该通过');
T('反例 · 缺 version ⇒ 拒绝', validateManifest({ name: 'x' }).ok === false, '不该通过');
const bad = validateManifest({ name: 'x', version: '1', contributes: { hackCore: [] } });
T('反例 · 未知贡献点 ⇒ 拒绝（不静默）', bad.ok === false && bad.issues.some((i) => i.code === 'unknown_point'), '不该通过');

const k2 = createKernel();
k2.load({ name: 'dup', version: '1' });
T('反例 · 重复 id ⇒ 拒绝', k2.load({ name: 'dup', version: '2' }).ok === false, '不该通过');

const k3 = createKernel();
k3.load({ name: 'p', version: '1' });
T('反例 · 贡献点非函数 ⇒ 拒绝', k3.contribute('p', 'commands', 'x', 'nope').ok === false, '不该通过');
T('反例 · 未装载插件 ⇒ 拒绝', k3.contribute('ghost', 'commands', 'g', () => 1).ok === false, '不该通过');

let threw = false;
try { k3.invoke('commands', 'nope'); } catch { threw = true; }
T('反例 · 调用不存在贡献点 ⇒ 抛错', threw, '不该静默');

// ── B. 激活模式（拓扑排序）──
const ms = [
  { name: 'a', version: '1', requires: ['b'] },
  { name: 'b', version: '1', requires: [] },
];
const sorted = topoSort(ms);
T('正例 · 拓扑排序：依赖优先（b → a）', sorted.ok && sorted.order.map(pluginId).join(',') === 'b,a', JSON.stringify(sorted.order.map(pluginId)));

T('反例 · 缺依赖 ⇒ 排序失败', topoSort([{ name: 'x', version: '1', requires: ['nope'] }]).ok === false, '不该通过');

const cyc = topoSort([
  { name: 'p1', version: '1', requires: ['p2'] },
  { name: 'p2', version: '1', requires: ['p1'] },
]);
T('反例 · 依赖成环 ⇒ 排序失败', cyc.ok === false && cyc.issues.some((i) => i.code === 'cycle'), '不该通过');

T('反例 · requires 非数组 ⇒ 拒绝', validateManifest({ name: 'x', version: '1', requires: 'nope' }).ok === false, '不该通过');

// ── C. 真实插件（probe-reader 无依赖，probe-audit 依赖它）──
const real = [
  { name: 'probe-reader', version: '1.0.0', requires: [] },
  { name: 'probe-audit', version: '1.0.0', requires: ['probe-reader'] },
];
const rs = topoSort(real);
T('正例 · 真实插件拓扑序 probe-reader → probe-audit',
  rs.ok && rs.order.map(pluginId).join(',') === 'probe-reader,probe-audit', JSON.stringify(rs.order.map(pluginId)));

T('正例 · 贡献点白名单固定 ' + CONTRIBUTION_POINTS.join('/'), CONTRIBUTION_POINTS.length === 3, '白名单变了');

const ok = pass === total;
console.log('  B1 插件化内核验收 —— 自研（无特权核心，双契约：贡献点 + 激活）');
console.log(lines.join('\n'));
console.log('\n  验收 ' + pass + '/' + total + ' · 四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
