# 45 · 界面重设计：参考 dsh-TUI 的终端美学

> 用户："我更喜欢 https://github.com/ccch1mneyyy/dsh-TUI"
> 7089 星 · TypeScript · 3421 文件 · DSH 官方首推 TUI 插件

---

## 一、dsh-TUI 的界面（我从 SVG 里还原出来的）

我解析了 `preview-zh.svg`（337 KB，2229 个文字元素），按 y 坐标还原了整个界面：

```
✦ dsh-TUI v0.10.2
┌────────────────────────────┐
│  █▀▀▀▄█▀▀▀▀█▀▀▀▀█▀▀▀▄█▀▀▀▀█ │   ← 像素鲸鱼（用 █▀▄ 块字符拼的）
│  ████████████               │
│  ███▀▀▀█▀▀▀█▄▄▄▀▀▀▀▄█▀▀▀█▀▀│
│  ██▄▀▄█▀▀▀▄███▀▀▀▀█▀▀▀▀█▀▀▀│
└────────────────────────────┘
deepseek-flash · Max effort
欢迎使用 dsh-TUI · 从这里开始
提示：minimal preset 下 /compact 与问卷不可用 · /tips 更多技巧

探索未至之境！

╭─命令·共 60 项 ──────────────────────────╮
│ ❯ new      新开会话              /fork   分叉 │
│   clear    清空当前会话          /export 导出 │
│   compact  压缩会话历史          /btw   侧问 │
│   resume   恢复历史会话          /trace       │
│                                              │
│ ↑↓ 滚动 · PgUp/PgDn 翻页 · Home/End 首尾 · Esc │
╰──────────────────────────────────────────────╯

╭──────────────────────────────────────────────╮
│ ❯ /help  你好，开始吧                          │
╰──────────────────────────────────────────────╯
deepseek-flash · max · 欢迎使用
```

**核心视觉特征**：
1. **字符画（ASCII art）** —— 用 `█▀▄` 块字符画鲸鱼，不是图片
2. **框线（box drawing）** —— 用 `╭╮╰╯│─` 画边框
3. **单色系** —— 雾蓝 / 樱粉两族，靠层级而不是靠花哨
4. **信息密度极高** —— 60 个命令塞进一个面板
5. **底部状态行** —— `deepseek-flash · max · 欢迎使用`
6. **左右分栏的命令列表** —— 不是单列菜单

---

## 二、它的设计原则（从文档里提炼）

### 2.1 主题系统（`docs/themes.md`）

**两个色板族 + 六套主题**：
| 名称 | 族 | 用途 |
|---|---|---|
`auto` | — | 跟随系统/终端背景（OSC 11 查询），自动解析为 light 或 dark |
`light` | 雾蓝 | 白色面板、墨色正文、雾蓝交互色 |
`dark` | 雾蓝 | 深色终端适配、暖灰正文、柔雾蓝强调色 |
`dark-ansi` | 雾蓝 | 16 色 ANSI 兼容回退 |
`pink-day` | 樱 | 淡粉面板、樱粉交互色 |
`pink-night` | 樱 | 暖调面板、樱粉交互色 |
`pink-ansi` | 樱 | 16 色 ANSI 回退 |

**选择优先级**：
```
DSH_TUI_THEME > ~/.dsh-tui/theme.json > OSC 11 背景检测 > dark 回退
```

**60+ 个按用途分组的颜色键**（不是只有 text/background）：
- 品牌/焦点/活动：`accent` `accentShimmer` `activity` `activityShimmer`
- 面板/边框：`permission` `promptBorder` `bashBorder` `planMode` `ide`
- 正文：`text` `inverseText` `inactive` `subtle`
- 工具名与状态点：`toolNameMutate` `toolDotExec` `toolDotRead` `toolDotWrite` `toolDotWeb`
- 状态：`success` `error` `warning` `merged`
- diff：`diffAdded` `diffRemoved` `diffAddedWord` `diffRemovedWord`
- diff 语法：`syntaxKeyword` `syntaxString` `syntaxComment` …
- 上下文条五段：`contextBarSystem` `contextBarPrompt` `contextBarAssistant` `contextBarThinking` `contextBarTools`
- 光标：`cursor` `ignition` `ignitionDim`

**失败策略（很关键）**：
> - 未知 Theme 键：跳过该键并写入警告，其余颜色继续生效
> - 非法颜色：跳过该值并写入警告
> - 非法 `base`、损坏 JSON：跳过整个文件
> - **一个坏主题不会阻止 TUI 启动，也不会影响其他主题**

### 2.2 渲染性能（`docs/architecture.md`）

| 技术 | 说明 |
|---|---|
**差分输出** | 每帧只写屏幕变化 |
**虚拟化消息列表** | 屏幕外行用上次测量的固定高度占位 |
**回放合并** | 历史回放时合并连续 token chunk |
**有界缓存** | transcript/渲染节点/测量缓存有上限 |
**零分配热路径** | visibleRows 管线记忆化，每滚动 tick 零数组分配 |
**全局 LRU** | wrapText 与 markdown token 跨挂载复用 |
**分帧回填** | 主屏先挂尾部窗口再分帧回填历史 |
**显示宽度** | ANSI/组合字符/emoji/东亚宽字符都按 terminal cell width |

### 2.3 状态仪表

- **上下文进度条**：pi-nano-context 算法（最大余数分段着色 + 多级紧凑读数）
- **TPS 仪表**：pi-tps-meter —— 1/8 块仪表、min-max 火花线、按速度语义着色（≥50 绿 / ≥20 黄 / <20 红）
- **working-activity**：由插件折叠并发布为 `workingActivity` 会话投影，**本应用只读取该投影**

**最后这点很重要**：UI 不自己推导状态，只读投影。

### 2.4 其他设计选择

- **启动页（launchpad）** —— 每次启动落在有**真实输入框**的着陆页（大字号 + 鲸鱼 + 快捷动作）
- **像素鲸鱼宠物** —— 三种开场动画，点击唤醒，首个任务后冻结
- **任务完成通知** —— 支持 OSC 777/9/BEL/Windows 原生四通道，有 2048 字节序列预算
- **侧栏** `Ctrl+B` —— 八种内置面板默认全开，可拖分隔条
- **时间线轨** —— 每一轮可点击
- **双 Esc 时间回退**
- **`/` 和 `@` 补全**，`#L12-14` 行范围
- **Mermaid / LaTeX 渲染成 Unicode 图**

---

## 三、我的重设计方向

### 3.1 从"卡片堆叠"到"终端美学"

| 现状（我们的工作台） | 新方向（参考 dsh-TUI） |
|---|---|
深色卡片 + 圆角 + 阴影 + 渐变 | **单色系 + 框线 + 无阴影** |
多色装饰 | **两级灰阶 + 一个强调色** |
emoji 图标 | **块字符/Unicode 符号**（`▸` `◆` `●` `│`） |
面板之间分隔靠间隙 | **框线 `╭╮╰╯` 明确边界** |
信息稀疏 | **信息密度高**（一屏能看到全部状态） |
滚动才看到关键信息 | **关键信息常驻顶/底栏** |

### 3.2 具体方案

**① 顶部状态栏**（照 dsh-TUI 底部那行）
```
✦ DeepSeek 工作台  ·  11 场景  ·  记忆 11  ·  管线 2  ·  容错 0  ·  09:15
```

**② 左侧场景栏改为"命令面板"风格**
```
╭─场景·共 11 ──────────────╮
│ ❯ 命令        /cmd       │
│   调研        /research  │
│   竞品拆解    /compet    │
│   逆向分析    /rev       │
│   架构梳理    /arch      │
│   实施计划    /plan      │
│   关系军师    /relation  │
│   自我复盘    /review    │
│   ...                    │
│ ↑↓ 切换 · Enter 进入     │
╰──────────────────────────╯
```

**③ 记忆面板改为"像素画 + 统计"**
```
╭─记忆 ────────────────────╮
│   █▀▀▀▄  11 场景         │
│   █████  4 数据源        │
│   ██▄▀▄  1 项目          │
│          34 连线         │
│  路径全在 · 0 失效        │
╰──────────────────────────╯
```

**④ 管线面板改为"终端树"**
```
╭─管线 build-software ──────╮
│ ● research        等待上游 │
│ ├▶ competitor-analyze 可开始│
│ ├▶ reverse-eng    等待上游 │
│ └▶ arch-review    等待上游 │
│ 产物 3 · 事件 4           │
╰──────────────────────────╯
```

**⑤ 底部命令提示栏**
```
❯ 输入命令    /help 查看帮助  ·  Ctrl+B 侧栏  ·  Tab 补全
```

### 3.3 技术实现选择

| 项 | 选择 | 理由 |
|---|---|---|
字体 | 等宽字体优先（`Consolas, 'Cascadia Code', monospace`） | 终端美学需要等宽 |
框线 | 用 CSS border + `::before` 伪元素画 `╭╮╰╯` | 纯 CSS，无图片 |
块字符画 | 用等宽字体渲染 `█▀▄` | dsh-TUI 就这么做的 |
色板 | 雾蓝族（`#4b6fff` 强调 + 灰阶层级） | 照 dsh-TUI 的雾蓝族 |
主题切换 | 支持 `auto/light/dark` 三个 | 学它的 OSC 11 思路（浏览器用 `prefers-color-scheme`） |

---

## 四、执行计划

| 步骤 | 内容 |
|---|---|
**1** | 新建 `theme-terminal.css` —— 终端美学的色板与组件 |
**2** | 新建 `renderer-terminal.js` —— 给关键面板加"终端模式"渲染 |
**3** | 顶部状态栏 + 底部提示栏 |
**4** | 场景栏改命令面板风格 |
**5** | 实测验证（CDP 截图 + 对比） |

**原则：不改功能，只改外观。**

---

## 五、一句话

> **dsh-TUI 的界面不是"好看"，是"信息密度 + 一致的视觉语言"。**
> **它用块字符画鲸鱼、用框线画边界、用 60+ 个语义化颜色键保证层级清晰、**
> **用差分输出和虚拟化保证 10 万行也不卡。**
>
> **我们的界面要学的是这套"终端美学"，不是照抄它的鲸鱼。**
