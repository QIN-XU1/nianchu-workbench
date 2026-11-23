#!/usr/bin/env node
/**
 * scope 校验 —— 用本地仓库的目录结构，判断提交里的 scope 是不是真模块
 *
 * ── 为什么需要它（2026-11-15 的阻塞）──────────────────────
 * 上一轮发现：fix 分类器对 openclaw 有效（认不出 5%），对其它 5 家不可用（17-35%）。
 * 根因是我的 scope 词表只覆盖 openclaw 的用词。
 *
 * 两条改进路，实测都堵死：
 *   ① 为每家扩词表 —— 等于给每家定制尺子，可能失真
 *   ② 按改动文件路径分类 —— **GitHub API 的 /commits 列表不返回 files 字段**
 *      （实测顶层键只有 sha/commit/url/author/committer/parents），
 *      要拿 files 得逐条请求 100 次；而限流只剩 14/60。**不可行。**
 *
 * ── 这个脚本做什么（零 API 调用）──────────────────────────
 * 从**本地 refs 的目录结构**出发，回答：
 *   · 这个仓库真实有哪些模块目录
 *   · 提交里的 scope 名，有多少能在目录结构里找到对应
 *
 * 找到 ⇒ scope 是**真实模块名**（客观）
 * 找不到 ⇒ scope 是**概念/缩写**（需要人判断，不能自动归类）
 *
 * ── 用法 ──────────────────────────────────────────────
 *   node tools/benchmark/scope-map.mjs weknora chat,frontend,docreader,wiki
 */
import fs from 'node:fs';
import path from 'node:path';

/** 本地 refs 映射（与 repo-timeline 的 id 对应） */
export const LOCAL_REFS = {
  weknora: 'D:/refs/WeKnora',
  'omp-studio': 'D:/refs/omp-studio',
  ecc: 'D:/refs/ECC',
  craft: 'D:/refs/craft-anything',
  openclaw: 'D:/refs/openclaw/openclaw-main',
};

const SKIP = /^(node_modules|\.git|dist|build|target|\.next|coverage|__pycache__|\.venv|vendor)$/;

/** 收集目录名（顶层 + 2 层），返回小写集合 */
export function collectDirs(root, maxDepth = 3) {
  const out = new Set();
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP.test(e.name)) continue;
      out.add(e.name.toLowerCase());
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  if (fs.existsSync(root)) walk(root, 0);
  return out;
}

/**
 * 校验一组 scope
 * @returns {{matched: string[], unmatched: string[], rate: number}}
 */
export function checkScopes(scopes, dirs) {
  const matched = [];
  const unmatched = [];
  for (const s of scopes) {
    const k = String(s).toLowerCase();
    // 精确命中目录名，或目录名包含它（docreader ⊂ doc-reader）
    const hit = dirs.has(k)
      || [...dirs].some((d) => d === k || d.replace(/[-_]/g, '') === k.replace(/[-_]/g, ''));
    (hit ? matched : unmatched).push(s);
  }
  const tot = scopes.length;
  return { matched, unmatched, rate: tot ? Math.round((matched.length / tot) * 100) : 0 };
}

/** 自检 —— 4 条反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const dirs = new Set(['ui', 'runtime', 'docreader', 'preview']);

  // ── 正例：必须能正确判「命中」，不只是「不误判」──────────────
  // 为什么需要它：如果 checkScopes 永远返回 matched=0 / rate=0，
  // 所有「不许当命中」的反例都会通过 —— 必须显式断言它确实能命中。
  const r1 = checkScopes(['ui'], dirs);
  T('正例 · 命中率：1 个 scope 命中 1 个目录 ⇒ rate=100',
    (r1?.matched || []).length === 1 && r1?.rate === 100, JSON.stringify(r1));

  const r2 = checkScopes(['ui', '不存在的目录xyz'], dirs);
  T('正例 · 部分命中：2 个 scope 命中 1 个 ⇒ rate=50',
    (r2?.matched || []).length === 1 && (r2?.unmatched || []).length === 1 && r2?.rate === 50, JSON.stringify(r2));

  T('正例 · 精确命中必须算 matched', (checkScopes(['ui'], dirs)?.matched || []).length === 1, '');
  T('反例 · 找不到的 scope 必须算 unmatched（不许当命中）',
    (checkScopes(['nonexistent-scope'], dirs)?.unmatched || []).length === 1, '');
  T('正例 · 连字符/下划线差异应视为同一个（doc-reader = docreader）',
    (checkScopes(['doc-reader'], dirs)?.matched || []).length === 1,
    JSON.stringify(checkScopes(['doc-reader'], dirs)));
  T('反例 · 空输入 rate 必须是 0（不许 NaN）', checkScopes([], dirs)?.rate === 0, '');
  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  scope 校验 · 自检（4 反例）');
  console.log('  ' + '─'.repeat(70));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

const repoId = process.argv[2];
const scopeArg = process.argv[3];
if (!repoId || !LOCAL_REFS[repoId]) {
  console.log('');
  console.log('  用法：node tools/benchmark/scope-map.mjs <repoId> <scope1,scope2,...>');
  console.log('  可用 repoId：' + Object.keys(LOCAL_REFS).join(' / '));
  console.log('');
  process.exit(2);
}
const root = LOCAL_REFS[repoId];
if (!fs.existsSync(root)) {
  console.log('  ❔ 本地 refs 不存在：' + root);
  process.exit(2);
}
const dirs = collectDirs(root);
console.log('');
console.log('  scope 校验 —— ' + repoId + '（本地 ' + root + '）');
console.log('  ' + '='.repeat(74));
console.log('  目录总数（3 层内）：' + dirs.size);
if (scopeArg) {
  const scopes = scopeArg.split(',').map((s) => s.trim()).filter(Boolean);
  const r = checkScopes(scopes, dirs);
  console.log('');
  console.log('  能在目录结构里找到的 scope（' + r.rate + '%）：');
  console.log('    ' + (r.matched.join(' ') || '（无）'));
  console.log('  找不到的 scope（概念/缩写，需人判断）：');
  console.log('    ' + (r.unmatched.join(' ') || '（无）'));
  console.log('');
  console.log('  含义：matched 的 scope 是**真实模块名**，可以客观归类；');
  console.log('        unmatched 的 scope 是作者随手写的概念，自动归类不可靠。');
} else {
  const sample = [...dirs].slice(0, 40).sort();
  console.log('  目录样本：' + sample.join(' '));
}
console.log('');
