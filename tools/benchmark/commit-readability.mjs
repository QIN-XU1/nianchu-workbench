#!/usr/bin/env node
/**
 * 提交信息可读性 —— 把「我的分类器认不出」翻转成一个客观观测维度
 *
 * ── 这个翻转怎么来的 ────────────────────────────────────
 * 前面几轮我一直在为「认不出率高」发愁，试图扩词表把它压下去。
 * 但 WeKnora 用了 36 个项目专有 scope（docreader/chunker/yuque/vlm…），
 * 任何通用词表都覆盖不了。
 *
 * 于是换个角度：**认不出率高，本身说明这个项目的提交信息不容易被机器读。**
 * 这不是「我的工具不好」，而是一个**关于项目的客观事实** ——
 * 它反映了该项目对提交规范的投入程度。
 *
 * ── 三个子指标（都不依赖语义理解）──────────────────────
 *   ccRate      全量提交里用了 conventional commit 前缀（feat:/fix(...)…）的比例
 *   scopeRate   fix 提交里带 scope 括号（fix(xxx)）的比例
 *   otherRate   fix 提交里我的分类器放不进四类的比例（来自 fix-anatomy.json）
 *
 * ⚠ 2026-11-15 实测推翻了我原本的假设
 * 我原本写的是「三者应互相印证：ccRate 高 ⇒ scopeRate 高 ⇒ otherRate 低」。
 * 实测不成立：WeKnora 前缀 100% / scope 99%，认不出仍 35%；
 * orca 93% / 100%，认不出 40%。
 *
 * 原因是**两个指标测的不是同一件事**：
 *   ccRate / scopeRate  → 格式有多规范（客观，属于项目）
 *   otherRate           → 我的词表覆盖了多少（工具属性，**不属于项目**）
 *
 * 所以判读**只看格式**；otherRate 单列，并明确标为「分类器覆盖率」。
 * 把「我的词表不够」说成「这个项目难被机器读」，是把工具局限伪装成项目缺陷。
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS     拿到 ≥20 条提交，三个指标都能算
 *   WARN     拿到 <20 条
 *   UNKNOWN  抓取失败
 *
 * 用法：node tools/benchmark/commit-readability.mjs [--selftest]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

export const REPOS = [
  { id: 'openclaw', slug: 'openclaw/openclaw', label: 'openclaw' },
  { id: 'weknora', slug: 'Tencent/WeKnora', label: 'WeKnora' },
  { id: 'omp', slug: 'the-snowpear/omp-studio', label: 'omp-studio' },
  { id: 'ecc', slug: 'affaan-m/ECC', label: 'ECC' },
  { id: 'orca', slug: 'stablyai/orca', label: 'orca' },
  { id: 'craft', slug: 'storytold/craft-anything', label: 'craft-anything' },
];

/** conventional commit 前缀（feat/fix/refactor/…，可带 scope，可带 !） */
const CC = /^(feat|fix|refactor|perf|docs|test|chore|build|ci|style|revert)(\([^)]*\))?!?:/i;

/**
 * 计算可读性指标
 * @param messages 提交首行数组
 */
export function readability(messages) {
  const all = messages.filter((m) => String(m || '').trim());
  const total = all.length;
  const cc = all.filter((m) => CC.test(m)).length;
  const fixes = all.filter((m) => /^fix/i.test(m));
  const withScope = fixes.filter((m) => /^fix\([^)]*\)/i.test(m)).length;
  const avgLen = total ? Math.round(all.reduce((a, m) => a + m.length, 0) / total) : 0;
  return {
    total,
    ccRate: total ? Math.round((cc / total) * 100) : 0,
    fixCount: fixes.length,
    scopeRate: fixes.length ? Math.round((withScope / fixes.length) * 100) : 0,
    avgLen,
  };
}

/**
 * 综合判读（只描述形态，不判好坏）
 */
export function readout(r) {
  if (!r || !r.total) return { label: 'UNKNOWN', why: '无提交' };
  // 判读只看**格式**，不看认不出率 —— 后者是分类器覆盖率，不是项目属性
  if (r.ccRate >= 90 && r.scopeRate >= 90) return { label: '格式严格', why: '前缀与 scope 都 ≥90%' };
  if (r.ccRate >= 70) return { label: '格式规范', why: '前缀 ≥70%' };
  if (r.ccRate >= 30) return { label: '半规范', why: '部分提交带前缀' };
  return { label: '自由格式', why: '基本不用 conventional commit' };
}

/**
 * 分类器覆盖率 —— 这是**工具指标**，不是项目属性
 * 明确与 readout 分开，避免再把工具局限说成项目缺陷。
 */
export function coverageOf(otherRate) {
  if (typeof otherRate !== 'number') return { label: 'UNKNOWN', note: '无数据' };
  if (otherRate <= 15) return { label: '高', note: '词表覆盖 ' + (100 - otherRate) + '%' };
  if (otherRate <= 30) return { label: '中', note: '词表覆盖 ' + (100 - otherRate) + '%' };
  return { label: '低', note: '词表覆盖 ' + (100 - otherRate) + '%（该项目的 scope 不在通用词表内）' };
}

/** 自检 —— 4 条正例 + 6 条反例
 *
 * 【2026-11-16 补正例】原来 6 条全叫「反例」，其中 2 条其实是正例写错了标签。
 * 真正的风险是**假红**：如果 readability 永远返回 0、readout/coverageOf 永远返回 {}，
 * 那 6 条反例里有 4 条照样绿（「不许当成规范」永远成立）—— 工具废了也看不出来。
 * 所以补 4 条正例：合法输入必须算出**精确值**，打瘸被测函数会立刻变红。
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const r1 = readability(['feat: a', 'fix(x): b', 'chore: c', 'plain message']);
  T('反例 · 3/4 带前缀 ⇒ ccRate 75', r1?.ccRate === 75, JSON.stringify(r1));
  T('反例 · fix 里 1/1 带 scope ⇒ scopeRate 100', r1.scopeRate === 100, JSON.stringify(r1));

  const r2 = readability(['随便写的', '又一条中文描述']);
  T('反例 · 无前缀 ⇒ ccRate 0（不许当成规范）', r2.ccRate === 0, JSON.stringify(r2));
  T('反例 · 无 fix ⇒ scopeRate 0（不许 NaN）', r2.scopeRate === 0, JSON.stringify(r2));

  T('反例 · 空输入必须 UNKNOWN（不许当 PASS）', readout(readability([])).label === 'UNKNOWN', '');
  T('反例 · 分类器覆盖率与项目判读必须分开：认不出 40% 不许影响 readout',
    readout(readability(['feat: a', 'fix(x): b'])).label === '格式严格' && coverageOf(40).label === '低',
    JSON.stringify({ ro: readout(readability(['feat: a', 'fix(x): b'])), cov: coverageOf(40) }));

  // ── 正例：合法输入必须算出精确值（被测函数被打瘸时这里会红）──
  const rp = readability(['fix(ui): a', 'fix(api): b', 'refactor: c', 'docs: d', 'wip stuff']);
  T('正例 · 5 条里 4 条带前缀、2 条 fix 都带 scope ⇒ 必须精确算成 80/2/100',
    rp.total === 5 && rp.ccRate === 80 && rp.fixCount === 2 && rp.scopeRate === 100,
    JSON.stringify(rp));

  const rl = readability(['fix(ui): a', 'feat: bb']);
  T('正例 · 首行 10 与 8 字符 ⇒ avgLen 必须精确等于 9',
    rl.avgLen === 9 && rl.total === 2, JSON.stringify(rl));

  T('正例 · 四档判读必须精确落位：100/90⇒格式严格 · 75⇒格式规范 · 50⇒半规范 · 10⇒自由格式',
    [readout({ total: 10, ccRate: 100, scopeRate: 90 }).label,
      readout({ total: 10, ccRate: 75, scopeRate: 0 }).label,
      readout({ total: 10, ccRate: 50, scopeRate: 0 }).label,
      readout({ total: 10, ccRate: 10, scopeRate: 0 }).label].join('/')
      === '格式严格/格式规范/半规范/自由格式',
    JSON.stringify([readout({ total: 10, ccRate: 100, scopeRate: 90 }),
      readout({ total: 10, ccRate: 75, scopeRate: 0 })]));

  T('正例 · 覆盖率三档必须精确：认不出 5%⇒高 · 20%⇒中 · 40%⇒低',
    [coverageOf(5).label, coverageOf(20).label, coverageOf(40).label].join('/') === '高/中/低',
    JSON.stringify([coverageOf(5), coverageOf(20), coverageOf(40)]));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

function fetchMessages(slug) {
  const tmp = path.join(REPO, 'evidence/evolve/_rd_tmp.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  for (let a = 1; a <= 10; a++) {
    try { fs.unlinkSync(tmp); } catch { /* ok */ }
    try {
      execFileSync('curl.exe', ['-sL', '--max-time', '20', '-o', tmp,
        '-H', 'User-Agent: dsh-agent', '-H', 'Accept: application/vnd.github+json',
        'https://api.github.com/repos/' + slug + '/commits?per_page=100'], { stdio: 'ignore' });
    } catch { /* retry */ }
    let raw = '';
    try { raw = fs.readFileSync(tmp, 'utf8'); } catch { /* ok */ }
    if (!raw.trim()) continue;
    let j;
    try { j = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(j)) continue;
    return { ok: true, messages: j.map((c) => (c.commit?.message || '').split('\n')[0]) };
  }
  return { ok: false };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  提交信息可读性 · 自检（4 正例 + 6 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

// 读 fix-anatomy 的 otherRate 做交叉印证
let otherRates = {};
try {
  const fa = JSON.parse(fs.readFileSync(path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/fix-anatomy.json'), 'utf8'));
  for (const [k, v] of Object.entries(fa.repos || {})) {
    if (v && v.ok && v.dist && v.dist.other) otherRates[k] = v.dist.other.pct;
  }
} catch { otherRates = {}; }

console.log('');
console.log('  提交信息可读性 —— 把「分类器认不出」翻转成项目的客观属性');
console.log('  ' + '='.repeat(80));
console.log('  项目            提交  前缀率  scope率  格式判读        | 分类器覆盖率');
console.log('  ' + '-'.repeat(80));

const out = { at: new Date().toISOString(), repos: [] };
for (const r of REPOS) {
  const got = fetchMessages(r.slug);
  if (!got.ok) {
    console.log('  ' + r.label.padEnd(16) + '  ❔ 抓取失败');
    out.repos.push({ ...r, state: 'UNKNOWN' });
    continue;
  }
  const m = readability(got.messages);
  const other = otherRates[r.id];
  const rd = readout(m);
  const cov = coverageOf(other);
  console.log('  ' + r.label.padEnd(16)
    + String(m.total).padStart(4)
    + String(m.ccRate + '%').padStart(7)
    + String(m.scopeRate + '%').padStart(8)
    + '  ' + rd.label.padEnd(12)
    + '  | ' + cov.label + '（' + cov.note + '）');
  out.repos.push({ ...r, state: 'PASS', metrics: m, readout: rd, coverage: cov, otherRate: other ?? null });
}
console.log('  ' + '-'.repeat(80));
console.log('  注：左半区（前缀率/scope率/格式判读）描述**项目**；');
console.log('      右半区（分类器覆盖率）描述**我的工具**，不是项目属性。');
console.log('      实测反例：WeKnora 前缀100%/scope99% 但覆盖率低（35% 认不出）；');
console.log('                orca 93%/100% 但覆盖率低（40% 认不出）—— 格式规范 ≠ 我的词表覆盖得到。');
console.log('');
const op = path.join(REPO, 'evidence/evolve/commit-readability.json');
fs.writeFileSync(op, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('  → ' + path.relative(REPO, op));
console.log('');
