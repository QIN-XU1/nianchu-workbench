#!/usr/bin/env node
/**
 * 任务分派引擎 —— 主 Agent 给各场景分配任务的地基
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是这套模型（参考 orca 的 orchestration + coordinator-loop）
 * ──────────────────────────────────────────────────────────────────────
 *   竞品 Orca（「parallel agentic development」）的核心抽象：
 *     Run      —— 一个目标（objective）
 *     Task     —— 工作单元，带 spec + deps[] ⇒ 组成 DAG
 *     Dispatch —— 一次「把某 Task 交给某 worker/场景」的派发
 *     Receipt  —— 回来的东西（worker_done / question / escalation）
 *     Inbox    —— 协调者的信箱
 *   协调循环：建 Run → 建 Task(带依赖) → task-list --ready → 对每个 ready 派发
 *            → 结束本轮 → 被唤醒 → 处理回执 + 派发新 ready → 全部 settled 后汇总
 *
 *   我们照这个骨架做，但落成本仓库的东西：
 *     · worker = 场景（workbench/外壳/scenarios/*.json 的 12 个）
 *     · 状态存 data/dispatch.json（和 memory-board.json 等同一层）
 *     · 四态沿用项目约定：exit 0=PASS / 3=WARN / 1=FAIL / 2=UNKNOWN
 *
 * ══════════════════════════════════════════════════════════════════════
 * 硬约束（沿用用户要求）
 *   · 判断类的事不机械化：引擎只做状态机和依赖判定，**不替人决定该不该派**
 *   · 越界拦截不做：不阻止用户派发任何场景，只如实记录
 *   · 反例不报 = 检查是假的：每个判定都要有反例
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用法：
 *   node tools/dispatch/dispatch.mjs run-create --objective "把 X 做好"
 *   node tools/dispatch/dispatch.mjs task-create --run <id> --title "调研" --spec "..." --deps '[]'
 *   node tools/dispatch/dispatch.mjs task-list --ready
 *   node tools/dispatch/dispatch.mjs dispatch --task <id> --scene research --agent "AI-1"
 *   node tools/dispatch/dispatch.mjs done --dispatch <id> --result "产出了 3 份报告"
 *   node tools/dispatch/dispatch.mjs inbox
 *   node tools/dispatch/dispatch.mjs list
 *   node tools/dispatch/dispatch.mjs --selftest
 *   node tools/dispatch/dispatch.mjs --json ...
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '../..');
const DB = path.join(REPO, 'workbench/外壳/data/dispatch.json');

// ── 状态机（显式，非法转移必须被拒）──────────────────────────────
export const TASK_STATES = ['pending', 'ready', 'dispatched', 'running', 'done', 'failed', 'blocked'];
export const DISPATCH_STATES = ['queued', 'running', 'done', 'failed'];

/**
 * Task 的合法状态转移
 *
 * 【为什么要显式】隐式状态机（if-else 散落）会让「done 又变回 pending」这种
 * 倒退悄悄发生。这里集中定义，非法转移一律抛错。
 */
export const TASK_TRANSITIONS = {
  pending: ['ready', 'blocked'],
  ready: ['dispatched', 'blocked', 'pending'],
  dispatched: ['running', 'failed', 'ready'],
  running: ['done', 'failed'],
  done: [],            // 终态：不许回流（要重做就新建 Task）
  failed: ['ready'],   // 失败可重试
  blocked: ['ready', 'pending'],
};

export function canTransition(from, to) {
  const allowed = TASK_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * 一个 Task 是否 ready：所有 deps 都已 done
 *
 * 【注意边界】deps 里有不存在的 id ⇒ 永远不 ready（返回 false），
 * 不许静默当「无依赖」——否则依赖写错了会变成「立刻可跑」。
 */
export function depsSatisfied(task, byId) {
  const deps = Array.isArray(task.deps) ? task.deps : [];
  for (const d of deps) {
    const dep = byId[d];
    if (!dep) return false;        // 依赖不存在 ⇒ 不满足（不许当无依赖）
    if (dep.state !== 'done') return false;
  }
  return true;
}

/** 计算一个 Task 在给定上下文里应有的状态（ready 还是 pending） */
export function computeState(task, byId) {
  if (task.state === 'done' || task.state === 'failed' || task.state === 'blocked') return task.state;
  if (task.state === 'dispatched' || task.state === 'running') return task.state;
  return depsSatisfied(task, byId) ? 'ready' : 'pending';
}

const nid = (p) => p + '-' + crypto.randomBytes(4).toString('hex');
const now = () => new Date().toISOString();

/**
 * 引擎工厂 —— 注入 load/save，便于自检时不碰真实磁盘
 */
export function makeDispatch({ load, save }) {
  function read() {
    const d = load();
    return {
      runs: d.runs || [],
      tasks: d.tasks || [],
      dispatches: d.dispatches || [],
      inbox: d.inbox || [],
    };
  }

  function createRun({ objective }) {
    if (!objective || !String(objective).trim()) throw new Error('objective 不能为空');
    const d = read();
    const run = { id: nid('run'), objective: String(objective).trim(), createdAt: now(), status: 'active' };
    d.runs.push(run);
    save(d);
    return run;
  }

  function createTask({ runId, title, spec, deps = [], scene = null }) {
    if (!title || !String(title).trim()) throw new Error('title 不能为空');
    const d = read();
    if (runId && !d.runs.find((r) => r.id === runId)) throw new Error('run 不存在: ' + runId);
    const task = {
      id: nid('task'), runId: runId || null, title: String(title).trim(),
      spec: String(spec || ''), deps: Array.isArray(deps) ? deps.slice() : [],
      scene: scene || null, state: 'pending', createdAt: now(), updatedAt: now(),
    };
    d.tasks.push(task);
    // 建完立刻按依赖刷新一次状态
    const byId = Object.fromEntries(d.tasks.map((t) => [t.id, t]));
    task.state = computeState(task, byId);
    save(d);
    return task;
  }

  /** 刷新所有非终态 task 的 ready/pending（依赖变了要重算） */
  function refresh() {
    const d = read();
    const byId = Object.fromEntries(d.tasks.map((t) => [t.id, t]));
    let changed = 0;
    for (const t of d.tasks) {
      const s = computeState(t, byId);
      if (s !== t.state) { t.state = s; t.updatedAt = now(); changed++; }
    }
    if (changed) save(d);
    return changed;
  }

  function listReady() {
    refresh();
    const d = read();
    return d.tasks.filter((t) => t.state === 'ready');
  }

  function setTaskState(taskId, to) {
    const d = read();
    const t = d.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('task 不存在: ' + taskId);
    if (!canTransition(t.state, to)) {
      throw new Error('非法状态转移: ' + t.state + ' → ' + to + '（' + taskId + '）');
    }
    t.state = to; t.updatedAt = now();
    save(d);
    return t;
  }

  function dispatch({ taskId, scene, agent }) {
    const d = read();
    const t = d.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('task 不存在: ' + taskId);
    if (t.state !== 'ready') throw new Error('只能派发 ready 的 task（当前 ' + t.state + '）');
    const disp = {
      id: nid('disp'), taskId, scene: scene || t.scene || null,
      agent: agent || null, state: 'running', startedAt: now(), endedAt: null, result: null,
    };
    d.dispatches.push(disp);
    t.state = 'dispatched'; t.updatedAt = now();
    if (disp.scene) t.scene = disp.scene;
    save(d);
    return disp;
  }

  function finish({ dispatchId, ok = true, result = '' }) {
    const d = read();
    const disp = d.dispatches.find((x) => x.id === dispatchId);
    if (!disp) throw new Error('dispatch 不存在: ' + dispatchId);
    if (disp.state === 'done' || disp.state === 'failed') {
      throw new Error('dispatch 已结束，不许重复结算: ' + dispatchId);
    }
    const t = d.tasks.find((x) => x.id === disp.taskId);
    disp.state = ok ? 'done' : 'failed';
    disp.endedAt = now();
    disp.result = String(result || '');
    if (t) { t.state = ok ? 'done' : 'failed'; t.updatedAt = now(); }
    // 写入 inbox（协调者信箱）
    d.inbox.push({
      id: nid('msg'), kind: ok ? 'worker_done' : 'worker_failed',
      dispatchId, taskId: disp.taskId, body: String(result || ''), at: now(), read: false,
    });
    save(d);
    // 结算后刷新下游依赖
    const byId = Object.fromEntries(d.tasks.map((x) => [x.id, x]));
    for (const x of d.tasks) {
      const s = computeState(x, byId);
      if (s !== x.state) { x.state = s; x.updatedAt = now(); }
    }
    save(d);
    return { dispatch: disp, task: t || null };
  }

  function inbox({ unreadOnly = false } = {}) {
    const d = read();
    return unreadOnly ? d.inbox.filter((m) => !m.read) : d.inbox;
  }

  function ack({ messageId }) {
    const d = read();
    const m = d.inbox.find((x) => x.id === messageId);
    if (!m) throw new Error('message 不存在: ' + messageId);
    m.read = true;
    save(d);
    return m;
  }

  function list() {
    const d = read();
    return d;
  }

  return { createRun, createTask, listReady, setTaskState, dispatch, finish, inbox, ack, list, refresh };
}

// ── 磁盘读写（原子写：先写临时文件再 rename，防止半截 JSON）─────────
function loadDisk() {
  if (!fs.existsSync(DB)) return { runs: [], tasks: [], dispatches: [], inbox: [] };
  return JSON.parse(fs.readFileSync(DB, 'utf8'));
}
function saveDisk(d) {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, DB);
}

// ══════════════════════════════════════════════════════════════════════
// 自检 —— 每个判定都要有反例（项目铁律：反例不报 = 检查是假的）
// ══════════════════════════════════════════════════════════════════════
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // 内存 store
  const mkStore = () => {
    let db = { runs: [], tasks: [], dispatches: [], inbox: [] };
    return makeDispatch({ load: () => db, save: (d) => { db = JSON.parse(JSON.stringify(d)); } });
  };

  // ── 状态机 ──
  T('正例 · pending → ready 合法', canTransition('pending', 'ready'));
  T('反例 · done → pending 非法（终态不许回流）', !canTransition('done', 'pending'));
  T('反例 · running → dispatched 非法（不许倒转）', !canTransition('running', 'dispatched'));
  T('正例 · failed → ready 合法（可重试）', canTransition('failed', 'ready'));

  const s = mkStore();
  const run = s.createRun({ objective: '测试目标' });
  T('正例 · 建 Run 成功', !!run.id && run.objective === '测试目标');
  T('反例 · 空 objective 必须被拒', (() => { try { s.createRun({ objective: '  ' }); return false; } catch { return true; } })());
  T('反例 · 空 title 的 task 必须被拒', (() => { try { s.createTask({ runId: run.id, title: '' }); return false; } catch { return true; } })());
  T('反例 · 引用不存在的 run 必须被拒', (() => { try { s.createTask({ runId: 'run-nope', title: 'x' }); return false; } catch { return true; } })());

  // ── DAG 依赖 ──
  const t1 = s.createTask({ runId: run.id, title: 'A' });
  const t2 = s.createTask({ runId: run.id, title: 'B', deps: [t1.id] });
  T('正例 · 无依赖的 A 立刻 ready', t1.state === 'ready');
  T('反例 · 依赖 A 的 B 不能 ready（A 未 done）', t2.state === 'pending');

  // B 依赖一个不存在的 id ⇒ 永远不 ready（不许当无依赖）
  const tBad = s.createTask({ runId: run.id, title: 'C', deps: ['task-nope'] });
  T('反例 · deps 指向不存在的 id ⇒ 不许 ready（不许静默当无依赖）', tBad.state === 'pending');

  // ── 派发 ──
  const d1 = s.dispatch({ taskId: t1.id, scene: 'research', agent: 'AI-1' });
  T('正例 · 派发 ready 的 task 成功', d1.state === 'running');
  T('反例 · 不能派发 pending 的 task', (() => { try { s.dispatch({ taskId: t2.id, scene: 'x' }); return false; } catch { return true; } })());
  T('反例 · 不能重复派发同一 task', (() => { try { s.dispatch({ taskId: t1.id, scene: 'y' }); return false; } catch { return true; } })());

  // ── 结算 → 依赖解锁 ──
  const done1 = s.finish({ dispatchId: d1.id, ok: true, result: '产出 3 份报告' });
  T('正例 · 结算后 task=done', done1.task.state === 'done');
  T('正例 · A done 后 B 自动变 ready', (() => { s.refresh(); return s.list().tasks.find((x) => x.id === t2.id).state === 'ready'; })());
  T('反例 · 重复结算同一 dispatch 必须被拒', (() => { try { s.finish({ dispatchId: d1.id }); return false; } catch { return true; } })());

  // ── inbox ──
  const inb = s.inbox({ unreadOnly: true });
  T('正例 · 结算后 inbox 有 1 条未读 worker_done', inb.length === 1 && inb[0].kind === 'worker_done');
  s.ack({ messageId: inb[0].id });
  T('正例 · ack 后未读清零', s.inbox({ unreadOnly: true }).length === 0);

  // ── 失败可重试 ──
  const s2 = mkStore();
  const r2 = s2.createRun({ objective: 'retry' });
  const a2 = s2.createTask({ runId: r2.id, title: 'A' });
  const dd = s2.dispatch({ taskId: a2.id, scene: 'x' });
  s2.finish({ dispatchId: dd.id, ok: false, result: '超时' });
  T('正例 · 失败后 task=failed', s2.list().tasks.find((x) => x.id === a2.id).state === 'failed');
  T('正例 · failed 可回到 ready 重试', s2.setTaskState(a2.id, 'ready').state === 'ready');

  // ── 四态 ──
  const all = s.list();
  T('正例 · inbox 有记录、task 有终态', all.inbox.length >= 1 && all.tasks.some((t) => t.state === 'done'));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain) {
  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('\n  任务分派引擎 · 自检');
    console.log('  ' + '─'.repeat(64));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const cmd = process.argv[2];
  const arg = (k) => {
    const i = process.argv.indexOf('--' + k);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const engine = makeDispatch({ load: loadDisk, save: saveDisk });
  const json = process.argv.includes('--json');
  const out = (o) => console.log(json ? JSON.stringify(o, null, 2) : o);

  try {
    if (cmd === 'run-create') {
      const r = engine.createRun({ objective: arg('objective') });
      out(json ? r : '  ✓ Run 已建: ' + r.id + '  「' + r.objective + '」');
    } else if (cmd === 'task-create') {
      let deps = [];
      const depsRaw = arg('deps');
      if (depsRaw !== undefined && String(depsRaw).trim() !== '') {
        // 【2026-11-17 修·自曝假绿】原实现 parse 失败就 catch 成 []，
        // 结果「依赖写错」被静默当成「无依赖」，任务立刻 ready —— 依赖图悄悄失效。
        // 这正是代码注释里警告的「不许静默当无依赖」，我自己却犯了。
        try { deps = JSON.parse(depsRaw); } catch (e) {
          throw new Error('--deps 不是合法 JSON，拒绝静默当无依赖: ' + depsRaw + ' （' + e.message + '）');
        }
        if (!Array.isArray(deps)) throw new Error('--deps 必须是 JSON 数组，例如 \'["task-1","task-2"]\'');
      }
      const t = engine.createTask({ runId: arg('run'), title: arg('title'), spec: arg('spec'), deps, scene: arg('scene') });
      out(json ? t : '  ✓ Task 已建: ' + t.id + '  [' + t.state + ']  ' + t.title);
    } else if (cmd === 'task-list') {
      const list = process.argv.includes('--ready') ? engine.listReady() : engine.list().tasks;
      if (json) console.log(JSON.stringify(list, null, 2));
      else {
        if (!list.length) console.log('  （无）');
        for (const t of list) console.log('  ' + String(t.id).padEnd(16) + ' [' + t.state.padEnd(10) + '] ' + t.title);
      }
    } else if (cmd === 'dispatch') {
      const d = engine.dispatch({ taskId: arg('task'), scene: arg('scene'), agent: arg('agent') });
      out(json ? d : '  ✓ 已派发: ' + d.id + ' → 场景 ' + (d.scene || '?') + '  执行 ' + (d.agent || '?'));
    } else if (cmd === 'done') {
      const r = engine.finish({ dispatchId: arg('dispatch'), ok: !process.argv.includes('--fail'), result: arg('result') });
      out(json ? r : '  ✓ 已结算: ' + r.dispatch.id + ' → ' + r.dispatch.state);
    } else if (cmd === 'inbox') {
      const m = engine.inbox({ unreadOnly: process.argv.includes('--unread') });
      if (json) console.log(JSON.stringify(m, null, 2));
      else {
        if (!m.length) console.log('  （空）');
        for (const x of m) console.log('  ' + (x.read ? '·' : '●') + ' [' + x.kind + '] ' + String(x.body).slice(0, 60));
      }
    } else if (cmd === 'ack') {
      engine.ack({ messageId: arg('message') });
      out('  ✓ 已读');
    } else if (cmd === 'list') {
      const d = engine.list();
      if (json) console.log(JSON.stringify(d, null, 2));
      else console.log('  runs ' + d.runs.length + ' · tasks ' + d.tasks.length + ' · dispatches ' + d.dispatches.length + ' · inbox ' + d.inbox.length);
    } else {
      console.log('  用法: run-create|task-create|task-list|dispatch|done|inbox|ack|list|--selftest');
      process.exit(2);
    }
  } catch (e) {
    console.error('  ✗ ' + e.message);
    process.exit(1);
  }
}
