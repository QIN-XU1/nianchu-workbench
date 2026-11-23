---
name: grpc-design
category: 工程
depth: deep
description: 设计 gRPC 服务：proto 演进、超时、流式、以及和 REST 的取舍。当用户要「gRPC 怎么用」「proto 兼容」「微服务通信」时使用。
---

# gRPC 设计 技能

> gRPC 的优势：**强类型 proto、高性能二进制、流式**。代价：**浏览器支持弱、调试难、proto 兼容要小心**。
> 判据：**改 proto 会不会让老客户端解析失败？**

## 什么时候用

- 服务间通信（内网高性能）
- 需要流式
- 强类型契约

## 什么时候**不**用

- 对外浏览器 API（REST 更合适）
- 简单场景

## 第 1 步：proto 演进（兼容性）

| 改动 | 兼容？ |
|---|---|
| 加字段（新编号） | ✅ |
| 删字段 | ✅ 但要用 `reserved` 占位（防复用编号） |
| 改字段编号 | ❌ 破坏 |
| 改字段类型 | ❌ 多半破坏 |
| 复用已删编号 | ❌ 数据错乱 |

★ **绝不重用字段编号**：删了字段要用 `reserved 5;` 标记，防止将来有人复用 5 号导致解析错乱。

## 第 2 步：超时与重试

| 项 | 要求 |
|---|---|
| **必须设 deadline** | gRPC 默认无超时（会挂死） |
| 重试 | 只重试幂等/瞬时 |
| 截止传播 | 上游 deadline 传到下游 |

⛔ 不设 deadline = 一个慢调用挂死连接。

## 第 3 步：流式

| 类型 | 说明 |
|---|---|
| 服务端流 | 服务端推多条 |
| 客户端流 | 客户端推多条 |
| 双向流 | 都有 |

流式要注意：背压、取消传播、流中断处理。

## 第 4 步：与 REST 对比

| 维度 | gRPC | REST |
|---|---|---|
| 性能 | 高（二进制） | 中（JSON） |
| 浏览器 | 弱（要 grpc-web） | 好 |
| 契约 | proto 强类型 | OpenAPI |
| 调试 | 难（二进制） | 易（curl） |
| 流式 | 原生 | SSE/WS |

## 第 5 步：其他

| 项 | 说明 |
|---|---|
| 负载均衡 | L7 需懂 gRPC（HTTP/2） |
| 错误码 | 用 gRPC status code |
| 拦截器 | 认证/日志/追踪 |

## 输出格式

**结论**：`四态: PASS | WARN | FAIL | UNKNOWN`
- PASS = proto 兼容（reserved）+ deadline + 重试合理
- WARN = 有 gRPC 但无 deadline
- FAIL = 复用字段编号 / 无超时 / 改类型不兼容
- UNKNOWN = 拿不到 proto

**1. proto 兼容**
| 项 | 有吗 |
|---|---|
| 加字段新编号 | |
| 删用 reserved | |
| 不重用编号 | |

**2. 超时**
| 项 | 值 |
|---|---|
| deadline | |
| 重试 | |

**3. 判不了的部分**
- <拿不到的 proto>

## 假阳性清单（这些不算「gRPC 好」）

- 有 proto 但无 deadline
- 删字段不 reserved
- 复用编号

## 假阴性清单（最常漏的 8 类）

1. **复用字段编号**（解析错乱）
2. **删字段不 reserved**
3. **无 deadline**（挂死）
4. **改类型不兼容**
5. **流式无背压**
6. **重试非幂等**
7. **L7 LB 不懂 gRPC**
8. **错误码用 HTTP 码**

## 本仓库可用的命令

```bash
node tools/quality/commit-gate.mjs   # 提交前门禁
```

## 与其他技能的关系

- `api-contract`：契约
- `api-versioning`：版本
- `retry-strategy`：重试
- `http-caching`：REST 缓存

## 边界（如实说清）

- gRPC 浏览器支持需 grpc-web 代理
- 调试工具不如 REST 成熟
- 本技能不实现，只设计
