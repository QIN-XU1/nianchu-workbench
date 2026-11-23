# 记忆神经元 · DSH 插件

在 DeepSeek Harness 左侧图标列表（「新建对话 / 搜索 / 插件 / 自动化任务」那一列）里增加一个入口，
打开后是一个**场景运营驾驶舱**：依赖星图 + 六件套完整度 + 健康度 + 派单 + 进化 + 待办。

---

## 一、入口位置

```
┌─────────────────────────────────────────┐
│  + 新建对话                             │
│  🔍 搜索                                │
│  🧩 插件                                │
│  ⏱ 自动化任务                           │
│  ✦ 记忆神经元   ← 新增（order: 20）     │
│  ⋯ 更多                                 │
└─────────────────────────────────────────┘
         ↓ 点击
┌──────────────────────────────────────────────────┐
│ 记忆神经元  9 个场景 · 20 条依赖  [搜索…] [刷新] │
├──────────────────────────────────────────────────┤
│ 场景 9 │ 依赖边 20 │ 契约覆盖 9/9 │ 六件套 35/36 │
├──────────────────────────────────────────────────┤
│ 运营                                              │
│ ┌ 健康度 7天 ────┐ ┌ 派单台账 4 ────────────┐   │
│ │ 有数据 0/2     │ │ 总数 4      4 已闭环    │   │
│ │ 待采样 2       │ │ hub→build-plan closed   │   │
│ └────────────────┘ └─────────────────────────┘   │
│ ┌ 进化台账 1 ────┐ ┌ 待办 27 ───────────────┐   │
│ │ 累计 1 观察中  │ │ · 机制体检失败：越界哨兵│   │
│ └────────────────┘ └─────────────────────────┘   │
├──────────────────────────────────────────────────┤
│ 依赖星图              —— 数据流   --- 间接依赖    │
│                                                   │
│   调研   ──┬─→ 竞品拆解 ──→ 架构梳理 ──→ 实施计划 │
│            ├─→ 逆向分析 ──→                       │
│   故障分析 ─┘                                     │
│   本地电脑 ──→ 中枢                               │
│   自我复盘 ──→                                    │
├──────────────────────────────────────────────────┤
│ 场景 9                                            │
│ ┌ 中枢 hub ──────┐ ┌ 架构梳理 ─────┐             │
│ │ 总控中枢：唯一  │ │ 汇总裁判：把  │             │
│ │ ✓契约 ✓身份 ✓记忆 ·技能 1面板 │                │
│ └────────────────┘ └───────────────┘             │
└──────────────────────────────────────────────────┘
```

---

## 二、五项能力

| 能力 | 说明 |
|---|---|
**依赖星图** | 分层布局（Kahn 最长路径 + 一维力松弛 + 重心排序），交叉数 0 |
**六件套追踪** | 契约 / 身份卡 / 私有记忆 / 专属技能 / 专属面板，逐场景打勾 |
**健康度** | 7 天窗口的 有数据 / 正常 / 警告 / 异常 / 待采样 |
**派单 + 进化** | 真实台账，显示状态与观察期 |
**搜索 + 详情** | 按名称/ID/角色过滤；点击卡片展开输入依赖与输出流向 |

---

## 三、数据来源（全部真实文件，不编造）

```
workbench/
├── 外壳/scenarios/*.json                场景配置（面板清单）
├── sceneboard/scenes/*.json             场景契约（role/inputs/outputs/schema）
└── 引擎数据/.dsh/
    ├── 场景记忆/
    │   ├── _共享记忆/*.json             健康度/派单/进化/场地地图/记忆地图/基线
    │   ├── _共享记忆/_待办.md
    │   └── <中文场景名>/                 身份卡 + 场景私有记忆 + 快照
    └── skills/<技能名>/SKILL.md
```

Host 侧从 `process.cwd()` 与插件目录逐级往上找含 `workbench/外壳/scenarios` 的项目根。
**任何一项读不到就返回空，绝不编造。**

当前真实数据：9 场景 / 20 边（10 flow + 10 indirect）/ 7 类台账 / 9 技能。

---

## 四、API 依据（源码级实测，非猜测）

这份插件的每个 API 都来自本机 DSH 0.2.2-rc.1 的源码，不是凭记忆写的。

### 4.1 dsh.client 只有 4 个字段

唯一校验器 `dsh-client-modules/lib/client.js:61-75`：

| 字段 | 说明 |
|---|---|
`platform` | **必填，唯一值 `"web"`**；不写则包根本不进 boot graph（`lib/index.js:790`） |
`immediately` | 只影响预取；全 88 个 client 包只有 11 个基础设施设了 true，业务插件不要设 |
`inject` | 值是包名；写错**静默忽略** |
`external` | 只登记非 baseline 模块。**primitives 已在 seed 表，不需要写** |

### 4.2 require 白名单 11 项

来自 shell bundle 的 `PLATFORM_MODULES`（`index-BgUyXZcc.js:196`）：

```js
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, zod, @tanstack/react-virtual,
@deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives, @deepseek-ai/dsh-client-ui-dockkit
```

`factory(require)` 只收到 `require` / `require.asset` / `require.async`（`client.js:819`）。

### 4.3 slot 注册

```js
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register({ name: 'sidebar.panellist', id: 'memory-neuron', order: 20, label: '记忆神经元' }, Icon));
ctx.slots.inject('main', () =>
  ctx.slots.register({ name: 'main', key: 'memory-neuron' }, Panel));
```

**`sidebar.panellist.id` 必须 === `main.key`**（硬约束）。
链路：PanelRow → `selectPanel(id)` → MainPanel 用 `entryKey: panelId` 派发 → `selectPanel` 校验 `hasMainPanel`，否则抛
`layout.selectPanel: main panel "x" is not registered`。

回调形态三种语义：

| 形态 | 语义 |
|---|---|
`() => register(...)` | 1 个 disposer（本插件用这个） |
`function* () { yield r1; yield r2; }` | 多项合成一个事务，各自收集、逆序释放 |
`() => { ... }` 无 return | **危险**：不 collect，声明折叠时成孤儿 |

### 4.4 样式

**组件内渲染 `<style>` React 元素**（规范 `references/ui-plugin.md` 推荐）。

- × 不用 `styles.insert` —— 它是 `cordis-client-runner` 动态包的闭包参数，不在 `factory(require)` 这条 lane 上
- × 不写 `document.head` / `document.body` —— 规范禁止

### 4.5 主题 token

实际存在 **56 个** `--dsw-alias-*`。本插件用 17 个，全部验证存在。

### 4.6 图标

primitives 有 **194 个 `Icon*` + 8 个 `PermissionIcon*`**。
`IconWorkspaceTreeOutlineRegular` 存在；`IconFocusOutlineRegular` 不存在。

⚠️ 图标 sprite 由 `dsh-client-ui-theme` 注入（`document.body > svg[data-dsh-icon-sprite]`）。
若图标空白先查 sprite；本插件用自绘 SVG，不依赖 sprite。

---

## 五、布局约束（实测）

注入式诊断条读到的真实 DOM：

```json
{
  "rootW": 1002, "rootX": 280,
  "parentTag": "DIV.", "parentW": 0,
  "parentDisplay": "contents",   ← 关键
  "bodyScrollW": 1282, "winW": 1282, "dpr": 1.25
}
```

宿主源码：

```css
mainPanel { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0 }
[data-global-panel] { padding-top: max(0, 48px - var(--dsh-frame-top-clearance)) }
```

结论（四条，全部踩过坑）：

1. 根容器用**纯 `flex:1 1 auto` + `min-width/height:0`**
2. **不要同时设 `width:100%`** —— 在 flex 容器里两者打架，width 按父内容宽度算，容易溢出
3. **全子树 `box-sizing:border-box`** —— 溢出最常见的原因
4. 概览卡用 **flex-wrap 而非 auto-fit grid** —— grid 的 auto-fit 在测量有偏差时会溢出

---

## 六、星图算法

**分层布局**（不是力导向）。

为什么：同一份数据实测对照——

| 布局 | 边长 min/中位/max | 交叉数 |
|---|---|---|
分层 | 235/238/705 | **0** |
二维力导向 | 108/122/142 | 无法避免 |

力导向把 9 个节点收成边长 122px 的团，`调研→竞品→架构→实施` 主干全看不出。
黄金角螺线更糟——只保证不重叠，不保证位置有意义，换个排序就换位置（这是"看起来在乱动"的根源）。

**做法**：
- x = Kahn 最长路径分层（4 列，间距 `clamp(usableW/maxLayer, 150, 235)`，不铺满否则长边拉成 705px 横线）
- y = 一维力松弛（同列排斥 62px + flow 边吸引 + 向中线收拢，240 次迭代，线性退火必然收敛）
- 列内**重心法**（Sugiyama 第 2 步），交叉数 3→0
- 边默认直线，只在跨 ≥2 层且穿节点时才加弧度
- 箭头 7×7 开口 V 形 + `markerUnits="userSpaceOnUse"`；多边射向同节点时按到达角扇开
- 节点尺寸 `5.5+8*t`（2.45× 区间，√ 归一化）；**默认不显示环**（常驻环是最大丑源）
- 单色 + 线型编码（不用多色相，否则 9 节点 × 4 边 = 13 色相变调色盘）
- 标签避让：不穿边、不重叠

**验证**（星图实验室实测）：
960/800/720/680 四种宽度全部 0 处标签被边穿过，11/11 边不穿节点，6 种尺寸无重叠无越界，
空/单节点/环/自环全部不崩不 NaN，三次布局逐位相同。

---

## 七、隔离测试

```bash
node prototype/run-all-tests.mjs plugins/memory-neuron
```

**65 项**：

**Host 侧 30 项**
- 严格 ctx Proxy（访问不存在的属性立即报错）
- `inject` 回调的 `injected` 派生 ctx 建模
- **真实调用路由 handler**，断言返回 200 + `scenes=9 edges=20`
- manifest / files / token / DOM / require 校验

**Client 侧 35 项**
- 模拟浏览器环境 + 极简 React 替身
- **真实执行 factory → apply(ctx)**，断言 2 个 slot + `id === key`
- **真实渲染三个分支**（loading / ready / error）
- ready 态断言：`.mn-stat` / `.mn-graph-wrap` / `.mn-card` / `<svg>` 存在
- **星图真实绘制**：12 个 circle + 5 个 path

---

## 八、安装

```bash
plugin_manager install_bundle → <此目录绝对路径>
```

安装后 `application: applied` 表示配置已落盘。**若 Harness 进程在安装前就已启动，需要重启才能加载新的 Host 模块。**

---

## 九、已知限制

| 项 | 现状 |
|---|---|
详情抽屉 / 搜索 / 悬停联动 | 已实现，未做交互截图验证 |
浅色主题 | 已用 token，未做视觉验证 |
窄窗口 <700px | 星图已验证 680px 不崩，整面板未验证 |
技能内容 | 只显示有无，未展示 SKILL.md 正文 |
派单列表 | 只显示最近 3 条，未做分页 |

---

## 十、修改须知

⚠️ **改含中文的源文件请用 edit/write 工具，不要用 PowerShell `Get-Content | Set-Content`** ——
GBK/UTF8 往返会把中文注释变成乱码。
⚠️ `.ps1` 脚本必须存成 UTF-8 with BOM，否则 PowerShell 5.1 把中文当 ANSI 导致引号配对错误。
