# OpenBitFun（基座）拆解 v2 —— 用「可抄实现」口径

> 仓库：`D:\refs\openbitfun-src\OpenBitFun-main`（55,066 文件 / 919MB / TypeScript + Rust）
> 核心问题：**基座里已经有什么；我们 fork 出 `apps/vouch-web` 之后把好东西丢了没有。**
> 结论先行：**基座是「Rust 六层内核 + React 前端」，插件/MCP/内存/调度/agent 循环全在 Rust crates；
> 我们的 fork 只搬了前端（web-ui/design-system），整套 Rust 运行时没搬 —— 于是我们自己用
> `tools/plugin/kernel.mjs` 重写了一个极薄的 JS 版，既重复造轮子又丢掉了隔离/信任/世代栅栏。**

---

## 1. 定位与规模

- 一句话：OpenBitFun 是「Rust workspace + 多 React 前端」的通用 Agent 工作台，通过 Desktop(Tauri)/CLI(TUI)/Server/移动端 多个宿主交付（`AGENTS.md:3`）。
- 文件 55,066；主语言 Rust（`Cargo.toml` 成员 60+ 个 crate）+ TypeScript（`src/web-ui`、`src/mobile-web`、`src/miniapp-market-web`、`design-system`）。
- 版本 `1.0.10`：`package.json:4`、`Cargo.toml` 的 `[workspace.package] version`。
- 证据：`D:\refs\openbitfun-src\OpenBitFun-main\package.json`、`Cargo.toml`、`pnpm-workspace.yaml`。

## 2. 架构骨架

顶层目录 → 职责（附路径）：

| 目录 | 职责 | 证据 |
|---|---|---|
| `src/apps/*` | 宿主入口：cli / desktop / server / sdk-host / relay-server / miniapp-shell / data-tools | `Cargo.toml:2-11` |
| `src/crates/interfaces` | ACP / app-server / app-server-protocol / sdk-host 协议层 | `Cargo.toml` 成员 |
| `src/crates/assembly` | 产品装配（补丁/兼容导出/能力选择/core 装配） | `AGENTS.md:20-25` |
| `src/crates/adapters` | ai-adapters(opencode/claude-code/codex/cursor/zcode/dsh/pi)、transport、opencode-plugin-host、webdriver | `rules/crate-layout.mjs:37-55` |
| `src/crates/services` | 系统能力：services-core、services-integrations(MCP/plugin_source/browser)、terminal、relay、computer-use | `AGENTS.md` 层 4 |
| `src/crates/execution` | agent-runtime / agent-workflows / tool-contracts / tool-execution / plugin-runtime-client | 层 5 |
| `src/crates/contracts` | core-types / runtime-ports / events / config-contracts / product-domains | 层 6 |
| `src/web-ui` | React 前端主壳（Vite） | `src/web-ui/package.json` |
| `design-system` | design-tokens / theme-openbitfun / ui 三个包 | `design-system/packages/*` |

**依赖方向（单向，六层）由 CI 脚本强制**：
- 规则文档：`AGENTS.md:16`「Dependencies point downward: a crate may depend on lower layers, not on higher ones」；六层表 `AGENTS.md:20-25`。
- 物理布局规则（crate→layer 映射）：`scripts/core-boundaries/rules/crate-layout.mjs:1-63`（`interfaces/assembly/adapters/services/execution/contracts` 六名）。
- 校验入口：`scripts/check-core-boundaries.mjs:3` → `scripts/core-boundaries/checker.mjs:1-60`（读 crate-rules/feature-rules/source-rules/public-api-rules 等）。
- CI 闸门：`.github/workflows/ci.yml:626-630`（`check:core-boundaries:test` 再 `check:core-boundaries`）。

**核心/插件边界**：靠「端口（runtime-ports）+ 适配器 trait」而非目录约定强制；`agent-runtime/AGENTS.md` 明确「不要依赖 openbitfun-core/app/Tauri；只依赖稳定 port + 注入的 RuntimeServices」，facade-only 文件由 `rules/source/facade-rules.mjs` 与 `source/public-api-rules.mjs` 守护。

## 3. 【A12】插件 / 扩展机制（重中之重）

**基座有两套并存的插件体系，都远超我们 `tools/plugin/kernel.mjs`：**

### 3.1 自有托管插件包（manifest + 信任库 + 完整性）
- 清单文件名 `openbitfun.plugin.json`，上限 64KB，禁止符号链接：`src/crates/services/services-integrations/src/plugin_source.rs:27-28,2845-2870`。
- 清单结构（`deny_unknown_fields`）：`{schemaVersion, id, version, adapter, files:[{path, sha256}]}`，逐文件 sha256 + `content_hash()`：`src/crates/contracts/product-domains/src/plugin_source.rs:28-101`。
- 校验：schema_version 精确匹配、id/adapter 长度校验、文件数/包大小上限、重复路径检测：同文件 `53-80`；错误码 `PluginSourceIssueCode::{MissingManifest,InvalidManifest,...}` `plugin_source.rs:1133-1152`。
- 发现 + 信任持久化：`ManagedPluginSourceService::refresh / set_trust`（用户/项目两个插件根 + 项目信任文件）：`src/crates/assembly/core/src/plugin_source.rs:22-56`，服务实现 `services-integrations/src/plugin_source.rs:169-210`（sha2/sha256、`MAX_TRUST_STORE_BYTES`、`PLUGIN_TRUST_STORE_SCHEMA_VERSION=2`）。

### 3.2 OpenCode 兼容插件运行时（进程隔离）
- 设计文档：`docs/architecture/extensions/plugin-runtime-design.md`（Plugin Host=Bun 子进程；`PluginRuntimeClient`=Rust 端校验/超时/串行/去重/诊断；贡献点 = Tool/Hook/Command/Route/界面项）。
- 真实清单形态就是 OpenCode：`opencode.json` 的 `"plugin": [...]` + `.opencode/plugins/*.ts` 导出 `Plugin`（`tool.execute.before` + `tool:{...}`）：`src/crates/adapters/opencode-adapter/tests/fixtures/opencode-example/opencode.json`、`.../.opencode/plugins/workspace-tools.ts:1-22`。
- 发现：OpenCode 源发现与优先级在 `src/crates/adapters/opencode-adapter/src/{hook_source.rs:87-140,source_adapter.rs}`；插件目录条目上限 `MAX_PLUGIN_DIRECTORY_ENTRIES=1024`（`hook_source.rs:31`）。
- 装载/隔离：`PluginHost` 进程 + IPC + generation fencing：`src/crates/adapters/opencode-plugin-host/src/{lib.rs,backend.rs,peer.rs}`（`GENERATION_FENCING_V1` 见 `plugin_host.rs:5`）；产品装配桥 `src/crates/assembly/core/src/plugin_host.rs:29-73`（`CapturedPluginGeneration` 只允许一次 registration batch）。
- 贡献点发布：`plugin_capability_publication.rs`、`plugin_hook_bridge.rs`、`plugin_runtime.rs`（Tool/Hook/Config/Permission/Agent/Skill）。
- 热插拔：设计文档 4.3/4.4 明确「新 Host 不能与旧 Host 同时加载同一组插件」「禁用=先停旧 Host 再起剩余」；当前实现状态诚实标注「OC-R2 切片已实现部分，完整安全热更新/资源沙箱未完成」（`plugin-runtime-design.md` 第 7 节）。

### 3.3 反向生态：它甚至给 DSH 写了插件
- `extensions/dsh-openbitfun` 是一个 **dsh 插件 bundle**，把 dsh 工具桥到 OpenBitFun SDK Host（`openbitfun_run` 工具，JSON-RPC over stdio）：`extensions/dsh-openbitfun/package.json:1-30`、`README.md:1-40`。这说明基座的 Agent Runtime 已被抽成可被外部 harness 调用的 SDK。

> **回答「我们 kernel.mjs 是不是重复造轮子」：是，而且是劣化版。** 我们的 `tools/plugin/kernel.mjs`（236 行）做的是 `plugin.json` → 进程内 ESM `import()` → `activate(ctx)`，贡献点只有 `commands/panels/verifiers`（`tools/plugin/kernel.mjs:22,95-150`），**没有清单 schema 版本、没有 sha256 完整性、没有信任库、没有子进程隔离、没有世代栅栏**。基座 `plugin_source.rs` 把这些全做了。

## 4. 【A13】MCP / 工具接入

- MCP 服务端管理在 `src/crates/services/services-integrations/src/mcp/`：`server/{mod.rs,connection.rs,process.rs,reconnect.rs,registry.rs,catalog_cache.rs,runtime_state.rs}`，协议 V1/V2 分离解析（`opencode-adapter/AGENTS.md:133-139`），stdio + streamable-http（`protocol/transport_remote.rs` 26KB）。
- 产品侧管理器：`src/crates/assembly/core/src/service/mcp/server/manager/{mod.rs,lifecycle.rs,auth.rs,auth_callback.rs,external_lifecycle.rs,interaction.rs}`（MCP OAuth 回调、外部生命周期）。
- 工具暴露给模型：动态注册 `ToolRegistry::register_mcp_tools`（`src/crates/assembly/core/src/agentic/tools/registry.rs:101-112`）。
- UI 管理（增删/启停/重启/JSON 配置）：前端 `MCPAPI` 有 `startServer/stopServer/enableServer/restartServer/getServers/saveMCPJsonConfig/...`：`src/web-ui/src/infrastructure/api/service-api/MCPAPI.ts:300-453`。
- 结果回填：MCP tool 走 `tool-contracts/src/mcp_tool_bridge.rs`。

## 5. 【A11】调度 / 后台任务

- 定时任务类型 `CronSchedule::{At,Every,Cron{expr,tz}}`，时区用 `chrono_tz`：`src/crates/assembly/core/src/service/cron/schedule.rs:1-57`。
- 服务/存储/事件：`src/crates/assembly/core/src/service/cron/{service.rs(59KB),store.rs,events.rs,subscriber.rs,types.rs}`；工具面 `agentic/tools/implementations/cron_tool.rs`。
- 可移植生命周期状态：`src/crates/execution/agent-runtime/src/scheduled_job.rs:9-60`（`Queued/Running/Ok/Error/Cancelled` 五态 + `next_run_at_ms/retry_at_ms/consecutive_failures/coalesced_run_count`）。
- 驱动：内置 loop 用 `tokio::spawn`+`tokio::time::sleep` 轮询（`agentic/coordination/scheduler.rs:2753` 等），非 systemd。
- 失败重试/超时：`DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS=5000`、`retry_remaining`、coalesce（`scheduled_job.rs` 全文）。

## 6. 【C1/C2】agent 循环与停止条件

- 主循环：`src/crates/assembly/core/src/agentic/execution/execution_engine.rs:4013` 的 `loop {`（`execute_dialog_turn` 起于 `:3213`）。
- 一轮定义：一个 model round → 执行工具批 → 回填 → 再进 loop（文件头注释 `:3`「Executes complete dialog turns, managing loops of multiple model rounds」；round 执行器 `agentic/execution/round_executor.rs`）。
- **停止条件是一族独立刹车（不是单一 maxTurns）**：
  - `max_rounds`（**默认 0 = 不限**，`config-contracts/src/types.rs:1862`；判定 `execution_engine.rs:139-140,4020`）；
  - 固定重复工具失败 `repeated_tool_failures`（连击 `:5155-5203`）+ **周期型循环检测 A-B-A-B**（`:5219-5263`）；
  - `user_steering` 打断 `:5370`；`partial_truncated` `:5458`；`background_quiet` `:5533`；`empty_round` `:5569`；thinking-only 救援 `:5529-5562`；Stop-hook 阻断继续 `:5499-5529`；取消 `:4014-4019`；自然结束（无工具调用给最终答案）`:5468-5472`。
  - 明确的设计纪律：**不许把硬编码上限/字符串匹配当成循环第一反应**（`AGENTS.md:115-117`）。
- 状态持久化：会话消息逐轮 `session_manager.add_message`，`ExecutionResult` 于 `:5948`；会话状态 sidecar 与 `session_state.rs`；断点续跑见第 7/9 节。

## 7. 【A6/A7】记忆

- 存储：SQLite，schema `openbitfun.memory.stage1.v1`，同时落 `MEMORY.md` + `memory_summary.md` + `extensions/` 目录：`src/crates/services/services-core/src/memory_store.rs:12-17`。
- 字段含 `usage_count / last_usage / selected_for_phase2 / rollout_summary / source_updated_at`：`memory_store.rs:53-67`。
- 治理：后台 consolidating job 表（`kind/job_key/status/ownership_token/lease_until/retry_at/retry_remaining`）：`memory_store.rs:34-48`，`JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL` 于 `:50`。即：有「老化（usage/last_usage）+ 合并任务 + 租赁/重试」，但**未找到向量/embedding 召回** → A7 判「部分」。

## 8. 【D1–D5】界面

- 技术栈：React + Vite + TypeScript；`design-system`（tokens/theme/ui）三包被 `web-ui` 依赖：`src/web-ui/package.json`（`@openbitfun/design-tokens`、`@openbitfun/theme-openbitfun`、`@openbitfun/ui`）。
- 布局范式：`src/web-ui/src/app/scenes/*`（21 个场景：assistant/session/agents/skills/terminal/workspace-resources/...）+ `flow_chat` 聊天流（timeline/tool-cards/deep-review/deep-research 子目录）+ `NavBar/NavPanel` sidebars。
- 状态可见性：flow_chat 事件流 + tool-cards + token 用量 API（`infrastructure/api/tokenUsageStatisticsApi.ts`）+ 会话状态。
- 多工作区：`scenes/workspace-resources`、`features/ssh-remote`、`infrastructure/peer-device`、worktree。
- 主题：`infrastructure/appearance/appearanceDomainTokens.ts`（light/dark prism token）、design-system 的 `theme-openbitfun` 包。

## 9. ⭐ 最值得抄的 3 条机制

```
机制 1：插件包清单 + sha256 完整性 + 信任库 + 子进程隔离 + 世代栅栏
位置：src/crates/contracts/product-domains/src/plugin_source.rs:28-101（manifest/validate/content_hash）
      src/crates/services/services-integrations/src/plugin_source.rs:27-28,169-210,2845-2870（openbitfun.plugin.json / 信任库 / 反符号链接）
      src/crates/assembly/core/src/plugin_host.rs:29-73（generation fencing 只允许一次 registration batch）
      src/crates/adapters/opencode-plugin-host/src/{lib.rs,backend.rs,peer.rs}（Bun 子进程 + IPC）
为什么好：我们现在 kernel.mjs 是进程内 import，插件一崩就拖死宿主、且没有任何来源校验/信任/热更新栅栏；
        基座这套正好补上「schema 版本 + 逐文件 sha256 + 信任决定 + 进程隔离 + 一次一代注册」。
我们抄到哪：tools/plugin/kernel.mjs（补 manifest schema/校验）+ 新增 trust 记录 + 若坚持轻量，至少把插件
        从 in-process import 改为 worker/child_process，并加 content hash。
```

```
机制 2：agent 循环的「一族独立停止条件 + 周期型循环检测」
位置：src/crates/assembly/core/src/agentic/execution/execution_engine.rs:4013（主 loop）
      :4020 max_rounds / :5155-5203 连击重复失败 / :5219-5263 A-B-A-B 周期循环 /
      :5370 用户插话 / :5458 partial / :5533 background_quiet / :5569 empty_round / :5499-5529 Stop hook /
      :5529-5562 thinking-only 救援；默认上限 0=不限：config-contracts/src/types.rs:1862
为什么好：`_清单.md` 已确认我们只有 maxTurns 一个刹车、反复空转。这里 10+ 个可独立判定的刹车，
        而且对循环的判定分「连续相同」和「周期交替」，并注入恢复提示而非直接砍，正是我们卡住的地方。
我们抄到哪：我们的 agent loop（vouch 侧/ harness 侧）——照抄这一族条件与注入的 system_reminder 文案策略。
```

```
机制 3：六层单向依赖 + 一个脚本 + CI 闸门（可移植成前端/TS 版）
位置：AGENTS.md:16-25（层表） / scripts/core-boundaries/rules/crate-layout.mjs:1-63（crate→layer）
      scripts/core-boundaries/checker.mjs:1-60 / scripts/check-core-boundaries.mjs:3
      .github/workflows/ci.yml:626-630（CI 强制）
为什么好：我们「模块边界靠自觉」，基座把边界写成机器可校验的规则并卡在 CI，违规即红；
        同一套思路可对 TS 用 import 图实现（web-ui ↔ shared ↔ infrastructure 分层）。
我们抄到哪：新建 `scripts/check-module-boundaries.mjs`（读目录→层映射 + 扫描 import 边），挂进 CI。
```

## 10. 我们不该抄的（避免看到就抄）

- **整个六层 60+ crate 的 Rust 结构**：`Cargo.toml` 成员 60+、`plugin_source.rs` 单文件 191KB、`source_adapter.rs` 137KB、`self-test.mjs` 227KB —— 我们 fork 是**纯前端**，搬不动也不该搬；只抄「分层规则+单脚本校验」的轻量版。
- **把「目标设计」当「已交付」**：`plugin-runtime-design.md` 第 7 节自承「安全热更新/资源沙箱尚未完成、OpenCode 全量 Client/Hook/TUI 表面未完成」。抄实现要抄 `plugin_source.rs`+`plugin-host` 的已落地部分，别抄文档里的愿景。
- **OpenCode 生态兼容层**：`opencode-adapter` 的 V1/V2 配置合并、OXC 静态投影非常重；除非我们真要兼容 OpenCode 插件，否则别引入。
- **超大体量单文件**：多次出现 100KB+ 单 `.rs`（`plugin_source.rs`、`source_adapter.rs`、`execution_engine.rs` 154KB），这是它的历史累积，不是我们要学的「密度」。

---

## 附：我们 fork（apps/vouch-web）到底丢了什么 —— 直接证据

- `apps/vouch-web/pnpm-workspace.yaml` 只保留 `src/web-ui`、`design-system`、`design-system/packages/*`、`packages/flow-chat-presentation`（注释原文「只保留我们实际扒进来的 workspace」），**无 `src/crates/execution|services|interfaces`，根目录无 `Cargo.toml`**（`Test-Path apps/vouch-web/Cargo.toml` = False）。
- `apps/vouch-web/src/crates` 仅剩 `assembly/core`（只有 `service/i18n` + locales）与 `adapters/transport/typescript`（JSON-RPC/WebSocket 客户端）：
  - `apps/vouch-web/src/crates/assembly/core/src/service/i18n/generated_locale_contract.rs`
  - `apps/vouch-web/src/crates/adapters/transport/typescript/src/index.ts`
- 关键实现文件在 fork **全部不存在**（逐个 Test-Path 对比 base=True / vouch=False）：
  `assembly/core/src/plugin_host.rs`、`assembly/core/src/agentic/execution/execution_engine.rs`、
  `adapters/opencode-plugin-host/src/lib.rs`、`execution/plugin-runtime-client/src/lib.rs`、
  `services/services-core/src/memory_store.rs`、`execution/agent-runtime/src/scheduler.rs`。
- 前端仍保留全部「调用后端的客户端」：`MCPAPI.ts`（MCP 增删启停）、`AgentAPI.ts`、`ToolAPI.ts` ... 都 `import { api } from './ApiClient'` 然后 `api.invoke(...)`，但**响应这些调用的 Rust 后端不在 fork 里**。
- 于是：**agent 循环 / 插件 Host / MCP server manager / 内存库 / 调度器 / 工具执行 = 全部没接上**；我们用 `tools/plugin/kernel.mjs` 用一个 236 行的进程内 JS 内核重造了「插件装载」，但丢掉了基座的隔离、完整性、信任、世代栅栏。
