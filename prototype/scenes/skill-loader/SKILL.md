---
name: skill-loader
category: 工程
depth: deep
description: 做技能加载器：解析 frontmatter、校验必填字段、生成常驻目录、按需加载正文。当用户要"技能系统怎么落地"时使用。
---

# 技能加载器 技能

> 技能不是一堆散落的 markdown。要能：解析元数据、校验完整性、生成目录、按需加载。
> 判据：**frontmatter 解析对吗？缺字段会拒吗？目录能生成吗？正文能按需加载吗？**

## 什么时候用

- 做 agent 技能/提示词库
- 要评审「技能系统」这类声明
- 技能数量增长后要管理

## 什么时候**不**用

- 只有一两个提示词

## 第 1 步：解析 frontmatter

每个技能文件以 `---` 分隔的 YAML 头开始，含 `name/category/depth/description`。解析成对象。

## 第 2 步：校验必填字段（缺则拒）

`validateSkill` 检查：

- `name` 唯一且合法（kebab-case）
- `category` 在允许集合内
- `depth` 是 guide/deep
- `description` 非空

缺字段 → 拒绝加载并报错，**不静默跳过**。

## 第 3 步：生成常驻目录（catalogue）

把所有技能的 `name + description` 拼成一段常驻文本（有字数上限），供模型「发现」有哪些技能。

## 第 4 步：按需加载正文

模型选中某个技能后，再读它的完整正文。**目录只放摘要，正文按需取**——这是渐进披露。

## 反例（写下来防复发）

- ✗ frontmatter 解析错 → name 变成 undefined
- ✗ 缺字段静默跳过 → 技能静默消失
- ✗ 目录塞全文 → 上下文爆
- ✗ 目录没有摘要 → 模型无法判断该选哪个

## 自检清单

- [ ] frontmatter 正确解析
- [ ] 必填字段校验（缺则拒）
- [ ] 目录生成（name+desc，有上限）
- [ ] 正文按需加载

## 参考实现指路

本仓库 `tools/skills/loader.mjs`（`parseFrontmatter` / `validateSkill` / `createSkillLoader`）+ `tools/skills/inject.mjs`（catalogText 生成目录、descChars 截断）+ `tools/skills/doctor.mjs`（体量与质量检查）。
