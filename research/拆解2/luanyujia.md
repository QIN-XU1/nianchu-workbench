# luanyujia-workbench 拆解（v2 · 可抄实现口径）

> 仓库：`D:\refs\luanyujia\luanyujia-workbench-main`（196 文件）
> 说明：这不是一个 git 克隆（无 `.git`，取不到 push 日期/star），也不是一个 npm 根工程（根目录无 `package.json`）。
> 它是「一份长文档 + 一套可跑外壳源码 + 精选片段」。README 用 GBK 编码，用 UTF-8 打开是乱码。

---

## 1. 定位与规模

**一句话**：这是一套「多场景 AI 工作台」的**方法论 + 纯壳模板** —— 一个 Electron 外壳（`12-源码照搬\外壳\`）把一个本地的 DSH 引擎 Web UI 嵌成 `<webview>`，再在网格里按场景摆一堆面板（有的面板是网页、有的面板又嵌一份引擎对话）。

- 文件数：196（`Measure-Object` 实测）；主语言：Markdown 91 + JS 22 + mjs 21 + JSON 15（`Get-ChildItem -Recurse | Group-Object Extension`）。
- 真正的可跑代码只有一套外壳：`12-源码照搬\外壳\package.json:2-4` `{"name":"dsh-workbench","version":"0.2.1-rc.3","main":"main.js"}`；`package.json:12-16` devDeps 只有 `electron 43.4.0` + `electron-builder`；`package.json:21-23` `engines.node >=24.9 <25`。
- 另外两块：`10-源码\` 是「精选 12 份、约 6550 行的脱敏摘录」（`10-源码\README.md:13` 明说「工具链其余部分约 90 个工具、插件、MCP 本体、计划任务不在公开仓」）；`12-源码照搬\引擎数据\.dsh\` 是引擎侧 profile/skills/场景记忆的**示例数据**，不是引擎源码。
- **v1 结论核实**：✅ 正确，但要补一句 —— 不是「webview 里跑工作台」，而是 **Electron 外壳本身是本地 `file://` 渲染层（工作台），它把「DSH 引擎 Web UI」当 `webview` 嵌进来**；每个场景的 AI 面板再各嵌一份同样的引擎 webview。证据：`12-源码照搬\外壳\renderer\index.html:64-68`、`12-源码照搬\外壳\main.js:788-791`（壳自己 `loadFile(renderer/index.html)`）。

---

## 2. 架构骨架

顶层目录（职责，附路径）：

| 目录 | 职责 |
|---|---|
| `00-核心机制`/`05-协作与规矩` | 纯文档：记忆/派单/协作/铁律（规矩层，不是代码） |
| `01-场景模式`/`02-会话定位与跟随` | 纯文档：场景 JSON 格式、面板注册、会话绑定三字段 |
| `12-源码照搬\外壳\` | **唯一完整的 Electron 外壳源码**（main/preload/renderer/scripts） |
| `12-源码照搬\外壳\renderer\` | 工作台自身的 UI（index.html + renderers.js 1.09MB + renderer.js） |
| `12-源码照搬\外壳\scenarios\` | 场景配置 JSON（bilibili / pc-cleanup / self-review / command） |
| `12-源码照搬\插件\启动动画\` | 一个真实 DSH 插件的三件套（package.json + lib/index.js + client/client.js） |
| `12-源码照搬\引擎数据\.dsh\` | 引擎 profile / skills / 场景记忆示例 |
| `10-源码\` | 精选脱敏片段（会话、免费 AI 桥、启动链路、3 个面板、4 个机制小工具） |
| `11-最小可运行壳\index.html` | 零依赖单文件 demo（只看长相用） |

**依赖方向（单向，铁律）**：外壳与引擎**只通过 HTTP + token 认识** —— `main.js:5` 注释「壳与 Harness 解耦——只通过 HTTP+token 认识它」。进程关系见 `04-工作台搭建\技术栈与启动链路.md` §1：① 壳（Electron main）② 渲染层（页面）③ 本地引擎（HTTP 服务）④ MCP 子进程。壳会 `spawn` 引擎（`main.js:324-344`），从引擎 stdout 里正则抓 token（`main.js:258-265`），再拼 `http://127.0.0.1:<port>/?token=...` 给 webview。

**核心/插件边界**：外壳内没有插件内核；插件归引擎（`12-源码照搬\引擎数据\.dsh\profiles\web\package.json` 用 `dsh.profile.bundles` 挂 `@deepseek-ai/dsh-base` + `dsh-web-app`）。壳只在 UI 层"列清单"（`main.js:3486-3534` plugins:list）。边界靠**目录约定 + 文档规矩**强制，无 CI 脚本（全仓无测试/CI，10-源码\README.md 文末自承）。

---

## 3. 【A12】插件 / 扩展机制 —— 重中之重

**结论：插件装载在引擎里（不在本仓）；本仓能抄的是「插件长什么样」+「壳怎么发现/展示插件」+「场景 JSON 这个本地扩展点」。**

**3.1 DSH 插件长什么样（真实三件套，`12-源码照搬\插件\启动动画\`）**

- `package.json`（`12-源码照搬\插件\启动动画\package.json:10-16`）：
  `"type":"module"`, `"main":"lib/index.js"`, `"exports":{".":...,"./client":"./client/client.js"}`,
  `"dsh":{"client":{"inject":["@deepseek-ai/dsh-client-ui-settings"],"platform":"web"}}` —— **贡献点靠 `dsh.client.inject` 声明**，挂进引擎的 settings UI。
- 主机侧 `lib/index.js`：`export const name='boot-anim-host'`、`export const inject=['webServer']`，`export function apply(ctx){ ctx.effect(()=> ctx.webServer.register({kind:'prefix',path:BASE,handler})) }` —— **典型的 Cordis 插件：`apply(ctx)` + `inject:[服务名]` + `ctx.effect(清理)` + `ctx.webServer.register`**。
- 客户端 `client/client.js`：`window.__ModuleLoader__.load({id, factory:(require)=>{ ... exports.apply=(ctx)=>{ ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id,order,label},Section)) } }})` —— **前端贡献点 = `ctx.slots.register('settings.section', ...)`**，不用打包，静态手写模块格式。
  → 这就是"可抄的插件协议"：**主机 `apply(ctx)` + `inject`，前端 `ctx.slots.register(槽位, 组件)`，一份 package.json 的 `dsh.client.inject` 把两者接到一个槽上。**

**3.2 壳怎么发现/校验/展示插件（`main.js:3486-3534`）**

- 扫描 `<HARNESS_DIR>/插件` 每个子目录（`main.js:3495-3500`），读子目录 `package.json` 取 `name/version/description`（`3502-3510`），坏 JSON 静默跳过（`3509`）；统计内置包数 `packages/client`+`packages/host` 下的目录（`3526-3531`）。
- **无 schema 校验、无动态 import、无沙箱** —— 壳只读元信息，装载由引擎负责。这是「宿主只读、引擎装载」的分工。

**3.3 本地真正的"扩展点"= 场景 JSON（`01-场景模式\场景配置格式.md`）**

- 一个新场景 = `scenarios/<id>.json` 丢进目录即被自动发现，**不改主进程代码**（文档 §1「放进去 `scenarios/` 即被自动发现」）。
- 顶层字段 `id/name/description/panels/cols/meta`（`场景配置格式.md` §2）；面板字段 `id/title/type/sub/col/row/w/h`（§3）。
- `type` 必须已注册，否则面板显示"未知面板类型"、不报错不崩（§5 硬规矩）。

**3.4 技能（Skill）发现（`main.js:3536-3600`）**

- 扫描 `<DSH_HOME>/skills`（`:3543`），顶层 `名字/SKILL.md` 目录包或 `名字.md` 单文件（`:3541`）；`parseSkillFrontmatter` 只取 `name/description/whenToUse`（`:3546-3559`）；缺 name/description ⇒ `valid:false` 并标「引擎会丢弃该技能」（`:3576-3579`）。

**3.5 热插拔**：装/卸/启用/禁用在引擎侧；壳里只有 **MCP 开关**这一个"启用禁用"落地点（见 A13）。

---

## 4. 【A13】MCP / 工具接入

**本仓没有 MCP client（client 在引擎，`main.js` 里没有 JSON-RPC/stdio）。本仓有的是：**

1. **MCP 开关面板**（`12-源码照搬\外壳\renderer\mcp-panel.js`）：不自建协议，直接**改引擎 profile 的 patch 覆盖项**——`mcp-panel.js:8-10` 把 `<工作台>\引擎\.dsh\profiles\web\cordis.patch.yml` 里 `- id: xxx` 后追加 `disabled: true`；引擎开了 patch 热重载（`mcp-panel.js:4-5`），写盘即卸载/拉起 MCP 子进程。面板自带每个 MCP 的 `tools` 数与 `est`（token/轮）表（`mcp-panel.js:18-32`），并有分组折叠、确认弹窗（`:158-179`）。
2. **免费网页版 AI 桥**（`03-MCP接免费AI\整体架构.md` + `模板\MCP-站点薄壳.mjs`）：把"网页版 AI"包成本地 MCP 工具，**内核共用一份，加一个站 = 加一个 `site` 对象**（`模板\MCP-站点薄壳.mjs:9` `export const site={id,name,url,loggedIn,inputSel,send,answerSel,wait,profileDir}`）。工具一次调用=`输入→等第一段→等稳定→取文本`（`MCP-站点薄壳.mjs:76-101`）。**这就是"薄壳 MCP"可抄范式**：站差异只在一个对象，流程代码八站共用。

- **工具列表怎么暴露给模型**：由引擎/DSH 完成，壳不参与；壳这边只把工具数/估算 token 显示给用户（`mcp-panel.js:11-14`：`est = ceil(len(tools)/4)+4`，与引擎 token-meter 同口径）。
- **结果回填**：`webai.mjs` 把 `[[bridge:vX]]`/`[[webai-img]]` 等诊断标记从正文剥掉，只回干净文本（`10-源码\免费AI桥\webai.mjs:97,269-287`）。

---

## 5. 【A11】调度 / 后台任务

- **本仓无 cron 引擎代码**。定时任务靠 **Windows 计划任务**注册（外部），文档记了 19 个 `DSH-*` 任务清单与触发时间（`05-协作与规矩\二-标准化规范.md:417`：会话备份周日 12:40、外壳数据备份每天 04:45、回执哨兵每 10 分钟…；`05-协作与规矩\一-全局铁律.md:52` 清理巡检周日 12:35）。启动器一律 `.vbs`（`二-标准化规范.md:421`：ANSI/GBK 写、不加 BOM）。**代码本身不在公开仓**（`10-源码\README.md:13`）。
- **有一个"派活前先看负载"的闸**：`10-源码\机制小工具\负载闸.mjs`（~300 行，`≥90% 不派单、≥95% 连体检都别跑`，见 `10-源码\README.md`「机制小工具」表）。这是可抄的"后台任务准入"。
- 失败/重试/超时：引擎启动失败有退避计数 `bumpBootFail`（`main.js:361-372`，写 `data/engine-boot-fail.json`，成功则 `resetBootFail` `:370-372`）。

---

## 6. 【C1/C2】agent 循环与停止条件

- **agent 主循环不在本仓**：它在 DSH 引擎（webview 里那份 UI 背后的 HTTP 服务）。本仓的壳只负责"拉起引擎 + 把它的 UI 嵌进来"（`04-工作台搭建\技术栈与启动链路.md` §1「③引擎：会话、模型调用、技能、插件」）。→ **C1 判不了（需读引擎源码）**。
- 本仓能抄的是**"外壳侧"的会话生命周期**：建会话 / 换会话 / 归档 / 回写场景 JSON（`10-源码\会话与切换\sessions.mjs`、`换会话.mjs`，见 `10-源码\README.md` 表：sessions.mjs 687 行"逐面板校验 sessionId、建会话、换会话、回写场景 json、RPC 认证 token→签名 cookie"）。
- **停止条件**：本仓**无代码级停止条件**，靠《全局铁律》规矩与派单超时人工判断；派单状态机里有"未回执"这一态（`00-核心机制\四-派单机制.md` §1：②已投递→(超时无回执)→④未回执→收尾知情）。→ 产品级 C2 是"靠规矩"，不是"可判定刹车"。

---

## 7. 【A6/A7】记忆

- **形态：纯文件、三层**（`00-核心机制\二-记忆机制.md` §2）：
  ① **注入层**（每轮注入的全局铁律，必须极短）② **私有层**（`引擎\场景记忆\<场景>\场景私有记忆.md` + `身份卡.md` + `场景画像.md` + `项目记忆\<id>.md`）③ **共享层**（`_共享记忆\`：待办/通知/areas/冲突/索引）。
- **核心前提**：「记忆在文件里，不在会话里」——换会话不失忆（`二-记忆机制.md` §1）。
- **字节红线**（可抄的硬约束）：`12-源码照搬\工具\场景记忆.mjs:149,406-427,556` §〇 ≤ 4096 B；主文件 ≤ 25600 B（`:558`）；`cmdCheck` 逐文件存在性 + 身份索引会话绑定一致性校验（`:472-489`）。
- **A7 治理**：有**冲突副本归档**（`场景记忆.mjs:250-266`：同名不同内容 ⇒ 归档到 `归档\冲突副本-*`，绝不当场删正文）+ 字节红线；**无 provenance 字段链、无 TTL/过期、无 supersededBy**（grep `superseded|expire|ttl` 无命中）。→ A7 = 部分。
- **跨会话召回**：靠 `_文件索引.md` + `索引.json` + 交接 §〇 五小节（`场景记忆.mjs:291-308` 写索引；`cmdHandover:351-394` 补交接并登记索引）。没有向量/embedding。

---

## 8. 【D1–D5】界面

**技术栈**：Electron 43.4.0 外壳 + 手写原生 DOM（无 React/Vue）。壳自身页面 `file://` 加载（`main.js:788-791`），CSP 明确放行 `file:`（`renderer\index.html:9-10`，注释解释 opaque origin 否则图片全裂）。渲染层就是一堆 `renderers['type']=(body,meta,head)=>{}` 函数表（`renderers.js:1692` 起大量 `renderers[...]`，如 `renderers['app-window']` `:1864`）。

**布局范式：4 列 CSS Grid + 每场景 JSON 声明坐标 + 每面板可拖拽改大小。**
- 网格：`renderer\index.html:90-91` `<div id="grid">`；`renderers.js:345` `var GRID_COLS=4`；`renderer.js:934-987` `loadScenario()` 按场景 `cols` 覆写 `grid.style.gridTemplateColumns`（`:954`），逐个面板 `renderers[p.type]` 渲染（`:974`）。
- 拖拽调大小：`renderers.js:343-390`（四边/四角，按格换算，含"独立窗口里 AI 面板被拖成整行宽"的踩坑注释）。
- 组合容器再套一个迷你网格：`renderers.js:1507-1538`（`planComboGrid`，`stage.style.gridTemplateColumns='repeat(N,minmax(0,1fr))'`）。
- 面板类型表就是 `renderers` 对象本身，不另维护清单（`01-场景模式\面板类型与注册.md` §1、§5）。

**状态可见性**：顶栏有余额 chip + 连接状态点（`index.html:56-58`）；顶栏状态区做压力灯/谁在等我/快照回滚（`preload.js:327-345` topbar.*，`topbar-status.js`）；负载胶囊来自 `负载闸.mjs`。→ 有。

**主题/密度/多工作区**：深/浅主题切 `html[data-theme="light"]` + CSS 变量（`styles.css:3-5,480-495`，`renderer.js:678-699` initTheme）；顶栏 1 排 6+ 工具按钮（`index.html:31-46`）密度高；多场景 tab（`index.html:50-61`）+ 场景可"分离"成独立窗口（`main.js:797-817` openSceneWindow，`preload.js:368-375` win.*）。

**⚠ 与我们的直接对应**：我们的 `apps/vouch-web/src/web-ui/WorkbenchScene.tsx` 若也要"宿主内嵌 web UI 里再嵌 agent 对话"，本仓的做法是**每面板一个 `<webview>`、一板一分区**（`renderers.js:14733-14760` `wv.setAttribute('partition', panelPartition(meta))`）——这是我们必须看的关键（见第 9 段机制 2）。

---

## 9. ⭐ 最值得抄的 3 条机制（最重要）

### 机制 1：宿主↔页面的「contextBridge 白名单 + 通道分类」桥

```
机制：preload 用一个 window.app 命名空间把 host 能力按域切开，全部走 ipcRenderer.invoke(channel,...)；
     渲染层永远拿不到 node/fs，主进程是唯一权威。
位置：12-源码照搬\外壳\preload.js:17（contextBridge.exposeInMainWorld('app',{...})）
      + main.js:716-722（webPreferences: preload/contextIsolation:true/nodeIntegration:false/sandbox:true/webviewTag:true）
      + 分域示例 preload.js:52-56(settings)/:80-90(file read/write/stat/toPdf)/:113-115(net.probe)/:320-326(plugins/models)
为什么好：这正是「宿主内嵌 web」最该有的安全边界——页面是 file://（opaque origin），
     除了 preload 白名单出来的 app.* 之外什么都碰不到；每个能力都显式列一条，缺接口就"重启 GUI 才有"，
     天然可灰度（preload.js:35-44 用 caps 位让渲染层判断"敢不敢用新能力"）。
     我们的 web-ui 现在如果有裸 postMessage/直接 ipc，抄这套"按域命名空间 + 一域一 invoke"会立刻安全一档。
我们抄到哪：apps/vouch-web/src/web-ui/（桥的定义层，对应我们宿主 preload/宿主 API 契约处）
```

### 机制 2：把 agent 对话嵌成「每面板一个 webview + 一板一分区 + 注入精简 CSS/钉会话 JS」

```
机制：AI 面板不自己实现聊天，而是 <webview src=引擎URL partition=persist:harness-<panel>>；
     宿主往 guest 的 webContents 注入 insertCSS（隐藏侧栏/详情/标题栏）+ executeJavaScript（按会话标题钉住会话）。
位置：宿主主界面 index.html:64-68（<webview id="harness-webview" partition="persist:harness">）
     + renderer.js:780-793（getHarnessUrl→setAttribute('src',url)，轮询 #root 才算加载完）
     + main.js:915-922（harness:url：token 拼 URL，外部引擎走 /chat 保命入口）
     + main.js:1137-1182（harness:wv:inject：webContents.fromId→insertCSS(HARNESS_CHAT_CSS)+executeJavaScript(HARNESS_FIX_JS)）
     + renderers.js:14733-14760（每面板 new webview、panelPartition、5s 重注入 pinTimer）+ :14076-14109（HARNESS_PIN_JS 按标题/ID 钉会话）
为什么好：这是"宿主内嵌 web"里最难的一段——**不改对方前端**，用 CSS+JS 注入把它裁成"只要聊天框"，
     再用 localStorage 键 + 分区隔离解决"多面板抢同一个会话"（renderers.js:14735-14741 注释：共用分区互抢 vs 一板一分区）。
     我们的 WorkbenchScene 若嵌的是自家 web UI，可直接抄"注入精简 + 分区隔离 + 按会话 id 校正"三件套。
我们抄到哪：apps/vouch-web/src/web-ui/WorkbenchScene.tsx（宿主注入 webview 视图与分区策略）
```

### 机制 3：脚本→HTTP→IPC→webview 的四跳「免费网页版 AI 桥」（含多窗口防抢单）

```
机制：任何会话/脚本 POST 127.0.0.1:31239/webai/ask → 主进程 broadcast('webai:task') → 渲染层在已登录的
     网页版 <webview> 里打字/等稳定/取正文 → IPC webai:done 回包；用 claim + 桥版本申报保证"只有一个窗口干活"。
位置：main.js:4611-4625（链路注释 + 5 站点表）/ :4757-4788（HTTP server 端点）/ :4666-4694（webAiAsk 派发、按窗口挑目标）
     + :4695-4747（webai:claim 抢单 + webai:bridge 版本申报 + webai:done 交卷，三道闸只认派发目标）
     + preload.js:352-362 & 378-385（onTask 单分发器：整个 preload 只注册一次监听，⟳ 重跑不会双处理）
     + renderer\webai-bridge.js:29-140（拿到任务后 ensureWv / 轮询到"确认它答完"的 started+firstChange）
     + 10-源码\免费AI桥\webai.mjs:358-372（长回答 --out 存盘、终端只回 600 字预览，省上下文）
为什么好：这是"进程外只有 HTTP 进得来、而登录态在渲染层 webview 里"这个死结的成熟解：
     ① HTTP 进 / IPC 出，主进程碰不到 DOM 就借渲染层的手；② claim 保证多窗口只有一个接活；
     ③ 版本申报（webai:bridge）让旧窗口的旧桥永远抢不到单——这条『派活前核对执行体版本』极值得抄。
我们抄到哪：apps/vouch-web/src/web-ui/ 的"宿主内 web 调外部登录态页面"链路（桥服务 + 目标挑选 + 版本闸）
```

---

## 10. 我们不该抄的

1. **`renderers.js` 18768 行 / 1.09MB 单文件**（本仓 `renderers.js` 实测；`main.js` 4896 行）。所有面板 + 所有业务塞一个全局 `renderers[...]` 表，靠 ⟳ 热重载整文件。我们已用 TS/组件化，别为了"热更新"退回单文件巨兽。
2. **`file://` + CSP 放行 `file:` 的本地页面形态**（`index.html:9-10`）。我们是 `apps/vouch-web` 走构建产物，不需要为 opaque origin 放开 `file:` 这种历史包袱。
3. **"靠规矩当机制"的文档层**（记忆/派单/权限五档大量写在 md 里）。可借用它的**判据措辞**，但别把它当运行时——它自己也在 `08-升级与改造清单\把规矩变成机制.md` 里承认"还没全变成机制"。
4. **Windows 深度绑定**（AUMID `main.js:24`、`%APPDATA%\npm` 硬路径 `main.js:32`、`.vbs` 计划任务、任务栏身份）。跨平台产品不要抄。
5. **每个场景再嵌一份完整引擎 webview**（`renderers.js:14733`）—— 内存/进程成本高（每面板一个 guest）。我们若在同进程内嵌，应评估共享一个会话视图 + 多焦点，而不是 N 份 webview。
6. **§〇 ≤4KB / 主文件 ≤25KB 这类硬红线**是它单机经验的产物，可参考阈值思路，不必照搬数字。

---

## 附：证伪/未找到清单（避免读者以为我漏了）

- **未找到**：本仓内 `package.json` 之外的构建产物、测试、CI；MCP client（JSON-RPC/stdio）实现；agent 主循环/停止条件的代码；cron 调度器代码。均在引擎或私有仓（`10-源码\README.md:13`）。
- **未找到**：`star`/最近 push 时间（本地无 `.git`）。
- **弱相关**：`13-公开情报\` 是对外部项目的观察笔记（AivyOS/DeepSeek 更新），不是本仓实现，未作为证据。
