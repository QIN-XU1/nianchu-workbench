/**
 * L0 平台层初始化 —— 数据目录结构
 *
 * 照 luanyujia 的七层模型，L0 是最底层：
 *   数据/.dsh/
 *     sessions/      会话存储（DSH 引擎用）
 *     场景记忆/       记忆（L3）
 *     skills/        技能
 *     MCP/           MCP 服务
 *     profiles/      配置
 *
 * 本脚本只做「建骨架 + 校验」，不写业务数据。
 *
 * 用法：
 *   node 工具\platform-init.mjs         建骨架
 *   node 工具\platform-init.mjs --check 只校验
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const DSH = path.join(WB, '数据', '.dsh');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

// ═══════ L0 目录清单（照 luanyujia 的七层）═══════
const L0_DIRS = [
  { path: 'sessions',           desc: '会话存储（引擎写入）',        required: true },
  { path: '场景记忆',            desc: '场景记忆（L3）',             required: true },
  { path: '场景记忆/_共享记忆',   desc: '共享层四块板（L4）',          required: true },
  { path: 'skills',             desc: '专属技能',                   required: true },
  { path: 'MCP',                desc: 'MCP 服务本体',                required: false },
  { path: 'profiles',           desc: '配置档',                     required: false },
  { path: '缓存',               desc: '缓存（可清）',                 required: false },
];

// ═══════ L0 关键文件清单 ═══════
const L0_FILES = [
  { path: '场景记忆/_共享记忆/索引.json',       desc: '机读索引',     create: '{"areas":[],"version":1}' },
  { path: '场景记忆/_共享记忆/索引.md',         desc: '人读索引',     create: '# 总索引\n\n（由 mem-map.mjs 生成）\n' },
  { path: '场景记忆/_共享记忆/记忆地图.json',   desc: '神经元数据源', create: '{"areas":[],"dataSources":{}}' },
  { path: '场景记忆/_共享记忆/项目.json',       desc: '项目清单',     create: '{"projects":[]}' },
  { path: '场景记忆/_共享记忆/_待办.md',        desc: '待办板',       create: '# 待办板\n\n（空）\n' },
  { path: '场景记忆/_共享记忆/_跨场景通知.md',  desc: '通知板',       create: '# 跨场景通知\n\n（空）\n' },
  { path: '场景记忆/_共享记忆/冲突.md',         desc: '冲突记录',     create: '# 冲突\n\n（空）\n' },
  { path: '场景记忆/_共享记忆/体检结果.json',    desc: '体检结果',     create: '{"at":null,"scenes":[],"summary":{}}' },
];

const isCheck = process.argv.includes('--check');
const problems = [];
const created = [];

console.log(C.bold + 'L0 平台层' + C.reset + C.dim + '  ' + DSH + C.reset);
console.log();

// ═══════ 建目录 ═══════
console.log(C.bold + '【目录】' + C.reset);
for (const d of L0_DIRS) {
  const full = path.join(DSH, d.path);
  const exists = fs.existsSync(full);
  if (!exists && !isCheck) {
    fs.mkdirSync(full, { recursive: true });
    created.push(d.path);
    console.log('  ' + C.green + '创建' + C.reset + ' ' + d.path.padEnd(28) + C.dim + d.desc + C.reset);
  } else if (exists) {
    console.log('  ' + C.green + '存在' + C.reset + ' ' + d.path.padEnd(28) + C.dim + d.desc + C.reset);
  } else {
    console.log('  ' + (d.required ? C.red + '缺失' : C.yellow + '可选缺') + C.reset + ' ' + d.path.padEnd(28) + C.dim + d.desc + C.reset);
    if (d.required) problems.push('缺目录：' + d.path);
  }
}

// ═══════ 建文件 ═══════
console.log();
console.log(C.bold + '【关键文件】' + C.reset);
for (const f of L0_FILES) {
  const full = path.join(DSH, f.path);
  const exists = fs.existsSync(full);
  if (!exists && !isCheck) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.create + '\n', 'utf8');
    created.push(f.path);
    console.log('  ' + C.green + '创建' + C.reset + ' ' + f.path.padEnd(36) + C.dim + f.desc + C.reset);
  } else if (exists) {
    console.log('  ' + C.green + '存在' + C.reset + ' ' + f.path.padEnd(36) + C.dim + f.desc + C.reset);
  } else {
    console.log('  ' + C.red + '缺失' + C.reset + ' ' + f.path.padEnd(36) + C.dim + f.desc + C.reset);
    problems.push('缺文件：' + f.path);
  }
}

// ═══════ 校验 JSON 合法性 ═══════
console.log();
console.log(C.bold + '【JSON 合法性】' + C.reset);
const jsonFiles = L0_FILES.filter(f => f.path.endsWith('.json'));
for (const f of jsonFiles) {
  const full = path.join(DSH, f.path);
  if (!fs.existsSync(full)) continue;
  try {
    JSON.parse(fs.readFileSync(full, 'utf8').replace(/\uFEFF/g, ''));
    console.log('  ' + C.green + 'OK' + C.reset + ' ' + f.path);
  } catch (e) {
    console.log('  ' + C.red + 'X ' + C.reset + ' ' + f.path + '  ' + e.message);
    problems.push('JSON 非法：' + f.path);
  }
}

// ═══════ 汇总 ═══════
console.log();
if (isCheck) {
  if (problems.length) {
    console.log(C.red + '校验失败：' + problems.length + ' 项' + C.reset);
    for (const p of problems) console.log('  · ' + p);
    process.exit(2);
  }
  console.log(C.green + 'L0 完整' + C.reset);
  process.exit(0);
}

console.log(C.green + 'L0 初始化完成' + C.reset + '  新建 ' + created.length + ' 项');
if (problems.length) {
  console.log(C.yellow + '仍有 ' + problems.length + ' 项问题' + C.reset);
}
