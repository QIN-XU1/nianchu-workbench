#!/usr/bin/env node
/**
 * 定时体检 —— 固定周期跑体检 + 出报告
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV15mnJ6YELj「搭 AI 工作台」）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [10:36] **「这里要多说两句体检功能。
 *  >   我定了八类检查项，覆盖记忆、索引、技能、场景这些，
 *  >   **固定每周日跑一次，自动出一份体检报告**。
 *  >   哪里该建索引没建、哪个文件超标、哪条规矩没执行，
 *  >   一眼就能看到，然后照着报告修。
 *  >   就是靠它，整个工作台才能一直井井有条、保持健康。」**
 *
 * ══════════════════════════════════════════════════════════════
 *  我们的现状
 * ══════════════════════════════════════════════════════════════
 *
 *  有 36 项体检 / 410 个不变量，但**只能手动跑**。
 *  没有「固定周期」和「历史报告」。
 *
 * ══════════════════════════════════════════════════════════════
 *  怎么做
 * ══════════════════════════════════════════════════════════════
 *
 *  ① 记录上次跑的时间
 *  ② 检查「该跑了没」（默认 7 天）
 *  ③ 跑了就落一份报告（带时间戳，可对比历史）
 *  ④ 报告里明确写「哪里该修」
 *
 *  ⚠ 不做真正的定时器（进程不常驻）。
 *    而是「打开工作台时检查该不该跑」+ 「一条命令手动触发」。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/体检报告.mjs --check          该跑了没（不跑体检）
 *  node 工具/体检报告.mjs --run            跑体检并出报告
 *  node 工具/体检报告.mjs --run --force    强制跑（不管周期）
 *  node 工具/体检报告.mjs --history        看历史报告
 *  node 工具/体检报告.mjs --latest         看最近一份报告
 *  node 工具/体检报告.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB_DIR = path.resolve(HERE, '..');
const WB = path.resolve(WB_DIR, '..');
const REPORT_DIR = path.join(WB_DIR, '数据', '.dsh', '体检报告');
const STATE_FILE = path.join(REPORT_DIR, '_状态.json');
const HEALTH_TOOL = path.join(HERE, '机制体检.mjs');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

// ══════════════════════════════════════════════════════════════
//  周期设置
// ══════════════════════════════════════════════════════════════
export const SCHEDULE = {
  /** 多少天跑一次（他说的「每周日」= 7 天） */
  INTERVAL_DAYS: 7,
  /** 保留多少份历史报告 */
  KEEP_REPORTS: 12,
};

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function loadState() {
  const j = readJsonSafe(STATE_FILE);
  if (!j) return { lastRun: null, runs: 0 };
  return j;
}

function saveState(s) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  该不该跑
// ══════════════════════════════════════════════════════════════
export function shouldRun(opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const state = o.state || loadState();
  const interval = (o.intervalDays || SCHEDULE.INTERVAL_DAYS) * 86400000;

  if (!state.lastRun) {
    return {
      should: true,
      reason: '从未跑过体检',
      daysSince: null,
    };
  }

  const last = Date.parse(state.lastRun);
  const elapsed = now - last;
  const days = elapsed / 86400000;

  return {
    should: elapsed >= interval,
    reason: elapsed >= interval
      ? '距上次体检 ' + days.toFixed(1) + ' 天（周期 ' + (interval / 86400000) + ' 天）'
      : '距上次体检 ' + days.toFixed(1) + ' 天，还没到期（周期 ' + (interval / 86400000) + ' 天）',
    daysSince: +days.toFixed(1),
    lastRun: state.lastRun,
  };
}

// ══════════════════════════════════════════════════════════════
//  跑体检并出报告
// ══════════════════════════════════════════════════════════════
export function runHealth(opts) {
  const o = opts || {};

  // 跑机制体检
  const r = spawnSync(process.execPath, [HEALTH_TOOL], {
    cwd: WB_DIR, encoding: 'utf8', timeout: 300000, windowsHide: true,
  });

  const out = (r.stdout || '') + (r.stderr || '');
  const passed = r.status === 0;

  // 解析输出
  const lines = out.split('\n');
  const items = [];
  let summary = '';

  for (const line of lines) {
    // 匹配 "  ✓  记忆哨兵        PASS  (5 个不变量)"
    const m = line.match(/^\s+([✓✗])\s+(\S+)\s+(PASS|FAIL)\s+\((\d+)\s*个不变量\)/);
    if (m) {
      items.push({
        ok: m[1] === '✓',
        name: m[2],
        status: m[3],
        invariants: Number(m[4]),
      });
    }
    // 匹配 "结果: 36 / 36 通过   （2883ms）"
    const s = line.match(/结果:\s*(\d+)\s*\/\s*(\d+)\s*通过/);
    if (s) summary = s[1] + ' / ' + s[2];
  }

  const failed = items.filter((x) => !x.ok);
  const totalInvariants = items.reduce((a, x) => a + x.invariants, 0);

  // 生成报告
  const now = new Date(o.now || Date.now());
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const R = [];
  R.push('# 体检报告');
  R.push('');
  R.push('> 由 `工具/体检报告.mjs` 自动生成。');
  R.push('>');
  R.push('> 依据：视频 BV15mnJ6YELj');
  R.push('> 「我定了八类检查项，固定每周日跑一次，自动出一份体检报告。');
  R.push('>  哪里该建索引没建、哪个文件超标、哪条规矩没执行，');
  R.push('>  一眼就能看到，然后照着报告修。」');
  R.push('');
  R.push('- 时间：' + now.toISOString());
  R.push('- 结果：**' + (passed ? '全部通过' : failed.length + ' 项失败') + '**');
  R.push('- 项数：' + items.length + ' 项 / ' + totalInvariants + ' 个不变量');
  if (summary) R.push('- 汇总：' + summary + ' 通过');
  R.push('');
  R.push('## 明细');
  R.push('');
  R.push('| 状态 | 检查项 | 不变量数 |');
  R.push('|---|---|---|');
  for (const it of items) {
    R.push('| ' + (it.ok ? '✓' : '✗') + ' | ' + it.name + ' | ' + it.invariants + ' |');
  }
  R.push('');

  if (failed.length > 0) {
    R.push('## 🔴 需要修的地方');
    R.push('');
    for (const f of failed) {
      R.push('- **' + f.name + '** 失败');
    }
    R.push('');
    R.push('**照着改：**');
    R.push('');
    R.push('```bash');
    for (const f of failed) {
      R.push('# ' + f.name);
    }
    R.push('node workbench/工具/机制体检.mjs   # 看详细');
    R.push('```');
    R.push('');
  } else {
    R.push('## ✓ 没有需要修的地方');
    R.push('');
  }

  const report = R.join('\n');

  // 落盘
  if (o.write !== false) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'report-' + stamp + '.md'), report, 'utf8');

    // 更新状态
    const state = loadState();
    state.lastRun = now.toISOString();
    state.runs = (state.runs || 0) + 1;
    state.lastPassed = passed;
    saveState(state);

    // 清理旧报告
    const files = fs.readdirSync(REPORT_DIR)
      .filter((f) => /^report-.*\.md$/.test(f)).sort();
    if (files.length > SCHEDULE.KEEP_REPORTS) {
      for (const f of files.slice(0, files.length - SCHEDULE.KEEP_REPORTS)) {
        try { fs.unlinkSync(path.join(REPORT_DIR, f)); } catch { /* ignore */ }
      }
    }
  }

  return {
    ok: passed,
    items,
    failed,
    summary,
    totalInvariants,
    report,
    stamp,
    raw: out,
  };
}

// ══════════════════════════════════════════════════════════════
//  历史
// ══════════════════════════════════════════════════════════════
export function history() {
  if (!fs.existsSync(REPORT_DIR)) return [];
  return fs.readdirSync(REPORT_DIR)
    .filter((f) => /^report-.*\.md$/.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const content = (function () {
        try { return fs.readFileSync(path.join(REPORT_DIR, f), 'utf8'); } catch { return ''; }
      })();
      const okM = content.match(/结果：\*\*(.+?)\*\*/);
      const cntM = content.match(/项数：(\d+) 项 \/ (\d+) 个不变量/);
      return {
        file: f,
        at: f.replace(/^report-/, '').replace(/\.md$/, '').replace(/-/g, ':').replace(/:(\d\d):(\d\d)$/, ':$1:$2'),
        result: okM ? okM[1] : '?',
        items: cntM ? Number(cntM[1]) : 0,
        invariants: cntM ? Number(cntM[2]) : 0,
        allPassed: okM ? okM[1].includes('全部通过') : false,
      };
    });
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  体检报告 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 周期设置
  chk('默认 7 天周期', SCHEDULE.INTERVAL_DAYS === 7, String(SCHEDULE.INTERVAL_DAYS));
  chk('保留 12 份报告', SCHEDULE.KEEP_REPORTS === 12, String(SCHEDULE.KEEP_REPORTS));

  // ② 从没跑过 → 该跑
  const now = Date.parse('2026-11-11T00:00:00Z');
  const s1 = shouldRun({ now, state: { lastRun: null } });
  chk('从未跑过 → 该跑', s1.should === true, s1.reason);

  // ③ 刚跑过 → 不该跑
  const s2 = shouldRun({ now, state: { lastRun: new Date(now - 3600000).toISOString() } });
  chk('刚跑过 → 不该跑', s2.should === false, s2.reason);

  // ④ 8 天没跑 → 该跑
  const s3 = shouldRun({ now, state: { lastRun: new Date(now - 8 * 86400000).toISOString() } });
  chk('8 天没跑 → 该跑', s3.should === true, s3.reason);
  chk('能算出间隔天数', s3.daysSince >= 7.9, s3.daysSince + ' 天');

  // ⑤ 反例：6 天没跑 → 不该跑
  const s4 = shouldRun({ now, state: { lastRun: new Date(now - 6 * 86400000).toISOString() } });
  chk('反例：6 天没跑 → 还不该跑', s4.should === false, s4.reason);

  // ⑥ 状态读写
  chk('能读状态', typeof loadState().runs === 'number', 'runs=' + loadState().runs);

  // ⑦ 历史
  chk('能读历史', Array.isArray(history()), history().length + ' 份');

  // ⑧ 关键：能判断「该跑了没」而不是只会跑
  chk('关键：能判断该不该跑',
      s1.should === true && s2.should === false && s3.should === true,
      '定时体检的核心是「到期才跑」');

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

  // ── 检查 ──
  if (has('--check')) {
    const r = shouldRun();
    console.log('═'.repeat(72));
    console.log('  体检周期检查');
    console.log('═'.repeat(72));
    console.log();
    console.log('  周期:   每 ' + SCHEDULE.INTERVAL_DAYS + ' 天');
    console.log('  上次:   ' + (r.lastRun || '从未跑过'));
    console.log('  距今:   ' + (r.daysSince !== null ? r.daysSince + ' 天' : '—'));
    console.log();
    console.log('  ' + (r.should ? '→ 该跑体检了' : '→ 还没到期'));
    console.log('  ' + r.reason);
    console.log();
    if (r.should) {
      console.log('  跑: node 工具/体检报告.mjs --run');
    }
    process.exit(r.should ? 0 : 0);
  }

  // ── 跑 ──
  if (has('--run')) {
    const force = has('--force');
    if (!force) {
      const chk = shouldRun();
      if (!chk.should) {
        console.log('还没到期：' + chk.reason);
        console.log('（要强制跑加 --force）');
        process.exit(0);
      }
    }

    console.log('═'.repeat(72));
    console.log('  跑体检并生成报告');
    console.log('═'.repeat(72));
    console.log();

    const r = runHealth();

    console.log('  检查项: ' + r.items.length);
    console.log('  不变量: ' + r.totalInvariants);
    console.log('  结果:   ' + (r.ok ? '✓ 全部通过' : '✗ ' + r.failed.length + ' 项失败'));
    console.log();
    if (r.failed.length > 0) {
      console.log('  需要修:');
      for (const f of r.failed) console.log('    ✗ ' + f.name);
      console.log();
    }
    console.log('─'.repeat(72));
    console.log('  报告: 数据/.dsh/体检报告/report-' + r.stamp + '.md');
    console.log('─'.repeat(72));

    process.exit(r.ok ? 0 : 1);
  }

  // ── 历史 ──
  if (has('--history')) {
    const h = history();
    console.log('═'.repeat(76));
    console.log('  体检历史（' + h.length + ' 份）');
    console.log('═'.repeat(76));
    console.log();
    if (h.length === 0) {
      console.log('  还没有报告。跑 `--run` 生成第一份。');
    } else {
      for (const x of h) {
        console.log('  ' + (x.allPassed ? '✓' : '✗') + '  ' + x.at +
          '  ' + x.items + ' 项 / ' + x.invariants + ' 不变量  ' + x.result);
      }
      console.log();
      console.log('  最新: 数据/.dsh/体检报告/' + h[0].file);
    }
    process.exit(0);
  }

  // ── 最近一份 ──
  if (has('--latest')) {
    const h = history();
    if (h.length === 0) { console.error('还没有报告'); process.exit(2); }
    console.log(fs.readFileSync(path.join(REPORT_DIR, h[0].file), 'utf8'));
    process.exit(0);
  }

  // 默认：检查状态
  const r = shouldRun();
  console.log('体检状态: ' + (r.should ? '该跑了' : '还没到期'));
  console.log('  ' + r.reason);
  process.exit(0);
}
