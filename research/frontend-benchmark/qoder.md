# Qoder 前端 & 功能设计解析档案

> 解析对象：`D:\file\software\Qoder\resources\app.asar`（127MB）→ 已解包 `research/qoder-renderer/`（6287 文件）。
> 方法（可复算）：① 读 main 进程与插件包结构；② 从 renderer 产物 `out/renderer/assets/*.js`（508 个 JS，40.8MB）抽取真实中文 UI 文案 **14,129 条**（`temp/extract-qoder-zh.mjs`），据此反推功能面；③ 视觉截图待补（有登录墙）。
> 注意：以下「有某文案」= 该界面/功能确实存在；强度与美观打分需截图佐证，暂标证据强度。

## 一、形态与骨架（可复算事实）
- Electron 应用；`productId=qoder`，协议 `qoder://`，更新源 `download.qoder.com.cn`。
- 5 个内置扩展：`computer-control / find-extensions / index-settings / knowledge.center / security`。
- 自有插件协议 `.qoder-app-plugin/plugin.json`：**显式 `permissions`**（如 `chat.observeTurn`、`chat.continueSession`）+ `contributes.qoderAgentSdk.plugins`（MCP 工具注册，带 enablement）+ `nativeModules`。
- MCP 工具面：computer-use 16（GUI：list_apps/click/drag/scroll/press_key/type_text/run_steps…）、qoder-qmind 知识库 7、record-and-replay 3（录制→生成 SKILL.md）。

## 二、UI 功能面（由 14,129 条中文文案聚类，按出现频次佐证存在性）
| 域 | 证据文案（节选，次数） | 说明 |
|---|---|---|
| 会话/对话 | 重试(126) 取消(57) 这轮回复失败(23) 已停止(18) 重新发送(8) 思考中(6) 排队中(6) | 完整轮次态：思考/排队/执行/失败/停止/重试 |
| 计划/任务 | 计划(10) 任务(12) 添加到任务(6) 下一步(8) 子 Agent(7) | 计划图层 + 子 Agent 编排 |
| 智能体 | 智能体(10) 子 Agent(7) 成员(16) 讨论(11) 分享(10) | Agent + 团队协作(成员/讨论/分享) |
| 插件/扩展 | 插件(17) 技能(7) 连接器(6) 指令(7) 添加文件夹(6) | 插件市场 + 技能 + MCP连接器 + 斜杠指令 |
| 记忆/知识 | 记忆(8) 没有发现需要导入的记忆(8) 来源(7) | 记忆导入 + 知识库(QMind) |
| 自动化 | 自动化仅支持桌面端(8) | 自动化任务（桌面专属） |
| 订阅/账号 | 升级订阅计划(6) 版本(10) | 订阅门禁 + 版本管理 |
| 设置 | 通用(14) 设定(8) 默认(7) 自定义(6) | 通用/自定义设置 |
| 状态/交互 | 已连接(9) 连接失败(7) 状态未知(7) 最近使用(8) 今天/昨天/最近7天 | 连接态 + 最近使用分组 |

## 三、功能设计亮点（值得念初对标）
1. **权限显式声明**（F4 安全边界）：插件必须声明 `permissions`，可审计。
2. **电脑控制 GUI 16 工具**（F2 差异化）：点/拖/滚/按键/输入/run_steps 全操作面。
3. **录制回放转 Skill**（F2）：event_stream → SKILL.md，把演示固化为能力。
4. **团队协作面**：成员/讨论/分享（念初只有单人）。
5. **子 Agent 编排** + 计划图层。
6. **不可信数据边界写死在 SKILL.md**（F4）。

## 四、三维记分（0–5，附证据强度）
| 维度 | 分 | 依据 | 证据强度 |
|---|---|---|---|
| D-实用 | 4.5 | 轮次态齐全、计划/子Agent、快捷指令、最近使用分组 | 文案强证据；布局待截图 |
| D-美观 | 4? | VSCode 分支成熟设计体系，双主题 | **待截图**（不臆断） |
| D-功能 | 4.5 | 电脑控制/录制回放/权限声明/团队协作，确为强项 | 包体强证据 |

## 五、念初 vs Qoder（差距 → 改进动作）
| 子项 | Qoder | 念初现状 | 动作 |
|---|---|---|---|
| 权限声明 | 有 `permissions` | 已补 ui-plugin permissions（对等） | ✅ 已对齐 |
| 审批闸（风险等级/作用域/始终允许/解释） | 有完整审批卡（§6.1） | **按既定边界不做**（verify-a15 钉住） | 有意差异，不记平、不做假弹窗 |
| 变更撤销（changeSet 粒度） | 有（§6.3） | 已接 `rollback_change`，界面可撤销（批次 Q） | ✅ 已对齐 |
| 电脑控制 | 16 GUI 工具 | 有 ComputerUsePermissions/ControlAPI，深度待核 | 需实测深度 |
| 录制回放 | 有 | 无 | 立项评估 |
| 团队协作(成员/讨论/分享) | 有 | 无（单人） | P2 评估 |
| 子Agent编排 | 有 | 有子 Agent（待核 UI） | 核对 |
| 轮次态(思考/排队/重试) | 齐全 | 有（需截图核） | 截图核对 |

## 六、审批 / 工具参数 / 变更撤销（2026-11-22 补充，源码级证据）

> 方法：在 `out/renderer/assets/*.js` 里按中文字串定位，取上下文（`temp/qoder-strings.mjs`，可复算）。
> 这些是**真实界面文案与组件属性**，不是推测。

### 6.1 权限审批卡（`assets/ClMoALKS.js`、`assets/D7G81Cst.js`）
- 按钮组（`ClMoALKS.js`，`Button variant/size/rounded` 属性齐全）：`取消`（outline）/ `始终允许`（outline, pill）/ `允许一次`（primary, pill）。
- 审批卡字段（`D7G81Cst.js`）：`product 产品` · `operation 操作` · `scope 作用域` · `riskLevel 风险等级`（`riskLow 低风险 / riskMedium 中风险 / riskHigh 高风险`）· `toolArguments 工具参数` · `allowOnce 允许本次` · `allowSession 本次任务允许` · `allowAlways 始终允许` · `configLink 查看更多权限配置`。
- 解释能力：`explain 解释`、`analyzingIntent 正在分析操作意图...`、`explainFailed 暂时无法解释此操作。你仍可直接允许或拒绝，也可以重试解释。` —— **审批不是只有按钮，还提供「为什么」**。
- 任务级授权粒度：`rules.add allow/deny/ask`（本次任务允许/拒绝/仍询问）、`directories.add 本次任务始终允许访问“{{scope}}”`、`mode 本次任务使用“{{mode}}”模式`。
- 另有「灵动岛」聚合入口：`approvalBadge 批准`、`decline 拒绝`、`asks 正在询问`，`description 在屏幕顶部查看会话进展、回答问题和处理权限请求`。

### 6.2 工具参数呈现
- `toolArguments 工具参数` + `collapse 收起` / `expand 展开完整内容`：参数默认折叠、可展开全文（和念初工具卡「点开看完整 JSON」同类，但 Qoder 多了「解释」。

### 6.3 变更撤销（`assets/DMzt2vcU.js`）
- 代码里有 `文件撤销交互` 埋点，参数含 `{ sessionId, stage, outcome, changeSetId, conversationIsWorking, undoPreparingId }` —— 说明**撤销是按 changeSet 粒度**、且会考虑「会话正在跑」的冲突（`blocked` 分支）。

### 6.4 对念初的结论（诚实）
- **审批闸**：Qoder 有完整审批卡（风险等级/作用域/始终允许/解释）。念初**按既定边界不做审批闸**（`tools/agent/verify-a15-approval.mjs` 明确钉住「未做」），因此这一项**不记为「平」**，是**有意的差异**，不能靠加个假弹窗刷分。
- **工具参数展开**：念初已有（批次 L），对齐。
- **变更撤销**：Qoder 按 changeSet 撤销；念初宿主已有 `rollback_change` / `list_changes`，但**界面还没接**，列为下一步候选（接上后才是真对齐）。

## 七、待补（证据缺口，如实标注）
- [ ] Qoder 各主界面**截图**（登录墙：需账号或离线渲染 mock）
- [ ] 美观度 V1–V5 逐项打分
- [ ] 电脑控制/团队协作的实际交互录屏
- [x] 审批/工具参数/撤销的源码级文案证据（见 §6）
