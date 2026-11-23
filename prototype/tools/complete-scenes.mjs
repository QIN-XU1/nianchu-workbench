/**
 * 给已有场景补齐六件套（CONTEXT.md / MEMORY.md / SKILL.md / .identity.json）
 *
 * 不覆盖已有文件，只补缺的。
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const PROTOTYPE = join(HERE, '..');
const SCENES = join(PROTOTYPE, 'scenes');

// 每个场景的实质内容（从 scene.json 读 + 人工补充职责/不碰/触发词）
const INFO = {
  'data-reconcile': {
    duty: '核对两份数据源的记录集合与金额是否完全一致',
    notDo: '不改业务数据、不决定以哪一方为准',
    triggers: ['核对数据', '两边数据对不对', '金额一致吗'],
    assets: '`data/sourceA.json`（A 源）、`data/sourceB.json`（B 源）',
    flow: '跑 check → 看差异 → 人工决定以谁为准 → 改数据 → 重跑',
  },
  'doc-consistency': {
    duty: '保证文档里登记的术语都出现、且没有未登记的缩写',
    notDo: '不改文档业务内容、不决定术语该叫什么',
    triggers: ['检查术语', '有没有未登记缩写', '文档一致性'],
    assets: '`data/glossary.json`（术语表）、`data/doc.txt`（正文）',
    flow: '跑 check → 看缺了哪个术语/多了哪个缩写 → 补正文或补术语表 → 重跑',
  },
  'docs-index': {
    duty: '保证 README 索引覆盖全部文档，且不指向不存在的文档、不重复',
    notDo: '不改文档正文、不决定该写哪篇',
    triggers: ['文档索引', 'README 漏了吗', '索引完整吗'],
    assets: '`data/docs.json`（实际文档清单）、`data/indexed.json`（README 索引）',
    flow: '跑 refresh-docs-index.mjs 刷新真实数据 → 跑 check → 补 README → 重跑',
  },
  'inventory-ledger': {
    duty: '保证账面量与仓库记录一致，且物料号在物料主数据里',
    notDo: '不改实际库存、不决定盘亏盘盈怎么处理',
    triggers: ['盘点', '库存对不对', '账实相符吗'],
    assets: '`data/items.json`（账面）、`data/warehouse.json`（仓库）、`data/master.json`（主数据）',
    flow: '跑 check → 看差异 → 人工盘点确认 → 改账面或仓库记录 → 重跑',
  },
  'support-assign': {
    duty: '保证每单有 owner、owner 在值班表、无重复单',
    notDo: '不改客户诉求、不替人决定该分给谁',
    triggers: ['客服分派', '这单谁接', '有没有漏单'],
    assets: '`data/tickets.json`（工单）、`data/roster.json`（值班表）',
    flow: '跑 check → 看哪单没 owner / owner 不在班 → 人工调整 → 重跑',
  },
  'self-review': {
    duty: '保证自己的档案都有索引、索引不指向不存在的档案、档案名不重复',
    notDo: '不改档案正文内容、不替人下结论',
    triggers: ['复盘', '看档案', '我的资料齐吗', '自我复盘'],
    assets: '`data/profiles.json`（档案清单）、`data/indexed.json`（索引）',
    flow: '跑 check → 看哪份档案没登记 → 补索引 → 重跑',
  },
};

for (const [id, info] of Object.entries(INFO)) {
  const dir = join(SCENES, id);
  if (!existsSync(dir)) { console.log(`跳过（不存在）：${id}`); continue; }

  let scene = {};
  try { scene = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8')); } catch { /* ignore */ }
  const name = scene.name || id;
  const desc = scene.desc || info.duty;

  // CONTEXT.md
  if (!existsSync(join(dir, 'CONTEXT.md'))) {
    writeFileSync(join(dir, 'CONTEXT.md'), [
      `# 定位卡 · ${name}`,
      '',
      '> 这张卡回答：**我是谁 · 我负责什么 · 我能碰什么 · 我怎么被触发 · 我的铁律**。',
      '> ⛔ 引擎不会自动注入它 —— 必须由会话开场「认领身份」后主动读。',
      '',
      '## 1. 身份与职责',
      '',
      `- **场景**：${name}（\`${id}\`）`,
      `- **负责**：${info.duty}`,
      `- **不碰**：⛔ ${info.notDo}`,
      '',
      '## 2. 资产地图',
      '',
      `- ${info.assets}`,
      '- `baseline/`：干净基线（门禁用它证明 check 不是恒定失败）',
      '- `check.mjs`：判定脚本（exit 0=通过；非0=失败且必须输出差异集合）',
      '- `MEMORY.md`：场景记忆（§〇 交接 ≤4KB）',
      '',
      '## 3. 触发词 → 定位',
      '',
      '| 用户这么说 | 该做什么 |',
      '|---|---|',
      ...info.triggers.map(t => `| ${t} | 跑 \`sea check ${id}\` |`),
      '',
      '## 4. 标准流程',
      '',
      info.flow,
      '',
      '## 5. 铁律',
      '',
      '- ⛔ 不改 `baseline/`（它是门禁的参照物）',
      '- ⛔ 改 `check.mjs` 后必须重跑门禁认证',
      '- ⛔ `data/` 与 `baseline/` 必须分开（否则改业务数据会误触"检查不可信"）',
      '',
      '## 6. 上次进度',
      '',
      '→ 见 `MEMORY.md` 的 `§〇 当前交接`（这里只放指针，不重复写）',
      '',
    ].join('\n'), 'utf8');
    console.log(`${id}: + CONTEXT.md`);
  }

  // MEMORY.md
  if (!existsSync(join(dir, 'MEMORY.md'))) {
    writeFileSync(join(dir, 'MEMORY.md'), [
      `# 场景记忆 · ${name}`,
      '',
      '## 核心职责',
      '',
      `- ${info.duty}`,
      `- 不碰：⛔ ${info.notDo}`,
      '',
      '## §〇 当前交接',
      '',
      '### 1) 上次交接',
      '',
      '- 2026-11-06：场景建立，六件套补齐；check 已过门禁认证。',
      '',
      '### 2) 当前项目',
      '',
      '| 项目 | 记忆文件 | 状态 | 下一步 |',
      '|---|---|---|---|',
      `| ${name} | 本文件 | 可运行 | 按实际数据跑 check |`,
      '',
      '### 3) 私有记忆变更',
      '',
      '- 2026-11-06：初始建立',
      '',
      '### 4) 下一步 / 卡点',
      '',
      '- 下一步：把真实业务数据放进 `data/`，跑 `sea check`',
      '- 卡点：无',
      '',
      '### 5) 全貌（工具生成，别手改）',
      '',
      '（留空）',
      '',
    ].join('\n'), 'utf8');
    console.log(`${id}: + MEMORY.md`);
  }

  // SKILL.md
  if (!existsSync(join(dir, 'SKILL.md'))) {
    writeFileSync(join(dir, 'SKILL.md'), [
      '---',
      `name: ${id}`,
      `description: ${desc}。当用户要检查或修复与「${name}」相关的一致性时使用。`,
      '---',
      '',
      `# ${name} 场景技能`,
      '',
      '## 什么时候用',
      '',
      `${info.duty}`,
      '',
      '## 怎么做',
      '',
      `1. 跑 \`node prototype/sea.mjs check ${id}\``,
      '2. 读差异集合，逐项定位到 `data/` 里的具体文件与字段',
      '3. 修数据（⛔ 不修 `baseline/`）',
      '4. 重跑，确认差异归零',
      '',
      '## 判据',
      '',
      '- 通过 = exit 0 且输出「差异集合 = 0」',
      '- 失败 = exit 非 0 且输出「差异集合 = N 项」+ 每项可定位',
      '',
      '## 坑',
      '',
      '- ⛔ 改 `check.mjs` 后必须重跑 `gate-cli.mjs validate`，否则可能悄悄漏报',
      '- ⛔ 场景记忆超 25KB 或 §〇 超 4KB 时先归档（`memory-guard.mjs archive`）',
      '',
    ].join('\n'), 'utf8');
    console.log(`${id}: + SKILL.md`);
  }

  // .identity.json
  if (!existsSync(join(dir, '.identity.json'))) {
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
      note: 'sessionId 建立常驻会话后回写；换会话必须回写',
    }, null, 2), 'utf8');
    console.log(`${id}: + .identity.json`);
  }
}

console.log('\n完成');
