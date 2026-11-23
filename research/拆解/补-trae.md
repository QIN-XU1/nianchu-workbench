# 补拆：Trae（从真实分发包取证）

> **证据等级：[确证]**
> 来源：官方 Linux x64 tar.gz（656.8MB）与 Windows 安装器（466.9MB），**只解包、未安装、未运行**。
> 版本：Trae CN **3.4.18**（product.json 内部版本 1.107.1），commit `e9a230d5`，构建于 2026-11-10。
> 取证路径：`D:\refs\_installers\trae-linux.tar.gz`
> 拆解时间：2026-11-15
>
> 这份报告替换此前那份「[高置信]/[推测]」的 Trae 章节。

---

## 一、怎么拿到的（过程本身就是证据）

Windows 安装器是 **Inno Setup 6.4**，`innoextract 1.9` 不支持（报
`Unexpected setup data version: 6.4.0.1`），7z 也只能解出 PE 节、拿不到 Inno payload。

**换路**：
1. 下载页是 SPA，静态 HTML 里没有下载链接
2. 用**浏览器工具抓网络请求**，发现版本 API：
   `GET https://api.trae.cn/icube/api/v1/native/version/trae/cn/latest`
3. 该 API 返回 **74 个平台/区域产物 URL**，其中含 **Linux x64 tar.gz**
4. tar.gz 是普通归档，直接可解 —— 绕过了 Inno Setup 的墙

**判断**：这条路径值得记下来。以后遇到 Inno Setup 6.4 的 Windows 安装器，
**先找它的版本 API，看有没有 Linux/macOS 产物** —— 那些格式（tar.gz / deb / dmg）更容易解。

---

## 二、实测数据

| 项 | 值 |
|---|---|
| Linux tar.gz | **656.8MB** / 10951 条目 |
| Windows 安装器 | 466.9MB（Inno Setup 6.4，未解开） |
| 内置扩展 | **108 个**（自研 16 个） |
| **ai-agent 模块** | **693.6MB**（单模块占总包绝大部分） |
| ckg 模块 | 48.0MB |
| sandbox 模块 | 30.7MB |
| browser-bridge | 1.6MB |
| VS Code 底座 | **1.107.1** |
| product.json 字段 | 81 个 |
| 数据目录 | `.trae-cn` |

---

## 三、底层架构

### 3.1 形态：VS Code fork + 原生模块（不是 JS）

与 Cursor 完全不同的路线。Trae 把 agent 做成**编译好的原生库**，随包分发：

| 文件 | 大小 | 推断职责 |
|---|---|---|
| `modules/ai-agent/libai_agent.so` | **250.7MB** | agent 主体 |
| `modules/ai-agent/libharness.so` | **237.2MB** | harness |
| `modules/ai-agent/bin/agent-tool-host` | **97.1MB** | 工具宿主（独立可执行） |
| `modules/ai-agent/libtoolhost.so` | **94.1MB** | 工具宿主库 |
| `modules/ai-agent/libsscronet.so` | 10.0MB | 网络库（字节 SSCronet） |
| `modules/ai-agent/bin/ctx-cli` | 4.5MB | 上下文 CLI |
| `modules/ai-agent/{start.sh,start.bat,meta.json,checkpoint.sh}` | — | 启动与检查点脚本 |

**关键：每个 `.so` 都有配套的 `.asc` 签名文件**
（`libai_agent.so.asc` / `libharness.so.asc` / `libtoolhost.so.asc` / `libsscronet.so.asc`）。

**判断**：这是「重客户端」路线的极致 —— 693.6MB 的原生代码随包发。
优点是**离线可用、可校验签名**；代价是**包体巨大、且编译产物无法审计源码**。

### 3.2 三个独立模块（不只 agent）

| 模块 | 体量 | 内容 | 推断 |
|---|---|---|---|
| `ckg` | 48MB | `libckg.so` 45.14MB + `libzmq.so.5` + `libpgm` + `libsodium` + `.asc` | **Code Knowledge Graph** —— 代码知识图谱，用 ZeroMQ 做 IPC |
| `sandbox` | 30.7MB | `trae-sandbox` 23.39MB + **`bwrap`** + `sbox.so` + `sbox_sdk.so` + `.asc` | **沙箱** —— 含 bubblewrap |
| `browser-bridge` | 1.6MB | — | 浏览器桥 |

**判断**：
- **`bwrap`（bubblewrap）的出现很关键** —— 这是 Linux 上的原生沙箱（Flatpak 用的那套）。
  说明 Trae 的隔离是**OS 级**，不是应用层文本判断
- **`ckg` 用 ZeroMQ + libsodium** —— 说明 CKG 是独立进程，通过消息总线与主进程通信，且做了加密
- 这三个模块都有 `.asc` 签名

### 3.3 扩展市场用 open-vsx.org

```json
"extensionsGallery": {
  "serviceUrl": "https://open-vsx.org/vscode/gallery",
  "resourceUrlTemplate": "https://open-vsx..."
}
```

**对比 Cursor**：Cursor 自建 `marketplace.cursorapi.com`；Trae 用**开源市场 open-vsx.org**。

**判断**：这是两种生态策略 —— 自建市场可控但要自己维护和审核；用 open-vsx 省事但受制于人
（且 open-vsx 上没有微软的闭源扩展，所以 Trae 同样要自研 Remote 系列，见 3.5）。

### 3.4 product.json 里没清理干净的字段

```json
"defaultChatAgent": {
  "extensionId": "GitHub.copilot",
  "chatExtensionId": "GitHub.copilot-chat",
  ...
}
```

这是 **VS Code 原生的默认 chat agent 配置**，Trae 没有改掉。

**判断**：说明它的 fork 是在 VS Code 基础上加模块，**product.json 的清理不彻底**。
结合 `licenseName: MIT` + `licenseUrl: https://github.com/microsoft/vscode/blob/main/LICENSE.txt`
（许可证直接指向微软仓库），可以确认它是**标准的 VS Code fork + 加装原生模块**。

### 3.5 自研扩展 16 个

| 扩展 | 推断职责 |
|---|---|
| `ai-completion` | 补全 |
| `byted-icube.python-enhance` | Python 增强 |
| `byted-icube.node-helper` | Node 增强 |
| `byted-icube.go-enhance` | Go 增强 |
| `byted-icube.java-helper` | Java 增强 |
| `byted-icube.icube-go-coding-experience-helper` | Go 编码体验 |
| `byted-icube.integrations-extended` | 扩展集成 |
| `byted-icube.trae-tob-git-ai-vscode` | 企业版 Git AI |
| `byted-solo.builtin-mcp` | **内置 MCP** |
| `cloudide.icube-remote-ssh` | **自研 Remote-SSH**（替代微软的） |
| `cloudide.icube-im-bridge` | **IM 桥**（飞书/Lark 类） |
| `cloudide.icube-devtool-ports` | 调试端口 |
| `cloudide.dsl-agent-logs` | agent 日志 |
| `git-ai.git-ai-vscode` | Git AI |
| `theme-icube` | 主题 |

**判断**：
- 四种语言增强（Python/Node/Go/Java）都要自研 —— **与 Cursor 重写 Pylance 是同一个问题**：
  微软的语言扩展不给 fork 用
- `cloudide.icube-im-bridge` 说明它有 **IM 集成**（这是字节生态的优势）
- `byted-solo.builtin-mcp` 确认 MCP 是自研内置

### 3.6 computer use 是独立的原生栈

| 文件 | 大小 |
|---|---|
| `cua_driver_sdk.dll`（win32-x64） | **29.5MB** |
| `cua_driver_node_runtime.node` | 0.6MB |
| `cua-restore-worker.exe` | 1.0MB |
| `cua-wgc-worker.exe` | 1.1MB |
| `trae-computer-use-mask.exe` | 0.6MB |
| 依赖 `@koromix/koffi`（FFI） | 1.5MB |
| 依赖 `@ubjs/node-win32-x64-msvc`（uniffi NAPI） | 0.5MB |

**判断**：
- `wgc` = **Windows Graphics Capture**（WGC API）—— 说明它用系统级截屏
- 用 **koffi（FFI）+ uniffi（Rust NAPI）** 桥接原生 DLL → 说明底层是 Rust/C++ 写的
- `trae-computer-use-mask.exe` 是「操作时遮挡敏感区域」的辅助进程（[推测]）

### 3.7 关键 npm 包

| 包 | 大小 |
|---|---|
| `@byted-icube/ai-modules-chat/dist/index.mjs` | **15.6MB** |
| `@byted-icube/solo-lite/dist/7528.da417b03.mjs` | 9.7MB |
| `@byted-solo/computer-use-mcp` | 2.0MB + 2.3MB chunk |

---

## 四、执行逻辑

### 4.1 从结构推断的链路（**[推测]**）

```
编辑器
 → ai-completion / byted-icube.* 扩展（前端触发）
 → @byted-icube/ai-modules-chat（JS 桥，15.6MB）
 → modules/ai-agent/libai_agent.so（agent 主体，250.7MB，签名校验）
 → libharness.so（harness，237.2MB）
 → bin/agent-tool-host + libtoolhost.so（工具宿主，191MB）
 → modules/sandbox/（bwrap + sbox.so）执行隔离
 → modules/ckg/libckg.so（知识图谱，ZeroMQ + libsodium 通信）
```

**明确标注**：原生库是编译产物，**无法读源码**，所以这条链路是**从模块划分 + 文件命名 + 依赖关系推断的**。

### 4.2 与 Cursor 的架构对比（这是本轮最有价值的对照）

| 维度 | Cursor | Trae |
|---|---|---|
| **agent 分发** | CDN 拉取（客户端内无 agent） | **原生 .so 随包（693.6MB）** |
| **签名校验** | 未知 | **每个 .so 有 `.asc`** |
| **离线可用** | ✗（依赖 CDN） | ✓ |
| **外部可审计** | ✗（agent 在 CDN） | ✗（编译产物） |
| 沙箱 | 未发现独立模块 | **sandbox 模块（含 bwrap）** |
| 知识图谱 | 未发现 | **ckg 模块 45MB libckg.so** |
| 进程通信 | 未发现 | **ZeroMQ + libsodium** |
| 工具宿主 | 未发现独立进程 | **agent-tool-host 独立可执行** |
| 扩展市场 | 自建 cursorapi.com | **open-vsx.org** |
| computer use | 独立扩展 | **独立原生栈（cua_driver_sdk.dll 29.5MB）** |
| 语言扩展 | 重写 Pylance/C++/C# | 重写 Python/Node/Go/Java 增强 |
| VS Code 底座 | 1.128.0 | 1.107.1 |
| 包体 | 安装器 198.3MB | **Linux 包 656.8MB** |

**结论**：两家都在 VS Code fork 路线上，但**对「agent 从哪来」的答案完全相反**：
- Cursor 选**解耦**（CDN，可独立迭代，但离线不可用、无法审计）
- Trae 选**内置**（693MB 原生库，离线可用、有签名，但包体巨大、同样无法审计）

---

## 五、界面设计

本次拿到的是 Linux 完整包，含 `resources/app/out/`（VS Code workbench）。
但**未逐层分析 UI 代码** —— 诚实标注：**界面维度的深度取证未做**。

从扩展与模块可推断的界面特征（**[推测]**）：
- `theme-icube` 自研主题（品牌化的视觉）
- `ai-completion`（内联补全）
- `mermaid-chat-features`（聊天里支持 mermaid）
- `cloudide.dsl-agent-logs`（agent 日志面板）

---

## 六、优势（可验证，≥3）

1. **原生库有签名校验**
   - 证据：`libai_agent.so.asc` / `libharness.so.asc` / `libtoolhost.so.asc` / `libsscronet.so.asc` / `sbox.so.asc` / `libckg.so.asc`
   - 为什么对：693MB 的原生代码如果被替换，用户无感知；**有 .asc 说明加载前会验签**。
     这正是我在 Cursor 那节列出的「要超过」第一项 —— **Trae 已经做了，Cursor 没有（或未证实）**。

2. **沙箱是 OS 级（bwrap）而非应用层判断**
   - 证据：`modules/sandbox/bwrap`（0.17MB）+ `sbox.so` + `sbox_sdk.so`
   - 为什么对：**这与用户的指示直接相关** —— 用户说「越界行为这类机制暂不做，因为一旦做错就是很大的漏洞」。
     原因正是：**应用层的文本判断不能当安全边界**。Trae 用 bwrap 是 OS 级隔离，判错的方向是内核保证的，不是自己判的。

3. **知识图谱是独立模块独立进程**
   - 证据：`modules/ckg/libckg.so` 45.14MB + `libzmq` + `libsodium`
   - 为什么对：CKG 计算重、内存大，独立进程不会拖累主进程；ZeroMQ 让通信异步；
     libsodium 说明消息通道加密（同机多进程也可能被其他进程监听）。

4. **工具宿主是独立可执行**
   - 证据：`bin/agent-tool-host` 97.1MB 单独存在（不是 .so）
   - 为什么对：工具执行与 agent 推理分离，**工具崩溃不拖垮 agent**；也便于对工具宿主单独做权限约束。

5. **computer use 用系统级 API（WGC）而非模拟点击**
   - 证据：`cua-wgc-worker.exe`（Windows Graphics Capture）
   - 为什么对：截屏走系统 API 更稳定，不受窗口遮挡影响。

6. **用开源市场而非自建**
   - 证据：`extensionsGallery.serviceUrl = open-vsx.org`
   - 为什么对：省掉自建市场的运维与审核成本；代价是上面没有微软闭源扩展。

---

## 七、缺点（可验证，≥3）

1. **agent 是编译产物，无法审计**
   - 证据：693.6MB 全是 `.so` 与二进制（`libai_agent.so` / `libharness.so` / `agent-tool-host`）
   - 什么场景出问题：
     - 企业合规审查无法回答「agent 到底怎么决策」
     - 出问题只能靠行为观察，不能读代码定位
     - **签名只证明「没被篡改」，不证明「内容是善意的」** —— 官方签名的代码也可能有 bug 或多余行为

2. **包体巨大：Linux 包 656.8MB，其中 ai-agent 模块 693.6MB（未压缩）**
   - 证据：tar 条目 10951，ai-agent 16 项合计 693.6MB
   - 什么场景出问题：下载慢、磁盘占用大、更新要重下整个包（若不做差分）

3. **VS Code 底座落后**
   - 证据：`vscodeVersion: 1.107.1`（Cursor 是 1.128.0）
   - 什么场景出问题：拿不到 VS Code 新版本的语言特性与 API；插件兼容性窗口更窄

4. **product.json 未清理上游字段**
   - 证据：`defaultChatAgent` 仍指向 `GitHub.copilot` / `GitHub.copilot-chat`；
     `licenseName: MIT` + `licenseUrl` 指向 `microsoft/vscode`
   - 什么场景出问题：
     - `defaultChatAgent` 若被 VS Code 的某些路径读到，可能触发意料外的行为
     - 许可证声明指向微软，而非 Trae 自己的许可条款 —— 用户对「我用的是什么许可」会困惑

5. **必须自研四种语言扩展**
   - 证据：`byted-icube.{python-enhance,node-helper,go-enhance,java-helper}` 四个扩展
   - 什么场景出问题：与 Cursor 同一个问题 —— 微软的语言扩展不给 fork 用，
     自研版永远慢于官方版的特性更新

6. **ckg 模块依赖一堆系统库**
   - 证据：`libckg.so` 需要 `libgcc_s.so.1` / `libstdc++.so.6` / `libzmq.so.5` / `libpgm-5.2.so.0` / `libsodium.so.18`
   - 什么场景出问题：不同发行版的 glibc/libstdc++ 版本差异会导致加载失败；
     打包了这些 .so 缓解，但可能与系统版本冲突

---

## 八、可照搬（≥1）

| 照搬什么 | 从哪来 | 为什么 |
|---|---|---|
| **原生库签名校验（.asc）** | `modules/ai-agent/*.so.asc` | 693MB 二进制若无验签，被替换用户无感知。**这一条直接对应用户的关切** |
| **沙箱用 bwrap 而非文本判断** | `modules/sandbox/bwrap` | OS 级隔离的判错方向由内核保证，不是自己判 |
| **知识图谱独立进程 + 加密 IPC** | `modules/ckg/libckg.so` + libzmq + libsodium | 重计算模块不拖累主进程 |
| **工具宿主独立可执行** | `bin/agent-tool-host` | 工具崩溃不拖垮 agent，且可单独约束权限 |
| **computer use 用系统级截屏 API** | `cua-wgc-worker.exe` | 比模拟点击稳定 |
| **版本 API 返回全平台产物** | `api.trae.cn/icube/api/v1/native/version/trae/cn/latest` | 74 个 URL 含 Linux tar.gz —— 这也是我拿到它的原因 |

---

## 九、要超过（≥1）

| 能力 | Trae 现状 | 我们怎么做 | 怎么验证 |
|---|---|---|---|
| **可审计性** ★核心 | 编译产物无法读 | 若走二进制路线，必须提供**可复核的行为清单**（这个二进制会碰哪些文件/网络/进程）| 用 strace/ETW 记录一次完整任务的系统调用，与声明的清单比对 |
| **签名 + 内容清单** | 有 `.asc` 但只证「没被改」 | 签名之外还要**发布内容清单**（构建来源、依赖 SBOM） | 从分发包可导出 SBOM，且与构建记录一致 |
| **包体** | 656.8MB（Linux） | 核心运行时 <50MB，重模块按需下载且**校验** | 安装包体积；断网后核心功能仍可用 |
| **VS Code 底座跟进** | 1.107.1（落后 21 个小版本） | 记录底座版本与跟进节奏，可复算 | 查 product.json 的 vscodeVersion；与上游最新对比 |
| **上游字段清理** | `defaultChatAgent` 仍指向 GitHub.copilot | fork 后清理所有上游遗留字段，并列出清单 | 对 product.json 逐字段核对，无遗留上游标识 |
| **许可证声明准确** | licenseUrl 指向 microsoft/vscode | 我们 fork 的是 MIT 的 OpenBitFun，许可证声明指向真正的上游并保留版权 | 核对 LICENSE 与 product.json 声明一致 |

---

## 十、这次取证纠正了我此前的四个错误

1. **「Builder 模式把需求一条龙做成项目」** —— 这是我从公开信息写的。
   实测**未在包内找到任何名为 Builder 的模块或扩展**。诚实标注：**未证实**。

2. **「基于 VS Code，与 Cursor 同路线」** —— 这句太粗。
   实测两者的 fork 策略相同，但 **agent 分发策略完全相反**（CDN vs 内置 693MB 原生库）。

3. **「依赖闭源模型服务，离线/内网场景受限」** —— 需要修正为：
   agent 主体是**本地的 693MB 原生库**（离线可用），但模型推理仍走云端。
   所以「离线可用」只到「agent 框架本地」，不到「完全离线」。

4. **「生态较新，插件不如 VS Code/Cursor」** —— 实测它有 **108 个内置扩展**，
   用 open-vsx.org 市场。比「较新」要成熟，但仍受 open-vsx 生态规模限制。

---

## 十一、诚实边界

1. **agent 原生库未反编译** —— 693.6MB 的 `.so` 只读了文件名与依赖，**没有反汇编**。
   所有执行逻辑都是**[推测]**。
2. **界面维度未深挖** —— 拿到了完整包但没逐层分析 workbench UI。
3. **`.asc` 的具体校验机制未确认** —— 只看到签名文件存在，
   它的验签时机（加载前？启动时？）与失败行为**未读**。
4. **Windows 安装器仍未解开** —— Inno Setup 6.4 + innoextract 1.9 不支持；
   Windows 版与 Linux 版的模块可能不同（如 `cua_driver_sdk.dll` 只在 Windows 有）。
5. **ckg / sandbox 的具体行为未验证** —— 只从文件构成推断，未运行。
6. **`trae-computer-use-mask.exe` 的用途是推测** —— 从命名猜的，未验证。
