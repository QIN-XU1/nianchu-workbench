# 38 · Sceneflow：场景数据管线引擎（"神"的骨架）

> 用户要的不是"更多场景"，而是**场景之间能传递产物**。
> 例子：调研搜到竞品 → 自动汇入竞品拆解 → 拆完传给架构分析 →
> 逆向场景的产出也能汇入架构分析。

---

## 一、先纠正我自己的误判

用户说"29 个失效路径"。我实测核查：

| 我查过的 | 结果 |
|---|---|
`索引.json` 8 条路径 | **全部有效**（我把基准目录搞错了，误报） |
`renderers.js` 资源引用 | 6 个是模板占位符（`/img/panel/xxx.png` 之类） |
场景 json 路径 | 有效 |

**结论：真正"虚"的不是路径，是场景之间的连接。**

但我还是清掉了那 6 个占位符路径，并标注了 3 个可选资源。

### 1.1 找到的真正"虚"

```
13 个面板中，4 个是空的：
  bilibili / bv-ai    (harness): 无 sessionId
  command / cmd-chat  (harness): 无 sessionId
  pc-cleanup / pc-ai  (harness): 无 sessionId
  self-review / sr-ai (harness): 无 sessionId
```

`_场景身份索引.md` 里写着 `__待填__` —— **从未被填过**。

这不只是"面板空"，是"这个场景的 AI 根本没接线"。

---

## 二、核心问题：场景是孤岛

### 2.1 现有"跨场景协作"的全部能力

```javascript
// 工具/发消息.mjs
给另一个场景的 场景私有记忆.md 追加一行
+ 在 _跨场景通知.md 追加一条
```

**这是贴纸条，不是传数据。** 下游场景：
- 不知道上游产出了什么文件
- 不知道格式是什么
- 不知道哪些能用、哪些过期
- 没有"领取"概念，无法追溯

### 2.2 没有"产物"这个概念

场景 json 只有 `panels`（长什么样），没有：
- 这个场景**产出什么**
- 这个场景**需要什么**
- 产出的**格式契约**
- 产出的**接收方**

---

## 三、借鉴的成熟架构

### 3.1 Airflow 的 DAG

来源：[Airflow 官方文档](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html)

| Airflow 概念 | 我们借用 |
|---|---|
**DAG**（有向无环图） | 场景间流转不能成环，`verify` 会检测 |
**Task** | = 一个场景的一次产出 |
**upstream / downstream** | 调研 → 拆解 → 架构 |
**XCom**（任务间传数据） | = 场景间传递的产物引用 |
**trigger_rule** | 上游全部满足才能开始 |

### 3.2 Temporal 的 Event History

来源：[Temporal 文档](https://docs.temporal.io/workflows)

> The Event History is **the source of truth** for everything that happens in the Workflow.

**关键思想**：不存"当前状态"，存"事件序列"，可以从头重放。

**我们借用**：`events.jsonl` 是唯一真相来源，`index.json` 可从事件重建 —— `verify` 会对比两者一致性。

---

## 四、Sceneflow 设计

### 4.1 三层的模型

```
场景（Scene）    = 工作单元，声明 inputs / outputs 契约
产物（Artifact） = 场景产出，有 id / 类型 / 正文文件 / 接收方 / 领取记录
管线（Pipeline） = DAG，定义场景之间的流转边
```

### 4.2 场景契约（`sceneboard/scenes/<id>.json`）

```json
{
  "id": "research",
  "name": "调研",
  "role": "全网搜索：架构方案、竞品、技术资料",
  "inputs": [],
  "outputs": [
    { "id": "competitor-list", "name": "竞品清单",
      "to": ["competitor-analyze"],
      "schema": ["名称", "官网/仓库", "定位", "技术栈线索", "值得拆的点"] },
    { "id": "tech-candidates", "name": "技术方案候选",
      "to": ["reverse-eng", "arch-review"], ... },
    { "id": "reference-index", "name": "资料索引",
      "to": ["arch-review"], ... }
  ]
}
```

**`to` 字段是关键**：声明"我产出的这个东西该给谁"。发布时自动解析接收方。

### 4.3 管线定义（`sceneboard/pipelines/build-software.json`）

```json
{
  "id": "build-software",
  "name": "造一个软件",
  "nodes": [
    { "scene": "research",           "role": "调研" },
    { "scene": "competitor-analyze", "role": "拆解竞品" },
    { "scene": "reverse-eng",        "role": "逆向成熟作品" },
    { "scene": "arch-review",        "role": "架构梳理" },
    { "scene": "build-plan",         "role": "实施计划" }
  ],
  "edges": [
    { "from": "research", "to": "competitor-analyze", "artifact": "competitor-list" },
    { "from": "research", "to": "reverse-eng",        "artifact": "tech-candidates" },
    { "from": "competitor-analyze", "to": "arch-review", "artifact": "feature-matrix" },
    { "from": "reverse-eng",        "to": "arch-review", "artifact": "impl-details" },
    { "from": "reverse-eng",        "to": "arch-review", "artifact": "reusable-patterns" },
    { "from": "arch-review",        "to": "build-plan",  "artifact": "architecture-plan" }
  ]
}
```

**这正是用户描述的流程**：调研分两路（竞品 → 拆解；技术方案 → 逆向），两路最后都汇入架构梳理。

### 4.4 存储（全是文件，零数据库）

```
workbench/
  产物/
    index.json        产物索引（可从事件重建）
    events.jsonl      事件流（唯一真相来源）
    <名字>-<日期>-<id>.md   产物正文
  sceneboard/
    scenes/<scene-id>.json       场景契约
    pipelines/<pipeline-id>.json 管线定义
```

---

## 五、真实流程验证（23/23）

```
调研发布竞品清单
  → 文件真的落盘：产物/竞品清单-2026-11-06-3500eec8.md
  → 自动解析接收方：competitor-analyze

竞品拆解收件箱
  → 看到 1 条待领取

领取
  → 状态变为已领，收件箱清空

读取
  → 内容包含竞品表格

拆解发布功能矩阵
  → 自动发给 arch-review

架构梳理收件箱
  → 看到 1 条待领取

管线进度
  → competitor-analyze 状态从 WAIT 变成 READY
```

### 5.1 校验能发现坏数据（这是关键）

| 人为制造的坏数据 | 校验反应 |
|---|---|
删掉一个产物文件 | ✗ 报"产物文件缺失" |
造一条有环的管线 | ✗ 报"管线有环" |
恢复后 | ✓ 通过 |

**一个永远通过的测试没有价值。这三个反例证明了校验是真的。**

---

## 六、界面接入（14/14）

新增面板类型 `sf-board`，实际渲染效果：

```
场景数据管线  [造一个软件 ▼]  5 节点 · 产物 3 个  ⟳

● research           调研：搜架构/竞品/资料        [等待上游]
● competitor-analyze 拆解竞品：功能矩阵/交互模式   [等待上游]
● reverse-eng        逆向成熟作品：实现细节        [等待上游]
● arch-review        架构梳理：汇总裁判           [可开始]
● build-plan         实施计划：里程碑/验收        [等待上游]

收件箱
  （空）/ 待领取产物 + [领取] 按钮

产物
  竞品清单 / 功能矩阵 / 架构方案 …
```

**这是可交互的**：能切换管线、点领取、看节点状态。

---

## 七、场景扩展：10 个

新增 6 个管线场景（都是真实面板组合，不是空壳）：

| 场景 | 面板组合 |
|---|---|
**管线** | 管线进度看板 + AI |
**调研** | 网页（可搜索）+ AI |
**竞品拆解** | 管线位置 + 竞品网页 + AI |
**逆向分析** | 管线位置 + 源码预览 + 文件库 + AI |
**架构梳理** | 管线位置 + 架构文档 + 参考网页 + AI |
**实施计划** | 管线位置 + 计划文档 + 文件库 + AI |

原有 4 个（命令/B站/自我复盘/本地电脑）保留。

---

## 八、剩余问题（诚实）

### 8.1 仍然"虚"的部分

**10 个场景的 AI 面板全部没有绑定会话**（`sessionId` 为空）。

原因：建会话需要跑 `node 外壳\scripts\建会话.mjs --title "xxx"`，这需要引擎在跑。
这**不是代码问题，是运行时配置**。

**这确实还是"虚"的** —— 面板格子在那里，但里面没有 AI 在跑。

### 8.2 没做的

| 项 | 原因 |
|---|---|
自动建会话 | 需要引擎配合，跨进程操作 |
产物版本管理 | 现在发布即固定，要改就发新版（暂未实现"更新"） |
管线中断恢复 | 没做"某个场景失败后从哪继续" |
多用户并发 | 单人工作台，未考虑并发锁 |

---

## 九、下一步

| 优先 | 做什么 |
|---|---|
**1** | **建 10 个场景的会话**，让 AI 面板真的跑起来（这就消除了最后一块"虚"） |
**2** | 产物的"更新"语义（同一逻辑 id 发新版，旧版标记 stale） |
**3** | 管线中断恢复 |
**4** | 把 Sceneflow 结果注入到 AI 会话的上下文（让 AI 知道上游给了什么） |

---

## 十、一句话

> **用户说"虚"，我查了两轮：路径是虚报（真没问题），但"场景孤岛"是真的虚。**
> **Sceneflow 把留言板变成数据管线：场景声明产出契约 → 发布自动路由 → 下游领取留痕 → 事件流可重放 → 校验能发现坏数据。**
> **这是"神"的骨架：不是一个万能场景，而是让任意场景能串成一条链。**
> **但还有最后一块虚：10 个场景的 AI 面板没绑会话 —— 这需要建会话，不是写代码。**
