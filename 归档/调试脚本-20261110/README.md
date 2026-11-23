# sea · Agent 自检与完成判定

> **每次打开都立刻知道"现在要不要我"，并且永不骗你。**

---

## 1. 立即试用（零配置、零依赖、零 key）

```powershell
cd "D:\file\AI Temp\DeepSeek\Agent自研"
node prototype\sea.mjs
```

**热启动 287ms**，冷启动约 5.6s（首次重算自检）。

---

## 2. 四个命令

| 命令 | 作用 |
|---|---|
| `sea` | 首屏：现在有没有事要你做 |
| `sea check <场景>` | 跑一次判定，给差异集合 |
| `sea verify` | 自检三层信任链 |
| `sea undo` | 退回上一次快照 |

`--more` 展开细节；`--root <dir>` 指向任意场景目录。

### 退出码语义（三档，明确）

| 码 | 含义 |
|---|---|
| `0` | 一切正常 |
| `1` | 有活要干（检查可信） |
| `2` | **检查本身不可信**（结论不可用，先修信任链） |

---

## 3. 三个真实输出

### 3.1 一切正常（2 行）

```
sea · 现在没事要你做
  5 个场景全部通过 · 门禁自检 20/20 · 不变量下限 4/4 · check 认证 5/5
```

### 3.2 有活要干（第二行就说差什么）

```
sea · 1 件事需要你
  FAIL 客服分派         每单有 owner、owner 在值班表、无重复单
       差 负责人不在值班表 1(T-1->alice)
```

### 3.3 检查被改坏（**最重要的一种输出**）

```
sea · 我的检查本身不可信
  ✗ 门禁自检 19/20 —— 它可能放过坏 check
  ✗ check 认证 4/5 —— 未通过：docs-index
  含义：下面的结论不可信，先修信任链
```

**这是三层信任链的最后一步**：警报响了，首屏就敢说"不可信"。

---

## 4. 加自己的场景（零代码改动）

```
<目录>/<场景id>/
├── scene.json
├── check.mjs
├── data/         ← 业务数据（可以有问 题）
└── baseline/     ← 干净基线（门禁用它证明 check 不是恒定失败）
```

**`scene.json`**：
```json
{
  "id": "my-project",
  "name": "我的项目",
  "desc": "config 与 expected 一致",
  "check": "check.mjs",
  "baselineDir": "baseline",
  "protects": ["completeness", "uniqueness", "required-field"]
}
```

> **`data/` 与 `baseline/` 必须分开**：否则改业务数据会误触发"检查不可信"。

`protects` 可选值：

| 不变量 | 含义 |
|---|---|
| `completeness` | 集合成员必须完整 |
| `uniqueness` | 集合内 id 不得重复 |
| `referential-integrity` | 引用必须能解析 |
| `required-field` | 必填字段不得为空 |
| `term-presence` | 登记的词必须在正文出现 |
| `no-unregistered-token` | 正文不得出现未登记缩写 |

`check.mjs` 契约：`exit 0` = 通过；非 0 = 失败**且必须输出「差异集合」**；读数据用 `process.env.SEA_DATA_DIR`。

然后：

```powershell
node prototype\sea.mjs --root <你的目录>
```

---

## 5. 三层信任链

| 层 | 检查什么 | 命令 | 当前 |
|---|---|---|---|
**1 门禁自检** | 门禁会拒绝坏 check 吗 | `gate-cli.mjs selfcheck` | **20/20** |
**2 不变量下限** | 声明是否过弱 | `invariant-floor.mjs` + `floor-selfcheck.mjs` | **4/4** |
**3 check 认证** | 每个 check 过 G0–G3 吗 | `gate-cli.mjs validate` | **5/5** |

首屏一行显示全部三层；任一层不成立 → **首屏变红（exit 2）**。

---

## 6. 门禁的五个门

| 门 | 判据 | 抓什么 |
|---|---|---|
**G0** | 声明了 protects | 不声明的检查不可信 |
**G0.5** | 声明达到不变量下限 | **声明过弱（Agent 自我削弱）** |
**G1** | 基线通过 | 恒定失败 |
**G2** | 全部变异被捕获 | 漏报 |
**G3** | 失败带差异集合 | 说不清差在哪 |

---

## 7. 文件说明

| 文件 | 作用 |
|---|---|
| `sea.mjs` | CLI 入口（首屏 + 4 命令） |
| `scene-loader.mjs` | 场景发现（放文件即新增） |
| `gate.mjs` | 门禁核心（validate） |
| `gate-cli.mjs` | 门禁 CLI（validate / selfcheck） |
| `mutations.mjs` | 不变量驱动的变异生成器 |
| `invariant-floor.mjs` | 不变量下限 |
| `floor-selfcheck.mjs` / `weak-declaration-test.mjs` | 下限元验证 |
| `selfcheck-cache.mjs` / `validation-cache.mjs` | 两级缓存（冷 5.6s → 热 287ms） |
| `undo.mjs` | 快照与撤回 |
| `usability-test.mjs` | 13 个指标度量 |
| `scenes/` | 5 个场景（4 演示 + 1 真实） |
| `tools/` | 建场景 / 刷新数据 / 补基线 |

---

## 8. 一键验证

```powershell
node prototype\sea.mjs                                   # 首屏
node prototype\gate-cli.mjs selfcheck                    # 门禁 20/20
node prototype\invariant-floor.mjs prototype\scenes      # 下限 4/4
node prototype\floor-selfcheck.mjs                       # 下限元验证 4/4
node prototype\weak-declaration-test.mjs                 # 弱声明被拦 1/1
node prototype\usability-test.mjs                        # 13 指标
```

**这些测试都会真的失败**（开发中被抓出 10+ 个真 bug），那正是它们可信的原因。

---

## 9. 已知限制

| # | 限制 |
|---|---|
| C1 | 5 个场景中只有 `docs-index` 是真实数据，其余是演示 |
| C2 | 独立 CLI，**还没接进 DSH 首屏** |
| C3 | check 是我写的，**不是 Agent 自己写的**（下一轮） |
| C4 | 冷启动 5.6s（热启动 287ms） |
| C5 | **没做过真人盲测** |
| C6 | `baseline/` 需人工维护，改 check 后忘记同步会失真 |

---

## 10. 一句话

> **三层信任链的价值，不在于它能报警，而在于报警之后首屏敢不敢说"不可信"。**
