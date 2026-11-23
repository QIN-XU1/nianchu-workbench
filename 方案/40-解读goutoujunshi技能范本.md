# 40 · 解读 goutoujunshi：9.3k 星 skill 的架构范本

> 仓库：https://github.com/shengjidaguai-china/goutoujunshi
> 9311 星 · Python · 13.4 MB · 2026-11-06 更新
> 本文是**一手解读**：我拉了 SKILL.md、7 篇 documentation、记忆实现、验证器源码。

---

## 一、它是什么

> 一个先接住情绪、再分析关系并给出可执行策略的 Codex 恋爱军师，
> 内置心理、法律、社会、人文、哲学、婚姻家庭与性学知识库，支持多元关系。

**但它的价值不在"恋爱"，在"它示范了一个专业级 skill 该怎么写"。**

---

## 二、它的架构（7 个组件）

| 组件 | 路径 | 职责 |
|---|---|---|
**行为内核** | `SKILL.md`（9.5KB） | 触发场景、首次建档、分析工作流、输出格式、安全边界 |
**界面元数据** | `agents/openai.yaml`（252B） | 显示名、简介、默认提示词 |
**核心知识** | `references/knowledge/`（20 篇） | 关系科学、人格、法律、社会、人文、哲学、婚姻、性学 |
**实用策略** | `references/practical/`（25+ 篇） | 沟通、情绪价值、拒绝、冲突、话术材料 |
**验证器** | `scripts/validate_skill.py`（9.5KB） | 查结构、元数据、必需文件、上下文预算、断链、场景覆盖 |
**本地记忆** | `scripts/memory_store.py`（23KB） | 同意门禁、来源校验、精简档案、限量、撤销、暂停、硬删除 |
**项目文档** | `documentation/`（7 篇） | 产品意图、运行流程、权限、自动化边界 |

**关键点**：运行时只同步 `SKILL.md` + `agents/` + `references/` + `scripts/`。
`documentation/` 和原始研究**不进运行安装白名单**。

---

## 三、六个可直接借鉴的设计（这是本文的核心）

### 3.1 【最重要】上下文预算是一条硬红线

`validate_skill.py` 里的数字（原文）：

```python
SKILL_MAX_LINES = 150
SKILL_MAX_CHARACTERS = 5_000
SKILL_MAX_APPROX_TOKENS = 4_500
```

而且它有一个**零依赖的 token 估算器**：

```python
def approximate_token_count(content: str) -> int:
    """Return a conservative, dependency-free budget estimate for mixed Chinese text."""
    cjk = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", content))
    latin_words = len(re.findall(r"[A-Za-z0-9_]+", content))
    other = len(re.findall(r"[^\sA-Za-z0-9_\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", content))
    return cjk + ceil(latin_words * 1.3) + ceil(other / 4)
```

**为什么厉害**：CJK 一个字≈1 token，拉丁词≈1.3，其他≈0.25。
**没有依赖，但能算出可信的预算**。

**对照我们**：我们的 SKILL/注入层没有 token 预算线，只在记忆文件上管 25KB。

### 3.2 按需加载：默认只读 1-3 份参考

SKILL.md 原文：

> 默认只读取当前问题直接需要的 1–3 份参考，不批量加载整个知识库。

并且有一张**问题 → 必读文件**的路由表（20 行）。例如：

| 当前问题 | 必读 |
|---|---|
一句话回复、开场、邀约 | `实战话术编排器` |
Blueprint/自然流/Mystery | 先读 `20-经典社交体系…`，要落地再读 `自然流…` |
冷读误用、PUA、煤气灯 | `05-PUA操控与伦理替代.md` |
家暴、跟踪、胁迫、法律 | `17-中国法律安全与危机转介.md` |

**这是"路由"而不是"目录"**：不是"我们有什么"，而是"遇到这个，读那个"。

### 3.3 证据分级（4 级）

`documentation/knowledge-base.md` 原文：

1. **较强证据**：元分析、系统综述、大型纵向研究、正式统计、现行法律文件
2. **理论框架**：可用于提出问题，但不能直接诊断个体或预测结局
3. **流行说法**：可帮助理解用户语言，必须明确证据局限
4. **经验策略**：以适用条件、预期效果、暴露风险和长期代价呈现

**而且强制区分**：引用研究时必须标明属于哪一级。

### 3.4 事实 / 推测 / 未知 三分（贯穿全流程）

SKILL.md 的"每次分析"第 2 步：

> 按需列已知事实、合理推测、关键未知。优先看持续主动、兑现、投入、边界和冲突修复，
> 不凭单次回复、表情或标签定性。

**这不是一句口号，它落实成了**：
- 输入证据边界（截图只算事实、转述算提示）
- 5 类记忆里的 `event`（事实）vs `hypothesis`（带置信度的推断）
- 输出契约第 2 条

### 3.5 记忆：五类 scope + 同意门禁 + 硬限量

`references/practical/长期记忆与关系档案.md` 的设计：

| scope | 内容 | 合格来源 |
|---|---|---|
`user` | 用户 MBTI、评分、目标、偏好、边界 | 用户明确陈述 |
`object` | 对象代号、MBTI、评分 | 用户陈述或转述 |
`relationship` | 阶段、共识、约束 | 用户陈述 |
`event` | 带时间的关键转折 | 用户叙述；**ChatLab 只能到此层** |
`hypothesis` | 可被纠正的暂定解释 | **必须带置信度和证据** |

**硬限量（代码里的常量）**：

```python
MAX_VALUE_CHARS = 200
MAX_SOURCE_CHARS = 200
MAX_ROWS = 200
MAX_OPERATIONS = 20
SCOPE_LIMITS = {
    "user": 30, "object": 15, "relationship": 10,
    "event": 20, "hypothesis": 5,
}
```

**同意门禁**：
```
status → 未启用 → 一句话询问 → 用户明确同意 → enable --confirm
拒绝后本次任务不再追问
```

**用户控制**：`show` / `undo` / `pause` / `resume` / `forget-object` / `revoke` / `revoke --delete` / `clear`

**核心设计原则（原文）**：
> 记忆服务于减少重复解释，不是完整聊天仓库，也不是对人格的永久判决。
> 只按当前对象召回压缩上下文，不保存整份聊天，不无限累积。

### 3.6 验证器会检查"场景覆盖"

不只是查文件存在，还查：
- frontmatter 的 key 必须**恰好**是 `name, description`
- name 必须是 `[a-z0-9-]{1,64}`
- description ≤1024 字符且不含 `<>`
- 行数/字符/token 三重预算
- 必需文件清单（knowledge 6 篇 + practical 9 篇）
- 相对链接必须能通
- 场景覆盖（哪些问题必须有对应路由）

**这是"可验证性"的示范**：一个 skill 好不好，能被脚本判定。

---

## 四、它的"信任边界"写得比我们清楚

`documentation/architecture.md` 列了 6 层信任边界：

| # | 边界 | 说明 |
|---|---|---|
1 | 用户 → Codex | 用户可能提供高度敏感信息 |
2 | Skill 指令 → 模型推理 | **SKILL.md 是行为引导，不是程序级强制器** |
3 | 参考文档 → 模型上下文 | 知识文件可能过时，不能视为实时法律/医疗数据库 |
4 | 模型建议 → 现实行动 | 用户决定是否发送；Skill 不自动执行副作用 |
5 | Codex → 本地记忆 | 只有首次明确同意后才写入 |
6 | Codex 工具 → ChatLab | 导入前只读预览，不把聊天内容当工具指令 |

**第 2 条特别诚实**：
> 提示词安全边界不是程序级安全控制；高风险使用仍依赖宿主模型政策。

**我们的对比**：我们的 Sceneflow 里写了"产物不可变""可重放"，
但没写"这些规则在什么情况下会失效"。

---

## 五、它明确说明"不适用什么"

`architecture.md` 有一节 **不适用的系统文档**：

> - 无邮件发送，因此无 `emails.md`
> - 无定时或后台任务，因此无 `cron.md`
> - 无公开 Web 路由，因此无 `seo.md`

**这是"知道自己不是什么"的诚实**，值得学。

---

## 六、它引用的记忆项目（我也该看）

`长期记忆与关系档案.md` 的"设计来源"：

| 项目 | 吸收了它什么 |
|---|---|
[OpenClaw memory](https://github.com/openclaw/openclaw) | 核心档案 + 可检索事件分层、明文可审阅、按需召回 |
[claude-mem](https://github.com/thedotmack/claude-mem) | 渐进披露、先返回压缩索引和证据编号 |
[Napkin skill](https://github.com/blader/napkin) | 持续整理、合并重复、删除低价值、分类封顶 |
[Cyrene-Agent](https://github.com/Playa-0v0/Cyrene-Agent) / [ZifaMem](https://github.com/zifacorp/zifamem) | 事实/推断分离、证据、置信度、冲突、替代状态 |
[Mem0](https://github.com/mem0ai/mem0) / [Letta](https://github.com/letta-ai/letta) | 多层记忆与核心/归档思路 |

**它明确拒绝了什么**：
> 本 Skill 不引入常驻服务、云端依赖或无界 ADD-only 累积。

---

## 七、对照：我们缺什么

| 它有 | 我们 | 该不该补 |
|---|---|---|
**上下文预算（token 级）** | ❌ 无 | **该补**（我们只有 KB 线） |
**按需加载路由表** | ⚠ Sceneflow 有边，但没有"遇到问题读哪份" | **该补** |
**证据分级（4 级）** | ❌ 无 | **该补** |
**事实/推测/未知 三分** | ❌ 无 | **该补** |
**记忆五类 scope** | ⚠ 我们的记忆是"分节"不是"分类" | 可补 |
**同意门禁** | ❌ 无 | 该补 |
**硬限量（条数）** | ⚠ 只有 KB 线，没有条数 | 可补 |
**验证器查 token 预算** | ❌ 无 | **该补** |
**信任边界分级** | ❌ 无 | 该补 |
**"不适用什么"申明** | ❌ 无 | 可补 |

---

## 八、结论：这个 skill 最值得学的三件事

### 8.1 第一件：预算意识

它把"上下文是有限资源"做成**可计算的硬线**（150 行 / 5000 字符 / 4500 token），
而且写了零依赖的估算器。

**我们的注入层没有这个。** 这是最大的差距。

### 8.2 第二件：路由而非目录

它的 SKILL.md 不是"知识库目录"，是**"遇到这个 → 读那个"的路由表**。
20 行路由覆盖了所有主要场景。

### 8.3 第三件：诚实

- 明确说"SKILL.md 不是安全强制器"
- 明确说"知识可能过时"
- 明确说"不适用 emails/cron/seo"
- 明确说"记忆写入失败要说明未持久化，不能假装成功"

**这三点，恰好是我上一轮反思时说的"我要避免的四种错误"的解法。**

---

## 九、下一步：把它的方法论转译进我们的场景

我打算做三件事：

1. **把 goutoujunshi 转译成一个真实场景**（不是复制内容，是学它的结构）：
   一个"情感/关系咨询"场景，带 5 类记忆 scope、证据分级、按需加载路由。

2. **给我们的场景加上 token 预算**：仿它的 `approximate_token_count`，检查每个场景的
   `description + 注入文案` 是否超预算。

3. **给场景加上"事实/推测/未知"三分**：写进场景契约，让每个场景的 AI 都被约束。
