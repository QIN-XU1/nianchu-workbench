# 库存盘点

账面库存与实盘记录一致，且 SKU 必须在主数据

## 你必须保证的不变量

- `completeness`
- `referential-integrity`
- `required-field`

## 业务语义

book.json 是账面库存（每项有 sku / qty / name）。count.json 是实盘记录（每项有 sku / qty）。每个 SKU 必须有实盘记录（反之亦然）；qty 必须相等；SKU 必须在 master.json 列表里；name 不得为空。

## check 脚本契约

- 文件：同目录下 `check.mjs`
- 运行时：`node check.mjs <sceneId>`
- 数据目录：环境变量 `SEA_DATA_DIR`（默认同目录 `data/`）
- 退出码：0 = 通过；非 0 = 失败
- **失败时必须输出一行 `FAIL <id>: 差异集合 = N 项`，随后每项一行 `  - <具体项>`**
- 通过时输出 `PASS <id>: 差异集合 = 0`
- 只允许用 Node 内置模块（node:fs / node:path）

## 可用数据

- `book.json`
- `count.json`
- `master.json`