#!/usr/bin/env node
/**
 * 可执行对照 —— 用**同一把尺子**量我们和参照系统的源码
 *
 * ── 为什么需要它（T5 的诚实化）─────────────────────────────
 * 31 维矩阵里其他 7 方的分数是**我们打的**。那是「我们认为我们比他们强」，
 * 不是「客观上我们更强」。audit-lead.mjs 已经把这条限制写进输出。
 *
 * 这个脚本做一件不同的事：**不评分，只数痕迹**。
 * 对每个系统跑完全相同的几个机械探测，数源码里出现了多少次相关标识。
 *
 * ── 它测什么、不测什么（必须说清）──────────────────────────
 *   测：某个能力在源码里**有没有留下痕迹**（可复现、可比、不看文档）
 *   不测：那个能力**做得好不好**
 *
 * 所以「痕迹多」不等于「实现好」。但「痕迹为 0」基本等于「没做这件事」——
 * 后者是硬信息，前者是弱信息。本脚本的结论按这个强弱来读。
 *
 * ── 为什么比自评强 ────────────────────────────────────
 *   · 同一段正则、同一套排除规则、同一批扩展名 —— 对所有系统一视同仁
 *   · 每条命中都能给出 文件:行号（可核对）
 *   · 有**负对照**（一个应当 0 命中的无意义 token），证明扫描器不是什么都匹配
 *
 * 用法：node tools/benchmark/executable-compare.mjs [--json] [--probe P1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { SENSITIVITY_NOTE } from './compare-notes.mjs';
import { SCOPE_POLICY, isArchived } from './scope-policy.mjs';
import { composeVerdict, detectOutlier } from './compare-verdict.mjs';
import { PROBES } from './probes.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');

/**
 * 每千文件率的最小样本量
 *
 * 【2026-11-17 加】实测：luanyujia-workbench 只有 43 个文件、P4 命中 14 个
 * ⇒ 每千文件 325.6，而 openclaw 有 56264 个文件、命中 451 ⇒ 每千 8.0。
 * 「325 > 8」不代表 luanyujia 的门禁意识强 40 倍，只代表它的仓库小。
 *
 * 这会让 P4 误判我们「落后」（我们 33.1 实际排第 3）。
 * 所以：**每千文件率只在 files >= MIN_FILES 的系统之间比较**。
 */
export const MIN_FILES = 1000;

/**
 * 参考副本 / 缓存目录 —— 这些**不是我们的实现**，必须从扫描里排除
 *
 * 【2026-11-17 修】实测：我们的 P4 命中 639 个文件，其中 585 个在 other/，
 * 样例里出现 hermes/... —— 而 .gitignore:180-183 明确写着
 *   「hermes 完整源码（MIT）作为设计参考，243 MB / 25514 文件」
 * 即那是**别人仓库的副本**。算进我们的分数会造成两个问题：
 *   ① 我们的分数虚高
 *   ② hermes 自己的代码被算进我们、而 hermes 又被单独统计 ⇒ **重复计数**
 *
 * 做法：优先从 .gitignore 里读被排除的顶层目录，读不到就用兜底列表。
 * 这样以后加新目录不用改代码。
 */

/**
 * fork 目录 —— 我们的代码里，源自 upstream、且逐字节未改的部分
 *
 * 【2026-11-17】vouch-web 约 97.8% 文件与 OpenBitFun upstream 逐字节相同（fork 副本）。
 * 口径：raw 与 own 都报，四态用 own。
 */
export const FORK_DIRS = [
  // projects.json 里 openbitfun 的 tagline 原文：「我们前端基座：已 fork 进 apps/vouch-web」
  { dir: 'apps/vouch-web', upstream: 'D:/refs/openbitfun-src/OpenBitFun-main' },
];

/**
 * 该目录是否被 git 跟踪 —— 用来判断「是不是我们自己的代码」
 *
 * 【2026-11-17】hermes-patches 是我们自己的（git 跟踪），曾被名字误排除。
 * 用 git 跟踪状态判断，不靠目录名猜。
 */
function isGitTracked(relDir) {
  try {
    const out = execFileSync('git', ['ls-files', '--', relDir],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export const REF_COPY_DIRS = (() => {
  const fallback = ['hermes', 'hermes-patches', 'node26', 'pnpm12', 'npm-cache', 'research/repos',
    'npm-cache2', 'pydeps', 'dist2', 'dist3', '.pnpm-store', '.pnpm-home', 'corepack', '参考项目'];
  try {
    const gi = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8');
    const found = new Set();
    for (const line of gi.split('\n')) {
      // 【2026-11-17 修】原正则只认单段名，漏掉 research/repos 这类多段路径
      // （那里有 2971 个 vendored 文件，占我们 own 的 61%）
      const m = /^([A-Za-z0-9_.\-/]+?)\/?\s*$/.exec(line.trim());
      if (m && !m[1].startsWith('!') && !m[1].startsWith('#')) found.add(m[1]);
    }
    // 只保留确实存在的顶层目录，且不与我们的源码目录同名
    const keep = [...found].filter((d) => fallback.includes(d) || /^(node|npm-cache|pnpm|pydeps|dist\d)/.test(d));
    const cand = [...new Set([...keep, ...fallback])];
    // 【2026-11-17 修】git 跟踪的目录是我们的代码，不许排除（hermes-patches 就是这样被误排的）
    return cand.filter((d) => !isGitTracked(d));
  } catch {
    return fallback.filter((d) => !isGitTracked(d));
  }
})();

const PROJECTS = JSON.parse(fs.readFileSync(
  path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/projects.json'), 'utf8')).projects;
/**
 * 自检：四态每档都要能触发 + 口径策略可核对
 *
 * @param {object} d 依赖注入（主文件传进来，避免循环依赖）
 */
function selfTest(d = {}) {
  const {
    MIN_FILES = 0, REF_COPY_DIRS = [], FORK_DIRS = [],
    SCOPE_POLICY = {}, isArchived = () => false, cheapHash = () => 0, REPO = '', path = null,
  } = d;
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 四态每档都能触发 ──
  T('反例 · 负对照 > 0 ⇒ FAIL（扫描器什么都匹配，数据不可信）',
    composeVerdict({ neg: 3, available: 16, lead: 8, behind: 0 }).state === 'FAIL', '');
  T('反例 · 可扫系统 < 10 ⇒ UNKNOWN（样本太少判不了）',
    composeVerdict({ neg: 0, available: 5, lead: 8, behind: 0 }).state === 'UNKNOWN', '');
  T('反例 · 落后 > 领先 ⇒ WARN（不许硬报 PASS）',
    composeVerdict({ neg: 0, available: 16, lead: 2, behind: 6 }).state === 'WARN', '');
  T('正例 · 领先 >= 落后 且负对照 0 且样本够 ⇒ PASS',
    composeVerdict({ neg: 0, available: 16, lead: 6, behind: 2 }).state === 'PASS', '');
  T('正例 · 领先 = 落后 也判 PASS（不强行要求超过）',
    composeVerdict({ neg: 0, available: 16, lead: 4, behind: 4 }).state === 'PASS', '');
  T('边界 · 可扫系统恰好 10 个 ⇒ 可以判定（不是 UNKNOWN）',
    composeVerdict({ neg: 0, available: 10, lead: 5, behind: 5 }).state !== 'UNKNOWN', '');
  T('反例 · 负对照 > 0 且样本也少 ⇒ 优先报 FAIL（先修扫描器）',
    composeVerdict({ neg: 1, available: 3, lead: 0, behind: 0 }).state === 'FAIL', '');

  // ── 小样本放大 ──
  // luanyujia 43 文件时 P4 每千 325.6，把 openclaw（56264 文件、每千 8.0）压成「落后」
  T('反例 · MIN_FILES 必须 >= 1000（否则 43 文件的小仓会放大成 325/千）',
    MIN_FILES >= 1000, String(MIN_FILES));
  T('正例 · 43 个文件的小样本必须被 MIN_FILES 排除', 43 < MIN_FILES, '43 < ' + MIN_FILES);
  T('正例 · 56264 个文件的 openclaw 必须被纳入比较', 56264 >= MIN_FILES, '');
  const o1 = detectOutlier([325.6, 123.8, 33.1, 8.0]);
  T('反例 · 325.6 vs 123.8 不该判离群（2.6 倍刚好在阈值边缘）',
    o1.ratio > 2.5 === o1.suspicious, JSON.stringify(o1));
  T('反例 · 1000 vs 10（100 倍）必须判离群', detectOutlier([1000, 10, 5]).suspicious === true, '');
  T('正例 · 10 vs 9（1.1 倍）不判离群', detectOutlier([10, 9, 8]).suspicious === false, '');
  T('边界 · 只有一个值时不判离群（无从比较）', detectOutlier([5]).suspicious === false, '');

  // ── 参考副本必须排除 ──
  T('反例 · hermes/ 必须被排除（那是 MIT 参考副本，不是我们的实现）',
    REF_COPY_DIRS.includes('hermes'), '');
  T('反例 · node26/ pnpm12/ npm-cache/ 等缓存目录必须被排除',
    ['node26', 'pnpm12', 'npm-cache'].every((x) => REF_COPY_DIRS.includes(x)), '');
  T('正例 · 我们的源码目录（tools/apps/prototype）不许被排除',
    !['tools', 'apps', 'prototype', 'research', 'evidence'].some((x) => REF_COPY_DIRS.includes(x)), '');
  T('反例 · 参考项目 必须在排除列表（外部仓库，gitignore:151）',
    REF_COPY_DIRS.includes('参考项目'), '');
  T('反例 · research/repos 必须在排除列表（vendored 参考副本）',
    REF_COPY_DIRS.includes('research/repos'), '');

  // ── fork 感知 ──
  // apps/vouch-web 约 97.8% 文件与 OpenBitFun upstream 逐字节相同
  T('反例 · FORK_DIRS 必须非空（否则 fork 副本会被算成我们的独创）',
    Array.isArray(FORK_DIRS) && FORK_DIRS.length > 0, '');
  T('反例 · FORK_DIRS 每条必须有 dir 与 upstream 两个字段',
    FORK_DIRS.every((f) => f && f.dir && f.upstream), '');
  T('正例 · apps/vouch-web 必须在 FORK_DIRS 里（它是 OpenBitFun fork）',
    FORK_DIRS.some((f) => f.dir.includes('vouch-web')), '');
  if (path && REPO) {
    T('反例 · fork 检测必须能区分「相同」与「不同」内容',
      cheapHash(process.execPath) !== cheapHash(path.join(REPO, 'package.json')), '');
    T('正例 · 同一文件两次 hash 必须相同（确定性）',
      cheapHash(path.join(REPO, 'package.json')) === cheapHash(path.join(REPO, 'package.json')), '');
  }

  // ── 口径策略可核对 ──
  T('反例 · SCOPE_POLICY 必须三层齐全（ours/archived/notOurs）',
    ['ours', 'archived', 'notOurs'].every((k) => SCOPE_POLICY[k]), '');
  T('反例 · 每层必须有 rule 字段（判据要可核对，不许含糊）',
    ['ours', 'archived', 'notOurs'].every((k) => SCOPE_POLICY[k] && SCOPE_POLICY[k].rule), '');
  T('正例 · 归档层必须列出目录（否则「不计入」是拍脑袋）',
    Array.isArray(SCOPE_POLICY.archived?.dirs) && SCOPE_POLICY.archived.dirs.length > 0, '');
  T('正例 · isArchived 能识别归档目录', isArchived('归档/旧备份/x.ts') === true, '');
  T('反例 · isArchived 不许把正常源码判成归档', isArchived('tools/evolve/evolve.mjs') === false, '');
  T('反例 · isArchived 不许前缀误判（归档X 不是 归档）', isArchived('归档X/a.ts') === false, '');

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length,
    total: cases.length,
    ok: bad.length === 0,
    lines: cases.map(([n, ok]) => '  ' + (ok ? '✓' : '✗') + ' ' + n).join('\n'),
  };
}



// --selftest 提前退出：只测四态判定逻辑，不跑完整扫描
if (process.argv.includes('--selftest')) {
  const r = selfTest({
    MIN_FILES, REF_COPY_DIRS, FORK_DIRS, SCOPE_POLICY, isArchived, cheapHash, REPO, path,
  });  // eslint-disable-line
  console.log('');
  console.log('  executable-compare · 四态判定的自检');
  console.log('  ' + '─'.repeat(68));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}


/** 统一排除规则 —— 对所有系统完全相同 */
const SKIP_DIR = /(^|[\\/])(node_modules|dist|build|out|target|\.git|vendor|third_party|coverage|\.next|__pycache__|\.venv|venv)([\\/]|$)/i;
const SKIP_FILE = /\.(min\.js|map|lock|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|mp4|zip|gz|tar|pdf)$/i;
// 【2026-11-18 修自指假阳性】探测器定义文件里写着 P99 的正则本身
// （zxqvblorp|quuxly_frobnicate），扫描器扫到自己就命中 ⇒ 负对照从 0 变 1。
// 那不是「扫描器什么都匹配」，是自指。把定义文件排除掉。
const SELF_DEF = /(^|[\\/])probes\.mjs$/;
const SRC_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|rs|go|java|kt|cs|cpp|c|h|hpp|rb|php|swift|scala|lua)$/i;
const MAX_BYTES = 2 * 1024 * 1024;   // 单文件上限，避免扫二进制/超大生成物
const MAX_FILES = 200000;   // 原来 40000：openclaw 有 4 万+ 文件，会被截断导致不可比

/**
 * 探测项 —— 每项必须能**机械判定**（正则 + 源码文件）
 *
 * strength 说明这条证据有多硬：
 *   hard   出现即基本说明做了这件事（如 supersededBy 这种专用标识）
 *   soft   可能只是提到（如 cost 可能出现在注释里）
 *
 * ── withContext：为什么需要它（2026-11-15 重要修正）──────────
 * 第一版 P6 用 `supersede|invalidate` 数命中，结论「我们落后 openclaw（1713 vs 5553）」。
 * 后来真去看 openclaw 那 5553 行命中是什么，发现：
 *   · 大量是 **UI 缓存失效** `invalidate()`（model-providers 页面）
 *   · 还有异步请求取消 "superseded consult"
 *   · 真正与 memory 相关的只有 281/4768，且多是 UI memory 页缓存
 *
 * 也就是说：**那个数字测的是「invalidate 这个词出现多少次」，不是记忆治理。**
 * `invalidate` 是个通用词（缓存失效/请求取消/表单重置都用），
 * 拿它当「记忆冲突处理」的代理是错的。
 *
 * 修法：加 `withContext` —— 一个文件只有**同时**包含这些上下文词，
 * 其中的命中才算数。这仍是粗筛，但至少排除了「整个仓库都在用 invalidate」的情况。
 */
// 探测器定义已拆到 ./probes.mjs（B4 体量纪律）
;

/** 扫描器自身 —— 必须排除，否则负对照会命中自己（同 syntax-guard 自污染） */
const SELF_FILES = new Set([
  path.join(REPO, 'tools/benchmark/executable-compare.mjs'),
]);

/**
 * 该文件算不算「源码」
 *
 * 【2026-11-17 修】加 inWhitelistedNm 参数。
 * 起因：我把调用从 isSourceFile(e.name) 改成 isSourceFile(完整路径) 后，
 * SKIP_DIR 终于能看见 node_modules，**把 keepInNodeModules 白名单打死了** ——
 * DeepSeek Harness 从 3995 个文件变成 0（验证方 v-h0131 硬伤③）。
 *
 * 之前白名单能生效纯属副作用（传的是文件名，路径检查看不见 node_modules）。
 * 现在显式表达：已进入白名单包内部时，跳过 SKIP_DIR 与 REF_COPY_DIRS。
 */
function isSourceFile(p, inWhitelistedNm = false) {
  if (SKIP_FILE.test(p)) return false;
  if (SELF_DEF.test(p)) return false;   // 探测器定义文件不参与扫描（自指会污染 P99 负对照）
  if (!inWhitelistedNm && SKIP_DIR.test(p)) return false;
  // 【2026-11-17 加】排除参考副本 / 缓存目录 —— 那些不是我们的实现
  // 实测：不排除时我们的 P4 命中 639 个文件，其中 585 个来自 hermes/ 等副本目录
  if (!inWhitelistedNm) {
    const rel = path.relative(REPO, path.isAbsolute(p) ? p : path.join(REPO, p)).replace(/\\/g, '/');
    if (REF_COPY_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))) return false;
  }
  return SRC_EXT.test(p);
}

/**
 * 递归收集源码文件
 *
 * keepInNodeModules：允许某些主体把 node_modules 下的**指定包**算进来。
 *
 * 为什么需要：DSH 的源码就在 `node_modules/@deepseek-ai` 下（它是装出来的包树），
 * 不开口子就是 0 文件。
 *
 * 【2026-11-15 修 · 两个 bug】
 *   ① 第一版只在「目录路径里已含 node_modules/<包名>」时才放行 ——
 *      但我们遇到的是 `.../node_modules` 这个**父目录**，路径里没有包名，
 *      于是整个 node_modules 被挡在门外，DSH 仍然 0 文件。
 *   ② 正解：进 node_modules 时加一个 `insideNm` 标记，
 *      **只有白名单里的包名**才继续往下走，其余一律不进。
 *
 * @param {string|null} insideNm  null=不在 node_modules 里；true=刚进 node_modules（只看下一层包名）；false=已在白名单包内
 */
function collect(dir, out = [], depth = 0, keepInNodeModules = [], insideNm = null) {
  if (out.length >= MAX_FILES || depth > 14) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (out.length >= MAX_FILES) break;
    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      const isNmRoot = /[\\/]node_modules$/i.test(full);

      // 情况 A：遇到 node_modules 根，且有白名单 ⇒ 进去，但只认下一层的包名
      if (isNmRoot && keepInNodeModules.length && insideNm === null) {
        collect(full, out, depth + 1, keepInNodeModules, true);
        continue;
      }

      // 情况 B：正在 node_modules 里挑包 ⇒ 只有白名单包才进
      if (insideNm === true) {
        if (keepInNodeModules.includes(e.name)) {
          collect(full, out, depth + 1, keepInNodeModules, false);
        }
        continue;
      }

      // 情况 C：已在白名单包内部 ⇒ 正常往下走（但不再被 SKIP_DIR 拦）
      if (insideNm === false) {
        collect(full, out, depth + 1, keepInNodeModules, false);
        continue;
      }

      // 情况 D：普通目录 ⇒ 按统一排除规则
      if (SKIP_DIR.test(full)) continue;
      collect(full, out, depth + 1, keepInNodeModules, null);

    } else if (e.isFile() && isSourceFile(full, insideNm === false)) {
      if (SELF_FILES.has(path.resolve(full))) continue;   // 排除扫描器自身
      try { if (fs.statSync(full).size <= MAX_BYTES) out.push(full); } catch { /* */ }
    }
  }
  return out;
}

/** 对单个系统跑全部探测 */
/**
 * 判断某文件是否是「fork 来的、逐字节未改的副本」
 *
 * 用内容 hash 比对（不读全文件，取前 200KB，足够区分）。
 * 为什么需要：apps/vouch-web 里 4859/4984 个文件与 OpenBitFun upstream 完全相同，
 * 把它们算成「我们的独创实现」会让分母虚大一倍，所有率被低估。
 */
function makeForkChecker() {
  const cache = new Map();   // upstream 相对路径 -> hash
  function loadUpstream(upDir) {
    if (cache.has(upDir)) return cache.get(upDir);
    const m = new Map();
    if (fs.existsSync(upDir)) {
      for (const p of collect(upDir, [], 0, [])) {
        m.set(path.relative(upDir, p).replace(/\\/g, '/'), cheapHash(p));
      }
    }
    cache.set(upDir, m);
    return m;
  }
  return function isForkCopy(absPath) {
    for (const fk of FORK_DIRS) {
      const forkAbs = path.join(REPO, fk.dir);
      if (!absPath.startsWith(forkAbs)) continue;
      const relp = path.relative(forkAbs, absPath).replace(/\\/g, '/');
      const up = loadUpstream(fk.upstream);
      if (!up.has(relp)) return false;
      return up.get(relp) === cheapHash(absPath);
    }
    return false;
  };
}

/** 廉价内容指纹（前 200KB，FNV 风格） */
function cheapHash(p) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    let h = 0;
    const n = Math.min(s.length, 200000);
    for (let i = 0; i < n; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  } catch { return -1; }
}

function scan(subject) {
  const root = subject.local;
  if (!root || !fs.existsSync(root)) {
    return { id: subject.id, name: subject.name, available: false, files: 0, hits: {}, samples: {} };
  }
  const filesAll = collect(root, [], 0, subject.keepInNodeModules || []);

  // 【2026-11-17 加】fork 感知：把「与 upstream 逐字节相同」的副本排除出 own 口径
  const isForkCopy = makeForkChecker();
  let forkCopyCount = 0;
  let archivedFiles = 0;
  const files = filesAll.filter((f) => {
    if (isForkCopy(f)) { forkCopyCount++; return false; }
    // 【2026-11-17】归档层：是我们的，但不是当前产品能力 ⇒ 单独报数，不计入四态
    const relp = path.relative(root, f).replace(/\\/g, '/');
    if (isArchived(relp)) { archivedFiles++; return false; }
    return true;
  });

  const hits = {}, samples = {}, fileHits = {};
  for (const p of PROBES) { hits[p.id] = 0; samples[p.id] = []; fileHits[p.id] = 0; }

  let contextSkipped = 0;   // 因文件级上下文不符而跳过的「潜在命中」数

  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }

    /**
     * 文件级上下文过滤（withContext）
     *
     * 一个探测项可以声明 `withContext`：只有同时含该上下文的正则的文件，
     * 其中的命中才算数。用来排除「整个仓库都在用同一个通用词」的假阳性。
     * 例：P6 不再接受通用的 invalidate（UI 缓存失效），要求文件里有 memory 上下文。
     */
    const ctxOk = {};
    for (const p of PROBES) {
      ctxOk[p.id] = p.withContext ? p.withContext.test(text) : true;
    }

    const hitInFile = {};   // 本文件是否已给某探测贡献过「文件命中」
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 2000) continue;   // 跳过超长生成行
      for (const p of PROBES) {
        if (p.re.test(line)) {
          if (!ctxOk[p.id]) { contextSkipped++; continue; }
          hits[p.id]++;
          if (!hitInFile[p.id]) { hitInFile[p.id] = true; fileHits[p.id]++; }
          if (samples[p.id].length < 3) {
            samples[p.id].push(path.relative(root, f).replace(/\\/g, '/') + ':' + (i + 1));
          }
        }
      }
    }
  }
  return { id: subject.id, name: subject.name, available: true, files: files.length, filesRaw: filesAll.length, forkCopies: forkCopyCount, archivedFiles, hits, fileHits, samples, contextSkipped };
}

// ── 主流程 ──
const only = (() => {
  const i = process.argv.indexOf('--probe');
  return i > 0 ? process.argv[i + 1] : null;
})();
const probes = only ? PROBES.filter((p) => p.id === only) : PROBES;

// 我们自己的源码 = 本仓库（排除证据目录与 node_modules，由 SKIP_DIR 已处理）
const SUBJECTS = [
  { id: 'us', name: '我们（念初）', local: REPO },
  ...PROJECTS.filter((p) => p.id !== 'us').map((p) => ({ id: p.id, name: p.name, local: p.local })),
];

// DSH 的源码在 node_modules/@deepseek-ai 下（装出来的包树），给它开白名单
{
  const dsh = SUBJECTS.find((s) => s.id === 'dsh');
  if (dsh) dsh.keepInNodeModules = ['@deepseek-ai'];
}

console.log('');
console.log('  可执行对照 —— 同一把尺子量所有系统的源码');
console.log('  ' + '='.repeat(88));
console.log('  测的是**痕迹**不是**质量**：痕迹为 0 基本等于没做；痕迹多不等于做得好。');
console.log('  计数口径：**文件命中数**（不是行命中数）—— 一个文件重复一个词 1000 次不算 1000。');
console.log('  排除规则统一：node_modules/dist/build/out/target/.git/vendor/third_party/coverage + 10 类源码扩展名');
console.log('');

const results = SUBJECTS.map(scan);
const available = results.filter((r) => r.available);

console.log('  可用源码：' + available.length + ' / ' + results.length + ' 个系统');
for (const r of results.filter((x) => !x.available)) {
  console.log('    · 无本机源码（跳过）：' + r.name);
}
console.log('');

// ── 表格 ──
const pad = (s, n) => String(s).padEnd(n);
console.log('  ' + pad('主体', 18) + pad('文件', 8) + pad('每千文件', 10) + probes.map((p) => pad(p.id, 7)).join(''));
console.log('  ' + '─'.repeat(88));

// 按总命中排序（负对照不计入）
const scored = available.map((r) => ({
  ...r,
  total: probes.filter((p) => p.id !== 'P99').reduce((a, p) => a + (r.hits[p.id] || 0), 0),
})).sort((a, b) => b.total - a.total);

for (const r of scored) {
  // 【2026-11-15 第三次修正】表格改成 **文件命中数**，不是行命中数。
  // 原因：openclaw 的 P2/P5/P6 行命中全集中在**一个 vendored 脚本**
  // （.agents/skills/update-team-server/controller/release-lib.mjs），
  // 一个文件重复一个词 1000 次，不代表这个能力在代码库里成立。
  // 文件数更能反映「这个能力散布在多广」。
  const totalFiles = probes.filter((p) => p.id !== 'P99').reduce((a, p) => a + (r.fileHits[p.id] || 0), 0);
  const rate = r.files ? (totalFiles / r.files * 1000).toFixed(1) : '—';
  console.log('  ' + pad(r.name.slice(0, 16), 18) + pad(r.files, 8) + pad(rate, 10)
    + probes.map((p) => pad(r.fileHits[p.id] || 0, 7)).join(''));
}

// ── 负对照检查 ──
console.log('');
console.log('  ' + '─'.repeat(88));
const neg = available.reduce((a, r) => a + (r.hits.P99 || 0), 0);
console.log('  负对照 P99（无意义 token）总命中 ' + neg + ' —— '
  + (neg === 0 ? '✓ 扫描器不是什么都匹配' : '✗ **扫描器有假阳性，结论不可信**'));

// ── 逐探测的「谁有谁没有」 ──
console.log('');
console.log('  逐项：有痕迹的系统数（痕迹为 0 的明确列出）');
console.log('  ' + '─'.repeat(88));
for (const p of probes) {
  if (p.id === 'P99') continue;
  const have = available.filter((r) => (r.hits[p.id] || 0) > 0);
  const lack = available.filter((r) => (r.hits[p.id] || 0) === 0);
  console.log('  ' + p.id + ' ' + pad(p.name, 18) + '有 ' + have.length + '/' + available.length
    + (lack.length ? '   没有：' + lack.map((x) => x.name).join('、').slice(0, 60) : ''));
}

// ── 我们 vs 最强的参照系统 ──
console.log('');
console.log('  我们 vs 参照系统（逐项 · 每千文件命中率）');
console.log('  ' + '─'.repeat(88));
const us = available.find((r) => r.id === 'us');
const others = available.filter((r) => r.id !== 'us');
for (const p of probes) {
  if (p.id === 'P99') continue;
  // 【2026-11-15 改口径】原来比**原始文件命中数**。但代码库体量差 2 倍时，小库天然吃亏 ——
  // 那个数字测的是「仓库有多大」，不是「能力有多强」。改成**每千文件命中率**。
  const rate = (r) => (r.files ? (r.fileHits[p.id] || 0) / r.files * 1000 : 0);
  const ours = rate(us);
  // 【2026-11-17 修】只和样本量够的系统比 —— 小仓库的每千文件率会被放大
  const comparable = others.filter((r) => r.files >= MIN_FILES);
  const tooSmall = others.filter((r) => r.files > 0 && r.files < MIN_FILES);
  const bestR = comparable.reduce((a, r) => Math.max(a, rate(r)), 0);
  const bestWho = comparable.filter((r) => Math.abs(rate(r) - bestR) < 1e-9).map((r) => r.name)[0] || '—';

  const ourSampleOk = (us?.files ?? 0) >= MIN_FILES;  // 我们也要过 MIN_FILES
  let mark;
  if (!ourSampleOk) {
    mark = '❔ 判不了（我们只有 ' + (us?.files ?? 0) + ' 文件 < MIN_FILES ' + MIN_FILES + '）';
  } else if (ours > bestR + 1e-9) mark = '✓ 领先';
  else if (Math.abs(ours - bestR) < 1e-9) mark = '= 持平';
  else mark = '✗ 落后';

  console.log('  ' + p.id + ' ' + pad(p.name, 18) + pad('我们 ' + ours.toFixed(2), 12)
    + pad('最强 ' + bestR.toFixed(2) + '（' + bestWho.slice(0, 8) + '）', 26) + mark
    + '   [每千文件]');
}

/**
 * 四态结论（H-0130）—— 把逐项数字汇总成一个可并入 verify-goal 的判定
 *
 * 【2026-11-17 加】起因：这个工具已经在做正确的事（同一把尺子 + 负对照 + 每千文件归一化），
 * 但输出只有数字没有结论，T5 一直是 UNKNOWN。
 *
 * 判定规则（可复算）：
 *   FAIL    负对照 > 0 —— 扫描器什么都匹配，全部数据不可信
 *   UNKNOWN 可扫系统 < 10 —— 样本太少，判不了
 *   WARN    领先项数 < 落后项数 —— **诚实说横向不领先**
 *   PASS    领先项数 >= 落后项数 且 负对照 0 且 样本够
 *
 * WARN 不是失败，是「数据说我们没领先」。把 WARN 硬报成 PASS 就是假绿。
 */

const OUT = {
  what: '可执行对照：同一把尺子量所有系统源码（数痕迹，不评质量）',
  at: new Date().toISOString(),
  // 【2026-11-18 加】这把尺子的已知偏向，必须和数字一起读
  limitation: [
    '每千文件命中率 = 能力散布在多少个文件里，**不是能力有多强**。',
    '分母越小，单个文件命中对结果影响越大：小库天然更容易被少数文件拉高或压低。',
    '本仓 249 个源文件命中 6 个（P8）；ECC 1055 个源文件命中 10 个 —— 抽样验证 ECC 的命中都是真的',
    '（含 "append-only, hash-linked NDJSON journal"），所以「落后」是真差距，但强度差被分母放大。',
    'P1 已于 2026-11-18 收紧规则（排除网页文案里的 pricing 区块名）—— 说明这把尺子本身会误判，需持续校。',
  ],
  probes: probes.map((p) => ({ id: p.id, name: p.name, strength: p.strength, why: p.why,
    validity: p.validity || 'ok', validityNote: p.validityNote || null })),
  available: available.length,
  total: results.length,
  negativeControl: neg,
  sensitivity: SENSITIVITY_NOTE,
  results: scored.map((r) => ({ id: r.id, name: r.name, files: r.files, filesRaw: r.filesRaw, forkCopies: r.forkCopies, hits: r.hits, fileHits: r.fileHits, samples: r.samples })),
};
// 四态结论（rate 在循环内定义，这里重建一份同样的口径）
const rateOf = (r, pid) => (r.files ? (r.fileHits[pid] || 0) / r.files * 1000 : 0);
let lead = 0, behind = 0;
const comparableForSum = others.filter((r) => r.files >= MIN_FILES);
for (const p of probes) {
  const oursR = rateOf(us, p.id);
  const best = comparableForSum.reduce((a, r) => Math.max(a, rateOf(r, p.id)), 0);
  if (oursR > best + 1e-9) lead++;
  else if (oursR < best - 1e-9) behind++;
}
const VERDICT = composeVerdict({ neg, available: available.length, lead, behind });
OUT.verdict = VERDICT;
OUT.lead = lead;
OUT.behind = behind;
console.log('');
console.log('  ' + '─'.repeat(76));
console.log('  四态结论: ' + VERDICT.state);
console.log('  ' + VERDICT.why);
  // 【2026-11-17 加】分母透明度 —— 验证方 v-h0133 硬伤 C：这两个数只在内存里，磁盘无记录
  if (us) {
    console.log('');
    console.log('  分母透明度（我们的）:');
    console.log('    own（四态用）:  ' + us.files + ' 个文件');
    console.log('    含副本 ' + (us.filesRaw || us.files) + ' · 排除 ' + (us.forkCopies || 0));
    // 归档层单独报数 —— 它是我们的，但不是当前产品能力。计不计入是判断，所以摆出来
    console.log('    已归档（不计入）: ' + (us.archivedFiles || 0) + ' 个'
      + '   ← 是我们的旧代码，不是当前能力；两种口径都能自圆其说，故单独列出');
    console.log('    ⚠ ' + SENSITIVITY_NOTE);
  }
console.log('');

const outPath = path.join(REPO, 'evidence/evolve/executable-compare.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(OUT, null, 2) + '\n', 'utf8');

console.log('');
console.log('  → ' + path.relative(REPO, outPath));
console.log('');
if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
process.exit(neg === 0 ? 0 : 1);