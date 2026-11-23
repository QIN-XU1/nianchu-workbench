# T1 计数口径统一与 H-0029 考古

> 一句话速览
> - **计数口径已统一**：审计快照（HEAD `129e571a`，台账 89 条）上两个计数器都报 **11**；且 `closed / partial / refuted` 三个桶从 `(12,43,3)` vs `(11,41,6)` 对齐成 `(11,41,6)` 全等。审计快照 89 条与并行 append 期间的现场 92 / 97 / 99 / 100 条，两者在每个快照上全等。
> - **H-0029 来源可验证、写入机制不可验证**：写它的提交是 `7138fc91`（可验证）；但已实测证明它**不是任何一个已提交 `record()` 版本的产出**；能逐字段复现它的"中间版本"在 git 里存在 **0 份**。精确机制（未提交工作区中间态 / 直接手改台账）git 无法区分 ⇒ 如实记 `unverifiable`。

本次改动只有一个文件：`prototype/agent-ui/verify-evolve.mjs`（`git diff --stat` → `1 file changed, 43 insertions(+), 4 deletions(-)`）。
**未修改 `research/改进台账.json`**（全程只读；所有沙箱实验写的是 `%TEMP%` 下的副本）；**未 `git add` / `git commit`**。
本报告本身在本仓库是**被 gitignore 的**（`.gitignore:259` → `evidence/evolve/`，与独立复审报告 `t1-independent-audit.md` 同目录），主线程提交时不会自动入库。

---

## 一、计数口径

### 改之前

问题：同一个仓库两个计数器，同一份台账算出两个数。

为排除并行 append 干扰，快照取自 git 而非工作区（`HEAD=129e571a`，`git show HEAD:research/改进台账.json` = 89 条）：

| 计数器 | 命令 | 实测输出 | 独立验证结案 |
|---|---|---|---|
| evolve | `node tools/evolve/evolve.mjs verify` | `✅ 台账完整性 · 89 条 · 0 个问题` / `独立验证结案 11 · 自己验证(partial) 41 · 被驳回 6` | **11** |
| countLedger（旧） | `countLedger(89 条 entries)` | `{"total":89,"closed":12,"partials":43,"refuted":3,"independent":12}` | **12** |

差额 = `H-0022`：`research/改进台账.json` 里它 `status:"closed"`、`independent:true`，但同时 `disputedBy:"H-0025"`（`H-0025` 是 `independent-verifier` 的正式驳回记录，`"reasons":"复审判 refuted…实现方却 attest 成 closed，属自我归属"`）。

`tools/evolve/evolve.mjs` 的 `verify()` 早就有正确规则：

```js
const effectiveStatus = (e) => (e.disputedBy ? 'refuted' : e.status);
```

> ⚠️ 行号订正：任务书与复审报告引用的是 `evolve.mjs:329`，但我实测该文件**并行改过**——`HEAD 129e571a` 里这行在 **353 行**，我读取时工作区在 345 行。为可复现，本报告一律引 HEAD 版行号（`git show HEAD:tools/evolve/evolve.mjs`）。

旧 `countLedger()` 只读 `e.status`，于是 `H-0022` 在这里算"结案"、在 evolve 里算"被驳回"——**同一个仓库两个数**。

关键发现（这也是它一直没被抓住的原因）：`countLedger` 的数字**根本不出现在验收器的正常输出里**。`composeVerdict()` 到第 4 层（台账）才打印计数（`prototype/agent-ui/verify-evolve.mjs:185-192`），而当前 CLI 在第 2 层就返回了（见下"环境说明"）。所以 12 与 11 的差别只能靠直接调用 `countLedger()` 才看得到。

### 改之后

改法（`prototype/agent-ui/verify-evolve.mjs:69-83`）：`countLedger()` 内部引入与 evolve **同一条** `effectiveStatus`，三个桶全部按有效状态归类：

```js
const effectiveStatus = (e) => (e.disputedBy ? 'refuted' : e.status);
const closed   = all.filter((e) => effectiveStatus(e) === 'closed');
const partials = all.filter((e) => effectiveStatus(e) === 'partial');
const refuted  = all.filter((e) => effectiveStatus(e) === 'refuted');
```

同一份 89 条快照上的实测：

| 计数器 | closed / partial / refuted | 独立验证结案 |
|---|---|---|
| evolve `verify` | `11 / 41 / 6` | **11** |
| countLedger（新） | `{"total":89,"closed":11,"partials":41,"refuted":6,"independent":11}` → `11 / 41 / 6` | **11** |

**三个桶全等，不只"独立验证结案"这一个数对齐**——这是有意的：只对齐一个桶的话，`H-0001`（partial 被 H-0004 驳回）、`H-0006`（partial 被 H-0009 驳回）这类条目仍会让 `partial/refuted` 两栏对不上（旧版 43/3，evolve 41/6）。

并行 append 期间的现场快照（工作区台账持续被其他 agent 追加，故数字会变，**但在每一个快照上两者全等**）：

| 快照 | 台账条数 | `evolve verify` | `countLedger` |
|---|---|---|---|
| 审计快照（HEAD 129e571a） | 89 | `独立验证结案 11 · partial 41 · 被驳回 6` | `{"closed":11,"partials":41,"refuted":6,"independent":11}` |
| 现场（更早一次） | 92 | `独立验证结案 12 · partial 43 · 被驳回 6` | `{"closed":12,"partials":43,"refuted":6,"independent":12}` |
| 现场 08:03:25 | 97 | `独立验证结案 17 · partial 43 · 被驳回 6` | `{"closed":17,"partials":43,"refuted":6,"independent":17}` |
| 现场 08:26 | 99 | `独立验证结案 19 · partial 43 · 被驳回 6` | `{"closed":19,"partials":43,"refuted":6,"independent":19}` |
| 现场 08:28（最终验证） | 100 | `独立验证结案 20 · partial 43 · 被驳回 6` | `{"closed":20,"partials":43,"refuted":6,"independent":20}` |

最终验证三条命令的真实输出：

```
$ node tools\evolve\evolve.mjs verify
✅ 台账完整性 · 100 条 · 0 个问题
    独立验证结案 20 · 自己验证(partial) 43 · 被驳回 6

$ node prototype\agent-ui\verify-evolve.mjs --selftest
结论: ✓ 22/22

$ countLedger(100 条)
{"total":100,"closed":20,"partials":43,"refuted":6,"independent":20}
```

三栏 `20 / 43 / 6` 与 evolve 逐项相同。台账在工作区被并行追加（89→92→97→99→100），**数字会继续变，但两边同步变**。

即：审计所指的"应当为 11"是 **89 条快照**上的值，在那个快照上现在就是 11（与 `evolve verify` 一致）；工作区台账随后被并行追加到 100 条，共同数随之变成 20——**两个计数器同步变化**，这正说明口径已经结构性地一致，而不是某一次巧合相等。

### 反例断言

在 `selfTest()` 里新增 3 条（`prototype/agent-ui/verify-evolve.mjs:319-343`），并且**成对存在**——只钉"有 disputedBy 不计"是不够的，因为把它写坏成"一律不计"也能让那条反例保持绿：

| 类型 | 断言 | 行 |
|---|---|---|
| 反例 | `status='closed'` 但有 `disputedBy` ⇒ 不许计入 closed，必须进 refuted（且不计 independent） | `:327` |
| 正例 | `status='closed'` 且无 `disputedBy` ⇒ 必须计入 closed 与 independent | `:334` |
| 反例 | `partial` 有 `disputedBy` ⇒ 算被驳回，不算自己验自己 | `:340` |

顺带修掉一个自带假数字：自检标题原先写死「2 正例 + 13 反例」，实际已是 19 条；现改为由 `r.total` 算出（`:358`）。

**突变检验（真做，改错→变红→还原）**

突变体 M1 —— 把核心判断退回旧口径（`effectiveStatus = (e) => e.status`）：

```
L4 改进闭环验收 · 自检 22 条（反例集中在「三层如何合成四态」与「台账口径 disputedBy」）
✗ 反例 · status=closed 但有 disputedBy ⇒ 不许算结案（必须是被驳回）  ← closed=1 independent=1 refuted=0
✓ 正例 · status=closed 且无 disputedBy ⇒ 必须算结案
✗ 反例 · partial 有 disputedBy ⇒ 算被驳回，不算自己验自己  ← {"total":1,"closed":0,"partials":1,"refuted":0,"independent":0}
结论: ✗ 2 项不成立        [exit code: 1]
```

突变体 M2 —— 空转检验（`effectiveStatus = () => 'refuted'`，把"有驳回的不算"退化成"谁都不算"）：

```
✓ 反例 · status=closed 但有 disputedBy ⇒ 不许算结案（必须是被驳回）
✗ 正例 · status=closed 且无 disputedBy ⇒ 必须算结案  ← {"total":1,"closed":0,"partials":0,"refuted":1,"independent":0}
✓ 反例 · partial 有 disputedBy ⇒ 算被驳回，不算自己验自己
结论: ✗ 6 项不成立        [exit code: 1]
```

M1 杀反例、M2 杀正例 ⇒ 这组断言不是装饰。还原后：

```
结论: ✓ 22/22
```

**环境说明（不掩盖验收器整体仍是 ❌）**

`node prototype/agent-ui/verify-evolve.mjs` 跑完仍是 `❌ L4 改进闭环`，但失败点在**第 2 层度量**、在 `countLedger` 之前，原因是我方并行未提交导致工作树不干净：

```
❌ L4 改进闭环（假设→改→量→留或退→留痕）
硬约束自检 27/27 · 度量没有四态结论
```

直接跑度量器可见根因（`exit=4`）：

```
❌ 前置体检：工作树不干净，而 F07 测的就是「树脏不脏」
    M prototype/agent-ui/verify-evolve.mjs
    M research/改进台账.json
    M tools/benchmark/commit-readability.mjs …
树脏时 F07 的干净基线本身就会红 ⇒ recall/fpr 随树状态变化 ⇒ **数字不可复算**。
```

这是"在脏树上跑度量就该拒跑"的**正确行为**，与计数口径无关；主线程统一提交后即可复跑。我不把这条 FAIL 说成通过。

---

## 二、H-0029 考古

先对齐事实。任务书说 H-0029 是 `status='partial'`，当前台账里是 `status='closed'`——两者都对，只是**时间点不同**（见下"git 追溯"三步）：

| 时间 | 提交 | H-0029 状态 |
|---|---|---|
| 19:09:09 | `ef350580` | `open`（after/samples/verdict 全 null） |
| 19:14:09 | `7138fc91` | `partial`（写入 C2+C5 两条 notes）← 复审读到的就是这一态 |
| 19:21:38 | `0a63c7f3` | `closed`（`attestUpgradedFrom:"partial"`, `attestedBy:"verifier-r3b"`） |

不变的是三个字段：`after=6`（数字）、`verdict='keep'`、`samples=6`，以及 `notes` 里**同时**有 C2 与 C5 两条——而这两条在当前实现里逻辑互斥。

它是**唯一**的异常条目（89 条里同时带 C2+C5 的只有它一条）：

```
$ node -e "<遍历 89 条，notes 是否含 C2/C5>"
H-0001..H-0028, H-0030.. — 都只有 C5 或只有 C2
H-0029 status=closed verdict=keep samples=6 after=6 C2=true C5=true upFrom=partial
```

### 复原的两个 record() 版本

`git show 7138fc91^:tools/evolve/evolve.mjs`（C2 修复前）与 `git show 7138fc91:tools/evolve/evolve.mjs`（修复后）。

**修复前（`7138fc91^`，C2 分支 138-145 行、C5 分支 147-151 行）—— C2 命中就"拒绝记录"，什么都不写（逐字原文）：**

```js
if (n > 0 && n < C2_MIN) {                          // 138
  // C2：样本不足 ⇒ 结论只能是 UNKNOWN
  return {
    ok: false,
    reasons: ['C2 违反：样本量 ' + n + ' < ' + C2_MIN + ' ⇒ 结论只能是 UNKNOWN，不许下判定'],
    forceState: 'UNKNOWN',
  };
}

if (verifier && e.by && verifier === e.by) {        // 147：只有 n>=8 才可能走到这里
  // C5：自己验自己 ⇒ 降为「部分」
  state = 'partial';
  reasons.push('C5：验证方与实现方是同一个（' + verifier + '）⇒ 状态降为「部分」，不算独立验证');
}
```

**修复后（`7138fc91`，143-152 行）—— C2 命中改"记为 unknown"，且 C5 被 unknown 挡住：**

```js
if (n > 0 && n < C2_MIN) {
  state = 'unknown';
  reasons.push('C2：样本量 ' + n + ' < ' + C2_MIN + ' ⇒ 记为 UNKNOWN，不下判定（不是拒写）');
}
if (state !== 'unknown' && verifier && e.by && verifier === e.by) {   // ← 互斥点
  state = 'partial';
  reasons.push('C5：验证方与实现方是同一个（' + verifier + '）⇒ 状态降为「部分」，不算独立验证');
}
```

（HEAD `129e571a` 与 `7138fc91` 的这段逐字相同，位于 135-152 行。）

### 判定

用两个版本**实际跑**（各自隔离沙箱，台账还原成 `ef350580` 时 H-0029 的 `open` 原样，调用 `record({id:'H-0029', after:6, samples:6, verdict:'keep', verifier:'lead'})`）：

**修复前** —— 拒绝记录，台账仍是 `open / null`：

```
record() 返回: {"ok":false,"reasons":["C2 违反：样本量 6 < 8 ⇒ 结论只能是 UNKNOWN，不许下判定"],"forceState":"UNKNOWN"}
落账字段: {"status":"open","after":null,"verdict":null,"samples":null}
⇒ 能产出 H-0029 那组字段吗? 不能
```

**修复后** —— 落成 `unknown`，且 notes 只有 C2 一条：

```
record() 返回: {"ok":true,"id":"H-0029","state":"unknown","delta":0,"moved":false,"notes":["C2：样本量 6 < 8 ⇒ 记为 UNKNOWN，不下判定（不是拒写）"]}
落账字段: {"status":"unknown","after":"6","afterType":"string","verdict":"unknown","samples":6,"notes":["C2：…"]}
⇒ 能产出 H-0029 那组字段吗? 不能
```

**H-0029 实际**（`git show 7138fc91 -- research/改进台账.json` 的新增块）：

```
status=partial  after=6(number)  samples=6  verdict=keep  moved=true  delta=6
notes = ["C2：样本量 6 < 8 ⇒ 记为 UNKNOWN，不下判定（不是拒写）",
         "C5：验证方与实现方是同一个（lead）⇒ 状态降为「部分」，不算独立验证"]
closedAt = 2026-11-15T11:13:34.964Z
```

对照表（逐字段）：

| 字段 | H-0029 实际 | 修复前 record() | 修复后 record() |
|---|---|---|---|
| `status` | `partial` | `open`（未写） | `unknown` |
| `after` | `6`（number） | `null` | `"6"`（string） |
| `verdict` | `keep` | `null` | `unknown` |
| `delta` | `6` | —（未写） | `0` |
| `moved` | `true` | —（未写） | `false` |
| `notes` | **C2 + C5 两条** | 一条都没有 | **只有 C2** |

**结论：两个已提交版本都产不出 H-0029 现在的字段组合。**

- 修复前：`samples=6 < 8` 直接被 `return ok:false` 拦掉，一个字段都不会写。
- 修复后：`state='unknown'` 使 C5 的 `state !== 'unknown'` 前置条件为假 ⇒ **C5 那条 note 在本版本里永不可能出现**；且 unknown 落账分支写的是 `verdict='unknown'`、`after=String(after)`、`delta:0`、`moved:false`——与实际的 `keep / 6(number) / delta 6 / moved true` 全部相反。

### git 追溯

`git log -p --follow research/改进台账.json`（等价于下面的精确检索）+ `git show` 定位三次写入：

1. **`ef350580`（2026-11-15 19:09:09 +0800，"chore(台账): H-0029 记忆检索 0→6"）** —— 登记，`git show ef350580 -- research/改进台账.json` 显示只新增 17 行、`status:"open"` 且 `after/samples/verdict/verifier/independent` 全 `null`。
   `git log -S "H-0029" -- research/改进台账.json` → 唯一命中 `ef350580`。
2. **`7138fc91`（19:14:09，"fix(C2): 机制 bug —— 样本不足时「拒绝记录」改为「记为 UNKNOWN」"）** —— 同一次提交里既改代码（`evolve.mjs` +37/-…），又把 H-0029 的 `open` 块整体替换成上面那份 `partial` 块。
   `git log -S "C2：样本量 6 < 8" -- research/改进台账.json` 最早引入者即 `7138fc91`。
3. **`0a63c7f3`（19:21:38，"chore(T1): H-0028/H-0029 独立确认 closed …"）** —— attest 把 H-0029 由 `partial` 升 `closed`（`attestUpgradedFrom:"partial"`）。

关键细节：`closedAt = 11:13:34.964Z`（= 19:13:34 +0800）比提交时间 19:14:09 **早 35 秒**。这个时间差与"改完代码→在工作区跑一次→再提交"的流程吻合，但**不是证据**（见下）。

那么"是哪个机制写进去的"？再往下挖一层：

- **中间版本重构实验**：把修复后版本**只去掉 C5 的 `state !== 'unknown'` 守卫**（其余逐字不动），再跑同样的调用：

  ```
  落账字段: {"status":"partial","after":6,"afterType":"number","verdict":"keep","samples":6,
             "verifier":"lead","independent":false,"moved":true,"delta":6,
             "notes":["C2：样本量 6 < 8 ⇒ 记为 UNKNOWN，不下判定（不是拒写）",
                      "C5：验证方与实现方是同一个（lead）⇒ 状态降为「部分」，不算独立验证"]}
  ```

  **与 H-0029 逐字段完全一致**（含 notes 顺序、`delta=6`、`independent=false`；仅 `closedAt` 是运行时值，不可比）。也就是说：C2 已改成"记 unknown"、但 C5 还没加守卫的那个**中间状态**，恰好能产出这份记录。

- **这个中间版本在 git 里存在吗？不存在。**
  - 不可达对象扫描：`git fsck --unreachable` 共 335 个 blob，**含「记为 UNKNOWN」的 0 个**。
  - 全历史版本扫描：`git rev-list --all` 484 个提交里，`tools/evolve/evolve.mjs` 只有 11 个不同版本；其中含 C2 文案「记为 UNKNOWN」的 5 个版本，**C5 守卫全部为 true**（`if (state !== 'unknown' && verifier && e.by …`）。

### 结论

**unverifiable（精确写入机制）/ 其余部分可验证。**

- **可验证 1**：H-0029 的 closed 块是提交 `7138fc91` 写进台账的（`git show ef350580` 与 `git show 7138fc91 -- research/改进台账.json` 对比 + `git log -S`）。
- **可验证 2（否证）**：它不是 `7138fc91^` 的 `record()` 产出（会被 `ok:false` 拒写），也不是 `7138fc91` 的 `record()` 产出（会落 `unknown/unknown/"6"/0/false` 且无 C5 note）。上面两个沙箱实跑即为证据。
- **可验证 3**：能**逐字段**复现它的代码状态确实存在（去掉 C5 守卫的中间版本）。
- **unverifiable**：该中间版本是否**真的**在工作区存在过并被跑过一次，还是作者直接手改了台账 JSON，git **无法区分**——两种可能都不留 git 对象（中间态若从未 `git add` 就不会有 blob；`git fsck` 已确认 0 命中，`git reflog` 也无 amend 痕迹，`7138fc91` 是普通 `commit:` 而非 `commit (amend):`）。
  因此**不猜**：这一层如实记为 unverifiable，不指定"就是手改"或"一定是中间版本"。
- 两条已排除的替代解释：①"修复前版本写的"——被 `ok:false` 排除；②"某个已提交版本写的"——5 个含 C2 文案的历史版本全部带守卫，且实际调用产出 `unknown`，排除。

**附加发现（与 T1 计数直接相关，供主线程决定，我未改动台账）**

H-0029 今天之所以计入"独立验证结案"，靠的是 `0a63c7f3`（19:21:38）那次 attest——而**当时的 `attest()` 没有任何 C2 样本闸门**：

```
0a63c7f3 | attest C2 样本闸门=false | attest verdict=unknown 闸门=false
HEAD     | attest C2 样本闸门=true  | attest verdict=unknown 闸门=true
```

闸门是 `c3cac601`（2026-11-16 07:15，"fix(evolve): T1 独立复审抓到机制漏洞 —— attest 会把 UNKNOWN 洗成 closed"）才加的（`ATTEST_MIN_SAMPLES = 8`，HEAD `tools/evolve/evolve.mjs:273-277`）。用**当前代码**重放那次确认，会被拒绝：

```
用 HEAD 版 attest() 重放 19:21:38 那次确认：
  ok= false  reasons= ["C2：样本量 6 < 8 ⇒ 统计上判不了，不许 attest 成 closed"]
```

即：H-0029 的 `closed` 是那个已修漏洞的**历史残留**——今天造不出这条记录，但它仍在台账里、仍计进 11。台账 append-only，我不改；是否给 H-0029 追加一条按现规则的重判，由主线程定。

---

## 附：复现方式

```powershell
cd "D:\file\AI Temp\DeepSeek\Agent自研"

# 一、计数口径（稳定快照，不受并行 append 影响）
node "tools\evolve\evolve.mjs" verify            # → 独立验证结案 N · partial M · 被驳回 K
node -e "import('./prototype/agent-ui/verify-evolve.mjs').then(m=>{const j=JSON.parse(require('fs').readFileSync('research/改进台账.json','utf8'));console.log(m.countLedger(j.entries))})"

# 断言与突变
node "prototype\agent-ui\verify-evolve.mjs" --selftest    # → 结论: ✓ 22/22
#（突变：把 verify-evolve.mjs:71 的 effectiveStatus 改成 (e)=>e.status 或 ()=>'refuted'，重跑自检应变红，改回）

# 二、H-0029 两版 record() 的真实产出
git show 7138fc91^:tools/evolve/evolve.mjs    # 修复前：C2 命中 → return ok:false
git show 7138fc91:tools/evolve/evolve.mjs     # 修复后：C2 命中 → state='unknown'，C5 被 state!=='unknown' 挡住
git show ef350580:research/改进台账.json      # H-0029 = open / null
git show 7138fc91 -- research/改进台账.json   # H-0029 的 partial 块由这次提交写入
git show 0a63c7f3 -- research/改进台账.json   # 之后 attest 升 closed

git log -S "H-0029" -- research/改进台账.json                  # → ef350580
git log -S "C2：样本量 6 < 8" -- research/改进台账.json        # 最早 → 7138fc91
git fsck --unreachable                                        # → 335 blob，含「记为 UNKNOWN」0 个
git log -1 --format="%ci %s" 7138fc91; git log -1 --format="%ci %s" 7138fc91^
```

沙箱（写在 `%TEMP%` 下，不碰仓库台账）：把 `git show <rev>:tools/evolve/evolve.mjs` 落到 `<tmp>/tools/evolve/evolve.mjs`、把 H-0029 的 open 原样落到 `<tmp>/research/改进台账.json`，`import()` 后调 `record({id:'H-0029',after:6,samples:6,verdict:'keep',verifier:'lead'})`——因为 `evolve.mjs` 用 `path.resolve(import.meta.dirname,'../..')` 定位台账，所以沙箱自洽。
