---
name: skill-authoring
category: 写作
depth: deep
description: 写一个可发现、可加载、不注水的 agent 技能：frontmatter 规范、触发词、渐进披露、硬约束密度、体量红线。当用户要"新增一个技能/写 SKILL.md"时使用。
---

# 技能编写规范 技能

> 技能不是「写篇文章」。写错了，模型发现不了它、加载了不照做、或体量超标被拒。
> 判据：**模型能从一句话话术命中它吗？加载后正文有可执行步骤吗？体量在红线内吗？**

## 什么时候用

- 新增一个技能
- 改写/合并现有技能
- 评审「技能生态」是否健康

## 什么时候**不**用

- 一次性提示词（不需要持久技能）

## 第 1 步：frontmatter 必须齐

```yaml
---
name: kebab-case-唯一名
category: 工程 | 审查 | 数据 | 交付 | 写作 | 研究 | 协作
depth: guide | deep
description: 一句话说清「做什么 + 何时用」
---
```

- name 唯一，且**不能与其他技能名互相包含**（如 `handoff` 与 `team-handoff` 冲突）
- description 必须含**触发词**（「当用户…时使用」或结尾「使用」），否则发现性检查 FAIL

## 第 2 步：description 要短而准（catalogue 会截断）

catalogue 是常驻索引，description 会被截断到固定长度（本仓库 50 字符）。所以：

- 前半句必须是「做什么」，后半句「何时用」
- 别把关键信息放在会被截断的尾部

## 第 3 步：渐进披露——正文是步骤，不是散文

- 正文用「什么时候用 / 什么时候不用 / 第 N 步 / 反例 / 自检清单」结构
- 判据写在最前面（一句话）
- **反例必写**（不写反例 = 这个技能没经历过踩坑）

## 第 4 步：控制体量与硬约束密度

| 指标 | 红线 | 建议 |
|---|---|---|
| 正文体量 | guide ≤6KB / deep ≤16KB（超则拆 reference） | 2-5KB |
| 硬约束密度 | ≤6 条/KB（MUST/必须/禁止 太多会僵化） | 关键处才强硬 |
| 代码块 | <3 个（堆例子会约束模型） | 用接口/枚举代替 |

## 第 5 步：可发现性自测

写完跑一遍「话术→技能」的命中测试：拿几句用户真会说的话，看能否命中这个技能。命中不了就改 description 的触发词。

## 反例（写下来防复发）

- ✗ description 没触发词 → 发现性检查 FAIL，模型永远不选它
- ✗ name 与已有技能互相包含 → 名字冲突检查 FAIL
- ✗ 正文全是散文没有步骤 → 加载了也不照做
- ✗ 不写反例 → 踩过的坑没沉淀

## 自检清单

- [ ] frontmatter 齐（name/category/depth/description）
- [ ] description 含触发词且前短后准
- [ ] 正文有步骤 + 反例 + 自检清单
- [ ] 体量在红线内、硬约束密度不超标
- [ ] 话术命中测试通过

## 参考实现指路

本仓库 `tools/skills/doctor.mjs`（体量/硬约束密度/代码块/示例词/跨技能重复行检查）、`tools/skills/verify-discoverability.mjs`（话术命中率 + 触发词 + 名字包含检查）、`tools/skills/loader.mjs`（frontmatter 解析）。

## 实战记录（本仓库真实事件，2026-11-22）

**事件一（编造）**：我写了个 `streaming-output` 技能，声称「`runtime.mjs` 的流式路径 + delta 增量拼接」。
自查发现：`runtime.mjs` 里只有 `stream` 字样，**没有 delta/onDelta**；
`verify-streaming.mjs` 验的是「**工具步骤边跑边到**」（首事件时间 vs 最终返回），**不是 token delta 流式**。
→ **那段「参考实现指路」是编的**。处理：删掉该技能，重写为 `step-event-streaming`（如实描述）。

**事件二（编造）**：我写 `memory-budget` 技能，声称机制是「按价值淘汰（最近访问×次数×可信度）」。
跑 `verify-memory-budget` 看实际断言：真实机制是**分类预算 + 超预算只注入一部分 + 裁剪不删除 +
outOfBudget 标记 + 交接闸门**，**根本没有「按价值淘汰」**。→ 已按实测重写。

**事件三（命名违规）**：我起名 `dim-evidence-audit`，它**包含**已有技能 `evidence-audit`（子串），
违反「技能名不能互相包含」的规则。→ 改名 `dim-functional-evidence`。

**共同教训**：写技能时的三类自欺——
1. **把"我记得"当"我验证过"**（事件一、二）——必须真的 grep/跑测试；
2. **把"名字像"当"不冲突"**（事件三）——必须跑包含性检查；
3. **把"文件存在"当"函数在里面"**——必须逐个标识符核对。

**复算**：`node tools/skills/doctor.mjs` + `node tools/skills/verify-references.mjs` +
`node tools/skills/verify-discoverability.mjs`（三项全绿才算写完）。
