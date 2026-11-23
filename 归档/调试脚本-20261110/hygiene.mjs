/**
 * 自检卫生（Test Hygiene）
 *
 * 问题：多个自检会把测试数据留在真实目录里，污染首屏与后续测试。
 * 本轮实测：collab/boards/ask 的自检残留导致首屏从 2 行变 4 行（U4 失败）。
 *
 * 解法：所有会写文件的模块，自检必须做到：
 *   ① 记录"要不要创建这个目录"（原本不存在 ⇒ 自检后删掉）
 *   ② 快照原有内容（原本存在 ⇒ 自检后还原）
 *   ③ 提供统一的 cleanup() 供各模块调用
 */

import {
  existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * 拍一个"目录快照"，返回一个 restore 函数。
 * 用于自检前后包裹。
 */
export function snapshotDir(dir) {
  const existed = existsSync(dir);
  let backup = null;

  if (existed) {
    backup = {};
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          if (statSync(p).isFile()) backup[f] = readFileSync(p, 'utf8');
        } catch { /* 子目录忽略 */ }
      }
    } catch { backup = {}; }
  }

  return {
    existed,
    restore() {
      try {
        if (!existed) {
          // 原本不存在 ⇒ 整个删掉
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          return;
        }
        // 原本存在 ⇒ 清空后还原备份
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          try { if (statSync(p).isFile()) rmSync(p, { force: true }); } catch { /* ignore */ }
        }
        for (const [f, content] of Object.entries(backup || {})) {
          writeFileSync(join(dir, f), content, 'utf8');
        }
      } catch { /* 还原失败不阻断 */ }
    },
  };
}

/**
 * 拍多个目录的快照，返回一个统一 restore。
 */
export function snapshotDirs(dirs) {
  const snaps = dirs.map(d => ({ dir: d, snap: snapshotDir(d) }));
  return {
    restore() { for (const s of snaps) s.snap.restore(); },
  };
}

/** CLI：清理所有自检残留（幂等，可随时跑） */
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/hygiene.mjs');
if (isDirect) {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
  const HERE = import.meta.dirname;

  const CLEAN_DIRS = ['boards', 'collab', 'would-do'];
  const CLEAN_PATTERNS = [
    { dir: 'scenes', re: /\.review$/, label: '自动归纳候选' },
  ];

  let cleaned = 0;
  for (const d of CLEAN_DIRS) {
    const p = join(HERE, d);
    if (existsSync(p)) {
      // boards 与 collab 是运行期数据，但自检可能留下测试痕
      // 只删明确的测试标记
      const removed = cleanTestFiles(p);
      if (removed > 0) { console.log(`${C.green}✓${C.reset} ${d}: 清理 ${removed} 个自检文件`); cleaned += removed; }
    }
  }

  // 场景下的 .review（自动归纳候选）
  const scenesDir = join(HERE, 'scenes');
  if (existsSync(scenesDir)) {
    for (const s of readdirSync(scenesDir)) {
      const rv = join(scenesDir, s, '.review');
      if (existsSync(rv)) {
        rmSync(rv, { recursive: true, force: true });
        console.log(`${C.green}✓${C.reset} scenes/${s}/.review 已清理`);
        cleaned++;
      }
    }
  }

  // would-do 里的 selftest 记录
  const wd = join(HERE, 'would-do');
  if (existsSync(wd)) {
    for (const f of readdirSync(wd)) {
      const p = join(wd, f);
      try {
        const c = readFileSync(p, 'utf8');
        if (c.includes('selftest') || c.includes('自检')) { rmSync(p, { force: true }); cleaned++; }
      } catch { /* ignore */ }
    }
  }

  // collab 里的 selftest 记录
  const collab = join(HERE, 'collab');
  if (existsSync(collab)) {
    for (const scene of readdirSync(collab)) {
      for (const kind of ['inbox', 'outbox']) {
        const dir = join(collab, scene, kind);
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          try {
            const c = readFileSync(p, 'utf8');
            if (c.includes('selftest') || c.includes('自检')) { rmSync(p, { force: true }); cleaned++; }
          } catch { /* ignore */ }
        }
      }
      // 空目录也清掉
      const inb = join(collab, scene, 'inbox');
      const outb = join(collab, scene, 'outbox');
      for (const d of [inb, outb]) {
        if (existsSync(d) && readdirSync(d).length === 0) rmSync(d, { recursive: true, force: true });
      }
      const sceneDir = join(collab, scene);
      if (existsSync(sceneDir) && readdirSync(sceneDir).length === 0) rmSync(sceneDir, { recursive: true, force: true });
    }
    if (existsSync(collab) && readdirSync(collab).length === 0) rmSync(collab, { recursive: true, force: true });
  }

  // boards 里的自检行
  const todoFile = join(HERE, 'boards', '待办板.md');
  if (existsSync(todoFile)) {
    const t = readFileSync(todoFile, 'utf8');
    const lines = t.split('\n').filter(l => !/自检/.test(l));
    if (lines.length !== t.split('\n').length) {
      writeFileSync(todoFile, lines.join('\n'), 'utf8');
      console.log(`${C.green}✓${C.reset} 待办板里的自检行已清理`);
      cleaned++;
    }
    // 剩下 0 条待办 ⇒ 删除板文件（保持干净）
    const remaining = lines.filter(l => /^\|/.test(l) && !l.includes('事项') && !l.includes('---')).length;
    if (remaining === 0) {
      rmSync(join(HERE, 'boards'), { recursive: true, force: true });
      console.log(`${C.green}✓${C.reset} 空板目录已清理`);
      cleaned++;
    }
  }

  console.log(`\n${cleaned === 0 ? '（没有需要清理的）' : `共清理 ${cleaned} 处`}`);
  process.exit(0);
}

function cleanTestFiles(dir) {
  let n = 0;
  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        const c = readFileSync(p, 'utf8');
        if (c.includes('selftest') || c.includes('自检')) { rmSync(p, { force: true }); n++; }
      } catch { /* ignore */ }
    }
  }
  walk(dir);
  return n;
}

export { cleanTestFiles };
