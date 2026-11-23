# 对标前端 & 功能设计解析 —— 总纲与注册表

> 目标（对应 goal）：解析所有对标项目的前端界面与每一项功能设计，产出逐项档案；在【实用性 / 界面美观度 / 功能设计】三维度对念初（apps/vouch-web）做到全领域超越，每项改进有截图或可复算证据。
> 纪律：开源读源码；闭源读本机真实包体（asar 解包 + renderer 分析，必要时启动截图）；拿不到如实标「未定位」。不靠痕迹刷分，不可比不当作「平」。
> 建立：2026-11-21

---

## 1. 三维评分口径（让「超越」可量化、可复算）

每个维度 0–5 分，**评分必须附证据**（截图 / 代码位置 / 交互录屏）。无证据 = 记「?」（不参与均分）。

### D-实用（实用性 / 效率）
| 子项 | 说明 |
|---|---|
| P1 上手成本 | 首屏是否即用、空态是否有引导、关键操作几步可达 |
| P2 信息密度 | 一屏有效信息量（工具流/diff/计量/状态） |
| P3 状态可见 | 计划/进度/审批/成本/中断态是否可见 |
| P4 键盘/效率 | 快捷命令、@提及、多行、拖拽、批量 |
| P5 可恢复 | 检查点/回滚/重试/断线重连 |

### D-美观（界面美观度）
| 子项 | 说明 |
|---|---|
| V1 版式与留白 | 栅格、对齐、留白、无溢出/无大片空白 |
| V2 视觉层级 | 字阶/色阶/分组，主次分明 |
| V3 一致性 | 组件/间距/圆角/图标风格统一 |
| V4 主题与细节 | 明暗主题、动效克制、空/加载/错误态美观 |
| V5 响应式 | 面板收起/窗宽变化时内容自适应（近期首页空白 bug 即此项） |

### D-功能设计（Feature design）
| 子项 | 说明 |
|---|---|
| F1 核心闭环 | 会话/工具/审批/记忆/成本等主干是否完整可用 |
| F2 差异化能力 | 电脑控制/录制回放/多模式/权限声明/云鉴权等 |
| F3 可扩展 | 插件/技能/MCP/ACP 的契约清晰、可挂载 |
| F4 安全边界 | 权限声明、审批闸、不可信数据边界、审计留痕 |

> 对标记分表格式：`项目 | D-实用 | D-美观 | D-功能 | 关键证据 | 念初当前 | 差距动作`

---

## 2. 对标项目注册表（本机可解析产物 + 方法）

| # | 项目 | 类型 | 本机产物（实测路径） | 解析方法 | 状态 |
|---|---|---|---|---|---|
| 1 | **Qoder** | 闭源 Electron | `D:\file\software\Qoder\resources\app.asar`(127MB)；已解包 `research/qoder-renderer/`(6287 files) | 解包 renderer + 源码读 + 启动截图 | 进行中（见 qoder.md） |
| 2 | **WorkBuddy** | 闭源 Electron | `D:\file\software\WorkBuddy\resources\app.asar`(165MB)；已解包 `research/wb-renderer/`(12,226 files) | 解包 + 中文文案按区聚类(12,095 条去重) + 读交互模式/起手模式源码 | ✅ 已完成（见 workbuddy.md） |
| 3 | **WorkBuddyAI** | 同 2 的**国际版构建** | `...\WorkBuddyAI\...app.asar`(173MB)，`@genie/workbuddy-desktop@5.9.3`，`workbuddy.ai` | 与 #2 同产品线（国内版 5.11.3 / 国际版 5.9.3），**不重复建档**，只记版本差 | ✅ 已判定（合并进 workbuddy.md） |
| 4 | **CodeBuddy CN** | 闭源 VSCode 分支 | `D:\file\software\CodeBuddy CN\resources\app`（VS Code 1.106.1 + `out/codebuddy/main.js` 60MB） | 读 product.json + `\uXXXX` 还原后抽中文文案(5,729 条去重) | ✅ 已完成（见 codebuddy-cn.md） |
| 5 | **Cursor** | 闭源 VSCode 分支 | `D:\file\software\cursor\resources\app\product.json` | product.json + 扩展；Agent UI 在 asar 主包 | 待办 |
| 6 | Cherry Studio | **开源** AI 客户端 | `D:\file\software\Cherry Studio\resources\app.asar`(231.5MB)；已解包 `research/cherry-renderer/`(17,495 项) | 解包 + `package.json` 依赖面 + 中文文案按域聚类(20,286 条去重) + CSS 令牌 | ✅ 已完成（见 cherry-studio.md） |
| 7 | raccoon-ai / TapNow / XingYunChuang | 闭源 AI app | 均含 app.asar；**星云创 `web-dist` 已静态分析**（11 chunk / 1491 条中文文案） | 读 web-dist 打包产物 | **星云创 已建档 → [xingyunchuang.md](xingyunchuang.md)**；TapNow=画布型消费 app（仅 offline/多区节点，相关度中）；raccoon-ai 未定位到 renderer（assets 空） |
| 8 | Trae / ChatGPT / Claude | 闭源 | 本机**未定位** | — | 未定位（如实标注） |
| 9 | cl4r1t4s | GitHub 仓库 | `elder-plinius/CL4R1T4S`（未 clone） | git clone 读 | 待办 |
| 10 | 开源 agent 系（OpenHands/OpenClaw/OpenClaude/ECC/WeKnora/RAGFlow/Dify/CoWAgent/nocobase/metagpt/luanyujia/omp-studio 等） | 开源 | `research/拆解2/*.md`(24 份) + `research/repos`,`D:\refs` | 读源码 + 已有拆解 | 复用已有拆解，补前端/ UX 章节 |

> 说明：Capability 矩阵里 21 家可比 + 7 闭源的**功能**已由 fair-compare/project-verdict 覆盖；本工程聚焦**前端/交互/功能设计**这一支，闭源部分靠本机包体补。

---

## 3. 批次路线（每批：解析 → 记分 → 差距 → 改进 → 截图验证 → 提交）

- **批次 1（进行中）**：Qoder 全量前端/功能档案 + 记分。
- **批次 2**：WorkBuddy / WorkBuddyAI / CodeBuddy（同源 genie）+ Cursor（VSCode 分支共性一起归纳）。
- **批次 3**：Cherry Studio（开源，抓聊天/多模态/助手管理的**美观与交互**最佳实践）。
- **批次 4**：开源 agent 系补齐前端/UX 章节（复用 research/拆解2）。
- **批次 5+**：以记分差距为输入，逐项改进念初（先 P0 体验/一致性，再功能），每项截图对比 + 提交。

---

## 4. 目录

- `00-INDEX.md`（本文件）
- `qoder.md`、`workbuddy.md`、`codebuddy.md`、`cursor.md`、`cherry-studio.md`…（逐项目档案）
- `scorecard.md`（汇总记分表，随批次更新）
- `evidence/`（截图、代码位置引用）
| 11 | **dsh-claude-style**（用户指定外观参照） | 开源（DSH 皮肤包） | `github.com/Nwflower/dsh-claude-style` master @ 2026-11-22T11:47Z；codeload zip 6.5MB → `packages/client/src/theme/{tokens.css,tokens.json}` + chrome/sidebar/typography.css | 读主题 CSS/令牌，把 Claude 配色移植到念初外观系统（不做逐行复制） | 批次 Z.8 已移植 Claude 配色为 claude-light/claude-dark 两套预设（实测选择生效） |
