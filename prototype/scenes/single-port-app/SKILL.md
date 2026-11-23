---
name: single-port-app
category: 工程
depth: deep
description: 把桌面应用做成「一份软件」：单进程单端口同时提供页面/API/WebSocket，数据在平台用户目录。当用户要"别起两个服务"时使用。
---

# 单端口一份软件 技能

> 「前端一个进程 + 后端一个进程」是常见的两进程形态。但用户装的是一个软件，不是两个服务。
> 判据：**同一个端口，能同时给出页面、API、WebSocket 吗？数据在用户目录而不是仓库里吗？**

## 什么时候用

- 设计桌面/本地 Web 应用
- 要评审「一份软件」这类声明
- 出现「用户要先起服务再用」

## 什么时候**不**用

- 纯库、纯 CLI（无界面）

## 第 1 步：一个 node 进程，一个端口

启动器只起**一个** node 进程（`serve.mjs`），它同时负责：

- `GET /` → 返回页面 HTML
- `/api/*` → JSON 接口
- `/ws` → WebSocket（实时交互）

判据：**同端口**。不是「8080 前端 + 47124 后端」。

## 第 2 步：数据放平台用户目录

- Windows：`%APPDATA%`
- macOS：`~/Library/Application Support`
- Linux：`$XDG_DATA_HOME` 或 `~/.local/share`

**不写进仓库目录**——否则换机器/换用户就乱，且会被 git 跟踪。

## 第 3 步：自报能力清单

服务提供 `/api/host-status`，返回 `singleProcess: true` 与 `implemented` 方法清单。这样「是不是一份软件」是可查的，不是自说自话。

## 反例（写下来防复发）

- ✗ 前端 8080 + 后端 47124 两个进程 → 用户要起两个
- ✗ 数据写在仓库 `./data` → 换机器丢、被 git 跟踪
- ✗ 只有 HTTP 没有 WS → 实时交互要另起通道
- ✗ 自报 singleProcess 但实际起了两个进程 → 自报不可信

## 自检清单

- [ ] 一个 node 进程
- [ ] 同端口提供 页面/API/WS
- [ ] 数据在平台用户目录
- [ ] `/api/host-status` 自报 singleProcess + 方法清单
- [ ] 不依赖 8080 上的独立宿主

## 参考实现指路

本仓库 `tools/workbench/serve.mjs`（单进程：页面 + /api/* + /ws 都在 47124，数据在 USER_DATA_DIR）；`tools/agent/verify-single-process.mjs`（自起服务后真验 15 项，含「不依赖 8080 独立宿主」反例）。

## 实测数据（本仓库，可复算）

```
node tools/agent/verify-single-process.mjs
```

实测 **15 通过 / 0 失败**，且脚本会**自己起服务**再验（不依赖人工先启动）：

- `GET /` → 200，返回 HTML（含 root 挂载点）
- `GET /api/host-status` → `singleProcess: true`，`implemented` 共 **91 个方法**
- `WS /ws` → 握手成功；发未知方法返回 JSON-RPC `-32601`（如实报错，不假装成功）
- 反例：`8080` 端口即使没有独立宿主也必须通过（证明不是两进程）
- 数据目录断言：源码里 `APPDATA` / `Application Support` / `XDG_DATA_HOME` 三个平台分支都在

**为什么这条要「自起」而不是「要求外部已起」**：早期版本要求人工先跑 serve，结果在 CI/无人值守时
它只能报 UNKNOWN。改成自起后才真正可一条命令复算。

**教训**：**「一份软件」是结构属性，但验证它需要真的把它跑起来**——只读源码只能证明「写了同端口」，证明不了「真的同端口」。
