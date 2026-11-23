# ECC (Everything Claude Code) 剖析

> 源码：`D:\refs\ECC\ECC-main`（v2.2.3，MIT，Affaan Mustafa）

## 一句话定位

ECC 自称 "Harness-native agent operating system"（`package.json:4`），实际形态是：**一套以 Markdown 为载体的 314 skills / 71 agents / 98 commands / 122 rules / 27 hooks 资产库，加一个 Node.js 选择性安装器（16 个目标适配器），把它「拷贝 + 变形」进 20 个工具的配置目录**。不是应用，不是运行时，是**跨 harness 的配置分发器**。

**关键纠偏：「620 个 skills」是误读。** `skills/` 下是 **314 个目录 = 314 个 skill**，620 是文件总数（314 个 `SKILL.md` + 306 个附属文件：`agents/openai.yaml`、`*.py`、`requirements.txt`、`provenance.json`）。证据：子目录数 314、`SKILL.md` 计数 314、`SOUL.md:4`/`AGENTS.md:3`/`.claude-plugin/plugin.json` 均称 314。同理 `agents/` 71 = 71 个 `.md`，`commands/` 98 = 98 个 `.md`。

## 规模实测表

| 目录 | 文件 | 子目录 | 职责 |
|---|---:|---:|---|
| `skills/` | 620 | 314 | 1 目录 = 1 skill，必有 `SKILL.md`（4.89 MB） |
| `agents/` | 71 | 0 | 子代理，扁平 `.md` + frontmatter |
| `commands/` | 98 | 0 | 斜杠命令；README 自承 "98 legacy command shims"（`:144,150`） |
| `rules/` | 122 | 22 | `common/` 9 + 21 语言目录 × 5（coding-style/hooks/patterns/security/testing） |
| `hooks/` | 9 | 2 | `hooks.json` 54 KB + metadata 边车 + codex/qoder 各 1 |
| `docs/` | 1540 | 26 | 16 语言翻译镜像 + design/architecture/releases/security |
| `scripts/` | 374 | 9 | `lib/`215、`hooks/`61、`ci/`22、install 适配器 28 |
| `tests/` | 534 | 11 | 456 个 `*.test.js` + 27 个 `test_*.py` |
| `schemas/` | 17 | 0 | JSON Schema（**无 skill/command/rule 的**） |
| `manifests/` | 10 | 3 | `install-modules.json` 38.5 KB + profiles + context-packs |
| `docker/` | 333 | 3 | context-profiles 204、**gateguard-effectiveness 119** |
| `pi/` | 213 | 1 | `pi/core` 精选编译产物 |
| `ecc2/` | 21 | 5 | **Rust 重写原型**（Cargo + TUI/session/worktree） |
| `.github/` | 35 | 3 | 15 个 workflow |
| 20 个 `.工具/` | — | — | 16 安装目标 + 3 插件清单 + `.github`/`.pr` |

点目录清单：`.adal .agents .claude .claude-plugin .codebuddy .codex .codex-plugin .cursor .gemini .hermes .kimi .kiro .openclaw .opencode .pi .qoder-plugin .qwen .trae .vscode .zed`（+非 harness 的 `.github`、`.pr`）。

## 核心机制一：跨 17 工具的可移植性

**它不是「统一源 + 编译分发」，而是「统一源 + 安装期变形 + 手工影子副本」三层混装。**

**第 1 层 canonical 源**：根目录 `agents/ skills/ commands/ rules/ hooks/` 唯一权威。`SOUL.md:17` 自供："Native agents, commands, and hooks remain authoritative in the repository until full manifest coverage is added."

**第 2 层 16 个安装目标**：`install.sh:42`/`install.ps1:76` 只是薄壳，最终 `exec node scripts/install-apply.js`。16 目标硬编码于 `install-apply.js:36-52`：`claude, claude-project, cursor, antigravity, codex, copilot, gemini, opencode, codebuddy, joycode, qwen, zed, hermes, kimi, openclaw, adal`，各一适配器于 `scripts/lib/install-targets/`（16 个 `*-project/home.js` + `registry.js` + `helpers.js`）。职责只到「解析根 + 拼路径」——`docs/SELECTIVE-INSTALL-ARCHITECTURE.md:113` 自承 "target adapters are still too thin"。

选择性安装契约完整（最强项）：`--profile/--modules/--skills/--with/--without/--dry-run/--json`（`install-apply.js:29-69`）+ 7 档 profile（minimal/opencode/core/developer/security/research/full）+ 每模块带 `targets[]`/`dependencies[]`/`defaultInstall`/`cost`/`stability`（`install-modules.json:3-31`）。

**第 3 层 格式变形（三种实现，不统一）**：
1. **IR 路线（对但只做 1/6）**：`schemas/agent.schema.json` 定义 `ecc.agent-ir.v1` = `{schema,id,name,description,model,tools[],color,body,frontmatter}`，意图精准："`tools` array holds source tool names **verbatim (lossless)**; each emitter maps them through its own tool table"（`:5-6`）。但 `agent-convert.js:39` 写死 `SUPPORTED = { claude: ['pi'] }`，其余 5 个 emitter 仍是注释里的 "Future emitters"。
2. **字符串改写路线**：`gemini-adapt-agents.js:6-17` 手写 `TOOL_NAME_MAP`（`Read→read_file`、`Edit→replace`、`Bash→run_shell_command`、`WebSearch→google_web_search`）；`qwen-adapt-agents.js` 同构。绕过 IR，各维护一张表。
3. **hook 适配器路线（唯一真 DRY）**：Cursor 20 个 hook 事件 vs Claude 8 个；`.cursor/hooks/adapter.js` 把 Cursor stdin JSON 规范成 Claude 格式再委派同一批 `scripts/hooks/*.js`。`README.md:1512` 称 "DRY adapter pattern"，`:1452` 列入 "Key architectural decisions"。**全仓最漂亮的设计。**

能力降级是明示的：`README.md:1327-1336` 把 harness 标为 stable/beta/experimental/instruction-only 并逐条写限制（Codex "hooks require an explicit trust decision and do not use Claude's hook profiles"；Cursor "Agent discovery varies by Cursor build"；Copilot Chat "ECC hooks are not adapted"）；`:1441-1448` 的跨工具能力表对 6 项能力逐格填。

## 核心机制二：skills 体系

**单元结构**：1 skill = 1 目录，**必需** `SKILL.md`；其余可选：`agents/openai.yaml`（Codex 子代理声明，4 个）、`scripts/*.py`（`pack.py`/`distill.py` 各 3 个）、`requirements.txt`、`provenance.json`、`README.md`。

**frontmatter schema —— 没有 JSON Schema，只有手写校验器**。`validate-skills.js:263-273` 仅强制 `name`、`description`；`skills/` 甚至允许完全无 frontmatter（`requireFrontmatter: false`，`:209`）。实测字段：`name/description` 必有，另见 `argument-hint`（`tdd-workflow`）、`license`、`homepage`、`metadata.origin`（281/314）、`metadata.version`、`metadata.author`、`metadata.clawdbot.emoji`（`customs-trade-compliance/SKILL.md:1-13`）。Codex 影子副本白名单更严（`validate-skill-host-compat.js:39-45`）：`{allowed-tools, description, license, metadata, name}`，`origin/version` 必须剥掉。

**body 约定靠软约束**：`## When to Activate` 覆盖 **281/314**；`## Anti-Patterns` 仅 **120/314（38%）**；行数上限 500/800 实测 **median 188、mean 261、>500 行 38 个、>800 行 5 个、最大 950**。

**分类（前缀家族，≥3）**：`agent-*` 9；`orch-*` 6；`laravel/kotlin/django/homelab/scientific-*` 各 5；`react/quarkus/skill/frontend/springboot/healthcare/ito-*` 各 4；`swift/security/ecc/continuous/motion/taste/benchmark/perl/network-*` 各 3。

抽样 10 个不同分类，共性 = **「When to Activate 触发卡 + 编号 Core Principles + 可照抄 Code Examples + Non-Negotiables/Hard Bans」**。粒度差 6 倍（`tdd-workflow` 590 行 22 KB vs `brand-voice` 98 行 3.6 KB），无统一深度标准。值得学的一处自省：`deep-research/SKILL.md:12-15` 顶部挂 "**Drift-prone skill.** …Verify the configured MCP tools and current API docs before promising coverage" —— skill 自带腐烂预警。

**路由元数据是最大的坑**：`manifests/context-packs/skill-triggers@1.json:2-12` → `coverage: {skills: 314, withTriggers: 34}`、`model.source: "manual-curation-pending-regeneration"`。**仅 34/314（10.8%）有触发词。** `context-profiles/lean@1.json` 只 eager 3 个（`configure-ecc`/`context-budget`/`ecc-guide`），budget 8000 tokens。

## 核心机制三：agents / commands / rules / hooks

**agents（71）**：`agents/<kebab>.md`，frontmatter `{name, description, tools, model}`，`model ∈ {haiku,sonnet,opus}`（`validate-agents.js:11-12` 强制 `model`+`tools`）。全部 71 个 body 首节都是复制的 **"## Prompt Defense Baseline"** 6 条（`agents/planner.md:7-13`）。工具面分层清晰：`planner/architect/code-explorer` 只 `Read,Grep,Glob`；`*-reviewer/build-error-resolver` 加 `Bash`；`doc-updater/code-simplifier` 才给写权；`docs-lookup` 唯一用 MCP（`mcp__context7__*`）；`comment-analyzer/conversation-analyzer` 降 haiku 省钱。

**agent vs skill**（它没写清、我提炼）：agent 有 `tools:`（能力裁剪）+ `model:`（成本分档），运行在隔离上下文、可由 Task 派生；skill 是被动加载的指令文档，无工具限制、无模型选择。数量比 314:71 ≈ 4.4:1，对应「知识多、执行角色少」。

**commands（98）**：frontmatter 极简，`description` **98/98**，`argument-hint` 15，其余零星（`name`10、`command`9、`allowed-tools`2、`disable-model-invocation`2、`agent/subtask/model/terminal` 各 1）。body 用 `$ARGUMENTS`（`code-review.md:10`）。它在主动做薄：`README.md:150` 叫 "98 legacy command shims"，`plan.md:10-12` 写明 "Run inline by default. Do not call the Task tool or any subagent by default."；20/98 提及 legacy/shim。

**rules（122）**：`common/` 9 文件（agents、code-review、coding-style、development-workflow、git-workflow、hooks、patterns、performance、security、testing）+ 21 语言目录 × 5 固定槽位。语义是**常驻加载**（`README.md:152`），安装粒度是语言：`./install.sh typescript python`（`rules/README.md:44-53`）。

**hooks（27）**：`hooks/hooks.json` 285 行 / 54,569 字节 / 27 hook，分布 8 事件：

| 事件 | 组 | hook |
|---|---:|---:|
| PreToolUse | 10 | 10 |
| Stop | 8 | 8 |
| SessionStart / PostToolUse / PostToolUseFailure | 各 2 | 各 2 |
| UserPromptSubmit / PreCompact / SessionEnd | 各 1 | 各 1 |

`schemas/hooks.schema.json` 允许 18 事件（含 `PermissionRequest`、`SubagentStart/Stop`、`TeammateIdle`、`WorktreeCreate/Remove`），3 种动作 `command`/`http`/`prompt|agent`。三档 profile `minimal/standard/strict`（`ECC_HOOK_PROFILE`，`hooks/README.md:162-165`），可按 ID 单关（`ECC_DISABLED_HOOKS`，`README.md:1379`）。

**一个真正聪明的防漂移机制**：`hooks/hooks.metadata.json` 边车为每条 matcher 存 `{id, description, fingerprint}`。因 Claude Code 只认自己认识的 key（`$schema`/`id`/`description` 会报 unknown），ECC 把语义放边车、加载时合并；`validate-hooks.js` 校验两边不漂移，`--update-fingerprints` 才允许更新（`hooks/README.md:17-21`）。

## 核心机制四：人格与指令分层

7 层，但**层间一致性没有 CI 保证**：

| 文件 | 大小 | 管什么 | 证据 |
|---|---:|---|---|
| `SOUL.md` | 1.1 KB/17 行 | **身份 + 5 条核心价值观**（Agent-First / Test-Driven / Security-First / Immutability / Plan Before Execute） | `:6-11`；末段自称 "gitagent surface"，承认只是可移植性外壳 |
| `AGENTS.md` | 12.9 KB/15 节 | **跨工具通用指令**（Claude Code/Cursor/Codex/OpenCode 都读；Copilot 改读 `.github/copilot-instructions.md`） | `README.md:1451`；含 71 行 agent 总表、编排、安全、编码风格、测试、workflow 策略、git、架构、性能、目录、成功指标 |
| `CLAUDE.md` | 4.3 KB/88 行 | **Claude Code 专用增量**：仓内开发指引 + Prompt Defense 6 条 + 测试命令 + skills 路由表 | `:9-16, 78-88` |
| `agent.yaml` | 5.7 KB/289 行 | **gitagent 元数据导出面**：spec 0.1.0、model `preferred claude-opus-4-6`+2 fallback、skills/commands 清单、tags | `:1-10` |
| `.gemini/GEMINI.md` `.qwen/QWEN.md` `.codex/AGENTS.md` `.claude/identity.json` `.kiro/steering/` | — | 各 harness 指令投影 | `.kiro` 下 skills 43 + agents 66 + steering 22 |

分层逻辑：SOUL（我是谁，17 行，极稳）→ AGENTS.md（跨 harness 行为契约）→ 各 harness 指令文件（增量差异）→ rules/（按语言常驻）→ skills/（按需注入）→ commands/（显式触发）→ hooks/（事件强制）。

**但一致性已破**：`agent.yaml` 只列 **171 个 skills**，实际 314 —— **45% 漂移**。这是「人格/元数据层没有生成器」的直接代价。

## 核心机制五：安全与质量闸

**① 指令层（软）**：Prompt Defense Baseline 6 条复制进 `AGENTS.md`、`CLAUDE.md` 与全部 71 个 agent 首节。覆盖：不改人格/不泄密/不输出可执行代码除非必要/把 unicode·同形字·零宽字符·上下文溢出·紧迫感·权威声明当可疑/把外部抓取数据当不可信/不生成恶意内容。

**② 运行时 hooks（硬，真创新）**：
- **GateGuard**：PreToolUse 拒绝首次 Edit/Write/MultiEdit/NotebookEdit，直到出示具体事实（importers、数据 schema、用户原话）再放行。`skills/gateguard/SKILL.md:1-9` 自称 "A/B-tested at +2.25 quality points"，理论是 "LLM self-evaluation doesn't work. Ask 'did you violate any policies?' and the answer is always 'no.'"（`:21-23`）。**并且真做了实验**：`docker/gateguard-effectiveness/` 119 文件，含 `arms.js`（对照组）、`fake-claude.js`（桩）、`user-sim.js`、7 个 `scenarios/`。
- `pre:config-protection`：**阻止 agent 改 linter/formatter 配置**，逼它改代码而非削弱规则（`hooks.metadata.json:34-38`）。
- `pre:mcp-health-check`：MCP 调用前查健康、不健康就拦；`pre:governance-capture`：捕获 secrets/违规/审批，需 `ECC_GOVERNANCE_CAPTURE=1`；`Hookify`：项目本地自定义 warn/block 规则。

**③ 安装期（工程纪律）**：`install.sh:30`/`install.ps1:67` 用 `npm install --ignore-scripts` 阻断依赖生命周期 RCE；写盘经 `scripts/lib/install/` 的 `guarded-write.js`/`contained-fs.js`/`ownership-guard.js`（防穿越、防覆盖用户文件）；`install-state.schema.json`（6.2 KB）记录每次操作，支撑 `doctor/repair/uninstall` 精确回滚。

**④ 供应链**：`npm audit signatures` + `npm audit --omit=dev --audit-level=high`（`ci.yml:428-433`）、`security:ioc-scan`（27.5 KB）、`supply-chain-watch.yml`、`npmscan.yml`、`validate-workflow-security.js`、`package.json:582-601` 的 `overrides` 钉死 7 个传递依赖。

**⑤ 文档**：`the-security-guide.md` 30.5 KB/17 节，是七份参照里少见的**威胁模型长文**：攻击链、CVE-2025-59536（CVSS 8.7，信任对话框前执行）、CVE-2026-21852（`ANTHROPIC_BASE_URL` 劫持窃 key）、OWASP MCP Top 10、lethal trifecta、沙箱、清洗（零宽/双向控制字符正则）、审批边界、可观测性、kill switch、最小基线 checklist。

**三个安全漏洞（我们的机会）**：
1. **AgentShield 不在仓里**。`README.md:153` 说 "AgentShield Included"，实为另一 npm 包 `ecc-agentshield`（`package.json` 无此依赖，仓内无源码）—— 审计能力无法自证。
2. **`.gitleaksignore` 是死配置**。文件在（110 字节，豁免 `docs/es/skills/api-design/SKILL.md:306` 示例 key），但 `.github/` 全目录 **gitleaks 出现 0 次**，无 gitleaks.toml，CI 不跑。
3. **hooks 配置本身不可审计**：27/27 个 hook 全是 `node -e "<内联脚本>"`，最长单条 **2,042 字符**，54,569 字节挤在 285 行。无法做有效 PR diff review，也无法单测隔离 —— 恰与它自己「配置即攻击面」的主张矛盾。

## 质量保障（测试/CI）

**测试**：`tests/` 534 文件，**456 个 `*.test.js`** + 27 个 `test_*.py`，分布 `lib/`184、`scripts/`91、`hooks/`76、`ci/`45、`skills/`23。自研 runner `tests/run-all.js` 支持 `ECC_TEST_JOBS`（进程池）、`ECC_TEST_ONLY/SKIP`（过滤）、`ECC_TEST_SERIAL`（改共享 checkout 的串行）。覆盖率门是硬的：`c8 --check-coverage --lines 80 --functions 80 --branches 80 --statements 80`（`package.json:539`）、Python `--cov-fail-under=80`。

**CI**：15 个 workflow。`ci.yml` 13 lane（OS ×{ubuntu,windows,macos} × Node{18,20,22} × PM{npm,pnpm,yarn,bun}），分 `full` 与 `pm` 两类车道（注释解释从 33 路降到 13 路的理由）。Job：`test`/`pack-installer`/`packed-install-lifecycle`/`validate`/`pi-core`/`security`/`coverage`。

**`validate` job 是 12 个独立校验器**，全部 `continue-on-error: false`：validate-agents / hooks / commands / skills / skill-host-compat / install-manifests / workflow-security / rules / catalog / command-registry / unicode-safety / no-personal-paths。

**最值得抄的防腐烂机制**：`scripts/ci/catalog.js` 从文件系统数出 agents/commands/skills 真值，再与 `README.md`、`AGENTS.md`、`SOUL.md`、`.gemini/GEMINI.md`、`README.zh-CN.md`、`docs/zh-CN/*`、`.claude-plugin/plugin.json`、`marketplace.json` 的宣称逐一对账，不一致即 CI 红（`:32-60`）。**README 里的数字不能撒谎。**

**但它对「内容腐烂」只是软门**：
- `validate-skills.js:15-18` 明写 frontmatter 问题 "default to WARN so CI does not break while pre-existing data defects are being cleaned up out of band (see #1663)"，要 `--strict` 才变错 —— 而 `ci.yml:302-304` 就是 `node scripts/ci/validate-skills.js`，**没带 `--strict`**。
- 500/800 行上限、`When to Activate`、`Anti-Patterns`、name-matches-dir 等 checklist 项只在 `--strict-checklist` 下失败 —— 全仓 grep 该参数，**只出现在 validator 自己源码里，无任何调用点**。
- 结论：**结构性保证有（每个都有 SKILL.md、目录像样），内容保证没有（写什么、多长、有无反模式、有无触发词、翻译到不到位，全部只警告）。**

## 它最强的地方（5 条）

1. **选择性安装的「契约」设计是 7 个参照里最完整的**。不只复制文件，而是能回答：请求了什么、解析出什么、复制/生成了什么、做了哪些目标特定变换、ECC 拥有哪些可安全删除/修复的东西（`docs/SELECTIVE-INSTALL-ARCHITECTURE.md:7-16` 原文）。落地为 `install-state.schema.json` + `--dry-run --json` + `doctor/repair/uninstall` 从状态快照反推。多数 agent 配置项目根本没有「安装状态」概念。

2. **GateGuard 是「可测量的质量闸」，不是口号**。拒绝首次编辑直到出示事实，并带完整 A/B 实验台（119 文件，含对照组、用户模拟、7 场景）。七份参照里唯一把自己的 gate 拿去跑对照实验的。

3. **hooks 边车 + 指纹漂移检测**。为每条 matcher 存指纹，重排主配置不重排边车、或改命令不改边车，CI 直接失败（`hooks/README.md:17-21`）。这是「事件接线」层防腐，比内容层难得多。

4. **`catalog.js` 让文档数字无法撒谎**。9 个文件的宣称数量与文件系统对账，CI 红即文档失真。配合 `command-registry:check`、`context-profiles:check`、`carrier-closure:check` 形成「声明-实现」双向校验链。

5. **罕见的自我批评式架构文档 + 诚实能力矩阵**。`docs/SELECTIVE-INSTALL-ARCHITECTURE.md:105-140` 专设 "Current Coupling Still Present" 列自己 4 条耦合；`README.md:1318-1336` 逐条标 limitation 并附 issue 号（#2674、#2489、#2626、#2617）。单维护者敢这么写，可信度远超营销式 README。

## 它的短板/漏洞（5 条 —— 我们的机会）

1. **可移植性是「复制粘贴 + 手工同步」，不是编译。** canonical 314 skills，Codex 影子树 `.agents/skills/` 只有 **47**（15%），Cursor `.cursor/skills/` 只有 **12**（3.8%），Kiro `.kiro/skills/` 43。`CONTRIBUTING.md:429` 原文："**Keeping these subsets in sync is manual**; mention in your PR if you updated them." 而设计上正确的 Agent IR 只有 **1 个 emitter**（`agent-convert.js:39`：`SUPPORTED = { claude: ['pi'] }`）。→ **机会：一份源 + N 个确定性 emitter + CI 校验副本 hash，把「手工同步」变成编译器。**

2. **hook 平权跨工具时崩塌：27 → 1。** Claude Code 27 个（8 事件），Codex 版 `hooks/codex-hooks.json` 只有 **1 个** SessionStart bootstrap，Qoder 版同样 **1 个**。即「跨工具 agent OS」在别的工具上只剩指令层，**运行时强制层没了**。→ **机会：把 gate 抽成 harness-neutral 的「策略 + 事件归一化层」，像 Cursor adapter 那样一套逻辑多端复用。**

3. **schema 真空：17 个 JSON Schema，零个管 skill / command / rule。** 管的是 install-state、hooks、agent-IR、memory、context-profile、state-store —— 三大核心资产全靠手写 validator，且默认只 WARN。后果实测：38 个 skill >500 行、5 个 >800 行、最大 950；`Anti-Patterns` 覆盖仅 120/314。→ **机会：给 skill/command/rule 出正式 schema（必填字段、body 必需章节、行数预算、触发词），CI 硬失败。**

4. **元数据层肉眼可见地腐烂，且仓内自己承认。** `agent.yaml` 171/314（45% 漂移）；`skill-triggers@1.json` 仅 **34/314** 有触发词，且 `model.source` 写着 `"manual-curation-pending-regeneration"`；16 语言翻译对 314 的覆盖是 ja-JP 228、zh-CN 183、es 38、tr 38、zh-TW 16、ko-KR 15，其余 0-2 —— 坐标系彻底不对称。→ **机会：所有派生物（清单、触发词、翻译、插件 manifest）一律从单一源生成 + CI `--check`，禁止手写。**

5. **hooks 配置是 285 行不可审计巨块 + 安全配置留白。** 27/27 全为 `node -e` 内联（最长 2,042 字符），54,569 字节压 285 行；这是可维护性灾难，也与 `the-security-guide.md`「配置即攻击面」自相矛盾（无法逐条 PR 审查、无法单测隔离、跨平台引号/路径易翻车）。同时 `.gitleaksignore` 存在但 CI 里 gitleaks **0 次**，豁免文件成孤儿。→ **机会：hook 一律指向可测的独立脚本（`scripts/hooks/*.js` 已有 61 个），配置只留 `{id,event,matcher,command,timeout}`；接入真 secret 扫描并对 314 个 skill 正文扫描（目前零检查）。**

**第 6 条（顺带）**：**知识资产无去重**。4.89 MB 里有明显近重复族：`springboot-*/quarkus-*/django-*/laravel-*` 各 4 件套（patterns/security/tdd/verification），`orch-*` 6 个，`continuous-learning` 与 `-v2` 并存，`council` 与 `council-multi-model` 并存，`motion-foundations/patterns/advanced` 三层。没有 base + override 继承机制，靠复制扩族，维护成本随数量线性上升。

## 对我们 10 条可直接继承的东西

1. **`ecc.agent-ir.v1` 的 IR 定义原文抄走**（`schemas/agent.schema.json`）：`tools` 保源工具名**逐字无损**、`frontmatter` 保原始 YAML 做 round-trip、`id` 用文件名 stem 作稳定键。这是多端发射唯一正确的数据模型 —— 我们只需补到 N 个 emitter，而不是从 1 个开始。

2. **选择性安装三件套**：`install-modules.json`（`targets[]` 白名单 + `dependencies[]` + `defaultInstall` + `cost` + `stability`）+ `install-profiles.json`（7 档画像）+ `install-state.schema.json`（每操作落盘），直接支撑 `--profile/--modules/--with/--without/--dry-run --json` 与 `doctor/repair/uninstall`。

3. **hooks 边车 + fingerprint 漂移检测**：`{id, description, fingerprint}` 与主配置分离，重排即失败，`--update-fingerprints` 才允许变更。**任何「事件 → 动作」的接线都该有这个机制。**

4. **`catalog.js` 的「声明-实现」对账模式**：从文件系统数真值 → 与所有文档/manifest 逐一对账 → 不一致即 CI 红。扩到我们全部文档与 manifest。

5. **Cursor hook adapter 的归一化思路**（`.cursor/hooks/adapter.js`）：异构 harness 的 stdin JSON 先规范成内部统一事件格式，再委派同一批脚本。**跨工具复用运行时逻辑最省力的路径**，远胜每端重写。

6. **GateGuard 的「事实强制」闸**：不搞自评（"are you sure?" 永远答 yes），而要求出示 importers / 数据 schema / 用户原话等**可验证事实**才放行首次写操作。附赠其方法论：对照组 + 桩 + 用户模拟 + scenario 目录。

7. **`pre:config-protection` 这条具体策略**：禁止 agent 改 linter/formatter 配置，逼它改代码而非削弱规则。极低成本、极高收益，直接抄。

8. **`--ignore-scripts` 安装纪律 + 受管写盘**：安装期阻断依赖生命周期脚本；写盘经 `guarded-write / contained-fs / ownership-guard`（路径穿越、覆盖用户文件、所有权边界三重保护）。这是配置分发器能被信任的前提。

9. **hooks profile 三档 + 按 ID 精关**：`minimal/standard/strict` + `ECC_HOOK_PROFILE` + `ECC_DISABLED_HOOKS` + `ECC_SESSION_START_MAX_CHARS`/`ECC_MAX_INJECTED_INSTINCTS`/`ECC_INSTINCT_CONFIDENCE_THRESHOLD` 这类上下文预算旋钮。**给用户「降档」的能力比给「开关」更重要。**

10. **SOUL.md 的极简人格层**：17 行、5 条不可谈判原则，其余全部下推到 AGENTS.md / rules / skills。**人格层越薄越稳、越不易腐烂** —— 反例就是它自己的 `agent.yaml`（171/314 漂移）。

**一句话总结竞争策略**：ECC 赢在**资产广度 + 安装契约 + 诚实的自我批评**，输在**派生层全手工**（影子副本 15%、触发词 10.8%、agent.yaml 漂移 45%、翻译不成比例）。要超过它不必写更多 skill，只需把「一份源 → 确定性生成 → CI 硬校验」这条它只做了 1/6 的编译器真正做完整。
