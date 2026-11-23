# Hermes Agent 自我进化机制逆向

> 逆向对象：`NousResearch/hermes-agent`（MIT）。**只提取机制与模式，不抄代码原文。**
> 证据基座（本机已抓，不联网）：
> - `prototype/h-clean-arch.md`（架构，329 行）
> - `prototype/h-clean-skills.md`（技能系统，2014 行）
> - `prototype/h-clean-memory.md`（记忆系统，982 行）
> - `prototype/h-clean-tools.md`（工具系统，764 行）
> - `prototype/h-hermes-readme.txt`（README，243 行）
> - 辅助参证：`prototype/h-{skills,memory,tools,arch}.html`（同页 HTML 存档，用于确认侧栏/章节存在性）
>
> 读法：**📄 = 文档明确写的**（附原文）；**🔶 = 我从架构推出来的**（附推理链，可被推翻）。
> 证据格式 `〔skills:1012〕` = `h-clean-skills.md` 第 1012 行。

---

## 0. 一页结论

| # | 机制 | 一句话 | 证据 |
|---|---|---|---|
| 1 | 触发不是"定时器"，是**回合结束后的 fork** | 每轮结束复制一份带热门 prefix 的子会话去复盘，用 `nudge_interval` 控制频率 | 〔memory:699-714〕〔memory:652-657〕 |
| 2 | 两个仓库，**两种税** | 事实进 2200 字上限的 MEMORY.md（每轮都付 token），流程进 SKILL.md（只在命中时加载） | 〔skills:993-997〕〔memory:9-15〕 |
| 3 | **渐进式披露**是让"无限生长"付得起的关键 | 索引常驻 prompt（~3k token），正文 `skill_view(name)`，子文件 `skill_view(name, path)` | 〔skills:230-236〕 |
| 4 | 写入是**协议**，不是自由文本 | memory 只有 add/patch/remove（**故意删掉 replace**）；skill 只有五个形状严格分开的 action | 〔memory:248-255〕〔skills:1091-1107〕 |
| 5 | 人类闸门是**暂存目录**，不是弹窗 | `~/.hermes/pending/skills/` 落盘、跨重启存活、gist/diff/approve/reject 四段式 | 〔skills:1134-1146〕 |
| 6 | 可逆性有**五条退路** | 锁 / origin hash 保护 / reset --restore / journey 归档 / 版本化 frontmatter | 〔skills:1156-1169〕〔skills:1874-1913〕 |

**它真正"进化"的不是模型，是三个可写文件系统 + 一套让写入不敢乱来的闸。** 没有微调、没有权重更新、没有自改核心代码。

---

## 1. 技能自我创造的完整闭环

### 1.1 谁触发、什么时候触发

📄 **触发源有四个，其中三个是 agent 自主的**：

1. **前台回合**（foreground turn）——系统提示词直接要求：
   > "The system prompt asks the agent to record a non-trivial workflow with `skill_manage` for future reuse. In practice that covers: When it worked out a multi-step workflow worth repeating / When it hit errors or dead ends and found the working path / **When the user corrected its approach**" 〔skills:1000-1006〕

   注意第三条：**被纠正**是最高价值触发点。这不是"做得好就写"，是"做错过才写"。

2. **回合结束后置审查**（background review）：
   > "The background review can suggest or stage skill changes after a session" 〔skills:995-996〕
   > "After a turn, the background self-improvement review may quietly save a memory or update a skill." 〔memory:652-653〕

3. **curator 的 consolidation pass**（见第 2 节）〔skills:1012〕

4. **`/learn` 显式命令**（人类发起）：
   > "/learn is the fast way to turn something you already know — or a pile of reference material — into a reusable skill, without hand-writing the SKILL.md." 〔skills:158-161〕
   > "There is no model-tool footprint: /learn builds a standards-guided prompt and hands it to the agent as a normal turn. The agent saves the result with the `skill_manage` tool, so the write-approval gate applies if you have it on." 〔skills:222-229〕

📄 **频率控制不在"何时跑"，在"跑几次"**：
> "To reduce review work ... adjust `memory.nudge_interval` / `skills.creation_nudge_interval`" 〔memory:751-755〕

🔶 **推理**：这两个是**计数器**（每 N 轮允许一次），不是 cron 表达式。依据：文档把它和 `max_input_tokens`、`enabled`、`defer` 并列为"降低审查工作量"的旋钮 〔memory:751-757〕，且后置审查本身是"per turn 可能发生"的 fork 〔memory:781-782〕。若它是 cron，就不需要"nudge interval"这种措辞。**这一点我无法从现有资料 100% 证实**——curator 页正文未抓取（见 §2.2）。

### 1.2 写到哪里

📄 单源真相目录：
> "All skills live in `~/.hermes/skills/` — the primary directory and source of truth. On fresh install, bundled skills are copied from the repo. Hub-installed and agent-created skills also go here. **The agent can modify or delete any skill.**" 〔skills:8-10〕

📄 但落点可重定向：
> "`skill_manage create` writes there [create_dir]. New skills (including category subdirectories) are created under `create_dir` instead of the local skills dir. ... **The agent's instructions follow the config.** Every agent-facing instruction that names the skill-creation path — the `skill_manage` tool description and related prompt text — **dynamically renders the configured directory**" 〔skills:721-730〕

这条设计很关键：**路径只在一处配置，提示词跟着配置渲染**。避免了"工具写到 A、提示词说写到 B"的经典漂移。

📄 优先级四层（决定了"写进去是否会被看见"）：
> "project → local (`~/.hermes/skills/`) → `skills.create_dir` → `external_dirs`" 〔skills:775-782〕

📄 **curator 与 create 的落点边界**：
> "Existing skills are still modified in place wherever they live; bundled skill sync, the hub, and **the curator keep operating on the profile-local dir**." 〔skills:739-741〕
> "project skill directories are treated as repo-owned: **autonomous skill maintenance (the curator) never modifies them**, and new agent-created skills always go to `~/.hermes/skills/`." 〔skills:786-789〕

🔶 **推理**：这是一条**信任边界**，不是路径偏好。理由：project skills 会随 `git pull` 变化，若允许 curator 改写，等于让远端仓库内容通过本地自治流程反向污染本地技能库。文档同节明确对 project skills 做了"扫描不合格即 隔离"〔skills:814-824〕，可见作者把 repo 内容当不可信输入。因此"curator 只碰 profile-local"是安全约束。

### 1.3 怎么防重复（四层，缺一层就漏）

| 层 | 机制 | 证据 |
|---|---|---|
| **L1 同名跨目录** | 高优先级目录胜出，被遮蔽的记 `shadowed` 日志 | "the higher-precedence directory wins everywhere ... The hidden copy is logged as shadowed." 〔skills:790-798〕 |
| **L2 同目录同名** | **拒绝猜**，两边都按相对路径列出，裸名报错 | "two **different** skills that share a name are never guessed between. Both are listed under their exact relative path (for example `a/one` and `b/two`), and loading the bare name fails with `Ambiguous skill name dup-demo: use one of a/one, b/two`" 〔skills:799-807〕 |
| **L3 内容重复** | `/learn` 同主题**折叠进已有技能** | "Re-running `/learn` with new material on the same topic **folds it into the existing skill rather than creating a duplicate**." 〔skills:203-206〕 |
| **L4 结构膨胀** | linter 三条（见 1.4） | 〔skills:1035-1046〕 |

📄 记忆侧的同层机制（可对照）：
> "The memory system automatically rejects exact duplicate entries. If you try to add content that already exists, it returns success with a 'no duplicate added' message." 〔memory:380-382〕

🔶 **推理**：L2 的"不猜"是刻意设计，代价是可用性（用户要写更长的名字）。判据是注释"never guessed between" —— 作者宁可报错也不做模糊匹配，因为技能是**会被执行的流程文档**，猜错 = 执行错流程。这跟我方"同一事实两处实现必然打架"是同一类教训。

### 1.4 怎么写才合格

📄 **合格的定义（这是全篇最硬的一段）**：
> "A skill is the instructions for doing a class of task the most efficient and correct way ... it captures **lessons, not logs**: a pitfall is a generalizable rule **plus one clause of why (the mechanism)**, attached to the step it affects, **stated once**. 事件叙述、PR/issue 编号、日期、引用的聊天记录不是技能内容；the rule has to stand without the story behind it. Always-on rules live in SKILL.md itself; `references/` holds a small set of files named by topic (a decision table, a recipe, provider quirks), **extended in place rather than accumulated one file per session**. Skills also do not restate what is already loaded every turn (the repo's AGENTS.md, tool schemas)." 〔skills:1009-1027〕

📄 **linter 只有三条，且只警告不阻断**：
> "`skill_manage` runs an **advisory** linter on create, on SKILL.md patches, and on `references/` writes and returns its findings in the tool result. Three rules exist specifically for this shape: `incident-log-shape` (a body dense in PR/issue numbers), `references-sprawl` (more than 60 reference files), and `oversized-body` (a SKILL.md body past ~24k chars — `skill_view` loads the whole file and it stays in context for the rest of the session). **They warn; they never block a write.**" 〔skills:1028-1047〕

📄 **正文骨架（frontmatter + 四节）**：`name / description / version / platforms / metadata.hermes.{tags,category,fallback_for_toolsets,requires_toolsets}` + `## When to Use` / `## Procedure` / `## Pitfalls` / `## Verification` 〔skills:252-334〕

📄 **`description` 有硬约束**（`/learn` 路径）：
> "authors a skill that follows the house authoring standards (**≤60-char description**, the standard section order, Hermes-tool framing, **no invented commands**)" 〔skills:166-170〕

🔶 **推理**：三条 linter 全部指向**同一根因的三个面**——技能文件会长期驻留上下文/文件系统，所以三条其实都是"成本通胀检测"：
- `oversized-body` → 直接吃 context（原文给了机制解释）；
- `references-sprawl` → 检索面变宽、命中率下降（60 个文件时按主题命名就失效了）；
- `incident-log-shape` → 体积膨胀且不可泛化（与"lessons not logs"同源）。
所以这三条不是风格检查，是**成本与可复用性的代理指标**。

### 1.5 写坏了怎么退（五条退路，各有适用面）

| 退路 | 适用 | 机制 | 证据 |
|---|---|---|---|
| **① 暂存即否决** | 写入前 | `pending/skills/` 落盘，`/skills reject <id>`，跨重启存活 | 〔skills:1134-1146〕 |
| **② 锁** | 单技能 | 锁定后 `skill_manage`/`write_file`/`patch`/**`terminal` 全部拒写**，但**仍可读可加载**；人自己改仍然可以 | 〔skills:1156-1169〕 |
| **③ origin hash 保护** | 内置技能 | 内容变更即视为 `user-modified`，"skipped forever, so your edits never get stomped" | 〔skills:1885-1891〕 |
| **④ reset 重基线** | 内置技能改乱了 | 清 manifest 项（保留你的副本）或 `--restore` 重拷原版 | 〔skills:1909-1929〕 |
| **⑤ 归档删** | 任意技能 | journey 删除 = archived（**restorable**），不是物理删 | 〔memory:481-483〕 |

📄 ②的实现力度值得单记：锁同时封住 **`terminal`**——
> "A locked skill stays readable and auto-loadable, but `skill_manage`, `write_file`, `patch` and `terminal` all refuse to change it, **in every kind of session**; your own edits still work." 〔skills:1158-1163〕

🔶 **推理**：封 `terminal` 是必需的——否则 agent 用 `rm SKILL.md` 就能绕过所有 skill_manage 层的锁。这是"闸要放在最底层"的正确示范。

### 1.6 闭环全图

```
                     ┌── 前台回合（被纠正/踩坑后）
 四个触发 ───────────┼── 回合结束后置审查 fork ──┐
                     ├── curator consolidation   │
                     └── /learn（人类显式）      │
                                                 ▼
                                     skill_manage(五形状 action)
                                                 │
                            ┌────────────────────┴──────────────┐
                            ▼                                   ▼
                advisory linter（3 条，只警告）        write_approval?
                    incident-log-shape                        │
                    references-sprawl             false ──────┤
                    oversized-body                true ───────┤
                                                              ▼
                                                pending/skills/<id>.json
                                                gist / diff / approve / reject
                                                              │
                                                              ▼
                                        ~/.hermes/skills/<cat>/<name>/SKILL.md
                                                              │
                     ┌────────────────────────────────────────┤
                     ▼                    ▼                   ▼
              下次会话 system prompt 索引   skill_view 按需加载    journey 时间线
                                                                            │
                                                          写坏了：锁 / reset / 归档 ◄─┘
```

---

## 2. curator（策展人）到底是什么

### 2.1 先把"能确定的"钉死（四条硬证据）

| # | 事实 | 原文 |
|---|---|---|
| A | **它有独立 CLI 命名空间和 Desktop 开关**，是人可操作的子系统，不是隐藏内部函数 | "`hermes curator lock <skill>` (or the lock switch in Desktop)" 〔skills:1156-1157〕 |
| B | **它是文档承认的第三个技能写入者**，与"前台回合""后置审查"并列 | "Whether written in a foreground turn, **by the background review**, or **by the curator's consolidation pass**" 〔skills:1012-1013〕 |
| C | **它是"autonomous skill maintenance"**，只对 profile-local 目录工作，绝不碰 project 目录 | "autonomous skill maintenance (the curator) never modifies them" 〔skills:787-788〕<br>"the curator keep operating on the profile-local dir" 〔skills:740〕 |
| D | **它有独立的文档页**，在侧栏与 Memory / Memory Providers 平级 | `h-memory.html` 中 `href="/docs/user-guide/features/curator"` 出现为 Memory 页的 "Previous" 链接；侧栏 `<span>Curator</span>` |

📄 还有一条间接但重要的：**技能变更会被它检出并通知下一轮**
> "When a skill is installed, created or removed while a conversation is open (from the Skills Hub, `hermes skills install` in another terminal, a plugin, **the curator**, or the agent itself), your next message to the agent carries a short note naming the new skills ... and the removed ones." 〔skills:240-246〕

### 2.2 资料缺口（必须说清，否则就是编）

⚠️ **本机没有 curator 页正文**（`h-clean-*.md` 四份里没有，HTML 只留了侧栏链接）。所以下面三类问题**无法从现有证据回答**：

1. 它是**常驻后台进程**、**cron 定时任务**，还是**agent 的一种运行模式**；
2. 它的触发节奏（每次启动？idle？每 N 次会话？`hermes update` 之后？）；
3. consolidation pass 的**算法**（是"合并同主题技能""删死技能""重排 references"中的哪些）。

### 2.3 我倾向于的判断（🔶 全部标注为推测）

🔶 **推测一：它不是独立守护进程，而是"技能库维护任务"，挂在已有的两条调度腿上（cron 或启动/更新时）**。
推理链：
- 架构文档的 `Directory Structure` 把 `cron/` 单列（"Scheduler (jobs.py, scheduler.py)"）〔arch:122〕，把 `agent/memory_manager.py`、`agent/memory_provider.py` 单列〔arch:63-65〕——**但没有任何 curator 模块/文件出现**〔arch:41-128〕。
- 若它是一个常驻服务，按这份目录树的详尽程度（连 `ansi_strip.py` 都列了）不该缺位。
- 因此更可能是：**能力寄生在既有的"技能维护"代码路径里**，由 cron 或 update/session 边界驱动。
- 反证可能：目录树本身不完整（它只是"top-level map"）。**这条推测的置信度我给中等，不是高。**

🔶 **推测二：consolidation pass 的产物标准 = 与新建技能同一套作者标准，只是作用对象不同**。
推理链：
- 文档把三种作者（前台/后置审查/curator）**放在同一个句子里**，说"it captures lessons, not logs"〔skills:1012-1019〕——主语是这三种作者共同的产出。
- 紧接着的规则是 "references/ ... **extended in place rather than accumulated one file per session**"〔skills:1022-1024〕。"extended in place"（就地扩展）这个动作**只有对已存在的技能才成立**，正是 consolidation 的语义。
- 所以：**consolidation pass 至少包含"把新学到的内容就地并入已有技能，而不是每次新建一个文件"**。这条我认为置信度较高。

🔶 **推测三：curator 不会"删技能"，只会"归档"**。
推理链：整个技能生命周期里，删除的唯一软路径是被明确记录为可恢复的——
> "`hermes journey delete <node>` ... Skills are **archived (restorable)**, memory chunks are removed." 〔memory:480-483〕
若 curator 有硬删能力，这条"可恢复"承诺会在自治流程下失效。

### 2.4 给工程的一句话定性

> **curator 是"技能库的垃圾回收 + 归并器"，形态未证实（推测为 cron/边界触发的维护任务），能力边界已被证死：只碰 profile-local、不碰 project、有 lock 可被人类冻结、产出必须符合与新建技能相同的作者标准。**

**对我们的直接含义**：不要急着做"后台进程"。先做**归并规则 + 冻结开关**——这两件在任何形态下都需要，且是 curator 真正的价值所在。

---

## 3. 渐进式披露（Progressive Disclosure）三级加载

### 3.1 三级结构（含成本数字）

📄 原文：
> "Level 0: `skills_list()` → `[{name, description, category}, ...]` (**~3k tokens**)
>  Level 1: `skill_view(name)` → Full content + metadata (varies)
>  Level 2: `skill_view(name, path)` → Specific reference file (varies)
>  The agent only loads the full skill content when it actually needs it." 〔skills:230-236〕

| 级 | 调用 | 返回 | 常驻性 | 成本 |
|---|---|---|---|---|
| **L0** | 无调用（**在 system prompt 里**） | name + description + category | 每轮都在 | ~3k token/轮 |
| **L1** | `skill_view(name)` | 整个 SKILL.md + metadata | 进会话，**本会话剩余轮次都在** | 技能体量（上限被 linter 压在 ~24k 字符） |
| **L2** | `skill_view(name, path)` | 单个 reference 文件 | 同上，但只一份 | 单文件体量 |

### 3.2 边界在哪（这是本题的实质）

📄 **边界一：L0 不是 tool call，是 prompt 的一部分。**
> "The list of skills the agent picks from **is part of the conversation's system prompt**, which stays fixed so the provider's prompt cache keeps working." 〔skills:239-242〕

🔶 **推理**：`skills_list()` 在三级表里写作工具调用，但同一份文档又说"列表在 system prompt 里"。这两句只有在一种解释下不矛盾：**system prompt 里放的是索引（L0 内容），`skills_list()` 是同一份索引的按需重读**（用于会话中途新增技能后刷新视野、或工具集被裁剪的场景）。证据支撑：`--toolsets skills` 可以单独开一组技能工具去问"What skills do you have?"〔skills:144-153〕。

📄 **边界二：L1 一旦加载，**整个文件驻留**到会话结束**——这是 linter 存在的直接原因：
> "`oversized-body` (a SKILL.md body past ~24k chars — `skill_view` loads the whole file and **it stays in context for the rest of the session**)" 〔skills:1042-1046〕

📄 **边界三：references 是"免费直到被需要"**：
> "Reference files cost nothing until a question needs one — the agent loads them on demand with `skill_view`, so **query cost stays proportional to the answer, not the source**." 〔skills:199-203〕

📄 **边界四：技能可自隐藏，连索引都不进**。平台与工具集条件在**索引生成前**就过滤：
> "When set, the skill is automatically hidden from the system prompt, `skills_list()`, and slash commands on incompatible platforms." 〔skills:362-364〕
> "`fallback_for_toolsets`: Skill is **hidden** when the listed toolsets are available. Shown when they're missing." 〔skills:433-436〕

🔶 **推理**：这条把"披露"从"读多少"提前到了"**是否进入候选集**"。真实价值：L0 的 ~3k token 是**每轮固定成本**，n 个技能线性膨胀；条件激活是唯一能在不删技能的前提下压住这块成本的手段。一个 60 技能的实例，若无条件过滤，L0 很容易翻几倍。

### 3.3 变更如何穿透 prompt 缓存（最巧的一处）

📄 问题：prompt 固定 ↔ 技能会变，怎么兼容？
> "When a skill is installed, created or removed while a conversation is open ... **your next message to the agent carries a short note** naming the new skills with their descriptions and the removed ones. **The note is sent once per change**; the system prompt itself picks up the change **at the next compaction**. `/reload-skills` is not needed for this" 〔skills:240-251〕

🔶 **推理**：这是"**旁路通知 + 惰性重基线**"模式——
- 不破坏 prefix（保住 cache）；
- 又保证新技能在本会话可见（用一条 user 侧消息）；
- 一致性最终由 compaction 收敛（此时 prompt 本来就要重建，改它免费）。
**代价**：存在"通知了但索引还没变"的窗口期，期间模型可能不信任索引。作者接受这个不一致，换 cache 命中率。

📄 同族设计还有 "bundles 不失效缓存"：
> "Bundles do not invalidate the prompt cache. They generate a fresh user message at invocation time, the same way `/<skill-name>` does — **no system prompt mutation**." 〔skills:963-966〕

### 3.4 为什么这套能叫"渐进式"

📄 架构层的总原则也写了同一条：
> "**Prompt stability** — System prompt doesn't change mid-conversation. No cache-breaking mutations except explicit user actions (`/model`)." 〔arch:280-283〕

🔶 **结论**：渐进式披露在 Hermes 里不是一个函数，是**三条约束的合解**：
① 固定成本只允许放"索引"（~3k）；② 变量成本必须按需（body/reference）；③ 任何增量都必须走 user 消息或 compaction，不许改 system prompt。

---

## 4. 记忆与技能的分工

### 4.1 一句话分工（文档原话）

> "memory stores **small durable facts that should always be in context**, while skills store **longer procedures that should load only when relevant**." 〔skills:993-995〕

### 4.2 触发条件对照

| 维度 | → memory | → skill | 证据 |
|---|---|---|---|
| **形态** | 事实 / 偏好 / 约定 / 环境 | 流程 / 步骤 / 坑 / 验收 | 〔memory:262-276〕 |
| **触发语** | "我偏好 X""这台机器是 Y""别用 Z" | "这事该怎么做""我刚走过的流程" | 〔memory:281-301〕 |
| **重复性** | 一次性也值得记（事实） | 需"**worth repeating**" | 〔skills:1004〕 |
| **每次任务都要用** | ✅ | ❌（会白付加载） | 🔶 见下 |
| **容量** | 2200 / 1375 字符硬顶 | 无理论上限，靠 linter 压 | 〔memory:9-15〕 |
| **成本模型** | **每轮固定** ~1300 token | **命中级** ~0 | 〔memory:402-424〕 |
| **写入动作** | add / patch / remove | create / patch / write_file / remove_file / delete | 〔memory:165-180〕〔skills:1048-1090〕 |

📄 **反直觉但明确的一条判据**（"反复任务要的路径"归 skill）：
> "For a location the agent needs **on every run of a recurring task**, a skill is often the better home than a memory entry — it loads only when relevant and **does not compete for the 2,200-character budget**." 〔memory:158-160〕

🔶 **推理**：这条把分工从"内容类型"推进到"**计费模式**"。判据可以工程化为一句话：
> **"它该不该在我不想它的时候也占着上下文？"** 该 → memory；不该 → skill。
这比"事实 vs 流程"更可判定，因为它对应了真实的成本结构。

### 4.3 容量税是设计核心（不是限制，是压力）

📄 超限**不静默丢**，而是**报错 + 要求同轮腾挪**：
> "Memory does **not** auto-compact: when a write would exceed the limit, the `memory` tool returns an error instead of silently dropping entries. The agent then makes room itself — consolidating or removing entries **in the same turn** before retrying" 〔memory:28-36〕

📄 错误文案直接把算法交给模型：
> "Retry as ONE 'operations' batch that removes or shortens (patch) stale entries from `current_entries` below to free at least 153 chars **AND** adds this entry — **the limit is checked only on the batch result**." 〔memory:333-340〕

🔶 **推理**：这是全篇最值得抄的单个设计。三个理由：
1. **把"淘汰"变成写入的必经成本**，避免无节制增长；
2. **批次原子性**（只在最终结果校验）允许"先删后加"在一次调用里完成，不会中途卡住；
3. **返回 `current_entries`**，让模型不必额外的 read（memory 工具故意没有 read action〔memory:178-180〕）。

### 4.4 统一观测面：journey

📄 技能与记忆被放进同一条时间线：
> "The learning journey is a timeline view of everything Hermes has learned — saved skills and memory entries plotted over time" 〔memory:433-434〕
> "A skill appears on the timeline as soon as it has a **learning signal**: it was created in this profile (a `/learn` result or a foreground `skill_manage create`), created by the background review, or **used at least once**. Bundled skills and hand-written skills that have never been used stay out of the timeline." 〔memory:466-470〕

🔶 **推理**："used at least once" 是**使用信号**，意味着技能库有"被加载"的埋点。这条埋点是判断"死技能"的唯一依据，也是 curator 归并的前提。**要抄 curator，先得抄这个埋点。**

---

## 5. write-approval gate（人类审批怎么插进自动进化）

### 5.1 两个开关，两套 UX（差异是有理由的）

📄 记忆侧：
> "| `false` (default) | Write freely ... |
>  | `true` | Require approval before anything is saved. **In the interactive CLI, foreground writes prompt you inline (entries are small enough to read in full)**. Everywhere else — messaging platforms, scripts, and the background self-improvement review — writes are **staged** for review with `/memory pending`." 〔memory:601-611〕

📄 技能侧：
> "When `write_approval: true`, every `skill_manage` write (create / edit / patch / delete / write_file / remove_file) is **staged instead of committed** — **a SKILL.md is too large to review inline, so staging applies regardless of whether the write came from a foreground turn or the background review.**" 〔skills:1134-1140〕

| | memory | skills |
|---|---|---|
| CLI 前台 | **内联弹窗**（条目小，能读完） | **一律暂存**（太大，读不了） |
| 非交互面 | 暂存 | 暂存 |
| 落盘位置 | `/memory pending` | `~/.hermes/pending/skills/<id>.json` |
| 审查粒度 | 整条 | gist（一行）+ 完整 unified diff |

🔶 **推理**：判据是**"人类能不能在对话里读完全部内容"**，不是"风险高低"。这解释了为什么同一开关在两个系统里 UX 不同——闸门形态应该由**审阅成本**决定，而非由资产重要性决定。

### 5.2 暂存机制的四个硬细节（这些才是能落地的部分）

📄 ① **跨重启存活**：
> "Staged writes **survive restarts** under `~/.hermes/pending/skills/` and are reviewed with the same familiar approve/deny flow as dangerous commands" 〔skills:1138-1141〕

📄 ② **四段式命令面**：
> "`/skills pending` (list + one-line gist) / `/skills diff <id>` (full unified diff) / `/skills approve <id>` (apply, or 'all') / `/skills reject <id>` (drop, or 'all') / `/skills approval on|off` (persist the switch)" 〔skills:1142-1146〕
> 记忆侧同构：`/memory pending`(auto 的标 `[auto]`) / `approve <id>` / `reject <id>` / `/memory approval on|off` 〔memory:620-623〕

📄 ③ **写入 pinning（防"审的和改的不是同一份"）**——这是最精妙的一条：
> "A staged `patch` or `remove` ... **records the full entry it targets**, and `/memory pending` shows it. Approval applies to **exactly that entry**: if it changed after the write was staged, **the write is refused** and stays pending for you to reject." 〔memory:629-638〕

📄 ④ **已被否决的旧格式也不放行**：
> "A `replace`/`patch`/`remove` staged before this pinning existed has **no verifiable target and is refused too**" 〔memory:638-644〕

🔶 **推理**：③ 解决的是 TOCTOU（检查时与使用时不一致）。在**多写者**环境下这是必需的——文档同时在别处强调"one agent per Hermes home"，因为"two writers sharing one home will compound each other's entries"〔memory:21-26〕。**克隆这条必须连"一个 home 一个写者"一起克隆，否则 pinning 只是安慰剂。**

### 5.3 三个"闸"是正交的，别混为一谈

📄 文档明确区分：
> "The separate `skills.guard_agent_created` setting is a **content scanner** (dangerous-pattern heuristics), **not an approval gate** — the two are **independent**." 〔skills:1170-1176〕

| 闸 | 性质 | 拦什么 | 时机 |
|---|---|---|---|
| `write_approval` | **人审** | 一切写入（等人类 yes/no） | 写前 |
| `guard_agent_created` | **自动扫** | 危险模式（注入/外泄/后门） | 写前 |
| `lock` | **冻结** | **任何**写入路径（含 terminal） | 全程 |
| `journey delete` | **软删** | 不拦，只保证可恢复 | 写后 |

📄 记忆侧的自动扫细节：
> "Memory entries are scanned for injection and exfiltration patterns before being accepted, since they're injected into the system prompt. Content matching threat patterns (prompt injection, credential exfiltration, SSH backdoors) or **containing invisible Unicode characters** is blocked." 〔memory:383-385〕

🔶 **推理**：为什么记忆要比技能扫得更狠？因为记忆**无条件注入 system prompt**（攻击面最大），而技能要"被加载"才生效。**扫描强度应该跟着"注入的无条件性"走**，这条可以照抄到我们的 AGENTS.md 注入层。

### 5.4 哪些操作不需要审批（边界）

📄 默认**全放行**：
> "By default the agent writes skills freely — including from the background self-improvement review that runs after a turn." 〔skills:1116-1120〕

📄 但**后置审查的 patch/remove 即使闸门关闭也会 stage**（这条容易被忽略）：
> "A staged `patch` or `remove` (**the background review stages these even with the gate off**) records the full entry it targets" 〔memory:629-634〕

🔶 **推理**：这说明作者对"后置审查"的信任度低于"前台回合"。理由可推：前台回合有人在场，写错了下一句就能纠正；后置审查无人监督且在后台，**破坏性操作（patch/remove 会覆盖已有条目）必须留痕**。而新增（add）破坏性低，所以不 stage。
**这是一条可工程化的原则：按"破坏性"分级，而不是按"来源"分级。**

---

## 6. 记忆系统

### 6.1 三层结构（先分清，再谈机制）

| 层 | 载体 | 容量 | 读取方式 | 证据 |
|---|---|---|---|---|
| **L-a 常驻** | `~/.hermes/memories/MEMORY.md` + `USER.md` | 2200 / 1375 字符 | **无条件注入 system prompt**（冻结快照） | 〔memory:6-20〕 |
| **L-b 可检索** | `~/.hermes/state.db`（SQLite + FTS5） | 无限 | `session_search` 按需查 | 〔memory:388-395〕〔arch:232-236〕 |
| **L-c 外部** | 插件 provider（Honcho / Hindsight / Mem0 / Supermemory / RetainDB / ByteRover …） | provider 自定 | provider 自己的工具 | 〔memory:914-930〕〔tools:16-21〕 |

📄 冻结快照的取舍：
> "The system prompt injection is captured once at session start and **never changes mid-session**. This is intentional — it preserves the LLM's prefix cache ... When the agent adds/removes memory entries during a session, the changes are persisted to disk immediately but **won't appear in the system prompt until the next session starts**. Tool responses always show the live state." 〔memory:61-62〕

### 6.2 SQLite + FTS5 怎么用

📄 存什么：
> "All CLI and messaging sessions are stored in SQLite (`~/.hermes/state.db`) with FTS5 full-text search" 〔memory:391-393〕

📄 返回什么（**关键：不做摘要**）：
> "Search queries return **actual messages from the DB — no LLM summarization, no truncation**. The agent can find things it discussed weeks ago, even if they're not in its active memory. The agent can also **scroll forward/backward inside any session** it finds." 〔memory:394-396〕

📄 性能与成本（这几个数字可直接当预算）：
> "| Speed | Instant (in system prompt) | **~20ms FTS5 query, ~1ms scroll** |
>  | Cost | Token cost in every prompt | **Free — no LLM calls** |" 〔memory:412-415〕

📄 三种调用形状：discovery / scroll / browse 〔memory:399-401〕

📄 会话血缘（FTS5 之外的第二根支柱）：
> "Sessions have **lineage tracking (parent/child across compressions)**, per-platform isolation, and atomic writes with contention handling." 〔arch:232-236〕

🔶 **推理**：FTS5 + lineage + "no LLM summarization" 三者合起来才成立：
- 若做摘要 → 引入一次 LLM 调用（成本）+ 一次幻觉风险（保真度）；
- 压缩会产生 parent/child → 必须有 lineage，否则搜到的消息**无法定位到"在哪个上下文里说的"**；
- 所以"免费、20ms、原文、可 scroll"这四条是一个整体，拆掉任何一条都会破坏其余。

📄 生态对照表（直接给出了分工判据）：
> "| Management | Manually curated by agent | Automatic — all sessions stored |" 〔memory:419-421〕

### 6.3 Honcho dialectic user modeling

📄 **文档说的（只有这些）**：
> "external memory provider plugins — RetainDB and ByteRover — and more, such as **Honcho**, Hindsight, Supermemory, Mem0, OpenViking and Holographic, are available from the plugin catalog" 〔memory:914-919〕
> "External providers run **alongside** built-in memory (**never replacing it**) and add capabilities like knowledge graphs, semantic search, automatic fact extraction, and **cross-session user modeling**." 〔memory:921-923〕
> "**Honcho cross-session memory** is available as a memory provider plugin from the plugin catalog (`hermes plugins install honcho`), **not as a built-in toolset**." 〔tools:16-21〕
> README 的说法："**Honcho dialectic user modeling**" 〔readme:26〕

🔶 **⚠️ 推测（无文档正文支撑，属外部背景）**：Honcho 的 "dialectic" 通常指**两个表征互相对话**——一个"用户对自己的表述"，一个"从对话中推断的表述"，二者做差异推理来更新用户模型。**这条我无法从这五份资料里证实**，只能确定：① 它是外部插件不是内置工具集；② 它"加能力而不替代"内置记忆；③ 文档把它归到 "cross-session user modeling"。
**结论级建议：不要照抄它的机制，只照抄它的位置——"用户建模必须是可插拔 provider，且不得取代常驻记忆"。**

📄 外部 provider 的溢出保护（这条是真机制）：
> "External memory providers return their full prefetched context by default, up to a safety ceiling of **10× `hooks.output_spill.max_chars`** (at least 100,000 characters); recall above that still spills so a runaway provider can't overflow the context window." 〔memory:568-573〕

🔶 **推理**：这是"外部 provider 不可信"的正确处理——**不阻止它返回，但设上限并降级为 head/tail 预览 + 文件路径**。对我们是直接可抄的（我方 `memory.provider` 类扩展目前没有这道闸）。

### 6.4 "periodic nudges" 到底怎么实现

📄 **一句话版本（README）**：
> "Agent-curated memory with **periodic nudges**. Autonomous skill creation after complex tasks. Skills self-improve during use." 〔readme:26〕
> "it creates skills from experience, improves them during use, **nudges itself to persist knowledge**" 〔readme:19〕

📄 **机制版本（memory 文档，六个旋钮）**——后置审查是一个**回合结束时的自复制 fork**：

| 旋钮 | 作用 | 原文 |
|---|---|---|
| `enabled` | 总开关（关掉后手动 `/refine` 仍可用） | 〔memory:758-776〕 |
| `memory.nudge_interval` / `skills.creation_nudge_interval` | **频率** | 〔memory:751-755〕 |
| `auxiliary.background_review.{provider,model}` | 换模型（默认 `auto` = 主模型） | 〔memory:699-726〕 |
| `max_input_tokens` | **成本上限**（单次审查的累计输入 token） | 〔memory:777-813〕 |
| `extra_tools` | 白名单额外工具 | 〔memory:814-833〕 |
| `defer` / `defer_max_age_s` | 本地 GPU 时**排队到空闲** | 〔memory:834-880〕 |

📄 **它是怎么"复制"的（caching 视角，这是精华）**：
> "The review runs on your **main chat model** by default, **replaying the conversation — which is already warm in the prompt cache, so it's cheap cache reads.**" 〔memory:703-706〕
> "When you point it at a model **different** from your main one ... Because a different model can't reuse your main model's prompt cache anyway, the fork **automatically replays a compact digest** of the conversation (**recent turns verbatim + a summary of older ones**)" 〔memory:727-735〕
> "Capture holds: in testing, **memory capture was identical and skill capture near-identical** to the main-model review." 〔memory:735-736〕

📄 **同模型时不允许改思考等级（为此牺牲了灵活性）**：
> "A review using the same model as the parent **always inherits the parent's reasoning effort** ... **Reasoning settings, the system prompt, the full conversation snapshot, and tool definitions stay byte-identical to the parent at fork birth** so the review can reuse its prompt-cache prefix." 〔memory:743-750〕

📄 **成本记账**：
> "Fork usage is persisted in `session_model_usage` with `task='background_review'` and a completion line is written to `agent.log` (`Background review complete: thread=bg-review calls=… in=… out=… result=…`)." 〔memory:805-813〕

📄 **本地模型的排队语义（细节密度很高）**：
> "Queued reviews **coalesce per session** (a newer turn's snapshot replaces the older one — the review replays the whole conversation, so nothing is lost), a review **preempted by a new prompt is re-queued instead of discarded**, and a review that has waited longer than `defer_max_age_s` runs **even if the machine never goes idle**. Explicit `/refine` always runs immediately. **The queue is in-memory**: reviews still pending when the app exits are dropped" 〔memory:869-880〕

📄 通知面（决策与感知分离）：
> "This only governs the **gateway chat notification**. The review itself, and writes to your memory/skill stores, are **unaffected by this setting**." 〔memory:685-691〕
> 三档：`off`（什么都不显示，但**仍然写**）/ `on`（"💾 Memory updated"）/ `verbose`（增量预览）〔memory:663-684〕

🔶 **推理 —— 这就是"nudges"的真实含义**：
它不是"定时提醒模型去记东西"，而是 **"在回合结束后、用同一个 warm prefix，让模型以审阅者身份重读这次对话，自己决定要不要写"**。
"nudge" 落在三处：
1. **interval 计数**（多久给一次机会）；
2. **系统提示词里的长期要求**（"asks the agent to record a non-trivial workflow"）；
3. **写回失败时的错误文案**（容量满了逼它腾挪）。
**完全没有"到点了发一条消息提醒你记"这种实现。**

### 6.5 ⚠️ 证据冲突（必须记录）

README 与 memory 文档在 FTS5 上**说法矛盾**：

| 来源 | 原话 |
|---|---|
| README | "FTS5 session search **with LLM summarization** for cross-session recall" 〔readme:26〕 |
| memory 文档 | "Search queries return actual messages from the DB — **no LLM summarization, no truncation**" 〔memory:394〕 |

🔶 **判断**：以 memory 文档为准（它是专题页，且给了 20ms/1ms 的数字与"三种调用形状"，可自洽验证）；README 是营销页，可能描述的是更早版本或"发现层"之外的另一条摘要路径。
**工程含义**：**不要拿 README 当接口契约。**这条冲突本身就是"文档也会漂移"的实证——与我方"同一判据两处写必然漂移"同源。

---

## 7. 真正让它"自我进化"的是哪几个零件（最小集合）

我按**"拆掉它，闭环就断"**来筛，得到 **5 个核心 + 3 个支撑**。

### 核心（缺一即断）

| # | 零件 | 一句话 | 拆掉会怎样 | 证据 |
|---|---|---|---|---|
| **C1** | **回合结束后置审查 fork** | 每轮结束复制一份**热 prefix** 的子会话，以审阅者身份重读并决定写什么 | 退化回"靠模型自觉"，弱模型会**声称写了但没调用工具** | 〔memory:703-706〕〔memory:96-112〕 |
| **C2** | **两种税的双仓** | 事实仓（2200 字，每轮固定付费）+ 流程仓（命中级付费） | 单仓必爆：要么每轮爆 token，要么关键事实被挤出 | 〔skills:993-995〕〔memory:9-15〕 |
| **C3** | **渐进式披露 + 条件激活** | 索引常驻、正文按需、子文件按路径、不适用就不进候选集 | 技能库一过 ~30 个，索引成本压垮 system prompt | 〔skills:230-236〕〔skills:362-364〕 |
| **C4** | **写入协议（含"删掉 replace"）** | memory 只 add/patch/remove；skill 五形状严格分槽；容量满→批次腾挪 | 自由文本写入 → 多事实条目被整条覆盖（文档给了这个 bug 的完整考古） | 〔memory:248-255〕〔memory:328-347〕〔skills:1091-1107〕 |
| **C5** | **暂存式人闸 + pinning** | 破坏性写入落 `pending/`，gist/diff/approve/reject；审批绑定被写的那个条目 | 自治流程改坏后无法知悉"人类批的是哪一版" | 〔skills:1134-1146〕〔memory:629-644〕 |

### 支撑（缺了会"假进化"）

| # | 零件 | 作用 | 证据 |
|---|---|---|---|
| **S1** | **可逆性五件套** | 锁 / origin hash / reset --restore / journey 归档 / version 字段 | 〔skills:1156-1169〕〔skills:1874-1929〕〔memory:480-483〕 |
| **S2** | **FTS5 会话检索 + lineage** | 让常驻记忆可以"小"——细节交给可检索层 | 〔memory:388-424〕〔arch:232-236〕 |
| **S3** | **变更一次性通知** | 在不破坏 prompt cache 的前提下让新技能可见 | 〔skills:240-251〕 |

### 一句话总结这套设计的"世界观"

🔶 **它不是"让 AI 变聪明"，是"给一个会犯错、会自我美化的写者，配一套它绕不过去的会计制度"**：
- 想写 → 有协议（C4）
- 想乱写 → 有 linter + 容量墙（C2/C3）
- 想偷偷写 → 有暂存与人闸（C5）
- 写坏了 → 有五条退路（S1）
- 想声称写了 → 后置审查 + 文件是唯一真相（C1；文档明确警告"a sentence like 'I've added that to my memory' is just text"〔memory:99-101〕）

**最锋利的一句原文（建议直接作为我们的设计准则）**：
> "Check whether the write actually happened. Memory only persists when the model **calls the `memory` tool**; a sentence like 'I've added that to my memory' **is just text**." 〔memory:96-101〕
> "Small local models (roughly under 30B parameters) and models with weak tool-calling do this often — **they produce the confirmation without the tool call**." 〔memory:108-110〕

---

## 8. 我们能借鉴什么（7 条，每条指明改哪个文件）

> 前 6 条按"投入产出比"排序。每条都给**判据**——没有判据的改动不算落地。

### 借鉴 1 ⭐最高优先：把"回合结束后置审查"补成真机制（而不是写在 AGENTS.local 里靠自觉）

- **改哪里**：新建 `workbench/工具/后置审查.mjs`；在 `workbench/数据/.dsh/AGENTS.md` 的"做完之后必须做的事"下加一行调用指令。
- **抄什么**：C1 + 6.4 的六个旋钮。最小实现只需三个：`--interval`（每 N 轮允许一次，落 `数据/.dsh/缓存/nudge.json` 计数）、`--max-input`（累计 token 上限）、`--defer`（本地模型排队到空闲）。
- **判据**：
  1. 关掉它时，`机制体检` 里"§五 新增经验"数应在一周内下降（证明它真的在起作用）；
  2. 开着它时，`工具/验证闸.mjs` 的**拒绝数 > 0**（若全是放行，说明审查在走过场——这正是我方 `验证闸` 自述的盲区"不查 AI 是否如实填写"）。
- **为什么**：我方现在是"AGENTS.local.md 要求 AI 自己记得写"，而 HERMES 明确记录了这个模式的失效方式（模型产出确认句但不调用工具）。**这是唯一一条能直接堵住我方已知漏点的改动。**

### 借鉴 2 ⭐：给 `记忆写入.mjs` 加"容量协商批"

- **改哪里**：`workbench/工具/记忆写入.mjs`（现有 ADD/UPDATE/DELETE/NOOP）+ `workbench/数据/.dsh/AGENTS.md`（写入约定）。
- **抄什么**：4.3 的批次语义——**上限只在批次最终结果校验**；超限错误里回传 `current_entries` + 需要腾出的精确字符数；拒绝 `replace`、只留 `patch`。
- **判据**：构造一个"加法必超限、但同批删旧后不超限"的用例，工具必须**一次通过**（不是两次调用）。再构造"patch 使条目变长导致溢出"，必须**报错并给出差额**。
- **为什么**：我方 `场景私有记忆.md` 有 25KB 红线（`记忆哨兵` INV-3），但现状是"先写爆再人工精简"（`记忆精简.mjs` 就是事后补救）。批次协商把淘汰前移到写入瞬间。

### 借鉴 3 ⭐：把 `验证闸.mjs` 从"自评五问"改成"闸 + 证人"分离

- **改哪里**：`workbench/工具/验证闸.mjs`；`workbench/数据/.dsh/机制清单.md` 里"验证闸"的"已知盲区"一栏。
- **抄什么**：Hermes 的 **"rule has to stand without the story"**〔skills:1016-1019〕 + `Phantom Guardrails` 的解法（我方 `方案/03-自进化机制.md` §2.3 已写"F1 事件绑定"，但工具里没实现）。
- **具体做法**：把"闸 1 有没有真结果"从**自由文本**改成**必须引用可验证凭证**——`--evidence` 接受"文件路径 + hash"或"工具输出 JSON 路径"，工具自己去 `Test-Path` / 解析；指不出就拒。
- **判据**：跑一个**应当被拒**的反例（给 `--evidence` 填不存在的路径），必须返回非 0 退出码。这条反例要进 `工具/验证闸.mjs` 的自测。
- **为什么**：我方 `验证闸` 自述"只查五道闸的判定逻辑，不查 AI 是否真的如实填写了闸门输入"〔机制清单:536〕——这就是 verifier 握在被验证者手里的经典问题。改成"引用证据"能把这条盲区从**无法检**变成**可检**。

### 借鉴 4：给技能加"三段硬结构 + 三条 linter"

- **改哪里**：`workbench/数据/.dsh/skills/*/SKILL.md`（12 个）；新建 `workbench/工具/技能lint.mjs`；接到 `workbench/工具/机制体检.mjs` 的 `GUARDS` 数组里。
- **抄什么**：`When to Use / Procedure / Pitfalls / Verification` 四节〔skills:318-334〕；三条 linter 的**具体阈值**——`incident-log-shape`（正文 PR/issue 编号密度）、`references-sprawl`（>60 个 reference 文件）、`oversized-body`（SKILL.md > ~24k 字符）〔skills:1035-1046〕。
- **判据**：对现有 12 个技能跑一遍，**至少命中 1 个**（我方 `incident-analysis/SKILL.md` 已 17.6KB，接近 oversized 线；若一个都不命中，说明阈值没按我们体量校准，要下调）。
- **为什么**：我方已有 `技能执行器`（check.mjs，Voyager 判据），但**只验"能跑"，不验"写得对不对"**——它自己的盲区就写着"不查技能说明本身是否准确"〔机制清单:500〕。linter 补的正是这一半。
- **注意**：抄"只警告不阻断"这一点。直接阻断会让人不敢写。

### 借鉴 5：加"暂存目录 + 四段式审批"，替换现在的散点确认

- **改哪里**：新建 `workbench/数据/.dsh/pending/`；`workbench/工具/进化.mjs`（L2/L3 写入前落 pending）；把现有 `数据/.dsh/规则待确认.json`、`A档确认.json` 收敛进同一套 `/xxx pending|diff|approve|reject` 语义。
- **抄什么**：5.2 的四段式 + **pinning**（审批绑定被写条目的完整快照，条目变了就拒）〔memory:629-644〕。
- **判据**：① 暂存文件跨进程重启仍在（杀进程重启后 `pending` 还能列出）；② 构造"stage 之后手动改目标条目再 approve"，必须被**拒**并保留在 pending。
- **为什么**：我方现在有 3 处独立的"待确认"文件（`规则待确认.json`/`A档确认.json`/派单台账状态），语义各写一套——这正是我方铁律"同一事实存两处 = 早晚打架"的现存违例。**收敛本身就是收益。**

### 借鉴 6：给技能加"锁 + 使用埋点"

- **改哪里**：`workbench/工具/技能执行器.mjs`（执行时记 `lastUsedAt`）、`workbench/工具/回滚.mjs`（加 `--lock <skill>`）、`workbench/工具/进化哨兵.mjs`（加 INV-9 `locked-untouched`）。
- **抄什么**：`hermes curator lock <skill>` 的语义——**锁定后仍可读可加载，但一切写路径（含 terminal）拒写**〔skills:1156-1163〕；`journey` 的"used at least once"埋点〔memory:466-470〕。
- **判据**：① 锁定后 `技能执行器` 仍能跑（可读）；② 锁定后任何写操作返回非 0；③ 30 天内 `lastUsedAt` 为空的技能数应能被列出（这就是"死技能"清单，是 curator 的输入）。
- **为什么**：**要做 curator 式的归并，必须先有"哪些技能是死的"的客观依据。**没有埋点就只能靠猜，一猜就会误删。

### 借鉴 7：`进化账本.mjs` 的度量从"静态计数"换成"真行为"，静态分降为子项

- **改哪里**：`workbench/工具/进化账本.mjs` 的 `measure()`；复用 `工具/封存集判分.mjs` + `工具/记忆评估.mjs`（它已在算 `recall_all@k`）。
- **抄什么**：**"度量必须比被度量的周期更快"**这条教训我方自己已经踩过——`进化账本.mjs` 注释里写着"第一版用完整机制体检当度量，实测 10 分钟以上，两次被 timeout 杀掉，综合分算成 49.2（假数据）"〔进化账本.mjs:61-77〕。
- **具体做法**：保留现有三维（覆盖/真跑率/完整率）作为 `structure` 子分；新增 `behavior` 子分 = 封存集得分 + 记忆召回率（秒级可算）；**基线必须包含一个"应当失败"的反例**——否则永远满分（`自我复盘/自进化复盘.md` 已证：36→36→40 全程 100 分，"一个永远满分、0 退化的测试，测不出进步，也测不出退化"）。
- **判据**：账本里出现**至少一条 `verdict: worse`** 的真实记录（证明它抓得住退步）。在那之前，`进化账本` 只是"记账"，不是"进化"。
- **为什么**：我方 `自我复盘/自进化复盘.md` 的结论是"增长几乎全是数字变多，只有没退化没有被证明变强"。根因就是度量只数文件。

### （附）不推荐照抄的两条

| 不抄 | 理由 |
|---|---|
| **Honcho dialectic 的具体建模方式** | 五份资料里**没有机制正文**，只有名称与"它是插件"这一事实。照抄等于照抄营销文案。只抄它的**位置**（可插拔 provider、不替代内置）。 |
| **"FTS5 + LLM 摘要"** | README 与专题页自相矛盾，且专题页明确"no LLM summarization"。**不要引入摘要环节**——它是成本与幻觉的双重来源。 |

---

## 9. 资料边界与未解问题（诚实清单）

| 问题 | 状态 | 说明 |
|---|---|---|
| curator 的**进程形态** | ❓**未解** | 无 curator 页正文；架构目录树无 curator 模块（见 2.2/2.3）。只能确定它是"有 CLI + Desktop 开关的自治技能维护子系统"。 |
| curator 的**触发节奏** | ❓**未解** | 同上。推测为 cron 或 update/session 边界，置信中等。 |
| **consolidation pass 的算法** | 🔶**部分可推** | 能确定它产出必须符合"lessons not logs + extended in place"；不能确定是否跨技能合并、是否删死技能。 |
| `nudge_interval` 的**计数单位** | 🔶**推测** | 推测是"轮/次"计数器。文档只给名字与"降低审查工作量"的作用。 |
| Honcho **dialectic 机制** | ❓**未解** | 只有 README 一句与插件安装方式。 |
| **后置审查的 prompt 文本** | ❓**未解** | 文档只说"system prompt, full conversation snapshot, tool definitions **byte-identical to the parent at fork birth**"〔memory:748-750〕，说明审查用的不是另一套 prompt，而是**沿用主 prompt + 隐含的审查任务**。具体怎么"隐含"未说明。 |
| FTS5 与摘要的**矛盾** | ⚠️**证据冲突** | README vs memory 专题页（见 6.5）。以专题页为准。 |
| **技能使用的埋点实现** | ❓**未解** | 只知 journey 依赖"used at least once"，不知埋点写在哪（推测在 `skill_view` 内）。 |

> 本报告**不含**任何源码级逆向（无代码仓库），全部结论来自官方文档 + 架构图的交叉验证。
> 因此凡涉及"实现细节"的部分，我用 🔶 明确标出，且给出了可推翻它的证据类型。
