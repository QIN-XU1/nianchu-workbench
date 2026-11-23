#!/usr/bin/env node
/**
 * 调度器种子 job —— 让调度器装好就有真实用途，而不是空壳
 *
 * 这三条 job 都是**真会跑真验收**的，不是 echo：
 *   每小时  跑 verify-goal（8 条硬要求总闸）
 *   每 6 小时 采一次运行时状态（D3 的数据源）
 *   每天    跑 size-guard + density（体量与界面密度两道工程纪律）
 *
 * 用法：
 *   node tools/schedule/seed.mjs            # 装（幂等，已存在的同名 job 会跳过）
 *   node tools/schedule/seed.mjs --remove   # 卸
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const S = path.join(REPO, 'tools/schedule/scheduler.mjs');
const STORE = path.join(REPO, 'evidence/schedule/jobs.json');
const REMOVE = process.argv.includes('--remove');

const SEEDS = [
  {
    name: 'verify-goal-hourly',
    cron: '0 * * * *',
    cmd: 'node prototype/hermes-agents/verify-goal.mjs',
    why: '8 条硬要求总闸，每小时一次；FAIL 说明有要求不达成',
  },
  {
    name: 'runtime-state-6h',
    cron: '0 */6 * * *',
    cmd: 'node tools/state/collect.mjs --fast',
    why: 'D3 的数据源，每 6 小时采一次现场状态',
  },
  {
    name: 'quality-daily',
    cron: '30 8 * * *',
    cmd: 'node tools/quality/size-guard.mjs && node prototype/agent-ui/verify-density.mjs',
    why: '每天早 8:30 跑体量红线 + 界面密度两道纪律',
  },
];

function cli(args) {
  try {
    return execFileSync(process.execPath, [S, ...args], {
      encoding: 'utf8', timeout: 60000, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

const existing = fs.existsSync(STORE)
  ? (JSON.parse(fs.readFileSync(STORE, 'utf8')).jobs || []).map((j) => j.name)
  : [];

console.log('');
console.log(REMOVE ? '  卸载种子 job' : '  安装种子 job');
console.log('  ' + '─'.repeat(70));

for (const s of SEEDS) {
  if (REMOVE) {
    cli(['remove', s.name]);
    console.log('  − ' + s.name);
    continue;
  }
  if (existing.includes(s.name)) {
    console.log('  · ' + s.name.padEnd(26) + '已存在，跳过');
    continue;
  }
  const out = cli(['add', '--name=' + s.name, '--cron=' + s.cron, '--cmd=' + s.cmd]);
  const ok = /已添加/.test(out);
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + s.name.padEnd(26) + s.cron.padEnd(16) + s.why);
}

if (!REMOVE) {
  const list = cli(['list']);
  const n = (list.match(/job 列表（(\d+) 条）/) || [, '?'])[1];
  console.log('');
  console.log('  当前共 ' + n + ' 条 job');
  console.log('  下次触发：node tools/schedule/scheduler.mjs next');
  console.log('  常驻运行：node tools/schedule/scheduler.mjs daemon --interval=30000');
}
console.log('');