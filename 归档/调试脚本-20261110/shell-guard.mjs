/**
 * 外壳哨兵（L0 Shell Sentinels）
 *
 * 照 luanyujia 的两条硬规矩：
 *   ① **根目录白名单制**：`<工作区>` 根不许丢文件；顶层新夹子先问机主
 *   ② **临时文件只放两处**：大体积/一次性 → `_临时/`；有点价值要复核 → 带时间的子目录
 *      ⛔ `%TEMP%` / C 盘不再接受
 *
 * 为什么需要"哨兵"而不是"写进文档"：
 *   规矩写在文档里，AI 会忘；落成检查器，违规就 exit 1 —— 这才叫自动。
 *
 * 本模块做两件事：
 *   audit()   —— 检查根目录与临时目录是否违规
 *   guard()   —— 在写入前判断"这个路径允许吗"
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname, isAbsolute, relative } from 'node:path';

const HERE = import.meta.dirname;
const PROJECT = join(HERE, '..');

/** 根目录白名单（顶层允许出现的目录/文件） */
const ROOT_WHITELIST = {
  dirs: [
    'prototype',      // 工具与场景
    'plugins',        // DSH 插件
    'research',       // 研究材料
    'verification',   // 验证记录
    'challenges',     // Agent 自写 check 实验场
    '方案',           // 方案文档
    'boards',         // 共享层四块板
    'collab',         // 协作信箱
    'would-do',       // observe 模式记录
    '_临时',          // 临时区
  ],
  files: [
    'README.md', '.gitignore', 'package.json', 'pnpm-lock.yaml',
  ],
  // 允许但不算违规的松散文件（配置文件类）
  looseFilesOk: [
    /^\.env/, /^\..*rc$/, /^tsconfig\.json$/, /^\.git/,
  ],
};

/** 临时目录规范：只允许出现在这些位置 */
const TEMP_DIRS = ['_临时', 'prototype/_临时', 'prototype/bridge/_临时'];

/** 明确的临时文件后缀（出现在非临时区 = 违规） */
const TEMP_SUFFIX = [
  /\.tmp$/i, /\.temp$/i, /\.bak$/i, /\.old$/i, /\.log$/i,
  /\.swp$/i, /~$/, /\.DS_Store$/i, /\.crdownload$/i,
];

/** 检查根目录 */
export function auditRoot(root = PROJECT) {
  const problems = [];
  let entries;
  try { entries = readdirSync(root); } catch { return { ok: false, problems: [`根目录不存在：${root}`] }; }

  for (const name of entries) {
    const p = join(root, name);
    let st;
    try { st = statSync(p); } catch { continue; }

    if (st.isDirectory()) {
      if (!ROOT_WHITELIST.dirs.includes(name)) {
        problems.push({ kind: 'UNKNOWN_DIR', path: name, detail: `顶层出现白名单外的目录「${name}」` });
      }
    } else {
      if (ROOT_WHITELIST.files.includes(name)) continue;
      if (ROOT_WHITELIST.looseFilesOk.some(re => re.test(name))) continue;
      if (TEMP_SUFFIX.some(re => re.test(name))) {
        problems.push({ kind: 'TEMP_IN_ROOT', path: name, detail: `根目录出现临时文件「${name}」，应放 _临时/` });
      } else {
        problems.push({ kind: 'LOOSE_FILE', path: name, detail: `根目录出现松散文件「${name}」（应归档到对应目录）` });
      }
    }
  }

  return { ok: problems.length === 0, root, checked: entries.length, problems };
}

/** 检查临时文件是否放对了地方 */
export function auditTemp(root = PROJECT) {
  const problems = [];

  function walk(dir, depth = 0) {
    if (depth > 3) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      const p = join(dir, e.name);
      const rel = relative(root, p).replace(/\\/g, '/');

      // 跳过 node_modules/.git 等
      if (/^(node_modules|\.git|\.cache|dist|build)/.test(rel)) continue;

      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }

      // 临时文件后缀出现在非临时区 ⇒ 违规
      if (TEMP_SUFFIX.some(re => re.test(e.name))) {
        const inTemp = TEMP_DIRS.some(t => rel.startsWith(t + '/') || rel.startsWith(t));
        if (!inTemp) {
          problems.push({ kind: 'TEMP_MISPLACED', path: rel, detail: `临时文件出现在非临时区` });
        }
      }
    }
  }

  walk(root);
  return { ok: problems.length === 0, problems };
}

/**
 * 写入前守卫：这个路径允许吗？
 * 返回 { ok, reason }
 */
export function guard(targetPath, { root = PROJECT } = {}) {
  const abs = isAbsolute(targetPath) ? targetPath : join(root, targetPath);
  const rel = relative(root, abs).replace(/\\/g, '/');

  // 拒绝 C 盘
  if (/^[A-Z]:\/?/i.test(targetPath) && !targetPath.startsWith(root.slice(0, 2)) && /^C:/i.test(targetPath)) {
    return { ok: false, reason: '⛔ C 盘不接受（照 luanyujia 规矩）' };
  }

  // 拒绝 %TEMP%
  if (/[\\/]AppData[\\/]Local[\\/]Temp/i.test(abs)) {
    return { ok: false, reason: '⛔ %TEMP% 不接受（照 luanyujia 规矩）' };
  }

  // 根目录直接放文件 ⇒ 拒绝（除非白名单）
  const parts = rel.split('/');
  if (parts.length === 1) {
    const name = parts[0];
    if (ROOT_WHITELIST.files.includes(name)) return { ok: true, reason: '白名单文件' };
    if (ROOT_WHITELIST.looseFilesOk.some(re => re.test(name))) return { ok: true, reason: '配置类文件' };
    return { ok: false, reason: `⛔ 根目录不许丢文件「${name}」—— 放对应目录或 _临时/` };
  }

  // 临时文件必须在临时区
  if (TEMP_SUFFIX.some(re => re.test(nameOf(rel)))) {
    const inTemp = TEMP_DIRS.some(t => rel.startsWith(t + '/'));
    if (!inTemp) return { ok: false, reason: `⛔ 临时文件应放 _临时/（当前 ${rel}）` };
  }

  return { ok: true, reason: '允许' };
}

function nameOf(rel) { const p = rel.split('/'); return p[p.length - 1]; }

/** 自动建一个"带时间的临时目录"（要复核的东西放这里） */
export function makeTempDir(label = 'work', { root = PROJECT, /** fs */ } = {}) {
  const { mkdirSync } = require('node:fs');   // 只在调用时才需要
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = join(root, '_临时', `${label}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------- CLI ----------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/shell-guard.mjs');
if (isDirect) {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
  const [, , cmd, ...args] = process.argv;

  if (cmd === 'audit' || !cmd) {
    console.log(`${C.bold}外壳哨兵${C.reset} · ${C.dim}根目录白名单 + 临时文件位置${C.reset}\n`);

    const r1 = auditRoot();
    console.log(`${C.bold}根目录${C.reset}（检查 ${r1.checked} 项）`);
    if (r1.ok) {
      console.log(`  ${C.green}✓${C.reset} 全部在白名单内`);
    } else {
      for (const p of r1.problems) console.log(`  ${C.red}✗${C.reset} [${p.kind}] ${p.detail}`);
    }

    const r2 = auditTemp();
    console.log(`\n${C.bold}临时文件${C.reset}`);
    if (r2.ok) {
      console.log(`  ${C.green}✓${C.reset} 没有放错位置`);
    } else {
      for (const p of r2.problems.slice(0, 10)) console.log(`  ${C.red}✗${C.reset} [${p.kind}] ${p.detail}`);
    }

    const ok = r1.ok && r2.ok;
    console.log(`\n===== 外壳哨兵：${ok ? C.green + '通过' : C.red + '违规'}${C.reset} =====`);
    process.exit(ok ? 0 : 1);
  }

  if (cmd === 'guard') {
    const target = args.join(' ');
    if (!target) { console.log('用法：node shell-guard.mjs guard <路径>'); process.exit(2); }
    const r = guard(target);
    console.log(`${r.ok ? C.green + '✓ 允许' : C.red + '✗ 拒绝'}${C.reset}  ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'selftest') {
    console.log(`${C.bold}外壳哨兵自检${C.reset}\n`);
    let pass = 0, total = 0;
    const chk = (name, ok, detail) => { total++; if (ok) pass++; console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name.padEnd(30)} ${detail}`); };

    // 守卫判据
    chk('根目录放文件被拒', !guard('random.txt').ok, guard('random.txt').reason);
    chk('白名单文件允许', guard('README.md').ok, guard('README.md').reason);
    chk('临时区允许临时文件', guard('_临时/a.tmp').ok, guard('_临时/a.tmp').reason);
    chk('非临时区临时文件被拒', !guard('prototype/a.tmp').ok, guard('prototype/a.tmp').reason);
    chk('C 盘被拒', !guard('C:/Windows/x.txt').ok, guard('C:/Windows/x.txt').reason);
    chk('%TEMP% 被拒', !guard('C:/Users/x/AppData/Local/Temp/a.txt').ok, guard('C:/Users/x/AppData/Local/Temp/a.txt').reason);
    chk('正常子目录允许', guard('prototype/sea.mjs').ok, guard('prototype/sea.mjs').reason);

    // 真实根目录审计（应当通过）
    const r1 = auditRoot();
    chk('真实根目录合规', r1.ok, r1.ok ? `${r1.checked} 项全在白名单` : `${r1.problems.length} 处违规`);

    console.log(`\n===== 外壳哨兵自检：${pass}/${total} =====`);
    process.exit(pass === total ? 0 : 1);
  }

  console.log('用法：');
  console.log('  node shell-guard.mjs audit       审计根目录与临时文件');
  console.log('  node shell-guard.mjs guard <路径> 判断路径是否允许');
  console.log('  node shell-guard.mjs selftest    自检');
  process.exit(2);
}
