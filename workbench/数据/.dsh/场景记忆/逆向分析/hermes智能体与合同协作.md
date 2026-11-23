# 12 智能体 + 合同协作：全量写入 hermes

> 2026-11-14。把工作台的 12 个场景全量写成 hermes 的 12 个智能体（profile），
> 并把场景管线搬进 hermes 的 kanban 形成「合同协作」任务图。
>
> **验收：114 项断言全通过，0 失败。**

## 一、结论

```
智能体层   12 / 12   （每个 4 层全写完）
任务层     12 / 12   9 / 9 依赖边（与管线逐条比对一致）
断言       114 通过 / 0 失败
边界       hermes 的 default profile 未被触碰
```

复验命令：

```powershell
node prototype\verify-all.mjs     # exit 0
```

`hermes profile list` 现在列 13 项（default + 我们 12 个），每个都有 wrapper alias。

## 二、映射关系

| 我们 | hermes | 说明 |
|---|---|---|
| 场景 `外壳/scenarios/<id>.json` | `profiles/<id>/profile.yaml` | description 写成「合同」 |
| `场景记忆/<中文名>/AGENTS.local.md` | `profiles/<id>/SOUL.md` | 在 hermes 人格基线后追加身份 |
| `场景记忆/<中文名>/*.md` | `profiles/<id>/memories/` | 排除 AGENTS.local.md |
| `skills/<id>/` | `profiles/<id>/skills/<id>/` | 整目录复制 |
| `sceneboard/pipelines/*.json` | kanban `task_links` | 依赖边 |

profile 落在 `C:\Users\15282\AppData\Local\hermes\profiles\<id>\`。

## 三、四层各写了什么

### 层 1：profile.yaml —— 这是「合同」

```yaml
description: 职责：…。产出：<产物id> 给 <下游>。越界：…。验收：…。
description_auto: false
```

必须有「产出 / 越界 / 验收」三要素，因为下游要靠它判断该不该等我。
实测长度 130–166 字。

### 层 2：SOUL.md —— 身份

保留 hermes 默认人格基线（667 B，逐字节一致），`\n\n---\n\n` 后追加五段：

```
## 我是谁
## 我做什么
## 我不做什么（越界即拒）
## 硬约束
## 我的偏好
```

来源是该场景 `AGENTS.local.md` 的职责 / 不碰什么 / 铁律 / 偏好。

几处关键红线已写进「硬约束」：
- `pc-cleanup`：不删系统目录，只报告不动作（红线，不是建议）
- `hub`：不产出专业内容（不写码、不写文档、不做架构判断）；填不出 verify 不许派

### 层 3：skills/<id>/ —— 技能

三个文件：`SKILL.md` + `check.mjs` + `skill.json`，sha256 与源一致。

**验证加载成功**（用 hermes 自己列）：

```
│ arch-review │  │ local │ local │ enabled │
```

`agent/skill_utils.py` 用 `rglob` 扫 `SKILL.md`，任意深度都能发现，
所以 `skills/<id>/SKILL.md`（一层）不用改成 `skills/<分类>/<名>/SKILL.md`（两层）。

### 层 4：memories/ —— 记忆

场景记忆目录下除 `AGENTS.local.md` 外的所有 `.md`，文件名集合 + sha256 与源一致。
合计 129 个文件（12+11+13+14+13+7+10+11+8+4+4+11 中的实际数，见验收表）。

## 四、合同协作：kanban 任务图

### 管线（9 条边，去重后）

```
research ─┬→ competitor-analyze ─┐
          ├→ reverse-eng ────────┼→ arch-review → build-plan ─┬→ backend-craft
          └→ arch-review ────────┘                            ├→ frontend-craft
                                                               └→ tool-forge
独立：hub / incident-analysis / pc-cleanup / self-review
```

### 在 kanban 里

```
▶ t_be4e0ca1  ready     research           调研
▶ t_bbdef4f3  ready     hub                中枢
▶ t_26b1ffee  ready     incident-analysis  故障分析
▶ t_65edd4b0  ready     pc-cleanup         本地电脑
▶ t_35f2bf2e  ready     self-review        自我复盘
⊘ t_c07c5e29  blocked   competitor-analyze 竞品拆解      ← research
⊘ t_54fddf1b  blocked   reverse-eng        逆向分析      ← research
⊘ t_936fd770  blocked   arch-review        架构梳理      ← research + competitor-analyze + reverse-eng
⊘ t_f1d46a02  blocked   build-plan         实施计划      ← arch-review
⊘ t_5ef983cc  blocked   backend-craft      后端工坊      ← build-plan
⊘ t_d082ea8e  blocked   frontend-craft     前端工坊      ← build-plan
⊘ t_53d4b8fa  blocked   tool-forge         工具工坊      ← build-plan
```

`blocked` 就是「上游没完成不许硬做」，和我们工作台的派单哨兵同义。

每个任务的 body 里写死四条完成合同：

```
1. 产出物已写入工作区，路径明确；
2. 每条结论都有证据（文件 / 命令输出 / 截图），不许只写结论；
3. 越界内容一律不产出；
4. 自验通过，并在回帖里给出数字。
```

## 五、踩到的坑（5 个，都实测）

### ① kanban 派单器会自己拉起 worker —— 一次失控到 48 个进程

建完 12 个 `ready` 任务后，python 进程从 2 个涨到 **48 个**。
因为 gateway 里嵌着 kanban dispatcher（`interval=60s`），
它把每个 ready 任务 claim 成 `running` 并拉起 worker。

**修法**：建任务前先 `hermes pause`（写 `ESTOP` 哨兵），建完保持暂停。
状态卡在 `running` 的用 `hermes kanban reclaim <id>` 放回 `ready`。

### ② `--completion-contract` 不是自由文本

```
kanban: completion_contract must be local-only, OWNER/REPO, or an exact GitHub PR URL
```

它的语义是**交付落点**，不是验收标准。
验收标准走 `--body-file`，落点固定 `local-only`。

### ③ `--board` 是全局参数

`hermes kanban --board dsh create ...` ✓
`hermes kanban create --board dsh ...` ✗ unrecognized arguments

`link` 同理，必须 `kanban --board dsh link p c`。

### ④ 事后再 `link` 挂不上

```
kanban: cannot link X -> Y: child is already running
```

`ready` 状态已被派单器算作启动，链接被拒；而且 kanban **没有删除单个任务的命令**，
只能 `boards delete` 整块板重来。

**修法**：建任务时就用 `--parent` 传依赖，并加 `--initial-status blocked`。

### ⑤ `create --json` 是格式化多行 JSON

`String(out).trim().split('\n').pop()` 拿到的是 `}`，task id 全 null，父依赖静默丢失。
必须整段 `JSON.parse`。

另外 `hermes kanban list --json` 这个版本**不支持**（抛 traceback），
验证要直接读 SQLite：`%LOCALAPPDATA%\hermes\kanban\boards\dsh\kanban.db` 的 `tasks` / `task_links` 表。

## 六、两个执行细节

### PowerShell 传中文给 python 会显示乱码（但文件字节是对的）

`profile.yaml` 实测字节 `E8 B0 83 E7 A0 94` = 「调研」的正确 UTF-8。
乱码只是 PowerShell 控制台显示问题。
但**为稳妥，中文一律走文件写入**（write 工具 / node fs），命令行只传 ASCII。

### `profile create` 必须在 `C:\hermes` 下跑

否则 `ModuleNotFoundError: No module named 'hermes_cli'`
（venv 里没装这个包，靠 cwd 进 `sys.path`）。

### 唯一的结构性例外：`research` 撞名

hermes 内置 44 个 bundled 技能里有分类目录 `research`，
和我们的场景 id `research` 同名 → 两边都写到 `skills/research/`。

处理：保留 bundled 的 9 个文件（DESCRIPTION.md + arxiv/ + competitor-news-monitor/ + grounded-citations/），
我们的 3 个文件并存。验证时按「我方文件名集合」计数（3/3），不按目录总文件数（12）。

其余 11 个 id 都不撞名（`arch-review` 看似像内置分类，实测 `C:\hermes\skills` 里没有它）。

## 七、现状与下一步

- 派单器**保持暂停**（`ESTOP` 存在）。没有模型密钥时 resume 会让 worker 空转。
- 要真正跑起来需要：配 provider key → `hermes resume` → 5 个根任务会被派单。
- 已建 5 个 `ready` 根任务（research / hub / incident-analysis / pc-cleanup / self-review）。
