/**
 * L1 执行层 —— 工具注册表
 *
 * 问题：工具散落在 workbench/工具 和 prototype/，没人知道有哪些、干什么、怎么用。
 * 照 luanyujia 的「工具与技能目录.md」做法：给每个工具登记一行。
 *
 * 本脚本：
 *   ① 扫描所有 .mjs 工具，提取用途与用法
 *   ② 生成 TOOLS.md（人读）+ tools.json（机读）
 *   ③ 校验：每个工具都能被 node --check 通过
 *
 * 用法：
 *   node 工具\tools.mjs            生成注册表
 *   node 工具\tools.mjs --check    只校验
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const PROJ = path.resolve(HERE, '..', '..');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const isCheck = process.argv.includes('--check');

// ═══════ 工具来源目录 ═══════
const SOURCES = [
  { dir: path.join(WB, '工具'),      layer: 'L1', scope: '工作台工具' },
  { dir: path.join(PROJ, 'prototype'), layer: 'L6', scope: '验证探针' },
];

/**
 * 从一个 .mjs 文件里提取元信息。
 * 认这几种注释格式：
 *   文件头块注释里的第一个非空行当用途
 *   CLI 用法行：形如 "用法：" 或 "node xxx.mjs"
 */
function extractMeta(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

  const name = path.basename(file);
  const lines = text.split('\n');

  // 用途：找第一段 /** */ 注释里的第一个有意义行
  let purpose = '';
  const m = text.match(/\/\*\*\s*\n([\s\S]*?)\n\s*\*\//);
  if (m) {
    for (const l of m[1].split('\n')) {
      const clean = l.replace(/^\s*\*\s?/, '').trim();
      if (clean && !/^(用法|Usage|@|参数|示例)/.test(clean)) {
        purpose = clean.replace(/[——-].*$/, '').trim();
        break;
      }
    }
  }
  if (!purpose) {
    // 退而找第一行 // 注释
    for (const l of lines) {
      const c = l.replace(/^\/\/\s?/, '').trim();
      if (l.startsWith('//') && c && c.length > 4) { purpose = c.slice(0, 60); break; }
    }
  }

  // 是否可执行 CLI（有 process.argv 处理 + 主流程）
  const isCli = /process\.argv/.test(text) && /(isMain|__isMain|isDirect)/.test(text);
  const isLibrary = /^export (function|const|class)/m.test(text) && !isCli;

  // 提取用法示例
  const usages = [];
  for (const l of lines) {
    const m2 = l.match(/(?:node\s+[^\s]*\.mjs[^\n]*)/);
    if (m2) usages.push(m2[0].trim().slice(0, 90));
  }

  const st = fs.statSync(file);
  return {
    name,
    path: path.relative(PROJ, file).replace(/\\/g, '/'),
    purpose: purpose || '（无说明）',
    kind: isCli ? 'CLI' : (isLibrary ? '库' : '脚本'),
    bytes: st.size,
    lines: text.split('\n').length,
    usages: [...new Set(usages)].slice(0, 3),
  };
}

// ═══════ 扫描 ═══════
const tools = [];
for (const src of SOURCES) {
  if (!fs.existsSync(src.dir)) continue;
  for (const f of fs.readdirSync(src.dir)) {
    if (!f.endsWith('.mjs')) continue;
    const full = path.join(src.dir, f);
    const meta = extractMeta(full);
    if (meta) {
      meta.layer = src.layer;
      meta.scope = src.scope;
      tools.push(meta);
    }
  }
}

tools.sort((a, b) => a.layer.localeCompare(b.layer) || a.name.localeCompare(b.name));

// ═══════ 校验语法 ═══════
let bad = 0;
if (isCheck) {
  console.log(C.bold + 'L1 工具语法校验' + C.reset);
  for (const t of tools) {
    const full = path.join(PROJ, t.path);
    try {
      execFileSync('node', ['--check', full], { stdio: 'ignore', timeout: 15000 });
    } catch (e) {
      console.log('  ' + C.red + 'X ' + C.reset + t.name);
      bad++;
    }
  }
  console.log(bad === 0
    ? C.green + '全部 ' + tools.length + ' 个工具语法通过' + C.reset
    : C.red + bad + ' 个工具语法失败' + C.reset);
  process.exit(bad ? 2 : 0);
}

// ═══════ 生成 TOOLS.md ═══════
const byLayer = {};
for (const t of tools) {
  (byLayer[t.layer] = byLayer[t.layer] || []).push(t);
}

let md = '# 工具注册表\n\n';
md += '> 由 `工具/tools.mjs` 自动生成。手改会被覆盖。\n\n';
md += `共 ${tools.length} 个工具。\n\n`;

for (const [layer, list] of Object.entries(byLayer)) {
  md += `## ${layer} · ${list[0].scope}\n\n`;
  md += '| 工具 | 类型 | 行数 | 用途 |\n|---|---|---|---|\n';
  for (const t of list) {
    md += `| \`${t.name}\` | ${t.kind} | ${t.lines} | ${t.purpose} |\n`;
  }
  md += '\n';
}

md += '## 常用命令\n\n```powershell\n';
md += '# 架构自检（一条命令看全七层）\nnode 工具\\arch.mjs\n\n';
md += '# 场景验证\nnode 工具\\scene-validate.mjs\n\n';
md += '# 记忆体检\nnode prototype\\mem.mjs checkall\n\n';
md += '# 管线校验\nnode 工具\\sceneflow.mjs verify\n\n';
md += '# 工作台健康度（需 CDP 端口）\nnode prototype\\wb-health.mjs\n';
md += '```\n';

fs.writeFileSync(path.join(WB, '工具', 'TOOLS.md'), md, 'utf8');
fs.writeFileSync(path.join(WB, '工具', 'tools.json'), JSON.stringify({
  at: new Date().toISOString(),
  count: tools.length,
  tools,
}, null, 2), 'utf8');

// ═══════ 输出 ═══════
console.log(C.bold + 'L1 工具注册表' + C.reset);
console.log();
for (const [layer, list] of Object.entries(byLayer)) {
  console.log(C.cyan + layer + C.reset + '  ' + list.length + ' 个（' + list[0].scope + '）');
}
console.log();
console.log(C.bold + '已生成：' + C.reset);
console.log('  workbench/工具/TOOLS.md   （人读）');
console.log('  workbench/工具/tools.json （机读）');
console.log();
console.log('共 ' + tools.length + ' 个工具');
