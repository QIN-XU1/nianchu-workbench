---
name: ws-jsonrpc
category: 工程
depth: deep
description: 用 WebSocket 跑 JSON-RPC 2.0 交互通道：请求-响应配对、id 关联、未知方法回 -32601、错误不假装成功。当用户要"实时交互通道"时使用。
---

# WebSocket JSON-RPC 技能

> 实时交互（运行、取消、注入）走 WS 比轮询 HTTP 合适。但 WS 是双向的，请求-响应配对做不好就乱套。
> 判据：**每个请求都能按 id 找回响应吗？未知方法会不会被当成成功？**

## 什么时候用

- 要做实时/长连接交互
- 要评审「WS 通道可用」这类声明
- 出现「发了请求收不到响应」

## 什么时候**不**用

- 纯请求-响应、无实时需求（HTTP 够了）

## 第 1 步：JSON-RPC 2.0 报文格式

请求：`{jsonrpc:'2.0', id, method, params}`
响应：`{jsonrpc:'2.0', id, result}` 或 `{jsonrpc:'2.0', id, error:{code,message}}`

`id` 必须回显，否则调用方无法配对。

## 第 2 步：id → pending 映射 + 超时

- 每发一个请求，把 `id` 存进 `pending` map，带一个超时定时器
- 收到响应按 `id` 取出 resolve/reject，清定时器
- 超时未回 → reject（不能无限等）

## 第 3 步：未知方法必须报错（-32601）

调一个不存在的方法，必须返回 `error.code = -32601`（Method not found），**不能静默成功或挂起**。

## 第 4 步：错误不假装成功

`result` 与 `error` 二选一。有 `error` 就是失败，调用方不能把「有 result 字段」当成功。

## 反例（写下来防复发）

- ✗ 不回显 id → 并发请求张冠李戴
- ✗ 未知方法挂起不返回 → 调用方一直等
- ✗ 未知方法返回空 result → 假装成功
- ✗ 没有超时 → 网络断了永远等

## 自检清单

- [ ] 报文符合 JSON-RPC 2.0
- [ ] id 回显且 pending 配对
- [ ] 有超时
- [ ] 未知方法 -32601
- [ ] error 与 result 互斥

## 参考实现指路

本仓库 `tools/workbench/verify-ws-e2e.mjs`（真连 ws://127.0.0.1:47124/ws 发 JSON-RPC，10 项）；`tools/agent/verify-alias.mjs` 里「★反例：不存在的方法名如实报错（不假装成功）」。

## 实战记录（本仓库真实事件，2026-11-22）

**事件**：`tools/agent/verify-alias.mjs` 明明已经跑完并打印了 `四态: PASS`（4 通过 / 0 失败），
但进程最终 `exit 2`，并且又打印了一行 `❔ 连不上 ws://...` / `四态: UNKNOWN`。

**根因**：脚本末尾先 `ws.close()`，**close 触发了 `onerror`**；而 `onerror` 是无条件
`console.log + process.exit(2)`——把刚算出的 PASS 结果覆盖掉了。

**修法**：加一个「已完成」标志，让 `onerror` 在完成后直接 return：

```js
let _done = false;
ws.onerror = () => {
  if (_done) return;      // 主流程已完成，close() 触发的 onerror 不应覆盖结果
  console.log('  ❔ 连不上 ' + WS_URL);
  console.log('  四态: UNKNOWN');
  process.exit(2);
};
// ... 主流程末尾：
ws.close();
_done = true;
```

**复算**：`node tools/agent/verify-alias.mjs`（修后 `exit 0`，4/0 PASS）。

**教训**：**`close()` 会触发 `onerror`**。任何在 `onerror`/`onclose` 里写「退出码」的代码，
都必须先判断「是不是已经出结果了」，否则会用异常路径覆盖正常路径。
