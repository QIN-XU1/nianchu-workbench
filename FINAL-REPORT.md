# 念初 · 对标 29 个参照项目 —— 最终交付报告

> 定稿于目标第 219 轮。一切结论都可按文中命令复算；拿不到证据的明确标 UNKNOWN。

---

## 一、目标四子项

| # | 子项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 补齐已知缺口（会话记忆/多轮上下文、团队协同改真实代码）| ✅ **达成** | `verify-context` 19/19 · `verify-memory-budget` 20/20 · `verify-e2e-scripted` 35/35（免 API key）|
| 2 | 逐一拆解 29 个参照项目 | ✅ **达成** | **30 行入矩阵（念初 + 29 参照）· 930 证据格**；念初 98.4% 列第 2 |
| 3 | 逐维对比实质超越（可比口径）| ✅ **达成** | 可比 21 家 · **零落后 21** · 落后 0；我们 31 维中 **30 维=有**（唯一「部分」是用户排除的 A15）|
| 4 | 超越全部 29 | ❌ **结构性不可达** | 8 家不可比（7 闭源无源码 + cl4r1t4s 非系统）|

---

## 二、一条命令复算（定稿实测）

```bash
node tools/verify-all.mjs
# 脚本总数 63 · 有失败 0 · FLAKY 0 · UNKNOWN 3 · WARN 1 · PASS

node tools/evolve/verify-dim-manifest.mjs
# 通过 29 维 · 失败 0 · FLAKY 0 · UNKNOWN 0 · 排除 2 · PASS

node prototype/hermes-agents/verify-goal.mjs
# 21 通过 / 0 失败 / 1 UNKNOWN（R11 横向领先，设计上不可判）
```

3 个 UNKNOWN 全合理：`agent-channel`（A10 用户排除）、`changeset-rpc`/`streaming`（需真模型，网关 401）。
**「0 失败」≠「全部能力已验证」**。

---

## 三、核心验证（逐条）

```bash
node tools/agent/verify-context.mjs             # 19/19
node tools/agent/verify-memory-budget.mjs       # 20/20
node tools/agent/verify-e2e-scripted.mjs        # 35/35（scripted 假模型，真写文件）
node tools/agent/verify-resume.mjs              # 21/21（中断续跑，零残留）
node tools/agent/verify-handoff.mjs             # 27/27（五态/禁跳级/黑洞/互等）
node tools/agent/verify-trace.mjs               # 16/16（span 树/失败留痕）
node tools/mcp/client.mjs --selftest            # 10/10
node tools/skills/doctor.mjs                    # 186 PASS · 0 WARN · 0 FAIL
node tools/skills/verify-discoverability.mjs    # 36/36（第1命中 100%）
node tools/skills/verify-references.mjs         # 4/4（285+ 处引用全真实）
node tools/evolve/audit-evidence-provenance.mjs # 899 格 · REAL 571(63.5%) · OWN 0
node tools/evolve/fair-compare.mjs              # 零落后 21 / 落后 0
```

---

## 四、运行时一手验证

| 维度 | 结论 |
|---|---|
| **单端口「一份软件」** | 15/15：`GET /` 200；`/api/host-status` singleProcess=true·**91 方法**；WS `/ws` 握手 OK |
| **D2 三档密度** | 17/17 真 headless Edge：**0.78 / 1 / 1.18** 单调、文本字符数一致、命中区 24px、非法回落 |
| **D3 状态条** | 16/16 真 dump DOM：5 字段（状态/停止原因/用量/耗时/trace）+ 空闲占位；前端标签表==后端枚举 |
| **D4 多场景 / D5 主题** | 13 个 work 场景可切换；`data-openbitfun-design-system-root` |
| **A7 记忆治理** | 真实 HTTP：无 source→400 拒写、supersede 旧值可查 |
| **A11 调度器** | 真执行 + runs 留痕 + 同分钟幂等 |
| **A13 MCP / A16 trace** | 10/10 · 11/11 |

截图：`evidence/ui/nianchu-workbench-d3-statusbar.png`

---

## 五、诚实边界（必须一起读）

1. **「零落后 21」是按本矩阵口径**，不是客观超越。系统自己的 R11 就标 UNKNOWN——竞品 133 个「有」格里 43 格（32.3%）是我们自己的文字描述。
2. **A12 技能：数量 186 = hermes 186（追平），深度落后**
   | 项目 | 唯一技能 | 深度中位 |
   |---|---|---|
   | ECC | 314 | 7.68KB |
   | hermes | 186 | 8.8KB |
   | 念初 | **186** | **3.53KB** |

   分布实测：`≥4KB 59 个(32%) · ≥5KB 38(20%) · ≥7.68KB 29(16%)`。
   **中位是第 93/94 个值** ⇒ 要让中位达 7.68KB，需 **93 个技能 ≥7.68KB**（现 29）⇒ **还差 64 个**。
   「真实材料不够 + 中位数学」两重约束，**本会话不可达**，且不为抬中位注水。
3. **模型智能层 UNKNOWN**：网关 `401 User not affiliated` / `400 model_not_supported`。
4. **8 家结构性不可比**（第六节）。
5. **四档判据会抹平「都有但对手更深」**——判据固有损失，已逐处标注。

---

## 六、为什么「超越全部 29」不可达

| 类别 | 项目 | 原因 |
|---|---|---|
| 闭源商业（7）| chatgpt · claude · qoder · workbuddy · cursor · trae · codebuddy | 无可获取源码 → 永久 UNKNOWN |
| 非系统（1）| cl4r1t4s | 82 个提示词文件，不可运行，不可比 |

---

## 七、工程修复（真改代码/测试）

- **B3 宿主投影** 12 → **19**（超越 ecc 14）。
- **runtime.mjs 守卫 bug**：`endsWith('runtime.mjs')` 误命中 `*runtime.mjs` → 改 basename 精确比较。
- **12 个 verify 的「环境→伪 FAIL」**：改为如实 UNKNOWN（新增 `_model-probe.mjs`、`_serve.mjs`）。
- **D2/D3 从「只验源码」升级到「真渲染验证」**。
- **verify-all 归类 bug**：无四态默认 UNKNOWN 掩盖 3 个 exit 1 真失败 → 改按退出码 0/1/2/3。
- **FLAKY 机制**（verify-all + dim-manifest）：失败重试一次，重试通过标 FLAKY 单独计数——偶发可见而非被「0 失败」掩盖。
- **端口争用**：`_serve.mjs` 加「子进程早退检测 + 递增退避重试」。
- **C4 真回归**：`verify-resume` 的 `id2` 从不 discard → 61 个 `test-ok-*` 残留 > `listResumable(50)` 窗口 → 断言稳定失败。修：try/finally 必清 + limit→100000 + 清残留（现**零残留**）。
- **D2 渲染 flake**：flake 时 comfy 档 DOM 仅 27 字符 → 加「渲染不足重跑」。
- **trace 无界增长**（真产品缺口）：2026 → 500，新增 `pruneTraces` + 节流自动清理。
- **静默 catch 扫描范围显式化**（原只扫 7 个产品目录，工具层另有 15 处）。
- **技能自审**：删掉编造的 `streaming-output`、修 `artifact-verification` 归属、修 `memory-budget` 机制描述、改 `dim-evidence-audit` 名字包含、修 `doc-number-audit` 的 `*/SKILL.md` 死引用、修 3 处过期数字。
- **技能 140 → 186**，全部锚真实机制、含反例与自检清单。

---

## 八、一句话总结

**可判定的 21 家按矩阵口径零落后，30/31 维自评「有」，每条「有」都经得起读代码与运行时复算；
不可判定的 8 家（7 闭源 + 1 提示词集）结构性不可比；技能数量已追平 hermes(186)，
但深度只有 ecc 的 45%（3.53 vs 7.68KB，差 64 个技能）——这部分本会话不可达，不粉饰。**

**念初自己的位置（第 222-223 轮补进矩阵并修正 hermes）**：30 行 × 31 维 = 930 格。
念初 98.4%，与 hermes 并列——但**非排除的 30 维，念初 100% > hermes 98.3%**（hermes 的 A7 只有溯源，
无记忆 TTL / 无冲突消解，低于念初的完整三件套）。fair-compare 仍「21 家零落后」。
即：**按用户认可的 30 维口径，念初是全部 21 个可比参照的第 1**。
这既是结论也是边界——「第 1」不是「31/31 满分」，剩余是 A15（用户排除）与 A12 深度（材料不够），两者都不是工程未完成。