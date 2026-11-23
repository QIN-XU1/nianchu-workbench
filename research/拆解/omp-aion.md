# omp-studio 与 AionUi 界面拆解

> 只读分析，未修改任何源码。测量口径：`rg -o '#[0-9a-fA-F]{3,8}\b'` 与 `rg -o 'rgb\(|rgba\('`，排除 `node_modules` / `*.map` / `*.lock`。

## 横向对比

| 维度 | omp-studio | AionUi |
|---|---|---|
| 一句话 | 面向编码 Agent 的 Electron 桌面工作台（IDE 型控制台） | 把 CLI AI Agent 包装成现代聊天界面的跨平台客户端（聊天型） |
| 版本 / 体量 | v0.2.1，44 个 workspace 包，renderer 497 tsx / 90 css | v2.2.2，desktop 包 315 tsx / 30 css |
| 技术栈 | React 19 + Vite 6 + TypeScript 5.9，**无 UI 组件库**（自研 CSS 变量体系）+ CodeMirror 6 + xterm + three/x_ite + pdfjs | React 19 + electron-vite 5 + **Arco Design 2.66** + **UnoCSS 66** + react-router 7 + CodeMirror/Monaco + icon-park |
| 布局骨架 | 顶栏 44px / 导航轨道 56px / 侧栏 272px / 阅读列 768px / 右侧面板 480px / 底部面板 240px，全部可拖拽 | Arco Layout：Titlebar 36px + Sider（可折叠、可拖拽排序）+ 内容区 + 预览侧栏 |
| 导航层级 | 三级：轨道(rail) → 侧栏(会话/工作区树) → 顶栏面包屑 + `trail` 前进后退 | 二级：Titlebar → Sider（搜索/助手/定时/团队分组 + 会话列表）+ Router 多页 |
| 颜色计数 | **1982** 处 hex，**487** 处 `rgb(`/`rgba(` | **2134** 处 hex，**460** 处 `rgb(`/`rgba(` |
| token 层 | `apps/renderer/src/styles/tokens.css` 单文件 ~101 hex，完整语义层 | `styles/themes/default-color-scheme.css`（95 hex）+ `docs/theming/tokens.md` 契约 + `tokenContract.ts` + `tokensToCss.ts` |
| 字号阶梯 | 11/12/14/16/18/22（1.17x 比例，显式注释掉 13） | 无全局阶梯，UnoCSS 原子类散用（`text-14px`、`text-12px` 等） |
| 间距阶梯 | `--sp-2..--sp-32` 11 档，全乘 `--density-scale` | 无阶梯，UnoCSS `p-2/p-4/mb-3` + Arco 内建 |
| 圆角 | `--r-4:6px / --r-6:9px / --r-8:12px / --r-10:16px / --r-full` | 无自定义阶梯，Arco 默认 + 少量局部覆盖 |
| 动画 | `tokens.css` 6 档时长 + 6 条曲线 + motion.css 5 类模式，44 个 keyframes / 271 处 transition | 7 个 keyframes / 43 处 transition，无动效库、无统一模式 |
| 图标 | 自研 `icons.tsx`：16×16 stroke 单色 SVG path 表，`satisfies` 锁字面量联合 | `@icon-park/react`（149 文件引用）+ `@iconify/react`（1 文件）双图标包混用 |
| 主题 | `html[data-theme]` light/dark + `data-density` + `data-palette="tri"` + forced-colors + prefers-contrast | `appearance` → `data-theme` + `body arco-theme`，**主题是插件能力**（Theme 可覆盖 tokens / 注入 css） |
| 设计系统层 | **有且很硬**：token CSS + motion.css + 校验脚本（check-renderer-motion / check-renderer-selects） | **有契约层**：tokenContract.ts 白名单 + UnoCSS bridge + 文档化 token 清单，但样式落地无强制 |

---

## omp-studio

### 定位 / 技术栈
snowpear 出品的 **OMP Runtime 桌面控制台**（"Desktop console for OMP Runtime — typed Studio Bridge, Electron workbench"）。不是聊天壳，是给编码 Agent 用的**工作台/IDE**：会话、工作区文件树、终端、Git、Diff、预览、面板停靠全在一个窗口里。

- 渲染层：React 19 + Vite 6 + TypeScript 5.9，**完全不用第三方组件库**，全部自研 CSS 变量 + 手写组件。
- 重依赖：CodeMirror 6 全家桶（编辑器）、`@xterm/xterm` 6（终端）、`three` 0.186 + `x_ite`（3D/图形预览）、`pdfjs-dist` 6、`xlsx`、`mermaid`、`highlight.js`/`lowlight`、`@tanstack/react-virtual`。
- 架构：44 个 `@omp-studio/*` workspace 包，renderer 是"pure-browser React surface over the semantic StudioClient contract"——UI 通过语义化 client contract 访问 Runtime，不直接碰 IPC。
- 桌面：Electron + electron-builder（win/mac 双安装器），自建 OMP host 打包/签名/更新链。

### 布局骨架
CSS 变量驱动的多区停靠布局，尺寸全在 `tokens.css`：

```
--topbar-h: 44px     --nav-rail-w: 56px    --sidebar-w: 272px (min 200 / max 400)
--panel-w: 480px     --doc-max-w: 768px    --bottom-panel-h: 240px
--minimap-w: 36px
```

结构是 `AppShell` → `AppTopbar` / `AppSidebar`（含 `WorkspaceTree`）/ `WorkbenchCanvas` / `BottomPanelChrome`，外加 `dock/` 的停靠系统（`DockRegions`、区域分 left 卡区与 rail 轨道区）。所有宽度由 `useWorkbenchLayout` 以 JS 写进 `:root` 的 CSS 变量（`--sidebar-w`、`--panel-w`、`--dock-rail-w`），`useWorkbenchResizers` 提供拖拽，`#sbResizer`/`#spResizer` 带 `aria-valuenow`。断点由独立 hook 承担：`useWideLayout`、`useCompactTopbar`、`useReadingColumn`。

特色：`--doc-max-w: 768px` 的**阅读列**——即使侧栏和右侧面板都展开，正文仍被夹到 768px，长对话不会被拉成一行 2000px。

### 导航层级
三级 + 历史栈：
1. **轨道 rail（56px）**：折叠式图标条，`railMode`（hidden/expanded/collapsed）由 `dock/store` 管理，收起后头像回落到侧栏底部（`useIdentityFlight` 做头像飞行过渡）。
2. **侧栏（272px）**：`AppSidebar` + `WorkspaceTree` + 项目/会话历史（`useProjectHistories`），带 running 态（`ThreadSpin`、`ThreadWaitChip`、`threadRunning.ts`）。
3. **顶栏（44px）**：面包屑 + `trail` 前进/后退（`TRAIL_MAX` 上限，`rail` 的工作台入口行为等同 Back/Forward）。

叠加：底部面板、右侧面板、命令面板（`cmdk-shell`）、BTW 浮窗、`menus.tsx` 菜单、`slashUiIntent` 斜杠命令。项数不是固定常量，是 route + panel 注册表，`dock/types.ts` 的 `PanelDefinition` / `PanelId` 决定。

### 信息密度
**极高，且是刻意设计的可调密度**。三档 `--density-scale`：`compact 0.85` / 默认 `1` / `cozy 1.15`，只缩放间距阶梯，**不动字号与布局度量**（注释里写明了这条边界）。同时 `--tap-min: 24px` 保证 WCAG 2.2 SC 2.5.8 的最小点击目标——即"视觉上很密，命中区靠 padding 补足"。界面元素类型也极多（40+ 个功能目录：files/git/terminal/preview/dock/usage/services/agents/skills…）。

### 颜色体系
- hex **1982** 处，`rgb(`/`rgba(` **487** 处。
- token 文件：`apps/renderer/src/styles/tokens.css`（101 hex，是最主要的颜色定义处）；另有 `ui_reference/ver2/styles/tokens.css`（116 hex，设计参考稿）与 `packaging/ui/styles.css`（75 hex，安装器）。
- 语义分层非常完整：`--bg / --bg-inset / --surface / --surface-2 / --surface-3 / --surface-hover / --surface-active`、`--border / --border-strong / --border-float`、四级文字 `--text / --text-2 / --text-3 / --text-faint` + `--glyph-faint`（非文字灰，只欠 3:1）、`--accent` 及 soft/softer/border、状态色 green/amber/red/blue + soft、**`--danger-orange` + `--danger-glow`（Full Access 权限模式专用）**、12 条 `--tint-*` 角色色、6 条 `--git-*` 文件状态色、diff 四色、8+3 条 `--ftype-*` 文件类型色。
- 值得抄的细节：每个文字色都标了实测对比度（`text-2 7.34:1 / text-3 5.95:1 / text-faint 4.72:1`），并写明"从 #8f96a1 的 2.95:1 拉下来"；注释解释 `--shadow-menu: none`——**用边框和表面层级做深度，不堆阴影**；开关旋钮的两条不变量写了整段推理，明确"accent 是浅紫时白字只有 2.76:1，前景必须反成 app 背景色"。

### 字号 / 间距 / 圆角阶梯
- 字号：`11 / 12 / 14 / 16 / 18 / 22`，按 ~1.17x，注释明确"删掉了 --fs-13，因为和 12px 分不开"。分 UI 与输出双轨：`--ui-font-scale` / `--output-font-scale`，`typography.css` 让代码/终端区用输出轨道，让嵌在里面的按钮输入框退回 UI 轨道。
- 间距：`2/4/6/8/10/12/14/16/20/24/32`（`--sp-*`），全部乘 `--density-scale`。
- 圆角：`--r-4: 6px`（chip/树行）→ `--r-6: 9px`（按钮/菜单/工具卡）→ `--r-8: 12px`（卡片/面板/气泡）→ `--r-10: 16px`（模态/输入框/命令面板）→ `--r-full`。命名 vs 值故意错位（`--r-4` 是 6px）是历史包袱，但注释承认了并解释"整条阶梯上移让 UI 更圆，且相对步长保留以便嵌套角正确"。另有 `--r-12: var(--r-8)` 等兼容别名。
- Z-index 也是 token 阶梯：`base 1 → resizer 5 → scroll-aid 9 → rail 10 → topbar 20 → panel 30 → fab 40 → menu 60 → float 70 → modal 80 → tip 90 → toast 100`。

### 动画
**全项目最强的一块**。`motion.css` 头部直接给出模式表：`state / element / region / surface / hero` 五类，每类规定"进入用什么时长+曲线、离开用什么"。

- 时长 6 档，每档 ~×1.4：`tactile 80 / fast 120 / base 180 / slow 250 / slower 320 / hero 480`，外加 `flash 900`、`marquee 3000`；循环三种节奏 `spin 800 / pulse 1400 / drift 2400`。
- 曲线 8 条按**语义**命名：`--ease`(state)、`--ease-out`(arrive)、`--ease-in`(leave)、`--ease-nav`(travel)、`--ease-ios`(follow gesture)、`--ease-emphasis`(morph)、`--ease-loop`(breathe)、`--ease-spring`（真阻尼弹簧，写成 `linear()` 分段，注释标明 ω 0.62、8% 过冲，且"只有它允许过冲，只给标记和滑块用"）。
- 位移阶梯 `--shift-xs 4 / sm 8 / md 12 / lg 16` + `--stagger 40ms`，并规定**深度走垂直、同级走水平**。
- 44 个 `@keyframes`、271 处 `transition`。
- 治理：`scripts/check-renderer-motion.mjs` 校验组件不能自造时长/曲线，且 `src/motion.ts` 必须与 CSS 表一致，漂移就 fail。

### 图标方案
自研单文件 icon 集 `apps/renderer/src/icons.tsx`：16×16 stroke SVG path 表，统一 `currentColor` + CSS 控尺寸（`.icon` / `.icon.sm` / `.icon.lg`）。用 `satisfies`（而非类型注解）保住 `keyof typeof PATHS` 的字面量联合，`<Icon name="…">` 打错字直接编译失败，动态来源必须证明是真实图标名。少量 GitHub 品牌图标来自 Primer Octicons（保留 MIT 声明）。零图标依赖、零字体图标、零运行时开销。

### 主题
- `html[data-theme="light"|"dark"]` 双主题，都用 `color-scheme` 声明，默认 light。
- 额外维度：`data-density="compact|cozy"`、`data-palette="tri"`（**三通道严格模式**：12 个文件类型色全部退回 `--text-3`，只留 secret→amber 一个"需注意"通道，用于证明"颜色只是加速器、语义 100% 由剪影承担"，并配 `__shots/light-palette.png` / `dark-palette.png` 截图）。
- 无障碍：`@media (forced-colors: active)` 与 `@media (prefers-contrast: more)` 自动降级同一组变量，且用 `:root:root:root` 提特异性避免被深色块覆盖；`prefers-reduced-motion` 有专门策略（tokens.css 与 motion.css 各 1 处声明 + motion.css 统一收口）。

### 有没有设计系统层
**有，而且是"带门禁的设计系统"**。四层：
1. token 层 `tokens.css`（颜色/字号/间距/圆角/时长/曲线/位移/z-index/布局度量，全部语义命名 + 注释解释取舍）；
2. 行为层 `motion.css`（模式表 + 降级策略）；
3. 排版层 `typography.css`（UI 轨道 vs 输出轨道）；
4. 治理层三个脚本：`check-renderer-motion.mjs`（动效越权）、`check-renderer-selects.mjs`（样式选择器）、`check.mjs`（整体）——设计系统不是文档，是 CI 会红的东西。

### 优势
1. **设计 token 有实测依据而非审美口号**。每个文字色都标了对比度数字并写明为何调（`--text-faint` 从 2.95:1 提到 4.72:1），状态色"压暗到白底 4.5:1"，开关旋钮连"accent 是浅紫时白字 2.76:1 所以前景反色"都写进注释。这是能直接拿去做无障碍审计的证据链。
2. **动效被当作可测试的契约**。6 档时长 × 8 条语义曲线 + 5 类模式表，配 `check-renderer-motion.mjs` 强制 CI 校验，还有 CSS 与 `motion.ts` 的双向一致性检查。绝大多数项目做不到这一层，它把"动效一致性"从口头约定变成会 fail 的测试。
3. **密度是三档可调而不是一个数值**。`--density-scale` 只缩间距、明确不动字号与布局度量，同时 `--tap-min: 24px` 守住 WCAG 最小命中区——"看起来密、点得准"两个目标被解耦了。
4. **图标自研且类型安全**。`satisfies` 保字面量联合，拼错图标名编译期报错，0 依赖 0 运行时。

### 缺点
1. **颜色纪律在 token 层很好，在实现层失效**。1982 处 hex 里，`apps/renderer/src/styles/tokens.css` 只占 101 处，`ui_reference/ver2/styles/tokens.css` 占 116 处，剩下 ~1700 处散落在组件 CSS、SVG、README 示意图、`website/` 里——token 系统没有 lint 阻止组件直接写 hex，所以"语义色"和"手写色"长期共存。
2. **变量命名与值脱节，且存在大量兼容别名层**。`--r-4` 实际是 6px、`--r-6` 是 9px、`--r-8` 是 12px，读代码时必须查表；文件末尾还堆了 `--fs-10: var(--fs-11)`、`--fs-13: var(--fs-12)`、`--sp-3: var(--sp-4)`、`--text-muted: var(--text-3)` 等一长串别名——说明历史上改名没做完，新人和 grep 都会踩坑。
3. **自研组件库的代价**：无 Arco/Radix 兜底，菜单、Popover、Tooltip、命令面板、焦点陷阱全靠自己写（`menus.tsx`、`cmdk-shell`、`data-tip` 500ms 延迟手写），`AppShell.tsx` 单文件超 2000 行，键盘导航/ARIA 的正确性全靠自测，维护成本高。
4. **`ui_reference/` 与 `website/` 混在主仓**，ver1/ver2 两套参考稿各带完整 token 文件（54 + 116 hex），grep 颜色时会被污染，也让"到底哪套是当前设计系统"变得需要靠 `apps/renderer` 路径才能判断。

---

## AionUi

### 定位 / 技术栈
"Transform your command-line AI agent into a modern, efficient AI Chat interface" —— 把 ACP / Claude Code / Gemini CLI 等命令行 Agent **包装成现代聊天客户端**的 Electron 应用（Apache-2.0，v2.2.2），同时支持桌面、WebUI、移动端与 Telegram/钉钉/飞书等 IM 桥接。

- React 19 + electron-vite 5 + TypeScript 5.8，**组件库是 Arco Design 2.66**（188 个文件引用），样式主力是 **UnoCSS 66 原子类**（`uno.config.ts` 把 token 桥接成 `bg-1` / `text-t-secondary` 等工具类）。
- 路由 `react-router-dom` 7，多页结构（conversation / settings / team / cron / guid / login）。
- 协议层：`@agentclientprotocol/sdk` 0.18（ACP），`@modelcontextprotocol/sdk`（MCP），一堆模型 SDK（openai / anthropic / @google/genai / @aws-sdk bedrock）。
- 编辑器：CodeMirror 6 + `@monaco-editor/react`；虚拟列表 `react-virtuoso`；拖拽 `@dnd-kit`；浮层 `@floating-ui`；富内容 mermaid / katex / wavedrom / diff2html / react-syntax-highlighter。
- 工程化：oxlint + oxfmt（不是 eslint/prettier）、vitest + Playwright、electron-builder 26。

### 布局骨架
Arco `Layout` 三件套 + 自管样式修正：

- **Titlebar 36px**（`--titlebar-height: 36px`），含 `WindowControls`、`MigrationInviteCapsule`、移动端 `MobileConversationBrand`。
- **Sider**：`layout-sider`，`border-inline-end: 1px solid var(--border-base)`，`box-shadow: none !important`，内部强制 flex 纵向（`layout-sider-header` 固定 + `layout-sider-content` 撑满 `min-height: 0`），注释明确"避免用固定 calc()，header 高度一变就坏"。
- **内容区**：`react-router` 按页切换；会话页内部再分 `ChatLayout` + `Messages` + `SendBox` + `Preview` 侧栏 + `explorer` 文件树。
- 响应式：`--app-min-width: 360px`，`@media (max-width: 767px)` 起移动端形态（`MobileActionSheet`），`ProjectPanelMobileOverlay`。
- 会话窗口有 `ConversationTitleMinimap`（标题小地图，和 omp 的 minimap 概念撞车）。

### 导航层级
二层 + 分组：
1. **Titlebar**（品牌、窗口控制、迁移提示）。
2. **Sider** = 顶部工具区（`SiderToolbar`、`SiderSearchEntry`、`SiderAssistantEntry`、`SiderScheduledEntry`）+ `TeamSiderSection` 分组 + 会话历史（`WorkspaceGroupedHistory`，按 workspace 分组）+ `SiderFooter`（设置/主题/登出）。
3. **路由页**：`/guid`（新会话）、`/assistants`、`/scheduled`、`/settings/*`、`/team/*`；设置页内部还有独立的 `SettingsSider` 二级侧栏。

独特设计：**侧栏条目顺序可拖拽并持久化**——`useStoredSiderOrder` + `siderOrder.ts`（`reconcileStoredSiderOrder` 保证新增项自动追加、删除项自动剔除）+ `SortableSiderEntry`（@dnd-kit）。导航不是写死的，是用户可编排的。

### 信息密度
中等偏舒适：字号随手写（`text-14px`、`text-12px`）、无密度档位、Arco 默认控件的内边距决定了基础呼吸感。信息组织靠**分组与折叠**而非压缩——侧栏 section label 吸顶（`sider-section-label` 背景 `--bg-2`）、团队/项目/定时/时间线分组各有标题。会话内容区较宽松，但工具调用、Diff、活动流（`pages/team/activity/activityHighlight.css`）密度会明显上升。

### 颜色体系
- hex **2134** 处，`rgb(`/`rgba(` **460** 处。
- 权威定义：`packages/desktop/src/renderer/styles/themes/default-color-scheme.css`（95 hex），文档契约 `docs/theming/tokens.md`，运行时白名单 `common/theme/tokenContract.ts`，序列化 `renderer/utils/theme/tokensToCss.ts`。
- 分层：**10 阶品牌色 `--aou-1..10`**（浅色模式从浅到深，**深色模式整条反向**，使 `--aou-1` 恒为最深）；**10 阶背景 `--bg-base / --bg-1..10`**（数字越大分离越强）+ `--bg-hover` / `--bg-active`；文字 `--text-primary / --text-secondary / --text-disabled / --text-0 / --text-white`（并让 `--color-text-1` 与 `--text-primary` 对齐，同时喂 Arco）；语义 `--primary #165dff / --success #00b42a / --warning #ff7d00 / --danger #f53f3f / --info`；品牌 `--brand #7583b2`；消息专属 `--message-user-bg #e9efff`、`--thought-gradient`。
- token 文档里诚实标注了缺口："`--info` 有 UnoCSS 类但还没有组件用"。

### 字号 / 间距 / 圆角阶梯
- **没有全局阶梯**。字号靠 UnoCSS 原子类按需写（`text-14px`、`text-12px`、`text-16px`），间距靠 `p-*` / `mb-*` / `ms-2px` 之类，圆角主要吃 Arco 默认（`borderRadius` 在其 token 里），只有局部文件做覆盖。
- 唯一的形式化度量写在 `base.css`：`--app-min-width: 360px`、`--titlebar-height: 36px`。
- 对比 omp：这一层是 AionUi 明显的短板——设计师改不了"整站字号 +1"，因为没有可调的单一变量。

### 动画
- 7 个 `@keyframes`、43 处 `transition`，**无动效库**（grep `framer-motion` / `motion/react` = 0 个文件）。
- 主要是 CSS 层面的 `transition-colors`、`transition-opacity`、`transition-transform` 原子类 + 零星 keyframes（`loading` 1s linear infinite、`bg-animate` 1s alternate infinite）。
- 有布局级细节：`.layout-sider--dragging { transition: none !important }`——拖拽时关掉过渡防掉帧，属于实用主义修补。

### 图标方案
- **双图标包并存**：`@icon-park/react` 149 个 tsx 文件引用（`<Pushpin theme='outline' size='14' />` 这类调用），`@iconify/react` 1 个文件引用（另有 `@iconify-json/vscode-icons` 用于文件树图标）。
- 图标尺寸是**每个调用点手写 prop**（`size='14'`），没有 token。
- `base.css` 里有一段全局修补：icon-park 的外层 `span.i-icon` 默认 `inline` 导致基线错位、"图标视觉整体偏上"，全局改成 `inline-flex` + 居中。这是典型的三方图标库水土不服。

### 主题
- 外层 `appearance: 'light' | 'dark'` → `<html data-theme>` + `<body arco-theme>`，同时驱动自研 token 与 Arco 内置主题。
- **主题是可扩展能力**：`Theme` 对象可带 `tokens`（flat 或 layered `{root, light, dark}`，只能改 `tokenContract.ts` 白名单内的键，未知键直接丢弃）或 `css`（原始装饰 CSS，自动 `!important`）。有 `examples/hello-world-extension/themes/ocean-breeze.css`、`sunset-glow.css`（各 152 hex）作为扩展样例，`AppearanceSettings/themeCovers.ts` 管主题封面。
- 效果：用户/插件能发布完整主题，这是 omp 没有的能力。

### 有没有设计系统层
**有"契约层"，缺"落地层"**。
- 有：`tokenContract.ts`（运行时白名单校验）、`docs/theming/tokens.md`（逐 token 的 light/dark 值 + 用途 + 对比度说明）、`tokensToCss.ts`（分层序列化）、UnoCSS bridge（`bg-1` → `var(--bg-1)`）、`arco-override.css` 统一压 Arco。
- 缺：间距/字号/圆角/动效没有 token 化，也没有 lint 阻止在组件里写 `text-14px` 或裸 hex。所以"契约"只覆盖颜色，其余靠自觉。

### 优势
1. **主题是产品能力而非皮肤开关**。`tokenContract.ts` 白名单 + `tokensToCss()` 分层注入（root/light/dark）+ 装饰 CSS 通道 + 官方 extension 主题样例，让第三方能做出完整可发布主题；相比之下 omp 的 `data-palette` 虽然严谨，但只是内置玩法，没有对外开放的覆盖协议。
2. **侧栏顺序可由用户拖拽编排并持久化**。`siderOrder.ts` 的 `reconcileStoredSiderOrder` 处理了"存了但当前不存在的 id""新出现但顺序里没有的 id"两类边界，配上 `SortableSiderEntry`——导航结构尊重用户肌肉记忆，而不是强迫所有人接受同一套排列。
3. **品牌色阶在深色下整条反转**（`--aou-1` 浅色最浅、深色最深），使"品牌底色"的表达在两套主题下语义一致；文档里还诚实标注了未使用/冗余的 token（`--info`）。
4. **底座选型务实**：Arco + UnoCSS + floating-ui + dnd-kit 全部组合起来，一个中等团队就能把 315 个 tsx 的复杂度撑住，不用为每个 Popover 手写焦点管理。

### 缺点
1. **颜色 token 只覆盖了颜色，其余设计决策全部裸奔**。2134 处 hex 中 `default-color-scheme.css` 只占 95 处；字号/间距/圆角根本没有 token（`text-14px`、`p-2`、Arco 默认圆角直接写进组件）。结果是"能换主题颜色，但换不了视觉节奏"。
2. **图标双包并行 + 尺寸靠手写 prop**。`@icon-park/react`（149 文件）与 `@iconify/react` + `vscode-icons`（文件树）两套风格并存，`base.css` 里那段 `i-icon` 全局修补就是证据——同一界面里图标基线、描边粗细、视觉重量都难以统一，还多了运行时包体。
3. **几乎没有动效体系**。0 个动效库、7 个 keyframes、43 处 transition，没有时长/曲线 token，也没有 reduced-motion 的统一策略；omp 用 271 处 transition 和一张模式表做的事，这里基本靠原子类随手加，跨页面手感难一致。
4. **信息密度不可调，字号梯度靠散写**。没有 `--density-scale` 之类能力，也没有 11/12/14/16/18/22 这样的固定阶梯，改版时想整体收紧一档只能逐文件改，且容易出现 13px 这类"半档"。

---

## 两者的共同好设计

1. **都建立了独立的语义 token 文件，而不是散写颜色**。omp 的 `styles/tokens.css`、AionUi 的 `themes/default-color-scheme.css` 都把颜色收敛成"背景/表面/边框/文字/状态/品牌"的分层命名，两者都同时提供 light/dark 两套值并用 `data-theme` 切换。语义命名（`--surface-2`、`--bg-3`、`--text-secondary`）而非 `gray-200` 这类外观命名，是两者能做出高质量深色模式的前提。
2. **都写了对比度依据**。omp 注释里逐个文字色标 `7.34:1 / 5.95:1 / 4.72:1` 并说明为何下调；AionUi 文档里写 `--text-secondary` "tuned for ~7.5:1 / ~11:1 contrast"。两家都把无障碍从"记得做"变成"数字写在这"。
3. **都用 `--` 前缀的 CSS 自定义属性做跨技术栈桥接**：omp 用它喂自研组件，AionUi 用 UnoCSS bridge 把同一批变量映射成 `bg-1` / `text-t-secondary` 工具类。换个主题，工具类和组件一起跟着变。
4. **都支持密度/尺寸的用户级调整**：omp 用 `--ui-font-scale` / `--output-font-scale` + `--density-scale`，AionUi 用侧栏拖拽宽度 + 可编排导航顺序。都在"给用户控制权"这件事上做了动作。
5. **都注意到拖拽/过渡的工程细节**：omp 的 `--ease-ios`（跟随手势的曲线）专门服务拖拽落位；AionUi 的 `.layout-sider--dragging { transition: none !important }` 在拖拽时关掉过渡。两家都知道"过渡动画在 1:1 跟手场景下是负担"。

## 两者的共同毛病

1. **token 层与实现层脱节：语义色和裸 hex 长期共存**。omp 1982 处 hex 里 token 文件只占 ~217 处（101 + 116），AionUi 2134 处里权威文件只占 95 处，且 AionUi 的 2134 里还有 640 处来自 CHANGELOG.md（历史版本说明）——两家的 `rg` 计数都被文档和示例污染。更关键的是：**两家都没有 lint 规则阻止组件里直接写 hex**，所以 token 系统的纯洁度只能靠 code review 守。
2. **设计系统缺少"间距/字号/圆角"的强制层**。omp 有阶梯但允许 271 处 transition 与散落组件 CSS 各自为政（靠脚本兜 motion，不兜 spacing）；AionUi 干脆没有阶梯。两家都做到了"颜色可换"，但都没做到"节奏可换"。
3. **历史兼容层沉淀成债务**。omp 的 `tokens.css` 末尾挂着一长串别名（`--fs-13: var(--fs-12)`、`--r-12: var(--r-8)`、`--text-muted: var(--text-3)`），AionUi 有 `--color-text-1` 与 `--text-primary` 双份对齐 Arco、`--text-0` 与 `--text-primary` 同值（文档自己写"prefer text-t-primary in new code"）。都是改名未收敛的痕迹。
4. **深色模式都有需要逐条打补丁的角落**。omp 为深色开关旋钮写了整段论证（`--switch-thumb` 在深色下不能用 `--surface`，"否则旋钮会读成一个洞"）；AionUi 在 `layout.css` 里为深色单独硬编码 `#9098a1`，理由是"tertiary 在 #0e0e0e 上太暗、secondary 又太亮"。说明双主题的成本主要发生在语义边界之外。

## 对我们（OpenBitFun 外壳）的建议

1. **直接抄 omp 的 token 三层结构，但给它加门禁**。照搬 `tokens.css` 的组织方式：颜色 / 字号 / 间距 / 圆角 / 时长 / 曲线 / 位移 / z-index 全部语义命名并集中一处；同时**必须**加一条 lint（stylelint `color-no-hex` + 禁止 `transition:` 里出现裸数字），否则我们会重演两家"token 很好、实现很脏"的老路。omp 已经有 `check-renderer-motion.mjs` 的先例，把它扩成 `check-renderer-tokens.mjs` 即可。
2. **动效表直接采用 omp 的五类模式 + 六档时长**。`state / element / region / surface / hero` × `80/120/180/250/320/480` 这套映射经过实测推敲（含"离开比到达快一档"这条规则），能省掉我们重新发明曲线的时间。但**把 `--ease-spring` 的 `linear()` 换成保守的 `cubic-bezier`**——那串分段值是浏览器新特性，Electron 版本一低就整段失效，回退会静默变线性。
3. **密度做成 omp 那样的单变量，而不是 AionUi 的散写**。`--density-scale` 只缩间距、明确不动字号和布局度量、再用 `--tap-min: 24px` 兜住命中区——这个"三件事解耦"的设计是最值得整段搬的。AionUi 的 `text-14px` 散写方式改一版要全仓搜，成本高一个量级。
4. **主题能力抄 AionUi 的契约，不抄 omp 的内置玩法**。`tokenContract.ts` 白名单 + flat/layered 两种 `tokens` 形状 + 装饰 `css` 通道 + `tokensToCss()` 分层注入，这套协议让第三方能发布完整主题且不会注入乱七八糟的键；omp 的 `data-palette="tri"` 思路很好（颜色降级到只有一条"需注意"通道，验证语义不依赖颜色），可以作为我们内置的**无障碍预设**保留，而不是唯一玩法。
5. **图标：抄 omp 的自研单表 + `satisfies`，别抄 AionUi 的双包并行**。单文件 16×16 stroke path 表 + `keyof typeof PATHS` 字面量联合，让拼错图标名在编译期就红；AionUi 双图标包并行带来的直接后果是 `base.css` 里那段 `i-icon` 全局对齐修补（且尺寸全靠 `<Xxx size='14' />` 手写）。如果一定要用第三方图标，至少把尺寸收进 token 并只保留一个包。
6. **布局骨架用 omp 的"可拖拽 + 阅读列"，但别学它单文件 2000 行**。`--doc-max-w: 768px` 保证长对话不被拉成一行 2000px 窄条，`--sidebar-w` / `--panel-w` / `--dock-rail-w` 由 JS 写入 `:root` 并带 `aria-valuenow`，这套做法直接可用。但 `AppShell.tsx` 超 2000 行是反面教材——壳应该只做区域编排，把 rail/sidebar/panel 各自的状态下沉到独立 store。
7. **两家都没解决、我们要先定的两件事**：(a) **"信息密度 + 字号"是否要联动**——omp 明确解耦（密度只动间距），我们要沿用它并在文档里写死，否则每次改版都会重新吵一次；(b) **三档主题覆盖优先顺序**——系统 `forced-colors` > 用户显式主题 > 内置 dark/light，omp 用 `:root:root:root` 提特异性解决了，AionUi 用硬编码色值绕过，我们应该在协议层就定义清楚而不是留给 CSS 特异性去打架。
