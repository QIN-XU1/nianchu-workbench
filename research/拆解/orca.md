# orca 界面拆解

> 源码：`D:\refs\orca`（37169 文件 / 253MB / TypeScript）
> 版本：`package.json:3` = `1.4.214`
> 只读分析。所有数字由 `rg` / 文件统计自行数出。读不到处标「推测」。

---

## 0. 技术栈（先摸清）

| 层 | 选型 | 证据 |
|---|---|---|
| 壳 | Electron 43.8.7 | `package.json` devDependencies `electron: 43.8.7`；`"main": "./out/main/index.js"`（`package.json:11`） |
| UI 框架 | React 19.2.8 | `react: ~19.2.8`、`react-dom: ~19.2.8`（devDependencies） |
| 构建 | electron-vite 8.3.6 | `electron.vite.config.ts`；`vite: ^8.3.6` |
| 样式 | Tailwind CSS **v4** + shadcn（new-york-v4） | `components.json:3` `"style": "new-york-v4"`；`tailwind: ^4.3.5`；`main.css:1` `@import 'tailwindcss'` |
| 状态 | Zustand 5.1.0 | `zustand: ^5.1.0`；`AppWorkspaceShell.tsx:4` `@/store/index` |
| 图标 | lucide-react 0.577.0 | `lucide-react: ^0.577.0` |
| 终端 / 编辑器 | @xterm/xterm 6.1.0-beta.336 / monaco-editor 0.55.1 | devDependencies |
| 提示 / 弹层 | sonner 2.0.7、@dnd-kit/core、@floating-ui/dom | devDependencies |
| i18n | i18next 26.7.2，**11 个 locale** | `src/renderer/src/i18n/locales/` = de, en, es, fr, ja, ko, pt, ru, tr, zh, zh-Hant |
| 渲染层规模 | **11521** 个 ts/tsx | `Get-ChildItem src/renderer -Recurse -Include *.tsx,*.ts` 计数 |

- **结论**：Electron + React 19 + Tailwind v4 + shadcn 的现代 Web 栈，不是自研渲染。
  - 证据：`components.json:1-20`、`main.css:1`、`package.json` devDependencies。
  - 判断：意味着「界面能力上限 = 浏览器能力 + Tailwind 表达力」，成本低、可维护；代价是 Tailwind class 直接铺进 11521 个文件，样式与结构没有中间层隔离（见缺点 1/2）。

**一句话定位**：一个面向「并行 agent 开发」的下一代 IDE —— 用终端/工作区多开为主界面，把多个 AI agent 会话、worktree、浏览器、编辑器并排塞进同一窗口的调度台（`package.json:4` 自述 "Next-gen IDE for parallel agentic development"）。

---

## 1. 布局骨架

### 结论：三栏 + 顶栏 + 状态栏，**纯 flex 嵌套**，无布局库

```
Window
└ div.flex.flex-row.flex-1.min-h-0.overflow-hidden        AppWorkspaceShell.tsx:147
  ├ div.flex.flex-col.flex-1                               :149
  │ ├ div.titlebar                                         :152   ← 全局顶栏
  │ └ div.flex.flex-row.flex-1.min-h-0                     :157
  │   ├ 左栏 工作区侧栏（可折叠为 w-0）                     :158-188
  │   │ ├ div.titlebar-left                                :166   ← 左侧栏自己的头
  │   │ └ WorktreeSidebar > Sidebar                        :182 / :70
  │   └ div.flex.flex-col.flex-1.min-w-0                   :189   ← 中央工作台
  │     ├ div.titlebar（条件渲染）                          :194
  │     └ div.relative.flex.flex-1                         :196
  │       ├ TerminalWorkbenchContainer > Terminal          :214-229  ← 主视图（常驻不卸载）
  │       ├ ActivePage（9 个页面互斥）                      :242
  │       └ FloatingTerminalToggleButton                   :247
  ├ RightSidebar                                           import :9
  └ StatusBar                                              status-bar/StatusBar.tsx:30
```

- 证据：`src/renderer/src/app-shell/AppWorkspaceShell.tsx:147-254`（整段 shell 结构，未出现 grid）。
- 左侧栏折叠技巧：折叠时 `relative w-0 overflow-visible`，子元素浮起但仍可点，不占 flex 宽度（`AppWorkspaceShell.tsx:161-163`）。
- **判断**：三栏（左工作区列表 / 中终端+编辑器+tabs / 右详情栏）+ 顶栏 + 底状态栏，是 IDE 的经典骨架。手写 `flex` 而不是 grid，是为了让「终端 viewport 精确填充剩余高度」——`min-h-0` / `min-w-0` 出现密集，正是为了避免 flex 子项被内容撑破导致 xterm/Monaco 测量尺寸错误（`AppWorkspaceShell.tsx:147,157,181,189,196,212`）。

### 布局技术实测

| 指标 | 数值 | 证据 |
|---|---|---|
| `react-resizable-panels` 导入 | **0** | `rg "react-resizable-panels" -g *.tsx src/renderer` |
| `allotment` 导入 | **0** | 同上 |
| `grid-cols-*` 使用 | **251** | `rg -o '\bgrid-cols-' -g *.tsx src/renderer` |
| 外层主分栏 | flex-row | `AppWorkspaceShell.tsx:147` |

- **判断**：主分栏是自研 flex + 自绘分割条，不是第三方 split pane 库。自绘分割条的颜色被单独提为 token 并附了对比度理由：`--split-divider: #868690`，注释写明「Split dividers must clear 3:1 against --card even before hover; --border is too faint」（`main.css:323-325`）。这说明分割条可见性是踩过坑后修过的。

---

## 2. 导航层级

### 结论：**顶栏（左控制组 + 主条）+ 左侧工作区侧栏 + 标签组 + 底状态栏 + 命令面板**，五处各有分工

| 层级 | 承载什么 | 证据 |
|---|---|---|
| 顶栏左控制组 | 窗口/后退前进/侧栏开关等窗口级控制 | `app-shell/TitlebarLeftControls.tsx`（6086B）；`AppWorkspaceShell.tsx:121,153` |
| 顶栏主条 | 当前视图身份 + 主操作 | `app-shell/TitlebarMainStrip.tsx`（3155B）；`:122,154` |
| 左侧栏 | 工作区（worktree）/ 仓库列表，虚拟滚动 | `AppWorkspaceShell.tsx:182`；`Sidebar` 接 `VirtualizedScrollAnchor`（`:13,39-42`） |
| 标签组 | 终端 / 浏览器 / 编辑器 / agent 会话 tabs，支持分组 | `components/tab-group/`、`components/tab-bar/`（含 `BrowserTab.tsx`、`ClientHostedBrowserTab.tsx`、`CliChatResumeMenuItems.tsx`） |
| 底部状态栏 | provider 账号、用量、端口、SSH、资源占用等 | `components/status-bar/StatusBar.tsx:30` 导出 10 个 `StatusBar*` 组件 |
| 命令面板 | cmd-j / 跳转调色板 / 工作区跳转 | `components/cmd-j/`、`components/worktree-jump/`、`main.css:1625` `.jump-palette-item` |

### 项数（可数）

- **页面级视图 9 个**：`settings` / `skills` / `artifacts` / `tasks` / `automations` / `activity` / `space` / `mobile` / `terminal`
  - 证据：`AppWorkspaceShell.tsx:94-110` 的 `activeView === '...'` 分支；`rg -o "activeView === '[a-z]+'"` 去重得 9 个。
- **状态栏段 10 个**：`StatusBar.tsx:4-28` 导出 Claude/Codex 账号切换、Provider、Usage、Ports、SSH、Plugins、Pet、Update、Resource 等（`rg '\bStatusBar[A-Z][A-Za-z]*'` 去重 = 10；status-bar 目录共 **196** 处 `Segment` 标识）。
- **components 子目录 ≈110 个**：`Get-ChildItem src/renderer/src/components -Directory` 列举得 activity/agent/artifacts/automations/browser-pane/cmd-j/dashboard/editor/… 直到 wsl-move。
- **判断**：导航是「工作区为中心」（左侧栏）而不是「功能为中心」（顶部菜单）。这是对的：目标用户 80% 时间在同一个 worktree 里反复切 agent 会话，功能页（settings/skills/stats）是低频道访问，所以被压进 `activeView` 互斥页而不是并列导航项。

---

## 3. 信息密度

### 结论：**高密度、终端原生型**，留白靠 4px 基数与细边框，不靠大区块间距

| 证据 | 数值 | 含义 |
|---|---|---|
| `--text-3xs: 0.625rem` | **10px 是注册在册的一等字号** | `main.css:50` |
| `--text-2xs: 0.6875rem` | 11px | `main.css:48` |
| `text-[Npx]` 任意值 | **1766** 处 | 见第 7 节 |
| 状态栏段 | 10 个并列 | `StatusBar.tsx:4-28` |
| 单标签内动作 | 多（浏览器 tab、CLI 会话续聊菜单等） | `tab-bar/BrowserTab.tsx`、`ClientHostedBrowserTabRows.tsx`、`CliChatResumeMenuItems.tsx` |

- **一屏可操作元素（估算，标「推测」）**：以主视图为例 ≈ 顶栏 2 组（约 6-10 个按钮）+ 标签条 1 排（假设 4-8 个 tab，每 tab 2-3 个动作）+ 左侧栏可视行（虚拟滚动，约 15-25 行 × 每行 2-3 动作）+ 状态栏 10 段 + 主视图内工具条。合计 **60–120 个可点目标**。
  - 依据：上述组件文件与 10 段状态栏；无截图实测，故标「推测」。
  - 判断：这是「专业工具」密度（对标 VS Code / JetBrains），不是消费级产品密度。10px 字号能在 13 寸 1080p 上塞下更多信息，代价见缺点 3。
- **留白比例（推测）**：不靠大留白，靠 `border` 1px + `--radius: 0.625rem` 的圆角块区分区域。侧栏与主区之间用 seam/分割条（`main.css:1150` `.workspace-sidebar-seam`、`:323-325` split divider），属「结构化留白」而非「呼吸感留白」。

---

## 4. 状态呈现

| 状态 | 做法 | 证据 |
|---|---|---|
| **loading** | ① 代码分割 `lazy()` + `Suspense fallback={null}`，不显示占位骨架；② `lazy-with-retry` 自动重试 chunk 加载 | `AppWorkspaceShell.tsx:2` `lazyWithRetry`；`:22-37`（11 个 lazy 页面）；`:215,231` `fallback={null}`；`:231` 外层 Suspense |
| **error** | 每个「面」一个独立 error boundary，带 `boundaryId` + 业务文案 + 重试 | `:53-69`（`sidebar.worktrees`，文案「活动工作区仍开着，可重试列表或切换视图」）、`:137-146`（`app.workspace-shell`）、`:216-224`（`terminal.workbench`，文案点名 Terminal/browser/editor 渲染失败）、`:232-241`（`page.${activeView}`） |
| **progress** | 语义色 + 关键帧动画：working 黄 / question 橙 / unread 蓝 / PR 状态三色 | `main.css:267` `--agent-working: var(--color-yellow-500)`；`:265` `--agent-question`；`:274` `--unread`（注释「蓝色，永不被读作状态色」）；`:276-278` `--workspace-status-done/review/progress` |
| **spinner** | 用 CSS `steps()` 做逐帧旋转，不用 JS 驱动 | `main.css:2044` `@keyframes agent-spinner-rotate`；实测参数 `animation: agent-spinner-rotate 86400s steps(1036800, end) infinite`（= 12 帧/秒的离散步进） |
| **cost / 用量** | 状态栏段 + 独立统计页 | `status-bar/StatusBarProviderSegment.tsx`、`InlineProviderUsage.tsx`、`usage-percentage-label.ts`、`UsageRosterPanel.tsx`；`components/stats/{Claude,Codex,Muse,OpenCode}UsagePane.tsx`、`*UsageDailyChart.tsx`、`ShareUsageCard.tsx` |
| **空态** | 有专门 CTA 组件 | `status-bar/StatusBarUsageEmptyCta.tsx` |
| **通知 / toast** | sonner 2.0.7 | devDependencies `sonner: 2.0.7`；`AppNotificationCards.tsx:1-40` |

- **判断**：error 处理是本项目最值得抄的一处 —— 边界粒度 = 面板粒度，且文案区分「活动工作区是否还活着」。理由见优势 3。
- loading 全部 `fallback={null}`（无骨架屏），是刻意的：IDE 里弹出骨架灰块比什么都不显示更打断注意力；代价是首帧可能空白，靠 `lazyWithRetry` 与启动 hydration 兜底（`app-shell/use-app-startup-hydration.ts`，17KB）。

---

## 5. 颜色体系

### 结论：**有完整语义 token 体系并被 lint 强制，但字面量仍未绝迹**

#### 5.1 字面量计数（`rg` 实测，范围 `src/`，`*.{ts,tsx,css}`）

| 模式 | 出现次数 |
|---|---|
| `#[0-9a-fA-F]{3,8}` | **3994** |
| `rgba\(` | **236** |
| `rgb\(` | **125** |
| `oklch\(` | **9** |
| `hsl\(` | **1** |
| **合计** | **4365** |

拆到具体层：

| 范围 | hex 次数 |
|---|---|
| `src/renderer/**/*.tsx` | **257**（分布在 **101** 个文件） |
| `src/renderer/src/assets/main.css`（唯一的调色板文件） | **186** |
| `docs/site/src/app/globals.css`（官网，非产品界面） | 51 |

- 证据：`rg -o --no-filename -e '#[0-9a-fA-F]{3,8}\b' -g '*.tsx' src\renderer` = 257；`rg -l` = 101 文件。
- **判断**：颜色治理是「收敛但未完成」。产品 UI 的 chrome 基本走 token，而 257 处 tsx hex 主要落在终端主题目录、git graph、编辑器配色等「数据即颜色」的场景（推测：`src/main/warp-themes/`、`src/shared/terminal-themes/`、`--git-graph-*` 系列都是 hex 直写）。这些是**合理例外**，但也是 lint 白名单必须持续维护的负担。

#### 5.2 token 定义在哪、多少个

| 指标 | 数量 | 证据 |
|---|---|---|
| 调色板唯一真源 | 1 个文件 | `src/renderer/src/assets/main.css`（**3626** 行 / 125KB） |
| `--color-*`（Tailwind 主题暴露层，`@theme inline`） | **112** | `rg -e '--color-[a-z0-9-]+:' main.css` = 112 |
| main.css 内全部 CSS 变量定义 | **545** | `rg -e '^\s+--[a-z][a-z0-9-]*:' main.css` = 545 |
| `var(--...)` 引用次数 | **740** | `rg -e 'var\(--' main.css` = 740 |
| 浅色调色板块 | `:root` @ 199 行 | `main.css:199-330` |
| 深色调色板块 | `.dark` @ 332 行 | `main.css:332-...` |

- **结论**：**是 token，不是散落色值**——112 个语义色 + 545 个变量构成四层结构：
  1. Tailwind 原始色（`--color-blue-600`、`--color-violet-500`、`--color-yellow-500`）
  2. 语义层（`--background` / `--card` / `--popover` / `--muted` / `--border` / `--ring` / `--sidebar-*` / `--worktree-sidebar-*`）
  3. 状态层（`--agent-working` / `--agent-question` / `--unread` / `--workspace-status-*` / `--git-graph-lane-1..5`）
  4. 透明层（`--floating-surface: rgba(255,255,255,0.82)` 玻璃拟态、`--dialog-surface: color-mix(in srgb, var(--background) 96%, transparent)`）
  - 证据：`main.css:199-330`（浅色）、`:332-...`（深色）、`:262-283`（状态色）、`:248-250`（玻璃层）。
- 亮点：透明/混色用 `color-mix()` 而不是新 hex，`--tab-inactive: color-mix(in srgb, var(--foreground) 4%, ...)`（`main.css:329`），保证深浅色自动一致。
- 亮点：chat 面板用**混合比例变量**而非独立颜色（`--chat-canvas-mix` / `--chat-foreground-mix` / `--chat-code-mix` 等，`main.css:228-242` 浅色、`:355-369` 深色），一套变量派生整个聊天配色。

#### 5.3 设计语言

- 证据：`docs/STYLEGUIDE.md:5` —— 「The identity is **monochrome and quiet**: neutral grays carry the chrome, color is reserved for state」。
- 判断：单色 chrome + 状态才用色。这与 token 分布吻合：`--background/#fff`、`--card/#fff`、`--muted/#f5f5f5`、`--border/#e5e5e5` 全是中性灰阶梯，彩色只出现在状态与 git 装饰。

---

## 6. 字号阶梯

### 结论：**8–9 档，跨度仅 10px–20px（2 倍），极其紧凑**，但任意值泛滥

在 `@theme` 里新增 5 个专用档（`main.css:46-57`）：

| token | 值 | 折合 px |
|---|---|---|
| `--text-3xs` | 0.625rem | **10px** |
| `--text-2xs` | 0.6875rem | **11px** |
| `--text-chat-code` | 0.75rem | 12px |
| `--text-settings-detail` | 0.78125rem | **12.5px** |
| `--text-settings-heading` | 0.9375rem | **15px** |

叠上 Tailwind 默认的 `xs 12 / sm 14 / base 16 / lg 18 / xl 20`，实际阶梯：
**10 → 11 → 12 → 12.5 → 14 → 15 → 16 → 18 → 20（9 档）**，跨度 **2.0×**。

- 证据：`main.css:46-57`（5 个新增档，每档都带 `--line-height`）；`main.css:8-19` 字体族 Geist Variable（100–900 全字重）。
- 实测使用量：
  - 刻度类 `text-(3xs|2xs|xs|sm|base|lg|xl|2xl)` = **3386** 次
  - 任意值 `text-[Npx|rem]` = **1766** 次 → **占排版调用的 52% 不走路 token**
  - renderer css 里 `font-size:` = 161 次
- 证据：`rg -o '\btext-(3xs|2xs|...)' -g '*.tsx' src/renderer` = 3386；`rg -o 'text-\[[0-9.]+(px|rem)\]'` = 1766。
- **判断**：跨度 2 倍而不是常见的 1.25 比例级数（如 12/14/16/20/24）——这是 IDE 的选择：字号只用于「区分层级强弱」，不用于「排版节奏」。代价是大量微调只能靠 `text-[11px]` 硬写，阶梯形同虚设（见缺点 1）。另外 5 个专用档（`settings-detail` / `chat-code`）是把「某一块界面的字号」直接提升为全局 token，属局部需求污染全局命名空间。

---

## 7. 间距体系

### 结论：**基数 4px（Tailwind v4 默认，未覆盖）**，节奏一致但无额外设计

- 证据：`main.css` 全文**没有**覆写 `--spacing`（`rg -e '--spacing' main.css` 只有 1 处*使用*：`main.css:3009` `inset-inline-start: calc(var(--spacing) * 3)`），因此走 Tailwind v4 默认 `--spacing: 0.25rem` = **4px** 基数。
- 实测：`gap|p|px|py|m|mt...-N` 类大量使用（`grid-cols-` 251、其余 padding/gap 类遍布 11521 文件）。
- 变量化的间距只有一处：`calc(var(--spacing) * 3)`（`main.css:3009`）。
- **判断**：4px 基数 + 全用 Tailwind 数字刻度（1=4px, 2=8px, 3=12px, 4=16px），有节奏、零学习成本。但没有「间距语义 token」（如 `--space-panel` / `--space-section`）——间距意图只存在于 class 里，改「面板内边距统一收紧 2px」需要全库替换。

---

## 8. 圆角与阴影

### 结论：圆角 **7 档全部从单一 `--radius` 派生**（很干净）；阴影 **只有 2 个 token**（很薄弱）

#### 圆角（优）

| token | 计算式 | 实际值（`--radius: 0.625rem`=10px） |
|---|---|---|
| `--radius-sm` | `calc(var(--radius) * 0.6)` | 6px |
| `--radius-md` | `* 0.8` | 8px |
| `--radius-lg` | `var(--radius)` | 10px |
| `--radius-xl` | `* 1.4` | 14px |
| `--radius-2xl` | `* 1.8` | 18px |
| `--radius-3xl` | `* 2.2` | 22px |
| `--radius-4xl` | `* 2.6` | 26px |

- 证据：`main.css:184-190`，基准 `--radius: 0.625rem`（`main.css:205`）。使用量：`rounded-*` 类 **1827** 次。
- **判断**：7 档由一个基准乘系数派生，改 `--radius` 一处即可全局缩放圆角风格（插件主题 API 也依赖这点）。这是本项目最干净的一条标尺。7 档偏多——实际 UI 里 6/8/10/14 之外的 18/22/26 大概率只服务少数浮层，属「为将来预留」的成本。

#### 阴影（弱）

| token | 值 | 证据 |
|---|---|---|
| `--shadow-floating` | `0 10px 24px rgb(0 0 0 / 0.18)` | `main.css:182` |
| `--shadow-notice` | `var(--notice-shadow)` | `main.css:183` |

- **仅 2 个**阴影 token（`rg -e '--shadow-[a-z0-9-]*:' main.css` = 2）。
- 但实际使用：`shadow-(2xs|xs|sm|md|lg|xl|2xl|none)` **268** 次 + 任意值 `shadow-[...]` **65** 次。
- 证据：`rg -o '\bshadow-(2xs|xs|...)\b' -g '*.tsx' src/renderer` = 268；`rg -o 'shadow-\['` = 65。
- **判断**：阴影是唯一没有体系化的标尺 —— 268+65 处绝大多数直接用 Tailwind 默认阴影，与 `--shadow-floating` 定义的「浮层语言」不一致。层级关系（卡片 / 弹出层 / 对话框 / 通知）没有 token 表达，见缺点 2。

---

## 9. 动画

### 结论：**时长以 150/200/300ms 为主（共 106 次，占 70% 以上）**，缓动以 `ease-out` 为默认，`cubic-bezier(0.16,1,0.3,1)` 作「入场」专用；46 个关键帧全部手写

| 指标 | 实测 | 证据 |
|---|---|---|
| `duration-*` | **132** 次：`150`×44、`200`×32、`300`×30、`100`×7、`500`×7、`700`×4、`0`×3、`2400`×2 | `rg -o 'duration-[0-9]+' -g *.tsx src/renderer \| group` |
| `ease-*` | **84** 次：`ease-out`×63、`ease-[cubic...]`×17、`ease-in`×5 | 同上 |
| `transition-*` 工具类 | **586** 次 | `rg -o '\btransition-(all\|colors\|opacity\|transform\|shadow\|\[)'` |
| `@keyframes`（renderer css） | **46** 个 | `rg -e '@keyframes' -g '*.css' src/renderer` |

- 时长结论：**150ms 是鼠标反馈档，200ms 是展开/折叠档，300ms 是视图切换档**——证据 `main.css:2071-2302` 的 `compact-agent-expansion-reveal 180ms cubic-bezier(0.16, 1, 0.3, 1)`、`settings-shell-enter 180ms ease-out`、`collapsible-down 200ms ease-out`、`collapsible-up 180ms ease-out`。
- 缓动结论：`cubic-bezier(0.16, 1, 0.3, 1)` = expo-out，只用于「内容出现」，因为要瞬间到位、尾巴长，符合 IDE「不让你等」的取向。
- 特殊手法：
  - **动画禁用开关**：`.theme-transition-disabled *` 强制 `transition: none`（`main.css:54-58`），注释说明「主题变量过渡会让调色板切换不同步，但保留 spinner」。
  - **减动效**：`@custom-variant reduce-effects`（`main.css:43-44`），由 `use-reduce-visual-effects` 或 OS「降低透明度」触发；`:1177-1184` 有专门块。
  - **spinner 用 steps 逐帧**：`steps(1036800, end)` 在 86400s 内 = 12 fps 离散旋转（`main.css:2044`），避免 JS 逐帧与合成层抖动。
  - **可选 hover**：`@custom-variant can-hover (@media (hover: hover))`（`main.css:41`），注释「Gate hover hiding behind can-hover so touch controls remain visible」——触屏上不隐藏控件。
- **判断**：动画参数不统一在 token 里（`--animate-*` 定义数 = **0**），而是散在 46 个 keyframes 与 class 里。对 132 处 duration 手写而言，这是可维护性隐患（见缺点 2 的延伸）。

---

## 10. 图标方案

### 结论：**lucide-react 为唯一图标库（≈91% 覆盖），另有 120 个文件自绘 SVG + 1 个 Nerd Font 符号字体**

| 指标 | 数值 | 证据 |
|---|---|---|
| `from 'lucide-react'` 导入 | **1241** 处 / **1236** 个 tsx 文件 | `rg -o "from 'lucide-react'" -g *.tsx src/renderer` |
| 手写 `<svg` | **120** 个 tsx 文件 | `rg -o '<svg\b' -g *.tsx src/renderer` |
| 其他图标库（phosphor / heroicons / radix-icons） | **0** | `rg '@phosphor-icons\|@heroicons\|@radix-ui/react-icons'` |
| `components/icons/` 目录 | 5 个文件（自有图标组件） | `Get-ChildItem components\icons` |
| 符号字体 | `Orca Nerd Font Symbols`，`unicode-range: U+E000-F8FF, U+F0000-FFFFD, U+100000-10FFFD` | `main.css:21-28` |

- **判断**：单一图标库 + 少量自绘（自绘占比 ≈ 120/1236 ≈ 9.7%）。自绘几乎必然是 lucide 没有的「品牌 logo / 产品专属图形 / git 装饰」——这是正确取舍：品牌图形自己画，通用语义图形用库，避免 1000 个图标各自为政。Nerd Font 符号字体专供终端里的 Powerline/Devicons 字形，`unicode-range` 精确限定到私有区，不污染正文（`main.css:21-28`）。
- 代价：lucide 默认 `stroke-width=2` 的 24px 线性图标，在 10–11px 字号旁容易糊；且 1236 个文件各自 import 会让 tree-shaking 与图标风格统一都依赖约定而非强制。

---

## 11. 主题（深浅色）

### 结论：**`.dark` class 挂 DOM + 同名 CSS 变量整套换值**，标准 shadcn v4 方案，但叠了 4 层特例

| 机制 | 证据 |
|---|---|
| 浅色：`:root { ... }` @ 199 行 | `main.css:199-330` |
| 深色：`.dark { ... }` @ 332 行（同名变量整套覆盖） | `main.css:332-...` |
| 深色变体定义（含聊天窗特例） | `main.css:36` `@custom-variant dark (&:is(.dark *:not(:where([data-native-chat-scheme='light'], ...)), [data-native-chat-scheme='dark'], ...))` |
| 运行时判色 | `src/renderer/src/hooks/use-document-dark-theme.ts:8-12`：`settings?.theme ?? 'system'` → `theme === 'system' ? systemPrefersDark : theme === 'dark'` |
| 主题切换时禁过渡 | `main.css:54-58` `.theme-transition-disabled *` |
| 额外主题维度 | `--tab-bar` 由主题设置（`main.css:326-329` 注释「`--tab-bar` is set only by themes; keep in sync with PLUGIN_APP_THEME_CSS_FALLBACKS」）；`--tab-active` / `--tab-inactive` 在浅色下「下陷」非活动 tab |

- 插件主题能力（超出常规）：
  - 主题 token 文档：`docs/reference/plugin-theme-tokens.md`、`docs/reference/plugin-themes.md`
  - 主题产物与回退：`src/shared/plugins/artifacts/plugin-theme-css-fallbacks.ts`、`plugin-theme-background.ts`、`plugin-theme-artifact.ts`
  - 兼容 Warp 主题文件：`src/main/warp-themes/`（`warp-theme-parser-worker.ts`、`theme-file-scanner.ts`、`auto-discovered-theme-files.ts`）
  - 终端主题目录：`src/shared/terminal-themes/terminal-theme-catalog.ts`、`terminal-custom-themes.ts`
  - 与 Claude Code 主题同步：`src/main/claude/theme-sync/claude-code-theme.ts`
- **判断**：深浅色实现是「变量换值」而非「组件分支」——因为 545 个变量里绝大多数在 `.dark` 有对称覆盖，组件只写 `bg-card` 一处。这是唯一能撑住 11521 文件规模的做法。代价是**双写**：新增一个颜色必须在 `:root` 与 `.dark` 各写一遍（`docs/STYLEGUIDE.md:24` 明确要求「A new token goes in `main.css` in both `:root` and `.dark`」），漏一处就出现暗色对比度不足。`main.css:36` 那行为了「聊天可以用与文档不同的配色方案」把 dark 变体写成超长选择器，是这套单 class 方案的复杂度外溢。

---

## 12. 有没有独立设计系统层

### 结论：**有，而且是「文档 + 唯一真源 CSS + shadcn 原语 + lint 强制」四件套 —— 这是本项目最强的一处**

| 组成 | 证据 |
|---|---|
| ① 规范文档 `docs/STYLEGUIDE.md`（70 行）+ 5 篇深潜 | `docs/STYLEGUIDE.md:11-19` 列 `styleguide/color.md`、`components.md`、`native-chat.md`、`ux-rules.md`、`ux-review-rubric.md` |
| ② 唯一真源 token 文件 | `docs/STYLEGUIDE.md:3` 声明「Token values live in `src/renderer/src/assets/main.css` (canonical)」 |
| ③ 组件原语层 | `src/renderer/src/components/ui/`；`docs/STYLEGUIDE.md:23` 「primitives in `src/renderer/src/components/ui/`」 |
| ④ **CI 强制**（关键） | `scripts.lint:design-system`（`package.json`）：`oxlint --config config/oxlint-design-system.json src/renderer` |
| ⑤ 强制规则内容 | `config/oxlint-design-system.json:19-38`：`@shadcn/lint` 三条 error 级规则 —— `shadcn/no-restyle`（allow: layout）、`shadcn/no-raw-colors`（allow: shadow-floating）、`shadcn/require-static-classes` |

- 证据：`config/oxlint-design-system.json:16-38`（`jsPlugins: [{ name: "shadcn", specifier: "@shadcn/lint" }]`，`overrides[0].files: ["**/src/renderer/**/*.tsx"]`）。
- 还有配套的质量闸：`audit:code-quality`、`audit:react-doctor`、`check:react-compiler-compat-ratchet`、`check:memo-translate-subscription-ratchet`、`check:render-path-translate-ratchet`（`package.json` scripts）。
- **判断**：这是「文档说一套、CI 卡一套」的稀缺组合。多数项目的 STYLEGUIDE 是给人看的，写完就腐化；orca 把「禁止裸色值」「禁止重写原语样式」变成 error 级 lint，规则才会在 11521 文件规模下真被执行。`allow: ["layout"]` 的精妙之处：允许用 className 改**布局**，禁止改**外观**——正好划在「原语该管视觉、调用方该管位置」的边界上。

---

## 13. 优势（为什么这样设计是对的）

1. **颜色 token 化 + lint 阻断，形成闭环**
   - 证据：112 个 `--color-*`（`main.css`）+ `shadcn/no-raw-colors: error`（`config/oxlint-design-system.json:30-35`）+ 唯一真源声明（`docs/STYLEGUIDE.md:3`）。
   - 判断：单纯约定会随 PR 数量漂移；把「不许写 hex」提升为 CI 失败项，才能在人手/时间不受控时保住色彩一致性。4365 处字面量里，产品 chrome 仍靠 token 统一，说明规则生效了。**要抄就抄这个闭环，别只抄 token 表。**

2. **圆角 7 档由单一 `--radius` 系数派生**
   - 证据：`main.css:184-190` 全部 `calc(var(--radius) * k)`，基准 `main.css:205`。
   - 判断：圆角是最容易长成「6/7/8/9/10px 各自为政」的标尺。乘系数派生保证任意时刻只有 1 个自由度，换品牌风格时改 1 个数即可；插件主题也能安全覆盖 `--radius` 而不破坏内部比例。

3. **错误边界粒度 = 面板粒度，且文案知道「其它部分还活着」**
   - 证据：`AppWorkspaceShell.tsx:53-69`（sidebar.worktrees：「活动工作区仍开着」）、`:216-224`（terminal.workbench：点名 Terminal/browser/editor）、`:232-241`（`page.${activeView}`）；配套 `RecoverableRenderErrorBoundary` + `lazyWithRetry`（`:2`）。
   - 判断：这个 app 的中央区同时跑 xterm、Monaco、内嵌浏览器三个高崩溃率第三方渲染。若只有顶层 boundary，任一渲染抛错就整个工作区白屏，用户会丢失正在进行的所有 agent 会话。按面板切边界，等于把「一次崩溃的爆炸半径」限制在一个 pane 内——这是多 agent 并行场景下的必要设计，不是可选优化。

4. **状态色语义化并把「颜色冲突」写进注释**
   - 证据：`main.css:264-278` —— 注释「Use one question hue across surfaces, distinct from working-yellow」、「blue so it never reads as a state color」、「Keep PR-state hues stable across theme changes」。
   - 判断：并行多 agent 时，用户靠颜色瞬间判断「哪个在干活、哪个在问我、哪个完成了」。yellow=working、orange=question、blue=unread、三色 PR 状态彼此不撞，是把「颜色即状态机」当契约维护。注释记录理由，使后来者不会为了好看而挪用状态色。

5. **`color-mix()` 做派生而非新增 hex**
   - 证据：`main.css:250` `--dialog-surface: color-mix(in srgb, var(--background) 96%, transparent)`；`:329` `--tab-inactive: color-mix(in srgb, var(--foreground) 4%, ...)`；`docs/STYLEGUIDE.md:25` 明确要求「Need a tint? `color-mix(...)` against an existing token, never a new hex」。
   - 判断：深浅色各写一遍 tint 必然出现「亮色 4% 刚好、暗色 4% 看不见」的问题。用 mix 让透明度随底色自动成立，把双写工作量从「每个 tint」降到「每个基色」。

6. **减动效 / 可选 hover / 主题切换禁过渡，三个无障碍与体验开关都做了**
   - 证据：`main.css:41` `@custom-variant can-hover`、`:43-44` `reduce-effects`、`:54-58` `.theme-transition-disabled`。
   - 判断：IDE 类产品用户常在弱机/远程桌面/触屏上跑，OS 级「降低动效」若被忽略，用户会直接判定「这软件卡」。三角开关成本极低但覆盖面大。

---

## 14. 缺点（什么场景出问题）

1. **字号阶梯形同虚设：52% 的排版调用用任意值**
   - 证据：刻度类 3386 次 vs `text-[Npx]` **1766** 次（`rg -o` 实测，`src/renderer/**/*.tsx`）；9 档阶梯里还塞了 12.5px / 15px 这种非整数档（`main.css:52-55`）。
   - 场景出问题：① 需要「整体字号 +1px」适配高分屏或中文字形时，阶梯一改，1766 处硬写值不动 → 界面立即错位；② 中文本地化时，10px（`--text-3xs`）的汉字在 125% 缩放的 Windows 上会糊成一团，而这类地方恰恰因为写了 `text-[10px]` 无法通过调 token 修复；③ 插件主题只能改颜色，改不了字号，因为字号意图不在 token 里。

2. **阴影/层级没有体系：2 个 token 对 333 处使用**
   - 证据：`--shadow-floating`、`--shadow-notice`（`main.css:182-183`）共 2 个；`shadow-*` 类 268 次 + `shadow-[...]` 任意值 65 次。
   - 场景出问题：① 深色模式下 `0 10px 24px rgba(0,0,0,.18)` 在 `#0a0a0a` 背景上几乎不可见，浮层（菜单/对话框/通知）与底层的层级只能靠 border 区分，密集界面里用户分不清「这是浮层还是内嵌块」；② 想把「通知卡」提到最高层级时，没有 `--shadow-overlay` 这类语义档，只能再写一个任意值，层级关系继续散落；③ 主题作者无法整体调阴影语言。

3. **信息密度过高，一屏 60–120 个可点目标（估算）**
   - 证据：10 个状态栏段（`StatusBar.tsx:4-28`）、9 个并列视图（`AppWorkspaceShell.tsx:94-110`）、每标签多动作（`BrowserTab.tsx` / `ClientHostedBrowserTabRows.tsx` / `CliChatResumeMenuItems.tsx`）、10px 为一等字号（`main.css:50`）。
   - 场景出问题：① 新用户在 13 寸屏上首屏面对顶栏 2 组 + 标签条 + 侧栏 20 行 + 状态栏 10 段，找不到「新建工作区」在哪，学习曲线陡；② 触屏/手抖用户（`can-hover` 已识别触屏但只解决了 hover 问题）点击目标 24–28px 偏小，误触率高；③ 演示/截图类场景（对外分享）信息噪音大，需要额外做「简化模式」。

4. **深浅色靠双写，545 个变量必须人工保持对称**
   - 证据：`:root` @ `main.css:199` 与 `.dark` @ `main.css:332` 是两份同名列表；`docs/STYLEGUIDE.md:24` 要求新 token 两边都写。
   - 场景出问题：漏写一处 `.dark` 覆盖 → 暗色下该处回落到浅色值（例如白底黑字突然出现在暗色面板里）；且这种缺陷不会被 lint 抓到（`no-raw-colors` 只管「有没有用 token」，不管「两边是否都定义了」）。11521 文件规模下，这种漏写只在特定弹窗/特定状态下暴露，回归测试很难覆盖。

5. **深色变体选择器复杂度过高，portal 层容易错色**
   - 证据：`main.css:36` 单个 `@custom-variant dark` 里同时处理 `.dark`、`data-native-chat-scheme='light'`、`data-native-chat-scheme='dark'` 三套作用域，注释自承「A matching chat can use a different scheme from the document; portaled menus stay outside it」。
   - 场景出问题：任何被 portal 到 body 的菜单/对话框/tooltip 天然落在 scheme 作用域之外，需要逐个补 `data-*` 标记；新写一个 popover 时忘记标记就会在「文档深色 + 聊天浅色」的组合下渲染成错误配色——这是组合爆炸（2 套 scheme × portal 与否 × 嵌套层级），不是单点 bug。

6. **动画参数无 token 化，46 个 keyframes 各自硬编码**
   - 证据：`--animate-*` 定义数 = **0**（`rg -e '--animate-[a-z0-9-]*:' main.css`）；`@keyframes` 46 个；`duration-*` 132 处手写；`ease-[cubic...]` 17 处。
   - 场景出问题：① 想统一「所有面板展开 200ms」需要改遍 46 个 keyframes 与 132 处 class；② 做「慢速模式」（录屏演示、低端机降帧）时没有单一开关可调，只能靠 `reduce-effects` 一刀切（全关），失去中间档；③ `ease-[cubic-bezier(0.16,1,0.3,1)]` 被复制 17 次，任一处改错就不一致。

7. **无布局库 / 无 resizable-panels，分栏与分割条全部自研**
   - 证据：`react-resizable-panels` 与 `allotment` 导入数均为 **0**；分割条颜色需手工满足对比度（`main.css:323-325` 注释「must clear 3:1 against --card even before hover; --border is too faint」）。
   - 场景出问题：① 三栏拖拽的键盘可达性（Tab 聚焦分割条 + 方向键调整 + `aria-valuenow`）要自己实现，第三方库自带；② 拖拽时的尺寸持久化、双击复位、最小宽度约束都是手写逻辑（`AppWorkspaceShell.tsx:171-176` 注释说明「persisted to Zustand only on mouseup」、`use-app-chrome-layout.ts:86-94` 用 `getBoundingClientRect` 手工测量塌缩头宽度）——这类代码是长期 bug 温床。

---

## 15. 可照搬清单（具体到模块）

| 要抄什么 | 具体位置 | 怎么用 |
|---|---|---|
| token 四层结构（原始色 → 语义 → 状态 → 透明） | `src/renderer/src/assets/main.css:199-330`（浅）+ `:332-...`（深） | 直接照结构建自己的 `main.css`；透明层用 `color-mix()` 而非新 hex |
| 设计系统 lint 闭环 | `config/oxlint-design-system.json:19-38` + `package.json` 的 `lint:design-system` | 抄 `@shadcn/lint` 三条规则与 `allow:["layout"]` 的边界划法 |
| 单一基准派生圆角 | `main.css:184-190` | `--radius` + 6 个系数，别抄 7 档，抄「派生」这件事 |
| 面板级错误边界 + 业务文案 | `src/renderer/src/components/error-boundaries/RecoverableRenderErrorBoundary` + `AppWorkspaceShell.tsx:53-69,137-146,216-224,232-241` | 每个 pane 一个 `boundaryId`，文案必须说明「其它部分是否还活着」 |
| 状态色语义表（含「为什么不能用蓝做状态」） | `main.css:262-283` | 抄注释里的理由，不是抄色值 |
| 无障碍三开关（reduce-effects / can-hover / theme-transition-disabled） | `main.css:41-58` | 三个 class 级开关，成本极低 |
| 逐帧 spinner（steps 代替 JS） | `main.css:2044` + `agent-spinner-rotate` | 需要「帧动画感」但不便引 JS 时的取巧法 |
| 设计规范文档结构 | `docs/STYLEGUIDE.md`（70 行总纲）+ `docs/styleguide/{color,components,native-chat,ux-rules,ux-review-rubric}.md` | 总纲只写「角色与规则」，值一律指向唯一真源文件 |
| 插件主题 token 契约 | `docs/reference/plugin-theme-tokens.md`、`src/shared/plugins/artifacts/plugin-theme-css-fallbacks.ts` | 主题可被外部产出时的回退链写法 |

## 16. 要超过清单（具体到能力 + 怎么验证超过）

| 要超过的能力 | orca 现状（弱在哪） | 怎么验证我们超过了 |
|---|---|---|
| **字号走 token** | 1766 处 `text-[Npx]`，52% 不走路 token | 我们全库 `rg -o 'text-\[[0-9.]+(px\|rem)\]'` **= 0**；且改 1 个字号 token 后，截图 diff 只出现预期的几处变化 |
| **阴影/层级语义化** | 2 个 shadow token 对 333 处使用 | 我们定义 `--shadow-raised / overlay / modal / toast` ≥4 档，`shadow-[` 任意值 = 0；暗色下浮层与卡片能被用户 3 秒内正确区分（做 10 人可用性小测） |
| **深浅色单一真源** | `:root` 与 `.dark` 双写 545 变量，靠人记住 | 深色值由浅色 token 经 `color-mix()`/相对色自动派生，token 定义只在 1 处；新增颜色后跑一次「漏写检测」脚本 = 0 命中 |
| **密度可调** | 10px 一等字号 + 60–120 目标/屏，无密度档位 | 提供 compact / comfortable 两档密度（间距与字号联动），切换时布局不破；13 寸 125% 缩放下中文最小字号 ≥11px 且不裁切 |
| **动画可 token 化 + 可调速** | 46 个 keyframes 硬编码，仅全开/全关 | `--motion-*` token 覆盖全部时长与缓动，`duration-[` 任意值 = 0；提供 0.5×/1×/2× 三档速度且不破布局 |
| **分栏键盘可达** | 自研 flex + 自绘分割条，无库 | 分割条可 Tab 聚焦、方向键调整、有 `aria-valuenow`；axe 扫描 0 violation |
| **导航首屏可发现性** | 三栏 + 9 视图 + 10 状态段全平铺 | 新用户首次任务（新建工作区并跑起一个 agent）完成时间 < 60s，无需求助（5 人可用性测试） |

---

## 附：实测数字汇总

| 指标 | 数值 |
|---|---|
| 源码规模 | 37169 文件 / 253MB；版本 1.4.214 |
| renderer ts/tsx 文件 | 11521 |
| components 子目录 | ≈110 |
| `--color-*` token | 112 |
| main.css CSS 变量定义 | 545（`var(--)` 引用 740） |
| main.css 行数 | 3626（125KB） |
| 颜色字面量（`src/`） | 4365（hex 3994 / rgba 236 / rgb 125 / oklch 9 / hsl 1） |
| hex in renderer tsx | 257 处 / 101 文件 |
| hex in main.css | 186 |
| 圆角档 | 7（全部由 `--radius: 0.625rem` 派生） |
| 阴影 token | 2（对 268 `shadow-*` + 65 `shadow-[`） |
| 字号档 | 9 档，跨度 10px→20px（2.0×）；新增 token 5 个 |
| `text-*` 刻度 vs 任意值 | 3386 : 1766 |
| 间距基数 | 4px（Tailwind v4 默认，未覆盖） |
| `rounded-*` / `grid-cols-*` / `dark:` | 1827 / 251 / 282 |
| 动画 | duration 132（主用 150/200/300ms）、ease 84（ease-out 63）、keyframes 46 |
| 图标 | lucide-react 1236 文件 / 1241 处；自绘 `<svg>` 120 文件（≈9.7%）；其他图标库 0 |
| 布局库 | react-resizable-panels 0、allotment 0 |
| 导航 | 9 个 `activeView` 页面；10 个状态栏段；status-bar 目录 196 处 `Segment` |
| i18n | 11 个 locale |
| 设计系统 | STYLEGUIDE 70 行 + 5 篇深潜 + 1 个 lint config（3 条 error 规则） |
