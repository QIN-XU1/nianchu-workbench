# career-ops 拆解（v2：只写「我们能抄什么」）

> 仓库：`santifer/career-ops`（本地 `D:\refs\career-ops`，HEAD `b2f3d89`，2026-11-17T07:49:50Z）
> 读法：结论全部来自源码，行号以本地克隆为准。它是 **agent 驱动的运营工作流系统**（找工作的整条流水线），
> 正好落在我们关心的三件事上：工作流状态机、人在环断点、记录落盘与回放。

---

## 1. 定位与规模

一句话：不是 agent 运行时，而是**一套长在「宿主 AI CLI」上的运营工作流**——把「扫职位 → 判定是否还在招 → 按 A–H 模板打分 → 定制 CV/PDF → 填表（绝不提交）→ 跟踪状态」写成一组 Markdown 提示词（`modes/*.md`，47 个 mode）＋约 230 个单职责 `.mjs` 脚本，由用户自己的 Claude Code / Codex / OpenCode / Gemini / Qwen / Grok 执行（`ARCHITECTURE.md:10`，`package.json:90-106` 的 keywords 列的就是这些 CLI）。

- 文件数 **3886**（用户给定；实测 `tests/**/*.test.mjs` 就有 **1275** 个）。主语言 **纯 ESM JavaScript**（无构建、无 TS 主源）；`web/` 内才是 TS+React（`web/package.json`）。
- 版本 `1.40.0`、engines node `^22.13.0 || >=23.4.0`、运行时依赖仅 **5 个**：`@google/generative-ai / dotenv / js-yaml / playwright / undici`（`package.json:3,6-8,114-120`）。零框架。
- 最近 push：`2026-11-17T07:49:50Z`（`git log -1`）。
- 体量失控的体感：`scan.mjs` 300 KB、`test-all.mjs` 1,061 KB、`update-system.mjs` 301 KB、`verify-cv-facts.mjs` 247 KB、`merge-tracker.mjs` 145 KB。

**它的产品形态和我们几乎同构**：文件是唯一真相、CLI 是执行器、人按最后一步、UI 只读文件。所以下面 10 段全写。

---

## 2. 架构骨架

### 2.1 顶层目录 → 职责（附证据）

| 目录 / 文件 | 职责 | 证据 |
|---|---|---|
| `modes/*.md`（47 个 mode + 多语言子目录） | **大脑**：工作流定义全在提示词里（`oferta.md` 打分、`apply.md` 填表、`pipeline.md` 批处理、`agent-inbox.md` 队列协议） | `ARCHITECTURE.md:45-48,62-63` |
| `providers/*.mjs`（169 个） | 零密钥公开职位源，一家 ATS 一个模块（greenhouse/ashby/lever/workday…） | `ARCHITECTURE.md:42-43` |
| `plugins/`（36 files）+ `plugins-registry/`（13 json） | 需要密钥 / 外部服务的集成，走插件引擎（第 3 段） | `plugins/_engine.mjs:1-25` |
| 根 `*.mjs` | 一脚本一职责（扫描/评估/生成/跟踪/自更新） | `ARCHITECTURE.md:26-30` |
| `data/` `reports/` `jds/` `output/` | **用户层**：`data/applications.md` 跟踪表、`reports/{NNN}-*.md` 评估报告 | `ARCHITECTURE.md:53-54`、`DATA_CONTRACT.md:39-41,68` |
| `web/`（906 files） | Next.js 16 + React 19 的本地 Web 工作台（17 个页面 + 80+ API 路由） | `web/package.json:5,18-24` |
| `dashboard/`（117 files） | 独立 Go TUI，只读流水线（Inbox / Pipeline / 统计） | `ARCHITECTURE.md:65-66`、`dashboard/main.go` |
| `evals/`（139 files） | 金标集 + 记录/回放夹具 | `evals/README.md:1-20`、`evals/record-claude.mjs:1-30` |
| `batch/` | 批处理编排器（状态机在第 6 段） | `batch/batch-runner.sh` |
| `templates/states.yml` | **状态机唯一真相**（11 个状态 + 别名 + terminal 标记） | `templates/states.yml:1-86` |

### 2.2 依赖方向 / 单向约束

- 插件引擎只向下依赖基础库：`_net.mjs`、`../url-key.mjs`、`../path-resolver.mjs`、`_lock.mjs`、`_registry.mjs`（`plugins/_engine.mjs:30-34`），且**声明零模块级副作用**（`:9-13`）——`scan.mjs` 每次运行都 import 它，必须免费。
- 单职责脚本彼此靠 `lib/`（72 个）下沉公共逻辑，例如 `lib/agent-launch.mjs:1-6` 明确把「启动 CLI」与「加载 dotenv」拆开，好让 `batch-tailor.mjs` 不必装 npm 包。

### 2.3 核心 / 插件边界：**有，且靠 CI 脚本强制**

- 系统层 vs 用户层是**第一架构规则**：系统层（`modes/ scripts/ templates/ dashboard/`）会被 `update-system.mjs` 更新，用户层（`cv.md config/profile.yml data/ reports/`）永不被碰（`ARCHITECTURE.md:13-20`）。
- 边界不靠类型，靠**白名单 + 覆盖率守卫**：`SYSTEM_PATHS` 在 `lib/update-manifest.mjs`，`updater-migration-tests.mjs` 断言「系统路径与用户路径永不重叠」，`validate-system-paths-coverage.mjs` 在 CI 里保证「每个根脚本都登记进 SYSTEM_PATHS」（`ARCHITECTURE.md:17-20,28`）。
- 「文件是正典，DB 只是派生」是写死的教条：SQLite 只做索引、可删除重建，永不成为第二真相源（`ARCHITECTURE.md:22-24`、`DATA_CONTRACT.md:41`）。

---

## 3. 【A12】插件 / 扩展机制 —— 重中之重

> 结论先行：**这是全仓对我们最有价值的一段**。它不是「静态 skill 分发」，而是**完整的插件内核**：JSON manifest → 目录发现 → 手写校验 → 动态 import → 能力受限 ctx → 能力同意卡 → 钉 sha 安装 → 完整性锁防 rug-pull → 启用/禁用/卸载 CLI。可直接对着我们 `tools/plugin/kernel.mjs` 抄。

### 3.1 插件清单长什么样

`plugins/<id>/manifest.json`（**JSON 解析、不执行**，所以 `doctor` 能不 import 代码就列出插件，`plugins/_types.js:14-16`）：

```json
// plugins/gmail/manifest.json:1-14
{ "id": "gmail", "name": "Gmail ingest", "version": "1.0.0", "apiVersion": 1,
  "description": "Pull job leads from a Gmail label into your pipeline (read-only, your OAuth token).",
  "hooks": ["ingest"], "jobPostings": true,
  "requiredEnv": ["GMAIL_CLIENT_ID","GMAIL_CLIENT_SECRET","GMAIL_REFRESH_TOKEN"],
  "allowedHosts": ["oauth2.googleapis.com","gmail.googleapis.com"],
  "skill": "skill.md", "humanInTheLoop": true, "homepage": "..." }
```

字段表见 `plugins/_types.js:28-41`；模板 `plugins/_template/manifest.json:1-13`。要点：
- `id` 必须等于目录名（去重键 + 防伪装，`_engine.mjs:244`）。
- `humanInTheLoop` **必须 true，硬拒 false**（`_engine.mjs:247`）；`hooks` 只能是闭集 `['provider','ingest','search','notify','export']`（`:37`），**故意没有 apply/submit**。
- 带 `requiredEnv`（读密钥）的插件**必须**声明非空 `allowedHosts` 出网白名单（`:265`）。

### 3.2 怎么被发现

`discoverPlugins(roots, overrideIds)`（`_engine.mjs:342-395`）：按 `pluginRoots()` = `[plugins/, plugins.local/]` 顺序扫（`:433-435`），**第一个出现的 id 赢**（bundled 遮蔽同名 local）；目录须含 `manifest.json`；`_`/`.` 前缀跳过；符号链接按目录处理（`:360-368`）。

**唯一越权例外**是 `resolveSuccessorIds()`（`:411-426`）：社区插件若在 registry 里声明 `supersedesBundled:true`，且用户**已装且 sha 精确等于 registry 钉的 sha**，才允许 local 覆盖 bundled——「无降级」不变式（`:328-336`）。

### 3.3 怎么校验（手写，fail-open）

`validateManifest()`（`_engine.mjs:239-321`）逐条 `if` 判断，失败 `warnSkip()` 打一行 ⚠️ 并跳过，**永不 throw、永不让一个坏 manifest 拖死核心**（`:120-122,241`）。校验项含：id 正则（`:55`）、`apiVersion===1`、`description` 单行非空、hooks 闭集、reserved env 拒绝（`:46-53` 的 `GEMINI_API_KEY/PATH/AWS_*` 等）、SSRF 型 host 拒绝（IP 字面量、`169.254.*`、`metadata.google.internal`、`*.internal`，`:271-276`）、entry 必须 `.mjs` 且不逃出插件目录（`:285-288`）、可选 `skill` 路径同样防穿越（`:293-300`）。**没有 JSON Schema 文件**——这一点我们抄时要么接受手写、要么补 schema。

Registry 侧另有一套 `validateRegistryEntry()`（`plugins/_registry.mjs:116-136`）：name 必须 `career-ops-plugin-<id>`、repo 必须 `https://github.com/<owner>/<repo>`、sha 必须 40-hex、hooks 子集、keyed 插件必须给 allowedHosts。

### 3.4 怎么装载（动态 import，无沙箱）

`importHook()`：`await import(pathToFileURL(entry).href)` 后取 `mod.default[kind]`（`_engine.mjs:614-633`）。**隔离能力是明说的「便利不是沙箱」**（`:18-21`、`_types.js:44-48`）：plain ESM 无法 VM 隔离。

但「能力对象」设计得很干净（`buildCtx()`，`:557-606`）：
- `env`：只把本插件声明的 required∪optional 变量做成**冻结副本**（`:558-562`）；
- `fetch/fetchText/fetchJson`：唯一出网原语，强制 HTTPS + `allowedHosts` + 手动重定向**逐跳重校验** + 跨主机剥 `authorization/cookie` + SSRF 解析校验（`makeGuardedFetch`，`:479-547`）；
- `log`：自动把声明的 secret 值替换成 `«redacted»`（`:569-576`）；
- `dataRoot` / `normalizePostingUrl` / `aggregatorPostingId`：把数据根与去重键交给插件（`:594-604`）。

### 3.5 贡献点：插件能加什么

闭集 hook 就是贡献点清单（`_engine.mjs:37`，语义在 `_types.js:80-101`）：`provider`（带密钥的职位源）、`ingest`（从邮箱/Notion 拉职位）、`search`（查询→职位）、`export`（把 tracker 快照推到外部）、`notify`（出站通知）。**引擎负责写盘，插件只返回数据**（`_types.js:18-21`）——插件永远不能破坏 Web 侧数据格式。可选伴生 `skill.md` 由 agent **按需 pull**，绝不自动注入（`_engine.mjs:290-300,657-672`），还带一套 `SKILL_RED_FLAGS` 提示注入扫描（`:646-655`）。

### 3.6 隔离 / 能力怎么限（分层，诚实标注）

1. manifest 评审（bundled 走与 providers 同一道代码评审闸，`:20-21`）；
2. reserved env 禁声明（`:46-53`）；
3. 出网白名单 + SSRF（`:271-276,497-499`）；
4. 完整性锁 `plugins.lock`（第 3.7）；
5. 明说 `process.env` 仍全局可达——**不装作有沙箱**（`:42-44`）。

### 3.7 热插拔 / 安装 / 启用 / 信任

- CLI 全生命周期在 `plugins.mjs`：`list / available / run / skill / new / add(=install) / enable / trust / remove`（`plugins.mjs:661-675,698-726`）。
- **安装只认钉死的 40-hex commit**：`safeClone` 用 `execFileSync` 跑 git（禁 protocol.ext/file），`fetch --depth 1 <sha>` + `checkout FETCH_HEAD`（`plugin-install.mjs:7-10,25,41-54`）；不在 registry 的仓库必须手给 `--sha`（`plugins.mjs:636-640`）。
- **信任根是「每插件一个 registry 文件」**：`plugins-registry/<id>.json`，只有维护者评审合并的钉 sha 才进得来；一插件一文件使并发 registry PR 永不冲突（`_registry.mjs:1-12,36-46`）。
- **信任分级**由文件系统 + registry 推导，绝不信用户可写的 lock：`bundled / approved / off-registry / unverified`（`_registry.mjs:92-99`）。
- **启用前先出能力同意卡**（`capabilityCard`，`plugins.mjs:480-492,555-569`）；`--confirm` 才写 `plugins.lock` 并置 `enabled:true`。
- **防 rug-pull**：`lockGate()` 对已启用插件在 import 前比对全目录哈希，`drift-nobump`（无版本号变更却改文件）在 local 插件上**拒绝加载**并提示 `plugins.mjs trust <id>`；`surface-widened`（新增 host/env）要求重新同意（`_engine.mjs:688-720`）。哈希是「整目录每个 regular file」（`_lock.mjs:37-60`，`lstat` 拒符号链接）。
- 启用状态存**用户层** `config/plugins.yml`（`setPluginEnabled`，`plugins.mjs:464-475`；示例 `config/plugins.example.yml:16-43`）；`pluginStatus()` 要求「配置 enabled 且 requiredEnv 全在」两道门（`_engine.mjs:444-449`）。

---

## 4. 【A13】MCP / 工具接入

- **仓内没有 MCP client**：根目录无任何 mcp 配置文件（`Get-ChildItem -Filter *mcp*` 为空），全仓不实现 `connectToServer` 之类。MCP 是**宿主 CLI 提供给它的**：`modes/_shared.md:283` 依赖 Playwright MCP 的 `browser_navigate + browser_snapshot` 验证职位；`:287` 可选 Canva MCP 做视觉 CV。
- 反向（生态侧）有：`plugins-registry/workspace-mcp.json:1-17` 是一个第三方插件，hook=`export`、`requiredEnv:[]`、`allowedHosts:[]`，提供「对 application 行 + 报告/CV 路径与字节数的**只读 MCP 访问**」——即 **MCP 被当成一种插件能力对外暴露**，而不是宿主的接入层。
- 结论：A13「MCP client + 工具池 + 管理 UI」在本仓 **无**；可抄的只有「把 MCP 作为 export hook 的一种消费者」这个思路。

---

## 5. 【A11】调度 / 后台任务

- **没有内置常驻 daemon**：调度被明说「交给你自己的操作系统」（`docs/AUTOMATION.md:3-6`）。给了三种 recipe：cron/launchd/Windows Task Scheduler 跑 `scan.mjs`（`AUTOMATION.md:41-60`）、零 token 的 triage 提示词、headless `claude -p` 的 follow-up sweep（`AUTOMATION.md:13-21`，脚本 `scripts/followup-sweep.sh`）。
- Web 侧有一套**真调度数据模型**：`scheduled-jobs` store 是 `{jobs, runs, queue}` 的 JSON，读写走目录锁（`web/src/lib/scheduled-jobs-store.mjs:24-49`）；OS 侧靠 `CRON_MARKER = "# career-ops recurring scan"` + `parseCrontab / parseLaunchctlPrint / nextQuarterHour / osScheduleStatus`（`web/src/lib/scheduled-os-schedule.mjs:1-29`）；本质是「Web 存 cadence，OS 里装一个 15 分钟队列 worker 来 tick」（`AUTOMATION.md:56-58`）。
- 失败/超时/四态：单次扫描 `exit 2` 表示「所有目标都失败」，`exit 0` 表示「至少读到一个 board」，好让监控只报真宕机（`AUTOMATION.md:41-44`）；批处理的失败重试在 `batch/batch-runner.sh`（见 C4）。

---

## 6. 【C1/C2】agent 循环与停止条件

### 6.1 主循环在哪

- **agent 内循环不在本仓**：真正的「模型→工具→再模型」由宿主 CLI 跑。本仓提供的是**外循环 = 批处理编排器** `batch/batch-runner.sh`（2601 行），`process_offer()` 在 `:1219`，主调度在 `main()`（`:2380+` 区间）。
- Web 侧另有一个「跑 agent」的入口：`web/src/app/api/run/route.ts:1-7` 用 `spawnHeadlessCli` 起 worker CLI，并在 `:41` 接 POST，把一次评估/改 CV 变成一次**流式 SSE/NDJSON 任务**（`maxDuration=800`，`:44`）。

### 6.2 一轮的定义 + 停止条件（可判定的，逐条列）

批处理器的状态机 = `batch/batch-state.tsv`（`INPUT_FILE=batch-input.tsv` / `STATE_FILE=batch-state.tsv`，`batch-runner.sh:59-60`）。每条 offer 的状态是闭集：`pending / processing / completed / skipped / failed / rate_limited / paused_rate_limit / needs_confirmation`（`print_status_table` 的 case 分支，`batch-runner.sh` 状态表函数内）。

停止/刹车条件（全部代码可查）：
1. **`--limit N`**：`LIMIT` 默认 0=不限，显式必须正数（`:145,250`），收集 pending 时 `if (LIMIT>0 && >=LIMIT) break`。
2. **`MAX_RETRIES=2`**（`:129`）：失败达上限即 SKIP，`--retry-failed` 才强制重试。
3. **`MIN_SCORE` 阈值**：分数低于 `--min-score` 直接判 `skipped/below-min-score` 并写 discard log。
4. **`WORKER_TIMEOUT=1800`**（`:138`）：单 worker 超时。
5. **限流刹车**：命中限流写 `THROTTLE_FILE`（`:113`）并可能 `BATCH_PAUSED`/`PAUSE_FILE`（`:112,140`），并行度临时降到 1，`--resume-paused` 才续。
6. **人在环刹车**：`needs_confirmation` 的行**不处理**，直接 `HOLD #$id: needs confirmation in the parent session`（`:2413`）；终态 `completed|skipped` 跳过（`:2435`）。
7. **文件存在性刹车（fail-closed）**：worker 退出码 0、自报 status 也「非 failed」，但若 `has_report_file()`（`:1186`）找不到报告文件，一律判 `failed`——「退出码和 JSON 状态都不足以证明报告真的写出来了」。

### 6.3 循环状态怎么持久化 / 断了能续

- 全在 TSV 状态文件里，逐 offer 一行：`id/url/status/started/completed/report/score/error/retries`（`update_state()`，`:885`；`update_state_retrying()`，`:1042`）。
- 状态写盘本身也有韧性：失败重试 3 次，仍失败就写**恢复记录** `append_recovery_record()`（`:906`），下次启动 `reconcile_recovery_records()`（`:973`）对账；两者都失败才报「这次状态没记到任何地方」。
- 并发安全：`reserve-report-num.mjs:11` 用 `O_CREAT|O_EXCL` 哨兵文件原子占号；`session-activity.mjs:1-20` 是「另一个会话可能已经在做这个」的**建议性**信号（故意不硬锁）；`pipeline-lock.mjs`/`dir-lock.mjs` 做写互斥。
- 续跑：`--retry-failed / --resume-paused / --start-from / --company` 都是「从状态文件重算待办」的参数（`batch-runner.sh:124-129,2413-2440`）。

> 对 C2 的直接价值：**停止条件是「一族可判定的护栏」，且「人没确认」本身就是一种一等状态（needs_confirmation）**，不是异常。

---

## 7. 【A6/A7】记忆

- **存储形态 = 用户层纯文件，无向量库**（教条见 `ARCHITECTURE.md:22-24`）。
  - 长期画像：`modes/_profile.md`（用户所有、永不被更新，`modes/_profile.template.md:3-11`）、`config/profile.yml`、`cv.md`。
  - 持久偏好/家规：`modes/_custom.md`——「记在里面的指令不是可选项，跨会话、跨 batch 项都不过期」，且**只有 `retro` 模式能写**，headless/subagent 只上报不落盘（`modes/_shared.md:31`）。
  - 结构化事实：`memory-fact.mjs:1-6` 把一条记忆限长 **300 字符**、空白归一。
- **Web 与 CLI 共用同一真相源**：`POST /api/memory` 明确「写入**正典** `modes/_profile.md`（single source of truth），不是 web-only memory store」，并且「读不到就宁可不写，避免 clobber」（`web/src/app/api/memory/route.ts:14-34`）；另有 `web/src/lib/profile-memory.mjs`、`personalization.mjs`。
- **A7 溯源/新鲜度**：有，但不在「记忆」上——在**证据**上：`evidence-freshness.mjs` 每批跑一次 GH 证据新鲜度并注入所有 worker 提示词（`batch-runner.sh` 的 `check_evidence_freshness()`）；报告的打分强制带 `confidence`（证据置信，不是录用概率，`batch/batch-prompt.md:476`）。
- **A7 缺**：记忆本身**无 TTL/老化、无冲突消解、无 supersede 链**；去重只做「完全相同 fact 的 dedupe」（`api/memory/route.ts:35` 的 `deduped`）。跨会话召回靠「每次把 `_profile.md` 拼进提示词」，不是检索。

---

## 8. 【D1–D5】界面

- **技术栈**：Next.js 16 + React 19 + Tailwind 4 + lucide + react-markdown（`web/package.json:18-24`）；Go TUI 另算（`dashboard/`）。
- **布局范式**：桌面侧栏 + 页面（`web/src/lib/nav-items.ts:5-6` 注释「desktop sidebar 与 mobile nav 共用一张表，永不漂移」）；17 个页面：`pipeline`、`pipeline/[id]`、`pipeline/[id]/apply`、`pipeline/[id]/cv-studio`、`pipeline/compare`、`jobs`、`jobs/[id]`、`analytics`、`explore`、`documents`、`cv`、`followups`、`portals`、`config`、`scheduled-scans`（`web/src/app/**/page.tsx`）——**流程朝向的、非画布**。另有命令面板 `web/src/lib/command-palette.mjs`。
- **状态可见性（D3）**：很强。
  - 漏斗/阶段：`web/src/lib/funnel-tiles.mjs`（累计口径 `everInterview = Interview+Offer+Hired`，「already cleared 的阶段不能显示 0」）+ `funnel-sankey.mjs` + `analytics/page.tsx`；核心口径在 `funnel-stages.mjs:3-9` 的 `RANKS` 与 `stats.mjs computeFunnel`。
  - 运行中：批处理有 `print_status_table`（状态表 + 分数 + 错误）与 `--watch` 实时刷新（`batch-runner.sh`）；Web 的 apply 驱动把 agent 每一步 `emit({t:"step",...})` 流给前端（`web/src/app/api/apply/drive/route.ts:37-56`）。
  - 成本：`utils/token-tracker.mjs`（RATES + estimateCost）+ `batch/aggregate-tokens.mjs`。
- **主题/多工作区（D4/D5）**：`light/dark` 两套 + 首屏防闪脚本（`web/src/lib/theme.mjs:5-18`、`web/src/app/layout.tsx:22-42`），i18n 多语言；**无并排多工作区**。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：插件 manifest + 闭集 hook + `humanInTheLoop:true` 硬闸 + 能力同意卡 + 钉 sha + 完整性锁

```
机制：插件=目录+JSON manifest；hook 是闭集（provider/ingest/search/notify/export，无 submit）；
      装载前先出「能力卡」要用户 --confirm；只装钉死 40-hex sha；启用后全目录 sha256 锁，改文件无版本号即拒载。
位置：plugins/_engine.mjs:37,239-321,342-395,479-606,688-720；plugins.mjs:480-492,555-569；
      plugins/_registry.mjs:1-12,92-99,116-136；plugin-install.mjs:25,41-54；plugins/_lock.mjs:37-60
为什么好：我们 A12 卡在「有文件、没入口、没信任模型」。它把三件我们都没做的事一次做完：
      ①能力最小化（scoped env + 受控 fetch + reserved env 黑名单）；
      ②安装即钉版本（永不克隆 moving branch，杜绝供应链 rug-pull）；
      ③「插件永远不能自动提交/自动动作」写成 manifest 必填 true，装载器硬拒 false。
      这正好是我们需要的「插件生态 + 安全边界」，且全部 fail-open，坏插件不拖死宿主。
我们抄到哪：tools/plugin/kernel.mjs（manifest schema + hook 闭集）、tools/plugin/install.mjs（钉 sha）、
      tools/plugin/lock.mjs（树哈希 + drift 判定）；capabilityCard 直接借鉴成我们 enable 前的确认卡。
```

### 机制 2：`needs_confirmation:` —— 把「人没确认」做成一等状态，而不是异常

```
机制：提示词层定义单一 HITL 契约：每个会「问/等/确认」的闸口，在无人值守时一律
      不等待、写一行 `needs_confirmation: {gate} {detail} - {resume 指令}` 结束；
      批处理层把这些行当作要 HOLD 的状态，绝不猜、绝不跳过。
位置：modes/_shared.md:309-325（Unattended runs 契约）；modes/oferta.md:7；modes/apply.md:7,19,42-44；
      batch/batch-runner.sh:2413（HOLD）、:2435（终态跳过）、templates/states.yml（状态闭集）
为什么好：我们的 C2 只有 maxTurns 一个刹车，人在环中断点散落在各处、不可判定。它把
      「停下来等人」建模成带 resume 指令的可机读记录，于是同一套提示词既能交互跑、也能 headless 跑，
      批量编排器还能逐条重放「哪些在等人」。这是 C2「停止条件可判定」+ D3「状态可见」的同一份数据。
我们抄到哪：停止条件枚举（新增 NEEDS_CONFIRMATION 终态）+ 编排器里「遇此态即 HOLD 并打印 resume 指令」；
      对应 apps/vouch-web 的 AgentAPI 停止原因与 agent run 状态展示。
```

### 机制 3：append-only 状态流水 + 结构化 Machine Summary（记录可回放）

```
机制：①tracker 是「当前状态」真相，`status-log.tsv` 是 append-only 的
        `{tracker#}\t{date}\t{from}\t{to}\t{source}\t{note}` 转移账本，更正=新 correction 行，
        撤回=写 `-` 行，读侧 foldObservations() 折叠出「当时到底发生了什么」；
      ②每份报告末尾强制一段 YAML `## Machine Summary`（字段白名单、单值 ≤2000 字符），脚本按标题定位解析。
位置：set-status.mjs:83-88（账本契约）、:703-720（replayObservations 折叠）；funnel-stages.mjs:12-57（撤回/更正解析）；
      DATA_CONTRACT.md:59-60（账本列定义）、:41（DB 只是派生索引）；
      batch/batch-prompt.md:480-573（Machine Summary schema 与白名单）
为什么好：我们要的「记录落盘 + 回放」它给了一个极强的范式：**事件溯源式 append-only 账本 + 派生索引可随时重建**，
      而人读的 Markdown 仍是正典。回放不是重新调模型，是把账本折叠——便宜、确定、可审计。
      结构化尾部让机器读报告无需解析自然语言（我们 D3「还差什么」可以直接由账本算）。
我们抄到哪：agent run 事件账本（append-only jsonl/tsv）+ 从账本派生「当前状态」的函数；
      报告/产物统一加「机器可读尾段」，UI 只读派生视图。
```

---

## 10. 我们不该抄的

1. **别抄它的「平铺根目录 + 200 多个 .mjs」**。它自己承认是刻意的历史包袱（`ARCHITECTURE.md:26-30`：路径稳定性 > 组织性），代价是 `scan.mjs` 300 KB、`test-all.mjs` 1 MB、`update-system.mjs` 301 KB、`merge-tracker.mjs` 145 KB 这种单文件失控（`B4`）。我们用模块目录 + 明确分层，不要复制「一脚本一职责 = 一文件」到这种规模。
2. **别抄「靠提示词强制 HITL」当唯一防线**。`modes/apply.md:19` 只写「Stop before Submit」——这是**文本约束，模型可绕过**；真正硬的地方是 `web/src/app/api/apply/drive/route.ts:17` 那种**代码层 `driveSession` 保证 NEVER submits**。要抄就抄后者，前者只能当补充。
3. **别抄它的插件「无沙箱」姿态到不可信来源**。`_engine.mjs:18-21,42-44` 明说「least-privilege ctx 是便利不是沙箱，`process.env` 全局可达」。它的安全靠 bundled 代码评审 + 用户自担风险。我们若要做第三方插件市场，必须真隔离（子进程/worker/权限声明），不能照抄 fail-open。
4. **别抄多语言/多 CLI 的重复成本**：20+ 份 README 翻译、`modes/` 下十几个语言子目录、`providers/` 169 个各写各的适配器——对我们没有对等收益，属于它的分发包袱。
5. **别抄「Web + Go TUI 两套 UI」**：`dashboard/`（Go）与 `web/`（Next）读同一批文件、各写一套解析与状态逻辑（如 `dashboard/internal/data/states_parity_test.go` 专门测「Go 侧状态与 `templates/states.yml` 是否一致」）。我们一套 UI + 共享派生层即可，两套等于永久双写。
6. **`fail-open` 不是万能答案**：插件加载 fail-open 合理；但「状态写盘失败也要写恢复记录、报告文件不存在就判 failed」——**结局判定必须 fail-closed**（`batch-runner.sh:1186`）。抄的时候要区分这两类。

---

## 附：本次判定用到的「无证据即说无」

- A1（文件编辑工具）/ A2（bash 工具）：**本仓不提供**，工具由宿主 CLI 提供；`package.json:114-120` 无任何工具框架依赖。
- A13（MCP client）：**本仓无**，根目录无 mcp 配置；MCP 由宿主提供（`modes/_shared.md:283,287`）。
- A9（多代理协议）：**无**；`modes/scan.md:15-21`、`_shared.md:290` 反而是「**禁止**嵌套子代理 / 研究必须有界」的成本护栏；并行只发生在 `batch-runner.sh` 的独立 worker 进程。
