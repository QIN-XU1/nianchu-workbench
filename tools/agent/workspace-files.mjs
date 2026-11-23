/**
 * 工作区文件清单 + `@` 引用的内容装载（批次 W）
 *
 * 为什么单独一个文件：
 *   size-guard 有 32KB 红线，ws-host.mjs 已经贴着线（32758B），
 *   而「列文件」和「读文件内容」这两件事两边都要用（UI 面板 + 宿主装上下文），
 *   放公共模块比在两边各抄一份干净。
 *
 * 两条纪律：
 *   1. **只列真存在的文件**（不编造路径）；读不到就如实报，不返回空串当成功。
 *   2. 路径必须落在工作区内（`..` 出界一律拒绝），否则 `@` 面板就成了任意文件读取口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 扫描时跳过的目录名（依赖/产物/版本库） */
const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo',
  'vendor', '.pnpm-store', '__pycache__', '.venv', '.idea', '.vscode',
]);

/** 二进制/大文件扩展名：列得出但默认不读内容 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz',
  '.7z', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.mp4', '.mp3',
  '.wav', '.sqlite', '.db', '.wasm', '.node', '.pyc',
]);

const MAX_SCAN = 20000;

/**
 * 优先用 `git ls-files` 拿清单：它自带 `.gitignore` 语义，且比递归走盘快一个数量级
 * （本仓库 10956 个受管文件，走盘要扫 2 万+ 还带一堆 vendor 噪音）。
 * 不是 git 仓库 / 沙箱禁子进程 → 返回 null，调用方回退到走盘。
 */
function gitTrackedFiles(base) {
  try {
    const out = execFileSync(
      'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: base, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15000, windowsHide: true },
    );
    return out.split('\u0000').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * 递归列出工作区内的文件（相对路径，正斜杠）。
 *
 * @param {object} o
 * @param {string} o.root       工作区根（绝对路径）
 * @param {string} [o.query]    子串过滤（大小写不敏感，按路径匹配）
 * @param {number} [o.limit]    最多返回多少条
 * @param {number} [o.maxScan]  最多扫多少个文件（防止巨型仓库卡死）
 */
export function listWorkspaceFiles({ root, query = '', limit = 120, maxScan = MAX_SCAN } = {}) {
  const base = path.resolve(String(root || process.cwd()));
  if (!fs.existsSync(base)) return { state: 'FAIL', reason: '工作区不存在：' + base, files: [], total: 0 };
  const q = String(query || '').toLowerCase();

  const tracked = gitTrackedFiles(base);
  let all;
  let scanned;
  let truncated = false;

  if (tracked) {
    scanned = tracked.length;
    all = tracked.filter((rel) => !q || rel.toLowerCase().includes(q));
    if (all.length > maxScan) { all = all.slice(0, maxScan); truncated = true; }
  } else {
    // 回退：走盘（非 git 仓库 / 子进程被沙箱禁掉）
    all = [];
    scanned = 0;
    const walk = (dir) => {
      if (truncated) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // 没权限的目录直接跳过，不因它整次失败
      }
      for (const e of entries) {
        if (truncated) return;
        if (e.isDirectory()) {
          if (SKIP_DIR.has(e.name)) continue;
          walk(path.join(dir, e.name));
          continue;
        }
        if (!e.isFile()) continue;
        scanned += 1;
        if (scanned > maxScan) { truncated = true; return; }
        const abs = path.join(dir, e.name);
        const rel = path.relative(base, abs).replace(/\\/g, '/');
        if (q && !rel.toLowerCase().includes(q)) continue;
        all.push(rel);
      }
    };
    walk(base);
  }

  // 短路径优先（顶层文件比深层目录更容易被 @ 到），同长度按字典序
  all.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return {
    state: 'PASS',
    root: base,
    files: all.slice(0, Math.max(1, Number(limit) || 120)),
    total: all.length,
    scanned,
    source: tracked ? 'git' : 'walk',
    truncated,
  };
}

/**
 * 把 `@` 引用的文件读成上下文块。
 *
 * 返回 { blocks, missing, skipped, bytes }：
 *   blocks  —— 拼好的 `<file path="...">…</file>` 文本（可直接塞进 user 消息）
 *   missing —— 不存在的路径（如实列出来，让模型和用户都知道没读到）
 *   skipped —— 读到了但因为是二进制/超限被跳过的路径
 *
 * 预算：单文件 60KB、合计 240KB（超过就停，超出的文件记 skipped）。
 */
export function readContextFiles(paths, { root, maxEach = 60 * 1024, maxTotal = 240 * 1024 } = {}) {
  const base = path.resolve(String(root || process.cwd()));
  const list = Array.isArray(paths) ? paths.map((p) => String(p || '').trim()).filter(Boolean) : [];
  const blocks = [];
  const missing = [];
  const skipped = [];
  let bytes = 0;

  for (const rel of list.slice(0, 20)) {
    const abs = path.resolve(base, rel);
    // 出界（..\..\etc）一律拒绝：`@` 只能引用工作区内的文件
    if (abs !== base && !abs.startsWith(base + path.sep)) { skipped.push(rel + '（工作区外）'); continue; }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { missing.push(rel); continue; }
    if (BINARY_EXT.has(path.extname(abs).toLowerCase())) { skipped.push(rel + '（二进制）'); continue; }
    const size = fs.statSync(abs).size;
    if (size > maxEach) { skipped.push(rel + '（' + Math.round(size / 1024) + 'KB 超过单文件上限）'); continue; }
    if (bytes + size > maxTotal) { skipped.push(rel + '（超出总预算）'); continue; }
    const body = fs.readFileSync(abs, 'utf8');
    bytes += size;
    blocks.push('<file path="' + rel.replace(/"/g, '&quot;') + '">\n' + body.replace(/\r\n/g, '\n') + '\n</file>');
  }
  return { blocks, missing, skipped, bytes, text: blocks.join('\n\n') };
}
