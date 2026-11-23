#!/usr/bin/env node
/**
 * 基线快照 —— 记录当前所有可测指标的当前值
 *
 * 为什么必须做（原项目判据）：
 *   "没有基线，'进化'无法验证。"
 *   说"变好了"必须有参照系，否则只是感觉。
 *
 * 用法：
 *   node 工具/基线.mjs              # 打印基线
 *   node 工具/基线.mjs --save       # 写入 _共享记忆/基线.json
 *   node 工具/基线.mjs --compare    # 与上次基线对比，输出变化
 *
 * 设计原则：
 *   ① 只读，不改任何东西
 *   ② 每个指标都必须可复算（不是"感觉")
 *   ③ 输出 JSON，可被其他工具消费
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');
const SHARED = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆');
const BASELINE_FILE = path.join(SHARED, '基线.json');

// ══════════════════════════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════════════════════════

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

function listFiles(dir, filter) {
  const out = [];
  function walk(d) {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (!filter || filter(p)) out.push(p);
    }
  }
  walk(dir);
  return out;
}

function dirSize(dir) {
  return listFiles(dir).reduce((s, f) => {
    try { return s + fs.statSync(f).size; } catch { return s; }
  }, 0);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function bytes(s) {
  return Buffer.byteLength(s, 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  采集指标
// ══════════════════════════════════════════════════════════════

function collect() {
  const m = {};

  // ── 1. 场景规模 ──
  const scenDir = path.join(WB, '外壳', 'scenarios');
  const scenFiles = fs.existsSync(scenDir)
    ? fs.readdirSync(scenDir).filter(f => f.endsWith('.json'))
    : [];
  m.场景总数 = scenFiles.length;

  // ── 2. 六件套覆盖率 ──
  const memRoot = path.join(WB, '数据', '.dsh', '场景记忆');
  const reg = readJson(path.join(SHARED, '索引.json'), { areas: [] });
  const areas = reg.areas || [];

  const coverage = { 定位卡: 0, 身份卡: 0, 私有记忆: 0, 会话绑定: 0, 专属技能: 0 };
  for (const a of areas) {
    const sid = a.id, name = a.name;
    if (fs.existsSync(path.join(scenDir, sid + '-context.md'))) coverage.定位卡++;
    if (fs.existsSync(path.join(memRoot, name, '身份卡.md'))) coverage.身份卡++;
    if (fs.existsSync(path.join(memRoot, name, '场景私有记忆.md'))) coverage.私有记忆++;
    const sj = path.join(scenDir, sid + '.json');
    if (fs.existsSync(sj)) {
      const sc = readJson(sj, {});
      // 会话绑定判据（2026-11-10 修正）：
      //   旧判据 `p.sessionId` 永远为假 —— 配置里根本没有这个字段，
      //   导致覆盖率被误报为 7/9。
      //   真判据：有 harness 类型面板（常规场景），
      //          或中枢这类对话由外壳固定挂载的场景（shell-side）。
      const panels = sc.panels || [];
      const hasHarness = panels.some(p => p.type === 'harness');
      const note = (sc.meta && sc.meta.note) || '';
      const shellMounted = note.includes('shell') || note.includes('外壳');
      const hasNeuronFirst = panels.some(p => p.type === 'neuron') && sc.first;
      if (hasHarness || shellMounted || hasNeuronFirst) coverage.会话绑定++;
    }
    const skillsDir = path.join(WB, '数据', '.dsh', 'skills');
    if (fs.existsSync(skillsDir)) {
      const found = fs.readdirSync(skillsDir).some(f => f.includes(sid));
      if (found) coverage.专属技能++;
    }
  }
  m.六件套 = coverage;
  m.六件套覆盖率 = areas.length
    ? Object.entries(coverage).reduce((s, [, v]) => s + v, 0) / (areas.length * 5)
    : 0;

  // ── 3. 真实使用痕迹（最关键指标）──
  //
  //  ★ 自检修复：原判据是"场景记忆里有没有模板标志词"
  //     但真实跑过任务后 §〇 可能还没更新，仍被误判为模板
  //     更准的判据：**派单台账里有没有真实完成的派单**
  const dates = new Set();
  if (fs.existsSync(memRoot)) {
    for (const d of fs.readdirSync(memRoot, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue;
      const memFile = path.join(memRoot, d.name, '场景私有记忆.md');
      if (!fs.existsSync(memFile)) continue;
      const t = fs.readFileSync(memFile, 'utf8');
      for (const dm of t.matchAll(/202\d-\d\d-\d\d/g)) dates.add(dm[0]);
    }
  }

  // 从派单台账算真实使用
  const sharedDir = path.join(memRoot, '_共享记忆');
  let dispatches = [];
  try {
    const lf = path.join(sharedDir, '派单台账.json');
    if (fs.existsSync(lf)) {
      let s = fs.readFileSync(lf, 'utf8');
      if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
      dispatches = (JSON.parse(s).dispatches || []);
    }
  } catch { /* 忽略 */ }

  // 有真实完成（acked/closed）派单的场景
  const scenesWithRealWork = new Set();
  let completedDispatches = 0;
  for (const d of dispatches) {
    if (d.type !== 'dispatch') continue;
    const done = d.state === 'acked' || d.state === 'closed' || !!d.ackedAt;
    if (done) {
      completedDispatches++;
      if (d.to) scenesWithRealWork.add(d.to);
      if (d.from) scenesWithRealWork.add(d.from);
    }
  }

  // 场景总数（从注册表）
  let totalScenes = 0;
  try {
    const rf = path.join(sharedDir, '索引.json');
    if (fs.existsSync(rf)) {
      let s = fs.readFileSync(rf, 'utf8');
      if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
      totalScenes = (JSON.parse(s).areas || []).length;
    }
  } catch { /* 忽略 */ }

  m.总场景数 = totalScenes;
  m.真实使用场景数 = scenesWithRealWork.size;
  m.已完成派单数 = completedDispatches;
  m.派单台账条数 = dispatches.length;
  m.真实使用率 = totalScenes > 0 ? scenesWithRealWork.size / totalScenes : 0;
  m.记忆中出现的日期数 = dates.size;
  m.最近记忆日期 = dates.size ? [...dates].sort().pop() : null;

  // ── 4. 记忆体量（红线是 4KB / 25KB）──
  const sizes = [];
  if (fs.existsSync(memRoot)) {
    for (const d of fs.readdirSync(memRoot, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue;
      const f = path.join(memRoot, d.name, '场景私有记忆.md');
      if (fs.existsSync(f)) {
        const t = fs.readFileSync(f, 'utf8');
        sizes.push({ name: d.name, bytes: bytes(t) });
      }
    }
  }
  m.私有记忆平均字节 = sizes.length
    ? Math.round(sizes.reduce((s, x) => s + x.bytes, 0) / sizes.length)
    : 0;
  m.私有记忆最大字节 = sizes.length ? Math.max(...sizes.map(x => x.bytes)) : 0;
  m.超限场景数_4KB = sizes.filter(x => x.bytes > 4096).length;
  m.超限场景数_25KB = sizes.filter(x => x.bytes > 25600).length;

  // ── 5. 注入层大小（红线 2KB）──
  const agents = path.join(WB, '数据', '.dsh', 'AGENTS.md');
  m.注入层字节 = fs.existsSync(agents) ? bytes(fs.readFileSync(agents, 'utf8')) : 0;
  m.注入层超限 = m.注入层字节 > 2048;

  // ── 6. 检查能力（工具里有多少能 exit 非 0）──
  const toolsDir = path.join(WB, '工具');
  const tools = fs.existsSync(toolsDir)
    ? fs.readdirSync(toolsDir).filter(f => f.endsWith('.mjs'))
    : [];
  let exitTools = 0, mutationTests = 0;
  for (const t of tools) {
    const src = fs.readFileSync(path.join(toolsDir, t), 'utf8');
    if (/process\.exit\(\s*[1-9]/.test(src)) exitTools++;
    if (/mutation|变异/.test(src)) mutationTests++;
  }
  m.工具总数 = tools.length;
  m.含exit非0的工具数 = exitTools;
  m.含变异测试的工具数 = mutationTests;

  // ── 7. 验证实验（challenges）──
  const chalDir = path.join(ROOT, 'challenges');
  const challenges = fs.existsSync(chalDir)
    ? fs.readdirSync(chalDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name)
    : [];
  m.验证实验数 = challenges.length;
  let hasSelftest = 0;
  for (const c of challenges) {
    const st = path.join(chalDir, c, 'selftest.mjs');
    if (fs.existsSync(st)) hasSelftest++;
  }
  m.含自动化变异测试的实验数 = hasSelftest;

  // ── 8. 文档与实现的比例 ──
  const plans = fs.existsSync(path.join(ROOT, '方案'))
    ? fs.readdirSync(path.join(ROOT, '方案')).filter(f => f.endsWith('.md')).length
    : 0;
  m.方案文档数 = plans;
  m.文档实现比 = exitTools > 0 ? Math.round(plans / exitTools * 10) / 10 : null;

  // ── 9. 崩溃日志（真实失败指标）──
  const crashLog = path.join(WB, '外壳', 'data', 'crash-log.jsonl');
  if (fs.existsSync(crashLog)) {
    const lines = fs.readFileSync(crashLog, 'utf8').split('\n').filter(Boolean);
    m.崩溃记录数 = lines.length;
    const kinds = {};
    for (const l of lines) {
      try { const j = JSON.parse(l); kinds[j.kind] = (kinds[j.kind] || 0) + 1; } catch {}
    }
    m.崩溃类型分布 = kinds;
  } else {
    m.崩溃记录数 = 0;
  }

  // ── 10. 代码规模 ──
  const uiDir = path.join(WB, '外壳', 'ui');
  if (fs.existsSync(uiDir)) {
    const jsFiles = listFiles(uiDir, p => p.endsWith('.js'));
    m.前端文件数 = jsFiles.length;
    m.前端总行数 = jsFiles.reduce((s, f) => {
      try { return s + fs.readFileSync(f, 'utf8').split('\n').length; } catch { return s; }
    }, 0);
    // 找出最大的文件
    const withSize = jsFiles.map(f => ({ f: path.basename(f), lines: fs.readFileSync(f, 'utf8').split('\n').length }));
    withSize.sort((a, b) => b.lines - a.lines);
    m.最大前端文件 = withSize[0] || null;
    m.超过1000行的前端文件数 = withSize.filter(x => x.lines > 1000).length;
  }

  // ── 11. 工具链总行数 ──
  m.工具总行数 = tools.reduce((s, t) => {
    try { return s + fs.readFileSync(path.join(toolsDir, t), 'utf8').split('\n').length; } catch { return s; }
  }, 0);

  return m;
}

// ══════════════════════════════════════════════════════════════
//  输出
// ══════════════════════════════════════════════════════════════

function fmt(v) {
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return (v * 100).toFixed(1) + '%';
  }
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

function print(m) {
  console.log('═'.repeat(66));
  console.log('  基线快照  ' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  console.log('═'.repeat(66));
  console.log();

  const groups = [
    ['规模', ['场景总数', '方案文档数', '工具总数', '前端文件数', '前端总行数', '工具总行数']],
    ['六件套', ['六件套', '六件套覆盖率']],
    ['★ 真实使用（最关键）', ['总场景数', '真实使用场景数', '真实使用率', '已完成派单数', '派单台账条数', '最近记忆日期']],
    ['体量红线', ['注入层字节', '注入层超限', '私有记忆平均字节', '私有记忆最大字节', '超限场景数_4KB', '超限场景数_25KB']],
    ['检查能力', ['含exit非0的工具数', '含变异测试的工具数', '验证实验数', '含自动化变异测试的实验数']],
    ['真实失败', ['崩溃记录数', '崩溃类型分布']],
    ['代码健康', ['最大前端文件', '超过1000行的前端文件数', '文档实现比']],
  ];

  for (const [title, keys] of groups) {
    console.log('【' + title + '】');
    for (const k of keys) {
      if (m[k] === undefined) continue;
      const mark = (k === '真实使用率' && m[k] === 0) ? '  ← 致命：系统从未被真实使用' : '';
      console.log('  ' + k.padEnd(24, '　') + fmt(m[k]) + mark);
    }
    console.log();
  }

  console.log('═'.repeat(66));
  console.log('  健康判定');
  console.log('═'.repeat(66));
  const issues = [];
  if (m.真实使用率 === 0) issues.push('✗ 真实使用率 0%：没有任何场景完成过真实派单');
  else if (m.真实使用率 < 0.5) issues.push('⚠ 真实使用率 ' + Math.round(m.真实使用率 * 100) + '%：大部分场景还没跑过真实任务');
  if (m.注入层超限) issues.push('✗ 注入层超 2KB');
  if (m.超限场景数_4KB > 0) issues.push('✗ ' + m.超限场景数_4KB + ' 个场景 §〇 超 4KB');
  if (m.含变异测试的工具数 === 0) issues.push('✗ 20 个工具里 0 个有变异测试（检查是否真会失败，未知）');
  if (m.专属技能 === 0) issues.push('✗ 专属技能覆盖 0');
  if (m.超过1000行的前端文件数 > 0) issues.push('⚠ ' + m.超过1000行的前端文件数 + ' 个前端文件超 1000 行');

  if (issues.length === 0) {
    console.log('  ✅ 全部达标');
  } else {
    for (const i of issues) console.log('  ' + i);
  }
  console.log();
}

function compare(oldB, newB) {
  console.log('═'.repeat(66));
  console.log('  基线对比');
  console.log('═'.repeat(66));
  console.log('  旧: ' + (oldB._at || '?'));
  console.log('  新: ' + newB._at);
  console.log();

  const keys = new Set([...Object.keys(oldB), ...Object.keys(newB)]);
  let changed = 0;
  for (const k of keys) {
    if (k.startsWith('_')) continue;
    const a = oldB[k], b = newB[k];
    if (typeof a === 'number' && typeof b === 'number') {
      if (a !== b) {
        const delta = b - a;
        const arrow = delta > 0 ? '↑' : '↓';
        console.log('  ' + k.padEnd(24, '　') + fmt(a) + ' → ' + fmt(b) + '  ' + arrow + Math.abs(delta));
        changed++;
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      console.log('  ' + k.padEnd(24, '　') + JSON.stringify(a) + ' → ' + JSON.stringify(b));
      changed++;
    }
  }

  if (changed === 0) console.log('  无变化');
  console.log();
  console.log('  变化项: ' + changed);
  console.log();
}

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const m = collect();
m._at = new Date().toISOString();

if (args.includes('--save')) {
  fs.mkdirSync(SHARED, { recursive: true });
  // 保留历史
  if (fs.existsSync(BASELINE_FILE)) {
    const old = readJson(BASELINE_FILE, null);
    if (old && old._at) {
      const histDir = path.join(SHARED, '基线历史');
      fs.mkdirSync(histDir, { recursive: true });
      const name = old._at.replace(/[:.]/g, '-') + '.json';
      fs.writeFileSync(path.join(histDir, name), JSON.stringify(old, null, 2), 'utf8');
    }
  }
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(m, null, 2), 'utf8');
  print(m);
  console.log('已保存: ' + path.relative(ROOT, BASELINE_FILE));
} else if (args.includes('--compare')) {
  const old = readJson(BASELINE_FILE, null);
  if (!old) {
    console.log('没有历史基线，先用 --save 建立');
    process.exit(1);
  }
  compare(old, m);
} else {
  print(m);
  console.log('提示: --save 保存为基线 / --compare 与上次对比');
}
