---
name: sql-review
category: 数据
depth: deep
description: 审查 SQL 的正确性与性能：查隐式类型转换、N+1、缺失索引、错误的 JOIN/聚合、全表扫描，并区分「结果错」与「慢」。当用户要「这条 SQL 有没有问题」「查询很慢」「为什么结果不对」时使用。
---

# SQL 审查 技能

> SQL 的问题分两类，**先分对错再谈快慢**：
> 结果错的 SQL，再快也是灾难；慢但对的，优化空间大。
> 判据：**这条 SQL 在边界数据（NULL/重复/大表/空集）下还对吗？**

## 什么时候用

- 新写/改动一条复杂 SQL
- 查询慢
- 报表数字对不上
- 迁移前的 SQL 检查

## 什么时候**不**用

- 简单的 `SELECT * FROM t WHERE id = ?`（主键查）
- 只查 ORM 用法 → 看 ORM 文档

## 第 1 步：先查正确性（比性能重要）

### 1.1 NULL 的陷阱

| 陷阱 | 后果 |
|---|---|
| `WHERE col != 'x'` 漏掉 NULL 行 | NULL != 'x' 是 UNKNOWN 不是 TRUE |
| `COUNT(col)` 不数 NULL | 与 `COUNT(*)` 不同 |
| `SUM` 遇全 NULL 返回 NULL | 不是 0 |
| `NOT IN (子查询含 NULL)` | 返回空集 |

⛔ `NOT IN` 子查询里有 NULL = 永远空结果，最难发现的错。

### 1.2 JOIN 的陷阱

| 陷阱 | 后果 |
|---|---|
| 一对多 JOIN 后聚合 | 主表行被放大，SUM 翻倍 |
| 隐式笛卡尔 | 忘写 ON 条件 |
| LEFT JOIN 后 WHERE 过滤右表 | 变成 INNER JOIN |
| 多表 JOIN 的重复 | 需 DISTINCT 或子查询先去重 |

⛔ 「JOIN 后 SUM 翻倍」是报表数字错的最常见原因。

### 1.3 聚合的陷阱

| 陷阱 | 说明 |
|---|---|
| `GROUP BY` 漏字段 | 非标准 SQL 会报错或取值不确定 |
| `HAVING` vs `WHERE` 混用 | WHERE 在聚合前，HAVING 在后 |
| 窗口函数分区错 | `PARTITION BY` 不对 |

## 第 2 步：再查性能

### 2.1 索引可用性

| 反模式 | 为什么慢 |
|---|---|
| `WHERE func(col) = ?` | 函数让索引失效 |
| `WHERE col LIKE '%x'` | 前导通配 |
| `WHERE col::text = '1'` | 隐式类型转换 |
| `OR` 跨不同列 | 可能走不了索引 |
| 复合索引顺序不对 | 最左前缀失效 |

### 2.2 执行计划（EXPLAIN）

| 看到什么 | 含义 |
|---|---|
| **全表扫描**（Seq Scan）大表 | 缺索引或索引失效 |
| **Nested Loop** 大表 | 可能是 N+1 |
| **filesort / temp table** | 排序/聚合内存不够 |
| 预估行数 vs 实际 | 统计信息过期 |

### 2.3 N+1

应用层循环里每条查一次 = N+1 查询。要改成 JOIN 或批量 IN。

## 第 3 步：边界数据测试

| 边界 | 试什么 |
|---|---|
| 空集 | 返回什么（0 行 vs NULL） |
| 单行 | 聚合对吗 |
| 大表 | 会不会超时 |
| NULL 多 | 过滤/聚合对吗 |
| 重复多 | JOIN 后翻倍吗 |

## 输出格式

**结论**：`四态: PASS | WARN | FAIL | UNKNOWN`
- PASS = 结果在边界下正确 + 执行计划无全表扫描 + 无 N+1
- WARN = 结果对但性能隐患（缺索引/全表扫）
- FAIL = 结果错（NULL/JOIN 翻倍/NOT IN NULL）
- UNKNOWN = 无法看执行计划

**1. 正确性**
| 检查 | 结果 |
|---|---|
| NULL 处理 | |
| JOIN 无放大 | |
| 聚合无重复 | |
| NOT IN 无 NULL | |

**2. 性能**
| 检查 | 结果 |
|---|---|
| 索引可用 | |
| 执行计划 | |
| 有无全表扫 | |

**3. 边界**
| 边界 | 结果对吗 |
|---|---|

**4. 判不了的部分**
- <拿不到执行计划/数据分布>

## 假阳性清单（这些不算「SQL 没问题」）

- 小数据量跑得快（大表会崩）
- 结果「看起来对」（边界没测）

## 假阴性清单（最常漏的 8 类）

1. **`NOT IN` 子查询含 NULL**（永远空）
2. **JOIN 后 SUM 翻倍**
3. **`WHERE col != x` 漏 NULL**
4. **函数包列**（索引失效）
5. **前导通配 `LIKE '%x'`**
6. **隐式类型转换**
7. **N+1 查询**
8. **LEFT JOIN + WHERE 右表条件**（退化 INNER）

## 本仓库可用的命令

```bash
node tools/memory/query.mjs          # 查询示例
node tools/quality/commit-gate.mjs   # 提交前门禁
```

## 与其他技能的关系

- `schema-design`：表结构（本技能查查询）
- `perf-profile`：整体性能
- `data-reconcile`：报表数字对不上
- `data-migration`：迁移 SQL 检查

## 边界（如实说清）

- 执行计划因数据分布而异，小表测不出大表问题
- 不同数据库方言差异大（NULL 排序、类型转换）
- 本技能不改 SQL，只指出问题
