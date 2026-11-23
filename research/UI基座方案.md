> ## ⛔ 本文已作废（被 `我们产品的方案.md` 取代）
>
> 作废原因：本文的方案是「在 OpenBitFun 安装包上挂一个 Creation UI 层」——
> 那是**寄生在别人的安装包上**，被 3 个挂载点锁死，场景界面无法自研，不是自己的项目。
>
> 用户明确：**我们要自己的一份项目，OpenBitFun 只作为前端与大体架构参考，
> 实际功能与场景界面自行深究开发。** 请看 `我们产品的方案.md`。
>
> 本文保留仅作追溯。
# UI 基座方案（站在 OpenBitFun 之上）

> 用户方向已定：**不仿照，直接拿它的源码用。** 本文只做一件事 —— 把方案定清楚，避免返工。
> 结论先行，然后逐条给证据与代价。

---

## 0. 一句话方案

**基座用 OpenBitFun 的安装版前端（不改一行）；我们的产品是它的一个官方「Creation UI」层，
通过 `openbitfun-creation.{js,css}` + `creation-assets/` 挂上去；我们的后端通过
`ui.commands.register` 的 handler 转出站 HTTP 调用。**

不 fork、不改 bundle、不重写界面 —— 它升级就是换安装包，我们的层照常加载。

---

## 1. 已验证的事实（都有证据，不是推断）

| 事实 | 证据 |
|---|---|
| 真前端完整落盘，不是只有二进制 | `D:\OpenBitFun\frontend\dist\` 2740 文件 / 89.1MB；`assets/index-*.css` 526KB、`index-*.js` 2MB |
| 它的 React 代码能在非 Tauri 环境跑起来 | 我写的 `run-real.mjs` 起静态服务 + IPC shim，DOM 渲染出它自己的文案，**118 条 IPC 调用** |
| 真实布局令牌 | `--openbitfun-layout-navigation-panel-inline-size: 216px`、`item-height: 30px`、`toolbar-md-height: 45px` |
| 真实亮色令牌 | `surface-chrome #f8f8f9` / `surface-canvas #ffffff` / `content-muted #343434` / `accent #059cb0` |
| 真实启动属性 | `data-density="compact"`、`data-contrast="standard"`、`data-openbitfun-native-frame="client"` |
| **它有官方扩展契约** | `D:\OpenBitFun\frontend\dist\openbitfun-creation-api.md`（7KB，Creation UI API v1） |
| 我此前所有复刻都是错的 | 真机截图 vs 我的复刻：语言/侧栏项数/首屏/窗口控件/密度 全不一致 |

## 2. 关键：官方 Creation UI API v1 提供什么

这是整个方案的支点。原文摘要（`openbitfun-creation-api.md`）：

```js
// openbitfun-creation.js —— 默认导出 activate(ui)
export default function activate(ui) { ... }   // 可返回 cleanup
```

| 能力 | 说明 | 对我们的用处 |
|---|---|---|
| `ui.mount(slot)` | 在 `sidebar-footer` / `scene-header` / `scene-footer` 建自己的 DOM 根，**React 重渲染与场景切换后仍存活**，停用时自动移除 | 我们所有自有 UI 的落点 |
| `ui.parts` | `shell` / `workspace` / `sidebar` / `content` / `tabs` 的 CSS 选择器 | 不靠生成类名做样式 |
| `ui.getScene()` / `ui.onSceneChange()` | 当前场景 id 与订阅 | 按场景挂我们的东西 |
| `ui.control.get/open/configure/execute(capabilityId, …)` | 发现式地读状态、开界面、改设置、执行操作 | 复用它的模型/设置/小程序页，不重造 |
| `ui.commands.register({id, description, parameters}, handler)` | 注册命令；**Agent 侧通过 `FrontendWorkbench invoke` 调用** | 我们的能力进入它生态的正式口子 |
| `ui.state.get/set/keys/delete` | WebView 里带命名空间的 JSON 状态，**代码替换 / 回滚 / 兼容升级都保留数据** | 我们的配置与产物索引 |
| `ui.events.on/emit` | `scene.changed`、`state.changed` + 自定义事件 | 层内通信 |
| `ui.inspect()` | 活体命令 schema、事件、state 键、诊断、当前场景、**支持的 UI part/slot 实际存在性** | P0 摸底的核心工具 |

硬约束（必须在设计里守住）：

- **Do not edit generated bundles or index.html.** → 我们一行都不改它的产物。
- **No arbitrary Tauri invocation API is exposed.** → 我们不能直接读它的会话/模型数据库，
  只能用 `ui.control` 已暴露的能力；这条决定了「我们能看到什么」的边界。
- **UI activation is local Desktop only; Peer surfaces deactivate it.**
- 安装流程是 `FrontendWorkbench` → `draftId` → 确认；**15 秒 Keep 倒计时**；失败可 `rollback`。
- **Compatible client upgrades retain the customization while replacing the product bundle.**
  → 这是「少返工」的全部来源。

## 3. 三层架构

```
┌──────────────────────────────────────────────────────────────┐
│ L1  基座：OpenBitFun 安装版前端（87 个 chunk，不改）           │
│     窗口外壳 / SceneBar / NavPanel(216px) / 会话 / 设置 / 小程序 │
│     升级 = 换安装包                                            │
├──────────────────────────────────────────────────────────────┤
│ L2  我们的层：openbitfun-creation.js + .css + creation-assets/  │
│     挂载点：sidebar-footer / scene-header / scene-footer        │
│     能力入口：ui.commands.register（命名空间，如 verify.*)      │
│     数据：ui.state（官方保证跨升级保留）                        │
├──────────────────────────────────────────────────────────────┤
│ L3  我们的 runtime（本地进程）                                  │
│     既有能力：四态验证 / 技能 / MCP / 场景 / 记忆               │
│     对外只有一个口：http://127.0.0.1:<port>                     │
│     L2 的 command handler 用 fetch 转进来（不违反契约）          │
└──────────────────────────────────────────────────────────────┘
```

**唯一出网口**：Creation API 不暴露任意 invoke，所以 L2→L3 只能走我们自己起的本地 HTTP。
这个口子也顺便解决了跨平台与调试（curl 能测）。

---

## 4. 七个决策点（每个都写清「选错要返工什么」）

| # | 决策 | 推荐 | 选错的返工代价 |
|---|---|---|---|
| 1 | 集成方式 | **官方 Creation API**，不 fork dist | fork 后每次它升级都要重做 diff；官方明说升级会替换 bundle |
| 2 | 我们的 UI 挂哪 | `sidebar-footer` 起家，逐步用 `scene-header`/`scene-footer` | 挂到 React 内部节点会在下一次重渲染被抹掉 |
| 3 | 样式怎么定 | 用它给的语义选择器 `[data-openbitfun-component=…][data-openbitfun-part=…]` + 它导出的 `--openbitfun-*` 变量 | 用生成类名（`index-*.css` 里的 hash）下次构建就失效 |
| 4 | 我们的能力怎么进 Agent | `ui.commands.register` 命名空间化（`verify.run` / `skill.list` / `mcp.status`） | 自己起 RPC 则 Agent 侧无法发现，等于旁路 |
| 5 | 数据放哪 | 小状态 `ui.state`；大对象与产物放 L3 | 全放 ui.state 会撑爆 WebView storage；全放 L3 则丢失跨升级保留的好处 |
| 6 | 它已有页面要不要重做 | **一律 `ui.control.open`**，只在它没有的地方自建 | 重做模型/设置页 = 与它的数据模型长期对不齐 |
| 7 | 版本策略 | pin 一个 OpenBitFun 版本（当前 v1.0.10），我们的层独立版本 | 跨大版本升级时 Creation API 可能升版，需按 `ui.version` 分支 |

---

## 5. 分阶段计划（每阶段都有可运行的验收门）

### P0 · 契约摸底（**先做，决定后面全部**）

目标：把 `ui` 的真实能力摸清，避免在错误假设上盖房子。

1. 写最小 `openbitfun-creation.js`：`ui.mount('sidebar-footer')` 一个按钮 + 注册 `p0.ping` 命令
2. 用它的 `FrontendWorkbench` 走 apply → Keep → `inspect()`
3. 记录并落盘：`ui.inspect()` 的**完整输出**（可用 commands / events / state keys /
   **实际存在的 slot 与 part**）、`ui.version`、可用 `capabilityId` 清单

验收门（全部通过才进 P1）：
- [ ] `inspect` 报告 `p0.ping` 及其 schema
- [ ] `FrontendWorkbench invoke` `p0.ping` 返回预期值
- [ ] 挂载的按钮在场景切换后仍存在
- [ ] `ui.state` 写后重新加载仍在
- [ ] `rollback` 能完整恢复
- [ ] **输出「可用 capabilityId 清单」—— 决定我们能不能复用它的模型/设置页**

> 风险最高的一步。若这里发现 slot 不够用或 capability 太少，方案要在 P0 就调整，
> 而不是等 P2 才发现。

### P1 · 我们的面板骨架

- 三个 mount 点各放一块：`scene-header`（当前场景的验证状态条）、
  `sidebar-footer`（我们的能力入口）、`scene-footer`（工具链快捷）
- 样式全部走它导出的变量，明暗两套都要能读
- 验收门：明/暗、`data-density` 两档下无溢出、对比度可读；切场景不掉

### P2 · 后端桥

- L3 起本地 HTTP（只监听 127.0.0.1，带一次性 token）
- L2 的 command handler 转发；超时/断线要有明确降级（显示「判不了」，不是假装成功）
- 验收门：`curl` 能打；断掉后端时界面显示不可用而不是白屏

### P3 · 能力接线

- 已有能力（四态验证 / 技能 / MCP / 场景）逐个注册为 command
- 它已有的（模型配置、设置、小程序）一律 `ui.control.open` 复用
- 验收门：每条能力在 `inspect` 里可见、可 invoke、有真实返回

### P4 · 升级演练（这一步才证明「少返工」成立）

- 卸载 → 装新版 OpenBitFun → 确认 customization 保留、我们的命令仍可 invoke
- 若 Creation API `ui.version` 变化，记录差异并加分支
- 验收门：升级后 P1–P3 的验收门全部重跑通过

---

## 6. 明确不做（非目标）

- ❌ 不改 `dist` 里任何文件、不改 `index.html`、不 fork bundle
- ❌ 不实现「任意 Tauri invoke」（官方明确不提供，绕过会破坏升级兼容）
- ❌ 不重写它的窗口外壳 / SceneBar / NavPanel / 会话页
- ❌ 不再写仿制 HTML（`bitfun-clone.html` / `bitfun-full.html` / `workbench-v1..v7` 全部作废）
- ❌ 不在 P0 之前写任何产品代码

---

## 7. 已知风险与去风险动作

| 风险 | 影响 | 去风险动作 |
|---|---|---|
| `ui.mount` 只有 3 个 slot | 我们的界面装不下 | P0 的 `inspect()` 先确认实际存在的 slot/part |
| 无任意 invoke，读不到会话数据 | 验证态/上下文面板拿不到数据 | P0 拿到 capability 清单；拿不到的部分改由我们自己的会话通道产生 |
| Creation 安装流程依赖它的 Agent 工具 | 无法脚本化/CI | P0 确认是否有 CLI 路径（`openbitfun-cli`）；没有则把「人工确认」写进流程 |
| 许可与再分发未确认 | 可能不能随产品分发 | **需你确认**：我们是要做内部工具还是对外分发 |
| Creation API 仍是 v1 | 后续可能变 | pin 版本 + P4 升级演练 + `ui.version` 分支 |

---

## 8. 需要你拍板的三件事

1. **产品形态**：我们是在它之上做「内部增强层」，还是要做成对外的产品？
   （影响许可、是否允许 pin + 分发它的安装包）
2. **优先级**：P0 契约摸底优先，还是先做某个具体能力（比如四态验证面板）？
   建议 **P0 优先** —— 它是唯一能防止后面大面积返工的一步。
3. **会话归属**：我们的 agent 会话是走它原生的会话页（`ui.control`），
   还是我们要自己的会话界面？（前者零返工，后者要重造消息流）

---

## 9. 本文之后的第一步

只做 P0，产出两样东西：

- `prototype/agent-ui/creation/openbitfun-creation.js`（最小 activate）
- `research/OpenBitFun契约摸底.md`（`inspect()` 的完整输出 + capability 清单）

拿到这两样，P1 的方案才能定死。
