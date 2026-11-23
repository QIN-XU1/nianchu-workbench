# 补拆：OpenBitFun —— 真跑它的治理检查

> 接 `openbitfun.md`。那份报告的诚实边界第 1 条是：
> **「未运行任何构建或测试。所有『能通过』的判断来自源码与脚本存在性，非执行结果。」**
>
> 这一轮**把它跑起来了**，并且抓到了我们自己的 49 处违规。
>
> 证据等级：[确证]　拆解时间：2026-11-15

---

## 一、跑之前的准备工作（改名）

起因：`product:identity:audit` 报 3 处违规，说仓库存着**退役产品名**。

它的判据是 `(?<!open)bitfun` —— 禁止裸 `bitfun`，允许 `OpenBitFun`。

实测被标记的是：
```
package.json:2:22                                    "@vouch/bitfun-fork"
benchmark/data/projects.json:14:25                   "D:/refs/bitfun2/OpenBitFun-main"
benchmark/data/projects.json:17:40                   "我们前端基座：已 fork 进 apps/bitfun-web"
```

**这三处说明了一件我此前没意识到的事**：我们 fork 了 OpenBitFun，却把它的名字留在了自己的身份里 ——
包名、目录名、数据路径。用户定的产品名是「念初 / Nouch」，不是 OpenBitFun。

### 处理原则：改现实，不绕检查

| 项 | 改前 | 改后 |
|---|---|---|
| 我们的 app 目录 | `apps/bitfun-web` | **`apps/vouch-web`** |
| 包名 | `@vouch/bitfun-fork` | **`@vouch/web`** |
| 上游源目录 | `D:\refs\bitfun2` | **`D:\refs\openbitfun-src`** |
| 我的脚本 | `run-bitfun-src.mjs` / `verify-bitfun-{clone,full}.mjs` | `run-vouch-src.mjs` / `verify-fork-{clone,full}.mjs` |

共改 **14 个文件 + 3 个文件名 + 2 个目录名**。

### 顺带踩到并修掉的坑：pnpm junction 断链

`git mv apps/bitfun-web apps/vouch-web` 之后，所有 `node_modules` 链接全断：

```
node_modules\typescript  LinkType=Junction
  Target: ...\apps\bitfun-web\node_modules\.pnpm\typescript@5.8.3\node_modules\typescript
                                                    ↑ 还是旧路径，目录已不存在
```

**原因**：pnpm 在 Windows 上用 **junction**，而 junction 存的是**绝对路径**；目录一搬就全部失效。
（相对符号链接不会这样 —— 这是 Windows 特有的坑。）

**修法**：`CI=true pnpm install --prefer-offline`（不加 `CI=true` 会报
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。

**这条值得记住**：在 Windows 上搬动含 `node_modules` 的目录后，必须重跑 `pnpm install`。

### 补齐缺失的生成产物

`postinstall` 失败，因为 `assets/brand/macos/generated.json` 与 `legacy-canvas.json` 缺失
（上游有、我们 fork 时没带）。从上游拷入后通过。

---

## 二、治理检查实测结果

**这是本轮的核心。** 之前只从源码推断「这些检查存在」，现在是执行结果。

| 检查 | 结果 | 实测数字 / 详情 |
|---|---|---|
| `product:identity:audit` | ✅ **PASS** | 5600 文本文件 / 5768 仓库文件 |
| `check:repo-hygiene` | ✅ **PASS** | 5783 内容文件 / 5770 文件名 |
| `motion:audit` | ✅ 通过 | **是 inventory 不是 gate**；列 3 个文件有无限动画但无局部 reduced-motion |
| `typography:audit` | ⚠️ **50 → 1** | 修掉 49 处（**全是我们写的**），剩 1 处是结构性的 |
| `theme:color-audit:all` | ❌ FAIL | **16 个 exclusions 路径不存在** |
| `i18n:audit` | ❌ FAIL | 要 `src/apps/relay-server/static/homepage/index.html` |
| `check:core-boundaries` | ❌ FAIL | 要 `Cargo.toml`（Rust 侧） |
| `type-check:web` | ❌ 3 错 | `Cannot find module '@/generated/api'` |

### 2.1 `motion:audit` 列出的 3 个文件（不是违规，是待人工审阅）

```
src\web-ui\src\app\components\NavPanel\sections\devices\DeviceWorkspaceSections.scss:1
src\web-ui\src\features\ssh-remote\PortForwardDialog.scss:1
src\web-ui\src\tools\generative-widget\GenerativeWidgetPanel.scss:1
Duplicate global keyframe names: 0
```

脚本结尾自述：**"This command is an inventory, not a pass/fail gate."**

**判断**：这是**设计正确的**——动效是否合理需要人判断，机器只能列出候选。
它区分了「可判定的」（重复 keyframe 名）与「需人判断的」（无限动画合不合理）。
这与 luanyujia 的「判断类不该机械化」是同一条原则。

### 2.2 `typography:audit` 抓到我 49 处违规 ★最有价值

**这是「未运行构建或测试」这个缺口最直接的实证。**

首次运行结果（按文件统计）：
```
   25 处  web-ui/src/app/scenes/benchmark/BenchmarkScene.scss
   15 处  web-ui/src/app/scenes/vouch/VouchShared.scss
    9 处  web-ui/src/app/scenes/vouch/VerifyScene.scss
    1 处  crates/assembly/core/src/service/config/types.rs   ← 上游的（结构性）
   ─────
   50 处，其中 49 处是我们在写界面时留下的
```

**违规类型**（两类）：
1. `[raw-css-typography]` —— 直接用原始数值而不走 token：
   `font-size: 10px` / `10.5px` / `9.5px` / `11.5px` / `20px` / `28px`、
   `font-weight: 400` / `550` / `600` / `620`、`line-height: 1.1` / `1.4` / `1.5` / `1.6`
2. `[foundation-typography-in-semantic-consumer]` —— 在语义消费者里用 foundation token：
   `font-family: var(--openbitfun-font-family-mono)` 应当用 `--openbitfun-type-code-*-font-family`

**判据来自 `src/web-ui/AGENTS.md`**：
> "failing audits should be fixed by **reusing tokens**, merging redundant values, or adding a scoped owner contract.
> **Do not raise baseline or test expectation counts just to make a theme audit pass.**"

所以修法是**只做 token 替换，不加豁免、不提基线**。

**我先导出了真实刻度**（从 `design-tokens/dist/tokens.css` 解析出 251 个语义 token 的别名目标）：

| role | 字号 | 字重 | 行高 | 族 |
|---|---|---|---|---|
| micro | 10px | 400 | 1.32 | control |
| meta | 11px | 400 | 1.32 | control |
| support | 11px | 400 | 1.55 | control |
| label-xs | 11px | 500 | 1.2 | control |
| label-sm | 12px | 500 | 1.2 | control |
| label-md | 13px | 400 | 1.2 | control |
| label-lg | 14px | 500 | 1.2 | control |
| body-sm | 13px | 400 | 1.5 | sans |
| body-md | 14px | 400 | 1.5 | sans |
| body-lg | 15px | 400 | 1.6 | sans |
| code-sm | 12px | 400 | 1.52 | **mono** |
| code-md | 13px | 400 | 1.52 | **mono** |
| code-meta | 11px | 400 | 1.2 | **mono** |
| heading-card | 13px | 600 | 1.2 | control |
| heading-section | 15px | 600 | 1.2 | control |
| heading-panel | 18px | 600 | 1.2 | control |
| heading-page | 24px | 700 | 1.2 | control |

**然后按值映射替换**（每条都注明为什么用这个 role）：

| 原值 | 换成 | 理由 |
|---|---|---|
| `font-family: var(--openbitfun-font-family-mono)` | `var(--openbitfun-type-code-md-font-family)` | code-md 是等宽 role |
| `font-size: 9.5px` / `10px` / `10.5px` | `var(--openbitfun-type-micro-font-size)` | 落在刻度最小档(10px) |
| `font-size: 11.5px` | `var(--openbitfun-type-code-meta-font-size)` | 用在等宽块里 |
| `font-size: 20px` | `var(--openbitfun-type-heading-panel-font-size)` | → 18px，标题第二档 |
| `font-size: 28px` | `var(--openbitfun-type-heading-page-font-size)` | → 24px，页面主标题档 |
| `font-weight: 400` | `var(--openbitfun-type-body-md-font-weight)` | regular |
| `font-weight: 550` | `var(--openbitfun-type-label-lg-font-weight)` | 插值 → medium(500) |
| `font-weight: 600` | `var(--openbitfun-type-heading-section-font-weight)` | semibold |
| `font-weight: 620` | `var(--openbitfun-type-heading-page-font-weight)` | 插值 → bold(700) |
| `line-height: 1.1` / `1.15` | `var(--openbitfun-type-heading-page-line-height)` | → tight(1.2) |
| `line-height: 1.4` / `1.5` | `var(--openbitfun-type-body-md-line-height)` | base(1.5) |
| `line-height: 1.6` | `var(--openbitfun-type-body-lg-line-height)` | relaxed |

**结果：我们文件的违规 49 → 0，总违规 50 → 1。**

**判断 —— 这个缺口不补的代价**：
我们写的三个场景界面上线后，**排版不在设计系统的刻度上**。
后果是具体的：
- 字号 10px / 10.5px / 11.5px / 9.5px 四档散落，**没有一档对得上设计系统**
- 字重 550 / 620 是插值值，**在非可变字体上会 fallback**（550→最接近的 500 或 600，各浏览器行为不一致）
- 行高 1.1 / 1.4 / 1.5 / 1.6 四档，与系统的 tight/base/relaxed 三档不成对应
- 后续要统一调排版（比如紧凑模式），**改 token 改不到这些地方**

**这正是「拆解 → 发现机制 → 跑机制 → 发现自己的问题」的完整闭环。**

---

## 三、结构性发现：部分 fork 的治理代价

`typography:audit` 剩的那 1 处、`theme:color-audit` 的 16 处、`i18n:audit`、`check:core-boundaries`、
`type-check:web` —— **全部同一个根因**：

> **OpenBitFun 的治理检查假设完整 monorepo，而我们是纯前端 fork。**

### 3.1 缺了什么（实测）

上游顶层 **19 个目录，我们缺 18 个**：

| 缺的顶层目录 | 上游条目数 |
|---|---|
| `scripts` | 175 |
| `OpenBitFun-Installer` | 12 |
| `png` | 12 |
| `docs` | 11 |
| `deploy` | 6 |
| `src` | 6（含全部 Rust crates 与 apps） |
| `third_party` / `website` | 4 / 4 |
| `.github` / `patches` / `products` | 3 / 3 / 3 |
| `MiniApp` / `packages` | 2 / 2 |
| `assets` / `extensions` / `resources` / `sdk` / `tests` | 各 1 |

我们只保留了 `design-system`（9 项）+ `apps/vouch-web/` 内部的一份子集。

### 3.2 治理检查依赖但缺失的 11 个路径（实测 11/11 全缺，上游全有）

```
src/crates/assembly/core/src/service/config/types.rs          ← typography owner
src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/{src,test,dist}
src/crates/contracts/product-domains/src/miniapp/generated
src/apps/mobile/android/app/src/main/res/drawable
src/apps/mobile/ios/OpenBitFun/Resources.xcassets
src/apps/mobile/harmonyos/entry/src/main/resources/base/media
src/apps/mobile/design-system/preview/generated
src/apps/data-tools/ui/generated
src/apps/desktop/src/generated
```

`src/` 下的第二层（全部缺失）：`apps/{cli,data-tools,desktop,extension-host,miniapp-market-server,miniapp-shell,mobile,relay-server,sdk-host,server}`、
`crates/{adapters,assembly,contracts,execution,...}`

### 3.3 `@/generated/api` 是种类生成物，且**纯类型**

`type-check:web` 的 3 个错误全是 `Cannot find module '@/generated/api'`。

**关键验证**：这 3 处**全部是 type-only 导入**：
- `websocket-adapter.ts:14` → `import type {`（L35 结束）
- `ConfigAPI.ts:23` → `import type {`（L26 结束）
- `ConfigAPI.ts:28` → `export type { ... } from '@/generated/api'`

全仓仅 **3 个文件**引用它，**没有一处是运行时导入**（用负向断言 `import (?!type).*@/generated/api` 搜过，零命中）。

**结论**：
- ✅ **`vite build` 成功**（esbuild 会抹掉 type-only 导入）—— 我们之前实测 build exit 0
- ❌ `tsc --noEmit` 失败（类型确实不存在）
- ✅ **运行时不受影响**

它的来源是文档注释里写的：`source: openbitfun-app-server-protocol` ——
即由 Rust 侧 crate 生成的 TS 类型。上游 `src/web-ui/src/generated/` 里**只有 `.gitkeep`**，
说明它是构建期产物、不入库。

### 3.4 判断：fail-closed 是对的，但代价要认

`theme:color-audit` 在 exclusions 路径不存在时**报错退出**，而不是跳过。
`typography:audit` 在 owner 文件缺失时报 `missing-typography-owner`。

**这个设计是对的**：豁免清单如果引用了不存在的路径，说明清单已经腐烂
（要么路径改名了、要么豁免不再需要）—— **报错比静默通过好**。
这与我们抓的「假绿」是同一原则。

**但代价是**：任何**部分 fork** 都会因为这些跨模块契约而拿不到绿色。

**我们要做的选择**（三选一，不能装作没问题）：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 补全 monorepo | 从上游拷 `src/`、`scripts/`、`docs/` 等 | 体量大；且我们并不需要 Rust 侧 |
| B. 维护 fork 专属的契约清单 | 改 exclusions / owner 路径 | 改了上游治理文件，后续跟进上游会冲突 |
| C. 明确声明 fork 范围 | 记录「我们只覆盖前端，以下检查不适用」并给出理由 | 需要一份**可复核的范围声明**，而不是「跑不过就算了」 |

**我倾向 C**，因为 A 是浪费（我们不跑 Rust 侧），B 会让跟进上游变难。
但 C 的前提是**把范围写清楚并可复核** —— 也就是本节这张表。

---

## 四、优势（可验证，≥3）

1. **治理检查是「可执行」的，不是文档**
   - 证据：`check:web` = `typography:audit:test` + `typography:audit` + `appearance:contract-audit`
     + `theme:color-audit:test` + `theme:color-audit:all` + `theme:visual-contract` + `type-check:web`
   - 为什么对：**它能抓到真人写的违规** —— 本轮抓了我 49 处。写在文档里的规范做不到这件事。

2. **审计区分「可判定」与「需人判断」**
   - 证据：`motion:audit` 自述 "This command is an inventory, not a pass/fail gate"，
     单独统计「重复 keyframe 名」（可判定）与「无限动画无 reduced-motion」（需人判断）
   - 为什么对：把需人判断的硬做成 gate 会误杀；做成 inventory 才可持续。
     这与 luanyujia 的「判断类不该机械化」是同一条原则的两种落地。

3. **fail-closed 而不是静默跳过**
   - 证据：exclusions 路径不存在 → 报错退出；owner 文件缺失 → `missing-typography-owner`
   - 为什么对：豁免清单最容易腐烂，报错逼人面对。

4. **token 体系是分层的，且语义 token 别名到基础刻度**
   - 证据：251 个 `--openbitfun-type-*` 语义 token，`type-micro-font-size: var(--openbitfun-font-size-micro)`
   - 为什么对：改基础刻度能推动全部语义 role；且审计能区分
     「用了语义 token」（合规）与「用了基础 token」（`foundation-typography-in-semantic-consumer`，违规）

5. **审计脚本自身有测试**
   - 证据：`typography:audit:test` = `node --test scripts/audit-typography-tokens.test.mjs`；
     `theme:color-audit:test` = 3 个 `*.test.mjs`
   - 为什么对：审计器自己没测试的话，它判错了没人知道。

6. **产品身份审计阻止旧名字回流**
   - 证据：`product:identity:audit` 扫 5600 文本文件，用 `(?<!open)bitfun` 拦裸名
   - 为什么对：改品牌最难的是「改干净」——散落的旧名会一直回流。**这正是我们踩到的**。

---

## 五、缺点（可验证，≥3）

1. **治理检查假设完整 monorepo，部分 fork 无法通过** ★本轮实测
   - 证据：`theme:color-audit:all` 报 16 个 exclusions 路径不存在；
     `typography:audit` 报 missing owner；`check:core-boundaries` 要 `Cargo.toml`；
     `i18n:audit` 要 `src/apps/relay-server/...`；上游 19 个顶层目录我们缺 18 个
   - 什么场景出问题：
     - 只想用前端的人（比如我们）**永远拿不到绿色**，且**无法区分「真有问题」与「范围不匹配」**
     - 想 fork 前端做产品的人会反复在这上面浪费时间
     - 反过来，如果他们因此关掉这些检查，就失去了全部治理

2. **`type-check` 依赖 Rust 侧生成物，导致纯前端 fork 无法通过类型检查**
   - 证据：`@/generated/api` 缺 → 3 个 TS2307；上游 `src/web-ui/src/generated/` 只有 `.gitkeep`
   - 什么场景出问题：
     - **类型检查形同虚设**：失败的是「找不到模块」而不是「类型不匹配」，
       真正的类型错误会被这 3 条噪音掩盖
     - 本轮我就是先看到这 3 条，需要额外验证才知道它们是 type-only、运行时不阻塞
   - 缓解（上游可做）：把生成物也入库，或在 `generated/` 放一份**声明占位**
     （`export type ... = unknown` 之类的 stub），让缺生成物时报一条明确的错而不是 3 条泛泛的找不到模块

3. **审计器的排除清单是硬编码路径，没有「这个路径本该存在」的自检**
   - 证据：`exclusions[6..15].path does not exist` 一次性报 16 条，但**不告诉你这些路径本来是什么**
   - 什么场景出问题：看到 16 条「路径不存在」，要自己判断是「fork 不全」还是「上游改名了」。
     如果它区分这两类（比如比对 git 历史），诊断会快得多。

4. **`product:identity:audit` 的正则 `(?<!open)bitfun` 会误伤正当引用**
   - 证据：我写 `projects.json` 记录上游仓库信息时，用了真实路径 `D:/refs/bitfun2/OpenBitFun-main`
     与上游 GitHub 仓库名，被判违规
   - 什么场景出问题：**引用上游是正当的**（尤其在「标杆」这种记录参照项目的场景），
     但审计无法区分「我们的身份」与「我们在引用别人」。
     它确实有 `retiredIdentityDataBoundaryFiles` 白名单，但白名单是硬编码的，
     新增一个正当引用场景就要改审计器。

5. **`check:core-boundaries` 的存在让前端 fork 结构性失败**
   - 证据：`ENOENT ... Cargo.toml`
   - 什么场景出问题：它不是「发现问题」，而是「缺输入就崩」。崩掉比报「不适用」更难处理。

6. **仓库卫生检查的作用域是当前工作目录，看不到上层污染**
   - 证据：`check:repo-hygiene` 在 `apps/vouch-web` 下跑，扫 5783 文件全过；
     但我们的仓库根有 `dist2` / `dist3` / `npm-cache` / `npm-cache2` / `pnpm-home` / `pnpm12` / `node26` / `tmp` / `pydeps` 等一堆我的临时目录
   - 什么场景出问题：以子目录为根跑检查，**上层的问题一条都看不到**。
     这不是它的错（它按设计工作），但如果把它接进 CI，会给人「整个仓库都干净」的错觉。

---

## 六、可照搬（≥1）

| 照搬什么 | 从哪来 | 为什么 |
|---|---|---|
| **治理检查写成可执行断言** | `check:web` 组合 | 能抓到真人违规（本轮抓了我 49 处） |
| **区分 inventory 与 gate** | `motion:audit` 的设计 | 需人判断的不做成 gate |
| **fail-closed 的排除清单** | exclusion 路径不存在就报错 | 防豁免清单腐烂 |
| **审计器自带测试** | `typography:audit:test` / `theme:color-audit:test` | 审计器判错了得有人知道 |
| **产品身份审计** | `product:identity:audit`（5600 文件） | 改品牌后防旧名回流 |
| **语义 token 别名到基础刻度** | 251 个 `--openbitfun-type-*` | 改刻度能推动全部 role |
| **typo 契约：语义消费者禁用 foundation token** | `foundation-typography-in-semantic-consumer` | 强制走语义层 |

---

## 七、要超过（≥1）

| 能力 | OpenBitFun 现状 | 我们怎么做 | 怎么验证 |
|---|---|---|---|
| **范围声明要可复核** ★核心 | 治理检查假设完整 monorepo，部分 fork 拿不到绿且无法区分「真问题」与「范围外」 | 显式声明 fork 范围 + 每条不适用的检查给出理由 + 范围可由脚本复算 | 一个 `scope-check` 脚本输出「哪些检查适用 / 哪些不适用及原因」，与实测一致 |
| **type-check 不依赖未入库的生成物** | `@/generated/api` 缺 → 3 条 TS2307 噪音掩盖真类型错 | 生成物入库，或在 `generated/` 放类型占位，让缺生成物时报一条明确错 | 清空生成物后 `tsc` 报 1 条明确的「未生成」而不是 N 条找不到模块 |
| **排除清单区分「fork 不全」与「上游改名」** | 一次性报 16 条路径不存在，不分类 | 排除项标注「本该存在/可能已改名」，并比对历史 | 造一个「上游改名」场景，报告必须与「fork 不全」可区分 |
| **身份审计区分「自称」与「引用他人」** | `(?<!open)bitfun` 误伤正当引用（本轮踩到） | 审计要理解上下文：引用块/数据字段 vs 产品身份 | 在记录参照项目的数据里引用上游全名，不应违规；产品身份里出现裸名必须违规 |
| **缺输入不崩，报「不适用」** | `check:core-boundaries` 直接 ENOENT | 缺前置条件时给明确的不适用结论（四态里的 UNKNOWN） | 删掉 `Cargo.toml` 后，检查输出 UNKNOWN + 原因，退出码区分于 FAIL |
| **卫生检查覆盖整个仓库** | 以子目录为根跑，上层污染看不到 | 卫生检查从仓库根跑，或声明作用域并复算 | 在仓库根放一个垃圾文件，检查必须报 |
| **旧名清理要一次性做净** | 提供审计但需要人主动跑 | 改名流程里内置「跑身份审计」这一步 | 改名后不跑审计就提交，CI 必须红 |

---

## 八、这一轮实际改了什么（可复核）

| 改动 | 文件数 | 证据 |
|---|---|---|
| 清退役产品名 | 14 文件 + 3 文件名 + 2 目录名 | `product:identity:audit` 从 3 违规 → PASS（5600 文件扫描） |
| 排版 token 化 | 3 个 SCSS | `typography:audit` 我们文件 49 → 0 |
| 修 pnpm junction 断链 | 1 次 `pnpm install` | `node_modules/typescript` 的 Target 从 `apps\bitfun-web` 变为 `apps\vouch-web` |
| 补生成产物 | 2 文件 | `postinstall` 从失败 → 通过 |

---

## 九、诚实边界

1. **`check:web` 的完整链路未跑通** —— 它由 7 个子命令组成，其中 3 个因缺 Rust 侧而失败。
   我逐个跑了能跑的，但没有得到一次「`check:web` 整体 exit 0」。
2. **`theme:color-audit` 的 16 个排除路径只看了名字** —— 没有逐个确认它们本来是什么内容。
3. **未跑 `theme:visual-contract` 与 `appearance:contract-audit`** —— 需要先解决 exclusions 问题。
4. **未跑任何前端单测** —— `src/web-ui` 有 1277 个测试，本轮一个没跑。
5. **Rust 侧完全未跑** —— 10478 个 Rust 测试一个没跑（我们没有 Rust 代码）。
6. **`i18n:audit` 的具体失败点未深究** —— 只看到它要 `src/apps/relay-server/static/homepage/index.html`。
7. **改名后未验证运行时** —— `apps/vouch-web` 改名 + 重装依赖后，只跑了审计脚本，
   **没有再启动一次界面确认能跑**（这一步应该补）。
