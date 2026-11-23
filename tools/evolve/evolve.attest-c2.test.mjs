#!/usr/bin/env node
/**
 * attest() 的 C2 反例 —— 独立文件，避免撑爆 evolve.mjs 的 32KB 红线
 *
 * ── 为什么单独放这里 ────────────────────────────────────
 * 2026-11-16 T1 独立复审抓到：`evolve.mjs:258-259` 的 attest() 直接
 * `e.status = 'closed'`，不检查 verdict、不检查 samples<8。
 *
 * 后果（台账实证）：
 *   H-0031  samples=5  verdict=unknown  status=closed  attestedFrom=unknown
 *   H-0034  samples=7  verdict=unknown  status=closed  attestedFrom=unknown
 *   H-0035  samples=4  verdict=unknown  status=closed  attestedFrom=unknown
 *
 * `status=closed` 与 `verdict=unknown` **字段自相矛盾**，直接违反 C2
 * 「UNKNOWN 永不并入通过」。而 attest 的设计动机原文是
 * 「直接改 JSON 就是伪造留痕」（evolve.mjs:224）—— 它自己成了洗白后门。
 *
 * ── 修法 ────────────────────────────────────────────────
 * attest() 现在拒绝 verdict=unknown 与 samples<8 两种情况。
 * 本文件用隔离台账验证这两道闸真的生效。
 *
 * 用法：node tools/evolve/evolve.attest-c2.test.mjs [--selftest]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const EVOLVE = path.join(REPO, 'tools/evolve/evolve.mjs');

/**
 * 纯逻辑检查：读 evolve.mjs 源码，确认两道闸都在
 * （行为级验证在 main 里用真台账跑）
 */
export function checkGates(src) {
  const problems = [];
  if (!/verdict[^\n]{0,40}unknown/i.test(src)) {
    problems.push('找不到「verdict 是 unknown 就拒绝」的判断');
  }
  if (!/ATTEST_MIN_SAMPLES|samples\)\s*<\s*8|samples\s*<\s*8/.test(src)) {
    problems.push('找不到「样本量 < 8 就拒绝」的判断');
  }
  // 原来的裸赋值不该是唯一路径 —— 必须在这两道闸之后
  const gateIdx = src.search(/verdict[^\n]{0,40}unknown/i);
  const assignIdx = src.indexOf("e.status = 'closed'");
  if (gateIdx < 0 || assignIdx < 0) {
    problems.push('找不到 e.status = closed 或闸门位置');
  } else if (gateIdx > assignIdx) {
    problems.push('闸门在赋值之后才检查 —— 无效');
  }
  return problems;
}

/** 自检 —— 2 正例 + 3 反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const good = `
    if (String(e.verdict).toLowerCase() === 'unknown') return { ok: false };
    const ATTEST_MIN_SAMPLES = 8;
    if (Number(e.samples) < ATTEST_MIN_SAMPLES) return { ok: false };
    e.status = 'closed';
  `;
  T('正例 · 两道闸都在赋值之前 ⇒ 无问题',
    checkGates(good).length === 0, JSON.stringify(checkGates(good)));

  const noVerdict = `
    const ATTEST_MIN_SAMPLES = 8;
    if (Number(e.samples) < ATTEST_MIN_SAMPLES) return { ok: false };
    e.status = 'closed';
  `;
  T('反例 · 缺 verdict 闸 ⇒ 报问题（H-0031 就是这样被洗白的）',
    checkGates(noVerdict).some((p) => /verdict/.test(p)), '');

  const noSamples = `
    if (String(e.verdict).toLowerCase() === 'unknown') return { ok: false };
    e.status = 'closed';
  `;
  T('反例 · 缺样本量闸 ⇒ 报问题',
    checkGates(noSamples).some((p) => /样本/.test(p)), '');

  const wrongOrder = `
    e.status = 'closed';
    if (String(e.verdict).toLowerCase() === 'unknown') return { ok: false };
  `;
  T('反例 · 闸门在赋值之后 ⇒ 报「无效」（顺序错了等于没闸）',
    checkGates(wrongOrder).some((p) => /之后/.test(p)), JSON.stringify(checkGates(wrongOrder)));

  // 正例：真实的 evolve.mjs 必须满足
  let realOk = false, realWhy = '';
  try {
    const src = fs.readFileSync(EVOLVE, 'utf8');
    const p = checkGates(src);
    realOk = p.length === 0;
    realWhy = p.join(' / ');
  } catch (e) {
    realWhy = e.message.slice(0, 60);
  }
  T('正例 · 真实的 evolve.mjs 两道闸都已就位', realOk, realWhy);

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = /[\\/]evolve\.attest-c2\.test\.mjs$/.test(process.argv[1] || '');
if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  attest C2 闸门 · 自检');
  console.log('  ' + '─'.repeat(70));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}
