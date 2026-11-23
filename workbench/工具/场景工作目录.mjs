#!/usr/bin/env node
/**
 * 场景工作目录改造 —— 方案 A
 *
 * ══════════════════════════════════════════════════════════════
 *  问题（端到端闭环暴露的真实障碍）
 * ══════════════════════════════════════════════════════════════
 *
 *  场景会话的 cwd = 数据/.dsh/场景注入/<sceneId>/
 *  但要写的记忆在 数据/.dsh/场景记忆/<场景名>/
 *  → 兄弟目录，跨出 cwd → 沙箱拒绝：
 *      [sandbox: file access denied under workspace-write mode]
 *
 *  这意味着：**所有场景 agent 都写不了自己的记忆**。
 *  这是「记忆写回」这条链路的根本障碍。
 *
 * ══════════════════════════════════════════════════════════════
 *  方案 A：让 cwd 就是场景记忆目录
 * ══════════════════════════════════════════════════════════════
 *
 *  cwd 从 场景注入/<sceneId>/  改为  场景记忆/<场景名>/
 *  注入文件 AGENTS.local.md 也放进去。
 *
 *  好处：
 *    · 记忆文件在 cwd 内 → 可直接写，不触发沙箱
 *    · 场景之间仍然隔离（各自的记忆目录）
 *    · 不需要放宽沙箱模式（安全）
 *
 *  代价：
 *    · 记忆目录里多一个 AGENTS.local.md（可接受，它是场景上下文）
 *    · 旧的 场景注入/ 目录作废
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const MEM_ROOT = path.join(DATA_ROOT, '场景记忆');
const INJECT_ROOT = path.join(DATA_ROOT, '场景注入');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  场景 id → 记忆目录名
// ══════════════════════════════════════════════════════════════
function sceneIdToMemName() {
  const map = {};
  if (!fs.existsSync(SCEN_DIR)) return map;
  for (const f of fs.readdirSync(SCEN_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readTextSafe(path.join(SCEN_DIR, f)));
      if (j.id) map[j.id] = j.name || j.id;
    } catch { /* ignore */ }
  }
  return map;
}

/** 新 cwd：场景记忆目录 */
export function sceneWorkDir(sceneId, memRoot, idMap) {
  const root = memRoot || MEM_ROOT;
  const map = idMap || sceneIdToMemName();
  const name = map[sceneId];
  if (!name) return null;
  return path.join(root, name);
}

const changes = [];
const idMap = sceneIdToMemName();

console.log('═'.repeat(72));
console.log('  场景工作目录改造（方案 A）');
console.log('═'.repeat(72));
console.log();

// ══════════════════════════════════════════════════════════
//  ① 把 AGENTS.local.md 从 场景注入/ 移到 场景记忆/
// ══════════════════════════════════════════════════════════
console.log('① 迁移注入文件');

for (const [sceneId, sceneName] of Object.entries(idMap)) {
  const oldFile = path.join(INJECT_ROOT, sceneId, 'AGENTS.local.md');
  const newDir = path.join(MEM_ROOT, sceneName);
  const newFile = path.join(newDir, 'AGENTS.local.md');

  if (!fs.existsSync(oldFile)) {
    console.log('  ○ ' + sceneName.padEnd(12) + '（无注入文件，跳过）');
    continue;
  }
  if (!fs.existsSync(newDir)) {
    console.log('  ✗ ' + sceneName.padEnd(12) + '（记忆目录不存在）');
    continue;
  }

  const content = readTextSafe(oldFile);
  if (content === null) {
    console.log('  ✗ ' + sceneName.padEnd(12) + '（读不到）');
    continue;
  }

  if (has('--apply')) {
    fs.writeFileSync(newFile, content, 'utf8');
    console.log('  ✓ ' + sceneName.padEnd(12) + '→ ' + path.relative(ROOT(), newFile).replace(/\\/g, '/'));
  } else {
    console.log('  · ' + sceneName.padEnd(12) + '（预览）→ ' + path.relative(ROOT(), newFile).replace(/\\/g, '/'));
  }
  changes.push({ sceneId, sceneName, from: oldFile, to: newFile });
}

function ROOT() { return path.resolve(WB, '..'); }

console.log();
console.log('  迁移 ' + changes.length + ' 个文件');
console.log();

// ══════════════════════════════════════════════════════════
//  ② 验证：新 cwd 下记忆文件是否可写
// ══════════════════════════════════════════════════════════
console.log('② 验证新 cwd 的边界');
for (const [sceneId, sceneName] of Object.entries(idMap)) {
  const cwd = path.join(MEM_ROOT, sceneName);
  const memFile = path.join(cwd, '场景私有记忆.md');
  const injectFile = path.join(cwd, 'AGENTS.local.md');
  const memInside = memFile.startsWith(cwd + path.sep);
  const injectInside = injectFile.startsWith(cwd + path.sep);
  console.log('  ' + sceneName.padEnd(12) +
    ' 记忆在cwd内=' + (memInside ? '✓' : '✗') +
    ' 注入在cwd内=' + (fs.existsSync(injectFile) ? (injectInside ? '✓' : '✗') : '待迁移'));
}

console.log();
if (!has('--apply')) {
  console.log('（预览模式。加 --apply 真迁移）');
} else {
  console.log('✓ 迁移完成');
  console.log();
  console.log('下一步：');
  console.log('  1. 改 投递通道.mjs 的 sceneInjectDir → 返回场景记忆目录');
  console.log('  2. 重建场景会话（旧会话的 cwd 还是 场景注入/）');
  console.log('  3. 重跑端到端闭环');
}
