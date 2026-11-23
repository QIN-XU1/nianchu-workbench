#!/usr/bin/env node
/**
 * 中枢调度卡哨兵 —— 第 11 个哨兵
 *
 * ══════════════════════════════════════════════════════════════
 *  守什么（依据 方案/121 调研）
 * ══════════════════════════════════════════════════════════════
 *
 *  调研 §5.2：主 agent prompt 必须写六块，一块都不能少：
 *    ① 身份 + 不可外包四件事 + 越界判据
 *    ② 名册
 *    ③ 派单契约
 *    ④ 终止条件
 *    ⑤ 输出格式
 *    ⑥ 硬不变量
 *
 *  调研 §5.3：写了反而有害（必须检查不能出现）：
 *    · 完整流程步骤长 prose
 *    · 8 个场景职责全文（15k token 警告）
 *    · 反复加 IMPORTANT
 *    · "think step by step / be thorough / 别偷懒"
 *    · 越界行为的示例描写
 *
 *  不变量：
 *    INV-1 体积        ≤2800 B
 *    INV-2 六块齐全
 *    INV-3 名册覆盖    8 个场景
 *    INV-4 三条硬约束   填不出 verify 不许派 / 同一 subject 不双挂 / 调度动作不可见
 *    INV-5 越界判据    必须是产物归属判据，不能是「50 行代码」
 *    INV-6 无有害内容   不含 think step by step / IMPORTANT 堆砌
 *    INV-7 生成器不覆盖 场景注入.mjs 必须跳过 hub
 *    INV-8 依赖可用    路由表 / 投递通道 工具存在且自测通过
 *
 *  用法：
 *    node 工具/中枢调度卡哨兵.mjs
 *    node 工具/中枢调度卡哨兵.mjs --json
 *    node 工具/中枢调度卡哨兵.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
// ⚠ 2026-11-12 修（测的是废弃目录，永远报通过）
//
//   原来：CARD = 数据/.dsh/场景注入/hub/AGENTS.local.md
//   但第 14 轮「场景工作目录迁移（方案 A）」后，会话 cwd 已改为
//        数据/.dsh/场景记忆/中枢/AGENTS.local.md
//   `中枢调度卡.mjs` 也早就不写旧目录了。
//
//   实测后果：
//     · 哨兵测旧文件 2223B → 判「INV-1 体积通过」
//     · 真实文件（中枢会话实际读的）3212B → 超出预算 2800B 的 115%
//     · 中枢调度卡.mjs 只打印「⚠ 超出预算」然后 exit 0
//   两处加起来 = 一个 43% 超标的 prompt 一直没人发现。
//
//   修法：指向会话 cwd 里真正被 AI 读到的那个文件。
const CARD = path.join(WB, '数据', '.dsh', '场景记忆', '中枢', 'AGENTS.local.md');
const ROUTE_YAML = path.join(WB, '数据', '.dsh', '场景路由.yaml');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const INJECT_TOOL = path.join(HERE, '场景注入.mjs');
const ROUTE_TOOL = path.join(HERE, '路由表.mjs');
const DISPATCH_TOOL = path.join(HERE, '派单.mjs');

export const THRESHOLDS = {
  MAX_BYTES: 2800,
};

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

function check() {
  const diffs = [];
  const stats = {};

  const card = readTextSafe(CARD);
  if (card === null) {
    return { diffs: ['调度卡不存在: ' + CARD], stats, invs: 8 };
  }
  const bytes = Buffer.byteLength(card, 'utf8');
  stats.bytes = bytes;

  // ── INV-1 体积 ──
  if (bytes > THRESHOLDS.MAX_BYTES) {
    diffs.push('INV-1 体积超限：' + bytes + ' B > ' + THRESHOLDS.MAX_BYTES + ' B');
  }

  // ── INV-2 六块齐全（调研 §5.2）──
  const blocks = [
    { re: /唯一交互入口|只做四件事/, name: '身份+职责' },
    { re: /## 名册/, name: '名册' },
    { re: /四件套|subject.*verify|phenomenon/, name: '派单契约' },
    { re: /填不出 verify 不许派|不许派/, name: '终止条件' },
    { re: /## 汇总|## 结论/, name: '输出格式' },
    { re: /## 不变量|不许/, name: '硬不变量' },
  ];
  const missing = blocks.filter((b) => !b.re.test(card));
  stats.blocksTotal = blocks.length;
  stats.blocksHit = blocks.length - missing.length;
  if (missing.length > 0) {
    diffs.push('INV-2 缺少必需块：' + missing.map((m) => m.name).join(', '));
  }

  // ── INV-3 名册覆盖 ──
  const names = [];
  if (fs.existsSync(SCEN_DIR)) {
    for (const f of fs.readdirSync(SCEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readTextSafe(path.join(SCEN_DIR, f)));
        if (j.id && j.id !== 'hub' && j.name) names.push(j.name);
      } catch { /* ignore */ }
    }
  }
  const uncovered = names.filter((n) => !card.includes(n));
  stats.sceneTotal = names.length;
  stats.sceneCovered = names.length - uncovered.length;
  if (uncovered.length > 0) {
    diffs.push('INV-3 名册未覆盖：' + uncovered.join(', '));
  }

  // ── INV-4 三条硬约束（v2 新增，调研重点）──
  const hardRules = [
    { re: /填不出 verify/, name: '填不出 verify 不许派' },
    { re: /不双挂|不得同时挂在两个场景/, name: '同一 subject 不双挂' },
    { re: /调度动作对用户不可见/, name: '调度动作不可见' },
  ];
  const missingRules = hardRules.filter((r) => !r.re.test(card));
  stats.rulesHit = hardRules.length - missingRules.length;
  stats.rulesTotal = hardRules.length;
  if (missingRules.length > 0) {
    diffs.push('INV-4 缺硬约束：' + missingRules.map((m) => m.name).join(', '));
  }

  // ── INV-5 越界判据必须是产物归属（不能是 50 行代码）──
  const hasProductJudge = /是某个场景的产物|场景的产物吗/.test(card);
  const hasBadJudge = /50 行代码|超过 50 行/.test(card);
  if (!hasProductJudge) {
    diffs.push('INV-5 缺少产物归属判据');
  }
  if (hasBadJudge) {
    diffs.push('INV-5 仍在用「50 行代码」代理判据（调研 §6.2 指出可被绕过）');
  }

  // ── INV-6 无有害内容（调研 §5.3）──
  const harmful = [
    { re: /think step by step/i, name: 'think step by step' },
    { re: /be thorough/i, name: 'be thorough' },
    { re: /别偷懒/, name: '别偷懒' },
    { re: /IMPORTANT[：:]?.*IMPORTANT/, name: 'IMPORTANT 堆砌' },
  ];
  const found = harmful.filter((h) => h.re.test(card));
  if (found.length > 0) {
    diffs.push('INV-6 含有害内容：' + found.map((f) => f.name).join(', '));
  }

  // ── INV-7 场景注入.mjs 必须跳过 hub ──
  const injectSrc = readTextSafe(INJECT_TOOL);
  if (injectSrc === null) {
    diffs.push('INV-7 场景注入.mjs 不存在');
  } else if (!/id === 'hub'/.test(injectSrc) || !/continue/.test(injectSrc)) {
    diffs.push('INV-7 场景注入.mjs 没跳过 hub → 会把调度卡覆盖回通用模板');
  }

  // ── INV-8 依赖可用 ──
  for (const [name, tool] of [['路由表', ROUTE_TOOL], ['派单', DISPATCH_TOOL]]) {
    if (!fs.existsSync(tool)) {
      diffs.push('INV-8 ' + name + '工具不存在: ' + tool);
    }
  }
  if (!fs.existsSync(ROUTE_YAML)) {
    diffs.push('INV-8 场景路由.yaml 不存在');
  }
  // 路由表自测
  if (fs.existsSync(ROUTE_TOOL)) {
    const r = spawnSync(process.execPath, [ROUTE_TOOL, '--selftest'], {
      cwd: WB, encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    stats.routeExit = r.status;
    if (r.status !== 0) {
      diffs.push('INV-8 路由表自测失败 (exit ' + r.status + ')');
    }
  }

  return { diffs, stats, invs: 8 };
}

function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  中枢调度卡哨兵 · 自测');
  console.log('═'.repeat(72));
  console.log();

  const card = readTextSafe(CARD) || '';
  const bytes = Buffer.byteLength(card, 'utf8');

  chk('调度卡存在', card.length > 0, bytes + ' B');
  chk('体积在预算内', bytes <= THRESHOLDS.MAX_BYTES, bytes + ' <= ' + THRESHOLDS.MAX_BYTES);

  // 反例：超限必须被发现
  //
  // ⚠ 2026-11-11 修：原来写的是
  //     Buffer.byteLength('x'.repeat(2500)) > THRESHOLDS.MAX_BYTES
  //   2500 根本不大于 2800 → 这条「反例」永远不会失败，
  //   但它存在的意义正是「证明判据能抓到超限」。它自己成了 bug。
  //   正确写法：构造真的超限样本（MAX_BYTES + 1）。
  chk('反例：超限体积判不合格',
      Buffer.byteLength('x'.repeat(THRESHOLDS.MAX_BYTES + 1)) > THRESHOLDS.MAX_BYTES,
      (THRESHOLDS.MAX_BYTES + 1) + ' > ' + THRESHOLDS.MAX_BYTES);

  // 正例：刚好在预算内应该通过（有正例才说明边界判对了）
  chk('正例：刚好在预算内判合格',
      Buffer.byteLength('x'.repeat(THRESHOLDS.MAX_BYTES)) <= THRESHOLDS.MAX_BYTES,
      THRESHOLDS.MAX_BYTES + ' <= ' + THRESHOLDS.MAX_BYTES);

  // 反例：缺硬约束必须被发现
  const noRules = '# 中枢\n只做四件事\n';
  chk('反例：缺「填不出 verify」判不合格', !/填不出 verify/.test(noRules), 'ok');

  // 反例：有害内容必须被发现
  chk('反例：含 think step by step 判不合格',
      /think step by step/i.test('Please think step by step'), 'ok');

  // 反例：50 行判据必须被发现
  const badJudge = '如果我在写超过 50 行的代码';
  chk('反例：仍用 50 行判据必须被发现', /50 行代码|超过 50 行/.test(badJudge), 'ok');

  console.log();
  console.log('  实际: ' + bytes + ' B');
  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  const r = check();
  const n = r.diffs.length;

  if (has('--json')) {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...r }, null, 2));
    process.exit(n > 0 ? 1 : 0);
  }

  console.log('  体积:    ' + (r.stats.bytes ?? '?') + ' B / ' + THRESHOLDS.MAX_BYTES + ' B');
  console.log('  六块:    ' + r.stats.blocksHit + ' / ' + r.stats.blocksTotal);
  console.log('  名册:    ' + r.stats.sceneCovered + ' / ' + r.stats.sceneTotal);
  console.log('  硬约束:  ' + r.stats.rulesHit + ' / ' + r.stats.rulesTotal);
  console.log();

  if (n === 0) {
    console.log('PASS hub-dispatch-card: 差异集合 = 0');
    process.exit(0);
  } else {
    console.log('FAIL hub-dispatch-card: 差异集合 = ' + n + ' 项');
    for (const d of r.diffs) console.log('  - ' + d);
    process.exit(1);
  }
}
