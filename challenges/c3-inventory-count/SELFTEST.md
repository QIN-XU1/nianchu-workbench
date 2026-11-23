# SELFTEST — c3-inventory-count `check.mjs`

自测在 `2026-11-06` 执行，Node v24（ESM），Windows + PowerShell 5.1。
可复现：在 `challenges/c3-inventory-count/` 下运行 `node selftest.mjs`（全自动，含临时目录清理与原始数据哈希比对）。

## 0. 被测文件

- `check.mjs` — 校验脚本，仅 `import ... from 'node:fs'` 与 `'node:path'`，无第三方依赖。
- `selftest.mjs` — 自动化自测（不影响被测脚本，可删除）。

## 1. 原始 `data/` 应 PASS

```
$ node check.mjs c3-inventory-count
PASS c3-inventory-count: 差异集合 = 0
$ echo $LASTEXITCODE
0
```

判定：stdout 恰好一行、匹配 `PASS <id>: 差异集合 = 0`、exit 0 → **通过**。

## 2. 临时副本制造错误（4 类共 5 个用例）

所有副本写入 `%TEMP%\c3-selftest-<guid>\`（`mkdtemp` 生成），通过
`SEA_DATA_DIR` 指向副本运行，**不触碰** 原始 `data/`。

| # | 制造的错误 | 期望 | exit | 实际输出 | 结果 |
|---|---|---|---|---|---|
| 1 | book 里 `SKU-B` 在 count 缺失 | FAIL，命中 SKU-B | 1 | `FAIL c3-inventory-count: 差异集合 = 1 项`<br>`  - book.json 有 sku "SKU-B"（book.json 第 2 项），count.json 缺失该实盘记录` | 通过 |
| 2 | count 里出现 book 没有的 `SKU-C`（master 已含 SKU-C） | FAIL，命中 SKU-C | 1 | `FAIL c3-inventory-count: 差异集合 = 1 项`<br>`  - count.json 有 sku "SKU-C"（count.json 第 3 项），book.json 无对应账面记录` | 通过 |
| 3 | `SKU-B` 两边 qty 不一致（20 vs 21） | FAIL，命中 qty 不一致 | 1 | `FAIL c3-inventory-count: 差异集合 = 1 项`<br>`  - sku "SKU-B" qty 不一致：book.json=20（book.json 第 2 项），count.json=21（count.json 第 2 项）` | 通过 |
| 4a | `SKU-B` 不在 `master.json` | FAIL，命中不在 master | 1 | `FAIL c3-inventory-count: 差异集合 = 2 项`<br>`  - book.json 第 2 项 的 sku "SKU-B" 不在 master.json`<br>`  - count.json 第 2 项 的 sku "SKU-B" 不在 master.json` | 通过 |
| 4b | `SKU-B` 的 `name` 为空（`"  "`） | FAIL，命中 name 为空 | 1 | `FAIL c3-inventory-count: 差异集合 = 1 项`<br>`  - book.json 第 2 项 的 sku "SKU-B" name 为空` | 通过 |

说明：4a 报 2 项符合设计——主数据外键在 book 与 count 两处各校验一次，每条都能定位到具体文件与项。

`selftest.mjs` 对每个用例还强制校验三件事：首行严格等于 `FAIL <id>: 差异集合 = N 项`、exit 非 0、
后续每一行都以 `  - ` 开头且非空。

```
OK   原始 data/ 应 PASS — exit=0 out="PASS c3-inventory-count: 差异集合 = 0"
OK   错误1 book 中 SKU-B 在 count 缺失 — exit=1 head="FAIL c3-inventory-count: 差异集合 = 1 项" 命中=全部
OK   错误2 count 出现 book 没有的 SKU-C — exit=1 head="FAIL c3-inventory-count: 差异集合 = 1 项" 命中=全部
OK   错误3 SKU-B qty 不一致 (20 vs 21) — exit=1 head="FAIL c3-inventory-count: 差异集合 = 1 项" 命中=全部
OK   错误4a SKU-B 不在 master.json — exit=1 head="FAIL c3-inventory-count: 差异集合 = 2 项" 命中=全部
OK   错误4b SKU-B name 为空 — exit=1 head="FAIL c3-inventory-count: 差异集合 = 1 项" 命中=全部
OK   临时目录已清理 — C:\Users\15282\AppData\Local\Temp\c3-selftest-0rZTrZ
OK   原始 data/ 字节未变（SHA256 一致） — 一致

自测结果：8/8 通过
```

## 3. 原始 `data/` 一字未改 + 临时文件清理

自测前后对 `data/` 三个文件取 SHA256，完全一致：

```
book.json    9EE58BDBE295BF664428A7328A3B2E33DC7CDB8D95D2EB9264EDC4C6D345F9B4
count.json   BC53EC85311FDDC95F0E5B564362105165662B61FFA765D66626E155C2110B01
master.json  DB37075BF7484FF1C076FE9B10AFBE490C5752E2ADF9314E8D9B6A04C2802E30
```

临时目录：每次用例结束后 `%TEMP%` 下无 `c3-*` 残留（`Get-ChildItem $env:TEMP -Directory | ? Name -like 'c3-*'` → none）。

## 4. 附加健壮性验证（额外项，均通过）

- **BOM 容忍**：用 PowerShell 5.1 `Set-Content -Encoding utf8` 造带 BOM（实测会写出重复 BOM `EF BB BF EF BB BF`）的三份 JSON，
  `SEA_DATA_DIR` 指向该目录 → `PASS ... 差异集合 = 0`，exit 0。脚本剥离开头任意个 `U+FEFF`。
- **默认数据目录**：不设 `SEA_DATA_DIR`、在场景目录运行 → 回落到 `import.meta.dirname/data` → PASS，exit 0。
- **数据目录缺失/不可读**：`SEA_DATA_DIR` 指向空目录 → `FAIL ... 差异集合 = 3 项`，每个文件一行 `无法读取（绝对路径）：ENOENT ...`，exit 1。
- **JSON 损坏**：解析失败计为差异项并带行列定位（文件名 + 绝对路径 + 解析器消息），exit 1。

## 5. 契约对照

| 契约要求 | 实现 |
|---|---|
| 文件 `check.mjs`，`node check.mjs <sceneId>` | ✅ 取 `process.argv[2]` 作 id，缺省 `c3-inventory-count` |
| 数据目录 `SEA_DATA_DIR`，默认同目录 `data/` | ✅ `process.env.SEA_DATA_DIR || join(import.meta.dirname, 'data')` |
| 通过 `PASS <id>: 差异集合 = 0` | ✅ 单行，exit 0 |
| 失败 `FAIL <id>: 差异集合 = N 项` + 每项一行 `  - <具体项>` | ✅ 每项含文件名、第几项、SKU、双方 qty 值 |
| 只用 node:fs / node:path | ✅ 仅这两条 import |
| 不变量 `completeness` | ✅ book/count SKU 集合双向对称差 |
| 不变量 `referential-integrity` | ✅ book 与 count 的 SKU 均须在 `master.json` |
| 不变量 `required-field` | ✅ book 的 `name` 非空；`sku` 有效；`qty` 为有限数字 |
| 业务语义 qty 相等 | ✅ 同 SKU 两侧 qty 严格比较 |

差异项均为“可定位到具体数据”的形式：`<文件> 第 <n> 项 ... sku "<SKU>" ...`。
