#!/usr/bin/env node
/**
 * 调度器 tick（可复用，不依赖 CLI）。
 *
 * 为什么单独建：独立审计指出 A11 的真缺口是
 *   「tools/schedule/scheduler.mjs:308-334 的 daemon **没人启动**；
 *     evidence/schedule/jobs.json 只有 3 job / 4 run，最后一次是手动 run」
 * 也就是说：cron 解析器是真的，但**没有任何进程在按时触发它**。
 *
 * 这个模块把 tick 抽成可调用函数，供 dev server 的常驻 tick 与
 * POST /api/scheduler/tick 端点共用 —— 这样「触发」这件事真的发生了。
 *
 * 不改 scheduler.mjs 的 CLI 路径，避免动到 verify-scheduler 的 12/12。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCron, matches, runJob } from './scheduler.mjs';
import { guardTick, createSchedulePolicy } from './guard.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const STORE = path.join(REPO, 'evidence/schedule/jobs.json');

function load(storePath = STORE) {
  if (!fs.existsSync(storePath)) return { what: '念初调度器 job 存储', at: new Date().toISOString(), jobs: [] };
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return { what: '念初调度器 job 存储', at: new Date().toISOString(), jobs: [] };
  }
}

function save(db, storePath = STORE) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  db.at = new Date().toISOString();
  fs.writeFileSync(storePath, JSON.stringify(db, null, 2) + '\n', 'utf8');
}

/**
 * 跑一次 tick：找出到点的 job、执行、落盘。
 * @param {{ now?: Date, dryRun?: boolean }} [opts]
 * @returns {Promise<{at:string, minuteKey:string, total:number, due:number, ran:Array<{name:string,state:string,why:string,ms:number}>}>}
 */
export async function tickOnce(opts = {}) {
  // 可注入 runJob / store，便于测试（默认用真的 runJob 与真的 jobs.json）
  const runJobFn = opts.runJob || runJob;
  // storePath 可注入 —— 测试用临时文件，避免读真 jobs.json 导致 hermetic 失败
  const storePath = opts.storePath || STORE;
  const now = opts.now || new Date();
  // 本次 tick 的真实开始时刻（用于 hard_max：单个 tick 不该跑太久）
  const tickStartedAt = opts.tickStartedAt ?? now.getTime();
  const minuteKey = now.toISOString().slice(0, 16);
  const db = load(storePath);

  const due = [];
  for (const j of db.jobs || []) {
    let hit = false;
    try {
      hit = matches(parseCron(j.cron), now) && j.lastRunMinute !== minuteKey;
    } catch {
      hit = false; // 坏 cron 不能让整次 tick 崩掉
    }
    if (hit) due.push(j);
  }

  // ── 停止判定接入（第 4 次审计：判定器必须有调用方）──
  // 用同一套 stop.mjs 语义，而不是在调度器里再写一套 if。
  const policy = opts.policy || createSchedulePolicy();
  // 【2026-11-17 自查抓到】这里原来用 opts.consecutiveFailures ——
  // 而生产路径（api-handler → tickOnce({})）永远不传它，所以**入口 guard 是死的**：
  // 已经累积到阈值时，tick 仍会跑第一个 job，只有跑完后的复查才拦得住。
  // 同一个值有两处来源，之前只修了循环里那处。现在入口也读落盘值。
  let persistedFailures = Number(db.guard?.consecutiveFailures) || 0;

  // ── 熔断器 half-open（2026-11-17 真跑才发现的缺陷）──
  // 入口 guard 生效后，被挡住的 tick 不会跑任何 job ⇒ 永远没有「成功」来清零
  // ⇒ 计数永不回落 ⇒ 调度器永久停摆。
  // 标准做法：挡住超过冷却期后清零放行一次（探针）。再失败就重新累积。
  const COOLDOWN_MS = Number(opts.cooldownMs ?? 10 * 60 * 1000);
  const lastBlockedAt = Number(db.guard?.blockedAt) || 0;
  if (persistedFailures > 0 && lastBlockedAt && now.getTime() - lastBlockedAt >= COOLDOWN_MS) {
    persistedFailures = 0;
  }

  const { allow, decision } = guardTick({
    now: now.getTime(),
    // 【第 6 次审计】hard_max 原来用 opts.startedAt / db.guard.startedAt，两者都从未写入
    // ⇒ 条件结构性不可达。现在传**本次 tick 的真实开始时间**：
    // hard_max 的语义是「单个 tick 不该跑太久」，这正是调度器需要的。
    tickStartedAt: opts.tickStartedAt ?? tickStartedAt,
    // 【第 6 次审计】去掉 opts 覆盖：调用方传 0 就能绕过刹车（审计实测过）。
    // 生产状态的唯一来源是落盘的 db.guard。
    consecutiveFailures: persistedFailures,
    // 本轮还没跑任何 job
    jobsRan: 0,
    jobsDue: due.length,
  }, policy);
  if (!allow) {
    // 记录「被挡住的时间」，供下一 tick 判断是否已过冷却期（half-open 探针）
    db.guard = {
      ...(db.guard || {}),
      consecutiveFailures: persistedFailures,
      lastDecision: decision,
      // 【第 6 次审计①】只在**首次**挡住时记时间。
      // 原来每次挡住都刷新 ⇒ 60s 常驻 tick 下冷却期永远差 60s ⇒ 永久停摆。
      blockedAt: Number(db.guard?.blockedAt) || now.getTime(),
      at: new Date().toISOString(),
    };
    if (!opts.dryRun) save(db, storePath);
    return {
      at: now.toISOString(), minuteKey, total: (db.jobs || []).length,
      due: due.length, ran: [],
      guard: { allow: false, decision, consecutiveFailures: persistedFailures },
    };
  }

  const ran = [];
  let lastGuard = null;
  // 【第 5 次审计】失败计数必须**落盘持久化**，否则每 tick 从 0 起算，
  // 跨 tick 永远不累积，连续失败条件形同虚设。
  let consecutiveFailures = persistedFailures;
  for (const j of due) {
    const r = await runJobFn(j);
    if (r.state === 'FAIL') consecutiveFailures++;
    else consecutiveFailures = 0;

    j.runs = Array.isArray(j.runs) ? j.runs : [];
    j.runs.push(r);
    if (j.runs.length > 50) j.runs = j.runs.slice(-50);
    j.lastRunMinute = minuteKey;
    ran.push({ name: j.name, state: r.state, why: r.why, ms: r.ms });

    // 每个 job 之后复查 —— 连续失败够了就停，不再往下跑
    lastGuard = guardTick({
      now: now.getTime(),
      tickStartedAt,
      // 必须用 tick 自己的时钟（now），不能用 Date.now() —— 两个时钟混用会让 idle 判定错乱
    lastActivityAt: now.getTime(),
      consecutiveFailures,
      // 预算按「本轮已跑数」判
      jobsRan: ran.length,
      jobsDue: due.length - ran.length,
    }, policy);
    if (!lastGuard.allow) break;
  }

  // 【第 5 次审计】失败计数与最后判定必须写回 db，否则：
  //   · 跨 tick 不累积（条件不可达）
  //   · 对外永远报 allow:true（假绿）
  db.guard = {
    consecutiveFailures,
    // 【第 6 次审计②】探针失败后必须**重新计时**，否则下一 tick 又满足冷却条件
    // ⇒ 又清零 ⇒ 刹车永久失效。
    //   · 成功（计数 0）⇒ 清掉 blockedAt
    //   · 失败（计数 > 0）⇒ 用本次 tick 的时间重新计时
    blockedAt: consecutiveFailures === 0 ? 0 : now.getTime(),
    lastDecision: lastGuard ? lastGuard.decision : decision,
    // 记录最后活动时间：下一 tick 的 idle_timeout 判定要用它，
    // 否则 idle 条件同样永远不可达（同一类 bug 的第三处）
    // 必须用 tick 自己的时钟（now），不能用 Date.now() —— 两个时钟混用会让 idle 判定错乱
    lastActivityAt: now.getTime(),
    at: new Date().toISOString(),
  };
  // guard 状态也要落盘（即使没有 due，也要保留 consecutiveFailures 的更新）
  //
  // 【第 6 次审计④】并发保护：tick 可能耗时数百秒（跑 job），期间别的 tick
  // （如 60s daemon）可能已经改过 store。整文件写回会抹掉它的写入。
  // 这里做乐观锁：写前重读，如果 at 变了就**只合并 guard 字段**，不覆盖 jobs。
  // 【第 103 轮修·真回归】第 96 轮我把 `let storeCorrupt` 声明在了下面这个 if 块内，
  // 却在函数末尾的 return 里引用 → ReferenceError: storeCorrupt is not defined，
  // 导致 /api/scheduler/tick 每次都 500。必须声明在**函数作用域**。
  let storeCorrupt = false;
  if (!opts.dryRun) {
    let latest = null;
    // 【第 96 轮修】原来 `try { latest = load() } catch { /* 读失败就按普通写 */ }`：
    // 若 store 文件**存在但损坏**，latest=null 会走 else 分支 save(db)，
    // 用内存里的 db 把损坏文件**覆盖掉** —— 与 tools/memory/bulk.mjs 同型的静默丢数据风险。
    // 现在：文件不存在 → 正常写；文件存在但读不出来 → **不写**，把 storeCorrupt 带回给调用方。
    try {
      latest = load(storePath);
    } catch {
      if (fs.existsSync(storePath)) storeCorrupt = true;
    }
    if (storeCorrupt) {
      // 不覆盖损坏文件；调用方应据此告警并人工处理
    } else if (latest && latest.at && db.at && latest.at !== db.at) {
      // 文件被别人改过 —— 只合并 guard，不动 jobs（避免抹掉别人的 job 变更）
      latest.guard = db.guard;
      save(latest, storePath);
    } else {
      save(db, storePath);
    }
  }

  // 用**最后一次真实判定**，不再无条件写 allow:true
  const finalDecision = lastGuard ? lastGuard.decision : decision;
  const finalAllow = lastGuard ? lastGuard.allow : allow;
  return {
    at: now.toISOString(), minuteKey, total: (db.jobs || []).length, due: due.length, ran,
    guard: { allow: finalAllow, decision: finalDecision, consecutiveFailures },
    // 库文件损坏时本函数拒绝回写（避免用内存 db 覆盖损坏文件），调用方据此告警
    storeCorrupt,
  };
}
