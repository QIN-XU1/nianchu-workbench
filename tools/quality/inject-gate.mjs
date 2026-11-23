#!/usr/bin/env node
/**
 * 进程闸 —— 防止「注入类度量互相嵌套」导致进程爆炸。
 *
 * 【为什么需要】2026-11-18 实测到真正的根因，比「还原逻辑写错」严重得多：
 *
 *   verify-goal → verify-evolve → measure-verifier-efficacy（注入 8 个文件）
 *                → mutation-check（再注入 9 个文件，且跑验收器）
 *                → 验收器（如 verify-scheduler）自己又 spawn 子进程
 *
 *   每一层都有 300s 超时，一旦某层卡住，孤儿进程就堆起来。
 *   实测抓到 **60 个本仓库 node 进程同时活着**，并发地注入/还原同一批文件：
 *     · git diff 报 `error: short read while indexing tools/cost/replay.mjs`
 *     · 同一份度量两轮结果不一致（这轮测到注入态、下轮测到还原态）
 *     · 残留反复出现（第七次），且**不是还原逻辑的错**
 *
 * 所以：**注入类工具必须先抢闸**，拿不到就不跑（判 UNKNOWN，不硬跑）。
 * 这不是「越界拦截」（用户明确不做那类机制）—— 它只管自己不要踩自己。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const LOCK = path.join(os.tmpdir(), 'nianchu-inject.lock');

/** 闸的存活期：超过这个时间的锁视为孤儿（上一个进程被 kill 了） */
const STALE_MS = 15 * 60 * 1000;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 抢闸。拿到返回 {ok:true, release}，拿不到返回 {ok:false, why}。
 * @param {string} who 谁在抢（写进锁文件，便于排查）
 */
export function acquire(who) {
  try {
    const raw = fs.readFileSync(LOCK, 'utf8');
    const held = JSON.parse(raw);
    const age = Date.now() - new Date(held.at).getTime();
    if (age < STALE_MS && held.pid !== process.pid && alive(held.pid)) {
      return {
        ok: false,
        why: '另一个注入类工具正在跑（' + held.who + ' · PID ' + held.pid + ' · ' + Math.round(age / 1000) + 's 前）',
      };
    }
    // 锁过期或持有者已死 ⇒ 可以接管
  } catch { /* 没有锁文件，正常 */ }

  try {
    fs.writeFileSync(LOCK, JSON.stringify({ who, pid: process.pid, at: new Date().toISOString() }), 'utf8');
  } catch (e) {
    return { ok: false, why: '写不了锁文件：' + String(e && e.message).slice(0, 60) };
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const held = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      if (held.pid === process.pid) fs.unlinkSync(LOCK);
    } catch { /* 已经不在了 */ }
  };
  process.on('exit', release);
  return { ok: true, release };
}

/**
 * 抢闸；拿不到就按四态打印 UNKNOWN 并退出（exit 2）。
 * 把这段收在这里，调用方只写一行 —— 也让主文件不因重复的打印逻辑涨过 B4 红线。
 * @param {string} who
 * @param {string} what 打印时的自称（如「度量」「变异测试」）
 */
export function requireGate(who, what) {
  const g = acquire(who);
  if (!g.ok) {
    console.log('');
    console.log('  \u2754 ' + what + '\u6ca1\u8dd1\uff1a' + g.why);
    console.log('  \uff08\u4e0d\u786c\u8dd1 \u2014\u2014 \u5e76\u53d1\u6ce8\u5165\u4f1a\u8ba9\u4e24\u8fb9\u4e92\u76f8\u8986\u76d6\uff0c\u6570\u5b57\u4e0d\u53ef\u4fe1\uff09');
    console.log('  \u56db\u6001: UNKNOWN \u2014\u2014 \u62ff\u4e0d\u5230\u8fdb\u7a0b\u95f8\uff0c\u5224\u4e0d\u4e86');
    console.log('');
    process.exit(2);
  }
  process.on('exit', () => { try { g.release(); } catch { /* \u5df2\u91ca\u653e */ } });
  return g;
}

/** 数一下本仓库还活着多少个 node 进程（用于自检「是不是我留下的」） */
export function countRepoNodeProcesses() {
  // 不引外部依赖：用 tasklist 拿不到命令行，所以这里只做「本进程可见」的粗估
  return { note: '精确计数需要 CIM/tasklist，本函数不实现（如实标注）' };
}
