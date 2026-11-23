# Orca 全量拆解

> 对象：`https://github.com/stablyai/orca`
> 版本：1.4.214（`package.json:3`）　语言：TypeScript　star：**124,552**　fork：7,896　MIT（YC 背书）
> 自述：「Next-gen IDE for parallel agentic development」/「**The AI Orchestrator for 100x builders**」
> 获取方式：`codeload` tarball 全量下载（**86.9MB 压缩 / 254.1MB 工作树**）后本地解压
> 实测规模：**37,185 文件 / 254.1MB**（`D:\refs\orca`）
> 拆解日期：2026-11-14

---

## 0. 先说最要紧的一件事

**Orca 已经支持 Hermes Agent 和 DeepSeek Harness 了。**

`src/shared/agent-launch/catalog/tui-agent.ts` 的 `TuiAgent` 联合类型里有：

```ts
| 'hermes'    // Hermes Agent
| 'dsh'       // 见 tui-agent-config.ts:304
| 'openclaw'
| 'pi' | 'omp' | 'qoder' | 'codex' | 'claude' | ... 共 40 个
```

`README.md` 的 Supported Agents 一栏直接挂了 `hermes-agent.nousresearch.com` 和 `deepseek-harness.github.io` 的徽章。

**这意味着三件事：**

1. **Orca 是「元编排器」，我们在它的被编排对象列表里。** 它不和我们抢「AI 工作台」这个位置，它站在我们**上面**。
2. **「能编排多个 agent」不能当我们的差异化** —— Orca 编排 40 个，我们编排 0 个外部 agent。这个维度我们客观落后，且短期追不上。
3. **但它也暴露了我们的一个真问题**：Orca 为了接我们，**不得不给我们写一套专属的注入模式**（`promptInjectionMode: 'hermes-query'`，见 §4.2）。而 Pi / OMP 用的是统一契约（`draftPromptEnvVar: 'ORCA_PI_PREFILL'`）。**我们是那个"不好接"的。**

---

## 1. 它是什么

一个 **Electron 桌面 IDE**，核心主张是**并行**：

> Run Claude Code, Codex, and any other coding agent in parallel, **each in its own worktree**. Chat or terminal, on your laptop or in the cloud, with diffs, a browser, and a CLI in one app.

产品面 12 条主功能 + 8 条「Also in the box」（`README.md`）：

| # | 功能 | 一句话 |
|---|---|---|
| 1 | Chat or Terminal | 同一场对话在 Chat UI 和裸 CLI 之间**互转而不丢上下文** |
| 2 | Orchestrate Agents | 协调者 agent 拆任务、在各自 worktree 起 worker、把结果收回来 |
| 3 | Run Anywhere | Remote Orca Server / SSH 主机 / 每 worktree 一个云 VM；**笔记本睡眠时 agent 继续跑** |
| 4 | Mobile App | iOS（App Store）+ Android APK；agent 需要你时推送，直接回话 |
| 5 | Review AI Output | 看 diff、**在具体改动行上留批注**、把聚焦反馈发回 agent |
| 6 | Git Integration | 从 diff 起草 commit/PR，把失败的 check 或 PR 评论发回 agent 去修 |
| 7 | Parallel Worktrees | 任务拆进隔离环境，多 agent 互不干扰 |
| 8 | Design Mode | 在 Orca 浏览器里点任意元素，复制它的 HTML/样式/选择器，粘进 agent 对话 |
| 9 | GitHub & Linear | 任务集中看，一键为 issue 起 workspace |
| 10 | Orca CLI | **UI 能干的事 agent 也能干**：建 worktree、起 worker、驱动浏览器和桌面应用、排自动化 |
| 11 | Plugins | 主题、编辑器、语言、面板的社区目录 |
| 12 | Split Anything | agent / 终端 / 浏览器 / diff 并排分屏 |

「Also in the box」：拖文件进 agent prompt、Jump Anywhere（一个快捷键跳到任何 workspace/tab，跨所有 repo 和主机）、富预览（图片/PDF/Markdown 就在产出它的 agent 旁边）、**Mobile Emulator**（在 agent 旁边跑 iOS 模拟器/Android 模拟器，让 agent 自己点、自己打字、自己验收）、听写、**Usage & Accounts**（看 agent 限额用了多少、何时重置，**不登出就能换账号**）、**Automations**（排定时 prompt：夜间依赖升级、每周 triage、flaky 测试清扫）、**Computer Use**、插件。

---

## 2. 规模与技术栈

```
src/main        13,830 文件   67.7MB    Electron 主进程
src/renderer    11,591 文件   68.6MB    React 渲染层
src/shared       4,265 文件   13.8MB    主/渲染共享
src/cli            482 文件    2.3MB    命令行
src/preload        237 文件    0.8MB
src/wsl-guest       94 文件    0.5MB    WSL 侧
config           1,079 文件   26.0MB    构建/检查脚本（比很多项目整个仓库都大）
mobile           3,239 文件   20.7MB    Expo / React Native
resources          126 文件   15.3MB
tests            1,166 文件    7.7MB
cloud              421 文件    2.6MB    独立可部署套件（apps/packages/security）
native              87 文件    0.8MB    三平台原生模块
```

**技术栈**：Electron + electron-vite + React + pnpm workspaces + oxlint/oxfmt + ast-grep + vitest + husky。

**mobile 是 Expo / React Native**，且 `pnpm-workspace.yaml:1-3` 说明它**故意独立 lockfile**：

> Exclude mobile's independent workspace/lockfile: recursive discovery causes ERR_PNPM_UNUSED_PATCH. Explicit registry/security workspaces avoid file:-dependency relinks, whose virtual-store churn **raced Windows node-gyp and removed @vscode/windows-process-tree's binding.gyp mid-rebuild**.

这种「把踩过的坑写进配置注释」的密度，是这个仓库的普遍风格。

**`native/` 下有**：`computer-use-linux` / `computer-use-macos` / `computer-use-windows`（三平台 computer-use 原生实现）、`keyboard-layout-macos`、`macos-shipit-scheduling`（macOS 自动更新调度）、`notification-status-macos`、`process-footprint-macos`、`wayland-clipboard`。

**供应链防线**：`pnpm-workspace.yaml:9` `minimumReleaseAge: 4320`（分钟 = **72 小时**）——不安装发布不满 3 天的包，给恶意投毒留出发觉窗口。并对明确需要的包做有注释的例外（如 Bun 1.4.4、安全修复）。

---

## 3. 架构：40 个 agent 怎么被统一起来 ★

这是全仓库对我们价值最高的部分。

### 3.1 声明式 agent 目录

`src/shared/agent-launch/catalog/tui-agent-config.ts` 里是一个：

```ts
const TUI_AGENT_CONFIG_SOURCE: Record<TuiAgent, TuiAgentConfigSource> = { ... }
```

**40 个 agent，每个 agent 的全部终端怪癖都是一条数据。** 字段清单：

| 字段 | 作用 | 例子 |
|---|---|---|
| `detectCmd` | 探测安装的命令 | `'claude'`、`'dsh-tui'` |
| `detectCmdAliases` | 别名 | `['cbc']`、`['dst']` |
| `detectRequiredCommands` | 额外必需命令 | dsh 需要 `['dsh']` |
| `detectUnsupportedRuntimes` | 不支持的运行环境 | `['win32','wsl']` |
| `launchCmd` / `launchCmdByPlatform` | 启动命令，可按平台不同 | `'hermes --tui'` |
| `expectedProcess` | 要监视的进程名 | |
| **`promptInjectionMode`** | **prompt 怎么送进去** | 见 §3.2 |
| `draftPromptFlag` | 原生的预填 flag | `'--prefill'` |
| **`draftPromptEnvVar`** | **环境变量预填** | `'ORCA_PI_PREFILL'` |
| **`draftPasteReadySignal`** | **composer 就绪信号** | `'claude-composer-prompt'`、`'dsh-composer-prompt'` |
| `draftPasteReadyTimeoutMs` | 就绪等待上限 | `20_000` |
| `pasteNeedsTypedRequest` | 粘贴需要模拟键入 | |
| `workerStartReadsComposerMarker` | | |
| `ctrlEnterEncoding` | Ctrl+Enter 的编码方式 | `'csi-u'` |
| `windowsShiftEnterEncoding` | Windows Shift+Enter 编码 | `'csi-u'` |
| `windowsInputRecordPasteNewline` | Windows 下粘贴换行 | `'alt-enter'` |
| `submitRetryDelayMs` / `submitRetryBudgetMs` | 提交重试延迟/预算 | dsh: `1000` / `30000` |
| `preflightTrust` | 预写信任配置以跳过首次信任菜单 | `'claude'` / `'codex'` / `'copilot'` |

**每一条怪癖都附 `Why:` 和 issue/PR 号**——这是制度性知识进单一源的样子：

```ts
claude: {
  // Native --prefill avoids paste-after-ready races (https://github.com/stablyai/orca/pull/926).
  draftPromptFlag: '--prefill',
  // Why: CLAUDE_CODE_DISABLE_TERMINAL_TITLE drops the `✳` title tui-idle waits on (#22655).
  draftPasteReadySignal: 'claude-composer-prompt',
  // Why: Claude decodes CSI-u Ctrl+Enter on local ConPTY; CR made a remapped
  //      ctrl+enter act as Enter (#29711).
  ctrlEnterEncoding: 'csi-u'
}
```

```ts
pi: {                                        // :124
  detectCmd: 'pi',
  promptInjectionMode: 'argv',
  // Pi has no prefill flag; the managed extension seeds env to avoid its long startup paste race.
  draftPromptEnvVar: 'ORCA_PI_PREFILL',      // :128
  // Why: Pi decodes CSI-u; Esc+CR submits after tool subprocesses reset live KKP state (#9703).
  windowsShiftEnterEncoding: 'csi-u'
},
```

### 3.2 六种 prompt 注入模式（实测分布）

用正则统计 `tui-agent-config.ts`：

| 模式 | 个数 | 含义 |
|---|---|---|
| `stdin-after-start` | 23 | 启动后在 stdin 注入 |
| `argv` | 13 | 作为命令行参数传 |
| `flag-prompt-interactive` | 4 | 用某 flag 传 prompt 但保持交互 |
| `flag-prompt` | 3 | 用某 flag 传 prompt |
| **`hermes-query`** | **1** | **我们专属** |
| `flag-interactive` | 1 | |

**只有 1 个 agent 需要专属模式，那个就是我们。**

### 3.3 我们是被怎么接的（原文）

`tui-agent-config.ts:269-275`：

```ts
hermes: {
  detectCmd: 'hermes',
  // Bare hermes opens the classic REPL; --tui selects the hosted full-screen interface.
  launchCmd: 'hermes --tui',
  // Why: Hermes delivers the prompt via its startup-query contract, submitting only after the composer is ready.
  promptInjectionMode: 'hermes-query'                            // :274
},
```

对比 DSH（`:304`）：

```ts
dsh: {
  detectCmd: 'dsh-tui',
  detectCmdAliases: ['dst'],
  detectRequiredCommands: ['dsh'],
  // A first bare launch opens the session browser instead of the composer.
  launchCmd: 'dsh-tui .',
  expectedProcess: 'dsh',
  promptInjectionMode: 'stdin-after-start',
  // The whale intro keeps repainting behind the ready composer.
  draftPasteReadySignal: 'dsh-composer-prompt',
  // Why: dsh-tui 0.17's launchpad refuses Enter, keeping the draft, until its session opens (1-24 s).
  submitRetryDelayMs: 1000,
  submitRetryBudgetMs: 30_000
}
```

**Orca 给 DSH 写的注释等于一份免费的外部评测报告**：「第一只鲸鱼开场在 composer 就绪后还在重绘」「dsh-tui 0.17 的 launchpad 在会话打开前（1–24 秒）拒绝 Enter、保留草稿」。

### 3.4 `hermes-query` 的实现：启动查询环境变量

`src/shared/agent-launch/startup/hermes-startup-query.ts`：

```ts
const QUERY_ENV_LIMIT = 24_000;
const QUERY_PLACEHOLDER = '__ORCA_HERMES_STARTUP_QUERY__';
const QUERY_ARG_PLACEHOLDER = `--query=${QUERY_PLACEHOLDER}`;
const POSIX_QUERY_VARIABLE = '__orca_hermes_startup_query';
const POWERSHELL_QUERY_VARIABLE = 'orcaHermesStartupQuery';
export const ORCA_HERMES_STARTUP_QUERY_ENV = 'ORCA_HERMES_STARTUP_QUERY';
```

它把查询串通过**环境变量**传（绕开 argv 长度限制和转义问题，上限 24KB），POSIX 侧用八进制转义 `\\0<octal>` 编码后用 `eval` 展开，Windows 侧走 PowerShell 变量。

**这说明 Orca 认为 hermes 有一个「启动查询契约」**（`--query=`），但需要它自己做一层环境变量 + 脚本桥接才能可靠投递。

---

## 4. Orca 对 hermes 的深度集成（这一段最值得读）★

`src/main/hermes/` 是一个完整子系统（15 个文件）：

```
hermes-config-document.ts             5.2KB   读/改 config.yaml
hermes-config-comment-boundaries.test.ts 4KB   ★ 注释边界测试
hermes-config-preservation.test.ts    7.6KB    ★ 配置保全测试
hermes-config-source-edits.ts         6.8KB
hermes-config-yaml.ts                 6.0KB
hermes-managed-plugin-source.ts       7.6KB   ★ 装插件
hermes-default-home.ts                1.9KB
hermes-home-filesystem.ts             3.2KB
hook-service.ts                       8.4KB
hook-service.test.ts                 18.9KB   ★ hook 服务测试比实现大一倍
```

### 4.1 它往 hermes 里装一个托管插件

`hermes-managed-plugin-source.ts:6-30`：

```ts
export const HERMES_PLUGIN_NAME = 'orca-status';
export const HERMES_PLUGIN_MARKER = 'Managed by Orca. Do not edit; changes may be overwritten.';

export const HERMES_EVENTS = [
  'on_session_start', 'pre_llm_call', 'post_llm_call',
  'pre_tool_call', 'post_tool_call',
  'pre_approval_request', 'post_approval_response',
  'on_session_end', 'on_session_finalize', 'on_session_reset'
] as const;
```

插件清单带 `provides_hooks:` 声明这 10 个事件，`kind: standalone`。生成的 Python 实现用 `urllib.request` 把事件 POST 回 Orca 的 endpoint。

### 4.2 环境变量白名单：KEY/TOKEN 永不传递

`hermes-managed-plugin-source.ts:22-30`：

```ts
// Hermes' shared gateway binds only these client env names to a session;
// KEY/TOKEN names never travel.
export const HERMES_CLIENT_ENV_PASSTHROUGH: readonly string[] = [
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  'ORCA_TAB_ID', 'ORCA_WORKTREE_ID',
  'ORCA_AGENT_HOOK_ENDPOINT', 'ORCA_AGENT_HOOK_ENV', 'ORCA_AGENT_HOOK_VERSION'
];
```

**这是一条安全设计：环境变量按名字白名单透传，密钥类名字（`*_KEY`、`*_TOKEN`）永不过网关。** 我们自己的桌面端有这个概念吗？——值得查。

### 4.3 改配置不破坏操作者注释

`hermes-config-preservation.test.ts`（7.6KB）测试里出现：

```ts
const configured = `# Operator comments\r\nmodel: "fixture"\r\nplugins:\r\n  enabled: [orca-status]\r\n...`
vi.stubEnv('HERMES_HOME', directory)
```

配合 `hermes-config-document.ts`、`hermes-config-source-edits.ts`（`HERMES_EDITED_LISTS`）——**它只改自己那几个列表项，保留其余注释和格式**。这跟我们的「单一真实来源、不覆盖用户配置」是同一条纪律，但它有专门的测试守着。

### 4.4 ★ 这件事暴露了我们什么（含一次自我纠错）

**先说结论**：Orca 用 hermes 的插件 hook 总线，是因为它**在 hermes 外面**——外部进程只能靠插件 hook 拿到生命周期事件。而**我们在 hermes 里面**，可以直接用网关自己的事件流，那条路比插件 hook 更底层、更完整。

**我们实际有什么（已核实，不是推断）：**

| 能力 | 我们的实现 | 位置 |
|---|---|---|
| 命名 + 版本的实时协议 | `CANONICAL_GATEWAY_PROTOCOL = 'hermes-gateway-v1'`（WebSocket 子协议） | `apps/desktop/src/api/canonical-protocol.ts:8` |
| 鉴权 | ticket 子协议 `hermes-gateway-ticket.<t>` | 同上 `:21` |
| 代数（防旧状态） | `execution_generation` | 同上 `:614` |
| 状态版本 | per-owner `revisions` | 同上 `:596-626` |
| 事件类型 | `session.info` / `session.updated` 等带 `payload` + `session_id` + `profile` | 同上 `:596-609` |
| 渲染层连接方式 | **渲染层直连网关 WS**，不经 IPC 转发 | `apps/desktop/src` 是渲染层，`apps/desktop/electron` 是主进程 |

**所以我在本报告初稿里写的「我们的桌面端现在是 HTTP 轮询 + 读 state.db」是错的**，必须撤回：
- 应用本身走 **WS 事件流 + REST 查询**，不是轮询；
- 读 `state.db` 的是**我的验证探针脚本**（`probe-approval.py`、`trace-approval*.py`），不是产品。

**真正该记的差距（修正后）：**

hermes 的插件 hook 总线有 **48 个事件**（Python `ast` 精确解析 `C:\hermes\hermes_cli\plugins.py:113` 的 `VALID_HOOKS`）：

| 分类 | 数量 | 事件 |
|---|---|---|
| 会话 | 6 | `on_session_start/end/finalize/reset/delete/open` |
| 流式 | 4 | `on_stream_start`、`on_stream_delta`、`on_stream_end`、`on_interim_message` |
| 工具 | 3 | `pre_tool_call`、`post_tool_call`、`transform_tool_result` |
| LLM/API | 9 | `pre/post_llm_call`、`pre/post_api_request`、`api_request_error`、`pre/post_auxiliary_call`、`transform_api_error_classification`、`transform_llm_output` |
| 子 Agent | 2 | `subagent_start`、`subagent_stop` |
| 验证 | 1 | `pre_verify` |
| 网关/入站 | 3 | `pre_gateway_dispatch`、`post_gateway_admission`、`gateway_platform_event` |
| 审批 | 2 | `pre_approval_request`、`post_approval_response` |
| Kanban/调度 | 10 | `kanban_task_claimed/completed/blocked`、`on_kanban_dispatch_tick`、`on_kanban_task_updated`、`on_kanban_worker_spawned/exited/stale_claim`、`post_compaction`、`post_curator_run` |
| 人机交互 | 4 | `on_human_input_request/resolved`、`pre_command`、`pre_transcription` |
| 技能/消息/线程 | 2 | `on_skill_lifecycle`、`on_room_member_activity` |
| 其它 | 2 | `agent_loop_stopped`、`transform_terminal_output` |

Orca 只用了其中 10 个（全部有效），38 个没用——**因为绝大多数被托管的 CLI agent 根本没有 hook 总线，它不能为某一个 agent 改架构。**

**我们真正的问题不是「该不该用 hook」，而是：这 48 个事件里，有多少已经被我们的 WS 事件流带到了界面上？** 这是一个**可测的问题**，不该靠推断回答。具体要查的是：流式增量、子 agent 生命周期、`pre_verify`、kanban 状态这四类，界面上有没有对应的实时展示。本报告不下结论——留给下一轮用「订阅 WS 帧并比对 hook 触发」的实测来回答。

**能确定的战略结论仍然成立**：Orca 因为要托管异构 agent，被迫**解析 PTY** 来推断界面状态；omp-studio 在自述里明确拒绝这条路（`PTY bytes are not a control protocol`、`docs/architecture.md:50`）。**我们拥有运行时和事件流，天生不必解析终端——这是结构性优势，但它值多少，取决于我们把多少结构化事件真正送到了界面。**

---

## 5. 编排拆解

### 5.1 15 条编排 CLI 动词

`src/cli/specs/orchestration.ts`：

| 动词 | 作用 |
|---|---|
| `run-create` / `run-use` / `run-current` / `run-list` / `run-show` | **Run** 概念：一次协调会话的生命周期 |
| `send` / `reply` / `inbox` | **agent 间信箱**：发、回、收 |
| `task-create` / `task-list` / `task-update` | 编排任务板 |
| `dispatch` / `dispatch-show` | 把任务派到终端 |
| **`request-show`** | **问某个编排变更请求是否已经生效**（幂等确认，防盲目重试） |
| **`ask`** | **向协调者提问，Orca 唤醒你并给答案**（阻塞式问询 + 唤醒） |

### 5.2 worker-start 的契约深度

`src/cli/specs/orchestration-worker-specs.ts` 里 `worker-start` 的用法字符串（节选原文）：

```
orca orchestration worker-start
  (--task <task_id> | --spec <text> | --spec-file <path|->)
  [--keep-open] [--on <saved-environment>]
  [--worktree <current|selector|new-child|new-top-level>]
  (--agent <agent> | --terminal <handle>)
  [--task-title <text>]
  [--deps <json_array>]      ★ 派单时声明依赖
  [--parent <task_id>]
  [--model <id>] [--effort <level>]
  [--name <name>] [--repo <selector>] [--base-branch <ref>]
  [--display-name <text>] [--comment <text>]
  [--setup <run|skip|inherit>]
  [--retry-of <dispatch_id>] [--timeout-ms <n>]
  [--run <run_id>] [--from <handle>] [--retry-request <id>]
  [--json]
```

`notes` 里几条特别值得抄：

> **`--spec-file` reads the spec from a file (relative to the current directory) or stdin (`-`) on this machine, so quotes and backticks need no shell escaping.**

——给 agent 用的 CLI 必须考虑「agent 传长文本时的转义地狱」。用 stdin `-` 绕开。我们的 CLI 没有这个。

> **Failed or outcome_unknown exits 1 and JSON includes `stage` / `failedStage`, `setup`, `effects`, `residualResources`, and recovery commands when needed.**

——**`outcome_unknown` 又出现了**（和 omp-studio 同一个概念，两个独立系统都收敛到这个第三状态）。而且失败时报告 **`residualResources`（泄漏了哪些资源）** 和 **恢复命令**。这是运维成熟度的标志：失败不只是「退出码 1」，而是「你留下了什么、怎么收拾」。

> **Not every worker has a terminal. ... Nothing above needs you to know which kind you have — the orchestration verbs cover all of them.**

——结构化工件和终端工件用**同一套动词**，调用方不需要知道自己手里是哪种。

> `--effort` 的语义按 agent 各不相同：Pi 映射到 `--thinking`（`off, minimal, low, medium, high, xhigh, max` 七档）；OMP 接受模型角色 `@worker` 或 `provider/model:level`；OpenCode 不支持 effort；其他 agent 用它自己配置里的模型。

——**异构 agent 的参数差异被写成一张显式映射表**，而不是「都传 `--model`，失败了再说」。

### 5.3 协调者实现

`src/main/runtime/orchestration/coordinator/`：

```
coordinator.ts                        主实现
coordinator-dag-convergence.ts        ★ DAG 收敛
coordinator-drift-probe-coalescing.ts 漂移探测合并
coordinator-runtime-contract.ts       运行时契约
decision-gates/                       决策闸门
dispatch/                             派发
escalation/                           升级
```

模式：**dispatch → decision-gates → escalation → DAG 收敛**。

### 5.4 信箱与联邦

```
mailbox/routing/            消息路由（带 *.spec.ts 竞态测试）
mailbox/senders/            发送者命名
mailbox/structured-mail/    结构化邮件
mailbox/structured-pointer/ 结构化指针投递（投指针而不是内容）
mailbox/delivery-hold/      投递挂起
mailbox/questions/          问询
federation/remote-owned/    跨机对等（远程所属）
federation/peer-mail/       对等邮件中继
db/remote-owned/            远程放置记录
terminal-authority/         终端权威（谁拥有这个终端）
workers/approvals/          worker 审批挂起
workers/turn-stops/         worker 回合停止上报
crew/                       crew（一组 agent）的投影与认领约简
```

**注意有 `*.spec.ts` 竞态测试**（`orchestration-mailbox-routing-races.spec.ts` 12.6KB）——他们为并发路由写专门的竞态测试。

---

## 6. 界面拆解

### 6.1 四条与「窗口化」不同的路线

omp-studio 走「浮动窗口 + 吸附」，Orca 走「**分屏面板**」：

- **Split Anything**：agent / 终端 / 浏览器 / diff 并排，按任务形状分屏
- **Jump Anywhere**：一个快捷键跳到任何 workspace 或 tab，**跨所有 repo 和所有主机**
- **Chat ⇄ Terminal**：同一场对话在两种形态间互转，**不丢上下文**（这是最难的：需要把 Chat UI 的结构化消息和 CLI 的文本流互相映射）

### 6.2 四个我们没有的界面能力

| 能力 | 说明 | 为什么重要 |
|---|---|---|
| **Design Mode** | 在 Orca 浏览器里点任意元素 → 复制 HTML/样式/选择器 → 粘进 agent 对话 | 把「视觉问题」变成「可执行的上下文」，省掉人的转述 |
| **在 diff 具体行上留批注** | 不只是「看一下 diff」，而是在改动行上写注释并把**聚焦反馈**发回 agent | 比「把整个 diff 丢回去让它自己找」精确得多 |
| **Mobile Emulator** | 在 agent 旁边跑 iOS 模拟器/Android 模拟器，**让 agent 自己点、自己打字、自己验收** | 移动端验收从「人肉」变成「agent 自证」 |
| **Usage & Accounts** | 看 agent 限额用了多少、何时重置，**不登出就能换账号** | 多账号用户的实际痛点 |

### 6.3 界面规范化的工程手段（我们没有的）

`package.json` scripts 里有几条值得单独点出：

| 脚本 | 作用 |
|---|---|
| **`lint:design-system`** | `oxlint --config config/oxlint-design-system.json src/renderer` —— **用 lint 规则强制设计系统** |
| **`check:zustand-selector-fanout`** | `zustand-selector-fanout-benchmark.mjs --check` —— **渲染扇出的性能闸门** |
| `lint:ast-grep` / `lint:ast-grep-gates` | 结构扫描 |
| **`lint:ast-grep:flaky-tests`** | `--filter "^test-"` —— **专查 flaky 测试的结构模式** |
| `check:code-quality:changed` | 只检查改动文件 |
| `audit:dead-code`（knip）/ `audit:react-doctor` | 死代码、React 反模式 |
| `check:dependencies` | 依赖安全审计 |
| `test:repro:remote-agent-session` | **为某个具体缺陷保留复现脚本** |

对照我们：我们靠**人写判据 + 验收器**，他们有**lint 层的自动强制**。两者互补——我们的验收器能查语义（这个能力有没有、证据在不在），lint 能查形式（有没有用错 token、有没有扇出爆炸）。**我们缺后者。**

---

## 7. 我们能拿走的（按优先级）

| # | 拿走什么 | 证据 | 我们的落点 |
|---|---|---|---|
| **P0** | **实测「48 个 hook 里有多少已到界面」**（流式/子 agent/verify/kanban 四类），缺的补上 | `hermes_cli/plugins.py:113` VALID_HOOKS；我们的 WS 在 `canonical-protocol.ts:8` | 下一轮实测，不靠推断 |
| **P0** | **`outcome_unknown` 第三状态 + `residualResources` + recovery 命令** | `orchestration-worker-specs.ts:56,58` | 验收器/审批/派单 |
| P1 | **声明式 agent/scene 目录**（每条怪癖带 `Why:` + issue 号） | `tui-agent-config.ts` 全文 | 我们 12 个场景的声明化 |
| P1 | **`--deps <json_array>` 派单时带依赖 DAG** | 同上 usage | 派单协议 |
| P1 | **`request-show` 幂等确认 + `ask` 阻塞问询唤醒** | `orchestration.ts` 15 动词 | 团队任务协议 |
| P1 | **`--spec-file -` 从 stdin 读长文本** | 同上 notes | 我们的 CLI |
| P2 | **环境变量白名单透传，KEY/TOKEN 名字永不过网** | `hermes-managed-plugin-source.ts:22-30` | 桌面端 env 处理 |
| P2 | **design-system lint + 渲染扇出性能闸门** | `package.json` scripts | 工程闸门 |
| P2 | **在 diff 具体行上留批注并回发 agent** | README Review AI Output | 审阅流 |
| P2 | **`minimumReleaseAge: 4320` 供应链延迟** | `pnpm-workspace.yaml:9` | 依赖策略 |
| P3 | Design Mode / Mobile Emulator / Usage&Accounts | README | 中期 |

## 8. 不该拿的 / 它的代价

1. **「40 个 agent」这条路我们走不了，也不该走。** 需要为每个 agent 维护注入模式、就绪信号、重试预算、编码怪癖——这是个**永无止境的维护黑洞**，靠 124k star 的社区体量摊平。我们做 1 个自己的运行时，应该走反方向：**把我们的运行时做成「别人容易接」的**（也就是补上 §3.3 暴露的那个短板）。
2. **PTY 解析是它的结构性债。** 它能用 hook 的地方就用（hermes 用了 10 个），不能用就解析终端。而解析终端意味着**所有界面状态都要从文本里猜**。我们可以不背这个债。
3. **37,185 文件 / 254MB / 13,830 文件的主进程**——这是规模的胜利也是可维护性的问号。我们不能照搬体量。
4. **它是商业产品（YC 背书）**，有 cloud/mobile/账号体系，我们需要判断哪些是产品必需、哪些是商业配套。

---

## 9. 证据索引

| 主张 | 位置 |
|---|---|
| 124,552 star / 254.1MB / 37,185 文件 | GitHub API + 本地 `Get-ChildItem` 实测 |
| 支持 Hermes / DSH / openclaw / Pi / OMP | `src/shared/agent-launch/catalog/tui-agent.ts:1-40` |
| 40 个 agent 类型 | 同上 |
| 6 种注入模式分布 | 正则统计 `tui-agent-config.ts` |
| hermes 接入方式与 `hermes-query` | `tui-agent-config.ts:269-275` |
| dsh 接入方式与缺陷注释 | `tui-agent-config.ts:304-318` |
| Pi 的 `ORCA_PI_PREFILL` | `tui-agent-config.ts:124-130` |
| Claude 的 CSI-u / #29711 / #22655 | `tui-agent-config.ts:27-35` |
| 启动查询环境变量与 24KB 上限 | `src/shared/agent-launch/startup/hermes-startup-query.ts:10-15` |
| hermes 托管插件名/marker/10 事件 | `src/main/hermes/hermes-managed-plugin-source.ts:6-30` |
| KEY/TOKEN 永不传递 | 同上 `:22-23` |
| 配置注释保全测试 | `src/main/hermes/hermes-config-preservation.test.ts` |
| hermes 48 个 hook 权威清单 | `C:\hermes\hermes_cli\plugins.py:113`（Python `ast` 精确解析） |
| 15 条编排动词 | `src/cli/specs/orchestration.ts` |
| worker-start 完整契约与 notes | `src/cli/specs/orchestration-worker-specs.ts:6-56` |
| `outcome_unknown` + `residualResources` | 同上 `:56` |
| `--spec-file -` stdin | 同上 `:52` |
| 协调者 DAG 收敛/闸门/升级 | `src/main/runtime/orchestration/coordinator/` |
| 信箱竞态测试 | `src/main/runtime/orchestration/mailbox/routing/*.spec.ts` |
| 联邦/远程所属 | `src/main/runtime/orchestration/federation/`、`db/remote-owned/` |
| design-system lint / 扇出闸门 / flaky 检测 | `package.json` scripts |
| 供应链 72 小时延迟 | `pnpm-workspace.yaml:9` |
| mobile 是 Expo/React Native | `mobile/package.json:1-20` |
| 三平台 computer-use 原生模块 | `native/computer-use-{linux,macos,windows}/` |

---

## 10. 诚实声明

- 本拆解基于**全量下载的源码**（37,185 文件 / 254.1MB），不是文档印象。
- **没有构建、没有运行**它的产品（需要 2.7GB 依赖 + 平台工具链）。所以界面部分的判断来自代码、README、以及它对自身行为的精确文字描述（如「160ms」「1–24 s」「上限 24KB」），**不是我自己跑起来的实测**。凡涉及「用起来怎样」的结论本报告不下。
- `src/main`（13,830 文件）和 `src/renderer`（11,591 文件）**只读了入口和关键子系统**，绝大部分没有逐行读。所以「它整体工程质量如何」这种结论我不下。
- 我确认了 hermes 的 48 个 hook 是**精确解析**得来的（Python `ast` 解 set 字面量），不是正则猜的。第一版我用正则在源码里抓，抓到 80 个——**那是错的**，因为把注释里引号包住的示例词（`action`、`allow`、`message`）也算进去了。已修正并改用 ast。这条记在这里，因为它正好是「不许凭看起来对就上报」的例子。
