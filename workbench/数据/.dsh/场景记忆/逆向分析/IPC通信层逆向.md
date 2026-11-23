# IPC 通信层逆向

> 目标：数清 IPC 通道、理清 preload 暴露的命名空间、说清 api/index.js 的白名单机制，最后落到「新增一个 IPC 要改哪几个文件」。
> 素材：`外壳/main.js`、`外壳/preload.js`、`外壳/ui/api/index.js`。

## 一、一句话结论

三层结构：`main.js` 注册 **188 个 `ipcMain.handle`**（双向 invoke）+ **2 个 `ipcMain.on`**（单向推送）；`preload.js` 用 `contextBridge.exposeInMainWorld('app', {...})` 把**一个 `app` 对象**（内含 27 个命名空间 + 约 25 个顶层函数 + 2 个常量）暴露给渲染层；`ui/api/index.js` 再用**两条白名单数组**二次封装成 `api()`。新增一个 IPC 至少要动 **main.js + preload.js + api/index.js 三个文件**，漏改 api 白名单会「静默 undefined」。

## 二、数量（实测 grep 精确值）

- `ipcMain.handle`：**188 个**（`main.js` 全文）
- `ipcMain.on`：**2 个**（`site:drag` L2910、`oa:dragstart` L3063，只收不发、不返回 Promise，对应 preload 里的 `ipcRenderer.send`）
- 通道名前缀分布（top 12，同一前缀是一组业务）：

| 前缀 | 数 | 前缀 | 数 |
|---|---|---|---|
| stock | 45 | webai | 7 |
| oa | 36 | appwin | 5 |
| topbar | 12 | remoteAccess/pc/ma/scenes/sf | 各 4 |
| blender | 10 | balance/app/harness/review | 各 3 |
| kun | 10 | boot/engine/skills/settings | 各 2 |
| window | 8 | 其余（code/tools/theme/…） | 各 1 |
| site | 7 | | |

> 说明：前缀数量是 `main.js` 里注册的 handler 数；`preload.js` 里按命名空间分组后，一个命名空间可能对应多条通道（如 stock 一个命名空间对应 45 条）。

## 三、preload 暴露了什么（file:line）

`contextBridge.exposeInMainWorld('app', {...})` 只暴露**一个顶层对象 `app`**（preload.js L28）。里面分三类：

**① 对象命名空间（27 个）**——调用形式 `api().ns.方法()`：

| 命名空间 | 位置 | 命名空间 | 位置 |
|---|---|---|---|
| browserSidebar | L33 | skills | L192 |
| settings | L76 | blender | L197 |
| engine | L82 | appwin | L212 |
| workspace | L90 | site | L227 |
| ma | L98 | code | L239 |
| tui | L106 | review | L243 |
| balance | L124 | stock | L253 |
| remoteAccess | L131 | oa | L327 |
| theme | L138 | plugins | L400 |
| app | L142 | models | L403 |
| file | L148 | topbar | L407 |
| sys | L159 | webai | L431 |
| net | L188 | win | L448 |
| pc | L166 | | |

**② 顶层函数**（直接挂在 `app` 上，如 `getHarnessUrl` L54、`listScenarios` L73、`filePath` L182、`pickFolder` L183、`bootState` L224、`toolsCatalog` L426、`minimize` L443 等约 25 个）——调用形式 `api().xxx()`。

**③ 常量**：`paths`（L29，含 dataDir/reviewDir/bootCfg/memRoot/skillDir/projectRoots）、`caps`（L67，能力位 `webaiGuestFreeNav`/`sceneTabOrder`）。

**④ 推送订阅**：`onFault` L43、`onHarnessReady` L219、`onBootProgress` L223、`tui.onData/onExit`、`balance.onUpdate`、`topbar.onToast`、`win.onChanged` 等；以及**单分发器** `webai:task`（L458，整个 preload 生命周期只注册一个监听，渲染层 `onTask` 只替换回调）。

## 四、api/index.js 的白名单机制（file:line）

不是安全白名单（安全边界在 preload 的 contextBridge），而是**「门面注册表」**：preload 已经把全部能力挂在 `window.app` 上，`createApi()` 只把「被列进两条数组的名字」重新包装进 `api()`。

**两条白名单数组：**

1. **`FN` 数组（只包函数）** L107-116：`getHarnessUrl / isHarnessReady / getVersion / caps / setSceneOrder / getSceneOrder / injectHarnessPanel / listScenarios / getScenario / settings / setAlwaysOnTop / pickFolder / pickFile / webaiWarmConfig / minimize / toggleMaximize / isMaximized / close / toolsCatalog`。循环 L117-126 里 `if (typeof fn !== 'function') continue`。
2. **命名空间数组（包对象或函数）** L143-146：`engine / tui / ma / workspace / balance / remoteAccess / theme / app / file / filePath / net / sys / skills / blender / appwin / site / code / review / stock / oa / plugins / models / sfBoard / sfPipelines / sfPipeStatus / sfClaim / browserSidebar / topbar / webai / win / pc`。循环 L147-158 对 `function` 走 `wrap`、对 `object` 走 `wrapNamespace`（递归包嵌套，L68-81）。
3. **订阅型** L129-132：`onFault / onHarnessReady / onBootProgress`（同步返回 unsubscribe，不套超时）。

**归一化包装 `wrap`** L34-59：`Promise.race` 套 30s 超时 → 统一返回 `{ok, value, error, ms}`；handler 未注册时 Electron 返回 `undefined` → 归一为 `{code:'no-handler'}`（L50-52）；异常归一 `normError`（L18-26，解析「Error invoking remote method …」）。

**组合封装 `util`** L161+：`scenes / scene / dispatch / sessions`，在多个底层 API 之上再组合。

**失败模式（关键）：**

- **AC-018 事故**（注释 L136-142）：preload 暴露了 `app.pc`，但没加进命名空间数组 → `api.pc` 是 `undefined` → 本地电脑场景 4 个面板全显示「接口未返回数据」。**漏加不报错，只静默变 undefined**。
- **本轮新发现**：`caps`（L67）与 `settings`（L76）是**对象/常量**，却被放进了只包函数的 `FN` 数组 → 被 `typeof fn !== 'function'` 跳过，又不在命名空间数组 → `api().caps` 与 `api().settings` **恒为 undefined**（只能走 `api().raw.caps`）。全渲染层 grep 无任何调用点（当前是潜伏态，未爆症状）。

## 五、新增一个 IPC 要改哪几个文件

| 步骤 | 文件 | 改什么 | 位置参照 |
|---|---|---|---|
| 1 | `main.js` | 注册 `ipcMain.handle('通道:动作', ...)`；若是主→渲染推送，用 `win.webContents.send(...)` + `ipcMain.on(...)` | 现有 188 个 handle；2 个 on（L2910/L3063） |
| 2 | `preload.js` | 在 `exposeInMainWorld('app', {...})` 里暴露：顶层函数或挂进某命名空间；推送事件用 `ipcRenderer.on` 并返回 unsubscribe | L28 起的 app 对象 |
| 3 | `ui/api/index.js` | **函数**加进 `FN` 数组（L107）、**对象命名空间**加进命名空间数组（L143）、**订阅**加进 L129 列表 | 漏改 = 静默 undefined（AC-018） |
| 4 | 渲染层消费方 | 调 `api().xxx()` 或 `api().ns.方法()`，不再直接碰 `window.app` | `ui/panels/*.js`、`ui/index.js` |

> 两条逆向反例印证「至少要动三个文件」：preload 暴露了但 api 白名单没列（`pc` 曾踩 AC-018）；注释里宣称的 `renderer\webai-bridge.js` 在本 checkout 不存在（全 `外壳` 只有 `ui\` 一个渲染层目录）。

## 六、判定

- **看懂**：188 个 handle 的数量、27 个命名空间清单、两条白名单数组的机制，均有 grep 精确计数 + 逐行 file:line 支撑。
- **断点/坑**：白名单「函数走 FN、对象走 namespace」两条路径，放错类型就静默丢（`caps`/`settings` 实例）；注释 `L6` 声称「44 个 API 一对一」已过期（实际远超）。
- **结论边界**：只描述「怎么加一个 IPC 要动哪些文件」与「漏了会怎样」，不评判这套三层封装该不该这么设计。
