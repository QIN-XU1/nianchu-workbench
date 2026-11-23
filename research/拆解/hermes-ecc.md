# hermes-agent 与 ECC 拆解

> 所有数字均为实测（`rg` + PowerShell 枚举 + **Python 真实 import 验证**），非抄 README。
> 唯一「实测」手段：`C:\hermes\.venv\Scripts\python.exe` 加载 `tools.registry` 并枚举 —— 这是下面 68 这个数字的来源。
> 读不到的会明确标注「推测」。
> 拆解时间：2026-11-15 ｜ 按 `research/拆解/标准.md`

---

# hermes-agent

## 一句话定位

**一个 Python 单核 agent，把「工具」当微内核系统调用、把「能力」全部外推到插件/技能/MCP 边缘**，用一套 `BaseEnvironment` ABC 把 6 种执行后端抹平成「都一样能跑 bash」，用 8 层审批闸把「模型想干什么」和「真的执行什么」彻底解耦。

## 实测数据

| 指标 | 数值 | 来源 |
|---|---|---|
| 总源码 | 25501 文件 / 243MB | 排除 node_modules/.venv/.git/dist |
| 内置工具 | **68**（31 toolset，当前环境可暴露 34） | Python import 枚举 42 个模块 |
| SQLite 表 | 18 张（其中 7 张是租约/心跳/代际） | `CREATE TABLE IF NOT EXISTS` 去重枚举 |
| SCHEMA_VERSION | 33 | `hermes_state_common.py` |
| 测试 | 7889 文件 / 1,325,018 行 | rg 统计 |
| 桌面端 | 6102 文件 / 102.6MB | 排除 node_modules |
| cron 模块 | 56 文件 / 17,866 行 | 其中 scheduler.py 219KB |

## 底层架构

### 进程模型

**一个 agent core，多个宿主。** `AGENTS.md:12-14`：
> "runs one agent core across a CLI, a TUI, an Electron desktop app, a web dashboard, ACP editors and a messaging gateway (25+ platform plugins)"

三个 console entry（`pyproject.toml:583-586`）：
- `hermes` → `hermes_cli.main:main`
- `hermes-agent` → `agent.legacy_cli:main`
- `hermes-acp` → `acp_adapter.entry:main`

Gateway 是独立进程（`gateway/run.py:1-4`）。

**执行是 spawn-per-call，不是长驻 shell**（`tools/environments/base.py:3`）：
> "Unified spawn-per-call model: every command spawns a fresh `bash -c` process. A session snapshot (env vars, functions, aliases) is captured once at init and re-sourced before each command. CWD persists via in-band stdout markers (remote) or a temp file (local)."

**判断**：这是整个后端抽象的**核心决策** —— 牺牲状态连续性换来后端无关性。对的，因为 6 个异构后端里只有 local/SSH 能真保持状态，Docker/Modal/Daytona/Vercel 都不能。

### 模块划分

按 LOC 实测（排除 `__pycache__`）：

| 目录 | py 文件 | py 行数 |
|---|---|---|
| `hermes_cli` | 857 | 274,484 |
| `agent` | 431 | 133,392 |
| `gateway` | 388 | 123,164 |
| `tools` | 390 | 119,522 |
| `tui_gateway` | 128 | 41,969 |
| `cron` | 56 | 17,866 |
| `acp_adapter` | 22 | 5,816 |
| `hermes_platform` | 15 | 1,595 |

官方口径（`AGENTS.md:22-24`）：
> "**The core is a narrow waist; capability lives at the edges.** Every model tool is sent on every API call, so the bar for a new *core* tool is high."

配套 **footprint ladder**（`AGENTS.md:58-60`）：extend existing code → CLI command + skill → service-gated tool → plugin → MCP server in catalog → new core tool。

反面清单（`AGENTS.md:43-48`）：「Rejected even when well-built: ...a new core tool when terminal + file or a skill already does the job; ...plugins that touch core files」。

### 工具注册机制

**发现：AST 静态扫描，不是 import 试错**。`tools/registry.py:121-125`：
> "Import built-in self-registering tool modules... The per-file AST scan costs ~145 ms over ~100 files, so verdicts are memoized on disk keyed by `(mtime_ns, size)`"

判定只在**模块体语句**里找 `registry.register(...)`，支持 `for` 循环体（表驱动）：`registry.py:94-109`。

**候选规则**（`registry.py:112-118`）：只扫 `tools/*.py` + `tools/<pkg>/tool.py`。

**注册即声明四元组**（`registry.py:215-239` `ToolEntry`）：`name / toolset / schema / handler / check_fn / requires_env / is_async` + 三个治理字段：
- `max_result_size_chars` — 结果截断预算
- `dynamic_schema_overrides` — 运行时 schema 浅合并
- `compat_args` / `self_checked_args` — 参数校验豁免白名单

**注册 ≠ 暴露**：68 注册，当前环境只有 **34 可暴露**（`check_fn` 过滤）。这是关键设计。

**授权：插件不能影子覆盖内置**（`registry.py:876-910`）三重闸：
1. 跨 scope 影子全局 → 必须 `override=True`
2. 跨 toolset 覆盖内置 → 必须 `plugins.entries.<id>.allow_tool_override: true`
3. 否则 `raise PermissionError`

**check_fn 是能力探测，带 TTL 缓存**：`registry.py:381` `CheckFnTimeout`、`:1035-1036`「Probes use the ~30 s TTL cache so `hermes tools enable` lands quickly」。

**skill 是另一套**：`tools/skills_tool.py:2-5` 渐进式披露 —— `skills_list` 只回 name/description，`skill_view` 才回全文。缓存签名在 `skills_tool.py:33-41`：目录 mtime+子目录名 + 30s TTL。

**外部 skill 有静态安全闸**（`tools/skills_guard.py:2-8`）：trust 分级（builtin / trusted / community）+ finding 严重度 → 策略矩阵（`:34-40`）。
**它自己诚实标注了已知漏洞**（`skills_guard.py:6-8`）：
> "Known gap: language write APIs (open(..., 'w'), Path.write_text, shutil.copy*, fs.writeFileSync) aimed at agent-config files surface only the low *_ref finding — static regexes cannot tie the call to a dynamic destination"

### 状态与记忆

**双轨制**：
- 会话状态 → SQLite（`HERMES_HOME/state.db`，`SCHEMA_VERSION=33`，18 张表）
- curated 记忆 → 纯文本 Markdown（`memories/MEMORY.md` + `USER.md`）

18 张表实测：
```
sessions, messages, session_model_usage, system_prompts, schema_version, state_meta,
conversation_generations, async_delegations, resumable_subagents, runtime_epoch,
session_admissions, session_turn_leases, compression_locks, gateway_heartbeats,
gateway_hygiene_state, gateway_routing, worker_executions, worker_receipts
```

**后 7 张全是分布式协同/租约/心跳** —— 这不是「聊天记录库」，是带并发治理的任务运行时。

`messages` 表 30 列，关键非显然字段（`hermes_state_common.py:538-569`）：
- `_compressed_summary` / `compacted` / `active` — 压缩生命周期三态
- `message_uid` / `absorbed_message_uids` / `tool_call_uids` — **消息身份与吸收关系**，为压缩后可溯源设计
- `api_content` vs `content` — 发给 API 的和展示的分开存

**FTS 内建**，base + trigram 两套索引（`:25-30`），触发器同步（`:862-872`）。

**curated 记忆是字符数定额的分隔符拼接文本**（`memory_tool_store.py:1-2`）：
- `memory_char_limit=2200`、`user_char_limit=1375`（`:188`）
- 这个数字小得刻意 —— 记忆进 system prompt，直接吃前缀缓存

**前缀缓存不可变是 hermes 的第一公理**（`AGENTS.md:18-21`）：
> "**Per-conversation prompt caching is sacred.** Mutating past context, swapping toolsets, reloading memories or rebuilding the system prompt mid-conversation breaks the cached prefix and multiplies the user's cost; the ONE exception is context compression."

代码落实：`memory_tool_store.py:179`「`_system_prompt_snapshot` is frozen at load time (prefix-cache stable)」。

## 执行逻辑

### 任务链路（`model_tools.py`）

```
model 返回 tool_call
  → _pre_dispatch_guards()                      model_tools.py:794
      ├─ plugin pre_tool_call hook（可改写 args / 可 block）  :804-816
      └─ ACP/Zed edit approval                    :820-828
          └─ 失败时 fail-closed: write_file/patch 直接拒   :827-828
  → run_tool_execution_middleware()               :873-875
  → _dispatch() → is_connector_name? 分流          :864-868
  → registry.dispatch()                           registry.py:1084
      ├─ hosted_tool_refusal()（宿主 scope deny-by-default）  :1088-1090
      ├─ check_tool_args() / flag_unknown_args()             :1094-1097
      ├─ _kwargs_accepted_by()（插件签名内省）                 :1102
      ├─ handler(args, **kwargs)                             :1103-1107
      └─ 任何异常 → tool_error(sanitize(...))                 :1109-1119
  → post_tool_call hook                           :702-726
  → transform_tool_result hook                     :878-892
```

### 六后端抽象

`tools/environments/__init__.py:1-4`：
> "one BaseEnvironment ABC for running shell commands in a specific context (**local, Docker, SSH, Modal direct/Nous-managed, Daytona, Vercel Sandbox**; plugin backends register through `agent.terminal_env_registry`)"

Builder 映射（`tools/terminal_tool_backends.py:277-279`）：`_ENV_BUILDERS` 6 项。

**统一靠「契约极窄」**：`BaseEnvironment` 只有 3 个必需方法 —— `__init__`(`base.py:324`)、`execute`(`:683`)、`cleanup`(`:352`)。其余 20+ 全是模板方法（`_wait_for_process:522`、`_kill_process:628`、`_wrap_command:487`、`init_session:428`、`fetch_file:359`）。

**后端差异用声明式规格而非 if/else**（`terminal_tool_backends.py:375-384`）：
```python
_BACKEND_SPECS = {
    "local": {},
    "docker": {"binary": (find_docker, "version", "Docker is not installed...")},
    "ssh": {"pre": _ssh_pre},
    "modal": {"pre": _modal_pre, "module": ("modal", "...")},
    "vercel_sandbox": {"pre": _check_vercel},
    "daytona": {"post": _daytona_post},
}
```
检查器通用（`:323-326`）："optional fields, checked in order: pre(config) / binary / module / post(config)"。

**插件后端不能冒名内置**（`agent/terminal_env_registry.py:26-34`）：`BUILTIN_BACKEND_NAMES` frozenset + `_reject_builtin_collision`。

**干净退出是后端抽象最难的部分**（`base.py:61-120`）：`_live_foreground` 表 + `_exit_fenced` 单向闸 + `_HARD_KILL_BUDGET_S = 0.5`。原因（`:97-104`）：
> "`now=True` is for a caller about to `os._exit`: the graceful kill TERMs, waits and only then KILLs, so a SIGTERM-ignoring command outlives a hard exit that lands inside that window..."

### 审批闸：8 层

`tools/approval.py:1-12` 自述是 facade，叶子模块：
```
approval_detection   (118KB) hardline/dangerous patterns
approval_context     (20KB)  contextvars, config readers
approval_floors      (10KB)  pre-gate blocks, allowlist match
approval_prompt      (20KB)  CLI prompt, plugin transports, MCP elicitation
approval_gateway_wait(17KB)  blocking gateway round-trip
approval_smart       (8.7KB) guardian LLM
approval_human_wait  (8.5KB)
approval_provenance  (2.3KB) allowlisted/preapproved 归因
approval_yolo        (5.3KB)
write_approval       (19KB)
```

`check_all_command_guards` 实测 8 层（`approval.py:1319-1409`）：

| 层 | 位置 | 行为 |
|---|---|---|
| 1. 容器短路 | `:1325-1326` | Docker 沙箱且无 host 挂载 → 跳过 |
| 2. 无条件地板 | `:1328-1330` | hardline + sudo -S + 用户 deny glob |
| 3. 预备批次 | `:1332-1335` | 同批命令复用一次判定 |
| 4a. yolo 旁路 | `:1337-1360` | 必须留审计痕迹 |
| 4b. 永久白名单 | `:1361-1362` | `_command_matches_permanent_allowlist` |
| 5. 无人值守 | `:1364-1371` | 按 ctx 配置 deny/approve |
| 6. fail-closed 兜底 | `:1374-1394` | 有 flag 但无人可批 → **BLOCK** |
| 7. 人类决策 | `:1396-1409` | 单次合并提问 |

**第 4a 层是全代码库最值得抄的一段**（`approval.py:1338-1359`），注释带实测史：
> "Make the bypass AUDIBLE. A flagged command must never vanish silently just because yolo / `approvals.mode=off` is on... **Measured before this change: `hermes -z` deleted a canary directory with no approval prompt AND no line anywhere saying the guard had been bypassed.** Reference systems announce the equivalent mode (Claude Code's `--dangerously-skip-permissions`), so log at WARNING"

实现不只 log，还**把旁路事实写进工具结果**：`return _approved(guard_bypassed=True, guard_bypass_reason=..., guard_description=..., guard_pattern=...)`。理由（`:1355-1356`）：
> "a log line nobody reads is not visibility. terminal_tool turns this into an audit note on the call."

**第 6 层同样是修过的 fail-open**（`approval.py:1372-1377`）：
> "This used to be a bare `return _approved()` — a fail-open default for flagged commands whenever nobody was watching. **Measured on this build: `rm -rf <dir>`, `git push --force` and `curl … | bash` all ran silently under `-z`.** Reference systems fail closed on non-interactive runs (Claude Code -p denies unless explicitly skipped), so block HERE too."

**地板层分三档**（`approval_floors.py`）：
1. **hardline**（`:98-122`）：无条件，连 `--yolo` / `approvals.mode=off` / cron approve 都不行
2. **用户 deny glob**（`:23-51`）：在 bypass **之前**触发；且**抗混淆** —— `_deny_command_variants(command)` 展开变体后逐个小写 fnmatch，"so quoting tricks (`r\m`, `git st""atus`) can't sidestep a rule"
3. **永久白名单**（`:188-208`）：**在 bypass 之后**，有防绕过 `_has_allowlist_shell_operator`（`:144-185`）—— 引号感知的复合命令检测，遇到 `-c/-e/--command/--eval` 时引号内控制字符**重新算危险**

**审批模式实为 3 个不是 2 个**：`hermes_cli/approval_mode.py:16` `VALID_APPROVAL_MODES = ("manual", "smart", "off")`。`smart` 是 LLM 当 guardian（`approval.py:903`），配 denial 熔断器（`:64` `_get_denial_breaker_threshold`、`:99 _denial_breaker_addendum`）。

**yolo 环境变量在 import 时冻结**（`approval.py:46-48`）—— 真安全设计：
> "Frozen at import: reading os.environ per call would let any skill running in the process set this and bypass every approval check (prompt-injection escalation path)."

**审批状态机 per-session**（`approval.py:53-60`）：`_lock`(RLock) / `_pending` / `_session_approved` / `_session_yolo` / `_launch_yolo_applied` / `_permanent_approved`。

**gateway 审批是完整异步协议**，不只是「发卡片」：`register_gateway_notify:128` / `resolve_gateway_approval:150` / `withdraw_gateway_approval:232` / `ack_gateway_approval:282` / `has_blocking_approval:292` / `register_gateway_settle:261` / `observe_gateway_settle:272` / `restrict_gateway_approval_card_to_deny:194`。

**execute_code 有独立闸**（`:1431-1448`），因为脚本能绕过 DANGEROUS_PATTERNS；且诚实标注局限（`:1437-1444`）：
> "Documented limitation: a purely local non-interactive non-gateway session returns approved"

### 记忆治理

| 维度 | 有无 | 证据 |
|---|---|---|
| TTL / 衰减 | ❌ **没有** | `rg -i "\bttl\b\|expires_at\|half_life\|decay"` 在四个 memory 模块零命中 |
| 溯源 | ✅ 但是**任务来源**不是事实来源 | `tools/skill_provenance.py:1-4` ContextVar 区分 background/foreground |
| 冲突处理 | ✅ **拒绝式**非合并式 | `memory_tool_store.py:51-60` `_drift_error`：超限无分隔符文本 → 拒绝写 + 先存 `.bak`（"prevent silent data loss (issue #26045)"） |
| 注入防御 | ✅ strict 模式 | `memory_tool_store.py:29-32`："**Strict scope: memory enters the system prompt, so a poisoned entry persists across sessions.**" |
| 超预算 | ✅ 强制模型自己合并 | `:328-330` `over_budget` 错误携带 `current_entries`；`:624` 预算校验跑在 FINAL state |
| 无人值守删除闸 | ✅ 有 | `memory_tool.py:181-210` |
| 会话保留期 | ✅ 有 | `hermes_state_maintenance.py:484` `retention_days=90` |
| 快照/备份 | ✅ 有 | 危险写前 `.bak`；`:179` system-prompt snapshot 冻结 |

### 调度

`cron/scheduler_provider.py:1-3`：
> "CronScheduler provider interface (Axis B — the trigger). EXPERIMENTAL: shape MAY change until a second provider validates it; growth MUST be additive... **Providers decide only *when* a job fires — execution + delivery stay in cron.scheduler.run_job / _deliver_result; never reimplement them.**"

ABC 只有 **2 个 abstractmethod** — `name:142`、`start:150`。其余 10+ 全是带默认实现的可选方法。

**降级永不失败**（`scheduler_provider.py:387-389`）：
> "Resolve `cron.provider`; missing/failing/unavailable providers fall back to the built-in with a warning — **cron must never be left without a trigger.**"

四级降级实测：空/builtin→内置；找不到→warning+内置；`is_available()` False→warning+内置；异常→warning+内置。

**多 profile 时外部 provider 直接拒绝**（`:416-427`）：「External providers own one unscoped remote registry and cannot reconcile several profile stores: fail closed」。

**EMFILE 韧性**（`:18-34`）：fd 耗尽时 tick 指数退避，`_EMFILE_BACKOFF_MAX_SECONDS = 15*60`；`_guarded_store_write`（`:52-63`）防 store 故障杀死 ticker 线程：
> "The gateway runs the provider on an unsupervised daemon thread: one escaping exception there stops cron silently while the gateway keeps serving (#111010)."

## 优势（可验证）

1. **极窄的 backend 契约让 6 个异构后端真的可互换** —— `BaseEnvironment` 必需方法 3 个，模板 20+。验证：新增后端只需实现 3 个方法 + 在 `_BACKEND_SPECS`(`:375`) 与 `_ENV_BUILDERS`(`:277`) 各加一行；`sandbox_conformance.py`（31KB）是一致性测试套。
2. **注册与暴露分离，让「装了但不可用」成为正常状态** —— 68 注册 / 34 可暴露。验证：`get_definitions()` 返回 34，`get_all_tool_names()` 返回 68。
3. **审批层的错误方向被实测数据强制修正过** —— 两处注释带具体复现（`approval.py:1343-1346` 的 canary 目录被删；`:1375-1377` 的三条命令静默执行）。验证：跑 `hermes -z "rm -rf <canary>"` 现在会被 block 并留痕。
4. **旁路可审计而不是可关闭** —— `_approved(guard_bypassed=True, ...)` 让「guard 被绕过」成为工具结果的**结构化字段**。
5. **YOLO 提权面被 import-time 冻结封死** —— `approval.py:48` 单行，消除「skill 在进程内改 env 绕过全部审批」整类攻击。
6. **cron 的可用性是设计目标而非 best-effort** —— 「cron must never be left without a trigger」+ 四级降级 + 受保护写入 + EMFILE 退避。
7. **跨进程并发被建模而非被祈祷** —— 18 张表里 7 张是租约/心跳/代际。
8. **数学上界守住 token 成本** —— 2200+1375 字符硬上限、per-tool `max_result_size_chars`（terminal 100,000）、错误体 2048 字符上限。都是常数不是「通常」。

## 缺点（可验证）

1. **无记忆 TTL → 陈旧记忆永久污染 system prompt**。
   出问题场景：长期项目里「这个 API 已废弃」和「已迁移到新 API」的旧记忆**同时存在** —— memory 工具只有 add/replace/remove/patch（实测 add=5/remove=3/replace=3/patch=7），**没有 age/decay 语义**，2200 字符上限只保证总量不保证新鲜度。
   验证：`rg -i "\bttl\b|decay|half_life"` 在四个 memory 模块零命中。这是「前缀缓存不可变」推到极致的必然代价。

2. **god-file 反模式在核心路径上**。
   `cron/scheduler.py` 219KB、`agent/auxiliary_client.py` 440KB、`agent/context_compressor.py` 328KB、`tools/approval_detection.py` 118KB、`tools/process_registry.py` 148KB。
   出问题场景：任何跨这些文件的改动都要同时理解 3000+ 行。`AGENTS.md:38` 自己把「god-file → module refactors」列进 Wanted，说明是已知债务。

3. **`_compressed_summary` / `compacted` / `active` 三态 + `absorbed_message_uids` 的正确性极难验证**。
   出问题场景：压缩 + rewind + branch 三者叠加时，`absorbed_message_uids` 指向已 `compacted=1` 但 `active=0` 的消息，任何一处忘记 `AND (active = 1 OR compacted = 1)`（这个条件在触发器里出现 **6 次**，`hermes_state_common.py:832-872`）就会漏数据或重复注入。

4. **注册顺序敏感 + 静默覆盖**。
   `registry.py:115-116` 自承：「`register()` lets a same-name, same-toolset duplicate overwrite silently, so the import order must not depend on file depth.」
   出问题场景：两个插件注册同名同 toolset 工具，后者**静默**替换前者无 warning（跨 toolset 才报错 `:903-910`）。

5. **execute_code 在特定上下文 fail-open**。
   `approval.py:1437-1444` 自述：「a purely local non-interactive non-gateway session returns approved」。
   出问题场景：CI 里跑 `hermes chat -q` 且脚本调 `os.system("rm -rf /")` → 通过。缓解只有 `approvals.cron_mode`。

6. **SKILL.md 的 mtime 签名看不见内容修改**。
   `skills_tool.py:36-37` 自承：「the TTL bounds staleness from in-place SKILL.md edits, which no directory signature can see.」
   出问题场景：30 秒内改 SKILL.md 并立刻 `skill_view`，可能拿到旧内容。

7. **无 plan / read-only 模式**。
   实测 `rg -i "plan_mode|readonly_mode"` 在 `hermes_cli` 只命中模型目录，**零真实 plan mode**。对比 ECC 有 `plan-canvas`、Cursor 有 Plan 模式。
   出问题场景：想「先看看方案再批准」只能靠审批闸逐个 tool call 拦，没有「整轮只读」这个粒度。

## 可照搬的

| 模块 | 照搬什么 |
|---|---|
| `tools/registry.py:94-163` | AST 扫描 + `(mtime_ns, size)` 磁盘记忆化做工具发现 |
| `tools/registry.py:876-910` | 插件覆盖内置的三重闸 |
| `tools/registry.py:1034-1062` | 注册与暴露分离：`check_fn` + 30s TTL |
| `tools/environments/base.py:324-683` | 3 必需方法 + 20 模板方法的 backend ABC |
| `tools/terminal_tool_backends.py:323-384` | `_BACKEND_SPECS` 声明式能力探测 |
| `tools/approval.py:1319-1409` | 8 层闸的**顺序**（地板在 bypass 前、白名单在 bypass 后） |
| `tools/approval.py:1338-1359` | 旁路必须 alarm + 结构化写进 result |
| `tools/approval.py:46-48` | 提权 env 在 import 时冻结 |
| `tools/approval_floors.py:144-185` | 引号感知 + `-c/--eval` 再解释检测 |
| `cron/scheduler_provider.py:1-3, 387-427` | provider 只管「何时」，四级降级永不留空 |
| `cron/scheduler_provider.py:52-63` | `_guarded_store_write` — 存储故障不杀 ticker |
| `tools/memory_tool_store.py:51-60` | 漂移检测 + 拒绝写 + `.bak` 快照 |
| `tools/memory_tool_store.py:29-32` | 记忆写入的 strict 注入扫描 |
| `agent/terminal_env_registry.py:26-34` | 内置名保留，插件不可冒名 |
| `tools/environments/base.py:61-120` | 退出 fence + 在途 spawn 等待 + 硬预算 |
| `tools/skills_guard.py:28-40` | trust 分级 × finding 严重度 → 策略矩阵 |

## 必须超过的

| 能力 | hermes 现状 | 怎么验证我们超过了 |
|---|---|---|
| **记忆新鲜度** | 无 TTL，只有字符硬上限 | 构造：写 10 条「%s 已废弃」，间隔 30 天，再问相关。验证我们引用最新事实，且 system prompt 里没有废弃条目。hermes 对照组会同时看到新旧。**注：我们的 A7 已实现 TTL + supersede，此处已超过。** |
| **单文件 god-file** | `scheduler.py` 219KB / `auxiliary_client.py` 440KB | 指标：>100KB 的核心文件数 = 0。**注：我们的 B4 体量红线已实现（32KB 红线，扫描 97 文件，红线 0）。** |
| **工具注册冲突静默覆盖** | `registry.py:115-116` | 注入两个同名工具，我们必须**启动时报错**并指出两个来源模块。 |
| **execute_code 局部 fail-open** | `approval.py:1437-1444` | 等价场景下脚本内 `os.system("rm -rf /tmp/canary")` 必须被拦。**注：我们的 A15 能力边界从工具调用层拦截，已覆盖。** |
| **SKILL.md 内容级变更检测** | 只靠 30s TTL | 改 SKILL.md 后 0ms 内 `skill_view` 返回新内容（用内容 hash 而非 mtime）。 |
| **审批粒度：整轮只读** | 无 | 存在「本轮所有写操作拒绝、读放行」开关，一次配置生效整轮。 |
| **压缩后溯源** | `absorbed_message_uids` 正确性靠 6 处重复 SQL 条件维持 | 压缩+rewind+branch 三重叠加后，任意被吸收消息仍能唯一反查到源行，且有**单点约束**（DB 约束或唯一索引）而非 6 处 WHERE 复制。**注：我们的 A5 用 extractKeyFacts 做硬约束保护，思路不同但可验证。** |

---

# ECC

## 一句话定位

**不是运行时，是一套「内容 + 投影器」的配置发行版**：314 skill / 71 agent / 98 command / 122 rule 是唯一真源（canonical），16 个 `install-target` adapter 把它们拷贝/改写成 16 个 AI 工具各自的原生格式，全靠 CLI 和 hook 在宿主里「寄生」。

## 实测数据

| 指标 | 数值 |
|---|---|
| 总文件 | 4701 文件 / 60MB |
| `.md` | 2878 个（61%） |
| `.js` | 1019 个 |
| canonical skills | **314** |
| canonical agents | **71** |
| canonical commands | **98** |
| canonical rules | **122** |
| install target adapters | **16** |
| npm 依赖 | **5**（`@iarna/toml, ajv, js-yaml, sql.js, zod`） |
| hooks 事件（Claude） | 8 个 / 26 matcher |
| hooks.json 体量 | 54KB（几乎全是重复 preamble） |
| `gateguard-fact-force.js` | **103KB 单文件** |
| `powershell-destructive-command.js` | **76KB** |
| skills 目录总字节 | 5.13MB ≈ 1.28M tokens |

## 底层架构

### 进程模型

**无自有运行时**。依赖只有 5 个纯工具库，engines `node >= 18`。bin 6 个：`ecc / ecc-control-pane / ecc-install / ecc-memory-mcp / ecc-plan-canvas / ecc-universal`。

它是一个 npm CLI + 一堆 hook 脚本 + 一堆 Markdown。宿主是 Claude Code / Codex / Cursor / … 本身。

### 模块划分

| 层 | 内容 | 实测 |
|---|---|---|
| **Canonical 内容** | `skills/` `agents/` `commands/` `rules/` | 314 / 71 / 98 / 122 |
| **Host 投影** | `.claude/` `.codex/` `.cursor/` `.kiro/` `.opencode/` `.agents/` `.gemini/` `.kimi/` `.qwen/` `.trae/` `.zed/` `.hermes/` `.openclaw/` `.adal/` `.codebuddy/` `.pi/` | 16 个 dot-dir |
| **安装器** | `scripts/lib/install-targets/` | `registry.js:19-36` |
| **Manifest** | `manifests/` | install-modules.json(47) / install-components.json(93) |
| **Hook 运行时** | `scripts/hooks/` | 60+ 脚本 |
| **Schema/校验** | `schemas/`(17) + `scripts/ci/validate-*.js`(10+) | — |

### 注册机制

ECC **没有运行时注册器**。「注册」= 文件写到目标工具会扫描的路径。

**发现 = adapter 声明**（`scripts/lib/install-targets/registry.js:19-36`）：16 个 adapter 冻结。

**加载 = 目标工具的目录约定**。`gemini-project.js:3-10` 全文 10 行 —— `rootSegments: ['.gemini']`，因为 Gemini 只吃 `GEMINI.md`。

**授权 = 各宿主自己的机制，ECC 只声明**。`.opencode/opencode.json` 的 `permission` 只有一条 `{"mcp_*": "ask"}`。

**manifest 驱动**：`install-modules.json` 47 module，kind 分布 `skills 26 / docs 13 / platform 2 / hooks 2 / orchestration 1 / rules 1 / commands 1 / agents 1`，总路径条目 **370**。

**组件粒度更细**：`install-components.json` 93 component，family `baseline 6 / language 14 / framework 9 / capability 23 / agent 12 / skill 16 / locale 13`。

### 状态与记忆

**安装状态**：每个目标根下 `ecc-install-state.json`。

**记忆是一套独立模型**（`scripts/lib/memory-vault-format.js`）：
- schema `ecc.memory.v1`（`:5`）
- **8 种 kind**：context/decision/fact/handoff/lesson/note/preference/runbook（`:6-15`）—— 注意 decision/lesson/handoff 有治理语义
- **3 种 scope**：project/team/user（`:16`）
- **trust 只有 1 个值：`['unreviewed']`**（`:17`）
- **3 种 status：active/rejected/superseded**（`:18`）—— **有 supersede 语义**
- 限额：body 64KB / document 128KB / title 200 / tags 32 / links 64（`:20-25`）
- **10 条 secret 扫描正则**（`:49-60`）：OpenAI `sk-`、Stripe、npm、HF、GitHub、Google、Slack、AWS、PEM
- **控制字符 + 双向文本拒绝**（`:62-72`）：`0x202a-0x202e` biDi override —— 防「用 RTL override 把恶意指令伪装成良性文本」
- **记忆默认不进 git**：`PROJECT_MEMORY_GITIGNORE = '*\n!.gitignore\n'`（`memory-vault.js:37`）
- 查询上限 `MAX_FILES 5000` / `MAX_SCAN_BYTES 16MB` / `MAX_RESULTS 100`（`:32-36`）
- 暴露方式：**MCP server**（`scripts/memory-mcp.mjs`，手写 JSON-RPC，1MB 上限，64 条待处理队列）

## 执行逻辑

### 任务链路（hook 链）

Claude 的 8 个事件（`hooks/hooks.json`）：

| 事件 | matcher 数 |
|---|---|
| `PreToolUse` | 10 |
| `UserPromptSubmit` | 1 |
| `PreCompact` | 1 |
| `SessionStart` | 2 |
| `PostToolUse` | 2 |
| `PostToolUseFailure` | 2 |
| `Stop` | 8 |
| `SessionEnd` | 1 |

单 hook 命令的真实形态是一个**内嵌 1200+ 字符的 ECC root 解析器**：从 `CLAUDE_PLUGIN_ROOT` → `CLAUDE_CONFIG_DIR` → `~/.claude` → 逐个尝试 4 个路径 → 扫 cache 目录 → WSL 路径转换 → 最后 `require(plugin-hook-bootstrap.js)`。

**这个 preamble 在每个 hook 里重复一遍** —— `hooks.json` 54KB 几乎全是它。

### 无后端抽象

ECC 不执行工具，只：
1. hook 在宿主执行前后插入检查
2. MCP server 提供额外工具
3. skill 告诉模型该怎么做

唯一接近后端抽象的是 **install-target adapter**。

### 审批闸

- **宿主自己的审批 ECC 不接管**
- ECC 自己的闸在 hook 形式：`gateguard-fact-force.js`（**103KB**）+ 9 个 `gateguard-*` 模块（合计 ~150KB）
- `powershell-destructive-command.js` **76KB** 专门识别 PowerShell 破坏性命令
- **hook profile 是核心授权设计**：4 档 `off / minimal / standard / strict`（`harness-capabilities.js:49`），每个 hook 用 `run-with-flags.js` 声明属于哪几档
- hook consent：`install/hook-consent.js`（15KB）

## 功能选取

### 有而我们没有

1. **16 宿主投影器 + 声明式 manifest**（47 modules / 370 路径条目）
2. **hook profile 四档 + 逐 hook 声明适用档位**
3. **类型化记忆 + supersede 状态机**（8 kind × 3 scope × 3 status）
4. **biDi override + 控制字符拒绝**（真实的 prompt injection 攻击面，绝大多数系统没做）
5. **记忆默认不进 git**
6. **Agent IR（中间表示）** —— `scripts/lib/agent-ir.js:4-17`：
   > "Reads ECC's canonical agent files (Claude frontmatter markdown) and emits **harness-neutral IR objects** validated against `schemas/agent.schema.json`. Design constraints: Deterministic / Lossless / Strict / No shell, no network, no new dependencies"
   
   但 `agent-convert.js:26` `const SUPPORTED = { claude: ['pi'] };` —— **目前只有一条边**
7. **跨宿主 skill 兼容性静态门**（`validate-skill-host-compat.js:2-27`）四类检查
8. **80% 覆盖率硬门**（`--check-coverage --lines 80 --functions 80`）
9. **supply-chain IOC 扫描**（`scan-supply-chain-iocs.js` 27KB）
10. **hook 运行时自己的 eval harness**（`scripts/lib/eval-harness/` 11 文件）

### 刻意没做

1. **不做自己的 agent loop / 模型调用** —— 主路径完全依赖宿主
2. **不接管宿主审批** —— 只声明 `{"mcp_*": "ask"}`
3. **不做记忆 TTL** —— schema 有 status 但无 expires
4. **Hermes 目标刻意不装 hook 运行时**（`docs/HERMES-HOOKS.md:6-9`）：
   > "ECC's `hooks/hooks.json` is Claude Code format, and the Hermes install target (`--target hermes`) **deliberately does not install the hook runtime** — so Hermes operators get ECC's rules, skills, and commands with no hooks at all."
   
   只移植 2 个 hook，理由（`:15-20`）：「Most of it is Claude Code-specific... or duplicates the target harness's own gates.」
5. **Agent 转换只做一条边**（`claude → pi`）

## ECC 特别要答

### 如何适配 8+ 个 AI 工具：三层，能力递减

**第 1 层：原生插件（最强，2 个）** —— `claude`（`.claude-plugin/plugin.json`）、`codex`（`.codex-plugin/plugin.json`）。宿主自己管加载/版本/更新/权限。

**第 2 层：托管安装（11 个）** —— 写文件到目标约定路径 + `ecc-install-state.json` 记账。
project 类：cursor / antigravity / copilot / gemini / codebuddy / joycode / zed / adal / kimi
home 类：opencode / qwen / hermes / openclaw
每个 adapter 决定要不要改写格式：`cursor-project.js:13-21` 把 `.md` 改成 `.mdc`；且**主动跳过**不适合的内容（`:142-146`）：
> "Cursor treats nested AGENTS.md files as directory context; do not install ECC's root project identity into a host project's `.cursor/`."

**第 3 层：能力声明（最弱，全部 16 个）** —— `harness-capabilities.js` 冻结每宿主的 `channel / installMode / guidedReady / availability / hooks.mode`。
`availability` 实测：`guided` 3 个（claude/codex/kimi），`advanced` 13 个。
`hooks.mode` 4 种：`profile-selection`(claude) / `native-trust`(codex) / `adapter-configured`(cursor) / `not-configured`(kimi)。

### 同一份 skill 在不同工具下的差异（实测）

以 `agent-sort` 为例：

| | canonical | Codex 副本 |
|---|---|---|
| 字节 | 5922 | 5911 |
| frontmatter | `name / description / metadata.origin: ECC` | `name / description / license: MIT` |

**差异 1：frontmatter 字段集不同**。canonical 有 `metadata.origin: ECC`（溯源），Codex 副本换成 `license: MIT`。原因（`validate-skill-host-compat.js:38-44`）：`ALLOWED_CODEX_FRONTMATTER_KEYS` allowlist。

**差异 2：可执行 fence 里的变量替换**（最实质）。`validate-skill-host-compat.js:6-10`：
> "Claude-only substitutions in Codex/Cursor executable `bash/sh/zsh` fences (`${CLAUDE_SESSION_ID}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, `$ARGUMENTS`). **Codex and a bare shell leave those tokens literal.**"

即：**同一段 bash，在 Claude 下 `$ARGUMENTS` 会被替换，在 Codex 下就是字面量**。这个差异是 CI 门（fail-closed）守住的。

**差异 3：副本数量严重不均**（实测）：

| 位置 | SKILL.md |
|---|---|
| `skills/`（canonical） | 314 |
| `pi/core/skills` | 134 |
| `.agents/skills`（Codex） | **47** |
| `.kiro/skills` | **43** |
| `.cursor/skills` | **12** |
| `.claude` / `.codex` | 0（走引用） |

**314 → 47 / 43 / 12**。这不是 bug，是能力天花板的具体表现。

**agent 同样漂移**：canonical 71 vs `.kiro/agents` 33 名 —— **38 个 agent 在 Kiro 下不存在**。

**另一处硬证据**：opencode 的 always-on 注入量。`.opencode/opencode.json` 的 `instructions` 数组列了 14 个文件，按 repo root 解析实测 **157,907 bytes ≈ 39,477 tokens / 每次请求**。

### 「配置层」路线的天花板

**天花板 1：内容必须能被压成 Markdown，能力就不行。**
- 能做：知识、检查清单、评审规则、prompt 模板
- 不能做：工具注册、状态机、并发、事务
- 证据：`memory-mcp.mjs`（21KB）是 ECC 唯一「真运行时」—— 一旦要做真能力，就得写 MCP server 而不是 SKILL.md
- 反面：`gateguard-fact-force.js` 103KB + 9 库 ~150KB，是在**用 hook 重写一个审批引擎**。对比 hermes 用 `approval.py`(82KB)+`approval_detection.py`(118KB) 在内核里做同样的事 —— ECC 花更多代码做更少的事

**天花板 2：宿主能力差异无法磨平，只能「降级声明」。**
- 314 skill → pi 134(43%) / Codex 47(15%) / Cursor 12(4%) / Claude 的一个都没有
- hooks：Claude 8 事件 26 matcher，Cursor 15，Codex **只有 1 个 SessionStart**，Kimi `not-configured`
- 这个梯度**不是 ECC 的选择，是宿主 API 的物理上限**

**天花板 3：一份内容 × N 份副本 = N 倍维护成本，漂移必然发生。**
- 314 canonical vs 47/43/12 副本，无自动再生机制（`agent-convert` 只支持一条边）
- CI 只能保证「副本合法」，不能保证「副本同步」
- 差 267 个，**没有任何机制会去补**

**天花板 4：hook 的转义与跨平台路径是永久的税。**
`helpers.js:39-43` 注释：
> "Contains no backslash: on native Windows, Claude Code runs hooks as `bash.exe -c "<command>"` and the extra argv/MSYS unescape layer collapses backslashes, which broke regex literals (#3746). The backslash separator is built with `String.fromCharCode(92)` instead."

**天花板 5：always-on 注入成本随内容线性增长。**
opencode 158KB ≈ 39K tokens/请求，无产品化的按需加载（`instructions` 是静态数组）。对比 hermes 的渐进式披露（`skills_list` 只回 name/description）。

**天花板 6：无法做真正的能力，只能做提示。**
无状态机、无并发、无事务、无 TTL、无租约。`state-store` 有 7 类实体和 Ajv schema，但底层是 JSON 文件 + `file-lock.js`(5.7KB) 咨询锁。对比 hermes 的 18 张表 —— 这是「记账」与「运行时」的差别。

## 优势（可验证）

1. **零运行时依赖 = 零启动成本、零崩溃面** —— 5 个纯工具库依赖。验证：`npm i` 后在任意支持 skill 的工具里立即生效，不需要守护进程/端口/SQLite。
2. **内容与投影分离，加一个宿主 = 加一个 10 行文件** —— `gemini-project.js` 10 行 / `hermes-home.js` 10 行。验证：`ADAPTERS` 数组加一个 + `SUPPORTED_INSTALL_TARGETS` 加一个字符串。
3. **manifest 驱动按需安装** —— 47 modules × 370 paths，每 module 带 `cost: light/heavy` + `stability` + `defaultInstall`。验证：`./install.sh --target cursor --modules rules-core` 只装 rules。
4. **跨宿主差异被 CI 硬门守住** —— `validate-skill-host-compat.js:20`「Default invocation is fail-closed on (1)-(3)」。验证：在 canonical bash fence 里加 `${CLAUDE_PROJECT_DIR}` 并跑 `npm run test:validators`，必然失败。
5. **记忆模型类型化程度高** —— 8 kind × 3 scope × 3 status + 10 条 secret 正则 + biDi 拒绝 + 双层限额。验证：`memory_save` 一个含 `sk-` 的 body 会被拒。
6. **记忆默认不进 git** —— 验证：项目 memory 目录只有 `.gitignore` 被 track。
7. **hook profile 是产品化开关** —— 4 档 + 逐 hook 声明 + 安装时 consent。验证：`--hook-profile minimal` 装完只剩 minimal hook。
8. **覆盖率硬门** —— 80% lines / 80% functions。
9. **对「自己做不到」极其诚实** —— `HERMES-HOOKS.md:15-20` 明说 24 个 hook 只移植 2 个及原因；`validate-skill-host-compat.js:21-22` 明说「Do not flip `validate-skills.js` to `--strict`」。文档标注的局限与代码一致。

## 缺点（可验证）

1. **副本必然漂移，无再生机制 → 「同一份 skill」是假象**。
   出问题场景：用户以为 Cursor 下有 314 skill，实际只有 12。`.agents/skills` 47 vs canonical 314。38 个 agent 在 Kiro 下不存在。
   验证：`(Get-ChildItem skills -Directory).Count` 对比 `(Get-ChildItem .agents\skills -Directory).Count`。

2. **能力上限被宿主 hooks API 卡死**。
   出问题场景：Codex 下 ECC 全部安全 hook 只有 1 个 `SessionStart` —— `gateguard-fact-force.js`(103KB) + `powershell-destructive-command.js`(76KB) 在 Codex 下**完全不生效**。
   验证：`Get-Content hooks\codex-hooks.json | ConvertFrom-Json`，`hooks` 只有一个 `SessionStart`。

3. **always-on 注入量不可控**。
   出问题场景：opencode 用户每次请求被注入 158KB ≈ 39K tokens，**永久每请求成本**且随内容线性上升。
   验证：累加 `instructions` 数组每个文件字节数。

4. **hook preamble 重复是结构性的**。
   出问题场景：`hooks.json` 54KB，每个 hook 前 1200+ 字符完全重复；改解析逻辑要改 N 处。且被迫用 `String.fromCharCode(92)` 绕 MSYS 反斜杠折叠。
   验证：统计 `hooks.json` 里 `resolve-ecc-root` 出现次数。

5. **用 hook 重写审批引擎 = 更多代码做更少的事**。
   出问题场景：ECC ~250KB 只能在支持 `PreToolUse` 的宿主用，且无法跨事件共享状态（每 hook 独立 `node` 进程）。对比 hermes `approval.py`(82KB)+`approval_detection.py`(118KB)，共享进程内 state，6 后端通用。
   验证：跑「同 session 内 5 次连续危险命令」，hermes 的 denial breaker 会累积，ECC 每次都是冷进程。

6. **shell 扫描靠 76KB+103KB 正则堆，必然有绕过面**。
   出问题场景：任何未覆盖的 shell（fish/nushell/zsh 特有语法）都是空白。
   验证：对比 hermes 的 `approval_floors.py:144-185` **引号感知 + `-c/--eval` 再解释检测**算法，ECC 无等价通用实现。

7. **无运行时状态 → 无跨调用治理**。
   出问题场景：ECC 不能做「这个 session 已批准过 rm -rf，后续免问」，不能做「连续 3 次拒绝就熔断」，不能做「整轮只读」。
   验证：看 `scripts/lib/state-store/file-lock.js`(5.7KB) —— 文件锁，无 MVCC。

8. **记忆 `trust` 字段是死字段**。
   出问题场景：`MEMORY_TRUST_STATES` 只有 `['unreviewed']` 一个值，意味着 review 流程未实现。
   验证：`rg "trust" scripts/lib/memory-vault.js` 只有读没有写状态迁移。

9. **supersede 只有枚举没有迁移逻辑**。
   出问题场景：`MEMORY_STATUSES` 有 `superseded`，但 `rg -i "supersed" scripts/` 只命中 3 个文件，都不是「把 A 标为 superseded 并链到 B」的迁移实现。
   验证：搜索 `status.*superseded` 赋值语句，零命中。

## 可照搬的

| 模块 | 照搬什么 |
|---|---|
| `scripts/lib/install-targets/registry.js:19-93` | adapter 注册表 + plan/validate/apply 三分离 |
| `scripts/lib/install-targets/helpers.js:370-460` | `createInstallTargetAdapter` 默认行为 |
| `manifests/install-modules.json` | module 声明 `paths[] + targets[] + dependencies[] + cost + stability` |
| `manifests/install-components.json` | 93 component + 前缀 family |
| `scripts/lib/agent-ir.js:4-48` | 中间表示：parse canonical → IR → emit host |
| `scripts/lib/harness-capabilities.js:31-260` | 每宿主声明 `channel / installMode / availability / hooks.mode` |
| `scripts/ci/validate-skill-host-compat.js:38-57` | 跨宿主 frontmatter allowlist + Claude-only 替换 token 清单 |
| `scripts/lib/memory-vault-format.js:5-72` | 8 kind × 3 scope × 3 status + secret 正则 + biDi 拒绝 + 双层限额 |
| `scripts/lib/memory-vault.js:32-37` | 检索上界 + `PROJECT_MEMORY_GITIGNORE` |
| `scripts/memory-mcp.mjs:29-41` | 手写 MCP：协议协商 + 1MB 上限 + 队列上限 |
| `install/hook-consent.js` + `hook-flags.js` | hook 的 explicit consent + 逐 hook 启用标志 |

## 必须超过的

| 能力 | ECC 现状 | 怎么验证我们超过了 |
|---|---|---|
| **跨宿主副本一致性** | 314 → 47/43/12，无再生机制 | 改 1 个 canonical skill，**所有已安装宿主目标文件自动同步**（内容 hash 一致），CI 能报出任何漂移。ECC 的 `validate-skill-host-compat.js` 只校验副本合法，不校验与 canonical 一致。 |
| **always-on 注入预算** | opencode 158KB / ~39K tokens per request | 仓库级配置里 always-on 内容 ≤ 2K tokens，其余走渐进式披露。可用等价物总字节数作硬指标。 |
| **hook 数量与性能** | 26 matcher × 每 hook 一个 `node` 冷进程 + 1200 字符 preamble | 同会话 20 次工具调用，hook 总耗时 < 200ms（ECC 按 ~50ms/个冷启动算，单轮就是秒级）。参考 `scripts/dev/gateguard-latency.js` 的度量口径。 |
| **跨调用状态共享** | 无（每 hook 独立进程） | 同 session 连续 5 次危险命令，第 3 次起触发熔断/降级。hermes 有 `_denial_breaker`，ECC 无。 |
| **shell 扫描算法完备性** | 76KB + 103KB 正则堆，按 shell 分文件 | 存在**引号感知 + 再解释选项检测**的统一算法，对 `bash -c "..."`、`git -c alias.x='!rm -rf /'`、`python -e` 等全覆盖，且有单测矩阵。 |
| **记忆 trust/status 落地** | `trust` 单值死字段；`superseded` 无迁移逻辑 | 记忆 review 后 `trust` 变 `reviewed`；supersede 时旧条 `status=superseded` 且 `links` 指向新条，检索默认过滤。**注：我们的 A7 已实现 supersede 链（`supersededBy`）+ 冲突检测，已超过。** |
| **记忆 TTL / 时效** | 无 | age-based 降权或过期。**ECC 与 hermes 都没有 —— 我们的 A7 已实现 TTL（`expiresAt` + `effectiveState`），这是净增量。** |
| **能力而非提示** | 无状态机/并发/事务/租约 | 审批/记忆/调度有持久化事务边界与并发租约，能通过「两进程同时改同一条记忆 / 同时 fire 同一 cron job」的测试。 |

---

## 附：本次未能读到 / 需标「推测」

1. **hermes 星图 UI 的完整机制** —— 只确认存在 `apps/desktop/src/app/starmap/timeline.tsx`（含 constellation 可视化、`--starmap-reveal` CSS 变量驱动的零 JS 逐帧动画）。数据源与 `conversation_generations` 的关系**未读**。
2. **ECC 的 hook 实际运行行为** —— 只做静态阅读，**没有在真实会话里执行过任何 hook**。拦截成功率是**推测**。
3. **hermes `approval_smart` 的 guardian LLM 判定质量** —— 只读函数签名与调用点，**没跑过 smart 模式**。漏报率未知。
4. **68 是「内置工具」，不含 MCP** —— `mcp_tool_registration.py`(37KB) 运行时动态注册，本次 probe 未配 MCP，所以是 68。真实部署会更多。
5. **ECC 314 skills 全部加载不现实** —— 5.13MB ≈ 1.28M tokens，这也是「渐进式披露」必需性的量化证明。
6. **Codex 副本的 frontmatter 转换由谁执行** —— 确认了差异与 allowlist，但**未找到生成脚本**。推测是 `codex-legacy-sync.js`(23KB) 或 `sync-ecc-to-codex.sh`(20KB)。
7. **`.kiro/agents` 的 66 文件 = 33 名 × 2 格式** —— 已确认，但哪个是 Kiro 真正读取的**未读 Kiro 文档**，推测是「机器可读 + 人可读」双写。
8. **hermes `retention_days=90` 是否真会删 sessions** —— 读了签名与范围校验，**没实跑过 prune**。
