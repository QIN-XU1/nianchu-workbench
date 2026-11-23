# 对标解析工具箱

> 本目录里每个脚本都是**可复算证据的生成器**。档案里任何一个「N 条去重文案」的数字，都能用这里的一条命令重跑出来。
> 纪律：不联网、不 pip/npm 安装新东西（只复用本机已有的 `@electron/asar`）。

## 0. 前置

```powershell
# 统一 UTF-8，否则中文关键字在 PowerShell 里会被弄坏
$OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
```

## 1. `extract-asar.mjs` —— 解包 Electron `app.asar`

```powershell
node research/frontend-benchmark/tools/extract-asar.mjs <app.asar> <outDir>
```

- 依赖 `@electron/asar`（本机 npx 缓存里已有）。解析顺序：`ASAR_MODULE_DIR` → 仓库 `node_modules` → `workbench/外壳/node_modules` → npx 缓存兜底。
- 实测耗时：WorkBuddy 165MB→9s；Cherry 231MB→9s。
- ⚠ 解包产物（`research/*-renderer/`）**已在 `.gitignore` 里**：可 5 分钟重建，不进 git。

## 2. `zh-by-area.mjs` —— 按「功能区」抽中文 UI 文案

```powershell
$env:ZH_MAX_BYTES='90000000'; $env:ZH_DECODE='1'
node --max-old-space-size=8192 research/frontend-benchmark/tools/zh-by-area.mjs `
  <rendererDir> research/frontend-benchmark/evidence/<name>-by-area.json 30000 3
```

参数：`<root> <outJson> [topPerArea=40] [areaDepth=3]`

- **`ZH_MAX_BYTES`**：单文件上限。默认 12MB —— VS Code 分支的 AI 主体是 **60MB 单 bundle**（CodeBuddy CN），Cherry 有 1.8MB 分包，都要放开到 90MB。
- **`ZH_DECODE=1`**：先还原 `\uXXXX` 再匹配。**CodeBuddy CN 全程转义**，不还原整个包只剩 26 条（实测 5,729 vs 26）。
- **`topPerArea` 必须给大**（如 30000）：给 300 会把绝大多数条目截掉，后续 grep 会得出「某功能不存在」的**错误结论**（已踩过）。

## 3. `zh-grep.mjs` —— 关键词检索

```powershell
node research/frontend-benchmark/tools/zh-grep.mjs `
  research/frontend-benchmark/evidence/<name>-by-area.json 助手 技能 审批 上下文
```

## 4. `zh-show.mjs` —— 看某区 top N

```powershell
node research/frontend-benchmark/tools/zh-show.mjs `
  research/frontend-benchmark/evidence/<name>-by-area.json 120
```

## 5. 各对标目标的完整复现命令

| 目标 | 解包 | 抽取 | 规模 |
|---|---|---|---|
| Qoder | `... Qoder/resources/app.asar research/qoder-renderer` | `zh-by-area qoder-renderer/out/renderer` | 14,129 条 |
| WorkBuddy | `... WorkBuddy/resources/app.asar research/wb-renderer` | 同上（`wb-renderer`） | 12,095 条 |
| CodeBuddy CN | **无需解包**（VS Code 分支，`resources/app` 直接可读） | `zh-by-area "CodeBuddy CN/resources/app/out"` + `ZH_DECODE=1` | 5,729 条 |
| Cherry Studio | `... Cherry Studio/resources/app.asar research/cherry-renderer` | `zh-by-area cherry-renderer/out/renderer` | 20,286 条 |

## 6. 已知坑（写下来省下一次）

1. **去重条数 ≠ 功能密度**。组件库 demo 页（`值1` `值2` `美國（NASD）30/360`）和 Emoji 分类名（`旗子` `動物`）会把 Top 频次占满。档案里必须显式剔除并说明。
2. **VS Code 分支的中文在 `\uXXXX` 里**，`rawZh=0` 是正常现象，不是没有中文。
3. **CSS 令牌统计要单独做**（`--var: value` 正则），不要指望文案抽取覆盖。
4. **拿不到截图就别打美观分**，记 `?`。WorkBuddy / CodeBuddy CN / Cherry 都因登录墙或未启动，美观一律记 `?`。
5. **闭源的模块边界不可读**：Vite 分包（Cherry 3,881 文件）和 60MB 单 bundle（CodeBuddy）都还原不出模块结构，功能归属只能靠「文案 + `package.json` 依赖面」交叉验证 —— 依赖面往往比文案更硬（Cherry 的双 Agent 内核就是从依赖看出来的）。
