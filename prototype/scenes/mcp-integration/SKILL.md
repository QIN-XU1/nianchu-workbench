---
name: mcp-integration
category: 工程
depth: deep
description: 给 agent 接 MCP（Model Context Protocol）服务器：stdio + JSON-RPC 2.0 握手、列工具、调工具、未知服务器如实报错。当用户要「让 agent 用外部 MCP 工具」时使用。
---

# MCP 集成 技能

> MCP 是「agent 与外部工具服务器」的通用协议。接错了，agent 会看到一堆不存在的工具，或握手失败却假装成功。
> 判据：**握手成功、工具清单真实、未知服务器如实报 404 —— 三件事缺一就是假集成。**

## 什么时候用

- 给 agent 挂 MCP 服务器（数据库、浏览器、内部系统）
- 评审一个 agent 产品的「MCP 支持」
- 自己实现 MCP 客户端

## 什么时候**不**用

- 工具是进程内函数（直接调，不需要协议）

## 第 1 步：传输层——stdio + JSON-RPC 2.0

MCP 最常见是 stdio：起子进程，用**按行分隔的 JSON-RPC 2.0** 通信（不是 WebSocket，不是 HTTP）。每条消息一行 JSON，`\n` 结尾。

请求：`{"jsonrpc":"2.0","id":1,"method":"...","params":{...}}`
响应：`{"jsonrpc":"2.0","id":1,"result":{...}}` 或 `{"jsonrpc":"2.0","id":1,"error":{...}}`

## 第 2 步：initialize 握手（顺序不能错）

1. 客户端发 `initialize`，带 `clientInfo`（名称/版本）与 `capabilities`
2. 服务器回 `serverInfo` + 它的 `capabilities`（能不能列工具/给资源/发通知）
3. 客户端**补发** `notifications/initialized`（通知，无 id、无响应）

漏第 3 步 = 服务器可能不进入就绪态，后续 `tools/list` 超时。

## 第 3 步：列工具与调工具

- `tools/list` → 返回 `tools[]`，每个带 `name` / `description` / `inputSchema`
- `tools/call` → 带 `name` + `arguments`，返回 `content[]`
- `inputSchema` 要能喂给模型当工具签名，否则模型不知道参数

## 反例（写下来防复发）

- ✗ 未知 serverId 却返回空工具列表（假装服务器存在但没工具）→ 必须 **404 / 明确报「没有这个服务器」**
- ✗ 跳过 `notifications/initialized` → 握手看起来成功，`tools/list` 超时
- ✗ 把 `inputSchema` 当字符串塞给模型 → 模型不会用
- ✗ 服务器进程退出没检测 → agent 卡在等响应

## 自检清单

- [ ] 手链路三步都发过（initialize / 收 serverInfo / initialized）
- [ ] 未知服务器 → 明确错误，不是空列表
- [ ] 工具签名来自 `inputSchema`，不是猜的
- [ ] 服务器崩溃能被检测（子进程 exit 事件）

## 参考实现指路

本仓库 `tools/mcp/client.mjs`：stdio + JSON-RPC 2.0、自己实现 initialize 握手、tools/list、tools/call、ping；未知 serverId 走 404 如实报。`tools/mcp/api-handler.mjs` 暴露 `POST /api/mcp`（action: probe/list/call）。

## 实测数据（本仓库，可复算）

```
node tools/mcp/client.mjs --selftest
```

实测 **10/10 PASS**（脚本自己起一个内置假 MCP server，走完整协议）：

- `initialize` 握手 → 返回 serverInfo / protocolVersion
- `tools/list` → 列出工具定义
- `tools/call` → 调用并拿到结果
- 3 条反例：协议错误 / 未知工具 / 非法参数 都要**如实报错**，不静默成功

**为什么要内置假 server**：真 server 需要外部进程与配置，会让这条验证在无人值守时变成 UNKNOWN。
内置假 server 让「协议正确性」可一条命令复算；「真 server（官方 SDK 1.32.2）」是另一层。

**教训**：**协议层验证要能脱离外部依赖**。否则你验证的其实是「环境配好了没」。
