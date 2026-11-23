#!/usr/bin/env node
/**
 * 参照项目重下 + 拆解（可复算）
 *
 * ══ 为什么要做成工具 ═════════════════════════════════════════
 * 目标要求「逐一重下并拆解 29 个参照项目」且「每轮都要有可复算的证据」。
 * 如果每次靠手工翻仓库，结论就不可复算 —— 换个时间、换个人，结果不一样。
 * 所以这里把「重下 → 度量 → 落证据」固化成一条命令：
 *
 *   node tools/evolve/refresh-references.mjs --id openclaw
 *   node tools/evolve/refresh-references.mjs --all --skip-clone
 *
 * 产出：evidence/references/<id>.json（每项都带可复算字段）
 *
 * ══ 为什么不直接用原来的 zip 目录 ═════════════════════════════
 * D:/refs 下多数是 zip 解压，**没有 .git**，拿不到 HEAD / 提交日期 / 文件数是否被 gitignore 影响。
 * 没有 HEAD 就无法说「这是哪个版本」，结论就不可复算。所以能 clone 的一律 clone 到
 * `D:/refs/<id>.git`，保留独立目录不覆盖原来的解压版（避免破坏已有工作）。
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 只能 clone 公开仓库；纯 SaaS（chatgpt/cursor/trae/qoder/codebuddy/workbuddy）无源码，
 *   一律标 `noSource`，**不推测实现**。
 * · 克隆失败（网络/私有/改名）如实记 cloneError，不假装成功。
 * · 度量是**结构与规模**，不是能力判断；能力判断仍在矩阵里靠人读代码给证据。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const REFS = 'D:/refs';
const OUT = join(ROOT, 'evidence', 'references');

const args = process.argv.slice(2);
const argVal = (name, dflt = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes('--' + name);

/**
 * git 直连（绕开本机失效的 proxy 与 gh-proxy insteadOf）。
 * 2026-11-18 实测：全局 http.proxy=127.0.0.1:7897 与 ghost 代理都已失效，
 * 不绕开就一律 "Failed to connect to gh-proxy.com"。
 */
function gitDirect(gitArgs, cwd) {
  return execFileSync('git', [
    '-c', 'http.proxy=',
    '-c', 'https.proxy=',
    '-c', 'url.https://github.com/.insteadOf=',
    ...gitArgs,
  ], { cwd, encoding: 'utf8', timeout: 20 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024 });
}

/** 读 benchmark projects.json 拿到 id → 源地址 */
function loadProjects() {
  const p = join(ROOT, 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/projects.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(j.projects) ? j.projects : [];
}

/** 目录度量：按扩展名统计文件数与字节数，另记最大的单文件 */
export function measure(dir) {
  const byExt = {};
  let files = 0;
  let bytes = 0;
  let largest = { path: '', bytes: 0 };
  const skip = /(^|[\\/])(\.git|node_modules|dist|build|\.next|target|vendor)([\\/]|$)/;

  function walk(d, depth) {
    if (depth > 14) return;
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const full = join(d, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (skip.test(full)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      files++;
      bytes += st.size;
      const e = extname(name).toLowerCase() || '(none)';
      const b = byExt[e] || (byExt[e] = { n: 0, bytes: 0 });
      b.n++;
      b.bytes += st.size;
      if (st.size > largest.bytes) largest = { path: relative(dir, full).split(sep).join('/'), bytes: st.size };
    }
  }
  walk(dir, 0);

  const topExt = Object.entries(byExt)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 12)
    .map(([ext, v]) => ({ ext, files: v.n, kb: Math.round(v.bytes / 1024) }));

  return {
    files,
    mb: Math.round((bytes / 1024 / 1024) * 10) / 10,
    topExt,
    largestFile: { path: largest.path, kb: Math.round(largest.bytes / 1024) },
  };
}

/** 探结构：这些目录/文件名存在与否，作为「架构维度」的客观信号 */
const STRUCTURE_PROBES = {
  monorepo: ['packages', 'apps', 'pnpm-workspace.yaml', 'lerna.json', 'turbo.json'],
  plugin: ['plugins', 'extensions', 'addons', 'packages/plugin', 'plugin'],
  agentLoop: ['agent', 'loop', 'runtime', 'packages/agent-loop', 'src/agent'],
  subagent: ['subagent', 'subagents', 'packages/subagent', 'multi-agent', 'agents'],
  memory: ['memory', 'packages/memory', 'context', 'packages/context', 'compaction'],
  mcp: ['mcp', 'packages/mcp', 'mcp-servers'],
  skills: ['skills', 'tools/skills', 'packages/skills'],
  telemetry: ['telemetry', 'packages/telemetry', 'otel', 'tracing'],
  guard: ['guard', 'packages/guard', 'policy', 'approval', 'permissions'],
  ui: ['ui', 'web', 'renderer', 'src/components', 'apps/web', 'src/web-ui'],
  docs: ['docs', 'website', 'documentation'],
  tests: ['tests', 'test', '__tests__', 'spec'],
  ci: ['.github/workflows', '.gitlab-ci.yml', 'azure-pipelines.yml'],
};

function probeStructure(dir) {
  const out = {};
  for (const [key, cands] of Object.entries(STRUCTURE_PROBES)) {
    out[key] = cands.filter((c) => existsSync(join(dir, c)));
  }
  return out;
}

function gitInfo(dir) {
  if (!existsSync(join(dir, '.git'))) return { isGit: false };
  try {
    const head = gitDirect(['log', '-1', '--format=%H%n%ci%n%s'], dir).trim().split('\n');
    const branch = gitDirect(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim();
    const count = gitDirect(['rev-list', '--count', 'HEAD'], dir).trim();
    return {
      isGit: true,
      head: head[0],
      committedAt: head[1],
      subject: head[2],
      branch,
      commits: Number(count) || null,
    };
  } catch (e) {
    return { isGit: true, error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

/**
 * 把「已 clone 但未检出」的目录补检出。
 *
 * 事故背景（2026-11-19）：`--filter=blob:none --depth 1` 的 clone 中断后，
 * `D:/refs/omp-studio.git` 里只有 .git 元数据、**工作区一个文件都没有**，
 * 但脚本按「目录存在」判 PASS，measure() 又把路径里的 `.git/` 当跳过项 → 报 0 文件 PASS。
 * 这是典型的「假 PASS」—— 于是这里先 `git reset --hard` 把 blob 拉下来再量。
 */
function materialize(dir) {
  if (!existsSync(join(dir, '.git'))) return { materialized: false, reason: '不是 git 仓库' };
  try {
    /**
     * 不跑 `git status --porcelain`：未检出的仓库里每个文件都是 D 行，
     * 3 万文件的仓库直接 ENOBUFS（实测 hermes 就是这么挂的）。
     * 改用最省的判定：工作区（除 .git 外）是否几乎为空 → 直接 reset --hard 拉 blob。
     */
    let onDisk = 0;
    try { onDisk = readdirSync(dir).filter((n) => n !== '.git').length; } catch { onDisk = 0; }
    if (onDisk <= 1) {
      gitDirect(['reset', '--hard', 'HEAD'], dir);
      const after = readdirSync(dir).filter((n) => n !== '.git').length;
      return { materialized: true, onDiskBefore: onDisk, onDiskAfter: after };
    }
    return { materialized: false, onDisk };
  } catch (e) {
    return { materialized: false, error: String((e && (e.stderr || e.message)) || e).slice(0, 200) };
  }
}

/** 重下（或复用）一个项目 */
function refresh(project, { skipClone }) {
  const id = project.id;
  const url = project.repo || project.url || '';
  const isGithub = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url);
  const target = join(REFS, id + '.git');

  const rec = {
    id,
    name: project.name || id,
    url,
    target,
    at: new Date().toISOString(),
  };

  if (!isGithub) {
    rec.state = 'noSource';
    rec.reason = url ? ('不是 GitHub 仓库（' + url + '），拿不到源码') : '没有源码地址（纯 SaaS / 闭源）';
    return rec;
  }

  if (!skipClone && !existsSync(target)) {
    try {
      mkdirSync(target, { recursive: true });
      gitDirect([
        'clone', '--depth', '1', '--single-branch', '--filter=blob:none', url, '.',
      ], target);
    } catch (e) {
      rec.cloneError = String((e && (e.stderr || e.message)) || e).slice(0, 400);
    }
  }

  /**
   * 回退：`<id>.git` 不存在时，用 matrix 里登记过的本地解压目录（D:/refs 下多数是 zip 解压）。
   * 但**必须标明它不是 git** —— 拿不到 HEAD 的结论只能算"某次快照"，不可复算到具体提交。
   * 不能因为"目录里有文件"就当重下成功。
   */
  let usedDir = null;
  let mat = null;
  if (existsSync(target)) {
    // 先补检出，再判断它到底有没有工作区文件
    mat = materialize(target);
    rec.materialize = mat;
    let n = 0;
    try { n = readdirSync(target).filter((x) => x !== '.git').length; } catch { n = 0; }
    if (n > 0) {
      usedDir = target;
    } else {
      rec.note = '克隆目录只有 .git 元数据、工作区为空（materialize=' + JSON.stringify(mat) + '），改用本地解压目录';
    }
  }
  if (!usedDir) {
    const fallbackName = FALLBACK_DIRS[id];
    if (fallbackName && existsSync(join(REFS, fallbackName))) {
      usedDir = join(REFS, fallbackName);
      rec.fallbackDir = usedDir;
      rec.note = (rec.note ? rec.note + '；' : '') + '用的是本地解压目录（非 git），拿不到 HEAD —— 结论只能算快照，不能复算到提交';
    }
  }

  if (!existsSync(usedDir)) {
    rec.state = 'FAIL';
    rec.reason = rec.cloneError ? ('克隆失败：' + rec.cloneError.slice(0, 160)) : '目录不存在';
    return rec;
  }

  rec.dir = usedDir;
  rec.git = gitInfo(usedDir);
  rec.measure = measure(usedDir);
  rec.structure = probeStructure(usedDir);

  if (!rec.git.isGit) {
    // 有源码可读 → 能拆解；但没有 HEAD → 不可复算到提交，标 WARN 而不是假装 PASS
    rec.state = 'WARN';
    rec.reason = '目录存在但不是 git 仓库：可拆解，但拿不到 HEAD，结论不可复算到具体提交';
  } else if (rec.git.error) {
    rec.state = 'UNKNOWN';
    rec.reason = 'git 元信息读取失败：' + rec.git.error;
  } else if (rec.cloneError) {
    rec.state = 'WARN';
    rec.reason = '本次克隆失败，复用了已有目录';
  } else {
    rec.state = 'PASS';
  }
  return rec;
}

/** id → D:/refs 下的本地解压目录名（没有 .git 的那些） */
const FALLBACK_DIRS = {
  openbitfun: 'openbitfun-src',
  dsh: 'deepseek-harness',
  openclaw: 'openclaw',
  ecc: 'ECC',
  hermes: 'hermes-agent',
  'open-design': 'open-design',
  'omp-studio': 'omp-studio',
  orca: 'orca',
  pi: 'pi-main',
  luanyujia: 'luanyujia-fresh',
  'craft-anything': 'craft-anything',
  'solo-to-team-skills': 'solo-to-team-skills',
  cl4r1t4s: 'CL4R1T4S',
  aionui: 'aionui',
  weknora: 'WeKnora',
};

/** 主流程 */
const projects = loadProjects();
const only = argVal('id');
const all = has('all');
if (!only && !all) {
  console.log('');
  console.log('  用法：node tools/evolve/refresh-references.mjs --all [--skip-clone]');
  console.log('        node tools/evolve/refresh-references.mjs --id openclaw [--skip-clone]');
  console.log('');
  console.log('  可用 id：' + projects.map((p) => p.id).join(' · '));
  console.log('');
  process.exitCode = 2;
} else {
  mkdirSync(OUT, { recursive: true });
  const list = all ? projects : projects.filter((p) => p.id === only);
  if (list.length === 0) {
    console.log('  找不到 id：' + only);
    process.exitCode = 2;
  } else {
    console.log('');
    console.log('  参照项目重下 / 拆解度量 · ' + list.length + ' 个');
    console.log('  ' + '─'.repeat(72));
    const results = [];
    for (const p of list) {
      process.stdout.write('  ' + String(p.id).padEnd(22));
      const rec = refresh(p, { skipClone: has('skip-clone') });
      results.push(rec);
      const m = rec.measure;
      const g = rec.git || {};
      console.log(String(rec.state).padEnd(9)
        + (m ? (String(m.files).padStart(6) + ' 文件 ' + String(m.mb).padStart(7) + 'MB') : ' '.repeat(20))
        + '  ' + String(g.head || '').slice(0, 8).padEnd(9)
        + (g.committedAt ? String(g.committedAt).slice(0, 10) : ''));
      writeFileSync(join(OUT, p.id + '.json'), JSON.stringify(rec, null, 2) + '\n', 'utf8');
      // clone 失败时别把空目录留在磁盘上，否则下次会误以为已下载
      if (rec.state === 'FAIL' && rec.cloneError) {
        try { execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', rec.target], { timeout: 60000 }); } catch { /* ignore */ }
      }
    }
    const sum = { at: new Date().toISOString(), total: results.length, rows: results };
    writeFileSync(join(OUT, '_summary.json'), JSON.stringify(sum, null, 2) + '\n', 'utf8');

    const by = {};
    for (const r of results) by[r.state] = (by[r.state] || 0) + 1;
    console.log('');
    console.log('  状态：' + Object.entries(by).map(([k, v]) => k + ' ' + v).join(' · '));
    const noSrc = results.filter((r) => r.state === 'noSource');
    if (noSrc.length) console.log('  无源码（不推测实现）：' + noSrc.map((r) => r.id).join(' · '));
    console.log('  ✓ 写出 evidence/references/（每项一份 JSON，含 HEAD / 规模 / 结构探针）');
    console.log('');
    process.exitCode = results.some((r) => r.state === 'FAIL') ? 1 : 0;
  }
}