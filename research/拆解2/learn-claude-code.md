# learn-claude-code 拆解（v2：只写「我们能抄什么」）

> 仓库：`shareAI-lab/learn-claude-code`（本地 `D:\refs\learn-claude-code`，git `448c75b`，pushed 2026-11-15）
> 读法：全部结论来自源码，行号以本地克隆为准（`s01..s17` 是**正典**，`agents/` 与 `docs/` 是作者标注的 legacy 轨，见 `README.md:173-177`、`README.md:393`）。

---

## 1. 定位与规模

一句话：这不是一个 agent 产品，而是一套**「从 0 到 1 手写 Claude-Code 式 agent harness」的 17 章课程**，每章一个可独立运行的 `code.py`，逐章加一层能力（循环→工具→权限→钩子→todo→子代理→技能→压缩→记忆→任务→后台→定时→团队→MCP→整合→workflow→goal）。

- 文件数：**417**（`Get-ChildItem -Recurse -File` 实测）。
- 主语言：**Python**（正典 `s01..s17/code.py` 共 17 个 + `agents/*.py` legacy 13 个）；`web/` 是 Next.js+TS 文档站（`web/package.json`）。
- 最近 push：**2026-11-15T13:41:46Z**；star **80,520**，fork **12,879**，MIT，`size` 6669（GitHub API `repos/shareAI-lab/learn-claude-code`，2026-11-17 取）。
- 依赖极薄：`requirements.txt:1-3` 只有 `anthropic>=0.25.0`、`python-dotenv>=1.0.0`、`pyyaml>=6.0`——**没有任何框架**，所有 agent 机制都是手写轮子。这正是它对我们有价值的原因。
- 证据：`requirements.txt`、`web/package.json`、`README.md:305-321`（17 章目录表）。

---

## 2. 架构骨架

### 2.1 顶层目录 → 职责

| 目录 | 职责 | 证据 |
|---|---|---|
| `s01_agent_loop/` … `s17_goal_loop/` | **正典**。每章一个目录：`code.py`（自包含可运行）+ `README{,.zh,.ja}.md` + `images/` | `README.md:173`、`README.md:305-321` |
| `agents/` | **legacy 轨**：12 个更短的旧版 + `s_full.py`（697 行整合版）。章节号与正典不一致，作者明说别混用 | `README.md:174-177`、`README.md:393` |
| `docs/` | legacy 文档（en/ja/zh） | `README.md:174` |
| `skills/` | 4 个真实技能：`agent-builder/`、`code-review/`、`mcp-builder/`、`pdf/`，每个 `SKILL.md` | `skills/*/SKILL.md` |
| `tests/` | 21 个 Python 测试（约 5.7k 行），CI 跑 `pytest` | `.github/workflows/test.yml`、`tests/*.py` |
| `web/` | Next.js 16 + React 19 + Tailwind 4 的**教学可视化站**（每章一个可视化组件 + 代码 diff + 时间线） | `web/package.json` |
| `.github/workflows/` | `ci.yml`（web tsc+build）、`test.yml`（pytest + web build） | 两文件实测 |

### 2.2 依赖方向 / 单向约束

- **章与章之间没有 import 依赖**：每个 `code.py` 只 import 标准库 + `anthropic` + `yaml`（`s07_skill_loading/code.py:22-39`、`s09_memory/code.py:11-20`）。它是 copy-forward（复制上一章再改），不是共享库——所以**不存在依赖图，也就没有单向约束**。
- 唯一一处显式「宿主 ← 扩展」的依赖：`s16_workflow_runtime` 用 `importlib` 懒加载 `s15_integrated_harness/code.py` 当 host（`s16_workflow_runtime/code.py:819-828`），再 monkey-patch `host.assemble_tool_pool` 把 `Workflow` 工具塞进宿主（`s16:800-816`）。**这是全仓唯一像「插件边界」的东西。**
- 唯一的「单一源 → 派生」：`web/scripts/extract-content.ts` 读 `s*/code.py` 与 `agents/`，生成 `web/src/data/generated/{docs,versions}.json`（`extract-content.ts:12-18`，`web/package.json` 的 `predev/prebuild` 自动跑）。文档站是派生物，代码是权威源。
- **没有 CI 脚本强制分层**；行为正确性靠 `tests/` + 每章 README 约束。

### 2.3 核心/插件边界：**不存在**

- 没有插件包、没有 npm 安装、没有禁用开关。可扩展的只有两处：**技能（`SKILL.md` 纯文本）** 和 **MCP 工具池（内存 mock）**。
- 因此别指望从这抄到「插件内核」；要抄的是它**把技能/工具接进循环的那几行接线**（见 3.9）。

---

## 3. 【A12】插件 / 扩展机制 —— 重中之重

> 先给结论：**learn-claude-code 没有「插件生态」**（无安装/禁用/市场/热插拔）。它有的是 **两条互不相干的扩展通道**：
> ① **技能（Skills）** = 磁盘目录里的 `SKILL.md`，启动时扫成目录，模型按需 `load_skill` 读全文；
> ② **MCP** = 运行时 `connect_mcp` 把外部工具并进工具池，命名 `mcp__server__tool`。
> 而我们最痛的点（A12 输 12 次）恰好是①——**它的技能机制只有 ~80 行，且接线方式极其可直接复用**。

### 3.1 技能清单长什么样（文件名 + 字段）

文件名固定 `SKILL.md`，YAML frontmatter 只要两个字段 `name` / `description`，其余是正文：

```yaml
# skills/pdf/SKILL.md:1-3
---
name: pdf
description: Process PDF files - extract text, create PDFs, merge documents. Use when user asks to read PDF, create PDF, or work with PDF files.
---
```
`skills/agent-builder/SKILL.md:1-10` 的 `description` 还用了 YAML 多行块（`|`），并把触发词（"create an agent"、"agent architecture"…）直接写进描述里——**描述本身就是触发条件**。

只有目录 + `SKILL.md`，没有 `plugin.json`、没有 `entry`、没有版本号。这是「最小可抄形态」。

### 3.2 怎么被发现（扫哪个目录、什么文件、什么字段）

正典 `s07_skill_loading/code.py` 的 `SkillLoader.scan()`，**行 89-113**：

- 目录：`WORKDIR / "skills"` —— `SKILLS_DIR = WORKDIR / "skills"`（`s07:46`）。
- 文件：`self.skills_dir.glob("*/SKILL.md")`，**只扫一层子目录**（`s07:95`）；并且检查 `manifest.resolve().is_relative_to(skills_root)` 防符号链接逃逸（`s07:96-98`）。
- 字段：`metadata.get("name")`，为空则回落目录名 `manifest.parent.name`（`s07:101-103`）；`metadata.get("description")`，为空则回落正文第一行（`s07:104-108`）。
- 存入 `self.skills[name] = {name, description, content}`（`s07:109-113`）——**content 是整份全文，扫描时就全读进内存**（这是它的省事做法，见 3.9 的差异）。

对比两种实现（都值得注意）：
- `s15_integrated_harness/code.py:748-773` `scan_skills()` 用 `iterdir()` + `directory/"SKILL.md"`，同样只一层，同样 name 回落目录名（`s15:763-765`）。
- legacy `agents/s05_skill_loading.py:74` 用 `rglob("SKILL.md")`（**递归**）——比正典更宽松。
- 对比我们自己 `tools/skills/loader.mjs:61-85` 的 `scan()`：同样 `readdirSync` 一层 + `SKILL.md`。

**答案：扫 `<workdir>/skills/*/SKILL.md`，取 frontmatter 的 `name` + `description`；一层目录，不递归。**

### 3.3 怎么校验

**s07 几乎没有校验**：frontmatter 解析失败就 `{}`（`s07:81-87`），name/description 都有回落，**不会拒绝任何技能**。它只在 `load()` 时对未知名字报错并列出可选项（`s07:123-128`）。

对照：我们的 `tools/skills/loader.mjs:39-54` `validateSkill()` 反而更严——强制 `name`+`description`、强制 `name==目录名`、正文 >12KB 给 WARN、重复 name 拒绝。**所以在「校验」这一环我们不该抄它，我们已更强；该抄的是它的接线。**

### 3.4 怎么装载：不是动态 import，是「读文本 → 塞 tool_result」

- 技能**不 import、不执行**。`SKILL_LOADER.load(name)` 只是 `return skill["content"]`（`s07:123-126`）。
- 它被挂成一个普通工具 `load_skill`（`s07:220-221` 定义，`s07:230` 注册 `"load_skill": SKILL_LOADER.load`）。
- 模型调用 `load_skill("pdf")` → `execute_tool`（`s07:333-345`）→ 返回全文作为 `tool_result` → 追加进 messages（`s07:369-377`）。**全文进的是对话消息，不是 system prompt。**

### 3.5 技能内容是「注入 prompt」还是「变成工具」？—— **两段式，都要**

这是本题最关键的一问，答案在 `s07:134-144` + `s07:220-221`：

1. **目录（name + 一句话 description）常驻 system prompt**：`build_system_prompt()` 返回
   `"Skills available:\n{catalog}\n\nUse load_skill to read the full instructions when a skill applies."`（`s07:134-141`，catalog 拼装见 `s07:115-121`）。`SYSTEM = build_system_prompt()` 在 import 时定一次（`s07:144`）。
2. **正文不进 prompt，变成工具结果**：只有模型主动 `load_skill` 才返回全文（`s07:123-126` + `220-221`+`230`）。

> **对我们的直接结论**：技能既不是「全量塞进系统提示」，也不是「编译成多个工具」，而是 **catalog 常驻 + 正文按需经 tool_result 注入**。我们 `tools/skills/loader.mjs` 已经实现了 `list()`（只给 name+description，`:90-92`）和 `load()`（懒读正文，`:94-100`）——**缺的正是这两处接线：把 `list()` 拼进 system prompt、把 `load()` 注册成 `load_skill` 工具。** 这两步在 s07 里一共不到 15 行。

legacy 版把它包了一层 `<skill name="…">…</skill>`（`agents/s05_skill_loading.py:105-110`），更利于模型识别边界；s07 正典返回裸文本。

### 3.6 贡献点：插件能往宿主里加什么

- 技能通道：加 **1 个工具** `load_skill`（`s07:220-221`）。仅此。
- MCP 通道：加 **N 个工具** `mcp__{server}__{tool}`，并整体并进工具池（`s14:328-368`）。
- workflow 通道：往宿主工具池 **append 一个 `Workflow` 工具**，且不改宿主 dispatch 循环（`s16:800-816`）。

**没有**命令 / 面板 / 路由 / 中间件 / 设置页。也没有我们 kernel 里那套 `['commands','panels','verifiers']` 白名单（对比 `tools/plugin/kernel.mjs:22`）。

### 3.7 隔离：插件拿得到宿主内部对象吗？能力怎么限

- MCP 工具名统一规整，非法字符替换成 `_`，空名报错：`normalize_mcp_name()`（`s14:213-218`）。
- 前缀 `mcp__{safe_server}__{safe_tool}`，长度 >64 直接拒绝（`s14:344-346`）；前缀重名（归一化后撞名）报冲突（`s14:348-352`）。
- **授权来自宿主配置，不来自 server 自述**：`MCP_HOST_POLICY`（`s14:205-210`），注释明确 "Authorization comes from host configuration, never server descriptions."（`s14:204`）。未知工具默认 `"confirm"`（`s14:363-365`）。
- 但**没有进程隔离**：MCP 是**同进程 mock**（`MCPClient` 直接持 `handlers` 字典，`s14:170-197`），工具 handler 就是 `lambda`，拿得到同进程任何东西。

### 3.8 热插拔：能装/卸/启用/禁用吗？状态存哪

- **不能。** 
  - `connect_mcp(name)` 只能「加」，且 add 后再 connect 直接返回 already connected（`s14:289-296`）；**没有 disconnect/disable**。
  - 技能在**模块 import 时就扫死了**：`SKILL_LOADER = SkillLoader(SKILLS_DIR)`（`s07:131`）、`scan_skills()`（`s15:776`）在顶层执行——改技能要重启进程。
  - 状态：技能在内存 `self.skills` dict，MCP 在内存 `mcp_clients` dict（`s14:200`）——**都不落盘**，进程一退全没。

### 3.9 对我们 `tools/plugin/kernel.mjs` 的逐项对齐（该补哪）

| 能力 | learn-claude-code | 我们 `tools/plugin/kernel.mjs` | 结论 |
|---|---|---|---|
| 发现 | `*/SKILL.md` 一层（`s07:95`）+ `discover()` 递归探 `plugin.json` | `discover()` 有界递归找 `plugin.json`（`kernel.mjs:194-236`，maxDepth=3） | 我们更全；**沿用** |
| 校验 | 几乎无（`s07:81-87`） | `validateManifest`（`kernel.mjs:25-53`）白名单 + `topoSort` 环检测（`61-92`） | 我们更强；**沿用** |
| 装载 | 读文本当 tool_result（`s07:123-126`） | `import()` 执行 `entry` 的 `activate(ctx)`（`kernel.mjs:133-147`） | 两条都留：**技能走「文本」，代码插件走「activate」** |
| 贡献点 | `load_skill` / `mcp__*` / `Workflow` | 白名单 `commands/panels/verifiers` 但 **`contribute()` 无真实调用方**（死代码） | **抄 s07/s14/s16 的「真把贡献点并进工具池」做法** |
| 隔离 | 名字规整 + host policy，无 OS 隔离（`s14:213-218,205-210`） | `run.mjs` 用 cap 前缀做「能力声明检查」（`run.mjs:37-94`） | 我们更好；**沿用** |
| 热插拔 | 无 | 无（我们也没有 enable/disable/市场） | **两边都缺** → 这是 A12 真正要补的（见第 9 段第 1 条 + 第 10 段） |

---

## 4. 【A13】MCP / 工具接入

- **MCP client 在哪**：`s14_mcp_plugin/code.py:170-197` 的 `class MCPClient`，全文 553 行。**它是同进程 mock**，不是真协议：注释自称 "Small in-process stand-in for MCP tools/list and tools/call"（`s14:171`）。两个 mock server `docs`（`s14:221-247`）、`deploy`（`s14:250-280`），由 `MOCK_SERVERS` 注册（`s14:283-286`）。
- **怎么起 server**：没有起子进程。`connect_mcp(name)` 从 `MOCK_SERVERS` 取工厂函数**在内存里 new 一个 `MCPClient`**（`s14:289-302`）。
- **工具列表怎么暴露给模型**：`assemble_tool_pool()` 每次调用都把 builtin + 每个已连 server 的工具拼成 `tools` 列表（`s14:328-368`）；`agent_loop` 每轮都 `assemble_tool_pool()` 重新取（`s14:491`），所以 connect 后下一轮工具就多出来。
- **有没有 UI 管理 MCP server**：**没有**。只有模型可调的 `connect_mcp` 工具（`s14:309-317`，enum 写死 `["docs","deploy"]`）。无增删改、无启用禁用、无设置页。
- **工具调用结果怎么回填**：MCP 工具 handler 是 `make_mcp_handler(server, tool)` 闭包（`s14:323-325`），结果 `str(handler(**args))` 直接作为 `tool_result` 内容（`s14:518-528`）。
- 审批：`permission_hook` 里对 `block.name.startswith("mcp__")` 查 `mcp_tool_policies`，非 `allow` 就 `input()` 问（`s14:423-428`）。

> 我们能抄的是**命名空间方案**（`mcp__server__tool` + 64 字符上限 + 归一化撞名检测 + host 侧 policy）——这套在我们的 MCP 接线上是现成可搬的；**别抄 mock**。

---

## 5. 【A11】调度 / 后台任务

### 5.1 定时任务（`s12_cron_scheduler/code.py`，792 行）

- **怎么定义**：`CronJob` dataclass —— `id / cron / prompt / recurring / durable / pending_delivery / last_fired`（`s12:269-277`）。工具 `schedule_cron(cron, prompt, recurring=True, durable=True)`（`s12:595-611`）。
- **怎么存**：内存 `scheduled_jobs` dict + `cron_queue` 列表 + `cron_lock`（`s12:280-282`）。durable 的落盘到 `.scheduled_tasks.json`（`s12:45`）。**写盘是原子的**：先写 `*.pid.tid.tmp` 再 `os.replace`（`s12:382-388`）——这点值得抄。
- **cron 解析**：自己写的五段匹配 `cron_matches()`（`s12:299-321`）+ 校验 `validate_cron()`（`s12:356-372`，支持 `*` / `*/n` / `a,b` / `a-b`）。
- **谁来 tick —— 这是本题核心**：**进程内 daemon 线程**，不是外部 cron/systemd：
  ```python
  # s12:644-646
  def cron_scheduler_loop(stop_event = RUNTIME_STOP):
      while not stop_event.wait(1.0):
          poll_due_jobs(datetime.now())
  ```
  每 1 秒轮询一次（`wait(1.0)`）。`poll_due_jobs` 命中就把 job 标 `pending_delivery=True` 并推进 `cron_queue`（`s12:497-508`），并用 `minute_marker = "%Y-%m-%d %H:%M"` 防同一分钟重复触发（`s12:498,502`）——**幂等**。
- **触发怎么落到 agent**：**不另起 agent，直接在下一轮 loop 入口消费队列**：
  ```python
  # s12:649-654
  def agent_loop(messages, context=None):
      fired = consume_cron_queue()
      scheduled_start = len(messages)
      for job in fired:
          messages.append({"role": "user", "content": f"[Scheduled] {job.prompt}"})
  ```
  即「到点 → 队列 → 下轮把 job.prompt 当 user 消息注入 → 跑一轮 agent」。
- **谁来驱动「跑一轮」**：`queue_processor_loop`（另一个 daemon 线程，`s12:727-735`，每 0.2s 检查队列 + 拿 `agent_lock` 非阻塞锁）。锁的设计：交互输入走 `agent_lock`（`s12:789`），后台也走同一把锁，避免两个线程同时驱动一个 agent。
- **ack / 失败回滚**：assistant 首轮返回后才 `acknowledge_cron_jobs`（一次性 job 完成后删除，recurring 清 `pending_delivery`，`s12:518-545`）；若首轮 LLM 抛错则 `del messages[scheduled_start:]` 并 `restore_cron_jobs` 把 job 塞回队列（`s12:666-671` + `548-558`）。
- **常驻怎么起**：`start_runtime_threads()` 起两个 daemon 线程（`s12:738-759`），**在 `if __name__ == "__main__":` 里调一次**（`s12:777`）；`stop_runtime_threads()` 统一 `event.set()` + join（`s12:762-771`）。
- **超时/四态**：cron 层没有 PASS/FAIL/UNKNOWN 四态（那是 **我们** scheduler 的纪律，`tools/schedule/scheduler.mjs:14-16,129-176`）。它只有 `pending_delivery` + `last_fired`。**重试**：仅「LLM 报错则回滚重投递」这一种（`s12:666-671`），没有指数退避。

> **对我们的直接结论（A11）**：我们的 `tools/schedule/scheduler.mjs:308-334` 的 `daemon` 循环是**对的**（`setTimeout(loop, interval)`），问题只是**没人启动它**（我们自己的 `tick.mjs:1-8` 注释也承认「daemon 没人启动，只有 dev server 的常驻 tick 和 POST /api/scheduler/tick」）。s12 给的答案就是：**把调度线程和「执行一轮 agent」放进同一个进程，在进程入口 `start_runtime_threads()` 起，由队列把 job 交接到 loop 入口注入**。这正是我们缺的那一段「谁来 tick + tick 完干什么」。

### 5.2 后台任务（`s11_background_tasks/code.py`，547 行）

- `BackgroundManager`（`s11:348-424`）：`start()` 起 daemon `threading.Thread`（`s11:372-378`），`bash` 工具加 `run_in_background` 参数（`s11:202-208`）。
- 立即返回占位 `"[Background task bg_0001 started] … collected on a later turn"`（`s11:478-481`）。
- 下一轮 loop 开头 `inject_background_results(messages)`（`s11:495`）把完成的任务包成 `<task_notification><task_id/><status/><summary/></task_notification>` 注入（`s11:403-424`）。
- 进程组清理：`atexit` + `SIGTERM` 时杀整棵进程树（`s11:94-107`），Windows 走 `terminate()/kill()`（`s11:71-83`）。**这套跨平台杀树逻辑我们该抄**（我们 scheduler 已经踩过 Windows `spawnSync timeout` 不杀孙进程的坑，`scheduler.mjs:124-128`）。

---

## 6. 【C1/C2】agent 循环与停止条件

### 6.1 主循环在哪

- 最纯粹版：`s01_agent_loop/code.py:96-126`（`while True` 在 `97`，模型调用 `98-101`，无 tool_use 即 `return` 在 `110-111`）。这就是「一轮 = 模型 → 工具 → 再模型」的最小定义。
- s02 起把工具派发抽成 `TOOL_HANDLERS` 字典（`s02:153-156`），循环体不变（`s02:163-185`）——**它刻意证明：加工具不改循环**。
- 集成版：`s15_integrated_harness/code.py:3155-3277`（注入定时/后台 → 准备上下文 → 调模型 → 执行工具 → 追加）。

### 6.2 一轮的定义

模型返回 assistant `content` → 收集 `tool_use` blocks → 逐个 `execute_tool` → 拼 `tool_result` 作为一条 user message → 回到模型。见 `s01:104-126`、`s07:348-377`。

### 6.3 停止条件有几种？分别在哪几行（**逐条核过**）

1. **无 tool_use 即停（主停止条件）**：`s01:107-111`；`s02:171-175`；`s03:227-231`；`s07:359-361`（此处在停前还会跑 Stop hook，见下）；`s12:681-684`；`s13:1819-1825`；`s14:511-516`；`s15:3220-3224`（停前 `remember_after_turn`）。
2. **Stop hook 反向「续跑」**（不是停，而是拦停）：Stop 回调返回非 None 就把它当 user 消息 `continue`——`s04:235-240`；`s07:362-367`；`s09:746-753`；`s12:684-689`。
3. **最大轮数 max_turns**：
   - 子代理写死 30：`s06:280`（`for _ in range(30)`），到顶返回 `"Subagent stopped after 30 turns…"`（`s06:312-313`）。
   - goal session 的全局 `max_turns`：`s17:684-690`（`turns >= self.max_turns` → `status="max_turns"`）。
4. **max_tokens 触顶 → 升级重试 → continuation 兜底**：`s15:3203-3215`：第一次 `stop_reason=="max_tokens"` 把 `max_tokens` 从 8000 升到 16000（`s15:68-69`）重试；再触顶则追 `CONTINUATION_PROMPT`（`s15:77`）最多 `MAX_RECOVERY_RETRIES=2` 次（`s15:72`），否则 return。
5. **目标评估器（goal loop）**：`s17:360-428` `evaluate_after_turn` 返回 `StopDecision`，共 6 个分支：
   - 无 goal → `allow`（`s17:365-366`）
   - 后台还在跑 → `defer`（`s17:367-370`）
   - 达成 → `achieved`（`s17:391-400`）
   - 判定不可能 → `failed`（`s17:402-411`）
   - 未达成但可继续 → `block`（`s17:413-419`）
   - 连续 block 超过 `block_cap=8` → `limit`（`s17:420-427`，常量 `s17:45`）
   agent 侧对 `block` 的处理：追加 `"[Goal still active] … Continue working"` 再 `continue`（`s17:744-757`）。
6. **预算 / 上限**（workflow 运行时）：`Budget.add` 超预算抛 `WorkflowInputError`（`s16:379-392`）；`ExecutionLimits.claim_agent` 超 `AGENT_CAP=1000` 抛错（`s16:44,424-434`）；`workflow()` 嵌套深度只允许 1 层（`s16:541-542`）；并发 `CONCURRENCY=8` 信号量（`s16:45,429`）。
7. **队友的 idle / stop**：`TeammateRuntime.work()` 返回 `"continue"/"idle"/"stop"`（`s13:1277-1326`）；`run()` 里 `while state != "stop"`，idle 时 `wait_for_work()`（`s13:1362-1368`）；收到合法 shutdown → `"stop"`（`s13:1248-1261`）。
8. **LLM 异常 → 记一条错误文本后 return**：`s12:666-671`；`s13:1806-1816`；`s14:499-508`。

> 统计：**至少 8 类可判定停止条件**。最容易忽略的是第 2 类——**Stop hook 是「可否决停止」的钩子**，这给了我们「停止条件可插拔」的范式（C2 正是「停止条件可判定」，我们目前只有 `maxTurns` 透传，见 `apps/vouch-web/.../AgentAPI.ts:65`）。

### 6.4 循环状态怎么持久化（断了能续吗）

- **默认不能**：`messages` 是内存 list，进程退出即丢（所有章节都是 `history = []` 起，`s01:134`）。
- **能续的只有三处**：
  - 定时任务：`.scheduled_tasks.json`（`s12:45,375-423`）。
  - 任务图：`.tasks/task_*.json`（`s10:70,84-199`）。
  - workflow journal：`<runId>.journal.jsonl`，按语义 key 缓存每个 agent 结果，`resume` 时命中即跳过（`s16:329-376`，尤其 `360-372`）。**这是全仓最值得抄的「断点续跑」实现**。

---

## 7. 【A6/A7】记忆

- **存储形态：文件，不是 DB/向量。** 目录 `.memory/`（`s09:37`），每条记忆一个 `*.md`，外加索引 `MEMORY.md`（`s09:38`）。
- **记录格式**：frontmatter `name/description/type` + 正文（`s09:147-153`）；类型闭集 `("user","feedback","project","reference")`（`s09:50`）。
- **索引生成**：`rebuild_memory_index()` 扫 `*.md` 重新拼 `- [name](file) - description`（`s09:171-190`）。
- **写入门槛（我们的 A7 可借）**：`should_store_memory()`（`s09:114-145`）：
  - 只收 `scope=="persistent"`、type 合法、name/desc/body 非空（`s09:118-127`）；
  - **临时信息拒收**：命中 `TEMPORARY_MEMORY_MARKERS`（"this session"/"本次会话"/"暂态"…，`s09:51-71`）就拒（`s09:130-131`）；
  - **去重**：slug 相同、归一化 description 相同、归一化 body 相同都拒（`s09:133-144`）。
- **跨会话召回**：`select_relevant_memories()` 把「记忆 catalog（序号+name+description）」发给模型，**让模型返回相关序号 JSON 数组**（最多 5 条，`s09:286-323`）；模型失败时退回关键词匹配 `keyword_memory_selection()`（`s09:271-284`）。召回正文受 `RECALL_CHAR_LIMIT=20000` 字符预算（`s09:72,325-335`）。
- **注入**：`build_system()` 把 catalog + 本次相关记录拼进 system（`s09:337-355`）。
- **抽取/巩固**：Stop 时 `extract_memories()`（`s09:392-454`）让模型从对话抽 JSON；记录数到 `CONSOLIDATE_THRESHOLD=10`（`s09:73`）触发 `consolidate_memories()` 合并去重、应用较新修正、删无用、最多留 30 条（`s09:456-543`）——且整段**有快照回滚**（失败时先把原文件删了再从 `snapshot` 写回，`s09:499-534`）。
- **A7 的缺口（对我们而言）**：**没有溯源（source/by/时间戳）**、**没有 TTL/过期**、**没有 supersede 链**——`consolidate` 是「整库重写」，旧值不可查。我们的 `tools/memory/store.mjs` 已经做了 source/supersede/expiresAt 三件套，**这块我们比它强，别抄它的记忆治理**；只抄它的「临时信息拒收 marker 表」和「catalog 序号选择」两个小技巧。

---

## 8. 【D1–D5】界面

> 重要前提：`web/` 是**教学文档站**，不是 agent 工作台。别把它的布局当我们的 WorkbenchScene 基座抄。

- **技术栈**：Next.js **16.1.6** + React **19.2.3** + Tailwind **4** + framer-motion + lucide-react（`web/package.json` 依赖段）。i18n 自研（`web/src/lib/i18n.tsx`，messages `en/zh/ja.json`）。
- **布局范式（D1 部分）**：`header.tsx`（152 行，顶部导航 + 语言切换 + 主题按钮）+ `sidebar.tsx`（61 行）+ 内容区 + `tabs.tsx`（33 行）。**没有可拖拽分栏 / 可停靠面板 / 多工作区**。
- **信息密度（D2 部分）**：每章一个可视化组件（`visualizations/s01-agent-loop.tsx` 381 行 … `s15-integrated-harness.tsx` 394 行）、`code-diff.tsx`（189）、`timeline.tsx`（195）、`mechanism-flow.tsx`（276）、`source-viewer.tsx`（94）。密度高但面向「讲解」。
- **状态可见性（D3 部分）**：`agent-loop-simulator.tsx`（113）+ `simulator-controls.tsx`（92）+ `useSteppedVisualization.ts`（73）能逐步播放「当前到哪一步」；`execution-flow.tsx`（378）画执行流。但**没有「花了多少 token / 还差什么」的实时账本**。
- **多场景 / 多工作区（D4 部分）**：有 3 语言 + 多路由（`[version]`、`compare`、`timeline`、`layers`，见 `web/src/app/[locale]/(learn)/…`），但「多工作区」= 文档里的多视角，不是产品意义的多 workspace。
- **主题系统（D5 有）**：CSS 变量 + `.dark` 类切换（`web/src/app/globals.css:3-23` 定义 `--color-bg/--color-text/--color-border` 双套；`web/src/hooks/useDarkMode.ts:1-22` 用 `MutationObserver` 监听 `.dark` 类）。另外 `useSvgPalette()` 给了明暗两套 SVG 配色（`useDarkMode.ts:31-64`）——**这个「图表明暗双主题 token」的做法值得抄进我们的可视化**。
- 结论：D1/D2/D3/D4 只能算「部分」，D5 可算「有」。

---

## 9. ⭐ 最值得抄的 3 条机制（全文最长段）

### 9.1 机制一：**技能两段式注入（catalog 常驻 prompt + 正文按需 tool_result）**

**位置**：
- `s07_skill_loading/code.py:59-128`（`SkillLoader`：`scan` 89-113、`catalog` 115-121、`load` 123-128）
- `s07_skill_loading/code.py:134-144`（`build_system_prompt` 把 catalog 拼进 system，`SYSTEM = build_system_prompt()`）
- `s07_skill_loading/code.py:220-221` + `224-231`（把 `load_skill` 注册成工具 → `SKILL_LOADER.load`）
- 强化版：`s15_integrated_harness/code.py:748-792`（`scan_skills` / `list_skills` / `load_skill`）+ `s15:859-860`（prompt 里拼 `"Skills catalog:\n" + list_skills()`）

**为什么好**：这正是我们 A12「输 12 次」的卡点形态。我们 `tools/skills/loader.mjs` 已经写好了 `list()`（只给 name+description，`:90-92`）和 `load()`（懒读正文，`:94-100`），**但全仓没有一处把它们接进 agent**——`createSkillLoader` 只被 `tools/workbench/export-capabilities.mjs:17` 和 `prototype/agent-ui/verify-skills.mjs:7` 调用（都是导出/自测），**模型根本看不到技能目录，也没有 `load_skill` 工具**。于是「技能生态」= 有文件、没入口。s07 用不到 15 行代码解决了「目录怎么进 prompt」「正文怎么进上下文」这两个我们一直没接的问题，而且**天然省 token**（目录只占每技能一行，正文按需才进对话）。

**我们抄到哪**：
1. `tools/skills/loader.mjs`：已有 `list()`/`load()`，**无需改**；最多把 `parseFrontmatter` 扩成支持 YAML 多行块（s07 用 `yaml.safe_load`，`s07:82`），因为我们目前只认 `key: value`（`loader.mjs:31-34`）。
2. **新增/改** 我们 agent 运行时组装 system prompt 的地方：把 `loader.list()` 渲染成 `"Skills catalog:\n- name: description\n…\nUse load_skill(name) when a skill is relevant."` ——直接照 `s15:859-860` + `s07:134-141`。
3. **新增** 一个 `load_skill` 工具定义 + handler（`{name}` → `loader.load(name).body`），照 `s07:220-221`+`230`。若我们工具注册在 `tools/dispatch`/`tools/plugin`，把 `load_skill` 作为内建工具注册进同一张 handler 表。
4. **目标文件（精确）**：`tools/skills/loader.mjs`（补 `catalog()` 方法）+ 我们 agent loop 的 prompt 组装处 + 工具注册表；对应把 `createSkillLoader` 的调用点从「只给 verify 用」提到「运行时装配」。
> 一句话：**技能不该是「目录里的 Markdown」，应该是「prompt 里的一行 catalog + 一个 load_skill 工具」**。s07 就是这么干的，照抄即可。

### 9.2 机制二：**定时任务的「进程内 daemon 线程 + 队列交接」触发循环**

**位置**：
- 轮询线程：`s12_cron_scheduler/code.py:644-646`（`cron_scheduler_loop`，`while not stop_event.wait(1.0): poll_due_jobs(now)`）
- 到点入队（幂等 minute marker）：`s12:497-508`；消费：`s12:511-515`
- **交接到 agent**：`s12:649-654`（`agent_loop` 开头 `consume_cron_queue()` 并把 `job.prompt` 追加成 `"[Scheduled] …"` user 消息）
- **谁驱动跑一轮**：`s12:727-735`（`queue_processor_loop`，0.2s 轮询 + 非阻塞拿 `agent_lock`）
- **a​ck/回滚**：`s12:518-545`（ack）、`s12:548-558`（restore）、`s12:666-671`（LLM 报错回滚）
- **启动/停止**：`s12:738-759`（`start_runtime_threads` 起 2 个 daemon）、`s12:762-771`（`stop_runtime_threads`）、`s12:777`（进程入口调 `start_runtime_threads()`）
- 原子落盘：`s12:375-389`

**为什么好**：我们的 A11 卡点**不是 cron 解析**（我们的 `tools/schedule/scheduler.mjs:49-111` 已实现五段解析 + `nextRun`；`scheduler.mjs:129-176` 还实现了四态执行），**而是「谁在按时间触发它」**——我们自己的 `tools/schedule/tick.mjs:1-8` 注释白纸黑字写着：「`scheduler.mjs:308-334` 的 daemon **没人启动**……也就是 cron 解析器是真的，但**没有任何进程在按时触发它**」，现在只有 dev server 的常驻 tick 和 `POST /api/scheduler/tick`。s12 给的完整答案是一条**不依赖外部 cron/systemd 的进程内闭环**：scheduler 线程（poll→enqueue）+ queue-processor 线程（拿锁→跑一轮 agent）+ loop 入口消费队列注入消息 + assistant 首轮后 ack + 报错回滚重投。**这正好补上我们「daemon 只在 dev server 里跑」的洞**：把 tick 循环搬进 agent 主进程，并在进程入口拉起。

**我们抄到哪**：
1. `tools/schedule/scheduler.mjs`：已有 `matches/parseCron/runJob`，**保留**；把它的 `daemon`（`308-334`）抽成 `schedulerLoop(stopEvent)`（照 `s12:644-646`，把 `setTimeout` 改成 `while(!stopEvent) await sleep`，语义一致即可）。
2. **新增** `tools/schedule/queue.mjs` 或直接在 `scheduler.mjs` 加：`pendingQueue` + `pollDueJobs()`（照 `s12:497-508`，保留 `lastRunMinute` 幂等，我们已有 `scheduler.mjs:300,327` 的 `lastRunMinute`）+ `consumeQueue()` + `ackQueue()` + `restoreQueue()`（照 `s12:511-558`）。
3. **改** 我们的 agent 执行入口（前端服务层 `apps/vouch-web/src/web-ui/src/infrastructure/api/service-api/AgentAPI.ts` 背后的 turn 启动处，或我们工具的 dispatch）：**在每轮 turn 开头 `consumeQueue()` 并把 job.prompt 注入成 user 消息**（照 `s12:649-654`），turn 成功后 ack、失败回滚。
4. **改** 进程启动处：`startRuntimeThreads()`（scheduler 线程 + queue-processor 线程，daemon），在应用 boot 时调一次（照 `s12:738-759,777`），**不再依赖 dev server**。
> 一句话：**把「tick 循环」和「跑一轮 agent」放进同一个进程、用队列交接**。我们的 cron 解析和执行都对了，缺的就是这一段 60 行左右的编排。

### 9.3 机制三：**可判定的停止条件族（尤其 Stop hook 可否决 + max_tokens 升级 + goal 评估器）**

**位置**：
- 主停止（无 tool_use）：`s01:107-111`
- **Stop hook 可否决停止（返回非空则续跑）**：`s04:235-240`、`s07:362-367`、`s09:746-753`
- 子代理 30 轮上限：`s06:280` + `312-313`
- max_tokens 升级 + continuation 兜底：`s15:3203-3215`（常量 `s15:68-69,72,77`）
- goal 评估器 6 分支 + block_cap：`s17:360-428`（常量 `s17:45`）、agent 侧 `continue`：`s17:744-757`
- 预算/上限：`s16:379-392`（Budget）、`s16:424-434`（AGENT_CAP）、`s16:541-542`（深度）

**为什么好**：我们的 C2 现状是「只有 `maxTurns` 透传」（见 `apps/vouch-web/.../AgentAPI.ts:65` 的 `maxTurns?: number`），也就是说循环只有「跑够 N 轮」一个刹车。learn-claude-code 把「停不停」拆成**一族可组合的判据**，而且最关键的是 **Stop hook 的语义是「可否决」**：模型说没工具要停了，Stop 回调仍可返回一段文本把 loop 拉回（`s04:235-240`）——这让「目标未达成不许停」变成**在循环外挂一个评估器**，而不是改循环本身。`s17` 的 goal 评估器就是用它实现的：未达成 → 返回 `block` → 追加 `"[Goal still active] … Continue working"` → `continue`（`s17:744-757`）。同时它给了**刹车兜底**：连续 block 8 次强制 `limit`（`s17:420-427`），避免「永远停不下来」。再叠 `s15` 的 `max_tokens` 升级 + continuation（`3203-3215`），就是一套**既不会半路断、也不会死循环**的停止策略。

**我们抄到哪**：
1. 我们的 agent loop（前端背后真正的 turn 执行处 / 或 `tools/dispatch` 的循环）：把「`if not tool_use: return`」改成「`if not tool_use: 依次跑 Stop 钩子；任一返回非空则 append 该文本并 continue`」，照 `s04:235-240`+`s07:362-367`。
2. **新增** 一个 `StopPolicy`/`Guard` 模块（可叫 `tools/dispatch/stop.mjs`）：聚合三类判据——`maxTurns`（已有）+ `maxTokensEscalate`（照 `s15:3203-3215`，8000→16000→continuation×2）+ `goalEvaluator`（照 `s17:360-428`，含 `block_cap` 兜底）。
3. **改** `AgentAPI.ts` 的 `SessionConfig`（`apps/vouch-web/src/web-ui/src/infrastructure/api/service-api/AgentAPI.ts:58-69`）：`maxTurns` 旁边加 `goal?: string`、`maxTokensEscalate?: boolean`、`stopBlockCap?: number`，把停止策略从「一个数字」扩成「一组可判定条件」。
4. 若要「停了还能续」：照 `s16:329-376` 的 journal（语义 key → 结果缓存 → resume 命中跳过）给 turn 级加断点。
> 一句话：**把停止条件从「maxTurns 一个数」升级成「Stop 钩子可否决 + 多判据 + block_cap 兜底」**，s01/s04/s15/s17 四段拼起来就是完整答案。

### 9.4 三条的落地顺序、改动面与验收标准（可直接开工）

**顺序理由**：① 技能接线是**纯新增**（只加 prompt 一段 + 一个工具），零风险、当天可验证，先做把 A12 从「有文件没入口」变成「模型真能用」；② 调度闭环**独立于技能**（只依赖「往 messages 注入一条 user 消息」这个我们已经有的能力），第二步做，直接消灭「daemon 只在 dev server 跑」；③ 停止条件要**动主循环**，风险最高，最后做，且必须带 `block_cap` 兜底。

| # | 机制 | 改动文件（我们的） | 新增 / 改动 | 可复算验收断言 | 风险 |
|---|---|---|---|---|---|
| 1 | 技能两段式注入 | `tools/skills/loader.mjs`（补 `catalog()`）、agent prompt 组装处、工具注册表 | 新增 `catalog()` + `load_skill` 工具；prompt 拼 catalog（照 `s07:134-141`/`s15:859-860`） | ① 构造 2 个技能目录，system prompt 里必须出现两行 `- name: description`；② 调 `load_skill(name)` 返回正文全文、且等于文件 body；③ 未知 name 报错并列出可选项（照 `s07:127-128`） | 低（纯新增，不动循环） |
| 2 | 定时任务进程内闭环 | `tools/schedule/scheduler.mjs`（抽 `schedulerLoop` + queue 三件套）、turn 启动处、应用 boot 处 | 新增 `pollDueJobs/consumeQueue/ackQueue/restoreQueue` + 两个 daemon；turn 开头注入 `[Scheduled] …` | ① 注入一个「每分钟」job，跑 90s 内必须恰好触发 1 次（幂等 minute marker，照 `s12:502`）；② 首轮 LLM 抛错时 job 必须回到队列（照 `s12:666-671` 断言队列非空）；③ 杀掉 daemon 后不再触发（证明退出干净，照 `s12:762-771`） | 中（多线程/多进程时序） |
| 3 | 停止条件族 | agent loop、新增 `tools/dispatch/stop.mjs`、`AgentAPI.ts:58-69` | 改「无 tool_use 即 return」为「先跑 Stop 钩子」；加 `maxTokensEscalate` + `goalEvaluator` + `stopBlockCap` | ① Stop 钩子返回文本时循环必须 `continue` 而非 return（照 `s04:235-240` 单测）；② `max_tokens` 触发两次后必须走 continuation 且最终 return（照 `s15:3203-3215`）；③ goal 连续 block 到 cap 必须返回 `limit` 而不是无限续（照 `s17:420-427`） | 高（改主循环，必须有 cap 兜底） |

### 9.5 三条的共同点（为什么能一起抄、且不会互相打架）

- **都是「在循环边上挂东西」，不改循环主体**：技能挂 prompt+工具、定时挂「入口注入队列」、停止挂 Stop 钩子。s01 的 `while True` 一行都不用重写（`s01:96-126`）。
- **都「可判定」**：catalog 进没进 prompt 可断言、队列消费没消费可断言、停止原因可枚举（`StopDecision.action`，`s17:85-88`）。这正好对上我们 C2「停止条件可判定」和 C3「独立可复算」的要求。
- **都零新依赖**：不需要引入任何框架，纯在现有 `tools/` 里加模块。

### 9.6 为什么没把「更亮」的两条放进来（反例排除）

- **没选 s13 团队协议**（`s13:852-909` 等）：能力确实强（MessageBus + 计划审批 + 停机协议 + worktree 隔离，全仓 1905 行），但我们的 A9 协作协议**还没定形**、A10 IM 是用户声明非目标，先上 1905 行会引入不可控复杂度。等 A9 协议定了再回来抄「协议状态机」那一块（`s13:921-967`）。
- **没选 s08 上下文压缩**（`s08:254-542`）：很完整，但我们自己的 `tools/context/compress.mjs` 已经做过结构化压缩 + 32 项验收，收益低于已卡死的 A12/A11/C2。可作为「C4 自愈」的补充参考（它和 `s15:3190-3193` 的 reactive_compact 配套），不是本轮首选。

---

## 10. 我们不该抄的

1. **单文件复制式增长（B4 反面教材）**：`s15_integrated_harness/code.py` **2874 行**、`s13_agent_teams/code.py` **1905 行**，而且每章把 `run_bash/run_read/run_write/run_edit/run_glob` 这 40 行原样复制一遍（如 `s07:149-206` vs `s09:547-605`）。这是**教学**为了「一章一个可跑文件」付出的代价；我们是**产品**，照抄会直接把单文件撑爆。我们应抽公共 `tools/` 模块，而不是 copy-forward。
2. **MCP 是假协议，别抄实现**：`s14` 的 `MCPClient` 是同进程 mock（`s14:170-197`），`MOCK_SERVERS` 写死两个假 server（`s14:221-286`），`connect_mcp` 的 enum 写死 `["docs","deploy"]`（`s14:314`）。**只抄命名空间+policy 思路，真协议实现要自己接 stdio/SSE。**
3. **技能生命周期「import 时一次性扫死」**：`SKILL_LOADER = SkillLoader(...)`（`s07:131`）、`scan_skills()`（`s15:776`）都在模块顶层执行，改技能/装卸技能要重启进程。我们做产品需要「装/卸/启用/禁用」，**这里不能抄它的生命周期**（也是我们 A12 真正要补的：`tools/plugin/kernel.mjs` 有 `load/activateAll`，但没有 enable/disable/market，和它一样缺）。
4. **用 `input()` 做审批闸**：`s04:175`、`s09:664`、`s12:200` 都是阻塞 stdin 的 `input("Allow? [y/N]")`。Web 产品没有 stdin。**只抄「三闸分层」的结构**（`s03:155-214`：deny list → rules → approval），交互必须走我们的 UI 审批通道。
5. **记忆整库重写 / 全量注入**：`consolidate_memories()` 会「删光所有 `*.md` 再重写」（`s09:505-523`），虽然有 snapshot 回滚（`s09:499-534`），但仍是高危批量操作；召回还按 `20000` 字符全量注入（`s09:72`）。**记忆治理（A7）我们已有 source/supersede/TTL，别退化成它的整库重写**；只借「临时信息 marker 拒收」和「catalog 序号选择」。
6. **把 `web/` 当 agent UI 基座**：它是 Next.js 文档站（`web/package.json`），只有 header+sidebar+tabs，没有可拖拽分栏/多工作区（D1/D2/D3/D4 都只是「部分」）。我们的 `WorkbenchScene.tsx` 需要的是工作台范式，不能照搬文档站布局；可取的是 **D5 的 CSS 变量 + `.dark` 双主题 + `useSvgPalette` 明暗双套配图**（`globals.css:3-23`、`useDarkMode.ts:31-64`）。
7. **`agents/` 和 `docs/` 整条 legacy 轨**：作者自己标了「章节号与正典不一致，别混用」（`README.md:174-177`）。例如 `agents/s05_skill_loading.py:74` 用 `rglob` 递归扫技能、`agents/s_full.py:229` 用 `<skill>` 包裹——**这些和正典 s07 不一致**，只读正典，避免照错版本。

---

## 附：行号核对清单（本报告逐条 grep/read 过）

- `s01_agent_loop/code.py`：96-126 循环，107-111 无工具即停。
- `s02_tool_use/code.py`：81-85 `safe_path`，153-156 `TOOL_HANDLERS`，163-185 循环。
- `s03_permission/code.py`：155-214 三闸，177-185 `PERMISSION_RULES`，203-214 `check_permission`，238-241 插入点。
- `s04_hooks/code.py`：137-147 HOOKS，235-240 Stop 可否决，245-249 PreToolUse 拦截。
- `s05_todo_write/code.py`：121-177 `TodoManager`，137-138 上限 20，156-157 只能一个 in_progress。
- `s06_subagent/code.py`：262-263 子代理无 task 工具，276-313 `run_subagent`，280 `range(30)`，312-313 超限文案。
- `s07_skill_loading/code.py`：46 `SKILLS_DIR`，59-128 `SkillLoader`，89-113 `scan`（95 `*/SKILL.md`），115-121 `catalog`，123-128 `load`，131 实例化，134-144 system，220-221/230 `load_skill`，348-377 循环。
- `s08_context_compact/code.py`：254-260 常量，368-386 `tool_result_budget`，398-419 `snip_compact`，421-444 `micro_compact`，446-465 `fit_tool_results`，500-516 `compact_history`/`reactive_compact`，518-542 `prepare`，549-596 循环，559-568 reactive 重试。
- `s09_memory/code.py`：37-38 目录，50 类型，51-71 临时 marker，72 `RECALL_CHAR_LIMIT`，73 巩固阈值，114-145 写入规则，147-169 写入/文档，171-190 重建索引，271-323 召回，325-335 载入，337-355 `build_system`，392-454 抽取，456-543 巩固（499-534 快照回滚），726-763 循环（751-752 Stop 时抽记忆）。
- `s10_task_system/code.py`：70 `TASKS_DIR`，74-82 `Task`，84-199 `TaskStore`，133-145 传递依赖，147-177 依赖+环检测（165-170），236-237 `can_start`，240-279 claim/complete。
- `s11_background_tasks/code.py`：71-107 进程组清理/atexit，202-208 `run_in_background`，348-424 `BackgroundManager`，403-424 通知 XML，447-467 注入，493-523 循环（495 注入）。
- `s12_cron_scheduler/code.py`：45 存储路径，269-277 `CronJob`，280-282 内存态，299-321 `cron_matches`，356-372 `validate_cron`，375-389 原子落盘，392-423 装载，497-515 poll/consume，518-558 ack/restore，595-611 工具，644-646 轮询线程，649-699 `agent_loop`（650-654 注入，666-671 回滚，674-679 ack，684-689 停止），727-735 queue-processor，738-771 起停，777 入口启动。
- `s13_agent_teams/code.py`：839-909 `MessageBus`，914-918 状态表，921-934 `ProtocolState`，944-967 `match_response`，1011-1035 提交计划，1060-1109 计划/停机应答校验，1125-1154 空闲认领，1160-1326 `TeammateRuntime`（1277-1326 `work`），1328-1360 `wait_for_work`，1362-1392 `run`，1796-1837 主循环。
- `s14_mcp_plugin/code.py`：170-197 `MCPClient`，204-210 host policy，213-218 名规整，221-286 mock，289-302 `connect_mcp`，309-317 工具定义，328-368 `assemble_tool_pool`（344 前缀，345-346 长度，348-352 撞名），371-374 system，423-428 mcp 审批，488-528 循环。
- `s15_integrated_harness/code.py`：64 `SKILLS_DIR`，68-77 常量，719-792 技能，748-773 `scan_skills`，779-792 list/load，803-845 `PROMPT_SECTIONS`，848-868 `assemble_system_prompt`（859-860 技能目录），2242-2292 恢复（256-258 状态，2258-2285 重试），3155-3277 `agent_loop`（3165-3174 定时注入，3220-3224 停止，3203-3215 max_tokens 升级）。
- `s16_workflow_runtime/code.py`：44-47 上限常量，329-376 `WorkflowJournal`，379-398 `Budget`，402-434 任务/限制，463-512 `agent()`，525-549 pipeline/嵌套，800-828 `install_workflow_tool`/`load_integrated_host`。
- `s17_goal_loop/code.py`：43-53 常量，69-95 状态 dataclass，275-479 `GoalController`（360-428 `evaluate_after_turn`），542-593 `AgentSession`（576-586 `/goal` 斜杠命令），681-763 `_run_query`（684-690 max_turns，740-757 goal block）。
- `web/`：`package.json` 依赖；`src/app/globals.css:3-23`；`src/hooks/useDarkMode.ts:1-64`；`src/components/layout/header.tsx`、`sidebar.tsx`；`src/components/simulator/agent-loop-simulator.tsx`；`web/scripts/extract-content.ts:12-18`。
- `skills/*/SKILL.md`：`pdf:1-3`、`agent-builder:1-10`。
- CI：`.github/workflows/ci.yml`、`test.yml`。
- 我们的产品（对照用）：`tools/plugin/kernel.mjs:22,25-92,133-147,194-236`；`tools/plugin/run.mjs:37-94`；`tools/skills/loader.mjs:31-100`；`tools/schedule/scheduler.mjs:14-16,49-111,129-176,300,308-334`；`tools/schedule/tick.mjs:1-8`；`apps/vouch-web/src/web-ui/src/infrastructure/api/service-api/AgentAPI.ts:58-69`。
