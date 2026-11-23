# 验证产物索引（v2）

> 本目录是 `方案/09-实机验证记录.md` 的证据。**全部可复现，不含任何真实凭据。**
> 环境：本机 `dsh` CLI **0.2.2-rc.1**，隔离的 `DSH_HOME=verification/sea-home`（不影响日常 `~/.dsh`）。

---

## 1. 三个已验证的假说

| 假说 | 状态 | 证据文件 |
|---|---|---|
**F-1：场景可用纯 preset 表达（不需要新造契约层）** | ✅ **成立** | `f1-pure-preset/cordis.patch.yml` + `f1-dump.txt` |
**F-1b：preset 写进配置 ≠ 会话用了它** | ✅ **成立（负面证据）** | `f1-dynamic.yml`（未 select）→ 会话忽略 |
**F-1'：显式 select 后真的生效** | ✅ **成立** | `f1prime-dynamic.yml` + `sea-preset-probe.js` + `sea-home/sessions/**` |
**F-3：非编码场景能写出会失败的 check** | ✅ **成立（正向 3/3，反例 6/6）** | `f3-donespec-check.mjs` + `f3-negative.mjs` |
**F-4：我引用的包是否真实存在** | ⚠️ 29/32，3 项需修正 | `web-config-tree.txt` |
**配置错误是否 fatal** | ❌ 不 fatal（只 warning） | `f1-bogus-dump.txt` + `exp-A-toplevel-bad.yml` |

---

## 2. 核心代码（可复用）

| 文件 | 作用 | 行数 |
|---|---|---|
**`sea-preset-probe.js`** | **F-1' 的核心**：`agent/created` 时 `agentPresets.select()`；含**反向探针**（假 preset 必须报错） | ~40 行 |
**`f3-donespec-check.mjs`** | **DoneSpec 的 3 条 check 实现**（客服分派/文档一致性/数据核对），输出差异集合 | ~130 行 |
**`f3-negative.mjs`** | F-3 反例测试：注入 6 个真实错误，验证 3 条 check 都会红且说出差异 | ~110 行 |
`mock-llm.cjs` | 本地 OpenAI 兼容 mock（**无需真实 key**），返回固定文本 + 统计请求数 | ~90 行 |

---

## 3. 配置文件

| 文件 | 作用 | 结论 |
|---|---|---|
`f1-pure-preset/cordis.patch.yml` | F-1：纯 preset 定义"数据核对"场景 | ✅ 进配置树 |
**`f1prime-dynamic.yml`** | **F-1'：preset + select 探针** | ✅ **preset 真的生效** |
`f1-dynamic.yml` | 未加 select 的对照 | ❌ 未生效（负面证据） |
`exp-A-toplevel-bad.yml` | 坏包在顶层 | ⚠️ warning 但不 fatal |
`exp-C-default-preset-bad.yml` | 坏包在默认 preset 内 | ❌ 完全静默 |

---

## 4. 脚本（读证据用）

| 文件 | 作用 |
|---|---|
`verify_preset.py` | 扫所有会话日志，输出 `preset_selected` / `persona_in_prompt` 两列 |
`inspect_events.py` | 列出每个会话的事件类型集合 |
`read_session.py` | 解压 zstd 并逐事件打印 |
`make_negatives.py` | 用字节级替换生成反例 patch（**避免 PowerShell 破坏 UTF-8 YAML**） |

---

## 5. 实测输出

| 文件 | 内容 |
|---|---|
`web-config-tree.txt` | 真实 web profile 配置树（46 KB，exit 0） |
`web-default-tree.txt` | shipped 默认层（不含用户 patch） |
`desktop-config-tree.txt` | desktop 被独占保护的报错 |
`f1-dump.txt` | F-1 dump（49,100 字节，含我插入的 preset） |
`f1-bogus-dump.txt` | PowerShell 破坏 YAML 的反例输出（**教训：PS 会改编码**） |
`sea-init.txt` / `sea-sdk-init.txt` | 新建 profile 的初始化输出 |

---

## 6. 会话日志（最关键证据）

`sea-home/sessions/**/session*.jsonl.zstd` —— **5 个真实会话**，全部可解压可读。

其中 `session-eb932e07-...` 是 F-1' 成功的那个：
- `preset_selected=True`
- `persona_in_prompt=True`
- system prompt 第二段 = `你是"数据核对"场景的专员。只产出差异集合，不改任何数据。完成判据：必须给出差异集合，不允许只说"看起来没问题"。`

**核对命令**：
```powershell
$env:PYTHONIOENCODING='utf-8'
python verification\verify_preset.py
```

---

## 7. 复现步骤

### 7.1 F-1'（preset 生效）

```powershell
cd "D:\file\AI Temp\DeepSeek\Agent自研"

# 1) 起 mock LLM（另开一个窗口/进程）
node verification\mock-llm.cjs 8899

# 2) 隔离 home
$env:DSH_HOME = "$PWD\verification\sea-home"

# 3) 跑一次 headless（必须带 select 探针才会生效）
$env:MOCK_API_KEY='mock-key-not-secret'
dsh --profile headless --patch verification\f1prime-dynamic.yml "say hi"

# 4) 读证据
python verification\verify_preset.py
```

### 7.2 F-3（DoneSpec）

```powershell
# 正向（应全 PASS，exit 0）
node verification\f3-donespec-check.mjs support-assign
node verification\f3-donespec-check.mjs doc-consistency
node verification\f3-donespec-check.mjs data-reconcile

# 反例（6 个注入，应全红且说出差异；脚本自身 exit 0）
node verification\f3-negative.mjs
```

---

## 8. 注意

- `sea-home` 是**完全隔离的 DSH home**，不影响日常 `~/.dsh`
- **没有读取或使用任何真实凭据**；mock provider 的 key 是占位字符串
- 所有 `zstd` 会话由 `dsh` 自己写出，未人工修改
- PowerShell 操作 UTF-8 YAML 会破坏编码 → **一律改用 Python 做字节级写入**
