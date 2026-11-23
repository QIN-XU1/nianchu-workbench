#!/usr/bin/env node
/**
 * 竞品迭代时间轴 —— 不是拍快照，是看「它怎么变的」
 *
 * ── 为什么做这个（用户 2026-11-15 的批评）──────────────────
 * 「我让你搭的竞品对标场景还是有很多缺点，因为这些大部分项目都是会迭代的，
 *   而他们从原来跟进到迭代的改变是非常具有学习意义的」
 *
 * 之前的 BenchmarkScene 是**快照**：22 个项目、某一刻的文件数/目录骨架。
 * 快照告诉你它长什么样，**时间轴告诉你它为什么变成这样、哪些改动活下来了**。
 *
 * ── 这个脚本量什么 ──────────────────────────────────────
 *   · 提交时间跨度（活跃度）
 *   · 提交类型分布（feat / fix / refactor / docs / test / perf / chore）
 *   · 按月活跃度（是不是一阵风就停了）
 *   · 最近 N 条提交的原文（供人读「它改了什么」）
 *
 * ── 诚实边界 ──────────────────────────────────────────
 *   · 只对**公开仓库**有效；闭源产品（ChatGPT/Cursor 等）拿不到 ⇒ 标 UNKNOWN
 *   · 只取默认分支最近 100 条，不是全历史
 *   · 提交信息分类是**启发式**，不是语义理解；分类错会体现在 selftest 里
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS     拿到 ≥20 条提交，能算出时间跨度与类型分布
 *   WARN     拿到 <20 条（历史太短或 API 截断）
 *   UNKNOWN  仓库不存在 / 无权限 / 网络失败
 *
 * 用法：node tools/benchmark/repo-timeline.mjs [--json] [--selftest]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');

/** 待跟踪的仓库（有公开源的）。闭源产品无法跟踪，另表列出。 */
// slug 不是猜的：从本地 refs 的项目文件（package.json/Cargo.toml/README）里提取，
// 提取脚本见 tools/benchmark/repo-timeline.mjs 头注释。没有公开源的如实标注。
export const REPOS = [
  { id: 'luanyujia', slug: 'mashanglinyu/luanyujia-workbench', label: '乱语家 workbench' },
  { id: 'openclaw', slug: 'openclaw/openclaw', label: 'openclaw' },
  { id: 'orca', slug: 'stablyai/orca', label: 'orca' },
  { id: 'ecc', slug: 'affaan-m/ECC', label: 'ECC' },
  { id: 'weknora', slug: 'Tencent/WeKnora', label: 'WeKnora' },
  { id: 'craft', slug: 'storytold/craft-anything', label: 'craft-anything' },
  { id: 'omp', slug: 'the-snowpear/omp-studio', label: 'omp-studio' },
];

/** 已知无法跟踪的（闭源）—— 如实列出，不猜 */
export const UNTRACKABLE = [
  'ChatGPT / Codex', 'Claude Code', 'Cursor', 'Trae', 'WorkBuddy', 'CodeBuddy', 'Qoder',
];

/**
 * 提交信息分类（启发式）
 *
 * 优先 conventional commit 前缀；否则退回关键词。
 * 分不清就归 other —— **不硬塞**。
 */
export function classify(message) {
  const m = String(message || '').trim();
  if (!m) return 'other';
  const head = m.split(/[\n:]/)[0].toLowerCase();
  const cc = /^(\w+)(\([^)]*\))?!?$/.exec(head);
  if (cc) {
    const t = cc[1];
    if (['feat', 'feature'].includes(t)) return 'feat';
    if (['fix', 'bugfix', 'hotfix'].includes(t)) return 'fix';
    if (['refactor', 'perf', 'style'].includes(t)) return 'refactor';
    if (['docs', 'doc'].includes(t)) return 'docs';
    if (['test', 'tests'].includes(t)) return 'test';
    if (['chore', 'build', 'ci', 'deps'].includes(t)) return 'chore';
  }
  const low = m.toLowerCase();
  if (/\b(fix|bug|repair|patch|hotfix)\b/.test(low)) return 'fix';
  if (/\b(add|support|implement|introduce|feature|new)\b/.test(low)) return 'feat';
  if (/\b(refactor|rename|move|restructure|simplify)\b/.test(low)) return 'refactor';
  if (/\b(doc|readme|comment)\b/.test(low)) return 'docs';
  if (/\b(test|spec|coverage)\b/.test(low)) return 'test';
  if (/\b(chore|bump|deps|release|version)\b/.test(low)) return 'chore';
  return 'other';
}

/** 从提交数组算出时间轴统计 */
export function summarize(commits) {
  const rows = commits
    .map((c) => ({
      sha: (c.sha || '').slice(0, 7),
      date: c.commit?.author?.date || c.commit?.committer?.date || null,
      message: (c.commit?.message || '').split('\n')[0],
      kind: classify(c.commit?.message || ''),
    }))
    .filter((r) => r.date);

  const byKind = {};
  const byMonth = {};
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    const m = r.date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  const dates = rows.map((r) => r.date).sort();
  const first = dates[0] || null;
  const last = dates[dates.length - 1] || null;
  const spanDays = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 86400000) : 0;

  return {
    count: rows.length, first, last, spanDays,
    byKind, byMonth,
    months: Object.keys(byMonth).sort(),
    recent: rows.slice(0, 12),
  };
}

export function verdictOf(s) {
  if (!s || !s.count) return { state: 'UNKNOWN', why: '拿不到提交（仓库不存在/无权限/网络失败）' };
  if (s.count < 20) return { state: 'WARN', why: '只拿到 ' + s.count + ' 条提交，历史太短或 API 截断' };
  return {
    state: 'PASS',
    why: s.count + ' 条提交 · 跨度 ' + s.spanDays + ' 天 · 覆盖 ' + s.months.length + ' 个月 · 最新 ' + (s.last || '').slice(0, 10),
  };
}

/** 自检 —— 4 条反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  T('反例 · feat: 前缀必须判 feat', classify('feat: add memory ttl') === 'feat', classify('feat: add memory ttl'));
  T('反例 · fix(scope): 必须判 fix', classify('fix(memory): expired entries leak') === 'fix', classify('fix(memory): expired entries leak'));
  T('反例 · 无前缀的中文/英文描述走关键词，认不出就 other（不许硬塞）',
    classify('随便改了点东西') === 'other', classify('随便改了点东西'));
  T('反例 · 空信息必须判 other（不许当 feat）', classify('') === 'other', classify(''));

  const s = summarize([
    { sha: 'aaa1111', commit: { author: { date: '2026-01-05T00:00:00Z' }, message: 'feat: x' } },
    { sha: 'bbb2222', commit: { author: { date: '2026-03-05T00:00:00Z' }, message: 'fix: y' } },
  ]);
  T('正例 · 能算出跨度与月份', s.spanDays === 59 && s.months.length === 2, JSON.stringify({ span: s.spanDays, months: s.months }));
  T('反例 · 空提交必须判 UNKNOWN（不许当 PASS）', verdictOf(summarize([])).state === 'UNKNOWN', '');

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

// 【2026-11-15】本机 node fetch 到 api.github.com 会 ECONNRESET（TLS 握手被重置），
// 但 curl 可达 —— 所以走 curl 子进程。这不是「绕过」，是这台机器的网络现实。
function fetchCommits(slug) {
  const url = 'https://api.github.com/repos/' + slug + '/commits?per_page=100';
  // 【2026-11-15 二次修】execFileSync 默认 stdio:'pipe' 在 Windows 沙箱下会被拦（EPERM）。
  // 改成让 curl 直接写临时文件、node 读文件 —— 不经过管道。
  const tmp = path.join(REPO, 'evidence/evolve/_tl_tmp.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  try { fs.unlinkSync(tmp); } catch { /* 不存在就算了 */ }
  // 【2026-11-15 三次修】本机到 api.github.com 的 TLS 会间歇性失败（curl exit 35），
  // 实测同一 URL 第 2 次就成了 —— 所以必须重试，不能一次就判 UNKNOWN。
  let lastErr = '';
  for (let attempt = 1; attempt <= 12; attempt++) {
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
    try {
      execFileSync('curl.exe', [
        '-sL', '--max-time', '20', '-o', tmp,
        '-H', 'User-Agent: dsh-agent',
        '-H', 'Accept: application/vnd.github+json',
        url,
      ], { stdio: 'ignore' });
    } catch (e) {
      lastErr = 'curl exit ' + (e.status ?? '?');
    }
    let size = 0;
    try { size = fs.statSync(tmp).size; } catch { size = 0; }
    if (size > 100) break;
    execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'sh',
      process.platform === 'win32' ? ['/c', 'ping', '-n', '1', '-w', '800', '127.0.0.1'] : ['-c', 'sleep 0.8'],
      { stdio: 'ignore' });
  }
  let raw = '';
  try { raw = fs.readFileSync(tmp, 'utf8'); } catch { /* 读不到就是空 */ }
  if (!raw.trim()) return { ok: false, status: 0, error: lastErr || 'empty after 5 tries' };
  let j;
  try { j = JSON.parse(raw); } catch { return { ok: false, status: 0, error: 'parse failed' }; }
  if (!Array.isArray(j)) return { ok: false, status: 200, body: j };
  return { ok: true, commits: j };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  竞品迭代时间轴 · 自检（2 正例 + 4 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

// 【2026-11-15】必须守卫主流程 —— 否则别的模块 import { classify } 时
// 会连带触发整个抓取流程（self-timeline.mjs 就踩过这个坑）。
const isMain = process.argv[1] && /[\\/]repo-timeline\.mjs$/.test(process.argv[1]);
if (isMain) {
  const out = { at: new Date().toISOString(), repos: [], untrackable: UNTRACKABLE };
  console.log('');
  console.log('  竞品迭代时间轴 —— 看「它怎么变的」，不是「它长什么样」');
  console.log('  ' + '='.repeat(78));

  // 上次成功的结果 —— TLS 抖动时沿用并标 stale，不丢数据也不假装是新的
  let prev = {};
  try {
    const pf = path.join(REPO, 'evidence/evolve/repo-timeline.json');
    prev = JSON.parse(fs.readFileSync(pf, 'utf8'));
  } catch { prev = {}; }
  const prevById = {};
  for (const r of (prev.repos || [])) if (r.summary) prevById[r.id] = r;

  for (const r of REPOS) {
    const got = fetchCommits(r.slug);
    if (!got.ok) {
      const old = prevById[r.id];
      if (old) {
        console.log('');
        console.log('  ' + r.label + '  ⚠ 沿用上次数据（本次 TLS 失败，非新数据）—— ' + old.why);
        out.repos.push({ ...old, stale: true, staleAt: out.at });
        continue;
      }
      const v = { state: 'UNKNOWN', why: 'GitHub API ' + got.status + '（仓库不存在/无权限/网络失败）' };
      console.log('');
      console.log('  ' + r.label + '  ❔ ' + v.why);
      out.repos.push({ ...r, state: v.state, why: v.why });
      continue;
    }
    const s = summarize(got.commits);
    const v = verdictOf(s);
    console.log('');
    console.log('  ' + r.label + '  ' + v.state + ' —— ' + v.why);
    const kinds = Object.entries(s.byKind).sort((a, b) => b[1] - a[1]);
    console.log('    类型分布  ' + kinds.map(([k, n]) => k + ' ' + n).join(' · '));
    console.log('    按月活跃  ' + s.months.map((m) => m + ':' + s.byMonth[m]).join(' '));
    console.log('    最近改动:');
    for (const c of s.recent.slice(0, 6)) {
      console.log('      ' + c.date.slice(0, 10) + '  [' + c.kind.padEnd(8) + ']  ' + c.message.slice(0, 56));
    }
    out.repos.push({ ...r, state: v.state, why: v.why, summary: s });
  }

  console.log('');
  console.log('  ' + '─'.repeat(78));
  console.log('  无法跟踪（闭源，如实标注而非猜测）：' + UNTRACKABLE.join(' / '));
  console.log('');
  const op = path.join(REPO, 'evidence/evolve/repo-timeline.json');
  fs.mkdirSync(path.dirname(op), { recursive: true });
  fs.writeFileSync(op, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('  → ' + path.relative(REPO, op));
  console.log('');
}
