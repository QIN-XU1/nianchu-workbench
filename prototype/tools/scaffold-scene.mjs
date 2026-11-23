/**
 * 场景骨架生成器（六件套）
 *
 * 对应 luanyujia 的六件套：
 *   1 scene.json        — 场景配置（已有）
 *   2 CONTEXT.md        — 定位卡（职责/资产/触发词/铁律/上次进度）
 *   3 MEMORY.md         — 场景记忆（§〇 交接 ≤4KB + 核心职责）
 *   4 SKILL.md          — 专属技能（name + description 常驻，正文按需）
 *   5 .identity.json    — 身份索引（会话 id ↔ 场景/面板/卡/技能/记忆）
 *   6 panel             — 专属面板（由 DSH 插件提供，默认状态条）
 *
 * 用法：
 *   node tools/scaffold-scene.mjs <sceneId> "<场景名>" "<一句话职责>"
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const PROTOTYPE = join(HERE, '..');
const SCENES = join(PROTOTYPE, 'scenes');

const [, , idArg, nameArg, dutyArg] = process.argv;

if (!idArg) {
  console.log('用法：node tools/scaffold-scene.mjs <sceneId> "<场景名>" "<一句话职责>"');
  console.log('例：  node tools/scaffold-scene.mjs docs-review "文档复核" "保证文档索引完整且无幽灵链接"');
  process.exit(2);
}

const id = idArg;
const name = nameArg || id;
const duty = dutyArg || '（待补：这个场景负责什么）';
const dir = join(SCENES, id);

if (existsSync(dir)) {
  console.log(`场景已存在：${dir}`);
  console.log('（不会覆盖。要补件请直接手写对应文件）');
  process.exit(1);
}

mkdirSync(join(dir, 'data'), { recursive: true });
mkdirSync(join(dir, 'baseline'), { recursive: true });

// ---- 1. scene.json ----
writeFileSync(join(dir, 'scene.json'), JSON.stringify({
  id,
  name,
  desc: duty,
  check: 'check.mjs',
  baselineDir: 'baseline',
  protects: ['completeness', 'uniqueness'],
}, null, 2), 'utf8');

// ---- 2. CONTEXT.md（定位卡）----
writeFileSync(join(dir, 'CONTEXT.md'), [
  `# 定位卡 · ${name}`,
  '',
  '> 这张卡回答：**我是谁 · 我负责什么 · 我能碰什么 · 我怎么被触发 · 我的铁律**。',
  '> ⛔ 引擎不会自动注入它 —— 必须由会话开场「认领身份」后主动读。',
  '',
  '## 1. 身份与职责',
  '',
  `- **场景**：${name}（\`${id}\`）`,
  `- **负责**：${duty}`,
  '- **不碰**：⛔ （待补：这个场景明确不做什么）',
  '',
  '## 2. 资产地图',
  '',
  '| 资产 | 位置 | 说明 |',
  '|---|---|---|',
  '| 真实数据 | `data/` | 要检查的对象（可以有问 题） |',
  '| 干净基线 | `baseline/` | 门禁用它证明 check 不是恒定失败 |',
  '| 判定脚本 | `check.mjs` | exit 0=通过；非0=失败且必须输出差异集合 |',
  '| 场景记忆 | `MEMORY.md` | §〇 交接（≤4KB）+ 核心职责 |',
  '',
  '## 3. 触发词 → 定位',
  '',
  '| 触发词 | 该做什么 |',
  '|---|---|',
  '| （待补） | （待补：用户说这句话时就该跑这个场景） |',
  '',
  '## 4. 标准流程',
  '',
  '1. 跑 `sea check <场景id>` 看差异',
  '2. 差异 > 0 → 定位到具体数据项',
  '3. 修数据或修 check（注意：改 check 必须重跑门禁）',
  '4. 收工前把进度写进 `MEMORY.md` 的 §〇',
  '',
  '## 5. 铁律',
  '',
  '- ⛔ 不改 `baseline/`（它是门禁的参照物）',
  '- ⛔ 改 `check.mjs` 后必须重跑门禁认证',
  '- ⛔ 场景记忆超红线必须先归档，不许硬塞',
  '',
  '## 6. 上次进度',
  '',
  '（由 `MEMORY.md` 的 §〇 提供，这里只放指针）',
  '',
].join('\n'), 'utf8');

// ---- 3. MEMORY.md（场景记忆）----
writeFileSync(join(dir, 'MEMORY.md'), [
  `# 场景记忆 · ${name}`,
  '',
  '## 核心职责',
  '',
  `- ${duty}`,
  '- 不碰：⛔ （待补）',
  '',
  '## §〇 当前交接',
  '',
  '### 1) 上次交接',
  '',
  '- 尚未开始（场景刚建立）',
  '',
  '### 2) 当前项目',
  '',
  '| 项目 | 记忆文件 | 状态 | 下一步 |',
  '|---|---|---|---|',
  `| ${name} | 本文件 | 待启动 | 写 check.mjs 并过门禁 |`,
  '',
  '### 3) 私有记忆变更',
  '',
  '- 无',
  '',
  '### 4) 下一步 / 卡点',
  '',
  '- 下一步：① 放 `data/` 与 `baseline/` ② 写 `check.mjs` ③ 过门禁',
  '- 卡点：无',
  '',
  '### 5) 全貌（工具生成，别手改）',
  '',
  '（留空，由工具填充）',
  '',
].join('\n'), 'utf8');

// ---- 4. SKILL.md（专属技能）----
writeFileSync(join(dir, 'SKILL.md'), [
  `---`,
  `name: ${id}`,
  `description: ${duty}。当用户要检查/修复与「${name}」相关的数据一致性时使用。`,
  `---`,
  '',
  `# ${name} 场景技能`,
  '',
  '## 什么时候用',
  '',
  `${duty}`,
  '',
  '## 怎么做',
  '',
  '1. 跑 `node prototype/sea.mjs check ' + id + '`',
  '2. 读差异集合，逐项定位到 `data/` 里的具体文件与字段',
  '3. 修数据（⛔ 不修 `baseline/`）',
  '4. 重新跑，确认差异归零',
  '',
  '## 判据',
  '',
  '- 通过 = `check.mjs` exit 0 且输出「差异集合 = 0」',
  '- 失败 = exit 非 0 且输出「差异集合 = N 项」+ 每项可定位',
  '',
  '## 坑',
  '',
  '- ⛔ 改 `check.mjs` 后必须重跑 `gate-cli.mjs validate`，否则可能悄悄漏报',
  '- ⛔ 场景记忆超 25KB 或 §〇 超 4KB 时先归档',
  '',
].join('\n'), 'utf8');

// ---- 5. .identity.json（身份索引）----
writeFileSync(join(dir, '.identity.json'), JSON.stringify({
  sceneId: id,
  sceneName: name,
  panelId: `${id}-ai`,
  panelTitle: `AI·${name}`,
  sessionId: null,
  sessionTitle: `${name} 常驻`,
  contextCard: 'CONTEXT.md',
  skill: 'SKILL.md',
  memory: 'MEMORY.md',
  check: 'check.mjs',
  createdAt: new Date().toISOString(),
  note: 'sessionId 在建立常驻会话后回写；换会话必须回写此字段',
}, null, 2), 'utf8');

console.log(`已创建场景骨架：${id}`);
console.log('');
console.log('生成的文件：');
console.log('  scene.json       场景配置');
console.log('  CONTEXT.md       定位卡');
console.log('  MEMORY.md        场景记忆');
console.log('  SKILL.md         专属技能');
console.log('  .identity.json   身份索引');
console.log('  data/            真实数据（待放）');
console.log('  baseline/        干净基线（待放）');
console.log('');
console.log('下一步：');
console.log('  ① 往 data/ 和 baseline/ 放同一份干净数据');
console.log(`  ② 写 check.mjs（可参考其他场景）`);
console.log(`  ③ node prototype/gate-cli.mjs validate prototype/scenes/${id}/check.mjs ${id}`);
