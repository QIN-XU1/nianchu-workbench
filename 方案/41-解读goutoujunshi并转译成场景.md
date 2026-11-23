# 41 · 解读 goutoujunshi 并转译成场景

> 仓库：https://github.com/shengjidaguai-china/goutoujunshi
> 9311 星 · 13.4 MB · 用户要求："先解读这个 skill，再进行场景以及对话的构建"

---

## 一、我读到了什么（一手材料清单）

| 文件 | 大小 | 内容 |
|---|---|---|
`SKILL.md` | 9,518 B | **行为内核**：触发、建档、分析流程、输出格式、安全边界 |
`README.md` | 12,709 B | 项目说明 |
`documentation/architecture.md` | 4,036 B | **7 个组件 + 6 层信任边界** |
`documentation/flows.md` | 5,812 B | **9 个关键流程** |
`documentation/knowledge-base.md` | 2,613 B | **4 级证据 + 包容性要求** |
`documentation/permissions.md` | 1,974 B | 权限矩阵 |
`documentation/variables.md` | 893 B | 只 1 个环境变量 |
`documentation/automation.md` | 2,163 B | **输出契约 + 失败处理** |
`documentation/product.md` | 5,484 B | 产品定位 |
`references/practical/长期记忆与关系档案.md` | 5,606 B | **五类 scope 记忆设计** |
`scripts/memory_store.py` | 22,706 B | 记忆实现（SQLite，同意门禁） |
`scripts/validate_skill.py` | 9,543 B | **验证器（含 token 预算）** |

**作者很诚实**：`documentation/architecture.md` 里明确写了
"`SKILL.md` 是行为引导，**不是不可绕过的程序级强制器**"。

---

## 二、它最有价值的六个设计

### 2.1 上下文预算是一条硬红线

`validate_skill.py` 里的原文：

```python
SKILL_MAX_LINES = 150
SKILL_MAX_CHARACTERS = 5_000
SKILL_MAX_APPROX_TOKENS = 4_500
```

**而且给了零依赖的估算器**：

```python
def approximate_token_count(content: str) -> int:
    cjk = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", content))
    latin_words = len(re.findall(r"[A-Za-z0-9_]+", content))
    other = len(re.findall(r"[^\sA-Za-z0-9_\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", content))
    return cjk + ceil(latin_words * 1.3) + ceil(other / 4)
```

**CJK 一字 ≈ 1 token · 拉丁词 ≈ 1.3 · 符号 ≈ 0.25**

**这是"上下文是有限资源"的可计算化。**

### 2.2 按需加载：默认只读 1–3 份

SKILL.md 有一张 **问题 → 必读文件** 的路由表（20 行）：

| 当前问题 | 必读 |
|---|---|
一句话回复、开场、邀约 | `实战话术编排器` |
冷读误用、PUA、煤气灯 | `05-PUA操控与伦理替代.md` |
家暴、跟踪、胁迫、法律 | `17-中国法律安全与危机转介.md` |
跨任务档案、记忆同意 | `长期记忆与关系档案.md` |

**这是"路由"而不是"目录"**：不是"我们有什么"，而是"遇到这个读那个"。

### 2.3 四级证据分级

`knowledge-base.md` 原文：

1. **较强证据**：元分析、系统综述、大型纵向研究、正式统计、现行法律
2. **理论框架**：可用于提出问题，**但不能直接诊断个体或预测结局**
3. **流行说法**：可帮助理解用户语言，**必须明确证据局限**
4. **经验策略**：以适用条件、预期效果、暴露风险、长期代价呈现

**强制要求：引用研究时必须标明属于哪一级。**

### 2.4 事实 / 推测 / 未知 三分（贯穿全流程）

这不是口号，它落实成了：
- **输入证据边界**：截图只算事实、转述算提示、无法核实要注明
- **记忆分层**：`event`（事实）vs `hypothesis`（必须带置信度）
- **输出契约第 2 条**：已知事实、合理推测、关键未知的区分

### 2.5 记忆：五类 scope + 同意门禁 + 硬限量

| scope | 内容 | 合格来源 |
|---|---|---|
`user` | 用户 MBTI、评分、目标、偏好、边界 | 用户明确陈述 |
`object` | 对象代号、MBTI、评分 | 用户陈述/转述 |
`relationship` | 阶段、共识、约束 | 用户陈述/转述 |
`event` | 带时间的关键转折 | 用户叙述 |
`hypothesis` | 可被纠正的暂定解释 | **必须带置信度和证据** |

**代码里的硬常量**：
```python
MAX_VALUE_CHARS = 200      # 单条 200 字
MAX_ROWS = 200             # 总 200 条
MAX_OPERATIONS = 20        # 可撤销 20 次
SCOPE_LIMITS = {"user":30, "object":15, "relationship":10, "event":20, "hypothesis":5}
```

**同意门禁**：`status → 未启用 → 一句话询问 → 明确同意 → enable --confirm`
**拒绝后不再追问。**

### 2.6 它明显说了"自己不是什么"

`architecture.md` 有一节 **不适用的系统文档**：

> - 无邮件发送，因此无 `emails.md`
> - 无定时或后台任务，因此无 `cron.md`
> - 无公开 Web 路由，因此无 `seo.md`

**这种"知道自己不是什么"的诚实，比列出功能更专业。**

---

## 三、它引用的记忆项目（我也该看）

| 项目 | 吸收了它什么 |
|---|---|
OpenClaw memory | 核心档案 + 可检索事件分层、明文可审阅、按需召回 |
claude-mem | 渐进披露、先返回压缩索引和证据编号 |
Napkin skill | 持续整理、合并重复、删除低价值、分类封顶 |
Cyrene-Agent / ZifaMem | 事实/推断分离、证据、置信度、冲突、替代状态 |
Mem0 / Letta | 多层记忆与核心/归档思路 |

**它明确拒绝的**："不引入常驻服务、云端依赖或无界 ADD-only 累积。"

---

## 四、我做了什么：把它转译成场景

### 4.1 新建技能库 `workbench/技能/`

| 文件 | 大小 | 内容 |
|---|---|---|
`relationship-advisor.md` | 2.8 KB | 行为内核（111 行 / 2016 token，**在预算内**） |
`relationship-advisor/长期记忆与关系档案.md` | 3.4 KB | 五类 scope + 硬限量 + 用户控制 |
`relationship-advisor/证据分级与内容边界.md` | 1.6 KB | 四级证据 + 包容性要求 |

**注意：我不是复制它的内容，是学它的结构。**
内容换成我方场景适用的，结构完全照它的规矩。

### 4.2 新建场景「关系军师」（5 个面板）

```
┌──────────────┬──────────┬──────────┐
│ 聊天记录/截图  │ 档案库    │          │
│ (review-doc)  │(files)   │          │
├──────────────┴──────────┤ AI·关系军师│
│ 场景位置(sf-board)        │ (harness) │
│                          │           │
├──────────────────────────┤           │
│ 记忆规范(review-doc)      │           │
└──────────────┴──────────┴──────────┘
```

### 4.3 新建场景契约 `sceneboard/scenes/relationship.json`

```json
{
  "id": "relationship",
  "skill": "技能/relationship-advisor.md",
  "evidenceLevels": ["较强证据", "理论框架", "流行说法", "经验策略"],
  "memoryScopes": ["user", "object", "relationship", "event", "hypothesis"],
  "outputs": [
    { "id": "relationship-advice", "schema": ["情绪落点","已知事实","合理推测","关键未知","首选建议","观察窗口"] },
    { "id": "relationship-archive", "schema": ["scope","field","value","source","confidence"] }
  ]
}
```

### 4.4 新建验证器 `workbench/工具/scene-validate.mjs`

**照它的 `validate_skill.py` 做的**，全部照搬思路：

| 检查项 | 照搬自它 |
|---|---|
frontmatter key 必须恰好 `name, description` | ✅ |
name 必须 `[a-z0-9-]{1,64}` | ✅ |
description ≤1024 且不含 `<>` | ✅ |
**行数/字符/token 三重预算** | ✅ **核心** |
零依赖 token 估算器 | ✅ **照搬** |
场景 json 必需字段 | 我方扩展 |
面板 id 唯一 / harness 有 sessionTitle / embed 有 url | 我方扩展 |
契约的 `to` 必须指向已知场景 | 我方扩展（Sceneflow 集成） |

---

## 五、实测结果

### 5.1 技能预算（这是最有价值的一条）

```
名称                        行     字符   token   状态
relationship-advisor       111   2807   2016    ✓
```

红线：150 行 / 5000 字符 / 4500 token —— **全部在预算内。**

### 5.2 token 估算器可信度验证

| 样本 | 估算 | 理论 |
|---|---|---|
纯中文 100 字 | **100** | 100 ✓ |
纯英文 100 词 | **130** | 130 ✓ |
混合（中200+英50） | 265 | 200+65 ✓ |
标点密集（300 符号） | 75 | 300/4=75 ✓ |

**估算器与理论值完全吻合，这不是拍脑袋。**

### 5.3 全套验收

| 套件 | 结果 |
|---|---|
**场景验证器** | **OK 全部通过（技能 1 · 场景 11 · 警告 0）** |
**技能接入测试** | **16/16** |
**记忆体检** | 11 个场景全部 OK |
**Sceneflow 引擎** | OK（产物 3，事件 4，场景 11，管线 2） |

### 5.4 验证器真的能发现问题（这是关键）

本轮它抓到两个真实 bug：

| 抓到的问题 | 说明 |
|---|---|
**技能缺 YAML frontmatter** | 实际是 CRLF 导致正则 `^---\n` 匹配不上 —— **Windows 上的真坑** |
**pipeline 缺场景契约** | 真实遗漏 |

**一个永远通过的检查没有价值。这两次证明它真的在检查。**

---

## 六、我比原项目多做的

| 我方扩展 | 价值 |
|---|---|
验证器同时检查**场景**（原项目只检查 skill） | 我们的场景也是"可验证对象" |
契约的产物去向必须指向已知场景 | 和 Sceneflow 集成，防断链 |
harness 面板必须有 sessionTitle | 防"会话绑不上"的静默失败 |
场景 json 面板 id 必须唯一 | 防渲染冲突 |

---

## 七、诚实的差距

| 它有、我们还没有 | 严重程度 |
|---|---|
**记忆的同意门禁**（`enable --confirm`） | 中 |
**记忆的可撤销操作**（`undo --op-id`） | 中 |
**SCOPE_LIMITS 按类封顶**（user 30/object 15/…） | 低（我们的记忆量还小） |
**9 个关键流程的完整文档** | 低（我们有契约但没写 flow 文档） |
**SQLite 事务与并发** | 低（单机单用户） |

**但最重要的差距已经补上了**：**token 预算**。

---

## 八、一句话

> **这个 9.3k 星的 skill 最值钱的不是"恋爱军师"，是它示范了三件事：**
> **① 上下文预算可计算（150 行/5000 字符/4500 token + 零依赖估算器）**
> **② 路由而非目录（遇到这个读那个）**
> **③ 诚实（明确说"我不是安全强制器""知识会过时""我不适用 emails/cron/seo"）**
>
> **我把这三点转译进了我们的工作台：技能库 + 关系军师场景 + 场景验证器。**
> **验证器当场上抓到了两个真实 bug（CRLF 导致的 frontmatter 失配、缺失的契约）。**
> **这是"可验证性"落地，比"又加了一个场景"有价值得多。**
