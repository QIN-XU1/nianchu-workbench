# 60 · dsh-TUI 嵌入完成（三个根因全部破解）

> 用户要求：**先把 dsh-TUI 嵌入做好**，并指出首要问题是
> **"我们现在直接的对话其实并没有在这个 agent 里的"**

---

## 一、最终结果

**dsh-TUI 已在 Electron 的 xterm.js 里真实运行**，截图可见像素鲸鱼：

```
         ▄▀▄       ▄
         ▀▀▀▀▄  ▄▄▀▀▀
   ▄▄▄▄▄▄▄▄▄  ▀▀▀▀▀▀▀▀▀▀▀▀
   ...像素鲸鱼 ASCII art...

       DeepSeek Harness
 ╭──────────────────────────────────╮
 │ ❯ 说点什么，或输入 / 看命令…    │
 ╰──────────────────────────────────╯
   deepseek-flash  ·  Max  ·  standard
     会话与工作区   设置   内核·DSH   帮助
```

### 完整技术链路

```
主 Agent 面板（280px 右栏）
  ↓
xterm.js（渲染 ANSI 转义序列）
  ↓ IPC: tui:data / tui:input / tui:resize
主进程 node-pty（真实伪终端，conpty 后端）
  ↓
真 node.exe（★不是 Electron.exe）
  ↓
_asar/dsh/.../dsh-desktop-host/lib/cli.js（解包后的）
  ↓
--profile dsh-tui
  ↓
dsh-TUI（Ink/React 终端 UI）
```

---

## 二、三个根因（全部实测定位）

### 根因 ①：Electron-as-Node 的 stdin 没有 setRawMode

**这是我的第一个致命误区。** 我一开始用 `Electron.exe + ELECTRON_RUN_AS_NODE=1`，
以为它等同 Node。实测：

```
系统 node + PTY:
  stdin.isTTY      = true
  stdin.setRawMode = function     ✅
  setRawMode(true) = OK

Electron as node + PTY:
  stdin.isTTY      = undefined
  stdin.setRawMode = undefined    ❌
```

**后果**：dsh-TUI 用的 Ink 框架报
```
ERROR: Raw mode is not supported on the current process.stdin,
which Ink uses as input stream by default.
```
→ 进程退出码 1，零输出。

**解法**：改用真正的 `D:\file\env\nodejs\node.exe`。

**判定代码**（写进了 tui-bridge.cjs）：
```javascript
function resolveRealNode() {
  const candidates = [
    process.env.DSH_REAL_NODE,
    'D:\\file\\env\\nodejs\\node.exe',
    // ...
  ];
  for (const c of candidates) {
    // ★ 排除 Electron.exe
    if (c && fs.existsSync(c) && !/DeepSeek Harness\.exe/i.test(c)) return c;
  }
}
```

### 根因 ②：cli.js 在 app.asar 里，普通 node 读不了

```
require('...app.asar/dsh/node_modules/.../cli.js')
→ MODULE_NOT_FOUND
```

asar 是 Electron 的归档格式，只有 Electron 运行时能透明读取。

**解法**：用 `@electron/asar` 解包一次到 `外壳/_asar/`。

```javascript
function ensureUnpackedCli(log) {
  const cli = path.join(shell, '_asar', 'dsh', 'node_modules',
    '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  if (fs.existsSync(cli)) return cli;

  const asar = require(path.join(shell, 'node_modules', '@electron', 'asar'));
  asar.extractAll(asarPath, unpackRoot);   // 25418 文件，约 30 秒
  return fs.existsSync(cli) ? cli : '';
}
```

**验证**：解包后 `node cli.js --version` → 输出 `0.2.2-rc.1` ✅

### 根因 ③：session-mounts.json 里有死进程的残留记录

**这个最隐蔽。**

错误信息：
```
cannot resume session "...":
  its occupancy could not be verified
  (cannot create C:\Users\15282\.dsh-tui\session-mounts.lock: EPERM)
```

我先怀疑是文件权限 —— **错了**：
```
目录存在: true
写文件成功: ✓
open(wx) 成功: ✓      ← 纯 node 下完全没问题
```

真相在 `session-mounts.json`：
```json
{
  "version": 1,
  "owners": [{
    "pid": 4688,
    "startedAt": 1794099104308,
    "sessionIds": ["d5b6b4c1-375d-453c-8cb9-074a65057bfc"]
  }]
}
```

**PID 4688 已经死了**，但记录还在。dsh-tui 看到有 owner 就认为会话被占用。

**解法**：清理死进程记录。
```javascript
const live = owners.filter(o => {
  try { process.kill(o.pid, 0); return true; } catch (e) { return false; }
});
```

---

## 三、其他必要修正

### 3.1 独立 DSH_HOME（避免 profile 锁冲突）

**试错的三个方案**：

| 方案 | 结果 |
|---|---|
主 `$HOME/.dsh` | ❌ EPERM `profiles/dsh-tui/cordis.yml`（工作台引擎持有锁） |
`$HOME/.dsh-tui-home` + 复制 profile | ❌ 复制破坏 pnpm 结构 + 仍 EPERM |
**项目内 `引擎数据/.dsh-tui` + 原生安装** | ✅ **成功** |

### 3.2 TEMP/TMP 隔离

```javascript
const tuiTemp = path.join(tuiHome, 'temp');
const env = { ..., TEMP: tuiTemp, TMP: tuiTemp, TMPDIR: tuiTemp };
```

### 3.3 sessions 用 junction 而非复制

```javascript
execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target]);
```

主 home 的 sessions 有 115 MB，复制太慢；junction 实时同步。

### 3.4 xterm.js 路径

```
✗ ./node_modules/xterm/lib/xterm.js
  → 实际查找 renderer/node_modules/...（不存在）
✓ ../node_modules/xterm/lib/xterm.js
  → renderer/ 的上一级才是 node_modules
```

### 3.5 fitSize 不要读 xterm 私有 API

```javascript
// ✗ term._core._renderService._dimensions.actualCellWidth
//   → 'Cannot read properties of undefined'
// ✓ 纯几何估算
const cols = Math.floor((w - 10) / (fontSize * 0.62));
```

---

## 四、当前状态

| 能力 | 状态 | 证据 |
|---|---|---|
**dsh-TUI 启动** | ✅ | pid 存在，像素鲸鱼渲染 |
**终端渲染** | ✅ | 30 行内容正确 |
**键盘交互** | ✅ | 发 Esc 能跳过引导页 |
**PTY 管理** | ✅ | start/input/resize/stop 全部 IPC 可用 |
**独立环境** | ✅ | 独立 home + temp + junction |
**会话 resume** | ⚠ | 受引擎独占写锁限制（见下） |

---

## 五、首要问题：为什么"对话不在 agent 里"

### 5.1 诊断结论

```
你跟我的对话 → 跑在 44401 端口（桌面版 DSH 引擎）
主 Agent TUI → 跑在 3080 端口（工作台自己的引擎）
```

**这是两个不同的 DSH 实例，会话日志各存各的，无法共享。**

实测 3080 引擎的会话列表：
```json
{
  "total": 164,
  "running": 0,
  "recent": [{
    "id": "session-49fac9b6-...",   ← 名字像我们的对话
    "seq": 17448,
    "updatedAt": 1794044140428       ← 昨天的时间
  }]
}
```

`seq=17448` 但 `updatedAt` 是昨天 —— 说明这是**旧的快照**，不是实时对话。

### 5.2 引擎的硬约束

源码 `dsh-session-persistence/lib/index.js`：

```javascript
var SessionAlreadyOwnedError = class extends Error {
  constructor(sessionId) {
    super(`session "${sessionId}" is already owned by an active write handle`);
  }
};
var SessionReadOnlyError = class extends Error {
  constructor(sessionId, operation) {
    super(`session "${sessionId}": ${operation} is not available on a read handle`);
  }
};
```

**一个会话只能有一个活跃写句柄。** 这是设计，不是 bug。

### 5.3 用户已做的选择

> "把对话本体搬进工作台（推荐）"

**这意味着**：以后在主 Agent 的 TUI 里对话，不再用外部 Web GUI。
这样没有多进程争抢，主 Agent 天然就是对话入口。

---

## 六、还没做的

| 项 | 说明 |
|---|---|
**引导页自动跳过** | 现在需要手动发 Esc。应该检测到引导页就自动发 |
**面板太窄** | 主 Agent 只有 280px，TUI 需要至少 60 列 |
**TUI 与场景切换联动** | 切到某场景时，TUI 应切到对应会话 |
**输出未持久化** | TUI 崩溃后历史丢失 |

---

## 七、踩坑方法论（写给未来的自己）

### 7.1 我这次最大的问题：没有先做最小验证

**错误路径**：
```
直接写 400 行 tui-bridge.cjs → 在 Electron 里试 → 失败
→ 改参数 → 再试 → 再失败 → 折腾 10 小时
```

**正确路径应该是**：
```
① 20 行纯 Node 脚本验证 node-pty 能拉起 dsh-tui
② 如果不行，逐步隔离变量（stdin? temp? home? 锁?）
③ 全部验证通过后再写 Electron 集成
```

### 7.2 关键调试技巧

**用「文件探针」代替「控制台输出」**：
```javascript
// 在 Electron 里 console.log 常被吞
// 改成写文件
fs.writeFileSync('D:/probe-result.txt', lines.join('\n'));
```

**用「进程存活 vs 退出」判断**：
```javascript
p.onExit(e => finish('exit', e.exitCode));
setTimeout(() => finish('alive', '存活'), 5000);
// 存活 = 正常；退出码 1 + 零输出 = 配置错了
```

---

## 八、一句话

> **dsh-TUI 终于真的跑起来了 —— 像素鲸鱼在 Electron 的 xterm 里动。**
>
> **卡了 10 小时，是因为我一直在猜，没有先做最小验证。**
> **三个根因里最隐蔽的是第三个：`session-mounts.json` 里死进程的残留记录。**
> **文件权限正常、纯 node 下能创建 lock —— 只有对照实际 JSON 内容才能发现。**
>
> **教训：遇到"操作被拒"先看状态文件，不要先怀疑权限。**
