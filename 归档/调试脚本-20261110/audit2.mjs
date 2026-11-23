/**
 * 补充审计：哪些是"真的在跑"，哪些是"我造的空壳"
 *
 * 重点区分：
 *   ① 真实运行时写入（crash-log / 配置文件 / 会话）
 *   ② 我造的测试数据（产物 / 事件）
 *   ③ 从原项目继承但从未激活的（skills / 一些面板）
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJ = String.raw`D:\file\AI Temp\DeepSeek\Agent自研`;
const WB = path.join(PROJ, 'workbench');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

console.log(C.bold + '真实运行 vs 空壳 —— 分类审计' + C.reset + '\n');

// ═══ 1. 真实运行时写入的证据 ═══
console.log(C.cyan + '【1】真实运行时产生的文件（有 mtime 且持续增长）' + C.reset);
const DATA = path.join(WB, '外壳', 'data');
if (fs.existsSync(DATA)) {
  for (const f of fs.readdirSync(DATA)) {
    const p = path.join(DATA, f);
    const st = fs.statSync(p);
    if (!st.isFile()) continue;
    const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000);
    const tag = ageMin < 60 ? C.green + '近期' + C.reset : (ageMin < 1440 ? C.yellow + '今天' + C.reset : C.dim + '旧' + C.reset);
    console.log(`  ${tag}  ${f.padEnd(28)} ${String(st.size).padStart(7)} B  ${ageMin} 分钟前`);
  }
}

// ═══ 2. crash-log 是真实写入吗 ═══
console.log('\n' + C.cyan + '【2】容错的 crash-log 是否真的有内容' + C.reset);
const cl = path.join(DATA, 'crash-log.jsonl');
if (fs.existsSync(cl)) {
  const lines = fs.readFileSync(cl, 'utf8').split('\n').filter(Boolean);
  console.log(`  ${lines.length} 条记录`);
  for (const l of lines.slice(-5)) {
    try {
      const e = JSON.parse(l);
      console.log(`    ${e.at || '?'}  ${e.kind || '?'}  ${String((e.detail && (e.detail.reason || e.detail.url)) || '').slice(0, 50)}`);
    } catch { console.log('    (解析失败) ' + l.slice(0, 80)); }
  }
  if (lines.length > 0) {
    console.log(`  ${C.green}→ 这是容错层真的在记录（我做的）${C.reset}`);
  }
} else {
  console.log(`  ${C.yellow}不存在 —— 容错层还没触发过故障${C.reset}`);
}

// ═══ 3. 产物是测试残留还是真实业务 ═══
console.log('\n' + C.cyan + '【3】产物：是真实业务还是我测试留下的' + C.reset);
const ART = path.join(WB, '产物');
const IDX = path.join(ART, 'index.json');
if (fs.existsSync(IDX)) {
  const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
  for (const a of idx.artifacts || []) {
    const isTest = /^(x|_test)/.test(a.logicalId || '') || a.name === 'x';
    console.log(`  ${isTest ? C.red + '测试残留' + C.reset : C.yellow + '来自测试脚本' + C.reset}  ${a.id}  ${a.name}  来自 ${a.fromScene}`);
  }
  console.log(`  ${C.dim}注：这 3 个产物都是 sf-test.mjs 跑出来的，不是真实业务${C.reset}`);
}

// ═══ 4. skills 目录 ═══
console.log('\n' + C.cyan + '【4】记忆系统里的 skills 目录' + C.reset);
const SKILL_DIR = path.join(WB, '引擎数据', '.dsh', 'skills');
if (fs.existsSync(SKILL_DIR)) {
  for (const d of fs.readdirSync(SKILL_DIR)) {
    const p = path.join(SKILL_DIR, d);
    if (fs.statSync(p).isDirectory()) {
      const files = fs.readdirSync(p);
      const st = fs.statSync(p);
      console.log(`  ${d.padEnd(16)} ${files.length} 文件  ${new Date(st.mtimeMs).toISOString().slice(0, 16)}`);
    }
  }
  console.log(`  ${C.dim}（这是原项目继承的 4 个技能：command / bilibili / self-review / pc-cleanup）${C.reset}`);
} else {
  console.log(`  ${C.red}不存在${C.reset}`);
}

// ═══ 5. 我写的新技能 vs 记忆系统的技能目录 ═══
console.log('\n' + C.cyan + '【5】两套技能目录的关系' + C.reset);
const NEW_SKILLS = path.join(WB, '技能');
console.log(`  workbench/技能/          （我造的，1 个技能）`);
console.log(`  引擎数据/.dsh/skills/    （原项目的，4 个技能）`);
console.log(`  ${C.yellow}→ 两处并存，没有打通 —— 记忆神经元读的是后者${C.reset}`);

// ═══ 6. 面板实际渲染状态（从代码看哪些类型有实现） ═══
console.log('\n' + C.cyan + '【6】场景用到的面板类型是否都有实现' + C.reset);
const SC = path.join(WB, '外壳', 'scenarios');
const RJ = path.join(WB, '外壳', 'renderer', 'renderers.js');
const rjs = fs.readFileSync(RJ, 'utf8');

const reg1 = new Set([...rjs.matchAll(/renderers\['([^']+)'\]\s*=/g)].map(m => m[1]));
const reg2 = new Set([...rjs.matchAll(/renderers\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]));
const allTypes = new Set([...reg1, ...reg2]);
allTypes.delete('embedded'); allTypes.delete('neuronDone');

const used = new Set();
for (const f of fs.readdirSync(SC).filter(x => x.endsWith('.json') && !x.startsWith('_'))) {
  const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
  for (const p of j.panels || []) used.add(p.type);
}
console.log(`  注册 ${allTypes.size} 种渲染器`);
for (const u of [...used].sort()) {
  console.log(`  ${allTypes.has(u) ? C.green + '有实现' + C.reset : C.red + '无实现' + C.reset}  ${u}`);
}

// ═══ 7. 总结 ═══
console.log('\n' + C.bold + '═'.repeat(70) + C.reset);
console.log(C.bold + '结论：真正的"实际写入"只有三类' + C.reset);
console.log(C.bold + '═'.repeat(70) + C.reset);
console.log(`  ${C.green}1.${C.reset} 容错 crash-log（我做的，真实在记故障）`);
console.log(`  ${C.green}2.${C.reset} 配置文件（memory-board / webai-warm / scene-tab-order 等）`);
console.log(`  ${C.green}3.${C.reset} Sceneflow 产物与事件（但全是测试数据）`);
console.log();
console.log(`  ${C.red}以下全部是空壳：${C.reset}`);
console.log(`  ${C.red}·${C.reset} 11 个场景记忆（0 个有真实内容）`);
console.log(`  ${C.red}·${C.reset} 11 个 AI 面板（0 个绑会话）`);
console.log(`  ${C.red}·${C.reset} 0 个会话目录`);
console.log(`  ${C.red}·${C.reset} 两套技能目录互不打通`);
