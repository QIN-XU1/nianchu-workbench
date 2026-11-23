#!/usr/bin/env node
/**
 * 端到端证明：guardTick 真的在运行时挡住 job 执行。
 *
 * 单元测试能证明「函数返回值正确」，但证明不了「它被调用、且真的阻止了副作用」。
 * 这个脚本用一个**会产生真实副作用**的临时 job（写文件）+ 一个故意失败的 job，
 * 然后断言：达到失败阈值后，后面的 job **没有被执行**（文件没被创建）。
 *
 * 这是对第 4 次审计「全仓零调用方」的直接反驳证据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tickOnce } from './tick.mjs';
import { createSchedulePolicy } from './guard.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-e2e-'));
const STORE = path.join(TMP, 'jobs.json');
const SENTINEL = path.join(TMP, 'sentinel.txt');
const NOW = new Date('2032-05-06T10:00:30Z');

let pass = 0, fail = 0;
const t = (n, ok, d) => { if (ok) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d ? '  ← ' + d : '')); } };

const jobs = [
  { name: 'fail-1', cron: '0 * * * *', command: 'x', runs: [], lastRunMinute: null },
  { name: 'fail-2', cron: '0 * * * *', command: 'x', runs: [], lastRunMinute: null },
  { name: 'sentinel', cron: '0 * * * *', command: 'x', runs: [], lastRunMinute: null },
];
fs.writeFileSync(STORE, JSON.stringify({ what: 'e2e', at: new Date().toISOString(), jobs }, null, 2));

// 用假 runJob：前两个返回 FAIL，第三个会写 sentinel 文件
const runJob = async (job) => {
  if (job.name === 'sentinel') {
    fs.writeFileSync(SENTINEL, 'executed at ' + new Date().toISOString());
    return { state: 'PASS', why: 'wrote sentinel', ms: 1 };
  }
  return { state: 'FAIL', why: '故意失败', ms: 1 };
};

// 阈值设成 2：跑完两个 FAIL 后应当被挡住，sentinel 不得执行
const policy = createSchedulePolicy({ toolFailureThreshold: 2 });

const r = await tickOnce({ now: NOW, storePath: STORE, runJob, policy });

t('端到端：前两个失败 job 确实被执行', r.ran.length >= 2 && r.ran[0].state === 'FAIL', JSON.stringify(r.ran.map((x) => x.name)));
t('★端到端：达到失败阈值后，sentinel job **没有**被执行（文件不存在）',
  !fs.existsSync(SENTINEL), 'sentinel 竟然存在 = guard 没起作用');
t('★端到端：ran 里不含 sentinel', !r.ran.some((x) => x.name === 'sentinel'), JSON.stringify(r.ran.map((x) => x.name)));

// 对照组：把阈值调高，sentinel 就应该被执行 —— 证明上一个断言不是「反正都不跑」
{
  fs.rmSync(STORE, { force: true });
  fs.writeFileSync(STORE, JSON.stringify({
    what: 'e2e', at: new Date().toISOString(),
    jobs: jobs.map((j) => ({ ...j, runs: [], lastRunMinute: null })),
  }, null, 2));
  const r2 = await tickOnce({
    now: NOW, storePath: STORE, runJob,
    policy: createSchedulePolicy({ toolFailureThreshold: 99 }),
  });
  t('★对照组：阈值 99 时 sentinel **应该**被执行（证明上一条不是「反正都不跑」）',
    fs.existsSync(SENTINEL), JSON.stringify(r2.ran.map((x) => x.name)));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log('  guard 端到端测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
