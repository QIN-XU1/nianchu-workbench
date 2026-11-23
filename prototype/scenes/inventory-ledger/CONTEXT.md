# 定位卡 · 库存台账

> 这张卡回答：**我是谁 · 我负责什么 · 我能碰什么 · 我怎么被触发 · 我的铁律**。
> ⛔ 引擎不会自动注入它 —— 必须由会话开场「认领身份」后主动读。

## 1. 身份与职责

- **场景**：库存台账（`inventory-ledger`）
- **负责**：保证账面量与仓库记录一致，且物料号在物料主数据里
- **不碰**：⛔ 不改实际库存、不决定盘亏盘盈怎么处理

## 2. 资产地图

- `data/items.json`（账面）、`data/warehouse.json`（仓库）、`data/master.json`（主数据）
- `baseline/`：干净基线（门禁用它证明 check 不是恒定失败）
- `check.mjs`：判定脚本（exit 0=通过；非0=失败且必须输出差异集合）
- `MEMORY.md`：场景记忆（§〇 交接 ≤4KB）

## 3. 触发词 → 定位

| 用户这么说 | 该做什么 |
|---|---|
| 盘点 | 跑 `sea check inventory-ledger` |
| 库存对不对 | 跑 `sea check inventory-ledger` |
| 账实相符吗 | 跑 `sea check inventory-ledger` |

## 4. 标准流程

跑 check → 看差异 → 人工盘点确认 → 改账面或仓库记录 → 重跑

## 5. 铁律

- ⛔ 不改 `baseline/`（它是门禁的参照物）
- ⛔ 改 `check.mjs` 后必须重跑门禁认证
- ⛔ `data/` 与 `baseline/` 必须分开（否则改业务数据会误触"检查不可信"）

## 6. 上次进度

→ 见 `MEMORY.md` 的 `§〇 当前交接`（这里只放指针，不重复写）
