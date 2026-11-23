/**
 * 场景六件套完备度检查（对应 luanyujia 的六件套 + 我们的实现）
 *
 * 六件套：
 *   1 场景配置 scene.json        ✅ 已有
 *   2 定位卡 CONTEXT.md          ❌ 待建
 *   3 场景记忆 MEMORY.md         ✅ docs-index 已有
 *   4 专属技能 SKILL.md          ❌ 待建
 *   5 专属面板（workbench）        ⚠️ 状态条已有
 *   6 常驻会话 + 身份索引 .identity.json  ❌ 待建
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const PROTOTYPE = join(HERE, '..');
const SCENES = join(PROTOTYPE, 'scenes');

const PARTS = [
  { key: 'config', file: 'scene.json', label: '场景配置' },
  { key: 'context', file: 'CONTEXT.md', label: '定位卡' },
  { key: 'memory', file: 'MEMORY.md', label: '场景记忆' },
  { key: 'skill', file: 'SKILL.md', label: '专属技能' },
  { key: 'identity', file: '.identity.json', label: '身份索引' },
];

let lines = [];
let totalDone = 0, totalMax = 0;
const rows = [];

for (const s of readdirSync(SCENES)) {
  const dir = join(SCENES, s);
  try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }

  const parts = PARTS.map(p => ({ ...p, has: existsSync(join(dir, p.file)) }));
  const done = parts.filter(p => p.has).length;
  totalDone += done;
  totalMax += parts.length;

  rows.push({ id: s, done, missing: parts.filter(p => !p.has).map(p => p.label) });
}

console.log('场景六件套完备度');
console.log('='.repeat(70));
for (const r of rows) {
  const pct = Math.round((r.done / PARTS.length) * 100);
  console.log(`${r.id.padEnd(22)} ${r.done}/${PARTS.length} (${pct}%)  ${r.missing.length ? '缺: ' + r.missing.join(', ') : '完整'}`);
}
console.log('='.repeat(70));
console.log(`合计：${totalDone}/${totalMax} (${Math.round((totalDone / totalMax) * 100)}%)`);
