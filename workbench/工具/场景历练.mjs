#!/usr/bin/env node
// 工具/场景历练.mjs —— 让场景 agent 真的干活，从实践中积累经验
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  2026-11-11 审计发现：9 个场景总共只有 7 条真实经验。
//
//    架构梳理   5 条
//    中枢       1 条
//    实施计划   1 条
//    其余 6 个  0 条   ← 「坑与决策」章节还是占位符「- （只追加：症状 → 根因 → 修法）」
//
//  而封存集（验证进化的依据）是从真实经验生成的，
//  每个场景需要 ≥12 条才能建有效验证集。
//
//  **也就是说：「自主进化」卡在「没有经验可进化」上。**
//
//  这不是编造几条能解决的 —— 封存集是从真实记忆生成的，
//  编造的内容拿同一份记忆出题考自己，只会立刻暴露（必须包含/不应出现都对不上）。
//
//  正确做法：**让场景 agent 真的去干活，从实践中积累经验。**
//
//  ══════════════════════════════════════════════════════════════════════
//  做什么
// ══════════════════════════════════════════════════════════════════════
//  给每个场景派一个**它职责范围内、能真正产出东西**的任务：
//    · 任务必须能用它自己能访问的素材完成（不依赖外部网络）
//    · 任务结果必须可验证（不是"想一想"）
//    · 完成后让它把「这次学到了什么」写进 §五 坑与决策
//
//  然后中枢用「中枢代写」把经验落盘（因为场景 agent 写不了共享区，
//  但它能写自己的记忆目录 —— 所以这里让它自己写自己的）。
//
//  用法：
//    node 工具/场景历练.mjs --list                    # 看每个场景的经验数
//    node 工具/场景历练.mjs --run 竞品拆解            # 给一个场景派任务
//    node 工具/场景历练.mjs --run-all                 # 全部跑一遍（慢）
//    node 工具/场景历练.mjs --run 竞品拆解 --dry      # 只看会派什么任务
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { countExperiences } from './_经验识别.mjs';
import { buildPrompt, tasksOf, scenesWithTasks } from './历练任务库.mjs';
import { sceneNames } from './_场景清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const PORT = 3083;

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

// ⚠ 2026-11-14 改：不再硬编码，从 scenarios/*.json 动态读
const SCENES = sceneNames();

// ══════════════════════════════════════════════════════════════════════
//  每个场景的「历练任务」
//
//  设计原则（很重要）：
//    ① 任务必须是**它职责范围内**的事，不能让它干别的场景的活
//    ② 必须能用**它能访问的素材**完成 —— 场景 agent 只能读自己目录 + 全局只读
//    ③ 结果必须**可验证**，不能是"写一段感想"
//    ④ 完成后必须让它把经验写进 §五（这是积累经验的唯一途径）
// ══════════════════════════════════════════════════════════════════════
const TASKS = {
  '竞品拆解': {
    title: '拆解本项目自身的功能矩阵',
    task: [
      '请做一件你职责范围内、能真实产出的事：**把本项目（这个工作台）当作一个竞品，拆出它的功能矩阵。**',
      '',
      '素材（你能读的）：',
      '- 你的记忆目录：`数据/.dsh/场景记忆/竞品拆解/`',
      '- 项目根：`' + ROOT.replace(/\\/g, '/') + '`（可以 read / glob / grep）',
      '- 重点看：`workbench/外壳/scenarios/*.json`（场景=功能模块）',
      '         `workbench/工具/*.mjs`（工具=能力）',
      '         `workbench/数据/.dsh/机制清单.md`（机制）',
      '',
      '产出要求（必须落到文件）：',
      '1. 用 glob 数一下工具目录有多少个 .mjs',
      '2. 用 read 看 3 个场景配置文件，提取它们的 panels 结构',
      '3. 写一份功能矩阵到 `数据/.dsh/场景记忆/竞品拆解/项目功能矩阵.md`，格式：',
      '   | 模块 | 功能 | 实现方式 | 成熟度(1-5) | 依据文件 |',
      '   至少 8 行，每行都要能指到具体文件',
      '4. 最后把「这次拆解学到的一条经验」写进你的 `场景私有记忆.md` 的 §五 坑与决策，',
      '   格式：`- YYYY-MM-DD：**标题** — 症状 → 根因 → 修法`',
      '',
      '注意：只改你自己目录下的文件，不要动别人的。',
      '',
      '### 写经验时必须用这个精确格式（否则不会被识别为有效经验）',
      '',
      '在你的 `场景私有记忆.md` 的 `## 五、坑与决策` 章节末尾**追加一行**（不要改别的）：',
      '',
      '```',
      '- YYYY-MM-DD：**一句话标题（至少 10 个字）** — 症状：... → 根因：... → 修法：...',
      '```',
      '',
      '硬要求：',
      '  · 必须以 `- ` 开头，紧跟日期 `YYYY-MM-DD：`',
      '  · 必须有 `**粗体标题**`，标题至少 10 个字',
      '  · 标题后面要有实质内容（症状/根因/修法 至少写两项），总长 ≥ 30 字',
      '  · **这一条经验必须是你这次真干活真踩到的**，不是泛泛而谈',
      '',
      '反例（会被判为无效，不给分）：',
      '  ✗ `- （只追加：症状 → 根因 → 修法）`        ← 模板占位符',
      '  ✗ `- 2026-X-X：初始化场景记忆骨架`           ← 创建注记不是经验',
      '  ✗ `- 学到了很多`                              ← 没有日期、没有标题、没有实质',
      '',
    ].join('\n'),
    verify: '数据/.dsh/场景记忆/竞品拆解/项目功能矩阵.md 存在且 ≥ 8 行矩阵',
  },

  '逆向分析': {
    title: '逆向本项目的一个真实模块',
    task: [
      '请做一件你职责范围内、能真实产出的事：**逆向分析本项目的一个真实模块，说清它怎么实现的。**',
      '',
      '选一个模块（建议按这个顺序，取第一个你能读到的）：',
      '- `workbench/外壳/ui/panels/neuron.js`（记忆神经元星盘）',
      '- `workbench/外壳/ui/panels/main-agent.js`（主 Agent 界面）',
      '- `workbench/工具/投递通道.mjs`（场景间投递）',
      '',
      '做法：',
      '1. 用 glob 找到文件，用 read 读它（大文件分段读）',
      '2. 找出：入口函数、核心数据结构、关键算法、对外接口',
      '3. 写一份逆向笔记到 `数据/.dsh/场景记忆/逆向分析/模块逆向笔记.md`，包含：',
      '   - 模块职责',
      '   - 入口与调用链',
      '   - 核心数据结构（贴关键代码片段 + 行号）',
      '   - 可复用的设计模式',
      '   - 至少 3 条「它怎么做到的」结论，每条都要有代码证据',
      '4. 把「这次逆向学到的一条经验」写进你的 `场景私有记忆.md` §五',
      '',
      '### 写经验时必须用这个精确格式（否则不会被识别为有效经验）',
      '',
      '在你的 `场景私有记忆.md` 的 `## 五、坑与决策` 章节末尾**追加一行**（不要改别的）：',
      '',
      '```',
      '- YYYY-MM-DD：**一句话标题（至少 10 个字）** — 症状：... → 根因：... → 修法：...',
      '```',
      '',
      '硬要求：',
      '  · 必须以 `- ` 开头，紧跟日期 `YYYY-MM-DD：`',
      '  · 必须有 `**粗体标题**`，标题至少 10 个字',
      '  · 标题后面要有实质内容（症状/根因/修法 至少写两项），总长 ≥ 30 字',
      '  · **这一条经验必须是你这次真干活真踩到的**，不是泛泛而谈',
      '',
      '反例（会被判为无效，不给分）：',
      '  ✗ `- （只追加：症状 → 根因 → 修法）`        ← 模板占位符',
      '  ✗ `- 2026-X-X：初始化场景记忆骨架`           ← 创建注记不是经验',
      '  ✗ `- 学到了很多`                              ← 没有日期、没有标题、没有实质',
      '',
    ].join('\n'),
    verify: '数据/.dsh/场景记忆/逆向分析/模块逆向笔记.md 存在且含 ≥3 条代码证据',
  },

  '调研': {
    title: '调研本项目的机制体系',
    task: [
      '请做一件你职责范围内、能真实产出的事：**调研本项目的机制体系，出一份带来源的资料索引。**',
      '',
      '素材：',
      '- `' + ROOT.replace(/\\/g, '/') + '/workbench/数据/.dsh/机制清单.md`（自动生成的机制总表）',
      '- `workbench/数据/.dsh/机制盲区.json`（已知盲区）',
      '- `workbench/数据/.dsh/事故档案/`（事故记录）',
      '- `workbench/工具/机制体检.mjs`（守卫注册表）',
      '',
      '做法：',
      '1. 读机制清单，数一下有多少条机制、分成几类',
      '2. 读机制盲区，看有多少条已知盲区',
      '3. 读事故档案，看有多少起事故、几个等级',
      '4. 写一份调研索引到 `数据/.dsh/场景记忆/调研/机制体系索引.md`，包含：',
      '   | 类别 | 数量 | 来源文件 | 关键发现 |',
      '   以及一段「这套机制体系的整体判断」（它强在哪、弱在哪）',
      '5. 把「这次调研学到的一条经验」写进你的 `场景私有记忆.md` §五',
      '',
      '### 写经验时必须用这个精确格式（否则不会被识别为有效经验）',
      '',
      '在你的 `场景私有记忆.md` 的 `## 五、坑与决策` 章节末尾**追加一行**（不要改别的）：',
      '',
      '```',
      '- YYYY-MM-DD：**一句话标题（至少 10 个字）** — 症状：... → 根因：... → 修法：...',
      '```',
      '',
      '硬要求：',
      '  · 必须以 `- ` 开头，紧跟日期 `YYYY-MM-DD：`',
      '  · 必须有 `**粗体标题**`，标题至少 10 个字',
      '  · 标题后面要有实质内容（症状/根因/修法 至少写两项），总长 ≥ 30 字',
      '  · **这一条经验必须是你这次真干活真踩到的**，不是泛泛而谈',
      '',
      '反例（会被判为无效，不给分）：',
      '  ✗ `- （只追加：症状 → 根因 → 修法）`        ← 模板占位符',
      '  ✗ `- 2026-X-X：初始化场景记忆骨架`           ← 创建注记不是经验',
      '  ✗ `- 学到了很多`                              ← 没有日期、没有标题、没有实质',
      '',
    ].join('\n'),
    verify: '数据/.dsh/场景记忆/调研/机制体系索引.md 存在且含数量统计与来源',
  },

  '架构梳理': {
    title: '梳理本项目的真实分层结构',
    task: [
      '请做一件你职责范围内、能真实产出的事：**梳理本项目当前的真实分层结构，判断哪层是薄弱的。**',
      '',
      '素材：',
      '- `workbench/数据/.dsh/AGENTS.md`（八节全局须知，含七层架构）',
      '- `workbench/数据/.dsh/机制清单.md`',
      '- `workbench/工具/` 全部工具（用 glob 列出来）',
      '- `workbench/外壳/` 目录结构',
      '',
      '做法：',
      '1. 用 glob 列出工具目录有哪些 .mjs，按前缀分组（哨兵/闸/体检/其他）',
      '2. 读机制清单，看每层实际有多少机制',
      '3. 写一份架构评估到 `数据/.dsh/场景记忆/架构梳理/当前架构评估.md`，包含：',
      '   | 层 | 本层职责 | 实际机制数 | 证据文件 | 判定(强/中/弱) |',
      '   最后给出「最薄弱的层是哪个、为什么、怎么补」的结论',
      '4. 把「这次梳理学到的一条经验」写进你的 `场景私有记忆.md` §五',
      '',
      '### 写经验时必须用这个精确格式（否则不会被识别为有效经验）',
      '',
      '在你的 `场景私有记忆.md` 的 `## 五、坑与决策` 章节末尾**追加一行**（不要改别的）：',
      '',
      '```',
      '- YYYY-MM-DD：**一句话标题（至少 10 个字）** — 症状：... → 根因：... → 修法：...',
      '```',
      '',
      '硬要求：',
      '  · 必须以 `- ` 开头，紧跟日期 `YYYY-MM-DD：`',
      '  · 必须有 `**粗体标题**`，标题至少 10 个字',
      '  · 标题后面要有实质内容（症状/根因/修法 至少写两项），总长 ≥ 30 字',
      '  · **这一条经验必须是你这次真干活真踩到的**，不是泛泛而谈',
      '',
      '反例（会被判为无效，不给分）：',
      '  ✗ `- （只追加：症状 → 根因 → 修法）`        ← 模板占位符',
      '  ✗ `- 2026-X-X：初始化场景记忆骨架`           ← 创建注记不是经验',
      '  ✗ `- 学到了很多`                              ← 没有日期、没有标题、没有实质',
      '',
    ].join('\n'),
    verify: '数据/.dsh/场景记忆/架构梳理/当前架构评估.md 存在且含逐层判定',
  },

  '实施计划': {
    title: '把本项目的待办拆成可验收的里程碑',
    task: [
      '请做一件你职责范围内、能真实产出的事：**把本项目的真实待办拆成可验收的里程碑。**',
      '',
      '素材：',
      '- `workbench/数据/.dsh/机制盲区.json`（已知盲区 = 待补的事）',
      '- `workbench/数据/.dsh/事故档案/`（事故暴露的问题）',
      '- `workbench/数据/.dsh/场景记忆/_共享记忆/派单台账.json`（未完成的事）',
      '- `workbench/数据/.dsh/机制清单.md`',
      '',
      '做法：',
      '1. 读机制盲区，数有多少条还没修',
      '2. 读派单台账，看有没有 cancelled 的（说明放弃了）',
      '3. 写一份里程碑计划到 `数据/.dsh/场景记忆/实施计划/里程碑计划.md`，包含：',
      '   | 里程碑 | 包含哪些待办 | 验收方式（可执行命令）| 依赖 |',
      '   至少 3 个里程碑，每个的验收方式必须是**能跑的命令**，不能是"做完了"',
      '4. 把「这次拆解学到的一条经验」写进你的 `场景私有记忆.md` §五',
      '',
      '### 写经验时必须用这个精确格式（否则不会被识别为有效经验）',
      '',
      '在你的 `场景私有记忆.md` 的 `## 五、坑与决策` 章节末尾**追加一行**（不要改别的）：',
      '',
      '```',
      '- YYYY-MM-DD：**一句话标题（至少 10 个字）** — 症状：... → 根因：... → 修法：...',
      '```',
      '',
      '硬要求：',
      '  · 必须以 `- ` 开头，紧跟日期 `YYYY-MM-DD：`',
      '  · 必须有 `**粗体标题**`，标题至少 10 个字',
      '  · 标题后面要有实质内容（症状/根因/修法 至少写两项），总长 ≥ 30 字',
      '  · **这一条经验必须是你这次真干活真踩到的**，不是泛泛而谈',
      '',
      '反例（会被判为无效，不给分）：',
      '  ✗ `- （只追加：症状 → 根因 → 修法）`        ← 模板占位符',
      '  ✗ `- 2026-X-X：初始化场景记忆骨架`           ← 创建注记不是经验',
      '  ✗ `- 学到了很多`                              ← 没有日期、没有标题、没有实质',
      '',
    ].join('\n'),
    verify: '数据/.dsh/场景记忆/实施计划/里程碑计划.md 存在且每个里程碑有可执行验收命令',
  },

  '故障分析': {
    title: '分析本项目事故档案里的共同模式',
    task: [
      '请做一件你职责范围内、能真实产出的事：**从本项目的事故档案里找出共同模式。**',
      '',
      '素材：',
      '- `workbench/数据/.dsh/事故档案/事故档案.json`（结构化记录）',
      '- `workbench/数据/.dsh/事故档案/` 下的 .md（详细记录）',
      '- `workbench/数据/.dsh/场景记忆/_共享记忆/派单台账.json`',
      '',
      '做法：',
      '1. 读事故档案，统计：总起数、按严重程度分、按类型分',
      '2. 挑 3 起不同类型的事故，读它们的详细记录',
      '3. 写一份根因分析到 `数据/.dsh/场景记忆/故障分析/事故共同模式.md`，包含：',
      '   - 事故统计表',
      '   - **至少 3 条共同模式**（例如「都不报错」「都是小操作」）',
      '   - 每条模式要举 2 个具体事故作为证据',
      '   - 「怎么防止这类事故再发生」的可执行建议',
      '4. 把「这次分析学到的一条经验」写进你的 `场景私有记忆.md` §五',
      '',
      '注意：你只分析不改码（这是你的边界）。',
      '',
      '### 写经验时必须用这个精确格式（否则不会被识别为有效经验）',
      '',
      '在你的 `场景私有记忆.md` 的 `## 五、坑与决策` 章节末尾**追加一行**（不要改别的）：',
      '',
      '```',
      '- YYYY-MM-DD：**一句话标题（至少 10 个字）** — 症状：... → 根因：... → 修法：...',
      '```',
      '',
      '硬要求：',
      '  · 必须以 `- ` 开头，紧跟日期 `YYYY-MM-DD：`',
      '  · 必须有 `**粗体标题**`，标题至少 10 个字',
      '  · 标题后面要有实质内容（症状/根因/修法 至少写两项），总长 ≥ 30 字',
      '  · **这一条经验必须是你这次真干活真踩到的**，不是泛泛而谈',
      '',
      '反例（会被判为无效，不给分）：',
      '  ✗ `- （只追加：症状 → 根因 → 修法）`        ← 模板占位符',
      '  ✗ `- 2026-X-X：初始化场景记忆骨架`           ← 创建注记不是经验',
      '  ✗ `- 学到了很多`                              ← 没有日期、没有标题、没有实质',
      '',
    ].join('\n'),
    verify: '数据/.dsh/场景记忆/故障分析/事故共同模式.md 存在且含 ≥3 条模式+证据',
  },

  '本地电脑': {
    title: '盘点本项目的磁盘占用',
    task: [
      '请做一件你职责范围内、能真实产出的事：**盘点本项目目录的磁盘占用情况。**',
      '',
      '做法（只能用你能访问的命令）：',
      '1. 用 pwsh 跑：`Get-ChildItem "' + ROOT.replace(/\\/g, '/') + '" -Directory | ForEach-Object { $s = (Get-ChildItem $_.FullName -Recurse -File -EA SilentlyContinue | Measure-Object -Property Length -Sum).Sum; "{0,-20} {1,10:N2} MB" -f $_.Name, ($s/1MB) }`',
      '2. 找出最大的 3 个目录',
      '3. 用 glob 或 pwsh 数一下各目录的文件数',
      '4. 写一份盘点报告到 `数据/.dsh/场景记忆/本地电脑/磁盘占用盘点.md`，包含：',
      '   | 目录 | 大小 | 文件数 | 是否可清理 | 理由 |',
      '   最后给出「哪些能清、哪些不能动、为什么」的判断',
      '5. 把「这次盘点学到的一条经验」写进你的 `场景私有记忆.md` §五',
      '',
      '注意：**只盘点不删除**。你只做判断，删除由用户确认。',
      '',
      '### 写经验时必须用这个精确格式（否则不会被识别为有效经验）',
      '',
      '在你的 `场景私有记忆.md` 的 `## 五、坑与决策` 章节末尾**追加一行**（不要改别的）：',
      '',
      '```',
      '- YYYY-MM-DD：**一句话标题（至少 10 个字）** — 症状：... → 根因：... → 修法：...',
      '```',
      '',
      '硬要求：',
      '  · 必须以 `- ` 开头，紧跟日期 `YYYY-MM-DD：`',
      '  · 必须有 `**粗体标题**`，标题至少 10 个字',
      '  · 标题后面要有实质内容（症状/根因/修法 至少写两项），总长 ≥ 30 字',
      '  · **这一条经验必须是你这次真干活真踩到的**，不是泛泛而谈',
      '',
      '反例（会被判为无效，不给分）：',
      '  ✗ `- （只追加：症状 → 根因 → 修法）`        ← 模板占位符',
      '  ✗ `- 2026-X-X：初始化场景记忆骨架`           ← 创建注记不是经验',
      '  ✗ `- 学到了很多`                              ← 没有日期、没有标题、没有实质',
      '',
    ].join('\n'),
    verify: '数据/.dsh/场景记忆/本地电脑/磁盘占用盘点.md 存在且含大小统计',
  },

  '自我复盘': {
    title: '复盘本项目的记忆质量',
    task: [
      '请做一件你职责范围内、能真实产出的事：**复盘所有场景的记忆质量，找出哪些是空壳。**',
      '',
      '素材（你能读全局记忆目录吗？先试试）：',
      '- `workbench/数据/.dsh/场景记忆/` 下各场景的 `场景私有记忆.md`',
      '',
      '做法：',
      '1. 用 glob 找出所有 `**/场景私有记忆.md`',
      '2. 用 read 逐个看（只看关键章节：核心职责、§五 坑与决策）',
      '3. 统计：哪些场景的 §五 是占位符「- （只追加：症状 → 根因 → 修法）」（= 空壳）',
      '4. 写一份复盘到 `数据/.dsh/场景记忆/自我复盘/记忆质量复盘.md`，包含：',
      '   | 场景 | 记忆大小 | §五 经验条数 | 质量判定 |',
      '   最后给出「记忆体系的整体健康度」判断',
      '5. 把「这次复盘学到的一条经验」写进你的 `场景私有记忆.md` §五',
      '',
      '### 写经验时必须用这个精确格式（否则不会被识别为有效经验）',
      '',
      '在你的 `场景私有记忆.md` 的 `## 五、坑与决策` 章节末尾**追加一行**（不要改别的）：',
      '',
      '```',
      '- YYYY-MM-DD：**一句话标题（至少 10 个字）** — 症状：... → 根因：... → 修法：...',
      '```',
      '',
      '硬要求：',
      '  · 必须以 `- ` 开头，紧跟日期 `YYYY-MM-DD：`',
      '  · 必须有 `**粗体标题**`，标题至少 10 个字',
      '  · 标题后面要有实质内容（症状/根因/修法 至少写两项），总长 ≥ 30 字',
      '  · **这一条经验必须是你这次真干活真踩到的**，不是泛泛而谈',
      '',
      '反例（会被判为无效，不给分）：',
      '  ✗ `- （只追加：症状 → 根因 → 修法）`        ← 模板占位符',
      '  ✗ `- 2026-X-X：初始化场景记忆骨架`           ← 创建注记不是经验',
      '  ✗ `- 学到了很多`                              ← 没有日期、没有标题、没有实质',
      '',
    ].join('\n'),
    verify: '数据/.dsh/场景记忆/自我复盘/记忆质量复盘.md 存在且含逐场景判定',
  },
  '中枢': {
    title: '复盘一次真实的调度闭环，找出调度链路的薄弱点',
    task: [
      '请做一件你职责范围内、能真实产出的事：**复盘一次真实的调度闭环，找出调度链路的薄弱点。**',
      '',
      '素材：',
      '- workbench/数据/.dsh/场景记忆/_共享记忆/派单台账.json（真实派单记录）',
      '- workbench/数据/.dsh/封存集历史.json（封存集判分历史）',
      '- workbench/数据/.dsh/场景记忆/_共享记忆/进化台账.json（进化记录）',
      '- workbench/工具/ 下的调度相关工具（派单.mjs / 投递通道.mjs / 中枢代写.mjs / 闭环验证.mjs）',
      '',
      '做法：',
      '1. read 派单台账，统计：总数、各状态分布、有多少条真正走到 closed',
      '2. read 进化台账，看有几条进化、几条已闭环（stable/improved/degraded）',
      '3. read 封存集历史，看得分趋势',
      '4. 写一份复盘到 数据/.dsh/场景记忆/中枢/调度链路复盘.md，包含：',
      '   | 环节 | 现状 | 证据 | 薄弱点 |',
      '   至少覆盖：建单 → 投递 → 场景执行 → 回执 → 销账 → 进化',
      '   最后给出「最薄弱的环节是哪个、为什么、怎么补」的结论',
      '5. 把一条经验写进你的 场景私有记忆.md 的 ## 五、坑与决策',
      '',
      '### 写经验时必须用这个精确格式（否则不会被识别为有效经验）',
      '',
      '在 ## 五、坑与决策 章节末尾追加一行：',
      '',
      '- YYYY-MM-DD：**一句话标题（至少 10 个字）** — 症状：... → 根因：... → 修法：...',
      '',
      '硬要求：以 - 开头、紧跟日期 YYYY-MM-DD：、必须有 **粗体标题**（至少 10 字）、',
      '标题后有实质内容（症状/根因/修法 至少两项）、总长至少 30 字、必须是真踩到的。',
      '',
      '注意：你只调度不代写专业内容（这是你的边界）。',
    ].join('\n'),
    verify: '数据/.dsh/场景记忆/中枢/调度链路复盘.md 存在且含六个环节的判定',
  },
};

// ══════════════════════════════════════════════════════════════════════
//  统计每个场景的真实经验数
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
//  轮次记录：每个场景派到第几个任务了
//
//  ⚠ 为什么需要：实测发现重复派同一个任务时，
//    场景 agent 会正确判断「任务已完成，无需重做」→ 不再积累经验。
//    所以必须记住派到哪一轮，下次派下一个任务。
// ══════════════════════════════════════════════════════════════════════
const ROUND_FILE = path.join(DATA, '历练轮次.json');

function readRounds() {
  try {
    if (!fs.existsSync(ROUND_FILE)) return {};
    return JSON.parse(fs.readFileSync(ROUND_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return {}; }
}

function writeRounds(obj) {
  try { fs.writeFileSync(ROUND_FILE, JSON.stringify(obj, null, 2), 'utf8'); } catch { /* ignore */ }
}

// ⚠ 2026-11-12：改用共享的 _经验识别.mjs
//   旧实现用严格正则（按日期切 + 必须有粗体标题），漏判了 3 条真实经验：
//     故障分析「25 起事故共同根因…」（无粗体标题）
//     本地电脑「日期后是空格不是冒号」
//     调研「日期用方括号」
//   按格式判真伪是错的，应该按「有没有实质内容」判。
function countExperience(sceneName) {
  const p = path.join(MEM, sceneName, '场景私有记忆.md');
  if (!fs.existsSync(p)) return { exists: false, count: 0, size: 0 };
  const c = fs.readFileSync(p, 'utf8');
  return { exists: true, count: countExperiences(c), size: Buffer.byteLength(c, 'utf8') };
}

// ══════════════════════════════════════════════════════════════════════
//  投递任务
// ══════════════════════════════════════════════════════════════════════
function getToken() {
  const p = path.join(WB, '外壳', 'server.log');
  const s = fs.readFileSync(p, 'utf8');
  const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

async function getCookie() {
  const token = getToken();
  if (!token) throw new Error('无 token');
  return await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT,
      path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 8000,
    }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => resolve(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

async function deliver(sceneName, text) {
  const cookie = await getCookie();
  const r = await new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'tr-' + Date.now(),
      method: 'session/list', payload: { args: { _request: {} } },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/api/session/list', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cookie': cookie, 'Origin': 'http://127.0.0.1:' + PORT },
      timeout: 20000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } resolve(j); });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });

  const items = (r && r.result && r.result.value && r.result.value.items) || [];
  const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
  const target = norm(path.join(MEM, sceneName));
  // ⚠ 2026-11-11：不能加 !s.blank —— 空会话正是要用的那个（场景还没开工过）
  const cands = items.filter((s) => norm(s.cwd) === target);
  const hit = cands.find((s) => !s.blank) || cands[0];
  if (!hit) throw new Error('找不到场景会话: ' + sceneName);

  const prompt = (t) => new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'tp-' + Date.now(),
      method: 'session/prompt',
      payload: {
        args: {
          request: {
            requestId: 'tr-' + Date.now(),
            sessionId: hit.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: t }],
          },
        },
      },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/api/session/prompt', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cookie': cookie, 'Origin': 'http://127.0.0.1:' + PORT },
      timeout: 30000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } resolve(j); });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });

  const ok = await prompt(text);
  return { sessionId: hit.sessionId, ok: !!(ok && ok.result && ok.result.ok) };
}

// ══════════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════════
async function main() {
  // ① --list：看经验数
  if (has('list') || argv.length === 0) {
    console.log('═'.repeat(72));
    console.log('  场景经验盘点（封存集需要每场景 ≥12 条）');
    console.log('═'.repeat(72));
    console.log();
    let total = 0;
    for (const s of SCENES) {
      const st = countExperience(s);
      const need = Math.max(0, 12 - st.count);
      const mark = st.count >= 12 ? 'OK' : 'XX';
      console.log('  ' + mark + ' ' + s.padEnd(10) +
        ' 经验 ' + String(st.count).padStart(2) + ' 条' +
        '  记忆 ' + String(st.size).padStart(5) + 'B' +
        (need ? '  还缺 ' + need + ' 条' : '  ✓ 达标'));
      total += st.count;
    }
    console.log();
    console.log('  总计真实经验: ' + total + ' 条');
    console.log('  目标: ' + (SCENES.length * 12) + ' 条');
    console.log();
    console.log('  下一步: node 工具/场景历练.mjs --run <场景名>');
    return;
  }

  // ② --run <场景>
  if (has('run')) {
    const scene = val('run');
    if (!scene) { console.log('缺少场景名'); process.exit(2); }

    const list = tasksOf(scene);
    if (!list.length) { console.log('该场景还没配历练任务: ' + scene); console.log('可用: ' + scenesWithTasks().join(', ')); process.exit(2); }

    const rounds = readRounds();
    const done = Number(rounds[scene] || 0);
    const prompt = buildPrompt(scene, done);

    if (!prompt) { console.log("取任务失败"); process.exit(2); }

    const st = countExperience(scene);
    console.log('场景: ' + scene + '   当前经验: ' + st.count + ' 条');
    console.log('轮次: ' + prompt.round + ' / ' + prompt.total + '  —— ' + prompt.title);
    console.log('验收: ' + prompt.verify);
    console.log();

    if (has('dry')) {
      console.log('=== 会派发的任务正文 ===');
      console.log(prompt.text);
      return;
    }

    console.log('投递中…');
    const r = await deliver(scene, prompt.text);
    console.log('  ' + (r.ok ? '✓ 已投递' : '✗ 投递失败') + '  会话: ' + r.sessionId.slice(0, 20) + '…');

    if (r.ok) {
      rounds[scene] = done + 1;
      writeRounds(rounds);
      console.log('  ✓ 轮次已记录: 下次派第 ' + Math.min(done + 2, list.length) + ' 个任务' + (done + 1 >= list.length ? '（已用完，将重头循环）' : ''));
    }

    console.log();
    console.log('等它干完（用 中枢代写 --wait-reply 查看）:');
    console.log('  node 工具/中枢代写.mjs --wait-reply --scene ' + scene + ' --timeout 300');
    return;
  }

  // ③ --run-all
  if (has('run-all')) {
    const targets = scenesWithTasks();
    console.log('给 ' + targets.length + ' 个场景派历练任务（每个场景会派下一个没做过的任务）');
    console.log();

    const rounds = readRounds();
    for (const scene of targets) {
      const list = tasksOf(scene);
      const done = Number(rounds[scene] || 0);
      const prompt = buildPrompt(scene, done);
      if (!prompt) continue;

      const st = countExperience(scene);
      process.stdout.write('  ' + scene.padEnd(10) + ' 经验 ' + String(st.count).padStart(2) + '  轮 ' + prompt.round + '/' + prompt.total + '  ' + prompt.title.slice(0, 24).padEnd(26) + ' → ');
      try {
        const r = await deliver(scene, prompt.text);
        console.log(r.ok ? '✓ 已派' : '✗ 失败');
        if (r.ok) { rounds[scene] = done + 1; writeRounds(rounds); }
      } catch (e) {
        console.log('✗ ' + String(e.message).slice(0, 40));
      }
      await new Promise((r2) => setTimeout(r2, 1500));
    }
    console.log();
    console.log('全部派完。等 5-10 分钟后用 --list 看经验增长。');
    return;
  }

  console.log('用法:');
  console.log('  node 工具/场景历练.mjs --list');
  console.log('  node 工具/场景历练.mjs --run 竞品拆解');
  console.log('  node 工具/场景历练.mjs --run-all');
}

main().catch((e) => {
  console.error('  ✗ ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
