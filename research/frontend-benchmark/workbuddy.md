# WorkBuddy 前端 & 功能设计解析档案

> 解析对象：`D:\file\software\WorkBuddy\resources\app.asar`（165MB）→ 已解包 `research/wb-renderer/`（12,226 文件 / 687MB）。
> 方法（可复算）：① 用 `temp/extract-asar.mjs`（复用本机 `@electron/asar`，不联网）解包；② `temp/zh-by-area.mjs` 从 `resources/extensions/*/ui/assets`、`resources/plugins/workbuddy-builtin/**` 抽取中文 UI 文案，得 **12,095 条去重**、**21,443 次出现**（证据 `evidence/wb-by-area.json`）；③ 直接读 `.workbuddy-plugin/plugin.json`、`interactionmode/*/fragments/*.md`、`welcomemode/*/prompt.tpl` 等**未压缩源文件**，模式/工具策略是源码级事实而非推断。
> 版本：`@genie/workbuddy-desktop@5.11.3`，Tencent，`workbuddy.cn`。

## 一、形态与骨架（可复算事实）

- Electron；`main: main/index.js`；`bin: wb`（自带 CLI）。
- **13 个「扩展」(extensions)**，每个是独立的 federated UI 模块（`resources/extensions/<name>/ui/assets/*.js`）：
  `agent-mail · cloud-assistant · community · design-ardot · design-miora · edge-sync · global-search · im-channels · ima · layout-demo · library · remote-desktop · workbuddy-baas-v2`
- **13 个内建插件 (builtin-plugins)**：`ardot · builtin-calendar · builtin-teams-todo · subscription-gate · tencent-docs-plugin · tencent-private-docs-plugin · tencent-xmind · wecom-a2a-auth · weixinpay · workbuddy-creative · workbuddy-docx · workbuddy-pptx · workbuddy-sheetagent`
- **25 个 Skills**、**2 个 MCP**(`agently-cli` / `miora-mcp`)、`hooks`、`prompt-common/fragments`。
- 插件协议 `.workbuddy-plugin/plugin.json`（`category: interaction` 等）；与 Qoder 的 `.qoder-app-plugin` 同类，但**多了 category 分类 + 交互模式插件化**。
- 依赖面很宽：`@larksuiteoapi`(飞书) `@slack/*` `@wecom/*` `dingtalk-stream` `@tencent-connect/qqbot-connector` —— **IM 渠道覆盖 5 家**（企业微信/飞书/Slack/钉钉/QQ）。

## 二、交互模式：5 种，且**每种 = 显式工具白名单**（本档案最关键的发现）

`resources/plugins/workbuddy-builtin/interactionmode/` 下 5 个插件，每个 `fragments/interaction.md` 用 YAML front-matter 声明 `tools:`：

| 模式 | 语义（`current-mode.md` 原文要点） | 工具白名单 |
|---|---|---|
| `quick` | Quick Q&A，纯对话、**无工作区、无工具** | `[]`（空） |
| `ask` | Ask，只读：只答问/读文件/分析；**禁止改文件、禁止 shell**，请求改文件时提示切到 Agent 模式 | `Read ViewImage WebFetch WebSearch Glob Grep` |
| `craft` | Craft，全量动手（读/写/编辑/Glob/Grep/Bash/PowerShell/Task*/Web*/Skill/AskUserQuestion/Agent/Team*/A2A*/Memory*/MCP…） | 37 项，**不含** `EnterPlanMode/ExitPlanMode` |
| `expert` | Expert = craft + 计划模式入口 + `PluginAgentPrompt` 注入 | craft 37 项 **+** `EnterPlanMode ExitPlanMode` |
| `plan` | Plan = expert 同工具面（差别在 fragment 行为而非白名单） | 同 expert |

**这是「模式 = 能力边界」的工程化写法**：不靠 prompt 里喊「不要改文件」，而是模式直接决定工具是否挂载（`quick` 连工具都没有）。念初当前是 `mode: 'chat' | 'do'` 二态（`NianchuChat.tsx:231`），语义上相当于 `quick`（无工具）与 `craft`（run_task 全量）。

## 三、起手模式：4 个 welcomemode，各带 27–31KB 的 prompt 模板

| 模式 | `prompt.tpl` | 附带资产 |
|---|---|---|
| `work` | 31,071 B | — |
| `code` | 30,717 B | — |
| `design` | 26,822 B | `scenes.json`(35.6KB) + `scenes-en.json`(38.9KB) 场景库 |
| `claw` | 23 B（极简，走 `agents/claw.md` 1,010B） | — |

即：**同一个宿主，按「起手意图」换整段系统提示 + 场景库**。念初的空态起手是「能力胶囊」（`NianchuChat.tsx:165`），只填输入框，不换系统提示。

## 四、UI 功能面（由 12,095 条中文文案按区聚类，证据 `evidence/wb-by-area.json`）

> ⚠️ 诚实标注：`community`(4,019) 与 `im-channels`(3,744) 两个区的文案**大量来自组件库 demo 页**（「美國（NASD）30/360」「值1」「运 算子」「数据_x」= 表单/表格组件演示），不能整块算产品功能面。下面只取**产品面**。

| 域 | 证据文案（去重数） | 说明 |
|---|---|---|
| 云服务/小程序发布 `workbuddy-baas-v2`(854) | 发布成功 体验版 小程序码暂不可用 升级套餐 用户隐私保护指引 云服务 | 发布链路 + 套餐门禁 + 合规文案 |
| 设计 `design-miora`(790)/`design-ardot`(772) | 缩放 重置缩放 取消分享 分享给好友 重命名 | 画布式设计（缩放/分享） |
| 云助理 `cloud-assistant`(509) | 运营人力 内容创作 知识与学习 办公协同 法务安全 效率工具 数据分析 | **按职能分组的场景目录** |
| 智能体邮箱 `agent-mail`(356) | 开通智能体邮箱 停用 已封禁 停用后将停止接收新邮件通知 | 邮箱生命周期 + 封禁态 |
| 全局搜索 `global-search`(185) | 频道 任务 产物 资料库 联系人 聊天记录 查看全部 | **6 类实体 + 分组 + 查看全部** |
| 文件预览 `ima`(342) | 此文件暂不支持预览 文件下载失败 加载更多… 确认解绑 | 预览降级 + 解绑 |
| 跨设备 `edge-sync`(292) | 对方设备已断开，请确认对方电脑在线后重试 已取消 未命名 | 设备在线校验 + 取消态 |
| 专家推荐 `builtin-expert-recommendations`(163) | 数据分析 深度调研 代码审查 交易策略 竞品分析 架构设计 估值建模 品牌叙事 | **18 个专家角色**（`curated-experts.json`） |
| 场景模板 `welcomemode`(64) | 旅游攻略 新品发布直播海报 电商大促宣发海报 泡茶六步骤 双人访谈预告海报 | 起手模板（含分步骤场景） |
| MCP `mcps`(238) | 已添加 {{count}} 个文件到对话 导出为 GIF 无法创建 Canvas 上下文 | 文件入对话 + 导出 |

## 五、设计令牌（美观维度的可复算证据）

- `resources/**/*.css` 中 **3,644 个去重 CSS 自定义属性**。
- 命名分层两类：`--wb-<component>-<part>-<state>`（如 `--wb-button-ghost-fg-active`、`--wb-datepicker-today-btn-color`、`--wb-pagination-total-line-height`）与 `--WB-IM-<Card>-<Role>`（如 `--WB-IM-Card-Chart-Series-6`）。
- 覆盖组件：button / popover / card / datepicker / table / pagination / tabs / alert / tag / checkbox / radio / select / avatar / notification / image / skeleton —— **每个组件都有独立的状态矩阵**。
- 对照：念初 `apps/vouch-web/src/web-ui/src/**/*.css` 去重 **90 个**（`--iui-*` 71 + shadcn 语义 19）。
  **不可直接比数量**（WB 是成熟组件库，念初是手写 CSS + 少量组件令牌）；可比的是**每组件状态覆盖度**，WB 明显更细。

## 六、三维记分（0–5，附证据强度）

| 维度 | 分 | 依据 | 证据强度 |
|---|---|---|---|
| D-实用 | 4.5 | 5 交互模式（含只读/纯对话两种安全态）、4 起手模板、6 类全局搜索、专家角色 18 个、文件入对话 | 源码级强证据；**布局与视觉待截图** |
| D-美观 | 4? | 3,644 个分层设计令牌、组件级状态矩阵 | 令牌强证据；**外观待截图，不臆断** |
| D-功能 | 5.0 | 13 扩展 + 13 内建插件 + 25 skills + 2 MCP + 5 IM 渠道 + 跨设备同步 + 小程序发布 | 包体强证据 |

## 七、念初 vs WorkBuddy（差距 → 改进动作）

| 子项 | WorkBuddy | 念初现状 | 动作 |
|---|---|---|---|
| 交互模式数 | 5（quick/ask/craft/expert/plan） | 2（chat/do，`NianchuChat.tsx:231`） | **补 `ask`（只读）与 `plan`（先出计划再执行）**：这两态是真实高频需求，且能复用现有 `run_task` 通道 |
| 模式=工具白名单 | 源码级 `tools:` 声明 | 靠 `mode === 'do'` 分支 | **把模式做成显式工具白名单**，UI 上显示「本模式可用工具」 |
| 起手模板 | 4 套 27–31KB prompt + 场景库 | 能力胶囊只填输入框 | 起手胶囊带「意图→系统提示」绑定（先做 work/code 两套） |
| 全局搜索 | 6 类实体 + 分组 | **已有** federatedSearchEngine + 5 provider | ✅ 已对齐（不重复造） |
| 专家角色 | 18 个 curated | 有「角色」概念（待核 catalog） | 核 `interactive-capabilities.json` 是否覆盖；缺则补 |
| 令牌体系 | 3,644 个组件级令牌 | 90 个 | 按组件补状态令牌（不刷数量，按真实用到的状态补） |
| 跨设备/发布 | edge-sync + 小程序发布 | 无 | **不做**（超出念初产品边界） |

## 八、证据缺口（不臆断）

1. **无截图**：WorkBuddy 需登录，未取到真实界面截图；本档案所有「布局/视觉」判断均未下结论。
2. `community` / `im-channels` 区的中文文案混入组件库 demo，功能面已按表剔除，但**聚类边界仍偏粗**。
3. 5 个模式的**运行期差异**（expert vs plan 的行为差别）只从 fragment 文本推断，未跑起来验证。
