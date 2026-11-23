# 定位卡 · 文档索引

> 这张卡回答：**我是谁 · 我负责什么 · 我能碰什么 · 我怎么被触发 · 我的铁律**。
> ⛔ 引擎不会自动注入它 —— 必须由会话开场「认领身份」后主动读。

## 1. 身份与职责

- **场景**：文档索引（`docs-index`）
- **负责**：保证 README 索引覆盖全部文档，且不指向不存在的文档、不重复
- **不碰**：⛔ 不改文档正文、不决定该写哪篇

## 2. 资产地图

- `data/docs.json`（实际文档清单）、`data/indexed.json`（README 索引）
- `baseline/`：干净基线（门禁用它证明 check 不是恒定失败）
- `check.mjs`：判定脚本（exit 0=通过；非0=失败且必须输出差异集合）
- `MEMORY.md`：场景记忆（§〇 交接 ≤4KB）

## 3. 触发词 → 定位

| 用户这么说 | 该做什么 |
|---|---|
| 文档索引 | 跑 `sea check docs-index` |
| README 漏了吗 | 跑 `sea check docs-index` |
| 索引完整吗 | 跑 `sea check docs-index` |

## 4. 标准流程

跑 refresh-docs-index.mjs 刷新真实数据 → 跑 check → 补 README → 重跑

## 5. 铁律

- ⛔ 不改 `baseline/`（它是门禁的参照物）
- ⛔ 改 `check.mjs` 后必须重跑门禁认证
- ⛔ `data/` 与 `baseline/` 必须分开（否则改业务数据会误触"检查不可信"）

## 6. 上次进度

→ 见 `MEMORY.md` 的 `§〇 当前交接`（这里只放指针，不重复写）
