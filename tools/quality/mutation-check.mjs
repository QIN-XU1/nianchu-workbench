#!/usr/bin/env node
/**
 * 变异测试：证明审计员发现的 3 个存活变异体现在都能被抓到。
 *
 * 【为什么要这个工具】2026-11-18 两个独立审计员各做了一遍变异测试，
 * 分别发现「12 个变异体 3 个存活」和「3 个变异体存活 + 1 条恒真断言」。
 * 存活的意思：把实现改坏，测试**仍然全绿** —— 那条测试等于没测。
 *
 * 手工做一次不够，下次改代码又会漂。所以把变异测试固化成工具：
 * 逐条注入变异 → 跑测试 → 期望变红 → 还原。任何一条「注入后仍绿」都是真问题。
 *
 * 用法：node tools/quality/mutation-check.mjs [--verbose]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireGate } from './inject-gate.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');

/**
 * 变异体清单：每条 = 改坏一个具体实现点 + 期望哪条测试变红。
 * 这些**全部来自独立审计员的实测**（他们发现这些位置改坏后测试仍绿）。
 */
const MUTANTS = [
  {
    id: 'M5',
    why: 'resolveConflict 去掉「不能选已被推翻的条目」保护',
    file: 'tools/memory/conflict.mjs',
    find: `  if (st === M.SUPERSEDED) {
    return { ok: false, why: '不能选一条已被推翻的条目' };
  }`,
    replace: `  if (false) {
    return { ok: false, why: '不能选一条已被推翻的条目' };
  }`,
    test: 'tools/memory/ttl-conflict.test.mjs',
  },
  {
    id: 'M9',
    why: '预算闸 >= 改成 >（多处理一条）',
    file: 'tools/collab/bus.mjs',
    find: 'if (handled >= budget)',
    replace: 'if (handled > budget)',
    test: 'tools/collab/api-handler.test.mjs',
  },
  {
    id: 'M11',
    why: 'inboxOf 返回内部数组而不是拷贝',
    file: 'tools/collab/bus.mjs',
    find: 'return m.inbox.slice();',
    replace: 'return m.inbox;',
    test: 'tools/collab/bus.test.mjs',
  },
  {
    id: 'M13',
    why: 'store.get 去掉 fresh 过滤（过期条目泄漏进 live）',
    file: 'tools/memory/store.mjs',
    find: 'const live = withState.filter((e) => e.effective === M.FRESH);',
    replace: 'const live = withState;',
    test: 'tools/memory/api-handler.test.mjs',
  },
  {
    id: 'M14',
    why: '哈希不覆盖嵌套对象（回到 array replacer 那个 bug）',
    file: 'tools/ledger/append-only.mjs',
    find: "  return sha256(String(prev ?? '') + '|' + canon(rest));",
    replace: "  return sha256(String(prev ?? '') + '|' + JSON.stringify(rest, Object.keys(rest).sort()));",
    test: 'tools/ledger/append-only.test.mjs',
  },
  // ── 以下 4 个变异体覆盖 verify-goal 依赖的核心验收器（T2「所有验收器」的补课）──
  {
    id: 'M16',
    why: 'verify-context 的目标模块 compress.mjs：压缩比恒报「无需压缩」',
    file: 'tools/context/compress.mjs',
    find: 'export function compress(',
    replace: 'export function compress() { return { state: \'PASS\', why: \'[crippled] 恒报无需压缩\', kept: [], dropped: [] }; }\nfunction _orig_compress(',
    test: 'prototype/agent-ui/verify-context.mjs',
  },
  {
    id: 'M17',
    why: 'verify-scheduler 的目标模块：matches 恒返回 true（cron 永不落空）',
    file: 'tools/schedule/scheduler.mjs',
    find: 'export function matches(cron, date = new Date()) {',
    replace: 'export function matches(cron, date = new Date()) { return true; }   // [crippled] 恒匹配\nfunction _orig_matches(cron, date = new Date()) {',
    test: 'prototype/agent-ui/verify-scheduler.mjs',
  },
  {
    id: 'M18',
    why: 'C6 成本：costOf 去掉单位校验（拿别的单位当美元）',
    file: 'tools/cost/pricing.mjs',
    find: "  if (!price || price.unit !== UNIT) return null;",
    replace: '  if (!price) return null;   // [crippled] 单位校验删掉',
    test: 'tools/cost/pricing-ledger.test.mjs',
  },
  {
    id: 'M19',
    why: 'C3 记忆老化：effectiveState 不再判过期（expired 永远出不来）',
    file: 'tools/memory/ttl.mjs',
    find: "  if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= now.getTime()) return M.EXPIRED;",
    replace: '  // [crippled] 过期判定删掉',
    test: 'tools/memory/ttl-conflict.test.mjs',
  },
  // ── 以下覆盖「验收器自己的判定逻辑」：打坏判定，它自己的反例必须报红 ──
  {
    id: 'M20',
    why: 'verify-density 的可复算判定：容差 5% 放宽成 100%（偏差永远不算超）',
    file: 'prototype/agent-ui/verify-density.mjs',
    find: 'export function repeatability(a, b, metrics = METRICS, tol = 0.05) {',
    replace: 'export function repeatability(a, b, metrics = METRICS, tol = 100) {   // [crippled] 容差放宽到 100%',
    test: 'prototype/agent-ui/verify-density.mjs',
    selftest: true,
  },
  {
    id: 'M21',
    why: 'verify-net 的搜索结果判定：条数上限不再检查（0 条也当 PASS）',
    file: 'tools/net/search.mjs',
    find: 'export function parseSearchResults(html, limit = 8) {',
    replace: 'export function parseSearchResults(html, limit = 8) { return []; }   // [crippled] 恒空\nfunction _orig_parseSearchResults(html, limit = 8) {',
    test: 'prototype/agent-ui/verify-net.mjs',
  },
  {
    id: 'M22',
    why: 'verify-mechanisms 的体量判定：按 kb 四舍五入判（3069 字节会被当成 3.0KB 放过）',
    file: 'prototype/hermes-agents/verify-mechanisms.mjs',
    find: '  return { ok: bytes >= minKB * 1024, kb: Math.round((bytes / 1024) * 10) / 10 };',
    replace: '  return { ok: Math.round((bytes / 1024) * 10) / 10 >= minKB, kb: Math.round((bytes / 1024) * 10) / 10 };   // [crippled] 按 kb 判',
    test: 'prototype/hermes-agents/verify-mechanisms.mjs',
    selftest: true,
  },
  // ── 覆盖剩余验收器（T2 覆盖率推进）──
  {
    id: 'M23',
    why: 'verify-runtime-state 的 judgeState：六类采集缺失不再报（结构完整性形同虚设）',
    file: 'prototype/agent-ui/verify-runtime-state.mjs',
    find: "  const missing = SECTIONS.filter((k) => !st[k]);",
    replace: '  const missing = [];   // [crippled] 缺采集也不报',
    test: 'prototype/agent-ui/verify-runtime-state.mjs',
    selftest: true,
  },
  {
    id: 'M24',
    why: 'verify-runtime-state：采集段状态不再校验四态（乱填也算合格）',
    file: 'prototype/agent-ui/verify-runtime-state.mjs',
    find: "  const badState = SECTIONS.filter((k) => st[k] && !VALID_STATES.has(st[k].state));",
    replace: '  const badState = [];   // [crippled] 状态不校验',
    test: 'prototype/agent-ui/verify-runtime-state.mjs',
    selftest: true,
  },
  {
    id: 'M25',
    why: 'verify-arch 的 isHollow：空壳判定恒为「不空」',
    file: 'prototype/hermes-agents/verify-arch.mjs',
    find: 'export function isHollow(info) {',
    replace: 'export function isHollow(info) { return false; }   // [crippled] 永远不判空壳\nfunction _orig_isHollow(info) {',
    test: 'prototype/hermes-agents/verify-arch.mjs',
    selftest: true,
  },
  {
    id: 'M26',
    why: 'verify-ui-layer 的 judgeArtifact：产物判定恒通过',
    file: 'prototype/agent-ui/verify-ui-layer.mjs',
    find: 'export function judgeArtifact(a = {}, opt = {}) {',
    replace: 'export function judgeArtifact(a = {}, opt = {}) { return { ok: true }; }   // [crippled] 恒通过\nfunction _orig_judgeArtifact(a = {}, opt = {}) {',
    test: 'prototype/agent-ui/verify-ui-layer.mjs',
    selftest: true,
  },
  {
    id: 'M27',
    why: 'audit-lead 的 parseProbeRows：解析恒返回空（探针行全丢）',
    file: 'tools/evolve/audit-lead.mjs',
    find: 'export function parseProbeRows(out) {',
    replace: 'export function parseProbeRows(out) { return []; }   // [crippled] 恒空\nfunction _orig_parseProbeRows(out) {',
    test: 'tools/evolve/audit-lead.mjs',
    selftest: true,
  },
  {
    id: 'M28',
    why: 'verify-freshness-discipline：新鲜度阈值放宽（陈旧快照也当新鲜）',
    file: 'prototype/agent-ui/verify-freshness-discipline.mjs',
    find: 'export function checkScene(fileName, sourceText, dataJson) {',
    replace: 'export function judgeAge() { return { ok: true, hours: 0, label: "[crippled] 恒新鲜" }; }\nfunction _orig_checkScene(fileName, sourceText, dataJson) {',
    test: 'prototype/agent-ui/verify-freshness-discipline.counterexamples.mjs',
  },
  {
    id: 'M29',
    why: 'verify-matrix-binding：绑定判定恒通过（矩阵格没实现也说绑定）',
    file: 'prototype/agent-ui/verify-matrix-binding.mjs',
    find: 'export function judgeCell(cell, existsFn) {',
    replace: 'export function judgeBinding() { return { ok: true, why: "[crippled] 恒通过" }; }\nfunction _orig_judgeCell(cell, existsFn) {',
    test: 'prototype/agent-ui/verify-matrix-binding.counterexamples.mjs',
  },
  {
    id: 'M30',
    why: 'verify-storage-sync：同步判定恒通过（存储不同步也说同步）',
    file: 'prototype/agent-ui/verify-storage-sync.mjs',
    find: 'export function judgeKey(key, files) {',
    replace: 'export function judgeSync() { return { ok: true, why: "[crippled] 恒通过" }; }\nfunction _orig_judgeKey(key, files) {',
    test: 'prototype/agent-ui/verify-storage-sync.counterexamples.mjs',
  },
  {
    id: 'M31',
    why: 'verify-mcp 的 judgeProbe：探针判定恒通过（连不上也说连上了）',
    file: 'prototype/agent-ui/verify-mcp.mjs',
    find: 'export function judgeProbe(parsed, { expectServer',
    replace: 'export function judgeProbe(parsed) { return { ok: true, why: "[crippled] 恒通过" }; }\nfunction _orig_judgeProbe(parsed, { expectServer',
    test: 'prototype/agent-ui/verify-mcp.mjs',
    selftest: true,
  },
  {
    id: 'M32',
    why: 'decompose-lead 的 score：矩阵打分恒返回 0（覆盖率算不出来）',
    file: 'tools/evolve/decompose-lead.mjs',
    find: 'export function score(state) {',
    replace: 'export function score(state) { return 0; }   // [crippled] 恒 0\nfunction _orig_score(state) {',
    test: 'prototype/agent-ui/verify-decompose-lead.counterexamples.mjs',
  },
  {
    id: 'M33',
    why: 'T3 审计器的差分判据：去掉「依赖在时不许 UNKNOWN」（永远 UNKNOWN 的假验收器就能过）',
    file: 'tools/evolve/audit-four-state-layers.mjs',
    find: "  if (s1 === 'UNKNOWN') {",
    replace: '  if (false) {   // [crippled] 不检查基线',
    test: 'tools/evolve/audit-four-state-layers.mjs',
    selftest: true,
  },
  {
    id: 'M34',
    why: 'T3 审计器的四态/退出码一致性：UNKNOWN 配 exit 0 也放行',
    file: 'tools/evolve/audit-four-state-layers.mjs',
    find: '  if (r.code !== want) {',
    replace: '  if (false) {   // [crippled] 不检查退出码',
    test: 'tools/evolve/audit-four-state-layers.mjs',
    selftest: true,
  },
  {
    id: 'M15',
    why: 'toLedgerRows 去掉单位校验（per-million 当 per-token）',
    file: 'tools/cost/replay.mjs',
    find: "    else if (price.unit !== UNIT) why = '单价单位不是 ' + UNIT + '（是 ' + String(price.unit) + '），不能当美元算';",
    replace: '    else if (false) why = null;',
    test: 'tools/cost/replay.test.mjs',
  },
];

const verbose = process.argv.includes('--verbose');

// 注入类工具不许嵌套并发跑（实测 60 个孤儿进程并发注入/还原同一批文件）
requireGate('mutation-check', '变异测试');

// ══════════════════════════════════════════════════════════════
// 启动前清扫 —— 目标文件必须干净，否则拒跑。
//
// 【2026-11-18 加·起因：第八次残留，而且被提交进了 HEAD】
// 上次变异工具在改 `tools/schedule/scheduler.mjs` 时被我强杀（为了止住另一处递归），
// `finally` 在 SIGKILL 下**根本不会执行** —— 这是 JS 层无法解决的。
// 残留版本随后被 `git add -A` 提交，导致 verify-scheduler 从 12/0 变 11/1。
//
// 所以防线不能只放在还原逻辑里（前七次都放那里，都失败）。
// 现在：**开始之前**先确认每个目标文件没有 [crippled] 标记；有就拒跑并点名。
// 这样「上一次的残留」会在下一次启动时立刻暴露，而不是被静默当成基线。
// ══════════════════════════════════════════════════════════════
const residue = [];
for (const m of MUTANTS) {
  let body;
  try { body = fs.readFileSync(path.join(REPO, m.file), 'utf8'); } catch { continue; }
  if (body.includes('[crippled]')) residue.push(m.file + '（' + m.id + ' 的目标）');
}
if (residue.length) {
  console.log('');
  console.log('  ✗ 拒绝运行 —— 目标文件里已有变异残留：');
  for (const r of [...new Set(residue)]) console.log('      ' + r);
  console.log('  处置：git checkout -- <文件> 后再跑。带着残留跑出来的数字不可信。');
  console.log('');
  console.log('  四态: FAIL —— 基线本身就是变异过的');
  console.log('');
  process.exit(1);
}
/**
 * 跑验收器。
 *
 * 【2026-11-18 修·我自己的工具错了】原来一律不带参数跑。
 * 但很多验收器的反例在 selfTest() 里，**不带 --selftest 根本不跑** ——
 * 于是「注入后仍全绿」被我误判成「测试没守住」。
 * 实测：verify-density 带 --selftest 是 10/10，不带就是 12/0（只跑真实测量，不跑反例）。
 */
const run = (file, opts = {}) => {
  const args = [path.join(REPO, file)];
  if (opts.selftest) args.push('--selftest');
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: REPO, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
};

let pass = 0;
let fail = 0;
const results = [];

for (const m of MUTANTS) {
  const abs = path.join(REPO, m.file);
  const original = fs.readFileSync(abs, 'utf8');

  if (!original.includes(m.find)) {
    results.push({ id: m.id, state: 'UNKNOWN', why: '变异锚点在源码里找不到（代码已变，需更新变异体）' });
    continue;
  }

  // 先确认基线是绿的 —— 基线就红的话这个变异测试没意义
  const runOpts = { selftest: m.selftest === true };
  const before = run(m.test, runOpts);
  if (before.code !== 0) {
    results.push({ id: m.id, state: 'UNKNOWN', why: '基线测试本来就红，无法判断变异是否被抓（' + before.code + '）' });
    continue;
  }

  try {
    fs.writeFileSync(abs, original.replace(m.find, m.replace), 'utf8');
    const after = run(m.test, runOpts);
    if (after.code !== 0) {
      pass++;
      results.push({ id: m.id, state: 'PASS', why: '注入后测试变红 ⇒ 这条测试真的守住了', mutant: m.why });
    } else {
      fail++;
      results.push({ id: m.id, state: 'FAIL', why: '**注入后测试仍全绿 ⇒ 这条测试没守住**', mutant: m.why });
    }
  } finally {
    // 无论成败都必须还原 —— 这是本仓库最痛的教训（注入残留已复发六次）
    fs.writeFileSync(abs, original, 'utf8');
    const back = fs.readFileSync(abs, 'utf8');
    if (back !== original) {
      console.log('  ✗ 还原失败：' + m.file + '（必须人工 git checkout）');
      process.exit(1);
    }
  }
}

console.log('');
console.log('  变异测试 —— 改坏实现，看测试是否变红');
console.log('  ' + '─'.repeat(72));
for (const r of results) {
  const mark = r.state === 'PASS' ? '✓' : r.state === 'FAIL' ? '✗' : '❔';
  console.log('  ' + mark + ' ' + r.id.padEnd(5) + r.state.padEnd(9) + r.why);
  if (verbose && r.mutant) console.log('        变异：' + r.mutant);
}
console.log('');
console.log('  结果：守住 ' + pass + ' · 没守住 ' + fail + ' · 判不了 ' + results.filter((r) => r.state === 'UNKNOWN').length);

// 收尾清扫：确认所有目标文件都还原了（finally 在 SIGKILL 下不执行，所以这步是补网）
const left = [];
for (const m of MUTANTS) {
  let body;
  try { body = fs.readFileSync(path.join(REPO, m.file), 'utf8'); } catch { continue; }
  if (body.includes('[crippled]')) left.push(m.file);
}
if (left.length) {
  console.log('');
  console.log('  ✗ 收尾清扫失败 —— 下列文件仍带变异标记：');
  for (const l of [...new Set(left)]) console.log('      ' + l);
  console.log('  处置：git checkout -- <文件>。');
  console.log('');
  process.exit(1);
}
console.log('  收尾清扫: ✓ 所有目标文件已还原');
console.log('');

// 没守住 = FAIL（测试是假的）；判不了 = UNKNOWN（不并入通过）
process.exit(fail > 0 ? 1 : results.some((r) => r.state === 'UNKNOWN') ? 2 : 0);
