# Pi（earendil-works/pi）源码级剖析

> 取证方式：**本地源码**（`D:\refs\pi-main\pi-main`，codeload tarball 15.1MB → 解压 4,511 文件 / 50.8MB）。
> 比联网文档和二手描述优先。所有结论都附 `文件:行号`。
>
> 仓库：`github.com/earendil-works/pi` · **121,913 stars** · TypeScript · 107.6MB
> 自述：「**minimal, extensible agent harness that you can make your own**」

## 一、它是什么（一句话）

一个**极简内核 + 包扩展**的 agent harness。README 明说：

> Pi ships with powerful defaults but **skips features like sub-agents and plan mode**.
> Ask Pi to build what you want, or install a package that does it your way.

—— 故意的减法。不做 sub-agent、不做 plan mode，让用户用扩展补。**OpenClaw 就是 Pi 的真实集成案例**（README 原文点名）。

## 二、规模解剖（LOC 是源码直接数的）

| 包 | 文件 | 行数 | 干什么 |
|---|---|---|---|
| `packages/agent` | 6 | **2,548** | **agent 循环（核心）** |
| `packages/ai` | 211 | 29,098 | 统一 LLM API（多 provider） |
| `packages/tui` | 46 | 20,061 | 终端 UI 框架 |
| `packages/coding-agent` | 265 | 78,807 | CLI 主体 + 扩展系统 |
| `packages/durable` | 102 | 35,610 | 持久化 |
| `packages/chord` | 299 | 61,560 | 跨进程对象运行时 |
| `packages/schema` | 43 | 4,852 | JSON Schema 构建器 |
| `packages/mcp` | 28 | 4,746 | MCP |
| `packages/codemode` | 17 | 3,051 | 代码模式 |
| `packages/evals` | 5 | 1,447 | 评测 |

**最值得注意的一格**：agent 循环只有 **2,548 行 / 6 文件**（`agent-loop.ts` 29.3KB + `agent.ts` 19.7KB + `types.ts` 21.4KB）。
总量 ~24 万行 TS，核心占 1%。这是一个明确的架构选择：**内核越小，越好被替换和包装**。

对比我们：我们的 agent 循环不在自己手里（用的是 hermes 的 `conversation_loop.py`）。
这既是省事，也是依赖 —— 见第五节。

## 三、agent 循环的设计（`packages/agent/src/agent-loop.ts`）

### 3.1 入口是第一等的「继续」

```
agent-loop.ts:47   export function agentLoop(
agent-loop.ts:80   export function agentLoopContinue(
agent-loop.ts:111  export async function runAgentLoop(
agent-loop.ts:137  export async function runAgentLoopContinue(
```

大部分框架只有一个 `run()`，Pi 把「继续一个已存在的循环」做成了独立入口。
这不是 API 糖 —— 它意味着**中断/恢复是设计内的，不是异常路径**。

### 3.2 事件流是一等公民

```
agent-loop.ts:162  function createAgentStream(): EventStream<AgentEvent, AgentMessage[]>
agent-loop.ts:35   export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
```

循环产出的是**事件流**，不是「最终字符串」。所以 TUI / JSON / RPC 三种界面能共用同一套循环
（`how-pi-works.md`：「All interfaces use the same agent and session mechanisms」）。

### 3.3 工具集在循环中间可以变

```
agent-loop.ts:342  function declareToolChanges(context, pendingMessages): AgentMessage[]
agent-loop.ts:374  const NO_CHANGES: ToolStateChanges = { toolsAdded: [], toolsRemoved: [] };
agent-loop.ts:377  function withToolChanges(message: SystemMessage, { toolsAdded, toolsRemoved })
```

**工具列表随 pending 消息动态增减**，并把变化写进 system message 告诉模型。
这比「一次装配、全程固定」灵活 —— 长任务里工具多了会稀释模型注意力，Pi 选择按需增删。

### 3.4 钩子在工具调用前后

```
agent-loop.ts:684  export type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall">
agent-loop.ts:690  function shouldTerminateToolBatch(finalizedCalls)
```

`shouldTerminateToolBatch` 很重要：**一批工具调用里只要有该终止的，整批就终止**。
不是「跑完所有再判断」，而是批内短路。

## 四、会话模型：JSONL 树（这条最值得抄）

`how-pi-works.md` 原文：

> Messages and events in a session form a **tree**. Each path through that tree is a **branch**.
> The branch ending at the current entry is the **active branch** and supplies the history for the next model request.

细节：
- **会话是 JSONL 文件**，每条 entry 有 ID 并**指向父 ID**
- 当前 entry 决定活动分支
- 「从更早的 entry 继续」= 在同一个文件里**开新分支**
- fork / clone = 把选定历史复制进新会话文件
- **压缩插入一条 summary entry，替换老消息参与后续请求，但原始 entry 留在树里**

最后一条是关键：**压缩不等于删除**。上下文被替换了，但历史没丢 —— 可回溯、可重放、可换分支重跑。

对比我们的记忆：我们是「三层记忆 + 神经元」，语义记忆强，但**对话分支能力没有**。
这是一个真实差距。

## 五、界面设计：Pi 的 UI 投入全在 TUI

Pi 有一个实验性 web app（`apps/p2`，自己的 README 标 **EXPERIMENTAL / "It will be gone soon"**），
但真正的界面资产是 **TUI 框架**（`packages/tui`，46 文件 / 20,061 行）。

### 5.1 组件库（`packages/tui/src/components/`）

| 文件 | 大小 | 是什么 |
|---|---|---|
| `editor.ts` | **82.7KB** | 输入编辑器（含 IME 光标定位） |
| `markdown.ts` | **39.7KB** | Markdown 渲染 |
| `input.ts` | 14.9KB | 单行输入 |
| `settings-list.ts` | 10.8KB | 设置流 |
| `select-list.ts` | 9.6KB | 可搜索选择 |
| `scroll-view.ts` | 8KB | 有界滚动视口 |
| `image.ts` | 5.2KB | **终端里渲染图片** |
| `box.ts` | 4.8KB | 边框容器 |
| `stack/h-stack/v-stack/spacer` | 1–5KB | 布局原语 |
| `loader.ts` / `cancellable-loader.ts` | 1–2.7KB | 进行中反馈 |
| `mouse-region.ts` | 0.9KB | 指针区域 |

布局原语是 **VStack / HStack / Box / Spacer** —— 和 Web 的 flex 同构，说明它在把 Web 布局心智搬进终端。

### 5.2 三条可以直接抄的设计规则（`docs/tui.md` 原文）

**① 宽度按可见列算，不按字符串长度**

> Measure **visible terminal columns** rather than string length because ANSI escapes,
> **wide characters, emoji, and combining characters** change display width.
> Use `visibleWidth()`, `truncateToWidth()`, `sliceByColumn()`, `wrapTextWithAnsi()`.

这条对**中文界面**尤其重要 —— 一个汉字占 2 列，按 `str.length` 排版必然错位。

**② 每个交互都要有键盘路径**

> Design every interaction with a **keyboard path** even when fullscreen mouse input is available.

**③ 焦点不向下传，中文输入法候选框会跑到错的位置**

> Containers that wrap an `Input` or `Editor` must **propagate their `focused` state** to that child.
> Without propagation, **Chinese, Japanese, Korean, and other IME candidate windows
> can appear at the wrong screen position.**

这条直接命中我们：我们是中文界面，输入法候选框位置错了就是硬伤。

### 5.3 主题：对比度是算出来的保证，不是手挑的

`docs/themes.md` 的 `system` 主题（默认）：

- 查询终端的默认前景/背景色 + 16 个 ANSI 色
- **每个颜色从某个 ANSI 色取色相**（错误取红、链接取蓝）
- **亮度按最小对比度反算** —— 「Body text keeps at least a **4.5:1 WCAG** contrast ratio on the background and **every panel**」
- 终端切换明暗时**重新查询并重建主题**
- 退化表：背景+ANSI / 只有背景 / 什么都没有（三级降级，都有明确表现）
- 启动时最多等 **100ms**，超时先用 ANSI 回退，晚到的颜色仍然生效

**这是把可访问性做成了计算属性，而不是设计稿上的一个值。** 我们的界面没有这条保证。

## 六、和我们的对比（诚实）

| 维度 | Pi | 我们 | 判定 |
|---|---|---|---|
| 内核体量 | 循环 2,548 行自持 | 用 hermes 的 `conversation_loop.py`（不属于我们） | **我们输**：不可替换 |
| 会话分支 | JSONL 树，原生分支/fork | 无分支能力 | **我们输** |
| 压缩 | summary entry 替换，原 entry 保留 | 有压缩但无树 | 部分输 |
| 工具集动态变化 | 循环中可增删 | 固定工具集 | 部分输 |
| 事件流 | `EventStream` 一等公民 | 有但非核心抽象 | 平 |
| 扩展系统 | 扩展/skill/模板/主题四类，可打包 npm 分享 | 12 场景 + 106 守卫 | 各有侧重 |
| 中文/IME | 明确处理（`CURSOR_MARKER` + 焦点传播） | 未处理 | **我们输** |
| 对比度保证 | WCAG 4.5:1 反算 | 无 | **我们输** |
| 多界面 | TUI / print / JSON / RPC / SDK 五套共用循环 | 桌面 + TUI(星图) 两套 | 我们少 |
| 记忆 | 无专设记忆层 | 三层记忆 + 神经元 + 派单台账 | **我们赢** |
| 编排 | 故意不做 sub-agent | 12 场景契约 + 派单 | **我们赢** |
| 验证 | 有 evals 包（5 文件 1,447 行，小） | 106 守卫 + 反例验证 + 三层验收 | **我们赢** |

## 七、要抄的三件事（按价值排序）

### 1. 会话树 + 压缩不删历史

我们现在的记忆是「语义记忆」，强在"记住规矩"，弱在"能回到过去任何一个点重试"。
Pi 的 JSONL 树把这件事变成了文件格式层面的能力。
**落到我们：给派单加 `parent_session` 链，压缩只写 summary 不删原始 entry。**

### 2. 中文宽度 + IME 焦点传播

这是硬伤，不是优化项。一条 `visibleWidth()` 等价物 + 焦点向下传播，成本很低。
**落到我们：hermes 桌面端是 React，用 `Intl.Segmenter` 或 canvas measureText 算显示宽度。**

### 3. 对比度反算

把「文字要看得清」变成代码里可计算的约束，而不是设计时凭感觉。
**落到我们：写一个 `ensureContrast(fg, bg, 4.5)` 工具，主题色一律过它。**

## 八、和我们「不做」清单的关系

Pi 有一句话和我们策略完全一致：

> **Adapt Pi to your workflows, not the other way around.**

这正是用户对我们的要求 —— **不要自己设计界面，在成熟 agent 上衍生**。
Pi 证明这条路线能到 121k stars。

但 Pi 也证明了一件事：**内核必须小到可以自己拿着**。
我们现在内核在 hermes 手里，这是最大的结构性依赖。短期靠补丁集缓解，长期要么接受，要么把循环接管过来。

## 九、取证索引

| 结论 | 证据 |
|---|---|
| 极简定位、不做 sub-agent | `README.md:23-25` |
| 循环 2,548 行 | `packages/agent/src/` 6 文件实测 |
| 继续是一等入口 | `packages/agent/src/agent-loop.ts:47,80,111,137` |
| 事件流 | `agent-loop.ts:162`、`:35` |
| 工具集动态 | `agent-loop.ts:342,374,377` |
| 批内短路 | `agent-loop.ts:690` |
| 会话树 | `packages/coding-agent/docs/how-pi-works.md`（Sessions 节） |
| 宽度按列 | `packages/coding-agent/docs/tui.md`（Understand the component model） |
| 键盘路径 | `tui.md`（Handle mouse input） |
| IME 焦点 | `tui.md`（Handle keyboard input and focus） |
| WCAG 4.5:1 | `packages/coding-agent/docs/themes.md`（Use your terminal's colors） |
| TUI 组件体量 | `packages/tui/src/components/` 逐文件实测 |
| p2 实验性 | `apps/p2/README.md:3-6` |
