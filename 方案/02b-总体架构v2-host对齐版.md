# 02 · 总体架构方案（v2 · 基于官方宿主）

> **版本说明**：这是 v2。v1 把 `dsh-superagent-prototype` 当地基、把本机 asar 当运行时事实，**定位错误**。
> v2 的第一手依据是 **`deepseek-ai/deepseek-harness`**（274,034 stars，MIT，master @ 2026-11-04）：
> `docs/architecture.zh.md`、`docs/capability-seams.zh.md`、`packages/README.md`（39 个包组）、
> `.agents/notes/`（4037 份 ADR）、`docs/testing.md`、`SAFETY.md`、`benchmarks/`、`snapshots/`。
> 差异清单见 `05-方法论与专家基线.md` §5。
> 所有"官方已有"的判断都带仓库路径；`[官方]` = 官方仓库文档/源码；`[实测]` = 运行时 Inspect；`[推断]` = 我的判断。

---

## 0. 核心命题（v2 修正版）

### 0.1 先承认：地基不是原型，是宿主

> **v3 追加（实测）**：`08b-二次开发可行性实测.md` 证明 superagent **可以编译（只改 1 行）**、**可以链接进 profile**、**能进配置树（3 插件 + 2 preset 全部识别）**，
> 但**在 Windows 上运行时崩溃**：`mkdir 'D:\D:\file\...'` —— POSIX 路径假设与盘符拼接。
> 结论：**不要"二开它"，要"移植它的源码骨架"**（改 6-10 处可跑，或直接抄 `src/core/*.ts` 的设计）。

| 层 | 是什么 | 数量级 | 我们的角色 |
|---|---|---|---|
| **宿主（L0）** | `deepseek-harness`：全插件 Cordis、事件三域、能力 seam、会话日志、39 包组 | 20,665 blobs / 11,073 包文件 / 1053 文档 | **只用，不改**（不 fork） |
| **应用-可移植参考（L0.5）** | `dsh-superagent-prototype`：Ticket/Mandate/Eval/Assignment 的**真实 JS 实现** | 216 文件，1 行可编译 | **抄设计，不二开**（平台不兼容） |
| **方法论参考（L0.6）** | `luanyujia-workbench`：场景六件套、派单/回执、把规矩变成机制 | 93 篇 md + 43 个定制外壳代码 | **抄规则表，不抄代码**（是成品外壳，非框架） |
| **应用（L1）** | 我们这一层：DoneSpec + 约 40 行 select 胶水 | 目标 3–5 个包 | **这就是本项目** |
| **插件生态（L2）** | 第三方 bundle | 数千 | 可选集成 |

官方 `docs/architecture.zh.md` 原话：

> **产品的每一部分都是插件**，包括模型适配器、工具注册表、会话日志，以及 agent loop（智能体循环）本身，因此每个都可以从配置替换。**不存在需要打补丁的特权内核**：扩展 dsh 的方式是把插件挂载到其他插件旁边，而各项注册都是副作用，会在其插件卸载时撤销。

**这意味着：我们不需要"设计一套架构"，我们需要"正确地挂载进已有架构"。**

### 0.2 修正后的双命题

| | v1（错） | v2（对） |
|---|---|---|
| **通用** | "设计一个能长出所有场景的机制" | **"在宿主已有的 preset/bundle/profile 三件套之上，只补一层场景契约"**——并先用"纯 preset 能否实现第一个场景"来证伪这层是否必要 |
| **自进化** | "设计七步闭环 + 封存集" | **"用宿主已有的 `extensions` 自修改 seam + `feedback` 人类信号 + `snapshots` 回放 + `benchmarks` 预算，组装出一条可被门禁证伪的进化链"** |

### 0.3 三条第一不变量（v2 修正）

| # | v1 表述 | v2 修正 | 依据 |
|---|---|---|---|
| **I1** | 权限在数据里，不在提示词里 | **保留**，并补充：**权限的实现点是 `tools/pre-execute` 的 monotonic guards + `ctx.approval`**，不是自造 Policy 引擎 | `docs/tool-execution-pipeline.md`：`pre-execute` waterfall → **monotonic guards（deny 或弃权，identity 受保护）** → `ctx.approval` |
| **I2** | 能自长的只有 D 档 | **保留**，但落点改为官方 `extensions` seam：`cordis-host-runner` 的**沙箱化 host-half 生命周期** | `packages/extensions/README.md` |
| **I3** | 注意力是一等成本 | **保留**，但承认它是**产品指标而非可证明性质**（见 §10.3 与 `05` §6 U3） | — |
| **I4（新增）** | —— | **模型可见 ⟺ 已记录**：任何进入模型请求的东西必须能从会话日志重建；新增模型可见输入**必须是会话事件** | `docs/architecture.zh.md` 原话；`AGENTS.md` 同名规则 |
| **I5（新增）** | —— | **不 fork、不打补丁、不做第二套实现**：新行为挂文档化扩展点；能复用官方包就不自造（否则 `duplication` 门禁会红） | `AGENTS.md`「Plugins, not loop changes」 |

---

## 1. 七层架构（v2：L0 是真实宿主）

```
╔═══════════════════════════════════════════════════════════════════════════╗
║ L6 运维   Watchdog 三层 · 审计 · 预算闸 · 版本回滚 · SAFETY 声明          ║
║           [官方可复用] guard/ · telemetry/ · session-query/              ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L5 信道   IM · 代码平台 · 邮件 · Web · CLI · HTTP · 定时 · 文件 · 告警    ║
║           [官方可复用] webhookRuntime · schedule/ · jobs/ · webServer    ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L4 人机   approval · ask-user · actionCards · **feedback/** · liveshare   ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L3 编排   ┌─────────────────────────────────────────────────────────┐    ║
║           │ ★ 本项目新增：Scene 契约层 + 三层编排（Router/Scene/Worker）│    ║
║           └─────────────────────────────────────────────────────────┘    ║
║           [官方可复用] preset/ · subagent/ · team/ · goal/ · workflow/   ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L2 领域   ┌─────────────────────────────────────────────────────────┐    ║
║           │ ★ 本项目新增：Ticket / Mandate / DoneSpec（**全部为会话事件**）│  ║
║           └─────────────────────────────────────────────────────────┘    ║
║           [官方] core/session（事件溯源日志）· session/projection       ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L1 能力   tools/ · skill/ · spill/ · compaction/ · context/ · fs/ ·     ║
║           shell/ · sandbox/ · credentials/ · deliverables/               ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ L0 宿主   deepseek-harness（Cordis 全插件，不 fork）                     ║
║           core/{session,agent,agent-loop,system-prompt,tools,scope}      ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

**图里最重要的一处**：**本项目的新增内容只有 L2 的 Ticket/Mandate/DoneSpec 与 L3 的场景契约层。** 其余全部是官方已有能力。

### 1.1 与 v1 的对比：自研清单从 6 项降到 2 项

| v1 声称要自研 | v2 结论 | 官方替代 |
|---|---|---|
| ① 运行时自修改（进化落点） | **删，复用** | `packages/extensions/`（`tool-cordis`、`cordis-host-runner`、`cordis-client-runner`） |
| ② 循环卫生护栏 | **删，复用** | `packages/guard/`（`repeat-tool-reminder` 阈值 3/5/8、`timeout-policy`） |
| ③ 证据自动采集 | **删，复用** | `packages/deliverables/`（`tool-present`、`workspace-changes`：turn 首尾 git 快照 + 首次编辑前整文件捕获） |
| ④ 人类纠正信号 | **删，复用** | `packages/feedback/`（会话备注 + 逐消息评分，**明确永不进入模型**） |
| ⑤ 任务板 / DAG | **删，复用** | `packages/team/agent-team`（`blockedBy` DAG、`writeScopes` 咨询式、`revision` CAS） |
| ⑥ 长目标自动续跑 | **删，复用** | `packages/goal/` + `goal-round-driver` |
| ⑦ **场景契约层** | **保留（核心）** | 官方只有 `preset/bundle/profile`，无"场景"概念 |
| ⑧ **完成契约 DoneSpec** | **保留（核心）** | 官方有 `deliverables`（声明交付物）与 `plan`（计划退出），无"完成判据" |
| ⑨ **三层编排** | **降级为可选** | 官方 `subagent` 已支持 continuable child + `agent.inject()`；先用两层 |
| ⑩ **证据/注意力账本** | **改造** | 若模型可见 → **必须是会话事件**；若仅运维 → 可独立存储 |

---

## 2. 通用性从哪来（v2：先证伪，再设计）

### 2.1 学术诚实：先证明"我可能不需要造这层"

官方已有三件套，**它们可能已经足够**：

| 机制 | 官方文档 | 能做什么 |
|---|---|---|
| **agent preset** | `preset/`："Per-session agent composition from preset `cordis.yml` files" | 一个会话一套能力集合（工具、提示词分节、监听器） |
| **bundle** | `bundle/`："Installable `dsh --profile` patch layers" | 可安装的一层 patch |
| **profile** | `docs/architecture.zh.md` | 具名组装：列出 bundle、存树外插件、存 `cordis.patch.yml` |

以及 **isolate realm**：
> "让某个会话拥有不同的能力集合 → 组装一个 agent preset；其中的服务行需要 `isolate` realm"

**所以第一件该做的事不是设计 `scene.yaml`，而是：用一个纯 preset 实现第一个场景，看够不够。**
- 若够 → **本方案的"通用性"退化为"preset 库 + 组织约定"**，不再新增概念（这是好消息，成本降一个量级）
- 若不够 → 再引入场景契约，且必须说明**它比 preset 多解决了什么**

这是 `05` §6 U1 的落地。

### 2.2 场景契约（SceneContract）—— **已被实测否决，删除**

> **v3 修正（2026-11-06 实测）**：`09-实机验证记录.md` 结论 0 证明：
> **场景可以用"一个 preset 定义 + 一次显式 `agentPresets.select()`"完整实现，约 40 行胶水代码，不需要契约文件。**
>
> 四重证据：① 正向 select 成功（`selected 'sea-data-reconcile'`）；② 反向探针（不存在的 preset 被拒）；
> ③ 会话日志出现 `agent-preset/selected`；④ **system prompt 真的变成** `你是"数据核对"场景的专员…`。
>
> 因此本节原设计（`scene.yaml`）**整段作废**。保留的只有"场景"这个**组织概念**。

#### 2.2.1 场景的真实最小实现（实测版）

```yaml
# 1) 一个 preset 定义（官方机制，零新概念）
- id: preset-sea-data-reconcile
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: sea-data-reconcile
    name: 数据核对
    description: 只读核对两类数据源的一致性，产出差异集合。
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: |
            你是"数据核对"场景的专员。只产出差异集合，不改任何数据。
            完成判据：必须给出差异集合，不允许只说"看起来没问题"。
      - id: tool-fs
        name: '@deepseek-ai/dsh-tool-fs'
        config: { write: false, edit: false }   # 能力边界用配置表达，不用提示词
```

```js
// 2) 一次显式 select（约 40 行插件，这是"场景激活"的全部）
export const name = 'sea-scene-selector'
export const inject = ['agentPresets']

export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    const scene = resolveSceneForSession(agent)   // 从配置/映射表取
    if (scene) await ctx.agentPresets.select(agent, scene)
  })
}
```

#### 2.2.2 为什么"定义 ≠ 生效"（这是最关键的一条实测教训）

| 检查 | 结果 |
|---|---|
preset 写进 `--dump-config` | ✅ 在（能证明"定义合法"） |
不 select 直接跑 headless | ❌ **会话完全忽略它**：无 `agent-preset/selected`；system prompt 是官方默认 |
`default: sea-data-reconcile` 设为默认 | ❌ **依然无效**（`default` 只是"没有请求时用哪个"，而 headless 路径不请求） |
官方选择入口 | 只有 `ui-agent-preset`（Web UI）+ 程序化 `agentPresets.select()`；**SDK 无 `/preset` 命令**；headless 无 flag |

**所以"场景"这个能力的真实成本 = 1 个 preset 定义 + 1 个 select 插件（约 40 行）。**

#### 2.2.3 由此得到的"场景六件套"官方映射

| 要素 | v1 说法 | 官方落点（实测） |
|---|---|---|
① 身份 | 定位卡 md 文件 | `dsh-persona` 的 `prefix` |
② 能力边界 | 契约 forbidden 路径 | `tool-fs` 的 `write:false` / `tools.restrict` |
③ 记忆 | 场景记忆 md | `skill-filesystem` + `context/` + `spill` |
④ 流程 | 专属技能 SKILL.md | `skill` provider（官方三级加载） |
⑤ 完成判据 | DoneSpec 字段 | **仍需自造**：一个 check 工具 + 约定（见 §2.3） |
⑥ 常驻身份 | 身份索引表 | **`agentPresets.select()`** ← 关键是这一条 |

**其中 ①–④⑥ 官方全有，只有 ⑤ 需要新造。**

---

### 2.3 完成契约（DoneSpec）—— 现在它是**唯一**的新增

**为什么它是唯一站得住的新概念**：官方有 `deliverables`（`present` 工具声明交付文件）与 `plan`（计划退出审批），但**没有"这件事算不算做完"的机器判据**。而"通用"的成败就在这里（`01` §5.4 的因果分析）。

三形态（不变）：

| 形态 | 判定 | 示例 |
|---|---|---|
| `check` | 跑命令，**输出差异集合**，exit 非 0 即失败 | `node tools/verify.mjs --ticket T-42` |
| `evidence` | 可复核物证（哈希/URL/前后对比） | `workspace-changes` 自动产出的 diff + 截图 |
| `review` | 具名人类签字 | `approval` 流 |
