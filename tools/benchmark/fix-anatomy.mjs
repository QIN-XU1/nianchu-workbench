#!/usr/bin/env node
/**
 * 修复内容分析 —— 回答「它在修什么」，不是「它修了多少」
 *
 * ── 为什么要这个 ───────────────────────────────────────
 * 上一轮拿到 openclaw「81% 提交是 fix」。光看这个数字分不出两件事：
 *   · **成熟**：功能齐了，在打磨边界情况
 *   · **停滞**：没东西可加，或者结构撑不住了在打补丁
 *
 * 唯一的区分办法是**读 fix 的具体内容**。
 *
 * ── 这个脚本怎么判（规则全部写在代码里，可复核）──────────────
 * 按 fix 的 scope 与描述，归到四类：
 *   polish    界面/文案/标签/样式 —— 打磨
 *   robustness 竞态/中断/重试/泄漏/超时/取消 —— 边界情况
 *   structure  因架构限制导致的绕行（lane/registry/scope/boundary）—— 结构压力
 *   feature-y  补上了本该有的行为（surface/allow/load/keep）—— 功能缺口
 *   other      认不出的，如实归 other
 *
 * 判据是**启发式**，不是语义理解。分类错会体现在样例里，供人纠正。
 *
 * 用法：node tools/benchmark/fix-anatomy.mjs <slug> [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

export const CATEGORIES = {
  // 【2026-11-15 扩】第一版 scope 只覆盖 openclaw 的用词，导致其它 5 家「认不出」占 38–100%。
  // 各家 scope 命名完全不同：WeKnora 用 chat/frontend/docreader/wiki，omp-studio 用
  // renderer/host/studio/desktop。这里按「这个 scope 属于哪一类工作」扩充，不是按仓库特判。
  polish: {
    label: '打磨（界面/文案/标签）',
    scope: /^(ui|ux|style|css|theme|i18n|frontend|renderer|preview|desktop|mobile|web|view|css)$/i,
    text: /\b(label|text|tooltip|tone|colour|color|spacing|copy|wording|render|display|badge|style|styling|layout)\b/i,
  },
  robustness: {
    label: '健壮性（竞态/中断/泄漏/超时）',
    scope: /^(logging|runtime|exec|gateway|cron|sessions|streams?|cache|queue|worker|socket|network|timeout)$/i,
    text: /\b(race|cancel|interrupt|leak|descriptor|stall|retry|timeout|resume|close|abort|guard|lock|transient|fallback|recover|validate|verify|harden|precedence)\b/i,
  },
  structure: {
    label: '结构压力（绕行/分层/作用域）',
    scope: /^(worktrees?|subagents|plugins?|worker-runtime|cli|ci|github|scripts|secrets|build|release|config|bundle|deps|hooks?|ecc2)$/i,
    text: /\b(lane|registry|scope|boundary|layer|orphan|exhaust|delegate|hoist|inject|mount|extract|split|integrate|bind|attribute|retain|ownership)\b/i,
  },
  featureish: {
    label: '功能缺口（补上本该有的）',
    scope: /^(skills|models|nodes|talk|goals|templates|workboard|android|chat|docreader|wiki|host|studio|knowledge|search|reader|editor|import|export|context)$/i,
    text: /\b(surface|allow|enable|support|load|keep|preserve|restore|follow|reaches|honor|select|attach|expand|open)\b/i,
  },
};

/** 分类一条 fix */
export function categorise(message) {
  const m = String(message || '').trim();
  if (!m) return 'other';
  const sc = /^fix\(([^)]*)\)/i.exec(m);
  const scope = sc ? sc[1] : '';
  // scope 命中优先（作者自己标的领域最可信）
  if (scope) {
    for (const [k, c] of Object.entries(CATEGORIES)) {
      if (c.scope.test(scope)) return k;
    }
  }
  // 再看描述关键词
  for (const [k, c] of Object.entries(CATEGORIES)) {
    if (c.text.test(m)) return k;
  }
  return 'other';
}

/**
 * scope 集中度 —— 不依赖词表的客观指标
 *
 * 为什么加它：4 类分类需要词表覆盖 scope 名，而 WeKnora 用了 36 个
 * 项目专有模块名（docreader/docparser/chunker/embed/yuque/vlm…），
 * 任何通用词表都覆盖不了，导致 35% 认不出。
 *
 * 集中度不需要认识 scope 是什么，只数「改得有多散」：
 *   种类多 + 最大占比低  => 修改分散在很多模块
 *   种类少 + 最大占比高  => 修改集中在少数模块
 *
 * 实测：openclaw 28 种 / 最大 ui 占 37%；WeKnora 36 种 / 最大 docreader 占 13%。
 */
export function scopeConcentration(messages) {
  const fixes = messages.filter((m) => /^fix/i.test(m));
  const sc = {};
  let noScope = 0;
  for (const m of fixes) {
    const r = /^fix\(([^)]*)\)/i.exec(m);
    if (r) sc[r[1]] = (sc[r[1]] || 0) + 1;
    else noScope++;
  }
  const entries = Object.entries(sc).sort((a, b) => b[1] - a[1]);
  const top = entries[0] || ['(none)', 0];
  const total = fixes.length;
  let entropy = 0;
  if (total && entries.length) {
    let h = 0;
    for (const [, n] of entries) { const p = n / total; h -= p * Math.log2(p); }
    entropy = Math.round((h / Math.log2(Math.max(entries.length, 2))) * 100) / 100;
  }
  return {
    total,
    scopeKinds: entries.length,
    topScope: top[0],
    topPct: total ? Math.round((top[1] / total) * 100) : 0,
    noScope,
    entropy,
  };
}

export function analyzeFixCommits(messages) {
  const fixes = messages.filter((m) => /^fix/i.test(m));
  const buckets = {};
  for (const m of fixes) {
    const k = categorise(m);
    (buckets[k] = buckets[k] || []).push(m);
  }
  const total = fixes.length;
  const dist = Object.fromEntries(
    Object.keys(CATEGORIES).concat(['other']).map((k) => [k, { n: (buckets[k] || []).length, pct: total ? Math.round(((buckets[k] || []).length / total) * 100) : 0, sample: (buckets[k] || []).slice(0, 3) }]),
  );
  return { total, dist };
}

/** 自检 —— 5 条正例 + 5 条反例
 *
 * 【2026-11-16 补正例】原来的 5 条全叫「反例」，其实前 3 条写的是「必须判对」，
 * 只是标签用错了。真正的风险是假红：如果 categorise 永远返回 'other'、
 * scopeConcentration 永远返回 0，那「不许硬塞」「非 fix 不许混进统计」照样绿，
 * 工具已经废了却看不出来。补 5 条正例钉住**精确**的分类与计数。
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  T('反例 · fix(ui): 必须判 polish', categorise('fix(ui): label a yielded child') === 'polish', categorise('fix(ui): label a yielded child'));
  T('反例 · fix(logging): 泄漏/描述符必须判 robustness',
    categorise('fix(logging): close log descriptors when workers terminate') === 'robustness',
    categorise('fix(logging): close log descriptors when workers terminate'));
  T('反例 · fix(worker-runtime): reserve a … lane 必须判 structure',
    categorise('fix(worker-runtime): reserve a class-0 lane for access checks') === 'structure',
    categorise('fix(worker-runtime): reserve a class-0 lane for access checks'));
  T('反例 · 认不出的 fix 必须判 other（不许硬塞）',
    categorise('fix: something totally opaque happened') === 'other',
    categorise('fix: something totally opaque happened'));

  const r = analyzeFixCommits(['fix(ui): a', 'fix(ui): b', 'feat: c']);
  T('反例 · 非 fix 提交不许混进统计', r.total === 2, 'total=' + r.total);

  // ── 正例：合法 fix 必须被分到**精确的那一类** ──
  T('正例 · fix(ui): adjust label color 必须精确判为 polish',
    categorise('fix(ui): adjust label color') === 'polish', categorise('fix(ui): adjust label color'));
  T('正例 · fix(logging): fix race in retry 必须精确判为 robustness',
    categorise('fix(logging): fix race in retry') === 'robustness', categorise('fix(logging): fix race in retry'));
  T('正例 · fix(worktrees): hoist registry 必须精确判为 structure',
    categorise('fix(worktrees): hoist registry') === 'structure', categorise('fix(worktrees): hoist registry'));

  // ── 正例：scope 集中度必须是精确数值 ──
  const cp = scopeConcentration(['fix(ui): a', 'fix(ui): b', 'fix(logging): c', 'fix: d', 'feat: e']);
  T('正例 · 4 条 fix、2 种 scope、最大 ui 占 50%、1 条无 scope、熵 1 ⇒ 必须精确算成 4/2/50/1/1',
    [cp.total, cp.scopeKinds, cp.topPct, cp.noScope, cp.entropy].join('/') === '4/2/50/1/1',
    JSON.stringify(cp));

  // ── 正例：分类分布必须是精确计数 ──
  const dd = analyzeFixCommits(['fix(ui): a', 'fix(ui): b', 'fix: something totally opaque happened']);
  T('正例 · 3 条 fix 里 polish 2 条占 67%、other 1 条占 33% ⇒ 分布必须精确',
    dd.total === 3 && dd.dist.polish.n === 2 && dd.dist.polish.pct === 67
      && dd.dist.other.n === 1 && dd.dist.other.pct === 33,
    JSON.stringify({ total: dd.total, polish: dd.dist.polish, other: dd.dist.other }));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

function fetchMessages(slug) {
  const tmp = path.join(REPO, 'evidence/evolve/_fix_tmp.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  let last = '';
  for (let a = 1; a <= 12; a++) {
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
    try {
      execFileSync('curl.exe', ['-sL', '--max-time', '20', '-o', tmp,
        '-H', 'User-Agent: dsh-agent', '-H', 'Accept: application/vnd.github+json',
        'https://api.github.com/repos/' + slug + '/commits?per_page=100'], { stdio: 'ignore' });
    } catch (e) { last = 'curl ' + (e.status ?? '?'); }
    let size = 0;
    try { size = fs.statSync(tmp).size; } catch { size = 0; }
    if (size > 1000) {
      // 光看大小不够 —— 必须真的能 parse 才算取到
      try { JSON.parse(fs.readFileSync(tmp, 'utf8')); break; } catch { last = 'parse-retry'; }
    }
    execFileSync('cmd.exe', ['/c', 'ping', '-n', '1', '-w', '700', '127.0.0.1'], { stdio: 'ignore' });
  }
  let raw = '';
  try { raw = fs.readFileSync(tmp, 'utf8'); } catch { /* ok */ }
  if (!raw.trim()) return { ok: false, err: last || 'empty' };
  let j;
  try { j = JSON.parse(raw); } catch { return { ok: false, err: 'parse' }; }
  if (!Array.isArray(j)) return { ok: false, err: 'not array' };
  return { ok: true, messages: j.map((c) => (c.commit?.message || '').split('\n')[0]) };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  修复内容分析 · 自检（5 正例 + 5 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

const slug = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'openclaw/openclaw';
const got = fetchMessages(slug);

console.log('');
console.log('  修复内容分析 —— ' + slug);
console.log('  ' + '='.repeat(78));
if (!got.ok) {
  console.log('  ❔ 拿不到提交：' + got.err);
  console.log('');
  process.exit(2);
}
const r = analyzeFixCommits(got.messages);
const conc = scopeConcentration(got.messages);
console.log('  最近 100 条里 fix 共 ' + r.total + ' 条，按内容分类：');
console.log('');
for (const [k, v] of Object.entries(r.dist)) {
  const label = k === 'other' ? '认不出' : CATEGORIES[k].label;
  console.log('  ' + String(v.n).padStart(3) + ' 条  ' + String(v.pct).padStart(3) + '%  ' + label);
  for (const s of v.sample) console.log('           · ' + s.slice(0, 88));
}
console.log('');
console.log('  scope 集中度（不依赖词表）：' + conc.scopeKinds + ' 种 · 最大 ' + conc.topScope
  + ' 占 ' + conc.topPct + '% · 归一化熵 ' + conc.entropy
  + (conc.topPct >= 30 ? '  => 修改集中在少数模块' : '  => 修改分散在很多模块'));
console.log('');
const op = path.join(REPO, 'evidence/evolve/fix-anatomy.json');
fs.writeFileSync(op, JSON.stringify({ at: new Date().toISOString(), slug, ...r, conc }, null, 2) + '\n', 'utf8');
console.log('  → ' + path.relative(REPO, op));
console.log('');
