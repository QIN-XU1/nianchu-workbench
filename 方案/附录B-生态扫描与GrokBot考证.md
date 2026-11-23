# 附录 B · 生态扫描与 Grok Bot 考证

> 目的：把 `01-源材料深度分析.md` §4–§5 的证据摊开，并记录**我如何确认 GrokBot 是什么**。
> 采集时间：2026-11-05 ~ 11-06。采集方式：DuckDuckGo lite、Hacker News Algolia API、GitHub API、官方文档抓取。
> 原始快照存于 `research/raw/grokbot/`、`research/raw/ecosystem/`。

---

## 1. GrokBot 考证（这是纠错）

### 1.1 用户原话与问题

用户提到"最近比较火的 GrokBot 之类的"。**"GrokBot" 这个名字在官方语境里是错误的**，正式名称是 **Grok Bot**（两个词，大写 G 小写 b）。

### 1.2 三条独立证据链

**证据链 1 · 搜索结果（DuckDuckGo lite）**

| 结果 | URL |
|---|---|
| Introducing Grok Bot \| SpaceXSI | `x.ai/news/introducing-grok-bot` |
| Grok Bot \| SpaceXSI Docs | `docs.x.ai/grok-bot/overview` |
| Grok Bot Marketplace | `x.ai/bot/marketplace` |
| Grok Bot (@bot) / X | `x.com/bot` |
| Cursor · Download Grok Bot | `cursor.com/download/bot` |
| Grok Bot sign-in \| Docs | `docs.x.ai/x-subscription/grok-bot-sign-in` |
| Grok Bot iPhone and Android download | `grokbot.run/learn/phone-download/` |
| Download Grok Bot: official Mac/Windows/Linux/phone | `grokbot.run/learn/install/` |
| grokbot.dev — ready-to-use Grok Bot prompts/plugins | `grokbot.dev` |

**证据链 2 · Hacker News（Algolia API，`nbHits: 2814`）**

| 标题 | URL | 分 |
|---|---|---|
| Grok Bot \| https://x.ai/bot | | 351 |
| Grok Bot by SpaceXAI | `x.ai/news/introducing-grok-bot` | 59 |
| Prompts for our Grok chat assistant and grok bot on X | `github.com/xai-org/grok-prompts` | 39 |
| Whoops: Grok Bot Spills Tech CEO's Bank Data in Public Slack | `techdirt.com`（2026-10-19） | 36 |
| Grok Bot for Linux: Unofficial port of the official app | `github.com/jakob-bu/grok-bot-linux-unofficial` | 33 |
| Show HN: Open Bot – an open-source Grok Bot that works with any agent harness | `github.com/copilotkit/openbot` | 12 |
| Grok Bot Throttled After xAI Costs Outpaced Subscription Revenue | `gadgetreview.com` | 8 |
| Elon Musk throttles Grok Bot limits due to 'unsustainably high' costs | `techcrunch.com`（2026-11-02） | 6 |
| Show HN: Agent Office (Slack for AI Agents) – Similar to Grok Bot but older | `github.com/baturyilmaz/agent-office` | 6 |
| Would you give Grok bot access to your bank accounts? | `twitter.com/elonmusk/status/…` | 5 |
| Grok Bot \| `twitter.com/bot/status/…` | | 5 |
| How Grok Bot Works | `peterp.me/articles/what-actually-happens-when-you-message-grok-bot/` | 5 |
| Show HN: GBDL – one Markdown+YAML file to save a multi-agent Grok Bot setup | `github.com/jcpsimmons/gbdl` | 5 |
| Show HN: Linubot – like Grok bot and Hermes had a kid | `github.com/agent-sh/linubot` | 5 |
| Errand – open-source Grok Bot and Muse alternative | `runta.com/blog/building-errand-in-one-week/` | 4 |

**证据链 3 · GitHub（`api.github.com/search/repositories?q=GrokBot`，`total_count: 1130`）**

| 仓库 | ★ | 描述 |
|---|---|---|
| `najmuzzaman-mohammad/gawkbot` | 1541 | open source grok bot. gawk bots automate your menial work via AI models and build you microapps… |
| `CelestoAI/celesto` | 1132 | Secure and persistent computer for AI agents |
| `unicodef1wn/grokbot-field-notes` | 680 | Rules, playbooks, bot roles and a failure log from the **xAI Grok Bot team's 72-hour live build**. Drop AGENTS.md |
| `BotHarness/DeepSeekBot` | 651 | Open-source GrokBot alternative built on **DeepSeek Harness**. Build your personal bot team |
| `kydlikebtc/awesome-grokbot` | 470 | 1894 live x.ai/bot shares for Grok Bot — every link status-checked |
| `sit-in/awesome-grokbot-playbooks` | 469 | 中文 Grok Bot 玩法与可抄配方清单 |
| `elie222/botdirectory.ai` | 298 | Open-source directory of agent-bot prompts for Grok Bot |
| `ScriptedAlchemy/grok-bot-cli` | 168 | CLI for Grok Bot agents and groups |
| `majiayu000/awesome-grok-bot` | 143 | 6688 live x.ai/bot shares |
| `runta-dev/errand` | 143 | open-source take on Grok Bot/Muse. Persistent AI teammates with their own cloud computers |
| `serenakeyitan/agent-org-chart` | 103 | Awesome catalog of portable agent org charts — pick one, paste to your grokbot |
| `ZeroPointRepo/awesome-grok-bot` | 101 | Grok Bot skills, plugins, and MCP servers: 60+ verified entries |
| `cobusgreyling/grok-bot-templates` | 89 | The engineering kit for Grok Bot templates |
| `robbin/grokbot-local-agent` | 85 | Let Grok Bot hand heavy work to a local agent (Pi) on its own computer |
| `xianyu110/grokbot` | 75 | Grok Bot 完整使用指南（2026 图文版） |

### 1.3 结论

**Grok Bot 是 xAI 的正式付费产品，2026-08-11 发布，Beta 期。** 不是开源项目，不是小众工具，也不是营销概念。

关键资质（官方原文）：
> Grok Bot is in beta and available today for **SuperGrok, SuperGrok Plus, and SuperGrok Heavy; Cursor Pro, Pro+, and Ultra; and Cursor Teams Standard and Premium** subscribers on desktop and iOS. Grok Bot comes with **its own usage, separate from your Grok and Cursor plans**. — `x.ai/news/introducing-grok-bot`

> The computers Bots work on run in **Cursor's cloud**. — `docs.x.ai/grok-bot/overview` FAQ

> On The X Subscription, Grok Bot is included with Premium, Super, and Ultra and **draws from the same weekly usage pool as Cursor and the Grok apps**. — 同上

**[推断] 品牌表述是 "SpaceXSI"**（`x.ai/news` 页面标题与 Hacker News 标题均如此），指的是 xAI 与 Cursor 合作的品牌实体。这一层交叉印证了 `docs.x.ai` 与 `x.ai` 是两个官方域。

### 1.4 一个必须记录的负面新闻

Hacker News 上有一条 36 分的负面报道：
> **Whoops: Grok Bot Spills Tech CEO's Bank Data in Public Slack** — `techdirt.com/2026/10/19/…`

以及两条成本相关：
> **Grok Bot Throttled After xAI Costs Outpaced Subscription Revenue** — `gadgetreview.com`
> **Elon Musk throttles Grok Bot limits due to 'unsustainably high' costs** — `techcrunch.com/2026/11/02/…`

**[推断] 这三条对我们极有价值**：
1. 第一条**实证了"持久云电脑 + 共享登录态"的现实风险**（对应 `PRODUCT.md:57` 的矛盾：一边说"每 Bot 独立 Linux VM"，一边说"账户内共享电脑/文件/登录态"）。**这正是我们 `02` §9 要超越的地方。**
2. 第二条、第三条**实证了成本是这类产品的头号问题**——它直接支撑我们"注意力税 < 1.0"与"四类预算"的设计不是洁癖，是生死线。

---

## 2. Grok Bot 官方架构要点（原文摘录）

来源：`docs.x.ai/grok-bot/overview`、`x.ai/news/introducing-grok-bot`。

### 2.1 官方定位

> Grok Bot gives you Bots you can keep around: **AI teammates with names, jobs, and context that compounds over time**. Each Bot works on a **persistent cloud computer** with a browser, filesystem, and terminal, so **tasks finish in your real tools instead of as chat drafts**.

### 2.2 五条"为什么不同"（原文）

| # | 原文 | 我的翻译 |
|---|---|---|
| 1 | **Each Bot has a computer.** Persistent cloud computer with browser, filesystem, terminal. Work continues while your laptop is closed. | 持久执行环境（= Super-agent 的"环境不跟着 Loop 上云"的反向做法：它把环境也上云了） |
| 2 | **Setup is a message, not a workflow builder.** Create a Bot, describe the job, grant access as it asks. | 无需编排器；描述即配置 |
| 3 | **Bots coordinate with each other.** Run in parallel, message each other, share context in group chats, and **pass ownership of a task**. | 多 Agent + **任务所有权转移**（这点值得抄） |
| 4 | **Bots learn workflows from demonstration.** Walk a Bot through a multi-step path once, and it can save the path as a **skill** and rerun it on a **schedule**. | **演示学习 → 技能 → routine**（这是它最强的进化闭环） |
| 5 | **Context compounds.** A named Bot keeps its memory, files, browser sessions, and preferences across sessions instead of resetting. | 命名实体的持久上下文 |

### 2.3 共享与隔离（原文，注意它内部是矛盾的）

> **Your Bots share one computer.** All of your Bots use the same cloud computer, sharing its files, browser sessions, and app logins... The computer belongs to your account, not to an individual Bot, so treat anything placed on it as available to every Bot you run; **between users, isolation is strict.**

vs.

> Each bot runs on **its own Linux VM**. One bot cannot touch another bot's computer. — `reference/PRODUCT.md:57`

**[推断] 这是官方口径的前后变化**（field notes 作者明确记录了："Where speakers contradicted each other, the resolution is noted."）。这说明**"隔离粒度"在快速迭代的产品里还没定论**。

**我们的判断**：**不照抄任何一方**。采用"**逻辑隔离（每场景独立目录 + 独立记忆 + 独立权限）+ 物理隔离（Worker 按爆炸半径决定是否需要独立沙箱）**"。低风险场景共享底座省钱，高风险场景独立沙箱。

### 2.4 FAQ 两条关键

> **Can several Bots work at the same time?** Yes... **Each Bot gets its own screen on the shared computer, and one Bot runs one computer-use task on its screen at a time.**

> **What does a Bot remember?** Stable preferences, role context, and summaries of prior work. Conversations and learned context stay separate per Bot, **except for a few facts about you** (name, time zone) that all your Bots share. **For consequential decisions, ask the Bot to check the current source instead of relying on memory.**

最后那句我认为极重要：
> **"For consequential decisions, ask the Bot to check the current source instead of relying on memory."**

它等价于我们的 **R3 溯源绑定到原始字节**（`03` §7.2）——**记忆不可信，关键决策要回源**。这是 xAI 官方自己承认记忆不可靠。

---

## 3. Grok Bot Field Notes：40 条事故的完整清单（分类摘录）

来源：`github.com/unicodef1wn/grokbot-field-notes`（★680，MIT）。作者说明："Three engineers from the xAI Grok Bot team built and launched a product from an empty repo in **72 hours, live on stream**"，三人分别为 Roshan Sadanani（产品）、Lauren Tan（工程，PStack 作者）、Matt Palmer（开发者体验）。

### 3.1 它有什么

| 路径 | 内容 |
|---|---|
| `AGENTS.md` | 仓库级规则（**本仓库根目录已存在一份，harness 自动加载**） |
| `ANTIPATTERNS.md` | **40 条直播事故**，每条：发生了什么 → 为什么 → 由此产生的规则 |
| `agents/` | 深度参考：`VERIFICATION.md`、`ORCHESTRATION.md`、`PROMPTS.md` |
| `roster/` | **69 个 agent 角色**，一个文件一个：owns / doesn't own / 事实来源 / 需批准事项 / 可粘贴的描述 |
| `playbooks/` | 9 个角色工作坊（工程/PM/创始人/销售工程/销售/SDR/支持/售后/市场） |
| `guide/` | 2 个 PDF（24 页三天故事 + 14 页营销） |
| `reference/` | `ECONOMICS.md`（每个成本与指标都带支撑它的规则）、`PRODUCT.md`（记忆/隔离/权限） |
| `notes/` | 每天一份结构化笔记 |

### 3.2 从 40 条里我筛选的"改变架构决策"的 8 条

（完整清单见 `01` §4.4；此处只补原文关键句）

| # | 原文关键句 | 架构含义 |
|---|---|---|
| **7** | 无限制的周度自检一次发"十个新 bot 要建" → Blake 的规则：**"Cap suggestions — one per week."** | 进化配额 |
| **8** | 三个数值应和为 100，实际不是 → **"Every invariant you can state goes in a test or a visible debug readout."** | 不变量必须可执行 |
| **15** | 概览卡与详细历史数字不一致 → **"One source computes derived numbers; everything else displays it."** | 单一真源 |
| **29** | 自主修复发坏 SQL 打挂生产 → **"Keep a human gate on migrations, deploys and anything touching production data, however well the loop has been working. Set autonomy from blast radius."** | D5 五类强制 review |
| **31** | "目前是坏的——提交什么都不会发生" → **"Don't announce or demo anything you haven't run end to end today, with the account you'll use on stage."** | DoneSpec 必须真跑 |
| **34** | 每 15 分钟 routine → **"Audit routine frequency. Once or twice a day is the default; prefer webhooks and inbound signals to blind schedules; tell routines to say nothing on a no-op."** | 预算闸 |
| **36** | Agent `sleep 300` → **"A routine checks running agents on a short interval for long sleeps, drift and unexplained activity, and interrupts."** | Watchdog W2 |
| **38** | "串行工厂、人肉合并、Lauren 作为中断总线" → **"Periodically ask the factory where *you* are the bottleneck."** | 注意力税指标 |

### 3.3 它提炼的 5 条总律（我认为是这份材料的最好部分）

> 1. **Write the principle, delete the story.**
> 2. **Reproduce it, run it, play it, then prove it.**
> 3. **Name the source of truth and the library.**
> 4. **Set autonomy from blast radius; keep human gates on prod, money and secrets.**
> 5. **Frequency and group chats are where the tokens go.**

我们采纳：`02` §1（不变量 3）、`02` §7.2（principle-not-incident 的强制实现）、`03` §5.2、`02` §9 D5、`02` §10。

---

## 4. 生态扫描（按类别，只列有机制可借的）

### 4.1 编码 Agent

| 项目 | 定位 | 值得抄的机制 | 不该抄的 |
|---|---|---|---|
| **OpenHands**（All-Hands-AI） | 开放的手软工程 Agent 平台 | 沙箱化 runtime；任务可重放；runtime 与环境分离的工程实现 | 抽象绑死"软件工程任务" |
| **SWE-agent**（SWE-agent） | 专门修 GitHub issue | **ACI（Agent-Computer Interface）：为模型设计界面，而非为人** | 只针对仓库级修复 |
| **Agent Zero**（frdel） | 层级式 Agent 框架 | 上级可派生下属；持久记忆；**工具可自动创建** | 单机、无多租户、以提示词为主 |
| **Cline**（cline/cline） | IDE 内 Agent | 人类审批点（每一步可批准）；diff 预览 | 强绑 IDE |

### 4.2 通用/多场景

| 项目 | 定位 | 值得抄 | 不该抄 |
|---|---|---|---|
| **Grok Bot** | 云端持久 Bot 团队 | one-bot-one-job、autopilot ladder、演示→技能→routine、成本六律 | 共享电脑模型、云 S3 记忆、闭源 |
| **Manus**（闭源，仅公开材料） | 通用任务 Agent | "任务即交付物"的产品化；artifact 优先 | 无法审计架构 |
| **Devin**（闭源） | 工程 Agent | 长时任务的可观测性 | 同上 |
| **Dify**（langgenius/dify） | LLM 应用平台 | 工作流 DSL + 可视化；插件/工具市场 | 以"应用"为单位，非"场景自治" |
| **n8n**（n8n-io/n8n） | 通用自动化 | 触发-动作模型；**事件驱动 + 可视化** | 确定性流水线，无 Agent 判断 |

### 4.3 编排框架

| 项目 | 定位 | 值得抄 | 不该抄 |
|---|---|---|---|
| **LangGraph**（langchain-ai/langgraph） | 有状态图编排 | **显式状态机 + 检查点（checkpoint）**；可恢复 | 图是开发者手画的，不是 Agent 自组织的 |
| **CrewAI**（crewAIInc/crewAI） | 角色协作团队 | 角色/任务/流程三段式；**角色即抽象** | 团队规模一上去就乱（同 Grok Bot 的 bot sprawl） |
| **AutoGen/AG2**（microsoft/autogen） | 多 Agent 对话 | 多方对话协议；可编程的会话模式 | 对话即编排，难以做确定性保证 |
| **OpenAI Agents SDK**（openai/openai-agents-python） | 轻量 Agent 原语 | **handoff（交接）+ guardrail（护栏）** 两个原语，干净 | 无持久化/无多租户 |
| **Claude Code + Agent Skills** | 编码 Agent + 技能 | **SKILL.md 模式**：name+description 自动进上下文，正文按需读 | 单机、单仓 |

> **[推断] `SKILL.md` 的加载机制（只有 name+description 自动进上下文，正文按需读）是我们"三级技能"的直接依据**，也是 `乱雨家 六-记忆分三层.md:13` 同一条结论的独立印证。

### 4.4 记忆

| 项目 | 机制 | 我们的用法 |
|---|---|---|
| **mem0**（mem0ai/mem0） | 提取→存储→更新→检索；区分事实/偏好/事件；冲突 update/delete | v2 记忆写入策略 |
| **Letta / MemGPT**（letta-ai/letta） | 分层记忆（core/archival/recall）；**模型可自己调工具编辑自己的记忆** | 自进化的"模型改记忆"合法形态 |
| **Zep / Graphiti** | 时序知识图谱，**事实带有效时间窗**，新事实失效旧事实 | v2 的 `revise` 算子 |
| **HippoRAG** | KG + Personalized PageRank 多跳检索 | v2 的召回（对应 Super-agent 链式召回） |

对应 arXiv 侧的独立印证：
- **GEM**（arXiv:2605.26252）给出四个状态级算子（ingestion/revision/forgetting/retrieval）与四种失效模式 → 我们的 `03` §7.1
- **记忆投毒**（arXiv:2606.24322）证明"纯内容/纯血缘防御不成立" → 我们的 R1–R5（`03` §7.2）

### 4.5 协议与规范

| 规范 | 用途 | 我们的取舍 |
|---|---|---|
| **MCP**（modelcontextprotocol.io） | 工具接入标准 | ✅ **选它**。DSH 已原生支持；VCP 的自造文本协议不如它 |
| **A2A**（a2aproject/A2A） | 跨 Agent 通信 | ❌ v1 不用（Super-agent 8.3 亦承认未解）；只预留接口 |
| **AGENTS.md**（agents.md） | 仓库级 Agent 规则 | ✅ 用，但升级为"可版本化 + 可校验"（Grok Bot 的 `AGENTS.md` 就是范例） |
| **VCP 协议** | 纯文本工具调用 | ❌ 不选（丢类型校验/UI/流式，见 `01` §3.8 对比表） |

---

## 5. "为什么大多数 Agent 都退化成 coding-only"（因果分析）

这是用户关心的核心问题。我给**四个原因 + 一个反证**。

### 原因 1：只有代码场景的"done"是可机器判定的

写代码有编译器、测试、CI。做别的（发邮件、改 CRM、做图、做调研）**没有自动判据**，Agent 只能"看起来做完了"。

Grok Bot 的整个 `AGENTS.md` 就是在对抗这件事（"Verification is the job. Writing code is the easy part."），但它的解法是**教人怎么教 Agent**，而不是**让系统强制可判定**。

**→ 我们的回答：DoneSpec 三形态 + `working/verifying` 阶段**（`02` §3.3、§4.2）。

### 原因 2：工具生态偏科

代码工具（git/shell/编辑器）**标准且本地**；业务工具**要么没 API，要么 API 各异**。Grok Bot 用"云电脑 + 浏览器"绕过这一层——代价是贵且脆（`ANTIPATTERNS` #26：浏览器会话掉登录；#27：connector 在最糟的时刻需要重认证）。

**→ 我们的回答：工具族 + MCP 优先 + computer-use 作为降级手段**（`02` §7.1、§9）。

### 原因 3：上下文抽象错位

coding 的上下文是"文件 + 仓库结构"，天然可按需读；通用场景的上下文是"事件 + 关系 + 历史"，需要**领域建模**。多数框架只做"对话历史 + 向量检索"，一跨场景就失忆。

**→ 我们的回答：七通道 + 三种记忆层 + 溯源图**（`02` §6、§7.3）。

### 原因 4：没有"场景"这个抽象

只有一个"通用 Agent"，于是什么都想吃、什么都不精。

**反证（这是最有力的一条）**：两个**完全独立**的来源收敛到同一个结论：
- 乱雨家：`00-核心机制/三-场景体系.md:4` —— "一个场景 = 一类活 + 一套资产 + 一套流程 + 一条常驻 AI"
- Grok Bot：`agents/ORCHESTRATION.md:8-24` —— "One bot, one job"，并给了四条理由

**→ 我们的答案**（本方案的核心命题，`02` §0）：
> **SEA 的"通用"，不是"一个 Agent 会所有事"，而是"新增一类场景 = 写一份契约，零代码改动"。**

---

## 6. 从生态里提炼的 10 条硬结论

| # | 结论 | 支撑 |
|---|---|---|
| 1 | **组织单位必须是"场景/Bot"，不是"通用 Agent"** | 乱雨家 §三 + Grok Bot ORCHESTRATION（独立收敛） |
| 2 | **验证必须是系统强制的，不是教出来的** | Grok Bot AGENTS.md 是"教"；我们要"强制"（DoneSpec） |
| 3 | **权限按爆炸半径分档，不是二元开关** | Grok Bot autopilot ladder + Super-agent accept mode |
| 4 | **技能加载要"轻入口 + 按需正文"** | Claude Agent Skills / 乱雨家记忆三层（独立印证） |
| 5 | **记忆不可信，后果性决策必须回源** | xAI 官方 FAQ 原话 + arXiv:2606.24322 |
| 6 | **自进化必须有配额，且默认极小** | Grok Bot #7（一周一个建议） |
| 7 | **唤醒/群聊是成本黑洞** | Grok Bot ECONOMICS + 乱雨家"≤3 条消息" + Super-agent relay/notice 区分 |
| 8 | **长任务等待该由"模型自报"而不是"固定轮询"** | VCP `[[NextHeartbeat::N]]`（但必须加上限） |
| 9 | **工具应族化（同族参数同构）** | VCP"同类插件共用一套指令"（体验层面正确） |
| 10 | **协议选 MCP 不选自造** | MCP 生态 + DSH 原生支持 + VCP 协议缺类型校验 |

---

## 7. 证据索引

### 7.1 本地快照

| 内容 | 路径 |
|---|---|
| Grok Bot 官方发布文 | `research/raw/grokbot/xh_intro.html`（→ `x.ai/news/introducing-grok-bot`） |
| Grok Bot 官方文档总览 | `research/raw/grokbot/docs_overview.html`（→ `docs.x.ai/grok-bot/overview`） |
| Grok Bot 文档其余页 | `research/raw/grokbot/doc_*.html`（get-started / use-cases / shared-bots / files-and-results / settings / approvals / teams / troubleshooting / faq） |
| Field Notes 原文 | `research/raw/grokbot/field/`（AGENTS.md、ANTIPATTERNS.md、reference_PRODUCT.md、reference_ECONOMICS.md、agents_ORCHESTRATION.md、agents_VERIFICATION.md、agents_PROMPTS.md、roster_README.md） |
| 第三方解读 | `research/raw/grokbot/peterp.html`、`erdand_blog.html` |
| 搜索原始结果 | `research/raw/grokbot/bing_*.html`、`ddg*.html`、`hn.json`、`gh.json` |
| 生态 README 快照 | `research/raw/ecosystem/`（OpenHands、agent-zero、Cline、mem0、Letta、dspy、openai-agents、langgraph、crewAI、autogen、dify、n8n、a2a、mcp、voyager、swe-agent） |
| 进化论文摘要 | `research/raw/evolution/arxiv_*.xml`、`abs_*.xml` |

### 7.2 外部 URL

| 类别 | URL |
|---|---|
| Grok Bot 官方 | https://x.ai/bot · https://x.ai/news/introducing-grok-bot · https://docs.x.ai/grok-bot/overview |
| Grok Bot 生态 | https://github.com/unicodef1wn/grokbot-field-notes · https://github.com/najmuzzaman-mohammad/gawkbot · https://github.com/BotHarness/DeepSeekBot · https://github.com/serenakeyitan/agent-org-chart · https://github.com/copilotkit/openbot |
| 负面报道 | https://www.techdirt.com/2026/10/19/whoops-grok-bot-spills-tech-ceos-bank-data-in-public-slack/ · https://techcrunch.com/2026/11/02/elon-musk-throttles-grok-bot-limits-due-to-unsustainably-high-costs/ |
| 编码 Agent | https://github.com/All-Hands-AI/OpenHands · https://github.com/SWE-agent/SWE-agent · https://github.com/frdel/agent-zero · https://github.com/cline/cline |
| 通用/平台 | https://github.com/langgenius/dify · https://github.com/n8n-io/n8n |
| 编排 | https://github.com/langchain-ai/langgraph · https://github.com/crewAIInc/crewAI · https://github.com/microsoft/autogen · https://github.com/openai/openai-agents-python |
| 记忆 | https://github.com/mem0ai/mem0 · https://github.com/letta-ai/letta |
| 协议 | https://modelcontextprotocol.io · https://a2aproject.github.io/A2A · https://agents.md |
| 进化（论文） | 见 `03-自进化机制.md` §13 |
