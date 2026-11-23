#!/usr/bin/env node
/**
 * tickOnce 的反例测试 —— **hermetic**：用临时 store，不读真 evidence/schedule/jobs.json。
 *
 * 为什么改：原来读真 store，常驻 daemon 真的在某个整点跑过之后，
 * lastRunMinute 就等于那个分钟，测试里固定的 NOW 便不再「到点」，出现 3/3 假失败。
 * 这不是产品坏了，是测试不 hermetic。现在用 storePath 注入临时文件。
 *
 * 覆盖：
 *   正例 1 到点 job 真的被 runJob 调用
 *   正例 2 ran 里带回 state/why/ms
 *   反例 3 同一分钟不重复跑
 *   反例 4 非到点分钟不调用 runJob
 *   反例 5 坏 cron 不让整次 tick 崩
 *   反例 6 dryRun 不写盘
 *   反例 7 注入的 store 与真 store 互不影响（hermetic 自证）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tickOnce } from './tick.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ← ' + detail : '')); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ticktest-'));
const STORE = path.join(TMP, 'jobs.json');
const REAL = path.resolve(import.meta.dirname, '../../evidence/schedule/jobs.json');
const realBefore = fs.existsSync(REAL) ? fs.readFileSync(REAL, 'utf8') : null;

const writeStore = (jobs) => fs.writeFileSync(STORE, JSON.stringify({ what: 'test', at: new Date().toISOString(), jobs }, null, 2), 'utf8');
const readStore = () => JSON.parse(fs.readFileSync(STORE, 'utf8'));

const JOB_HOURLY = { name: 'hourly', cron: '0 * * * *', command: 'echo x', runs: [], lastRunMinute: null };
const NOW_TOP = new Date('2031-03-04T10:00:30Z'); // 0 * * * * 命中，且远离真实时间
const NOW_MID = new Date('2031-03-04T10:23:00Z'); // 不命中

const fakeRun = (state = 'PASS') => async (job) => ({ state, why: 'fake:' + job.name, ms: 1 });

// 1 + 2
{
  writeStore([{ ...JOB_HOURLY }]);
  const calls = [];
  const r = await tickOnce({
    now: NOW_TOP, dryRun: true, storePath: STORE,
    runJob: async (j) => { calls.push(j.name); return { state: 'PASS', why: 'ok', ms: 2 }; },
  });
  t('正例：到点 job 真的被 runJob 调用', calls.length === 1 && r.due === 1 && r.ran.length === 1, JSON.stringify({ calls, due: r.due }));
  t('正例：ran 里带回 state/why/ms', r.ran[0] && r.ran[0].state === 'PASS' && typeof r.ran[0].ms === 'number', JSON.stringify(r.ran[0] || null));
}

// 3
{
  writeStore([{ ...JOB_HOURLY }]);
  const r1 = await tickOnce({ now: NOW_TOP, storePath: STORE, runJob: fakeRun() });
  const r2 = await tickOnce({ now: NOW_TOP, storePath: STORE, runJob: fakeRun() });
  t('反例：同一分钟不重复跑（第二次 due=0）', r1.due === 1 && r2.due === 0, JSON.stringify({ first: r1.due, second: r2.due }));
}

// 4
{
  writeStore([{ ...JOB_HOURLY }]);
  const calls = [];
  const r = await tickOnce({ now: NOW_MID, storePath: STORE, runJob: async (j) => { calls.push(j.name); return { state: 'PASS', why: '', ms: 0 }; } });
  t('反例：非到点分钟 due=0 且不调用 runJob', r.due === 0 && calls.length === 0, JSON.stringify({ due: r.due }));
}

// 5
{
  writeStore([{ name: 'bad', cron: '完全不是 cron', command: 'echo x', runs: [] }, { ...JOB_HOURLY }]);
  let threw = false; let r = null;
  try { r = await tickOnce({ now: NOW_TOP, dryRun: true, storePath: STORE, runJob: fakeRun() }); } catch { threw = true; }
  t('反例：坏 cron 不让整次 tick 崩（其它 job 照常处理）',
    !threw && r && r.due === 1 && r.ran.every((x) => x.name !== 'bad'), JSON.stringify(r ? r.ran.map((x) => x.name) : null));
}

// 6
{
  writeStore([{ ...JOB_HOURLY }]);
  const before = fs.readFileSync(STORE, 'utf8');
  await tickOnce({ now: NOW_TOP, dryRun: true, storePath: STORE, runJob: fakeRun() });
  t('反例：dryRun 不写盘', before === fs.readFileSync(STORE, 'utf8'));
}

// 7 —— hermetic 自证：整个测试跑完，真 store 一个字节都没变
{
  const realAfter = fs.existsSync(REAL) ? fs.readFileSync(REAL, 'utf8') : null;
  t('反例：测试不影响真 jobs.json（hermetic 自证）', realBefore === realAfter);
}





// ══════════════════════════════════════════════════════════════
// 以下 4 条由第 5 次审计 audit-c2b 点名补上：
// 它原话「tick.test.mjs 变异后仍 7/7 全绿——它 7 条断言零条涉及 guard」
// ══════════════════════════════════════════════════════════════

// ── E. tick 必须真的把 guard 判定暴露出来（不能恒 allow:true）──
{
  writeStore([{ ...JOB_HOURLY }]);
  const r = await tickOnce({
    now: NOW_TOP, storePath: STORE, dryRun: true,
    runJob: async (j) => ({ state: 'FAIL', why: '故意失败', ms: 1 }),
  });
  t('★反例（审计点名）：tick 返回值必须带 guard.decision',
    r.guard && r.guard.decision && typeof r.guard.decision.reason === 'string',
    JSON.stringify(r.guard || null));
}

// ── F. 失败计数必须落盘（跨 tick 累积），否则连续失败条件不可达 ──
{
  // 用每分钟都到点的 job，两次 tick 相隔 1 分钟 ——
  // 不能相隔 1 小时：那会**合法地**触发 idle_timeout（30 分钟），
  // 看起来像「累积没生效」，其实是另一条刹车在起作用。
  writeStore([{ name: 'every-minute', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const failRun = async (j) => ({ state: 'FAIL', why: 'x', ms: 1 });
  await tickOnce({ now: new Date('2031-03-04T10:00:30Z'), storePath: STORE, runJob: failRun });
  const after1 = JSON.parse(fs.readFileSync(STORE, 'utf8')).guard?.consecutiveFailures;
  await tickOnce({ now: new Date('2031-03-04T10:01:30Z'), storePath: STORE, runJob: failRun });
  const after2 = JSON.parse(fs.readFileSync(STORE, 'utf8')).guard?.consecutiveFailures;
  t('★反例（审计点名）：连续失败计数跨 tick 累积（不是每次从 0 起算）',
    Number(after1) >= 1 && Number(after2) > Number(after1),
    JSON.stringify({ after1, after2 }));
}

// ── G. 达到阈值后，后面的 job 不再执行 ──
{
  writeStore([
    { name: 'f1', cron: '0 * * * *', command: 'x', runs: [], lastRunMinute: null },
    { name: 'f2', cron: '0 * * * *', command: 'x', runs: [], lastRunMinute: null },
    { name: 'never', cron: '0 * * * *', command: 'x', runs: [], lastRunMinute: null },
  ]);
  const r = await tickOnce({
    now: NOW_TOP, storePath: STORE,
    runJob: async (j) => ({ state: j.name === 'never' ? 'PASS' : 'FAIL', why: 'x', ms: 1 }),
  });
  t('★反例（审计点名）：阈值 2 时第 3 个 job 不应被执行',
    !r.ran.some((x) => x.name === 'never'), JSON.stringify(r.ran.map((x) => x.name)));
}

// ── H. 生产规模下阈值必须可达（3 个 job 时阈值不能 > 3）──
{
  const { createSchedulePolicy } = await import('./guard.mjs');
  const p = createSchedulePolicy();
  t('★反例（审计点名）：生产只有 3 个 job，阈值必须 ≤ 3 才可达',
    p.toolFailureThreshold <= 3, 'threshold=' + p.toolFailureThreshold);
}


// ══════════════════════════════════════════════════════════════
// 熔断器 half-open（真跑才发现的缺陷：入口 guard 生效后永久卡死）
// ══════════════════════════════════════════════════════════════

// ── I. 挡住后超过冷却期 ⇒ 必须放行一次探针（否则永久停摆）──
{
  writeStore([{ name: 'e', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  // 手动造出「已被挡住、且挡住时间很早」的状态
  const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  db.guard = { consecutiveFailures: 9, blockedAt: new Date('2031-03-04T09:00:00Z').getTime(), at: new Date().toISOString() };
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2), 'utf8');

  const r = await tickOnce({
    now: new Date('2031-03-04T10:00:30Z'), // 距 blockedAt 1 小时 > 冷却 10 分钟
    storePath: STORE,
    runJob: async () => ({ state: 'PASS', why: 'ok', ms: 1 }),
  });
  t('★反例：超过冷却期后必须放行（否则调度器永久停摆）',
    r.guard.allow === true && r.ran.length === 1, JSON.stringify({ allow: r.guard.allow, ran: r.ran.length }));
}

// ── J. 未超冷却期 ⇒ 必须继续挡住（不能一被挡就立刻放行）──
{
  writeStore([{ name: 'e', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  db.guard = { consecutiveFailures: 9, blockedAt: new Date('2031-03-04T10:00:00Z').getTime(), at: new Date().toISOString() };
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2), 'utf8');

  const r = await tickOnce({
    now: new Date('2031-03-04T10:00:30Z'), // 只过了 30 秒 < 冷却 10 分钟
    storePath: STORE,
    runJob: async () => ({ state: 'PASS', why: 'ok', ms: 1 }),
  });
  t('★反例：未超冷却期必须继续挡住（不能一挡就放）',
    r.guard.allow === false && r.ran.length === 0, JSON.stringify({ allow: r.guard.allow, ran: r.ran.length }));
}

// ── K. 探针成功 ⇒ 计数清零（真正恢复）──
{
  writeStore([{ name: 'e', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  db.guard = { consecutiveFailures: 9, blockedAt: new Date('2031-03-04T09:00:00Z').getTime(), at: new Date().toISOString() };
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2), 'utf8');

  const r = await tickOnce({
    now: new Date('2031-03-04T10:00:30Z'), storePath: STORE,
    runJob: async () => ({ state: 'PASS', why: 'ok', ms: 1 }),
  });
  const after = JSON.parse(fs.readFileSync(STORE, 'utf8')).guard?.consecutiveFailures;
  t('★反例：探针成功后失败计数必须清零',
    Number(after) === 0, 'after=' + after + ' ran=' + r.ran.length);
}

// ── L. 探针又失败 ⇒ 计数重新累积（不能无限放行）──
{
  writeStore([{ name: 'e', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  db.guard = { consecutiveFailures: 9, blockedAt: new Date('2031-03-04T09:00:00Z').getTime(), at: new Date().toISOString() };
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2), 'utf8');

  const r = await tickOnce({
    now: new Date('2031-03-04T10:00:30Z'), storePath: STORE,
    runJob: async () => ({ state: 'FAIL', why: 'still broken', ms: 1 }),
  });
  const after = JSON.parse(fs.readFileSync(STORE, 'utf8')).guard?.consecutiveFailures;
  t('★反例：探针又失败 ⇒ 计数重新累积（不是清零后一直放行）',
    Number(after) >= 1, 'after=' + after);
}


// ══════════════════════════════════════════════════════════════
// 真实 60s 节奏的反例（第 6 次审计 audit-c2c 点名：I/J/K/L 全是人工伪造状态）
// 这批**不伪造 blockedAt**，全靠连续 tick 自己写出来的状态驱动。
// ══════════════════════════════════════════════════════════════

// ── M. 常驻 60s 节奏下，冷却期必须真的会到（不能永远差 60s）──
{
  writeStore([{ name: 'e', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const failRun = async () => ({ state: 'FAIL', why: 'broken', ms: 1 });
  const COOLDOWN = 10 * 60 * 1000;
  const t0 = new Date('2031-03-04T10:00:30Z').getTime();

  // 连续 tick（每次 +60s），直到出现一次 allow=true
  let firstAllowAt = null;
  let blockedCount = 0;
  for (let i = 0; i < 20; i++) {
    const now = new Date(t0 + i * 60 * 1000);
    const r = await tickOnce({ now, storePath: STORE, runJob: failRun });
    if (r.guard.allow) { firstAllowAt = i; break; }
    blockedCount++;
  }
  t('★反例（真实节奏）：连续 60s tick 下，冷却期必须真的会到（≤10 分钟放行一次）',
    firstAllowAt !== null && firstAllowAt * 60 * 1000 <= COOLDOWN + 60 * 1000,
    JSON.stringify({ firstAllowAt, blockedCount, cooldownMin: COOLDOWN / 60000 }));
}

// ── N. 探针失败后必须重新计时，不能下一 tick 又清零 ──
{
  writeStore([{ name: 'e', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const failRun = async () => ({ state: 'FAIL', why: 'broken', ms: 1 });
  const t0 = new Date('2031-03-04T10:00:30Z').getTime();

  // 先跑到「挡住」
  let blockedAtIdx = null;
  for (let i = 0; i < 5; i++) {
    const r = await tickOnce({ now: new Date(t0 + i * 60 * 1000), storePath: STORE, runJob: failRun });
    if (!r.guard.allow) { blockedAtIdx = i; break; }
  }
  // 再连跑到冷却后放行一次（探针），探针失败
  let probeIdx = null;
  for (let i = (blockedAtIdx ?? 0) + 1; i < 20; i++) {
    const r = await tickOnce({ now: new Date(t0 + i * 60 * 1000), storePath: STORE, runJob: failRun });
    if (r.guard.allow) { probeIdx = i; break; }
  }
  // 探针失败后的**下一 tick** 必须重新挡住（不能又清零放行）
  const after = await tickOnce({ now: new Date(t0 + ((probeIdx ?? 0) + 1) * 60 * 1000), storePath: STORE, runJob: failRun });
  t('★反例（真实节奏）：探针失败后，下一 tick 必须重新挡住（刹车不能永久失效）',
    probeIdx !== null && after.guard.allow === false,
    JSON.stringify({ probeIdx, nextAllow: after.guard.allow, nextReason: after.guard.decision.reason }));
}

// ── O. 入口不能被 opts 覆盖绕过（审计实测传 0 可绕过）──
{
  writeStore([{ name: 'e', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  db.guard = { consecutiveFailures: 9, blockedAt: new Date('2031-03-04T10:00:00Z').getTime(), at: new Date().toISOString() };
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2), 'utf8');

  const r = await tickOnce({
    now: new Date('2031-03-04T10:00:30Z'), storePath: STORE,
    consecutiveFailures: 0,           // ← 恶意/误传的覆盖值
    runJob: async () => ({ state: 'PASS', why: 'ok', ms: 1 }),
  });
  t('★反例（审计实测）：传 consecutiveFailures:0 不能绕过刹车',
    r.guard.allow === false && r.ran.length === 0,
    JSON.stringify({ allow: r.guard.allow, ran: r.ran.length }));
}

// ── P. 并发写回不能抹掉别人的 job 变更（乐观锁）──
{
  writeStore([{ name: 'e', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const runJob = async () => {
    // 模拟「tick 跑 job 期间，另一个进程改了 store」
    const cur = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    cur.jobs.push({ name: 'added-by-other', cron: '0 0 1 1 *', command: 'x', runs: [], lastRunMinute: null });
    cur.at = '2099-01-01T00:00:00.000Z';   // 让别人写过的痕迹可识别
    fs.writeFileSync(STORE, JSON.stringify(cur, null, 2), 'utf8');
    return { state: 'PASS', why: 'ok', ms: 1 };
  };
  await tickOnce({ now: new Date('2031-03-04T10:00:30Z'), storePath: STORE, runJob });
  const after = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  t('★反例（审计点名并发）：tick 写回时不能抹掉别人新增的 job',
    after.jobs.some((j) => j.name === 'added-by-other'),
    JSON.stringify(after.jobs.map((j) => j.name)));
}


// ══════════════════════════════════════════════════════════════
// 刹车可达性（第 6 次审计点名：5 类里只有 tool_failure_loop 可达）
// 下面走 **tick 真实路径**，不伪造 guard 状态。
// ══════════════════════════════════════════════════════════════

// ── Q. budget_exhausted 真的可达：一个 tick 到点 job 数超过预算 ──
{
  const many = Array.from({ length: 6 }, (_, i) => ({
    name: 'j' + i, cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null,
  }));
  writeStore(many);
  const { createSchedulePolicy } = await import('./guard.mjs');
  const r = await tickOnce({
    now: new Date('2031-03-04T10:00:30Z'), storePath: STORE,
    policy: createSchedulePolicy({ budgetLimit: 3 }),
    runJob: async () => ({ state: 'PASS', why: 'ok', ms: 1 }),
  });
  t('★反例（审计点名）：预算 3 时，6 个到点 job 只跑 3 个就停',
    r.ran.length === 3 && r.guard.decision.reason === 'budget_exhausted',
    JSON.stringify({ ran: r.ran.length, reason: r.guard.decision.reason }));
}

// ── R. hard_max 真的可达：单个 tick 跑太久 ──
{
  writeStore([{ name: 'slow', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const { createSchedulePolicy } = await import('./guard.mjs');
  const T0 = new Date('2031-03-04T10:00:30Z').getTime();
  // tickStartedAt 设成 40 分钟前 ⇒ 一进来就超过 hard_max(30min)
  const r = await tickOnce({
    now: new Date(T0), storePath: STORE,
    tickStartedAt: T0 - 40 * 60 * 1000,
    policy: createSchedulePolicy(),
    runJob: async () => ({ state: 'PASS', why: 'ok', ms: 1 }),
  });
  t('★反例（审计点名）：单个 tick 超过 30 分钟 ⇒ hard_max 挡住',
    r.guard.allow === false && r.guard.decision.reason === 'hard_max',
    JSON.stringify({ allow: r.guard.allow, reason: r.guard.decision.reason }));
  t('★反例：hard_max 挡住时不能跑任何 job', r.ran.length === 0, 'ran=' + r.ran.length);
}

// ── S. hard_max 不该误伤：刚开工的 tick 必须放行 ──
{
  writeStore([{ name: 'fast', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const { createSchedulePolicy } = await import('./guard.mjs');
  const T0 = new Date('2031-03-04T10:00:30Z').getTime();
  const r = await tickOnce({
    now: new Date(T0), storePath: STORE,
    tickStartedAt: T0,              // 刚刚开始
    policy: createSchedulePolicy(),
    runJob: async () => ({ state: 'PASS', why: 'ok', ms: 1 }),
  });
  t('★反例：刚开工的 tick 不能被 hard_max 误伤', r.guard.allow === true, JSON.stringify(r.guard.decision));
}

// ── T. 不适用的刹车永远不能触发（防止将来有人「为了凑数」把它打开）──
{
  writeStore([{ name: 'e', cron: '* * * * *', command: 'x', runs: [], lastRunMinute: null }]);
  const r = await tickOnce({
    now: new Date('2031-03-04T10:00:30Z'), storePath: STORE,
    runJob: async () => ({ state: 'PASS', why: 'ok', ms: 1 }),
  });
  const bad = ['idle_timeout', 'max_turns'].includes(r.guard.decision.reason);
  t('★反例：idle_timeout / max_turns 对调度器不适用，永远不能成为停止理由',
    !bad, JSON.stringify({ reason: r.guard.decision.reason }));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log('  tickOnce 反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
