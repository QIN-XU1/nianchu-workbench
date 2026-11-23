#!/usr/bin/env node
/**
 * 语法守卫 —— 全量检查我们的脚本有没有语法错误或已知损坏词
 *
 * ── 为什么需要它 ────────────────────────────────────────────
 * 2026-11-15 实测：三个脚本被一次全局 `t`→`o` 替换损坏
 *   import → imporo   const → conso   path → paoh
 *   dist   → diso     .html → .homl   OpenBitFun → OpenBioFun
 *
 * 症状是 **静默的**：
 *   · `verify-ui-layer.mjs` 坏了 → R8 报「界面层判不了」，而不是报「脚本坏了」
 *   · `measure-density.mjs` 坏了 → D2 报失败
 *   · 谁都没说「你的脚本有语法错误」
 *
 * 直到改名后重跑才发现。**这就是「没有会失败的检查」的代价** ——
 * 语法错误应该被一条专门的检查抓住，而不是靠别的检查出怪结果来间接暴露。
 *
 * ── 判据 ──────────────────────────────────────────────────
 *   1. 每个 .mjs/.js 能过 `node --check`（语法有效）
 *   2. 不出现已知损坏词（imporo/conso/paoh/diso/oools/homl/BioFun）
 *
 * 四态：
 *   PASS     全部通过
 *   FAIL     有语法错误或损坏词
 *   UNKNOWN  扫不到文件（目录不存在）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

/** 已知损坏词 —— 来自 2026-11-15 的 t→o 事故 */
const BAD_WORDS = /\b(imporo|conso|paoh|diso|oools|homl|BioFun)\b/;

/**
 * 显式豁免标记
 *
 * 为什么需要：有的文件**合法地**提到这些词 —— 比如修复脚本自己要在正则里列出它们。
 * 第一版没处理这个，实测立刻产生 1 个假阳性（tools/quality/repair-t-o.mjs）。
 *
 * 设计：豁免必须**显式且可见** —— 文件里写一行标记，守卫统计并打印豁免数，
 * 不静默跳过。这样「豁免」本身是可审计的。
 */
const ALLOW_MARKER = 'syntax-guard:allow-bad-words';

/** 扫描根（我们的代码，不含 fork 进来的上游与产物） */
const ROOTS = ['tools', 'prototype'];

const SKIP = /node_modules|[\\/]\.git[\\/]|[\\/]dist[\\/]|evidence[\\/]|_fault_/;

let pass = 0, fail = 0;
const problems = [];

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

/** 对单个文件做两项检查 */
function checkFile(file) {
  const issues = [];

  // 1) 语法（永远检查，不可豁免）
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').find((l) => /SyntaxError|Error:/.test(l)) || '语法错误';
    issues.push('语法: ' + msg.trim().slice(0, 90));
  }

  // 2) 损坏词（可被显式标记豁免）
  let t;
  try { t = fs.readFileSync(file, 'utf8'); } catch { return { issues, exempt: false }; }
  const exempt = t.includes(ALLOW_MARKER);
  if (!exempt) {
    const m = t.match(BAD_WORDS);
    if (m) issues.push('损坏词: ' + m[0]);
  }
  return { issues, exempt };
}

/** 递归收集 */
function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) { walk(p, out); continue; }
    if (!/\.(mjs|js)$/.test(e.name)) continue;
    // 守卫脚本自己含这些词（在正则里）
    if (path.resolve(p) === path.resolve(import.meta.filename)) continue;
    out.push(p);
  }
  return out;
}

// ── 主流程 ──
export function run() {
  pass = 0; fail = 0; problems.length = 0;
  let exemptCount = 0;

  const files = [];
  for (const r of ROOTS) walk(path.join(REPO, r), files);

  if (!files.length) {
    return { state: 'UNKNOWN', why: '扫不到文件（' + ROOTS.join('/') + ' 不存在？）', pass, fail };
  }

  for (const f of files) {
    const { issues, exempt } = checkFile(f);
    if (exempt) exemptCount++;
    if (issues.length) {
      fail++;
      problems.push({ file: path.relative(REPO, f).replace(/\\/g, '/'), issues });
    } else {
      pass++;
    }
  }

  return {
    state: fail ? 'FAIL' : 'PASS',
    why: fail
      ? fail + ' 个文件有问题（语法或损坏词）'
      : '全部 ' + pass + ' 个脚本语法有效且无损坏词'
        + (exemptCount ? '（' + exemptCount + ' 个显式豁免损坏词检查）' : ''),
    pass, fail, problems, scanned: files.length, exempt: exemptCount,
  };
}

// ── 自检（含应当失败的反例）──
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const clean = path.join(REPO, 'tools/evolve/_selftest_clean.mjs');
  const dirty = path.join(REPO, 'tools/evolve/_selftest_dirty.mjs');
  const broken = path.join(REPO, 'tools/evolve/_selftest_broken.mjs');

  const restore = [];
  const put = (p, c) => {
    const had = fs.existsSync(p);
    const old = had ? fs.readFileSync(p) : null;
    fs.writeFileSync(p, c, 'utf8');
    restore.push(() => { if (had) fs.writeFileSync(p, old); else if (fs.existsSync(p)) fs.unlinkSync(p); });
  };

  try {
    // 正例：干净文件不该报
    put(clean, 'import fs from "node:fs";\nconst x = 1;\nconsole.log(x);\n');
    T('干净脚本 → 无问题', checkFile(clean).issues.length === 0, JSON.stringify(checkFile(clean).issues));

    // 反例 1：语法错误必须报（且不可被豁免标记绕过）
    put(broken, 'const x = ;\n');
    T('语法错误 → 报', checkFile(broken).issues.length > 0, JSON.stringify(checkFile(broken).issues));
    put(broken, 'const x = ;\n// ' + ALLOW_MARKER + '\n');
    T('语法错误即使有豁免标记 → 仍报', checkFile(broken).issues.length > 0, JSON.stringify(checkFile(broken).issues));

    // 反例 2：损坏词必须报
    put(dirty, 'imporo fs from "node:fs";\n');
    T('损坏词 imporo → 报', checkFile(dirty).issues.some((s) => /损坏词/.test(s)), JSON.stringify(checkFile(dirty).issues));

    // 正例 2：显式豁免标记 → 损坏词不报，且 exempt 为真
    put(dirty, '// ' + ALLOW_MARKER + '\n// probe imporo\nconst a = 1;\n');
    T('显式豁免标记 → 损坏词不报且标记为 exempt',
      checkFile(dirty).issues.length === 0 && checkFile(dirty).exempt === true,
      JSON.stringify(checkFile(dirty)));

    // 反例 3：每个已知损坏词都能被识别
    for (const w of ['conso', 'paoh', 'diso', 'oools', 'homl', 'BioFun']) {
      const f = path.join(REPO, 'tools/evolve/_selftest_w.mjs');
      put(f, '// probe ' + w + '\nconst a = 1;\n');
      T('损坏词 ' + w + ' → 报', checkFile(f).issues.some((s) => /损坏词/.test(s)), String(checkFile(f).issues));
    }
  } finally {
    for (const r of restore.reverse()) r();
  }

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length,
    total: cases.length,
    ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

// ── CLI ──
if (isMain) {
  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  语法守卫 · 自检（1 正例 + 8 反例）');
    console.log('  ' + '─'.repeat(70));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const r = run();
  const ICON = { PASS: '✅', FAIL: '❌', UNKNOWN: '❔' };
  console.log('');
  console.log('  ' + ICON[r.state] + ' 语法守卫 · ' + r.why);
  console.log('  扫 ' + (r.scanned || 0) + ' 个脚本 · 通过 ' + r.pass + ' · 有问题 ' + r.fail);
  for (const p of (r.problems || []).slice(0, 12)) {
    console.log('    ✗ ' + p.file);
    for (const i of p.issues) console.log('        ' + i);
  }
  console.log('');
  process.exit(r.state === 'PASS' ? 0 : r.state === 'UNKNOWN' ? 2 : 1);
}
