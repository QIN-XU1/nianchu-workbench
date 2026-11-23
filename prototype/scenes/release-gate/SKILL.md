---
category: 审查
name: release-gate
description: 提交/交付前的四态门禁检查（残留、体量、文档、矩阵绑定、诚实、目标）。当用户要「提交前检查」「跑一遍门禁」或准备收尾时使用。
---

# 发布门禁

**时机**：commit 前、向用户汇报前。

**命令**（任一 FAIL 停止修复）：
0. `node tools/quality/preflight.mjs` —— **前置探活**：跑任何依赖服务的验证前先确认 47124 健康（第 104 轮教训：服务重启窗口里跑验证会得到假失败）
1. `node tools/quality/scan-mutation-residue.mjs`
2. `node tools/quality/size-guard.mjs`
3. `node tools/quality/verify-docs.mjs`
4. `node prototype/agent-ui/verify-matrix-binding.mjs`
5. `node prototype/hermes-agents/audit-matrix-honesty.mjs`
6. `node prototype/hermes-agents/verify-goal.mjs`
7. `node tools/quality/audit-doc-numbers.mjs`（配套 `.selftest.mjs`）
8. `node tools/skills/verify-index.mjs`
9. `node tools/workbench/verify-http-e2e.mjs`（需起 `serve.mjs`）
10. `node tools/workbench/verify-ws-e2e.mjs`（需起 `serve.mjs`）
11. `node tools/skills/doctor.mjs`
12. `node tools/skills/evolve.mjs snapshot`（改 skill 后执行）

**标准**：全 PASS 或可解释的合法 UNKNOWN。禁止“先提交再修”。

**特例与陷阱**：
- 修改台账后须跑 `node tools/quality/verify-docs.mjs --fix` 同步 README 条数。
- `size-guard` 报错时拆模块，严禁加白名单。
- `audit-doc-numbers` 校验文档计数与代码实测一致，防隐性错误。
13. `node tools/skills/verify-deep-skills.mjs` —— 深度技能可执行性（命令/技能引用必须真实存在）
14. `node tools/skills/verify-release-pipeline.mjs` —— 发布流水线技能真跑（含文档数字过期反例）
15. `node tools/skills/verify-release-rollback.mjs` —— 回滚演习（临时 git 仓库真回滚一次）
16. `node tools/skills/verify-release-postdeploy.mjs` —— 发布后验证（需起 serve.mjs；冒烟/数字核对/用户流程+反例）
17. `node tools/workbench/verify-api-error-contract.mjs` —— /api 错误语义（错误请求须 4xx JSON，非 200/HTML）
18. `node tools/quality/scan-ok-inner-inconsistency.mjs` —— 「外层 ok:true / 内层失败」反模式（每处须白名单写理由）
19. `node tools/workbench/verify-plugin-run-error.mjs` —— 插件跑失败须 500+ok:false（桩注入，确定性）
20. `node tools/quality/scan-silent-catch.mjs` —— 静默吞异常（API 层空 catch 须白名单写理由）
21. `node tools/memory/verify-bulk-corrupt.mjs` —— 记忆库损坏必须拒绝继续（不得用空库覆盖）
22. `node tools/evolve/audit-verdict-real-only.mjs` —— 判定在「仅 REAL」口径下是否仍成立（防二手撑结论）
23. `node tools/evolve/scan-mixed-evidence.mjs` —— REAL 格里有没有「自家文件当对手证据」的错引
24. `node tools/quality/verify-silent-catch-whitelist.mjs` —— 静默 catch 白名单不漂移（插行仍绿 / 真删必红）
25. `node tools/evolve/verify-dim-manifest.mjs` —— 31 维逐维真跑验收（显式登记表，非关键词猜测；约数分钟，slow 项失败会重试一次并打印）
26. `node tools/quality/commit-gate.mjs` —— 提交前门禁（4 项快检查）；已装 git hook，带红提交会被 git 拦下（第 111 轮两次带红提交的教训）
