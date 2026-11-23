# 念初 · 工作台（Agent UI 原型）

> BitFun 风格的 agent 工作台（纯 HTML/CSS/JS 单文件，无构建依赖）。
> **立绘是占位色块**（真实立绘在作者本机，未随项目打包）。

## 五个视图

| 视图 | 内容 | 状态 |
|---|---|---|
| 🏠 **Home** | 工作台：今日概览（团队代理/决策 trace/步骤/通过率）+ 团队代理卡（动态渲染自 `/api/agents`）| 真数据 |
| 💬 **对话** | 真聊天（接 `ws://127.0.0.1:47124/ws`，`start_dialog_turn` 真模型）| 真数据 |
| 👥 **Agents** | 团队代理（动态渲染自 `/api/agents`：规划者/调研员/实现者/审阅者 + 真实 prompt）| 真数据 |
| 📋 **Task Board** | 看板（Backlog / Ready / In Progress / Blocked / Done，从 `/api/board` 读真任务）| 真数据 |
| ⚙️ **Settings** | 念初真身 · 47124 + 重连 | 真数据 |

## 关键制品（真版链）

- `workbench-v1.html` ~ `workbench-v5.html`：五轮 mock 原型（**BitFun 主题**：白底 / 靛蓝主色 / 圆角卡片 / 左侧 rail）
- **`bitfun-live.html`**：**真版**（BitFun 外观 + 真数据：`ws://127.0.0.1:47124/ws`，真模型/真工具/真 trace）
- **验证**：`verify-workbench.mjs`（服务器真跑 + 静态检查）→ **12/12 通过**
- **真图**：`screens/workbench-*.png`（5 张）、`screens/bitfun-live-home.png` / `screens/bitfun-live-session.png`（真版）

## 设计要点（BitFun 抄作业）

- **左侧 rail 260px**：logo「念初 真版」（靛蓝 + 蓝底 pill）+ 6 项导航（active 蓝底 + 蓝字 + border）+ 底部版本（`念初真身 · 47124`）
- **顶栏**：左侧连接状态（`已连接 · ws://…/ws`，green dot + 等宽字体），右侧「重连」
- **主区**：标题 + 副标题 + 4 统计卡（白底 + 圆角 + 细边框）+ 团队代理卡
- **配色（BitFun 主题）**：白底 `#ffffff` / `#f7f7f8`，主色 `#4a6cf7`，文字 `#1d1d1f` / `#6e6e73` / `#aeaeb2`，边框 `rgba(0,0,0,.08)`
- **布局**：`grid-template-columns: 260px 1fr`，`minmax(0,1fr)` 防撑破
- **Skills**：不用（该页面是 mock 看板，不依赖交互）

## 起服务器

```powershell
# 推荐：一次性两个服务
node tools/workbench/serve.mjs   # 47124（API + 静态）
# 打开 http://127.0.0.1:47124/prototype/agent-ui/

# 只看静态
python -m http.server 8904       # → /bitfun-live.html
```

## 验证（真跑）

```powershell
node prototype/agent-ui/verify-workbench.mjs   # 12/12 通过（服务器真跑 + 静态检查）
```

## 目录

```
prototype/agent-ui/
├─ workbench-v1.html ~ workbench-v5.html   # 五轮 mock
├─ bitfun-live.html                        # 真版（真数据）
├─ screens/                                 # 真图（5 mock + 2 真版）
├─ verify-workbench.mjs                     # 验证脚本
└─ README.md
```

## 生态定位

- **mock 版**（v1/v2/v3）只是**视觉参考**（BitFun 主题已固化进 `bitfun-live`）
- **bitfun-live.html** 是**落地主战场**：接真模型（`auto/claude-sonnet-5-5`）、真工具（规划者/调研员/实现者/审阅者）、真 trace（`auto-claude-sonnet-5-5 · in 18 / out 54`）

## 验证（2026-08-12 真跑）

- **Home**：已连接；团队代理 **4**（规划者/调研员/实现者/审阅者，**真实 prompt 原文**）
- **Session**：真发「用一句话介绍你自己」→ 真模型回复「我是 Claude,由 Anthropic 开发的 AI 助手…」；`auto-claude-sonnet-5-5 · in 18 / out 54`（**真实 usage**）

**截图**：`screens/bitfun-live-home.png`（Home 真代理）、`screens/bitfun-live-session.png`（Session 真模型）
