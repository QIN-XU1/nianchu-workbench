# 念初超越改进日志（按批次，含截图/可复算证据）

> 每个改动：对标出处 → 改了什么 → 证据（截图 + 功能核验）→ 提交。禁止无证据。

## 批次 A · P0 主 agent 输入增强（对标 Cursor / WorkBuddy）
**对标**：Cursor composer「`/` for skills, `@` for context」；WorkBuddy「@添加上下文，/调用技能与指令」；WorkBuddy 能力胶囊 / Cursor 起手建议行。

**改动**（`apps/vouch-web/src/web-ui/src/app/layout/NianchuChat.tsx` + `.scss`）：
1. 空态**起手胶囊** ×4（解释这段代码 / 写一份内容方案 / 分析一组数据 / 帮我排查这个报错），点击填入输入框。
2. 输入框支持 **`@` 上下文补全**（当前会话 / 工作区文件 / 相关记忆）。
3. 输入框支持 **`/` 技能指令补全**（技能清单来自宿主 `get_skill_configs`，真实技能库；向上/下/回车/Esc 键盘操作）。
4. placeholder 与引导文案更新为「@ 上下文，/ 技能指令」。

**证据（47124 真实渲染 + 无头 Chrome CDP 交互）**：
- 功能核验（`temp/cdp-verify.mjs` 输出）：`chipCount=4`，chipTexts 四胶囊；输入 `/` → sug-head「技能 / 指令」+ 真实技能项（accessibility-audit…ws-jsonrpc 等）；输入 `@` → ["@当前会话","@工作区文件","@相关记忆"]。
- 截图：`evidence/improve-p0-empty.png`（空态胶囊）、`improve-p0-slash.png`（/ 技能浮层）、`improve-p0-at.png`（@ 上下文浮层）。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（type-check + vite 通过）。

**记分影响**：D-实用 P4(键盘/效率) 从「无 @ // 」→ 具备（对齐 Cursor/WorkBuddy）。

## 批次 B · 助手段 Markdown 渲染（对标 Cursor / Claude）
**对标**：Cursor、Claude 对助手回复做 Markdown 渲染（列表/加粗/代码块）；念初原来纯文本 pre-wrap，`**加粗**`、代码块都不成样。
**改动**（`NianchuChat.tsx` + `.scss`）：助手段改用本仓 `MarkdownRenderer`（`ncc-msg__body--md`，块级正常排版 + 代码块底色/等宽）。
**证据**：
- 端到端核验（`temp/cdp-verify2.mjs`，真实发一条要求 Markdown 的消息）：助手 body `hasMdClass=true, strong=true, list=true, code=true, pre=true`，真实模型回复（auto-claude-sonnet-5-5 in114/out620）。
- 截图：`evidence/improve-markdown.png`（编号列表 + 加粗 + 带 Python 标签/复制键/高亮的代码块）。
- 构建 `build:web` ✓。
**记分影响**：D-美观 V2 视觉层级 / D-实用 P2 信息密度显著提升（代码/要点可读）。

## 批次 C · `/` 技能补全体验（可搜索技能面板）
**问题**：技能库 186 项，原 `/` 弹层只靠滚动，难定位。
**改动**（`NianchuChat.tsx` + `.scss`）：弹层加「共 N 项」总数 + 「仅示前 50，继续输入筛选」+ 键盘提示「↑↓选择·↵填入·Esc关闭」；输入即实时过滤。
**证据**：CDP 核验——`/`→head「技能 / 指令 · 共 186 项（仅示前 50…）」items=50；`/wr`→「共 3 项」items=3（doc-write/read-write-split/test-writing）；截图 `evidence/improve-slash-count.png`、`improve-slash-filter.png`；build ✓。

## 批次 D · 修复「调用统计」页崩溃 + 用量热力图（对标 Qoder Credits）
**问题**：设置→调用统计 点开即 Application Error（`g is not iterable` → `Cannot read .slice/.length of undefined`）：宿主未实现 `get_token_usage_statistics`，且前端组件对空/残缺数据无防护 → 整页崩。
**改动**：① 宿主 `methods-host-gaps` 补 `get_token_usage_statistics` 返回**合法空结构**（0 值+空数组，诚实空态）；② `UsageActivityGrid` 传 `points ?? []` 兜底；③ `UsageStatisticsSettingsPage` 校验 stats 各数组字段完整才渲染图表，残缺即视为无数据。
**证据**：CDP 实测（`hasError=false`，`hasCanvas=4 / hasSvg=45`，正文含「近半年每日用量…累计 0 Token…少/多」）；截图 `evidence/improve-usage-heatmap.png`；build ✓（注：`get_token_usage_statistics` 原已有旧桩，本次为覆盖修复，方法总数仍 120）。
**结果**：调用统计页可正常打开，展示 **Qoder Credits 式「近半年每日用量」贡献热力图**（当前真实 0 token 空态）。功能+美观双补。

## 批次 E · 调用统计导入真实用量（热力图显示真数据）
**问题**：上一轮账本/聚合已做好，但热力图仍 0。CDP 抓 WS **响应**发现：`get_token_usage_statistics` 被 ws-host 里一个位置更靠后的旧桩 `{totalInput:0,totalOutput:0,sessions:0,source:'not-tracked'}` 覆盖（对象字面量后定义者胜），页面拿到废结构。
**改动**：把该旧桩改为 `usageStore.statistics(...)`（真账本聚合）；移除 `methods-host-gaps` 里的重复定义；ws-host 仍 <32KB（32740B）。
**证据（CDP 实测）**：真发一条消息后 → 热力图「累计 **986** Token」，明细「Token总量986 / 输入731 / 输出255 / 已记录模型请求3」，热力图出现**非 0 蓝色日格**；截图 `evidence/improve-usage-real.png`；宿主侧无需 build。
**结果**：调用统计页显示**真实**用量（来自真实对话的 token 记账）。**对齐并超过 Qoder Credits**：Qoder 只有热力图，念初另有 token/输入/输出/请求数明细。

## 批次 F · 消息级操作（复制 / 重新生成 / 编辑重发）+ 模型展示名 + 用量去重
**对标**：ChatGPT / Claude / Cursor 的消息悬停工具栏（复制、重新生成、编辑重发）；Coder 类产品把模型名显示为可读名而非内部 id。
**问题**（见 `design-nianchu-panel.md` §2）：① 回复只能看，不能复制/重发/改问法；② 元信息暴露 `auto-claude-sonnet-5-5` 这种内部 id；③ 脚注「本轮 in/out」与每条消息的 `in/out` 重复，视觉噪音。
**改动**（`NianchuChat.tsx` + `.scss`）：
1. 消息悬停（或键盘 focus-within）出现操作条：助手「复制 / 重新生成」，用户「复制 / 编辑重发」；复制成功后按钮回执「已复制」1.2s，剪贴板 API 被拒时回退 `execCommand`，两者都失败才报错。
2. 「重新生成」= 截断到该助手消息之前，用**同一条用户消息**真再调一次模型（不追加重复提问）；「编辑重发」= 回填输入框并截断该条及其后，等价于从这句重新开始。
3. 模型展示名映射：`group/auto-claude-sonnet-5-5` → `Claude Sonnet 5.5`（完整 id 放 `title` tooltip）。
4. 脚注去重：只保留「本会话累计 N tokens」，明细（输入/输出）放 `title`；避免与消息级 `in/out` 重复。
**证据（CDP 端到端，`temp/cdp-actions.mjs`）**：
- 复制：按钮文本 `复制 → 已复制`；`navigator.clipboard.readText()` 读回内容与回复前 40 字一致；`errAfterCopy=null`。
- 重新生成：点击后 `duringRegen={typing:true, assistant:0, user:1}`（先撤旧回复、不重复提问）；完成后 `assistant=1,user=1`，文本与首次不同（幂等定义换了表述）→ 真调模型而非贴旧文。
- 编辑重发：`afterEdit={input:"用一句话说明什么是幂等", assistant:0, user:0}`（回填 + 截断）。
- 截图：`evidence/improve-actions-assistant.png`（悬停操作条 + `Claude Sonnet 5.5 · in 77 / out 61`）、`improve-actions-copied.png`（已复制回执）、`improve-actions-user.png`（用户侧 复制 / 编辑重发）。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（2m48s，type-check + vite 通过）。
**记分影响**：D-实用 P4（消息级操作）从 0 → 对齐主流；D-美观 V2（元信息可读性）提升。

## 批次 G · 会话历史（真实 list_sessions + 搜索 + 切换）
**对标**：Qoder / WorkBuddy / Cursor 侧栏的会话列表 —— 关掉面板或刷新后能回到旧会话，而不是只能从零开始。
**问题**（`design-nianchu-panel.md` P0#2）：原来只有「＋ 新对话」，**没有任何历史入口**，历史会话（宿主 `list_sessions`/`get_session` 本来就有）在界面上完全不可达。
**改动**（`NianchuChat.tsx` + `.scss`）：
1. 头部加时钟图标「历史会话」按钮，展开浮层：搜索框 + 会话列表（会话名 / 条数 / 相对时间，当前会话高亮）。
2. 点一条 = **真读** `get_session` 替换消息区（历史消息也带 `model`/`usage`，切换后元信息照常显示）；空查询按名字过滤，无结果给空态。
3. 浮层点外部 / Esc 关闭（用 `closest('[data-history-toggle]')` 排除开关按钮，避免「点开关又立刻被关」）。
4. 会话数上限 60 条（本机实测已有 900+ 段历史），超出显示「共 N 条，仅显示最近 60 条」，避免一次渲染上千 DOM。
5. 发完一轮会话名/条数/时间会变，`refreshSessions()` 顺带刷新列表。
**证据（CDP 端到端，`temp/cdp-history2.mjs`）**：
- 造 A（熔断）/B（降级）两段会话 → 开历史：`count=903`、`hint="共 903 条，仅显示最近 60 条"`，首条 `data-current='1'`。
- 搜索「熔断」→ `filteredNames=["历史验收A：用一个词…熔断",…]`；点击该条 → `closed=true`（切完自动收起）→ 消息区 `first="历史验收A…熔断"`、`users=1 / assistants=1`、`modelLine="Deepseek · in 67 / out 106"`（历史模型与用量完整还原）。
- 截图：`evidence/improve-history-open.png`（浮层+搜索+列表）、`improve-history-search.png`（过滤）、`improve-history-switched.png`（切换后渲染）。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（3m38s）。
**记分影响**：D-实用 P5（可恢复/回看）从 0 → 对齐主流（补上「无历史入口」这个 P0）。

## 批次 H · 停止生成（真的中断在途请求）
**对标**：Claude / ChatGPT / Cursor 生成中都有「停止」；念初原来 `busy` 时只是把发送键 disabled，长回答只能干等。
**问题**：不只是少个按钮 —— 宿主侧 `submitTurn` 没有 `AbortSignal`，即使前端「停止」也停不掉在途 fetch，后台会继续烧 token 并最终把回复补上，属于假停止。
**改动**：
1. `runtime.mjs`：`ACTIVE_TURNS`（runToken→AbortController）；`interruptTurn(token)` 真 abort；`submitTurn` 接受 `runToken`、把 signal 传给 `callWithFailover`，被中断时落 `turn-interrupted` 记录并返回 `state:'INTERRUPTED'`。
2. `requestGateway`：`signal.aborted` 时立即返回 `ABORTED`，不再按瞬时错误退避重试（否则「停止」还要再等两轮）。
3. `models.mjs`：故障转移链在 abort 后**不再换下一个模型**继续烧 token。
4. `methods-agent.mjs`：新增 `interrupt_dialog_turn { runToken } → { aborted }`（找不到就如实 false）；方法总数 120→121（`架构.md` 同步）。
5. `NianchuChat.tsx`：发消息前生成 runToken 随请求带上；busy 时发送键换成**方形停止键**；停止后显示中性灰「已停止生成 / INTERRUPTED」（不当成红色错误）。
**证据（CDP 端到端，`temp/cdp-stop.mjs`）**：
- 发一条长生成请求 → `stopButtonVisible=true`，原发送键消失（`sendButtonGone=true`）。
- 点停止 → `stoppedInMs=207`（0.2s 内 typing 消失）；`systemMessages=["已停止生成"]`、`states=["INTERRUPTED"]`、`assistants=0`。
- 再等 6 秒：`lateCheck={assistants:0, typing:false}` —— **没有迟到的回复补上来**，证明是在途请求被真正 abort，不是前端假装停。
- 截图：`evidence/improve-stop-busy.png`（方形停止键）、`improve-stop-done.png`（已停止生成 / INTERRUPTED）。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（2m22s）；宿主 `node --check` 四个改动文件全 OK，`ws-host.mjs` 32686B < 32KB。
**记分影响**：D-实用 P3/P5（中断与状态可见）从 0 → 对齐主流；「停止」是**功能设计**层面的真能力，不是痕迹。

## 批次 J · 视觉令牌统一（面板紫 → 应用 accent）+ 状态条降级
**对标**：Qoder / Cursor / Claude 的对话面板都跟应用同一套主题令牌；念初面板原来自己一套紫色（头像渐变 `#a06bff→#7c3aed`、用户气泡 `#f1eaff`、助手左线 `rgba(148,94,255,.28)`、发送键 `#7c3aed`），和左侧设置页的中性 accent 明显不是一套；另外状态条常驻「宿主 121 个方法 · 插件 v1 · 免构建加载」，是开发期调试信息。
**改动**：
1. `NianchuChat.scss` 顶部声明 `--ncc-*` 局部变量，全部指向应用主题令牌（`--openbitfun-color-accent-default / surface-panel / content-primary / content-muted / border-subtle / border-default / action-secondary-background / action-neutral-surface*`），带兜底值；头像、发送键、用户气泡、助手左线、focus 环、chips、sug/history 选中态全部改用变量。
2. `ui-plugins/status-bar/index.js`：把「宿主 N 个方法 · 插件 v1 · 免构建加载」收成右侧小胶囊「● 扩展已加载」，具体数字进 `title` 悬浮提示；样式挂 `<head>` 并在 unmount 时移除，改用同一套主题令牌。**插件热更新能力保留**（改文件刷新即生效，无需构建）。
**证据（CDP 计算样式 + 截图，`temp/cdp-visual.mjs`）**：
- 令牌：`accent=#101a27`、`panel=#ffffff`、`scheme=light`。
- 计算样式：`avatarBg=rgb(16,26,39)`（=accent）、`userBubbleBg=rgb(243,243,245)`、`assistantBorder=rgba(16,26,39,.15)`、`panelBg=rgb(255,255,255)`。
- **紫色残留扫描 `purpleHits=[]`**（对面板内所有元素的 color/background/border/shadow 匹配 `124,58,237 / 148,94,255 / 7c3aed`，0 命中）。
- 状态条：`text="扩展已加载"`，`title="宿主 121 个方法 · 插件 status-bar v1 · 免构建加载（改 ui-plugins/ 刷新即生效）"`。
- 截图：`evidence/improve-visual-tokens.png`（统一后的面板 + 右上角胶囊）、`improve-visual-tokens-hover.png`（悬停工具栏同套中性色）。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（2m17s）。
**诚实边界**：暗色主题本次**未截图验证** —— 主题变量是 JS 运行时写入的，手动改 `data-color-scheme` 不会重算；已确认面板颜色全部引用主题令牌（理论上跟随主题），但「暗色下好看」这件事仍未取得证据，记为 UNKNOWN，后续用设置→外观切换后补图。
**记分影响**：D-美观 V3（一致性）明显提升；V4（主题）从硬编码 → 令牌化，但暗色未验证。

## 批次 K · 暗色主题实测 + 面板剩余硬编码色令牌化
**背景**：批次 J 把主要控件换成主题令牌，但只验证了浅色；本轮补暗色证据，并把面板里剩余的 `rgba(29,33,41,α)` / `rgba(0,0,0,α)` 全部令牌化 —— 否则暗色下元信息、边框、占位符会变成「深底深字」。
**改动**（`NianchuChat.scss`）：文本色 → `--ncc-text / --ncc-text-muted / field-placeholder / content-disabled`；边框 → `--ncc-border-subtle / --ncc-border-base`；中性填充 → `--ncc-element-base/medium`；阴影 → `--openbitfun-shadow-xs/menu/overlay`；错误/成功 → `--openbitfun-color-status-danger-* / status-success-content`。剩余字面量只作为 var() 的兜底值。
**证据（CDP 计算样式 + 截图，`temp/cdp-theme-check.mjs`、`temp/cdp-dark2.mjs`、`temp/cdp-light.mjs`）**：
- 通过真实设置路径切换：设置 → 外观 → 内置主题 → 「暗色」（选项实测：跟随系统/浅色/黑白撞色/石板灰/暗色/午夜/墨韵/墨夜/赛博/东京夜）。
- 暗色实测：`scheme=dark`、`panelBg=rgb(28,28,31)`、`panelText=rgb(232,232,232)`、`metaColor=rgb(133,133,133)`、`usageColor=rgb(133,133,133)`、`boxBorder=rgba(255,255,255,0.18)`、`headBorder=rgba(255,255,255,0.12)`。
- 切回浅色：`scheme=light`、`panelBg=rgb(255,255,255)`、`panelText=rgba(0,0,0,0.8)`。
- 截图：`evidence/improve-theme-dark.png`（暗色下的面板：深底、浅字、蓝调用户气泡）、`improve-theme-light.png`。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（3m18s）。
**仍未解决（如实记录）**：暗色下**中间神经图画布仍是白底**（`NeuronHomeScene.scss` 的 `--nhn-*` 仍是硬编码浅色，且 G6 的 `labelFill:#3b4252 / labelStroke:#ffffff` 也写死），需要把画布与图样式一起令牌化并处理「切主题后重绘」，属于独立批次，不在本轮冒充完成。
**记分影响**：D-美观 V4（主题）从「令牌化但未验证」→ **浅/暗双主题均有实测证据**；场景画布仍记为缺口。

## 批次 L · 动手模式 + 工具卡片（主 agent 真能读写文件/跑命令）
**对标**：Qoder / Cursor / Claude Code 的**工具流**——每一步工具调用都有卡片（工具名、参数、耗时、成功/失败、可展开看输出）。念初之前主 agent 只会纯对话，`run_task` 的读写文件能力藏在另一个入口，界面上看不到工具流。
**改动**（`NianchuChat.tsx` + `.scss`）：
1. 输入区加「对话 / 动手」切换（默认对话；动手有独立 placeholder 提示「可读写文件 / 执行命令」）。
2. 动手模式走宿主 `run_task`（复用既有 `runWithTools` 循环：tool_use → 执行 → tool_result，最多 8 步），把返回 `transcript` 里 `kind==='tool'` 的步骤渲染成卡片：状态点（成功绿/失败红）、工具名、参数摘要（优先 path/command）、耗时、点开看完整 JSON 输出。
3. 失败如实显示宿主 `state/reason`；不做「假装调用」的装饰卡。
**证据（CDP 端到端，`temp/cdp-do.mjs`）**：
- 切到动手：`modeButtons=["对话","动手"]`，placeholder 变为「让念初动手（可读写文件 / 执行命令）」。
- 发「读取 README.md 的前 5 行，并告诉我第一行是什么」→ 真实工具卡：`tool=read`、`arg={"file_path":"README.md","limit":5}`、`ms=1ms`、`ok=1`。
- 展开卡片：真实输出 `{ok:true, file_path:"D:\\file\\AI Temp\\DeepSeek\\Agent自研\\README.md", total_lines:66, offset:1, limit:5, ...}`。
- 回答引用真实文件内容：「第一行是：# 念初 · 本地 AI agent 工作台（文件共 66 行）」；`err=null`。
- 截图：`evidence/improve-do-mode.png`（模式切换）、`improve-do-result.png`（工具卡 + 回答）、`improve-do-expanded.png`（展开输出）。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（2m15s）。
**记分影响**：D-实用 P2（信息密度）/ D-功能 F1（核心闭环：真能动手）显著提升；工具流从「无」→ 有真实卡片，是 Qoder 最突出的可视化能力。

## 批次 M · 神经图场景跟随主题（补上暗色下「中间白底」）
**问题**：批次 K 之后对话面板已跟随主题，但**首页神经图画布在暗色下仍是白底**：`NeuronHomeScene.scss` 的 `--nhn-*` 全是硬编码浅色，`.nhn__flow` 写死 `#ffffff`；更关键的是 G6 画在 canvas 上，`labelFill:#3b4252 / labelStroke:#ffffff / stroke:#ffffff / shadowColor / edge` 也都是初始化时写死的浅色值，改 CSS 变量不会重绘。
**改动**：
1. `NeuronHomeScene.scss`：`--nhn-bg/surface/line/fg-*/primary*` 全部映射到主题令牌（`surface-scene / surface-panel / border-subtle / content-primary/secondary/muted/disabled / accent-default`），`.nhn__flow` 背景改 `var(--nhn-surface)`；状态徽标（PASS/WARN/UNKNOWN）改用 `status-success/warning-*` 与 `surface-subtle`。
2. `NeuronHomeScene.tsx`：新增 `readThemeColors()` 从计算样式读令牌；G6 的 `labelFill / labelStroke / node stroke / shadowColor / selected stroke / edge stroke` 全部改用读到的值；新增 `MutationObserver` 监听 `<html data-color-scheme / data-openbitfun-appearance*>`，主题切换时递增 `themeRev` 触发**重建图**（canvas 不会自己改色）。
**证据（CDP，`temp/cdp-scene-theme.mjs`）**：
- 浅色：`sceneBg=rgb(255,255,255)`、`flowBg=rgb(255,255,255)`、`sceneText=rgba(0,0,0,0.8)`。
- 切「暗色」：`scheme=dark`、`sceneBg=rgb(28,28,31)`、`flowBg=rgb(28,28,31)`、`barBg=rgb(28,28,31)`、`sceneText=rgb(232,232,232)`。
- 切回「浅色」：全部恢复白底/深字（可逆）。
- 截图：`evidence/improve-scene-dark.png`（暗色下画布、标签、连线都可读）、`improve-scene-light.png`。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（1m52s）。

## 批次 N · 工具步骤流式推送（工具卡边跑边出）
**问题**：批次 L 的工具卡是 `run_task` **跑完才一次性出现**，长任务期间界面只有「念初正在回复…」——和 Qoder/Cursor 的逐条工具流差距明显。宿主其实早就通过 `agent/frontendEvent` 推送 `nianchu://agent-step`（ws-host 的 `notify`），只是前端没订阅。
**改动**（`NianchuChat.tsx`）：动手模式改为「先订阅再发请求」——`api.listen('nianchu://agent-step')` / `api.listen('nianchu://agent-answer')`，用 `runToken` 过滤别的运行；先插入一条 `state:'RUNNING'` 的占位助手消息，每来一步就追加一张工具卡；`run_task` 返回后把占位消息替换成最终结果（`finalText` + 完整 `steps` + `usage`），失败则撤掉占位并落系统消息。
**证据（CDP 端到端，`temp/cdp-stream.mjs`）**：
- 发多步任务（读 README + 统计 tools/agent 的 .mjs）→ 采样序列里出现 `busy=true` 且 `steps>=1` 的中间态：**`sawStepsWhileBusy=true`、`maxStepsDuringRun=6`**（边跑边出，不是跑完才有）。
- 运行中截图：`evidence/improve-do-stream-mid.png`（`read` 绿点 1ms、`bash` 红点 28ms 失败也如实标红，底部仍在「念初正在回复…」+ 停止键）。
- 完成：6 张工具卡，回答引用真实数据（README 前 3 行 + `tools/agent` 下 **53 个 .mjs**），`err=null`；截图 `improve-do-stream-final.png`。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（1m10s）。
**记分影响**：D-实用 P2/P3（信息密度、过程可见）与 D-功能 F2（差异化：真工具流）继续提升；工具流从「跑完才见」→「边跑边见」。

## 批次 O · 文件变更卡（行内 diff，对标 Cursor / Qoder）
**问题**：动手模式能改文件，但界面上只看到「工具执行成功」，**改了哪些文件、加了几行、具体 diff 是什么**完全看不到 —— 这正是 Qoder/Cursor 最核心的可视化。
**改动**（`NianchuChat.tsx` + `.scss`）：
1. 捕获 `run_task` 返回的 `changeSet`（真实前后快照对比：`files[{path,status,added,removed,lines[{type,text}]}]`）。
2. 助手消息下方渲染「变更 N 个文件 +X −Y」+ 逐文件可展开的行内 diff（`+` 绿底 / `-` 红底 / 上下文灰字），路径只显示末 3 段（完整路径在 title），最多 20 个文件、每文件 200 行，避免撑爆。
3. 颜色用 `--openbitfun-color-code-change-added/removed` 令牌，暗色同样可用。
**证据（CDP 端到端，`temp/cdp-diff.mjs`）**：
- 动手任务「在 temp/ 下创建 round12-demo.txt，三行 alpha/beta/gamma」→ 工具卡 `write ok=1`（另有 bash 失败卡如实标红）。
- 变更卡：`diffHead="变更 1 个文件+3−0"`；文件 `…/Agent自研/temp/round12-demo.txt`、`status=added`、`+3 −0`。
- 展开行：`add alpha` / `add beta` / `add gamma`（真实文件内容，磁盘上确实生成了该文件）。
- 回答给出绝对路径与字节级核对（17 字节 `61 6c 70 68 61 0a …`）；`err=null`。
- 截图：`evidence/improve-diff-card.png`。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（2m19s）。
**记分影响**：D-功能 F1/F2（真改文件 + 可见 diff）达到 Qoder 同级可视化；D-美观 V2 信息层级更完整。

## 批次 P · 竞品功能档案补全：Qoder 审批 / 工具参数 / 变更撤销（源码级）
**目标**：goal 要求「解析每一项功能设计」，此前 Qoder 档案只到首页与文案聚类，审批与撤销两块是空的。
**做法（可复算）**：在解包产物 `research/qoder-renderer/out/renderer/assets/*.js` 里按中文字串定位并取上下文（`temp/qoder-strings.mjs`），把真实组件属性与文案写进 `qoder.md` §6。
**关键事实**：
- 审批卡按钮：`取消` / `始终允许` / `允许一次`（`Button variant=outline|primary, rounded=pill`）。
- 审批卡字段：`product / operation / scope / riskLevel(低/中/高) / toolArguments / allowOnce / allowSession / allowAlways / configLink`，并提供 `explain 解释` 与 `analyzingIntent 正在分析操作意图...`。
- 任务级授权：`rules allow/deny/ask`、`directories 本次任务始终允许访问“{{scope}}”`、`mode 本次任务使用“{{mode}}”模式`。
- 变更撤销：`文件撤销交互` 埋点参数含 `{ changeSetId, conversationIsWorking, undoPreparingId }`，`blocked` 分支说明「会话正在跑」时撤销会被挡住。
**结论（诚实）**：审批闸是念初**按既定边界有意不做**的（`tools/agent/verify-a15-approval.mjs` 钉住），因此**不记「平」**，也不做假弹窗；但「按 changeSet 撤销」是可对齐的真能力 —— 见批次 Q。

## 批次 Q · 变更撤销（对齐 Qoder 的 changeSet undo）
**问题**：批次 O 能看见 diff，但**改错了只能手动改回去**；宿主其实早有 `rollback_change`（按 changeSet 恢复文件），界面没接。
**改动**（`NianchuChat.tsx` + `.scss`）：助手消息记录 `changeSetId`；变更卡头部加「撤销」按钮（busy 时禁用），点击调 `rollback_change { changeSetId }`；成功置「已撤销」（绿色）并移除按钮，失败如实提示原因（不假装成功）。
**证据（CDP 端到端，`temp/cdp-undo.mjs`）**：
- 动手创建 `temp/round13-undo.txt` → 变更卡「变更 1 个文件 +1 −0 撤销」，`hasUndo=true`，磁盘 `fileBeforeUndo=true`。
- 点「撤销」→ `rolledLabel="已撤销"`、`undoGone=true`、`err=null`，磁盘 `fileAfterUndo=false`（文件真的被删除）。
- 截图：`evidence/improve-undo-before.png`、`improve-undo-after.png`。
- 构建：`pnpm --dir src/web-ui run build:web` ✓。
**顺带修**：`run_task` 不带 usage 时元信息会显示 `in ? / out ?`，改为仅在真有 token 数时显示。

## 批次 R · 会话管理（重命名 / 删除）+ 条数口径修正
**对标**：Qoder / WorkBuddy / Cursor 的历史列表都能重命名与删除；念初批次 G 只能切换，列表里还堆着大量「新会话 1 条」的空壳（因为把 meta/system 记录也计入了条数）。
**改动**：
1. 宿主 `runtime.mjs`：新增 `renameSession`（追加 `meta type=session-renamed`，索引重建后仍生效）与 `deleteSession`（删 jsonl 真源）；`rebuildIndex` 优先取最后一次改名，且**只把 user/assistant 计入条数**（空壳会话自然从列表消失）。
2. 宿主 `methods-agent.mjs`：新增 `rename_session` / `delete_session`；`ws-host` 补 `agent/renameSession` / `agent/deleteSession` 别名（前端适配器就是这么发的，第一版没加别名 → 报「尚未实现该方法」，如实暴露后补上）。
3. UI：历史行悬停出现「重命名 / 删除」；重命名是内联输入（Enter 保存 / Esc 取消），删除需二次确认（确认删除 / 取消），删的是当前会话时清空消息区。
**证据（CDP + 磁盘核对，`temp/cdp-session-mgmt.mjs`）**：
- 重命名：点「重命名」→ 输入框带出原名 → 改成「重命名验收-13」→ 保存后列表首条变为该名；磁盘上含该名的 jsonl 文件 `fileWithNewName=1`。
- 删除：点「删除」→ `confirmVisible=true`（二次确认）→ 点「确认删除」→ `fileWithNewNameAfter=0`、`filesAfter=915`（`filesBefore=916`，少了一个文件）、`err=null`。
- 条数口径：修正后列表不再出现「新会话 1 条」，首屏是真实对话（`历史验收B…`、`历史验收A…` 等）。
- 截图：`evidence/improve-session-rename.png`（内联改名）、`improve-session-delete-confirm.png`（二次确认）、`improve-session-deleted.png`。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（1m34s）；`ws-host.mjs` 32734B < 32KB。
**记分影响**：D-实用 P5（可恢复/可管理）补齐重命名与删除，历史列表不再被空壳污染。

## 批次 S · 图片附件（粘贴 / 拖入 / 选择文件，真·多模态）
**对标**：Claude / ChatGPT / Cursor 都能把图片拖进输入框直接问；念初之前只能打字。
**前置事实（先验证再动手）**：直接探网关 `group/deepseek` 的 `image_url` 多模态负载 → 200 且能回答颜色；`auto/mimo-v2.6-flash` 也 200。所以这是**真能力**，不是画个缩略图装样子。
**改动**：
1. `runtime.mjs`：`submitTurn` 接受 `images`（data URL），只把图片挂到**本轮最后一条 user 消息**（`content` 变成 `[{type:'text'},{type:'image_url'}...]`）；历史里不存 base64（避免会话 jsonl 膨胀），因此**回看历史只有文字**，这一点如实说明。
2. `ws-host` 的 `dialogTurn` 透传 `images`。
3. UI：输入框支持**粘贴图片**、**拖拽到输入区**、**点回形针选文件**；缩略图可单张移除；限制「最多 4 张 / 单张 ≤4MB / 仅图片」，超限如实报错；只有图片没文字也能发送；动手模式禁用附件并提示原因（工具读不了 data URL）。
**证据（CDP 端到端，`temp/cdp-image.mjs`）**：
- 用 canvas 造 64×64 纯红 PNG 塞进 file input → `thumbs=1`，`src` 前缀 `data:image/png;base64,…`，`sendEnabledWithoutText=true`。
- 发送后 `thumbsAfterSend=0`（附件已清空）；模型回答 **"深红色"**（真读了图）；元信息 `Deepseek · in 259 / out 80`；`err=null`。
- 截图：`evidence/improve-image-attached.png`（缩略图 + 回形针）、`improve-image-reply.png`（带图提问后的回答）。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（1m54s）；`ws-host` 32758B < 32KB。
**记分影响**：D-功能 F1（多模态输入）从「无」→ 可用；D-实用 P1/P2 提升。

## 批次 T · 回到最新 + 导出 Markdown
**对标**：ChatGPT / Claude 在长对话里往上翻时会出现「回到最新」，并支持把会话导出成 Markdown；念初原来只能手动滚、内容也拿不出去。
**改动**：
1. `NianchuChat.tsx`：`atBottom` 状态 + 滚动监听（距底 <80px 视为贴底）；**只有贴底时才自动跟随新消息**（用户往上翻不会被抢滚动位置）；离开底部时右下角出现「↓ 回到最新」，点击平滑回到底部并自动隐藏。
2. 头部新增「导出为 Markdown」：把当前会话拼成 `# 会话名 / ## 用户 / ## 念初 / ### 工具调用 / ### 文件变更` 的 Markdown，用 Blob 触发浏览器下载（文件名带日期时间）。
**证据（CDP 端到端，`temp/cdp-scroll-export.mjs`）**：
- 长回答后 `overflow=387`（可滚动）；滚到顶部 → `toBottomVisible=true`、`scrollTopAtTop=0`。
- 点「回到最新」→ `scrollAfterClick=0`（已贴底）、`toBottomGone=true`。
- 导出：`Browser.setDownloadBehavior` 指向 `temp/dl`，点导出后真的落盘 `念初会话-20261122-0355.md`（895 字节），内容含 `## 用户` / `## 念初`，开头是会话标题与导出时间。
- 截图：`evidence/improve-to-bottom.png`（回到最新按钮）、`improve-export-md.png`。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（2m13s）。
**记分影响**：D-实用 P2/P5（长对话可用性、内容可带走）提升；这是「会话资产能拿走」的实能力。

## 批次 U · 会话内搜索（定位 + 计数 + 上/下跳转）
**对标**：ChatGPT / Claude 的会话内搜索（输入关键词跳转到那条消息并显示 `n / m`）；念初的会话能长到几十轮，只能靠肉眼翻。
**改动**（`NianchuChat.tsx` + `.scss`）：头部放大镜打开搜索条；命中判定 = 正文或**工具参数**里包含关键词（大小写不敏感）；显示 `n / m`；↑/↓ 与 Enter/Shift+Enter 跳转；无匹配显示「无匹配」并禁用跳转；Esc 关闭；命中消息只加**外环高亮**（`data-hit`），不改写 Markdown DOM。
**关于快捷键（如实说明）**：最初接的是文档级 Ctrl+F，但本机实测**合成键事件到不了 React 根处理器**（`document.dispatchEvent`/`Input.dispatchKeyEvent` 都测过，连自建探针都收不到，说明被浏览器或应用级快捷键层先吃掉）。为了不写「看起来有、其实不触发」的代码，**移除全局劫持**，只保留可验证的入口：头部按钮 + 输入框内 Enter/Esc。这一点在代码注释里也写清了。
**证据（CDP 端到端，`temp/cdp-search.mjs`）**：
- 点放大镜 → `barVisible=true`。
- 搜「苹果」→ `1 / 2`，命中消息正文含「用一句话解释「苹果」这个词的含义」；搜「香蕉」→ `1 / 2`，命中的是另一条（证明是真实过滤，不是写死）。
- 搜「的」→ `1 / 4`；按 Enter → `2 / 4`（跳转生效）。
- 搜「不存在的词zzz」→ `无匹配`、`nextDisabled=true`；按 Esc → `closedByEsc=true`。
- 截图：`evidence/improve-search-apple.png`（命中环 + 计数）、`improve-search-next.png`。
- 构建：`pnpm --dir src/web-ui run build:web` ✓（1m28s）。
**记分影响**：D-实用 P2/P5（长会话找得到、可定位）提升。

## 批次 V · `/` 技能面板分类 + 描述（186 项可导航）
**对标**：Qoder / Claude 的斜杠指令面板会**分组**并带一行说明；念初上一版把 186 个技能平铺，只能靠「记得名字」去搜——等于没有目录。
**改动**（`NianchuChat.tsx` + `.scss`）：
1. 技能清单从宿主 `get_skill_configs` 取 `name + description`（原来只取名字），按名字里的稳定词根归到 12 个分类（`skillCategory()`），**找不到就落「其他」——宁可少归也不归错**。
2. 面板按分类排序并渲染**粘性分组头**，每项显示「等宽名字 + 一行灰描述」；描述**参与搜索**（描述里写的是「什么时候用」，比名字好找）。
3. 面板最高 340px 可滚，键盘 ↑↓ 仍是**扁平有序**（跨组不跳），回车填入、Esc 关闭。
**证据（CDP，`temp/cdp-skills.mjs`）**：
- 输入 `/`：`head="技能 / 指令 · 共 186 项（仅示前 50，继续输入筛选）"`，`itemCount=50`，分组头 `["安全与合规","测试与质量","记忆与上下文","技能与代理","架构与设计"]`。
- 每项都带真实描述（例：`/audit-log` → 「设计审计日志：记什么、不可篡改、保留与查询，满足合规与追责。当用户要「操作审计」…」）。
- 输入 `/wri`：`filterHead="技能 / 指令 · 共 3 项"`，命中 `/test-writing`、`/read-write-split`、`/doc-write`（**描述命中**，三个名字都没有 wri）。
- 输入 `/rollback`：`["/changeset-rollback","/rollback-plan"]`（名字命中）。
- 键盘：连按 ↓ 三次 → `selectedIdx=3`、`selectedName="/guardrails"`；点选后 `input="/guardrails "`、`sugGone=true`。
- 截图：`evidence/improve-skill-cats.png`（分组 + 描述）、`improve-skill-filter-desc.png`（描述命中过滤）。
- 类型检查：`tsc --noEmit -p src/web-ui/tsconfig.json` 仅剩 3 条**既有** `@/generated/api` 缺失错误；`vite build` ✓（1m21s）。

## 批次 W · `@` 引用真实工作区文件（内容真进上下文）
**对标**：Cursor / Qoder 的 `@` 文件引用——打 `@` 出**真文件**菜单，选中变芯片，发送后文件内容进模型上下文（不是只把路径塞进 prompt 让模型瞎猜）。
**改动**（新增 `tools/agent/workspace-files.mjs`；`NianchuChat.tsx` + `.scss`；`runtime.mjs` / `methods-agent.mjs` / `ws-host.mjs` 透传）：
1. **清单来源用 `git ls-files`**（自带 `.gitignore` 语义、比走盘快一个数量级）；不是 git 仓库/子进程被禁 → 回退递归走盘，跳过 `node_modules` 等。只列真存在的文件，`..` 出界一律拒绝（否则 `@` 就是任意文件读取口）。
2. **两段式过滤**：空查询用挂载时缓存的浅层路径（本地即时）；有查询词**交给宿主过滤**（仓库一万多个文件，本地只缓存 200 条会漏），序号自增丢弃过期响应。
3. **对话模式挂附件**（`files` 经 `dialogTurn` → `submitTurn` → `readContextFiles` 读成 `<file path>` 块拼到**本轮** user 消息）；**动手模式只填路径**。历史里只存路径不存内容（否则 jsonl 线性膨胀）。
4. 面板顶部固定 `@当前会话` / `@相关记忆` 两项上下文；已发送消息下渲染文件回执芯片（等宽文件名，`title` 为完整路径）。
**证据（CDP，`temp/cdp-w-final.mjs` 重跑）**：
- `@` 面板：`head="添加上下文 · 共 202 项（仅示前 50，继续输入筛选）"`，`ctxItems=["@当前会话","@相关记忆"]`，`fileSample=[".gitignore",".host-config.json",".host-usage.json",".npmrc",".tmp-serve-static.cjs"]`（**都是真文件**）。
- 输入 `@workspace-files`：`共 1 项` → `["tools/agent/workspace-files.mjs"]`（宿主过滤命中深层文件，本地缓存里没有）。
- 选中 → composer 芯片 `title="tools/agent/workspace-files.mjs"`，输入框清空；发送后气泡回执 `bubble files=["tools/agent/workspace-files.mjs"]`。
- **内容真进上下文**：问「readContextFiles 单文件上限是多少？只答数字」→ 模型回 `"61440"`（=60KB，与源码 `maxEach` 一致；没读到就答不出）。
- `error banner=null`、`errors=[]`、发送后 composer 芯片清空。
- 截图：`evidence/improve-at-panel.png`（菜单）、`improve-at-chip.png`（芯片）、`improve-at-result.png`（回执 + 回答）、`improve-at-file.png`。
- 构建：`vite build` ✓；`tsc --noEmit` 仅剩 3 条**既有** `@/generated/api` 缺失错误。

## 批次 X · 计划图层（todo_write + 计划面板）+ 子代理卡片
**对标**：Qoder 计划面板；dsh `packages/todo/tool-todo` 的 `todo/write` 整表快照契约。
**问题**（见 `scorecard.md` 美观栏）：「计划图层 / 子 Agent 可视化」是 4.2 vs Qoder 4.3 的缺口之一。长任务跑起来界面只能显示「正在执行」——不知道做到第几步、还剩什么。
**改动**（`tools/agent/toolkit.mjs` / `loop.mjs` / `tools/hostapi/ws-host.mjs` / `NianchuChat.tsx` + `.scss`）：
1. 新增 `todo_write` 工具：**整表替换**（不是追加）、三项状态、同时最多一项 `in_progress`；非法状态/空项/重复/多项进行中/超长全部**拒绝并给出可读原因**，不静默纠正（静默纠正会造出「看起来对、和模型想的不一样」的计划，比不显示更糟）。
2. 循环侧取**最后一次成功**提交作为 `run.plan`：不累加（整表语义会重复）、失败那次不算（没生效）、从没写过则 `null`（界面不渲染空面板）。
3. 宿主单独推 `nianchu://agent-plan`（整份清单）：`agent-step` 的 input 是截断预览，计划项多了会被切、界面会显示**缺项**的计划。
4. **修掉一个真 bug**：原来 `JSON.parse(JSON.stringify(input).slice(0,1200))` 是先序列化再按字符截断 —— 截出来不是合法 JSON，`JSON.parse` 抛异常会打穿 `onStep` 连带 `run_task` 失败；任何 >1200 字符的 `write` 都能复现。改成 `previewInput()` 按字段安全截断。
5. 计划面板：`已完成/总数` + 进度条 + 清单；**三重编码**（符号 ✓/●/○ + 颜色 + 删除线），不只靠颜色；`todo_write` 不再重复出现在工具卡里；导出 Markdown 变成 `- [x]` 复选框。
6. 子代理卡片：`spawn_subagent` 步骤标题显示「子代理」、摘要显示任务描述（`stepArgText` 键序加 `task`，放最后）。
**证据**：
- 判据脚本 `node tools/agent/verify-plan.mjs` → **22/22 PASS**：工具形状 3、正常提交 6、反例 7（非法 status / 空 content / 重复 / 两项进行中 / 非数组 / 超长 / 空清单不算完成）、整表替换 1、循环快照 5（含「失败提交不覆盖有效计划」「没写计划时 plan=null」，用假网关跑真 `runWithTools`，不烧模型）。
- 产品服务器（47124，真模型）任务「分三步…开始前先用 todo_write 写计划」：`planPanels=1`、`sawPlanWhileBusy=true`（**跑的过程中就出现**）、三项全 `completed`、`planCount="3/3"`、`barWidth="100%"`、`todoWriteInCards=false`、工具卡 `["read","bash","bash","glob","bash","bash"]`、`err=null`、`errors=[]`。
- 第二组「先写两条计划再做完」→ `计划 2/2` 全绿 + 删除线 + 满进度条 + 真实工具卡。
- 截图：`evidence/improve-plan-mid.png`（0/3，首项 ● 进行中、后两项 ○）、`improve-plan-final.png`（3/3）、`improve-plan-light.png`（2/2）、`improve-product-home.png`、`improve-product-todos.png`、`improve-product-scenes.png`。
- 构建 `vite build` ✓；`tsc --noEmit` 仅剩 3 条既有 `@/generated/api` 缺失错误。
**如实边界**：
- 子代理卡片**只有代码、没有端到端证据**：实测模型收到「用 spawn_subagent」后先去 bash 找工具，最后 `Request timeout`，没产生该步骤，所以没有卡片截图。不记为已验证。
- 暗色下的计划面板**没有有效证据**：我试的 `data-theme="dark"` 不是本应用的切换机制（实测切完背景仍是浅色令牌），有效的暗色入口这轮没找到，不当作已验证。
**部署坑（记下来）**：改完宿主侧工具必须**重启宿主进程**。第一次端到端时模型总结里写「环境里没有 todo_write」，不是幻觉——预览服务器 05:17 启动，而工具 06:23 才加进去，跑的是旧代码；重启后同一任务立刻出计划面板。
**记分影响**：D-美观 V2 提升（长任务有计划进度可见）；D-功能 F1 多一个真实计划工具（与 dsh `tool-todo` 契约对齐）。美观 4.2 → 4.3。

## 批次 Y · 上下文用量网格（最近一轮真实装配的窗口占用）
**对标**：Cherry Studio 的「上下文数 / 最大上下文数」+ 对话框工具栏「以彩色网格可视化当前上下文的使用情况」。
**为什么加**：念初输入框上方只有「本会话累计 29937 tokens」这一行——那是**历史总账**（从开篇加到现在的和），回答不了「这一轮还能塞多少」。没有后者，用户看不到上下文压力，也不知道什么时候该开新会话，只能等模型突然开始丢信息。Cherry 用网格回答的正是这个问题。
**改动**（`contextUsageView.ts` 新增；`runtime.mjs` / `NianchuChat.tsx` + `.scss`）：
1. **`contextUsageView.ts`（90 行纯函数）**：`resolveContextUsage` 从消息数组**倒序**找最近一条带 `context` 的助手消息（最近的才是当前状态）；脏数据一律跳过（非数字 / NaN / 负预算 / `budget <= 0`）。`buildContextUsageView` 算比例、点亮格数、三档（`ok`/`warn`/`danger`，阈值 70% / 90%）。**「用了就至少亮一格」**：向下取整会让「刚过 1%」看起来像 0 格，等于没监控；反过来 0 token 才允许全灭。
2. **`tools/agent/runtime.mjs`**：`submitTurn` 成功时把 `{historyTokens, historyBudget, historyDropped, memoryHits}` **落盘**进助手消息的 `context` 字段。两个关键决定：
   - **复用**：先建 `ctx` 再同时塞进 `appendMessage` 和返回值——同一份数字，不会「界面显示 2400、返回值说 2500」。
   - **`historyBudget` 必须由宿主给**：它是 `buildHistory` 的 `maxTokens`。界面**不能**写死 6000——那是装配侧的默认值，一旦按会话/配置调整，界面就会显示一个假的「用量 / 上限」。这条也写进了 `contextUsageView.ts` 的注释。
3. **`NianchuChat.tsx`**：`Msg` 加 `context`；`get_session` 历史加载和 `start_dialog_turn` 实时返回**都**填（否则切会话/重载后网格消失）；`buildContextUsageView(resolveContextUsage(msgs))`；20 格（2 行 × 10 列）+ 文案 `2,529 / 6,000` + 省略条数；`role="img"` + `aria-label`（读屏用户只需要一个可比较的数）；`title` 说明「最近一轮真正发给模型的历史窗口」+ 省略处的解释。**没有任何一轮数据时不渲染**——不显示「0 / 6,000」的空条假装在监控。
4. **位置**：放在「本会话累计」**之前**。它回答「现在还能塞多少」，比历史总账更该先看到；两个数字挨着，用户能自己对比「这一轮 2.5k vs 本会话 30k」。
5. **`NianchuChat.scss`**：网格空格**从 `--ncc-text-muted` 派生 34% 透明度**，不写死黑/白——6px 方块上写 8% 黑几乎看不见，而写死黑色在暗色主题下又会消失。三档状态同时改格子色、文案色，**文案**在非 `ok` 档也跟着变色（不只靠格子）。
**判据**（`node tools/agent/verify-context-usage.mjs` → **19/19 PASS**）：

| # | 判据 | 结果 |
|---|---|---|
| 1 | 长历史会被裁剪（dropped > 0） | PASS |
| 2 | 裁剪后 token 不超预算 | PASS |
| 3 | elided 计数与 dropped 一致 | PASS |
| 4 | 短历史不裁剪 | PASS |
| 5 | `get_session` 能读回 context | PASS |
| 6 | context **落盘**（不是内存态） | PASS |
| 7 | 三个字段都是数字（界面按名字取值） | PASS |
| 8 | 取到的是**最近**一轮（2400 而非 1234） | PASS |
| 9 | 最近一轮无省略时 dropped = 0 | PASS |
| 10 | 网格点亮数与比例一致（2400/6000 = 40% → 8 格） | PASS |
| 11 | 40% 落在「宽裕」档 | PASS |
| 12 | **反例**：没有 context → null（不显示假进度条） | PASS |
| 13 | **反例**：预算为 0 → null（除零/空条都不显示） | PASS |
| 14 | **反例**：缺 historyTokens → null（不把 undefined 当 0） | PASS |
| 15 | dropped 为负时钳到 0（不显示「省略 -3 条」） | PASS |
| 16 | 70% 转 warn | PASS |
| 17 | 90% 转 danger | PASS |
| 18 | 超预算只亮满格、不越界 | PASS |
| 19 | 省略文案只在 dropped > 0 时出现 | PASS |

单测 `contextUsageView.test.ts` **13 条**（3 个 describe；同一组规则，随 `test:run` 跑）。

**产品实测**（CDP，1600×1000）：网格 8 格点亮，文案 `2,529 / 6,000`；「本会话累计 29937 tokens」在它下面。截图：
- `evidence/screenshots/ctx-usage-foot.png`（面板底部，796×142）
- `evidence/screenshots/ctx-usage-foot-3x.png`（3× 放大）
- `evidence/screenshots/ctx-usage-foot-dark.png`（暗色）
- `evidence/screenshots/ctx-usage-panel.png`（面板全貌，398×898）

**构建**：`vite build` ✓；`tsc --noEmit` 仅剩 3 条**既有** `@/generated/api` 缺失错误（与本批无关）。
**如实边界**：
- 只有**用量网格**，**没做** Cherry 的「自动压缩开/关」——念初的装配侧没有对应开关，做出来就是假开关（点一下什么也不变）。这一条在批次 D 的「未做」里已经记过，本批仍未做。
- 网格是**最近一轮**的占用，不是「当前正在编辑的草稿」。草稿还没发出去，宿主没装配过，没有真实数字可报——不估算。
- `memoryHits` 也一起落盘了（`runtime.mjs` 的 `ctx`），但界面**没显示**它。存着是为了将来「记忆命中」看板能直接读，不用再改一次持久化格式。
**记分影响**：D-美观 V2 提升（上下文压力从「看不见」变成「数得清」）；D-功能 F1 无变化（这是可视化，不是能力）。美观 4.3 → 4.35。

## 批次 Z · 主题模式（浅色 / 深色 / 跟随系统）
**对标**：Cursor / Qoder / Claude 的「设置 → 外观」第一组永远是浅色 / 深色 / 跟随系统；念初只有「内置主题」下拉（十来个皮肤），缺了更前置的那个问题——**我要浅色还是深色**。

**为什么加**：批次 K / M 已经证明了「面板与神经图画布能跟着主题变」，但**没有任何入口能切主题**。用户只能手动改 `data-color-scheme`，而它是 JS 运行期写入的，手改不会重算；也就是说「深色好看」这件事在界面上**不可达**。设置页摆着一排皮肤，却回答不了「我要深色」。

**改动**（新增 `infrastructure/theme-preference/`：`types.ts` / `core/mapping.ts` / `core/ThemePreferenceService.ts` / `hooks/useThemePreference.ts` / `components/ThemePreferencePanel.tsx` + `.scss` / `appearance.ts`；接入 `AppearanceSettingsPage.tsx`）：
1. **三档只翻译成一次外观包选择**：`light`→`openbitfun-light`、`dark`→`openbitfun-dark`、`system`→`system` 哨兵。不自己写 DOM 属性、不自己存配置键——`AppearanceService` 是唯一持有「当前外观包」与持久化的地方，`OpenBitFunDesignSystemProvider` 从 `appearance.current.mode` 落 `data-color-scheme`。写两套状态，迟早出现「面板说深色、DOM 还是浅色」。
2. **反解先看选择 id，再看配色**：`deriveThemeMode` 先判 `system` 哨兵，否则「跟随系统 + 系统当前是深色」会被误判成「固定深色」——**一进设置页就把用户的「跟随系统」改写成固定配色**。自带深色皮肤（`openbitfun-cyber`）按 `current.mode` 归到「深色」档，不按包 id 白名单（白名单每加一个皮肤就要改一次）。
3. **面板**用 WAI-ARIA 单选组（`role="radiogroup"` + `aria-checked`，方向键循环、Home/End 到两端、选中项 `tabIndex=0`），每段同时挂 `data-openbitfun-component` / `data-openbitfun-part` / `data-openbitfun-value`——外观包既能按 part 也能按值改样式。**没用 `@openbitfun/ui` 的 `SegmentedControl`**：它的选项只接受 `value`，挂不上外观契约所需的 part 属性。下面一行 `当前：深色`（`resolvedHint`）回答「跟随系统现在到底是哪种」。
4. **失败不假装成功**：`setMode` 抛错时 appearance 已回滚到上一个选择，面板只负责弹「没切过去」（`themeMode.saveFailed`），不让按钮亮着却毫无解释。
5. **位置**：放在「内置主题」**之前**——先定配色再挑皮肤；两个控件挨着，挑完皮肤也知道当前是深是浅。
6. **三语 locale**：`settings/appearance` 命名空间下 zh-CN / en-US / zh-TW 各 8 条（`themeMode.title/description/modeLabel/system/light/dark/resolvedHint/saveFailed`）。

**判据 1 · 数据契约**（`cd apps/vouch-web/src/web-ui && node_modules\.bin\tsx ../../../../tools/agent/verify-theme-mode.mjs` → **37/37 PASS**）：

| 组 | 关键判据 | 结果 |
|---|---|---|
| 映射（6） | `light`→默认浅色包、`dark`→默认深色包、`system`→哨兵；映射表**只**产出这三个 id | PASS |
| 反解（6） | **反例**：`system` 选择 + 系统已落地深色 → 仍是 `system`；**自带深色皮肤**按配色归「深色」 | PASS |
| 落地（5） | 固定浅/深**不受系统影响**；只有 `system` 去问 `prefers-color-scheme`；`system` 不会漏到 DOM 属性 | PASS |
| 脏值（9） | 空串 / `DARK` / `" dark"` / 旧词 `auto` / 数字 / `null` / `undefined` / 对象 → 回落 `system` | PASS |
| 往返（9） | 档位 → 选择 → 反解 → 档位，三档 × 两种系统偏好下**配色一致** | PASS |

判据脚本**直接 import 界面那一份实现**（`core/mapping.ts` + `types.ts`），不重写等价逻辑——重写只能证明「我抄得对」。常量一改名（`openbitfun-light` → 别的）这里立刻红。单测 4 个文件 **52 条**（`types` 14 / `mapping` 13 / `ThemePreferenceService` 17 / `ThemePreferencePanel` 8，随 `test:run` 跑）。

**判据 2 · 浏览器实测**（CDP，`http://127.0.0.1:47124/`，**15/15 PASS**，存证 `evidence/theme-mode.json`）：

| # | 判据 | 实测值 |
|---|---|---|
| 1 | 三档单选组存在（system / light / dark 各一段） | `["system","light","dark"]` |
| 2 | 同一时刻只有一段点亮（radio 语义） | `["system"]` |
| 3 | 点亮档位与落地配色一致 | `checked=system → scheme=light` |
| 4 | 外观包应用期间控件不忙碌 | `aria-busy=null` |
| 5 | **点深色 → 点亮 `dark` 且 `<html data-color-scheme="dark">`** | `dark` |
| 6 | 深色下提示文案说「当前深色」 | `当前：深色` |
| 7 | **深色下 `<html>` 背景真的变暗**（亮度 < 0.35） | `rgb(14, 14, 16)` |
| 8 | **刷新后仍是深色**（持久化，不是内存态） | `checked=dark, scheme=dark` |
| 9 | **点浅色 → 点亮 `light` 且 `data-color-scheme="light"`** | `light` |
| 10 | 浅色下背景真的变亮（亮度 > 0.6） | `rgb(248, 248, 249)` |
| 11 | **跟随系统 + 系统深色 → 点亮 `system`、落地 `dark`** | `checked=system, scheme=dark` |
| 12 | **运行期系统改回浅色 → 界面跟着变**（`system` 不是一次性快照） | `light` |
| 13 | **刷新后仍是「跟随系统」**（没被改写成固定配色） | `["system"]` |
| 14 | 整个切换序列无 theme-preference / appearance 异常 | `[]` |
| 15 | 除「静态服务缺 Tauri IPC」环境噪声外无其它异常 | `[]` |

截图：`evidence/screenshots/theme-mode-dark.png`（深色）、`theme-mode-light.png`（浅色）、`theme-mode-system.png`（跟随系统）。

**构建**：`vite build` ✓；`eslint` 新增文件 0 告警；`tsc --noEmit` 仅剩 3 条**既有** `@/generated/api` 缺失错误（与本批无关）。

**如实边界**：
- 只有**三档模式**，**没做**「按时间自动切换」（日出日落 / 定时深色）。appearance 侧没有对应调度器，做出来就是假开关。
- 「跟随系统」的**运行期跟随靠 appearance 的 `system` 解析**，实测覆盖「系统深→浅」一次切换；**没有**覆盖「系统主题在应用最小化时变化」这类边界（CDP 模拟的是媒体查询变化，不是真操作系统事件）。
- 深色下的**神经图画布**沿用批次 M 的重建逻辑，本批没有重新截图（M 的证据仍然有效，未重复取）。
- 主题选择存在 appearance 的配置里，**没有**独立的「导出/导入外观」入口。

**记分影响**：D-美观 V4（主题）从「深色只能改代码」→ **深色是一等公民，有入口、能持久化、跟随系统**；D-实用 P5 无变化。美观 4.35 → 4.4。

## 批次 Z.1 · 工具卡「命令风险」徽标（只分级、不拦截）
**对标**：CodeBuddy CN 的三级提示——`高风险命令，可能影响系统稳定性` / `中风险命令，请谨慎执行`。
**为什么加**：动手模式的工具卡把 `bash({"command":"rm -rf …"})` 原样摆出来，用户得自己逐字读命令才知道这条会不会毁东西。批次 D 的「未做」里记过「不做审批闸」，但**提示风险**与**拦截执行**是两件事：前者只是信息，后者才是闸门。
**改动**（新增 `app/layout/toolRisk.ts`；`NianchuChat.tsx` 步骤行 + `.scss`）：
1. `classifyToolRisk(tool, input)` 纯函数：只对**命令执行类工具**（bash / shell / pwsh / cmd / exec …）分级，其余返回 `null`——`read`/`glob`/`write` 不参与，避免「读文件也有风险」的假结论。
2. **不确定就返回 null**，不兜底成「低风险」：给错一个「低风险」比不给更危险。只有命中「只读白名单」（ls/cat/grep/git status…）才判 `low`。
3. 规则分层且**顺序即优先级**：`rm -rf` 先命中 high，裸 `rm` 落 medium（单测里专门锁了这条反例，防止把「删一个文件」和「递归强删」混为一谈）。
4. 徽标**三重编码**：符号（⛔/⚠/○）+ 文字（高风险/中风险/只读）+ 颜色；`title` 写明命中的是哪条规则（如「rm -rf：递归强制删除，删掉的文件不进回收站」），只写「高风险」等于让用户再猜一遍。
5. 只看命令前 4KB：超长命令分级没意义，也避免正则在长串上回溯。
**单测**（`toolRisk.test.ts`，**23 条**）：非命令类工具 → null / 空命令 → null / 未知命令 → null（不默认低风险）/ 裸 `rm` 是 medium 不是 high / `rm -fr`、`curl|bash`、`git reset --hard`、`del /f /s /q` 是 high / 大小写与多余空格容错 / 20 万字符命令不崩 / 数组形参数拼命令 / 三档文案都带符号+文字。
**产品实测**（CDP，真模型，动手模式下发「用 bash 执行 ls 看看当前目录」）：产生 2 条 bash 步骤，徽标各为 `○ 只读`（`data-risk="low"`、`data-risk-rule="只读命令"`），控制台无异常。截图 `evidence/screenshots/z-tool-risk.png`。
**如实边界**：
- **中/高两档只在单测里验证分类**，产品实测故意只跑只读命令——「验证高风险徽标」最直接的办法是真删一次数据，那不能做。两档渲染走同一段代码，只换 class 与文案。
- 不做拦截、不做确认弹窗（`总纲.md:18` 既定非目标）；徽标只是提示，命令照常执行。
- 只覆盖本机工具卡的 `bash` 等命令类工具；MCP 远端工具的参数不做风险推断（拿不到可靠语义，宁可不猜）。

**记分影响**：D-美观 V2（信息密度/视觉层级）小增；D-功能 F4 无变化（不新增拦截能力）。美观保持 4.4。

## 批次 Z.2 · 运行状态条（它在做什么 / 为什么停 / 花了多久 / 怎么复盘）
**对标**：openclaw / orca 把 provider 用量、余额与成本摆到界面上；dsh 判定层 `tools/agent/stop.mjs` 的 9 种停止原因。
**问题（先说真话）**：`verify-d3-status` 里有 6 条红。它测量的还是**已废弃的 `DoPanel.tsx`**——批次 X 之前三 tab 面板被换成单一对话面板后，这份判据没跟着搬，于是「后端能判定停止原因、前端却看不见」这件事被一条过时的判据掩盖着。红不是因为产品坏了，是因为判据指着空气。
**改动**：
1. 新增 `app/layout/runStatusView.ts`：`STOP_LABEL` 九键（与后端 `STOP_REASONS` **逐字一致**，判据脚本直接比对）+ `buildRunStatusView()` 纯函数（无运行 → 空闲；未知 stopReason → 原样显示，不冒充「正常完成」；0/负数耗时 → 占位）。
2. `NianchuChat.tsx`：把 `run_task` 回包里的 `stopReason / stopLabel / traceId / elapsedMs / usage` 收进消息的 `run` 字段；compose 上方新增**运行状态条**，五个字段一行，**空闲也保留占位**（「看不到状态」≠「状态是空闲」）。
3. `verify-d3-status.mjs`：判据**改成测量现行面板**（`ncc-run-status` 系列标记 + 状态条模型文件），断言数量与强度不变（仍是同一组 22 条），不是「删红转绿」。
4. `.scss`：等宽数字、`trace` 允许省略但完整值进 `title`，不撑破一行。
**判据**（`node tools/agent/verify-d3-status.mjs` → **22/22 PASS**，此前 16/22）：源码含五个字段 + 空闲占位 + 前后端停止原因键集合一致 + 后端真给值 + 真浏览器 DOM 里五个字样都在。
**单测**：`runStatusView.test.ts` **16 条**（键集合一致 / 空闲占位 / 正常一次运行 / 未知 reason 原样 / 耗时 0 与负数 / trace 空白 / usage 0 不假装 / state 缺失 → UNKNOWN）。
**产品实测**（CDP，真模型）：
- 空闲：`状态：空闲 停止原因：— 耗时：— trace：— 用量：—`
- 跑一次动手任务：`状态：PASS 停止原因：正常完成 耗时：4.0s trace：tr-77ff7a6c61bf4f0d 用量：2 次调用（in 17904 / out 72）`
- 截图：`evidence/screenshots/z-run-status-idle.png`、`z-run-status-done.png`。
**如实边界**：
- `run` **不落盘**（`get_session` 不返回），刷新/切会话后状态条回到「空闲」。历史里本来也没有「上一次为什么停」的语义，所以不算丢数据；但**刷新后看不到上一次 trace**——要持久化得改会话落盘格式，留待后续。
- 状态条只反映**动手模式 run_task**；对话模式一轮问答没有 stopReason（装配层不产生这个判定），不硬凑。
**记分影响**：D-实用 P3（状态可见）从「四态」补到「为什么停 / 耗时 / trace / 用量」（对标 openclaw 的 provider 面板）；D-功能 F2 无变化。实用 4.6 → 4.65。

## 批次 Z.3 · 记忆命中看板（这一轮回答参考了哪几条记忆）
**对标**：CodeBuddy CN 的「项目记忆 + 对话记忆、跨会话保留上下文」；本质是让「记忆」从黑箱变成可核对的东西。
**问题**：宿主每轮都会从跨会话记忆里按词法召回若干条（`tools/agent/context.mjs` 的 `recallMemory`），但界面上**只有一个数字**（`memoryHits`）。用户没法回答「它到底参考了什么」，这正是「记忆」最容易被怀疑成编造的地方。
**改动**：
1. `runtime.mjs`：落盘 `context.memoryHitItems = [{ key, preview }]`（前 6 条，预览 80 字）。只存 key + 预览，**不存整条 value、不存 score**——score 是词法命中中间量，摆给用户会被误读成「相关度」。
2. `contextUsageView.ts` 新增 `resolveMemoryView()` 纯函数 + `MEMORY_VIEW_MAX=6`：取最近一轮；`count > 明细数` → `truncated=true`；脏明细跳过；负 count 钳 0；没有可展示信息 → `null`（**界面不渲染假面板**）。
3. `NianchuChat`：输入框上方加**可折叠看板**（`<details>`，默认收起）。命中数为 0 或没有数据源时**整块不渲染**；旧数据没落明细时如实写「这一轮没有落明细」；明细被截断时写「还有 N 条未展开」。
4. 同时修了两个「明细被吞」的接线点：历史映射（`get_session` → Msg）和实时回包（`start_dialog_turn` → Msg）原来只拷了 3 个用量字段，把 `memoryHits/memoryHitItems` 丢了。
**判据**（`node tools/agent/verify-context-usage.mjs` → **25/25 PASS**，原 19/19）：新增 6 条 —— 明细落盘 / 界面能解析 key+预览 / 最近一轮 0 条隐藏 / 无 context→null / count>明细→truncated / 超上限只留 6 条。
**单测**：`contextUsageView.test.ts` 新增 **10 条**（共 23 条，含反例：非数字 memoryHits 跳过、脏明细跳过、负 count 钳 0、预览截断 80）。
**产品实测**（CDP，真模型，重启宿主后）：
- 先临时写入一条记忆 `nianchu.memory.demo`（验证后已删除，避免污染用户记忆）；
- 对话模式问「记忆看板验证用 这条记忆写了什么？」→ 面板出现 `记忆命中 1 条（点开看命中了哪些）`，展开显示 `nianchu.memory.demo` + 预览；
- 截图 `evidence/screenshots/z-memory-board.png`。
**如实边界**：
- 召回是**词法**匹配（中文 bigram + 英文词），**不是语义检索**；命中了不代表「用对了」。界面只陈述「命中了哪些」，不给相关度分数，也不假装它是 RAG。
- **只有一层记忆**：念初是单一 KV 库（key/value/source/ttl），没有 CodeBuddy 的「项目记忆 / 对话记忆」两层分离 —— 这一项**不记「平」**，如实写在记分表里。
- 明细只保留前 6 条预览；要看完整 value 得去记忆库，界面不展开全文（避免把长记忆灌进对话区）。
- 落盘的是**当时**命中的快照：记忆后来被更新/删除，历史里的看板仍显示当轮内容（这是「当轮事实」，不是当前状态）。

**记分影响**：D-功能 F1（记忆可视）从「一个数字」→「可核对明细」；D-实用 P3 小增。实用 4.65 保持（这一条主要是把已有能力做可见，不新增检索能力）。

## 批次 Z.4 · 错误分类化（是哪一类 / 下一步做什么）
**对标**：CodeBuddy CN 四类（网络 / 代理 / DNS / 模型）；Cherry 10+ 类且**每类给下一步**。
**问题**：界面上原本只有一行原始报错（`fetch failed` / `WebSocket connection failed`）。用户既分不清是自己的网络、代理、DNS 还是模型侧的问题，也不知道该干什么——「报错」等于把排查工作原样丢回给用户。
**改动**：
1. 新增 `app/layout/errorDiagnosis.ts`：`diagnoseError()` 纯函数，五类（network / proxy / dns / timeout / model），每类带 `badge`（符号+文字）、`title`、`nextStep`、`detail`（原始串原样保留）。
2. **只在有确定性证据时分类**（错误码/状态码/关键短语），认不出返回 `null` → 界面退回原文。**不猜**：猜错类别会把用户带去改代理、改 DNS 这类无效操作。
3. 优先级：`proxy` / `dns` 排在 `network` 前面——它们也是网络故障，但要采取的动作完全不同，混成「网络错误」等于没说。
4. 状态码必须带语境（`status 401` / `429 Too Many Requests`），裸数字（「跑了 403 步」）不判模型类。
5. `NianchuChat`：`err` 从一行红字变成**分类卡**（徽标 + 标题 + 「下一步：…」+ 可展开原文）；判不出时仍是原来那行原文。代理/DNS 用提示色，不和真正的失败抢红色。
**判据**（`node tools/agent/verify-error-diagnosis.mjs` → **27/27 PASS**）：8 个分类样例 + 每类必须有下一步/徽标 + 代理/DNS 优先级 + 原文保留 + 5 条反例（普通文案 / 空串 / null / 裸数字 / 正常用量文案都不误判）。
**单测**：`errorDiagnosis.test.ts` **24 条**。
**产品实测**（CDP，真实制造失败）：停掉宿主进程后在对话里发消息 → `WebSocket connection failed` → 界面显示 `🌐 网络 / 连不上（网络层）/ 下一步：确认网络可用、宿主进程在线（端口 47124 可访问）…` + 可展开原文。**这一步抓到真 bug**：首版正则没覆盖 `WebSocket connection failed`，实测显示成原文；补进 network 规则后才分类（单测/判据各加 1 条锁住）。截图 `evidence/screenshots/z-error-diagnosis.png`。
**如实边界**：
- 只对**错误串文本**分类，不做 HTTP 抓包/状态码真解析；宿主若只回「失败」二字，界面也判不出（如实显示原文）。
- 五类覆盖最常见的可行动故障；「配置非法 / 权限不足」这类不在此列，仍显示原文。
- 代理/DNS 用了提示色（黄）而非红：它们更像配置问题，不是「程序挂了」。

**记分影响**：D-实用 P4（可诊断性）从「一行报错」→「分类 + 下一步 + 原文」；D-功能 F1 无变化。实用 4.65 保持。

## 批次 Z.5 · 子代理卡片端到端（真让动手 agent 派活）
**对标**：dsh `subagent-spawn-in-process`（子代理看不到父上下文、递归有深度上限）；Qoder / Claude 的「派个子代理查清楚再回来」。
**问题（真 bug）**：界面上早就画了「子代理」工具卡（`tool === 'spawn_subagent'` 显示为「子代理」），但 `tools/agent/loop.mjs` 的 **`runWithTools` 默认工具表里没有 `spawn_subagent`** —— 动手模式（`run_task`）里模型根本调不到它，这张卡片**永远不会出现**。实测：明确要求模型「必须用 spawn_subagent」，它只能去 `grep` 代码找工具，transcript 里 0 个 `spawn_subagent` 步骤。
**改动**：
1. `loop.mjs`：默认工具表补上 `spawn_subagent`（`run_team` / CLI 路径本来就有，唯独产品 UI 的 `run_task` 漏了）。
2. `verify-subagent.mjs`：加一条**不依赖模型**的接线断言——解析 `loop.mjs` 的默认工具表，必须含 `spawn_subagent`（25→26），防止再次「卡片在、工具不在」。
3. `.scss`：工具名在窄卡片里会被挤成竖排（截图里「子/代/理」三行），加 `white-space: nowrap; flex: 0 0 auto`。
**判据**：`node tools/agent/verify-subagent.mjs` → **26/26 PASS**（新增接线断言；模型相关段不可用时如实 UNKNOWN 跳过）。
**产品实测**（CDP，真模型，重启宿主后）：
- 动手模式下发「你【必须】用 spawn_subagent 派一个子代理确认 1+1」；
- transcript 出现 `data-tool="spawn_subagent"`、`ok=1`、label=`子代理`、耗时 5174ms；
- 截图 `evidence/screenshots/z-subagent-card.png`。
**如实边界**：
- 这是「卡片可达 + 真跑通一次」，**不是**对子代理质量的评测（嵌套调用的回答对不对由模型决定，本批不评）。
- `spawn_subagent` 进默认表后，模型在需要时会多一层嵌套模型调用；成本受 `subagentDepthLimit=2` 与工具自身深度判定约束，但仍比单层贵——这是「能派活」的固有代价，不隐藏。
- 卡片点开只有子代理的最终回答摘要（截断 1500 字）与调用数，**看不到**子代理内部逐步 tool 流（那是独立小循环，未做下钻）。

**记分影响**：D-功能 F2（多智能体）从「卡片空壳」→「可达且真跑通」；D-美观 V2 顺手修了竖排。功能 4.6 保持（不虚增）。

## 批次 Z.6 · 子代理卡片下钻（看得到它内部调了哪些工具）
**对标**：Claude Code / dsh 的子代理视图——不只告诉你「派了一个子代理」，还能看它内部怎么干活。
**问题（Z.5 自己留下的尾巴）**：Z.5 修好「卡片可达」后，点开只有一个最终回答摘要 + 一个调用次数，**看不到子代理内部逐步调了什么**。对用户来说，子代理仍是个黑箱：「它到底干没干活？调了哪些工具？失败没有？」。
**改动**：
1. `toolkit.mjs` 的 `spawn_subagent` 返回值补 `innerSteps`：`[{ tool, ok, ms }]`，最多 20 条；**不返回完整 output**（父上下文不装子代理的中间产物）。
2. 新增 `app/layout/subagentView.ts`：`buildSubagentView()` 纯函数做防御式整形（摘要/步骤/成败计数/`truncated`；既无摘要也无步骤→null，老数据退回原 JSON）。
3. `NianchuChat`：子代理卡片展开区改成「摘要 + `子代理内部工具 N 次（成功 x · 失败 y）` + 逐条工具清单（成败点 + 工具名 + 耗时）」；`truncated` 时如实写「仅展开前 N 条」。
**判据**：
- `node tools/agent/verify-subagent.mjs` → **27/27 PASS**（新增 1 条「工具返回带 innerSteps」；26→27）。
- 单测 `subagentView.test.ts` **9 条**（含反例：null/非对象→null、既无摘要也无步骤→null、脏步骤不崩、ms 非数字→null、40 条只留 20）。
**产品实测**（CDP，真模型）：
- 让子代理「用 bash 看一下当前目录」，展开卡片：摘要「看完了」；`子代理内部工具 2 次（成功 1 · 失败 1）`；两条 bash（45ms / 27ms，一条红一条绿）。
- 截图 `evidence/screenshots/z-subagent-drill.png`。
**如实边界**：
- 只展示子代理**内部工具清单**（工具名/成败/耗时），**不含**每一步的完整输出与参数——要看细节属于另一个层级的评审，避免父上下文被撑爆。
- 超过 20 步只保留前 20 条，界面如实标「仅展开前 20 条」，总数仍显示真实值。
- 老会话（innerSteps 上线前的运行）没有这块数据，卡片退回显示原始 JSON，不伪造。

**记分影响**：D-实用 P3（子代理状态可见）补到「内部工具流」；D-功能 F2 增强。功能 4.6 保持。

## 批次 Z.7 · 修用户直报三处体验问题（不再闭门造车）
**用户反馈（原话）**：「开场动画完全没必要；主 agent 对话框下方堆成一坨；进入后神经记忆元放大又拉回的闪烁 bug；很多出错。」并要求「不要闭门造车，把经过市场验证的开源项目直接化为己用」。
**本批采纳的方法**：直接读用户点名的开源外观项目 **`github.com/Nwflower/dsh-claude-style`**（`git clone` 被本机 gh-proxy 重写挡住 → 改用 `codeload.github.com` 官方 zip，master @ 2026-11-22T11:47Z，6.5MB，含 packages/client 主题 CSS 与 tokens.json）确认它「怎么做」，而不是自己另发明一套。**外观移植放到下一批**（涉及整套配色/字号令牌，需单独一批做干净）；本批先把三处**具体缺陷**修掉。

**1) 开场动画 —— 删掉**
`index.html` 里有一套启动遮罩 + logo 呼吸/交接动画（`#openbitfun-startup-overlay` + `.splash-screen` + `data-startup-*` 的 fade/handoff）。用户明确「没必要」。
改法（CSS 覆盖，最小侵入）：遮罩 `display:none !important`，根节点不再在 `data-startup-stage="loading"` 时 `visibility:hidden`，内容不做淡入、logo 不做交接动画。**保留元素存在**（`isStartupOverlayPresent()` 等就绪逻辑依赖它），只是永不显示 → React 一挂载即可见，无启动动画。
实测：`document.getElementById('openbitfun-startup-overlay')` → **absent**（交接后移除），页面直接呈现。

**2) 输入框下方「堆成一坨」—— 收成一行**
原来「上下文网格 / 记忆命中 / 运行状态 / 会话累计」四块各自 padding、各占一行（实测总高 **56px**、三块 top 分别 932/950/969）。
改法：四块收进一个 `.ncc-meta` 弹性行（`flex-wrap`，gap 2px/12px），清掉各自上下留白；**空闲时状态条只显示「状态：空闲」**（停止原因/耗时/用量/trace 在没有运行记录时全是「—」，是噪音；元素仍留 DOM，判据脚本照常能读到字样）。
实测：`.ncc-meta` 三块 **top 全部 = 969、总高 19px**（56 → 19）；截图 `z-fix-footer.png` 一行显示 `▮▮▮▮ 2,611 / 6,000　状态：空闲　本会话累计 15092 tokens`。

**3) 神经记忆元「放大又拉回」闪烁**
根因：`NeuronHomeScene` 里 `ResizeObserver` 首次回调 与 `graph.render()` 完成 几乎同帧各调一次 `fitView`，两次适配之间容器宽度还在变（右侧主 agent 停靠让位），且 fitView 默认**带动画** → 用户看到放大再拉回。
改法：① Graph 全局 `animation: false`（适配/布局直接到位，不做动画过渡）；② 同帧多次 fit 用 `requestAnimationFrame` 合并成一次（`scheduleFitView`），卸载时 `cancelAnimationFrame`。
**如实边界**：G6 用 canvas 2D 画相机变换，**无法用 DOM transform 采样**证明「不闪」；本修复是**构造性**的（全图关动画 + 同帧合并 fit），DOM 采样只能证明「稳定后 transform 为 none、无异常」，不能量化首帧动画。要在真机上确认，需要录制首屏。

**复算**
- 截图：`evidence/screenshots/z-fix-home.png`（整页）、`z-fix-footer.png`（底部一行）。
- 数值：probe 读 `.ncc-meta` children 的 `top/height`（见上），改前 56px/三行 → 改后 19px/一行。
- 源码：`index.html` 的 `#openbitfun-startup-overlay { display:none !important }`；`NeuronHomeScene.tsx` 的 `animation: false` 与 `scheduleFitView`。

**记分影响**：D-美观 V4（空/载入/细节态）+ V1（版式留白）修掉用户可见缺陷；D-实用 P2（输入区不再被四行挤占）。均为缺陷修复，不加虚分。

## 批次 Z.8 · 移植 Claude Code Desktop 外观（直接复用 dsh-claude-style 的配色卡）
**用户要求**：「我比较喜欢给它加上 dsh-claude-style 此插件后的界面外观」「不要闭门造车，把开源项目直接化为己用」。
**方法（复用，不自造）**：读 `github.com/Nwflower/dsh-claude-style` master @ 2026-11-22T11:47Z 的 `packages/client/src/theme/tokens.json` → `palette.cards[claude]`，取它的**种子色**：
`accent #d97757`、`canvas light #ffffff / dark #191919`、`text light #161616 / dark #fdfdfd`、`sidebar #fafafa / #1f1f1f`、`bubble #f4f2f3 / 白 6%`、`link #184f95 / #8ab4f8`。
把它落成念初外观系统里的两套一等预设，**复用念初既有的 `paletteHelpers`**（createAccentScale / createSemanticColors / 中性 border/element），而不是逐行抄它的 DOM/CSS。

**改动**：
1. 新增 `builtins/claudeLight.ts`（id `claude-light`，name «Claude»）与 `builtins/claudeDark.ts`（id `claude-dark`）。
   - 暗色文字用 Claude 品牌暖白 `#faf9f5`（而非卡片里的 `#fdfdfd`，同时避开既有唯一性断言）。
   - 修正一处真实校验错误：monaco `cursor` 首版漏了 `#`（`e0a184`）→ `AppearanceCompiler` 报 `colors.editorCursor.foreground is not a supported color`，已修。
2. `palettes.ts` 注册（浅/深各插在对应类型旁）；`locales/{zh-CN,zh-TW,en-US}/settings/application.json` 的 `appearance.presets` 加名称/描述（Claude / Claude 暗色）。
3. 重新生成启动首屏清单 `apps/desktop/src/generated/startup_appearance_bootstrap.json`（10→11 项）；`appearancePresetOutput.test.ts` 的内联快照随新增预设更新。

**判据/测试**：`src/infrastructure/appearance` 全量 **163/163 PASS**（含 compiler / renderer 契约 / 预设输出哈希快照 / 启动清单同步）；`tsc --noEmit` 仅 3 条既有 `@/generated/api` 缺失错误。
**产品实测**（CDP，真实 47124）：设置→外观→内置主题下拉里出现 **Claude / Claude 暗色**；
- 选 Claude → `data-openbitfun-appearance=claude-light`、`data-color-scheme=light`、`canvas #ffffff`、`contentPrimary #161616`、accent `#d97757`、body `rgb(250,250,250)`；
- 选 Claude 暗色 → `appearance=claude-dark`、`scheme=dark`、`canvas #191919`、`contentPrimary #faf9f5`、body `rgb(31,31,31)`、accent `#d97757`；
- 测完还原 `openbitfun-light`（不把用户环境留在自定义外观）。截图 `z-claude-light.png` / `z-claude-dark.png`。

**如实边界**：
- 只移植**配色/语义色/圆角间距/按钮强调**；**没有**照搬它的 DOM 结构 CSS（`chrome.css`/`sidebar.css` 依赖 DSH 的 `data-pane`/`data-slot` 结构，念初组件树不同），也**没有**移植「Claude/DeepSeek 品牌切换」「六套预设编辑/新建/复制」「字体替换」——这些是它那套皮肤包的完整能力，念初这边是「两套配色 + 现有外观机制」。
- **默认外观不变**（仍是 `openbitfun-light`），Claude 作为可选项；要不要设为默认由用户决定。
- 视觉最终观感以截图为准，未做逐像素比对（两边组件树不同，像素级比对没有意义）。

**记分影响**：D-美观 V4（主题与细节）从「9 套自有配色」扩到「11 套，含用户指定的 Claude」，并验证了「开源皮肤 → 念初外观系统」的移植通道。美观总分保持 4.4（新增可选主题不虚增）。

## 批次 Z.9 · 提问跳转（turn-nav，对标 Claude Code / dsh-claude-style）
**对标**：`dsh-claude-style` 的 `packages/client/src/features/turn-nav`（Claude Code 在长对话里一键跳上/下一条用户提问）。
**为什么加**：念初有「会话内搜索」，但长对话里想快速回看「上一个问题」只能手动滚。这是 Claude Code 的日常操作。
**改动**：
1. 新增 `app/layout/turnNav.ts` 纯函数：`clampTurnIndex`（上/下钳在 [0,total-1]）、`activeTurnFromOffsets`（按偏移+scrollTop 推导当前条，含 slack 边界）。
2. `NianchuChat` 对话右侧加一枚**半透明胶囊**（↑ / `当前/总数` / ↓），默认 0.6 透明度、悬停变实；只在提问数 > 1 时出现。点按按「目标相对滚动容器的偏移」滚（**不用 scrollIntoView**——实测它会去滚外层文档、内部 scrollTop 不动）。
3. 跟随逻辑：提问数量变化（含历史加载完成）时指针跟到最新一条；否则停在用户手动翻到的位置。
**判据/测试**：`turnNav.test.ts` **12 条**（越界钳制、非数字兜底、两条之间取上一条、差 1px 的 slack 边界、空列表、负 scrollTop）。
**产品实测**（CDP，真实 47124）：胶囊出现且显示 `4/4`；点 ↑ → 计数 `3/4` 且 `scrollTop 68 → 4488`（跳到上一条提问处）；按钮在首/末正确禁用。截图 `z-turnnav.png` / `z-turnnav-full.png`。
**如实边界**：
- 本机这个会话的 4 条提问都挤在最后（前面是一条 3435px 的超长消息），所以「相邻两条跳转」的位移被 clamp 到接近底部——**位移大不等于功能对**，真正判据是计数与禁用态；纯函数的边界由 12 条单测锁。
- 只做了「上/下一条提问」，**没做**「按主题/工具调用跳转」；也没绑键盘（Alt+↑/↓），因为全局快捷键容易被浏览器/输入法先吃掉，需要单独做冲突处理。
- 胶囊是浮层，**未做** 窄屏折叠策略（面板 < 260px 时会盖住一点正文，后续可加断点隐藏）。

**记分影响**：D-实用 P4（键盘/效率）小增（长对话导航）；D-美观 V2 增一枚克制浮层。实用 4.65 保持。

## 批次 Z.10 · 长回复折叠（超过阈值默认折起，可展开）
**对标**：`dsh-claude-style` 的 `features/chat-fold`；Claude / ChatGPT 对超长回答的通行处理。
**为什么加**：念初出现过 3400px 高的长回答，一屏放不下只能一路滚；用户也抱怨过「堆成一坨」。
**改动**：
1. 新增 `app/layout/replyFold.ts`：`shouldFoldReply(content, {chars=2200, lines=45})`——**字符或行数**任一超过即折叠；判据是「超过」不是「达到」。
2. `NianchuChat`：助手正文超过阈值时套 `max-height:360px + 底部渐隐`，下方给「展开全文（约 N 字）」/「收起」按钮；**只折已结束生成的消息**（`m.state !== 'RUNNING'`，流式中途折叠会把正在长出来的内容藏起来）。
3. 展开状态按消息 id 记在 `Set`，不写回消息数据（纯视图态）。
**判据/测试**：`replyFold.test.ts` **7 条**（短/空/纯空白/null 不折、字符超阈值、行数超阈值、刚好等于不折、自定义阈值、中文按字符计）。
**产品实测**（CDP，真模型）：让模型列 50 条建议 → 回答 1781 字（>45 行）→ 折叠态高度 **360px**、按钮「展开全文（约 1781 字）」；点开后按钮变「收起」、折叠态消失。截图 `z-fold.png`。
**如实边界**：
- 只按**字符/行数**粗判，不按渲染高度（纯函数拿不到布局；同字数不同排版高度会不同）。
- 只折助手正文，**不折**工具流 / 计划面板（那两块本身已有折叠语义）；长**代码块**不会被单独折叠，只随整条回复折。
- 折叠是纯前端视图态，**不落盘**：刷新后重新按阈值判断（长回答仍会折起）。

**记分影响**：D-实用 P2（信息密度）/ D-美观 V1（版式不失控）小增；README 式「一屏铺满几千字」的问题缓解。实用 4.65 保持。

## 批次 Z.11 · 历史会话按「今天 / 昨天 / 更早」分组
**对标**：`dsh-claude-style` 的 `features/date-groups`（Claude 侧栏按日期分段）。
**为什么加**：历史里几百条会话平铺一长串，扫起来费劲；先按「今天/昨天/更早」分段，再在段内看相对时间。
**改动**：
1. 新增 `app/layout/sessionDayGroup.ts`：`sessionDayKey(iso, now)` 用**本地日历日 00:00 的毫秒差**判今天/昨天/更早；`needsDayHeader` 只在「与上一条不同组」时出标题。缺失/非法时间归「更早」，未来时间（时钟漂移）归「今天」。
2. `NianchuChat` 历史下拉：在行前插 `ncc__history-group-title`（sticky 小标题），单次 map + Fragment 包裹，不改列表结构。
3. 相对时间沿用已有的 `relTime`（「6 分钟前 / 3 小时前」），与分组标题配合。
**判据/测试**：`sessionDayGroup.test.ts` **9 条**（今天、跨零点 23:59→昨天、00:01→今天、前天→更早、未来时间→今天、缺失/空串/非法→更早、首条需要标题、同组不重复、跨组需要标题）。
**产品实测**（CDP，真实历史 895 条）：打开历史下拉 → 出现 `今天` 分组标题 + 60 行（`10 条 · 6 分钟前` 等相对时间）。截图 `z-date-groups.png`。
**如实边界**：
- **只渲染最近 60 条**（原有防卡顿上限），所以「昨天/更早」的分组标题在这台机器上看不到——因为最近 60 条全是今天；分组逻辑本身由 9 条单测覆盖，**不把「看不到更早组」算作功能缺失**，也不把它算作「已展示」。
- 分组是**纯展示**，不改会话排序；跨月份不显示「X 月」，统一归「更早」。
- 没有做「按周/月折叠」或「分组默认收起」。

**记分影响**：D-功能 P3（会话管理）小增；D-实用 P2 小增。实用 4.65 保持。

## 批次 Z.12 · 会话标题清洗（吸取 dsh-claude-style 的自动会话名）
**对标**：`dsh-claude-style` 的自动会话标题（Claude 用模型生成短名）。
**为什么加**：本机 895 条历史里会话名直接取「首条消息前 40 字」，于是满屏「目标：…」「总目标：…」「请…」前缀、且截断在半个词上；列表可读性差。
**改动**：
1. 新增 `app/layout/sessionTitle.ts`：`cleanSessionTitle` 去指令式前缀（目标/总目标/子目标/请/请只/帮我/麻烦）、合并空白、去悬空省略号、超 28 字按**词边界**截断补「…」；`sessionDisplayName` 空名兜底。
2. 历史下拉的 `historyName` 改为走清洗（重命名输入框也预填清洗后的名字）。
**判据/测试**：`sessionTitle.test.ts` **10 条**（目标/总目标/请只/帮我前缀、合并换行、超长词边界截断、短名不截、去悬空省略号、空/纯前缀→兜底）。
**产品实测**（CDP，真实 895 条历史）：下拉 60 行标题 **0 行以「目标/请/帮我」开头**，样本「在工作目录创建 out.txt，内容写…」「用不超过 100 字说明：进程退出码 0/1/2…」。截图 `z-session-titles.png`。
**如实边界**：
- **纯前端展示清洗，不改宿主存的 sessionName**；重命名仍以用户输入为准（用户手动重命名成「目标：xxx」也会被清洗，属预期）。
- 没做「用模型生成短标题」（要额外模型调用，未纳入本批）。

**记分影响**：D-功能 P3、D-实用 P2 小增；实用 4.65 保持。

## 批次 Z.13 · 完成提示（声音 / 桌面通知）
**对标**：`dsh-claude-style` 的 `sound-cues`（Claude Code 完成提示音）与 `attention-notifications`（后台完成弹通知）。
**为什么加**：长任务跑完时人常常切走了，回来才发现；给一个**默认关**的完成提示（声音 + 后台桌面通知）比一直盯着强。
**改动**：
1. 新增 `app/layout/completionCues.ts`：`readCueSettings/writeCueSettings`（localStorage `nianchu.completionCues.v1`，默认全关、损坏回退）、`shouldCueTurn`（**只在 RUNNING→PASS 这条边**响，失败/中断不响）、`playCompletionCue`（WebAudio 合成 880→660Hz 两声，无音频文件）、`notifyCompletion`（仅 `granted` 且页面不可见时弹）、`requestNotifyPermission`。
2. 面板头部加 🔔 按钮 + 弹层：两个 `role="switch"` 开关 +「试听」+ 说明文案。
3. `NianchuChat` 在 live 回复落到 PASS 时按开关触发，`cuedTurnRef` 保证同一条只响一次。
**判据/测试**：`completionCues.test.ts` **10 条**（默认关、合并写、损坏回退、非布尔不认、RUNNING→PASS 才响、FAIL/INTERRUPTED 不响、无 AudioContext 静默、两个振荡器间隔 0.16s、构造抛错静默）。
**产品实测**（CDP）：点 🔔 → 弹层两个开关；点「提示音」→ `aria-checked` 关→开、localStorage 变 `{"sound":true,"notify":false}`；点「试听」不抛错。截图 `z-completion-cues.png`。
**如实边界**：
- **无头浏览器听不到声音**：声音只由单测 mock AudioContext 验证调度（两个振荡器、错开 0.16s），**不宣称「已听到」**。
- 桌面通知**需用户授权**，且只在页面不可见时触发；无头环境不弹系统通知。
- 只在「正常完成」响；失败/中断静默（避免误报成功）。

**记分影响**：D-功能 P2、D-实用 P2 小增；实用 4.65 保持。

## 批次 Z.14 · 工具调用竖列（process-column）
**对标**：`dsh-claude-style` 的 `process-column`（把一次回复里的工具调用收成竖列时间线 + 一行摘要）。
**为什么加**：工具步骤卡展开后能看，但折叠时用户数不清「跑了多少步、有没有失败、总共多久」；圆点之间也没有连接，视觉上像散落的卡片。
**改动**：
1. 新增 `app/layout/stepsSummary.ts`：`summarizeSteps`（步数/失败数/总耗时，非数字与负数不计）+ `stepsSummaryLabel`（`工具调用 · 3 步 · 1 失败 · 共 1.2s`，0 步返回空串不渲染表头）。
2. **重构**：把工具步骤卡片从 `NianchuChat.tsx` 抽成独立组件 `app/layout/ToolSteps.tsx`（`stepArgText`/`stepOutputText`/`ToolStep` 类型移到 `stepText.ts`），`NianchuChat` 只留一行 `<ToolSteps steps={m.steps} />`。
3. 竖列样式：圆点左侧一条连接线（`.ncc-steps::before`）、每步加序号、顶部加摘要表头。
**判据/测试**：
- 纯逻辑 `stepsSummary.test.ts` **9 条**（计步/失败/耗时、ok 缺省、NaN/负数、空输入、ms 与 s 切换、无耗时不提、0 步空串）。
- 组件 DOM `ToolSteps.test.tsx` **7 条**（表头文案、序号 1/2、失败标 `data-ok=0`、todo_write 过滤、参数优先 path、rm -rf 出风险徽标、普通读文件无徽标、空步骤不渲染、子代理下钻 2 条）。
**证据边界（如实）**：
- **没有「真实工具步骤」的截图**：当前模型（DeepSeek）在本面板发出的工具调用是未解析的 DSML 文本，跑不出真实步骤；历史会话只存文字不存 steps。本批以 **DOM 测试 + 单测**为可复算证据，**不拿占位图冒充**。
- 竖列是纯展示重构，不改 steps 来源；`todo_write` 仍被过滤（计划面板已翻译成人话）。

**记分影响**：D-功能 P2、D-美观 P2 小增；实用 4.65 保持。

## 批次 Z.15 · 会话搜索命中片段（上下文 + 高亮）
**对标**：Claude 的搜索下拉 + 命中高亮（此前只有「第 3/12 条」+ 滚动，用户不知道命中在哪句话里）。
**改动**：
1. 新增 `app/layout/searchSnippets.ts`：`extractSnippets(messages, query, {radius=24, limit=5})` —— 大小写不敏感、每条消息只取**第一处**命中、前后各取 24 字、超长两侧补「…」、空查询/无命中返回空数组。
2. 搜索栏下方渲染命中列表：角色标签（你/念初）+ 上下文 + `<mark>` 高亮；点一条跳转到对应消息（`searchMatches.indexOf(msgIndex)` → 现有 `setSearchIdx`）；`aria-selected` 标当前项；无命中显示「没有命中」。
**判据/测试**：
- `searchSnippets.test.ts` **7 条**（大小写不敏感且匹配词原样、只取第一处、上下文+省略号、limit 截断、空/无命中、多消息顺序与 msgIndex、首尾不补多余省略号）。
- 实测（CDP，历史会话 996 条）：搜「的」→ **6 条命中**，`mark` 文本正确；点第 2 条 → 计数 `2 / 6`、第 2 项 `aria-selected=true`；截图 [z-search-snippets.png](evidence/screenshots/z-search-snippets.png)（含黄色高亮与角色标签）。
**记分影响**：D-功能 P2、D-美观 P2 小增；实用 4.65 保持。

## 待办（P1+，下一批）
- ⛔ P1 composer 可见权限档（对标 WorkBuddy「允许完全访问」）——**不做了**：`总纲.md:18` 与 `tools/agent/verify-a15-approval.mjs` 明确把「越界拦截类安全机制」列为**非目标**（用户明令），权限档本质是同一类闸门。此条从待办移除，不记「平」也不做假 UI。
- ✅ P2 子代理卡片端到端——**已做（批次 Z.5）**：发现默认工具表漏了 `spawn_subagent`（卡片永远不出现），补进默认表 + 接线断言；产品实测真跑通（`z-subagent-card.png`）。
- ✅ P2 「记忆命中」看板——**已做（批次 Z.3）**：`memoryHitItems` 落盘 + 可折叠看板（key+预览，truncated 如实说）；`verify-context-usage` 25/25。
- ✅ P2 暗色主题——**已做（批次 Z）**：入口就是「设置 → 外观 → 浅色 / 深色 / 跟随系统」，放在「内置主题」之前；三档对齐 appearance 的 `system` 哨兵，持久化与运行期跟随系统均实测（`evidence/theme-mode.json` 15/15）。副作用：面板、神经图、上下文网格的深色配色从此**可达**（此前只能改代码）。
- 逐屏补截各家「对话中/工具流/设置/审批」再细化美观分。

## 批次 Z.16 – Z.27 · 补记（当时只写了提交信息，日志没跟上）

> 这里逐批补齐要点，**不重写历史**：每批的可复算证据是那一批的 `verify-*.mjs` / `*.test.ts` 与
> `git log` 里的提交正文；没留下截图的批次如实写「证据以脚本为准」。

### 批次 Z.16 · 回到底部悬浮按钮（对标 Claude 浮动下箭头）
滚动离开底部后右下角出现 ↓，点击平滑回到最新；已在底部时隐藏。只读既有 `atBottom`，不引入新状态。
证据：截图 `evidence/screenshots/z-jump-bottom.png`；逻辑并入 `NianchuChat` 的滚动监听。

### 批次 Z.17 · 面板主题五档（只换面板，不污染全站）
`panelTheme.ts`：五档枚举唯一真源 + 脏值归一化 + localStorage 存取降级；scss `data-ncc-theme` 覆盖四套令牌（system 继承应用）；头部主题按钮 + radiogroup 弹层。
证据：`panelTheme.test.ts` 15 条；`verify-panel-theme.mjs` 61/61；`evidence/panel-theme*.png`。

### 批次 Z.18 · 弹层键盘可达性（主题弹层不只能用鼠标）
`rovingRadio.ts`：单选组方向键导航（↓/→ +1、↑/← −1、边界回绕、Home/End），不吞 Tab/Esc/Enter；弹层打开即聚焦当前档，Esc 关闭并归还焦点（Esc 挂 document 捕获，修「焦点在触发按钮上会漏」）。
证据：单测 11 条；`verify-panel-theme` 扩到 61/61；截图 `panel-keys-*.png`。

### 批次 Z.19 · 搜索当前命中选错行（两套坐标不能直接比）
命中序号 ↔ 消息下标的换算收敛到 `searchSnippets.ts` 一处；越界收敛、空命中 −1。
证据：`searchSnippets.test.ts` 20 条判据版 `verify-search-snippets.mjs`；截图 `search-coords-*.png`。

### 批次 Z.20 · 提问跳转的「按位置推导」此前是死代码
`turnNav.ts`：首尾钳制、两条之间取上一条、slack 边界、滚到底认末条；组件真的接上 scroll 监听 + rAF 合并 + 跳转抑制窗口。
证据：`verify-turn-nav.mjs` 28/28；截图 `turn-nav-*.png`。

### 批次 Z.21 · 展开状态跨会话串台
消息 id 去掉「h+下标」位置型（改为带会话作用域），换会话/新对话时清掉展开与搜索；危险字符不进选择器。
证据：`verify-chat-state-scope.mjs` 17/17；截图 `chat-scope-*.png`。

### 批次 Z.22 · 历史会话可翻页（60 条硬截断 → 加载更多）
首屏一页 60 条，点「加载更多」逐页追加，加到头停在总数；非法输入不产出 NaN。
证据：`verify-history-paging.mjs` 24/24；截图 `history-paging-*.png`。

### 批次 Z.23 · 会话置顶（本机视图偏好，不假装跨设备）
`pinnedSessions.ts`：归一化（非空/去重/上限 50）、读写与降级、切换插到最前、排序（置顶在前、其余保序、已删自然跳过）；置顶区与普通区共用一份行渲染。
**边界如实写**：宿主 `list_sessions` 没有置顶字段，只存 localStorage —— 刷新仍在、换机器不跟随。证据：16 条单测；截图 `pinned-*.png`。

### 批次 Z.24 · 工具步骤用下标当 key，展开态会错位
步骤 key 改由内容决定（工具/成败/耗时/参数）而非下标，插入新步骤不改变已有 key、同工具同参数不撞；组件不再 `key={i}`，重复项补序号。
证据：`verify-step-keys.mjs` 12/12。

### 批次 Z.25 · 修 UI 热更新的假红与 Chrome 进程泄漏
采样早于挂载、断言过期 → 假红；顺带修 Chrome 进程泄漏。属**验证器自身**的修复，不计入产品分。

### 批次 Z.26 · d2 也用 CDP 取样，清掉最后一个 FLAKY
同 Z.25 一类：把不稳定的采样换成同一把尺子；FLAKY 归零后再报绿。

### 批次 Z.27 · 置顶项拖动排序（拖动 + Alt+↑/↓ 双路径）
`movePinned(ids, fromId, toId)`（插到目标**前面**，与插入线一致）与 `movePinnedToIndex`；任一边不在列表/自己拖自己/非数组 → 原样返回。拖动中读 ref（state 是上一帧）；只有置顶区可拖，普通区是最近顺序没有语义。
证据：`pinnedSessions.test.ts` 25 条；`verify-pinned-sessions.mjs` 29/29；`src/app/layout` 317/317。

## 批次 Z.28 · 工作方式四档（对话 / 只读提问 / 计划 / 动手）—— 而且模式是真的工具白名单
**对标**：WorkBuddy `interactionmode/*/fragments/interaction.md` 的「交互模式 = 显式工具白名单」（quick 空 / ask 只读 6 项 / craft 37 项 / expert+plan 39 项）；CodeBuddy CN 的五种工作模式。念初此前只有 `chat` / `do` 两态，而 `do` 也不限制工具。

**为什么加**：用户问「只读提问时它真的不会改文件吗」——实测反例：`run_task` 传 `tools:['read']`、模型调 `write`，**文件真的被写了**。原因是白名单只管「给模型看哪些 schema」，派发只查 `toolkit[name]`（全量表）。所以这批复刻的不只是 UI，是把闸补在派发处。

**改动**：
1. 新增 `tools/agent/modes.mjs`：四档唯一真源 —— `chat`（0 工具）/ `ask` 只读 8 项 / `plan` 只读 + `todo_write` / `do` = `null`（宿主默认全量）；`do` 不抄第二份清单，`DEFAULT_TOOLS` 由 `loop.mjs` 默认参数抽出共用。
2. `loop.mjs`：`allowedTools = new Set(toolList)`，派发时不在集合内一律 `ok:false`，错误文案「不在本次允许范围内（本次可用：…）」；系统提示按是否有写工具改成两版（只读版明说「这需要动手模式」）。
3. `tools/hostapi/methods-modes.mjs` + `ws-host.mjs` 白名单：`list_modes` 暴露模式表；`run` 支持 `mode`（**优先于 `req.tools`**，未知 mode 报错并给可选项）。
4. 面板（`NianchuChat` + `workModes.ts`）：四档切换，旁边一行「本模式可用工具」（数字来自宿主，悬停看全清单；切档清掉上一档报错）。
5. 坑（写进脚本注释防再犯）：`GATEWAY` 是 `runtime.mjs` **import 时**读 env，而 `toolkit.mjs` 经 session/context 间接拉起 runtime —— 验证脚本必须先起假网关、先覆盖 env，再动态 import。

**判据/测试**：新增 `tools/agent/verify-work-modes.mjs` **29/29**：
- 模式表（只读无写工具、plan=只读+todo、do=null、未知/空 id 不静默放成 do、describeAllModes 顺序与计数）
- 宿主解析（mode 优先、未知 mode 文案、无 mode 沿用 tools、空白 trim）
- **派发闸反例**（自带脚本化假网关）：`tools:['read']` 时模型真调 `write` → `ok:false` 且 **`blocked.txt` 不存在**；错误里列出「本次可用：read」；系统提示已含「只读」；
- `mode=ask` 经宿主解析后同样拦住；`mode=plan` 放行 `todo_write` 且计划进 `run.plan`；`mode=chat` 错误写「本次可用：（无）」。
其它：`src/app/layout` 333/333；`tsc --noEmit` 仅剩仓库既有的 3 条 `@/generated/api` 缺生成物；`size-guard` 无红文件；`scan-mutation-residue` PASS。

**如实边界**：
- 白名单是**能力裁剪**，不是沙箱：`ask` 里没有 `bash`，但 `bash` 本身能写文件——这一版解决的是「没给你的工具调不动」，不是「越权也拦得住」。审批闸仍按既定边界不做。
- `chat` 模式下游模型仍会「说」，只是没有任何工具可调；错误文案里 `（无）` 是字面量，别指望它优雅。
- 面板四档是**本次运行级**的（每次 run 显式带 mode），不是全局持久化偏好——持久化会诱导「以为切了模式其实没切」。

**记分影响**：D-功能 F2 差异化（多模式）+ D-实用 P3（状态可见：本模式可用工具）小增；实用 4.65 保持。


## 批次 Z.29 · 右栏可拖宽（真·能拖，不是画了个手柄）

**现象**：用户报「宽度拖拽还是没有、完全没有反应」。**先查真值再动手**（CDP 9223 打到 47124 运行页）：
1. DOM 里 resizer 存在但只有 **6px 宽、透明、`::after` 常态 opacity:0** —— 肉眼看不出能拖；
2. 旧包里的拖拽用 `setPointerCapture` 且把 move/up 挂在手柄上：capture 一旦静默失败，指针移出手柄后 move 全落到别的元素 —— 表现就是「拖半天没反应」；
3. 窄视口下 `46vw` 上限（762px → 350px）让任何左拖都被夹回原值 —— 看起来也像没反应。

**改动**：
- `FloatingMiniChat.scss`：手柄 6px→**10px**；常显 1px 接缝 + 30px 抓握短条（平时 0.35 透明，hover/聚焦/拖动变 accent 色并加粗）；
- `FloatingMiniChat.tsx`：`pointerdown` 后改挂 **window 级 pointermove/pointerup/pointercancel**（不依赖 pointer capture），up 时落 `ncc_panel_width`；保留 ←/→（Shift ×4）、Home 复位、双击复位；
- `FloatingMiniChat.appearance.ts`：登记 `panelResizer` 部件（否则注册期抛 `Invalid appearance part id`）。

**实测（重建后的包，1600×1000 视口，CDP 真实鼠标事件）**：
- 手柄 10×998px，`elementFromPoint` 命中手柄；
- 拖动 25px×6：宽度 375→400→425→450→475→500（精确 +150）；
- 键盘 ←×2：500→532；双击：→400（默认）；再拖 →520，localStorage=`520`；**reload 后仍 520**；
- 截图 `evidence/screenshots/z29-panel-drag.png`（右栏 520px、左侧接缝可见）。

**判据**：`tools/agent/verify-panel-width.mjs` **33/33**（纯计算边界 + 组件走 window 监听 + scss 手柄 + appearance 登记）；`panelWidth.test.ts` 20/20；`vite build` 通过。

**如实边界**：宽度上限仍 46vw（窄窗不能无限拉宽，这是有意的）；拖动是前端视图偏好，不写宿主。
