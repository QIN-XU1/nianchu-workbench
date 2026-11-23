# 深读 1 · superagent 授权与执行模型

> 本文件是**我本人逐段读过的内容**，不是二手转述。每节标了出处。
> 目的：为「赛博工作台」的 L1 纪律层提供可直接采用的设计依据。

---

## 0. 元信息

| 项 | 值 |
|---|---|
仓库 | `dsh-superagent-prototype`（MIT，TypeScript，216 文件） |
本地 | `research/repos/superagent/` |
已读 | `docs/000-philosophy.md` 全文 · `001-domain.md` 全文 · `002-authorization.md` 全文 · `003-execution.md` 部分 |
未读 | `004-prompts.md` · `005-panel.md` · `006-deployment.md` · `007-architecture.md`(69KB) · `008-cookbook.md` · `src/` 全部 |

**诚实说明**：我没能读完全部 216 个文件。下面只写我真正读到的。

---

## 1. 哲学：一切按"注意力成本"审判

出处：`docs/000-philosophy.md`

> **核心原则：Take as little human attention as possible, and give as much value as possible.**
> "A message, a notification, a question, a setting, a panel element and a paragraph of documentation each cost someone's attention, and each has to give more value than that, or it is removed."

**五条行为准则**（原文）：
1. **只在被要求时行动**，或写在规则允许时。没人要求的工作需要一条团队写的规则，且**从"只记录"模式开始**。
2. **只在有人必须行动或能用上结果时才说话**。确认一次请求并说清要做什么；干活时保持安静；有结果/需要决策/做不完时才再说。
3. **一次只问一个具体问题**，用结构化形式。
4. **按影响停，不按努力停**。局部改到可评审为止；需要设计决策就停下问。
5. **诚实汇报**。草稿标未完成，失败就说失败，**绝不为了不问人而绕过限制**。

**四条设计准则**：
- **概念少**：只有领域概念 + 具体实现；业务需求变成某个概念的属性，不新增概念
- **设置少**：默认值取代设置；团队用话描述的行为 → 写进提示词，不做设置
- **面板只显示需要人的**：健康状态不占空间
- **文档按序读**：每篇只建立在前面的之上

**这四条的工程价值**：
> 我们内部做过很多"功能面板"，90% 后来没人点。这条"健康状态不占空间"直接对应我们首屏的"2 行"目标——已经验证有效。

---

## 2. 授权模型：权限由 host 强制，消息不能改权限

出处：`docs/002-authorization.md` 开头

> **"The host enforces allowed lists, rules and Mandates. Messages, comments and quoted documents are inputs to a decision; they cannot change those permissions."**

这一句是**防 prompt injection 的架构级答案**：
- 权限不是一个"判断"，而是 **host 侧的强制检查**
- 消息只能**触发**判断，不能**改变**权限

> **对我们直接有用**：桥（外包给免费网页 AI）拿回来的文本是**外部不可信数据**，
> 必须走这条原则——**外部文本永远不能提升授权**。

### 2.1 两条路径

| 路径 | 作用 | 关键 |
|---|---|---|
**Eval** | 决定"要不要开新活" | gate 检查发送者 + Policy |
**Subscription** | 继续已有工作 | **绕过 gate，但不授予新权限** |

> 注意第 20 行原文：`This delivery bypasses the gate and grants no new authority.`
> **"绕过 gate 但不授予权限"** —— 这是个精妙设计：让后续消息能进上下文，但不能扩大权。

### 2.2 强度三档

出处：`002` 第 46-54 行

| 强度 | 情形 |
|---|---|
`explicit` | 名单内的人直接找 agent，或在已有 Ticket 的 Thread 上跟进；admission 表设为 explicit 的格 |
`inferred` | 名单外的人在已有 Ticket 的 Thread 上跟进；admission 表设为 inferred 的格；名单内 bot 的消息 |
`not admitted` | 其他 bot；admission 表 ignore 的；**且 accept mode 为 off 时所有 inferred** |

> **`inferred` + `off` = 不接纳**。这就是"先观察"的基础。

### 2.3 Admission 表：行/列/三选（默认保守）

出处：`002` 第 56-76 行

**行 = 接收范围**；**每行最多三格**：

| 格 | 可选 | **默认** |
|---|---|---|
名单内但没点名 agent | inferred / ignore | **inferred** |
名单外但点名 agent | explicit / inferred / ignore | **ignore** |
名单外且没点名 | inferred / ignore | **ignore** |

> **默认值全部保守**（两格 default=ignore）。
> 想让"任何人 @ 就能开活"，需要显式把第二格改成 explicit。

**我们能直接抄的**：这就是"哪些来源可以开活"的可配置判据，而且**默认拒绝**。

### 2.4 Accept mode 三档

出处：`002` 第 91-99 行

| 模式 | 效果 |
|---|---|
`off` | 任何 inferred 都不成为候选 |
`observe`（**默认**）| inferred 会被评估；**正面评估记为 ignore 并标 "would accept"，但什么也不接受** |
`auto` | 正面评估就接受 |

> **`observe` 的设计极妙**：AI 会"想干"并记录下来，但**不真干**。
> 这解决了"AI 乱来"和"AI 太保守"的两难——先看它想干什么，再放权。

**这是我们最该抄的一条。**

---

## 3. 领域模型：概念极少，且明确拒绝多余概念

出处：`docs/001-domain.md`

**流程**（原文 mermaid）：
```
Source --Trigger--> Thread --batch--> Eval --accept with Mandate--> Ticket
                     Thread --Subscription fan-out--> Ticket
                     Ticket --Assignment--> Executor
                     Ticket --Channel--> Source
```

**核心五概念**：Source / Thread / Eval / Mandate / Subscription

| 概念 | 一句话规则 | 为什么存在 |
|---|---|---|
`Source` | 持读位置与自己的 bot 身份；**重启不重放事件** | 审计与幂等的基础 |
`Trigger` | 一条不可变事件；**同一 Trigger 接受两次只产生一个 Ticket** | 幂等单元 |
`Thread` | 按时间排的 Trigger；**同一时刻最多一个 Eval** | 给 Eval 一致视图 |
`Eval` | 判断，两层（gate + assessment）；**不持状态** | 决定开/续/停 |
`Mandate` | accept 授予什么；**不可变**；范围变宽 = 新 Ticket | 授权不能事后扩大 |
`Ticket` | 授权范围内的一个执行单元 | 工作单元 |
`Executor` | 一个 DSH Session + 每 Ticket 一个目录 | 执行者 |

**明确拒绝的概念**（原文 "Rejected concepts"）：原文列了它拒绝加的抽象。
> 这条设计原则对我很有启发：**"业务需求变成已有概念的属性，而不是新增概念"**。

**这个思路直接可用于我们**：不做"场景类型/场景模板/场景实例"三层，只做**场景**一个概念 + 属性。

---

## 4. 执行模型（我读到的部分）

出处：`docs/003-execution.md`（我只读了部分）

- Worker Session 与目录：每 Ticket 一个目录，目录里是它的全部资产
- 后台工作有时间上限（原文提到 30 分钟级）
- 重启恢复：靠 **recovery note**（把恢复所需信息写进文件，而不是靠内存）
- 同 Ticket 同会话的消息顺序有保证

> **对我们的直接启示**：每场景一个目录 + 一份记忆 = 同一个思路的更大尺度版本。

---

## 5. 直接可采用的 5 条

| # | 机制 | 怎么用到我们这里 | 成本 |
|---|---|---|---|
**S1** | **host 强制权限，消息不能改** | 桥拿回的外部文本一律标"数据"，永不变更权限 | 低（写进宪法 + 检查器） |
**S2** | **observe 模式（默认只记录）** | 新场景/新技能上线时先 observe，看它想干什么再放 auto | 中（需记录"would accept"） |
**S3** | **admission 表默认保守** | 哪些来源可以开活，默认全 ignore，显式开 | 低 |
**S4** | **Mandate 不可变，范围变宽=新单** | 场景的"授权范围"改大必须新建一张卡，不许原地扩大 | 低 |
**S5** | **概念少：业务需求变属性** | 不做"场景类型/模板/实例"三层，只做场景 + 属性 | 低（设计约束） |

---

## 6. 不该抄的

| 项 | 为什么不 |
|---|---|
Source/Thread/Channel 的 Git/飞书专有语义 | 我们多场景、异构来源，直接搬会扭曲 |
9 个概念全套 | 我们只需要 S1-S5 的思想，不需要那套领域 |
69KB 的 `007-architecture.md` 里的实现细节 | 那是单业务域的实现，我们没有对应物 |

---

## 7. 证据索引

| 结论 | 出处 |
|---|---|
注意力成本原则 | `docs/000-philosophy.md:5-7` |
五条行为准则 | `docs/000-philosophy.md:9-16` |
host 强制权限 | `docs/002-authorization.md:5` |
订阅绕过 gate 但不授权 | `docs/002-authorization.md:20` |
强度三档 | `docs/002-authorization.md:46-54` |
Admission 默认值 | `docs/002-authorization.md:63-71` |
Accept mode 三档 | `docs/002-authorization.md:95-99` |
核心五概念 | `docs/001-domain.md:23-40` |
Ticket/Mandate 规则 | `docs/001-domain.md:27-40`（表格） |
