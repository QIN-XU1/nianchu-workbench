---
name: http-caching
category: 工程
depth: deep
description: 设计 HTTP 缓存：Cache-Control、ETag/条件请求、CDN 与浏览器缓存、以及缓存失效。当用户要「浏览器缓存怎么配」「CDN 缓存」「改了看不到新版本」时使用。
---

# HTTP 缓存 技能

> HTTP 缓存和应用层缓存（Redis）不是一回事：它发生在**浏览器和 CDN**，靠响应头控制。
> 最常见的线上事故：**改了资源但用户看到旧的**（缓存没失效）或 **API 被 CDN 缓存了敏感数据**。
> 判据：**发版后，用户多久能看到新版本？会不会看到别人的数据？**

## 什么时候用

- 静态资源（JS/CSS/图片）
- API 响应缓存
- CDN 配置

## 什么时候**不**用

- 纯后端内部服务

## 第 1 步：Cache-Control 核心指令

| 指令 | 含义 |
|---|---|
| `max-age=N` | 缓存 N 秒 |
| `no-store` | 完全不缓存（敏感数据） |
| `no-cache` | 可缓存但每次要验证 |
| `private` | 只浏览器缓存（不进 CDN） |
| `public` | 可被 CDN/代理缓存 |
| `s-maxage` | CDN 缓存时间（覆盖 max-age） |
| `immutable` | 内容永不变（配长缓存） |

⛔ 用户私有数据用 `public` + CDN = 用户 A 看到用户 B 的数据。

## 第 2 步：静态资源策略（内容哈希 + 长缓存）

| 策略 | 说明 |
|---|---|
| 文件名带 hash（app.a1b2c3.js） | 内容变了文件名变 |
| `max-age=31536000, immutable` | 缓存一年 |
| HTML 不缓存 | 它引用新的 hash 文件 |

★ 这是最优组合：**hash 文件名 + 长缓存** → 新版本自动是新文件，不用手动清缓存。

## 第 3 步：条件请求（ETag / Last-Modified）

| 机制 | 说明 |
|---|---|
| ETag | 内容指纹，客户端带 `If-None-Match` |
| Last-Modified | 最后修改时间，带 `If-Modified-Since` |
| 304 | 未变，不传 body（省带宽） |

## 第 4 步：API 缓存

| 类型 | 策略 |
|---|---|
| 公开只读（配置/字典） | public, max-age |
| 用户私有 | private, no-store（或 no-cache + 验证） |
| 敏感（余额/隐私） | **no-store** |

⛔ API 默认被 CDN 缓存（有些 CDN 默认缓存 GET）= 敏感 GET 接口串数据。

## 第 5 步：失效

| 手段 | 说明 |
|---|---|
| 内容哈希 | 最优雅（不用清） |
| 版本号参数（?v=） | 手动画（易忘） |
| CDN 主动 purge | 应急，但传播慢 |
| s-maxage 短 | 让它自然过期 |

## 输出格式

**结论**：`四态: PASS | WARN | FAIL | UNKNOWN`
- PASS = 静态资源 hash+长缓存 + 敏感 no-store + 失效策略清晰
- WARN = 有缓存但敏感数据用 public
- FAIL = 敏感数据被 CDN 缓存 / 改版看不到新 / 无失效策略
- UNKNOWN = 拿不到响应头

**1. 静态资源**
| 项 | 策略 |
|---|---|
| 文件名 hash | |
| max-age | |

**2. API 缓存**
| 接口 | 类型 | Cache-Control |
|---|---|---|

**3. 失效**
| 手段 | 说明 |
|---|---|

**4. 判不了的部分**
- <拿不到的 CDN 配置>

## 假阳性清单（这些不算「缓存配好」）

- 有 max-age 但敏感数据 public
- 静态资源无 hash 长缓存
- 改版靠手动清

## 假阴性清单（最常漏的 8 类）

1. **敏感数据 public + CDN 缓存**（串数据）
2. **静态资源无 hash**（改版看不到）
3. **HTML 被缓存**（引用旧 hash）
4. **无失效策略**
5. **API 默认被 CDN 缓存**
6. **no-store 用错**（该省不省/该不存却存）
7. **ETag 不生效**（无 304）
8. **purge 传播慢以为即时**

## 本仓库可用的命令

```bash
node tools/quality/commit-gate.mjs   # 提交前门禁
```

## 与其他技能的关系

- `caching-strategy`：应用层缓存
- `secrets-management`：敏感数据不回缓存
- `release-pipeline`：资源 hash
- `cdn-design`：CDN 层

## 边界（如实说清）

- 缓存是分布式的，失效有传播延迟
- 各 CDN 默认行为不同，要显式配
- 本技能不实现，只设计
