# 闭源四家 · 真实软件截图与功能设计核对（本机实测）

> 方法（可复算、非 mock）：经 `explorer.exe <桌面快捷方式>`（等同用户双击，走用户 shell 上下文）启动本机真实安装包 → 用 Win32 `PrintWindow(PW_RENDERFULLCONTENT)` 抓目标窗口自身内容（不受遮挡/置顶影响，避免抓到上层窗口张冠李戴）。
> 结论：**四家均已成功启动并截到真实界面**（登录态）。截图存 `evidence/{qoder-home,cursor-agents,workbuddy-home,codebuddy-home}.png`。
> 说明：先前用 `Start-Process`/`cmd start` 直启会秒退（自动化令牌限制）；`explorer` 双击法 + PrintWindow 才稳定。这是本机真实界面，**不是 mock 渲染**。

## 1. Qoder（浅色，登录态）— evidence/qoder-home.png
- 布局：左栏（新任务/需要我/搜索 + 工作区列表 + 最近任务）；顶部「编程」页签 + 「手机遥控电脑」；主区大留白欢迎 + **Credits 贡献热力图**（12月–9月，类 GitHub 打卡）+ 会话卡。
- 亮点：Credits 用量热力图（把"用量/配额"做成可视化）；工作区按项目分组。
- 美观 4.3/5：留白克制、字阶清晰；空态用图+口号，不空洞。

## 2. Cursor（浅色，Agent 窗口）— evidence/cursor-agents.png
- 布局：左栏 New Chat / Automations / Customize / Repositories；居中 composer，提示 **「Plan, Build, `/` for skills, `@` for context」**；模型选择 Grok 4.7；三条**起手建议**（Start with a plan / Debug an issue / Create a dashboard）。
- 亮点：极简却信息到位；**`/` 技能 + `@` 上下文**输入；意图化起手建议降上手成本。
- 美观 4.0/5：干净通透；偏空，但克制有设计感。

## 3. WorkBuddy v5.11.3（浅色，登录态）— evidence/workbuddy-home.png
- 布局：左栏（新建任务/助理BETA/专家·技能·连接器/定时任务/资料库/发现 + 最近 + 分组）；主区大标题「WorkBuddy，我帮你」+ **7 个能力胶囊**（创作文档/分析数据/代码开发/UI·UX/生图生视频/金融服务/制作PPT/更多）+ composer「今天帮你做些什么？**@添加上下文，/调用技能与指令**」+ 底部**「允许完全访问」权限档** + 选择分组。
- 亮点：任务类型胶囊（按目的分流）；`@`+`/`；**composer 内直接可见的权限档位**；最近任务时间标注。
- 美观 4.2/5：层级分明、色块克制。

## 4. CodeBuddy CN（深色，登录态）— evidence/codebuddy-home.png
- 布局：左图标栏 + 顶部菜单 + 「打开 Agents」；主区吉祥物 + **两张大模式卡（编程模式 / 工作模式）**；编程模式含 新建/打开文件夹、克隆 Git 仓库；右区 New Chat + 「让想法成为现实」+ 欢迎卡片（快速MVP/Figma转源码/0经验动态网站）。
- 亮点：**编程/工作双模式**卡片式入口；深色主题 + 品牌吉祥物；vibe 编程卖点卡片。
- 美观 4.0/5：深色对比强、吉祥物活泼；信息略密。

---

## 5. 跨家共性最佳实践（念初要超越的基线）
| 能力 | 谁有 | 念初现状 | 差距动作 |
|---|---|---|---|
| composer 支持 `@` 上下文 + `/` 技能/指令 | Cursor, WorkBuddy | 纯 textarea，无 | **P0 补**：`@` 文件/记忆补全 + `/` 技能指令 |
| 按任务类型的能力胶囊/起手建议 | WorkBuddy, Cursor, CodeBuddy | 空态仅一句 | P0：主 agent 空态加"起手胶囊/建议行" |
| 可见的权限档（允许完全访问/审批模式） | WorkBuddy | 有审批组件但无顶栏档位 | P1：composer 显示权限档并可切 |
| 模式卡片（编程/工作/...） | CodeBuddy, Qoder(编程页签) | 单一对话（用户要求过单一，勿再拆 tab） | P2：以 composer 内"模式选择"实现，不拆 tab |
| 用量/配额热力图 | Qoder Credits | 有 token 计量但无可视化 | P2：调用统计页加热力图 |
| 欢迎大标题 + 品牌语气 | WorkBuddy/CodeBuddy | 有"想让念初做什么" | P3：语气与品牌统一 |

## 6. 记分（D-美观，已有真实截图证据）
| 项目 | D-美观 | 证据 |
|---|---|---|
| Qoder | 4.3 | qoder-home.png |
| WorkBuddy | 4.2 | workbuddy-home.png |
| Cursor | 4.0 | cursor-agents.png |
| CodeBuddy | 4.0 | codebuddy-home.png |
| 念初 | 待与本表逐项对照后定 | 见 scorecard.md |

## 7. 诚实边界
- 只截了**首屏/欢迎态**；各家对话中、工具流、设置页、审批弹窗等**尚未逐屏截**（下一步补）。
- 美观分为**评审判断**（附截图），非机械指标；分歧以截图为准。
