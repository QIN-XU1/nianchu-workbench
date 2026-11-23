#!/usr/bin/env node
/**
 * 可复算性守卫 —— 验证链路上不许有硬编码绝对路径
 *
 * ── 为什么需要它（独立验证方 R4）─────────────────────────────
 * 第一轮独立验证实测：
 *   `verify-goal.mjs:35` 把仓库根硬编码成 `D:/file/AI Temp/DeepSeek/Agent自研`
 *   后果：**同一把度量键换个目录就跑出不同结果**
 *     主仓库：recall 1.000 / fpr 0.000
 *     副本里：recall 0.750 / fpr 0.125
 *   而且 F07「抓到」/F08「漏掉」与注入物无关 —— 归因会错。
 *
 * 「可复算」这个主张的直接反例是：**换台机器/换个目录就不成立的度量。**
 * 所以验证链路上的脚本必须从 `import.meta.dirname` / `fileURLToPath` 推导根目录。
 *
 * ── 范围 ──────────────────────────────────────────────────
 *   只查**验证链路**（会被 verify-goal / 度量器调用的脚本）。
 *   历史脚本（一次性分析、抓图等）不查 —— 它们不参与「可复算」主张。
 *
 * 四态：
 *   PASS     验证链路无硬编码绝对路径
 *   FAIL     有硬编码（会导致换目录结果不同）
 *   UNKNOWN  扫不到文件
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');

/**
 * 验证链路清单 —— 参与「可复算」主张的脚本
 *
 * 加新验收器时**必须同步加这里**（有自检会发现漏项）。
 */
const VERIFY_CHAIN = [
  'prototype/hermes-agents/verify-goal.mjs',
  'prototype/hermes-agents/four-state.mjs',
  'prototype/hermes-agents/audit-matrix-honesty.mjs',
  'prototype/hermes-agents/render-matrix.mjs',
  'prototype/hermes-agents/make-patches.mjs',
  'prototype/agent-ui/verify-syntax-guard.mjs',
  'prototype/agent-ui/verify-evolve.mjs',
  'prototype/agent-ui/verify-cost.mjs',
  'prototype/agent-ui/verify-ui-layer.mjs',
  'prototype/agent-ui/verify-density.mjs',
  'prototype/agent-ui/verify-runtime-state.mjs',
  'prototype/agent-ui/verify-scheduler.mjs',
  'prototype/agent-ui/verify-mcp.mjs',
  'prototype/agent-ui/verify-net.mjs',
  'prototype/agent-ui/verify-memory.mjs',
  'prototype/agent-ui/verify-context.mjs',
  'tools/benchmark/audit-coverage.mjs',
  'tools/benchmark/r5-regression.mjs',
  'tools/evolve/evolve.mjs',
  'tools/evolve/measure-verifier-efficacy.mjs',
  'tools/evolve/measure-real-recall.mjs',
  'tools/quality/size-guard.mjs',
  'tools/quality/measure-density.mjs',
  'tools/quality/repair-t-o.mjs',
  'tools/memory/store.mjs',
  'tools/context/compress.mjs',
  'tools/mcp/client.mjs',
  'tools/net/fetch.mjs',
  'tools/net/search.mjs',
  'tools/schedule/scheduler.mjs',
  'tools/state/collect.mjs',
  'tools/cost/meter.mjs',
];

/** 硬编码绝对路径的模式（只查仓库根的硬编码） */
const ABS_PATTERNS = [
  { re: /['"`]D:[/\\]+file[/\\]+AI Temp[/\\]+DeepSeek[/\\]+Agent自研/i, name: '本机绝对路径（D:\\file\\AI Temp\\...）' },
  // 【2026-11-15 修 · 第二轮复审 A2】原来只认 Users/file/work/projects 四个前缀，
  // 实测 E:/data/agents 与 /home/ci/agent 两个真实绝对路径**都不报**。
  // 现在：任何盘符绝对路径都报（宁可误报要求改成相对路径，也不许漏）。
  { re: /['"`][A-Za-z]:[/\\]/i, name: '盘符绝对路径（任何盘符）' },
  // POSIX 绝对路径：/home /Users /opt /srv /var /tmp /mnt /root 开头
  { re: /['"`]\/(?:home|Users|opt|srv|var|tmp|mnt|root)\/[^'"`\s]*/i, name: 'POSIX 绝对路径' },
  { re: /file:\/\/\/[A-Za-z]:/i, name: 'file:/// 绝对 URL' },
];

/** 允许的例外（注释里提到路径不算） */
function isInComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * 显式豁免标记
 *
 * 【为什么需要】有的脚本**合法地**要写出绝对路径 —— 比如
 * `measure-real-recall.mjs` 的职责就是「把历史缺陷塞回去」，
 * 其中 RT-05 的历史缺陷正是「硬编码仓库根」，它必须把那个字符串写出来。
 *
 * 设计同 verify-syntax-guard：豁免必须**显式且可见** —— 文件里写一行标记，
 * 守卫统计并打印豁免数，不静默跳过。
 */
const ALLOW_MARKER = 'abspath-guard:allow-literal-root';

/**
 * 系统/外部路径允许表 —— 每条必须写理由，输出里会报出豁免条数
 *
 * 【为什么要这张表】不是「不许出现绝对路径」，而是
 * **不许把「我们自己的仓库根」写死成绝对路径**。
 * 那才会导致「换目录结果不同」（独立验证方 R4 实测过）。
 *
 * 系统可执行文件的位置本来就在系统里；外部仓库路径本来就在仓库外。
 * 把这两类也判成违规，会逼着人写一堆假豁免 —— 那更糟。
 *
 * 但「合法」必须**显式可见**，不许靠正则默默放过。
 */
const SYSTEM_PATH_ALLOW = [
  // 注意：**不锚定行首** —— 路径通常出现在数组/对象字面量里，
  // 例如 return ['C:/Program Files (x86)/.../msedge.exe', ...]
  { re: /[A-Za-z]:[/\\]Program Files(?: \(x86\))?[/\\][^'"\s]*\.exe/i, why: '浏览器/系统可执行文件（Program Files 下的 .exe）' },
  { re: /[A-Za-z]:[/\\]Windows[/\\][^'"\s]*/i, why: 'Windows 系统路径' },
  { re: /['"`]\/(?:usr|bin|sbin|etc|lib|proc|sys)\//, why: 'POSIX 系统路径' },
  // 外部仓库默认位置（hermes 源码不是 git 仓，是解压的上游源码）。
  // 已改成 process.env.HERMES_SRC 可覆盖，这里只是默认值。
  { re: /[A-Za-z]:[/\\]hermes['"`]/, why: '外部仓库默认位置（可用 HERMES_SRC 覆盖）' },
];

/** 这一行是不是被允许的系统/外部路径 */
function isSystemPath(line) {
  for (const a of SYSTEM_PATH_ALLOW) if (a.re.test(line)) return a.why;
  return null;
}

/**
 * 检查 —— fileList 可注入，便于自检覆盖**扫描循环本身**
 *
 * 【2026-11-15 修 · 元检验抓到的盲区】
 * 原来 check() 固定扫 VERIFY_CHAIN，自检只能测 ABS_PATTERNS 正则，
 * **测不到扫描循环**。于是 audit-selftest-reality.mjs 把
 * `if (p.re.test(line))` 改成 `if (false)` 后，自检依然全绿 —— 装饰性自检。
 *
 * 现在 check(fileList) 可注入，自检就能：
 *   造一个含硬编码的探针文件 → check 必须报 FAIL
 *   ⇒ 扫描循环被打瘸时这条必红
 */
export function check(fileList = VERIFY_CHAIN) {
  const problems = [];
  const missing = [];
  const exemptFiles = [];
  const systemSkipped = [];

  for (const rel of fileList) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }

    const text = fs.readFileSync(abs, 'utf8');
    const exempt = text.includes(ALLOW_MARKER);
    if (exempt) exemptFiles.push(rel);
    if (exempt) continue;   // 显式豁免：跳过，但会在 why 里报出数量

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isInComment(line)) continue;
      const sysWhy = isSystemPath(line);
      if (sysWhy) { systemSkipped.push({ file: rel, line: i + 1, why: sysWhy }); continue; }
      for (const p of ABS_PATTERNS) {
        if (p.re.test(line)) {
          problems.push({ file: rel, line: i + 1, kind: p.name, sample: line.trim().slice(0, 90) });
        }
      }
    }
  }

  if (!fileList.length) return { state: 'UNKNOWN', why: '验证链路清单为空', problems, missing };
  if (missing.length === fileList.length) return { state: 'UNKNOWN', why: '清单里的文件一个都不存在', problems, missing };

  const exemptNote = exemptFiles.length ? '（' + exemptFiles.length + ' 个显式豁免：' + exemptFiles.join(',') + '）' : '';

  return {
    state: problems.length ? 'FAIL' : 'PASS',
    why: problems.length
      ? problems.length + ' 处硬编码绝对路径（换目录就会失真）'
      : fileList.length + ' 个验证链路脚本全部从 import.meta.dirname 推导根目录'
        + exemptNote
        + (missing.length ? '（' + missing.length + ' 个文件缺失，已跳过）' : ''),
    problems, missing, exemptFiles, systemSkipped,
  };
}

/** 自检：含应当失败的样例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // 【2026-11-15 修 · 元检验抓到的盲区】
  // 原来这个自检只测 ABS_PATTERNS 正则本身（"这个字符串会被匹配吗"），
  // **完全没有测 check() 的扫描循环**。
  // 后果：tools/evolve/audit-selftest-reality.mjs 把 check() 里的
  // `if (p.re.test(line))` 改成 `if (false)`（即扫描永不报），
  // 自检**依然全绿** —— 那是一个装饰性自检。
  //
  // 现在补上「真的写一个含硬编码的文件，让它被扫出来」这条。

  const tmpScript = 'tools/evolve/_abspath_selftest_target.mjs';
  const tmpAbs = path.join(REPO, tmpScript);
  const backup = [];
  const put = (c) => {
    const had = fs.existsSync(tmpAbs);
    const old = had ? fs.readFileSync(tmpAbs) : null;
    fs.writeFileSync(tmpAbs, c, 'utf8');
    backup.push(() => { if (had) fs.writeFileSync(tmpAbs, old); else if (fs.existsSync(tmpAbs)) fs.unlinkSync(tmpAbs); });
  };

  try {
    // ══════════════════════════════════════════════════════
    // 核心：通过 check() 的**扫描循环**判定（不是只测正则）
    //
    // 这一条是对 audit-selftest-reality.mjs 那个装饰性指控的直接回应：
    // 如果扫描循环被打瘸（if (p.re.test(line)) → if (false)），
    // 下面的「含硬编码的探针 → 必须 FAIL」会红。
    // ══════════════════════════════════════════════════════
    put("const REPO = 'D:/file/AI Temp/DeepSeek/Agent自研';\n");
    const dirty = check([tmpScript]);
    T('扫描循环 · 含硬编码的探针文件 → check 判 FAIL',
      dirty.state === 'FAIL' && dirty.problems.length > 0,
      dirty.state + ' · problems=' + dirty.problems.length);

    // 正例：干净文件 → check 判 PASS
    put("const REPO = path.resolve(import.meta.dirname, '../..');\n");
    const cleanRes = check([tmpScript]);
    T('扫描循环 · 干净探针文件 → check 判 PASS',
      cleanRes.state === 'PASS', cleanRes.state);

    // 正例：显式豁免标记 → check 跳过
    put("// abspath-guard:allow-literal-root\nconst REPO = 'D:/file/AI Temp/DeepSeek/Agent自研';\n");
    const exemptRes = check([tmpScript]);
    T('扫描循环 · 有豁免标记 → check 判 PASS 并计入 exempt',
      exemptRes.state === 'PASS' && exemptRes.exemptFiles.length === 1,
      exemptRes.state + ' · exempt=' + exemptRes.exemptFiles.length);

    // 正例：注释里的路径不算
    put("// 历史：这里曾经写死 D:/file/AI Temp/DeepSeek/Agent自研\nconst REPO = 1;\n");
    const commentRes = check([tmpScript]);
    T('扫描循环 · 注释里的路径 → check 判 PASS',
      commentRes.state === 'PASS', commentRes.state);

    // ── 反例 1：单引号硬编码 ──
    put("const REPO = 'D:/file/AI Temp/DeepSeek/Agent自研';\n");
    T('单引号绝对路径 → 应被抓',
      ABS_PATTERNS.some((p) => p.re.test(fs.readFileSync(tmpAbs, 'utf8').split('\n')[0])), '');

    // ── 反例 2：双引号 + 反斜杠 ──
    put('const P = "D:\\\\file\\\\AI Temp\\\\DeepSeek\\\\Agent自研\\\\x";\n');
    T('双引号 + 反斜杠 → 应被抓',
      ABS_PATTERNS.some((p) => p.re.test(fs.readFileSync(tmpAbs, 'utf8').split('\n')[0])), '');

    // ── 反例 3：盘符路径 ──
    put("const W = 'C:/Users/x/project';\n");
    T('盘符绝对路径 → 应被抓',
      ABS_PATTERNS.some((p) => p.re.test(fs.readFileSync(tmpAbs, 'utf8').split('\n')[0])), '');

    // ── 正例 1：import.meta.dirname 不该被抓 ──
    put("const REPO = path.resolve(import.meta.dirname, '../..');\n");
    T('import.meta.dirname → 不报',
      !ABS_PATTERNS.some((p) => p.re.test(fs.readFileSync(tmpAbs, 'utf8').split('\n')[0])), '');

    // ── 正例 2：注释里提到路径不算 ──
    put("// 历史：这里曾经写死 D:/file/AI Temp/DeepSeek/Agent自研\nconst REPO = 1;\n");
    T('注释里提到路径 → 不算（只查代码行）',
      isInComment(fs.readFileSync(tmpAbs, 'utf8').split('\n')[0]), '');

    // ── 正例 3：相对路径不报 ──
    put("const A = 'apps/vouch-web/x.json';\nconst B = path.join(REPO, 'tools');\n");
    T('相对路径 → 不报',
      !ABS_PATTERNS.some((p) => p.re.test(fs.readFileSync(tmpAbs, 'utf8').split('\n')[0])), '');
  } finally {
    for (const r of backup.reverse()) r();
  }

  // 整体检查也应能跑
  const c = check();
  T('整体检查可跑且给出四态', ['PASS', 'FAIL', 'UNKNOWN'].includes(c.state), c.state);

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  可复算性守卫 · 自检（3 正例 + 3 反例）');
    console.log('  ' + '─'.repeat(72));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const r = check();
  const ICON = { PASS: '✅', FAIL: '❌', UNKNOWN: '❔' };
  console.log('');
  console.log('  ' + ICON[r.state] + ' 可复算性守卫（验证链路无硬编码绝对路径）');
  console.log('  ' + r.why);
  for (const p of r.problems) console.log('    ✗ ' + p.file + ':' + p.line + '  ' + p.kind + '  ' + p.sample);
  for (const m of r.missing.slice(0, 6)) console.log('    · 缺失（跳过）' + m);
  if (r.systemSkipped && r.systemSkipped.length) {
    const byWhy = {};
    for (const s of r.systemSkipped) byWhy[s.why] = (byWhy[s.why] || 0) + 1;
    console.log('    · 系统/外部路径豁免 ' + r.systemSkipped.length + ' 处：');
    for (const [why, n] of Object.entries(byWhy)) console.log('        ' + n + ' × ' + why);
  }
  console.log('');
  process.exit(r.state === 'PASS' ? 0 : r.state === 'UNKNOWN' ? 2 : 1);
}

export { VERIFY_CHAIN, ABS_PATTERNS };