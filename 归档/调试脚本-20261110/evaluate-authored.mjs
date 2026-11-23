/**
 * Agent 自写 check 的评测器。
 *
 * 这是 objective 里最关键的一关：
 *   让独立 Agent 只凭契约写 check，然后看门禁的 ACCEPT 率。
 *
 * 判据（预先声明，防止事后找理由）：
 *   ACCEPT 率 >= 60% → "Agent 自写 DoneSpec" 成立，可以进入下一阶段
 *   ACCEPT 率 30-60% → 需要改进契约（BRIEF 写得更清），再测
 *   ACCEPT 率 < 30%  → 暂不成立，退回"人写 check + Agent 只写 evidence"，并记录
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discover, healthy } from './scene-loader.mjs';
import { validate } from './gate.mjs';
import { checkFloor } from './invariant-floor.mjs';

const HERE = import.meta.dirname;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

const ROOT = process.argv[2] || join(HERE, '..', 'challenges');

const scenes = discover(ROOT);
if (scenes.length === 0) {
  console.error('没有挑战场景：' + ROOT);
  process.exit(2);
}

console.log(`${C.bold}Agent 自写 check 评测${C.reset} · ${C.dim}${scenes.length} 个挑战${C.reset}\n`);

const rows = [];
let accepted = 0;
let present = 0;

for (const s of scenes) {
  if (s.error) {
    rows.push({ id: s.id, state: 'CONFIG_ERROR', detail: s.error, accept: false });
    console.log(`${C.red}✗${C.reset} ${s.id.padEnd(22)} 场景配置有误：${s.error}`);
    continue;
  }

  const hasCheck = existsSync(s.check);
  if (!hasCheck) {
    rows.push({ id: s.id, state: 'NO_CHECK', detail: 'Agent 未产出 check.mjs', accept: false });
    console.log(`${C.yellow}?${C.reset} ${s.id.padEnd(22)} ${C.dim}尚未产出 check.mjs${C.reset}`);
    continue;
  }
  present++;

  // 先看能否在真实数据上跑（语法/路径问题会在这里暴露）
  let runs = false, runOut = '';
  try {
    const { execFileSync } = await import('node:child_process');
    runOut = execFileSync('node', [s.check, s.id], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SEA_DATA_DIR: s.dataDir },
    });
    runs = true;
  } catch (e) {
    runOut = ((e.stdout || '') + (e.stderr || '')).slice(0, 200);
    runs = false;
  }

  // 不变量下限（先看声明是否够，虽然这是挑战给的，但能检验 Agent 是否真的覆盖）
  const floor = checkFloor(s);

  // 门禁认证（核心判据）
  const r = validate(s.check, s);
  const accept = r.verdict === 'ACCEPT';
  if (accept) accepted++;

  rows.push({
    id: s.id, state: accept ? 'ACCEPT' : 'REJECT', accept,
    runs, floorOk: floor.ok,
    gates: r.gates, caught: r.caught,
    reasons: r.reasons,
    failures: r.mutations.filter(m => !m.failed).map(m => m.name),
  });

  const mark = accept ? `${C.green}ACCEPT` : `${C.red}REJECT`;
  console.log(`${mark}${C.reset} ${s.id.padEnd(22)} 跑通=${runs ? 'Y' : 'N'} 捕获=${r.caught}`);
  if (!accept) {
    for (const why of r.reasons) console.log(`  ${C.red}· ${why}${C.reset}`);
    const missed = r.mutations.filter(m => !m.failed);
    for (const m of missed.slice(0, 5)) console.log(`  ${C.dim}  漏: [${m.invariant}] ${m.name}${C.reset}`);
  }
}

const rate = present > 0 ? accepted / present : 0;
console.log(`\n${C.bold}===== 结果 =====${C.reset}`);
console.log(`  挑战总数：${scenes.length}`);
console.log(`  已产出：${present}`);
console.log(`  ACCEPT：${accepted}`);
console.log(`  ${C.bold}ACCEPT 率：${(rate * 100).toFixed(0)}%${C.reset}`);

let verdict;
if (present === 0) {
  verdict = 'NO_DATA';
  console.log(`\n${C.yellow}尚无产出，无法判定${C.reset}`);
} else if (rate >= 0.6) {
  verdict = 'PASS';
  console.log(`\n${C.green}结论：Agent 自写 DoneSpec 成立（ACCEPT 率 >= 60%）${C.reset}`);
} else if (rate >= 0.3) {
  verdict = 'MARGINAL';
  console.log(`\n${C.yellow}结论：边际（30%-60%），需改进 BRIEF 契约清晰度后重测${C.reset}`);
} else {
  verdict = 'FAIL';
  console.log(`\n${C.red}结论：暂不成立（< 30%），应退回"人写 check + Agent 只写 evidence"${C.reset}`);
}

// 写报告
const report = {
  at: new Date().toISOString(),
  root: ROOT,
  total: scenes.length,
  present,
  accepted,
  rate,
  verdict,
  rows,
};
const out = join(HERE, 'agent-authored-report.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n${C.dim}报告：${out}${C.reset}`);

process.exit(verdict === 'PASS' ? 0 : verdict === 'NO_DATA' ? 2 : 1);
