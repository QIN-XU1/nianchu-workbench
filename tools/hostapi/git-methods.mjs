#!/usr/bin/env node
/**
 * git 只读方法（第 104 轮）—— 不调 git 二进制，纯读 .git 目录；用真实 git 命令做 oracle 对拍。
 *
 * 【为什么】第 103 轮量化出：UI 直接 invoke 26 个 git_* 命令（无映射兜底），我们只有 git/isRepository。
 * 本轮补**只读最小集**：仓库信息 + 分支列表。写操作（commit/push/reset）**不做**——那是另一个量级。
 *
 * 读法：
 *   · `.git/HEAD` → "ref: refs/heads/<branch>"（或裸 sha = detached）
 *   · `.git/refs/heads/*` + `.git/packed-refs` → 分支与 sha
 * 支持 worktree：`.git` 是文件时，内容 "gitdir: <path>"，指向真实 gitdir（HEAD/refs 在那里）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 找到仓库根与 gitdir（处理 .git 为文件的情形） */
export function locate(start) {
  let cur = path.resolve(String(start || process.cwd()));
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(cur, '.git');
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return { root: cur, gitdir: dotGit };
      const txt = fs.readFileSync(dotGit, 'utf8').trim();
      const m = /^gitdir:\s*(.+)$/.exec(txt);
      if (m) {
        const gd = path.isAbsolute(m[1]) ? m[1] : path.resolve(cur, m[1]);
        return { root: cur, gitdir: gd };
      }
      return { root: cur, gitdir: null };
    } catch { /* 继续向上 */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { root: null, gitdir: null };
}

/** 读 HEAD：返回 { branch, sha, detached } */
export function readHead(gitdir) {
  if (!gitdir) return { branch: null, sha: null, detached: null };
  let head;
  try { head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim(); } catch { return { branch: null, sha: null, detached: null }; }
  const m = /^ref:\s*(.+)$/.exec(head);
  if (!m) return { branch: null, sha: head || null, detached: true };
  const ref = m[1].trim();
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  let sha = null;
  try { sha = fs.readFileSync(path.join(gitdir, ref), 'utf8').trim(); } catch {
    // 可能在 packed-refs 里
    try {
      const packed = fs.readFileSync(path.join(gitdir, 'packed-refs'), 'utf8');
      const line = packed.split(/\r?\n/).find((l) => l.endsWith(' ' + ref));
      if (line) sha = line.split(' ')[0];
    } catch { /* 无 */ }
  }
  return { branch, sha, detached: false };
}

/** 列分支：refs/heads/* + packed-refs 里的 refs/heads/* */
export function listBranches(gitdir) {
  if (!gitdir) return [];
  const out = new Map();
  const headsDir = path.join(gitdir, 'refs', 'heads');
  const walk = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const name = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, name);
      else if (e.isFile()) {
        try { out.set(name, fs.readFileSync(abs, 'utf8').trim()); } catch { /* 跳过 */ }
      }
    }
  };
  walk(headsDir, '');
  try {
    const packed = fs.readFileSync(path.join(gitdir, 'packed-refs'), 'utf8');
    for (const line of packed.split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, ref] = line.split(' ');
      if (ref && ref.startsWith('refs/heads/')) out.set(ref.slice('refs/heads/'.length), sha);
    }
  } catch { /* 无 packed-refs */ }
  return [...out.entries()].map(([name, sha]) => ({ name, sha })).sort((a, b) => a.name.localeCompare(b.name));
}

/** 组装 UI 需要的 repository basic 形状 */
export function repositoryBasic(start) {
  const { root, gitdir } = locate(start);
  if (!root || !gitdir) return { isRepository: false, path: path.resolve(String(start || process.cwd())), root: null, branch: null, head: null };
  const h = readHead(gitdir);
  return {
    isRepository: true,
    path: path.resolve(String(start || process.cwd())),
    root,
    gitdir,
    branch: h.branch,
    head: h.sha,
    detached: h.detached,
  };
}


// ── 第 107 轮：status / changed files（调 git 二进制，用真实输出为准）──
import { execFileSync } from 'node:child_process';

/**
 * 跑一次 git（失败不抛，返回 {ok, code, stdout, stderr}）。
 * 【为什么允许调 git】status 需要比较 index 与工作树，纯文件系统做不可靠；
 * git 本身就是仓库的权威工具，用它比自造解析更诚实。git 不存在时明确返回 supported:false。
 */
function runGit(args, cwd) {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, code: 0, stdout, stderr: '' };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, code: -1, stdout: '', stderr: 'git 未安装', supported: false };
    return { ok: false, code: (e && typeof e.status === 'number') ? e.status : -1, stdout: String(e && e.stdout || ''), stderr: String(e && e.stderr || '') };
  }
}

/** 解析 `git status --porcelain=v1` 输出 → [{path, status, origPath?}] */
export function parsePorcelain(out) {
  const files = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    let rest = line.slice(3);
    let origPath = null;
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) { origPath = rest.slice(0, arrow); rest = rest.slice(arrow + 4); }
    files.push({ path: rest, status: xy, origPath });
  }
  return files;
}

export function repositoryStatus(start) {
  const p = path.resolve(String(start || process.cwd()));
  const { root, gitdir } = locate(p);
  if (!root || !gitdir) return { supported: true, isRepository: false, path: p, root: null, clean: null, changedCount: 0, files: [] };
  const r = runGit(['-C', root, 'status', '--porcelain=v1'], root);
  if (r.supported === false) return { supported: false, isRepository: true, path: p, root, reason: 'git 未安装' };
  if (!r.ok) return { supported: true, isRepository: true, path: p, root, clean: null, changedCount: 0, files: [], error: (r.stderr || '').trim().slice(0, 200) };
  const files = parsePorcelain(r.stdout);
  return { supported: true, isRepository: true, path: p, root, clean: files.length === 0, changedCount: files.length, files };
}


// ── 第 108 轮：文件内容 / diff（只读，仍以 git 为权威）──
/**
 * 读文件内容。rev 为空 → 读工作树；给了 rev → `git show <rev>:<path>`（读历史版本）。
 * 安全：只允许读**仓库根之下**的相对路径，拒绝绝对路径与 `..` 穿越。
 */
export function fileContent(start, relPath, rev) {
  const p = path.resolve(String(start || process.cwd()));
  const { root } = locate(p);
  if (!root) return { ok: false, error: 'not_a_repository', path: p };
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel) return { ok: false, error: 'path_required' };
  if (path.isAbsolute(rel) || rel.split('/').includes('..')) return { ok: false, error: 'path_outside_repository', path: rel };
  if (rev) {
    const r = runGit(['-C', root, 'show', String(rev) + ':' + rel], root);
    if (!r.ok) return { ok: false, error: 'rev_read_failed', detail: (r.stderr || '').trim().slice(0, 200), path: rel, rev: String(rev) };
    return { ok: true, path: rel, rev: String(rev), content: r.stdout };
  }
  const abs = path.join(root, rel);
  try { return { ok: true, path: rel, content: fs.readFileSync(abs, 'utf8') }; }
  catch (e) { return { ok: false, error: 'read_failed', detail: String(e && e.message || e).slice(0, 160), path: rel }; }
}

/**
 * diff 文本。mode：'worktree'（默认，工作树 vs index）/ 'staged'（index vs HEAD）/ 'head'（工作树 vs HEAD）。
 */
export function diffText(start, relPath, mode = 'worktree') {
  const p = path.resolve(String(start || process.cwd()));
  const { root } = locate(p);
  if (!root) return { ok: false, error: 'not_a_repository', path: p };
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (rel && (path.isAbsolute(rel) || rel.split('/').includes('..'))) return { ok: false, error: 'path_outside_repository', path: rel };
  const base = mode === 'staged' ? ['diff', '--cached'] : mode === 'head' ? ['diff', 'HEAD'] : ['diff'];
  const args = ['-C', root, ...base];
  if (rel) args.push('--', rel);
  const r = runGit(args, root);
  if (!r.ok) return { ok: false, error: 'diff_failed', detail: (r.stderr || '').trim().slice(0, 200) };
  return { ok: true, mode, path: rel || null, patch: r.stdout, empty: r.stdout.trim().length === 0 };
}


// ── 第 114 轮：提交历史 / 版本解析（只读，仍以 git 为权威）──
/**
 * 提交历史。limit 默认 50，钳到 1..500。
 * 用 %x09（制表符）分隔，避免 subject 里出现空格/冒号时切错字段。
 */
export function commitLog(start, limit = 50) {
  const p = path.resolve(String(start || process.cwd()));
  const { root } = locate(p);
  if (!root) return { ok: false, error: 'not_a_repository', path: p };
  // 【第 114 轮修】原来写 `Number(limit) || 50`：limit=0 是假值 → 静默变成 50，
  // 把「显式传 0」和「没传」混为一谈。现在显式区分：
  //   未传（undefined/null/''）→ 默认 50
  //   传了但非法（0/负数）→ 钳到 1（而不是偷偷用默认值）
  //   传了但非数字 → 默认 50
  const provided = !(limit === undefined || limit === null || limit === '');
  const num = Number(limit);
  const n = !provided ? 50 : (Number.isFinite(num) ? Math.min(Math.max(num, 1), 500) : 50);
  const r = runGit(['-C', root, 'log', '-n', String(n), '--pretty=format:%H%x09%an%x09%aI%x09%s'], root);
  if (!r.ok) return { ok: false, error: 'log_failed', detail: (r.stderr || '').trim().slice(0, 200) };
  const commits = String(r.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split('\t');
    const sha = parts[0] || '';
    return { sha, short: sha.slice(0, 8), author: parts[1] || '', date: parts[2] || '', subject: parts[3] || '' };
  });
  return { ok: true, limit: n, count: commits.length, commits };
}

/** 把任意 revision（HEAD / 分支名 / 短 sha / tag）解析成完整 sha */
export function resolveRevision(start, rev) {
  const p = path.resolve(String(start || process.cwd()));
  const { root } = locate(p);
  if (!root) return { ok: false, error: 'not_a_repository', path: p };
  const want = String(rev || '').trim();
  if (!want) return { ok: false, error: 'rev_required' };
  const r = runGit(['-C', root, 'rev-parse', '--verify', want + '^{commit}'], root);
  if (!r.ok) return { ok: false, error: 'rev_unresolved', rev: want, detail: (r.stderr || '').trim().slice(0, 160) };
  return { ok: true, rev: want, sha: String(r.stdout || '').trim() };
}

const pickPath = (p) => (p && (p.path || p.repositoryPath || p.cwd || p.workspace)) || process.cwd();

export const gitReadMethods = {
  'git/isRepository': (p) => {
    const r = locate(pickPath(p));
    return { isRepository: !!r.gitdir, path: path.resolve(pickPath(p)), root: r.root, kind: r.gitdir ? 'dir' : null };
  },
  git_is_repository: (p) => gitReadMethods['git/isRepository'](p),
  git_get_repository_basic: (p) => repositoryBasic(pickPath(p)),
  git_get_repository: (p) => repositoryBasic(pickPath(p)),
  git_get_branches: (p) => {
    const { gitdir } = locate(pickPath(p));
    return { branches: listBranches(gitdir), current: readHead(gitdir).branch };
  },
  git_get_status: (p) => repositoryStatus(pickPath(p)),
  git_get_changed_files: (p) => {
    const r = repositoryStatus(pickPath(p));
    return { isRepository: r.isRepository, files: r.files, changedCount: r.changedCount };
  },
  git_get_tracked_change_count: (p) => {
    const r = repositoryStatus(pickPath(p));
    return { count: r.changedCount, isRepository: r.isRepository };
  },
  // 【第 108 轮修】不能用 pickPath(p) 取仓库路径后又把 p.path 当文件路径 —— 会冲突。
  // 这里显式区分：仓库路径看 repositoryPath/cwd/workspace/repo；文件路径看 path/file/relPath。
  git_get_file_content: (p) => fileContent(
    (p && (p.repositoryPath || p.cwd || p.workspace || p.repo)) || process.cwd(),
    p && (p.path || p.file || p.relPath),
    p && (p.rev || p.ref),
  ),
  git_get_commits: (p) => commitLog(
    (p && (p.repositoryPath || p.cwd || p.workspace || p.repo)) || process.cwd(),
    (p && (p.limit || p.maxCount)) || 50,
  ),
  git_resolve_revision: (p) => resolveRevision(
    (p && (p.repositoryPath || p.cwd || p.workspace || p.repo)) || process.cwd(),
    p && (p.rev || p.revision || p.ref),
  ),
  git_get_diff: (p) => diffText(
    (p && (p.repositoryPath || p.cwd || p.workspace || p.repo)) || process.cwd(),
    (p && (p.path || p.file || p.relPath)) || null,
    (p && p.mode) || 'worktree',
  ),
};
