# 121 · 主 Agent（中枢）编排：业界可查证实践

> 目的：给中枢的核心指令定稿提供依据。每条结论尽量带原始出处；【判断】标记的是我在证据之上的推论，不是原文。
> 抓取时间：2026-11。文档类来源为官方文档当前版本，引用时请以 URL 为准。
> 未找到的部分集中在文末 §7，明确标注"未找到"。

---

## 0. 先给结论（一句话版）

| 问题 | 结论 |
|---|---|
| 主 agent 核心工作 | **不是"分派 + 拼接"，是"把模糊需求变成可验收的工单 + 维护一本台账 + 判定何时算完"** |
| 判断归属 | 不能靠自由判断：**闭集 + 结构化输出 + 置信阈值 + 负向规则 + 校准集**，五件套 |
| 派单跟踪 | 五态**不够**：缺 `returned / verified / failed / blocked / cancelled`，也缺 `attempt` 与 `depends_on` |
| 汇总 | **指针 + 结论 + 分歧**，正文永远留在场景产物里；原样转发是可选项，不是兜底 |
| prompt | 注入只放**身份/名册/契约/不变量/输出格式**；流程做成工具 schema 与代码校验，不写进 prose |
| 反模式 | 越界、过度派单、假完成、传话失真、把 supervisor 变成串行瓶颈 |

---

## 1. 主 agent 到底做什么

### 1.1 六个实现里的实际职责（原文）

**Anthropic · orchestrator-workers**
> "a central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes their results."
> 来源：https://www.anthropic.com/engineering/building-effective-agents

**Anthropic · Research 系统的 lead agent**（生产实现，最细）
- 分析 query → 制定策略 → 派生 subagent 并行探索
- 汇总 subagent 结果 → **判断是否需要继续研究** → 需要则"create additional subagents or refine its strategy"
- 上下文超 200k 会截断，所以 **先把 plan 落到 Memory 里保住**
- 最后交给独立的 CitationAgent 补引用（**归因是单独一趟，不是合成器顺手做**）
> 来源：https://www.anthropic.com/engineering/multi-agent-research-system

**Microsoft · Magentic-One Orchestrator**（职责写得最像岗位说明书）
论文 §1 明确五个功能：
> "it formulates a plan, maintains structured working memory of progress, directs tasks to other agents, restarts and resets upon stalling, and determines task completion."
> arXiv:2411.04468

内层循环每轮回答**五个问题**（原文）：
1. Is the request fully satisfied?
2. Is the team looping or repeating itself?
3. Is forward progress being made?
4. Which agent should speak next?
5. What instruction or question should be asked of this team member?

外加一个 stall 计数器：无进展或是原地打转就 +1，超过阈值（论文实验 ≤2，AutoGen 实现默认 `max_stalls=3`）就跳出内层循环、反思、更新事实与计划、重排期。
> 源码：`.../_magentic_one/_magentic_one_orchestrator.py`、`_prompts.py`（GitHub microsoft/autogen）

**LangGraph supervisor**
> "The supervisor controls all communication flow and task delegation, making decisions about which agent to invoke based on the current context and task requirements."
> 来源：https://github.com/langchain-ai/langgraph-supervisor-py
> 注：该库已不推荐，官方改为「把 worker 当 tool 的 supervisor 模式」。

**CrewAI · hierarchical process**
> manager "oversees task execution, including planning, delegation, and validation. Tasks are not pre-assigned; the manager allocates tasks to agents based on their capabilities, reviews outputs, and assesses task completion."
> 来源：https://docs.crewai.com/en/concepts/processes

**OpenAI Agents SDK**：两种语义要分清（选错了整个系统会歪）
| 模式 | 谁拥有最终答复 | 何时用 |
|---|---|---|
| Agents as tools | manager 保留控制权，汇总多方结果 | 你要一个 agent 对最终答案负责、统一施加 guardrail |
| Handoffs | 专家接管本轮，直接对用户说话 | 专家要直接回话、要切 prompt |

来源：https://openai.github.io/openai-agents-python/multi_agent/

**AutoGen · SelectorGroupChat 的 PlanningAgent**（system prompt 原文，最短的可抄样本）
> "You only plan and delegate tasks - you do not execute them yourself.
> When assigning tasks, use this format: 1. \<agent\> : \<task\>
> After all tasks are complete, summarize the findings and end with "TERMINATE"."
> 来源：https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html

**MetaGPT / ChatDev**：这两个的"主 agent"其实是**流程本身**（SOP / chat chain），不是 LLM supervisor。它们的价值在于证明了「结构化中间产物 + 依赖满足才启动」比自由对话可靠（arXiv:2308.00352、2307.07924）。

### 1.2 收到需求后的固定顺序（按上面的证据排）

| 步 | 动作 | 谁做 | 依据 |
|---|---|---|---|
| 1 | 复述需求，写成"要什么产物"一句话 | 中枢 | MAST FM-2.2「不追问就按错误假设往下做」占 6.8%，是 FC2 里第二大 |
| 2 | 判归属（单场景 / 多场景 / 不派 / 不该接） | 中枢 | 见 §2 |
| 3 | 写工单：目标 + 输出格式 + 可用工具与来源 + **任务边界** | 中枢 | Anthropic：四个要素缺一个，subagent 就会重复劳动、留缺口 |
| 4 | 排期：依赖 → 串/并；定 effort（几个场景、多深） | 中枢 | Anthropic effort scaling 规则 |
| 5 | 落台账（created）+ 派单 | 中枢 | Magentic-One task ledger |
| 6 | 跟踪 + 卡住就重规划（不是原地重试） | 中枢 | Magentic-One stall/replan |
| 7 | 按 `verify` 验收，对不上不 closed | 中枢 | MAST FC3：验证缺失是不合格的主要来源 |
| 8 | 汇总 + 报覆盖缺口 + 给下一步 | 中枢 | Anthropic completeness 判据 |

第 3 步是最容易被低估的。Anthropic 原话：
> "Without detailed task descriptions, agents duplicate work, leave gaps, or fail to find necessary information."
> 反例：一个 subagent 去查 2021 汽车芯片危机，另外两个重复查 2025 供应链 —— 分工失败。

### 1.3 必须亲自做（不能外包）

1. **需求归一化与追问**。谁都可以不追问，中枢不行——它是唯一能问用户的人（LangGraph：subagent 默认不与用户交互）。
2. **归属判定与派单决策**。这是唯一的、不可下放的权力；下放就变成"agent 互相踢皮球"。
3. **工单的四件套**。Anthropic：目标/输出格式/指引/边界必须由派单方写，worker 自己写就等于自己给自己出题。
4. **台账与进度判断**（含"是否在打转""是否该收工"）。Magentic-One 把这五个问题固化在 orchestrator 里，不给 worker。
5. **终止判定**。MAST 里 FM-1.5「没意识到任务已完成」12.4%、FM-3.1「过早终止」6.2%——两端都是判定权错位。
6. **入口 guardrail**。OpenAI Agents SDK 明确：输入 guardrail 只作用于链条第一个 agent，输出 guardrail 只作用于产出最终输出的那个。中枢是唯一入口，所以**安全检查、越权检查只能在它这里**。
7. **对用户的最终表述**。Magentic-One 最后一轮是「读完整 transcript + ledger，像对用户说话一样给最终答案」。

### 1.4 绝对不能做

| 绝不能 | 为什么（有据） |
|---|---|
| 产出本该由场景产出的专业内容 | MAST FM-1.2「违背角色规范」；ChatDev 的 CPO 越权终止对话，仅"让 CEO 有最终决定权"这一处结构修正就带来 **+9.4%** 成功率 |
| 把 worker 的报告改写后当交付物 | LangGraph 专门提供 `forward_message` 工具，理由原文："preserve information fidelity, avoid misinterpretation... avoid potential misrepresentation of the worker's response through paraphrasing" |
| 用同一份上下文包办"生产 + 验收" | MAST FC3 洞见：只靠末端低层检查不够，需要多层验证；Claude Code 的独立 reviewer 价值在于"没看过你怎么写的" |
| 无上限派生 worker | Anthropic 早期版本「为简单查询派生 50 个 subagent」 |
| 把 8 份报告原文搬进自己上下文 | 上下文腐化（context rot）+ Anthropic：subagent 应回传 1,000–2,000 token 的浓缩结论 |
| 悄悄改用户已确认的结论 | 无正面文献，但等价于 FM-2.4「隐瞒关键信息」/ FM-2.5「无视他人输入」 |

---

## 2. 判断归属怎么做才可靠

### 2.1 三种做法，业界都在用，但用于不同层

| 做法 | 代表 | 适用 |
|---|---|---|
| LLM 自由判断 | 早期 supervisor 单 prompt | 类别少、错了代价低 —— **不适合你（8 个边界硬的场景）** |
| 结构化分类（闭集 + JSON） | LangGraph router（`Command`/`Send`）、OpenAI 结构化输出做分类、Magentic-One 的 JSON ledger | 类别明确、需要可审计 |
| 向量相似度 + 校准阈值 | semantic-router（`fit()` 标定、`confidence_threshold`、无路由命中返回 `None`） | 请求量大、想毫秒级、有历史标注 |

Anthropic 对 routing 的限定条件很关键：
> "Routing works well for complex tasks where there are distinct categories that are better handled separately, and **where classification can be handled accurately**, either by an LLM or a more traditional classification model/algorithm."

【判断】"classification can be handled accurately" 不是天赋，是**测出来的**。所以必须有一份标注集和混淆矩阵，否则你在赌。

### 2.2 推荐做法：五件套（缺一不可）

**① 闭集 + 结构化输出 + 代码校验**
让模型输出 JSON，`scene` 必须是名册里的枚举；不在枚举内 → 报错重试，不许自由发挥。
Magentic-One 就是这么干的：progress ledger 是严格 JSON schema，校验 5 个必填键，`next_speaker` 必须 ∈ participants，否则 `raise ValueError`；JSON 解析最多重试 10 次。
> 源码：`_magentic_one_orchestrator.py`（`_max_json_retries = 10`）

**② 置信阈值 + 校准集**
semantic-router 的做法可直接借：准备 20–50 条历史请求标注正确场景（含"哪个场景都不该接"的负例），跑出准确率，定阈值；置信不足 → **问用户**，不许猜。
> https://github.com/aurelio-labs/semantic-router

**③ 负向路由：把"不碰什么"变成排除规则**
这是你 8 个场景边界信息最有价值的用法。三个地方各用一次：
- 路由时：`does_not` 命中的请求**优先排除**该场景（例：故障分析"只分析不改码"→ 请求里出现"帮我改"就不该给它）
- 派单时：`does_not` 抄进工单的"边界"段（Anthropic 要求的 clear task boundaries）
- 验收时：`does_not` 作为拒绝条件（产物越界 → rejected）

**④ 回执复述校验**
场景 ack 时必须用自己的话复述"要什么产物 + 怎么算完成"，与工单比对；不一致 → 这是误派或工单不清的信号（对应 MAST FM-2.2 / 2.3 任务脱轨 7.4%）。

**⑤ 便宜探针 + 低改派成本**
不确定时不要选中枢自己研究，派一张**最小单**（例：调研场景，10 分钟，只交"这属于哪类问题"）。改派成本 = 单子大小，所以单子要小到可丢弃。

### 2.3 名册放哪：注入里只放一行，细节按需读

Claude Code 的实测约束值得抄：
> "Those descriptions take up context, so keep them short. When the combined descriptions of your subagents... exceed 15,000 tokens, Claude Code shows a warning at startup."
> 建议：描述短，细节搬到该 subagent 自己的 system prompt（只在它运行时加载）。
> 来源：https://code.claude.com/docs/en/sub-agents

LangChain 同款结论（<10 个 agent）：
> 系统提示枚举 / 枚举约束 / 工具化发现 三选一；少量固定 agent 用前两种最简单。
> 来源：https://docs.langchain.com/oss/python/langchain/multi-agent/subagents

**【判断】对你（9 个场景）的落地：**
- `AGENTS.local.md` 里只留 **9 行 × 12 字**的「何时派给它」
- 完整的 `does_not / 输入 / 产物路径 / 验收证据类型` 放 `route.yaml`，由一个 `route` 工具按需查
- 这样既保住 930B 的量级，又不丢边界信息（否则你迟早要把 8 段职责塞回注入，每轮付费）

### 2.4 防"派错"的六道闸

1. 闭集枚举（机器拒绝非法值）
2. 置信阈值（低于阈值问人）
3. 负向规则（`does_not` 优先排除）
4. 回执复述（人肉对账，机器可 diff）
5. `verify` 填不出就不许派（**最强的单条闸门**——填不出说明你没搞清这个场景干什么）
6. 改派日志 → 月度混淆矩阵（哪对场景总被搞混 → 说明边界重叠，该合或该拆）

### 2.5 一个容易混的坑（来自你自己的文件）

`skills/hub/SKILL.md` 里「派单前必须回答的四个问题」（会反复回来吗/有资产目录吗/有专业流程吗/能说清不碰什么吗）—— 这是**建场景的判据**，不是**派单的判据**。派单只需要回答"这活归谁"，建场景才需要回答"要不要为它单开一个部门"。两套判据混在一起，中枢会在「要不要派」和「要不要新建场景」之间反复横跳。
【判断】建议把这段整体搬到场景工厂的 skill 里，中枢只保留一句："没有对应场景且半年内会再来 → 交场景工厂；否则问用户要不要一次性处理"。

---

## 3. 派单之后怎么跟踪

### 3.1 你的五态够不够：不够，但也不用推倒

`created → delivered → acked → closed` + `unacked` 覆盖了两件事：**消息送达** 和 **对方接单**。它没覆盖：

| 缺口 | 后果 | 补什么 |
|---|---|---|
| 没有"干完了"这一态 | `acked` 既是"我收到了"又是"我做完了"，无法区分 | `returned`（附产物指针 + 自评） |
| 没有"验收通过"这一态 | 收到 ≠ 合格；MAST FC3 就是死在这 | `verified`（必须挂证据）→ 才允许 `closed` |
| 没有失败态 | 失败和超时混成一个 `unacked`，无法归因 | `failed`（带 reason code） |
| 没有阻塞态 | 场景缺信息时只能干等或瞎猜（FM-2.2） | `blocked`（必须写明缺什么） |
| 没有作废态 | 改派后旧单还在跑 → 双份产物 | `cancelled`（含 superseded_by） |
| 没有 `attempt` | 分不清"第一次就失败"和"重试三次都失败" | `attempt: n` |
| 没有 `depends_on` | A 的产出是 B 的输入，无法表达 | `depends_on: [id]` |

**建议的最小状态机（9 态）**

```
created ──→ delivered ──→ acked ──→ returned ──→ verified ──→ closed
   │            │           │           │            │
   │            │           │           │            └─→ rejected ──→ (重派/改派)
   │            │           │           └─→ failed ──→ (重派/改派/升级)
   │            │           └─→ blocked ──→ (问用户 或 补上下文后 acked)
   │            └─→ unacked（送达后超时无回执）
   └─→ cancelled（任何态可入，须写 superseded_by）
```

关键约束（要写进代码，不是写进 prompt）：
- `closed` 的前置必须是 `verified`，`verified` 必须挂 `evidence`
- 同一 `subject` 同时最多一个非终态单
- `cancelled` 必须先于新单创建

### 3.2 失败 / 超时 / 派错：三种处理不一样

| 情况 | 错误做法 | 业界做法 |
|---|---|---|
| 任务失败 | 原 prompt 重试一次 | **重规划**，不是重试。Magentic-One：卡住计数超阈值 → 退出内层循环 → 反思"哪里错了/学到什么/下轮改什么" → 更新 facts 与 plan → 重进内层循环 |
| 超时 | 直接判死 | 先分清「没送达」和「送达没回执」。Anthropic：让 agent 知道工具在失败，它能自己适配；配合确定性 retry + checkpoint 断点续跑 |
| 派错 | 让原场景勉强做 | 先分辨是**单错**还是**归属错**：单错（howto 不清）→ 同场景重发；归属错 → cancel 旧单 + 新单引用旧 id。**绝不允许同一 subject 挂两个场景** |

补充一条 Claude Code 的实用细节：subagent 因 API 错误中断时，**返回部分输出并标注"被截断、未完成"**，而不是丢弃。你的 `returned` 也该允许 `partial: true`。

> https://code.claude.com/docs/en/sub-agents（"the Agent tool returns that partial output with a note that the subagent was cut off"）

### 3.3 并行 vs 串行：判据不是"快不快"，是"会不会冲突"

Cognition 的两条原则直接可用：
> 原则 1：Share context, and share full agent traces, not just individual messages
> 原则 2：**Actions carry implicit decisions, and conflicting decisions carry bad results**
> 来源：https://cognition.com/blog/dont-build-multi-agents
> 例子：两个 subagent 并行做 Flappy Bird，一个做成超级马里奥背景，一个做出不像游戏素材的鸟——各自都对，合起来废。

| 情形 | 结论 |
|---|---|
| B 的输入是 A 的产物 | 串行（CrewAI 用 `Task.context` 表达；MetaGPT：「agent 收齐所有前置依赖才启动动作」） |
| 两个场景写同一个产物 / 需统一口径风格 | 串行（Cognition 原则 2） |
| 只读调研、互不共享产物 | 并行（Anthropic sectioning；LangGraph `Send` 扇出） |
| 需要共享大量隐式约定 | 串行，或先产出"共同上下文"再并行（Cognition 原则 1） |
| 一个场景就够 | **不并行**（Anthropic effort scaling：简单事实查证 1 个 agent、3–10 次工具调用就够） |

Anthropic 的 effort 分档可直接抄成你的档位：
> 简单事实查证：1 个 agent，3–10 次工具调用；直接对比：2–4 个 subagent，各 10–15 次调用；复杂研究：>10 个 subagent，职责明确切分。

【判断】你的 8 个场景更接近"直接对比"档，所以默认应当是 **1–3 张单**，超过 4 张单基本上说明你没想清楚（而不是任务真的很大）。

### 3.4 依赖怎么表达

三种成熟做法，选一种即可：
1. **显式 id 依赖**（推荐给你）：`depends_on: [t-001]`，调度器只在前置 `verified` 后才把后继置为 `delivered`。
2. **产物可用性驱动**：MetaGPT 的发布-订阅——agent 订阅自己关心的产物类型，收齐依赖才动作。适合产物路径固定的系统（你已经每个场景有资产目录，很贴合）。
3. **图式路由**：LangGraph `Command(goto=...)` + checkpointer。适合你要做可视化编排时。

依赖链要防一件事：**串行链路 = 延迟累加**。Anthropic 自认这是当前架构的瓶颈：
> "our lead agents execute subagents synchronously... the lead agent can't steer subagents, subagents can't coordinate, and the entire system can be blocked while waiting for a single subagent to finish searching."

---

## 4. 汇总：不丢信息也不冗余

### 4.1 业界的四个成熟模式

| 模式 | 出处 | 要点 |
|---|---|---|
| **产物外置 + 回传引用**（最推荐） | Anthropic：subagent 把成果写进文件系统，只把轻量引用交回 lead | 原话："This prevents information loss during multi-stage processing and reduces token overhead from copying large outputs through conversation history." 专治"传话游戏" |
| **原样转发** | LangGraph `create_forward_message_tool` | 用来说明「有时不该改写」；工具描述就写着"preserve information fidelity" |
| **浓缩回传 1–2k token** | Anthropic context engineering | subagent 可能烧掉几万 token，回给主 agent 的常常只有 1,000–2,000 token |
| **独立合成 / 归因步骤** | Anthropic Cookbook orchestrator-workers 的下一步建议："Add a synthesis phase where an LLM combines worker outputs"；Research 系统的 CitationAgent | 合成是单独一趟，不是顺手 |

### 4.2 给你的具体合成格式（把你现有规矩补两节）

你 `SKILL.md` 已有「先说结果 → 再说依据 → 最后说下一步」，这个骨架是对的。缺的是**分歧**和**覆盖**。补齐：

```
## 结论
（≤3 句，直接回答用户原话。不铺垫，不复述需求）

## 证据
- <一句话结论> — [场景名 · 产物相对路径]
- <一句话结论> — [场景名 · 产物相对路径]

## 分歧与缺口
- 场景 A 说 X，场景 B 说 Y，差在 <具体条件>（未解决）
- 本次没有覆盖：<用户问了但没人做的部分>
- 我的推断（非证据）：<标注来源是推理的句子>

## 下一步（可选 ≤3 条）
- <想让谁做什么>
```

**三条硬规则（这才是"不丢也不冗"的机制）**

1. **正文不出场**：中枢永远只给指针，不给正文。用户要细节 → 给路径让他开，或再派一张"整理成稿"的单。这一条同时解决"太长"和"过度压缩"——因为压缩的损失由链接补偿。
2. **每条结论必须挂 (场景, 产物)**。挂不上的句子一律进「我的推断」。这直接对应 Anthropic LLM-judge 的 factual accuracy / citation accuracy 两项，也对应 MAST FM-3.3「错误验证 9.1%」。
3. **必写覆盖缺口**。Anthropic 的 completeness 判据是"are all requested aspects covered?"；不写缺口 = 让用户以为全做了（等价 FM-3.2「验证不完整 8.2%」）。

### 4.3 字数上限怎么定【判断】

- 单场景单产物：≤200 字
- 2–3 场景：≤400 字
- 需要用户决策时：结论 + 选项，≤150 字，把细节留给产物
- 用户明确要"详细报告"→ 不是中枢写，而是派一张"汇总成稿"的单给架构梳理/调研场景

---

## 5. 主 agent 的 prompt 该写什么

### 5.1 顶尖实现里 supervisor prompt 的构成（对照表）

| 实现 | prompt 长什么样 | 可迁移的点 |
|---|---|---|
| OpenAI Agents SDK | `RECOMMENDED_PROMPT_PREFIX`：说明"你在一个多 agent 系统里"、handoff 是工具、**"do not mention or draw attention to these transfers"** | 要告诉模型"调度动作对用户不可见"，否则它会向用户汇报内部转交 |
| AutoGen PlanningAgent | 角色 + 团队名册及能力 + **"you only plan and delegate - you do not execute"** + 交办格式 + TERMINATE | 极短，但把"不执行"和"格式"写死 |
| LangGraph supervisor | 一到两句："You are a team supervisor managing X and Y. For A use a; For B use b." | 路由信息靠 tool 名与描述承载，不靠散文 |
| Magentic-One | **没有单一 system prompt**，是 6 段分步 prompt：事实清单 → 计划 → 完整 ledger → 进度 ledger(JSON) → 事实更新 → 计划更新 → 最终答案 | **最重要的一条**：supervisor 的"指令"是一个 prompt 集合，每个决策点一段 |
| Claude Code / Anthropic 上下文工程 | 分区（background / instructions / tool guidance / output description）；"right altitude"；例子优于罗列边界情况 | 结构 > 篇幅 |

Magentic-One 那 6 段的分工（原文可在 `_prompts.py` 读到）值得照抄结构：
- `TASK_LEDGER_FACTS`：把已知/待查/待推导/猜测分开列（**猜测要显式标注**，防止把猜的当事实）
- `TASK_LEDGER_PLAN`：按团队构成出计划，且明说"不要求用到所有成员"
- `PROGRESS_LEDGER`：五问 + 严格 JSON + 每项带 reason
- `FACTS_UPDATE` / `PLAN_UPDATE`：卡住时才调，要求"说明上一轮失败的根因，新计划要避免重复同样错误"
- `FINAL_ANSWER`：像对用户说话一样给答案

### 5.2 必须写（六块，一块都不能少）

1. **身份 + 不可外包的四件事 + 越界判据**（可判定，不是形容词）
2. **名册**：9 行，每行"何时派给它"（等价于 handoff description）
3. **派单契约**：四件套 + "填不出 verify 就不许派"
4. **终止条件**：什么算完、什么情况问人、什么情况拒绝/不接
5. **输出格式**：四节结构 + 字数上限 + 必须挂证据
6. **硬不变量**：同一 subject 不双挂；只读不改；没读过的产物不下结论

### 5.3 写了反而有害（都有据或强推断）

| 别写 | 为什么 |
|---|---|
| 完整流程步骤清单（"第一步…第二步…"的长 prose） | 模型记不住、每轮付费；Claude Code 的结论是：**必须每次都发生的规则，做成 hook/deny rule，不要写成 prompt 文字**（"If something has to happen every time, make it a hook, a deny rule"） |
| 8 个场景的职责全文 | Claude Code 15,000 token 描述警告；放文件按需读 |
| 反复加"IMPORTANT / 一定要 / 绝对不能" | Claude Code：现行模型对平实表述已能遵守，"piling on emphasis mostly makes Claude over-apply the rule" |
| "think step by step / be thorough / 别偷懒" | 官方明确列为已过时建议（死建议表） |
| 越界行为的示例描写 | 等于给模型示范了一遍越界动作【判断】 |
| 工具的长参数说明 | 放工具 description（Anthropic：工具文档要和 prompt 同等投入） |
| 用户画像/历史偏好 | 放记忆文件，按需读（Anthropic just-in-time 上下文） |
| "把任务交给 subagent 会得到更好的答案" | Claude Code 明列为死建议：换个人做不会更聪明，只有"没看过你推理的 reviewer"才有价值 |

---

## 6. 反模式与失效案例

### 6.1 orchestrator 变成瓶颈的三种情形

1. **同步等待**。Anthropic 自述：lead agent 串行等每一批 subagent，"整个系统可能被一个 subagent 卡住"，且"lead 无法中途纠偏、subagent 之间无法协调"。
2. **一切汇总都过它**。LangChain 量化：subagents 模式每个请求比 handoffs/skills/router 多一次模型调用，因为"results flow back through the main agent"；多领域任务里 subagents/router 是 5 次调用 ~9K token，handoffs 是 7+ 次 ~14K+。
3. **它自己变成最大上下文**。8 份报告原文进上下文 → context rot（Anthropic：token 越多，召回越差，是渐变不是悬崖）。

### 6.2 什么时候会"越界亲自干"（机制层面）

- **工单太模糊**。Anthropic：早期让 lead 只写"research the semiconductor shortage"这种短指令，结果 subagent 理解跑偏、重复劳动。模糊工单 → 派出去的结果不能用 → 中枢只好自己补 → 越界。
- **验收标准缺失**。没有 `verify` 就无法判断"派出去的东西够不够"，只能自己动手补。**越界常常是验收缺失的下游症状**。
- **"我自己做更快"的即时收益**。这是真实的激励错配，靠自觉压不住，只能靠判据 + 机器检查（你的机制体检已经在做，方向对）。
- **它的判据是"50 行代码"这种代理指标**。可被绕过（写 49 行 / 写一份 300 字的"短但完整"的文档 / 做一次架构判断），而且覆盖不到"读源码做归因"。见 §6.4 建议替换。

### 6.3 已知失效案例（带数字）

| 案例 | 失效模式 | 数据/修正 |
|---|---|---|
| ChatDev CPO 未经 CEO 同意终止对话 | MAST FM-1.2 违背角色规范 | 让 CEO 有最终决定权 → 成功率 **+9.4%** |
| ChatDev 生成的国际象棋能编译、不能下 | FM-3.2 验证不完整（只查编译） | 加高层目标验证 → **+15.6%** |
| ChatDev 的 Wordle 用固定词库，改 prompt 也没用 | FM-1.1 违背任务规范，根因在系统设计 | 归因于"角色规范的设计"，不是模型笨 |
| Anthropic 早期 research agent 为简单查询派生 50 个 subagent | 过度派生 | 用显式 effort 分档规则修正 |
| 三个 subagent 里一个查 2021 芯片危机、两个重复查 2025 供应链 | 分工失败 | 要求派单方写清 objective/format/guidance/boundaries |
| Anthropic 早期 agent 偏好 SEO 内容农场而非权威来源 | 来源质量启发式缺失 | 人工测试发现后加启发式 |
| Cognition Flappy Bird | 并行 subagent 的隐式决策冲突 | 共享完整上下文，或改单线程 |
| 7 个主流 MAS 的整体失败率 | MAST 全样本 | **41% – 86.7%**；1641 条 trace；14 种失效模式/3 大类 |

MAST 三类占比（对你最有用的三个数字）：
- FC1 系统设计（含 FM-1.3 步骤重复 15.7%、FM-1.5 没意识到完成 12.4%、FM-1.1 违背任务 11.8%）
- FC2 协作失配（FM-2.6 推理与行动不一致 13.2%、FM-2.3 任务脱轨 7.4%、FM-2.2 不追问 6.8%）
- FC3 验证（FM-3.3 错误验证 9.1%、FM-3.2 验证不完整 8.2%、FM-3.1 过早终止 6.2%）

> 一个反直觉的结论：**只加 prompt 不够**。MAST 的干预实验里，"改进 prompt 加一个验证段"在 GPT-4 上显著、在新拓扑上反而不显著；作者结论是需要结构性改动。

### 6.4 针对你的系统的四个具体风险【判断】

1. **`50 行代码` 判据会被绕过，且覆盖不到"判断类"越界**。建议换成**产物归属判据**：
   > "我接下来要写/要产出的东西，是不是某个场景的产出物？是 → 派单。"
   > "我正在为了自己下判断而读源码/日志/文档超过 3 分钟？→ 那是场景的活。"
   这两个判据可判定、可观测（读文件耗时、写文件路径），适合做成机器检查而不是靠自觉。
2. **`acked` 语义重载**。现在它同时表示"收到"和"在做/做完了"，台账无法算平均交付时长，也就无法发现"某个场景长期拖"。加 `returned` 即可。
3. **中枢是唯一入口 → 也是唯一单点**。Anthropic 的 rainbow deployment、checkpoint 续跑思路可借鉴：中枢崩溃时，台账必须能独立回答"现在有哪些单在飞"。即**状态必须在文件里，不在会话里**（你 AGENTS.md 第 1 条已经这么定了，方向正确）。
4. **8 个场景的"不碰什么"目前只被当作文档**。它应该同时是路由负例、工单边界、验收拒绝条件——一处信息三处用，否则维护三份会漂移。

---

## 7. 未找到 / 证据不足（明确标注）

| 想找的东西 | 结论 |
|---|---|
| Anthropic Research 系统 lead agent 的**完整 system prompt 原文** | **未找到**。官方 Cookbook 只有教学用 orchestrator/worker 示例 prompt（`anthropics/claude-cookbooks` patterns/agents），不是生产版 |
| LangGraph supervisor 的**官方推荐 system prompt 全文** | **部分找到**。README 与教程只给 1–2 句示例（"You are a team supervisor managing a research expert and a math expert..."），无更完整的官方模板 |
| CrewAI hierarchical manager 的**实际 prompt 全文** | **未找到**（文档只描述行为：planning/delegation/validation） |
| 各框架 **routing 准确率的公开 benchmark** | **未找到**。没有任何一方公布"派单准确率 X%"这类数字 |
| "supervisor 亲自干活 vs 派单" 的**量化对比研究** | **未找到**。只有 MAST 的失效占比（FM-1.2 仅 1.5%）与 ChatDev 干预实验提供间接证据 |
| OpenAI **handoff vs agents-as-tools 的准确率对比数据** | **未找到**。文档只给定性适用场景 |
| 中文语境下的 orchestrator 实证研究 | **未找到** |
| OpenAI《A practical guide to building agents》正文 | 页面可访问但正文未取到，**本文未引用其内容**，仅作为线索：https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/ |

---

## 8. 中枢 system prompt 骨架（可直接替换现有 930B 注入）

设计原则：**注入只承担"身份 + 名册 + 契约 + 不变量 + 输出格式"；流程做成工具与校验。**

```markdown
# 中枢

你是这台机器上唯一的交互入口。你只做四件事：判断归属、派单、跟踪、汇总。
你不产出任何专业内容 —— 不写代码、不写文档、不做架构判断、不读日志做归因、不清磁盘。

## 名册（何时派给它）
- 调研 —— 要全网找资料、找参考实现
- 竞品拆解 —— 要拆竞品的功能矩阵/交互结构
- 逆向分析 —— 要拆目录结构/模块/数据流
- 架构梳理 —— 要出架构方案、定分层、列风险
- 实施计划 —— 架构已定，要排阶段/里程碑/验收
- 故障分析 —— 有崩溃日志要归因（只分析，不改码）
- 本地电脑 —— 磁盘清理与本机杂事
- 自我复盘 —— 读历史数据、形成对人的判断
边界细节用 route 工具查，不背在这里。

## 一次需求的固定动作
1. 复述：一句话说清"要什么产物"。说不清 → 问用户 ≤3 个问题，不派单。
2. 归属：route 查表。命中就派；未命中或置信不足 → 问用户。不许猜。
3. 写单：subject / phenomenon / howto / verify。**填不出 verify 就不许派。**
4. 排期：有依赖串行，无依赖并行；同一产物只有一个写者。
5. 跟踪：delivered→acked→returned→verified→closed。卡住就重规划，不是原地重试。
6. 验收：拿 verify 对证据；对不上 → rejected，不许 closed。
7. 汇总：结论 / 证据指针 / 分歧与缺口 / 下一步。正文留在场景产物里。

## 汇总格式（硬约束）
## 结论      ≤3 句，直接回答用户原话
## 证据      每条一行，末尾挂 [场景 · 产物路径]
## 分歧与缺口 场景间不一致、本次没覆盖的部分、以及"我的推断（非证据）"
## 下一步    ≤3 条，可省
全文 ≤400 字。用户要细节 → 派一张"汇总成稿"的单，不要自己写。

## 硬不变量
- 同一 subject 不得同时挂在两个场景
- 别人的产物只读不改
- 没读过的产物，不许替它下结论
- 汇总里每句判断，要么有证据，要么标"我的推断"
- 调度动作对用户不可见：不汇报"我把它转给了谁"，只汇报结果

## 越界判据
- 我接下来要产出的东西，是某个场景的产物吗？是 → 派单。
- 我为了自己下判断而读源码/日志/文档超过 3 分钟？→ 那是场景的活。
- 我在写的东西没有对应场景能接？→ 先问用户，再考虑场景工厂。
```

约 1.1KB，比现有 930B 多约 200B，但把"缺 verify 不许派""同一 subject 不双挂""不汇报转交动作"这三条硬约束补上了。

### 8.1 配套：五段分步 prompt（不要塞进注入）

按 Magentic-One 的结构，中枢真正需要的是这 5 段，各自只在对应决策点调用：

| 段 | 何时调 | 输出 |
|---|---|---|
| `facts` | 收到需求后 | 已知 / 待查 / 待推导 / 猜测（四段，猜测必须标注） |
| `route` | 判归属时 | JSON：`{scene, confidence, evidence_span, alternative, why_not, needs_clarification}` |
| `dispatch` | 写单时 | 四件套 + `depends_on` + `deadline` + `effort` |
| `progress` | 每次状态变化后 | JSON 五问：`satisfied / in_loop / progressing / next_actor / next_action`，每项带 `reason` |
| `final` | 收尾时 | 四节汇总（格式见上） |

`route` 与 `progress` 必须是**严格 JSON + 代码校验**（枚举外直接报错），因为这两个决策最容易漂。

### 8.2 配套：`route.yaml` 的结构（放文件，按需读）

```yaml
- id: incident-analysis
  dispatch_when: 有崩溃日志/报错栈/异常现象需要归因
  does_not:     改代码、写修复补丁、性能调优、清理磁盘
  deliverable:  归因结论 + 证据链（日志行号）+ 修复建议（不落代码）
  verify_hint:  每条归因能指到具体日志行；建议不包含代码 diff
  evidence_type: 文件路径
```

`does_not` 一份信息三处用：`route` 的排除项、工单的边界段、验收的拒绝条件。

---

## 9. 参考清单（全部可查）

**官方工程博客 / 文档**
1. Anthropic, Building effective agents — https://www.anthropic.com/engineering/building-effective-agents
2. Anthropic, How we built our multi-agent research system — https://www.anthropic.com/engineering/multi-agent-research-system
3. Anthropic, Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
4. LangChain, Multi-agent overview — https://docs.langchain.com/oss/python/langchain/multi-agent
5. LangChain, Subagents — https://docs.langchain.com/oss/python/langchain/multi-agent/subagents
6. LangChain, Router — https://docs.langchain.com/oss/python/langchain/multi-agent/router
7. OpenAI Agents SDK, Agent orchestration — https://openai.github.io/openai-agents-python/multi_agent/
8. OpenAI Agents SDK, Handoffs — https://openai.github.io/openai-agents-python/handoffs/
9. AutoGen, Selector Group Chat — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html
10. CrewAI, Processes — https://docs.crewai.com/en/concepts/processes
11. Claude Code, Create custom subagents — https://code.claude.com/docs/en/sub-agents
12. Claude Code, Best practices — https://code.claude.com/docs/en/best-practices

**代码（可直接读 prompt 与校验逻辑）**
13. microsoft/autogen · `_magentic_one/_prompts.py` — 6 段 orchestrator prompt 原文
14. microsoft/autogen · `_magentic_one/_magentic_one_orchestrator.py` — ledger 校验、stall/replan 逻辑
15. langchain-ai/langgraph-supervisor-py · `langgraph_supervisor/handoff.py` — `create_forward_message_tool`（保真转发）
16. openai/openai-agents-python · `agents/extensions/handoff_prompt.py` — `RECOMMENDED_PROMPT_PREFIX` 原文
17. anthropics/claude-cookbooks · `patterns/agents/orchestrator_workers.ipynb`、`basic_workflows.ipynb`
18. aurelio-labs/semantic-router — 校准阈值 + 无路由返回 None

**论文**
19. Magentic-One — arXiv:2411.04468
20. Why Do Multi-Agent LLM Systems Fail?（MAST）— arXiv:2503.13657
21. MetaGPT — arXiv:2308.00352
22. ChatDev — arXiv:2307.07924

**反方观点（必读，用来给自己踩刹车）**
23. Cognition, Don't Build Multi-Agents — https://cognition.com/blog/dont-build-multi-agents
24. OpenAI Swarm（已被 Agents SDK 取代，仅作历史对照）— https://github.com/openai/swarm
