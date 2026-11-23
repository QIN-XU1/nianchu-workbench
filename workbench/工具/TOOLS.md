# 工具注册表

> 由 `工具/tools.mjs` 自动生成。手改会被覆盖。

共 95 个工具。

## L1 · 工作台工具

| 工具 | 类型 | 行数 | 用途 |
|---|---|---|---|
| `_共用-场景记忆.mjs` | 库 | 36 | 场景记忆 · 路径解析（公开模板版） |
| `场景记忆.mjs` | CLI | 621 | 场景记忆 v2 · 统一工具（2026 |
| `发布前检查.mjs` | 脚本 | 42 | 发布前检查.mjs |
| `发消息.mjs` | 脚本 | 51 | 发消息.mjs |
| `封装.mjs` | CLI | 169 | 封装.mjs |
| `mem-init.mjs` | 脚本 | 158 | 记忆初始化 |
| `mem-map.mjs` | 脚本 | 211 | 补全记忆地图 |
| `platform-init.mjs` | 脚本 | 127 | L0 平台层初始化 |
| `scene-validate.mjs` | CLI | 287 | 技能/场景质量验证器 |
| `sceneflow.mjs` | CLI | 489 | Sceneflow |
| `tools.mjs` | CLI | 175 | L1 执行层 |

## L6 · 验证探针

| 工具 | 类型 | 行数 | 用途 |
|---|---|---|---|
| `ask.mjs` | CLI | 222 | 桥工具化：让场景能"调用桥" |
| `audit2.mjs` | 脚本 | 123 | 补充审计：哪些是"真的在跑"，哪些是"我造的空壳" |
| `auth.mjs` | CLI | 280 | 授权模式（Accept Mode）：off / observe / auto |
| `boards.mjs` | CLI | 289 | 共享层四块板（Shared Boards） |
| `capabilities.mjs` | CLI | 257 | 能力开关（Capability Switch） |
| `collab.mjs` | CLI | 330 | 场景间协作（Cross |
| `diag-colors.mjs` | 脚本 | 77 | 实测关键元素的真实颜色 |
| `doc-index-judge.mjs` | 库 | 127 | 文档密度索引判定（需求 6 的后半段） |
| `doc-index-selfcheck.mjs` | 脚本 | 92 | 文档密度索引的元验证。 |
| `evaluate-authored.mjs` | 脚本 | 129 | Agent 自写 check 的评测器。 |
| `find-violators.mjs` | 脚本 | 108 | 1. 确认 enforce CSS 真的加载了 |
| `floor-selfcheck.mjs` | 脚本 | 80 | 不变量下限的元验证：证明"声明过弱"会被拒。 |
| `gate-cli.mjs` | 脚本 | 103 | gate CLI 入口（独立文件，避免"库 vs 入口"的判定问题）。 |
| `gate.mjs` | 库 | 143 | sea 门禁（Gate）：判断一个 DoneSpec check 是否**值得信任**。 |
| `hygiene.mjs` | CLI | 187 | 自检卫生（Test Hygiene） |
| `idempotent-test.mjs` | 脚本 | 93 | 检查状态是否被污染 |
| `identity.mjs` | CLI | 198 | 身份认领（Identity Claim） |
| `induct.mjs` | CLI | 250 | 自动归纳（Auto |
| `inject.mjs` | CLI | 376 | 上下文注入层（引力注入 / Context Injection） |
| `invariant-floor.mjs` | 库 | 167 | 不变量下限（Invariant Floor） |
| `mcp-e2e.mjs` | 脚本 | 79 | 保存原状态 |
| `mcp-fs-server.mjs` | 脚本 | 147 | 最小可用的 MCP 服务器（只读文件系统） |
| `mcp.mjs` | CLI | 319 | MCP 客户端（零依赖） |
| `mem.mjs` | CLI | 251 | 记忆交接 CLI |
| `memory-guard-selfcheck.mjs` | 脚本 | 121 | 记忆体量红线的元验证：证明检查会失败、归档不丢内容。 |
| `memory-guard.mjs` | 库 | 267 | 记忆体量红线检查器（需求 3 + 6 的最小实现） |
| `mutations.mjs` | 库 | 257 | 不变量目录（Invariant Catalog） |
| `neuron-debug.mjs` | 脚本 | 120 | 深查神经元的两个问题： |
| `neuron-nodes.mjs` | 脚本 | 141 | 找出 9 个"路径失效"节点的确切身份 |
| `neuron-paths.mjs` | 脚本 | 99 | 精确找出哪 2 个节点的路径失效 |
| `neuron-verify.mjs` | 脚本 | 141 | 记忆神经元验证：它到底能不能读到数据、能不能写入 |
| `newcap-test.mjs` | 脚本 | 210 | 新能力的统一度量（可回归） |
| `profiles.mjs` | 库 | 109 | 自我复盘的档案浏览（Host 侧） |
| `rui-audit.mjs` | 脚本 | 206 | Refactoring UI 正式审计 |
| `scene-loader.mjs` | CLI | 90 | 场景加载器：把"放文件即新增场景"变成现实。 |
| `sea-audit.mjs` | CLI | 81 | 记忆与索引体检（独立 CLI，不侵入 sea.mjs） |
| `sea.mjs` | 脚本 | 354 | sea |
| `selfcheck-cache.mjs` | CLI | 140 | 自检结果缓存：把慢的自检（gate selfcheck / floor selfcheck）结果缓存起来。 |
| `sessions.mjs` | CLI | 335 | 场景 ↔ 会话 绑定 |
| `sf-test.mjs` | 脚本 | 186 | Sceneflow 端到端测试 |
| `sf-ui-verify.mjs` | 脚本 | 133 | 验证 Sceneflow 面板在界面上真的能工作 |
| `shell-guard.mjs` | CLI | 232 | 外壳哨兵（L0 Shell Sentinels） |
| `shot-dark.mjs` | 脚本 | 62 | 确保 dark |
| `skill-test.mjs` | 脚本 | 96 | 验证：技能是否真的能被场景使用 + token 预算是否真实生效 |
| `tui-audit.mjs` | 脚本 | 79 | 深挖：哪些元素还没被终端化 |
| `tui-check-fill.mjs` | 脚本 | 94 | 专门查「面板高 vs 内容高」的差 |
| `tui-check-pipeline.mjs` | 脚本 | 87 | 先切到 pipeline |
| `tui-diag-layout.mjs` | 脚本 | 90 | 诊断面板留白的真实原因 |
| `tui-verify.mjs` | 脚本 | 167 | 终端模式界面验证 + 截图 |
| `undo.mjs` | 库 | 69 | 撤回能力（U5）：让任何改动都可以一键退回。 |
| `usability-test.mjs` | 脚本 | 305 | ---------- 备份 / 恢复所有场景数据 ---------- |
| `validation-cache.mjs` | 库 | 110 | check 认证结果缓存：gate validate 很贵（每场景 ~270ms × 6 次子进程）。 |
| `wb-ab-test.mjs` | 脚本 | 195 | A/B 实验：关闭 4 个免费 AI 站，看 GPU 内存掉多少 |
| `wb-ab2.mjs` | 脚本 | 188 | 重做 A/B 实验（这次量准） |
| `wb-bisect.mjs` | 脚本 | 168 | 二分定位：逐个禁用 webview，量内存差，找出最耗资源的那个 |
| `wb-destroy-test.mjs` | 脚本 | 152 | 关键实验：销毁 webview 元素（从 DOM 移除）能否真正释放 renderer 进程 |
| `wb-diag-btn.mjs` | 脚本 | 79 | 诊断：webai |
| `wb-diag-gc2.mjs` | 脚本 | 118 | 诊断：为什么第二次跑测试时销毁后 webview 又变成 6 |
| `wb-diag-restore.mjs` | 脚本 | 101 | 诊断：为什么点了顶栏按钮 webview 没重建 |
| `wb-diag-sweep0.mjs` | 脚本 | 121 | 精确诊断 sweep 为什么销毁 0 个 |
| `wb-diag-webview.mjs` | 脚本 | 103 | 诊断：webview 的 did |
| `wb-fault-test.mjs` | 脚本 | 153 | 故障注入测试 |
| `wb-fault-test2.mjs` | 脚本 | 159 | 容错链路端到端测试（可靠版） |
| `wb-fault.mjs` | 脚本 | 111 | 深度探针 3：错误恢复能力 |
| `wb-gpu-deep.mjs` | 脚本 | 136 | GPU 进程深挖 |
| `wb-gpu-probe.mjs` | 脚本 | 132 | GPU 进程深挖 2：用 Electron 官方 API 拿 GPU 真实状态 |
| `wb-health.mjs` | 脚本 | 190 | 工作台健康度总检（一条命令给出全部关键指标） |
| `wb-idle-test.mjs` | 脚本 | 137 | 生命周期管理：闲置 webview 自动销毁 |
| `wb-idle-verify.mjs` | 脚本 | 201 | 闲置销毁 · 端到端验证 |
| `wb-idle-verify2.mjs` | 脚本 | 155 | 闲置销毁 · 确定性端到端验证（v2） |
| `wb-leak.mjs` | 脚本 | 100 | 累积泄漏验证：连续切 6 次，看 webview 与内存是否持续增长 |
| `wb-mem-double.mjs` | 脚本 | 90 | 诊断：为什么重启后内存翻倍 |
| `wb-memory-board.mjs` | CLI | 190 | 内存看板（Host 侧）：把内存测量做成主进程服务 |
| `wb-memory-breakdown.mjs` | 脚本 | 155 | 内存去向拆解（P3） |
| `wb-memory-verdict.mjs` | 脚本 | 125 | GPU 内存的真相：可控 vs 不可控 |
| `wb-memory.mjs` | 脚本 | 102 | 深入测量：内存去向与 0x0 面板 |
| `wb-probe.mjs` | 脚本 | 161 | 工作台运行时探针（通过 CDP 真实测量） |
| `wb-process-map.mjs` | 脚本 | 89 | 定位最大的那个进程：PID 11052 占 478MB 工作集 / 438MB 私有 |
| `wb-stress.mjs` | 脚本 | 125 | 深度探针 2：并发与稳定性 |
| `wb-webai-api.mjs` | 脚本 | 83 | 查 webai API |
| `wb-wv-recycle.mjs` | 脚本 | 110 | 验证：场景切换时旧 webview 是否被正确回收 |
| `wb-zero-wv.mjs` | 脚本 | 94 | （无说明） |
| `weak-declaration-test.mjs` | 脚本 | 66 | 验证：声明过弱的场景，门禁会不会拒？ |
| `write-audit.mjs` | 脚本 | 250 | 全量"实际写入"审计 |

## 常用命令

```powershell
# 架构自检（一条命令看全七层）
node 工具\arch.mjs

# 场景验证
node 工具\scene-validate.mjs

# 记忆体检
node prototype\mem.mjs checkall

# 管线校验
node 工具\sceneflow.mjs verify

# 工作台健康度（需 CDP 端口）
node prototype\wb-health.mjs
```
