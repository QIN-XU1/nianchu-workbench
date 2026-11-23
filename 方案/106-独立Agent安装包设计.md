# 106 · 独立 Agent 安装包设计

> 用户：「我想让它成为一个独立的 agent，做成安装程序吧」
>
> 这是从"依附外部引擎的壳"到"自带引擎的独立产品"的转变。

---

## 一、先弄清楚：现在是什么、要变成什么

### 1.1 现在

```
DeepSeek Harness（外部程序）
  └── app.asar/dsh/          引擎本体（433 MB，在 asar 里）
  
我们的项目
  └── workbench/
      ├── 外壳/              Electron GUI（壳）
      │   └── main.js        依赖外部引擎的 token
      └── 引擎数据/
          ├── .dsh/          引擎数据（场景记忆/技能/配置）
          └── .dsh-tui/      TUI 会话数据
          
问题：壳和引擎分离，引擎不在项目里
     → 启动时找不到引擎 → pnpm/package.json 都找不到
     → 拿不到 token → "no cookie"
```

### 1.2 要变成

```
安装包（一个 exe 或一个目录）
  ├── 引擎/                  引擎本体（228 MB，已提取验证）
  ├── 外壳/                  Electron GUI
  ├── 数据/                  首次运行生成的场景记忆等
  └── 启动器                 exe 入口
      
特点：
  · 不需要外部 DeepSeek Harness
  · 双击就能用
  · 数据在安装目录内（可移植）
```

---

## 二、已完成的验证（本轮实测）

### 2.1 引擎可以完整提取

```
从 app.asar 提取：
  · asar 内：19442 文件，189.6 MB
  · unpacked：834 文件，38.6 MB
  合计：20276 文件，228.2 MB
  
排除项（可裁）：
  · libreoffice（182 MB）—— Office 功能
  · sherpa-onnx（22 MB）—— 语音识别
```

### 2.2 引擎可以独立运行

```bash
$ node node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js --version
0.2.2-rc.1

$ node node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js web --no-open --port 3199
dsh web: http://127.0.0.1:3199/?token=zkyAENn0_9ND2cGrgcuEI7yIuyzpHnDYM5unhWis0pU

$ curl "http://127.0.0.1:3199/?token=..."
HTTP 200
<!doctype html>...<title>DSH</title>...
```

**完全独立，不依赖原 DeepSeek Harness 安装。**

---

## 三、安装包架构设计

### 3.1 目录结构

```
Agent自研/                         ← 安装根目录
├── Agent.exe                       ← 启动器（Electron 主程序）
├── resources/
│   ├── app.asar                    ← 我们的壳（GUI 代码）
│   └── app.asar.unpacked/
│       └── 引擎/                    ← 引擎本体（228 MB）
│           ├── node.exe            ← Node 运行时
│           ├── node_modules/       ← 引擎依赖
│           └── package.json
├── 数据/                            ← 用户数据（首次运行生成）
│   ├── .dsh/                       ← 场景记忆/技能/配置
│   └── .dsh-tui/                   ← 会话数据
└── 启动.vbs                        ← 可选：无控制台启动
```

### 3.2 为什么这样设计

| 决策 | 理由 |
|---|---|
引擎放 `resources/app.asar.unpacked/引擎/` | Electron 打包规范，unpacked 目录不会被压进 asar |
数据放安装目录 `数据/` | 可移植（拷走就能用），也符合"独立 agent" |
自带 `node.exe` | 用户机器可能没装 Node |
启动器 exe | 双击就能用，不需要命令行 |

### 3.3 关键技术问题

**问题 1：Electron 的 Node 与系统 Node 版本差异**

```
Electron 内置 Node 版本可能与引擎要求不符
→ 解决：引擎用自带的 node.exe 启动（不用 Electron 的）
```

**问题 2：asar 内的引擎无法被 spawn**

```
spawn 时 asar 里的文件不能直接执行
→ 解决：引擎必须放在 app.asar.unpacked/
```

**问题 3：首次运行要初始化数据**

```
首次启动时：
  · 检查 数据/.dsh 是否存在
  · 不存在 → 从模板复制
  · 然后启动引擎
```

---

## 四、实施路径（分三步）

### 第一步：本地可运行版（不打包，直接跑）

```
创建一个 _standalone/ 目录：
  _standalone/
  ├── 引擎/           ← 从 _engine 复制
  ├── 外壳/           ← 复制我们的壳
  ├── 数据/           ← 复制现有 .dsh 数据（脱敏）
  └── 启动.cmd        ← 命令行启动脚本
  
验收：双击 启动.cmd，GUI 起来，AI 对话能用
```

**为什么先做这个：**
```
打包成 exe 后调试困难。
先在目录形态跑通，再打包。
```

### 第二步：Electron 打包

```
用 electron-builder：
  · 把 引擎/ 放进 extraResources
  · 把 数据/ 模板放进 extraResources
  · 生成 NSIS 安装包（.exe）
  
验收：安装 → 双击 → GUI 起来
```

### 第三步：安装程序完善

```
  · 安装向导（选择安装目录）
  · 桌面快捷方式
  · 卸载程序
  · 首次运行引导
```

---

## 五、必须先解决的三个问题

### 问题 1：入口脚本改造

**当前 main.js 的启动逻辑：**
```js
// 找 HARNESS_DIR = workbench/引擎数据（只有数据，没源码）
// 尝试 spawn CLI_BUILT = 引擎数据/apps/cli/lib/bin.js（不存在）
// 尝试 pnpm（失败）
```

**改造后应该是：**
```js
// HARNESS_DIR = <安装目录>/resources/app.asar.unpacked/引擎
// 直接 spawn：<安装目录>/resources/app.asar.unpacked/引擎/node.exe 
//             <引擎>/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js web
```

**关键：用自带的 node.exe，不是 Electron 的。**

### 问题 2：数据目录重定向

**当前：**
```js
env.DSH_HOME = path.join(HARNESS_DIR, '.dsh');
```

**改造后：**
```js
env.DSH_HOME = <安装目录>/数据/.dsh;
```

**这样数据独立于引擎，升级引擎不丢数据。**

### 问题 3：首次运行初始化

```
如果 数据/.dsh 不存在：
  ① 创建目录
  ② 复制模板（场景配置、技能、AGENTS.md）
  ③ 生成默认场景记忆
  ④ 然后启动引擎
```

---

## 六、体积与性能预估

### 6.1 体积

| 组件 | 体积 |
|---|---|
引擎（已裁 Office/语音） | 228 MB |
Electron 运行时 | ~180 MB |
我们的壳代码 | ~2 MB |
数据模板 | ~1 MB |
**合计** | **~411 MB** |

**可再裁：**
```
experimental 包（22.4+14.1+6.2+5.3+5.2×3 ≈ 60 MB）
→ 若裁掉，约 350 MB
```

### 6.2 安装后

```
安装包（压缩）：约 150-180 MB
安装后占用：约 411 MB
```

**对于一个自带 AI 引擎的独立 agent，这个体积是合理的。**
（对比：VS Code 约 350 MB，Cursor 约 500 MB）

---

## 七、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
**引擎依赖系统库** | 某些机器跑不起来 | 实测 koffi/node-pty/sharp 都是预编译的，应该能直接跑 |
**杀毒软件误报** | 用户装不上 | 用 electron-builder 标准打包，不混淆代码 |
**数据迁移** | 用户已有数据丢失 | 首次运行检测旧数据，提供迁移选项 |
**升级覆盖数据** | 升级后场景记忆丢失 | 数据与程序分离，升级只换程序目录 |
**端口冲突** | 3080/3083 被占用 | 自动检测可用端口 |

---

## 八、一句话

> **技术上完全可行 —— 本轮已实测：**
> **① 引擎可以从 asar 完整提取（228 MB，排除 Office/语音）**
> **② 提取后能独立运行（--version 和 web 服务都验证通过）**
>
> **要做的三件事：**
> **① 改造 main.js：引擎路径指向打包后的位置，用自带 node.exe**
> **② 数据目录重定向到安装目录下的 数据/（可移植）**
> **③ 首次运行初始化 + electron-builder 打包**
>
> **建议路径：先做目录形态的 standalone（能跑通），再打包成 exe。**
> **因为打包后调试困难，目录形态更容易定位问题。**
