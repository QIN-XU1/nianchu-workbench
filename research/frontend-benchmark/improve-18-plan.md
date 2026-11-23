# 批次 X · 计划图层（todo_write）+ 子代理卡片

> 对标：Qoder 计划面板、dsh `packages/todo/tool-todo`（`todo/write` 整表快照）
> 证据：`tools/agent/verify-plan.mjs` 22/22 + 产品服务器（47124）真跑截图
> 日期：2026-11-22

## 1. 为什么做这一批

`scorecard.md` 里「美观 4.2 vs Qoder 4.3」的缺口写得很清楚：**计划图层 / 子 Agent 可视化**没做。
这不是装饰问题——长任务跑起来时界面只能显示「正在执行」，用户不知道它做到第几步、
还剩什么、哪些已经放弃。Qoder 的计划面板正是为这件事存在的。

## 2. 改动

### 2.1 宿主侧：`todo_write` 工具（`tools/agent/toolkit.mjs`）

契约照 dsh 的 todo 工具：

- **整表替换**，不是追加。理由：模型的增量编辑很容易和上一版对不上（漏改、重排），
  整表提交每次都自洽。
- 三项状态 `pending / in_progress / completed`。
- 同一时刻**最多一项** `in_progress`。
- 校验全部在工具里做，**错了就把原因喂回模型让它重写**，不静默纠正：

| 反例 | 返回 |
|---|---|
| `status: 'done'` | `status 非法：done（只能是 pending/in_progress/completed）` |
| `content: '   '` | `第 1 项 content 为空` |
| 两项同名 | `计划里有重复项：…` |
| 两项 `in_progress` | `同一时刻只能有一项 in_progress，现在是 2 项` |
| `todos: 'x'` | `todos 必须是数组` |
| 单项 > 200 字 | `第 1 项 content 超过 200 字` |

为什么必须拒绝而不是纠正：静默纠正会让界面出现一份「看起来对、其实和模型想的不一样」的计划，
那比不显示更糟。

### 2.2 循环侧：计划快照（`tools/agent/loop.mjs`）

- `todo_write` 进默认工具表（第 64 行），系统提示补一条使用规则
  （「任务需要 3 步以上时，先用 todo_write 写一份计划」）。
- 跑完从 transcript 取**最后一次成功的** `todo_write` 作为 `run.plan`：
  - 不用累加：整表替换语义下累加会得到重复项。
  - 失败那次不算：校验没过，清单没被接受，否则界面显示的是没生效的计划。
  - 从没写过 → `plan = null`，界面据此**不渲染空面板**。

### 2.3 事件侧：`nianchu://agent-plan`（`tools/hostapi/ws-host.mjs`）

`agent-step` 的 `input` 是截断预览，计划项多了会被切掉 —— 界面就会显示一份**缺项**的计划。
所以 `todo_write` 成功时单独推一份**完整清单**（清单本身很小，整份发）。

**同时修掉一个真 bug**：原来推 step 用的是

```js
input: step.input ? JSON.parse(JSON.stringify(step.input).slice(0, 1200)) : undefined
```

先序列化再按字符截断 —— 截出来的不是合法 JSON，`JSON.parse` 会抛，
而这里抛异常会把整个 `onStep` 打穿、连带 `run_task` 失败。
只要一次 `write` 的内容超过 1200 字符就会复现。改成 `previewInput()`：按字段安全截断。

### 2.4 前端：计划面板（`NianchuChat.tsx` + `.scss`）

- 面板在助手消息的工具卡之前，含标题、`已完成/总数`、进度条、逐项清单。
- **三重编码**：符号（✓ / ● / ○）+ 颜色 + 删除线。不只靠颜色区分，色弱也能看出「已完成」。
- `todo_write` 不再出现在工具卡里（已经从面板「翻译」成人话，再摊一份 JSON 只是噪音）。
- 导出 Markdown 时计划变成 `- [x] …` 复选框。

### 2.5 前端：子代理卡片

`spawn_subagent` 的步骤标题显示「子代理」而不是原始工具名，参数摘要显示任务描述
（`stepArgText` 的键序加了 `task`，放最后——它通常最长，不该抢 `path` 的位置）。

> 如实边界：这一条**本批只在代码上落地，没有端到端跑通证据**。实测中模型收到
> 「用 spawn_subagent 派子代理」的指令后先去 bash 里找这个工具，最后 `Request timeout`，
> 没有产生 `spawn_subagent` 步骤，所以没有它的卡片截图。不当作已验证项。

## 3. 证据

### 3.1 判据脚本 `tools/agent/verify-plan.mjs` — 22/22 PASS

```
══ 一、工具形状 ══            3/3
══ 二、正常提交 ══            6/6   （计数自洽、allDone 判定、顺序保持、trim）
══ 三、反例：必须拒绝 ══      7/7   （6 个反例 + 空清单不算完成）
══ 四、整表替换语义 ══        1/1
══ 五、循环输出计划快照 ══    5/5   （假网关，不烧模型）
   · run.plan 存在且是数组
   · 快照取**最后一次**提交（两项都 completed）
   · 两次 todo_write 都进了 transcript
   · 校验失败的提交不覆盖上一份有效计划
   · 没写计划时 plan=null（不渲染空面板）
```

### 3.2 产品服务器端到端（47124，真模型）

任务：「分三步做：第一步读 README.md 前 3 行；第二步统计 tools/agent 目录下 .mjs 文件数量；
第三步用两行总结。开始前先用 todo_write 写计划。」

| 断言 | 实测 |
|---|---|
| 计划面板数量 | `planPanels = 1` |
| 面板出现时机 | `sawPlanWhileBusy = true`（**跑的过程中就出现**，不是跑完才补） |
| 三项状态 | `completed\|读取 README.md 前 3 行` / `completed\|统计 … .mjs 文件数量` / `completed\|用两行总结结果` |
| 计数 | `planCount = "3/3"` |
| 进度条 | `barWidth = "100%"` |
| `todo_write` 是否在工具卡重复 | `todoWriteInCards = false` |
| 工具卡内容 | `["read","bash","bash","glob","bash","bash"]`（todo_write 已过滤） |
| 错误横幅 / 控制台异常 | `null` / `[]` |

中途截图（`improve-plan-mid.png`）能看到 `计划 0/3`、第一项 `●` 加粗为进行中、后两项 `○` 待办 ——
证明是**边跑边更新**，不是一次性渲染。

第二组任务：「先用 todo_write 写两条计划（1 看 README 第一行 2 复述），然后按计划做完。」
→ `improve-plan-light.png`：`计划 2/2`，两项全绿 ✓ + 删除线 + 满进度条，工具卡 `bash ls` / `bash dir /b` / `read`。

### 3.3 截图

| 文件 | 内容 |
|---|---|
| `evidence/improve-plan-mid.png` | 运行中：0/3，首项进行中（●），后两项待办（○） |
| `evidence/improve-plan-final.png` | 收尾：3/3 全绿 ✓ + 删除线 + 满进度条 + 工具卡 |
| `evidence/improve-plan-light.png` | 第二组：2/2 全绿，含真实工具卡 |
| `evidence/improve-product-home.png` | 产品服务器首页（神经记忆元，28 记忆元 / 62 关系，真实会话 20954 tokens） |
| `evidence/improve-product-todos.png` | 任务看板（计划概览 / 待执行任务 / 2026年11月日历） |
| `evidence/improve-product-scenes.png` | 场景页（架构梳理：相关文件 / 相关改进 / AI·架构梳理 / 相邻场景） |
| `evidence/improve-subagent-card.png` | ⚠️ 子代理卡片**未取到**（模型超时，无 spawn_subagent 步骤），此图仅为该轮工具卡现场 |

### 3.4 一个被实测揪出来的部署坑

第一次端到端跑完，模型在总结里写「**环境里没有 todo_write**」——不是模型幻觉，
是预览服务器 05:17 启动、而 `todo_write` 06:23 才加进 `loop.mjs` / `toolkit.mjs`，
**服务器跑的是旧代码**。重启后同一任务立刻出现计划面板。
记在这里：改完宿主侧工具必须重启宿主进程，热更新不覆盖 `tools/`。

## 4. 构建与类型

- `vite build` ✓（1m48s），产物含 `.ncc-plan__*` 样式。
- `tsc --noEmit` 仅剩 3 条**既有** `@/generated/api` 缺失错误（与本次改动无关）。

## 5. 记分影响

- D-美观 V2 视觉层级：多一层「计划」信息块，长任务有进度可见 → 4.2 → **4.3**。
- D-功能 F1 闭环：多一个真实的计划工具（不是假进度条），与 dsh `tool-todo` 契约对齐。

**仍缺（如实列）**：
- 审批卡 —— 有意不做（`总纲.md:18` 列为非目标）。
- 子代理卡片 —— 代码在，**没有端到端证据**。
- 竞品逐屏对照 —— 未补完。
