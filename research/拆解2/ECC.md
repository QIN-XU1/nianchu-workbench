# ECC 拆解（v2 可抄口径）

> 仓库：`D:\refs\ECC\ECC-main`（GitHub affaan-m/ECC，v2.2.3）
> 文件数：**4,701**（Markdown 为主，其次 Python/JS/Rust）
> 拆解时间：2026-11-17

---

## 1. 定位与规模

**一句话**：ECC 不是一个 agent 运行时，而是一套 **「装进别人 harness 的资产包」**——把 skills / agents / hooks / rules / MCP 配置 / 安装清单 打包，通过各 harness 的插件机制装进 Claude Code、Codex、Cursor、Gemini、OpenCode 等（`package.json:3` 自述 "Harness-native agent operating system for Codex, OpenCode, Cursor, Gemini, Claude Code"；`package.json:8` 的 `"main"` 指向 `.opencode/dist/index.js`）。

- 证据：`package.json:1-60`；`VERSION`（2.2.3）；`pyproject.toml`（Python 侧 `src/llm`）。
- 规模明细：`skills/` 314 个技能目录、`agents/` 71 个 `.md` agent、`tests/` 534 文件、`docs/` 1540 文件、`ecc2/` 21 个 Rust 文件（ECC 2.0 alpha 控制面）、`scripts/` 374 文件。
- **它不是 README 说的「agent OS 本体」**：本体逻辑（循环/工具执行）都在宿主 harness 里；ECC 提供的是配置与资产，外加一个 Rust 控制面（`ecc2/`）去管理「别的 harness 的会话」。

---

## 2. 架构骨架

顶层目录 → 职责：

| 目录 | 职责 | 证据 |
|---|---|---|
| `skills/` | 314 个技能，每个一目录一 `SKILL.md`（YAML frontmatter：name/description/metadata.origin） | `skills/accessibility/SKILL.md:1-6` |
| `agents/` | 71 个 agent 定义（Claude frontmatter markdown，`tools:` 逗号分隔 allowlist） | `scripts/lib/agent-ir.js:24`；`.claude-plugin/PLUGIN_SCHEMA_NOTES.md:58-70` |
| `hooks/` | 生命周期钩子（PreToolUse/PostToolUse…），`hooks.json` 声明 | `hooks/hooks.json:1-30` |
| `commands/` | 98 个斜杠命令 shim | `package.json` files 段 |
| `schemas/` | 17 个 JSON Schema（memory / agent IR / plugin / state-store / context-profile…） | `schemas/` |
| `manifests/` | 安装模块/组件/档位单一源（install-modules/components/profiles） | `manifests/install-profiles.json:1-40` |
| `scripts/lib/install-targets/` | 16 个 harness 安装适配器（claude/codex/cursor/gemini/…） | `scripts/lib/install-targets/registry.js:1-36` |
| `scripts/lib/` | 纯库层（memory-vault / agent-ir / context-carriers / skill-evolution …） | `scripts/lib/` |
| `src/llm/` | Python LLM 抽象（core/providers/tools/prompt） | `src/llm/providers/resolver.py:1-24` |
| `ecc2/` | Rust 控制面（TUI 仪表盘 + SQLite 会话库 + worktree 管理） | `ecc2/README.md:3-16` |

**依赖方向**：`scripts/*.js`（CLI 入口）→ `scripts/lib/*`（纯库）→ `schemas/*`。例：`scripts/agent-convert.js:23-24` 引 `./lib/agent-ir` + `./lib/agent-emit-pi`；`scripts/lib/memory-vault.js:9-28` 引 `./memory-vault-format`。库层用「函数内 lazy require」断环（`scripts/lib/install-manifests.js:4` 顶部 require registry，但 registry 只在函数里用）。

**核心/插件边界**：ECC 自身没有「内核 vs 插件」的运行时边界——它是「资产包」，边界靠**目录约定 + 测试断言**强制：`tests/plugin-manifest.test.js` 保证两个 plugin.json 与 `.mcp.json` 合规；`scripts/lib/harness-adapter-compliance.js:9-15` 维护 harness 合规矩阵。**无 CI 级类型墙**，靠 534 个测试文件。

---

## 3. 【A12】技能 / 插件生态（重中之重）

### 3.1 插件清单长什么样（真实片段）

**Claude 插件清单** `.claude-plugin/plugin.json:1-46`：
```json
{ "name": "ecc", "version": "2.2.3",
  "userConfig": { "hooks_enabled": {"type":"boolean","default":true},
                  "hook_profile": {"type":"string","default":"standard"} },
  "mcpServers": {},
  "skills": ["./skills/"],
  "commands": ["./commands/"] }
```
**Codex 插件清单** `.codex-plugin/plugin.json:23-25`：
```json
"skills": "./skills/", "mcpServers": "./.mcp.json", "hooks": "./hooks/codex-hooks.json"
```
**Schema**：`schemas/plugin.schema.json:1-70`（draft-07，字段 name/version/description/author/skills/commands/mcpServers/features）。

> 极有价值的「踩坑档案」：`.claude-plugin/PLUGIN_SCHEMA_NOTES.md`（231 行）记录了 Claude 插件校验器的**未文档化硬约束**——`version` 必填、`commands/skills/hooks` 必须是数组、**绝不能加 `agents` 字段**（`.claude-plugin/PLUGIN_SCHEMA_NOTES.md:73-90`）、**绝不能加 `hooks: ./hooks/hooks.json`**（v2.1+ 自动加载会报重复，`:113-146`）。这是白送的避坑知识。

### 3.2 怎么被发现 / 校验 / 装载 / 贡献 / 隔离 / 热插拔

- **发现**：ECC **不做运行时发现**。它靠宿主按约定扫描——Claude 自动加载 `hooks/hooks.json`（`PLUGIN_SCHEMA_NOTES.md:119-125`）、自动扫 `agents/*.md`（`:85`）。ECC 自己的「发现」是安装期枚举：`scripts/lib/install-manifests.js:8` 的 `SUPPORTED_INSTALL_TARGETS`（16 个目标）+ `scripts/lib/install-targets/registry.js:19-36` 的适配器表。
- **校验**：① 清单——`tests/plugin-manifest.test.js:1-40`（断言两个 plugin.json / .mcp.json / marketplace）；② 安装前置——`scripts/lib/install-targets/registry.js:62-68` 调 `adapter.validate()`，error 级 issue 直接抛；③ agent frontmatter——`scripts/lib/agent-ir.js:127-134` 用 Ajv 对 IR 校验。
- **装载**：**不是动态 import / 子进程 / 沙箱**。ECC 把文件**拷到目标目录**（`install-executor.js` + `install-state`），由宿主加载。这就是它「无运行时内核」的根因。
- **贡献点**：插件能往宿主加——技能（`skills/`）、斜杠命令（`commands/`）、agent 定义（`agents/`）、生命周期钩子（`hooks/` + 33 个事件）、MCP server（`mcpServers`）、规则（`rules/`）。见两处 plugin.json 字段与 `hooks/hooks.json`。
- **隔离**：**无隔离**。所有资产是纯文本/配置，交给宿主执行；`mcpServers` 甚至要显式设空 `{}` 来**防止**自动捆绑根 `.mcp.json`（`PLUGIN_SCHEMA_NOTES.md:150-168`，避免超长 MCP 工具名）。
- **热插拔**：无运行时开关。ECC 支持的是**安装期选择性**——档位 `manifests/install-profiles.json`（minimal/core/developer/opencode…，`:1-40`）+ 模块 `install-modules.json`；状态落 `schemas/install-state.schema.json`。技能层面有版本化/回滚：`scripts/lib/skill-evolution/versioning.js:8-14`（`.versions/`、`.evolution/` 三日志 observations/inspections/amendments）。

### 3.3 技能组织方式（可抄）

- 一技能一目录，`SKILL.md` 的 frontmatter **只有 name + description + metadata**，正文按需加载 → 天然的渐进披露（见 D/C5）。`skills/accessibility/SKILL.md:1-6`。
- 技能健康度仪表：`scripts/skills-health.js:4-22`（`skill-evolution/health.js` + `dashboard.js`，成功率/失败/修订/版本四面板）。
- 技能溯源 schema：`schemas/provenance.schema.json:1-31`（learned/imported 技能强制 source/created_at/confidence/author）。

---

## 4. 【A13】MCP / 工具接入

- **手写 MCP server（含 memory vault）**：`scripts/memory-mcp.mjs`（691 行）——自己实现 JSON-RPC 2.0 握手，暴露 4 个工具 `memory_save / memory_search / memory_read / memory_doctor`（`scripts/memory-mcp.mjs:52-100` 及 `Select-String` 命中）。协议版本协商 `:29-37`，能力边界 `:38-41`。
- **注册进 MCP 配置**：`mcp-configs/mcp-servers.json` 有 `ecc-memory-vault`（`"command": "ecc-memory-mcp"`，env `ECC_MEMORY_HARNESS`），**默认不启用**（描述明写 "Not enabled by default"）。
- **MCP 管理/审计**：`scripts/lib/mcp-inventory/` 有一组 reader（codex/opencode/canonical），`canonical-mcp.js:7-141` 做 secret 键/值识别与 `redactArgs/redactUrl` 脱敏；`scripts/mcp-inventory.js:48-72` 输出「几个 server 带 secret」的 CLI。**无 MCP server 增删改的可视化 UI**（Tkinter 仪表盘只读展示，见 `ecc_dashboard.py`）。
- **工具列表如何暴露给模型**：MCP 侧靠 `TOOL_DEFINITIONS` 的 `inputSchema`（`memory-mcp.mjs:52-100`）；宿主侧靠各 harness 自己。
- **结果回填**：memory MCP 返回 `{ code, message }` 与查询结果；工具调用失败走 `isError`（`memory-mcp.mjs:223-225` 专门区分 "suspected secret" 拒绝）。

---

## 5. 【A11】调度 / 后台任务

- **ECC 本体无 cron / 无任务调度器**：全 `scripts/` 无 scheduler 实现（grep `cron|schedule` 只命中 skills 文本与 operator-readiness-dashboard）。
- **唯一的常驻进程是 ecc2 的 daemon**：`ecc2/src/session/daemon.rs:25`（`loop {`）+ `ecc2/src/session/daemon.rs`；它 tick 的是「会话状态同步」，不是「定时任务触发」。
- **失败/预算刹车**：ecc2 有 `enforce_budget_hard_limits`（`ecc2/src/session/manager.rs:1203-1250`）对 token/成本超预算的外部 runner 会话做自动 pause——这是它少见的「运行时刹车」。**无四态重试框架**（会话恢复见 C4）。

---

## 6. 【C1/C2】agent 循环与停止条件

- **ECC 本体没有 agent 主循环**。模型→工具→再模型的循环在宿主 harness 内（这也是为什么 A1/A2/A3 全「无」）。ecc2 也不是循环体，它是「起一个外部 runner 子进程并跟踪」（`ecc2/src/session/manager.rs:3148-3286` 给 runner 拼 `--max-budget-usd` 等命令行参数）。
- **停止条件**：ECC 无 `max_turns`/显式 done；ecc2 侧的「停止」是**预算硬限**（`manager.rs:1189-1226` 三态 `token_budget_exceeded / cost_budget_exceeded / profile_token_budget_exceeded`）暂停会话。
- 结论：C1 = 无，C2 = 部分（仅控制面预算刹车，无 turn 级停止）。

---

## 7. 【A6/A7】记忆 —— 重点核实（v1 说「有记忆 schema」属实，且比预想完整）

### 7.1 存储形态

- **文件型 vault（每个记忆一个 Markdown 文件）**，按 `kind` 分目录、按 `scope` 分根：`scripts/lib/memory-vault.js:319-343`（`saveMemory` → `<root>/<kind>s/<id>.md`）。三个 scope 根：project / team / user（`:59-95`）。写入 create-only（`:335-340`），权限 0700。
- project scope 自动写 `.gitignore`（`*\n!.gitignore\n`，`memory-vault.js:37, 243-244`）。
- 召回：**纯词法打分，无 embedding**（`memory-vault.js:555-578` `scoreMemory`：标题/标签/元数据/正文词频），`searchMemories` 过滤 `status==='active'`（`:628`）。

### 7.2 记忆 schema（`schemas/memory.schema.json` + `scripts/lib/memory-vault-format.js`）—— 可抄的核心

**kind × scope × status 三轴 + trust + 溯源**（`memory.schema.json:37-68`，代码常量 `memory-vault-format.js:6-18`）：
```js
MEMORY_KINDS   = [context, decision, fact, handoff, lesson, note, preference, runbook]  // 8 种
MEMORY_SCOPES  = [project, team, user]                                                   // 3 种
MEMORY_STATUSES= [active, rejected, superseded]                                          // 3 种
MEMORY_TRUST   = [unreviewed]                    // 恒为「未审阅」——治理真相在 vault 之外
```
另含 `sourceHarness`（来源 harness）、`targetHarnesses`（1-32）、`tags`、`links[]`（指向其它 `mem_` id，上限 64）、`createdAt/updatedAt`（严格 ISO 毫秒 UTC，`memory-vault-format.js:29,131-142`）。

**secret 正则（10 条，硬拒写）** `memory-vault-format.js:49-60`：
```js
provider API key /\bsk-[A-Za-z0-9_-]{16,}\b/i
Stripe sk_live_/npm_/hf_/gh[pors]_/github_pat_/AIza/xox[baprs]-/AWS AKIA|ASIA/
private key  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
```
写库前 `findPotentialSecrets(JSON.stringify(memory))` 命中即抛错拒写（`memory-vault.js:322-325`）。

**biDi 拒绝 + 控制字符拒绝** `memory-vault-format.js:62-75`：
```js
isBidirectionalFormatting = (0x202A..0x202E) || (0x2066..0x2069)
isControl = (<=0x1F 非允许空白) || (0x7F..0x9F)
```
title 拒；body 允许 TAB/LF/CR 但拒其余控制符与 biDi（`:85-87, 148-150`）。另有 CLI 侧终端转义清洗 `scripts/memory.js:261-267`（`isBidiControl` 含 0x061C/200E/200F）。

**格式健壮性**：fatal UTF-8 解码（`memory-vault-format.js:47,214-220`）、frontmatter 逐行 `JSON.parse` 且未知/重复字段报错（`:222-241`）、body ≤64KiB / 文档 ≤128KiB（`:20-21,155`）。

### 7.3 【A7】溯源 / 冲突 / TTL —— 诚实结论

| 项 | 结论 | 证据 |
|---|---|---|
| 溯源 | **部分** | 有 `sourceHarness` + `links[]` + `trust=unreviewed`；但无 `source` 正文/作者字段，`saveMemory` 允许 `sourceHarness:'unknown'`（`memory-vault.js:309`） |
| 冲突消解 | **无** | `status` 有 `superseded` 枚举，但**无任何代码会自动置 superseded**，无 `supersededBy` 链（grep `superseded|conflict` 全无赋值处；默认恒 `'active'`，`memory-vault.js:308,628`） |
| TTL / 老化 | **无** | 无 `ttl/expiresAt/expire`（grep 三处命中全是 `settled` 误匹配） |

> 对比我们 A7 的判「无」：ECC 也只到「部分」——它有 **schema 级的 kind/scope/status + secret 正则 + biDi 拒绝**（这套很值得抄），但**冲突靠人工改 status、无 TTL、无自动 superseded 链**。别指望从它抄到「冲突消解引擎」，只能抄「记忆文档的校验与拒绝规则」。

---

## 8. 【D1–D5】界面

- **技术栈**：① `ecc_dashboard.py`（41KB，**Tkinter 桌面 GUI**，管理 ECC 组件，`ecc_dashboard.py:1-24`）；② `ecc2/src/tui/`（**Rust ratatui TUI**，`ecc2/src/tui/app.rs:21-26`，`Terminal::new` + `dashboard.render`）。
- **布局**：ecc2 TUI 有**可调分栏 + 折叠 pane**（`ecc2/src/tui/dashboard.rs:16,34-37,154-165,204,277`：`PaneLayout / Pane / PaneDirection`，`OUTPUT_PANE_PERCENT=70`、resize step 5%）。
- **状态可见性（D3 强项）**：每会话 token/成本/预算仪表 + 超预算告警态（`ecc2/src/tui/widgets.rs:78-232` `TokenMeter/budget_state`：Normal/Warning/Critical/OverBudget）；总账 `dashboard.rs:4067-4204`。
- **多工作区（D4）**：ecc2 session manager 管理多会话 + worktree（`ecc2/src/worktree/mod.rs`）。
- **主题（D5）**：`ThemePalette`（`dashboard.rs:52`）+ `toggle_theme()`（`app.rs:127`）。
- 但**都不是「agent 工作台」**——是 ECC 配置管理 + 外部会话监控。没有 chat/画布/时间线那种 agent 交互界面。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：Agent IR —— parse → 中性 IR → 按 harness 多 emitter（把 N×M 降成 N+M）

```
机制：把「Claude 格式的 agent md」解析成 harness 中立的 ecc.agent-ir.v1 对象，
      再由每个 harness 的 emitter 消费同一 IR 产出原生定义；工具名逐字保留、映射表分离。
位置：schemas/agent.schema.json:1-59（IR 契约，:5 明写 "Emitters consume this IR"）
      scripts/lib/agent-ir.js:80-146（parseAgentFile/parseAllAgents，Ajv 校验 :127-134）
      scripts/lib/agent-emit-pi.js:41-127（Pi emitter，前端契约 :64-75）
      scripts/lib/agent-tool-map.js:23-56（Claude→Pi 工具表 + 「只读不升级权限」不变量 :17-19）
      scripts/agent-convert.js:26-30（SUPPORTED={claude:['pi']}，EMITTERS 注册）
为什么好：正是我们要的「架构级思路」——一份源定义，N 个宿主不再各写一份。
      IR 还保留 frontmatter 原文（agent.schema.json:53-57）做无损回写；emitter 永不静默丢工具，
      未映射工具进 warnings（agent-emit-pi.js:46-55）；空 allowlist 强制写 `tools: none`
      而非留空（:61-62，因为留空=全放权，这是安全不变量）。
我们抄到哪：tools/plugin/kernel.mjs 之上加一层「agent/preset IR」+ emitter 表；
      对应 apps/vouch-web/.../WorkbenchScene.tsx 的 agent 定义读入。
诚实提醒：它只真正实现了 1 个 emitter（claude→pi）。gemini/qwen 是另写的一套
      工具映射脚本（scripts/gemini-adapt-agents.js:6-17 自带 TOOL_NAME_MAP），
      并未走 IR —— 所以「N+M」在它这里也是「设计到位、只落 1 条」。我们抄框架时按 N+M 补齐。
```

### 机制 2：记忆文档的「校验 + 拒绝」规则（kind/scope/status + secret 正则 + biDi）

```
机制：记忆是前端 matter 化的 Markdown；写入前做 schema 级三轴校验 + 10 条密钥正则 + 控制符/biDi 拒绝。
位置：schemas/memory.schema.json:37-68（kind8×scope3×status3 + trust=unreviewed）
      scripts/lib/memory-vault-format.js:6-18（枚举常量）
      :49-60（10 条 secret 正则）  :62-75（biDi 0x202A-202E/0x2066-2069 + 控制符拒绝）
      :205-280（serialize/parse，逐行 JSON.parse + 未知/重复字段报错 + fatal UTF-8）
      scripts/lib/memory-vault.js:319-344（saveMemory：命中 secret 即拒、create-only、0700）
      scripts/memory-mcp.mjs:52-100（同一 schema 暴露成 MCP 工具 memory_save/search/read/doctor）
为什么好：我们记忆元 12 场景/31 边完全无溯源/冲突/TTL（A7=无）。这套不是补「冲突引擎」，
      而是先补「入库卫生」——密钥/biDi 注入在写库第一道就被拒，schema 三轴可直接当我们的记忆元标签。
我们抄到哪：tools/memory/store.mjs（若尚未有校验层）加入 memory-vault-format.js 的
      SECRET_PATTERNS + hasUnsafeControlCharacters + kind/scope/status 枚举校验。
```

### 机制 3：多 harness「安装适配器」注册表 —— 一个 plan 接口，16 个目标

```
机制：每个 harness（claude/codex/cursor/gemini/…）实现统一 adapter 契约：supports/validate/
      resolveRoot/getInstallStatePath/planOperations；注册表按 target 查表，产出安装计划。
位置：scripts/lib/install-targets/registry.js:19-87（ADAPTERS 16 个 + planInstallTargetScaffold）
      单个 adapter 例：scripts/lib/install-targets/claude-home.js 等 17 文件
      scripts/lib/install-manifests.js:8（SUPPORTED_INSTALL_TARGETS 16 项）
      档位/模块单一源：manifests/install-profiles.json + install-modules.json
      schemas/install-state.schema.json（安装态 schema）
为什么好：我们的 tools/plugin/kernel.mjs 是「单宿主」写法。它把「装到哪个宿主」抽象成
      adapter 表，加宿主=加一个文件，不改核心——这恰是我们要的「N 宿主 M 资产」的另一半。
我们抄到哪：tools/plugin/kernel.mjs 的装载入口抽成 adapter 注册表；
      技能/插件清单沿用 manifests 单一源 + install-state schema。
```

---

## 10. 我们不该抄的

1. **它的「巨大 Rust alpha」**：`ecc2/src/main.rs`(459KB)、`tui/dashboard.rs`(552KB)、`session/store.rs`(340KB)、`session/manager.rs`(297KB) 单文件——严重违反 B4。ECC 自己的 `docs/` 也承认是 alpha。我们要抄的是它的 schema/adapter 思路，不是这几个巨型文件。
2. **「无运行时内核」的形态**：ECC 把 A1/A2/A3（编辑/终端/联网）全推给宿主，自身零执行。我们是有自己 kernel 的形态，**不能学它「什么都不执行」**——只能学它的资产分发与 IR。
3. **Claude 插件校验器的历史包袱**：`PLUGIN_SCHEMA_NOTES.md:127-146` 那段 hooks 字段「加→删→加→删」的 flip-flop 是宿主编译器版本折腾史，抄「结论（别声明 hooks/agents）」即可，别抄那套 node -e 内联 bootstrap 巨串（`hooks/hooks.json:1-30` 里一坨转义的路径探测代码，极其难维护）。
4. **记忆的「假治理」**：有 `superseded` 枚举却没有自动置位/冲突链/TTL（第 7.3 节）。别看到 schema 就以为有冲突消解——它没有。我们要的 A7 得自己补。
5. **多语言/多 harness 影子副本**：`gemini-adapt-agents.js`、`qwen-adapt-agents.js`、`codex-legacy-sync.js` 各自维护工具名映射，与 IR 并存——这是「有 IR 却没统一走 IR」的债，我们抄 IR 时要一次到位，别长第二套影子表。

---

## 附：与我们现状的对接速览

| 我们的痛点 | ECC 对应文件 | 抄什么 |
|---|---|---|
| A7 记忆无溯源/冲突/TTL | `memory-vault-format.js:49-75`、`memory.schema.json:37-68` | 只抄「入库卫生」(secret 正则 + biDi + 三轴枚举)；冲突/TTL 它也没有 |
| A12 插件生态最痛 | `plugin.json`(Claude/Codex)、`install-targets/registry.js`、`skill-evolution/versioning.js` | adapter 注册表 + manifests 单一源 |
| N×M → N+M（Agent IR） | `agent-ir.js` + `agent-emit-pi.js` + `agent-tool-map.js` + `agent.schema.json` | 整套 IR 框架（它只落了 pi 一个 emitter，我们补齐） |
| C2 停止条件只有 maxTurns | ecc2 `manager.rs:1189-1250` | 预算三态刹车（弱，别指望） |
| D3 状态可见性 | ecc2 `tui/widgets.rs:78-232` | 每会话 token/成本/预算仪表 |
