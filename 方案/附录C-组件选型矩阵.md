# 附录 C · 组件选型矩阵（含"为什么选它 / 什么情况下会改主意"）

> 这是所有关键决策的对照表。每条都写清：**选了什么 / 备选 / 理由 / 推翻条件**。
> 依据见 `01`（源材料）与 `附录A`（运行时事实）。

---

## 1. 总原则

三条选型准则（按优先级）：

1. **优先用 DSH 已有原语**，其次自建插件，再次外部进程，**最后才考虑 fork 运行时**。
2. **优先选"能被确定性检查"的方案**，其次选"能被模型判断"的方案。
3. **优先选"可回滚/可替换"的方案**，即使它性能差一点。

> 准则 3 的理由：这套系统要长期运行、要自进化，**可替换性比性能重要**。一个 3 倍快但改不动的组件是负债。

---

## 2. Agent 运行时底座

| | 方案 A（推荐） | 方案 B | 方案 C |
|---|---|---|---|
| **是什么** | **DeepSeek Harness 作为宿主，写 bundle 插件** | 自建独立 Agent 运行时（Node/Python） | 用 LangGraph/CrewAI 等现成框架 |
| **为什么选/不选** | ✅ 已有一套完整原语：Session/Event/Tools/Storage/Approval/Credentials/Sandbox/Presets/Web | ❌ 从零做 Session/事件/工具/审批/沙箱，≥6 个月 | ❌ 它们的抽象是"图/团队"，缺"持久会话 + 事件总线 + 审批/凭据原语" |
| **成本** | 低（写插件） | 极高 | 中，但会绑死别人的抽象 |
| **推翻条件** | R-1/R-1b **两条都不可行**，且备选 A/B 也不成立 | — | — |
| **证据** | `附录A` §1/§2：150+ Service、80+ Event、三套预设机制 | — | `附录B` §4.3 |

**结论：选 A。** 并且**明确不 fork**（`附录A` §5.2 结论）。

---

## 3. 编排层数

| | 2 层（Super-agent 式） | **3 层（推荐）** | 1 层（每场景直连人） |
|---|---|---|---|
| **结构** | Router → Worker | Router → Scene → Worker | 人 ⇄ Scene（无 Router） |
| **优点** | 上下文最连续、成本最低 | 多场景不污染 Router；场景记忆有归属 | 最少一跳、最快 |
| **缺点** | N 个场景全塞 Router → Router 变重，批处理优势消失；场景记忆无处放 | 多一层会话 = 多一层 token | 跨场景协调要靠人；对外多出口易混乱 |
| **适用** | **场景数 = 1** | **场景数 ≥ 3** | 场景数 = 1 且无跨场景协作 |
| **推翻条件** | — | P2 实验证明 token 超 1.5× 且收益不显著（`04` §4.3） | — |

**结论：默认 3 层，但架构必须支持降级到 2 层**（`02` §5.3）。

---

## 4. Session 唤醒与投递

| | 方案 A | 方案 B | 方案 C（推荐先试） | 方案 D |
|---|---|---|---|---|
| **做法** | 平级 Session 直投 | Router 作为 Scene 的 parent，用父子 `sendMessage` | **`agentLoop.resume` + inbox 注入** | 每次新建 Session + 从内核重建上下文（seed） |
| **依据** | `subagents.sendMessage` 要求父子邻接 **[实测]** | 满足邻接约束 | 最自由，但需验证"能否驱动一轮" | 已验证可行（`webhookRuntime` 内置动作） |
| **风险** | 大概率被邻接拒绝 | 树形结构，Scene 间不能直连 | **R-1 未验证** | token +40%，冷启动 +2s |
| **选择** | — | 备选 | **首选（P0 spike 验证）** | 兜底 |

**结论：P0 第 1 周 spike。** 决策写进 ADR-001。

---

## 5. 事件源接入

| 事件源 | 方案 | 依据 |
|---|---|---|
| **通用 webhook（GitHub/Stripe/自建）** | `webhookRuntime.register` + 自定义 `run()` | **[实测]**：`WebhookRule.run()` 可返回 `null`（不建 Session），在回调里自己处理 |
| **HTTP 回调** | `webServer.register(route)` + `connection.admit` | **[实测]** |
| **定时** | `timer.interval` + 自建 routine 表 | **[实测]** |
| **文件变化** | `workspaceFiles.changes`（stream） | **[实测]** |
| **IM（飞书/企微/Slack）** | 自建插件（webhook + CLI） | Super-agent 的飞书实现可作蓝本（`src/sources/feishu*.ts`） |
| **邮件** | 自建插件（IMAP IDLE 或轮询） | 无现成原语 |
| **代码平台（GitHub）** | 自建插件 + `gh` CLI | Super-agent 的 `src/sources/github*.ts`（34KB）可作蓝本 |
| **其他 Agent（A2A）** | ❌ v1 不做 | Super-agent 8.3 承认未解 |

**结论：先做 1-2 个事件源（推荐：定时 + 文件变化，因为它们零外部依赖）。** 每个 Source kind 都必须声明 `done_capability`（能否提供 check/evidence）。

---

## 6. 工具协议

| | **DSH 原生 tools + MCP（推荐）** | VCP 纯文本协议 | 自造 JSON-RPC |
|---|---|---|---|
| **类型校验** | ✅ Zod/JSON Schema + `tools/pre-execute` 拦截 | ❌ 弱（模糊匹配） | ✅ |
| **流式增量** | ✅ `tool-call-delta` | ❌ | ⚠️ 要自己做 |
| **UI 卡片** | ✅ 原生 | ❌ | ⚠️ |
| **模型兼容** | 需 tool calling（主流模型都支持） | ✅ 任何模型 | ✅ |
| **生态** | ✅ MCP 快速扩张 | ❌ 自有市场 | ❌ |
| **权限拦截** | ✅ `tools/pre-execute` waterfall + `ToolGuard` | ❌ 无标准 | ⚠️ 自己加 |
| **嵌套调用** | ⚠️ 需多轮 | ✅ 天然支持 | ⚠️ |

**结论：选 DSH 原生 + MCP。** 从 VCP 只拿两条体验优化：**工具族（同族参数同构）+ 参数模糊容错归一化**（在 `tools/pre-execute` 里做）。

---

## 7. 记忆

### 7.1 v1（文件优先）

| | **文件 + SQLite 索引（推荐）** | 纯 SQLite | 纯向量库 |
|---|---|---|---|
| **可读性** | ✅ 人可直接读改 | ⚠️ 需工具 | ❌ |
| **可审计** | ✅ git diff | ⚠️ | ❌ |
| **成本** | ✅ 低（每轮固定注入很小） | ✅ | ❌ 每次检索要 embedding |
| **语义检索** | ⚠️ 无（v2 补） | ⚠️ | ✅ |
| **依据** | 乱雨家"记忆在文件里"（`总纲.md:13`）+ GEM 论文的四个算子 | — | — |

**结论：v1 用文件 + SQLite 索引。** 三红线：单一真源 / 先快照再减肥 / 只记结论。

### 7.2 v2（语义层）

| 组件 | 方案 | 理由 | 推翻条件 |
|---|---|---|---|
| **写入抽取** | 借鉴 mem0：区分事实/偏好/事件/决策 | 有成熟工程 | 抽取准确率 < 70% |
| **时序修订** | 借鉴 Zep/Graphiti：事实带有效时间窗 | 解决"读到三年前的错误结论" | — |
| **召回** | 向量 + 关键词混合 + rerank | 成熟 | — |
| **多跳** | 借鉴 HippoRAG（KG + PPR） | 对应 Super-agent 链式召回 | 图维护成本 > 收益 |
| **禁用** | ❌ VCP 的 TagMemo/EPA/残差金字塔 | 无可复现评测，只有作者能解释 | — |

**结论：v2 只用有公开评测的标准方案。** 不可解释的向量变换一律不进主干（`01` §3.6 / `04` §11 X5）。

---

## 8. 上下文管理

| 需求 | 方案 | 依据 |
|---|---|---|
| **"放多少"** | Super-agent 的 **Inline & Spill** | 文章 3.3 |
| **"活多久"** | VCP 的**四类生命周期标签** → 翻译成 `tools/post-execute` 标签 | `VCP.md:93-102`（**抄思想不抄实现**） |
| **长内容外置** | `spill.saveText` **[实测]** | DSH 原生 |
| **历史压缩** | `compaction` + `toolResultPruner` **[实测]** | DSH 原生，但要**保护 DoneSpec/Evidence 引用** |
| **压力观测** | `tokenMeter.contextPressure` **[实测]** | DSH 原生 |
| **装配** | `systemPrompt.section/context` + `'system-prompt/assemble'` **[实测]** | DSH 原生 |

**结论：七通道 = 宪法/身份/契约/工作集/环境感/状态台账/通知栏 + 召回不进 prompt。** （`02` §6.2）

---

## 9. 异步与心跳

| | Super-agent 式（工具超时） | **合成（推荐）** | VCP 式（纯自报） |
|---|---|---|---|
| **机制** | shell 5s 转后台；job wait 5s；后台 30min 上限 | **两源叠加** | 模型输出 `[[NextHeartbeat::N]]` |
| **优点** | 对同步工具有效、可控 | 覆盖同步+长任务 | 任意长任务，省 token |
| **缺点** | 长任务（视频/深研）管不到 | 复杂度高 | 模型可滥用（报 10 小时） |
| **落地** | Worker preset 照抄两个数 | 三重上限：单次 ≤300s、累计 ≤40 次、总时长 ≤2h + Watchdog 覆盖 | 采纳为协议，映射到 Report |

**结论：合成方案。** 上限与 Watchdog 覆盖是我们加的两条护栏（`02` §6.4）。

---

## 10. 授权与自治

| 维度 | 方案 | 来源 |
|---|---|---|
| **强度** | `explicit` / `inferred` / `not admitted` | Super-agent `002` |
| **准入** | admission table（接收范围 × 人-消息组合 × 三选） | Super-agent `002` §Admission |
| **默认模式** | **`observe`**（记录"would accept"，不行动） | Super-agent `002` §Accept mode |
| **自治档位** | investigate / draft / autopilot / full | Grok Bot autopilot ladder |
| **二维矩阵** | autonomy.ceiling × 场景风险 → 实际权限 | **SEA 合成**（两个来源的交叉） |
| **强制 review** | prod/money/secret/migration/permission 五类 | Grok Bot #29 |
| **撤销** | 只有人 stop；Policy 失效则 revoke | Super-agent `002` §Resume and stop |

**结论：Super-agent 的三层授权 + Grok Bot 的档位，做成二维矩阵。**

---

## 11. 安全

| 威胁 | 方案 | 对比四源 |
|---|---|---|
| **提示词注入** | D1 数据/指令分离 + `tools/pre-execute` 兜底 | Super-agent 有优先级链但无隔离；我们加硬隔离 |
| **凭据泄露** | D2 **Broker**（凭据不进上下文） | Grok Bot 有（表单/1Password）；Super-agent 无；我们照 Grok Bot + 自建 Broker |
| **端侧被控** | D3 **`cmd_key` 白名单**（非裸命令） | Super-agent 明说"不是安全边界"；**我们补上** |
| **不可追责** | D4 出站审计（append-only） | 四源都弱 |
| **生产事故** | D5 五类强制 review | Grok Bot #29 血的教训 |
| **自我权限膨胀** | D6 进化只改 D 档 | 乱雨家五档 |

**结论：六道防线。** 这是 SEA 相对四个参考**唯一明确超越**的地方（`02` §9）。

---

## 12. 持久化与多机

| 需求 | 方案 | 依据 |
|---|---|---|
| **计算/状态分离** | 无状态 Host + 持久库（`storageDomain`） | Super-agent 5.1 |
| **计算/环境分离** | 端侧 daemon（`cmd_key` 白名单） | Super-agent 5.2 + **我们补安全** |
| **远程执行** | `ssh` / `connection.createPeer` **[实测]** | DSH 原生 |
| **多机代码** | `worktrees.create` / `forge` **[实测]** | DSH 原生 |
| **归档** | 对象存储 / 冷备，只进不改 | 乱雨家 L5 |

**结论：两层解耦（5.1 + 5.2），但 5.2 的白名单命令是我们对 Super-agent 的修正。**

---

## 13. 人机交互

| 需求 | 方案 | 依据 |
|---|---|---|
| **需要人的事** | `actionCards` **[实测]** + 面板第一屏 | Super-agent `005-panel.md`（健康态不占空间） |
| **结构化提问** | `userQuestions.askTimed` **[实测]** | Super-agent 拒绝"从自由文本推断在等人" |
| **信道适配** | 代码级长度检查（IM ≤100 词） | Super-agent `004-prompts.md:79` |
| **会话绑定（若做 Web 面板）** | `webserver/index-inject` + 写键直达 + 幂等脚本 + 带签名 | 乱雨家 `二-会话绑定三字段.md:73-124` |
| **三上限** | ≤3 条 / ≤200 字 / `【结束】` | 乱雨家 `一-协作机制.md:149-155` |

**结论：抄 Super-agent 的面板原则 + 乱雨家的通信宪法。**

---

## 14. 进化

| 决策 | 选择 | 依据 | 推翻条件 |
|---|---|---|---|
| **能改什么** | 只 D 档（技能/记忆/提示词/派单启发式） | 不变量 2 + 乱雨家五档 | — |
| **验证集分层** | S1 沙箱可见 / S2 回归可见 / **S3 封存不可见** | arXiv:2607.24300（verifier–deployment gap） | — |
| **裁判** | 确定性检查决定性；**LLM 只作排序顾问** | arXiv:2609.02246（11 种信号失效） | — |
| **提案必须带** | 真实事件 id + 反例 + 回归集 | arXiv:2607.13083（幻影失败）+ 乱雨家五步法 | — |
| **配额** | 每场景每周 ≤1 | Grok Bot #7 | — |
| **灰度** | canary 10% → half 50% → full | 通用工程实践 | — |
| **回滚** | 60 秒内，版本化 | 总律 2 | — |
| **不做** | 自改代码（DGM 式） | `03` §3.2 | 有了"可执行、可自动评分、零代价"的 benchmark 后可重新考虑 |

---

## 15. 协议

| | MCP | A2A | AGENTS.md | VCP 协议 |
|---|---|---|---|---|
| **用途** | 工具接入 | Agent 间通信 | 仓库级规则 | 工具调用 |
| **选择** | ✅ **选** | ❌ v1 预留 | ⚠️ 用，但升级为可校验 | ❌ 不选 |
| **理由** | DSH 原生 + 生态大 | Super-agent 8.3 承认未解 | Grok Bot 的 `AGENTS.md` 是范例 | 丢类型/UI/流式 |

---

## 16. 一句话总结

> **能用宿主原语的，不要自建；能写插件的，不要起外部进程；能确定性检查的，不要交给模型判；**
> **能回滚的，优先于更快的；能被证明变强的，才配留下。**
