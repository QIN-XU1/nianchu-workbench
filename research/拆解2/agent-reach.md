# Agent-Reach 拆解（Panniantong/Agent-Reach，v1.6.1）

> 一句话：**它不是外呼/触达系统，而是「让 Agent 够得着互联网」的只读 CLI 接入层**——一个 `agent-reach <渠道> <动作>` 命令，把 14 个平台（YouTube/GitHub/X/Reddit/B站/小红书/Boss/V2EX/雪球/小宇宙/网页……）的「搜索、读帖、看评论、取字幕」统一成一份 JSON。
> 与本产品形态**强相关于「多渠道接入（A10）」与「渠道扩展机制（A12）」**，其余维度多为无或弱。可借鉴 3 条核心机制 + 3 条辅助机制。

---

## 1. 定位与规模

- 包定义：`agent-reach` v1.6.1，`description = "Internet access for AI agents: one CLI with JSON output to search and read the web, YouTube, GitHub, V2EX and more."`（`pyproject.toml:2-4`）。
- 入口：console script `agent-reach = "agent_reach.cli:main"`（`pyproject.toml:46-47`）→ `cli.py:44-46` 转 `runtime.cli.main`。
- 规模：**124 个文件**（实测 `Get-ChildItem -Recurse -File | Measure` = 124），Python ≥3.10（`pyproject.toml:7`），核心代码约 **8,000 行**；最大三个文件 `runtime/manage.py`（1034 行）、`runtime/browser.py`（947 行）、`runtime/cli.py`（582 行）。
- 最近提交：`2026-11-08`（`git log -1`，Merge PR #934）；CHANGELOG 最新版本 1.6.1 / 2026-11-01（`CHANGELOG.md:9`）。
- star 数：**未找到**——离线仓库里只有徽章图片，没有数字（`README.md:14`、`README.md:20`）。不做猜测。
- 依赖极少：`requests / loguru / pyyaml / yt-dlp`（`pyproject.toml:30-35`）——浏览器自动化不靠 Playwright/Selenium，而是自研 CDP 客户端（`runtime/cdp.py:1-6`）+ 借上游 OpenCLI 扩展（`backends/opencli.py:1-6`）。

## 2. 架构骨架

顶层目录 → 职责：

| 路径 | 职责 | 证据 |
|---|---|---|
| `agent_reach/cli.py` | 控制台入口：Windows UTF-8、loguru 静音、取出 `--` 后的字面参数 | `cli.py:8-46` |
| `agent_reach/runtime/cli.py` | 真正的命令分发：渠道动作 + 12 个管理命令，全部输出一行 JSON | `runtime/cli.py:41-70`, `549-582` |
| `agent_reach/channels/` | 每平台一个 `Channel` 子类 + 静态注册表 | `channels/__init__.py:24-39` |
| `agent_reach/backends/` | **跨渠道**上游运行时（OpenCLI / BOSS 原生 / Cloak） | `backends/__init__.py:1-9` |
| `agent_reach/runtime/` | 执行层：dispatch、result、clock、state、tools、browser、bridge、cdp、sessions、session_reuse、manage、onboarding、public_web、run、legacy、update_notice | 目录清单 |
| `agent_reach/utils/` | paths（私有原子写）/ url（SSRF）/ text（脱敏）/ process | `utils/paths.py:1-6` |
| `agent_reach/skill/` | 给 Agent 读的说明书 `SKILL.md` + 3 篇 references | `skill/SKILL.md:1-105` |
| `tests/` `scripts/` `.github/` | 契约/单元测试、发布验收、CI 与发布工作流 | `test_channel_contracts.py:1-41`, `scripts/check_release_acceptance.py:1-90` |

依赖方向（谁 import 谁）：

- `channels/*` → `runtime.result` / `runtime.run` / `utils`（`youtube.py:11-20`、`xiaohongshu.py:4-5`）。
- `runtime.dispatch` → `channels.base`（`dispatch.py:10`）+ `state/result/clock/browser_binding`（`dispatch.py:12-25`）。
- `runtime.cli` → `channels`（`runtime/cli.py:24-25`）+ `dispatch`（`runtime/cli.py:29`）。
- 反向依赖一律**函数内 lazy import** 断开环：`manage._channels()` 内部才 import `runtime.cli.unified_channels`（`manage.py:34-37`）；`run_cmd` 内部才 import `tools.resolve`（`run.py:81`）；`state.mutate` 内部才 import `browser_binding`（`state.py:80-81`）。
- 结论：**没有单向强约束**，靠「lazy import + 目录约定」维持可导入，不是靠类型/接口隔离。

有没有「核心/插件」边界？**有声明式契约，但没有强制执行的核心-插件边界**：

- 契约写在抽象基类里（`channels/base.py:52-123`），一致性由**测试**守：渠道名唯一、`level ∈ {default,optional,experimental}`、每个 action 的每个 backend 方法必须 `callable`（`test_channel_contracts.py:7-22`）。
- 打包侧由 CI 守「退役模块不得进 wheel」（`pytest.yml:99-101`）；发布侧由 tag=版本号断言守（`release.yml:24-30`）。
- 但渠道都是**同进程、in-tree** 的 Python 类，没有目录扫描、没有 manifest 文件、没有沙箱。

## 3. 【A12】插件 / 扩展机制（重中之重）

**先给结论：这不是插件系统，是「声明式渠道清单 + 静态注册表」。可抄的是清单的字段设计，不可抄的是发现/隔离/热插拔。**

### 3.1 清单长什么样（真实片段）

```python
Action(
    "search",
    "Search videos",
    (Param("query", "what to search for"),
     Param("limit", "max results", required=False, type=int, default=5)),
    (("yt-dlp", "_ytdlp_search"),),          # 有序后端链：(后端标签, 渠道方法名)
    live_test={"query": "python tutorial", "limit": 2},
)
```
（`channels/youtube.py:127-136`；数据结构定义见 `channels/base.py:19-49`）

`Channel` 上可声明的字段全部是类属性（`channels/base.py:55-86`）：

| 字段 | 含义 | 行号 |
|---|---|---|
| `name` / `description` / `level` | 标识、说明、等级 default/optional/experimental | `base.py:55-59` |
| `actions: Tuple[Action,...]` | 统一动作清单 | `base.py:60-61` |
| `session` / `login_argv` / `login_url` / `domains` / `legacy_state` | 登录态与清理范围 | `base.py:62-74` |
| `tools` / `prereqs` | `add` 时要装的工具与机器前置（key of `tools.TOOLS`） | `base.py:75-79` |
| `logout_keys` / `needs_key` / `session_home` | 配置键、必需 Key、HOME 隔离开关 | `base.py:80-86` |
| `Action.public_web` | 该动作允许走的「免登录公开网页作用域」 | `base.py:47-49` |
| `Action.timeout` | 慢动作单独超时（如转写 1800s） | `base.py:45-46` |

钩子方法：`setup_problems()` / `validate_params()` / `on_add()` / `on_remove()` / `sync_login()` / `recover_login()`（`base.py:88-118`）。其中 `on_add` 的注释原型就是「注册一个 MCP server」（`base.py:96`）——现在没渠道用。

### 3.2 怎么被发现

**没有扫描逻辑。** 注册表是手写 import + 手写实例化列表：

```python
ALL_CHANNELS: List[Channel] = [GitHubChannel(), TwitterChannel(), ... WebChannel()]
```
（`channels/__init__.py:9-39`；查找靠线性遍历 `get_channel` `42-47`）

要加一个平台 = 新建 `channels/xxx.py` + 在 `__init__.py` 里 import 并 append。第三方无法只放文件就生效。

### 3.3 怎么校验

三层，全在**入参**和**测试**，不在「插件装载」：

1. 结构校验（测试期）：`test_channel_contracts.py:7-22`。
2. 参数校验（运行期，统一）：必填、类型、`limit/page` 正整数、未知参数报错（`dispatch.py:37-64`）。
3. 站点级校验（渠道自写）：如小红书评论要求 https、无 userinfo、端口 443、路径白名单（`xiaohongshu.py:99-117`）；先校验再装依赖/开登录，见 `validate_action` 注释与调用顺序（`dispatch.py:67-80`）。

失败怎么报：抛 `ReachError(code, message, hint)`，由调度层包成统一信封（`result.py:50-57`, `116-142`）。

### 3.4 怎么装载

普通 Python import（`channels/__init__.py:9-22`），**同进程、无子进程、无沙箱**。真正跑外部动作时才起子进程/HTTP：

- 子进程：`run_cmd` 带超时、超时杀进程组（POSIX `killpg`，Windows `taskkill /T /F`）（`run.py:96-137`）。
- HTTP：`http_request` 带 8MB 上限与短读检测（`run.py:151-173`）。
- 浏览器：CDP 调用到 127.0.0.1（`cdp.py:27-33`, `77-80`）。

### 3.5 贡献点（插件能往宿主加什么）

只能通过**类属性**扩展：动作（actions）、要装的工具（tools/prereqs）、登录方式（login_url/login_argv）、Cookie 清理域（domains）、公开网页作用域（public_web）、两个生命周期钩子。**不能**加命令、面板、路由、中间件——CLI 命令表也是写死的 `if/elif`（`runtime/cli.py:561-581`）。

### 3.6 隔离

**没有隔离。** 渠道代码可直接 import 运行时内部（`youtube.py:19` 直接拿 `run_cmd`；`boss.py:72-74` 直接 import `state` 与 `browser_binding.wait_lock`），也能读写 `state.load()["tools"]`。能力边界只靠「只读红线」的约定，不靠机制（`skill/SKILL.md:101-105`）。

### 3.7 热插拔

- 「装/卸渠道」= 装/卸**依赖工具 + Cookie + 状态账本**，不是装卸代码（`manage.py:291-306`, `322-359`）。
- 状态存 `~/.agent-reach/state.json` 的 `channels` 键与 `removed_defaults`（`state.py:3-16`, `48-66`）；被移除的默认渠道会记进 `removed_defaults`，以后 `setup/update` 不再装回（`manage.py:348-357`, `852-877`）。
- 没有「启用/禁用」中间态：只有 added / not added（`manage.py:48-52`）。

## 4. 【A13】MCP / 工具接入

- **MCP server/client 已被移除**：1.6.0 计划明确「Remove the Reach MCP server/registration, model planner, local OpenCLI patch command」（`docs/plans/2026-10-20-shared-cloak-browser.md:9`），CHANGELOG 也把「MCP server entry」列进删除项（`CHANGELOG.md:122`）。残留只有一句提示，不再改别人配置（`manage.py:765-769`），并顺手卸掉自家私有 `mcporter`（`manage.py:719-720`）。
- **唯一还用 MCP 的地方**：`web` 渠道把 Exa 的**托管 MCP 当 HTTP API 用**——手写 JSON-RPC `tools/call`、解析 `data:` SSE 行（`channels/web.py:29`, `77-104`）。这是「MCP 客户端的最小实现（~30 行）」，不是 MCP 服务管理。
- **工具列表怎么暴露给模型**：不走 MCP，走 `agent-reach channels` 输出机器可读的完整 schema（名字/说明/usage/参数/后端/public_web，`runtime/cli.py:192-233`），再配一份给 Agent 读的 `SKILL.md`（`skill/SKILL.md:22-34`）。
- **有没有 UI 管理 MCP server**：无（全仓无前端，见第 8 段）。
- **调用结果怎么回填**：统一信封 `{schema_version, ok, channel, action, backend, items, meta{elapsed_ms,attempts}, error{code,message,hint}}`（`result.py:116-142`），Agent 只按 `ok` 和 `error.code` 分支，不解析上游原文（`result.py:1-9`）。

## 5. 【A11】调度 / 后台任务

- **没有定时任务/调度器**。更新检查明确「no background process」（`update_notice.py:1`），只在 `update --check` 时联网并写缓存（`manage.py:774-789`）。
- 有**一个常驻进程**：`browser_watcher`，由 `runtime.browser` 分离式启动，独占 `watcher.lock` 保证单实例（`browser.py:496-525`, `browser_watcher.py:99-109`）。
  - 空闲 600s 自动关浏览器（`browser.py:62-63`；关停逻辑 `browser_watcher.py:142-149`），冷启动最多等 90s（`browser.py:65`）。
  - 循环里每 2s 做一次 `observe_activity()`（可信输入检测）+ `save_session()`（Cookie 快照）（`browser_watcher.py:135-162`）。
- 失败重试/超时/状态：
  - **每次动作一个预算时钟**，且「等浏览器冷启动/排队」可暂停计时不算超时（`clock.py:11-61`，`dispatch.py:149-179`）。
  - **后端级暂停**：TIMEOUT 60s / UPSTREAM_BROKEN 120s / NEED_SETUP 60s（`dispatch.py:29`, `105-114`）。
  - **渠道级限流冷却**：`RATE_LIMITED` 直接锁 3600s（`dispatch.py:30`, `93-102`）。
  - 状态不是四态而是九态：not_added / needs_setup / unverified / ready / search_ready / needs_login / cooldown / needs_user_action / broken（`manage.py:219-245`）。

## 6. 【C1/C2】agent 循环与停止条件

- **没有 agent 主循环。** 它是被外部 Agent（Claude Code/Cursor/Codex…）调用的单次命令：`main()` 解析一次、执行一次、打印一行 JSON、退出（`runtime/cli.py:549-582`）。「一轮 = 一次模型工具调用」，模型→工具→再模型的循环在宿主 Agent 里，不在本仓库。
- 本仓库唯一的「循环」是**同一次动作内按序试后端**：`for label, method_name in backends:`（`dispatch.py:254-287`）。
- 停止条件：
  1. 总预算耗尽（`clock.remaining() <= 0` 即记 TIMEOUT 并 break，`dispatch.py:261-264`）；
  2. 命中终态错误集 `FINAL_CODES = {NOT_FOUND, BAD_INPUT, PLATFORM_BLOCKED, RATE_LIMITED, NEED_LOGIN, BUSY}` 立即 break，不再换后端（`result.py:32-33`, `dispatch.py:275-277`）；
  3. 后端全部试完；
  4. 显式 `--backend` 只跑指定后端（`dispatch.py:221-225`）。
- 没有 max_turns、没有预算金额、没有显式 done 信号。
- 循环状态持久化：不持久化「会话」，只持久化**证据与健康度**——`checks`/`codes`/`evidence`（带指纹，`manage.py:189-207`）、`cooldowns`、`backend_health`、`request_starts`（`dispatch.py:117-146`）。断了不能续跑，只能重放命令。

## 7. 【A6/A7】记忆

- **无 Agent 记忆**：没有 conversation/context 存储、没有向量库、没有 embedding、没有 TTL/老化/冲突消解/跨会话召回（全仓 grep 无 memory/vector/embedding 模块；`pyproject.toml:30-35` 依赖里也没有）。
- 它持久化的只有**机器状态**，不是知识：`state.json` 账本（`state.py:3-16`）、`config.yaml`（`config.py:100-104`）、会话目录 `~/.agent-reach/sessions/<tool>/`（`sessions.py:18-38`）、浏览器 `session.json` Cookie 快照（`browser.py:673-706`）。
- 结论：A6/A7 = **无**。可类比的只有「渠道登录态复用」，不是记忆（`session_reuse.py:91-134`）。

## 8. 【D1–D5】界面

- 技术栈：**没有前端**。全仓 124 个文件里 0 个 `.ts/.tsx/.js/.jsx/.vue/.svelte/.html/.css`（实测 glob），`docs/assets` 只有 logo/赞助商 SVG。
- 布局范式：CLI。设计原则写在模块 docstring：「Everything prints one JSON object to stdout so agents never parse prose; logs go to stderr. Exit code 0 = ok, 1 = error」（`runtime/cli.py:1-13`）。
- 状态可见性：面向 Agent 的 JSON（`envelope`，`result.py:116-142`）；面向人的只有 3 个命令的 `--text` 纯文本表格：`setup` 安装报告（`runtime/cli.py:326-340`）、`doctor` 渠道状态表（`runtime/cli.py:273-286`）、`check` PASS/FAIL 表（`runtime/cli.py:251-260`）。
- 主题/密度/多工作区：**无**。并发不是工作区，是「共享浏览器排队」（见第 9 段机制 3 与 `browser_binding.py:11-16`）。
- 结论：D1–D5 全 **无**（它是「给 Agent 用的无界面工具」，UI 缺失是设计选择，不是缺陷）。

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：声明式渠道清单 + 「有序后端链」自动降级
- **机制**：一个平台=一个类，声明 `actions`；每个 action 给一条 `(后端标签, 方法名)` 有序链；调度器按序试，遇可重试错误换下一个，遇终态错误立刻停，最终只回一份不泄露上游细节的信封。
- **位置**：清单 `channels/base.py:19-49`；调度 `runtime/dispatch.py:200-322`（核心循环 `254-287`）；终态集 `runtime/result.py:32-33`；例子 `channels/boss.py:36-53`（`opencli` → `boss-agent-cli` 双后端）。
- **为什么好**：解决了我们「一个能力要接 N 个供应商、每家一套错误码和脏输出」的问题。它的做法是把 **N×M 的适配爆炸**收敛为「一张表 + 一个调度器 + 一个错误枚举」，新增供应商只写方法、不改调度；且 `_pick_error` 明确规定「真错误优先于‘没装’」（`dispatch.py:182-187`），避免把配置问题误报成平台问题。
- **我们抄到哪**：我们的「多渠道/多供应商」适配层（A10）——落成 `providers/<name>.py` + 一个 `dispatch`，动作→后端链用配置而非 if/else。

### 机制 2：统一 JSON 信封 + 机器可执行错误提示（error.code → hint），并把「怎么用」写成 Agent 说明书
- **机制**：所有输出一个 `envelope`，错误只给 8 个 code，每个 code 配一句「Agent 下一步该做什么」的 hint；同时用 `channels` 命令输出完整 schema，并用 `SKILL.md` 教 Agent 何时该停手、不许重试。
- **位置**：信封 `runtime/result.py:116-142`；错误码与默认提示 `result.py:23-45`；异常映射 `result.py:64-82`；schema 输出 `runtime/cli.py:192-233`；Agent 指引 `skill/SKILL.md:36-53`（错误→动作表）、`skill/SKILL.md:101-105`（红线）。
- **为什么好**：直接解决「Agent 把工具报错读成一堆 prose、然后疯狂重试/换号」的经典事故。它的 hint 是**行为约束**（例如 `PLATFORM_BLOCKED`：「Stop automation…Do not switch backends or retry」，`result.py:37`；`RATE_LIMITED`：「respect retry_after_seconds and do not switch backends」，`result.py:42`）。这比「错误信息更清楚」强一个量级：它把**止损策略编码进返回值**。
- **我们抄到哪**：我们的工具结果协议与错误分类（A13/可观测性）——`{ok, code, hint, retry_after}` 固定字段 + 一份 `SKILL/工具说明` 教模型按 code 分支。

### 机制 3：后端健康账本（指纹失效 + TTL 暂停 + 全渠道冷却）+ 可暂停的动作预算时钟 + 共享浏览器排队
- **机制**：失败按 `(渠道, 动作, 后端)` 记一条健康记录，只存 code/时间/指纹（不存 query、结果、Cookie）；同一后端在 TTL 内直接跳过；平台限流则整渠道冷却 1 小时；同时并发靠「文件锁槽位」限流（同站 2、全局 4），排队时间不计入超时。
- **位置**：指纹 `manage.py:73-90`（版本+代码哈希+代理+端口+会话版本+依赖版本）；暂停/冷却/记账 `dispatch.py:83-131`；状态原子读改写 `state.py:69-95`；预算时钟 `clock.py:11-61`；槽位与排队 `browser_binding.py:11-16`, `51-154`（`query_slot` `127-143`）。
- **为什么好**：解决两个我们一定会踩的坑：(a)「上次能跑=现在能跑」的假阳性——它用**代码指纹**让换构建后旧验收自动失效（`manage.py:93-108`）；(b)「一台机器把平台打到封号/限流」——它把退避做成**跨进程、跨入口共享**的账本（`dispatch.py:93-102` 注释：a confirmed rate limit applies to every entry point and backend）。
- **我们抄到哪**：我们的重试/熔断层与并发闸门（A11/A10）——`backend_health` 表 + `cooldown` + 带暂停的 deadline clock + N 槽位文件锁。

### 补充：另外 3 条值得单独摘出来的小机制
1. **私有路径写盘安全**：拒绝任何符号链接组件、mkstemp 同目录、0600、fsync 目录、Windows 重试替换（`utils/paths.py:53-167`）——抄到我们的凭据/状态落盘。
2. **发布验收闸门**：tag 发布前必须有一份「真实 CLI 跑通、7 天内、源码 sha256 匹配、item_count>0」的验收清单，否则 `release.yml:38-39` 直接失败（`scripts/check_release_acceptance.py:25-68`）；允许带理由的 waiver（`release-acceptance.json` 的 `waived`）。
3. **URL/SSRF 防线**：`host_matches` 用 hostname 精确+子域匹配，防 `x.com.evil.test` 与 `x.com@evil.test`（`utils/url.py:99-121`）；转写下载前拒绝私有/保留/回环/link-local 及 `inet_aton` 简写（`transcribe.py:174-244`）。

## 10. 我们不该抄的

1. **静态注册表当插件系统**。`ALL_CHANNELS` 手写列表（`channels/__init__.py:24-39`）+ CLI `if/elif` 命令表（`runtime/cli.py:561-581`）。如果我们要第三方生态，这套是**反面教材**：没有发现、没有授权、没有版本协商、没有隔离；抄它只会得到「改宿源码才能加渠道」。
2. **同进程无隔离地跑渠道代码**。渠道能直接 import `state`/`browser_binding` 并改全局账本（`boss.py:72-74`）。我们若允许外部贡献者写渠道，必须先有 capability 边界（只给 `ctx.call_tool/http/browser`），否则一个渠道 bug 能污染全部状态。
3. **900–1000 行的平台胶水**。`browser.py`（947 行）/`manage.py`（1034 行）里塞满 Windows `.cmd` shim、CloakBrowser 回退、下载解压、端口占用、Cookie 逐域清理（`run.py:27-54`、`browser.py:328-356`、`729-769`）。这是它「无依赖、零安装」的代价；我们的形态（有运行时/有包管理）不该复制这份复杂度。
4. **`public_first` 的内容启发式判定**。用「文本<80 字且等于 title 就判空」「正则匹配登录墙」来决定公开网页是否可用（`public_web.py:30-45`）。这是补丁式判定，误判成本高；我们应显式区分「搜索结果/正文/评论」三种 scope，而不是靠字符串猜。
5. **只读红线 + 永不代登录**。是它的产品定位（`SKILL.md:101-105`），对我们「要发起外部动作」的场景是**限制而非能力**；可抄它的「用户亲手登录、我们只复用会话」模式（`session_reuse.py:1-5`），但不要抄「什么都只读」。
6. **MCP 注册改成改别人配置文件**。它历史上往 Cursor `mcp.json` 写 `agent-reach` 条目，后来专门写了退役清理与提示（`manage.py:765-769`，`tests/test_manage.py:803-842`）。这类「替用户改第三方配置」的做法我们不要碰。
7. **重流程的发布验收**。真实联网验收 + 7 天有效期 + 手工 waiver 对它（14 个易碎平台）是必要的，但对我们是过重流程；只抄「验收清单与源码指纹绑定」的思想，不抄逐动作 live test。

---

### 附：如果只读 5 个文件
`agent_reach/channels/base.py`（契约）→ `agent_reach/runtime/dispatch.py`（调度/降级/退避）→ `agent_reach/runtime/result.py`（信封/错误码）→ `agent_reach/skill/SKILL.md`（怎么教 Agent 用）→ `scripts/check_release_acceptance.py`（发布闸门）。
