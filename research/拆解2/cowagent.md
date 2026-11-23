# CowAgent 拆解（zhayujie/CowAgent，ChatGPT-on-WeChat 同作者）

> 目标：不写「它是什么」，只写「我们能抄哪几行」。每个结论带 `文件:行号`；找不到就写「未找到」。

---

## 1. 定位与规模

一句话：**一个以「IM 消息 → Agent 循环 → 多渠道回复」为主干的中文 AI Agent 框架**，同时提供 Web 控制台与 Electron 桌面端，把「微信/飞书/钉钉/企微/QQ/Telegram/Slack/Discord」等 10+ 通道收敛到同一套消息管线。

- 文件数：1744；主语言 Python（1068 个 `.py`），前端 TS/TSX（71+51）+ JS（62），另有静态 Web 控制台。
- 仓库最后提交：`bcc36de 2026-11-16 11:28:42 +0800`（`git log -1`）；版本 `cowagent 1.0.0`（`pyproject.toml:5-9`），桌面端 `2.2.2`（`desktop/package.json:2-3`）。
- star：**未核实**（未读 README 的 badge，不猜）。
- 入口：`app.py:795 run()` → 载入配置/迁移 → 启动 `ChannelManager` → 每通道一个 daemon 线程（`app.py:851-853`）。

证据：`pyproject.toml:1-13`、`app.py:795-871`、`desktop/package.json:1-33`。

---

## 2. 架构骨架

### 2.1 顶层目录 → 职责

| 目录 | 职责 |
|---|---|
| `channel/` | 多渠道适配层 + Web 控制台后端 API/静态资源（`channel/channel.py`、`channel/web/api/*.py`） |
| `bridge/` | 消息域与 Agent 域的桥：`Context`/`Reply`、`Bridge` 模型工厂、`AgentBridge` 路由与持久化（`bridge/bridge.py`、`bridge/agent_bridge.py`） |
| `agent/` | Agent 内核：循环 `protocol/`、工具 `tools/`、技能 `skills/`、记忆 `memory/`、多 Agent `team.py`/`multiagent/`、权限 `permission/` |
| `plugins/` | 旧式事件钩子插件（内存内 importlib 装载），与 `agent/tools` 的「工具」是两套扩展轴 |
| `skills/` | 内置 Markdown 技能（`SKILL.md` + `scripts/`），由 `agent/skills` 加载 |
| `models/` | 各 LLM 供应商 bot（openai/claude/gemini/deepseek/qwen/... 20+ 子目录）+ `model_catalog.py` |
| `voice/` `translate/` | TTS/ASR、翻译工厂（`factory.py` + 每家一目录） |
| `cli/` | `cow` 命令（install/process/skill/knowledge/backup，`cli/commands/*.py`） |
| `desktop/` | Electron + React 18 + Vite 桌面端（`desktop/src/main/*`、`desktop/src/renderer/*`） |
| `common/` | 日志、原子写、state_dir、channel_registry、token_bucket 等基础设施 |

### 2.2 依赖方向（谁 import 谁）

单向链路基本成立：**channel → bridge → agent → agent.tools / models**；plugins 挂在 channel 层。

- `channel/channel.py:5-9`：`from bridge.bridge import Bridge` / `bridge.context` / `bridge.reply`。
- `channel/chat_channel.py:8-16`：`from bridge.context import *`、`from channel.channel import Channel`、`from agent.routing import ...`、`from plugins import *`。
- `bridge/bridge.py:1-9`：`models.bot_factory`、`bridge.context`、`translate.factory`、`voice.factory`。
- `bridge/agent_bridge.py:11-28`：`from agent.protocol import (Agent, LLMModel, ...)`。
- `agent/protocol/agent.py:97-100`：`from agent.protocol.agent_stream import AgentStreamExecutor`、`from agent.tools.base_tool import BaseTool`。
- 叶子：`agent/tools/tool_manager.py:6` 只依赖 `agent/tools/base_tool.py`。

### 2.3 有没有「核心 / 插件」边界？靠什么强制？

**有边界，但只靠目录约定 + 事件契约，无类型/CI 强制：**

- 边界定义：插件是「目录下必须有 `__init__.py`」的子包，用 `@plugins.register(...)` 注册（`plugins/plugin_manager.py:48-66`、`:182-230`）。
- 强制手段：**没有**。`pyproject.toml:31-44` 的 ruff 只 lint（F 类 fatal），不做模块边界检查；`channel/web/tools/check-load-order.mjs`、`check-router.mjs` 只校验 **Web 前端脚本加载顺序/路由**，与插件无关。
- 结果：插件可直接 `import config`、拿 `e_context["channel"]`（完整 channel 对象），无能力收敛（见第 3 段 §隔离）。

---

## 3. 【A12】插件 / 扩展机制（重点）

> 关键认知：CowAgent 有**两条独立扩展轴**——`plugins/`（Python 事件钩子，旧）与 `agent/skills/`（Markdown 技能，新）。二者不共享机制。

### 3.1 插件清单长什么样（不是 JSON，是装饰器）

插件没有 `plugin.json` 清单，元数据写在类装饰器里：

```python
@plugins.register(name="Hello", desire_priority=-1, hidden=True, enabled=False,
                  desc="A simple plugin that says hello", version="0.1", author="lanvent")
class Hello(Plugin): ...
```
`plugins/hello/hello.py:12-23`；装饰器字段在 `plugins/plugin_manager.py:48-66` 写入类属性（`name/priority/desc/author/path/version/namecn/hidden/enabled`）。

插件目录结构：`plugins/<name>/__init__.py`（必需）+ 可执行模块 + `config.json`（或 `config.json.template`），见 `plugins/README.md:183-195`、`plugins/hello/hello.py:119-128`。

插件配置读取优先级：先 `plugins/config.json` 全局，再回落插件目录 `config.json`，`plugins/plugin.py:12-28`。

### 3.2 怎么被发现（扫描逻辑）

`PluginManager.scan_plugins()`，`plugins/plugin_manager.py:182-230`：

- 遍历 `_plugins_resource_dir()` 下每个子目录（`:186-188`）；
- **判定标准**：子目录存在 `__init__.py`（`:190-191`）；
- 用 `importlib.import_module("plugins.<name>")` 导入（`:193,205`）；已导入的重载用 `importlib.reload` 并级联重载子模块（`:196-203`，GODCMD 例外）；
- 扫描后把新插件写进 `plugins.json`，已存在的读回 `enabled/priority`（`:215-229`）。

### 3.3 怎么校验

- **插件清单无 schema 校验**（没有 manifest 可校验）；`register()` 只做「路径必须已设置」的断言（`plugin_manager.py:61-62`）。
- 唯一的「校验」在**配置存储**：`_read_plugin_store`（`plugin_manager.py:80-119`）容错解析 `plugins.json`——非 dict 丢弃、缺 `priority` 补 0、缺 `enabled` 补 true；损坏文件返回 None 而不是崩溃（`:80-119`，`load_config` 的回退链 `:121-158`）。

### 3.4 怎么装载

**同进程动态 import，无子进程、无沙箱**：`importlib.import_module` + 直接 `plugincls()` 实例化（`plugin_manager.py:244`）。插件实例与宿主共享进程、共享 `sys.modules`、共享 `config`。

### 3.5 贡献点（插件能加什么）

CowAgent 的贡献点只有**消息管线事件**，不是「命令/面板/路由/中间件」：

- 事件枚举：`Event.ON_RECEIVE_MESSAGE / ON_HANDLE_CONTEXT / ON_DECORATE_REPLY / ON_SEND_REPLY`（`plugins/event.py:6-27`）。
- 插件在 `__init__` 里把处理函数绑到 `self.handlers[Event.X]`（`plugins/hello/hello.py:40`）。
- 宿主在管线四个位置派发：收消息 `chat_channel.py:103`、生成回复前 `:224-229`、装饰回复 `:325-330`、发送前 `:370-375`。
- 插件通过改写 `e_context["context"]` / `e_context["reply"]` 生效（`plugins/event.py:36-55`；示例 `hello.py:90-113`）。

**控制流三态**（这是它的精髓）：`EventAction.CONTINUE`（交给下个插件）/ `BREAK`（停插件链但走默认逻辑）/ `BREAK_PASS`（停链且跳过默认逻辑），`plugins/event.py:30-33`；派发逻辑见 `plugin_manager.py:309-319`（`action == CONTINUE` 才继续下一个，`is_break()` 时打 `breaked_by`）。

### 3.6 隔离

**没有隔离。** 派发时把 `{"channel": self, "context": context, "reply": reply}` 整个交出去（`chat_channel.py:225-229`），插件可拿到真实 Channel 对象、可 `import config`、可读写文件。README 也承认「仅需了解插件触发事件」即可，无权限模型（`plugins/README.md:11-20`）。

### 3.7 热插拔（装/卸/启/停/改优先级）

状态存 **`plugins/plugins.json`**（`{plugins: {Name: {enabled, priority}}}`，原子写 `plugin_manager.py:68-78`）：

- 启用/禁用：`enable_plugin` / `disable_plugin`（`:336-361`），改内存+落盘+重新 `activate_plugins`。
- 改优先级：`set_plugin_priority`（`:321-334`），SortedDict 堆重排（`:41,232-234`）。
- 运行时重载单插件：`reload_plugin`（`:261-274`）。
- 安装：`install_plugin` 用 dulwich `git clone` 到 `./plugins/<repo>` 并装 `requirements.txt`（`:366-405`）；更新 `update_plugin`（`:407-440`）；卸载 `uninstall_plugin` 直接 `rmtree`（`:442-463`）。
- 桌面端强制黑名单：`_apply_desktop_plugin_denylist` 禁掉 IM-only 插件（`:280-294`）。
- 用户入口：管理员在聊天里发 `#installp` / `#scanp`（`plugins/README.md:28-36`，实现见 `plugins/godcmd/godcmd.py`），无独立插件管理 UI。

### 3.8 第二扩展轴：技能（skills）——比 plugins 更接近我们需要的「声明式扩展」

- 发现：递归扫描 `SKILL.md`（子目录有 `SKILL.md` 即视为一个技能并停止下钻），`agent/skills/loader.py:76-159`；根目录散 `.md` 也算（`:149`）。
- 声明：YAML frontmatter（`name/description/metadata.cowagent.requires.anyEnv...`），`skills/image-generation/SKILL.md:1-15`；解析 `agent/skills/frontmatter.py`。
- 校验/启用：`skills_config.json` 存 `enabled/category/source/display_*`，与磁盘扫描合并（`agent/skills/manager.py:211-263`）；双闸门启用（实例库开关 + 该 Agent 的 selection），`manager.py:265-300`。
- 依赖检查：`should_include_skill` / `get_missing_requirements`（`agent/skills/config.py`，`manager.py:346-409`）。
- 安装/编辑/删除：`SkillService.dispatch`（`agent/skills/service.py:112,427-577,749`），支持 URL/package 安装与在线创建。
- 注入模型：技能目录被格式化成一段 prompt 塞进系统提示（`manager.py:411-440`、`build_skill_snapshot` `:442-472`）。

> 一句话对比：**plugins = 代码级事件钩子（强但无隔离）**；**skills = 声明式 Markdown 能力包（弱但可校验/可开关/可热更）**。我们 kernel.mjs 想做的贡献点模型，更接近 skills 的「声明 + 白名单校验」，但 CowAgent 的 plugins 给了「真实派发链」的答案。

---

## 4. 【A10】多渠道适配层（重点：怎么抽象）

### 4.1 三层抽象（这是最值得抄的部分）

1. **`Channel` 基类**（`channel/channel.py:12-188`）——定义通道契约：`startup()` `:102`、`handle_text(msg)` `:134`、`send(reply, context)` `:142`，并把「如何生成回复」统一到 `build_reply_content` `:151-182`（内部走 `Bridge().fetch_agent_reply`）。
2. **`ChatMessage` 标准化消息**（`channel/chat_message.py:70-121`）——把每家 IM 的原始消息压成同一结构。必填字段文档写得很清楚（`:1-33`）：`msg_id/ctype/content/from_user_id/to_user_id/other_user_id`（群聊另加 `is_group/is_at/actual_user_id`）。**「填好必填项即可接入 ChatChannel 并支持插件」**（`:4`）。
3. **`ChatChannel` 通用管线**（`channel/chat_channel.py:27-830`）——与通道无关的全部逻辑都收在这里：构造 Context、群/私聊前缀与 @ 匹配、白名单、会话 id 归并、插件事件、语音转写、回复装饰、发送重试、按会话串行队列、取消/引导。

**接入一个新 IM 只需：** 继承 `ChatChannel` → 实现 `startup()`（建连/收消息）→ 把收到的消息包成 `ChatMessage` → 调 `produce(context)`。收发都走基类，插件/记忆/队列免费获得。

### 4.2 工厂与注册

- 工厂是**显式 if/elif 大表**（不是注册表）：`channel/channel_factory.py:54-107`，每个 `channel_type` 一个 `from ... import XxxChannel`。新增通道必须改这张表（`const.py` 常量 + 分支）。
- `create_channel()`（`:8-36`）判断是否多实例（`instance_id/credentials/bound_agent_id/members/peers` 任一非空），多实例时构造**非单例**实例并 `apply_instance(...)`（`:25-36`、`:45-51`）。

### 4.3 多实例 + 每实例凭据（成熟做法）

- `ChannelInstance` dataclass：`instance_id/channel_type/agent_id/name/credentials/members/peers`（`channel/channel_instances.py:146-172`）。
- 每个类型哪些键算「凭据」：`CREDENTIAL_KEYS` 表（`:79-115`，如 feishu 的 `feishu_app_id/secret/token/bot_name`）；只有这些键可被实例覆盖，端口/开关仍全局。
- 支持多实例的类型白名单：`MULTI_INSTANCE_READY`（`:134-143`）。
- 通道读取凭据走 `self.cfg(key)` 而非 `conf()`，这样同类多实例各带各的 app_id（`channel/channel.py:42-54`）。
- 实例身份注入消息：`stamp_instance_context()` 把 `bound_agent_id/instance_id/members/peers` 写进 context（`channel.py:75-100`），让路由把这条消息送到绑定的 Agent；`_compose_context` 会调用它（`chat_channel.py:52-54`）。
- 配置来源分两世界：legacy `config.json` 的 `channel_type` 列表 vs `team.json` 的 `channel_instances`，`resolve_channel_instances()` 统一成 `ChannelInstance` 列表（`channel_instances.py:272-288`），启动去重见 `app.py:60-130`。

### 4.4 生命周期管理

`ChannelManager`（`app.py:133-441`）：

- `start()` 为每个通道起 daemon 线程跑 `startup()`（`:284-290`）；坏通道跳过不拖垮整个进程（`:230-235`）。
- `restart/add_channel/remove_channel`（`:367-440`）+ `_clear_singleton_cache` 反射清单例缓存（`:443-484`）。
- 进程级句柄放在 `common/channel_registry.py:17-26`（避免 `python app.py` 下 `__main__` 双模块导致拿到 None 的坑，注释 `:1-15`）。

### 4.5 群聊/会话规则（渠道无关）

`chat_channel._compose_context`（`chat_channel.py:46-189`）：群名白名单 `:70-97`、`group_shared_session` 决定群内共享还是每人独立 `:80-94`、群 @ 与昵称剥离 `:129-150`、单聊前缀 `:162-164`、图片生成前缀 `:171-177`。**这段是「国内 IM 语义」的集中地，抄的是规则不是代码。**

---

## 5. 【A5/C5】会话上下文怎么存、怎么裁剪（重点）

### 5.1 存储形态：SQLite append-only（每 Agent 一个库，实际共享一个全局库）

- 库路径：`<agent workspace>/memory/long-term/index.db`（`agent/memory/conversation_store.py:1-12`）。
- 三张核心表 + 辅助表（`conversation_store.py:46-158`）：
  - `sessions(agent_id, session_id, channel_type, title, context_start_seq, last_active, msg_count, pinned, context_usage)`，主键 `(agent_id, session_id)`（`:47-59`）；
  - `messages(agent_id, session_id, seq, role, content JSON, created_at, extras, run_id)`，唯一 `(agent_id, session_id, seq)`（`:61-72`）；
  - `runs(...)` 记录每次可寻址的 Agent 运行（可续跑/可追溯，`:95-127`）；`artifacts(...)` 产物索引（`:135-158`）。
- 迁移是「加列 + 索引分离 + `_migration_meta` 标记」，老库可原地升级（`:78-84,160-237`）。

### 5.2 写入

- 用户消息**先落盘**再跑 Agent：`AgentBridge._pre_persist_user_message`（`bridge/agent_bridge.py:2069-2116`），这样刷新页面不丢正在跑的会话。
- 回复后落盘：`_persist_messages`（`:2118-2187`），按 `enable_thinking` 决定剥离/保留 thinking block（`:2142-2163`）。
- `append_messages` 自己续 seq：`MAX(seq)+1` 并与 `context_start_seq` 取 max，防止清空后复用旧序号（`conversation_store.py:864-899`）；首条用户消息自动生成标题（`:907-923`）。
- 「清空上下文」= 只设边界不删数据：`clear_context()` 把 `context_start_seq` 设为当前最大 seq+1（`:928-952`）；`load_messages` 只读 `seq >= context_start_seq`（`:700-716`）。**这是很值得抄的「软清空」设计。**

### 5.3 读取与裁剪（A5 核心）

**两层裁剪：**

1. **读库层按「可见轮次」截断**：`load_messages(session_id, max_turns=30)`，`_rows_within_turns` 从新到旧数「真正的用户文本消息」（工具结果不算一轮），到预算即停（`conversation_store.py:667-768`，`:741-768`）。
2. **内存层按 token 预算裁剪**：`AgentStreamExecutor._trim_messages`（`agent/protocol/agent_stream.py:2937-3089`）：
   - 先 `_truncate_historical_tool_results()` 把历史工具结果 30K→10K（`:2949-2950`，实现在 `:2699`）；
   - 以「完整轮次」为单位（保证 tool_use/tool_result 不拆散，`:2952-2953`）；
   - 预算 = `context_window - output_reserve(20%) - system_prompt`（`:2958-2979`），`input_ceiling` 见 `:2969`；
   - 双约束：token 预算 **且** `max_context_turns`（默认 30，`agent.py:829`）都要满足，都满足则不动（`:2989-2998`）；
   - 不满足则从新到旧保留最长后缀（`_token_budget_trim` `:2914-2935`），至少保住上一轮（压成纯文本，`:3014-3024`）；
   - 被丢弃的轮次**异步摘要写回长期记忆**并回注摘要：`flush_memory(..., context_summary_callback=cb)`（`:3069-3082`），一次 LLM 调用同时用于「落盘记忆」和「回灌上下文」。
   - 裁剪只在**每次 run 开始前做一次**（`:1021-1029`），避免跑到一半拆断工具链导致模型死循环——这条注释（`:1021-1023`）本身就是踩坑经验。
- 溢出补救：`_smart_compact_to_budget`（`:2784-2880`）在 provider 报 context overflow 时 reactive 再压。
- 手动压缩：`Agent.compact_context(keep_recent_turns=2)`（`agent/protocol/agent.py:915-1053`），`/compact` 立即释放上下文。

### 5.4 会话生命周期服务

`SessionService`（`agent/chat/session_service.py:303-614`）：`list_sessions / delete_session / rename_session / clear_context / gen_title`，`dispatch(action,payload)` 作为协议单入口（`:542-614`）。标题生成走模型 + fallback 链（`:102-122`）。

### 5.5 旧短会话（非 Agent 模式）仍在

`models/session_manager.py:39-91`：`ExpiredDict(expires_in_seconds)` 做 TTL、`conversation_max_tokens` 兜底、子类实现 `discard_exceeding/calc_tokens`（`:32-36`）。这是 ChatGPT-on-WeChat 遗留的短会话路径，Agent 模式不用它。

---

## 6. 【C1/C2】Agent 主循环与停止条件

- 主循环：`agent/protocol/agent_stream.py:997 run_stream()`，`while turn < self.max_turns` 在 `:1100`；末尾兜底 `:1417`。
- 一轮定义：`_call_llm_stream`（`:1118`）→ 得到 `tool_calls` → `_run_parallel_calls`（`:1250`）→ 逐个 `_execute_tool`（`:2400`）→ 把 `tool_result` 作为 user 消息追加（`:1363-1368`）→ 下一轮。
- **停止条件**（都在 `run_stream`）：
  1. 无 tool_calls 即结束（`:1143-1223`；空回复会强制再要一次文字 `:1150-1191`）。
  2. 达到 `max_steps`（默认 100，`agent.py:105,139`）→ 注入「请总结」再调一次（`:1417-1436`）。
  3. 用户取消：`_check_cancelled`（`:432`）在每轮顶部与工具间检查。
  4. 连续失败熔断：`_check_consecutive_failures`（`:891`）→ 命中返回 `critical_error` 直接终止（`:1302-1305`）。
  5. 死循环提示：同工具同参数成功 3 次注入 `_inject_loop_hint`（`:1383-1392`，实现 `:962`），注释明确「temporary，下一轮看到后丢弃」。
  6. steer（运行中引导）会打断当前续写（`:1123-1140`）。
- 状态持久化/可续：executor 跑完把 `messages` 同步回 `Agent.messages`（`agent.py:861-900`），再由 `AgentBridge._persist_messages` 落 SQLite；`runs` 表带 `parent_run_id/task_id/status`（`conversation_store.py:95-127`），支持委派树回溯与断点续跑。

---

## 7. 【A6/A7】记忆

- 存储形态：**SQLite + FTS5 关键词 + 向量后端**，同一 `index.db`；chunk 结构见 `agent/memory/storage.py:103-116`（`id/user_id/scope/source/path/start_line/end_line/text/embedding/hash/metadata`）。
- 混合检索：`MemoryManager.search`（`agent/memory/manager.py:137-192`）向量 + 关键词，`_merge_results`/`_rank_normalize` 融合（`manager.py:723-801`），可选 reranker（`:801`）。
- 记忆文件：`MEMORY.md`（主）+ 每日 `daily`（`agent/memory/summarizer.py:226-253`）；裁剪/溢出时异步摘要落每日记忆（`summarizer.py:262-399`，`write_daily_summary` `:401-436`）；`deep_dream` 做定期整合（`:511`）。
- **溯源**：chunk 带 `source/path/start_line/end_line/hash`（`storage.py:103-116`），可按文件行回溯。
- **老化**：`_compute_temporal_decay(path, half_life_days=30)` 时间衰减（`manager.py:658`）；会话按天龄剪枝，`DEFAULT_MAX_AGE_DAYS = 30`（`conversation_store.py:239`，头注释 `:7`）。
- **冲突消解 / supersede 链**：**未找到**（全仓无 supersede / conflict-resolution 实现）。
- 跨会话召回：`memory_search` / `memory_get` 工具（`agent/tools/memory/memory_search.py`、`memory_get.py`，注册于 `agent/tools/__init__.py:157-158`），scope 分 `shared/user`（`manager.py:162-170`）。

---

## 8. 【D1–D5】界面

- 技术栈：桌面端 **Electron 33 + React 18 + zustand + Vite + Tailwind**（`desktop/package.json:23-46`）；Web 控制台是**无框架原生 JS + Jinja 模板**（`channel/web/static/js/**`、`channel/web/templates/**`），后端按功能拆 `channel/web/api/*.py`（chat/sessions/skills/memory/models/scheduler/...）。
- 布局范式：桌面 `NavRail + SessionList + ChatPage + WorkspacePanel`（`desktop/src/renderer/src/layout/NavRail.tsx`、`SessionList.tsx`、`pages/ChatPage.tsx`、`components/WorkspacePanel.tsx`）——左导航/会话列表/主对话/右侧工作区四区。
- 状态可见性：**强**。上下文用量环形图 `ContextUsageDonut.tsx` + `ContextUsagePopover.tsx`，数据来自 `Agent.get_context_usage()` 的 `{system,tools,history,free}` 分解（`agent/protocol/agent.py:531-670`），并优先用 provider 真实 `prompt_tokens`（`:614-648`）；执行步骤 `MessageSteps.tsx`；任务/调度页 `TasksPage.tsx`、`tasks-modal`。
- 主题/多工作区：主题 `desktop/src/renderer/src/theme/themes.ts` + `channel/web/static/css/themes.css` + `channel/web/api/themes.py`；多工作区 `WorkspaceSelector.tsx` + `agent/workspace/project_store.py`；i18n `desktop/src/renderer/src/i18n.ts`。
- 知识图谱：`KnowledgeGraph.tsx`（d3）。

---

## 9. ⭐ 最值得抄的 3 条机制

### 机制 1：事件钩子链 + 优先级排序 + plugins.json 持久启停（真正「派发」而不是「声明」）

- **位置**：`plugins/event.py:6-55`（事件/三态）、`plugins/plugin_manager.py:309-319`（按优先级派发、BREAK 短路）、`:232-234`（按 priority 排序）、`:121-158`（plugins.json 容错加载）、`:336-361`（启停落盘）、`channel/chat_channel.py:103/224-229/325-330/370-375`（四个真实挂载点）。
- **为什么好**：我们 `tools/plugin/kernel.mjs` 现在只有 `CONTRIBUTION_POINTS` 白名单和 `contribute()/invoke()`，但**没有任何宿主循环去调用它**——贡献点等于死代码。CowAgent 给出了缺失的另一半：宿主在管线固定位置 `emit_event(EventContext)`，内核按 `priority` 遍历所有「监听该事件」的插件，用 `CONTINUE/BREAK/BREAK_PASS` 决定是否短路默认逻辑，且启停/优先级持久化在 `plugins.json`。这套「事件 + 有序链 + 三态短路」是插件生态真正能跑起来的骨架。
- **我们抄到哪**：`tools/plugin/kernel.mjs`（补 `emit(event, ctx)` 遍历 + 每事件监听表 + `continue/break/breakPass` 三态 + `priority` 排序）；启停状态持久化到插件的 `plugin.json`/状态文件，对应 kernel 现有 `validateManifest/topoSort` 之后加 `dispatch`。

### 机制 2：三层渠道抽象 + ChatMessage 标准化 + 多实例每实例凭据

- **位置**：`channel/channel.py:12-188`（Channel 契约）、`channel/chat_message.py:70-121`（标准化消息，必填项文档 `:1-33`）、`channel/chat_channel.py:27-830`（统一管线：队列/取消/插件/群规则）、`channel/channel_factory.py:8-36,54-107`（工厂 + 多实例）、`channel/channel_instances.py:79-143,146-172,272-288`（凭据键表/多实例白名单/统一解析）、`channel/channel.py:42-100`（`cfg()` 与身份注入）。
- **为什么好**：我们 A10 判「无」，缺的不是某个 IM SDK，而是**抽象层**。CowAgent 证明：把「收消息」压成 `ChatMessage`、把「处理消息」全部收进 `ChatChannel`、把「发消息」抽象成 `send(reply, context)`，新接一个渠道只需实现 `startup + 消息适配` 两件事，插件/记忆/队列/取消/群规则全部自动继承。且它解决了「同一个渠道跑多个 bot、每个 bot 绑不同 Agent、各自一套凭据」的真实企业需求（`CREDENTIAL_KEYS` + `cfg()` + `stamp_instance_context`）。
- **我们抄到哪**：新增 `tools/channel/` 适配层（`Channel` 基类 + `ChatMessage` 归一化 + `ChannelHub` 管线），先在 Web/CLI 通道落地，再按需接 IM；多实例凭据表照 `channel_instances.CREDENTIAL_KEYS` 建模。

### 机制 3：会话上下文「双层裁剪 + 软清空 + 摘要回灌」

- **位置**：`agent/memory/conversation_store.py:46-72`（append-only 表）、`:667-768`（可见轮次截断）、`:796-926`（续 seq 写入）、`:928-952`（`context_start_seq` 软清空）；`agent/protocol/agent_stream.py:2937-3089`（token 预算 + 轮次上限双约束裁剪）、`:3069-3082`（丢弃轮次摘要写回记忆 + 回注上下文）；`agent/protocol/agent.py:915-1053`（`/compact` 手动压缩）。
- **为什么好**：我们的会话管理要么全量塞、要么硬删。CowAgent 的做法是：**磁盘 append-only 永不丢历史 + 读时只取最近可见轮次 + 内存里按 token/轮次双预算裁剪 + 被裁的轮次摘要写回长期记忆并回注一条摘要**，还有「清空只设边界不删数据」的软清空。这样既省钱又不丢信息，且「摘要一次 LLM 调用同时服务落盘和回灌」避免两次调用。裁剪只在一轮开始前做、以完整轮为单位、保 tool_use/tool_result 成对，这些都是我们容易踩的坑。
- **我们抄到哪**：`tools/session/`（或现有会话存储模块）——SQLite 表结构照 `sessions/messages`；裁剪算法照 `_trim_messages` 的「token 预算 + 轮次上限 + 完整轮单位 + 摘要回灌」；`clear_context` 的边界 soft-delete 直接照搬。

---

## 10. 我们不该抄的

1. **单文件失控**：`agent/protocol/agent_stream.py` 3166 行、`agent/memory/conversation_store.py` 2860 行、`bridge/agent_bridge.py` 2574 行、`channel/chat_channel.py` 830 行。都是功能堆积的产物；我们若照抄会把复杂度直接搬进来。**只抄算法/契约，不抄文件组织。**
2. **插件零隔离**：`plugin_manager.py:193-205` 直接 importlib 跑，插件拿整个 channel/config。我们 `kernel.mjs` 已用 `Object.freeze(ctx)` 做只读注入，**不该退化成 CowAgent 的裸奔**；但也不该像现在这样「声明了贡献点却没人派发」。
3. **显式 if/elif 工厂**：`channel_factory.py:54-107` 每加通道改一处，容易漏。我们应做成注册表（`register(type, factory)`）而非照抄分支。
4. **聊天命令管理后台**：`#installp` / `#scanp`（`plugins/README.md:28-36`，`godcmd.py`）是 2022 年的交互形态，我们有 GUI，没必要复刻。
5. **大一统 config.py**：`config.py` 1058 行 `available_setting` 把所有键（含 20+ 模型、语音、翻译、渠道）平铺；与我们分模块配置的方向相反。
6. **重复的供应商样板**：`models/` 下 20+ 家各自一份 `*_bot.py`/`*_session.py`（`models/openai`、`models/deepseek`、`models/qwen`...），大量结构雷同；我们若要抄 LLM 接入，抄 `model_catalog.py` + `custom_provider.py` 的「目录驱动」即可，不要每家一份。
7. **国内 IM 特化逻辑**：`channel/wechatmp`（公众号被动/主动回复）、`channel/wechatcomapp`、微信扫码登录等，与我们的形态（无微信生态）不匹配，抄抽象不抄实现。

---

## 附：证据索引（便于复核）

- 插件：`plugins/plugin_manager.py:48-66,121-158,182-230,232-234,261-274,309-319,336-361,366-463`；`plugins/event.py:6-55`；`plugins/plugin.py:12-49`；`plugins/hello/hello.py:12-43`；`plugins/README.md:183-273`。
- 渠道：`channel/channel.py:12-188`；`channel/chat_message.py:1-121`；`channel/chat_channel.py:27-189,191-278,368-408,542-723`；`channel/channel_factory.py:8-107`；`channel/channel_instances.py:79-288`；`app.py:60-441`；`common/channel_registry.py:17-26`。
- 会话/上下文：`agent/memory/conversation_store.py:46-72,95-158,667-768,796-952,1139-1222`；`agent/protocol/agent_stream.py:997-1436,2699,2937-3089`；`agent/protocol/agent.py:915-1053`；`bridge/agent_bridge.py:1453-1508,2069-2187`；`agent/chat/session_service.py:303-614`。
- 记忆：`agent/memory/manager.py:63-192,658,723-801`；`agent/memory/storage.py:1-120`；`agent/memory/summarizer.py:226-436`；`agent/memory/__init__.py:1-68`。
- 工具/技能：`agent/tools/base_tool.py:82-251`；`agent/tools/tool_manager.py:31-194,355-604`；`agent/skills/loader.py:76-159`；`agent/skills/manager.py:211-300,346-472`；`agent/skills/service.py:112-577`；`skills/image-generation/SKILL.md:1-15`。
- MCP：`agent/tools/mcp/service.py:99-274`；`agent/tools/tool_manager.py:355-604`；`channel/web/templates/modals/mcp-editor.html`。
- 调度：`agent/tools/scheduler/scheduler_service.py:51-401`。
- 权限：`agent/permission/policy.py:1-90`；`agent/protocol/agent.py:243-298`。
- UI：`desktop/package.json:23-46`；`desktop/src/renderer/src/layout/NavRail.tsx`、`pages/ChatPage.tsx`、`components/ContextUsageDonut.tsx`、`theme/themes.ts`；`channel/web/static/js/**`、`channel/web/api/*.py`。
