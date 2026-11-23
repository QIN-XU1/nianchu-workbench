# DSH Client 侧插件规范（实测版）

> 全部结论来自本机实际文件，逐条标注出处。
> 环境：DSH `0.2.2-rc.1`，asar = `D:\file\software\DeepSeek Harness\resources\app.asar`
> （下文 `asar:` 前缀 = asar 内路径 `dsh/node_modules/@deepseek-ai/<pkg>/...`）
> 页面外壳 bundle = `asar:dsh-web-frontend/dist/assets/index-BgUyXZcc.js`（951,974 字符，仅 **198 行**，绝大部分逻辑压在第 123~197 行）

---

## 0. 先厘清三组同名但完全不同的东西

这是最容易出错的地方，先把三组概念分开：

| 名称 | 写在哪 | 值的含义 | 谁校验 |
|---|---|---|---|
| `dsh.client.inject` | `package.json` | **包名**（如 `@deepseek-ai/dsh-client-ui-layout`） | `dsh-client-modules` 的 `parseDshClient` |
| 插件对象的 `inject` | `client.js` 里 `return { inject: [...] }` | **Client Service 名**（如 `'slots'`、`'locale'`） | cordis `Inject.resolve` |
| `slots.register({ inject })` | `client.js` 注册项里 | **组件额外 props 的工厂函数** | `dsh-client-ui-renderer` |

三者互不相同，且都不能混用。

---

## 1. `dsh.client` 声明的完整字段

### 1.1 唯一权威校验器（逐字原文）

浏览器半：`asar:dsh-client-modules/lib/client.js:61-75`

```js
function parseDshClient(pkgName, value) {
    if (value === void 0) return void 0;
    if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
    const decl = value;
    if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
    const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
    const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
    if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
    return {
        platform: decl.platform,
        ...inject !== void 0 ? { inject } : {},
        ...external !== void 0 ? { external } : {},
        ...decl.immediately !== void 0 ? { immediately: decl.immediately } : {}
    };
}
```

宿主半有一份完全相同的副本：`asar:dsh-client-modules/lib/index.js:86-100`。

**结论：字段只有 4 个 —— `platform`（必填）、`inject`、`external`、`immediately`（均可选）。多写别的字段会被静默丢弃（不是报错）。**

### 1.2 `platform`

**唯一取值 `"web"` 才有意义。** 宿主半的组合闸门（`asar:dsh-client-modules/lib/index.js:790`）：

```js
if (decl === void 0 || decl.platform !== "web") return null;
```

即：不写 `platform` 或写别的值 → 该包裹根本不会进入 boot graph，`/plugins` 路由也不提供它的 bundle，浏览器永远拿不到它。**所以这是"必须设"的唯一字段。**

不写 `./client` 导出但声明了 `dsh.client` 会**硬失败**（同上文件 791-792 行）：

```js
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
```

### 1.3 `immediately`

只影响**预取时机**，不影响功能。页面 boot 里唯一的消费点（`asar:dsh-web-frontend/dist/assets/index-BgUyXZcc.js`，`prefetchImmediateTier`）：

```js
async prefetchImmediateTier(){
  await Promise.all(
    this.manifest.plugins.filter(e=>e.immediately)
      .map(e=>this.modules.prefetch(e.id).catch(t=>{}))
  )
}
```

它会在**应用挂载前后台预取**这些 bundle，避免首个使用时的加载延迟。缺失/失败都被 catch 吞掉。

**全 88 个带 `dsh.client` 的包中，只有 11 个设了 `immediately: true`**（本机统计）：

```
dsh-api-gateway          dsh-api-remotes          dsh-client-connection
dsh-client-file-upload   dsh-client-hmr           dsh-client-locale
dsh-client-modules       dsh-client-ui-renderer   dsh-client-ui-theme
dsh-typert-registry      dsh-experimental-inspector
```

全部是基础设施（模块系统、渲染器、主题、语言、连接、网关）。**业务 UI 插件一律不要设。**

### 1.4 `inject`

值是**包名**，作用是"这些包的 client bundle 必须先到"。

消费点（`asar:dsh-client-modules/lib/client.js:791-794`，`arriveGraphRow`）：

```js
for (const packageName of row.inject) {
    const dependency = this.graphRows.get(packageName);
    if (dependency !== void 0) await this.arriveDependency(row.id, dependency, [], visited);
}
```

注意 `if (dependency !== void 0)` —— **写错的包名会被静默忽略，不报错**。所以 `inject` 写错不会炸，但也不会起保护作用。

**什么时候必须设：** 你的插件在模块顶层（factory 执行时）就要 `require` 别人的 client bundle，或者必须在别人的 Slot 声明之后才注册（后者其实 `slots.inject` 已经保证，不需要 `inject`）。绝大多数业务插件 **`inject` 为空或不写即可**。

### 1.5 `external`

**只用于"非 baseline"模块请求**，且**会建立真实的模块图边**。

宿主半构图（`asar:dsh-client-modules/lib/index.js:480-502`，`orderByModuleGraph`）：

```js
for (const name of entry.external ?? []) {
    const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name));
    if (dependency === entry) throw new Error(`client-modules: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external`);
    if (dependency !== void 0) visit(dependency);
}
```

浏览器半同语义（`client.js:785-790`），且**seed 表里的词会被跳过**：

```js
for (const request of row.external) {
    const id = stripClientSuffix(request);
    if (this.seed.has(request) || this.loadCache.has(id)) continue;
    ...
}
```

官方 README 的定义（`asar:dsh-client-modules/README.md:55`）：

> The shell seeds a frozen module table (`PLATFORM_MODULES`); every dynamic bundle resolves its externals against exactly that baseline. `dsh.client.external` adds only exact non-baseline requests, each answered by the dynamic package row it names or an exact static-table key. Type-only imports are erased and create no request. Composition rejects malformed requests, missing suppliers, self-requests, and synchronous request cycles.

**全仓只有 6 个包用了 `external`，全部是同一条：**

```
dsh-api-job-controller              -> ["@deepseek-ai/dsh-api-gateway/client"]
dsh-api-remote-access               -> ["@deepseek-ai/dsh-api-gateway/client"]
dsh-api-session-controller          -> ["@deepseek-ai/dsh-api-gateway/client"]
dsh-api-terminal-controller         -> ["@deepseek-ai/dsh-api-gateway/client"]
dsh-api-workspace-controller        -> ["@deepseek-ai/dsh-api-gateway/client"]
dsh-experimental-client-ui-voice-input -> ["@deepseek-ai/dsh-api-gateway/client"]
```

> ⚠️ **重要更正**：`@deepseek-ai/dsh-client-ui-primitives` **本来就在 baseline 里**（见第 2 节），**不需要**写进 `external`。写了也不会报错（seed 命中的 external 被 `continue` 跳过），属于冗余声明。第三方插件 `browser-skill-dsh-plugin` / `@local/dsh-memory-neuron` 都这么写了，可以照抄但没必要。

### 1.6 三个真实插件的 `dsh` 原文对比

**(a) `asar:dsh-client-ui-jobs/package.json:54-64`** —— 最简形态，无 `external`、无 `immediately`：

```json
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-job-controller",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-primitives"
      ],
      "platform": "web"
    }
  }
```

**(b) `asar:dsh-client-ui-schedule/package.json:21-39`** —— 依赖最多，同样无 `external`、无 `immediately`：

```json
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-api-workspace-controller",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-tool",
        "@deepseek-ai/dsh-client-ui-workspace",
        "@deepseek-ai/dsh-client-ui-primitives"
      ],
      "platform": "web"
    }
  },
```

**(c) `asar:dsh-client-ui-renderer/package.json:29-34`** —— 只有 `platform` + `immediately`，连 `inject` 都不写：

```json
  "dsh": {
    "client": {
      "platform": "web",
      "immediately": true
    }
  }
```

**(d) 已安装第三方** `C:\Users\15282\.dsh\profiles\desktop\node_modules\@wxg-prc-cpg\browser-skill-dsh-plugin\package.json:44-58`：

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-tool",
        "@deepseek-ai/dsh-client-ui-layout"
      ],
      "external": [
        "@deepseek-ai/dsh-client-ui-primitives"
      ]
    }
  }
```

**(e) 已安装第三方** `C:\Users\15282\.dsh\profiles\desktop\node_modules\dsh-claude-style\package.json:39-50` —— 一个**什么都不 inject** 的主题插件（它只做 DOM/样式层）：

```json
  "dsh": {
    "engines": {
      "dsh": ">=0.1.7"
    },
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [],
      "platform": "web"
    }
  }
```

### 1.7 最小可用 vs 生产推荐

```json
// 最小
"dsh": { "client": { "platform": "web" } }

// 生产推荐（要往别人的 slot 里注册）
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"]
  }
}
```

`inject` 里填你想注册进的那个 slot 的**声明者包**（`sidebar.panellist` ← `dsh-client-ui-sidebar`；`main` ← `dsh-client-ui-layout`）。严格说 `slots.inject` 已经保证顺序，写 `inject` 只是额外保险。

---

## 2. `require` 白名单：完整清单

### 2.1 权威来源：`PLATFORM_MODULES` seed 表

外壳自己构造并交给模块系统的冻结表。**原文**（`asar:dsh-web-frontend/dist/assets/index-BgUyXZcc.js:196`）：

```js
function YZ(){return{
  react:fk,
  "react/jsx-runtime":gk,
  "react-dom":xk,
  "react-dom/client":Ck,
  "@deepseek-ai/cordis":Rb,
  zod:JS,
  "@tanstack/react-virtual":rI,
  "@deepseek-ai/dsh-client-store":SI,
  "@deepseek-ai/dsh-client-ui-slots":MI,
  "@deepseek-ai/dsh-client-ui-primitives":FU,
  "@deepseek-ai/dsh-client-ui-dockkit":WZ
}}
```

它作为 `staticModules` 传入（同文件 boot 处）：

```js
this.modules=r.create({boot:t.__DSH_BOOT__,staticModules:YZ(),...})
```

### 2.2 完整白名单（11 项，逐字）

| # | specifier | 内容 |
|---|---|---|
| 1 | `react` | React 18 运行时 |
| 2 | `react/jsx-runtime` | `jsx` / `jsxs` / `Fragment` |
| 3 | `react-dom` | ReactDOM |
| 4 | `react-dom/client` | `createRoot` |
| 5 | `@deepseek-ai/cordis` | cordis 本体（Context / Service / symbols…） |
| 6 | `zod` | Zod（v4 风格） |
| 7 | `@tanstack/react-virtual` | 虚拟列表 |
| 8 | `@deepseek-ai/dsh-client-store` | `createSnapshotStore` / `defineStore` / `shallowEqual` / `notifySubscribers` |
| 9 | `@deepseek-ai/dsh-client-ui-slots` | `SlotCore` / `SlotOwnershipError` / `StaleAuthorizationError` / `resolveSlotLabel` / `standardHookPropName` |
| 10 | `@deepseek-ai/dsh-client-ui-primitives` | 311 个导出（见第 3 节） |
| 11 | `@deepseek-ai/dsh-client-ui-dockkit` | 63 个导出（Dock 布局引擎） |

> 注：`@deepseek-ai/dsh-client-ui-dockkit` **在 asar 里没有独立包目录**，只以 seed 形式内联在 shell bundle 里（`const WZ=Object.freeze(...)`，同文件第 194 行）。可以 `require`，但不能作为 `dsh.client.inject` 的包名去等待。

### 2.3 除此之外呢？—— 没有

`require` 的解析顺序（`asar:dsh-client-modules/lib/client.js:834-843`）：

```js
makeRequire(ownerId, edges) {
    const require = (spec) => {
        edges.add(spec);
        if (this.seed.has(spec)) return this.seed.get(spec);
        const id = stripClientSuffix(spec);
        const record = this.loadCache.get(id);
        if (record !== void 0) return record.exports;
        if (this.factories.has(id)) return this.materialize(id).exports;
        throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`);
    };
```

三分支：**seed 表 → 已materialize → 已注册 factory**。第四种情况直接抛错。

所以：
- 想要 `@deepseek-ai/dsh-api-gateway/client` 之类的**其他包**，光写 `external` 不够 —— 该包必须是 boot graph 里一个**活跃的** dynamic 行（即它在 profile 的 bundle 列表里且已启用），否则 `graphRows.get(id)` 拿不到，`require` 仍然抛错。
- **不存在** `require('@deepseek-ai/dsh-client-ui-conversation')` 这种"从 UI 包里取组件"的用法是可以的（如果那个包在 graph 里），但**官方明确劝阻**（见 2.5）。

### 2.4 `external` 与 `require` 的关系

一句话：**`external` 是给"非 baseline 的 require"登记供应商，让模块图知道你依赖谁、先加载谁。它不改变 `require` 白名单本身，只是让第 3 分支（已注册 factory）能命中。**

`<id>/client` 和裸包名会归一到同一个 id（`stripClientSuffix`，`client.js:98-100`）：

```js
function stripClientSuffix(spec) {
    return spec.endsWith("/client") ? spec.slice(0, -7) : spec;
}
```

即 `require('@deepseek-ai/dsh-api-gateway/client')` 与 `require('@deepseek-ai/dsh-api-gateway')` 等价；这也是为什么 `external` 里写哪个都行。

### 2.5 官方对"跨包 require UI 组件"的态度（重要，与常见做法相反）

`asar:dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35`：

> Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed. They change without notice, a plain-JS plugin has no type check, and a throwing component blanks your slot entry (console: `slot entry crashed in '<slot>'`). Write your own controls and match the host instead: copy markup, CSS, and behavior from the primitive into the plugin …

而 `asar:dsh-client-ui-workspace/README.md:195` 给了相反的口径：

> A Module Loader package (`factory(require)`, as in the real Loader/Web fixture) gets `@deepseek-ai/dsh-client-ui-primitives` as an implicit baseline external: resolve `MenuItemButton` through the loader's `require`, do not list the primitive as a runtime dependency or bundle another copy…

**实操判据：**
- `factory(require)` 形态（本报告讨论的形态）→ primitives **可以直接 require**，官方 UI 包（jobs / schedule / plugin-manager / conversation …）全都这么做（68 处）。
- 稳定性取舍：primitives 的图标组件只依赖 `size`/`className`，风险低；`Menu` / `Modal` / `SettingsForm` 等复杂组件一旦抛错会让**整个 slot 条目白掉**（`slot entry crashed in '<slot>'`）。

### 2.6 内置包实际 require 分布（全仓统计，作参考）

```
  71  react/jsx-runtime
  68  @deepseek-ai/dsh-client-ui-primitives
  66  react
  53  @deepseek-ai/dsh-client-store
  23  @deepseek-ai/cordis
  16  react-dom
  12  zod
   7  @deepseek-ai/dsh-client-ui-slots
   6  @deepseek-ai/dsh-api-gateway/client
   3  @tanstack/react-virtual
   1  react-dom/client
   1  @deepseek-ai/dsh-client-ui-dockkit
```

**没有一次 require 超出上面的 11 项**（`util` / `url` / `${spec}` 三条是 Node 侧代码里的误命中，非 client bundle）。

---

## 3. primitives 的全部导出（311 个）

### 3.1 导出对象原文（首尾）

`asar:dsh-web-frontend/dist/assets/index-BgUyXZcc.js:194`：

```js
const FU=Object.freeze(Object.defineProperty({
  __proto__:null,
  AnimatedRows:PD,
  BrandWordmark:pR,
  Button:vi,
  CODE_HIGHLIGHT_EXTENSIONS:NO,
  Checkbox:tR,
  CodeBlock:Qy,
  CommandText:Hy,
  ConnectionIndicator:fR,
  ...
  IconSparkleRegular:LP,
  ...
  IconWorkspaceTreeOutlineRegular:mD,
  ...
  Menu:$4,
  MenuGroup:iR,
  MenuItemButton:WD,
  MenuSurface:G1,
  Modal:wy,
  ...
  Theme 相关:无
  ...
},Symbol.toStringTag,{value:"Module"}))
```

（完整名单已落盘：`primitives-names.txt`，311 行）

### 3.2 非图标导出（101 个，逐字）

（`__proto__` 是 `Object.freeze` 的伪条目，不算导出）

```
AnimatedRows            BrandWordmark           Button
CODE_HIGHLIGHT_EXTENSIONS Checkbox              CodeBlock
CommandText             ConnectionIndicator     DEFAULT_DIFF_MAX_LINES
DEFAULT_READ_MAX_LINES  DEFAULT_SEARCH_MAX_LINES DEFAULT_TERMINAL_MAX_LINES
DOCUMENT_ZOOM           DetailDocument          DiffBlock
DisclosureRow           DraggableImage          FISH_LOGO_PATH
FISH_LOGO_VIEWBOX       FileTypeIcon            FishLogo
GuideArtworkBrowser     GuideArtworkFiles       HoverCard
HoverCardGroup          ICON_MEDIUM_STROKE      ICON_REGULAR_STROKE
ICON_SYMBOLS            ImageLightbox           InlineEditor
Input                   JsonBlock               JsonTree
LinkIconMedium          LinkIconRegular         MENU_TRANSITION_MS
MarkdownDelegateProvider MarkdownText           Menu
MenuGroup               MenuItemButton          MenuSurface
Modal                   PathLabel               Pill
PluginArtworkDefault    PluginArtworkLoop       PluginArtworkSearch
PluginArtworkSubagent   PluginArtworkTerminal   QuotePreview
ReadBlock               ReferenceChip           ReferenceIconMedium
ReferenceIconRegular    RiskConfirmation        SHIELD_OUTLINE_PATH
SearchBlock             SegmentedControl        SegmentedTabs
SettingsForm            SettingsFormModel       SettingsSecretField
SettingsValueField      ShortcutKeys            StateDot
Switch                  Tag                     TerminalBlock
TextShimmer             Toast                   Tooltip
UserMessageBubble       UserTextRun             WebBlock
ZoomControls
--- 函数 / hooks ---
classifyFileType        classifyLinkPath        closeTopModal
detailDocumentState     diffTotals              extractMarkdownPlainText
fileExtension           fileSizeText            focusWithoutRing
formatQuoteText         isBehindModal           isDarwinDesktop
isMobileDevice          languageForPath         modalSelector
observeComposition      observeStickyMenuGroups pointerModality
rankByName              relativeTime            settingsNumberField
settingsTextField       useAnchoredMaxHeight    useAnchoredPosition
useClipboardCopy        useCodeHighlighter      useDetailDocumentLabels
useDismissOnOutsidePointer useMarkdownDelegate  useModalLayer
useRowDragPreview       writeClipboard
```

### 3.3 图标导出（209 个）

精确构成（`primitives-names.txt` 全量 311 项统计）：

| 类别 | 数量 | 说明 |
|---|---|---|
| `Icon[A-Z]*` 组件 | **194** | 真正的图标 React 组件，96 个字形家族 × 常规/中等两档笔画 |
| `PermissionIcon*` | **8** | `AutoReview` / `FullAccess` / `ReadOnly` / `WorkspaceWrite` × `Regular` / `Medium` |
| `LinkIcon*` | **2** | `LinkIconMedium` / `LinkIconRegular` |
| `ReferenceIcon*` | **2** | `ReferenceIconMedium` / `ReferenceIconRegular` |
| `ICON_*` 常量 | **3** | `ICON_SYMBOLS`（id→SVG 字符串全表）、`ICON_REGULAR_STROKE`、`ICON_MEDIUM_STROKE` |
| **合计** | **209** | |

**96 个字形家族清单**：

```
AgentPreset  AlarmClock  Api  AppsAdd  Archive  ArchiveCheck  ArchiveOff
Branch  Browse  Check  CheckCircle  CheckCircleFill  Checklist  ChevronDown
ChevronLeft  ChevronRight  ChevronUp  ChevronsUpDown  Clock  Close
CloseCircleFill  CloseFill  Code  Compact  CompareSplit  ContextInjection
Copy  CordisPlugin  Dark  Data  Database  DeliverDoc  Dislike  DislikeFill
Download  DragHandle  Edit  Ellipsis  Enhance  FlatList  FolderClose
FolderOpen  Followsystem  Fullscreen  Gauge  Globe  Goal  Info  Inspect
Light  Like  LikeFill  Link  ListPen  Loading  Microphone  NewChat
NowrapFill  PanelLeft  PaperPlane  Paperclip  Pause  Personalization
Pin  PinFill  Plan  Play  PluginPinwheel  Plus  ProjectAdd  Question
Queue  Refresh  RightUp  Save  Search  Send  Settings  Share  Shield
Skill  SlidersTwo  Sparkle  StopFill  Think  Trash  TreeCorner
TriangleRightFill  Unarchive  User  Users  Warning  WarningTriangle
WorkspaceTree  WrapFill  WrapLines
```

**命名规则**：`Icon<家族>Outline<Regular|Medium>`（描边）或 `Icon<家族>[Fill]<Regular|Medium>`（填充）。**不是**所有家族都有 `Outline`：`Sparkle` / `AgentPreset` / `DeliverDoc` 等无 `Outline` 段（`IconSparkleRegular`，不是 `IconSparkleOutlineRegular`）。

### 3.4 你点名的三个图标

| 你问的 | 是否存在 | 实际导出名 | 对应字形 key |
|---|---|---|---|
| `IconSparkleRegular` | ✅ 存在 | `IconSparkleRegular`（另有 `IconSparkleMedium`） | `sparkle` / `sparkle`(medium) |
| `IconWorkspaceTreeOutlineRegular` | ✅ 存在 | `IconWorkspaceTreeOutlineRegular`（另有 `…Medium`） | `workspace-tree-outline` |
| **`IconFocusOutlineRegular`** | ❌ **不存在** | — | 全仓无 `"focus-outline"` 字形；`pointer` / `target` / `crosshair` / `cursor` 字形也都不存在 |

字形定义原文（`index-BgUyXZcc.js`）：

```js
// 图标组件工厂
function M(e,t){const{size:r,aspect:[i,n]=[1,1]}=Qv[e],s=ey(e,t);
  return({size:l=r,className:u})=>p.jsx("svg",{
    width:l*i/n,height:l,className:u,"data-icon":s,"aria-hidden":"true",
    children:p.jsx("use",{href:`#${s}`})
  })}

// 三个具体绑定
LP=M("sparkle","regular"),            NP=M("sparkle","medium")
mD=M("workspace-tree-outline","regular"), gD=M("workspace-tree-outline","medium")
lN=M("agent-preset-outline","regular"),  cN=M("agent-preset-outline","medium")

// symbol id 规则
function ey(e,t){return`dsw-icon-${e}-${t}`}
```

**图标组件的 props 只有 `{ size, className }`**（无 color、无 stroke）。尺寸默认取字形自身的 `size`（16），`aspect` 处理非 1:1 字形。

### 3.5 ⚠️ 图标依赖 ui-theme 的 sprite（关键坑）

图标本身只是 `<svg><use href="#dsw-icon-xxx"/></svg>`，**真正定义 `<symbol>` 的是 `dsh-client-ui-theme`**。

`asar:dsh-client-ui-theme/lib/client.js:1431-1457`：

```js
function installIconSprite(ctx, icons) {
    if (typeof document === "undefined") return;
    const sprite = document.createElementNS(SVG_NS$1, "svg");
    sprite.setAttribute("aria-hidden", "true");
    sprite.setAttribute("data-dsh-icon-sprite", "");
    sprite.style.cssText = "position: absolute; width: 0; height: 0; overflow: hidden";
    const rendered = new Map();
    const markups = new Map();
    const apply = (replacements = {}) => {
        for (const [id, fallback] of Object.entries(_deepseek_ai_dsh_client_ui_primitives.ICON_SYMBOLS)) {
            const markup = replacements[id] ?? fallback;
            if (markups.get(id) === markup) continue;
            const symbol = toSymbol(id, markup);
            ...
        }
    };
    apply(icons);
    ctx.effect(() => {
        document.body.prepend(sprite);
        return () => { sprite.remove(); };
    }, "ui-theme: icon sprite");
```

**推论：**
1. `ui-theme` 必须在组合里（`dsh-web-app` 的 patch 第 250-251 行固定插入它，桌面/web profile 都默认有）。
2. 若图标显示为**空白**而不是报错，多半是 sprite 没挂上或被卸载 —— 查 `document.body > svg[data-dsh-icon-sprite]` 是否存在、里面有没有对应 `<symbol id="dsw-icon-…-regular">`。
3. 主题（如 `dsh-claude-style`）可以通过 `theme.overrideTokens` 的 `icons` 替换图形，但 id 不变。

### 3.6 真实使用片段（照抄）

**(a) `asar:dsh-client-ui-schedule/lib/client.js:17193-17205`** —— 侧栏图标（正是 `sidebar.panellist` 的 occupant）：

```js
//#region lib/types/client/TaskManagerIcon.js
/** Decorative occupant for the task-manager sidebar entry. */
/**
* Render the clock glyph at the size the sidebar asks for; the sidebar owns
* its accessible navigation label. The glyph is the row's direct icon child,
* as on every other panel row: an inline wrapper makes it the baseline of a
* line box inside the row's glyph slot, which lifts it above the label.
* @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
* @returns decorative clock icon.
*/
function TaskManagerIcon({ size }) {
    return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconClockOutlineRegular, { size });
}
//#endregion
```

**(b) `asar:dsh-client-ui-plugin-manager/lib/client.js:7608-7616`**：

```js
//#region lib/types/client/PluginsPanelIcon.js
/**
* Render the plugin glyph at the size the sidebar asks for.
* @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
* @returns the icon element.
*/
function PluginsPanelIcon({ size }) {
    return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPluginPinwheelOutlineRegular, { size });
}
//#endregion
```

**(c) `asar:dsh-client-ui-workspace/lib/client.js:3043`** —— 用 `IconWorkspaceTreeOutlineRegular`，且**不传 size**（用字形默认 16）：

```js
icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWorkspaceTreeOutlineRegular, {})
```

**(d) `asar:dsh-client-ui-chat/lib/client.js:4833`** —— `IconSparkleRegular` 传 `size: 14`：

```js
tools: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSparkleRegular, { size: 14 })
```

**(e) 纯 JS（无 JSX）写法**（`browser-skill-dsh-plugin` 与 `memory-neuron` 都是这个形态，可直接用 `React.createElement`）：

```js
let P = null;
try { P = require('@deepseek-ai/dsh-client-ui-primitives'); } catch (_e) { P = null; }

function MyIcon(props) {
  const size = (props && props.size) || 16;
  const Prim = P && P.IconWorkspaceTreeOutlineRegular;
  if (Prim) return React.createElement(Prim, { size });
  return React.createElement('svg', { /* 自绘回落 */ });
}
```

---

## 4. Slot 注册的完整写法

### 4.1 两个目标 slot 的权威定义（来自实时候选目录）

`asar:dsh-cordis-client-runner/lib/client.js:6228-6274`（`sidebar.panellist`）：

```js
{
  key: "sidebar.panellist",
  kind: "list",
  scope: "root",
  summary: "Global panel icons.",
  doc: "Global panel icons. Each list id addresses the matching main panel;\nthe sidebar owns the button and resolves its label from list metadata.",
  registerOptions: [
    { name: "id",    requirement: "required", type: "string",
      doc: "Your cell key. Use an id of your own: a fresh id is added beside the shipped entries, while reusing a shipped id puts you in THAT cell and replaces it. Owners that filter by id address you by it." },
    { name: "order", requirement: "optional", type: "number",
      doc: "Position among the entries, ascending (default 0)." },
    { name: "label", requirement: "optional", type: "string | (() => string)",
      doc: "Display text where the owner projects one (nav rows, tabs). A thunk is re-read on every projection, so localized text follows the active locale without re-registering." }
  ],
  ownerProps: ["/** Icon presentation supplied by the global panel row. */\nexport interface SidebarPanelIconOwnerProps {\n  /** Requested square edge in pixels. */\n  size: number\n  /** Whether this panel is selected in the main column. */\n  active: boolean\n}"],
  declaredBy: "an entry in 'sidebar' (client-ui-sidebar), so it exists while that entry is mounted",
  occupants: ["client-ui-plugin-manager PluginsPanelIcon", "client-ui-schedule TaskManagerIcon"],
  replaceRisk: "none",
  example: "return {\n  inject: ['slots'],\n  apply(ctx) {\n    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(\n      { name: 'sidebar.panellist', id: 'my-entry', order: 100, label: 'My entry' },\n      () => React.createElement('div', null, 'hello'),\n    ))\n  },\n}",
  source: "packages/client/ui-sidebar/src/client/contract/slots.ts:36"
}
```

`asar:dsh-cordis-client-runner/lib/client.js:4758`（`main` 条目）：

```js
{
  key: "main",
  kind: "keyed",
  scope: "root",
  summary: "Central panel selected by sidebar entry id.",
  doc: "Central panel selected by sidebar entry id. The reserved `conversation`\nkey hosts the Conversation; other keys receive no Session binding.",
  registerOptions: [{
    name: "key", requirement: "required", type: "string",
    doc: "Your cell key: the entry renders where the owner dispatches this exact key. Registering an already-occupied key replaces that occupant."
  }],
  ownerProps: [],
  declaredBy: "an entry in 'root' (client-ui-layout), so it exists while that entry is mounted",
  occupants: [
    "client-ui-conversation ConversationPanel key 'conversation'",
    "client-ui-plugin-manager PluginManagerPage",
    "client-ui-schedule TaskManagerPage"
  ],
  replaceRisk: "shadows-shipped-ui"
}
```

**关键点：**
- `sidebar.panellist` 是 **list** 型 → 必须 `id`，可有 `order` / `label`。
- `main` 是 **keyed** 型 → 必须 `key`，**没有** `id` / `order` / `label`。
- `main` 的 `replaceRisk` 是 `shadows-shipped-ui` —— 别用 `conversation` 这个 key。

### 4.2 list 型注册（带 id / order / label / locale）—— 逐字原文

`asar:dsh-client-ui-schedule/lib/client.js:19387-19393`：

```js
yield ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 10,
    locale: MANAGER_NS,
    label: () => t("panel")
}, TaskManagerIcon));
```

`asar:dsh-client-ui-plugin-manager/lib/client.js:7820-7826`：

```js
yield ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 0,
    label: () => t("panel"),
    locale: NS
}, PluginsPanelIcon));
```

两者常量（`plugin-manager:7680`、`schedule:19196`）：

```js
const NS = "pluginManager";     // 或 MANAGER_NS
const PANEL_ID = "plugins";     // schedule: const PANEL_ID = "schedules";
```

### 4.3 keyed 型注册（`main`）—— 逐字原文

`asar:dsh-client-ui-schedule/lib/client.js:19360-19386`：

```js
yield ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: MANAGER_NS,
    store: createEditorStore(),
    inject: () => ({
        ...detail,
        onNewTask: () => { ... },
        ...
    })
}, TaskManagerPage));
```

`asar:dsh-client-ui-plugin-manager/lib/client.js:7744-7760`（`main` 还**声明子 slot**）：

```js
yield ctx.slots.inject("main", function* () {
    const handle = createNavigationStore(), instance = handle.create();
    const store = {
        ...handle,
        create: () => instance
    };
    yield ctx.slots.register({
        name: "main",
        key: PANEL_ID,
        locale: NS,
        store,
        inject: () => ({
            ...face,
            createHeaderRef: createPluginHeaderRef
        }),
        children: {
            "plugins.add.actions":  { kind: "list",  scope: "root" },
            "plugins.tab":          { kind: "list",  scope: "root" },
            "plugins.item":         { kind: "list",  scope: "root" },
            "plugins.bundle.activation": { kind: "keyed", scope: "root" },
            ...
        }
    }, PluginManagerPage);
    ...
});
```

### 4.4 两者的 key 必须满足什么关系

**`sidebar.panellist.id` 必须 === `main.key`。** 这是硬约束，不是约定。

链路：

1. 侧栏按 `id` 派发（`asar:dsh-client-ui-sidebar/lib/client.js:206-231`，`PanelRow`）：

```js
function PanelRow({ id, label, wide, usePanelInfo, selectPanel, trackEntryClick, renderSlot }) {
    const active = usePanelInfo((info) => info.activePanelId === id);
    ...
    onClick: () => {
        const entry = officialEntry(id);
        ...
        selectPanel(id);          // ← 传的就是 panellist 条目的 id
    },
    ...
    children: renderSlot("sidebar.panellist", {
        size: wide ? 16 : 18,
        active
    }, { only: id })               // ← 按 id 取图标
}
```

2. `selectPanel` 落到 layout，`main` 按 key 派发（`asar:dsh-client-ui-layout/lib/client.js:121-129`）：

```js
/** Subscribe to the main key without subscribing the column frame to each panel id. */
function MainPanel({ usePanelInfo, renderSlot }) {
    const panelId = usePanelInfo((info) => info.activePanelId);
    return (0, react_jsx_runtime.jsx)("div", {
        className: AppFrame_module_css_default.mainPanel,
        "data-global-panel": panelId !== null || void 0,
        children: renderSlot("main", {}, { entryKey: panelId ?? "conversation" })
    });
}
```

3. `selectPanel` 会**校验**（`asar:dsh-client-ui-layout/lib/client.js:522-526`）：

```js
selectPanel(panelId) {
    if (panelId !== null && !this.hasMainPanel(panelId)) throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
    this.navigation.abort();
    this.panels.selectPanel(panelId);
}
```

而 `hasMainPanel` 正是查 `main` 槽的 key（同文件 699 行）：

```js
new LayoutController(instance.actions, (id) => ctx.slots.entries("main").some((entry) => entry.options.key === id), {...})
```

**所以 id ≠ key 的后果是：点击侧栏图标 → 抛 `layout.selectPanel: main panel "xxx" is not registered`，页面切不过去。**

`main` 的 `keyDomain` 也明确写了这一点（候选目录原文）：

```
keyDomain: "open: any string the owner dispatches (no compile-time key set), already taken: conversation"
```

### 4.5 `slots.inject` 回调：generator 还是普通函数？

**两种都对，语义不同。** 不是"哪个正确"的问题。

#### 机制依据

`slots.inject` 的实现（`asar:dsh-client-ui-renderer/lib/client.js:1368-1427`），关键是这一行：

```js
const disposeEffect = ctx.effect(callback, `slots.inject(${JSON.stringify(key)}): declaration`);
```

**回调被原样交给 `ctx.effect(...)`。** 所以回调的返回值规则 = cordis effect 的返回值规则。

cordis effect 的返回值处理（`asar:cordis/lib/index.js:429-462`，`_execute`）：

```js
const safeCollect = (dispose) => {
    if (typeof dispose === "function") runner.collect(dispose);
    else if (!isNullable(dispose)) throw new TypeError("Invalid effect");
};
const effect = runner.execute.call(this);
if (typeof effect === "function") return runner.collect(effect);
else if (isNullable(effect)) {} else if (!isObject(effect)) throw new TypeError("Invalid effect");
else if ("then" in effect) return effect.then(safeCollect);
else if (Symbol.iterator in effect) {
    info.error = new Error();
    const iter = effect[Symbol.iterator]();
    while (true) {
        const result = iter.next();
        safeCollect(result.value);
        if (result.done) return;
    }
} else if (Symbol.asyncIterator in effect) { ... }
else throw new TypeError("Invalid effect");
```

#### 语义对照

| 回调形态 | 行为 | 适用 |
|---|---|---|
| `() => ctx.slots.register(...)` | 返回 1 个 disposer，被收集 | **只注册 1 项**（最常见） |
| `function* () { yield reg1; yield reg2; }` | 迭代器，**每个 yield 的 disposer 都被收集**，逆序释放 | **在一个"声明就绪"事务里注册多项** |
| `() => [reg1, reg2]` | 同上（数组也是 iterable） | 等价于 generator，但不能有副作用穿插 |
| `() => { ... }`（无 return） | 返回 `undefined` → `isNullable` → 不收集任何东西 | **危险**：注册项泄漏，声明折叠后不撤销 |

**⚠️ 最需要强调的一点：`ctx.slots.register(...)` 自己已经包了一层 effect。**

`asar:dsh-client-ui-renderer/lib/client.js:1813-1819`：

```js
SlotRegistry.prototype.register = function register(rawOptions, component) {
    const options = rawOptions;
    return this.ctx.effect(() => this["_register"](options, component), "slots.register()");
};
SlotRegistry.prototype.registerFactory = function registerFactory(rawOptions, component) {
    const options = rawOptions;
    return this.ctx.effect(() => this["_registerFactory"](options, component), "slots.registerFactory()");
};
```

而 `this.ctx` 在 `slots.inject` 的回调里是**调用方的 ctx**（cordis 服务调用时 receiver 是调用者，见 `dsh-cordis-client-runner/lib/client.js:386-400` 的注释）：

> Forward service methods with the traced service as receiver — `this.ctx` inside prototype methods (slots.register) must stay the CALLER's ctx so effects land on the calling plugin's fiber

**所以即使你用 `() => ctx.slots.register(...)` 而不 yield，disposer 也已经挂在你自己的 fiber 上了 —— 插件卸载会清干净。** 区别只在"声明折叠/恢复"这一层：

- `inject` 的 effect 在**声明消失时被 dispose、恢复时重跑**（`reconcile()`，renderer:1384-1399）：

```js
const reconcile = () => {
    if (stopped) return;
    const spec = this._core.specDynamic(key);
    const epoch = this._core.declarationEpoch(key);
    if (active !== void 0 && activeEpoch === epoch) return;
    const dispose = active;
    active = void 0;
    activeEpoch = void 0;
    dispose?.();
    if (spec === void 0) return;
    const disposeEffect = ctx.effect(callback, `slots.inject(${JSON.stringify(key)}): declaration`);
    active = () => { disposeEffect(); };
    activeEpoch = epoch;
};
```

- 这个 `disposeEffect()` 会把 **yield 出去的那些**都清掉。而直接 `return` 的那个 disposer 同样会被清掉（`typeof effect === "function" → runner.collect`）。**两种都正确。**
- 唯一的失败形态是**不返回也不 yield**：`_register` 的 effect 挂在调用方 fiber 上，声明折叠时**不会**被撤销 → 变成"声明没了的孤儿注册"。

#### 官方用法统计

- 单条注册 → `() => ctx.slots.register(...)`：jobs、entry-customization、schedule 的大部分（`ctx.slots.inject("...", () => ctx.slots.register(...))`）
- 多条合成一个事务 → `function* () { yield ... }`：conversation、plugin-manager、schedule 的部分

`asar:dsh-client-ui-conversation/lib/client.js:22576-22588`（单 inject 注册 2 项）：

```js
slots.inject("conversation.user.text.node", function* () {
    yield slots.register({
        name: "conversation.user.text.node",
        key: "text",
        priority: 100
    }, PlainUserText);
    yield slots.register({
        name: "conversation.user.text.node",
        key: "session",
        priority: 100
    }, SessionReference);
});
```

`asar:dsh-client-ui-conversation/lib/client.js:23102-23112`（单 inject 注册 6 项）：

```js
slots.inject("main", function* () {
    yield slots.register({
        name: "main",
        key: "conversation",
        children: { "main.conversation": {
            kind: "single",
            scope: "session-maybe"
        } }
    }, ConversationPanel);
    yield registerConversationRoot();
    yield registerConversationContent();
    yield registerConversationSession();
    yield registerHeader();
    yield registerSessionHeader();
    yield registerComposerBar();
});
```

**推荐判据：1 项用箭头函数；≥2 项且都要跟随同一个声明生命周期，用 `function* () { yield ... }`。**

#### 另一个常见错误

`ctx.slots.register` 的组件参数是**组件本身**，不是 `<Component/>` 元素。写成 `() => React.createElement(X, null)` 虽然类型上能过（函数组件），但会丢掉 owner props / inject / t 的注入 —— 因为 renderer 是拿它当函数组件渲染的。

### 4.6 `register` 选项全集（`SlotCore.register`，`index-BgUyXZcc.js` 第 123 行内）

```js
const l = {
  component: t,
  options: {
    ...e.key !== void 0 ? { key: e.key } : {},
    ...e.id !== void 0 ? { id: e.id } : {},
    ...e.order !== void 0 ? { order: e.order } : {},
    ...e.label !== void 0 ? { label: e.label } : {},
    ...e.priority !== void 0 ? { priority: e.priority } : {}
  },
  ...e.select !== void 0 ? { select: e.select } : {},
  ...e.inject !== void 0 ? { inject: e.inject } : {},
  ...e.children !== void 0 ? { children: e.children } : {},
  ...e.store !== void 0 ? { store: e.store } : {},
  ...e.locale !== void 0 ? { locale: e.locale } : {},
  ...e.registrant !== void 0 ? { registrant: e.registrant } : {}
};
```

排序规则（同处）：

```js
if (u.sort(i.kind === "list"
    ? (f, h) => (f.options.priority ?? 0) - (h.options.priority ?? 0) || (f.options.order ?? 0) - (h.options.order ?? 0)
    : (f, h) => (f.options.priority ?? 0) - (h.options.priority ?? 0)), ...
```

**list：`priority` 升序 → `order` 升序；keyed/single：只有 `priority`（越低越先渲染，可用于覆盖）。**

`priority` 冲突处理（keyed 例）：

```js
case "keyed": {
    if (e.key === void 0) throw new Error(`keyed slot "${e.name}" requires options.key`);
    const f = r.entries.find(h => h.options.key === e.key && (h.options.priority ?? 0) === n);
    if (f) throw new Error(`keyed slot "${e.name}" already has an entry for key "${e.key}" ...`);
    break
}
```

→ **同 key 同 priority 会抛错；同 key 低 priority 会覆盖（这就是"替换官方 UI"的机制）。**

---

## 5. 样式方案

### 5.1 `styles.insert(css)` 真实存在吗？

**存在，但只存在于 `cordis-client-runner` 的动态闭包 lane，不存在于 `factory(require)` lane。**

证据一 —— 实现（`asar:dsh-cordis-client-runner/lib/client.js:227-261`）：

```js
/** Per-package style-tag bookkeeping behind the `styles.insert` symbol. */
var DynamicCordisStyles = class {
    pluginId;
    tags = new Set();
    constructor(pluginId) { this.pluginId = pluginId; }
    /**
    * Inject one stylesheet, removed automatically on package unload.
    * @param css - raw CSS text.
    * @returns disposer removing this one tag early.
    */
    insert(css) {
        if (typeof css !== "string") throw new Error("styles.insert(css) needs a CSS string");
        const tag = document.createElement("style");
        tag.dataset.dyn = this.pluginId;
        tag.textContent = css;
        document.head.append(tag);
        this.tags.add(tag);
        return () => { this.tags.delete(tag); tag.remove(); };
    }
    get count() { return this.tags.size; }
    dispose() { for (const tag of this.tags) tag.remove(); this.tags.clear(); }
};
```

证据二 —— 它是**闭包参数**，不是 ctx 服务（`asar:dsh-cordis-client-runner/lib/client.js:308-337`）：

```js
async function evaluateClientHalf(pluginId, clientCode, env, styles) {
    const traps = closureTraps();
    const parameters = [
        "React",
        "console",
        "styles",
        "host",
        "harness",
        ...Object.keys(traps),
        "process",
        "Buffer"
    ];
    let closure;
    try {
        closure = new Function(...parameters, `return (async () => {\n${clientCode}\n})()`);
    } catch (error) { ... }
    const returned = await closure(react, taggedConsole(...), styles, { call: ... }, harnessTrap(), ...);
```

证据三 —— 它自己的 builtin 目录（`asar:dsh-cordis-client-runner/lib/client.js:7609-7613`）：

```js
{
    name: "styles",
    description: "Package-owned stylesheet insertion cleaned up with the Client run.",
    signatures: ["styles.insert(css: string): () => void"]
}
```

**证据四（决定性）—— `factory(require)` 的 factory 只有一个参数。**（`asar:dsh-client-modules/lib/client.js:819`）

```js
exports: registered.factory(this.makeRequire(ownerId, edges)),
```

`makeRequire` 的返回值只有三个成员（同文件 834-852）：`require` 本身、`require.asset`、`require.async`。**没有 `styles`。**

全仓 grep `styles.insert` 只命中 2 个文件：`dsh-client-ui-workspace/README.md`（讲的是 runner lane）和 `dsh-cordis-client-runner/lib/client.js`（实现）。**没有任何官方 UI 包调用过它。**

> 你现有 `plugins/memory-neuron/client.js` 头部注释里写的"实测该 builtin 在本部署不可用，调用后整包客户端模块静默失活"是**正确结论**，原因就是上面第 4 条：`styles` 未定义 → factory 抛 `ReferenceError` → materialize 失败 → 整个包白掉。

### 5.2 官方推荐的做法（两条）

#### 方案 A：预设编译产物形态 —— 模块顶层注入 `<style>`

**这是所有官方 UI 包的实际做法**（jobs / schedule / plugin-manager / sidebar / conversation … 100% 一致）。

逐字原文（`asar:dsh-client-ui-jobs/lib/client.js:11-20`）：

```js
//#region \0dsh-css:D:\ci\runners\github\_work\deepseek-harness\deepseek-harness\packages\client\ui-jobs\src\client\JobListAction.module.css.mjs
const css = ".Ag-ohG_trigger{border-radius:var(--dsw-radius-sm);...}";
const tagId = "@deepseek-ai/dsh-client-ui-jobs/JobListAction.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-jobs";
    tag.dataset.pluginCss = tagId;
    tag.textContent = css;
    document.head.appendChild(tag);
}
//#endregion
```

第三方插件同形态（`browser-skill-dsh-plugin/lib/client.cjs:36-43`）：

```js
const tagId$4 = "@wxg-prc-cpg/browser-skill-dsh-plugin/bsk-tokens.nomodule.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@wxg-prc-cpg/browser-skill-dsh-plugin";
    tag.dataset.pluginCss = tagId$4;
    tag.textContent = css$4;
    document.head.appendChild(tag);
}
```

**为什么这套能自动清理：** 模块系统在 materialize 前后做 style 认领（`asar:dsh-client-modules/lib/client.js:617-631`）：

```js
/** Untagged <style> elements present before a factory runs; the factory must not claim them. */
const untaggedStyles = () => typeof document === "undefined" ? new Set() : new Set(document.querySelectorAll("style:not([data-plugin])"));
/**
* Claim and inventory the <style> tags a factory injected during
* materialization: preset-emitted tags arrive pre-tagged with data-plugin;
* an untagged tag that was absent from `before` is claimed for the
* materializing plugin (HMR bookkeeping).
*/
const claimStyles = (id, before) => {
    if (typeof document === "undefined") return [];
    for (const el of untaggedStyles()) if (!before.has(el)) el.setAttribute("data-plugin", id);
    const owned = [];
    for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) owned.push(el.getAttribute("data-plugin-css") ?? id);
    return owned;
};
```

卸载时（`client.js:308-315`）：

```js
/**
* Remove styles after their plugin's effect cleanup has settled.
* @param id - Package whose factory owns the style tags.
*/
function removeOwnedStyles(id) {
    if (typeof document === "undefined") return;
    for (const el of document.querySelectorAll("style[data-plugin]")) if (el.getAttribute("data-plugin") === id) el.remove();
}
```

**三个要点：**
1. `data-plugin` 必须存在（预设会自动打，手写要自己打），值必须是**包名**（与 `__ModuleLoader__.load({id})` 一致），否则 HMR/卸载找不到。
2. `data-plugin-css` 作为去重 key（同名 tag 只插一次）。
3. 必须在**模块顶层**（factory 闭包里），不能在组件里 —— 这样 `before`/`after` 快照才能认领。

#### 方案 B：组件内渲染 `<style>` 元素（官方文档推荐给手写插件）

`asar:dsh-agent-preset/skills/cordis-plugin-development/references/ui-plugin.md:13`：

> Keep factories free of side effects. Register styles, timers, listeners and other resources inside `apply` with `ctx.effect`/`ctx.on` and return their cleanup functions. **Component-local styles can render as React elements so unmounting removes them.**

即：

```js
function MyPanel() {
  return React.createElement('div', { className: 'mnp-root' }, [
    React.createElement('style', { key: 'css' }, CSS),
    /* ... */
  ]);
}
```

**取舍：**
- 方案 B 不需要 `document.head`，不需要 `data-plugin` 约定，卸载天然清理；但样式在**组件挂载后**才生效（首次渲染可能闪一下未样式化），且无法给 portaled 内容（`Modal`/`Menu` 的 `portal: true` 会挂到 `document.body`）用 className 命中…… 其实能命中，因为 CSS 是全局的，只要 tag 还在 DOM 里。
- 方案 A 样式在模块加载时就位，无 FOUC，但需要 `data-plugin` 标注才能被自动清理。

**给"手写 client.js 插件"的建议：A 为主（无闪烁、无泄漏风险），B 作为局部补充。**

### 5.3 主题 token（真实存在的 `--dsw-alias-*`）

从 `asar:dsh-web-frontend/dist/assets/index-lh_YM6sT.css` 提取的**全部 56 个** `--dsw-alias-*`：

```
--dsw-alias-bg-base            --dsw-alias-bg-layer-1        --dsw-alias-bg-layer-2
--dsw-alias-bg-layer-3         --dsw-alias-bg-layer-4        --dsw-alias-bg-mask-1
--dsw-alias-bg-module-platform --dsw-alias-bg-skeleton        --dsw-alias-border-l1
--dsw-alias-border-l2          --dsw-alias-border-l2-darkmode-thin  --dsw-alias-border-l3
--dsw-alias-border-l4          --dsw-alias-brand-primary     --dsw-alias-button-ghost-active-border
--dsw-alias-button-ghost-active-fill  --dsw-alias-button-primary-fill  --dsw-alias-button-primary-hover
--dsw-alias-button-tool-bar-fill      --dsw-alias-button-tool-bar-hover --dsw-alias-code-diff-added
--dsw-alias-code-diff-deleted  --dsw-alias-interactive-bg-active    --dsw-alias-interactive-bg-hover
--dsw-alias-interactive-bg-hover-danger --dsw-alias-label-caption   --dsw-alias-label-dimmed
--dsw-alias-label-error        --dsw-alias-label-primary      --dsw-alias-label-primary-foreground
--dsw-alias-label-secondary    --dsw-alias-label-shimmer      --dsw-alias-label-tertiary
--dsw-alias-link               --dsw-alias-markdown-code-block --dsw-alias-markdown-code-block-banner
--dsw-alias-markdown-inline-code  --dsw-alias-markdown-tag    --dsw-alias-menu-group-header-fill
--dsw-alias-menu-icon          --dsw-alias-scrollbar-bg-l2    --dsw-alias-scrollbar-hover-l2
--dsw-alias-state-business-primary  --dsw-alias-state-error-primary  --dsw-alias-state-idle-primary
--dsw-alias-state-success-primary   --dsw-alias-state-success-tertiary --dsw-alias-state-warn-label
--dsw-alias-state-warn-primary --dsw-alias-state-warn-tertiary --dsw-alias-switch-thumb
--dsw-alias-toast-bg           --dsw-alias-toast-label       --dsw-alias-tooltip-bg
--dsw-alias-tooltip-key-bg
```

另有 `--dsw-radius-xs/sm/md/lg/xl/panel`、`--dsw-font-mono`、`--dsw-elevation-*`、`--dsw-specific-*`（如 `--dsw-specific-menu`、`--dsw-specific-sidebar-fill`）。

> ⚠️ 注意 `--dsw-alias-label-error` 存在，但**不存在** `--dsw-alias-label-warn`；warn 用 `--dsw-alias-state-warn-label`。

---

## 6. locale 集成

### 6.1 `register` 的三种签名与实现

`asar:dsh-client-locale/lib/client.js:1675-1700`：

```js
register(ns, localeOrDicts, dict) {
    const pairs = typeof localeOrDicts === "string" ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
    for (const [locale] of pairs) if (!LOCALE_ID_PATTERN.test(locale)) throw new Error(`locale id "${locale}" is not a BCP 47-style tag`);
    let locales = this.dicts.get(ns);
    if (!locales) {
        locales = new Map();
        this.dicts.set(ns, locales);
    }
    for (const [locale] of pairs) if (locales.has(localeKey(locale))) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
    for (const [locale, entries] of pairs) locales.set(localeKey(locale), entries);
    this.publish(this.snapshot.active, false);
    return () => {
        const owner = this.dicts.get(ns);
        if (!owner) return;
        let removed = false;
        for (const [locale, entries] of pairs) {
            const key = localeKey(locale);
            if (owner.get(key) === entries) {
                owner.delete(key);
                removed = true;
            }
        }
        if (removed) this.publish(this.snapshot.active, false);
    };
}
```

两种调用形态：
- `ctx.locale.register(ns, { zh, en, ja, ... })` —— 一次给全（**官方 UI 包用这个**）
- `ctx.locale.register(ns, 'it', { ... })` —— 单语言（语言包用这个）

**必须同时给 `zh` 和 `en`**（`asar:dsh-client-locale/README.md:40`）：

> Call `ctx.locale.register(ns, { zh, en, ja })` with a namespace merged into `LocaleNamespaceMap`; the compiler checks every key against the namespace's typed key union and requires both baseline locales (`zh` and `en`). Additional locale ids are optional...

> 注意：这是**编译期**约束（`LocaleNamespaceMap` 是 TS 类型）。手写纯 JS 的 client.js 没有类型检查，runtime 只校验 locale id 格式，**不校验 zh/en 齐全**。但缺 `en` 会导致英文界面回落到 key（`translate` 的 `?? key` 兜底）。

### 6.2 完整用法（照抄官方）

`asar:dsh-client-ui-jobs/lib/client.js:869-899`：

```js
//#region lib/types/client/index.js
/** Required services: the jobs rosters, observations, and kill, the slot registry, and dictionaries. */
const inject = [
    "jobs",
    "slots",
    "locale"
];
/**
* Client plugin body: register the dictionaries and the header action.
* @param ctx - client root context.
*/
function apply(ctx) {
    ctx.effect(() => ctx.locale.register("job", {
        zh,
        en,
        ja,
        es,
        fr,
        de,
        ru,
        pt
    }), "ui-jobs: dictionaries");
    ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "job-list",
        order: 20,
        locale: "job",
        inject: () => ({
            hooks: { jobs: ctx.jobs.state },
            watchRows: (sessionId) => ctx.jobs.watchRows(sessionId),
            observe: (sessionId, id) => ctx.jobs.observe(sessionId, id),
            killJob: async (sessionId, jobId) => (await ctx.jobs.kill(sessionId, jobId)).ok
        })
    }, JobListAction));
}
//#endregion
```

`asar:dsh-client-ui-schedule/lib/client.js:19233-19247`（两个命名空间）：

```js
function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, {
        zh: zh$1,
        en: en$1,
        ja: ja$1,
        es: es$1,
        fr: fr$1,
        de: de$1,
        ru: ru$1,
        pt: pt$1
    }), "ui-schedule: dictionaries");
    const managerDictionaries = {
        zh,
        en,
        ja,
        es,
        fr,
        de,
        ru,
        pt
    };
    ctx.effect(() => ctx.locale.register(MANAGER_NS, managerDictionaries), "ui-schedule: manager dictionaries");
    const t = ctx.locale.bind(MANAGER_NS);
    ...
```

`asar:dsh-client-ui-plugin-manager/lib/client.js:7700-7710`：

```js
ctx.effect(() => ctx.locale.register(NS, {
    zh,
    en,
    ja,
    es,
    fr,
    de,
    ru,
    pt
}), "ui-plugin-manager: dictionaries");
const t = ctx.locale.bind(NS);
```

**关键：`register` 返回 disposer，必须交给 `ctx.effect(...)`。不包 effect 直接调用 → 插件卸载后字典残留，重载时同一 locale id 会抛 `locale namespace "x" already has locale "zh"`。**

### 6.3 `bind` 与 `translate`

`asar:dsh-client-locale/lib/client.js:1702-1723`：

```js
bind(ns) {
    let t = this.bound.get(ns);
    if (!t) {
        t = (key, params) => this.translate(ns, key, params);
        this.bound.set(ns, t);
        return t;
    }
    return t;
}
translate(ns, key, params) {
    const chain = this.fallbackChain(this.snapshot.active);
    const template = this.lookup(ns, key, chain) ?? (ns !== "common" ? this.lookup("common", key, chain) : void 0) ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
}
lookup(ns, key, chain) {
    const locales = this.dicts.get(ns);
    for (const locale of chain) {
        const value = locales?.get(localeKey(locale))?.[key];
        if (value !== void 0) return value;
    }
}
```

要点：
- `bind(ns)` 返回的引用**同一命名空间内稳定** → 可以放心闭包进 `inject`、不会破坏 memo。
- 占位符语法是 **`{name}`**（`/\{(\w+)\}/g`），参数缺失时保留原样。
- 查找链：本 ns 的 fallback chain → `common` 的 fallback chain → **key 本身**。
- 所以"没翻译"表现为**界面上出现 key 字符串**。

### 6.4 `label: () => t('panel')` 是怎么实现的

三步链路，全部真实可查：

**(1) 注册项声明 `locale: NS`，组件会拿到 `t` prop。**

`asar:dsh-client-ui-renderer/lib/client.js:741-745`：

```js
if (entry.locale !== void 0) {
    const face = host.locale;
    if (face === void 0) throw new SlotAssemblyError(`entry declares locale namespace '${entry.locale}' but no locale face is installed (locale plugin missing from the composition?)`);
    kit["t"] = localeSeat(face, entry.locale);
}
```

`localeSeat` 会按 `revision` 缓存（同文件 542-557）：

```js
const localeSeatCache = new WeakMap();
function localeSeat(face, ns) {
    let perNs = localeSeatCache.get(face);
    if (!perNs) { perNs = new Map(); localeSeatCache.set(face, perNs); }
    const revision = face.getSnapshot().revision;
    const cached = perNs.get(ns);
    if (cached && cached.revision === revision) return cached.t;
    const bound = face.bind(ns);
    const t = (key, params) => bound(key, params);
    perNs.set(ns, { revision, t });
    return t;
}
```

→ **语言切换时 revision 变化 = 新的 `t` 引用 = `React.memo` 组件因浅比较不相等而重渲染。** 这是它"语言一换 UI 就跟着换"的机制。

**(2) `label` 是 thunk，owner 每次投影都会调用它。**

`resolveSlotLabel`（`index-BgUyXZcc.js`，`const MI=Object.freeze(...)` 前的 `function EI`）：

```js
function EI(e){return typeof e=="function"?e():e}
```

侧栏的投影逻辑（`asar:dsh-client-ui-sidebar/lib/client.js:688-706`）：

```js
const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => {
    const id = options.id;
    return {
        id,
        order: options.order ?? 0,
        label: (0, _deepseek_ai_dsh_client_ui_slots.resolveSlotLabel)(options.label) ?? id
    };
}).sort((a, b) => a.order - b.order);
const previous = panels.getSnapshot();
if (previous.length === next.length && previous.every((panel, index) => {
    const candidate = next[index];
    return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label;
})) return;
panels.set(next);
};
ctx.effect(() => ctx.slots.subscribe("sidebar.panellist", syncPanels), "ui-sidebar: panel entries");
ctx.effect(() => ctx.locale.subscribe(syncPanels), "ui-sidebar: panel labels");
```

注意最后一行：**`ctx.locale.subscribe(syncPanels)`** —— 语言一变就重新投影并重算 label。

**(3) 所以 `label: () => t('panel')` 中，`t` 必须是"每次调用都读当前 locale"的函数。**

- `ctx.locale.bind(NS)` ✅ 满足（内部 `this.translate` 每次读 `this.snapshot.active`）
- 在 `apply` 时**把翻译结果存成字符串** ❌ 不满足（`label: t('panel')` 会永远是注册时的语言）
- 唯一例外：`label: 'my-entry'`（字面量）不随语言变 —— 见 `dsh-cordis-client-runner` 的 example

---

## 7. 可直接复制的完整 `client.js` 骨架

见同目录 `skeleton-client.js`（已 `node --check` 通过）。

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-my-panel',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 可选依赖：取不到就回落，保证不白屏
    let P = null;
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (_error) {
      P = null;
    }

    // 主面板 key 与侧栏 list id 必须是同一个字符串
    const NS = 'myPanel';
    const PANEL_ID = 'my-panel';

    // zh 与 en 必须同时提供（编译期约束；runtime 缺 en 会回落到 key）
    const zh = { 'panel': '我的面板', 'title': '我的面板', 'empty': '还没有内容。', 'refresh': '刷新' };
    const en = { 'panel': 'My panel', 'title': 'My panel', 'empty': 'Nothing here yet.', 'refresh': 'Refresh' };

    // 方案 A：模块顶层注入 <style>，data-plugin 让 HMR/卸载能清理
    const CSS = `
.mnp-root{position:absolute;inset:0;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.55;overflow:hidden;}
.mnp-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;
  padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);}
.mnp-title{font-weight:600;font-size:14px;}
.mnp-grow{flex:1 1 auto;}
.mnp-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;}
.mnp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.mnp-body{flex:1 1 auto;overflow:auto;padding:16px 18px;}
.mnp-empty{color:var(--dsw-alias-label-secondary);}
`;
    if (typeof document !== 'undefined' &&
        document.querySelector('style[data-plugin-css="my-panel"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = '@local/dsh-my-panel';   // 必须等于 load({ id })
      tag.dataset.pluginCss = 'my-panel';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // 图标：只接 { size, className }；取不到 primitives 就自绘
    function PanelIcon(props) {
      const size = (props && props.size) || 16;
      const Prim = P && P.IconWorkspaceTreeOutlineRegular;
      if (Prim) return h(Prim, { size: size });
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.2,
        strokeLinecap: 'round', 'aria-hidden': 'true',
        style: { display: 'block' },
      }, [
        h('rect', { key: 'a', x: 1.8, y: 1.8, width: 5, height: 4, rx: 1 }),
        h('rect', { key: 'b', x: 1.8, y: 10.2, width: 5, height: 4, rx: 1 }),
        h('rect', { key: 'c', x: 9.2, y: 6, width: 5, height: 4, rx: 1 }),
        h('path', { key: 'd', d: 'M6.8 3.8h1.2v10.4H6.8z' }),
      ]);
    }

    // 注册项声明了 locale: NS，所以这里能拿到 t
    function MyPanel({ t }) {
      const [count, setCount] = React.useState(0);
      return h('div', { className: 'mnp-root' }, [
        h('div', { key: 'head', className: 'mnp-head' }, [
          h('span', { key: 't', className: 'mnp-title' }, t('title')),
          h('span', { key: 'g', className: 'mnp-grow' }),
          h('button', {
            key: 'b', type: 'button', className: 'mnp-btn',
            onClick: () => setCount((n) => n + 1),
          }, t('refresh') + ' (' + String(count) + ')'),
        ]),
        h('div', { key: 'body', className: 'mnp-body' },
          count === 0
            ? h('div', { className: 'mnp-empty' }, t('empty'))
            : h('div', null, 'clicks: ' + String(count))),
      ]);
    }

    return {
      // 这里是 Client Service 名，不是包名
      inject: ['slots', 'locale'],

      apply(ctx) {
        // 1) 字典必须包在 ctx.effect 里（拿 disposer）
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'my-panel: dictionaries');

        // 2) bind 返回稳定引用，可安全闭包
        const t = ctx.locale.bind(NS);

        // 3) 侧栏入口（list 型）
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 100,
            label: () => t('panel'),
            locale: NS,
          }, PanelIcon));

        // 4) 主面板（keyed 型）：key === 上面的 id
        ctx.slots.inject('main', () =>
          ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          }, MyPanel));
      },
    };
  },
});
```

### 7.1 配套 `package.json`

```json
{
  "name": "@local/dsh-my-panel",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ]
    }
  }
}
```

### 7.2 骨架里的"必查清单"（踩坑点）

| # | 检查项 | 错了会怎样 |
|---|---|---|
| 1 | `load({ id })` 的 id === `package.json` 的 `name` | 模块系统按 graph row id 匹配，不匹配 → `loaded without registering "<id>"` |
| 2 | `tag.dataset.plugin` === 同一个 id | 卸载/HMR 清不掉样式 |
| 3 | `sidebar.panellist.id` === `main.key` | 点图标抛 `layout.selectPanel: main panel "x" is not registered` |
| 4 | `main` 的 key 不能是 `conversation` | 覆盖官方会话面板 |
| 5 | list 型必须有 `id`，keyed 型必须有 `key` | `slot "<name>" requires options.id/key` |
| 6 | `ctx.locale.register` 必须包 `ctx.effect` | 热重载抛 `already has locale "zh"` |
| 7 | `label` 用 `() => t('k')` 而非 `t('k')` | 语言切换后标签不变 |
| 8 | 组件传**组件引用**，不是元素 | owner props / `t` / inject 全部丢失 |
| 9 | `inject` 数组是 **Service 名**（`'slots'`/`'locale'`） | 写成包名 → 插件永不激活（service 不存在） |
| 10 | `main` 组件宽度：owner 是 `div.mainPanel` 整块，建议 `position:absolute;inset:0` | 内容塌陷/出现双滚动条 |

---

## 8. 明确"未找到"的部分

| 声称 | 结论 |
|---|---|
| `IconFocusOutlineRegular` / `IconFocusOutlineMedium` | **不存在**。全仓无 `focus-outline` 字形；`pointer` / `target` / `crosshair` / `cursor` 字形也不存在。最接近的：`IconInspectOutlineRegular`、`IconBrowseOutlineRegular`、`IconPanelLeftOutlineRegular`、`IconWorkspaceTreeOutlineRegular` |
| `styles.insert` 在 `factory(require)` lane | **不可用**。factory 只收到 `require`（`client.js:819`）；`styles` 仅是 runner lane 的闭包参数（`dsh-cordis-client-runner/lib/client.js:310-337`） |
| `ctx.styles` 服务 | **不存在**。全仓 `ctx.styles` 零命中；`CTX_VERBS` 里也没有（只有 `effect/on/once/provide/timeout/interval/setTimeout/setInterval/throttle/debounce`） |
| `@deepseek-ai/dsh-client-ui-primitives` 独立包目录 | asar 里**没有**该目录。primitives 以 `PLATFORM_MODULES` seed 形式内联在 shell bundle（`FU`），**不能**用 `Read`/`rg` 直接看它的 `src/*.tsx`，只能读 shell bundle 里的压缩产物 |
| `@deepseek-ai/dsh-client-ui-dockkit` 独立包目录 | 同上，只在 seed 表里（`WZ`，63 个导出） |
| `dsh.client` 的第 5 个字段 | **没有**。`parseDshClient` 只认 4 个；多余字段静默丢弃 |

---

## 9. 与既有产出的差异（需修正）

`D:\file\AI Temp\DeepSeek\Agent自研\plugins\memory-neuron\client.js` 的头部注释：

| 注释说法 | 实测结论 |
|---|---|
| "`require('@deepseek-ai/dsh-client-ui-primitives')` ← 必须在 `dsh.client.external` 声明" | ❌ **不需要**。primitives 在 `PLATFORM_MODULES` seed 表里，`external` 里写它会被 `if (this.seed.has(request) …) continue` 跳过。写了无害，但不是"必须" |
| "② `slots.inject` 回调：generator + yield" | ⚠️ 只说了一半。**普通函数返回 disposer 同样正确**，且是 jobs / entry-customization 的官方写法。判据是"1 项 vs 多项" |
| "③ 不用 `styles.insert`" | ✅ **正确**（原因见第 5.1 节：factory 只收到 `require`） |
| "④ 主题 token 只用 Theme.listTokens 里真实存在的 14 个" | ⚠️ 实际存在 **56 个** `--dsw-alias-*`（完整清单见 5.3）。当时 `Theme.listTokens` inspect 超时，导致清单不全 |
| "⑤ primitives 里有 100 个 Icon* 组件" | ⚠️ 实际 **194 个 `Icon*` 组件 + 8 个 `PermissionIcon*` + 4 个 `Link/ReferenceIcon*` + 3 个 `ICON_*` 常量**，共 209 个图标类导出；且 202 这个数也不对（那是把 `PermissionIcon` 算进 `Icon*` 的误计数） |
