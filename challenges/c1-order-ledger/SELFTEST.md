# SELFTEST — c1-order-ledger check.mjs

环境：Node v24.18.0 (Windows, PowerShell)
被测脚本：`check.mjs`（契约见 BRIEF.md）

## 1. 正常数据（未修改的 data/）

命令：`node check.mjs c1-order-ledger`

```
PASS c1-order-ledger: 差异集合 = 0
exit=0
```

## 2. 故障注入（复制到临时目录，原始 data/ 未改动）

临时目录 `%TEMP%\ledger-selftest`，每个用例单独一份 `orders.json` + `shipments.json`，
通过 `SEA_DATA_DIR` 指向该目录后运行同一脚本。

### 用例 A — 删掉一条 shipments 记录（制造悬空订单）

改动：从 `shipments.json` 删除 `S-2`（orderId=O-2），其余不变。

```
FAIL c1-order-ledger: 差异集合 = 1 项
  - 订单 O-2 缺少对应发货记录（completeness 不变量被破坏）
err1 exit=1
```

### 用例 B — 改掉某条金额

改动：`S-1`（orderId=O-1）的 amount 由 120 改为 999。

```
FAIL c1-order-ledger: 差异集合 = 1 项
  - 金额不一致: 订单 O-1 amount=120，但发货记录 S-1 amount=999
err2 exit=1
```

### 用例 C — 让两条 shipments 有相同 orderId

改动：`S-2` 的 orderId 由 `O-2` 改为 `O-1`（金额一并改为 120），造成 O-1 被 S-1、S-2 重复引用。

```
FAIL c1-order-ledger: 差异集合 = 2 项
  - orderId 重复: O-1 同时被发货记录 S-1 和 S-2 引用（每个订单只能有一条发货记录）
  - 订单 O-2 缺少对应发货记录（completeness 不变量被破坏）
err3 exit=1
```

### 用例 D — 发货记录指向不存在的订单（补充覆盖 referential-integrity）

改动：`S-1` 的 orderId 由 `O-1` 改为 `O-999`（该订单不存在）。

```
FAIL c1-order-ledger: 差异集合 = 2 项
  - 发货记录 S-1（orderId=O-999） 指向不存在的订单：orderId=O-999（referential-integrity 不变量被破坏）
  - 订单 O-1 缺少对应发货记录（completeness 不变量被破坏）
err4 exit=1
```

## 结论

- 正常数据：PASS，差异集合 = 0，exit 0。
- A/B/C/D 四种真实错误：全部 FAIL（exit 1），差异集合非 0，且每项一行可定位到具体 id / 金额。
- 覆盖三条不变量：completeness（A/C/D）、uniqueness（C）、referential-integrity（D），以及金额一致（B）。
- 原始 `data/` 文件未被修改。
