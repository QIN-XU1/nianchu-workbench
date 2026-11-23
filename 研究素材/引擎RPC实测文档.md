# DSH 引擎 RPC API 实测文档

> 实测时间：2026-11-11
> 用途：自己实现主 Agent 对话界面（方向 C）的依据
> 所有结论都是**实际调通**的，不是猜的

---

## 一、基本信息

| 项 | 值 |
|---|---|
| 引擎端口 | 3083 |
| RPC 端点 | `POST /api/<method>` |
| Content-Type | `application/json; charset=utf-8` |

### 请求体格式

```json
{
  "type": "client-request",
  "rpcId": "<唯一id>",
  "method": "<channel>/<endpoint>",
  "payload": { "args": { ... } }
}
```

⚠ `method` 必须是**完整路径**（如 `session/list`，不能只写 `list`）。

### 响应格式

```json
{
  "type": "server-response",
  "rpcId": "<原样返回>",
  "result": {
    "ok": true,
    "value": { ... }
  }
}
```

失败时：
```json
{
  "result": {
    "ok": false,
    "error": {
      "code": "gateway/arguments-invalid",
      "message": "typert gateway: ...",
      "details": { "endpoint": "...", "field": "..." }
    }
  }
}
```

---

## 二、认证（最容易踩的坑）

### 引擎返回 401 时先看这里

**cookie 名是动态的 `dsh-auth-<hash>`，不是固定的 `token` 或 `dsh_session`。**

获取方式：
```
GET /?token=<TOKEN>
→ 从响应的 Set-Cookie 头里取
```

实测：
```
cookie: dsh-auth-pPyMfRema1gy6ow1MQJ0rU0OVqimJtW...
```

用这个 cookie 请求 `session/list` → 200。

⚠ **token 每次引擎重启都会变**。要从 `外壳/server.log` 里取最新的：
```
[token] captured: <TOKEN>
[out] dsh web: http://127.0.0.1:3083/?token=<TOKEN>
```

### 必需的请求头

```
Cookie: <上面拿到的 dsh-auth-xxx>
Origin: http://127.0.0.1:3083
Content-Type: application/json; charset=utf-8
```

---

## 三、会话列表：`session/list`

### 参数

```json
{ "_request": {} }
```

⚠ 注意字段名是 **`_request`**（下划线开头）。

### 返回

```json
{
  "ok": true,
  "value": {
    "items": [
      {
        "sessionId": "session-6900e7b4-cb82-42f3-8c66-9a166cfaaec6",
        "updatedAt": 1794352327964,
        "agentAvailable": false,
        "formatStatus": "current",
        "running": false,
        "blank": false,
        "cwd": "D:\\...\\场景记忆\\自我复盘",
        "projections": {
          "kind": "cached",
          "asOfSeq": 3,
          "values": {
            "userQuestions": { "active": [], "settled": [] },
            "tokenUsage": {
              "uncachedInputTokens": 21286,
              "outputTokens": 1034,
              "cacheReadTokens": 11904,
              "cacheWriteTokens": 0
            },
            "title": "场景记忆填充：自我复盘",
            "goal": null,
            "agentPreset": "standard",
            "modelSelection": {
              "lastUsed": { "provider": "pursueray", "model": "deepseek-v4-pro" },
              "next": { "provider": "pursueray", "model": "deepseek-v4-pro" }
            },
            "workingDirectory": "D:\\...",
            "inbox": { "next-turn": [], "next-step": [] },
            "permissions": { "currentValue": "workspace-write" },
            "subagentCatalog": [],
            "subagentTiming": { "settledMs": 0 },
            "subagent": null,
            "plan": { "active": false, "pending": false },
            "sessionListMetadata": {
              "blank": false,
              "lastPromptAt": 1794314903591
            }
          }
        }
      }
    ]
  }
}
```

**有用的字段：**
- `sessionId` ← 唯一 id
- `title`（在 projections.values 里）← 会话标题
- `blank` ← 是否空会话
- `running` ← 是否正在跑
- `projections.values.tokenUsage` ← token 用量
- `projections.values.modelSelection.next` ← 当前模型

---

## 四、取对话历史：`session/page` ★ 最关键的接口

### 参数（踩了很久才试对）

```json
{
  "request": {
    "address": {
      "kind": "session",
      "sessionId": "session-xxx"
    }
  }
}
```

### 三个关键坑

1. **字段名是 `request`，不是 `_request`**
   - `session/list` 用 `_request`
   - `session/page` 用 `request`
   - **同一个 API 里不一致**，这是最容易踩的

2. **`address` 是对象，不是字符串**
   ```json
   ✗ { "request": { "sessionId": "..." } }
   ✓ { "request": { "address": { "kind": "session", "sessionId": "..." } } }
   ```

3. **`address.kind` 有多个变体**
   - `{ kind: 'session', sessionId }`
   - `{ kind: 'subagent', parentSessionId, childSessionId, mode }`（子 agent 会话）

### 返回

```json
{
  "ok": true,
  "value": {
    "cursor": 35,
    "records": [
      {
        "type": "event",
        "event": {
          "type": "permission/preset",
          "seq": 0,
          "time": 1794314903330,
          "data": { "preset": "workspace-write" }
        }
      },
      {
        "type": "event",
        "event": {
          "type": "agent/inbox/spliced",
          "seq": 4,
          "time": 1794314903337,
          "data": {
            "target": "next-turn",
            "start": 0,
            "inserted": [
              { "content": [ { "type": "text", "text": "..." } ] }
            ]
          }
        }
      }
    ],
    "hasMore": false
  }
}
```

**`session/events` 和 `session/page` 返回格式相同**，都可以用。

### 已知的 event 类型（全部实测过）

| type | data 字段 | 用途 |
|---|---|---|
| `permission/preset` | `{preset}` | 权限预设 |
| `sandbox/mode` | `{mode}` | 沙箱模式 |
| `approval/policy` | `{policy}` | 审批策略 |
| `model/selection` | `{provider, model}` | 模型选择 |
| `agent/inbox/spliced` | `{target, start, inserted}` | 注入消息 |
| **`turn/start`** | `{turn}` | 一轮开始 |
| **`step/start`** | `{turn, step}` | 一步开始 |
| **`user/message`** | `{content, source, role, id}` | 用户消息 |
| `system/message` | `{turn, step, message}` | 系统消息（含 system prompt）|
| `request/header` | `{header, reason}` | 请求头 |
| `request/context` | `{provider, model, contextWindow}` | 上下文窗口 |
| `session/title` | `{title, messageSeqs, source}` | 会话标题 |
| `session/title-llm-request` | `{titleProvider, messageSeqs, route, system, messages, maxTokens}` | 生成标题的请求 |
| **`assistant/message`** | `{turn, step, message, usage, stream}` | **AI 回复（含流式）** |
| **`tool/call`** | `{turn, step, callId, name, arguments}` | 工具调用 |
| **`tool/result`** | `{turn, step, message, meta}` | 工具结果 |
| `step/end` | `{turn, step}` | 一步结束 |
| **`turn/end`** | `{turn, reason: {kind}}` | **一轮结束 ← 判断回复完成的依据** |

### 🔑 `assistant/message` 的 stream 字段 —— ⚠ 实测：**做不到逐字打字**

```json
{
  "turn": 1,
  "step": 1,
  "message": {
    "role": "assistant",
    "content": [
      { "type": "reasoning", "text": "..." },
      { "type": "tool-call", "id": "...", "name": "read", "arguments": "{...}" },
      { "type": "text", "text": "..." }
    ]
  },
  "usage": { "inputTokens": 10108, "outputTokens": 85, "totalTokens": 10449 },
  "stream": [
    { "type": "chunk", "chunk": { "type": "block-start", "index": 0, "blockType": "reasoning" } },
    { "type": "reasoning-chunks", "index": 0, "texts": ["..."], "dt": [] },
    { "type": "chunk", "chunk": { "type": "block-start", "index": 1, "blockType": "text" } },
    { "type": "text-chunks", "index": 1, "texts": ["现在 19:34"], "dt": [] },
    { "type": "chunk", "chunk": { "type": "block-end", "index": 1 } }
  ]
}
```

#### ❌ 为什么做不了打字机效果（2026-11-11 实测更正）

**之前我以为 `stream.dt[]` 是每段文本的毫秒偏移，可以按它回放成打字机。实测证明不行：**

```
seq=29  text-chunks: texts=1 段, dt=0 个
        前 8 段: ["现在 19:34"]
        总时长: 0ms  总字数: 8
seq=39  text-chunks: texts=1 段, dt=0 个
        前 8 段: ["好的"]
        总时长: 0ms  总字数: 2
```

**结论：`session/page` 返回的是「已经完成的整条消息」**，`texts` 只有 1 段（整段文本），`dt` 是空数组。

也就是说：引擎把流式过程聚合完了才写进事件日志，**我们拿不到中间状态**。

#### ✅ 能做和不能做的

| 想做的效果 | 能不能做 | 原因 |
|---|---|---|
逐字打字机（按引擎时序）| ❌ | `dt` 是空的，没有分片时序 |
逐字打字机（自己编时序）| ⚠️ 技术上能 | 但那是假动画，不是真实生成速度 |
一次性显示 + 淡入 | ✅ | 可以 |
「模型正在思考」的等待动画 | ✅ | 用 `turn/start` / `step/start` / `tool/call` 事件驱动 |
显示工具调用过程 | ✅ | `tool/call` 事件是实时的 |

**所以正确的做法是：**
- 等 `turn/end` 拿到完整回复 → 显示（带淡入）
- 过程中用 `step/start` / `tool/call` 事件显示「模型在干什么」
- **不要假装在做流式**，那会骗用户

#### `stream` 数组的结构（虽然做不了打字机，但知道结构没坏处）

- `type: 'chunk'` + `chunk: { type: 'block-start'|'block-end', index, blockType }` —— 块边界
- `type: 'reasoning-chunks'` —— 推理文本（`texts[]` 是分段的，但实测只有 1 段）
- `type: 'text-chunks'` —— 正文文本（同上）

---

```json
{ "turn": 1, "reason": { "kind": "completed" } }
```

**这是最可靠的完成判据**：轮询到 `turn/end` 就说明这一轮结束了。

`reason.kind` 的可能值（待补全实测）：
- `completed` —— 正常完成
- 其他：可能是 `error` / `cancelled` / `tool-limit` 等

### 🔑 `turn/end` —— 判断「AI 回复完了」

```json
{ "turn": 1, "reason": { "kind": "completed" } }
```

**这是最可靠的完成判据**：轮询到 `turn/end` 就说明这一轮结束了。

`reason.kind` 的可能值：
- `completed` —— 正常完成（实测确认）
- 其他值未实测（可能是 `error` / `cancelled` / `tool-limit`）

**这就是自研界面唯一能用的「回复完成」信号** —— 因为我们拿不到流式，
只能等这一轮结束。

### `tool/call` / `tool/result` —— 工具调用展示

```json
// tool/call
{ "turn": 1, "step": 1, "callId": "call_00_xxx", "name": "read",
  "arguments": "{\"file_path\":\"D:\\\\...\"}" }    // ← 注意是 JSON 字符串，要二次 parse

// tool/result
{ "turn": 1, "step": 1,
  "message": { "role": "tool",
    "content": [ { "type": "text", "text": "<path>D:\\...</path>\n<type>file</type>\n..." } ] },
  "meta": { ... } }
```

**这对自研界面很重要**：可以把「AI 在做什么」实时展示出来（读了哪个文件、改了哪个文件）。

---

## 五、发消息：`session/prompt`

### 参数

```json
{
  "request": {
    "requestId": "ma-<时间戳>-<随机>",
    "sessionId": "session-xxx",
    "mode": "queue",
    "content": [
      { "type": "text", "text": "用户说的话" }
    ]
  }
}
```

⚠ 字段名是 **`request`**（不是 `_request`）。

### 说明

- `mode: 'queue'` —— 排到当前回合后
- 这个方法**是同步返回的**，只返回「已接受」，**不返回 AI 回复**
- AI 回复要通过 `session/page` 轮询拿

---

## 六、⚠ 最重要的限制：没有服务端推送

### 实测结果

```
/api/events        → 404
/api/stream        → 404
/api/sse           → 404
/api/session/events → 404（这个是 RPC 方法，不是 HTTP 端点）
/api/notifications → 404
/api/subscribe     → 404
```

**引擎只有「请求-响应」式 RPC，没有 SSE / WebSocket 推送。**

### 对自研主 Agent 界面的影响

**必须轮询**：
```
1. session/prompt 发消息
2. 每 500ms 调 session/page 取最新事件
3. 对比 cursor / seq，只处理新增的
4. AI 回复完成（如何判断？待测）后停止轮询
```

**待测问题：**
- 怎么判断「AI 回复完了」？
  - 可能看 `session/list` 的 `running` 字段
  - 或看 event 里有没有 `turn/end` 之类的类型
- 流式输出能不能拿到中间状态？
  - 如果不能，只能等完整回复

---

## 七、其他有用的 RPC（待测）

| 方法 | 用途 | 状态 |
|---|---|---|
| `session/create` | 新建会话 | 待测（参数 `{ request: { cwd } }`） |
| `session/selectModel` | 切模型 | 待测 |
| `session/modelCatalog` | 模型列表 | 待测（有 `groups[]` 和 `routableProviders[]`） |
| `scenarios/list` | 场景列表 | 已用（工作台侧） |
| `settings/update` | 改设置 | 待测 |

---

## 八、给自研主 Agent 界面的建议架构

```
┌─────────────────────────────────────────┐
│  自研对话界面（不用引擎 UI）              │
│                                          │
│  ┌────────────────────────────────────┐ │
│  │ 消息列表                            │ │
│  │  [用户] xxx                         │ │
│  │  [AI]   xxx（流式/一次性）           │ │
│  └────────────────────────────────────┘ │
│  ┌────────────────────────────────────┐ │
│  │ 输入框                    [发送]    │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
          ↓ IPC
┌─────────────────────────────────────────┐
│  主进程（main.js）                       │
│                                          │
│  engine:prompt  → session/prompt        │
│  engine:page    → session/page          │
│  （新增）轮询 + 事件广播                  │
│    ipcMain → webContents.send('ma:event')│
└─────────────────────────────────────────┘
          ↓ HTTP
┌─────────────────────────────────────────┐
│  DSH 引擎 (127.0.0.1:3083)              │
└─────────────────────────────────────────┘
```

**关键设计点：**
1. 轮询放**主进程**（渲染层不直接 HTTP，避免 CORS / cookie 问题）
2. 主进程用 `webContents.send` 推给渲染层
3. 渲染层只负责显示和输入

---

## 九、复现脚本

```bash
# 完整验证：拿 cookie → 列会话 → 取历史
node prototype/probe-address.mjs

# 完整流程验证：建会话 → 发消息 → 轮询 → 拿到回复
node prototype/test-full-flow.mjs
```

### 完整流程实测结果（2026-11-11）

```
会话: session-b260edda-83ed-4c13-b1f4-7c7c83efa236

=== 发送消息 ===
  耗时: 15ms  status=200
  返回: {"ok":true,"value":{"accepted":true}}

=== 轮询 session/page（每 800ms）===
  第1轮: cursor=16 新增 16 个事件
  第5轮: cursor=19 新增 3 个事件
    ★ assistant/message: "收到消息"
    ★ turn/end: {"turn":1,"reason":{"kind":"completed"}}

总耗时: 4.1s, 轮询 5 次, done=true
```

**结论：**
- `session/prompt` 立即返回 `{accepted: true}`（不等 AI）
- `session/page` 轮询能拿到新增事件
- **`turn/end` 是可靠的完成判据**
- 简单问答 4.1 秒拿到结果

---

## 十、新建会话：`session/create`

```json
{ "request": { "cwd": "D:/.../场景记忆/中枢" } }
```

返回：
```json
{ "ok": true, "value": { "sessionId": "session-xxx", "agentPreset": "standard" } }
```

⚠ 字段名 **`request`**（不是 `_request`）。

---
