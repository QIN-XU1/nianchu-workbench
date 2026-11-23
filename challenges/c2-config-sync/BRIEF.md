# 配置同步

三个环境的配置键集合必须一致

## 你必须保证的不变量

- `completeness`
- `uniqueness`

## 业务语义

dev.json / staging.json / prod.json 是三个环境的配置项数组（每项有 key / value）。三个环境必须拥有相同的 key 集合（不允许某环境缺键或多键）。每个环境内部 key 不得重复。

## check 脚本契约

- 文件：同目录下 `check.mjs`
- 运行时：`node check.mjs <sceneId>`
- 数据目录：环境变量 `SEA_DATA_DIR`（默认同目录 `data/`）
- 退出码：0 = 通过；非 0 = 失败
- **失败时必须输出一行 `FAIL <id>: 差异集合 = N 项`，随后每项一行 `  - <具体项>`**
- 通过时输出 `PASS <id>: 差异集合 = 0`
- 只允许用 Node 内置模块（node:fs / node:path）

## 可用数据

- `dev.json`
- `staging.json`
- `prod.json`