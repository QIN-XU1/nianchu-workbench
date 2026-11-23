# c2-config-sync 自测记录

被测脚本：`check.mjs`（Node ESM，仅用 `node:fs` / `node:path`）
运行方式：`node check.mjs c2-config-sync`
数据目录：`process.env.SEA_DATA_DIR`，未设置时默认 `join(import.meta.dirname, 'data')`
自测环境：Windows，Node v24.18.0

## 用例与结果

### 1. 基线（原始 `data/`）— 应 PASS

命令：

```
node check.mjs c2-config-sync
```

输出：

```
PASS c2-config-sync: 差异集合 = 0
```

退出码：`0` ✅ 符合契约。

同时验证了默认数据目录解析：从 `%TEMP%` 目录（cwd 不是脚本目录）运行且不设置 `SEA_DATA_DIR`，仍输出同样 PASS、exit 0，说明 `join(import.meta.dirname, 'data')` 生效。

### 2. 负例（均在 `data/` 的临时副本上构造，不修改原始数据）

每个用例把 `data/` 的三个 json 复制到系统临时目录，只改动其中一处，然后用 `SEA_DATA_DIR=<该临时目录>` 运行脚本。

#### case1 — staging 删掉一个 key（completeness）

变异：`staging.json` 中删除 `key = "logLevel"` 的项。

```
FAIL c2-config-sync: 差异集合 = 1 项
  - staging.json: 缺少 key "logLevel"（该 key 存在于 dev、prod）
```

退出码：`1` ✅ 报告了差异集合，且定位到具体文件 / 具体 key / 该 key 现存于哪些环境。

#### case2 — prod 多加一个别的环境没有的 key（completeness）

变异：`prod.json` 追加一项 `{ "key": "maxBodySize", "value": 1048576 }`。

```
FAIL c2-config-sync: 差异集合 = 2 项
  - dev.json: 缺少 key "maxBodySize"（该 key 存在于 prod）
  - staging.json: 缺少 key "maxBodySize"（该 key 存在于 prod）
```

退出码：`1` ✅ 多出的 key 按「哪个环境缺失」逐项展开，因此 1 个多余 key 报 2 条（dev 与 staging 各缺一项），可直接定位到要补的位置。

#### case3 — 某环境内部重复 key（uniqueness）

变异：`dev.json` 追加一项 `{ "key": "retries", "value": 9 }`，使其内部 `retries` 出现两次。

```
FAIL c2-config-sync: 差异集合 = 1 项
  - dev.json: key "retries" 重复出现 2 次（第 2、4 项）
```

退出码：`1` ✅ 定位到具体文件、具体重复 key、重复次数与重复所在的数组项序号。

## 汇总

| 用例 | 变异 | 期望 | 实际首行 | 退出码 |
| --- | --- | --- | --- | --- |
| baseline | 无（原始 data/） | PASS | `PASS c2-config-sync: 差异集合 = 0` | 0 |
| case1-missing-key | staging.json 删除 `logLevel` | FAIL | `FAIL c2-config-sync: 差异集合 = 1 项` | 1 |
| case2-extra-key | prod.json 增加 `maxBodySize` | FAIL | `FAIL c2-config-sync: 差异集合 = 2 项` | 1 |
| case3-duplicate-key | dev.json 重复 `retries` | FAIL | `FAIL c2-config-sync: 差异集合 = 1 项` | 1 |

三个负例互相独立（缺键 / 多键 / 环境内重复），均被捕获并输出 `  - ` 前缀的逐项差异，符合 BRIEF.md 的 check 脚本契约。

## 附：额外健壮性验证

### A. 组合负例（多问题同时存在时差异集合应累加）

在同一个临时副本上同时施加三种变异（dev 重复 `retries`、staging 删 `logLevel`、prod 加 `maxBodySize`）：

```
FAIL c2-config-sync: 差异集合 = 4 项
  - dev.json: key "retries" 重复出现 2 次（第 2、4 项）
  - staging.json: 缺少 key "logLevel"（该 key 存在于 dev、prod）
  - dev.json: 缺少 key "maxBodySize"（该 key 存在于 prod）
  - staging.json: 缺少 key "maxBodySize"（该 key 存在于 prod）
```

退出码：`1` ✅ 三类问题全部被收集，N 正确累加为 4（1 个内部重复 + 1 个缺键 + 1 个多出键展开出的 2 条缺失）。

### B. BOM 容忍

用 `[System.IO.File]::WriteAllBytes` 给 `dev.json` 写入 UTF-8 BOM 后运行，仍输出 `PASS c2-config-sync: 差异集合 = 0`、exit 0 ✅


在自测过程中曾用 PowerShell 5.1 写副本，其 `-Encoding utf8` 会写入 BOM，`JSON.parse` 因此报 `Unexpected token ''`。这属于自测工具本身的问题（随后改用 Node 生成副本，并改用 `utf8NoBOM` 等价的无 BOM 写入），但为稳妥起见 `check.mjs` 已对文件头 BOM 做了剥离处理，避免因编辑器 / Windows 工具重存导致的假失败。

## 数据完整性

自测全程未修改 `data/` 下原始文件，三个负例都在系统临时目录的副本上构造；自测结束后临时目录与临时辅助脚本已清理。`data/` 仍只包含 `dev.json`、`staging.json`、`prod.json`，内容未变。
