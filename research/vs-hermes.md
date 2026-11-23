# hermes-agent 源码剖析

> 全部结论基于 `C:\hermes` 只读源码实测。数字为排除 `.venv / node_modules / __pycache__ / dist` 后的统计值。

## 一句话定位

**Hermes = "一个 agent core + 极窄工具腰 + 边缘能力" 的个人通用 Agent 平台**：`agent/` 里一个同步 turn 循环（约 13.8 万行）被 CLI / TUI / Electron 桌面 / Web dashboard / ACP 编辑器 / 26 个消息平台插件共用，能力通过 **plugins + skills** 外挂，核心只保留 41 个 core tool。两条被写进仓库根 `AGENTS.md:16-24` 的不变量支配了几乎所有设计：**① 逐会话 prompt cache 神圣不可破坏；② 核心是窄腰，能力住在边缘**。

## 规模与结构（实际数字）

**总计：11,501 个 `.py`（121 MB）+ 5,601 个 `.ts/.tsx`（43 MB）**（任务说明给的 4650 个 TS 偏保守，实测含 `apps/shared` 与 `website` 为 5601）。

| 目录 | .py | .ts/.tsx | 职责 |
|---|---|---|---|
| `tests/` | 8,205（其中 `test_*.py` 7,889） | 1 | 契约测试 / CI 门 |
| `hermes_cli/` | 857 | 0 | CLI 全部子命令、配置系统、插件装载、skin、profiles、web_server |
| `agent/` | 430（`agent/*.py` 364 个 / 138,572 行；`turn_*.py` 33 个） | 0 | **turn 循环 + prompt + 压缩 + 记忆 + curator + 子代理运行时** |
| `tools/` | 390（顶层 43 个 + `environments/` 沙箱后端） | 0 | 模型工具定义/注册/执行；6 种执行后端 |
| `gateway/` | 388 | 0 | 消息网关（`run.py` 272 KB）；`gateway/platforms/` 49 个 py 是适配器基类/helpers，具体平台在 `plugins/platforms/` |
| `plugins/` | 348 | 0 | 在树插件：`platforms/`(26) `model-providers/`(43) `web/`(26) `memory/`(5) 等 |
| `scripts/` | 173 | 0 | `scripts/check`、`scripts/ci/*`（含 `prompt_surface.py`） |
| `evals/` | 168 | 8 | **开发者 A/B 与探针 harness（44 个子目录）**，非 agent 自检 |
| `tui_gateway/` | 128 | 0 | TUI/Desktop/Dashboard 共用的 JSON-RPC 后端 |
| `optional-skills/` | 101 | 17 | 22 分类 / 141 个 `SKILL.md`，按需安装 |
| `cron/` | 56 | 0 | 调度器（`scheduler.py` 219 KB）、kanban dispatcher |
| `skills/` | 50 | 0 | 13 分类 / **44 个内置 `SKILL.md`** |
| `acp_adapter/` `hermes_platform/` `providers/` `pm/` | 22/15/2/57 | 0 | 编辑器协议 / 机器事实 / 模型 provider ABC / 包管理 |
| `apps/desktop/src` | — | 3,728（electron 另 733） | Electron + React 桌面端 |
| `apps/*`（全部） | 5 | 4,651 | desktop / shared / web |
| `ui-tui/` | 4 | 643 | Ink TUI |
| `web/` | 0 | 245 | dashboard（内嵌真 TUI） |
| `plugin-catalog/` | 0 | 0（**2,311 个 yaml**） | 离树插件唯一发现通道，40-hex SHA 锁定 |
| 根目录 | 88 个 `.py` | — | facade：`run_agent.py`(90 KB) `cli.py`(83 KB) `hermes_state.py`(95 KB) + 60 个 `hermes_state_*.py` 兄弟 |

## 架构分层图

```
┌─ 表面 (Surfaces) ────────────────────────────────────────────────┐
│ CLI(hermes_cli)  Ink TUI(ui-tui)  Electron(desktop)  Dashboard   │
│ ACP 编辑器  Webhook  └─ 26 个消息平台插件 (plugins/platforms)     │
└───────────────┬──────────────────────────┬──────────────────────┘
                │ 进程内直调                │ JSON-RPC (WebSocket /api/ws)
                │                          ▼
                │              ┌─ tui_gateway/ (128 py) ───────────┐
                │              │ methods_* 会话权威 + event 广播    │
                │              └──────────┬────────────────────────┘
                ▼                         ▼
┌─ 网关 gateway/ (388 py) ────────────────────────────────────────┐
│ run.py 单进程多 profile 多路复用；消息守卫/流式/通知/token 锁    │
└───────────────────────────┬─────────────────────────────────────┘
                            ▼
┌─ run_agent.py::AIAgent（facade，~60 构造参数）──────────────────┐
│ agent/agent_init.py::init_agent 组装 mixin                      │
│ ▼                                                              │
│ agent/conversation_loop.py::run_conversation  ← 一次 turn 的根   │
│   └ _run_conversation_turn:  while(...)  ← 真正的循环            │
│       33 个 turn_*.py 阶段兄弟文件，每个 ~300-1000 行            │
│       preflight → iteration_prep → request_assembly → api_call  │
│       → response_check → tool_round / finish_text_response      │
│       → overflow / truncation / recovery / stop_gates           │
├─ tool_executor.py（并发批次 + 串行 + 授权门 + 中间件）           │
│   └ model_tools.py::handle_function_call → tools/registry.py     │
├─ context_compressor.py（328 KB，两层阈值 + aux 模型摘要）        │
├─ memory_manager.py（provider 扇出） ← memory_tool/MEMORY.md      │
├─ background_review.py（turn 后 fork 评审写 memory/skill）        │
└─ curator.py（技能生命周期：active→stale→archive）                │
                            ▼
┌─ 工具与执行 tools/ (390 py) ────────────────────────────────────┐
│ registry: 55 次 register() / 45 个文件；57 个 toolset；67 个工具 │
│ environments/: local / docker / modal / daytona / vercel / ssh   │
└─────────────────────────────────────────────────────────────────┘
                            ▼
┌─ 状态 SQLite：$HERMES_HOME/state.db（20 张表）+ FTS5 索引 ───────┐
│ 记忆：$HERMES_HOME/memories/MEMORY.md + USER.md（纯文本）        │
│ 技能：$HERMES_HOME/skills/<name>/SKILL.md（frontmatter+markdown）│
└─────────────────────────────────────────────────────────────────┘
```

---

## 一、agent 执行循环

**一次 turn 的完整链路**（每一步都可指到行号）：

1. **入口 facade**：`run_agent.py` 的 `AIAgent` 由 mixin 拼装（`agent/AGENTS.md:7-19`）。`AIAgent.run_conversation` 先取会话 turn lease，再转发到 `agent/conversation_loop.py:1809` 的 `run_conversation`。
2. **turn 包装**：`run_conversation` 设 `_turn_user_intervened=False`、开启 `native_turn_images` 上下文，然后在 `finally` 里 `end_voice_turn_route`，最后依次 `fence_result_reply` → `settle_held_final` → `export_current_turn_boundary` → `_close_durable_failed_turn`（`conversation_loop.py:1838-1869`）。
3. **主体** `_run_conversation_turn`（`conversation_loop.py:1647`）：先 `_decode_inline_moa_turn`，重置 turn 级压缩状态（`1681`），`begin_fast_mode_turn`，`_try_refresh_env_client_credentials`（把用户在 Settings 里改的 `.env` 采纳进来，`1687-1690`），再调 `build_turn_context`（`1700`）完成：user 行持久化、prompt 恢复/重建、turn 起始压缩（idle 压缩 → 阈值 preflight 压缩 → overflow 预警重臂，见 `agent/turn_context_compaction.py:1-8`）。
4. **循环本体**：`conversation_loop.py:1752-1799`

```
while _prelude_action != "break" and (
    (s.api_call_count < agent.max_iterations and agent.iteration_budget.remaining > 0)
    or agent._budget_grace_call):
    begin_iteration → prepare_iteration → assemble_api_request
    run_preflight_gate           # 压缩/超限前置门
    _run_api_retry_loop          # 见 (5)
    apply_retry_restarts
    normalize_model_response
    run_tool_round  if 有 tool_calls   else  finish_text_response
```

**停止 = 模型不再返回 `tool_calls`**（`1789`），由 `finish_text_response` 收尾；`_budget_grace_call` 给预算耗尽的最后一次宽限调用。

5. **重试/降级内层**：`_run_api_retry_loop`（`1578-1608`）每轮做 `nous_rate_limit_guard → build_api_request → perform_api_call → check_api_response`，异常走 `handle_api_error`（`agent/turn_api_error.py`，24 KB）。
6. **状态传递机制（设计亮点）**：所有跨阶段局部变量压进 `_LoopState`（`1462-1541`，约 60 个字段），`_run_phase`（`1557-1575`）用 `inspect.signature` 反射把同名参数喂给阶段函数、再把 verdict 同名字段写回。加一个阶段输入只需加一个 dataclass 字段——这是 33 个 `turn_*.py` 能拆开而不失内聚的关键。
7. **工具轮**：`agent/turn_tool_round.py:49::run_tool_round`。执行器 `agent/tool_executor.py` 里 `_resolve_sequential_dispatch`（`1690`）先拦 agent 级 inline 工具（`INLINE_TOOL_EXECUTORS` 表），再判断走 `execute_tool_calls_concurrent`（`1594`，线程池 + `_StartOrderGate` 保序 + 超时）还是串行；结果经 `_commit_tool_result`（`1080`）落库。
8. **停止门（关键）**：即使模型给出文本，`agent/turn_stop_gates.py:1-11` 还有**四道门**可以把它变成 interim 行 + 用户角色 nudge 并 continue：late LSP verdict、verify-on-stop、`pre_verify` 插件钩子、kanban worker 终局守卫。
9. **turn 收尾**：`agent/turn_finalizer.py`（50 KB）—— 外接记忆 sync、再触发后台 memory/skill review（`610-633`）。

**没有显式「计划」阶段**。规划完全落在模型侧：`todo_list` 工具（`tools/todo_tool.py:1-4`，状态挂在 AIAgent 上、压缩后重注入、单调 revision 供 UI 拒绝陈旧更新）+ prompt 里的 `TASK_COMPLETION_GUIDANCE`（`agent/prompt_builder.py:383-393`）。

---

## 二、工具系统

**定义/注册**：`tools/registry.py:845-924` 的 `register(name, toolset, schema, handler, check_fn, requires_env, is_async, description, emoji, max_result_size_chars, dynamic_schema_overrides, override, scope, execution_timeout, compat_args, self_checked_args)`。注册期就校验 schema 形状（`858-865`），跨 toolset 遮蔽默认被拒（`903-910`），插件要覆写内置必须显式 `override=True` + 运营开关（`886-897`）。

**自动发现**：`discover_builtin_tools()`（`registry.py:121`，用 AST 检测 `_module_registers_tools`，`84-110`）扫描 `tools/*.py` 与 `tools/<pkg>/tool.py`，**没有任何手工 import 清单**（`tools/AGENTS.md:9-16`）。

**实测数量**：
- `tools/` 下 **390 个 .py**，其中 **45 个文件共 55 次 `registry.register(`**
- `toolsets.py:11-36` 的 `_HERMES_CORE_TOOLS` = **41 个**；`toolsets.py:70` 起 `TOOLSETS` 字典 = **57 个 key**（含 25 个 `hermes-*` 平台 bundle），去重后 **67 个唯一工具**（实测 `import toolsets` 结果）
- MCP 工具动态注册：`tools/mcp_tool_registration.py:384`，toolset 名为 `mcp-<server>`（`163`）

**schema 格式**：标准 OpenAI function-calling JSON，`{"name", "description", "parameters": {...JSON Schema...}}`，由 `_ts()` 辅助构造 toolset。**所有 handler 必须返回 JSON 字符串**；唯一例外是多模态信封 `{"_multimodal": True, "content": [...], "text_summary": str}`（`tools/AGENTS.md:17-21`，`registry.py:1067` 的 `_normalize_handler_result`）。

**可用性门控**：`check_fn` 回答「可达/已 opt-in」，结果按 `hermes_home_key()` TTL 缓存（`registry.py:477` `_check_fn_cached`），进程级共享——一个进程服务多 session 多 profile，所以 probe 必须走 `agent.secret_scope.get_secret` 而非裸 `os.getenv`（`tools/AGENTS.md:55-62`）。

**窄腰的交通管制**：`tool_search` 延迟加载（`tools/tool_search.py` + `model_tools.py:548-560`）——当可延迟的 MCP/插件工具超过上下文窗口的配置份额时，折叠到 `tool_search / tool_describe / tool_call` 桥后，**core 工具永不延迟**。这是「核心窄腰」在 token 层的强制实现。

**沙箱执行**：`tools/environments/` 六后端 `local, docker, modal, daytona, vercel_sandbox, ssh`（`tools/terminal_tool_backends.py:52`）。统一环境构造：`environments/local.py::build_subprocess_env`，替 profile 干活的子进程走 `served_profile_child_env(target_home=, inherit_credentials=)`，丢弃 launch profile 的 `.env` 残留（`tools/AGENTS.md:119-133`）。docker 后端 72 KB 单独处理 egress/ownership。

---

## 三、记忆系统

**存储：两层 + 纯文本 + 硬上限。**

- **内置层（core）**：`$HERMES_HOME/memories/MEMORY.md`（agent 笔记）+ `USER.md`（用户画像）。`tools/memory_tool.py:38-40` `get_memory_dir()`；**字符硬上限 2200 / 1375**（`memory_tool_store.py:188`，`memory_tool.py:56`）。整个 `memory` 工具只有 `add / patch / remove` 三种 op，可批量原子提交（`memory_tool.py:373-438`），char limit **只在最终结果上校验**，所以一次 batch 可以「删旧腾位 + 加新」。
- **外部层（plugin）**：`agent/memory_provider.py:1-6` 的 `MemoryProvider` ABC，`plugins/memory/<name>/`，`memory.provider` **同时只允许一个外部 provider**（`memory_manager.py:1-5`）。生命周期 `initialize → system_prompt_block / prefetch / sync_turn → tool dispatch → shutdown`，另有 `on_pre_compress` 检查点（v2 fail-closed，`memory_provider.py:35-37`）。
- **会话层（DB）**：`$HERMES_HOME/state.db`（`hermes_state.py:181`），**18 张表**：`sessions, messages, session_model_usage, system_prompts, compression_locks, conversation_generations, session_turn_leases, session_admissions, gateway_routing, gateway_heartbeats, gateway_hygiene_state, resumable_subagents, async_delegations, worker_executions, worker_receipts, runtime_epoch, state_meta, schema_version` + FTS5 虚拟表（`messages_fts` / `messages_fts_trigram`）。检索走 FTS5（`hermes_state_fts.py:46-59`），由 `session_search` 工具（`tools/session_search_tool.py:798`）暴露。

**注入 prompt 的方式：三档拼接 + 冻结快照。**

`agent/system_prompt.py:1-9` 明确写死三档：`stable`（身份/guidance/env hints/coding brief/平台提示）→ `context`（workspace 快照 + 调用方 system_message + context files）→ `volatile`（**skills 索引、memory、USER.md、外部 provider、时间戳行**），用 `\n\n` 连接。**只构建一次，之后复用**；唯一的上下文突变是压缩。

关键取舍：`memory_tool.py:2-5` 明说两个 MD 文件「as a FROZEN snapshot at session start；mid-session writes hit disk but never change the prompt」。**会话内写的记忆本次会话看不到**——这是为 prompt cache 付的代价。

**分层/压缩/遗忘：**

- **压缩是唯一被授权的 cache 破坏**（`agent/AGENTS.md:76-91`）。两层：gateway session hygiene 85% + `ContextCompressor` 50%（可按模型覆写，小窗口 floor 到 75%，`context_compressor.py:1148-1151`）。算法顺序：**先剪旧 tool result（无 LLM 调用）→ 选边界 → 用 `auxiliary` 压缩模型生成结构化摘要**；`_SUMMARY_RATIO = 0.20`（`826`）。摘要流卡住会重试一次 fallback_chain，再卡则走确定性降级摘要。
- **遗忘：`MEMORY.md` 没有自动遗忘**——只有 char limit 逼模型自己删。真正的「遗忘」发生在 **skill 侧**：`agent/curator.py:31-32` 的 `stale_after_days=14 / archive_after_days=30`，且**只归档不删除**（`curator.py:1-7` 不变量：「never delete, only archive」）。
- **记忆→prompt 的二次注入**：`agent/memory_context.py:1-6` 用 `<memory-context>` 围栏包装召回内容 + 「NOT new user input」系统注释，并有 `StreamingContextScrubber`（`44-54`）在流式 delta 里跨块剥离围栏，防止召回内容泄漏成模型输出。
- **可视化**：`agent/learning_graph.py:1-6` 把 `MEMORY.md`/`USER.md` 的每条 entry 与 skill 一起做成图谱节点（memory→skill 边由词面重叠推导），供桌面端「Learning」页。

---

## 四、自进化机制

**有，而且分四条独立轨道，但全部止步于「skill / memory」，不碰核心代码和系统 prompt。**

1. **turn 后后台评审（主引擎）**：`agent/background_review.py:1-6` —— 每个 turn 结束后可能起一个 daemon 线程，把对话快照喂给 **fork 出来的 AIAgent**，问「有没有该存/该改的 skill 或 memory」。**写直接落 memory + skill store，主对话与 prompt cache 永不受影响**；fork 继承父的 provider/model/凭证/已缓存 system prompt，所以命中同一前缀缓存。触发点：`agent/turn_finalizer.py:610-633`（`skip_background_review` 可关，cron 关掉，因为每次 fork 约 30K tokens）；线程创建在 `run_agent.py:795-833`。评审 prompt 在 `background_review.py:370-396`：`_MEMORY_ROUTING_BLOCK` 强制「一个事实只进一个 store」（否则两边都被写爆，注释引 #30220），并要求「save only facts GROUNDED in this conversation」。另一个 `_LESSON_LAYER_BLOCK`（`401-420`）专治「囤积式技能库」：禁 PR 号/日期/引用原文、同一教训只留一条、不重复 AGENTS.md 已教的东西。
2. **Curator（技能生命周期）**：`agent/curator.py:1-7`。**无 cron daemon，靠空闲触发**——agent 空闲且距上次运行超过 `interval_hours`（默认 7 天）时，`maybe_run_curator()` 按活动时间戳迁移生命周期状态，可选 fork 一个 AIAgent 做 pin/archive/consolidate/patch。状态存 `$HERMES_HOME/skills/.curator_state`（`40-41`）。不变量（`skills/AGENTS.md:72-78`）：**只碰 `created_by: "agent"` 的技能**（内置与 hub 安装的免疫）、**只归档不删除**、pinned 技能绕过所有自动迁移、`skill_manage(action="delete")` 拒绝 pinned。`DEFAULT_CONSOLIDATE = False`（`curator.py:35`）——**LLM 合并默认关闭**，只有确定性 inactivity prune 恒开。
3. **技能写入工具**：`tools/skill_manager_tool.py:875-931` 的 `skill_manage`。一个 `operations` 数组，动作 `create / patch / write_file / remove_file / delete`。schema 注释里写得很直白：不用「一个扁平 object 装 content/new_string/file_content」，因为 27B 模型会串槽（引 #112677），所以改成 per-action `anyOf` 分叉。
4. **Dashboard 学习图谱**：`agent/learning_graph.py` + `learning_graph_render.py` + `learning_mutations.py`，把「学到什么」做成桌面端可点开的图。

**没找到证据的地方**：没有让 agent 修改自身系统 prompt、修改 `agent/*.py`、或自动改写工具定义的机制；`agent/AGENTS.md:57-63` 明确禁止在会话中重建 system prompt。**自进化的边界被刻意画在「可卸载的 skill 文件」内**。

---

## 五、多智能体

**有子代理，但没有真正的「多智能体团队」。**

**能力**：`tools/delegate_tool.py:1-12` 的 `delegate_task`（`delegation` toolset，`toolsets.py:152`）。语义：起子 `AIAgent`，**全新对话**、自己的 `task_id`、父的 toolsets 减去禁用项、聚焦的 system prompt（goal+context 就是首条 user turn）。**父只看得到 delegation 调用和最终 summary，永远看不到子代理的中间 tool call 与推理**（`delegate_tool.py:9-11`）。

**关键参数（实测默认值，`tools/delegate_tool_config.py`）**：
- `_DEFAULT_MAX_CONCURRENT_CHILDREN = 10`（`19`）
- `MAX_DEPTH = 1`（`23`）——**默认扁平：父(0) → 子(1)**，更深必须配 `max_spawn_depth`（`204-210`）
- `DEFAULT_CHILD_TIMEOUT = None`（`29`）——不再给子代理硬墙钟上限，靠 heartbeat 陈旧检测（`delegate_tool.py:106-117`）
- 角色 `leaf | orchestrator`（`delegate_tool.py:61`），orchestrator 需 `delegation.orchestrator` 开启
- 并行：单任务 + 批量两种模式；顶层模型调用在后台跑，orchestrator 子等自己的 worker

**禁用清单（很能说明设计哲学）**：`tools/delegate_tool_toolsets.py:14-22`

```python
DELEGATE_BLOCKED_TOOLS = {"delegate_task",  # 禁止递归
                          "clarify",        # 不许问用户
                          "memory",         # 不许写共享 MEMORY.md
                          "send_message",   # 不许跨平台副作用
                          "cronjob_manage"} # 不许替父排更多活
DEFAULT_TOOLSETS = ["terminal", "file", "web"]
```

**对应的 `dsh-agent-team` 是什么**：hermes 这边**没有等价物**。最接近的三样东西都不构成团队协作：
- `delegate_task` 批量模式 = **父→子的单向扇出 + 摘要回收**，子树之间无通信、无共享黑板
- `cron/` + kanban（`tools/kanban_tools.py`，14 个 kanban 工具在 core 里）= **任务队列/看板**，是持久化工作项，不是 agent 间协商协议
- `tui_gateway` 的多 profile 复用 = **一个进程服务多个用户配置**，不是多个 agent 协作

**未找到证据**：跨代理共享内存/黑板、代理间消息传递、投票/仲裁、动态角色分配。

---

## 六、验证与自检

**有四件套，但缺一环——没有一个会让 agent 必须自证才允许结束的强制闭环。**

1. **验证账本（被动）**：`agent/verification_evidence.py:1-3` 自称「**Deliberately passive — it never runs a suite, never blocks completion, and never upgrades targeted checks into "repo green"**」。它把 agent 实际跑过的验证命令记进 sqlite（`_db_path`，`123`），带 30 天过期（`_MAX_EVIDENCE_AGE_DAYS`，`23`）、每 session root 100 条上限（`24`）。做的是 shell 段解析，识别 `python/pytest/node/...` 等解释器家族、`test_*/spec/__tests__` 目标（`34-45`），并检测「exit status 被管道遮住」这类假证据。
2. **verify-on-stop 提醒（opt-in）**：`agent/verification_stop.py:1-3` 自称「**Policy-only: it never runs checks itself**」。当模型刚改完代码就想收工而账本里没有新鲜证据时，注入一段有界 nudge。**默认 OFF**：`verify_on_stop_enabled()`（`62-88`）——先看 `HERMES_VERIFY_ON_STOP`，再看 `agent.verify_on_stop` 配置，`auto` 只对交互式编码表面开，**缺省值落到 OFF**（`86-88`）。对纯文档改动会抑制（`_NON_CODE_VERIFY_EXTENSIONS`, `30-32`）。
3. **验证 runner（项目级）**：`agent/verify/runner.py:1-7`，来自 grok-cli 的移植：`bootstrap → build → test → 后台 start → readiness 轮询 → 拆解`，recipe 由 `agent/verify/recipes.py` 静态探测（框架/端口/就绪路径）。CLI 侧入口 `hermes verify`。
4. **evals/（给开发者，不是给 agent）**：44 个子目录 / 168 个 .py。命名如 `provider_wire, token_accounting, prefix_rediet, prompt_footprint, toolperf_abeval, schema_dedupe, compaction, native_compaction, liveness, subagent_process_handoff`。`evals/output_caps_scope.md:1-16` 说明这是**人手动跑的 live-model A/B 与探针**：用 fixture HTTP server 只回 `LOCAL_CAPTURE_ONLY`，比对「抓到的请求体」而不是响应。**与 agent 运行时完全解耦**。

**prompt 侧的自检说教**：`agent/prompt_builder.py:383-393` `TASK_COMPLETION_GUIDANCE`（「deliverable is a working artifact backed by real tool output」）+ `344-361` `TOOL_USE_ENFORCEMENT_GUIDANCE` + `433-` `OPENAI_MODEL_EXECUTION_GUIDANCE`（`<tool_persistence>` 等标签块）。**这是 prompt 说教，不是机制**。

**结论**：验证能力很完整，但**默认不强制**。这是它最明显的结构性漏洞（见第十节）。

---

## 七、界面架构

**四个表面共享一个后端**：CLI（`hermes_cli/`）、Ink TUI（`ui-tui/`）、Electron 桌面（`apps/desktop/`）、Web dashboard（`web/`），其中 TUI / 桌面 / dashboard 都通过 `tui_gateway/` 的 **换行分隔 JSON-RPC over WebSocket `/api/ws`** 说话（`tui_gateway/AGENTS.md:1-40`）。桌面端不嵌 TUI、不复刻 dashboard，三者分工明确。

### 7.1 `apps/desktop/src` 目录职责（3,728 个 ts/tsx）

| 目录 | 文件 | 职责 |
|---|---|---|
| `app/chat` | 437（225 .tsx） | 聊天主表面：transcript、composer、slash 补全 |
| `app/session` | 243 | 会话生命周期、`use-prompt-actions/slash.ts` 派发 |
| `app/settings` | 196 | 设置页（含 `memory/memory-layers.tsx`） |
| `app/capabilities` | 129 | 能力/插件/技能浏览 |
| `app/right-sidebar` | 73 | 右栏（preview / files / review） |
| `app/contrib` | 55 | **contribution 装配层**：`registry.ts` `panes.tsx` `surfaces.tsx` `wiring*.ts` |
| `app/shell` | 49 | 外壳（titlebar / statusbar / groups） |
| `app/gateway` `app/cron` `app/starmap` `app/hud` `app/command-center` `app/profiles` `app/overlays` … | 22/20/21/19/5/7/7 | 路由目标（`OverlayView` 卡片） |
| `components/assistant-ui` | 231（159 .tsx） | `@assistant-ui/react` 适配层 |
| `components/pane-shell` | 88（**`tree/` 77**） | **树状分隔布局引擎** |
| `components/ui` | 116 | shadcn 风格基础控件 |
| `components/chat` | 58 | 聊天内部构件 |
| `store` | 439（**205 处 `nanostores`**） | 状态：`session-states.ts` 125 KB、`gateway.ts` 92 KB、`session.ts` 84 KB、`layout.ts` 43 KB |
| `themes` | 31 | 主题/skin 转换 |
| `contrib` | 31 | **插件贡献点注册表**：`registry.ts` `runtime-loader.ts`(41 KB) `plugin.ts`(17 KB) `settings-pages.ts` |
| `plugins` | 301 | 内置插件（`hermes-bots` 等） |
| `i18n` | 312 | 10 语言包（含 `*_memory_layers.ts`） |
| `lib` `api` `sdk` `hooks` | 503/53/23/17 | 纯辅助 / gateway REST / 插件 SDK / hooks |

### 7.2 布局系统：contribution + tree split

- **Contribution 注册表**：`apps/desktop/src/app/contrib/registry.ts:14-60`。一个 `ContributionRegistry` 类，按**命名空间 area id**（`statusBar.right`、`rightColumn.panel`、`capabilities.detail.actions`、`panes`…）索引，「the same primitive resolves at any depth of the recursive Area scene graph」。桶快照按 area 缓存、mutation 驱动失效，**area 作用域失效**（注册一个 statusbar item 不会重渲染 titlebar）。`register()` 返回 disposer；`registerMany` 整批只通知一次。插件走**同一套 API**（`contrib/plugins-store.ts`、`runtime-loader.ts`）。
- **Tree split**：`apps/desktop/src/components/pane-shell/tree/`
  - `store.ts` 84 KB（布局状态权威）、`model.ts` 22 KB、`grid-model.ts` 17 KB、`zones-engine.ts` 12 KB、`grid-to-tree.ts` 6.5 KB
  - `renderer/tree-split.tsx` 35 KB、`renderer/tree-group.tsx` 52 KB、`drag-session.ts` 23 KB、`zone-editor.tsx` 19 KB、`renderer/keep-alive-panes.tsx`、`floating-panes.tsx`、`narrow-overlays.tsx`、`layout-picker.tsx`、`compact-tab-picker.tsx`
  - 语义：面板是树节点，拖拽换位、sash 调宽、窄屏降级为 overlay、keep-alive 保活、隐藏而非销毁（`hide-only-strip-tabs.ts`、`side-collapse-persistence.ts`）
- **信息架构契约**（`apps/desktop/DESIGN.md:46-79`）：Chat 是主表面；页面是持久目的地；路由 overlay 是短任务卡片（关掉回上一路由）；面板是**附着于当前任务的工作上下文**，状态要跨临时隐藏/切会话存活；「One action, one home」；Projects 拥有 workspace cwd。

### 7.3 主题系统

三端统一在 **skin** 这一抽象上：CLI/TUI 的 skin 是 `$HERMES_HOME/skins/*.yaml`，由 `hermes_cli/skin_engine.py` 解析，经 JSON-RPC（`gateway.ready` / `skin.changed` / `config.get skin`）推到所有表面。桌面端在 `themes/skin.ts:1-16` 把 CLI 形状的调色板转成 `DesktopTheme`，「a skin Hermes authors from a prompt lights up all three surfaces from one file」。

内置色板在 `apps/shared/src/theme-presets.ts:66` 起：`github, nous, catppuccin, everforest, solarized, midnight, ember, mono, cyberpunk` 等，其中 `nous/catppuccin/everforest/solarized` 是从 VS Code 扩展**程序化转换**而来（`themes/presets.ts:1-19`，走 `buildThemeFromMarketplace`，与手工装扩展同路径）。另有 `themes/install.ts`（Marketplace 导入）、`vscode.ts`(12 KB)、`retint.ts`、`accent-override.ts`、`user-themes.ts`、`backend-sync.ts`。

### 7.4 状态管理

- **nanostores atom 为唯一原语**，实测 `store/` 下 **205 处 nanostores 引用**；`@tanstack/react-query` 管请求态（`app/contrib/panes.tsx:12`）
- **按权威分派状态**（`apps/desktop/AGENTS.md:28-47`）：后端权威 → 渲染层当 cache；Electron 权威 → 机器/运行时事实；渲染层只拥有「本窗口的呈现」。持久化状态**必须在自己 key 里声明 scope**（global / connection / profile / session / project / window）
- 热路径协调放 ref 不放 state；新全局 store 要「earn that claim」
- `apps\desktop\electron\main.ts` **691 KB** + `connection-registry.ts`(65 KB) `remote-lifecycle.ts`(68 KB) `profile-session-routing.ts`(61 KB) `ssh-connection.ts`(47 KB) `preload.ts`(43 KB) —— Electron 侧负责进程生命周期、SSH/远程、更新、以及一条**窄且类型化的 capability bridge**（渲染层永不直接摸 Node）

---

## 八、扩展点

**四条正式通道，加一条已关闭的通道。**

1. **插件（Python）**：`hermes_cli/plugins_loader.py`(47 KB) `plugins_manifest.py` `plugins_context.py`(54 KB) `plugins_dispatch.py`(39 KB)。插件用 `ctx`（`PluginContext`）注册工具/命令/平台/记忆 provider/模型 provider。**公开 API 有白名单文件**：`hermes_cli/data/plugin_api.json`（176 行）——列出插件被允许 import 的 50 个 core 模块，`hermes plugins validate` 对越界 import 告警（`plugin_validate_private_imports.py`）。**硬规矩**：`plugins/AGENTS.md:7-15`「Plugins never touch core」——插件不得改 `run_agent.py` / `cli.py` / `gateway/run.py`；缺能力就拓宽通用插件面（加 hook / 加 ctx 方法），不许把插件逻辑硬编进核心。
2. **技能（Markdown）**：`skills/`（13 分类 44 个，默认加载）+ `optional-skills/`（22 分类 141 个，`hermes skills install official/<cat>/<skill>` 装，适配器 `tools/skills_hub_official.py::OptionalSkillSource`）。frontmatter 契约在 `skills/AGENTS.md:16-21`（`name/description/version/author/license/platforms/metadata.hermes.{tags,category,related_skills,config}`），作者标准是 HARDLINE（`23-55`）：description ≥60 字符一句话、正文必须用反引号点名原生工具而不是 shell 工具、`platforms` 要按真实 import 审计。技能分发中心有 5 个来源后端（`skills_hub_github/official/skillssh/clawhub/...`）。
3. **MCP**：`tools/mcp_tool_*.py`（discovery 50 KB / handlers 51 KB / registration / schema / oauth 68 KB）。每个 profile 独立 trust 记录（`_record_scope_trust` 按 home 键），secondary profile 不继承 launch profile 的 trust（`tools/AGENTS.md:130-133`）。
4. **离树插件目录**：`plugin-catalog/` —— **2,311 个 yaml**，每个条目强制 40-hex SHA pin，人工 PR 合并，`plugin-catalog/removed.yaml` 是 kill list（`plugins/AGENTS.md:64-70`）。这是**唯一的**离树发现系统。
5. **已关闭**：`plugins/memory/` 自 2026-05 起不再收新的树内 memory provider（`plugins/AGENTS.md:19-29`）；2026-06 起不收第三方产品型插件（`53-59`）。方向是「全部推到独立 repo + catalog」。

**插件可用的 hook 面（实测从 `agent/*.py` 抓出的字符串常量）**：`pre_tool_call, post_tool_call, post_tool, pre_llm_call, post_llm_call, pre_api_request, post_api_request, pre_auxiliary_call, post_auxiliary_call, pre_verify, pre_compress_checkpoint_api_version, pre_transform_response, post_chunk, post_compaction, pre_progress, post_event, on_turn_start, on_turn_complete, on_session_start, on_session_end, on_session_switch, on_compaction, on_memory_write, on_delegation, on_stream_start/delta/end, on_text_delta, on_first_delta, on_reasoning_delta, on_interim_message, on_commentary_message, on_pre_compress, post_curator_run, post_setup`。另有 **60+ 个 `plugins_*.py`** 文件做加载/校验/隔离/事务/更新/准入。

**插件还能扩什么**：模型 provider（`plugins/model-providers/` 43 个，`providers/` 里是 `ProviderProfile` 注册表与 ABC）、平台适配器（`plugins/platforms/` 26 个）、记忆 provider、context engine、image/video gen provider、TTS / transcription provider、terminal backend、web search provider、dashboard auth、cron provider、桌面端 plugin half（`hermes_cli/desktop_plugin_halves.py`、`apps/desktop/src/contrib/runtime-loader.ts`）。

---

## 九、它最强的地方

1. **把「prompt cache 不可破坏」当成架构第一性原理，并真的贯穿到底。**
   证据链完整：`AGENTS.md:18-21` 立规矩 → `agent/system_prompt.py:1-9` 三档拼接、只构建一次 → `memory_tool.py:2-5` 记忆冻结快照（宁可本次会话读不到自己的写入）→ `agent/AGENTS.md:57-63` 中途注入只能走 user 消息或 tool result，subdirectory AGENTS.md 提示是**追加到 tool result** 而非 system prompt → 连后台评审都要 fork 一个复用同一前缀缓存的 agent（`background_review.py:1-6`）→ `tests/ci/test_prompt_surface.py` 把 stock prompt 与 `tools[]` 做成快照门禁（`AGENTS.md:26-28`）。**这是一条有 CI 执法、有文档、有降级路径的完整纪律，不是口号。**

2. **窄腰 + 边缘扩展的克制，做到了罕见的彻底度。**
   core 工具只有 41 个（`toolsets.py:11-36`），配 57 个 toolset 按平台/姿态组合；`tool_search` 在 token 层强制窄腰（`model_tools.py:548-560`）；贡献门槛写成「Footprint ladder」五级（`AGENTS.md:58-61`：扩展既有代码 → CLI+skill → 服务门控工具 → 插件 → catalog MCP → 新 core 工具），并明确「hooks with no concrete consumer」「a new core tool when terminal+file already does the job」属于**即使做好也会被拒**（`AGENTS.md:43-48`）。插件不得碰核心且有白名单校验（`plugin_api.json` + `plugin_validate_private_imports.py`）。

3. **上下文工程深度远超一般 agent：压缩是一条完整流水线，不是一次 summarize。**
   `context_compressor.py` 328 KB。分两层阈值（gateway 85% / agent 50%，小窗口 floor 75%）、**先无 LLM 剪 tool result 再选边界**、`auxiliary` 模型出结构化摘要（`_SUMMARY_RATIO=0.20`）、摘要流卡住走 fallback_chain、再卡走确定性降级、失败有 cooldown、provider 实证 overflow 会覆盖粗糙估算（`conversation_loop.py:1507-1509`）、原地 compaction 保持同一 session id、todo 列表压缩后重注入（`todo_tool.py:19-21`）、母语提示词明确告诉模型「你的 MEMORY.md 在 system prompt 里始终权威」（`context_compressor.py:291, 662`）。**这套东西的工程量是我们必须正面回答的基准线。**

4. **同一 turn 循环横向铺满 6 类表面 + 26 个平台，且不靠复制代码。**
   `agent/conversation_loop.py:1809` 一个 `run_conversation` 被 CLI/TUI/Desktop/Dashboard/ACP/gateway 全部复用；平台侧只是 `plugins/platforms/` 下 26 个适配器目录；一个 gateway 进程多 profile 多路复用（`AGENTS.md:120-124` 的 profile scope 规则 + `tui_gateway` 的会话权威）。**「一个 core，多表面」在它这里是真的共享，不是各写一套。**

5. **桌面端的 UI 工程化程度罕见：贡献点注册表 + 树状分隔布局 + 三端统一 skin。**
   `app/contrib/registry.ts:14-60` 的 area 作用域失效 + disposer + 批量通知，是一个**正经的插件化 UI 内核**，而且插件与内置 UI 走同一条 API；`pane-shell/tree/` 77 个文件把布局做成树模型（drag/zone/sash/keep-alive/narrow-overlay 全有测试）；主题从 `skin.ts` 一处转换，CLI/TUI/Desktop 三端点亮（`apps/desktop/src/AGENTS.md` 与 `DESIGN.md:80-120` 的 token 纪律：「Don't add per-overlay shadow one-offs; if elevation needs to change, change the token」）。

---

## 十、它的短板 / 漏洞（我们的机会）

1. **「做完了」没有强制闭环——验证能力齐备，但默认全关，且验证本身太贵。**
   三处自述是硬证据：`verification_evidence.py:1-3` 自称 passive、**never runs a suite, never blocks completion**；`verification_stop.py:1-3` 自称 policy-only、**never runs checks itself**，且 `verify_on_stop_enabled()` 默认落到 OFF（`62-88`）；`turn_finalizer.py:620-627` 注释直说 background review「costs ~30K tokens/event with no human-in-the-loop benefit」所以 cron 直接关掉（`skip_background_review`）。**机会**：① 把「改完代码 → 自动跑项目 recipe → 证据落 ledger → 没有绿色证据就拒绝收工」做成默认开启的硬门，而不是 opt-in 提醒——它的 `agent/verify/runner.py`（bootstrap→build→test→start→readiness）已经写好了，只差接进 stop gate 并默认启用；② 把验证与记忆写入做成低成本确定性流程（结构化 diff 检查、复用已有测试输出、增量摘要），而不是每次 fork 一个完整 agent 重放整段对话。

2. **记忆容量被 prompt cache 逼到极小，且会话内新写的记忆本次会话看不到。**
   `MEMORY.md` 2200 字符 / `USER.md` 1375 字符（`memory_tool_store.py:188`），`memory_tool.py:2-5` 明说「mid-session writes hit disk but never change the prompt」。写入完全依赖 turn 后 fork 的 review（`turn_finalizer.py:610-633`，且每次 ~30K tokens），cron 直接关掉（`skip_background_review`）。**机会**：用「可增量更新且 cache 友好的记忆结构」（例如分页/索引 + 检索注入而非全量冻结）替代「冻结快照 + 极小配额」，并让记忆写入同步化、可回溯，而不是事后异步赌一次 LLM 评审。

3. **子代理是单向扇出 + 摘要回收，没有团队协作协议；默认 depth=1 且子代理被阉割。**
   `delegate_tool.py:9-11`「父只看得到 summary，永远看不到中间过程」；`delegate_tool_config.py:23` `MAX_DEPTH=1`；`delegate_tool_toolsets.py:14-22` 子代理禁用 `memory / clarify / send_message / delegate_task / cronjob_manage`——**不能问人、不能记忆、不能横向通信、不能嵌套**。`kanban` 是任务看板不是协商协议。**机会**：这正是 `dsh-agent-team` 的正面战场——共享黑板、代理间消息、动态角色、可审计的分工，以及「父能看到子代理的证据链而不只是摘要」。

4. **自进化只覆盖「技能文件」，碰不到核心行为；而且 LLM 合并默认关闭。**
   所有自进化都止于 `skill_manage` / `memory`：`curator.py:1-7` 不变量是「只碰 `created_by: agent` 的技能、只归档不删」；`curator.py:35` `DEFAULT_CONSOLIDATE = False`；`agent/AGENTS.md:57-63` 禁止会话中重建 system prompt。**机会**：把自进化的作用域往上抬一层——可版本化、可回滚、可 A/B 的「行为策略」层（prompt 片段 / 工具编排策略 / 检索策略），而不是只能在 skill 的沙箱里打转。注意它的谨慎有理由（cache 与稳定性），我们的方案必须自带 cache 影响评估与回滚证据。

5. **复杂度已经反噬：`agent/` 13.8 万行 / 364 文件 / 33 个 `turn_*`，`main.ts` 691 KB。**
   为了守 facade+siblings 规约，单是 `hermes_state_*` 就有 60 个兄弟文件、`agent/turn_*` 33 个；`turn_recovery.py` 108 KB、`turn_finalizer.py` 50 KB、`context_compressor.py` 328 KB；`apps/desktop/electron/main.ts` 691 KB 单文件。`AGENTS.md:104-107` 自己承认文件上限 2000 行、CC ≤20、嵌套 ≤6 是**棘轮制**（已经在超标只能降）。**机会**：用更小的状态机 + 显式协议（事件/中间件表）替代「33 个阶段兄弟文件 + 60 字段 `_LoopState` + `inspect.signature` 反射回填」（`conversation_loop.py:1462-1575`），把可维护性做成第一天的约束而不是事后棘轮。

---

### 附：给对比矩阵的核心参数速查

| 维度 | hermes 实测值 | 证据 |
|---|---|---|
| core 工具数 | 41 | `toolsets.py:11-36` |
| 全部工具 / toolset | 67 / 57 | `import toolsets` 实测 |
| `registry.register` 调用 | 55 次 / 45 文件 | `tools/*.py` grep |
| 单 turn 最大 API 轮次 | 500（默认，子代理共享） | `agent/AGENTS.md:15` |
| 压缩阈值 | gateway 85% / agent 50%（小窗 75%） | `agent/AGENTS.md:82-84`, `context_compressor.py:1148-1151` |
| 摘要比 | 0.20 | `context_compressor.py:826` |
| MEMORY.md / USER.md 上限 | 2200 / 1375 字符 | `memory_tool_store.py:188` |
| 子代理并发 / 深度 | 10 / 1 | `delegate_tool_config.py:19,23` |
| 子代理禁用工具 | 5 个 | `delegate_tool_toolsets.py:14-22` |
| 技能 内置 / 可选 | 44 / 141 | `SKILL.md` 计数 |
| 平台插件 | 26 | `plugins/platforms/` |
| 模型 provider 插件 | 43 | `plugins/model-providers/` |
| 插件公开 API 模块 | 50 个条目 | `hermes_cli/data/plugin_api.json` |
| 离树插件目录 | 2,311 yaml | `plugin-catalog/` |
| state.db 表 | 18（+ `messages_fts` / `messages_fts_trigram`） | `hermes_state_common.py:458` 起 DDL |
| curator 节奏 | 7 天间隔 / 14 天 stale / 30 天 archive | `curator.py:31-32` |
| 执行后端 | 6（local/docker/modal/daytona/vercel/ssh） | `terminal_tool_backends.py:52` |
| 桌面端 ts/tsx | 3,728（electron 另 733） | 实测 |
| 桌面端主题色板 | 9+（github/nous/catppuccin/everforest/solarized/midnight/ember/mono/cyberpunk） | `apps/shared/src/theme-presets.ts:66+` |
