# 对标记分表（三维：实用 / 美观 / 功能设计）

> 口径见 `00-INDEX.md` §1。0–5 分，必须附证据；无证据记「?」。此表随批次更新。
> 更新：2026-11-21（批次 1：Qoder；批次 2：WorkBuddy / CodeBuddy CN；批次 3：Cherry Studio）

| 项目 | 类型 | D-实用 | D-美观 | D-功能 | 关键证据 | 备注 |
|---|---|---|---|---|---|---|
| **Qoder** | 闭源 | 4.5 | 4.3 | 4.5 | 真实截图 evidence/qoder-home.png；renderer 14129 文案 | 见 qoder.md / screenshots-real.md |
| **Cursor** | 闭源 | 4.2 | 4.0 | 4.3 | 截图 evidence/cursor-agents.png；`/`+`@`、起手建议 | screenshots-real.md |
| **WorkBuddy** | 闭源 | 4.5 | 4? | 5.0 | 截图 evidence/workbuddy-home.png；**12,095 条**中文文案按区聚类（`evidence/wb-by-area.json`）；**源码级 5 交互模式 = 显式工具白名单**（`interactionmode/*/fragments/interaction.md`）+ 4 起手模板（27–31KB prompt）+ 3,644 个分层设计令牌 | **美观记 ?（未取到登录后界面，不臆断）**；功能 5.0 为全表最高 |
| **CodeBuddy CN** | 闭源 | 4.5 | 4? | 4.5 | 截图 evidence/codebuddy-home.png；**5,729 条**中文文案（`\uXXXX` 还原后抽取，`evidence/cbcn-by-area.json`）；5 工作模式 + 从 VS Code/Cursor 导入 + 命令风险三级 + 双层记忆 | **美观记 ?（需扫码登录）**；组件库 demo 文案占比未量化 |
| **Cherry Studio** | **开源** | 4.7 | 4? | 4.8 | **20,286 条**中文文案（`evidence/cherry-by-area.json`）；`package.json` 依赖面：**双 Agent 内核**（claude-agent-sdk + pi）+ 本地向量库（sqlite-vec/onnx）+ **三套 OCR** + 划词钩子；上下文**彩色网格** + 三档压缩；**8 个导出目标**；7 档推理强度；1,107 个设计令牌（含布局量） | **美观记 ?（未启动截图）**；功能 4.8（依赖面是最强证据）；Emoji 分类标签占去重数大部分 |
| **星云创** | 闭源 | 3.8 | **?** | 4.2 | `web-dist` 静态分析：11 chunk（canvas/flows/chat 三合一）+ **1,491 条**中文文案；节点画布+工作流+模型能力分槽 | 见 xingyunchuang.md；**美观记 ?（未启动，无截图不猜）**；不同赛道（AIGC 生成），仅可迁移「模型能力分槽/工作流模板」 |
| **念初（apps/vouch-web）** | 自有 | 4.65 | 4.4 | 4.6 | 批次 A–Z 每批都有截图 + 可复算证据（`evidence/improve-*`、`evidence/theme-mode.json`）：@//、Markdown、`/` 面板（**186 项分类 + 描述参与搜索**）、`@` **真实工作区文件引用**（内容真进上下文，答出 60KB 上限）、调用统计真实热力图、消息级操作、会话历史（含重命名/删除）、停止生成（`stoppedInMs=207`）、视觉令牌统一（`purpleHits=[]`）、动手模式 + 工具卡片 + 流式步骤 + 行内 diff + changeSet 撤销、**图片多模态（答"深红色"）**、面板+神经图双主题、回到最新、Markdown 导出、**计划图层（`todo_write` 整表快照 → 计划面板 3/3 + 进度条，`verify-plan.mjs` 22/22）**、**上下文用量网格（20 格 + `2,529 / 6,000`，最近一轮真实装配，`verify-context-usage.mjs` 19/19）**、**主题模式三档（浅色/深色/跟随系统，`verify-theme-mode.mjs` 37/37 + 浏览器 15/15）**、**工具卡命令风险徽标（high/medium/low 三重编码，`toolRisk.test.ts` 23 条）**、**主题模式三档入口（浅/深/跟随系统，深色 `rgb(14,14,16)`、浅色 `rgb(248,248,249)` 实测，`verify-theme-mode.mjs` 37/37 + 浏览器 15/15）** | 实用 4.65（`@` 真文件引用对标 Cursor 同档；**运行状态条补齐「为什么停/耗时/trace/用量」**）；功能 4.6（计划工具与 dsh `tool-todo` 契约对齐）；美观 4.4 已超 Qoder 4.3（**上下文可视化对齐 Cherry、深色从"不可达"变一等公民**，仍缺：审批卡（**有意不做**）、子代理卡片**端到端+内部工具流下钻已补（Z.5/Z.6）**、竞品逐屏对照未补完；**批次 Z.7 修用户直报三处：开场动画删除 / 底部元信息 56→19px 一行 / 神经图闪烁（全图关动画 + 同帧合并 fit）**；**批次 Z.8 移植 Claude 外观（复用 dsh-claude-style 配色卡，新增 claude-light/claude-dark 两套预设，实测 accent #d97757 / canvas #ffffff、#191919，`appearance` 测试 163/163）**；**批次 Z.9 提问跳转（turn-nav 胶囊，12 条单测 + 实测 4/4→3/4、scrollTop 68→4488）**；**批次 Z.10 长回复折叠（>2200 字或 >45 行默认折，实测 1781 字→360px + 展开/收起）**；**批次 Z.11 历史会话按日期分组（今天/昨天/更早，9 条单测 + 实测「今天」+相对时间）**；**批次 Z.12 会话标题清洗（去「目标/请」前缀+词边界截断，10 条单测 + 实测 60 行 0 脏名）**；**批次 Z.13 完成提示（声音/后台桌面通知，默认关，10 条单测 + 实测开关持久化）**；**批次 Z.14 工具调用竖列（抽取 ToolSteps，7 条 DOM + 9 条单测；无真实步骤截图，如实标注）**；**批次 Z.15 会话搜索命中片段（7 条单测 + 实测 6 条命中/计数 2/6/高亮截图）**；**批次 Z.29 右栏可拖宽（10px 手柄 / 键盘 / 双击复位 / localStorage，实测 350→500 与刷新持久 + 截图 `z29-panel-drag.png`）**；**批次 Z.16–Z.28**：回到底部悬浮按钮、面板主题五档（`panelTheme` 15 条 + 键盘可达 11 条，`verify-panel-theme` 61/61）、提问跳转真接线（28/28）、会话翻页（24/24）、会话置顶+拖动排序（29/29）、工具步骤改用内容 key（12/12）、**工作方式四档且模式=派发处白名单（反例：`tools: ["read"]` 时模型调 write 返回 ok:false 且文件不落盘，`verify-work-modes` 29/29）**） |

## 批次 2–3 新增结论（WorkBuddy / CodeBuddy CN / Cherry Studio）

| 发现 | 证据 | 对念初的动作 |
|---|---|---|
| **「交互模式 = 显式工具白名单」**：WB 5 模式（quick 空 / ask 只读 6 项 / craft 37 项 / expert+plan 39 项），CodeBuddy 5 模式（问答/代码/规划/自动/思考） | `wb interactionmode/*/fragments/interaction.md`；`cbcn-by-area.json`【模式】 | 念初只有 `chat`/`do` 二态（`NianchuChat.tsx:231`），**补 `ask`（只读）与 `plan`**，并让 UI 显示「本模式可用工具」 |
| 模式失效要能降级 | CB `当前工作模式不可用，请切换其他模式后重试` | 念初现在只报错，补「可切换」引导 |
| 起手模板带系统提示 | WB `welcomemode/*/prompt.tpl` 27–31KB × 4（work/code/design/claw） | 念初能力胶囊只填输入框，**绑定意图→系统提示** |
| 配置迁移导入 | CB `从 VS Code 导入` / `从 Cursor 导入` / `导入配置` | 补「从 Cursor/VS Code 导入」 |
| 命令风险三级（纯展示） | CB `高风险命令，可能影响系统稳定性` / `中风险命令，请谨慎执行` | 工具卡标风险等级（**不做审批闸**，守既定边界） |
| **上下文可视化** | Cherry `以彩色网格可视化当前上下文使用情况` + `上下文数 / 最大上下文数` | ✅ **已对齐（批次 Y）**：20 格网格 + `2,529 / 6,000` + 省略条数，数据来自宿主最近一轮真实装配（落盘 `context`，`verify-context-usage.mjs` 19/19）；**未做** Cherry 的三档压缩开关（装配侧无对应能力，不做假开关） |
| 布局量令牌化 | Cherry `--assistants-width` / `--app-top-chrome-height` | 面板/侧栏宽度提为令牌（拖拽调宽前提） |
| 导出粒度 | Cherry `导出时包含思维链` / `不导出引用内容` | 补「导出含/不含思维链」粒度 |
| 双层记忆 | CB `项目记忆` + `生成对话记忆` + `按项目分别保存工作记忆，跨会话保留上下文` | **部分对齐（批次 Z.3）**：召回**明细上屏**（命中 key + 80 字预览，`truncated` 如实说还有几条没展开）。**仍差一层**：念初记忆是单一 KV 库（key/value/source/ttl），没有 CB 的「项目记忆 / 对话记忆」两层分离 —— 不记「平」 |
| 异常分类可诊断 | CB 网络/代理/DNS/模型四类；Cherry 10+ 类且每类给下一步 | ✅ **已对齐（批次 Z.4）**：`diagnoseError` 五类（网络/代理/DNS/超时/模型）+ 每类「下一步」+ 原文可展开；判不出→显示原文不臆断（`verify-error-diagnosis` 27/27） |
| 快捷键冲突检测 | Cherry `该快捷键已被系统或其他应用占用` | ✅ **已在**（`KeyboardShortcutsSection.tsx` 内置实时冲突检测：`buildFinalConflictMap` 标红冲突行 + `conflictBlocking` 禁止「应用」；本轮代码级核对，未单独截图） |
| 标签 / 分组 | Cherry 会话标签 + 分组显示 | **P2：会话标签 + 分组** |
| 审批闸 + 三档权限预设 | Cherry 完整实现（`可自由编辑文件，执行命令前询问` / `预先授权工具` / `总是允许此工具`） | **按既定边界不做**（`总纲.md:18` + `verify-a15-approval.mjs`）；**不记「平」** |
| 7 档推理强度 | Cherry `禁用→最高` 七档 + 思考预算上限 | 不做（念初无统一 reasoning 参数面） |
| 全局搜索 6 类实体 | WB `频道/任务/产物/资料库/联系人/聊天记录` + 分组 + 查看全部 | 念初已对齐（federatedSearchEngine + 5 provider），不重复造 |
| 跨设备/小程序发布/额度门禁 | WB `edge-sync`、`workbuddy-baas-v2`；CB 企业额度 | **不做**（超出念初产品边界） |


## 念初基线分项（批次 1 初测 → 批次 A–J 更新）
| 维度 | 子项 | 现状 | 证据 |
|---|---|---|---|
| D-实用 | P1 上手 | 首屏神经图+主 agent；空态起手胶囊；`@`/`/` 补全；**图片粘贴/拖入** | `improve-p0-*.png`、`improve-image-attached.png` |
| | P2 密度 | 助手 Markdown、模型/用量元信息、会话累计用量；**动手模式工具卡片（真实执行记录，可展开）** | `improve-markdown.png`、`improve-model-label.png`、`improve-do-expanded.png` |
| | P3 状态可见 | 四态透传；停止生成显示 `INTERRUPTED`；**工具步骤边跑边出（运行中即有卡）**；**运行状态条（状态/停止原因/耗时/trace/用量，空闲亦占位，`verify-d3-status` 22/22）** | `improve-stop-done.png`、`improve-do-stream-mid.png`、`z-run-status-done.png` |
| | P4 效率 | 消息级复制/重新生成/编辑重发；`/` 可搜索技能面板（186 项，**分类 + 描述命中**）；**`@` 引用真实工作区文件** | `improve-actions-*.png`、`improve-skill-cats.png`、`improve-at-panel.png` |
| | P5 恢复 | 会话历史（真实 list_sessions + 搜索 + 切换 + **重命名/删除**，条数只算真实对话） | `improve-history-*.png`、`improve-session-rename.png` |
| D-美观 | V1 版式 | 首页空白 bug 已修（96d3724c）；设置被面板遮挡已修（522231c0） | 截图+几何 |
| | V2 视觉层级 | 助手无气泡+左侧细线；消息元信息降为 micro；操作条悬停出现；技能面板粘性分组头 + 一行灰描述；**计划面板（进度条 + 三重编码清单，「进行中」加粗、「已完成」删除线，不只靠颜色）**；**上下文用量网格（三档色 + 文案双编码，空格从文本主色派生透明度，明暗两套主题都数得清）** | `improve-visual-tokens.png`、`improve-skill-cats.png`、`improve-plan-final.png`、`ctx-usage-foot.png`、`z-tool-risk.png` |
| | V3 一致性 | 面板紫 → 应用 accent 令牌；`purpleHits=[]`（0 残留） | `improve-visual-tokens.png` |
| | V4 主题与细节 | 面板 + 神经图**双主题实测**：暗色下面板 `rgb(28,28,31)`、场景 `flowBg=rgb(28,28,31)`，切回浅色可逆；**主题模式三档入口**（浅/深/跟随系统，持久化 + 运行期跟随系统） | `improve-theme-dark.png`、`improve-scene-dark.png`、`theme-mode-dark.png`、`theme-mode-system.png` |
| | V5 响应式 | 主 agent 停靠自适应已修（首页图 ResizeObserver） | 几何 828/1228 |
| D-功能 | F1 闭环 | 会话/工具/审批/记忆/成本主干在；调用统计接真实用量账本；**记忆命中看板（批次 Z.3）** | `improve-usage-real.png`、`z-memory-board.png` |
| | F2 差异 | 中断生成（runToken 精确 abort）；插件热更新通道；用量账本；**动手工具流 + 行内 diff + changeSet 撤销**；**计划图层（`todo_write` 整表替换、反例拒绝、`run.plan` 取最后一次成功快照，22/22 判据）**；**子代理卡片端到端 + 内部工具流下钻（真调 `spawn_subagent`，批次 Z.5/Z.6；原默认工具表漏了它，已修）** | `improve-stop-*.png`、`improve-diff-card.png`、`improve-undo-after.png`、`improve-plan-final.png`、`z-subagent-card.png`、`z-subagent-drill.png`、`tools/agent/verify-plan.mjs`、`tools/agent/verify-subagent.mjs` |
| | F3 扩展 | 插件/技能/MCP/ACP 契约在；插件 permissions 已补 | 代码 |
| | F4 安全 | 审计留痕(append-only)、权限声明 在；**审批闸按既定边界未做** | verify |

## 已知「念初明确领先 / 已对齐」项（防回退）
- 审计留痕 append-only（深哈希链、截尾/损坏可检）——功能对照实验 27/27。
- 插件 permissions 显式声明（Qoder 对等）。
- 设置页宿主方法全实现（横扫 42 方法 0 缺失）。

## 待办
- [x] P2 面板宽度可拖拽（批次 Z.29：10px 手柄 + 键盘 + 双击复位 + 持久化；实测 350→500、重启后仍在，`z29-panel-drag.png`；`verify-panel-width` 33/33）
- [ ] Qoder/Cursor/WorkBuddy/CodeBuddy 截图 → 填 D-美观（WorkBuddy/CodeBuddy 需登录，两处仍记 `?`）
- [x] Cherry Studio（开源）美观/交互最佳实践 → 上下文网格已对齐（批次 Y）
- [x] 念初暗色主题入口 → 主题模式三档（批次 Z，`verify-theme-mode.mjs` 37/37 + 浏览器 15/15）
- [ ] 念初 V2/V3/V4 系统评审









