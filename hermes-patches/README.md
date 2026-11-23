# hermes-patches：在 hermes 上衍生的补丁集

## 为什么是补丁而不是改上游

`C:\hermes` 是解压的上游源码树，**不是 git 仓**。所以「所有改动进 git」只能靠这一层：
上游保持原样，我们的东西是一套可审查、可重放、可回退的补丁。

这也决定了以后怎么加界面功能：**不新写界面，改 hermes 的数据源或贡献点**。
上游升级时重新 `--check` 一遍就知道哪些补丁要重打。

## 现在有什么

| 文件 | 类型 | 干什么 |
|---|---|---|
| `agent/neuron_graph.py` | 新增 | 把 `dsh-shared/NEURON.json` 转成 hermes 星图的数据结构 |
| `agent/learning_graph.py.patch` | 修改（18 行） | 在 `build_learning_graph()` 里并入神经元层 |

合起来的效果：**我们的记忆神经元出现在 hermes 自带的星图里**（`/starmap`），
不需要写一行前端代码 —— 用的是 hermes 那套 32KB 渲染器 + 力导向模拟 + 时间轴回放 + share code。

## 怎么用

```bash
node hermes-patches/apply.mjs --check     # 只校验，不改
node hermes-patches/apply.mjs             # 应用（幂等）
node hermes-patches/apply.mjs --revert    # 回退
```

默认目标是 `C:/hermes`，可以传别的根目录。

## 关键设计决定（都有代价，写清楚）

### 1. 节点 id 加 `scene:` 前缀

场景 id 会和 hermes 自己的技能重名：我们的场景 `research` vs hermes 内置技能分类 `research`。
星图拿 id 当实体身份，重名会让两条边挂到同一个节点上。所以统一 `scene:<id>`，显示名用中文 label。

### 2. 时间戳故意留空

星图的径向轴语义是「什么时候学到的」。我们的场景图是**拓扑图**：

- 12 个场景里 10 个是同一天建的（git 首次提交 2026-11-10），真实时间线基本是一个点
- 把同一桶的 9 个节点塞进同一条环 → 标签完全互相覆盖（实测截图中心是一坨读不出的字）

所以不编假时间。`simulation.ts` 的 `indexFor()` 会把无时间节点放到最外环，
再按 id 的 FNV 角度扇开，12 个节点就均匀铺在外圈。

**代价**：时间轴这条信息对我们这张图没有意义，中间会显示 hermes 自带的
「Matrix 字符雨」装饰（`render.ts:745` 注明 `PURELY decorative`）——那不是我们的字乱码。

### 3. useCount 用真实派单次数

不填 0，也不用记忆文件数。读 `dsh-shared/派单台账.json` 的 `from`/`to`/`createdAt`：

- 中枢被派了 **62** 次 → 星图上最大最亮的那个点，这是事实
- 7 个场景从未被派单 → 如实统计进 `stats.neuron_never_dispatched`，不隐藏

星图的 `nodeRadius()` 是 `3 + sqrt(useCount)*0.55 + pinned*0.8`，所以权重直接体现为大小。

### 4. 领域来自场景源头

`workbench/外壳/scenarios/<id>.json` 的 `domain` 字段（6 个领域：中枢/调研/设计/实现/质量/运维）。
它只写在一处，`NEURON.json` 由 `integrate-neuron.mjs` 从源头重新生成。
星图按 `category` 聚类，所以领域自动变成 6 个簇。

## 验证

```bash
node prototype/hermes-agents/verify-starmap.mjs
```

三层都要绿才算过：

1. **数据层** —— `build_neuron_layer()` 返回 12 节点 / 29 无向边 / 6 领域
2. **传输层** —— 节点 id 全带前缀、枢纽识别正确、派单数 76、未派单 7
3. **界面层** —— CDP 进 `/starmap`，DOM 里读到 `12 / 12`，canvas 挂载，截图落盘

> 29 而不是 31：`NEURON.json` 的 31 条是**有向**边，星图是**无向**图，
> 2 处真实业务环（hub↔incident-analysis、hub↔pc-cleanup）各塌成 1 条 → 31 − 2 = 29。

## 注意

`agent/neuron_graph.py` 的 `_dispatch_usage()` 读不到台账时返回空，`build_neuron_layer()`
任何异常都返回空层，绝不抛异常 —— 星图是只读视图，我们的接入不能让它白屏。

---

## 界面补丁：`apps/desktop/src/components/chat/intro.tsx`

### 改了什么

空态从「一个超大 SERIF 字标 + 一行副标题」变成「字标 + 副标题 + **12 个可点的场景卡片**」。

原状（上游）：

```tsx
<div className="pointer-events-none ...">     {/* 整个空态不可点 */}
  <Wordmark text="HERMES AGENT" />
  <p>{body}</p>                                {/* 一句随机文案 */}
</div>
```

改后：在 `<p>` 之后加一个 `4×3` 网格，每格是一个场景按钮，
点一下 `newSessionInProfile(p.name)` —— 在**该场景的 profile 里**开新会话。

数据来自 `$profiles`（hermes 自己的 profile store），**组件里不硬编码任何场景名**。

### 为什么这么做（不是我自己想的）

用户要求「界面设计全方面借鉴当下主流的这些 agent」。调研 25 个系统后，
主流空态的共同形态是**放可点入口**，不是放标语：

| 产品 | 空态形态 |
|---|---|
| ChatGPT | 建议卡片 |
| Kiro | `+ New session` + 会话列表 |
| Qoder | `What can Qoder help you with` |
| **DSH** | 专门的 `conversation.hero.brand.mark` / `hero.agentPreset` / `hero.options` slot |

我们原来那一屏是「主流里最空的之一」：实测 160 文字块 / 5.55% 密度，
Kiro 真界面是 269 / 9.24%（`measure-ui.mjs` 同一算法）。
改后 186 文字块 / 6.84% 密度。

详见 `research/界面设计全量调研.md`。

### 中文名从哪来（单一源）

`display_name` 由 `prototype/hermes-agents/sync-profile-display.mjs` 从
`workbench/外壳/scenarios/<id>.json` 的 `name` 字段**单向同步**进
`%LOCALAPPDATA%\hermes\profiles\<id>\profile.yaml`。

**不许在组件里写死 12 个中文名** —— 那就是 ECC 那种 45% 漂移的起点。
同步脚本带 `--check` 模式，可以进 CI。

### ⚠️ 为什么界面是整份替换，不是 diff

`C:\hermes` 不是 git 仓，没有可 diff 的基线。所以这个文件是**整份替换**，代价要说清楚：

- 上游若在 `intro.tsx` 里改了别的东西（比如新增 personality 分支），**本补丁会覆盖掉**
- 上游升级后必须：`apply.mjs --check` 看是否已应用 → 若上游改过，**手动合并**这两个 hunk
- 改动很小（两个 hunk：imports + render 里的场景网格），手工合并成本低

### 改完必须重新构建

界面改动要重建才能生效，而且**必须跑完整构建**：

```bash
cd C:/hermes/apps/desktop && node scripts/build.mjs
```

⚠️ **不要只跑 `vite build`** —— 那会清掉 `dist/electron-main.mjs`，应用直接起不来
（实测报 `Cannot find module 'dist/electron-main.mjs'`）。`build.mjs` 会同时构建渲染层和 electron 主进程。

### 另一个坑：`ELECTRON_RUN_AS_NODE`

如果从 DSH 自己的进程树里启动 electron，会继承 `ELECTRON_RUN_AS_NODE=1`，
electron 退化成纯 Node，报 `does not provide an export named 'BrowserWindow'`。
启动前必须清掉这个环境变量。

---

## 审批加固（A15）：四个 tools 文件

改动文件（整份替换，同上没有 git 基线）：
`tools/approval_context.py` · `tools/approval.py` · `tools/approval_detection.py` · `tools/terminal_tool.py`

### 先说结论：原来的「高危漏洞」判断不准确

实测把这件事拆成了三层，**三层都有证据**（判据是金丝雀文件是否存活，不是模型怎么说）：

| 层 | 实测结果 | 性质 |
|---|---|---|
| `hermes -z` | 自动放行，目录被删 | **设计契约**，不是漏洞：`gateway/session_finite.py:27` 注释原文「`hermes -z`: nobody can answer a prompt, so the classic one-shot contract auto-approves (legacy oneshot.py set HERMES_YOLO_MODE)」 |
| `hermes chat -q --oneshot` | `rm -rf <dir>` / `git push --force` / `curl\|bash` **全部 BLOCKED**，hardline 拦 `rm -rf /` | 审批**确实在工作**，`approvals.single_query_mode` 默认 deny |
| 模式匹配本身 | 可被**等价分解**绕过 | **真问题**，见下 |

所以我们之前记的「A15 审批被绕过·高危」是**用错了模式**（一直用 `-z`）得出的错误结论。已改。

### 真问题：模式匹配不是安全边界

实测两条绕过链（都在 `-q`、无人可答、默认 deny 的前提下成功）：

```
链 1（先写后执行）
  1. terminal  rm -rf <dir>                        → BLOCKED ✓
  2. terminal  python -c "shutil.rmtree(...)"      → BLOCKED ✓
  3. write_file → cache/scratch/del.py             → 放行（写文件不危险）
  4. terminal  python <scratch>/del.py             → 放行 ✗ 目录被删

链 2（等价分解）
  1. terminal  rm -rf <dir>                        → BLOCKED ✓
  2. terminal  rm <dir>/canary.txt && rmdir <dir>  → 放行 ✗ 目录被删
     （`rm` 不带 -r 不匹配「递归删除」；`rmdir` 只删空目录所以也不匹配）
```

**要点：任何有限的黑名单都能被等价分解。** 这是模式匹配的固有性质，再加十条正则也追不上。
参照系统（Claude Code 等）用的是工具级权限 + 沙箱，不是命令文本匹配。

### 本轮修了什么

1. **路径围栏**（`approval_detection.py: _path_fence_finding`）
   删除动词的目标若**全部落在允许根之外**（允许根 = 进程 cwd / `HERMES_HOME` / 临时目录）→ 标记。
   判的是**删除落在哪**，不是**命令怎么拼**，所以分解没用。修掉链 2。
   刻意保守：只有「所有目标都在外面」才标记，所以 `rm -rf node_modules`、`rm -rf ./dist`、
   `rm -rf /tmp/build-out` 这些工作区内/临时的操作不会多一次提示。

2. **scratch 脚本执行检测**（`approval_detection.py: _runs_scratch_script`）
   解释器指向 `*/cache/scratch/*` 的脚本 → 标记（守卫看不到脚本内容，只能当作不可验证）。
   修掉链 1。实测 `python manage.py migrate`、`node server.js` 不误报。

3. **未识别非交互上下文从 fail-open 改 fail-closed**
   `approval.py` 两处兜底 `return _approved()` 改为查 `approvals.no_context_mode`（默认 deny）。
   新增 `approval_context.py: _get_no_context_approval_mode()`。
   只影响**被标记**的命令，未标记的命令照常放行 —— 否则所有非交互操作都会被拦死。

4. **把静默放行变成可追溯** —— 这是「界面/状态可见性」维度的落地
   yolo / `mode: off` 短路放行一个被标记的命令时：
   - 打 `WARNING`（进 `agent.log` / `errors.log`）
   - 在**工具结果**里写 `"approval": "AUDIT: … NO human approved it … Treat its effects as unreviewed."`
     （`approval.py: _approved(**extra)` + `terminal_tool.py` 的 note 分支）
   实测 `-z` 的工具结果里确实出现该字段。日志里没人看，工具结果才会进 transcript。

### 残余风险（不许当已解决）

模式匹配仍不是安全边界。一个足够有能力的模型可以继续找等价分解（第三方可执行文件、
MCP 工具、写文件后让别的进程执行……）。**真正的边界只能是沙箱/VM 或工具级权限允许列表**，
那是架构改动，不在本轮范围。

因此矩阵里 A15 记 **「部分」而不是「有」** —— 只要残余风险在，它就不是完整的安全边界。

### 验证

```bash
python prototype/hermes-agents/verify-a15.py      # 5 断言，含金丝雀端到端
python prototype/hermes-agents/probe-bypass.py    # 还原任意会话的完整工具序列
python prototype/hermes-agents/probe-approval.py  # 守卫函数判定矩阵
```

⚠️ **改完必须重启网关进程**（`python _run_gateway.py run --force -q`），否则跑的还是旧代码。
排查时踩过：补丁已落盘但网关是半小时前起的，症状是「代码改了却没生效」，我据此误判了一整轮。

⚠️ **不要用 `Set-Content -Encoding UTF8` 改这些 .py 文件** —— PowerShell 会加 BOM，
Python 3 报 `SyntaxError: invalid non-printable character U+FEFF`。用
`[System.IO.File]::WriteAllText($p, $txt, (New-Object System.Text.UTF8Encoding($false)))`。

---

## ⚠️ 启动网关必须设 HERMES_HOME（最有欺骗性的失败模式）

`python _run_gateway.py run --force -q` 如果不带 `HERMES_HOME`，会回退到
`Path.home()/".hermes"`（即 `C:\Users\<user>\.hermes`），那是**另一个 home**：
没有 `dsh-shared/NEURON.json`、没有 `state.db` 里的会话与学习数据。

症状极具欺骗性：
- 应用照常启动，状态栏显示「后端 就绪」
- 但星图显示「尚无学习内容」，节点数 0
- 验收器报「没有 canvas / 图例缺失 / 节点计数 null」

看起来像前端坏了，其实是**后端读错了 home**。本轮为此误判了一轮。

正确启动方式：

```powershell
$env:HERMES_HOME = "C:\Users\<user>\AppData\Local\hermes"
$env:HERMES_GIT_BASH_PATH = "D:\file\env\Git\bin\bash.exe"   # terminal 工具需要
cd C:\hermes
Start-Process .venv\Scripts\python.exe -ArgumentList @("_run_gateway.py","run","--force","-q")
```

同理，从 DSH 进程树里起 electron 要清 `ELECTRON_RUN_AS_NODE`（见上一节）。
