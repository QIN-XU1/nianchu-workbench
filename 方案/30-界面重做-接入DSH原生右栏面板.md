# 30 · 界面重做：接入 DSH 原生右栏面板（修正 v1/v2 的根本错误）

> 用户批评："你这样的界面设计根本就不实用，完全不如 luanyujia-workbench"
>
> **这个批评是对的。** 本文记录我错在哪、查到了什么、怎么改的。

---

## 1. 我错在哪（诚实复盘）

### 1.1 v1/v2 做的

把 sea 工作台塞进 `conversation.composer.dock` —— 也就是**对话输入框上方的一行状态条**。

点开展开后，是一个塞在输入区里的小卡片：场景标签、文档预览、能力开关。

### 1.2 为什么这是错的

| 问题 | 后果 |
|---|---|
**位置错**：占的是输入区 | 把对话框硬生生压矮了 —— 用户打字的地方变小 |
**尺度错**：那个 slot 只适合"一条状态" | 装不下文件树 + 预览 + 多标签 |
**概念错**：我把它叫"工作台"，但它只是"状态条 + 折叠卡片" | 名不副实 |
**方向错**：**我在重造 DSH 已有的东西** | 白做 |

### 1.3 luanyujia 的实用性来自哪（重新理解）

它的自我复盘场景是**整块右栏面板**：

```
┌────────────────────────────┬────────┐
│ 预览（md 渲染/图片/视频）    │ 文件库  │
│  占 75% 宽                   │ 25%    │
├──────────────┬─────────────┴────────┤
│ DeepSeek网页版 │ AI 面板              │
└──────────────┴──────────────────────┘
```

**关键差别**：
- 它占**整块区域**，不是塞在输入框上方
- 它**可停靠、可全屏、可分割**
- 它**不挤压对话框**

我做的那个，连这个形态的 1/10 都不到。

---

## 2. 查到的真相：DSH 本来就有这套系统

### 2.1 通过官方 slot 目录发现

我从 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（316KB，生成的穷举契约）里查到 **112 个 slot**，其中有一个完整的**右栏面板系统**：

```
sidebar.right.pane.tab           ← 面板体（keyed）
sidebar.right.pane.tab.title     ← 面板标题
sidebar.right.tab.document       ← 文档预览
sidebar.right.tab.files          ← 文件树
sidebar.right.tab.guide          ← 引导页
sidebar.right.tab.menu.item      ← 面板菜单项
rightbar / rightbar.session      ← 右列容器
```

### 2.2 现成的面板类型（shipped）

`sidebar.right.pane.tab` 当前的占位者（即已内置的实现）：

```
client-ui-deliverables     ReviewTab
client-ui-plan             PlanPreview
client-ui-schedule         ScheduleTaskTab
client-ui-sidebar-browser  BrowserBody        ← 浏览器
client-ui-sidebar-documentpreview TextPreview ← 文档预览
client-ui-sidebar-files    FilesBody          ← 文件树
client-ui-sidebar-right    GuideBody          ← 引导页
client-ui-sidebar-terminal LazyTerminalBody   ← 终端
client-ui-subagent         SidebarChatTab     ← 子代理会话
```

**这意味着**：
- luanyujia 在 Electron 里重造的文件树、预览、终端 —— **DSH 的 Web GUI 本来就有**
- 我上次写方案说"工作台要做成 DSH Client 插件"，方向对，但**落点错**（选了 composer.dock 而不是 sidebar.right.pane.tab）

### 2.3 正确的接入方式（官方文档原文）

从 `ui-sidebar-right/README.md` 的 "Extension seats"：

> A tab type registers in **two stages**...
> 1. **The type** — `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`
> 2. **The body** — `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)`
> Both stages sit inside the type's own `ctx.effect`.

打开方式：
```
ctx.sidebarRight.openTab(kind, options?)
ctx.sidebarRight.openResource(address, options?)
```

---

## 3. 修正做了什么

### 3.1 删除错误的部分

- ❌ 移除 `conversation.composer.dock` 注册（状态条）
- ❌ 移除 Host 侧的 `inject: ['slots','sidebarRightTabs','sidebarRight']`

### 3.2 新增的正确部分

**Host（index.js）**：
- `inject: ['webServer']`（只注入 Host 服务）
- 保留 13 个 HTTP 数据端点（面板体通过 fetch 取数据）

**Client（client.js）**：
```js
apply(ctx) {
  const TAB_ID = '@local/sea-workbench/workbench';
  const TAB_KIND = 'sea-workbench';

  // ① 声明 tab 类型
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => 'sea 工作台',
    keepMounted: true,
  }), 'sea-workbench tab type');

  // ② 面板体
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    SeaWorkbenchPanel,
  ));

  // ③ 标题
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
    () => React.createElement('span', { style: { fontSize: 12 } }, 'sea 工作台'),
  ));
}
```

### 3.3 面板形态（对齐 luanyujia）

```
┌─ sea 工作台 ────────────────────────────────────┐
│ ● 现在没事  门禁 24/24  认证 6/6  资产0         ⟳ │
├─────────────────────────────────────────────────┤
│ [总览] [档案] [注入] [外挂]                      │
├─────────────────────────────────────────────────┤
│ 档案视图：                                        │
│ ┌──────────┬──────────────────────────────────┐ │
│ │ 方案文档  │  # 28-自我复盘档案界面            │ │
│ │ 研究材料  │  ## 1. 实现                      │ │
│ │ 场景文档  │  - 并排双窗…                     │ │
│ │ 插件源码  │                                  │ │
│ │ README.md │                                  │ │
│ │ 28-…md    │                                  │ │
│ └──────────┴──────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**四个视图**（在真正的右栏面板里）：
| 视图 | 内容 |
|---|---|
总览 | 场景卡片（六件套/会话绑定/保护的不变量）+ 板统计 |
档案 | **左文件树 + 右 Markdown 预览**（对齐 luanyujia 的核心搭配） |
注入 | 五通道注入账本 |
外挂 | 能力开关（可点击，带滑动开关样式） |

---

## 4. 一个必须记录的坑

### 4.1 第一次安装失败

```
sea-workbench (@local/sea-workbench):
  pending (waiting for services: slots, sidebarRightTabs, sidebarRight)
```

**原因**：我把 `slots` / `sidebarRightTabs` / `sidebarRight` 写进 **Host 的 inject**，
但它们是 **Client 侧服务**，Host 永远等不到。

**修法**：
- Host 只 `inject: ['webServer']`
- tab 注册全部移到 client.js 的 `apply` 里（Client 有这些服务）

### 4.2 修正后

```
application: "applied"
```

**这印证了一条 DSH 的规则**：Host 与 Client 的服务边界是硬的，写错位置不会报"找不到"，
而是在装配阶段永远 pending。

---

## 5. 这次修正的意义

| 项 | 之前 | 现在 |
|---|---|---|
落点 | 输入框上方一行 | **右栏整块面板** |
能力 | 状态条 + 折叠卡片 | **可停靠、可全屏、可分割的 tab** |
是否挤压对话 | ✅ 是（占了输入区） | ❌ 否（在右列） |
是否重造轮子 | ✅ 是（无视 DSH 已有面板系统） | ❌ 否（接入原生系统） |
与 luanyujia 可比性 | 不具可比性 | **同一形态**（文件树+预览+多标签） |

---

## 6. 诚实的现状

### 6.1 已验证

- ✅ 插件 `application: applied`（tab 类型注册成功，不再 pending）
- ✅ 13 个 HTTP 数据端点全部 200
- ✅ 所有自检仍通过（18/18 新能力、13/13 好用）

### 6.2 未验证

- ❓ **面板在界面上是否真的显示** —— 需要你刷新页面，点右栏的「+」看有没有 "sea 工作台"
- ❓ `ctx.sidebarRightTabs.register` 的参数是否被接受（比如 `title` 是不是函数、`keepMounted` 是否支持）—— 我只能保证不报错，不能保证语义正确
- ❓ 面板是否能在窄屏/浮动模式下正常布局

### 6.3 我做不到的

- **不能替你点开界面确认**：本会话没有 Client Inspect Provider，也没有浏览器控制能力（`browser-skill` 的 bsk_* 工具未在本次会话可用）

---

## 7. 下一步

按你的批评，正确的做法是：

| 优先 | 做什么 |
|---|---|
1 | **你刷新页面，确认右栏里出现「sea 工作台」，且档案视图是左树右预览** |
2 | 如果布局仍不像 luanyujia，告诉我具体差在哪（是宽度？是可分割？是缺面板？） |
3 | 讨论是否要接入现成的 `client-ui-sidebar-files FilesBody`（DSH 自带文件树），而不是我自己写一个 |

**第 3 点很关键**：DSH 自带 `FilesBody`（文件树）和 `TextPreview`（文本预览）。
如果它们已经够用，我应该**复用**而不是自写。这需要看它们的 standard props 才知道能不能喂给它们自定义数据源。

---

## 8. 一句话

> **我把工作台塞进输入框上方，是位置、尺度、概念三重错误 —— 用户批评准确。**
> **DSH 本来就有完整的右栏面板系统（含文件树/预览/终端/浏览器），luanyujia 在 Electron 里重造的东西，这里本来就是现成的。**
> **现在改成注册原生 tab，形态终于和 luanyujia 可比。但"界面上真的显示"这一环，仍需你确认。**
