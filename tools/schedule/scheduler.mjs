#!/usr/bin/env node
/**
 * A11 调度器（自研，不借 hermes cron）
 *
 * 之前 A11 记「部分」，证据写得很清楚：「定时任务来自 hermes 的 cron/ 与
 * scheduler_provider，我们**没有自己的调度器**」。
 *
 * 这一层是自研的。设计上刻意与「跑个 setInterval」区分开：
 *
 *   1. 持久化 job  —— job 定义存 JSON，进程重启不丢；不是内存里的定时器
 *   2. 五段 cron   —— 分 时 日 月 周，支持星号 / 逗号 / 区间 / 步进；可复算的下次触发时间
 *   3. 真实执行    —— 每条 job 是一个 shell 命令，跑完记 exit / stdout / stderr / 耗时
 *   4. 留痕        —— 每次执行追加到 runs 数组，带四态判定
 *   5. 四态        —— exit 0 = PASS；非 0 = FAIL；超时/起不来 = UNKNOWN
 *      **不许把 UNKNOWN 当 PASS**，这是本项目的核心纪律
 *   6. 幂等        —— 同一分钟内重复 tick 不会跑两次（记 lastRunMinute）
 *
 * 用法：
 *   node tools/schedule/scheduler.mjs add --name=daily-check --cron="0 9 * * *" --cmd="node prototype/hermes-agents/verify-goal.mjs"
 *   node tools/schedule/scheduler.mjs list
 *   node tools/schedule/scheduler.mjs tick            # 跑所有到点的 job（可被外部 cron/任务计划器调）
 *   node tools/schedule/scheduler.mjs run <id>        # 立刻跑一次（用于验证）
 *   node tools/schedule/scheduler.mjs next            # 列出各 job 下次触发时间
 *   node tools/schedule/scheduler.mjs remove <id>
 *   node tools/schedule/scheduler.mjs daemon --interval=30000   # 常驻循环 tick（真实调度）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const STORE = path.join(REPO, 'evidence/schedule/jobs.json');

// ── 存储 ──
function load() {
  if (!fs.existsSync(STORE)) return { what: '念初调度器 job 存储', at: new Date().toISOString(), jobs: [] };
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return { what: '念初调度器 job 存储', at: new Date().toISOString(), jobs: [] };
  }
}
function save(db) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  db.at = new Date().toISOString();
  fs.writeFileSync(STORE, JSON.stringify(db, null, 2) + '\n', 'utf8');
}

// ── cron 解析（五段：分 时 日 月 周）──
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 },   // 0 = 周日
];

/** 把一段 cron 字段展开成允许值集合。支持 * , - /n */
export function parseField(expr, { min, max }) {
  const out = new Set();
  for (const part of String(expr).split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    const body = stepMatch ? stepMatch[1] : part;
    if (step < 1) throw new Error('步长必须 >=1: ' + part);

    let lo, hi;
    if (body === '*') { lo = min; hi = max; }
    else if (body.includes('-')) {
      const [a, b] = body.split('-').map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('区间不合法: ' + part);
      lo = a; hi = b;
    } else {
      const n = Number(body);
      if (!Number.isFinite(n)) throw new Error('数值不合法: ' + part);
      lo = n; hi = n;
    }
    if (lo < min || hi > max) throw new Error(`${part} 超出范围 ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 必须是 5 段（分 时 日 月 周），实际 ' + parts.length + ' 段');
  const set = {};
  FIELDS.forEach((f, i) => { set[f.name] = parseField(parts[i], f); });
  return set;
}

/** 某时刻是否命中 cron */
export function matches(cron, date = new Date()) {
  return cron.minute.has(date.getMinutes())
    && cron.hour.has(date.getHours())
    && cron.dom.has(date.getDate())
    && cron.month.has(date.getMonth() + 1)
    && cron.dow.has(date.getDay());
}

/** 下次触发时间（从 from 之后开始找，最多找 366 天） */
export function nextRun(cron, from = new Date()) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(cron, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// ── 执行 ──
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 跑一条 job，返回四态结果。
 *
 * 判据：
 *   exit 0            → PASS
 *   非 0              → FAIL
 *   超时 / 起不来     → UNKNOWN（「跑不起来」和「跑完报错」是两件事，不许混）
 *
 * ⚠ 实测踩到的坑：`spawnSync(shell:true, timeout)` 在 Windows 上**对子进程超时不生效** ——
 *   一个 60 秒的 job 配 3 秒超时，实测跑了 60 秒还被判成 PASS。
 *   原因：shell:true 时 spawnSync 的 timeout 只杀中间 cmd.exe，孙进程继续跑。
 *   解决：不用 spawnSync 的 timeout，改成 spawn + 手动计时 + taskkill /T 整棵树。
 */
export function runJob(job) {
  const t0 = Date.now();
  const timeout = job.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cwd = job.cwd ? path.resolve(REPO, job.cwd) : REPO;

  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn(job.cmd, [], { shell: true, cwd, windowsHide: true });

    const finish = (state, why, exit) => {
      if (settled) return;
      settled = true;
      resolve({
        at: new Date().toISOString(), state, why, exit,
        ms: Date.now() - t0,
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
        ...(job._sync ? {} : {}),
      });
    };

    child.stdout?.on('data', (b) => { stdout += String(b); });
    child.stderr?.on('data', (b) => { stderr += String(b); });

    const timer = setTimeout(() => {
      // 整棵树杀掉（Windows），否则孙进程继续跑
      try {
        execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore', windowsHide: true });
      } catch {
        try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      }
      finish('UNKNOWN', '超时 ' + Math.round(timeout / 1000) + 's（判不了是慢还是卡住）', null);
    }, timeout);

    child.on('error', (e) => {
      clearTimeout(timer);
      finish('UNKNOWN', '起不来：' + String(e.message).slice(0, 80), null);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (signal) return finish('UNKNOWN', '被信号终止 ' + signal, null);
      if (code === 0) return finish('PASS', 'exit 0', 0);
      return finish('FAIL', 'exit ' + code, code);
    });
  });
}

// ── CLI ──
function flag(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}
function positional(n) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  return args[n];
}

const ICON = { PASS: '✓', WARN: '🟡', FAIL: '✗', UNKNOWN: '?' };

// 只有直接执行时才跑 CLI —— 被 import 时（测试/验收器用）只导出函数，不打印不退出。
// 第一版没这个判定，导致 import 立刻打印 help 并 process.exit(0)。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (!isMain) {
  // 被 import：什么都不做，函数已通过 export 暴露
} else {
const cmd = positional(0);

if (!cmd) {
  console.log('');
  console.log('  念初调度器 —— 自研，持久化 job + 五段 cron + 留痕');
  console.log('  ' + '─'.repeat(64));
  console.log('  add --name=X --cron="0 9 * * *" --cmd="node ..."');
  console.log('  list · tick · run <id> · next · remove <id> · daemon --interval=30000');
  console.log('');
  process.exit(0);
}

const db = load();

if (cmd === 'add') {
  const name = flag('name');
  const cronExpr = flag('cron');
  const c = flag('cmd');
  if (!name || !cronExpr || !c) {
    console.error('  需要 --name= --cron= --cmd=');
    process.exit(2);
  }
  try { parseCron(cronExpr); } catch (e) { console.error('  cron 不合法: ' + e.message); process.exit(2); }
  if (db.jobs.some((j) => j.name === name)) { console.error('  同名 job 已存在: ' + name); process.exit(2); }
  const cron = parseCron(cronExpr);
  const job = {
    id: 'job-' + Date.now().toString(36),
    name,
    cron: cronExpr,
    cmd: c,
    cwd: flag('cwd'),
    timeoutMs: flag('timeout') ? Number(flag('timeout')) * 1000 : DEFAULT_TIMEOUT_MS,
    createdAt: new Date().toISOString(),
    lastRunMinute: null,
    runs: [],
  };
  db.jobs.push(job);
  save(db);
  console.log('  ✓ 已添加 ' + job.id + '  ' + name);
  console.log('    cron: ' + cronExpr + '   下次: ' + (nextRun(cron)?.toISOString() || '永不'));
  process.exit(0);
}

if (cmd === 'list') {
  console.log('');
  console.log('  调度器 job 列表（' + db.jobs.length + ' 条）');
  console.log('  ' + '─'.repeat(76));
  if (!db.jobs.length) console.log('  （空）');
  for (const j of db.jobs) {
    const last = j.runs.length ? j.runs[j.runs.length - 1] : null;
    console.log('  ' + ICON[last?.state || 'UNKNOWN'] + ' ' + j.name.padEnd(22) +
      j.cron.padEnd(16) + ' 跑过 ' + j.runs.length + ' 次' +
      (last ? ' 最近 ' + last.state + ' (' + last.at.slice(11, 19) + ')' : ' 从未跑过'));
    console.log('      ' + j.cmd.slice(0, 90));
  }
  console.log('');
  process.exit(0);
}

if (cmd === 'next') {
  console.log('');
  for (const j of db.jobs) {
    const n = nextRun(parseCron(j.cron));
    console.log('  ' + j.name.padEnd(22) + j.cron.padEnd(16) + ' → ' + (n ? n.toISOString() : '永不'));
  }
  console.log('');
  process.exit(0);
}

if (cmd === 'remove') {
  const id = positional(1);
  const before = db.jobs.length;
  db.jobs = db.jobs.filter((j) => j.id !== id && j.name !== id);
  save(db);
  console.log('  ✓ 删掉 ' + (before - db.jobs.length) + ' 条');
  process.exit(0);
}

if (cmd === 'run') {
  const key = positional(1);
  const j = db.jobs.find((x) => x.id === key || x.name === key);
  if (!j) { console.error('  找不到 job: ' + key); process.exit(2); }
  console.log('  跑 ' + j.name + ' …');
  const r = await runJob(j);
  j.runs.push(r);
  if (j.runs.length > 50) j.runs = j.runs.slice(-50);
  save(db);
  console.log('  ' + ICON[r.state] + ' ' + r.state + '  ' + r.why + '  ' + r.ms + 'ms');
  if (r.stdout) console.log('  stdout 尾: ' + r.stdout.trim().split('\n').slice(-2).join(' | '));
  process.exit(r.state === 'PASS' ? 0 : r.state === 'FAIL' ? 1 : 2);
}

if (cmd === 'tick') {
  const now = new Date();
  const minuteKey = now.toISOString().slice(0, 16);
  const due = db.jobs.filter((j) => {
    try { return matches(parseCron(j.cron), now) && j.lastRunMinute !== minuteKey; } catch { return false; }
  });
  console.log('');
  console.log('  tick @ ' + minuteKey + ' —— 到点 ' + due.length + ' 条 / 共 ' + db.jobs.length + ' 条');
  for (const j of due) {
    const r = await runJob(j);
    j.runs.push(r);
    if (j.runs.length > 50) j.runs = j.runs.slice(-50);
    j.lastRunMinute = minuteKey;
    console.log('  ' + ICON[r.state] + ' ' + j.name.padEnd(22) + r.state.padEnd(8) + r.why + '  ' + r.ms + 'ms');
  }
  if (due.length) save(db);
  console.log('');
  process.exit(0);
}

if (cmd === 'daemon') {
  const interval = Number(flag('interval', '30000'));
  console.log('');
  console.log('  调度器常驻 —— 每 ' + interval + 'ms tick 一次（Ctrl+C 停）');
  console.log('  job ' + db.jobs.length + ' 条');
  console.log('');
  let ticks = 0;
  const loop = async () => {
    ticks++;
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16);
    const d = load();
    const due = d.jobs.filter((j) => {
      try { return matches(parseCron(j.cron), now) && j.lastRunMinute !== minuteKey; } catch { return false; }
    });
    for (const j of due) {
      const r = await runJob(j);
      j.runs.push(r);
      if (j.runs.length > 50) j.runs = j.runs.slice(-50);
      j.lastRunMinute = minuteKey;
      console.log('  ' + ICON[r.state] + ' ' + now.toISOString().slice(11, 19) + ' ' + j.name + '  ' + r.state + '  ' + r.why);
    }
    if (due.length) save(d);
    if (ticks % 20 === 0) console.log('  … tick #' + ticks + ' @ ' + now.toISOString().slice(11, 19) + '（无到点 job）');
    setTimeout(loop, interval);
  };
  loop();
} else if (cmd !== 'add' && cmd !== 'list' && cmd !== 'next' && cmd !== 'remove' && cmd !== 'run' && cmd !== 'tick') {
  console.error('  未知命令: ' + cmd);
  process.exit(2);
}
}  // ← end isMain
