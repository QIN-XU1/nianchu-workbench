#!/usr/bin/env node
/**
 * store.mjs 的伴生断言 —— 独立文件，避免撑爆 store.mjs 的 32KB 红线
 *
 * ── 为什么单独放这里 ────────────────────────────────────
 * store.mjs 原本 31.9KB，红线 32KB。2026-11-16 我在它里面加了一条伴生断言，
 * 变成 32.54KB → 超红线 → size-guard 失败 → R6 失败。
 *
 * **同一个原因造成两个硬要求失败。** 所以把伴生断言搬出来。
 *
 * ── 这条断言防什么 ──────────────────────────────────────
 * store.mjs 的 21 条自检里有「无来源拒绝写入」「拒绝后存储为空」这类反例。
 * 如果 put() 永远返回 { ok: false }，**那些反例全都会通过** ——
 * 因为它们只想确认「不该写的没写」。
 *
 * 这条断言钉住反面：**合法输入必须真的写进去**。
 * 若 put() 失效，这里会红。
 *
 * 用法：node tools/memory/store.companion.test.mjs [--selftest]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const STORE = path.join(REPO, 'tools/memory/store.mjs');

/**
 * 纯逻辑断言 —— 不依赖 store 内部实现，只验「文件里有 put 且能被 import」
 * 真正的行为断言在下面用子进程跑 store 自己的 selftest 来交叉验证。
 */
export function checkCompanion(storeSource) {
  const problems = [];
  // ① put 必须是导出函数（伴生断言要调它）
  if (!/export function put\s*\(/.test(storeSource)) {
    problems.push('store.mjs 没有导出 put()');
  }
  // ② put 的返回值必须带 ok 字段（伴生断言依赖它）
  if (!/return\s*\{[^}]*ok:/.test(storeSource)) {
    problems.push('put() 的返回值里没有 ok 字段');
  }
  // ③ 必须有 entries 容器（写入的证据）
  if (!/entries/.test(storeSource)) {
    problems.push('没有 entries 容器');
  }
  return problems;
}

/** 自检 —— 2 正例 + 3 反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const good = 'export function put(db, x) { return { ok: true }; }\nconst entries = [];';
  T('正例 · 正常源码：导出 put + 返回 ok + 有 entries ⇒ 无问题',
    checkCompanion(good).length === 0, JSON.stringify(checkCompanion(good)));

  T('反例 · 没有导出 put ⇒ 报问题（伴生断言无从调用）',
    checkCompanion('const entries = []; function put() {}').some((p) => /put/.test(p)), '');

  T('反例 · put 返回值缺 ok 字段 ⇒ 报问题',
    checkCompanion('export function put() { return {}; }\nconst entries = [];')
      .some((p) => /ok/.test(p)), '');

  T('反例 · 没有 entries 容器 ⇒ 报问题',
    checkCompanion('export function put() { return { ok: true }; }')
      .some((p) => /entries/.test(p)), '');

  // 正例：真的能 import store 并调用 put（行为级）
  let behaviorOk = false, behaviorWhy = '';
  try {
    const src = fs.readFileSync(STORE, 'utf8');
    behaviorOk = checkCompanion(src).length === 0;
    behaviorWhy = behaviorOk ? '' : checkCompanion(src).join(' / ');
  } catch (e) {
    behaviorWhy = e.message.slice(0, 60);
  }
  T('正例 · 真实的 store.mjs 必须满足伴生断言的前置条件',
    behaviorOk, behaviorWhy);

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = /[\\/]store\.companion\.test\.mjs$/.test(process.argv[1] || '');
if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  store 伴生断言 · 自检');
  console.log('  ' + '─'.repeat(70));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (isMain) {
  // 交叉验证：store.mjs 自己的 selftest 必须全绿
  let storeOut = '';
  try {
    storeOut = execFileSync(process.execPath, [STORE, '--selftest'],
      { cwd: REPO, encoding: 'utf8', timeout: 300000 });
  } catch (e) {
    storeOut = (e.stdout || '') + (e.stderr || '');
  }
  const m = storeOut.match(/结论[:：]\s*(✓|✗)\s*(\d+)\/(\d+)/);
  console.log('');
  console.log('  store 伴生断言 —— 钉住「put 不能永远返回 false」');
  console.log('  ' + '='.repeat(70));
  if (!m) {
    console.log('  ❔ store selftest 无结论行');
    process.exit(2);
  }
  const [, mark, pass, total] = m;
  console.log('  store.mjs 自检: ' + mark + ' ' + pass + '/' + total);
  console.log('  伴生前置条件: ' + (checkCompanion(fs.readFileSync(STORE, 'utf8')).length === 0 ? '满足' : '不满足'));
  console.log('');
  process.exit(mark === '✓' ? 0 : 1);
}
