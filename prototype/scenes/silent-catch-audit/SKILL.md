---
name: silent-catch-audit
category: 审查
depth: deep
description: 审计静默吞异常（空 catch），要求每处写明为什么吞掉可接受，用片段匹配白名单防漂移。当用户要"别把异常悄悄吞了"时使用。
---

# 静默吞异常审计 技能

> `catch {}` 什么都不做，是最隐蔽的 bug 藏身处：出错了却当成功，问题被吞掉。
> 判据：**每个空 catch，都能说出「为什么吞掉是安全的」吗？说不出就该改。**

## 什么时候用

- 代码里有大量 try/catch
- 要评审「错误处理是否诚实」
- 排查「明明失败却当成功」

## 什么时候**不**用

- 明确要忽略的清理路径（但也要写明理由）

## 第 1 步：扫描所有空 catch

找出「catch 块体为空或只有注释」的位置。**只报位置不够，要能定位到第几个**。

## 第 2 步：每处必须有理由

可接受的理由举例：

- 关闭已断开的连接（无可补救）
- 清理临时目录失败不阻塞主流程
- 尽力写错误响应（连接可能已断）

不可接受的理由：「忽略」「不太可能」「先这样」。

## 第 3 步：白名单用「片段匹配」，不用行号

- 用 `{file, snippet, nth}` 定位，**插入/删除行不会漂移**
- 白名单条目要带 `reason`
- 白名单也要检查**过期项**（代码删了但白名单还在）

## 反例（写下来防复发）

- ✗ 用行号做白名单 → 加一行就全错位
- ✗ 理由写「忽略」 → 等于没写
- ✗ 只加白名单不查过期 → 白名单腐化
- ✗ 吞掉异常后返回默认值当成功 → 假绿

## 自检清单

- [ ] 扫出所有空 catch
- [ ] 每处有具体理由（非「忽略」）
- [ ] 白名单用片段匹配 + nth
- [ ] 检查过期白名单项

## 参考实现指路

本仓库 `tools/quality/scan-silent-catch.mjs`（片段匹配 + 未解释/过期统计）+ `tools/quality/silent-catch-whitelist.json`（每条带 reason）+ `tools/quality/verify-silent-catch-whitelist.mjs`（性质验证：插入行不漂移、恢复后回基线）。

## 实战记录（本仓库真实事件，2026-11-22）

**事件**：我给几个 verify 脚本加「自起服务」助手 `tools/workbench/_serve.mjs`，里面写了

```js
try { child.kill(); } catch { /* ignore */ }
```

项目自己的 `tools/quality/scan-silent-catch.mjs` 立刻判「**未解释的空 catch** 1 个」。

**连锁后果**：`commit-gate` 因此 `exit 1` → `verify-commit-gate` 7/3 FAIL、
`verify-silent-catch-whitelist` 1/3 FAIL。**我写的新代码把门禁搞红了。**

**修法**：在 `tools/quality/silent-catch-whitelist.json` 加一条，写明理由：

```json
{ "file": "tools/workbench/_serve.mjs", "snippet": "} catch { /* ignore */ }", "nth": 0,
  "reason": "kill 自起的 serve 子进程失败无可补救（进程可能已自行退出），吞掉不影响测试结果" }
```

**复算**：`node tools/quality/scan-silent-catch.mjs`（45 白名单 · 未解释 0 · 过期 0）。

**教训**：**"我知道这里可以忽略" ≠ "审计器知道"**。只要吞异常，就必须把理由写进白名单；
否则后人（或 CI）会把它当缺陷。这条纪律对**自己新写的代码**同样适用。
