#!/usr/bin/env node
/**
 * B4 体量纪律 —— 单文件体量红线（自研，不借 hermes）
 *
 * 为什么需要：
 *   矩阵 B4 之前记「部分」，证据是「我们用断言管矩阵证据」—— 那是验收纪律，
 *   不是**产品代码的体量纪律**。实测我们自己的最大源文件已经 23.5KB，
 *   再长下去就是「一个文件里塞整个系统」，没人能审。
 *
 * 与本项目其他检查的区别：
 *   这是**红线**，不是提示。超了退出 1，必须拆或显式豁免（豁免要写理由+复核日）。
 *
 * 三档判据（不是拍脑袋，参照的是可维护性经验值）：
 *   红线 32KB    单文件超过它 = 必须拆
 *   黄线 24KB    超过它 = 记 WARN，下次改动要评估拆不拆
 *   白名单       少数「数据表/长清单」型文件允许超（每项须写理由）
 *
 * 用法：
 *   node tools/quality/size-guard.mjs            # 检查，超红线退出 1
 *   node tools/quality/size-guard.mjs --json     # 机器可读
 *   node tools/quality/size-guard.mjs --list     # 只列体量排行
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const RED_KB = 32;
const YELLOW_KB = 24;

/** 扫描范围：我们自己的源码（排除 vendor / fork / 生成物 / 证据） */
const SCAN = [
  'tools',
  'prototype/hermes-agents',
  'prototype/agent-ui',
  'apps/agent-ui/src',
  'hermes-patches',
];
const EXT = /\.(mjs|js|ts|tsx|py|ps1)$/;
/**
 * 排除项 —— 这条判据是实测逼出来的
 *
 * 第一版把 vendor 与上游原文件也算进来，报出「超红线」：
 *   prototype/agent-ui/vendor/lucide.js        349.7KB  ← 第三方库（ISC），不是我们的代码
 *   hermes-patches/tools/approval_detection.py  115.5KB  ← 上游 hermes 原文件，我们只改几行
 *
 * 红线管的是**我们自己写的代码**。把 vendor 和上游原文件算进去，
 * 等于要求「把第三方库拆了」，那是错的。
 * 上游原文件应该用「补丁行数」而不是「文件体量」来管（见 _upstream 字段）。
 */
const SKIP = /node_modules|[\\/]dist[\\/]|[\\/]evidence[\\/]|\.min\.|openbitfun-dist|dsh-src|[\\/]vendor[\\/]/;

/** 上游原文件：我们只改了其中几行，体量不由我们决定 */
const UPSTREAM = /^hermes-patches\/(?!apply\.mjs|README)[^/]+\/.+\.(py|ts|tsx|js)$/;

/**
 * 白名单：允许超过黄线的文件，每项必须写清「为什么它长但不该拆」+ 复核日。
 * 不加理由的豁免等于没有红线。
 */
const ALLOW = {
  'prototype/hermes-agents/verify-goal.mjs': {
    why: '8 条硬要求的判定集中在一处，拆开会让「一眼看完全部判据」的能力消失；每次改动都要通读',
    reviewBy: '2026-12-31',
  },
  'prototype/hermes-agents/resolve-anchors.mjs': {
    why: '定向锚点表是数据（77 条能力→源码位置映射），不是逻辑；拆表会让维护变成两处同步',
    reviewBy: '2026-12-31',
  },
  'prototype/hermes-agents/attach-official-docs.mjs': {
    why: '官方文档锚点表是数据；同上',
    reviewBy: '2026-12-31',
  },
  'prototype/hermes-agents/matrix-data.json': {
    why: '矩阵数据源，本身就是大数据表',
    reviewBy: '2026-12-31',
  },
};

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) { walk(p, out); continue; }
    if (!EXT.test(e.name)) continue;
    const bytes = fs.statSync(p).size;
    // 【2026-11-15 修】判定与显示分开：
    //   原来只存 `Math.round(kb*10)/10`，判定也用它 —— 于是 32769 字节
    //   （32.001KB）被舍入成 32.0，`32.0 > 32` 为假 ⇒ **漏过红线**。
    //   实测漏网窗口约 50 字节（要到 32819 字节才标红）。
    //   这是「表示精度污染判定」—— 显示可以取整，判定必须用原始字节。
    out.push({
      rel: path.relative(REPO, p).replace(/\\/g, '/'),
      bytes,
      kb: Math.round((bytes / 1024) * 10) / 10,   // 仅供显示
    });
  }
  return out;
}

/**
 * 判定 —— 抽成纯函数便于自检
 *
 * 【为什么必须有自检】这个脚本有一个**真实发生过的 bug**：
 *   原来只存 `Math.round(kb*10)/10` 并拿它判定，于是 32769 字节 → 32.0 →
 *   `32.0 > 32` 为假 ⇒ **漏过红线**，实测漏网窗口约 50 字节。
 *   发现方式：L4 度量（tools/evolve/measure-verifier-efficacy.mjs）的难度注入 F11。
 *
 * 正是因为没有反例测「刚好超 1 字节」这种边界，这个 bug 活了很久。
 */
export function classify(files, { redBytes = RED_KB * 1024, yellowBytes = YELLOW_KB * 1024, allow = ALLOW, upstreamRe = UPSTREAM } = {}) {
  const upstream = files.filter((f) => upstreamRe.test(f.rel));
  const own = files.filter((f) => !upstreamRe.test(f.rel));
  return {
    upstream,
    own,
    red: own.filter((f) => f.bytes > redBytes && !allow[f.rel]),
    yellow: own.filter((f) => f.bytes > yellowBytes && f.bytes <= redBytes && !allow[f.rel]),
    exempt: own.filter((f) => allow[f.rel]),
  };
}

/**
 * 自检 —— 边界是本脚本唯一的难点，所以反例全在边界上
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const KB = 1024;
  const mk = (bytes, rel = 'x.mjs') => ({ rel, bytes, kb: Math.round((bytes / KB) * 10) / 10 });

  // ── 反例 1（核心）：只超红线 1 字节必须标红 ──
  //   这正是历史 bug：32*1024+1 = 32769 字节被取整成 32.0KB，判据 `kb>32` 为假 ⇒ 漏网
  const c1 = classify([mk(32 * KB + 1)]);
  T('反例 · 只超红线 1 字节（32769B）→ 必须标红',
    c1.red.length === 1, 'red=' + c1.red.length + ' yellow=' + c1.yellow.length);

  // ── 正例 1：恰好等于红线（32768B）不算超 ──
  //   判据是「超过」不是「达到」。恰好 32KB 归黄线。
  const c2 = classify([mk(32 * KB)]);
  T('正例 · 恰好 32768B → 不标红（判据是「超过」不是「达到」）',
    c2.red.length === 0 && c2.yellow.length === 1,
    'red=' + c2.red.length + ' yellow=' + c2.yellow.length);

  // ── 反例 2：只超黄线 1 字节 → 黄线 ──
  const c3 = classify([mk(24 * KB + 1)]);
  T('反例 · 只超黄线 1 字节 → 黄线警告',
    c3.yellow.length === 1 && c3.red.length === 0,
    'red=' + c3.red.length + ' yellow=' + c3.yellow.length);

  // ── 正例 2：恰好等于黄线 → 不警告 ──
  const c4 = classify([mk(24 * KB)]);
  T('正例 · 恰好 24576B → 不警告', c4.yellow.length === 0, 'yellow=' + c4.yellow.length);

  // ── 反例 3：147KB（远超）→ 必须标红 ──
  const c5 = classify([mk(147 * KB)]);
  T('反例 · 147KB 远超 → 标红', c5.red.length === 1, 'red=' + c5.red.length);

  // ── 正例 3：白名单里的超大文件不标红（但要列出）──
  const c6 = classify([mk(147 * KB, 'allowed.mjs')], { allow: { 'allowed.mjs': { why: '测试用' } } });
  T('正例 · 白名单内超大文件 → 不标红但列入 exempt',
    c6.red.length === 0 && c6.exempt.length === 1, 'red=' + c6.red.length + ' exempt=' + c6.exempt.length);

  // ── 正例 4：上游代码不受本纪律约束 ──
  const c7 = classify([mk(147 * KB, 'apps/vouch-web/src/web-ui/x.ts')], { upstreamRe: /apps\/vouch-web\// });
  T('正例 · 上游代码超红线 → 不计入我们的 red',
    c7.red.length === 0 && c7.upstream.length === 1, 'red=' + c7.red.length + ' upstream=' + c7.upstream.length);

  // ── 反例 4：白名单**不能**豁免上游判定 ──
  //   即使一个文件在 allow 里，它如果是上游代码，也不该出现在 red/exempt 里
  const c8 = classify([mk(147 * KB, 'apps/vouch-web/x.ts')],
    { upstreamRe: /apps\/vouch-web\//, allow: { 'apps/vouch-web/x.ts': { why: 'x' } } });
  T('反例 · 上游 + 白名单 → 仍只算 upstream，不进 exempt',
    c8.exempt.length === 0 && c8.upstream.length === 1, 'exempt=' + c8.exempt.length);

  // ── 反例 5：边界扫描 —— 红线±2 字节全部正确 ──
  //
  // 【注意这里差点写成错期望】32KB-2 = 32766 字节，它**仍在黄线区**
  // （黄线 24KB ~ 红线 32KB），所以应当是 yellow 而不是 ok。
  // 第一版期望写成 'ok'，跑出来红了 —— 那是**测试写错**，不是代码错。
  // 这种「测试期望本身要经得起推敲」也是反例纪律的一部分。
  const boundary = [
    [YELLOW_KB * KB - 1, 'ok'],        // 恰好不到黄线
    [YELLOW_KB * KB, 'ok'],            // 恰好黄线，不算超
    [YELLOW_KB * KB + 1, 'yellow'],    // 超黄线 1 字节
    [RED_KB * KB - 1, 'yellow'],       // 红线下 1 字节，仍在黄线区
    [RED_KB * KB, 'yellow'],           // 恰好红线，不算超
    [RED_KB * KB + 1, 'red'],          // 超红线 1 字节 ← 历史 bug 所在
    [RED_KB * KB + 2, 'red'],
  ];
  let boundaryOk = true;
  const boundaryDetail = [];
  for (const [bytes, want] of boundary) {
    const c = classify([mk(bytes)]);
    const got = c.red.length ? 'red' : c.yellow.length ? 'yellow' : 'ok';
    boundaryDetail.push(bytes + '→' + got);
    if (got !== want) boundaryOk = false;
  }
  T('反例 · 黄线/红线各 ±1 字节逐点扫描', boundaryOk, boundaryDetail.join(' '));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  B4 体量纪律 · 自检（3 正例 + 5 反例，反例全在边界）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

const files = SCAN.flatMap((d) => walk(path.join(REPO, d)));
files.sort((a, b) => b.bytes - a.bytes);

// 判定一律用原始字节，不用取整后的 kb
const RED_BYTES = RED_KB * 1024;
const YELLOW_BYTES = YELLOW_KB * 1024;
const { upstream, own, red, yellow, exempt } = classify(files);

if (process.argv.includes('--list')) {
  console.log('');
  console.log('  源文件体量排行（我们自己的代码）');
  console.log('  ' + '─'.repeat(64));
  for (const f of files.slice(0, 25)) {
    const mark = ALLOW[f.rel] ? '白' : f.bytes > RED_BYTES ? '✗' : f.bytes > YELLOW_BYTES ? '🟡' : ' ';
    console.log('  ' + mark + ' ' + String(f.kb).padStart(6) + 'KB  ' + f.rel);
  }
  console.log('');
  process.exit(0);
}

const out = {
  what: 'B4 单文件体量红线',
  rule: '红线 ' + RED_KB + 'KB（超则失败）· 黄线 ' + YELLOW_KB + 'KB（超则警告）· 白名单须写理由',
  at: new Date().toISOString(),
  scanDirs: SCAN,
  filesScanned: files.length,
  maxKB: files.length ? files[0].kb : 0,
  red: red.map((f) => f.rel + ' (' + f.kb + 'KB)'),
  yellow: yellow.map((f) => f.rel + ' (' + f.kb + 'KB)'),
  exempt: exempt.map((f) => f.rel + ' (' + f.kb + 'KB)'),
  upstream: upstream.map((f) => f.rel + ' (' + f.kb + 'KB)'),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('');
  console.log('  B4 体量纪律 —— 单文件红线 ' + RED_KB + 'KB / 黄线 ' + YELLOW_KB + 'KB');
  console.log('  ' + '─'.repeat(64));
  console.log('  扫描 ' + files.length + ' 个源文件，最大 ' + (files.length ? files[0].kb : 0) + 'KB');
  console.log('');
  if (red.length) {
    console.log('  ✗ 超红线（必须拆或加白名单说明）:');
    for (const f of red) console.log('      ' + f.kb + 'KB  ' + f.rel);
  } else {
    console.log('  ✓ 没有文件超红线');
  }
  if (yellow.length) {
    console.log('  🟡 超黄线（下次改动评估是否需要拆）:');
    for (const f of yellow) console.log('      ' + f.kb + 'KB  ' + f.rel);
  }
  if (exempt.length) {
    console.log('  白名单（已写理由 + 复核日）:');
    for (const f of exempt) {
      const a = ALLOW[f.rel];
      console.log('      ' + f.kb + 'KB  ' + f.rel + '  复核 ' + a.reviewBy);
    }
  }
  console.log('');
}

fs.mkdirSync(path.join(REPO, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'evidence/size-guard.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

process.exit(red.length ? 1 : 0);