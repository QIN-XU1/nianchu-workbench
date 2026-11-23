# 记忆神经元：融入 hermes 的完整记录

> 2026-11-14。回答「我们最重要的记忆神经元是否融入」。
>
> **上一版答案是没有。这一版是融入了，而且过程中发现神经元本身是残缺的。**

## 一、神经元是什么（读 `外壳/ui/panels/neuron.js` 132KB 得出的定义）

```
节点  = 场景（只有场景；技能/记忆不做节点 —— 用户③明确要求）
边    = 场景↔场景的真实依赖，来自契约 sceneboard/scenes/<id>.json
附属  = { memory, identity, skills(=capabilities), mcp, panels }，点击节点才展开
形态  = 球面排布 + 拖拽 + 360° 旋转 + 「整理」复位 + 双层（领域层/场景层）
```

关键一句（neuron.js 补充 1）：
> 「用 `outputs.to` 建边，这是**真实的依赖关系**，不是我瞎连的。」

## 二、上一版为什么没融进去

| 项 | 上版 | 现在 |
|---|---|---|
| 节点 | ✓ 12/12 profile | ✓ |
| **边** | ✗ 用了 pipelines 的 9 条 | ✓ **契约真实 31 条** |
| 记忆/身份/技能 | ✓ 12/12 | ✓ |
| **共享底盘** | ✗ 0/9 文件 | ✓ **11/11** |
| **记忆地图** | ✗ 过期（9/12） | ✓ 12/12 |
| **智能体自觉** | ✗ 不知道自己在家谱哪 | ✓ 12/12 SOUL 有「我在神经元里的位置」 |
| MCP | 契约里全空 | 双方都空，无事可做 |
| 面板 | 工作台外壳概念 | hermes 无对应物，结构性没有（如实记） |

## 三、发现一：神经元自己也是残缺的

neuron.js 只读 `outputs[].to`。但实测契约有**三种写法混用**：

```
outputs: [{ id, to: ["build-plan"] }]      ← 出边，数组        15 次
inputs:  [{ id, from: ["arch-review"] }]   ← 入边，数组 id     18 次   ← 神经元没读
inputs:  [{ id, from: "架构梳理" }]         ← 入边，**中文名**   9 次   ← 神经元没读
```

只读第一种，会漏掉后两种声明的全部关系。把三种都展开、中文名归一化成 id、双向合并去重后：

```
真实边 31 条（去重后）
管线边  9 条 —— 全部被契约覆盖（管线 ⊂ 契约）
```

**所以工作台的场景关系球画出来的图，比真实依赖少得多。**

## 四、发现二：契约漏声明（已修）

`build-plan.json` 的三张任务单只写了 `files`，**没写 `to`**：

```json
{"id":"backend-tasks",  "name":"后端任务单",  "files":["后端任务单.md"]}   ← 交给谁？没说
{"id":"frontend-tasks", "name":"前端任务单",  "files":["前端任务单.md"]}
{"id":"tool-gaps",      "name":"工具缺口单",  "files":["工具缺口单.md"]}
```

管线里明明有 `build-plan → backend-craft / frontend-craft / tool-forge`，契约里却没有。
已补 `to` 字段并加 `note` 记录原因。

修后：管线 9 条**全部**被契约覆盖，管线不再有契约外的边。

## 五、发现三：真实工作流有环，任务图不能有环

契约里存在真实的反馈环：

```
hub → incident-analysis → hub     中枢派单下去、故障分析回报上来
hub → pc-cleanup → hub            中枢派清理、本地电脑回报台账
```

这两个环是**业务真实**（派单向下、回报向上），不是数据错误。

但 kanban 是任务依赖图，有环就死锁。所以采用**两套图**：

| | NEURON.json / NEURON.md | kanban task_links |
|---|---|---|
| 是什么 | **神经元本体** | 执行用的无环子图 |
| 边数 | **31**（含 2 处环） | **18**（无环） |
| 用途 | 关系真相、人/智能体阅读、图形视图 | 派单执行 |
| 关系 | 权威 | ⊆ 本体 |

kanban 少掉的 13 条边，每一条都能解释：

```
冗余（已被其他路径蕴含）10 条：
  arch-review>backend-craft        arch-review>frontend-craft
  reverse-eng>backend-craft        reverse-eng>build-plan
  reverse-eng>frontend-craft       reverse-eng>tool-forge      reverse-eng>hub
  research>frontend-craft          competitor-analyze>hub
  self-review>tool-forge

断环（保留派单方向、断开回报方向）3 条：
  incident-analysis>build-plan     incident-analysis>hub
  pc-cleanup>hub
```

「冗余」不丢语义（路径还在），「断环」在 NEURON.md 里明确写着。

## 六、落到了哪里

```
C:\Users\15282\AppData\Local\hermes\
├── dsh-shared\                        ← 共享记忆底盘（新建）
│   ├── NEURON.json      20 KB         12 节点 / 31 边 / 附属物（机器读）
│   ├── NEURON.md       5.9 KB         183 行，每个场景的上下游 + 环说明（人读）
│   ├── 记忆地图.json                  面板↔场景↔私有记忆
│   ├── 场地地图.json                  83 条「这东西归谁」规则
│   ├── 身份索引.json                  跨场景身份
│   ├── 关键资产.json      33 KB
│   ├── 进化台账.json / 派单台账.json 55 KB / 健康度.json
│   ├── 基线.json / 索引.json / 索引.md / 项目.json
│   └── 中枢\场景私有记忆.md
└── profiles\<id>\
    ├── SOUL.md         ← 追加了「## 我在神经元里的位置」（真实上下游 + 交接产物名）
    └── memories\ skills\ profile.yaml
```

每个智能体现在读自己的 SOUL.md 就知道：我等谁、我给谁、交的是什么产物。

例子（架构梳理 SOUL.md 里）：

```
## 我在神经元里的位置
**我等谁（上游）**
- 竞品拆解（`competitor-analyze`）　交来 `feature-matrix`,`ux-patterns`
- 调研（`research`）　交来 `reference-index`,`tech-candidates`
- 逆向分析（`reverse-eng`）　交来 `impl-details`,`reusable-patterns`
**我给谁（下游）**
- 后端工坊（`backend-craft`）　交 `architecture-plan`
- 实施计划（`build-plan`）　交 `architecture-plan`,`risk-list`
- 前端工坊（`frontend-craft`）　交 `architecture-plan`
- 中枢（`hub`）　交 `architecture-plan`
```

## 七、验收

```
node prototype/hermes-agents/audit-neuron.mjs
  断言：通过 13  失败 0
  神经元 31 边（含环）· 执行图 18 边（无环）· 节点 12

node prototype/hermes-agents/verify-all.mjs
  断言：通过 104  失败 0
  智能体 12/12   任务 12/12   依赖边 18 条
```

审计器的 8 组判据（全部重算源，不信任生成物）：

| # | 判据 | 结果 |
|---|---|---|
| ① | 节点 12/12 有 profile | ✓ |
| ② | 重算契约 = NEURON.json（31 vs 31） | ✓ |
| ③ | kanban ⊆ 本体、无环、差集全可解释 | ✓ |
| ④ | 附属物 记忆/身份/技能 12/12 | ✓ |
| ⑤ | 底盘 11/11 + NEURON.md 183 行 | ✓ |
| ⑥ | 记忆地图覆盖 12/12 | ✓ |
| ⑦ | SOUL 含神经元位置 12/12 | ✓ |
| ⑧ | hermes 的 default profile 未被触碰 | ✓ |

## 八、工具

```
prototype/hermes-agents/
├── real-neuron-graph.mjs     从契约算真实神经元图（三种写法全展开）→ .neuron-graph.json
├── integrate-neuron.mjs      融入：底盘 + NEURON.json/md + SOUL 位置 + kanban DAG
├── audit-neuron.mjs          审计 8 组判据（重算源）
├── verify-all.mjs            四层验收（只管智能体与任务字段）
└── sync-agents.mjs           幂等同步（记忆变了就补）
```

## 九、还没做的（如实记）

- **图形视图没搬**：`neuron.js` 的球面渲染、拖拽、360° 旋转仍在工作台外壳里。
  hermes 侧目前只有**数据**（NEURON.json/md），没有那张可交互的球。
  要真看到球，得在 hermes 里做一个等价视图（工作量大，未做）。
- **面板附属物**：工作台里每个场景有 4 个面板（看板/文档/库/AI），hermes 没有面板概念。
- **领域层**：neuron.js 支持「领域球」（如命理球、工程球），我们的 12 个场景还没分领域。
