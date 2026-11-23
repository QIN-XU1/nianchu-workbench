/**
 * L6 架构自检 —— 一条命令看全七层
 *
 * 这是整个架构的总入口。跑完就知道哪层坏了。
 *
 * 七层依赖顺序（下层坏，上层全假）：
 *   L0 平台 → L1 执行 → L2 场景 → L3 记忆 → L4 协作 → L5 管线 → L6 验证
 *
 * 用法：
 *   node 工具\arch.mjs          全量自检
 *   node 工具\arch.mjs --json   机器可读
 *   node 工具\arch.mjs --layer L3  只看某一层
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const PROJ = path.resolve(HERE, '..', '..');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const asJson = process.argv.includes('--json');
const onlyLayer = (() => { const i = process.argv.indexOf('--layer'); return i >= 0 ? process.argv[i + 1] : ''; })();

const layers = [];
function layer(id, name, checks) {
  if (onlyLayer && onlyLayer !== id) return;
  const results = checks.map(c => {
    let ok = false, detail = '';
    try {
      const r = c.run();
      ok = r.ok; detail = r.detail || '';
    } catch (e) {
      ok = false; detail = '异常: ' + (e && e.message);
    }
    return { name: c.name, ok, detail, required: c.required !== false };
  });
  layers.push({ id, name, results });
}

// ══════════════════════════════════════════
// L0 平台层
// ══════════════════════════════════════════
const DSH = path.join(WB, '数据', '.dsh');
layer('L0', '平台层', [
  { name: '数据目录', run: () => ({ ok: fs.existsSync(DSH), detail: path.relative(PROJ, DSH) }) },
  { name: 'sessions 目录', run: () => ({ ok: fs.existsSync(path.join(DSH, 'sessions')), detail: '' }) },
  { name: '场景记忆目录', run: () => ({ ok: fs.existsSync(path.join(DSH, '场景记忆')), detail: '' }) },
  { name: 'skills 目录', run: () => ({ ok: fs.existsSync(path.join(DSH, 'skills')), detail: '' }) },
  { name: 'AGENTS.md 注入层', run: () => {
      const f = path.join(DSH, 'AGENTS.md');
      if (!fs.existsSync(f)) return { ok: false, detail: '缺失' };
      const kb = fs.statSync(f).size / 1024;
      return { ok: kb <= 2, detail: kb.toFixed(2) + ' KB / 2 KB' };
    } },
]);

// ══════════════════════════════════════════
// L1 执行层
// ══════════════════════════════════════════
layer('L1', '执行层', [
  { name: '工具目录', run: () => {
      const d = path.join(WB, '工具');
      const n = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.mjs')).length : 0;
      return { ok: n >= 5, detail: n + ' 个 .mjs' };
    } },
  { name: '工具注册表', run: () => {
      const f = path.join(WB, '工具', 'TOOLS.md');
      return { ok: fs.existsSync(f), detail: fs.existsSync(f) ? '已生成' : '需跑 tools.mjs' };
    } },
  { name: '外壳脚本', run: () => {
      const d = path.join(WB, '外壳', 'scripts');
      const n = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.mjs')).length : 0;
      return { ok: n >= 5, detail: n + ' 个脚本' };
    } },
]);

// ══════════════════════════════════════════
// L2 场景层
// ══════════════════════════════════════════
const SC = path.join(WB, '外壳', 'scenarios');
const scenes = [];
if (fs.existsSync(SC)) {
  for (const f of fs.readdirSync(SC)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
      if (j.id && j.name) scenes.push(j);
    } catch { /* ignore */ }
  }
}
layer('L2', '场景层', [
  { name: '场景定义', run: () => ({ ok: scenes.length >= 4, detail: scenes.length + ' 个场景' }) },
  { name: '定位卡', run: () => {
      const n = fs.readdirSync(SC).filter(f => f.endsWith('-context.md')).length;
      return { ok: n === scenes.length, detail: n + '/' + scenes.length };
    } },
  { name: '身份索引', run: () => {
      const f = path.join(SC, '_场景身份索引.md');
      if (!fs.existsSync(f)) return { ok: false, detail: '缺失' };
      const t = fs.readFileSync(f, 'utf8');
      const covered = scenes.filter(s => t.includes('`' + s.id + '`')).length;
      return { ok: covered === scenes.length, detail: covered + '/' + scenes.length + ' 登记' };
    } },
  { name: '场景契约', run: () => {
      const d = path.join(WB, 'sceneboard', 'scenes');
      const n = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json') && !f.startsWith('_')).length : 0;
      return { ok: n === scenes.length, detail: n + '/' + scenes.length };
    } },
  { name: 'AI 面板会话绑定', run: () => {
      const unbound = scenes.filter(s => {
        const h = (s.panels || []).find(p => p.type === 'harness');
        return h && !h.sessionId;
      }).length;
      return { ok: unbound === 0, detail: unbound + ' 个未绑', required: false };
    } },
]);

// ══════════════════════════════════════════
// L3 记忆层
// ══════════════════════════════════════════
const MEM = path.join(DSH, '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
layer('L3', '记忆层', [
  { name: '注入层体量', run: () => {
      const f = path.join(DSH, 'AGENTS.md');
      if (!fs.existsSync(f)) return { ok: false, detail: '缺失' };
      const kb = fs.statSync(f).size / 1024;
      return { ok: kb <= 2, detail: kb.toFixed(2) + ' KB' };
    } },
  { name: '私有记忆完整性', run: () => {
      const withMem = scenes.filter(s => fs.existsSync(path.join(MEM, s.name, '场景私有记忆.md'))).length;
      return { ok: withMem === scenes.length, detail: withMem + '/' + scenes.length };
    } },
  { name: '记忆体量红线', run: () => {
      let over = 0;
      for (const s of scenes) {
        const f = path.join(MEM, s.name, '场景私有记忆.md');
        if (!fs.existsSync(f)) continue;
        const kb = fs.statSync(f).size / 1024;
        if (kb > 25) over++;
      }
      return { ok: over === 0, detail: over + ' 个超 25KB' };
    } },
  { name: '共享层四块板', run: () => {
      const boards = ['_跨场景通知.md', '_待办.md', '索引.md', '体检结果.json'];
      const n = boards.filter(b => fs.existsSync(path.join(SHARED, b))).length;
      return { ok: n === 4, detail: n + '/4' };
    } },
]);

// ══════════════════════════════════════════
// L4 协作层
// ══════════════════════════════════════════
layer('L4', '协作层', [
  { name: '通知看板可写', run: () => {
      const f = path.join(SHARED, '_跨场景通知.md');
      return { ok: fs.existsSync(f), detail: fs.existsSync(f) ? '存在' : '缺失' };
    } },
  { name: '待办板可写', run: () => {
      const f = path.join(SHARED, '_待办.md');
      return { ok: fs.existsSync(f), detail: fs.existsSync(f) ? '存在' : '缺失' };
    } },
  { name: '协作工具', run: () => {
      const f = path.join(WB, '工具', 'collab.mjs');
      return { ok: fs.existsSync(f), detail: fs.existsSync(f) ? 'collab.mjs' : '缺失' };
    } },
]);

// ══════════════════════════════════════════
// L5 管线层
// ══════════════════════════════════════════
layer('L5', '管线层', [
  { name: '场景契约覆盖', run: () => {
      const d = path.join(WB, 'sceneboard', 'scenes');
      const n = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json') && !f.startsWith('_')).length : 0;
      return { ok: n === scenes.length, detail: n + '/' + scenes.length };
    } },
  { name: '管线定义', run: () => {
      const d = path.join(WB, 'sceneboard', 'pipelines');
      const n = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json') && !f.startsWith('_')).length : 0;
      return { ok: n >= 1, detail: n + ' 条管线' };
    } },
  { name: '产物索引', run: () => {
      const f = path.join(WB, '产物', 'index.json');
      if (!fs.existsSync(f)) return { ok: false, detail: '缺失' };
      const idx = JSON.parse(fs.readFileSync(f, 'utf8').replace(/\uFEFF/g, ''));
      const n = (idx.artifacts || []).length;
      // 检查每个产物文件存在
      let missing = 0;
      for (const a of idx.artifacts || []) {
        if (!fs.existsSync(path.join(WB, a.path || ''))) missing++;
      }
      return { ok: missing === 0, detail: n + ' 个产物' + (missing ? '，' + missing + ' 个文件缺失' : '') };
    } },
  { name: '事件流', run: () => {
      const f = path.join(WB, '产物', 'events.jsonl');
      if (!fs.existsSync(f)) return { ok: false, detail: '缺失' };
      const n = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
      return { ok: n > 0, detail: n + ' 条事件' };
    } },
]);

// ══════════════════════════════════════════
// L6 验证层
// ══════════════════════════════════════════
layer('L6', '验证层', [
  { name: '验证探针', run: () => {
      const d = path.join(PROJ, 'prototype');
      const n = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.mjs')).length : 0;
      return { ok: n >= 20, detail: n + ' 个探针' };
    } },
  { name: '场景验证器', run: () => {
      const f = path.join(WB, '工具', 'scene-validate.mjs');
      return { ok: fs.existsSync(f), detail: fs.existsSync(f) ? '存在' : '缺失' };
    } },
  { name: '架构自检自身', run: () => ({ ok: true, detail: 'arch.mjs（本脚本）' }) },
]);

// ══════════════════════════════════════════
// 输出
// ══════════════════════════════════════════
const report = {
  at: new Date().toISOString(),
  layers: layers.map(l => ({
    id: l.id,
    name: l.name,
    ok: l.results.filter(r => r.required !== false).every(r => r.ok),
    results: l.results,
  })),
};

const total = layers.reduce((a, l) => a + l.results.length, 0);
const passed = layers.reduce((a, l) => a + l.results.filter(r => r.ok).length, 0);
report.total = total;
report.passed = passed;
report.score = passed + '/' + total;

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(C.bold + '══════════════════════════════════════════════════════' + C.reset);
console.log(C.bold + '  架构自检 · 七层' + C.reset + C.dim + '  ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + C.reset);
console.log(C.bold + '══════════════════════════════════════════════════════' + C.reset);
console.log();

for (const l of report.layers) {
  const required = l.results.filter(r => r.required !== false);
  const layerOk = required.every(r => r.ok);
  const icon = layerOk ? C.green + '✓' : C.red + '✗';
  console.log(C.bold + icon + C.reset + ' ' + C.cyan + l.id + C.reset + ' ' + l.name);
  for (const r of l.results) {
    const mark = r.ok ? C.green + '  ✓' : (r.required === false ? C.yellow + '  !' : C.red + '  ✗');
    console.log(mark + C.reset + ' ' + r.name.padEnd(20) + C.dim + r.detail + C.reset);
  }
  console.log();
}

// 结论
const allOk = report.layers.every(l => l.ok);
console.log(C.bold + '══════════════════════════════════════════════════════' + C.reset);
if (allOk) {
  console.log(C.green + C.bold + '  全部通过  ' + report.score + C.reset);
} else {
  const bad = report.layers.filter(l => !l.ok);
  console.log(C.yellow + C.bold + '  通过 ' + report.score + C.reset);
  console.log();
  console.log(C.red + '  缺口层：' + bad.map(l => l.id).join(' ') + C.reset);
  console.log(C.dim + '  下层坏，上层全假 —— 先修最下面的' + C.reset);
}
console.log(C.bold + '══════════════════════════════════════════════════════' + C.reset);

fs.writeFileSync(path.join(WB, '工具', 'arch-report.json'), JSON.stringify(report, null, 2), 'utf8');

process.exit(allOk ? 0 : 2);
