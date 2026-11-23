/**
 * 场景记忆引擎 —— 按「淋雨家工作台」记忆机制实现（护城河逻辑，纯函数、可测试）
 *
 * 依据 00-核心机制/二-记忆机制.md + 12-源码照搬/工具/场景记忆.mjs 的 check 校验点：
 *  1) 必须有 `## 核心职责` 且 `- ` 条目 ≥3
 *  2) `## §〇`（或旧 `## 〇、当前交接`）五小节齐全：1)上次交接 2)当前项目 3)私有记忆变更 4)下一步/卡点 5)全貌
 *  3) §〇 区段字节 ≤ 4096
 *  4) 主文件字节 ≤ 25600（红线，超了搬归档）
 *  5) 项目记忆 ≤ 8192（单独校验）
 *
 * 原则：记忆在文件里不在会话里；§〇只回答「我是谁/干到哪/下一步/卡在哪」。
 * 「反例验收」：validate 必须在该失败时真的失败（见 .test.ts）。
 */

export const MEMORY_LIMITS = { main: 25600, section0: 4096, project: 8192 } as const;

export type IssueLevel = 'error' | 'warn';
export type Issue = { level: IssueLevel; code: string; message: string };
export type ValidationResult = { ok: boolean; issues: Issue[] };

/** UTF-8 字节长度（§〇/主文件的红线按字节算） */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** §〇 五小节标题（引擎/工具按这些固定标题校验） */
export const SECTION0_SUBSECTIONS = [
  '### 1) 上次交接',
  '### 2) 当前项目',
  '### 3) 私有记忆变更',
  '### 4) 下一步 / 卡点',
  '### 5) 全貌',
] as const;

/** 抽取 §〇 区段正文（从 `## §〇` 或旧 `## 〇、当前交接` 到下一个二级 `## ` 之前）。找不到返回 null。 */
export function extractSection0(text: string): string | null {
  const re = /^##\s*(?:§〇|〇、当前交接)[^\n]*\n([\s\S]*?)(?=^##\s|\Z)/m;
  const m = re.exec(text);
  return m ? m[1] : null;
}

/** 抽取某个二级标题区块正文（到下一个 `## ` 之前）。 */
export function extractLevel2Section(text: string, title: string): string | null {
  const re = new RegExp('^##\\s*' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)', 'm');
  const m = re.exec(text);
  return m ? m[1] : null;
}

/** 数某区块里以 `- ` 开头的条目数（核心职责 ≥3 的判据）。 */
export function countBullets(block: string | null): number {
  if (!block) return 0;
  return block.split('\n').filter((l) => /^\s*-\s+/.test(l)).length;
}

/** 校验一份「场景私有记忆.md」是否符合记忆机制硬门槛。 */
export function validateMemory(text: string): ValidationResult {
  const issues: Issue[] = [];

  // 1) 核心职责 ≥3
  const dutyBlock = extractLevel2Section(text, '核心职责');
  if (dutyBlock === null) {
    issues.push({ level: 'error', code: 'missing_core_duty', message: '缺少 `## 核心职责` 区块' });
  } else if (countBullets(dutyBlock) < 3) {
    issues.push({ level: 'error', code: 'core_duty_lt3', message: `核心职责条目 <3（实际 ${countBullets(dutyBlock)} 条）` });
  }

  // 2/3) §〇 五小节齐 + ≤4KB
  const s0 = extractSection0(text);
  if (s0 === null) {
    issues.push({ level: 'error', code: 'missing_section0', message: '缺少 `## §〇 当前交接` 区块' });
  } else {
    const missing = SECTION0_SUBSECTIONS.filter((h) => !s0.includes(h));
    if (missing.length > 0) {
      issues.push({ level: 'error', code: 'section0_missing_sub', message: `§〇 缺小节：${missing.join(' / ')}` });
    }
    const s0Bytes = byteLength(s0);
    if (s0Bytes > MEMORY_LIMITS.section0) {
      issues.push({ level: 'error', code: 'section0_too_large', message: `§〇 ${s0Bytes}B > ${MEMORY_LIMITS.section0}B（搬历史到归档）` });
    }
  }

  // 4) 主文件 ≤25KB（红线，告警）
  const mainBytes = byteLength(text);
  if (mainBytes > MEMORY_LIMITS.main) {
    issues.push({ level: 'warn', code: 'main_too_large', message: `主文件 ${mainBytes}B > ${MEMORY_LIMITS.main}B（搬归档留指针）` });
  }

  const ok = issues.every((i) => i.level !== 'error');
  return { ok, issues };
}

/** 校验项目记忆（≤8KB + 必备字段存在性，弱校验）。 */
export function validateProjectMemory(text: string): ValidationResult {
  const issues: Issue[] = [];
  const need = ['状态', '一句话', '下一步'];
  for (const k of need) {
    if (!new RegExp('\\*\\*' + k + '\\*\\*|' + k + '\\s*[:：]').test(text)) {
      issues.push({ level: 'warn', code: 'project_missing_field', message: `项目记忆缺字段：${k}` });
    }
  }
  const b = byteLength(text);
  if (b > MEMORY_LIMITS.project) {
    issues.push({ level: 'error', code: 'project_too_large', message: `项目记忆 ${b}B > ${MEMORY_LIMITS.project}B` });
  }
  return { ok: issues.every((i) => i.level !== 'error'), issues };
}

/** 生成一份合规的「场景私有记忆.md」骨架（照 场景记忆.mjs init 的 §〇 五小节）。 */
export function buildSkeleton(sceneName: string): string {
  return [
    `# ${sceneName} · 场景私有记忆`,
    '',
    '> 身份与形态见 `身份卡.md` / `场景画像.md`（工具生成，⛔ 手改会校验失败）',
    '> 规矩：这份记忆只有本场景能改写；别的场景发现错误只能提醒。',
    '',
    '## 核心职责（≥3 条）',
    '- 负责：<做什么，让什么不出问题>',
    '- 负责：<做什么>',
    '- 不碰：<边界，谁的地盘 / 遇到 X 交给 Y 场景>',
    '',
    '## §〇 当前交接（≤ 4 KB，新会话先读这一节）',
    '### 1) 上次交接',
    '- <做了什么 / 结果 / 证据>',
    '### 2) 当前项目',
    '| 项目 | 记忆文件 | 状态 | 下一步 |',
    '|---|---|---|---|',
    '| 无 | - | - | - |',
    '### 3) 私有记忆变更',
    '- <YYYY-MM-DD：改了什么 + 为什么>',
    '### 4) 下一步 / 卡点',
    '- 下一步：<谁先动，按什么顺序>',
    '- 卡点：无',
    '### 5) 全貌',
    '- 由工具生成（项目记忆数 / 归档数 / 索引）',
    '',
    '## §一 这个场景是干什么的',
    '<三句话：服务谁、守什么、不碰什么>',
    '',
    '## §二 我是谁、开工读什么',
    '- 面板：<面板id> ｜定位卡：scenarios/<场景>-context.md ｜主技能：<技能名>',
    '',
    '## §五 长期记忆（决策 / 铁律 / 坑，只追加）',
    '| 日期 | 症状/决策 | 根因 | 怎么处理 | 以后怎么办 |',
    '|---|---|---|---|---|',
    '',
  ].join('\n');
}
