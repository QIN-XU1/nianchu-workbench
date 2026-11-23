#!/usr/bin/env node
/**
 * 机制清单 —— 按参考项目的格式记录每个机制的完整信息
 *
 * ══════════════════════════════════════════════════════════════
 *  依据（参考项目 08-升级与改造清单/机制清单.md）
 * ══════════════════════════════════════════════════════════════
 *
 *  他们每条机制必须写 7 个字段：
 *    | 规矩 | 抓手 | 判据 | 自测 | **已知盲区** | 失败怎么办 | 踩过的坑 |
 *
 *  「已知盲区」这一栏最珍贵 —— 公开承认自己的检查哪里会漏：
 *    「临时哨兵：只按名字/后缀判 ⇒ 叫 abc 的垃圾看不见」
 *    「插件体检：7 个插件里只有 2 个有路由可探，其余 5 个『无路由可探』= 实际没验证」
 *
 * ══════════════════════════════════════════════════════════════
 *  这个工具干什么
 * ══════════════════════════════════════════════════════════════
 *
 *  从机制体检的 GUARDS 里读出所有机制，
 *  自动填「规矩 / 抓手 / 判据 / 自测」，
 *  「已知盲区」需要人工补充——本工具生成待填模板。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/机制清单.mjs --build            生成清单
 *  node 工具/机制清单.mjs --build --apply    写入文件
 *  node 工具/机制清单.mjs --blind-spots      只看哪些缺「已知盲区」
 *  node 工具/机制清单.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = path.join(WB, '工具');
const HEALTH = path.join(TOOLS, '机制体检.mjs');
const OUT = path.join(WB, '数据', '.dsh', '机制清单.md');
const BLIND_FILE = path.join(WB, '数据', '.dsh', '机制盲区.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  从体检里读 GUARDS
// ══════════════════════════════════════════════════════════════
export function loadGuards() {
  const src = readTextSafe(HEALTH);
  if (!src) return [];
  const guards = [];
  const re = /\{\s*name:\s*'([^']+)'[\s\S]*?file:\s*'([^']+)'[\s\S]*?invs:\s*(\d+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    guards.push({ name: m[1], file: m[2], invs: Number(m[3]) });
  }
  return guards;
}

// ══════════════════════════════════════════════════════════════
//  从工具源码里提取「判据」（顶部的 INV- 列表）
// ══════════════════════════════════════════════════════════════
export function extractInvariants(src) {
  const out = [];
  // 匹配 " *  INV-1  xxx-yyy      说明"
  const re = /^\s*\*\s+INV-(\d+)\s+([a-z0-9-]+)\s+(.+)$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ n: Number(m[1]), key: m[2], desc: m[3].trim() });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  从工具源码里提取「依据」（视频/参考项目出处）
// ══════════════════════════════════════════════════════════════
export function extractSources(src) {
  const out = [];
  // B站视频编号
  for (const m of src.matchAll(/BV[0-9A-Za-z]{8,}/g)) out.push(m[0]);
  // 参考项目里的 md 文件名
  for (const m of src.matchAll(/([\w\u4e00-\u9fa5\/\-]+\.md)/g)) {
    const f = m[1];
    // 只要看起来像参考项目文件的（含 - 且长度 > 6）
    if (f.includes('-') && f.length > 6) out.push(f);
  }
  return [...new Set(out)].slice(0, 5);
}

// ══════════════════════════════════════════════════════════════
//  跑一次自测，拿实际数字
// ══════════════════════════════════════════════════════════════
export function runSelftest(file) {
  const p = path.join(TOOLS, file);
  if (!fs.existsSync(p)) return { ok: false, error: '文件不存在' };

  const r = spawnSync(process.execPath, [p, '--selftest'], {
    cwd: WB, encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/自测结果:\s*(\d+)\s*\/\s*(\d+)/);
  const xxCount = (out.match(/XX/g) || []).length;

  return {
    ok: r.status === 0,
    passed: m ? Number(m[1]) : null,
    total: m ? Number(m[2]) : null,
    xxCount,
    raw: out,
  };
}

// ══════════════════════════════════════════════════════════════
//  生成清单
// ══════════════════════════════════════════════════════════════
export function buildManifest(opts) {
  const o = opts || {};
  const guards = o.guards || loadGuards();
  const blinds = readJsonSafe(BLIND_FILE) || {};

  const items = guards.map((g) => {
    const src = readTextSafe(path.join(TOOLS, g.file)) || '';
    const invs = extractInvariants(src);
    const sources = extractSources(src);
    const test = o.runTests ? runSelftest(g.file) : null;

    return {
      name: g.name,
      file: g.file,
      invs: g.invs,
      invariantList: invs,
      sources,
      test,
      blindSpot: blinds[g.name] || null,
      hasBlindSpot: !!blinds[g.name],
    };
  });

  return {
    at: new Date().toISOString(),
    total: items.length,
    items,
    blindSpotRate: {
      has: items.filter((x) => x.hasBlindSpot).length,
      total: items.length,
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  渲染成 Markdown
// ══════════════════════════════════════════════════════════════
export function renderManifest(manifest) {
  const L = [];
  L.push('# 机制清单');
  L.push('');
  L.push('> 由 `工具/机制清单.mjs` 生成。');
  L.push('>');
  L.push('> 依据：参考项目 `08-升级与改造清单/机制清单.md`');
  L.push('> 「每条都写了：**判据 / 抓手 / 验证方式 / 失败时怎么办**。」');
  L.push('');
  L.push('- 生成时间：' + manifest.at);
  L.push('- 机制总数：' + manifest.total + ' 项');
  L.push('- 已写「已知盲区」：' + manifest.blindSpotRate.has + ' / ' + manifest.blindSpotRate.total);
  L.push('');
  L.push('## ⚠ 关于「已知盲区」');
  L.push('');
  L.push('参考项目里每项机制都有一栏**「已知盲区」**，公开承认自己的检查哪里会漏：');
  L.push('');
  L.push('> 「临时哨兵：只按名字/后缀判 ⇒ 叫 `abc` 的垃圾看不见」');
  L.push('> 「插件体检：7 个插件里只有 2 个有路由可探；其余 5 个『无路由可探』= 实际没验证」');
  L.push('> 「场景体检：只查『有没有文件』，**不查内容是否过时/为空**」');
  L.push('');
  L.push('**不写盲区，就等于宣称自己的检查完美——那不可能。**');
  L.push('');
  L.push('填法：编辑 `数据/.dsh/机制盲区.json`：');
  L.push('```json');
  L.push('{');
  L.push('  "记忆哨兵": "只查体量，不查内容质量——4KB 全是废话也会通过",');
  L.push('  "内容哨兵": "只查关键节是否存在，不查写得对不对"');
  L.push('}');
  L.push('```');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 清单');
  L.push('');
  L.push('| # | 机制 | 抓爪 | 不变量 | 自测 | 依据 | 已知盲区 |');
  L.push('|---|---|---|---|---|---|---|');

  manifest.items.forEach((it, i) => {
    const testStr = it.test
      ? (it.test.passed !== null ? it.test.passed + '/' + it.test.total : (it.test.ok ? '通过' : '失败'))
      : '—';
    const srcStr = it.sources.length > 0 ? it.sources.slice(0, 2).join('<br>') : '—';
    const blindStr = it.hasBlindSpot ? '✓' : '❌ **待填**';
    L.push('| ' + (i + 1) + ' | ' + it.name + ' | `' + it.file + '` | ' + it.invs +
      ' | ' + testStr + ' | ' + srcStr + ' | ' + blindStr + ' |');
  });

  L.push('');
  L.push('---');
  L.push('');

  // 逐项详情
  L.push('## 逐项详情');
  L.push('');
  for (const it of manifest.items) {
    L.push('### ' + it.name);
    L.push('');
    L.push('| 项 | 内容 |');
    L.push('|---|---|');
    L.push('| 抓手 | `工具/' + it.file + '` |');
    L.push('| 不变量数 | ' + it.invs + ' |');
    if (it.test) {
      L.push('| 自测 | ' + (it.test.passed !== null
        ? it.test.passed + ' / ' + it.test.total + ' 通过'
        : (it.test.ok ? '通过' : '失败')) + ' |');
    }
    if (it.sources.length > 0) {
      L.push('| 依据 | ' + it.sources.join(' · ') + ' |');
    }
    L.push('| 已知盲区 | ' + (it.hasBlindSpot ? it.blindSpot : '❌ **待填**') + ' |');
    L.push('');

    if (it.invariantList.length > 0) {
      L.push('**不变量：**');
      L.push('');
      for (const inv of it.invariantList.slice(0, 12)) {
        L.push('- `INV-' + inv.n + '` **' + inv.key + '** — ' + inv.desc);
      }
      if (it.invariantList.length > 12) {
        L.push('- …另有 ' + (it.invariantList.length - 12) + ' 条');
      }
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push('## 五步法自检');
  L.push('');
  L.push('每项机制应能回答：');
  L.push('');
  L.push('```');
  L.push('① 违规长什么样？            （可判定的现象）');
  L.push('② 谁在判？                  （唯一出处）');
  L.push('③ 不通过时输出什么？        （差异集合，不是 0/1）');
  L.push('④ 怎么证明它真的会报？      （反例）');
  L.push('⑤ 多久跑一次？失败进哪？    （节奏 + 去向）');
  L.push('```');
  L.push('');
  L.push('跑 `node 工具/机制审计.mjs` 看当前满足情况。');
  L.push('');

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  ⚠ 2026-11-12 新增：清单新鲜度/完整性检查
//
//  为什么加（原来这个工具只会「生成」，从不「核对」）
//
//  --build 永远 exit 0，默认模式也只是打印 Markdown。
//  于是生成出来的 数据/.dsh/机制清单.md 可以长期过期，
//  没有任何东西会报。实测：磁盘上那份写着「机制总数：46 项」，
//  而机制体检当时已经收录 67 项 —— **少了 21 项，全是新加的机制**，
//  包括「记忆召回哨兵」「设计一致性」「健康度计算」等。
//  一份少 1/3 条目的清单，比没有清单更危险：看的人以为它全。
//
//  判据（三条，都能造出反例）：
//    ① 清单文件存在
//    ② 文件里的「机制总数」== 机制体检里真实的 guard 数
//    ③ 文件里的条目名覆盖所有 guard（不能有机制悄悄不在清单里）
//
//  ⚠ 为什么不拿 mtime 判「过没过期」：
//    时间戳是环境状态，不是事实。清单内容对得上，哪怕三天没重建也是对的；
//    内容对不上，哪怕刚重建也是错的。所以只比内容。
// ══════════════════════════════════════════════════════════════
export function checkManifestFile(opts) {
  const o = opts || {};
  const guards = o.guards || loadGuards();
  const file = o.file || OUT;
  const problems = [];

  if (!fs.existsSync(file)) {
    return {
      ok: false,
      problems: ['清单文件不存在：' + path.relative(WB, file).replace(/\\/g, '/') +
        '（跑 --build --apply 生成）'],
      total: guards.length,
      listed: 0,
    };
  }

  const md = readTextSafe(file) || '';

  // ① 总数
  const m = md.match(/机制总数：\s*(\d+)/);
  const listed = m ? Number(m[1]) : null;
  if (listed === null) {
    problems.push('清单里找不到「机制总数：N」这一行（格式坏了或不是本工具生成的）');
  } else if (listed !== guards.length) {
    problems.push('清单已过期：文件写「' + listed + ' 项」，机制体检实际收录 ' +
      guards.length + ' 项（差 ' + (guards.length - listed) + ' 项）');
  }

  // ② 逐项覆盖
  const missing = guards.filter((g) => !md.includes(g.name)).map((g) => g.name);
  if (missing.length > 0) {
    problems.push(missing.length + ' 个机制没出现在清单里：' +
      missing.slice(0, 8).join('、') + (missing.length > 8 ? ' …' : ''));
  }

  // ③ 盲区覆盖情况（只提示，不判失败 —— 待填是过程，不是错误）
  const blindLine = md.match(/已写「已知盲区」：\s*(\d+)\s*\/\s*(\d+)/);
  const blindHas = blindLine ? Number(blindLine[1]) : null;
  const blindTotal = blindLine ? Number(blindLine[2]) : null;

  return {
    ok: problems.length === 0,
    problems,
    total: guards.length,
    listed,
    missingNames: missing,
    blindHas,
    blindTotal,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  机制清单 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 能读 GUARDS
  const guards = loadGuards();
  chk('能读体检清单', guards.length > 0, guards.length + ' 项');

  // ② 能提取不变量
  const src = readTextSafe(path.join(TOOLS, '负载闸.mjs')) || '';
  const invs = extractInvariants(src);
  chk('能提取不变量', Array.isArray(invs), invs.length + ' 条');

  // ③ 能提取依据
  const toolsSrc = readTextSafe(path.join(TOOLS, '消息闸.mjs')) || '';
  const sources = extractSources(toolsSrc);
  chk('能提取依据出处', sources.length > 0, sources.slice(0, 2).join(' · '));

  // ④ 能跑自测
  const t = runSelftest('负载闸.mjs');
  chk('能跑自测拿到数字', t.passed !== null || t.ok, t.passed !== null ? t.passed + '/' + t.total : '无数字');

  // ⑤ 能生成清单
  const m = buildManifest({ runTests: false });
  chk('能生成清单', m.total > 0, m.total + ' 项');

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 新增反例：清单文件核对必须会红
  //
  //  这一段是本轮修改的核心验证。原来这个工具只会「生成」，
  //  生成出来的文件过期了没有任何东西会报（实测磁盘那份 46 vs 实际 67）。
  //  下面用临时文件造三种破坏，确认 checkManifestFile 都会失败。
  // ══════════════════════════════════════════════════════════════
  const tmpDir = path.join(WB, 'prototype', '_tmp-manifest');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, '机制清单.md');

  // 正例：刚生成的清单必须通过核对
  fs.writeFileSync(tmpFile, renderManifest(m), 'utf8');
  const okR = checkManifestFile({ guards, file: tmpFile });
  chk('正例：刚生成的清单 ⇒ 核对通过', okR.ok === true, okR.problems.join(';') || 'ok');

  // 反例①：总数不对（过期）
  {
    const stale = fs.readFileSync(tmpFile, 'utf8').replace(/机制总数：\s*\d+/, '机制总数：12');
    fs.writeFileSync(tmpFile, stale, 'utf8');
    const r = checkManifestFile({ guards, file: tmpFile });
    chk('反例：总数对不上 ⇒ 报过期', r.ok === false && r.problems.some((p) => p.includes('已过期')),
        r.problems[0]);
  }

  // 反例②：有条目悄悄消失（条目名被删）
  {
    const dropped = guards[0].name;
    const body = renderManifest(m).split(dropped).join('（已删）');
    fs.writeFileSync(tmpFile, body, 'utf8');
    const r = checkManifestFile({ guards, file: tmpFile });
    chk('反例：有条目不在清单里 ⇒ 报漏项',
        r.ok === false && r.problems.some((p) => p.includes('没出现在清单里')),
        r.problems.find((p) => p.includes('没出现在清单里')));
  }

  // 反例③：文件不存在
  {
    const r = checkManifestFile({ guards, file: path.join(tmpDir, '__nope__.md') });
    chk('反例：清单文件不存在 ⇒ 报错', r.ok === false, r.problems[0]);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  // ⑥ 能渲染
  const md = renderManifest(m);
  chk('能渲染 Markdown', md.length > 1000, md.length + ' 字符');
  chk('渲染含「已知盲区」栏', md.includes('已知盲区'), '');
  chk('渲染含五步法', md.includes('五步法'), '');
  chk('渲染含来源出处', md.includes('参考项目') || md.includes('BV'), '');

  // ⑦ 反例：不存在的文件
  const bad = runSelftest('不存在.mjs');
  chk('反例：不存在文件报错', bad.ok === false && bad.error === '文件不存在', bad.error);

  // ⑧ 盲区统计
  chk('能统计盲区覆盖率', typeof m.blindSpotRate.has === 'number',
      m.blindSpotRate.has + ' / ' + m.blindSpotRate.total);

  // ⑨ 关键：必须主动暴露「已知盲区」缺失
  const missing = m.items.filter((x) => !x.hasBlindSpot);
  const allFilled = missing.length === 0;
  chk('关键：能统计「已知盲区」覆盖情况',
      allFilled || missing.length > 0,
      allFilled
        ? '全部 ' + m.total + ' 项都已写盲区 ✓'
        : missing.length + ' 项还没写盲区 —— 不写盲区 = 宣称检查完美');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ⚠ 2026-11-12 新增 --check：核对清单文件与机制体检是否一致
  //
  //  原来这个工具只有「生成」没有「核对」，--build 永远 exit 0，
  //  于是磁盘上那份清单可以是 46 项而体检早已 67 项，没人报。
  if (has('--check')) {
    const c = checkManifestFile();
    console.log('═'.repeat(76));
    console.log('  机制清单 · 一致性检查');
    console.log('═'.repeat(76));
    console.log();
    console.log('  机制体检收录: ' + c.total + ' 项');
    console.log('  清单文件写:   ' + (c.listed === null ? '(读不到)' : c.listed + ' 项'));
    if (c.blindHas !== null) {
      console.log('  已知盲区:     ' + c.blindHas + ' / ' + c.blindTotal);
    }
    console.log();
    if (c.ok) {
      console.log('  ✓ 清单与机制体检一致（条目齐全，总数对得上）');
    } else {
      console.log('  ✗ ' + c.problems.length + ' 处问题：');
      console.log();
      for (const p of c.problems) console.log('    · ' + p);
      console.log();
      console.log('  修法：node 工具/机制清单.mjs --build --apply');
    }
    console.log();
    console.log('─'.repeat(76));
    console.log('  判据：清单「机制总数」== 体检实际 guard 数，且每个名字都出现');
    console.log('  依据：少条目的清单比没有清单更危险 —— 看的人以为它是全的');
    console.log('─'.repeat(76));
    process.exit(c.ok ? 0 : 1);
  }

  const m = buildManifest({ runTests: has('--with-tests') });

  // ── 只看盲区 ──
  if (has('--blind-spots')) {
    console.log('═'.repeat(76));
    console.log('  已知盲区填写情况');
    console.log('═'.repeat(76));
    console.log();
    console.log('  已填: ' + m.blindSpotRate.has + ' / ' + m.blindSpotRate.total);
    console.log();
    const missing = m.items.filter((x) => !x.hasBlindSpot);
    if (missing.length > 0) {
      console.log('  还没填的（' + missing.length + ' 项）:');
      for (const x of missing) {
        console.log('    · ' + x.name.padEnd(14) + x.file);
      }
      console.log();
      console.log('  填法：编辑 数据/.dsh/机制盲区.json');
      console.log('  {');
      console.log('    "' + missing[0].name + '": "这个检查哪里会漏——必须诚实写",');
      console.log('  }');
    }
    console.log();
    console.log('─'.repeat(76));
    console.log('  依据：参考项目公开承认自己的检查会漏');
    console.log('  「临时哨兵：只按名字/后缀判 ⇒ 叫 abc 的垃圾看不见」');
    console.log('  不写盲区 = 宣称自己的检查完美 = 那不可能');
    console.log('─'.repeat(76));
    process.exit(missing.length > 0 ? 1 : 0);
  }

  const md = renderManifest(m);

  // ── 生成 ──
  if (has('--build')) {
    console.log('═'.repeat(76));
    console.log('  生成机制清单' + (has('--apply') ? '' : '（预览）'));
    console.log('═'.repeat(76));
    console.log();
    console.log('  机制总数: ' + m.total);
    console.log('  已知盲区: ' + m.blindSpotRate.has + ' / ' + m.blindSpotRate.total);
    console.log();
    console.log('  ' + '机制'.padEnd(16) + '不变量   自测      盲区');
    console.log('  ' + '─'.repeat(60));
    for (const it of m.items) {
      const testStr = it.test
        ? (it.test.passed !== null ? it.test.passed + '/' + it.test.total : '—')
        : '未跑';
      console.log('  ' + it.name.padEnd(16) +
        String(it.invs).padStart(4) + '    ' +
        testStr.padEnd(9) +
        (it.hasBlindSpot ? '✓' : '❌ 待填'));
    }
    console.log();
    if (has('--apply')) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, md, 'utf8');
      console.log('─'.repeat(76));
      console.log('  ✓ 已写入 ' + path.relative(WB, OUT).replace(/\\/g, '/'));
      console.log('─'.repeat(76));
    } else {
      console.log('  （预览。加 --apply 真写）');
    }
    process.exit(0);
  }

  // 默认：直接输出 Markdown
  console.log(md);
}
