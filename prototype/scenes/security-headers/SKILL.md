---
name: security-headers
category: 审查
depth: deep
description: 审查 HTTP 安全响应头：CSP、HSTS、X-Content-Type-Options、X-Frame-Options、Referrer-Policy、CORS，并判定配置是「缺失」还是「配错」。当用户要「安全头怎么配」「CSP 怎么写」「点击劫持」时使用。
---

# HTTP 安全头审查 技能

> 安全头最危险的不是「没配」，而是**配了但配错**：
> `X-Frame-Options: ALLOW-FROM`（已废弃，多数浏览器忽略）、
> `CORS: *` 配在带凭据的接口上（等于没防护）。
> 判据：**每个头的值，在当前浏览器上真的生效吗？**

## 什么时候用

- Web 应用上线前
- 安全扫描报了缺头
- 有 iframe/跨域/混合内容问题

## 什么时候**不**用

- 纯 API 无浏览器（但仍要 CORS）
- 内部工具且无敏感数据（可降低要求）

## 第 1 步：六个核心头

| 头 | 防什么 | 推荐值 |
|---|---|---|
| **Content-Security-Policy** | XSS/注入 | `default-src 'self'; ...`（不用 `unsafe-inline`） |
| **Strict-Transport-Security** | 降级到 HTTP | `max-age=31536000; includeSubDomains` |
| **X-Content-Type-Options** | MIME 嗅探 | `nosniff` |
| **X-Frame-Options** | 点击劫持 | `DENY` 或 `SAMEORIGIN` |
| **Referrer-Policy** | 泄露 URL | `strict-origin-when-cross-origin` |
| **Permissions-Policy** | 滥用浏览器特性 | 按需关闭 |

## 第 2 步：常见「配了但错」

| 错误 | 问题 |
|---|---|
| `X-Frame-Options: ALLOW-FROM x` | 已废弃，多数浏览器忽略 |
| CSP 含 `unsafe-inline` + `unsafe-eval` | 几乎等于没有 |
| `Access-Control-Allow-Origin: *` + 凭据 | 浏览器拒绝 / 或危险配置 |
| HSTS `max-age=0` | 等于关闭 |
| 只配 `X-Frame-Options` 不配 CSP `frame-ancestors` | 现代浏览器看 CSP |
| CORS 反射任意 Origin | 等于全开 |

## 第 3 步：CORS 特别检查（最易错）

| 检查 | 危险信号 |
|---|---|
| 是否反射 `Origin` 头 | `Allow-Origin: <请求的Origin>` = 任意域可访问 |
| 是否带 `Allow-Credentials: true` | 与反射组合 = 严重 |
| 预检 `Allow-Methods` | 是否过宽 |

⛔ 「动态回显 Origin」是常见懒法，等于对所有站点开放。

## 第 4 步：验证方法

| 手段 | 查什么 |
|---|---|
| 浏览器 DevTools Network | 看实际响应头 |
| 安全头扫描（observatory 等） | 缺/错 |
| 手动构造跨域请求 | CORS 是否真生效 |
| 真浏览器测 iframe | 点击劫持防住没 |

## 输出格式

**结论**：`四态: PASS | WARN | FAIL | UNKNOWN`
- PASS = 六头齐全且值正确
- WARN = 缺非关键头（Permissions-Policy 等）
- FAIL = CSP 含 unsafe / CORS 反射+凭据 / 关键头缺
- UNKNOWN = 拿不到实际响应头

**1. 核心头**
| 头 | 现状值 | 判定 |
|---|---|---|

**2. 配错检查**
| 检查 | 结果 |
|---|---|
| CSP 无 unsafe | |
| HSTS max-age>0 | |
| CORS 非反射 | |

**3. 验证**
| 手段 | 做了吗 |
|---|---|

**4. 判不了的部分**
- <哪些响应头未实测>

## 假阳性清单（这些不算「配了安全头」）

- 有 CSP 但含 unsafe-inline
- X-Frame-Options ALLOW-FROM
- CORS 反射任意 Origin

## 假阴性清单（最常漏的 8 类）

1. **CSP 含 unsafe-inline/eval**
2. **CORS 反射 Origin + 凭据**
3. **X-Frame-Options ALLOW-FROM**（废弃）
4. **HSTS max-age=0**
5. **只配 X-Frame-Options 不配 CSP frame-ancestors**
6. **nosniff 缺失**
7. **Referrer-Policy 缺失**（泄露 URL）
8. **只测主域不测子域**

## 本仓库可用的命令

```bash
node tools/quality/commit-gate.mjs   # 提交前门禁
```

## 与其他技能的关系

- `security-review`：整体安全（本技能是响应头）
- `input-validation`：XSS 的输入侧
- `threat-model`：威胁面
- `release-gate`：发布前检查

## 边界（如实说清）

- 安全头不能替代输入校验/输出编码
- 有些头需按业务调整（CSP 太严会破功能）
- 本技能只查头，不改应用逻辑
