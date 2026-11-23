#!/usr/bin/env node
/**
 * 防重入与进程闸的反例测试 —— 每条都要能红。
 * 用法：node tools/quality/inject-gate.test.mjs
 *
 * 【为什么必须有这个文件】这两处防护是 2026-11-18 才加的，起因是两次真事故：
 *   ① 60 个孤儿进程并发注入/还原同一批文件（残留第七次）
 *   ② fpr-sweep 会跑 verify-goal，而 verify-goal → verify-evolve → fpr-sweep ⇒ 进程爆炸
 *
 * 按纪律「反例不报 = 这个检查是假的」：加防护还不够，必须证明**坏掉时它会报**。
 * 本文件测两件事：
 *   A. 进程闸：拿不到闸要判 UNKNOWN（不硬跑）；闸过期/持有者已死要能接管
 *   B. 防重入：NIANCHU_FPR_SWEEP=1 时，fpr-sweep 必须跳过会反向触发的验收器
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquire } from './inject-gate.mjs';

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const REPO = path.resolve(import.meta.dirname, '../..');
const LOCK = path.join(os.tmpdir(), 'nianchu-inject.lock');

// ── A. 进程闸 ──
{
  try { fs.unlinkSync(LOCK); } catch { /* 本来就没有 */ }
  const a = acquire('test-a');
  t('正例：空锁时能抢到闸', a.ok === true, JSON.stringify(a));

  // 同一个进程再抢一次：应视为「自己持有」而不拒绝（否则自己调自己会死锁）
  const a2 = acquire('test-a-again');
  t('正例：同进程重复抢闸不拒绝（否则自调用会死锁）', a2.ok === true, JSON.stringify(a2));

  a.release();
  t('正例：释放后锁文件被删掉', !fs.existsSync(LOCK), fs.existsSync(LOCK) ? '锁还在' : '');
}
{
  // ★核心反例：别的活进程持锁时，必须拒绝
  try { fs.unlinkSync(LOCK); } catch { /* 无 */ }
  const held = acquire('test-holder');
  t('前置：先由本进程持有闸', held.ok === true);

  // 伪造一个「别的活进程」持有锁：用当前 node 的父进程 PID（一定活着且不是本进程）
  const otherPid = process.ppid;
  fs.writeFileSync(LOCK, JSON.stringify({ who: 'other-alive', pid: otherPid, at: new Date().toISOString() }), 'utf8');
  const denied = acquire('test-b');
  t('★反例：别的**活**进程持锁 ⇒ 必须拒绝（这是防并发注入的核心）',
    denied.ok === false && /另一个注入类工具/.test(denied.why), JSON.stringify(denied));

  // 清理
  try { fs.unlinkSync(LOCK); } catch { /* 无 */ }
  held.release();
}
{
  // ★反例：持有者已死 + 锁未过期 ⇒ 应能接管（否则一次 kill 就把闸永久锁死）
  try { fs.unlinkSync(LOCK); } catch { /* 无 */ }
  fs.writeFileSync(LOCK, JSON.stringify({ who: 'dead', pid: 999999, at: new Date().toISOString() }), 'utf8');
  const took = acquire('test-c');
  t('★反例：持有者进程已死 ⇒ 必须能接管（否则一次 kill 永久锁死）', took.ok === true, JSON.stringify(took));
  took.release();
}
{
  // ★反例：锁过期（>15min）⇒ 应能接管
  try { fs.unlinkSync(LOCK); } catch { /* 无 */ }
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  fs.writeFileSync(LOCK, JSON.stringify({ who: 'stale', pid: process.ppid, at: old }), 'utf8');
  const took = acquire('test-d');
  t('★反例：锁已过期 20 分钟 ⇒ 必须能接管（孤儿锁不许永久挡住）', took.ok === true, JSON.stringify(took));
  took.release();
}
{
  // ★反例：锁文件是坏 JSON ⇒ 应能接管（不能因为读不出来就永远拒绝）
  try { fs.unlinkSync(LOCK); } catch { /* 无 */ }
  fs.writeFileSync(LOCK, '{not json', 'utf8');
  const took = acquire('test-e');
  t('★反例：锁文件损坏 ⇒ 必须能接管（读不出来不等于有人持锁）', took.ok === true, JSON.stringify(took));
  took.release();
}

// ── B. 防重入 ──
{
  // 直接跑 fpr-sweep，带 NIANCHU_FPR_SWEEP=1，看它是否跳过会反向触发的验收器。
  // 只跑到「打印 SKIP」就够 —— 不跑完整 20 个（那要 20 分钟）。
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(REPO, 'tools/evolve/fpr-sweep.mjs')], {
      cwd: REPO, encoding: 'utf8', timeout: 1500000,
      env: { ...process.env, NIANCHU_FPR_SWEEP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  t('★反例：设了 NIANCHU_FPR_SWEEP=1 ⇒ 必须跳过 verify-goal（否则无限递归）',
    /SKIP[^\n]*verify-goal\.mjs/.test(out), out.split('\n').filter((l) => /SKIP/.test(l)).join(' | ').slice(0, 120));
  t('★反例：设了 NIANCHU_FPR_SWEEP=1 ⇒ 必须跳过 verify-evolve',
    /SKIP[^\n]*verify-evolve\.mjs/.test(out), '');
  // 【2026-11-18 修】fpr 的分母标准改了：只算「产出了 PASS/WARN 判定」的验收器。
  // 带防重入时：20 个里跳 2 个（verify-goal / verify-evolve），剩 18 个实扫，
  // 其中 1 个（audit-lead）如实报 UNKNOWN 不计入分母 ⇒ 可判定 = 17。
  t('正例：带防重入时可判定数应为 17（20 − 2 跳过 − 1 如实 UNKNOWN）',
    /0\/17/.test(out), (out.match(/fpr = FAIL\/[^\n]*/) || [''])[0]);
  t('正例：fpr 分母规则要写在输出里（可判定 17 · 如实报 UNKNOWN 1）',
    /可判定 17/.test(out), '');
}

// 收尾：别把锁留下
try { fs.unlinkSync(LOCK); } catch { /* 无 */ }

console.log('\n  进程闸 + 防重入 反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
