# 主 Agent 界面改造方案（基于 dsh-claude-style 参考）

> 参考：`dsh-claude-style` v0.20.3（Nwflower，561 stars）
> 设计规范：`研究素材/参考-dsh-claude-style-设计规范.md`（75 KB）
> 截图：`研究素材/参考截图/`

---

## 一、从参考里学到的核心原则

### 1. 从不用纯黑，从不用冷灰

> "Never pure black, never a cold gray. Each canvas pair is read as one family:
> the canvas, its sidebar, its borders and every ink step around them derive
> from that card's seed."

**我的问题**：`#0E1114` / `#151A1F` / `#232A31` 都是冷灰偏黑。

**改法**：用「种子色 + 色阶」——所有颜色从种子派生，暖偏（不用纯中性灰）。

### 2. 色彩阶梯（tone ladder）

参考的阶梯（每个 tone 是种子的 Δl 亮度偏移）：

| Tone | 用途 | 亮色 Δl | 暗色 Δl |
|---|---|---|---|
`canvas` | 画布底 | 0 | 0 |
`surface-1` | 面板 | 0 | +0.036 |
`surface-2` | 面板内层 | 0 | +0.065 |
`surface-3` | 更高一层 | +0.002 | +0.104 |
`overlay` | 浮层 | +0.01·C0 | +0.065 |
`code-block` | 代码块 | +0.01·C0 | +0.036 |
`card` | 卡片 | 0 | +0.044 |
`bubble` | 消息气泡 | -0.037 | +0.09·α0.06 |
`border-1/2/3` | 边框三级 | -0.067/-0.098/-0.144 | +0.026·α0.09/0.18/0.3 |
`divider` | 分隔线 | 0·α0.05 | +0.026·α0.06 |
`ink` | 主文字 | -0.801 | +0.781 |
`ink-2` | 次要文字 | -0.474 | +0.571 |
`ink-3` | 辅助文字 | -0.365 | +0.458 |
`ink-4` | 最弱文字 | -0.251 | +0.336 |
`accent` | 强调色 | 种子 | 种子 |

**关键洞察：暗色下所有 surface 是「往上加亮」，所有 border 是「半透明白」**（不是深色线条）。

> "in dark not a colour but a highlight. The three border tokens are one
> translucent white at three strengths, so a card reads as a chamfer catching
> the top light."

**我的问题**：`border: 1px solid #232A31` —— 暗色下用深色描边，看起来「脏」。

### 3. 强调色 < 10% 可见元素

> "Accent usage stays under ~10% of visible elements."

**我的问题**：蓝色用在了发送按钮、状态灯、代码高亮、链接、工具调用标记……加起来超过 10%。

### 4. 圆角阶梯 4 / 8 / 16，popover 12/6

> "Radius: a ladder of 4 / 8 / 16 px, a 12px popover card with 6px rows, and
> pills for CTAs."

**我的问题**：3 / 4 / 5 / 6 混用。

### 5. 间距 4px 节奏

> "Spacing: 4 px rhythm."

**我的问题**：5 / 6 / 7 / 8 混用。

### 6. 分隔线 0.5px，边框 1px

> "Separator: a rung below the lightest border, drawn at 0.5px on every line
> that only separates."
> "A card, a field and a popover keep their 1px border in l1, so an outline
> always reads heavier than a separator inside it."

### 7. 动效分角色，全部 token 化

| 角色 | 时长 | 缓动 | 用途 |
|---|---|---|---|
`feedback` | 120ms | ease | 控件响应 hover/press/focus |
`reveal` | 120ms | ease | 内容进入聊天区 |
`enter` | 320ms | cubic-bezier(0.34, 1.3, 0.64, 1) | 用户消息长到行里（微过冲）|
`surface` | 150ms | ease | 浮层出现 |
`exit` | 120ms | ease | 浮层消失（比出现快）|
`open` | 250ms | cubic-bezier(0.22, 1, 0.36, 1) | 从锚点长出 |
`slide` | 240ms | cubic-bezier(0.22, 0.61, 0.36, 1) | 滑动高亮 |
`bounce` | 350ms | cubic-bezier(0.34, 1.45, 0.64, 1) | 开关滑动 |

**我的问题**：只有零散的 `transition`，没有统一的动效语言。

### 8. 字体三分

- **Serif display** — 标题 / 编辑式陈述
- **Sans UI** — 界面、正文
- **Mono** — 代码、技术标签

**我的问题**：混用 `system-ui` 和 `monospace`，没有明确分工。

### 9. 「等待行」要说明模型正在做什么

> "The waiting line — 模型正在做什么的那一行"

参考做了**三个点的小动画**（三种动作随机切换：弹跳 / 走线 / 换角），
配合文字：「思考中…」「正在写回答」「正在调用工具」。

**我的问题**：只有 `setState('思考中…')` 一行文字，没有动态感。

### 10. 过程行（Process rows）—— 工具调用怎么展示

> "the group's body becomes one card — the 1px card border and the ladder's 8px
> radius — and each row is one line of it, 36px tall, inset 12px, with the 0.5px
> divider between rows and none above the first. No icon leads a row; a row that
> opens has a chevron trailing its words."

**我的问题**：工具调用是裸的一行 `⚙ read C:\...`，没有卡片包裹、没有折叠。

---

## 二、我的界面要改的清单

### P0：色彩系统（最影响观感）

| 项 | 现状 | 改成 |
|---|---|---|
| 背景 | `#0E1114`（冷灰黑）| 从种子派生的 canvas（暖偏）|
| 面板 | `#151A1F` | surface-1 |
| 边框 | `1px solid #232A31`（深色线）| `1px solid rgba(255,255,255,.09)`（高光）|
| 文字 | `#DDE3EA` / `#8A94A3` / `#5b6470` | ink / ink-2 / ink-3 / ink-4 四档 |
| 强调色 | 到处用蓝 | 降到 < 10%（只用于发送按钮、当前状态）|

### P0：几何统一

| 项 | 现状 | 改成 |
|---|---|---|
| 圆角 | 3/4/5/6 混用 | 4 / 8 / 16 阶梯 |
| 间距 | 5/6/7/8 混用 | 4px 节奏（4/8/12/16）|
| 分隔线 | 1px 同边框 | 0.5px（`rgba` 更低）|

### P1：等待行（模型在干什么）

改成参考的做法：
```
● ● ●  思考中…                    03:24
```
- 三个点做动画（弹跳 / 走线 / 换角，随机切换）
- 文字跟着状态变：连接引擎 → 思考中 → 第 N 步 → 正在调用工具 → 就绪
- 右侧显示本轮的耗时

### P1：过程行（工具调用）

改成卡片包裹 + 折叠：
```
┌─────────────────────────────────┐
│ 读取文件  记忆/中枢/场景私有记忆.md  › │
│ ─────────────────────────────── │
│ 编辑文件  记忆/中枢/场景私有记忆.md  › │
└─────────────────────────────────┘
```
- 一个「过程组」把连续的工具调用包成一张卡
- 每行 36px 高，内缩 12px
- 0.5px 分隔线（第一行上面没有）
- 行尾一个 chevron，点开看详情

### P1：动效语言

| 场景 | 用哪个 token |
|---|---|
| 消息气泡出现 | `enter` 320ms 微过冲 |
| 状态文字变化 | `swap` 150ms（旧的往上走+模糊，新的从下进）|
| 工具行展开 | `reveal` 120ms |
| 发送按钮 hover | `feedback` 120ms |
| 加载点 | period 2400ms |

### P2：字体分工

```
标题 / 强调     → serif
界面 / 正文     → sans
代码 / 技术标签 → mono
```

---

## 三、不照搬的部分（我的判断）

| 参考的做法 | 我不采用 | 原因 |
|---|---|---|
宠物小鲸鱼 Deepy（8 个状态 GIF）| ❌ | 那是品牌吉祥物，我的项目是「记忆神经元星盘」，视觉语言应该是星象而不是宠物 |
两套品牌配色卡（Claude 橙 / DeepSeek 蓝）| ⚠️ 只借「色彩阶梯」，不借品牌色 | 我的项目有自己的朱红（国学主题）|
右侧栏做成可收起的抽屉 | ❌ 保持常驻 | 主 Agent 是核心，不该藏起来 |
「首页版面」那种空状态 | ❌ | 我的星盘本身就是空状态 |

---

## 四、实施顺序

1. **先建色彩 token 表**（`ui/core/theme.js`）—— 一个种子色派生出所有 code
2. **替换主 Agent 面板的颜色**（只用 token，不写死）
3. **统一圆角/间距**
4. **重做等待行**（三点动画 + 状态文字 + 耗时）
5. **重做过程行**（卡片 + 折叠）
6. **加动效**（消息进入 / 状态切换 / 展开）
7. **验证**：CDP 截图看效果 + 量化对比（颜色数、间距值、圆角值是否都在阶梯上）

---

## 五、验证判据（可量化）

改完必须能回答：

- [ ] 面板里出现的所有颜色，是否都来自 token 表？（不能有游离的 hex）
- [ ] 所有圆角是否都在 {0, 4, 8, 12, 16} 里？
- [ ] 所有间距是否都是 4 的倍数？
- [ ] 强调色占可见元素的比例是否 < 10%？
- [ ] 暗色下边框是否都是 `rgba(255,255,255,α)` 而不是深色实色？
- [ ] 每个动效是否都有明确的角色归属（feedback/reveal/enter/surface/exit）？

可以写成 `工具/设计一致性.mjs` 自动检查前 3 条。
