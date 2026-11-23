# dsh-superagent-prototype 拆解（2026-11-17）

> 一句话：**它不是独立 agent，而是 DeepSeek Harness (dsh) 的一个 bundle 插件**——为「一个 GitHub 仓库」提供主动型编码 agent：监听 GitHub/飞书 → 授权判定 → 建工单 → 在独立 DSH Session 里执行 → 回原会话。
> 这决定了它对我们价值最高：我们产品就跑在 dsh 上，它的插件清单、Session 装配、工具/面板贡献点可以「按同门接口」直接对照。

---

## 1. 定位与规模

- **是什么**：DSH bundle（不是 standalone app）。包描述原文：`"A proactive agent for one GitHub repository, as a DSH (DeepSeek Harness) bundle..."`（`package.json:7`）。入口是 DSH 插件 `apply(ctx, config)`（`src/index.ts:8-25`），bundle 补丁插入 3 个插件（`cordis.patch.yml:4-12`）。
- **文件数 / 语言 / 时间 / star**：
  - 文件 216（排除 `node_modules`、`.git` 实测 216，与任务给的一致）。
  - 主语言 TypeScript（`src/**/*.ts` + `src/client/*.tsx`），构建 `tsdown`（`tsdown.config.ts`），测试 `vitest`（`package.json:47-52`）。
  - 最近提交 `8c32a9d`，`2026-10-31T20:06:31+08:00`，消息 "feat: add the dsh-superagent research prototype"（git log）。
  - star ≈ 23,577（据同目录 `_清单.md:44`；本仓库内无法验证）。
- **证据**：`package.json:30-46` 的 `dsh.bundle.patch` 与 `dsh.client.inject`；`src/index.ts:8` `inject = [...]`；`README.md:3-5` 自述为 research prototype（说明它是研究代码，不保证生产质量——不要按生产照搬）。

---

## 2. 架构骨架

顶层目录 → 职责（`docs/007-architecture.md:289-398` 有一张完整的模块表，是可复用点）：

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `src/core/` | 纯领域：Engine + Intake/Evals/Tickets/Assignments/Replies 五个部件；**不做 I/O** | `engine.ts`、`evals.ts`、`tickets.ts`、`stage.ts`、`model.ts`、`ports.ts` |
| `src/app/` | 应用层 / 组合根 / glue：Runtime、Store(SQLite)、Effects、Passes、Outbox、Sessions、Settings、Prompts、HTTP、views | `runtime.ts`、`store.ts`、`effects.ts`、`passes.ts`、`sessions.ts` |
| `src/sources/` | Source 插件（GitHub / 飞书）与注册表、契约 | `kind.ts`、`registry.ts`、`host.ts`、`github.ts`、`feishu.ts` |
| `src/executor/` | 把工单变成 DSH Session + 目录 | `dsh.ts`、`background.ts` |
| `src/infra/` | CLI 传输、进程环境、health、路径、文本 | `commands.ts`、`environment.ts`、`health.ts` |
| `src/client/` | React 管理面板（DSH slot 插件） | `index.tsx`、`app.tsx`、`provider.tsx` |
| `prompts/` `skills/` | 内建提示词与技能（运行时读文件） | `prompts/*.md`、`skills/*/SKILL.md` |
| `docs/` | 000–008 分序文档（philosophy→domain→authorization→execution→prompts→panel→deployment→architecture→cookbook） | |

- **依赖方向（有明确单向约束）**：`docs/007-architecture.md:255-274` 明文规定；`src/core` 除 Node 的 hashing 外不 import 自己之外的任何东西、不做 I/O（`docs/007:258`；代码验证 `src/core/engine.ts:2-11` 只 import core 内部）。`src/sources` 不 import `src/app`（`docs/007:258`）。面板只 import host 侧类型 + 少量纯值（`docs/007:258`；`src/app/api.ts:1-10` 全是 `import type`）。`Runtime` 是唯一组合根，向别人只暴露窄接口（`src/app/runtime.ts:87-172`）。
- **核心/插件边界，靠什么强制**：
  - 类型层：每个调用方只拿到 `Pick` 出来的角色接口 `EngineForSources / EngineForMainSession / EngineForPeople / EngineForSettings / EngineForExecutor`（`src/core/engine.ts:261-270`）；插件只拿 `SourceHost` / `SourceContext`（`src/sources/host.ts:23-67`、`src/app/source-context.ts:33-72`）。
  - 运行时层：`Runtime` 以 Cordis service `orchestrator` 暴露给插件（`src/app/runtime.ts:51`）；`SourceRegistry.register()` 用 health 唯一所有权 + 注销 disposer 强约束（`src/sources/registry.ts:20-35`）。
  - 测试层：`tests/bundle-patch.spec.ts:29-73` 把 bundle 补丁当真读一遍并断言插件行与工具白名单。
  - **没有 CI 边界脚本**：`package.json:47-52` 只有 `typecheck / test / build`，没有 import-boundary lint。边界主要靠类型 + 目录约定，不是硬 CI。

---

## 3. 【A12】插件 / 扩展机制（重中之重）

这个仓库本身就是「插件」，而且它同时演示了**三套清单**：

### 3.1 插件清单长什么样（真实片段）

1. **bundle 补丁**（`package.json:30-46`）声明这是一个 DSH bundle，补丁文件、client 平台与要注入的 client 插件：
```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale", "..."] },
  "manifestVersion": 1
}
```
`cordis.patch.yml` 用 entry-list 方言插入插件行（每行 `id / name / disabled / config`）：
```yaml
- insert:
    - id: dsh-superagent
      name: dsh-superagent
    - id: dsh-superagent-github
      name: dsh-superagent/github-watch
    - id: dsh-superagent-feishu
      name: dsh-superagent/feishu-watch
      disabled: true
```
（`cordis.patch.yml:4-12`）同一文件定义两个 agent preset：worker preset `20-120`、router preset `125-193`。

2. **SourceKind 对象**（一个 Source 插件的全部声明，`src/sources/kind.ts:85-113`）：`kind / title / description / facts? / schema(zod) / fields[] / health[] / scope? / channel? / threadContext? / find? / repliesTo? / policy? / refreshLabels? / environment?`。具体例子见 `src/sources/github.ts:38-109`（GitHub）与 `src/sources/feishu.ts:31-126`（飞书）。

3. **client 插件**声明在 `package.json:34-44` 的 `dsh.client.inject`，源码入口 `src/client/index.tsx:48-57` 注册三个 slot：主面板 `main`、侧栏图标 `sidebar.panellist`、Plugin Manager 配置行 `plugins.row.config`。

### 3.2 怎么被发现

- DSH 的 include 插件把 `cordis.patch.yml` 当 entry list 解析并 `applyEntryPatches` 到 profile 的插件表（`tests/bundle-patch.spec.ts:9-21` 用 `entryListSchema` + `applyEntryPatches` + `js-yaml` 完整复现，说明发现机制就是这个）。`!!js` 标量（如 `disabled: !!js process.platform === 'win32'`，`cordis.patch.yml:47`）由 Cordis 解析。
- 源码入口由 `package.json` 的 `main` 与 `exports` 暴露：`main: lib/index.js`、`./github-watch`、`./feishu-watch`（`package.json:9-18`），对应构建 entry（`tsdown.config.ts:10`）。
- Source 插件入口是 `export const name / inject = ['orchestrator'] / apply(ctx)`（`src/sources/github.ts:110-122`、`src/sources/feishu.ts:130-138`），`apply` 里 `ctx.effect(() => ctx.orchestrator.sources.register(kind))` 完成注册。

### 3.3 怎么校验

- 每个 kind 的配置由 zod `schema` 校验（`src/sources/kind.ts:92-93`；GitHub `GithubConfigSchema` `src/sources/github.ts:25-29`；飞书 `FeishuConfigSchema` `src/sources/feishu.ts:21-30`）。
- 注册表 `SourceRegistry.validate` 对提交的实例配置做 `kind.schema.parse`，对策略段调用 kind 的 `policy.schema` + 全局 `AdmissionTableSchema`（`src/sources/registry.ts:54-67`）。
- 失败策略：**存储里的配置解析失败 → 该 Source 实例被禁用**（`src/sources/registry.ts:133-137`；`docs/003-execution.md:201-203`）。健康探针 `health[]` 的重复声明会被拒（`registry.ts:21-35`），保留名 `sync:` 也被拒（`registry.ts:22-24`）。
- bundle patch 由测试校验：`tests/bundle-patch.spec.ts:29-73` 断言插入的行、worker/router preset 各自的工具白名单与 5 秒 shell 配置。

### 3.4 怎么装载

- 不是动态 import 用户代码，也不起子进程或沙箱：Source 插件与宿主**同进程**，靠 `ctx.effect` + Cordis 依赖注入装载（`github.ts:112-122`）。
- 一个 kind 注册后，宿主通过 `SourceRegistry` 统一驱动它的 channel / threadContext / environment / policy（`src/sources/registry.ts:95-132`）。
- 但 Source 的 `apply` 只拿得到 `orchestrator`（`SourceHost`），拿不到 Store/Engine；kind 自己的代码只拿 `SourceContext`（`source-context.ts:33-72`）。

### 3.5 贡献点：一个插件能往宿主里加什么

一个 `SourceKind` 一次能带来（`src/sources/kind.ts:85-113`）：

| 贡献点 | 字段 | 宿主如何用 |
|---|---|---|
| 配置表单 | `schema` + `fields[]`（`FieldSpec` `kind.ts:16-22`，支持 switch/select/number/text/fact/rows） | 面板自动渲染 Source 卡片（`views/settings.ts`、`client/source.tsx`） |
| 健康探针 | `health[]` | 注册时在 `HealthBoard` 上按名 claim，单写者（`registry.ts:26-31`；`infra/health.ts:15-35`） |
| 监听规则 | `scope(meta, config)` | Engine 的 `SourceScope.scope` → gate 判断是否 listened/observed（`registry.ts:124-132`；`policy.ts:175,193-211`） |
| 出站通道 | `channel.send/link/allowed` | Outbox 发送、面板链接（`registry.ts:95-103`） |
| 线程上下文读取 | `threadContext` | 评估时读有界窗口（`registry.ts:109-123`；`assessment.ts:123-174`） |
| 搜索 | `find` | `orchestrator_read`/面板搜索（`registry.ts:104-107`） |
| 回复定位 | `repliesTo` | 定位被回复的消息（`registry.ts:108`） |
| 策略段 + 准入表 | `policy: { schema, fields, explicit, rows?, sync? }` | 面板策略页 + 准入表（`kind.ts:28-41`；`feishu.ts:70-117` 有 sync 实例） |
| 环境变量 | `environment.variables/values` | 执行环境（`kind.ts:111-112`；`github.ts:92-105`） |
| 显示名刷新 | `refreshLabels` | 面板"刷新群列表"（`feishu.ts:33`） |

面板额外贡献点：主面板 / 侧栏 / Plugin Manager 配置（`client/index.tsx:53-57`）；Session 侧：工具注册（`sessions.ts:206-216`）、systemPrompt section（`sessions.ts:244-249`）、skill 注册（`sessions.ts:313-327`）。

### 3.6 隔离：插件拿得到宿主内部对象吗？

- 拿不到 Store / Engine：SourceContext 是**逐个 kind 构造的窄对象**（`src/app/source-context.ts:33-72`），只暴露 `deployment/commands/config/receive/atomic/state/threads/tickets/triggers/notify/report`。
- health 写入被限制在 kind 自己声明的条目，写了未声明的会抛错（`source-context.ts:67-70`）；且绑定到「当次注册」，注销后再写是 no-op（`registry.ts:36-42`）。
- 但**没有 OS 级隔离**：workers 以 `danger-full-access` 跑（`sessions.ts:152`；`docs/006-deployment.md:19`），`docs/003-execution.md:78-80` 明说「These wrappers and directories establish defaults, not a security boundary」。这是研究代码的定位，不要当成隔离实现来抄。

### 3.7 热插拔：能装/卸/启用/禁用吗？状态存哪

- **安装/卸载**：bundle 级用 DSH 的 `dsh plugin --profile add "link:$PWD"`（`docs/006-deployment.md:80-81`），不是本仓库代码。
- **运行时注册/注销**：`SourceRegistry.register()` 返回 disposer，注销时删 kind、release 所有 health 条目（`registry.ts:20-35`）。
- **启用/禁用**：Source 实例 `enabled` 存在 settings（`SourceInstanceSchema` `policy.ts:98`），`resolve()` 里 `parsed.success && (stored?.enabled ?? true)` 决定（`registry.ts:133-137`）；Feishu 插件默认 `disabled: true`（`cordis.patch.yml:10-12`）。
- **状态存哪**：所有 settings 在 SQLite（`store.ts:183-199`）；Source 自己的读游标等在 KV（`kv.ts:40-57`），通过 `SourceContext.state` 读写。
- **没有「运行时从 npm 装一个插件」的代码**——那是 DSH plugin manager 的能力，不在本仓库。

---

## 4. 【A13】MCP / 工具接入

- **MCP client：未找到。** 全仓 `grep -i mcp` 无命中；没有 `mcp` 协议、server 启动、工具列表协商的任何代码。
- **工具接入走 DSH 原生工具注册**，不走 MCP：`sessions.ts:206-216` 的 `registerTool` → `agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema), output: {...render...}, execute })`。工具定义在 `src/app/tools/main.ts`（主 Session）与 `src/app/tools/executor.ts`（worker）。
- **工具列表怎么暴露给模型**：初始工具由 agent preset 决定（`cordis.patch.yml:63-120` 给 worker、`163-176` 给 router）；本仓库再用 `agent.ctx.tools.restrict({allow})` 收窄（`sessions.ts:263`、`289-297`），worker 白名单常量 `WORK_TOOLS`（`sessions.ts:61-62`）。
- **有没有 UI 让用户管理 MCP server**：无。DSH Plugin Manager 管的是插件行（`client/index.tsx:56-57`），不是 MCP server。
- **工具调用结果怎么回填**：`render` 把返回值 JSON 化，若含 `image` 附成 attachment（`sessions.ts:209-213`）；结果进 DSH Session event，不落本库。
- **结论：A13 = 无。** 工具生态的借鉴点是「注册 + 白名单 + render」三层，不是 MCP；我们要 MCP 必须自己补。

---

## 5. 【A11】调度 / 后台任务

- **定时任务怎么定义/存/谁 tick**：**没有用户级 cron/定时任务**。只有内部编排节拍：
  - `Passes` 用 `setInterval(() => this.request(), 2000)`（`src/app/passes.ts:28`），`pump()` 合并并发调用、一次只跑一个 pass（`passes.ts:56-68`）；每个 pass 先 `effects.kick()` 再 `engine.evaluateDue()`（`passes.ts:63-68`）。
  - 持久工作不在内存，而在 SQLite 的 `effect` 表（建表 `store.ts:80-90`，索引 `86`）；命令在事务内 `enqueue`（`effects.ts:61-66`），**提交后**才执行。
- **常驻进程怎么起**：不是 systemd；是 DSH profile 由 tmux 起（`scripts/dsh-superagent:159-207`），进程内 loops 在 `Runtime.initialize()` 起（`runtime.ts:215-216` `this.passes.start(); this.effects.start()`）。库内没有独立 daemon 进程。
- **失败重试 / 超时 / 四态**：
  - 每个 effect kind 一个 handler，带 `limit()`（并发上限，暂停时 0）、`retry`、`ordered`（保序）、`quiet`（`effects.ts:26-36,67-74`）。
  - 失败指数退避：`delay = min(retry[1], retry[0] * 2^attempts)`（`effects.ts:140-146`）；抛 `Later` 只延后不算失败（`effects.ts:138-139`）；连续 3 次失败把该 kind 的 health 标 error（`FAILURES_BEFORE_ERROR=3`，`effects.ts:6-7,151-159`）。
  - 六种 kind：`assessment / launch / delivery / relay / notice / reply`（`effects.ts:11-24`；各自的并发/退避表见 `docs/007-architecture.md:172-180`）。
  - 「四态」体现在 health：`starting | ready | paused | error`（`src/sources/host.ts:19`）。
- **另有执行器后台任务**：worker 的 shell jobs / subagents 由 `DshExecutor` 跟踪，turn 结束后最多再跑 30 分钟（`dsh.ts:32`、`601-672`；`background.ts:96-104`）。
- **注意**：`docs/006-deployment.md:135-141` 的「每小时巡检」是**在另一个 profile 里用 DSH 自己的 schedule**，不在本仓库代码内——说明本仓库自己不做 cron。

---

## 6. 【C1/C2】agent 循环与停止条件

**没有单文件 `while True`。** 循环分两层：

### 6.1 主循环在哪（贴行号）

- **外层编排循环（决定性节拍）**：`Passes` 每 2s → `Engine.evaluateDue()`（`passes.ts:28,56-68` → `engine.ts:75-85`），加上 `Effects.dispatch()` 从 SQLite 取到期行执行（`effects.ts:103-122`）。这就是它「自主」的发动机：不靠人触发，每 2 秒推进一次。
- **内层 agent 循环（模型→工具→再模型）**：由 DSH 的 agent 负责，本仓库只挂钩事件：`DshExecutor.install()` 订阅 `agent/status / agent/inbox/claimed / session/event / agent/error`（`dsh.ts:477-512`），并用 `launch()`（`dsh.ts:424-470`）把 assignment 投进 Session。
- **一轮的定义（以工单为单位）**：Assignment `pending → running → ended`（`model.ts:211-233`）；Report `progress / waiting / ready / blocked / failed / dropped`（`model.ts:216`）；worker turn 结束统一走 `workerIdle()`（`dsh.ts:601-672`），没报告默认补 `waiting`（`dsh.ts:663-671`）。

### 6.2 停止条件有哪些（逐项 + 行号）

1. **工单阶段表**（第一匹配行胜）：`src/core/stage.ts:9-21` —— `person/delivery`、`person/answer`、`person/review`、`person/blocked|failed`、`working/queued`、`idle`、`working`。
2. **Report 驱动结束**：`tickets.end()`（`tickets.ts:345-363`），其中跟随的 PR 全部关闭才结束用 `followsDone()`（`tickets.ts:95-101`），未完成用 `unfinished()`（`tickets.ts:370-379`）。
3. **等人暂停**：`waitsForPerson()` = 最新 report 是 blocked/failed 且没有更新的人类消息（`model.ts:349-353`）；`addInput` 在此时扣住自动输入（`tickets.ts:238-239`）。
4. **Eval 超时**：`REQUEUES = 2`，连续两次超时重排，第三次记 `unavailable`（`evals.ts:18-19,60-69`）；`delivered` 后才开始计时（`evals.ts:47-54`）；处理暂停时 deadline 顺延（`evals.ts:35-46`）。
5. **并发上限**：`WorkerSlots` 预留槽位 + `maxWorkers`（`dsh.ts:171-199`；`policy.ts:92`），人类跟进额外 1 槽（`dsh.ts:186-196`）。
6. **后台工作上限**：turn 结束后后台最多 30 分钟（`dsh.ts:32`，`644-656`）。
7. **无 max-turns**：本仓库不设 turn 上限；由 DSH preset / 模型自己收敛（`cordis.patch.yml` 未出现 turn cap）。

### 6.3 循环状态怎么持久化（断了能续吗）

- 域状态全在 SQLite：Triggers/Threads/Tickets/Decisions/Assignments（`store.ts:201-247`，`atomic` 保存点事务 `140-153`；`afterCommit` 提交后回调 `159-162`）。Eval 的 `deadline / pausedAt / delivered` 存在 `Thread.evaluating`（`model.ts:136-154`）。
- 待办工作存在 `effect` 表（`effects.ts:61-66`）。
- Session 历史由 DSH `sessionPersistence` 持久化（`delivery.ts:40-60`；`runtime.ts:243` flush）。
- **续跑**：`Runtime.initialize()` 里 `executor.resume()`（`runtime.ts:214`）；`DshExecutor.resume()` 逐个把 interrupted assignment 报给 Engine、把 pending 的重新入队（`dsh.ts:524-537`）；`assignmentInterrupted`（`engine.ts:245-247`）带「恢复说明」重启（`tickets.ts:317-327`）。

---

## 7. 【A6/A7】记忆

- **存储形态**：单 SQLite 库（`node:sqlite`，`store.ts:51-101`），**不是向量库、不是文件记忆目录**。所谓「记忆」在这里是域记录：Trigger / Thread / Ticket / Decision（`store.ts:201-247`）；KV 按 family 收口（`kv.ts:21-57`）；Session 历史由 DSH 持久化（`delivery.ts:40-60`）。
- **溯源**：有，但属于**授权/审计**而非记忆条目溯源：`Decision.audit`（`model.ts:205`）、`TriggerDisposition`（`model.ts:42-61`）、`MandateBasis`（`model.ts:104-133`）。
- **冲突消解 / TTL / 老化**：**未找到**。无 TTL、无超期衰减、无 supersede 链。只有运行期时间窗（`poll.ts:6` 的 14 天轮询视界、`dsh.ts:32` 的 30 分钟后台）——这不是记忆老化。
- **跨会话召回**：靠**重读**而非语义检索——工单 resume 时重读 Thread/PR/worktree（`dsh.ts:132-135` 的 `RESUMED` 文本；`tickets.wake` `252-270`）；prompt 版本按 Session 绑定、可读自己跑过的旧版（`sessions.ts:328-339,202-204`）。
- **结论**：A6 = 部分（持久状态很强，但没有独立「记忆」抽象）；A7 = 无（没有带溯源/冲突/TTL 的记忆系统；现有 audit 是授权审计，不能算记忆）。

---

## 8. 【D1–D5】界面

- **技术栈**：React 18（`package.json` devDeps `react 18.3.1`）；client 以 CJS 打包注入 `window.__ModuleLoader__`（`tsdown.config.ts:11-13`）；以 DSH slot 注册（`src/client/index.tsx:48-57`）。
- **布局范式**：Header（标题 + 全局搜索 + 术语表 + 打开主 Session）+ 分段 tabs（Overview / Source / Trigger / Eval / Execution / Settings）（`src/client/route.ts:7`；`app.tsx:161-170`）；列表 → 详情两级；**无拖拽分栏 / 可停靠 / 多工作区**。
- **状态可见性（能看「在做什么/花了多少/还差什么」吗）**：
  - 强：Overview 汇总「需要人的工单 / 系统问题 / 24h 流量 / 执行器负载」（`views/overview.ts:67-78`）；Ticket 阶段明确「等谁、要什么」（`views/records.ts:109-131`、`views/tickets.ts:44-87`）；执行器 `running / queued / maxWorkers`（`tickets.ts:50-55`；`http.ts:107-109`）；前端 5s 轮询（`provider.tsx:74-89`）。
  - 缺：**没有 token / 花费账本**、没有百分比式的「还差什么」进度。
- **主题 / 密度 / 多工作区**：使用 DSH design tokens + 自带 `client.css`（`provider.tsx:6,104`；`docs/005-panel.md:57`）；i18n 中英（`locales.ts` 767 行；`client/index.tsx:51`）；单一 deployment / 单面板，无多工作区。

---

## 9. ⭐ 最值得抄的 3 条机制

> 三条正好对应我们的三个痛点：① 插件生态/贡献点死代码 → ② 调度 daemon 只在 dev server → ③ agent 停止条件弱。

### 机制 1：插件 = 声明式 bundle 补丁 + 自描述 kind 契约 + 单写者注册

```
机制：把「插件贡献点」从手写代码变成数据：一个 bundle 用 cordis.patch.yml 插入插件行与 agent preset；
      一个 Source 插件用 SourceKind 对象声明 schema/fields/health/scope/channel/policy/environment；
      SourceRegistry 按 kind 注册、按名唯一 claim health、返回 disposer。
位置：package.json:30-46（dsh.bundle.patch + client.inject）
      cordis.patch.yml:4-12（insert 三个插件）、20-120（worker preset）、125-193（router preset）
      src/sources/kind.ts:85-113（SourceKind 契约）、28-41（policy 段）、46-56（channel）、65-75（threadContext）
      src/sources/registry.ts:20-35（register/health claim/disposer）、124-132（scope）
      src/sources/host.ts:23-67（SourceHost/SourceContext）
      src/app/source-context.ts:33-72（逐 kind 窄上下文）
      src/sources/github.ts:38-109 / src/sources/feishu.ts:31-126（两个真实 kind）
      src/client/index.tsx:48-57（面板三个 slot）
      tests/bundle-patch.spec.ts:29-73（把补丁当真读一遍的验收）
为什么好：我们现在的插件生态只有 2 个探针、贡献点全是死代码——根因是「贡献点没有统一契约，只能硬编码」。
      这套做法把每个贡献点（配置表单/健康探针/策略/环境变量/通道）都变成 kind 的一个可选字段，
      由宿主 Registry 统一驱动；加一个 Source = 加一个对象，不用改宿主。bundle patch + preset 又让
      「工具集/提示词/skills/shell 超时」全部是声明数据，而不是散落代码。
我们抄到哪：Tools/plugin/kernel.mjs（改成读 yml 清单 + kind 契约驱动）、tools/plugin/run.mjs（注册/注销/health）、
      apps/vouch-web/src/web-ui/src/app/scenes/workbench/WorkbenchScene.tsx（把 fields[] 渲染成设置表单、health 渲染成探针）。
```

### 机制 2：SQLite 持久副作用队列 + 2s Passes 常驻循环（事务内入队、提交后执行）

```
机制：命令在同一个事务里只「入队」副作用（assessment/launch/delivery/relay/notice/reply），事务提交后才由队列执行；
      每个 kind 有并发上限、退避、保序、health；一个进程内 2 秒的 Pass 负责踢到期行 + 推进 Engine 评估。
位置：src/app/effects.ts:46-161（enqueue 61-66、handle 67-74、dispatch 103-122、attempt/退避 130-146、health 151-159）
      src/app/passes.ts:22-69（start=setInterval 2s 28、pump 合并 56-68）
      src/core/ports.ts:105-134（Repositories 同步接口，让 atomic 包住一个工作单元）
      src/app/store.ts:80-90（effect 表）、140-153（atomic 保存点）、159-162（afterCommit）
      src/app/runtime.ts:215-216（启动 passes/effects）
为什么好：我们的调度 daemon 只在 dev server 起——因为它是一个独立进程。这套做法把调度放进宿主进程：
      SQLite 落盘 → 重启不丢；事务内入队保证「不产生半个状态」；提交后执行保证「回滚不会真的发消息/起工单」；
      退避 + health 让失败可观测。不需要 systemd/独立 daemon。
我们抄到哪：tools/schedule/（把 daemon 的 tick 换成进程内 Pass + 用 SQLite effect 表替代内存队列）、
      tools/plugin/run.mjs（副作用入队/执行/退避）。
```

### 机制 3：工单阶段 + Report 状态机 + waitsForPerson + Eval 超时重排 的显式停止条件

```
机制：把「agent 何时停」写成可判定的状态机，而不是靠模型自觉：
      工单阶段表（person/delivery|answer|review|blocked|failed / working|queued / idle / ended）；
      Report 六态驱动结束与等待；blocked/failed 后没有新人类消息就 waitsForPerson 扣住自动输入；
      Eval 交付后才计时、连超 2 次重排、第 3 次判 unavailable。
位置：src/core/stage.ts:9-21（ticketStage 逐行判定，第一匹配胜）
      src/core/model.ts:211-233（Assignment）、216（ReportState 六态）、349-353（waitsForPerson）
      src/core/tickets.ts:345-363（end）、95-101（followsDone）、370-379（unfinished）、238-239（waitsForPerson 扣输入）
      src/core/evals.ts:18-19（REQUEUES=2）、35-46（暂停顺延）、47-54（delivered 才计时）、60-69（超时/不可用）
      src/executor/dsh.ts:601-672（workerIdle：turn 收口 + 默认补 waiting）、32（30min 后台上限）
为什么好：我们的 agent 停止条件弱，根因是「停止」只靠模型是否不再调用工具，缺少外部可判定的状态。
      这套把停止拆成三层：域层阶段（等谁）、Report 层（worker 自报）、时间层（Eval/后台超时），
      每一层都能被面板展示、被重试、被恢复；比 max-turns 更贴近真实工作。
我们抄到哪：我们的 agent 循环收口（停止判定模块，建议新建 tools/agent/stage）、
      WorkbenchScene.tsx 的工单状态展示（person/working/idle 的 label 与动作）。
```

> 附带（几乎并列第 4 条）：PR 绑定/关闭即结束工单的规则 `src/sources/github-pull.ts:35-105` + `tickets.followsDone:95-101`，很适合我们「外部对象生命周期驱动 agent 收口」。

---

## 10. 我们不该抄的

1. **飞书硬编码进通用模块**：`docs/007-architecture.md:275-286` 自己列了「Source-specific dependencies」——Outbox 里带飞书字数限制、links/resources/cards/Runtime 里直接认 feishu/github。这是在「通用架构」里漏了具体 Source，抄了会把耦合带进来。我们要么保持 kind 纯净，要么接受但别扩散。
2. **一次性大迁移 `migration.ts`（606 行）**：schema10→schema11 一大坨转换（`migration.ts:36-80+`）。这是它版本包袱，早期我们不该模仿「重 schema + 大迁移」；先用简单的 KV/JSON 落盘更轻。
3. **巨型提示词文本**：`prompts/dispatch.md` 59 行、`prompts/team/communication.md` 97 行、`prompts/work.md` 49 行这类极密规则文本，是它为了「少花人注意力」堆出来的；直接搬会变成提示词债。我们应只抄「结构（分段/占位/版本化）」（`prompts.ts:55-70,102-119`），不抄字数。
4. **danger-full-access + 无真隔离**：`sessions.ts:152`、`docs/006:19`、`docs/003:78-80`。研究原型可以，我们若要给多人用必须补沙箱；不要把它当安全实现。
5. **整个 Ticket/Mandate/Assignment/Subscription 领域模型全套**：概念很多（`model.ts:1-353`，`docs/001` 一整套）。只有当我们真的做「多源主动接单」时才值得；否则是过度设计，会把简单 agent 循环拖成工单系统。
6. **无 MCP / 无用户 cron 的缺口**：这两项它没有（A13=无、A11=部分），我们别把它当「已完成」的参照，该补就补。
7. **面板体量**：`locales.ts` 767 行、views 一整套，前端体量对我们是过剩；抄交互范式（tabs、stage label、5s 轮询、错误/健康块）不抄页面数量。

---

## 附录：本报告核对过的关键行号（逐条已 read）

- `package.json:7`（description）、`:30-46`（dsh.bundle/client）、`:47-52`（scripts）、`:53-56`（engines）、`:58-61`（deps）
- `cordis.patch.yml:4-12`（insert 插件）、`:20-120`（worker preset）、`:125-193`（router preset）、`:47-62`（win/posix 分支）
- `src/index.ts:8`（inject）、`:10-25`（apply + settings auto:false + restart）
- `src/app/runtime.ts:51`（orchestrator service）、`:87-172`（组合根）、`:201-218`（initialize/resume/passes/effects）、`:230-253`（shutdown）
- `src/core/engine.ts:24-38`、`:48`、`:75-85`、`:100`、`:109-121`、`:239`、`:255-257`、`:261-270`
- `src/core/evals.ts:18-19`、`:35-46`、`:47-54`、`:60-69`、`:71-119`、`:131-156`、`:183-188`、`:306-316`
- `src/core/tickets.ts:37-56`、`:95-101`、`:234-245`、`:252-270`、`:317-327`、`:345-363`、`:370-379`
- `src/core/stage.ts:9-21`、`:24-26`
- `src/core/model.ts:42-61`、`:104-133`、`:136-154`、`:211-233`、`:216`、`:271-315`、`:349-353`
- `src/core/ports.ts:17-27`、`:59-69`、`:76-83`、`:86-103`、`:105-134`
- `src/app/effects.ts:6-7`、`:11-24`、`:26-36`、`:61-66`、`:67-74`、`:103-122`、`:130-146`、`:151-159`
- `src/app/passes.ts:22-69`、`:28`、`:56-68`
- `src/app/store.ts:51-101`、`:80-90`、`:140-153`、`:159-162`、`:201-247`、`:251-288`
- `src/app/sessions.ts:47-48`、`:61-62`、`:152`、`:162-167`、`:206-216`、`:232-269`、`:263-268`、`:289-297`、`:313-327`、`:328-339`
- `src/app/assessment.ts:21-34`、`:89-104`、`:123-174`、`:183-220`、`:231-239`、`:272-279`
- `src/app/settings.ts:44-52`、`:148-196`、`:231-252`
- `src/app/delivery.ts:31-86`
- `src/app/resources.ts:24-57`、`:299-308`
- `src/app/source-context.ts:33-72`
- `src/app/http.ts:75-79`、`:230-246`
- `src/app/prompts.ts:55-70`、`:102-119`、`:135-247`
- `src/app/context.ts:7-24`
- `src/app/skill-files.ts:29-32`
- `src/app/api.ts:20-46`
- `src/policy.ts:70-71`、`:83-87`、`:92-97`、`:111-118`、`:167-242`、`:191-211`、`:213-240`
- `src/limits.ts:1-11`
- `src/kv.ts:21-57`
- `src/deployment.ts:15-43`
- `src/sources/kind.ts:12-22`、`:28-41`、`:46-56`、`:65-75`、`:85-113`
- `src/sources/registry.ts:20-35`、`:36-42`、`:54-67`、`:95-132`、`:124-132`、`:133-137`
- `src/sources/host.ts:11-22`、`:23-67`
- `src/sources/github.ts:25-29`、`:38-109`、`:110-122`
- `src/sources/feishu.ts:21-30`、`:31-126`、`:130-138`
- `src/sources/github-pull.ts:35-105`
- `src/sources/poll.ts:6`、`:18-31`
- `src/executor/dsh.ts:24`、`:32`、`:44-55`、`:171-199`、`:207-236`、`:247-262`、`:424-470`、`:477-512`、`:524-537`、`:601-672`
- `src/executor/background.ts:96-104`、`:141-165`
- `src/infra/health.ts:15-35`
- `src/client/index.tsx:48-57`
- `src/client/app.tsx:161-170`
- `src/client/provider.tsx:6`、`:74-107`
- `src/client/route.ts:7`
- `src/app/views/overview.ts:38-79`
- `src/app/views/tickets.ts:44-55`、`:56-87`
- `src/app/views/records.ts:109-131`、`:118-178`
- `src/app/cards.ts:9-15`、`:26-33`、`:36-69`
- `tests/bundle-patch.spec.ts:9-21`、`:29-73`
- `docs/000-philosophy.md:3-33`、`docs/001-domain.md:7-112`、`docs/002-authorization.md:107-155`、`docs/003-execution.md:7-203`、`docs/004-prompts.md:44-96`、`docs/005-panel.md:13-58`、`docs/006-deployment.md:15-141`、`docs/007-architecture.md:255-398`
