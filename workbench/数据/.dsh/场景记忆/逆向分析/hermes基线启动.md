# Hermes 基线：从零到可用（实测记录）

> 2026-11-14 建立。目标：把 hermes-agent 作为 UI 基地，在其之上改造。
> 这份文档记录**所有实测出来的启动条件**，每条都有排除过程，不是猜的。

## 一、结论：已经跑通

```
C:\hermes\start-desktop.ps1  → 4 秒起，4 个 Electron 进程，CDP 就绪
桌面端日志: [bot-roster] snapshot active=local answered=1b88c31b expected=1b88c31b
界面状态栏: 后端 就绪
真实会话:   "GETTING STARTED · 你好，我是 Hermes。我们先帮你把一切设置好，然后一起做点很酷的事。"
```

截图：`prototype/shots/H2-after-skip.png`（1600×1000，82 KB）

## 二、五个必要条件（缺一不可）

### ① 路径不能有中文 ★最坑的一条

```
D:\file\AI Temp\DeepSeek\Agent自研\hermes   → 0 进程，exit -36861 (0x7003)
C:\hermes                                    → 4 进程，6 秒
```

**排查过程**（花了很久，因为报错完全不指向原因）：

| 试验 | 结果 | 排除了什么 |
|---|---|---|
| hermes 自带 electron 44 跑 hermes | 0 进程 | 不是版本问题 |
| 我们的 electron 43 跑 hermes | 0 进程 | 同上 |
| **hermes 的 electron 44 跑我们的 app** | **5 进程 ✓** | electron 本身没问题 |
| 我们的 app + `type:module` | 1 进程 | 不是 ESM |
| 最小 app 放 `C:\hm-test` | **5 进程 ✓** | **纯 ASCII 路径能跑** |

关键证据：在 `electron-main.mjs` 第一行插入探针，**一行都没执行** →
失败在 V8 启动之前，是原生层（路径解析/DLL）。

### ② 必须用 PowerShell 托管启动

```
VBS sh.Run(electron.exe)           → 进程秒退（路径含空格 + 多参数，引号拼接坏）
VBS → powershell -File xxx.ps1      → 正常
```

这条本项目工作台的 `启动.vbs` 注释里早就写着，我一开始没照做。

### ③ PATH 必须最小化

```powershell
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\Wbem"
```

继承的 PATH 会让 Electron 卡在 1 个进程（不报错、不退出）。

### ④ Desktop 靠「launcher 契约」发现本地安装

桌面端日志会停在：
```
[bootstrap] no usable Hermes install at
  C:\Users\...\AppData\Local\hermes\hermes-agent and no published user-bin launcher
[boot] Waiting for first-run setup choice
```

它找 `<HERMES_HOME>\bin\hermes.cmd`（或 `hermes.exe`），并**执行它**验证两个契约：

| 参数 | 要求 | 桌面端解析方式 |
|---|---|---|
| `--version` | stdout 含 `Install directory: <绝对路径>` | `/^Install directory: (.+)$/m` |
| `--print-runtime-command` | stdout 是 JSON，`[0]` 为 python 绝对路径 | `JSON.parse` 后 `isAbsolute + isFile` |

缺第 2 条会报：
```
Gateway ticket bootstrap could not resolve the installed Hermes Python runtime
```

**注意**：本仓库 CLI 的 argparse **不认** `--print-runtime-command`。
转发给它只会打印 usage 并 exit 2。所以 launcher 必须**自己回答**这个参数：

```bat
if /I "%~1"=="--print-runtime-command" goto print_runtime_command
...
:print_runtime_command
set "PY_JSON=%HERMES_PY:\=\\%"
echo ["%PY_JSON%"]
exit /b 0
```

### ⑤ Gateway 必须先起，且**端口是动态的**

```bash
hermes gateway run --force -v
```

实测两次拿到不同端口：`56974` / `45020`。**不能硬编码端口做健康检查。**

正确做法：用 `hermes gateway attach` 返回的 JSON 里的 `endpoint.api_origin`。
桌面端自己也是这么发现的。

```
attach 输出：
{"url":"ws://127.0.0.1:<port>/api/ws",
 "ticket":"<一次性>",
 "protocols":["hermes-gateway-v1","hermes-gateway-ticket.<ticket>"],
 "endpoint":{"api_origin":"http://127.0.0.1:<port>", ...}}
```

本地模式**不需要 token**：`GET /api/health` → `{"ok":true,"auth_required":false}`

## 三、WebSocket 握手方式（实测三选一）

| 方式 | 结果 |
|---|---|
| `ws://.../api/ws?token=<ticket>` | ✗ close 1006 |
| `ws://.../api/ws?ticket=<ticket>` | ✗ close 1006 |
| **子协议 `["hermes-gateway-v1","hermes-gateway-ticket.<ticket>"]`** | **✓ open** |

且 ticket 是**一次性**的，每次连接必须重新 attach。

## 四、目录布局

```
C:\hermes\                          ← 源码树（1.24 GB / 103433 文件，从中文路径迁来）
├── apps\desktop\                   ← Electron + React 桌面端
│   ├── dist\                       ← 已构建产物（51.6 MB）
│   ├── electron\                   ← 主进程 TS 源码（main.ts 675 KB）
│   ├── src\                        ← React 源码（app/ components/ store/ themes/）
│   └── node_modules\electron\      ← electron 44.10.2
├── .venv\                          ← Python 3.14.6 / 151 包
├── hermes_cli\                     ← CLI（main.py 是入口）
├── _run_gateway.py                 ← 我加的 gateway 启动包装
└── start-desktop.ps1               ← 一键启动（本文档描述的全部条件）

C:\Users\15282\AppData\Local\hermes\
├── bin\hermes.cmd                  ← 我加的 launcher（桌面端靠它发现安装）
├── logs\desktop.log                ← 桌面端日志（排查必看）
└── gateway_state.json / state\gateway.lifecycle.json

C:\Users\15282\AppData\Roaming\
└── Hermes-Baseline\                ← 独立 user-data（不与正式安装抢锁）
```

## 五、界面结构（照搬的对象）

### 布局：不是「固定几个面板」，而是树形分栏

`apps/desktop/src/app/contrib/layout-presets.ts`：

```js
DEFAULT_TREE = split('row', [
  group(['sessions']),                       // 左栏  权重 1
  group(['workspace']),                      // 主区  权重 3.4
  split('column', [                          // 右栏  权重 1.25
    split('row', [group(['review']), group(['files'])], [1, 1.2]),
    group(['terminal'])
  ], [1.6, 1])
], [1, 3.4, 1.25])
```

三套预设：`DEFAULT_TREE`（默认）/ `FOCUS_TREE`（专注）/ `BASIC_TREE`（基础）。

### pane-shell：37 文件 / 398 KB

```
tree\store.ts              82.2 KB   树状态机
tree\renderer\tree-group.tsx 51.5 KB  分组渲染
tree\renderer\tree-split.tsx 34.2 KB  分割器
tree\model.ts              22.1 KB   树模型
tree\renderer\drag-session.ts 22.5 KB 拖拽
tree\zone-editor.tsx       18.9 KB   区域编辑
...
```

### 组成（截图实测）

```
左侧栏 250px：会话/机器人 tab、新建会话 Ctrl N、技能与工具、消息平台、
              产物、定时任务、搜索会话、已置顶、会话列表
顶部：○ SESSION ×  +   设置 布局编辑器 HUD 交换侧栏 右栏 最小化
主区：聊天流（空态是巨大蓝色衬线 HERMES AGENT 字标）
底部：+ 输入框  [模型] [推理档] [麦克风] [发送]
状态栏：后端状态 · 账号 · 智能
```

## 六、复现命令

```powershell
# 一键
powershell -NoProfile -ExecutionPolicy Bypass -File C:\hermes\start-desktop.ps1

# 分步
$env:PATH = "C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem"
$env:ELECTRON_RUN_AS_NODE = ''
$env:HERMES_HOME = "$env:LOCALAPPDATA\hermes"

C:\hermes\.venv\Scripts\python.exe C:\hermes\_run_gateway.py run --force -v
Start-Process C:\hermes\apps\desktop\node_modules\electron\dist\electron.exe `
  -ArgumentList '.','--no-sandbox','--disable-gpu','--remote-debugging-port=9333' `
  -WorkingDirectory C:\hermes\apps\desktop
```

## 七、已知遗留问题

- `[renderer console:main] Uncaught Error: Maximum update depth exceeded`
  每次启动都刷，来自 `getSnapshot` 的 React 循环。**不影响使用**（界面正常渲染、
  后端就绪），但应该修 —— 在我们改造时要处理。
- 模型目录拉取失败（无外网）：
  `model catalog fetch failed (https://hermes-agent.nousresearch.com/...)`
- 具体模型调用未验证（需要 provider key）。
