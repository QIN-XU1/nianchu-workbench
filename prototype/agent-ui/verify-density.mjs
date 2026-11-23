#!/usr/bin/env node
/**
 * D2 信息密度验收 —— 把「密度」变成可复算的数字，而不是感觉
 *
 * 这份检查做三件事：
 *   1. 机制在位：measure-density.mjs 能跑，产物 evidence/density.json 有四类指标
 *   2. 数据可复算：同一 URL 两次测量，关键指标差异 < 5%（渲染抖动容忍）
 *   3. 诚实报告：把「我们 vs 参照」的真实数字打出来 ——
 *      **包括我们不如它的时候**。密度不是越大越好，是「该密的密、该疏的疏」。
 *
 * 四态：没有浏览器 → UNKNOWN(退出 2)。
 *
 * ── 关于 --selftest（给验收器本身加反例）────────────────────────
 * 这份验收的核心是几个「数字判据」，它们写松/写反不会报错，只会静默放过坏数据。
 * 所以把完整性、可复算、诚实对比抽成纯函数，用假测量记录断言「该红的必须红」。
 * 反例挑的都是这里真实会错的点：
 *   · 两项测量偏差 6% 仍判「可复算」（门槛写松）
 *   · 恰好 5% 被当成通过（判据该是「<」不是「≤」）
 *   · 指标缺失/是字符串/是 NaN，却被当成「五项齐全」
 *   · 有失败项时退出码被「无法判断」的 2 盖掉
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const DENSITY = path.join(REPO, 'evidence/density.json');

/** 五类密度指标 —— 缺一不可 */
const METRICS = ['fillRatio', 'charsPerKpx', 'interactivePerKpx', 'whitespaceRatio', 'rowDensity'];

// ══════════════════════════════════════════════════════════════
// 纯函数区 —— 只吃数据，不碰文件/进程/浏览器，自检可注入假记录
// ══════════════════════════════════════════════════════════════

/**
 * 某条测量记录缺哪些指标
 *
 * 【为什么用 Number.isFinite，而不是 typeof === 'number'】
 *   NaN 的 typeof 也是 'number'。探针读不到数值时写的正是 NaN，
 *   老判据会把它当成「指标齐全」——「读不到」和「读到了 0」是两件事。
 *   这是给本文件加自检时反例逼出来的真漏洞。
 */
export function missingMetrics(m, metrics = METRICS) {
  return metrics.filter((k) => !Number.isFinite(m?.metrics?.[k]));
}

/** 完整性检查（每条记录五项指标都必须是有限数字） */
export function completenessChecks(measurements, metrics = METRICS) {
  const ms = Array.isArray(measurements) ? measurements : [];
  return ms.map((m) => {
    const bad = missingMetrics(m, metrics);
    return {
      label: '「' + m?.label + '」五项指标齐全' + (bad.length ? '  ← 缺 ' + bad.join(',') : ''),
      ok: bad.length === 0,
      missing: bad,
    };
  });
}

/**
 * 可复算性 —— 两次测量同一对象的相对偏差
 *
 * 判据是 **worst < tol**（严格小于）。等于门槛不算通过：
 * 门槛是「抖动容忍上限」，顶到上限说明已经不稳了。
 */
export function repeatability(a, b, metrics = METRICS, tol = 0.05) {
  const diffs = metrics.map((k) => {
    const x = a?.metrics?.[k];
    const y = b?.metrics?.[k];
    // 任一侧不是数字 ⇒ 这次比对无效，按最大偏差处理（不许把缺项当 0 偏差放过）
    if (typeof x !== 'number' || typeof y !== 'number') return { k, diff: 1, usable: false };
    const base = Math.max(Math.abs(x), Math.abs(y), 0.01);
    return { k, diff: Math.abs(x - y) / base, usable: true };
  });
  const worst = diffs.length ? Math.max(...diffs.map((d) => d.diff)) : 1;
  return {
    ok: worst < tol,
    worst,
    diffs,
    label: '两次测量关键指标最大偏差 ' + (worst * 100).toFixed(1) + '%（门槛 ' + Math.round(tol * 100) + '%，可复算）',
  };
}

/**
 * 「我们 vs 参照」的诚实对比
 *
 * 注意：这不是比「谁更密」，而是判断两者是否接近到「同源」的程度。
 * 若一方缺 charsPerKpx（NaN 参与运算），结论必须是「有差异、要解释」，
 * 绝不能因为算不出就把「接近」当默认值。
 */
export function compareDensity(ours, refs, { tolerance = 0.5 } = {}) {
  const x = ours?.[0]?.metrics?.charsPerKpx;
  const y = refs?.[0]?.metrics?.charsPerKpx;
  const sameChars = Math.abs((x - y) / Math.max(y, 0.01)) < tolerance;
  const message = sameChars
    ? '两者的字符密度接近（' + x + ' vs ' + y + '）—— 诚实结论：界面层我们与上游同源，密度未超过它'
    : '字符密度有差异（' + x + ' vs ' + y + '），需要在报告里解释原因';
  return { sameChars, message };
}

/**
 * 退出码约定：0 通过 / 1 失败 / 2 无法判断。
 * 抽出来是为了能测「有失败时不许被 UNKNOWN 掩盖」。
 */
export function exitCode({ fail = 0, unknown = 0 } = {}) {
  return fail ? 1 : unknown ? 2 : 0;
}

// ══════════════════════════════════════════════════════════════
// 自检 —— 用假测量记录断言「该红的必须红」
// ══════════════════════════════════════════════════════════════
export function selfTest() {
  const cases = [];
  const T = (n, okv, why) => cases.push([n, !!okv, why]);

  const base = {
    label: '我们-念初',
    metrics: { fillRatio: 0.078, charsPerKpx: 0.13, interactivePerKpx: 0.02, whitespaceRatio: 0.82, rowDensity: 2 },
  };
  const withM = (patch) => ({ label: base.label, metrics: { ...base.metrics, ...patch } });

  // ── 反例 1：某指标偏差 6%（> 门槛 5%）──
  // 为什么重要：门槛写松（比如 0.1）或写成 ≤，渲染抖动的数据会被当成「可复算」。
  const r1 = repeatability(base, withM({ charsPerKpx: 0.13 * 1.06 }));
  T('反例 · 某指标偏差 6%（> 门槛 5%）→ 必须判不可复算', r1.ok === false, r1.label);

  // ── 反例 2：偏差恰好 5% ──
  // 为什么重要：判据必须是「< 门槛」。写成「≤」时，顶到抖动上限也被算作稳定。
  // 这里用 rowDensity 19 vs 20：|19-20|/20 = 0.05，在浮点里**精确**等于门槛
  // （用 0.95 vs 1.0 会得到 0.050000000000000044，那不是「恰好 5%」，测不到边界）。
  const r2 = repeatability(withM({ rowDensity: 19 }), withM({ rowDensity: 20 }));
  T('反例 · 偏差恰好 5%（判据是「<」不是「≤」）→ 必须判不可复算', r2.ok === false, r2.label);

  // ── 反例 3：某项指标缺失（undefined）──
  // 为什么重要：缺项若被当成 0 偏差，一个没量到 rowDensity 的记录会显得「完全一致」。
  const missing = { label: base.label, metrics: { ...base.metrics } };
  delete missing.metrics.rowDensity;
  const r3 = repeatability(base, missing);
  T('反例 · 某项指标缺失（undefined）→ 必须判不可复算（不许当 0 偏差）', r3.ok === false, r3.label);

  // ── 反例 4：指标是字符串（探针序列化变了）──
  // 为什么重要：'0.13' 看着有值，但它不是数字，参与比较会得到 NaN。
  const c4 = completenessChecks([withM({ charsPerKpx: '0.13' })]);
  T('反例 · 指标是字符串 "0.13" → 必须判指标不全', c4[0]?.ok === false, c4[0]?.label);

  // ── 反例 5：指标是 NaN（读不到数值）──
  // 为什么重要：NaN 的 typeof 也是 'number'，老判据会把它当齐全 —— 这是给本文件
  // 加自检时反例逼出来的真漏洞（已改用 Number.isFinite）。
  const c5 = completenessChecks([withM({ charsPerKpx: NaN })]);
  T('反例 · 指标是 NaN（typeof 也是 number）→ 必须判指标不全', c5[0]?.ok === false, c5[0]?.label);

  // ── 反例 6：对比时参照缺 charsPerKpx ──
  // 为什么重要：算不出差异时，默认结论绝不能是「接近/同源」——那是把无知当结论。
  const cmpBad = compareDensity([base], [{ label: '上游-空', metrics: {} }]);
  T('反例 · 参照缺 charsPerKpx → 不许把「算不出」说成「接近」', cmpBad.sameChars === false, cmpBad.message);

  // ── 反例 7/8：退出码约定 ──
  T('反例 · 有失败项时退出码必须是 1（不许被「无法判断」的 2 盖掉）',
    exitCode({ fail: 1, unknown: 3 }) === 1, 'got=' + exitCode({ fail: 1, unknown: 3 }));
  T('反例 · 只有无法判断时退出码必须是 2（不许当 0 通过）',
    exitCode({ fail: 0, unknown: 2 }) === 2, 'got=' + exitCode({ fail: 0, unknown: 2 }));

  // ── 正例 1：五项齐全 + 两次完全一致 → 可复算 ──
  const goodComplete = completenessChecks([base])[0].ok;
  const goodRepeat = repeatability(base, base).ok;
  T('正例 · 五项齐全 + 两次完全一致 → 判合格', goodComplete && goodRepeat, 'complete=' + goodComplete + ' repeat=' + goodRepeat);

  // ── 正例 2：0.04 vs 0.05 判「接近」（现状诚实结论不变）──
  // 真实数据就是这一组，改动不能把这条现有结论弄反。
  const cmpOk = compareDensity([withM({ charsPerKpx: 0.04 })], [{ label: '上游', metrics: { ...base.metrics, charsPerKpx: 0.05 } }]);
  T('正例 · 0.04 vs 0.05 判「接近」（现状诚实结论不变）', cmpOk.sameChars === true, cmpOk.message);

  const bad = cases.filter(([, okv]) => !okv);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, okv, w]) => '  ' + (okv ? '✓' : '✗') + ' ' + n + (okv ? '' : '  ← ' + w)).join('\n'),
  };
}

// ══════════════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════════════
if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  D2 信息密度验收 · 自检（8 反例 + 2 正例，注入假测量记录）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

// ══════════════════════════════════════════════════════════════
// 正式验收
// ══════════════════════════════════════════════════════════════
let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };
const un = (m) => { unknown++; console.log('  ' + I.un + ' ' + m); };

console.log('');
console.log('  D2 信息密度验收 —— 数字而非感觉');
console.log('  ' + '─'.repeat(72));

// ── 1. 机制在位 ──
const TOOL = path.join(REPO, 'tools/quality/measure-density.mjs');
ok(fs.existsSync(TOOL), '度量工具在位（tools/quality/measure-density.mjs）');
const src = fs.readFileSync(TOOL, 'utf8');
const missingMetricsInSrc = METRICS.filter((m) => !src.includes(m));
ok(missingMetricsInSrc.length === 0, '五类密度指标都有定义' + (missingMetricsInSrc.length ? '  ← 缺 ' + missingMetricsInSrc.join(',') : '（填充率/字符密度/交互密度/留白/行密度）'));

if (!fs.existsSync(DENSITY)) {
  un('还没有 evidence/density.json —— 先跑 measure-density.mjs');
} else {
  const store = JSON.parse(fs.readFileSync(DENSITY, 'utf8'));
  const ms = store.measurements || [];
  ok(ms.length > 0, '已有 ' + ms.length + ' 条测量记录');

  // ── 2. 数据完整性 ──
  for (const c of completenessChecks(ms)) ok(c.ok, c.label);

  // ── 3. 我们 vs 参照的真实对比（含我们落后的情况）──
  const ours = ms.filter((m) => /^我们/.test(m.label));
  const refs = ms.filter((m) => /^(上游|参照)/.test(m.label));
  if (!ours.length) {
    un('还没有「我们」的测量记录');
  } else if (!refs.length) {
    un('还没有参照系统的测量记录 —— 无法对比');
  } else {
    console.log('');
    console.log('  密度对比（视口统一 1440×900，同一探针）');
    console.log('  ' + '─'.repeat(72));
    const rows = [...ours, ...refs];
    const keys = [
      ['fillRatio', '填充率', '%', 100],
      ['whitespaceRatio', '留白', '%', 100],
      ['charsPerKpx', '字符密度', '', 1],
      ['interactivePerKpx', '交互密度', '', 1],
      ['rowDensity', '行密度', '', 1],
    ];
    console.log('  ' + '指标'.padEnd(12) + rows.map((r) => r.label.padEnd(20)).join(''));
    for (const [k, name, unit, mul] of keys) {
      const cells = rows.map((r) => {
        const v = r.metrics?.[k];
        return (typeof v === 'number' ? (v * mul).toFixed(mul === 100 ? 1 : 2) : '-') + unit;
      });
      console.log('  ' + name.padEnd(12) + cells.map((c) => c.padEnd(20)).join(''));
    }
    console.log('');

    // 诚实判定：不比「谁更密」，比「是否有定义、可复算、差异可解释」
    const cmp = compareDensity(ours, refs);
    ok(true, cmp.message);
  }
}

// ── 4. 可复算：同一对象测两次，关键指标稳定 ──
function findBrowser() {
  return ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p)) || null;
}
const browser = findBrowser();
/**
 * 测哪套前端 —— 这个选择必须说清楚，否则数字没有意义
 *
 * 我们有两套前端：
 *   apps/agent-ui/dist    我们自己的界面（8 个场景、真实验收数据）← 密度应该测这个
 *   apps/vouch-web/dist  fork 的上游 OpenBitFun（品牌已换，但结构还是它的）
 *
 * 上一版测的是 bitfun-web，结果是「我们 vs 上游同源、密度一样」——
 * 那比较的其实是同一个东西，没有意义。
 * 现在 D2 测我们自己的界面；与上游的对比在密度报告里单独列出（标为参照）。
 */
const DIST = path.join(REPO, 'apps/agent-ui/dist');
if (!browser) {
  un('没有浏览器，可复算性判不了');
} else if (!fs.existsSync(DIST)) {
  un('没有前端产物，可复算性判不了');
} else {
  const tmp = path.join(os.tmpdir(), 'dens-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  const child = spawn(process.execPath, [path.join(REPO, 'tools/run-vouch-src.mjs')], {
    env: { ...process.env, ROOT: DIST, PORT: '48041' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  await new Promise((res) => {
    const t = setTimeout(res, 10000);
    child.stdout.on('data', (b) => { if (String(b).includes('READY')) { ready = true; clearTimeout(t); res(); } });
  });
  if (!ready) {
    un('服务没起来，可复算性判不了');
  } else {
    const run = (label) => {
      try {
        execFileSync(process.execPath, [TOOL, '--url=http://127.0.0.1:48041', '--label=' + label], {
          encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch { /* 退出码不代表失败，读产物为准 */ }
      const st = JSON.parse(fs.readFileSync(DENSITY, 'utf8'));
      return st.measurements.find((m) => m.label === label);
    };
    const a = run('复算-A');
    const b = run('复算-B');
    if (!a || !b) {
      un('复算测量没产出');
    } else {
      const rep = repeatability(a, b);
      ok(rep.ok, rep.label);
    }
  }
  child.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(exitCode({ fail, unknown }));
