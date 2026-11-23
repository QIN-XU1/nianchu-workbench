# craft-anything（ArtCraft）拆解

> 口径：可抄实现。仓库 `D:\refs\craft-anything\craft-anything-main`，1,071 文件，纯 Rust（workspace, edition 2024）。
> 注意：它是 **逆向工程工作台**（看网页/App/游戏怎么实现，再让 coding agent 重建一份），不是一个通用聊天 agent。
> 但它的 **工具契约层** 和 **把 dsh 当后端** 这两件事，恰好命中我们的问题。

---

## 1. 定位与规模

一句话：**"看清任何软件怎么工作，再让 AI 重建一份"** 的原生桌面工具（egui）+ CLI + MCP server，三者共用**一个 engine**。

- 文件数 1,071；语言 100% Rust；workspace 版本 0.6.1；`rust-version = "1.97"`（`Cargo.toml:5-10`）。
- 14 个内部 crate + 3 个 app，成员表在 `Cargo.toml:1-26`。
- star / 最近 push：本地 checkout 无 git 元数据可查 → **未找到**（不猜）。

---

## 2. 架构骨架

`AGENTS.md:13-32` 给了权威的分层表，且**有 CI 强制**：

```
evidence  L0  证据记录/错误契约        formats L0  纯解析器(无 I/O)
disasm    L1  自研反汇编              js      L1  JS/Electron
analysis  L2  分析器→evidence         platform L2 进程/PTY/沙箱/原子文件
engines   L3  外部引擎(Ghidra/adb/CDP/Frida)
engine    L4  Session/Project/Workspace/ToolSpec registry/settings/consent
ai        L5  AI 后端 + agent loop + crews + rebuild 工作流
mcp       L5  MCP server（渐进 toolset）
setup     L5  连接 coding-agent
ui-egui   L6  唯一允许用 egui/eframe/winit 的 crate
```

- **依赖方向单向、按层号硬约束**：`xtask/src/main.rs:13-15` 定义 `LAYERS`，`:181-232` 的 `layers()` 逐 crate 检查"只能依赖严格更低的层"，还额外禁止 L6 之外用 UI 工具包、禁止 wasm app 依赖非 wasm crate、禁止 app 把 testkit 当正式依赖。`AGENTS.md:34`："Layering is enforced by `cargo xtask layers`"。
- **核心/插件边界**：核心 = 静态 `ToolSpec` + `Registry`；插件 = 运行期 `RuntimeTool`（`registry.rs:17-28`），只能经 `Registry::with_runtime` 进入（`:89-113`）。没有"插件拿宿主内部对象"的口子：插件是**外部进程(MCP)或 WASM 组件**，只能贡献 tool/check。
- 与我们的差异：我们是 TS 单进程 + Node 工具，它这套多层 crate 不能照搬；但**"静态工具表 + 运行期工具表 + 一个 Registry 统一分发"** 这个骨架可以直接映射到 `kernel.mjs`。

---

## 3. 【A12】插件 / 扩展机制（重点）

它有**两种插件，共用同一出口 `RuntimeTool`**。

### 3.1 清单长什么样（真实片段）
`config.toml`，`plugins.rs:1-15,127-135`：

```toml
[[plugins.mcp]]
id = "notes"            # toolset id；工具 id 变 notes_<tool>
command = "notes-mcp"
args = ["--stdio"]
consent = true          # 默认 true：每次调用前问
# url = "https://mcp.example.com/mcp"  # 或远程 Streamable HTTP
headers = { Authorization = "Bearer …" }
enabled = true

[[plugins.wasm]]
id = "wordtools"
path = "C:/plugins/wordtools.wasm"
```

### 3.2 怎么被发现
无目录扫描。**只在启动时读 settings.plugins**：
- MCP：`plugins.rs:188-226` `install()` 遍历 `session.settings.plugins.mcp`（`.filter(|p| p.enabled)`），读**上次缓存的工具列表**（`{id}.tools.json`，`plugins.rs:117-124`），生成 `RuntimeTool`。
- WASM：`wasm_plugins.rs:101-107` 取 `plugins.wasm` 中 enabled 项 → `imp::install`（`:138-207`）。
- 关键设计：**启动不启动 server**，工具表来自缓存；server 在**第一次调用**才起（`plugins.rs:246-267`）。

### 3.3 怎么校验
手写 `problem()`，不抛异常，只返回**一句人话**，跳过并 `log::error!`：
- `McpPlugin::problem()` `plugins.rs:96-106`：id 合法 + command/url 恰好一个 + https 校验。
- `WasmPluginConfig::problem()` `wasm_plugins.rs:44-55`：id 合法 + 绝对路径 + `.wasm` + 文件存在。
- id 统一规则 `RuntimeTool::valid_id` `registry.rs:31-34`：`[a-z0-9_]{1,64}`。
- 装载期再校验一次：重复 id / 非法 id / schema 非 object 一律跳过（`registry.rs:89-95`；`wasm_plugins.rs:179-184`）。

### 3.4 怎么装载
- MCP：子进程 stdio（`Process::new(...).spawn()`，`engines/mcp_client.rs:181-208`）或 HTTP；`McpClient::connect → list_tools → call_tool`（`:92-140`）。**没有容器沙箱**，靠 `consent=true` 每次问。
- WASM：wasmtime component，**import 为空**（`wit/plugin.wit:6-7,38-50`），每次调用新实例、fuel=2e9、内存 256MiB（`engines/wasm_plugin.rs:60-62,146-148`）。

### 3.5 贡献点
- MCP/WASM 插件只能加 **tool**（进自己的 toolset）；WASM 还能加 **check**（`PluginCheck`，`wasm_plugins.rs:58-95`，参与 rebuild 的判定轮）。
- 不能加命令/面板/路由：那些是宿主自己的 `ToolSpec`，插件没有这层权限 —— **这就是它的隔离边界**。

### 3.6 热插拔
- 有 `plugins_add` / `plugins_remove` / `plugins_refresh` / `plugins_list` 工具（`docs/extending.md:26-28,46-48`，`mcp/src/lib.rs:75` 的 `ACTS_ON_MACHINE` 也点了名）。
- 状态存 `config.toml`；**新工具下次启动才生效**（工具表是缓存+启动装载）。
- 卸载插件不会卸掉已注册工具（进程内 `Box::leak` 的 `&'static str`，`registry.rs:96`）——**只能重启**。这是我能抄时要避开的坑。

---

## 4. 【A13】MCP / 工具接入

双向，都很成熟：

- **MCP client（当插件用）**：`crates/engines/src/mcp_client.rs`（461 行）。`Transport` trait `:63-69`，stdio 与 HTTP 两实现；`list_tools:106` / `call_tool:129`（带 timeout + cancel 回调）。
- **MCP server（把 271 个工具暴露出去）**：`crates/mcp/src/lib.rs`（781 行）。`tools/list` 只给 Core + 客户端 `enable_toolset` 过的组，变更发 `notifications/tools/list_changed`（`:3-5,314,507`）。
- **结果回填 + 体积预算**：响应超过连接预算时**不报错**，而是把证据记录**留在会话里**、返回 summary + `continue_with: core_evidence_browse`（`mcp/src/lib.rs:472-520,640-680`）；Claude Code 连接自动降到 80KB（`:39-42,328-332`）。
- **UI 管理 MCP server**：有（Settings → Plugins，`docs/extending.md:26`），增删改/启停都有对应工具。
- 工具调用结果统一 `ToolOutput::Evidence | Value`（`engine/src/tool.rs:246-267`），Evidence 进 session ledger。

---

## 5. 【A11】调度 / 后台任务

- **没有 cron / 定时任务**（grep `cron|schedul` 只命中 EVM 元数据、UI 定时重绘，**未找到**调度器）。
- 有的是**并发运行队列**：`RunSet` 按 folder 保活每个 rebuild run，超过 `limit` 入队（`ai/src/rebuild/runs.rs:34-93`），有 `keep_queue_moving` 后台线程。
- 长任务跑在**独立 worker 线程**：`ai/src/agent.rs:1-4`（UI 只调非阻塞 `Conversation`）、`rebuild/mod.rs:15`（一条 worker 线程，UI `poll()` 收 `RunEvent`）。
- 失败/超时：进程层强制 wall-clock deadline + idle deadline，超时杀进程组（`platform/process.rs:11-18`）；rebuild 有 `not_working_checks` 连续失败上限（`rebuild/mod.rs:1051-1053,1083-1085`）。
- **我们不适用**：我们要的是定时/常驻，它是"用户点一下跑一次"，这块没有可抄的。

---

## 6. 【C1/C2】agent 循环与停止条件

### 两条循环，都在 `crates/ai`

**① 对话循环（主）**：`ai/src/agent.rs:466-591` `handle_turn()`
```
loop {
  if stop.is_stopped() → break            :482
  if turns >= max_turns → break           :486   (DEFAULT 40 / BUILDER 400, :26-28)
  turns += 1; ask_window(); one_turn()    :494-497
  match result.stop {
    Refusal        → break                :522
    PauseTurn      → 续                :532
    ToolUse        → run_tools + 回填  :540
    MaxTokens+uses → 不执行，告知模型 :556
    MaxTokens      → break                :569
    _              → break                :574 }
}
```
一轮定义 = 模型→(工具→再模型)，工具结果全部塞进**同一条 user 消息**（`:822-835, 543`）。

**② rebuild 循环**：`rebuild/mod.rs:960-1097`，Study→Build→Check→Refine，最多 `max_rounds`（`:1086-1089`，默认 6，`:165`）。

**停止条件族（C2 的重点，明显强于我们）**：
| 刹车 | 位置 |
|---|---|
| max_turns 轮数 | `agent.rs:26-28,486` |
| 用户 stop token | `:482, 825` |
| 连续 build 失败 25 次 | `:36, 545-554`（注释 #399：一个模型烧了 9.4M token） |
| 模型拒绝 / 输出超长 / 暂停 | `:521-578` 分 StopReason |
| 上下文预算不够 → 先压缩再试 | `:642-700`、`context.rs:15-46` |
| build 无进展（指纹不变） | `rebuild/mod.rs:963-968,1071-1080` |
| check 连续"不工作"上限 | `:1051-1053,1083-1085` |
| 模型降级链耗尽 | `agent.rs:803-815` |

**状态持久化**：transcript 每轮落盘（`agent.rs:609-615`、`context.rs:1-5`）；journal 追加 JSONL（见 §7）；agent CLI 会话有 unfinished-session 记录 + OS 锁清扫（`cli_agents/unfinished.rs:1-24`）。**断了能续**。

---

## 7. 【A6/A7】记忆

- **没有向量库/DB**。记忆 = **项目里的 investigation 文件**，由工具读写：`core_brief_write / core_plan_update / core_hypothesis_record / core_finding_record / core_handoff_write`（系统提示 `prompt.rs:19-26`，clean_room 白名单 `clean_room.rs:31-45`）。
- 存储：`.cany` 项目目录（evidence 文件 + unknowns + journal）。`session.rs:242-268` 记录/按 id 回查（内存→磁盘）；`journal.rs:1-14` 每次工具/模型轮/consent 追加 `<project>/journal/YYYY-MM-DD.jsonl`。
- **溯源有**：findings 必须 cite evidence id；改 finding 要 `based_on_revision` 防覆盖（`prompt.rs:24`）。
- **冲突消解/老化/TTL：未找到**（grep `ttl|decay|supersede|conflict` 无产品级命中）。
- 跨会话召回：读 transcript + investigation 文件 + journal（`agent.rs:973`、`session.rs:318-351`），没有语义检索。

---

## 8. 【D1–D5】界面

- 技术栈：**egui 0.36 立即模式**（`Cargo.toml:39-42`），只在 `ui-egui` crate。我们 TS Web **不同形态**。
- 布局范式（D1）：**两套模式**——Beginner 是向导式，Experienced 是 `workbench.rs:1-2` 描述的四区：左 rail 列表 / 中 tab 视图 / 右 inspector-evidence-unknowns / 底 agent 控制台·jobs·log。`state.rs:14` 的 `Screen` 枚举 + `lib.rs:133` `Route`。
- 状态可见性（D3）：强。`AgentEvent` 有 `Status / ToolStarted / ToolFinished / ConsentNeeded / TurnDone{input_tokens,output_tokens,cost_usd} / Error{remediation,log}`（`ai/src/lib.rs:304-360`）；rebuild 有 `Step/Status/Checked/Preview`（`rebuild/mod.rs:77-100`）+ `BuildProgress`（`workspace/progress.rs`）。
- 主题/密度/多工作区（D4/D5）：两套主题 `Studio(dark)/StudioLight`（`theme.rs:19-42`），`Tokens::get` 统一色/圆角/字号（`theme.rs:48-60`）；15 种语言目录（`ui-egui/src/i18n/*.tsv`）。
- **D2 可视化**：evidence JSON 树 + 地址表 + 截图缩略图（`workbench.rs:20-60` 的 `rows()`），**没有图表/时间线**。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：一个 ToolSpec 契约，Effects 位标志 → MCP annotations → consent
- **位置**：`crates/engine/src/tool.rs:10-59`（Effects 11 个位 + `read_only_hint/destructive_hint/open_world_hint/needs_consent`）、`:269-286`（`ToolFn`+`ToolSpec` 十字段）、`registry.rs:166-180`（`mcp_descriptor` 把 Effects 映射成 MCP 的 4 个 hint）、`clean_room.rs:12-45`（同一 id 列表决定"深度模式才可用"）。
- **为什么好**：**一个工具只写一次，UI/CLI/MCP/agent 四处按 id 分发**（`AGENTS.md:37-40` "Everything is a tool"）。Effects 是"honest side effects"，consent 和 MCP 安全提示都从它派生，不会出现"某个入口忘了限权"。我们 `kernel.mjs` 现在每个入口各自描述工具，最容易漏 effects。
- **我们抄到哪**：`tools/plugin/kernel.mjs` 的工具注册表 → 加 `effects: number(bitflags)` + 由它派生 `read_only/destructive/needs_consent`；dsh 侧 MCP 暴露时直接用同一个派生。

### 机制 2：Toolset 渐进披露（list_toolsets + enable_toolset 元工具 + lean 列表）
- **位置**：`tool.rs:61-104`（17 个内置 Toolset 分组）、`agent.rs:843-866`（两个**元工具**，模型自己开组）、`:344-347`（local 小窗口时只给精简 Core 列表）、`agent.rs:69-79`（`clean_schema` 修本地模型不吃的 schema）、`mcp/src/lib.rs:3-5`（MCP 侧同样按组给工具）。
- **为什么好**：271 个工具，靠"**默认只给 Core + 模型主动 enable**"把上下文压下来；还专门处理了"小模型窗口 24k 时工具描述就吃掉 5-8k"（`agent.rs:310-331` 注释 #417）。我们 kernel 是"全量工具塞进去"，规模一大就爆。
- **我们抄到哪**：`kernel.mjs` 的工具清单 → 引入 `toolset` 字段 + 两个元工具；dsh profile 里按会话预算选 lean/full。

### 机制 3：把 dsh 当一等后端，用 run 级 `--patch` overlay 注入我们的 MCP server
- **位置**：`crates/ai/src/cli_agents/adapters/dsh.rs:1-14`（它把 `dsh --profile headless` 当一个 coding agent 适配）、`:46-56`（argv 只有 `--profile headless` + `--patch <overlay>`，任务走 stdin）、`:127-161`（生成 overlay YAML：`insert: [{id, name:'@deepseek-ai/dsh-mcp-client', config:{serverName, transport:stdio, command, args}}]`）、`:93-105`（每次 run 建 owner-only 临时目录，不污染用户 profile）。
- **为什么好**：**这正是我们的集成点**。它不修改用户 profile，而是每次跑生成一个 patch 层把工具 server 插进去；server 名用 `craft-anything-run` 避开用户自己的注册（`dsh.rs:24-26` 注释"harness 拒绝同名两个 client"）。我们现在 `kernel.mjs` + dsh 循环的接法就是从零手搓这套。
- **我们抄到哪**：`tools/plugin/` 的 dsh 集成层 → 生成同格式的 `cordis.patch.yml`/`--patch` overlay，serverName 用独立名，任务走 stdin；临时目录 0700。

---

## 10. 我们不该抄的

1. **egui 立即模式 UI / 271 个工具 / L0-L6 crate 分层** —— 形态完全不同（它是原生反汇编工作台），照搬只会把 `kernel.mjs` 撑爆。
2. **插件 id 用 `Box::leak(&'static str)`**（`registry.rs:96`、`wasm_plugins.rs:185`）—— 换来的代价是**插件不能真正卸载**（§3.6）。Node 侧用普通字符串即可，别学这个 trade-off。
3. **WASM 插件默认关掉**（`wasm_plugins.rs:120-215` feature gate）—— 说明连它自己都觉得这条路成本高；我们别一上来就做 WASM 沙箱。
4. **无 cron、无冲突消解、无向量记忆** —— 这三块它没有，别把"它有 271 工具"误读成"它记忆/调度也成熟"。
5. **大量巨型单文件**（`cli_agents/mod.rs` 3374 行、`agent.rs` 2329、`rebuild/mod.rs` 1656、`rebuild/tests.rs` 4344）—— 是它的历史包袱，不是范本。

---

## 附：与我们三问的直接回答

1. **Rust 侧架构分层**：L0 纯数据/解析 → L2 platform(进程/沙箱) → L4 engine(工具契约) → L5 ai(循环) → L6 UI；**靠 `cargo xtask layers` 硬卡**（`xtask/src/main.rs:181-232`）。给我们最大的启示不是"抄分层"，而是"**工具契约单独一层 + 由一个注册表统一分发**"。
2. **工具/能力注册**：静态 `ToolSpec`（编译期）+ 运行期 `RuntimeTool`（插件/MCP），统一进 `Registry`（`registry.rs:60-181`），工具数由测试守 `MIN_TOOLS=271`（`tool_list.rs:7-10`）。可抄。
3. **有没有 agent 循环**：**有，而且有两条** —— 对话循环 `agent.rs:466-591`、rebuild 轮次循环 `rebuild/mod.rs:960-1097`；停止条件是 8+ 种可独立判定的刹车（§6 表），这是最值得抄 C2 的部分。
