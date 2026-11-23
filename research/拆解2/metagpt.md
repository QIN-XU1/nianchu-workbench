# MetaGPT 拆解（v2：找可抄的实现）

> 仓库：`D:\refs\metagpt`　1,255 文件 / Python
> 版本：`setup.py:99-110`（name=metagpt，version=1.0.0，python_requires >=3.9,<3.12）
> 最近提交：`2026-01-21 18:12:32 +0800  11cdf466`（`git log -1`，非 README）
> star：**未找到**（本地无 GitHub 元数据文件，未联网查询，不猜）

---

## 1. 定位与规模

一句话：**用「SOP + 角色分工 + 消息广播」把一次软件公司协作写成可运行的 Python 多智能体程序**——不是通用 agent 运行时，而是一套「公司/团队」隐喻的多代理编排框架（`metagpt/team.py:32-36` 自己就是这么定义的）。

- 文件数 1,255；主语言 Python（`setup.py:110` 限定 3.9–3.11）。
- 依赖规模很大（`requirements.txt:1-40`：faiss/lancedb/openai/anthropic/playwright/pandas/...），核心却很小：`roles/role.py` 592 行、`environment/base_env.py` 247 行、`memory/memory.py` 112 行、`schema.py` 976 行。
- 入口两个：CLI/公司模式 `metagpt/software_company.py:14-74`，团队模式 `metagpt/team.py:122-137`。

---

## 2. 架构骨架

顶层（`metagpt/` 下）职责：

| 目录/文件 | 职责 | 证据 |
|---|---|---|
| `base/` | 抽象契约：`BaseRole` / `BaseEnvironment` | `base/base_role.py:7-36`、`base/__init__.py:1-8` |
| `roles/` | 角色实现；`role.py` 是基类，`roles/di/*` 是新一代 RoleZero 角色 | `roles/role.py:125`、`roles/di/role_zero.py:55` |
| `actions/` | 原子动作（写 PRD/设计/写码/跑码/审码…），Role 的可执行单元 | `actions/action.py:29`、`actions/__init__.py` |
| `environment/` | 消息总线 + 角色容器；`Environment`，以及 mgx/werewolf/minecraft 等专用环境 | `environment/base_env.py:124`、`environment/__init__.py:5-13` |
| `memory/` | 记忆：短期 Memory、长期 LongTermMemory、向量库 MemoryStorage | `memory/memory.py:20`、`memory/longterm_memory.py:18` |
| `provider/` | LLM 供应商抽象与 12 个实现 | `provider/llm_provider_registry.py:12-44` |
| `tools/` | 工具注册表 + 内置工具（editor/terminal/browser/search） | `tools/tool_registry.py:27-118`、`tools/libs/` |
| `strategy/` | Planner（计划树）与经验检索 | `strategy/planner.py`、`schema.py:496-712`（Plan/Task） |
| `rag/`、`document_store/` | 检索增强与文档库 | `rag/`、`document_store/` |
| `ext/` | 独立 demo 应用（werewolf / stanford_town / android_assistant / aflow / sela / spo） | `ext/werewolf/werewolf_game.py:3-7` |

**依赖方向（单向）**：`roles → actions → provider`；`roles ↔ environment` 通过抽象 `BaseEnvironment` 解耦（`roles/role.py:33` import 的是 `metagpt.base.BaseEnvironment`，不是具体 Environment）。核心**从不 import `metagpt.ext`**（grep `metagpt.ext` 在 `metagpt/*.py`、`roles/`、`environment/`、`actions/` 下 0 命中），而 `ext/werewolf` 反向 import 核心（`ext/werewolf/werewolf_game.py:3-7`）——这是全仓唯一干净的边界。

**核心/扩展边界靠什么强制？——没有强制。** 只是目录约定：
- `@register_tool()` 装饰器把类塞进全局 `TOOL_REGISTRY`（`tools/tool_registry.py:90-118`），没有清单文件、没有 schema 强校验（`ToolSchema(**schemas)` 失败直接 `pass`，`tool_registry.py:55-61`）；
- 角色扩展就是 subclass `Role`/`RoleZero`；
- `metagpt/skills/` 是 Semantic-Kernel 风格的旧技能包（每个技能 `config.json` + `skprompt.txt`，如 `skills/SummarizeSkill/Summarize/`），`management/skill_manager.py:14` 直接把 `Skill = Action`。
- 无 CI 边界检查、无类型门禁。

**A12 结论（部分）**：有工具注册表 + 技能目录 + Action/Role 子类三种扩展点，但**没有插件清单、没有安装/卸载/启用禁用、没有市场、没有热插拔、没有沙箱隔离**。工具能拿到的就是宿主进程内的一切（`register_tool` 存的是 class 对象本身，`tool_registry.py:63`）。

---

## 3. 角色与协作协议（A9 重点）

### 3.1 `Role` 基类在哪、有哪些钩子

- 抽象契约：`metagpt/base/base_role.py:7-36`（`think` / `act` / `react` / `run` / `get_memories` / `is_idle`）。
- 主基类：**`metagpt/roles/role.py:125`** `class Role(BaseRole, SerializationMixin, ContextMixin, BaseModel)`。
- 运行时上下文：`RoleContext` **`role.py:92-122`**，里面装着 `env`(98)、`msg_buffer`(100-102)、`memory`(103)、`working_memory`(105)、`state`(106)、`todo`(107)、`watch`(108)、`react_mode`(110-113)。

钩子全部存在，行号如下：

| 钩子 | 位置 | 作用 |
|---|---|---|
| `_observe` | `role.py:399-427` | 从 `msg_buffer` 取新消息，按订阅过滤后写进 `rc.news` / `rc.memory` |
| `_think` | `role.py:340-379` | 决定下一步做哪个 Action；`-1` 表示结束 |
| `_act` | `role.py:381-397` | 跑 `rc.todo.run(history)`，产出 `AIMessage` 并写回 memory |
| `_react` | `role.py:454-470` | think↔act 循环体（**注意：它是 ReAct 循环，不是「反思」钩子**） |
| `react` | `role.py:512-523` | 三模式分发（REACT / BY_ORDER / PLAN_AND_ACT） |
| `_plan_and_act` | `role.py:472-496` | 先规划再连续执行（Planner） |
| `run` | `role.py:529-554` | 一次完整节拍：`_observe → react → set_todo(None) → publish_message` |
| `_watch` | `role.py:284-288` | 订阅：把 Action 类型名写进 `rc.watch` |
| `is_idle` | `role.py:556-559` | 「没新闻 + 没 todo + 收件箱空」= 空闲 |

要点：`_react` 的注释明确写「standard think-act loop in the ReAct paper」（`role.py:455-457`）。没有独立的 `_reflect`/`_critique` 钩子——反思是靠「再用 Prompt 问一次状态」在 `_think` 里做的（`STATE_TEMPLATE`，`role.py:54-69`）。

### 3.2 消息怎么传递

**消息结构**：`metagpt/schema.py:232-242`

```python
class Message(BaseModel):
    id: str
    content: str
    instruct_content: Optional[BaseModel]
    role: str = "user"            # system/user/assistant，只给 LLM API 用
    cause_by: str                  # 由哪个 Action 产生（订阅键）
    sent_from: str                 # 谁发的
    send_to: set[str] = {<all>}    # 路由地址，默认 <all>
    metadata: Dict[str, Any]
```

路由常量在 `metagpt/const.py:77-83`：`sent_from` / `send_to` / `cause_by` / `<all>` / `<none>` / `<self>`。

**发布链（3 段）**：
1. `Role.publish_message` **`role.py:429-446`**：补齐 `sent_from`，`<self>` 转成自己 `any_to_str(self)`；只发给自己就走 `put_message`；否则交给环境。
2. `Environment.publish_message` **`base_env.py:175-195`**：遍历 `self.member_addrs`，用 `is_send_to(message, addrs)` 命中就 `role.put_message(message)`，然后写 `self.history.add(message)`。
3. `is_send_to` **`utils/common.py:423-431`**：`send_to` 含 `<all>` 直接 True；否则地址集合有交集即 True。

**收件箱（每个角色私有）**：`put_message` **`role.py:448-452`** → `rc.msg_buffer.push`；`MessageQueue` 是 `queue.Queue` 包装（`schema.py:713-743`），`pop_all` 在 `_observe` 里被消费（`role.py:406`）。

**订阅（pull 语义，不是 push）**：`_watch` **`role.py:284-288`**，过滤条件在 `_observe` **`role.py:410-412`**：
```python
self.rc.news = [n for n in news
                if (n.cause_by in self.rc.watch or self.name in n.send_to)
                and n not in old_messages]
```
默认订阅 `UserRequirement`（`role.py:176-177`）。地址注册：`Role.set_addresses` `role.py:293-300` → `Environment.set_addresses` `base_env.py:240-242`，默认地址是「类名 + name」（`role.py:210-214`）。

**MGX 环境是「中心路由」变体**：`environment/mgx/mgx_env.py:24-62` 里所有常规消息强制 `message.send_to.add(tl.name)` 交给 TeamLeader（55-58），TeamLeader 再用 `publish_team_message(content, send_to)` 指定唯一收件人（`roles/di/team_leader.py:75-86`，`mgx_env.py:48-58`）。这是「星形总线」而非「广播黑板」。

### 3.3 共享黑板 / 记忆在哪

- **`Memory` 类**：`metagpt/memory/memory.py:20-112`。
  - `storage: list[Message]`（23）+ **`index: {cause_by → [Message]}`**（24，倒排索引在 `add` 里维护，`34-35`）。
  - `add` 用 `if message in self.storage: return` 去重（`31-32`）。
  - `get(k)` 取最近 k 条（`80-82`）；`get_by_actions(watch)` 把订阅集合展开成消息（`99-107`）。
- **角色私有记忆**：`rc.memory`（`role.py:103`）；`history` 属性（`role.py:120-122`）；`important_memory = memory.get_by_actions(watch)`（`role.py:115-118`）。
- **`working_memory` 单独一份**（`role.py:105`），给 Planner 用（`role.py:282`）。
- **长期记忆**：`memory/longterm_memory.py:18-78`；落盘向量库 `memory/memory_storage.py:19-77`（FAISS，路径 `data/role_mem/{role_id}/`，`38-42`）；RoleZero 还叠加一层 RAG 长期记忆 `memory/role_zero_memory.py:119-141`。
- **`Environment.history` 不是黑板**：它确实是 `Memory`（`base_env.py:134`），但只 `add`（`193`）**从没有任何角色读它**，注释写着「For debug」（`134`）。所以：**MetaGPT 的「共享黑板」= 消息总线 + 每个角色各自的 Memory，没有一块 everyone read/write 的共享可变存储。**

### 3.4 角色之间怎么串（SOP：`_watch` 订阅哪些消息类型）

**老 SOP（固定流水线）**：
- `ProductManager` 订阅 `[UserRequirement, PrepareDocuments]`，按顺序跑 `PrepareDocuments → WritePRD`，`react_mode = BY_ORDER`（`roles/product_manager.py:43-47`）。
- `Architect` 订阅 `{WritePRD}`（`roles/architect.py:52`）。
- `ProjectManager` 订阅 `[WriteDesign]`（`roles/project_manager.py:41`）。
- 一次「公司」的编制在 `software_company.py:45-54`：`TeamLeader, ProductManager, Architect, Engineer2, DataAnalyst`。

即 SOP 就是**一张「谁订阅谁的输出」的因果链**：UserRequirement → WritePRD → WriteDesign → WriteTasks → WriteCode → …。没有显式 DAG 对象，DAG 藏在各 `_watch` 调用里。

**新 SOP（默认路径，RoleZero）**：`use_fixed_sop: bool = False`（`role_zero.py:98`），`_think`/`_act` 直接走 LLM 选命令（`role_zero.py:198-301`），由 TeamLeader 派单（`team_leader.py:75-86`）。老 SOP 只在新开关打开时生效（`role_zero.py:201-202`、`281-282`）。

**外部事件源**：`SubscriptionRunner.subscribe(role, trigger, callback)`（`subscription.py:40-65`）把「异步生成器吐 Message → role.run(msg) → callback」跑成 asyncio task，`run()` 循环 1s 巡检（`76-100`）。

### 3.5 多轮怎么收敛（轮次上限 / 终止条件）

四层闸，缺一不可：

1. **角色级轮数**：`rc.max_react_loop`（`role.py:113` 默认 1）→ `_react` 的 `while actions_taken < max_react_loop`（`role.py:461-469`）。`RoleZero` 设为 **50**（`role_zero.py:71`），到顶不静默死循环，而是**问人**「要不要继续」（`role_zero.py:328-335`）；`TeamLeader` 设为 3（`team_leader.py:29`）。
2. **`_think` 返回 False**：`RoleZero._think` 里 `if not self.rc.todo: return False`（`role_zero.py:205-206`）；经典 Role 靠 LLM 回 `-1`（`role.py:371-378`）。
3. **显式 `end` 命令**：`_run_special_command` 里 `elif cmd["command_name"] == "end": await self._end()`（`role_zero.py:431-432`），`_end` 把 state 置 -1 并总结（`474-491`）。
4. **团队级**：`Team.run(n_round=3)` 的 `while n_round > 0`（`team.py:128-136`），每轮先查 `env.is_idle` 就 `break`（`129-131`），再 `_check_balance()` 超预算抛 `NoMoneyException`（`team.py:98-100`）；`Environment.run` 用 `asyncio.gather` 并发跑所有非 idle 角色（`base_env.py:197-211`），`Environment.is_idle` 要求全部角色 idle（`228-234`）。

**没有的东西（诚实说）**：没有投票/仲裁/quorum，没有角色间协商协议，没有跨角色的计划共识——`Plan` 是单一 role 内的任务树（`schema.py:496-712`），不是共享协议对象。

---

## 4. 【A13】MCP / 工具接入

**MCP：未找到。** 全仓 `grep -i "\bmcp\b"` 在 `metagpt/` 下 **0 命中**；无 MCP client/server、无 stdio/JSON-RPC、无 server 管理 UI。这一格判「无」。

它实际的「工具接入」是**函数签名自动生成 schema**：

- 注册：`@register_tool(tags=[...], include_functions=[...])` 装饰器（`tools/tool_registry.py:94-118`），把 `inspect.getfile/getsource` 拿到的源码 + 由签名转出的 schema 存进全局 `TOOL_REGISTRY`（`90-91`、`register_tool` `31-69`）。
- 校验：`validate_tool_names`（`131-163`）支持三种键——工具名、`Tool:method1,method2`（`139-156`）、tag（`159-160`）；非法只 `logger.warning(...skipped)`，不抛错（`161-162`）。
- 动态从文件/目录注册：`register_tools_from_file`（`166-182`）、`register_tools_from_path`（`185-194`）——靠 AST 解析（`convert_code_to_tool_schema_ast`，`172`）。
- 暴露给模型：`RoleZero.tools`（`role_zero.py:74`）+ `BM25ToolRecommender`（`109-110`）挑工具 → `json.dumps({tool.name: tool.schemas})` 塞进 system prompt 的 `available_commands`（`role_zero.py:219-230`）。
- 回填：LLM 输出被 `parse_commands` 解析成 `commands`（`role_zero.py:284-286`），`_run_commands` 按 `tool_execution_map` 逐个执行（`385-415`），结果包成 `UserMessage(content=outputs, cause_by=RunCommand)` 写回 memory（`295`）——**结果以「用户消息」形式回填上下文**，不是结构化 tool_result。
- 能力限制：只有 `special_tool_commands` / `exclusive_tool_commands` 两张名单（`role_zero.py:77-85`），没有沙箱、没有权限分级、没有 UI 管理。

---

## 5. 【A11】调度 / 后台任务

**定时任务：未找到。** 全仓无 cron / APScheduler / 持久化 job 表（grep `cron|schedule|APScheduler` 只在注释/词义命中）。

有的只是两种「异步」：
- 终端命令后台跑：`Terminal.run_command(cmd, daemon=True)` 用 `asyncio.create_task(self._read_and_process_output(cmd))`（`tools/libs/terminal.py:102-105`），输出进 `stdout_queue`（`134-145`）。
- 订阅长轮询：`SubscriptionRunner.run()` 的 `while True: ... await asyncio.sleep(1)`（`subscription.py:85-100`）。

没有四态、没有重试策略、没有常驻进程守护——这一格判「无」。

---

## 6. 【C1/C2】agent 循环与停止条件

**主循环**：`Role.run` **`role.py:529-554`**

```
put_message(可选) → _observe()（没新闻就 return，挂起）
                 → react()（REACT/BY_ORDER→_react；PLAN_AND_ACT→_plan_and_act）
                 → set_todo(None) → publish_message(rsp)
```

**一轮的定义**（ReAct）：`_think`（LLM 选状态/命令）→ `_act`（跑 todo）→ 回 `_observe`。经典版在 `role.py:454-470`；RoleZero 版在 `role_zero.py:303-336`，差别是**循环体内每轮都重新 `_observe`**（`role_zero.py:315-316`）以便中途感知新消息。

**停止条件（C2）**：
- 轮数：`max_react_loop`（`role.py:113`；RoleZero 50 `role_zero.py:71`；TeamLeader 3 `team_leader.py:29`）。
- 无 todo：`role_zero.py:205-206`；经典版 `-1`（`role.py:371-378`）。
- 显式 done：`end` 命令（`role_zero.py:431-432`）→ `_end()` 置 `state=-1`（`474-475`）。
- 团队轮数：`Team.run(n_round=3)`（`team.py:123-136`）。
- 预算：`total_cost >= max_budget` 抛 `NoMoneyException`（`team.py:98-100`）。
- 全员空闲：`Environment.is_idle`（`base_env.py:228-234`）/ `Role.is_idle`（`role.py:556-559`）。

**状态持久化（断了能续吗？能，且是显式的）**：
- `Role.latest_observed_msg` + `recovered` 标记（`role.py:155-157`）；`_think` 里 `if self.recovered and self.rc.state >= 0: 从该 state 续跑`（`role.py:348-351`）；`_observe` 用 `memory.find_news(observed=[latest_observed_msg])` 补新闻（`role.py:403-404`）。
- 异常时删掉「最新观测消息」以便重跑：`utils/common.py:689-707`。
- 整体归档/恢复：`Team.serialize` / `Team.deserialize`（`team.py:59-81`），`@serialize_decorator` 包住 `Team.run`（`team.py:122`）。

---

## 7. 【A6/A7】记忆

**A6 跨会话记忆（部分）**：
- `LongTermMemory(Memory)`（`memory/longterm_memory.py:18-78`）：启动 `recover_memory(role_id)`（`31-40`），只把「自己 watch 的 cause_by」写进长期库（`42-48`），检索时按相似度过滤掉已见过的（`50-67`）。
- 存储形态：**向量库（FAISS）**，按角色分目录 `data/role_mem/{role_id}/`，`persist()` 落盘（`memory_storage.py:38-42`、`75-77`），`search_similar` 阈值 0.1（`28`、`61-69`）。
- RoleZero 另有一套 RAG 长期记忆（`memory/role_zero_memory.py:97-141`），超过 `memory_k` 就把旧消息搬进长期库（`100`、`119-129`），检索结果拼在最近记忆前面（`89-95`）。
- **默认关**：`configs/role_zero_config.py:7` `enable_longterm_memory: bool = False`。所以判「部分」。

**A7 记忆治理（无）**：
- TTL 只定义未使用：`const.py:75` `MEM_TTL = 24*30*3600`，到了 `memory_storage.py:27` 变成 `self.mem_ttl = mem_ttl  # later use`，全仓无任何过期判断。
- 无溯源字段（`Message` 无 source/author 之外的可信度标记，`schema.py:232-242`）、无冲突消解、无 supersede 链。
- 只有两层去重：`Memory.add` 的 `message in storage`（`memory.py:31-32`）和向量检索阈值（`memory_storage.py:67-68`）。

---

## 8. 【D1–D5】界面

**这个仓库没有前端。** 全仓无 `.tsx/.vue/.jsx/.css`（`Get-ChildItem -Include` 查得 0），唯一 HTML 是 `metagpt/utils/index.html` 一个 **5.65MB 的压缩打包产物**（`index.html:1` 单行，不可读、无源码）。所以：

- D1 布局 / D2 信息密度 / D4 多工作区 / D5 主题：**无**（未找到任何 UI 源码）。
- D3 状态可见性：**部分**——它提供了给外部 UI 用的**结构化事件流**：`utils/report.py` 的 `ResourceReporter`（`49-130`）可插拔 `set_report_fn` / `set_async_report_fn`（`77-101`），并有 `TerminalReporter`(192) / `BrowserReporter`(211) / `ThoughtReporter`(264) / `EditorReporter`(308) 等按类型的 reporter；`role_zero.py:252-254` 每次思考都 `ThoughtReporter.async_report({"type":"react"})`。加上 `logs.py:40-52` 把 DEBUG 日志落到 `logs/{date}.txt`。**但没有任何「花了多少 / 还差什么」的 UI**，token/成本只存在于 `cost_manager` 内部。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：消息三字段路由 + 每角色私有收件箱

```
机制：Message 只带 sent_from / send_to / cause_by 三个路由字段；环境按地址表把消息投递到「每个角色自己的队列」，角色只在 _observe 时消费。
位置：metagpt/schema.py:232-242（Message 结构）、metagpt/environment/base_env.py:175-195（publish_message）、metagpt/roles/role.py:429-452（publish/put_message）、metagpt/utils/common.py:423-431（is_send_to）、metagpt/schema.py:713-743（MessageQueue）
为什么好：我们现在的 agent 间要么全局广播、要么 orchestrator 手工点名调用，没有「收件箱」语义——结果是要么所有人都被唤醒重复处理，要么新增一个 agent 就得改调度器。MetaGPT 用 ~20 行 publish + 8 行 put_message + 4 行 is_send_to 就得到：新增角色只要注册地址就能收消息，发送方完全不知道接收方是谁（解耦）。
我们抄到哪：给 agent 间加的最小「角色+黑板」协议层（新增 mailbox 模块，字段名直接对齐 sent_from / send_to / cause_by）。
```

### 机制 2：用 `cause_by` 做订阅过滤与记忆倒排索引

```
机制：订阅不是「监听事件名」，而是「声明我关心哪些 Action 的产物」；`_watch` 把 Action 类名存进集合，`_observe` 只收 cause_by ∈ watch 的消息，Memory 同时按 cause_by 建倒排索引。
位置：metagpt/roles/role.py:284-288（_watch）、metagpt/roles/role.py:410-412（过滤条件）、metagpt/memory/memory.py:24 与 34-35（index）、metagpt/memory/memory.py:99-107（get_by_actions）、metagpt/roles/role.py:115-118（important_memory）
为什么好：这解决了「谁该醒」这个多代理最难的判定。用「产物类型」而不是自然语言匹配，判定是 O(1) 集合查找且可解释；同时 `important_memory` 让角色「按需只看自己订阅的那部分历史」，天然抗上下文膨胀。我们的黑板如果只做 KV 存取，每个 agent 每轮都要重读全量历史。
我们抄到哪：黑板 subscribe(filter) + 记忆索引（memories 按 producer/action 建倒排）。
```

### 机制 3：收敛四闸（角色轮数 / 显式 end / 团队轮数 / 预算）

```
机制：把「什么时候停」拆成四层独立硬条件，任一触发就停；角色轮数到顶不静默退出，而是转人工确认续期。
位置：metagpt/roles/role.py:113 与 454-470（max_react_loop）、metagpt/roles/di/role_zero.py:71 与 314-335（50 轮 + ask_human 续期）、metagpt/roles/di/role_zero.py:431-432（end 命令）、metagpt/team.py:98-100 与 123-136（预算 + n_round）、metagpt/environment/base_env.py:197-211 与 228-234（gather + is_idle）、metagpt/roles/role.py:556-559（Role.is_idle）
为什么好：我们的多代理最容易出的事故是「互相等 / 无限循环 / 烧钱不停」。它把「停」做成四道可分别观测的闸，且 50 轮 + human-in-the-loop 的处理避免了「跑飞了也没人知道」。注意它没有投票/仲裁——收敛靠的是资源与空闲判定，不是协商，这对我们反而是可落地的最小版本。
我们抄到哪：orchestrator 的循环控制（maxRounds / isIdle / budget / explicit done 四字段）。
```

---

## 10. 我们不该抄的

1. **Pydantic 全模型 + 巨型打包产物**：`Role`/`Action`/`Message`/`Environment` 全是 `BaseModel`（`role.py:125`、`action.py:29`、`schema.py:232`），好处是序列化方便，代价是每加一个字段都要过 validator、`model_config extra="allow"` 到处漏（`role.py:128`）。再加上 `utils/index.html` 5.65MB 的单行 bundle——这是它多年演化的考古层，不是设计。
2. **RoleZero 的 50 轮 + quick_think + 命令 DSL 塞一个类**：`roles/di/role_zero.py` 491 行里同时塞了 prompt 组装、命令解析、重复检测（`257-263`）、工具执行、人类交互、经验缓存（`267-274`）、总结（`488-491`）。我们只需要 20 行的角色协议，别照抄这套「万能角色」。
3. **MGXEnv 的星形单点**：所有消息必须经 TeamLeader（`mgx_env.py:55-58`），而且 `TeamLeader.publish_message(msg, send_to=...)` 调的是 `env.publish_message(msg, publicer=...)`（`team_leader.py:64-73`），**和基类 `Environment.publish_message(message, peekable)` 签名不兼容**（`base_env.py:175`）——只有换成 MGXEnv 才不炸。这是它自己的耦合债，别学。
4. **新旧两套 SOP 并存**：`use_fixed_sop` 开关（`role_zero.py:98`），同一个角色的 `_think`/`_act` 各有一条老分支（`role_zero.py:201-202`、`281-282`）。两套行为两套测试，是典型历史包袱。
5. **别把「248 个测试」当验证闭环**：`pytest.ini` 里 **152 条 `--ignore=`** 把网络/LLM 相关测试全屏蔽；`unittest.yaml:34-49` 只跑剩余部分。真正「这次多代理任务成功了吗」没有任何独立验证器——由角色自己发 `end` 自报（`role_zero.py:431-432`）。我们的 C3 要的是「独立可复算」，这里恰好是反面教材。
6. **`ext/` 的 werewolf / minecraft / stanford_town 别当插件机制抄**：它们是几十个文件的独立 demo，直接 import 核心（`ext/werewolf/werewolf_game.py:3-7`），没有接口边界、没有注册机制、没有版本约束——是「放在同仓的例子」，不是「可插拔的插件」。

---

## 附：本次未找到的项（诚实清单）

- star 数：未找到（本地无元数据）。
- MCP：全仓 0 命中。
- cron / 定时任务：0 命中。
- IM 通道（slack/telegram/discord/feishu）：0 命中（仅 wiki 链接里有 feishu 域名）。
- 前端源码：0（仅 `metagpt/utils/index.html` 打包产物）。
- 共享可变黑板：0（`Environment.history` 只写不读，`base_env.py:134,193`）。
- 投票 / 仲裁 / 协商协议：0。
