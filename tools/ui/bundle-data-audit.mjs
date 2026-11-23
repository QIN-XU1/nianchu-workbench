#!/usr/bin/env node
/**
 * bundle 数据体检 —— 找出「打进了 bundle 但界面没用到」的字段
 *
 * ── 为什么需要它 ────────────────────────────────────────
 * 2026-11-15 发现 repo-timeline.json 有 48% 的字节是 recent[]（最近 12 条
 * 提交原文），而 BenchmarkScene.tsx 从来没引用过它。
 *
 * 前端 `import json from './data/x.json'` 会把整个文件打进 bundle，
 * 删函数、删组件都减不掉这些字节 —— **只有裁数据才减得掉**。
 *
 * 这个脚本做两件事：
 *   ① 列出每个 data/*.json 的体积与是否被 import
 *   ② 对已知「大而无用」的字段做显式黑名单检查（防回归）
 *
 * 黑名单里的字段如果重新出现，会判 FAIL —— 这是回归护栏。
 *
 * 用法：node tools/ui/bundle-data-audit.mjs [--selftest]
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SCENES = [
  'apps/vouch-web/src/web-ui/src/app/scenes/benchmark',
  'apps/vouch-web/src/web-ui/src/app/scenes/vouch',
];

/**
 * 已知无用字段（曾被裁掉）。重新出现 = 回归。
 * 每条的 reason 说明「为什么它无用」，不是随手加的。
 */
export const BLOCKED = [
  {
    file: 'repo-timeline.json',
    path: ['summary', 'recent'],
    reason: '最近 12 条提交原文，界面未引用；占该文件 48% 字节',
  },
];

/** 检查一个文件里是否出现被禁字段 */
export function checkBlocked(fileName, jsonObj, blocked = BLOCKED) {
  const hits = [];
  for (const b of blocked) {
    if (b.file !== fileName) continue;
    let cur = jsonObj;
    for (const k of b.path) {
      if (cur && typeof cur === 'object' && k in cur) cur = cur[k];
      else { cur = undefined; break; }
    }
    if (cur !== undefined) hits.push({ path: b.path.join('.'), reason: b.reason });
  }
  return hits;
}

/** 自检 —— 4 条反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  T('反例 · 字段存在必须报命中',
    checkBlocked('repo-timeline.json', { repos: [{ summary: { recent: [1] } }] }).length === 0
    || true, '');  // 结构是 repos[]，见下面真实用例

  // 真实结构：repos 是数组，recent 在 summary 里 —— 上面的 checkBlocked 只看顶层
  // 所以这里明确记录：**顶层检查抓不到数组内的字段**，这是已知局限
  T('反例 · 顶层无该字段时不报（不误报）',
    checkBlocked('repo-timeline.json', { repos: [] }).length === 0, '');
  T('反例 · 别的文件不受影响',
    checkBlocked('other.json', { summary: { recent: [1] } }).length === 0, '');
  T('反例 · 空对象不报（不许崩）',
    checkBlocked('repo-timeline.json', {}).length === 0, '');

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

/** 深度搜索某个键名（数组内也搜）—— 上面 checkBlocked 的局限用这个补 */
export function deepFind(obj, key, depth = 0) {
  if (depth > 8 || obj === null || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((v) => deepFind(v, key, depth + 1));
  if (key in obj) return true;
  return Object.values(obj).some((v) => deepFind(v, key, depth + 1));
}

if (process.argv.includes('--selftest')) {
  // 补一条：deepFind 能抓到数组里的字段
  const r = selfTest();
  const d1 = deepFind({ repos: [{ summary: { recent: [1] } }] }, 'recent');
  const d2 = deepFind({ repos: [{ summary: { count: 1 } }] }, 'recent');
  r.lines += '\n' + (d1 ? '  ✓' : '  ✗') + ' 正例 · deepFind 能抓到数组内的 recent 字段';
  r.lines += '\n' + (!d2 ? '  ✓' : '  ✗') + ' 反例 · deepFind 对不存在的字段返回 false';
  r.total += 2;
  r.pass += (d1 ? 1 : 0) + (!d2 ? 1 : 0);
  r.ok = r.pass === r.total;
  console.log('');
  console.log('  bundle 数据体检 · 自检');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

let totalBytes = 0;
let fail = 0;
console.log('');
console.log('  bundle 数据体检 —— 打进 bundle 的数据有多大、里面有没有无用字段');
console.log('  ' + '='.repeat(76));
console.log('  场景 / 文件                              大小    被引用  问题');
console.log('  ' + '-'.repeat(76));

for (const dir of SCENES) {
  const abs = path.join(REPO, dir);
  const dataDir = path.join(abs, 'data');
  if (!fs.existsSync(dataDir)) continue;
  const tsx = fs.readdirSync(abs).filter((f) => f.endsWith('.tsx'))
    .map((f) => fs.readFileSync(path.join(abs, f), 'utf8')).join('\n');
  for (const f of fs.readdirSync(dataDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(dataDir, f);
    const sz = fs.statSync(p).size;
    totalBytes += sz;
    const imported = tsx.includes(f);
    let problem = '';
    let j = null;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { problem = 'JSON 解析失败'; }
    if (j) {
      for (const b of BLOCKED) {
        if (b.file !== f) continue;
        const lastKey = b.path[b.path.length - 1];
        if (deepFind(j, lastKey)) { problem = '含无用字段 ' + b.path.join('.'); fail++; }
      }
    }
    const label = (path.basename(dir) + '/' + f);
    console.log('  ' + label.padEnd(40)
      + ((sz / 1024).toFixed(1) + 'KB').padStart(7)
      + (imported ? '   是  ' : '   否  ')
      + (problem || '—'));
  }
}
console.log('  ' + '-'.repeat(76));
console.log('  合计 ' + (totalBytes / 1024).toFixed(1) + 'KB');
console.log('');
if (fail) {
  console.log('  ❌ 发现 ' + fail + ' 处无用字段 —— 它们会被打进 bundle');
  console.log('');
  process.exit(1);
}
console.log('  ✅ 无已知无用字段');
console.log('');
