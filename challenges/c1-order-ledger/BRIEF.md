# 订单台账

订单与发货记录必须一一对应，金额一致

## 你必须保证的不变量

- `completeness`
- `uniqueness`
- `referential-integrity`

## 业务语义

orders.json 是订单列表（每项有 id / amount / status）。shipments.json 是发货记录（每项有 id / orderId / amount）。任意订单必须有对应发货记录；任意发货记录必须指向存在的订单；orderId 不得重复；金额必须一致。

## check 脚本契约

- 文件：同目录下 `check.mjs`
- 运行时：`node check.mjs <sceneId>`
- 数据目录：环境变量 `SEA_DATA_DIR`（默认同目录 `data/`）
- 退出码：0 = 通过；非 0 = 失败
- **失败时必须输出一行 `FAIL <id>: 差异集合 = N 项`，随后每项一行 `  - <具体项>`**
- 通过时输出 `PASS <id>: 差异集合 = 0`
- 只允许用 Node 内置模块（node:fs / node:path）

## 可用数据

- `orders.json`
- `shipments.json`