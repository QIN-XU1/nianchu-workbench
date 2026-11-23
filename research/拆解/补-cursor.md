# 补拆：Cursor（从真实分发包取证）

> **证据等级：[确证]**
> 来源：官方 `vscode-reh-win32-x64.tar.gz`（101.6MB）与安装器（198.3MB），**只解包、未安装、未运行**。
> 版本：Cursor **3.30.14**，commit `5f54c8173e5552412beb40702adac16275677fa0`，构建于 2026-11-13。
> 路径：`D:\refs\_installers\cursor-src\vscode-reh-win32-x64`
> 拆解时间：2026-11-15
>
> 这份报告替换了此前那份「[高置信]/[推测]」的 Cursor 章节 —— 之前因为「未安装」只能靠公开信息，
> 现在拿到真实分发包，全部改成实测。

---

## 一、实测数据

| 项 | 值 |
|---|---|
| 分发包 | 101.6MB / **5488 文件**（3734 个 .js） |
| 安装器 | 198.3MB（Inno Setup 6.4，`innoextract 1.9` 不支持该版本） |
| 主 bundle | `out/server-main.js` **1255KB** |
| Cursor 专有模块 | `cursor-files/cursor-files.cjs` **207KB** |
| 内置扩展 | **52 个**（其中 anysphere 自有 19 个 + cursor.* 2 个） |
| VS Code 底座 | **1.128.0** |
| 内置 Node | 24.22.1 |
| 数据目录 | `.cursor` |
| product.json 字段 | **86 个** |

---

## 二、底层架构

### 2.1 形态：VS Code fork + 分层扩展

底座是 VS Code **1.128.0**，Cursor 的所有 AI 能力都做成**内置扩展**，而不是改核心。

**判断**：这与我此前「three-layer AI」的推测不同 —— 真实做法是**把 agent 拆成多个扩展各管一段**（见 2.4）。

### 2.2 agent harness 不在安装包里

`product.json` 有一个字段：

```json
"agentHarnessCdnUrl": "https://downloads.cursor.com/agent-host-harness/"
```

**这是关键发现**：agent 的实现是**从 CDN 单独分发**的，不随客户端打包。

验证：探测该 CDN 返回 **403 AccessDenied**（列表被拒，无公开索引），
所以无法确定具体文件名 —— **诚实标注为未取到**。

**判断**：这条设计有两层含义：
1. **好处**：agent 逻辑可以独立于客户端发版迭代，用户不必更新整个 IDE
2. **代价**：客户端里看不到 agent 全貌，任何审计都只能到「它去 CDN 取了什么」为止；
   而且**离线/内网场景拿不到 agent**

`anysphere.cursor-local-agent-runtime` 这个扩展名说明它也有本地运行时路径，但主路径是 CDN 拉取。

### 2.3 服务端点（全部实测）

| 用途 | 端点 |
|---|---|
| 更新 | `https://api2.cursor.sh/updates` |
| 备用更新 | `http://cursorapi.com/updates`（**注意是 http**） |
| **agent harness** | `https://downloads.cursor.com/agent-host-harness/` |
| 遥测代理 | `https://api3.cursor.sh/tev1/v1` |
| Statsig（特性开关） | key `client-Bm4HJ0aDjXHQVsoACMREyLNxm5p6zzuzhO50MgtoT5D` |
| 扩展市场 | `https://marketplace.cursorapi.com/_apis/public/gallery`（**自建市场**） |
| server 分发包 | `https://cursor.blob.core.windows.net/remote-releases/${commit}/vscode-reh-${os}-${arch}.tar.gz` |

**判断**：
- **自建扩展市场** + `extensionReplacementMapForImports`（见 2.5）= 它不依赖微软市场，也不受其条款约束
- 备用更新走 **http**（非 https）是个小瑕疵 —— 但更新包本身该有签名，所以不算严重
- 遥测有独立代理域名，说明遥测量级大到需要单独入口

### 2.4 19 个 anysphere 自有扩展（这是最有价值的部分）

agent 相关（拆成四段）：

| 扩展 | 推断职责 |
|---|---|
| `anysphere.cursor-agent-host` | agent 宿主（进程/生命周期） |
| `anysphere.cursor-agent-exec` | agent 执行 |
| `anysphere.cursor-agent-worker` | 工作单元 |
| `anysphere.cursor-local-agent-runtime` | 本地运行时 |

其余：

| 扩展 | 推断职责 |
|---|---|
| `anysphere.cursor-retrieval` | 检索（embedding / RAG 索引） |
| `anysphere.cursor-mcp` | **MCP 客户端** |
| `anysphere.cursor-shadow-workspace` | **影子工作区**（隔离/预览） |
| `anysphere.cursor-always-local` | 始终本地模式 |
| `anysphere.cursor-socket` | socket 通道 |
| `anysphere.cursor-ndjson-ingest` | NDJSON 流式摄取 |
| `anysphere.cursor-resolver` / `-resolver-helper` | 路径/依赖解析 |
| `anysphere.cursor-explorer` | 探索（浏览器？） |
| `anysphere.cursor-polyfills-remote` | 远程环境 polyfill |
| `anysphere.cursor-deeplink` | 深链 |
| `anysphere.cursor-checkout` | 结账/订阅 |
| `anysphere.cursor-commits` | **遥测**：`description: "Tracks requests and commits for Cursor online metrics"` |

另有 2 个 `cursor.*`：
- `cursor.cursor-browser-automation` — 浏览器自动化
- `cursor.cursor-computer-use` — 电脑操作

**关键证据**：`cursor-commits` 的 `enabledApiProposals` 是
```json
["control","cursor","cursorTracing","cursorNoDeps"]
```
即 Cursor **有自己的 VS Code API proposal 命名空间**（`cursor*`）——
它是 fork，可以给自己的扩展开私有 API，第三方扩展拿不到。

### 2.5 扩展替换表：重写微软的闭源扩展

```json
"extensionReplacementMapForImports": {
  "ms-vscode-remote.remote-ssh":          "anysphere.remote-ssh",
  "ms-vscode-remote.remote-containers":   "anysphere.remote-containers",
  "ms-vscode-remote.remote-wsl":          "anysphere.remote-wsl",
  "jeanp413.open-remote-ssh":             "anysphere.remote-ssh",
  "jeanp413.open-remote-wsl":             "anysphere.remote-wsl",
  "ms-python.vscode-pylance":             "anysphere.cursorpyright",
  "ms-vscode.cpptools":                   "anysphere.cpptools",
  "ms-dotnettools.csharp":                "anysphere.csharp"
}
```

**判断**：这是 **fork 路线的真实成本** ——
微软的 Remote 系列、Pylance、C/C++、C# 扩展**不允许 fork 使用**，
所以 Cursor 必须自己重写（`cursorpyright` 显然基于开源 pyright）。

**这条对我们直接相关**：我们 fork 的是 OpenBitFun（MIT），但**如果未来要接 VS Code 生态，会遇到同一堵墙**。

### 2.6 42 个构建期移除标记 —— 特性清单的意外泄露

```json
"removeLinesBeforeCompilingIfTheyContainTheseWords": [ 42 项 ]
```

这是 gulp 构建时按标记删行的清单，**等于公开了它的特性名**。按类别：

**AI 相关（12 个，最有信息量）：**

| 标记 | 推断特性 |
|---|---|
| `disable_cursoreval` | **Cursor 有自己的 eval 系统** |
| `disable_ai_assert` | **AI 断言** —— 用 AI 检查代码断言 |
| `disable_ai_debugger` | AI 调试器 |
| `disable_ttft_logging` | time-to-first-token 日志 |
| `disable_dev_only_prompt_quality_link` | prompt 质量度量 |
| `disable_embedding_model_switch` / `disable_multiple_embeddings` | 多 embedding 模型可切换 |
| `disable_cursor_prediction_options` | 预测选项 |
| `disable_context_ast_typescript_fork` | **AST 级 TypeScript 上下文**（fork 了 TS 解析器） |
| `disable_always_on_fast_apply_chunk_speculation` | 快速应用的 chunk 推测 |
| `disable_runnable_code_blocks` | 可运行代码块 |
| `disable_multi_file_applies` | 多文件应用 |
| `disable_composer_handle_debugging` / `disable_composer_migration_warning` | Composer 相关 |
| `disable_agent_cli_formatter` | agent CLI 格式化 |
| `disable_user_intent_agents` | **用户意图 agent** |

**平台/其他（22 个）：**
`disable_local_mode`、`disable_resume`、`disable_rcp_server`、`disable_orbit_build`、
`disable_cpp_eval`、`disable_cpp_control_token`、`allow_skip_privacy_mode_grace_period`、
`disable_kill_all_modes_and_surface_bg`、`disable_fill_screen`、`disable_statsig`、
`disable_warning_on_too_many_update_locks`、`SPACEX_DEV_ONLY` 等。

**判断**：`disable_ai_assert` 与 `disable_cursoreval` 值得注意 ——
说明 Cursor 在做**「用 AI 验证 AI 的输出」**与**自己跑 eval**。
这与我们的四态主张方向一致，但它只到「断言」层，没有「判不了」这一态。

---

## 三、执行逻辑

### 3.1 任务链路（从扩展名推断，属**[推测]**）

```
编辑器 → cursor-agent-host（宿主/生命周期）
       → cursor-agent-exec（执行）
       → cursor-agent-worker（工作单元）
       → agent harness（从 CDN 拉取）
       → cursor-local-agent-runtime（本地运行时）
       ↘ 输出经 cursor-ndjson-ingest 流式回传
```

**明确标注**：agent 主体在 CDN，本包内看不到，所以这条链路是**从扩展命名与依赖关系推断的**，不是读代码得出的。

### 3.2 MCP 是独立扩展

`anysphere.cursor-mcp` —— MCP 客户端是自研扩展，不是外包。
对照我们的 A13（自研 stdio + JSON-RPC 客户端），路线一致。

### 3.3 影子工作区

`anysphere.cursor-shadow-workspace` —— 名字说明它做**影子/隔离工作区**。
用途推测是：让 agent 先在影子区改，确认后再落到真实工作区。

**判断**：如果确实如此，这是比「直接改真文件 + git 回滚」更安全的做法 —— 值得我们参考。

---

## 四、功能选取

### 有而我们没有

1. **agent harness CDN 独立分发** —— agent 逻辑与客户端解耦，可独立迭代
2. **私有 VS Code API 命名空间**（`cursor*` proposal）—— 给自己的扩展开后门
3. **AST 级 TypeScript 上下文**（fork 了 TS 解析器）
4. **AI 断言 + 自己的 eval 系统**（`ai_assert` / `cursoreval`）
5. **多 embedding 模型可切换**
6. **影子工作区**
7. **用户意图 agent**
8. **浏览器自动化 + 电脑操作**（两个独立扩展）

### 刻意没做

- **不自己做编辑器**（fork VS Code）
- **不用微软市场**（自建 `cursorapi.com` 市场）

---

## 五、界面设计

本次分发包是 **reh（remote extension host）**，不含完整前端 UI（UI 在另一个包 `vscode-web` 里）。
所以**界面维度的证据仍然不足** —— 诚实标注：**未取到**。

此前版本里的界面描述（inline diff、三层 AI）保持 [高置信]，未被本次取证证实或推翻。

---

## 六、优势（可验证，≥3）

1. **agent 与客户端解耦**
   - 证据：`agentHarnessCdnUrl` 字段 + `cursor-local-agent-runtime` 扩展
   - 为什么对：agent 迭代频率远高于 IDE；解耦后不必让用户更新整个客户端。**这是分发策略上的优势，值得学。**

2. **给自己的扩展开私有 API 命名空间**
   - 证据：`cursor-commits` 的 `enabledApiProposals: ["control","cursor","cursorTracing","cursorNoDeps"]`
   - 为什么对：fork 的核心价值就是「能改底座」；开私有 API 让自己能力不受上游约束。

3. **把微软闭源扩展全部重写**
   - 证据：`extensionReplacementMapForImports` 8 条映射，含 `pylance → cursorpyright`
   - 为什么对：绕开许可证限制，且重写后可深度集成自己的 AI（比如 cursorpyright 可以给 AI 提供类型信息）。**代价是维护成本极高。**

4. **MCP 是自研扩展而非外包**
   - 证据：`anysphere.cursor-mcp`
   - 为什么对：MCP 是能力入口，外包等于把命脉交出去。我们 A13 的选择一致。

5. **影子工作区**
   - 证据：`anysphere.cursor-shadow-workspace`
   - 为什么对：agent 改动先落影子区再合并，比「直接改 + git 回滚」安全（[推测] 具体行为）。

---

## 七、缺点（可验证，≥3）

1. **agent 主体不在客户端里，外部无法审计**
   - 证据：`agentHarnessCdnUrl` 指向 CDN；探测该地址返回 403 AccessDenied，无公开索引
   - 什么场景出问题：
     - **离线/内网/气隙环境**：拿不到 agent，产品不可用
     - **合规审查**：企业无法回答「agent 到底执行了什么逻辑」
     - **供应链**：CDN 上的内容可变，客户端无法校验版本一致性

2. **备用更新走 http**
   - 证据：`"backupUpdateUrl": "http://cursorapi.com/updates"`（**http 不是 https**）
   - 什么场景出问题：主更新域名不可用时降级到 http，若更新包签名校验有缺陷则可被中间人替换。

3. **必须重写微软扩展 = 永久的落后成本**
   - 证据：8 条替换映射，含 Pylance / C++ / C# / Remote 三个系列
   - 什么场景出问题：
     - 微软每次更新这些扩展，Cursor 要同步；不同步则用户拿不到新语言特性
     - `extensionMaxVersions` 里 pin 了具体版本（如 `ms-vscode.cpptools: max 1.23.6`），说明它**主动阻止用户装新版**以避免不兼容

4. **遥测规模大到需要独立代理**
   - 证据：`statsigLogEventProxyUrl: https://api3.cursor.sh/tev1/v1` + `cursor-commits` 扩展
     （`description: "Tracks requests and commits for Cursor online metrics"`）
   - 什么场景出问题：企业环境需要审计「什么数据出网」；`requests and commits` 说明它追踪的不只是崩溃。

5. **`removeLinesBeforeCompiling` 用字符串匹配删行**
   - 证据：42 个 `__GULPFILE_REMOVE_LINE_BEFORE_COMPILING__` 标记，靠文本匹配在构建时删行
   - 什么场景出问题：如果某行正文里恰好含这些字符串（比如注释里提到），会被误删；
     且这套机制**不可审计**（删了什么没有记录）。

6. **私有 API proposal 让第三方扩展处于劣势**
   - 证据：`enabledApiProposals: ["control","cursor",...]`
   - 什么场景出问题：生态里「亲儿子」与第三方能力不对等，第三方做不出同等体验。

---

## 八、可照搬（≥1）

| 照搬什么 | 从哪来 | 为什么 |
|---|---|---|
| **能力与宿主解耦的分发方式** | `agentHarnessCdnUrl` | 不必为 agent 更新发整个客户端。**但要加校验**（见「要超过」#1） |
| **影子工作区** | `anysphere.cursor-shadow-workspace` | agent 改动先落影子区，确认后再合并 |
| **私有能力命名空间** | `enabledApiProposals: ["cursor*"]` | 我们 fork 了 OpenBitFun，也可以有自己的 `vouch*` 命名空间 |
| **把 agent 拆成 host/exec/worker/runtime** | 四个扩展名 | 单文件 god-object 的反面；我们正好有 B4 体量红线 |
| **MCP 自研** | `anysphere.cursor-mcp` | 与我们 A13 路线一致，互相印证 |

---

## 九、要超过（≥1）

| 能力 | Cursor 现状 | 我们怎么做 | 怎么验证 |
|---|---|---|---|
| **分发物可校验** ★核心 | agent 从 CDN 拉，无客户端校验 | 若走远程分发，必须**内容哈希 + 签名**，且客户端持久化记录实际使用的版本 | 篡改分发内容，客户端必须拒绝；版本记录可离线复核 |
| **离线可用** | agent 依赖 CDN，气隙环境不可用 | 核心能力本地可用，远程只是增强 | 断网后核心功能仍可跑；无 CDN 也能完成一次完整任务 |
| **更新链路全 https** | 备用更新是 http | 所有更新链路 https + 签名 | 检查所有端点为 https；篡改更新包必须被拒 |
| **不依赖重写上游扩展** | 8 条替换映射，永久跟版成本 | 我们只在 MIT 范围内 fork，不依赖闭源扩展 | 列出所有外部依赖及其许可证；无「必须重写」项 |
| **四态而非二元断言** | 有 `ai_assert` / `cursoreval`，但只有「断言通过/失败」 | 「判不了」是一等状态 | 构造不可判定场景，我们输出 UNKNOWN 且不并入通过；Cursor 只有 true/false |
| **删行机制可审计** | 字符串匹配删行，无记录 | 构建期变换要有清单与日志 | 构建产物与源码的差异可枚举 |

---

## 十、这次取证纠正了我此前的三个错误

1. **「三层 AI（Tab / Cmd+K / Composer）」** —— 这是我从公开信息推测的架构描述。
   实测发现真实的组织方式是**按能力拆成 19 个扩展**（host/exec/worker/runtime/retrieval/mcp/shadow-workspace…），
   不是「三层」。[推测] → [确证]

2. **「VS Code fork 免费获得整个扩展生态」** —— 我在上一版把它列为优势。
   **实测推翻**：`extensionReplacementMapForImports` 说明它**拿不到**微软的 Remote/Pylance/C++/C# 系列，
   必须自研替代。fork 不是「免费拿生态」，是「拿到框架但要重写关键扩展」。

3. **「索引的隐私边界对用户不透明（推测）」** —— 现在有了硬证据：
   `cursor-commits` 扩展明写 `Tracks requests and commits for Cursor online metrics`，
   遥测有独立代理域名。**这不只是「不透明」，是有明确的数据外发通道。**

---

## 十一、诚实边界

1. **agent 主体未取到** —— 在 CDN（403 AccessDenied），所以执行逻辑的细节是**[推测]**。
2. **界面证据仍不足** —— 本次拿的是 reh（远程扩展宿主），不含 UI 包。
3. **安装器未解开** —— Inno Setup 6.4 超出 `innoextract 1.9` 支持范围。
   （已尝试：7z 解出 PE 节但拿不到 Inno payload；innoextract 报
   `Unexpected setup data version: 6.4.0.1`）
4. **扩展的 `contributes` 未逐个读** —— 52 个扩展只读了 package.json 的元数据，
   没有深入每个扩展的实现。
5. **`extensionMaxVersions` 的完整列表未展开** —— 只提取了替换表，pin 版本表未逐条记录。
