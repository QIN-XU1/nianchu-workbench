/**
 * 全量"实际写入"审计
 *
 * 用户要求：全方位验证哪些并没有做实际写入。
 * 这不是查代码有没有写，是查**数据是不是真的产生了**。
 *
 * 审计维度：
 *   A 记忆系统：11 个场景的记忆文件有没有真实内容（不只是骨架）
 *   B Sceneflow：产物是不是真的发布了、被领取了
 *   C 技能：技能文件是否被场景引用、是否有实际调用
 *   D 面板：每个场景的面板是否真渲染、有没有空壳
 *   E 会话：AI 面板是否绑定 sessionId
 *   F 事件：events.jsonl 是否有真实事件
 *   G 时间戳：文件的 mtime 是否说明"真的被写过"
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJ = String.raw`D:\file\AI Temp\DeepSeek\Agent自研`;
const WB = path.join(PROJ, 'workbench');
const MEM = path.join(WB, '引擎数据', '.dsh', '场景记忆');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const findings = [];
function add(cat, item, verdict, detail) {
  findings.push({ cat, item, verdict, detail });
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

console.log(C.bold + '═'.repeat(76) + C.reset);
console.log(C.bold + '  全量"实际写入"审计' + C.reset);
console.log(C.bold + '═'.repeat(76) + C.reset);

// ═══════════════ A. 记忆系统 ═══════════════
console.log(`\n${C.cyan}${C.bold}【A】记忆系统：11 个场景的记忆文件是不是真的被写过${C.reset}\n`);

const SCAFFOLD_MARKERS = [
  '（新场景，还没有交接记录）',
  '（待补）', '（待填）', '（空）',
  '跟这个场景的 AI 说第一句',
];

let memReal = 0, memSkeleton = 0;
for (const d of fs.readdirSync(MEM).sort()) {
  const dir = path.join(MEM, d);
  if (!fs.statSync(dir).isDirectory() || d === '_共享记忆') continue;
  const f = path.join(dir, '场景私有记忆.md');
  if (!fs.existsSync(f)) continue;
  const t = fs.readFileSync(f, 'utf8');
  const st = fs.statSync(f);

  // 判断是不是"只有骨架"
  const hitMarkers = SCAFFOLD_MARKERS.filter(m => t.includes(m));
  const isSkeleton = hitMarkers.length >= 2;   // 命中 2 个以上就当骨架

  if (isSkeleton) memSkeleton++;
  else memReal++;

  const verdict = isSkeleton ? 'SCAFFOLD' : 'REAL';
  const mark = isSkeleton ? C.yellow + '骨架' + C.reset : C.green + '有内容' + C.reset;
  console.log(`  ${mark}  ${d.padEnd(12)} ${String(t.length).padStart(5)} B  mtime=${fmtTime(st.mtimeMs)}`);
  if (isSkeleton) {
    console.log(`         ${C.dim}命中占位符: ${hitMarkers.join(' | ')}${C.reset}`);
  }
  add('A-记忆', d, verdict, isSkeleton ? '只有骨架' : '有真实内容');
}
console.log(`\n  ${C.bold}小计：有内容 ${memReal} 个 · 只有骨架 ${memSkeleton} 个${C.reset}`);

// ═══════════════ B. Sceneflow 产物 ═══════════════
console.log(`\n${C.cyan}${C.bold}【B】Sceneflow：产物是不是真的发布了、被领取了${C.reset}\n`);

const ART = path.join(WB, '产物');
const EVENTS = path.join(ART, 'events.jsonl');
const INDEX = path.join(ART, 'index.json');

if (fs.existsSync(INDEX)) {
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const arts = idx.artifacts || [];
  console.log(`  索引里 ${arts.length} 个产物`);
  for (const a of arts) {
    const f = path.join(WB, a.path);
    const exists = fs.existsSync(f);
    const consumed = (a.consumedBy || []).length;
    const mark = exists ? C.green + '文件在' + C.reset : C.red + '文件没了' + C.reset;
    console.log(`  ${mark}  ${a.id.padEnd(30)} ${String(a.name).padEnd(12)} 被领 ${consumed} 次  ${fmtTime(fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)}`);
    add('B-产物', a.id, exists ? (consumed > 0 ? 'CONSUMED' : 'READY') : 'MISSING', `被领 ${consumed}`);
  }
  const consumedAny = arts.some(a => (a.consumedBy || []).length > 0);
  console.log(`\n  ${consumedAny ? C.green + '有产物被领取过' + C.reset : C.yellow + '没有一个产物被领取过 —— 流转只发生在测试里' + C.reset}`);
} else {
  console.log(`  ${C.red}没有产物索引 —— 从未发布过任何产物${C.reset}`);
  add('B-产物', '(索引)', 'MISSING', '无 index.json');
}

if (fs.existsSync(EVENTS)) {
  const lines = fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean);
  console.log(`  事件流 ${lines.length} 条`);
  for (const l of lines.slice(-5)) {
    try {
      const e = JSON.parse(l);
      console.log(`    ${fmtTime(Date.parse(e.at))}  ${e.type.padEnd(8)} ${e.scene || (e.artifact && e.artifact.fromScene) || ''}`);
    } catch { /* ignore */ }
  }
  add('B-事件', 'events.jsonl', lines.length > 0 ? 'HAS_EVENTS' : 'EMPTY', `${lines.length} 条`);
} else {
  console.log(`  ${C.red}没有事件流${C.reset}`);
}

// ═══════════════ C. 技能 ═══════════════
console.log(`\n${C.cyan}${C.bold}【C】技能：有没有被场景实际引用${C.reset}\n`);

const SKILLS = path.join(WB, '技能');
if (fs.existsSync(SKILLS)) {
  const files = [];
  for (const f of fs.readdirSync(SKILLS)) {
    if (f.endsWith('.md')) files.push({ name: f, path: path.join(SKILLS, f) });
  }
  for (const f of files) {
    // 有没有场景契约引用它
    const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');
    let referencedBy = [];
    if (fs.existsSync(CONTRACTS)) {
      for (const c of fs.readdirSync(CONTRACTS).filter(x => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(CONTRACTS, c), 'utf8'));
        if (j.skill && j.skill.includes(f.name.replace('.md', ''))) referencedBy.push(j.id);
      }
    }
    const st = fs.statSync(f.path);
    console.log(`  ${referencedBy.length ? C.green + '被引用' + C.reset : C.yellow + '未被引用' + C.reset}  ${f.name.padEnd(36)} ${fmtTime(st.mtimeMs)}  ← ${referencedBy.join(',') || '无'}`);
    add('C-技能', f.name, referencedBy.length ? 'REFERENCED' : 'ORPHAN', referencedBy.join(','));
  }

  // 技能目录下的参考文件
  const subDirs = fs.readdirSync(SKILLS).filter(f => fs.statSync(path.join(SKILLS, f)).isDirectory());
  for (const sd of subDirs) {
    const refs = fs.readdirSync(path.join(SKILLS, sd)).filter(f => f.endsWith('.md'));
    console.log(`  ${C.dim}参考子目录 ${sd}/: ${refs.length} 个文件${C.reset}`);
  }
} else {
  console.log(`  ${C.red}没有技能目录${C.reset}`);
}

// ═══════════════ D. 面板渲染 ═══════════════
console.log(`\n${C.cyan}${C.bold}【D】场景面板：每个场景的面板构成${C.reset}\n`);

const SC_DIR = path.join(WB, '外壳', 'scenarios');
const scenes = [];
for (const f of fs.readdirSync(SC_DIR).filter(x => x.endsWith('.json') && !x.startsWith('_'))) {
  try { scenes.push(JSON.parse(fs.readFileSync(path.join(SC_DIR, f), 'utf8').replace(/\uFEFF/g, ''))); } catch { /* ignore */ }
}

let totalPanels = 0, emptyHarness = 0;
for (const sc of scenes) {
  const panels = sc.panels || [];
  totalPanels += panels.length;
  const harness = panels.filter(p => p.type === 'harness');
  const noSession = harness.filter(p => !p.sessionId);
  emptyHarness += noSession.length;
  const mark = noSession.length > 0 ? C.yellow + '有空格' + C.reset : C.green + '全绑' + C.reset;
  console.log(`  ${mark}  ${String(sc.id).padEnd(20)} 面板 ${panels.length} 个` +
    (harness.length ? `  AI ${harness.length} 个（未绑 ${noSession.length}）` : '  （无 AI 面板）'));
}
console.log(`\n  ${C.bold}合计 ${totalPanels} 个面板 · AI 面板未绑会话 ${emptyHarness} 个${C.reset}`);

// ═══════════════ E. 会话绑定 ═══════════════
console.log(`\n${C.cyan}${C.bold}【E】AI 会话：有没有真的绑定${C.reset}\n`);

const SCENES_ROOT = path.join(WB, '引擎数据', '.dsh', 'sessions');
let sessionDirs = [];
if (fs.existsSync(SCENES_ROOT)) {
  for (const ws of fs.readdirSync(SCENES_ROOT)) {
    const wsDir = path.join(SCENES_ROOT, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const sid of fs.readdirSync(wsDir)) {
      const sd = path.join(wsDir, sid);
      if (fs.statSync(sd).isDirectory()) sessionDirs.push({ ws, sid, path: sd });
    }
  }
}
console.log(`  引擎数据/.dsh/sessions 下 ${sessionDirs.length} 个会话目录`);
for (const s of sessionDirs.slice(0, 10)) {
  console.log(`    ${s.ws.slice(-20)} / ${s.sid.slice(0, 12)}`);
}
if (sessionDirs.length === 0) {
  console.log(`  ${C.red}没有任何会话 —— AI 面板全部是空壳${C.reset}`);
}

// 检查 .identity.json
const identityFiles = [];
if (fs.existsSync(MEM)) {
  for (const d of fs.readdirSync(MEM)) {
    const dir = path.join(MEM, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    const idf = path.join(dir, '.identity.json');
    if (fs.existsSync(idf)) {
      try {
        const j = JSON.parse(fs.readFileSync(idf, 'utf8'));
        identityFiles.push({ scene: d, sessionId: j.sessionId || '(空)' });
      } catch { identityFiles.push({ scene: d, sessionId: '(解析失败)' }); }
    }
  }
}
console.log(`\n  .identity.json: ${identityFiles.length} 个`);
for (const i of identityFiles) console.log(`    ${i.scene.padEnd(12)} sessionId=${i.sessionId}`);

// ═══════════════ F. 配置文件 ═══════════════
console.log(`\n${C.cyan}${C.bold}【F】配置文件：有没有被真实使用${C.reset}\n`);

const DATA = path.join(WB, '外壳', 'data');
if (fs.existsSync(DATA)) {
  for (const f of fs.readdirSync(DATA)) {
    const p = path.join(DATA, f);
    const st = fs.statSync(p);
    console.log(`  ${f.padEnd(30)} ${String(st.size).padStart(6)} B  ${fmtTime(st.mtimeMs)}`);
  }
}

// ═══════════════ 总结 ═══════════════
console.log(`\n${C.bold}${'═'.repeat(76)}${C.reset}`);
console.log(`${C.bold}  审计汇总${C.reset}`);
console.log(`${C.bold}${'═'.repeat(76)}${C.reset}\n`);

const byVerdict = {};
for (const f of findings) {
  byVerdict[f.verdict] = (byVerdict[f.verdict] || 0) + 1;
}
console.log('  按结论分组：');
for (const [v, n] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) {
  const color = v === 'REAL' || v === 'CONSUMED' || v === 'REFERENCED' || v === 'HAS_EVENTS' ? C.green
    : v === 'SCAFFOLD' || v === 'ORPHAN' || v === 'READY' ? C.yellow : C.red;
  console.log(`    ${color}${v.padEnd(12)}${C.reset} ${n} 项`);
}

// 落盘
const report = {
  at: new Date().toISOString(),
  memory: { real: memReal, skeleton: memSkeleton },
  panels: { total: totalPanels, aiUnbound: emptyHarness },
  sessions: sessionDirs.length,
  findings,
};
fs.writeFileSync(path.join(PROJ, 'prototype', 'write-audit.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\n  ${C.dim}报告：prototype/write-audit.json${C.reset}`);
