# 31 · DeepSeek 工作台：二次开发分析与改造记录

> 本文回答两件事：
> ① **我做了什么**（改名、去作者痕迹、撤掉误加的东西）
> ② **通读整个项目后，哪些地方可以增强改善**

---

## 一、已完成：改名与去作者化

### 1.1 改名

从「淋雨家的工作台」改为 **「DeepSeek 工作台」**。

| 文件 | 替换处数 |
|---|---|
`README.md` | 2 |
`启动.vbs` | 2 |
`外壳/main.js` | 1 |
`外壳/package.json` | 2（含 `productName`、`description`） |
`外壳/renderer/index.html` | 3（title + 品牌区） |
`外壳/renderer/renderer.js` | 1 |
`外壳/renderer/renderers.js` | 3 |
`外壳/renderer/styles.css` | 1 |

**窗口标题实测已变**：`DSH 引擎 · DeepSeek 工作台`

### 1.2 去作者痕迹

| 项 | 处理 |
|---|---|
`LICENSE` 的 `Copyright (c) 2026 淋雨家` | 改为 `Copyright (c) 2026`（保留 MIT） |
`<机主>` 占位符（27 处） | 改为「本机」 |
`linyujia`（2 处） | 改为 `local` |
`上班盯盘助手` / `shangban-dingpan`（3 处） | 改为「示例工具」/ `example-tool` |
`小鱼干`（赞助相关） | 改为「咖啡」 |
「梦想是优雅地淋一场雨」个人签名 | 删除 |
**赞助按钮**（`btn-donate` → `linyujia.me/#donate`） | **整行删除** |
**推广卡片**（个人站 / 工具站 / DSH 集市 / 两个 GitHub 仓库） | **URLS 数组清空**（原 1022 字符 → 220 字符，保留注释说明如何自行添加） |
`main.js` 官网板块推广文案 | 改为中性描述 |

**复查结果**：`linyujia` / `小鱼干` / `上班盯盘` / `<机主>` / `淋一场雨` / `淋雨家` **全部 0 处残留**。

### 1.3 撤掉我误加的东西

我之前理解错方向，往项目里塞了「sea 体检」场景。已全部撤销：

- 删除 `外壳/scenarios/sea-audit.json`、`sea-audit-context.md`
- 删除 `外壳/renderer/sea-audit-panel.js`
- 还原 `main.js`（移除 `sea:audit` IPC）
- 还原 `preload.js`（移除 `seaAudit`）
- 还原 `index.html`（移除脚本引用）
- 还原 `_场景身份索引.md`

**场景数量回到原始 4 个**：`bilibili` / `command` / `pc-cleanup` / `self-review`

### 1.4 改动后的完整性校验：27/27

- 12 个 JS 文件语法全部通过
- 5 个 JSON 全部合法
- 新名字在 package.json / index.html / main.js 生效
- 赞助按钮、推广链接已清除
- electron 二进制完好
- 面板类型数仍 ≥ 30

---

## 二、通读后的分析：可增强的地方

### 2.1 代码规模（真实数字）

| 文件 | 行数 | 大小 | 判断 |
|---|---|---|---|
`外壳/renderer/renderers.js` | **18,744** | **1,090.7 KB** | ⚠ **超大** |
`外壳/main.js` | 4,896 | 256.8 KB | ⚠ 偏大 |
`外壳/renderer/styles.css` | 4,956 | 287.2 KB | ⚠ 偏大 |
`外壳/renderer/topbar-status.js` | 1,728 | 96.0 KB | ⚠ 偏大 |
`外壳/renderer/webai-bridge.js` | 1,506 | 125.2 KB | ⚠ 偏大 |
`外壳/renderer/renderer.js` | 1,320 | 72.1 KB | ⚠ 偏大 |
`外壳/preload.js` | 386 | 22.7 KB | 正常 |

**这是最值得改善的地方**：一个 1.09 MB 的单文件渲染器，占了整个项目代码量的绝大部分。

### 2.2 改善建议（按价值排序）

#### ① 【高】拆分 `renderers.js`

现状：**18,744 行 / 1.09MB 单文件**，用 `var renderers = {}` 集中注册 36 种面板。

问题：
- 编辑器打开会卡
- 改一个面板要加载全文
- 项目 README 说它是**热更新**文件（点 ⟳ 会重新拉取）—— 每次热更新都要重载 1MB

建议：
- 按面板族拆成多个文件：`renderers/core.js`（view/file/combo/dash）、`renderers/pc.js`、`renderers/site.js`、`renderers/review.js`、`renderers/blender.js`、`renderers/misc.js`
- `renderers.js` 只做加载与合并（`Object.assign(renderers, ...)`）
- 热更新只重载被改的那个

风险：拆分要动 `renderer.js` 的加载逻辑，需同步改 `index.html` 的 script 列表或改成动态 import。

#### ② 【高】27 种面板闲置

注册 36 种，场景只用 9 种，**闲置 27 种**：

```
app-window, bl-folder, bl-live, board, chart, code-urls, combo, ctl,
dash, file, flow, log, market, radar, reserved, screen, shell,
site-about, site-folder, site-media, site-preview, site-projects,
site-urls, usboard, view, wb-cards, web
```

其中很多是上游 luanyujia 的通用面板（`view`+`file` 是它复用率最高的搭配、`combo` 组合窗、`flow` 节点画布）。

**价值**：这些是**已经写好的能力**，只是没场景在用。加一个新场景能立刻用上，等于白拿。
**代价**：它们依赖 luanyujia 的目录约定（站点目录、Blender 工程等），部分需要改数据源才能用。

建议：**先挑 3 个改造**：
- `view` + `file`（预览 + 文件树，最通用）
- `wb-cards`（卡片网格，最轻）
- `combo`（组合窗，解决"一块地放两样"）

#### ③ 【中】场景缺「记忆」件

四个场景的完整性都是 **3/4**：

| 场景 | json | 定位卡 | **记忆** | 技能 |
|---|---|---|---|---|
bilibili | Y | Y | **N** | Y |
command | Y | Y | **N** | Y |
pc-cleanup | Y | Y | **N** | Y |
self-review | Y | Y | **N** | Y |

原因：记忆在 `引擎数据/.dsh/场景记忆/` 下，用的是**中文目录名**（`B站`/`命令`/`本地电脑`/`自我复盘`），不是场景 id。所以按 id 找不到。

**这是真实的命名不一致**：`scene.json` 的 `id` 是英文，记忆目录是中文，靠 `_共享记忆/index.json` 的 `areas[].memory` 字段路由。

建议：统一成用 `id` 命名（`bilibili`/`command`/`pc-cleanup`/`self-review`），或明确文档化这套中英映射。

#### ④ 【中】硬编码端口

`main.js` 里硬编码：

| 端口 | 出现次数 | 用途 |
|---|---|---|
`3083` | 1 | 引擎默认端口（可用 `DSH_PORT` 覆盖） |
`31238` | 5 | 界面静态服务 |
`31239` | 2 | 网页版 AI 桥 |
`3080` | 1 | 引擎 GUI 地址 |

建议：把 `31238`/`31239` 也改成可用环境变量覆盖（现在只有 `DSH_PORT` 可覆盖），避免端口冲突时要改代码。

#### ⑤ 【中】上游文档未搬运

上游仓库有 15 个目录，工作副本只搬了运行必需的部分：

| 上游目录 | 文件数 | 是否搬运 |
|---|---|---|
`12-源码照搬` | 96 | ✅（这就是工作副本来源） |
`00-核心机制` | 7 | ❌ |
`01-场景模式` | 6 | ❌ |
`02-会话定位与跟随` | 7 | ❌ |
`03-MCP接免费AI` | 4 | ❌ |
`04-工作台搭建` | 8 | ❌ |
`05-协作与规矩` | 5 | ❌ |
`06-场景实例` | 4 | ❌ |
`07-顶栏与菜单栏` | 4 | ❌ |
`08-升级与改造清单` | 3 | ❌ |
`13-公开情报` | 7 | ❌ |
`模板` | 8 | ❌ |

**这些是方法论金矿**（尤其 `00-核心机制` 的记忆机制、`03-MCP接免费AI` 的桥架构）。

建议：**不搬进工作副本**（它们是文档不是代码），而是在项目根建一个 `参考/` 目录放这些文档，供查阅。

#### ⑥ 【低】自检脚本可增强

现有 `外壳/scripts/` 有 10 个脚本，其中 `自检.mjs` 和 `check-gui.mjs` 是健康检查。

可增强：加一个「场景完整性检查」——检查每个场景的 json / 定位卡 / 记忆 / 技能 / 会话绑定是否齐全（这正是 ③ 发现的问题）。

### 2.3 我认为暂时不该动的

| 项 | 原因 |
|---|---|
| `main.js` 4,896 行拆分 | 主进程强耦合（窗口管理、IPC、引擎启动、Blender overlay、网页AI桥全在一起），拆风险高收益低 |
| `styles.css` 4,956 行 | CSS 拆分对运行时无收益，只对编辑体验有改善，优先级低 |
| 36 种面板全改 | 工作量巨大且多数用不上 |
| Electron 版本升级 | 当前 43.4.0 已验证可用，升级会引入未知风险 |

---

## 三、当前状态

### 3.1 运行验证

| 项 | 状态 |
|---|---|
窗口标题 | **DSH 引擎 · DeepSeek 工作台** ✅ |
进程 | 13 个 electron 进程 |
31238 界面服务 | ✅ 监听 |
31239 网页AI桥 | ✅ 监听 |
`/chat` 保命入口 | ✅ HTTP 200 |
场景 | 4 个原始场景 |
完整性校验 | **27/27** |
作者痕迹残留 | **0 处** |

### 3.2 工作副本位置

`D:\file\AI Temp\DeepSeek\Agent自研\workbench\`

### 3.3 启动命令

```powershell
cd "D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳"

# 关键：必须清除 ELECTRON_RUN_AS_NODE，否则 app 是 undefined 会崩
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 复用正在运行的 DSH（默认它监听 1996/3080 等端口，按实际改）
$env:DSH_PORT="1996"

& ".\node_modules\electron\dist\electron.exe" .
```

---

## 四、下一步建议（等你决定）

| 优先 | 做什么 | 理由 |
|---|---|---|
**1** | **拆分 renderers.js** | 1MB 单文件是最大技术债，且它是热更新文件，拆分后热更新会明显变快 |
**2** | **把 3 个闲置面板接进场景**（view+file / wb-cards / combo） | 已有代码，改数据源即可用，性价比最高 |
**3** | **统一场景记忆目录命名**（中文 → id） | 现在 4 个场景都缺"记忆"件，这是真实的不一致 |
**4** | **端口改成可配置** | 避免冲突时要改代码 |
**5** | 把上游 13 个文档目录放到项目根的 `参考/` | 方法论资料，不进运行目录 |

---

## 五、一句话

> **改名与去作者化已完成（15 处改名 + 34 处痕迹清除 + 赞助按钮与推广卡片整块移除），校验 27/27，窗口标题已生效。**
> **通读后最值得改的是 `renderers.js` 的 1MB 单文件 —— 它是热更新文件，每次刷新都重载 1MB；其次是 27 种闲置面板没被用上。**
> **我这次没有擅自改动这些，等你定了再动。**
