#!/usr/bin/env node
// 工具/体检进化.mjs —— 体检项自身的进化追踪
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  这个项目的机制体检从 4 项长到 90 项，每次增长都是「一次真实事故」换来的：
//
//    · 加「废弃路径体检」← 目录迁移后代码还指向旧位置（3 处互相掩护）
//    · 加「固定注入层体检」← clampBytes 把管线位置静默丢掉
//    · 加「会话轮转」← 56 个会话把模型额度吃光
//    · 加「会话预热」← 空白会话不被侧栏渲染 → 面板绑错场景
//    · 加「真实模型体检」← 模型不可用时所有需要模型的验证都被跳过
//    · 加「目标验收」← 90 项细则回答不了「目标达成了吗」
//    · 加「中枢面板体检」← 硬编码在 main-agent.js 的面板不在任何检查里
//
//  **但没有任何地方记录「这 90 项是怎么长出来的」。**
//  结果是：
//    · 新人（或下一轮的我）不知道每项为什么存在
//    · 不知道哪些项是事故驱动的、哪些是预防性的
//    · 无法判断「这一项能不能删」
//
//  这个工具：把「体检项的进化史」变成可查的数据。
//    ① 扫当前 90 项，提取每项的 name/desc
//    ② 扫 git 历史，找出每项是哪个 commit 加的
//    ③ 从 commit message 提取「为什么加」（事故描述）
//    ④ 输出一张「体检项进化表」
//
//  用法：
//    node 工具/体检进化.mjs              生成进化表
//    node 工具/体检进化.mjs --json       机器可读
//    node 工具/体检进化.mjs --missing    只列「找不到来源」的项
//    node 工具/体检进化.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');
const HEALTH = path.join(HERE, '机制体检.mjs');
const OUT = path.join(WB, '数据', '.dsh', '机制清单.md');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/** commit message 里「为什么加」的标志词 */
export const WHY_MARKERS = ['事故', '实测', '发现', '根因', '缺陷', '踩', '问题', 'bug', '修'];

/**
 * 强标志词（优先级高于弱标志词）
 *
 * ⚠ 2026-11-13 修（第一版抓到标题行而不是正文的事故描述）
 *
 *   实测：commit message
 *     feat(注入层): 第 14 轮的修复其实只对 1 个场景生效
 *
 *     事故：clampBytes 把管线位置丢掉了
 *
 *   第一版按顺序扫，第一行含「修」（修复）就被选中了。
 *   但那只是标题，真正的「为什么」在「事故：」那一行。
 *
 *   修法：先扫强标志词（事故/根因/缺陷/实测发现），找到就用；
 *        一个都没有才退回弱标志词。
 */
export const STRONG_MARKERS = ['事故', '根因', '缺陷', '实测发现', '实测：'];

/**
 * 从 commit message 提取「为什么加这一项」
 * @param {string} msg
 * @returns {string} 一句话原因（找不到就空）
 */
export function extractWhy(msg) {
  const lines = String(msg || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // 先找强标志词
  for (const l of lines) {
    if (STRONG_MARKERS.some((m) => l.includes(m)) && l.length > 8) {
      return l.replace(/^[-*·\s]+/, '').slice(0, 100);
    }
  }
  // 再找弱标志词
  for (const l of lines) {
    if (WHY_MARKERS.some((m) => l.includes(m)) && l.length > 8) {
      return l.replace(/^[-*·\s]+/, '').slice(0, 100);
    }
  }
  return '';
}

/**
 * 解析机制体检源码，抽出所有 guard
 * @param {string} src
 * @returns {Array<{name:string, file:string, desc:string}>}
 */
export function parseGuards(src) {
  const out = [];
  const re = /\{\s*name:\s*'([^']+)',\s*file:\s*'([^']+)',\s*desc:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ name: m[1], file: m[2], desc: m[3] });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
function gitLog(fileRel) {
  try {
    const out = execFileSync('git', ['log', '--format=%H|%as|%s', '--', fileRel], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
    });
    return out.split('\n').filter(Boolean).map((l) => {
      const [hash, date, ...rest] = l.split('|');
      return { hash: hash.slice(0, 8), date, subject: rest.join('|') };
    });
  } catch { return []; }
}

/** 某个 guard 是什么时候加的（找第一个包含它名字的 commit 的 diff） */
function findWhenAdded(name) {
  try {
    // 搜 commit message 里提到这个工具/能力的
    const out = execFileSync('git', ['log', '--format=%H|%as|%s', '-S', "name: '" + name + "'", '--', 'workbench/工具/机制体检.mjs'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
    });
    const lines = out.split('\n').filter(Boolean);
    if (!lines.length) return null;
    // -S 返回的是「改动包含这个字符串」的 commit，最后一个是最早的
    const last = lines[lines.length - 1];
    const [hash, date, ...rest] = last.split('|');
    return { hash: hash.slice(0, 8), date, subject: rest.join('|') };
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  体检进化 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】解析 guard');
  {
    const src = `
export const GUARDS = [
  {
    name: '甲检查',
    file: '甲.mjs',
    desc: '甲做什么',
    invs: 1,
  },
  {
    name: '乙检查',
    file: '乙.mjs',
    desc: '乙做什么',
    invs: 2,
  },
];`;
    const g = parseGuards(src);
    chk('能解析出 2 个', g.length === 2, String(g.length));
    chk('name 正确', g[0].name === '甲检查', g[0].name);
    chk('file 正确', g[1].file === '乙.mjs', g[1].file);
    chk('desc 正确', g[0].desc === '甲做什么', g[0].desc);
  }

  console.log();
  console.log('【二】提取「为什么加」');
  {
    const m1 = 'feat(注入层): 第 14 轮的修复其实只对 1 个场景生效\n\n事故：clampBytes 把管线位置丢掉了';
    chk('能提取含「事故」的行', extractWhy(m1).includes('事故'), extractWhy(m1));
    const m2 = 'chore: 清理临时脚本';
    chk('反例：无标志词返回空', extractWhy(m2) === '', JSON.stringify(extractWhy(m2)));
    chk('反例：null 返回空', extractWhy(null) === '');
  }

  console.log();
  console.log('【三】关键：这个工具补的是什么');
  chk('关键：90 项是怎么长出来的，之前没有任何地方记录',
    true, '每项都对应一次真实事故，但没人能查');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const src = fs.readFileSync(HEALTH, 'utf8');
  const guards = parseGuards(src);

  if (!guards.length) { console.log('  ✗ 解析不到 guard'); process.exit(2); }

  // 每个 file 的 git 历史（一次查，批量用）
  const fileHistoryCache = new Map();
  const rows = [];

  for (const g of guards) {
    let when = findWhenAdded(g.name);
    let why = when ? extractWhy(when.subject) : '';

    // 找不到就退一步：按 file 查历史
    if (!when) {
      const rel = 'workbench/工具/' + g.file;
      if (!fileHistoryCache.has(rel)) fileHistoryCache.set(rel, gitLog(rel));
      const hist = fileHistoryCache.get(rel);
      if (hist.length) {
        const oldest = hist[hist.length - 1];
        when = oldest;
        why = extractWhy(oldest.subject) || '(按文件推断)';
      }
    }

    rows.push({ ...g, when, why });
  }

  if (has('missing')) {
    const miss = rows.filter((r) => !r.when);
    console.log('  找不到来源的体检项: ' + miss.length);
    for (const m of miss) console.log('    · ' + m.name.padEnd(18) + m.file);
    return;
  }

  if (has('json')) {
    console.log(JSON.stringify({ total: rows.length, rows }, null, 2));
    return;
  }

  console.log('='.repeat(90));
  console.log('  体检项进化表 —— 这 ' + rows.length + ' 项是怎么长出来的');
  console.log('='.repeat(90));
  console.log();
  console.log('  每一项都对应一次真实事故或发现。这里记录它的来源，');
  console.log('  这样「这一项能不能删」就有据可查，而不是凭感觉。');
  console.log();

  const withWhen = rows.filter((r) => r.when);
  const without = rows.filter((r) => !r.when);

  console.log('  ' + '体检项'.padEnd(18) + '加入时间'.padEnd(12) + '为什么加');
  console.log('  ' + '─'.repeat(86));
  for (const r of rows) {
    const date = r.when ? r.when.date : '(未知)';
    const why = (r.why || r.desc || '').slice(0, 54);
    console.log('  ' + r.name.padEnd(18) + date.padEnd(12) + why);
  }

  console.log();
  console.log('─'.repeat(90));
  console.log('  ' + withWhen.length + ' / ' + rows.length + ' 项能找到来源');

  // 按时间分组，看增长节奏
  const byDate = {};
  for (const r of withWhen) byDate[r.when.date] = (byDate[r.when.date] || 0) + 1;
  const dates = Object.keys(byDate).sort();
  if (dates.length) {
    console.log();
    console.log('  增长节奏（每天新增多少项）:');
    for (const d of dates) console.log('    ' + d + '  +' + byDate[d]);
  }

  if (without.length) {
    console.log();
    console.log('  ⚠ 找不到来源（可能是一次性加入的）:');
    for (const w of without.slice(0, 10)) console.log('    · ' + w.name);
    if (without.length > 10) console.log('    ... 还有 ' + (without.length - 10) + ' 个');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
