/**
 * 处置矩阵里 9 项假绿：把「hermes 有能力」改写成「我们有什么 + 借了什么」
 *
 * 处置原则（不粉饰）：
 *   · 我们确实没有自己实现的 → 状态从「有」降到「部分」，证据里写明
 *     「能力来自 hermes 补丁基线，我们尚未自研」+ 我们实际做了什么（如有）
 *   · 绝不把 hermes 的行为写成我们的实现
 *
 * 用法：node prototype/hermes-agents/fix-matrix-honesty.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');
const CHECK = process.argv.includes('--check');

const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const dims = raw.dimensions.flatMap((g) => g.items);
const byId = new Map(dims.map((d) => [d.id, d]));

/**
 * 每项的处置。state 是我们**真实**的状态。
 */
const FIXES = {
  A3: {
    state: '部分',
    evidence:
      '【借力·未自研】联网能力来自 hermes 基线（tools/ 内建 web 搜索与抓取），我们没有自己的实现。' +
      '我们自研的只有**取证用途**的抓取脚本：`prototype/agent-ui/ui-survey-fetch.mjs` 与 `ui-survey-render.mjs`，' +
      '用于把外部界面参考抓成可比对的本地证据，不是通用搜索工具。',
  },
  A4: {
    state: '部分',
    evidence:
      '【借力·未自研】图像/文件输入走 hermes 的 vision 工具（已实测能准确读出我们星图截图的径向网络结构、' +
      'skill/memory 图例、"12 / 12" 计数，并诚实说明"小字模糊不猜"）。**这是 hermes 的能力，不是我们的**。' +
      '音频未接（hermes stt 默认 disabled）。我们自研的是截图比对流程：`prototype/hermes-agents/capture-pages.mjs` + `measure-ui.mjs`。',
  },
  A11: {
    state: '部分',
    evidence:
      '【借力·未自研】定时任务来自 hermes 的 cron/ 与 scheduler_provider，`hermes cron list` 实测可用（当前无 job）。' +
      '我们**没有自己的调度器**。自研部分只有验收脚本的重复执行入口（如 `tools/gen-snapshot.mjs` 批量跑套件），' +
      '那是构建期批处理，不是产品级调度。',
  },
  A12: {
    state: '部分',
    evidence:
      '【借力·未自研】技能生态来自 hermes（44 内置 + 141 可选），`hermes skills list --profile arch-review` 实测可用。' +
      '我们自研的是**清单读取**：`tools/gen-snapshot.mjs` 扫 .claude/skills 与 tools/ 生成能力快照给界面用，' +
      '不提供技能市场、不提供运行时装载。',
  },
  A13: {
    state: '部分',
    evidence:
      '【借力·未自研】MCP 来自 hermes（optional-mcps 66 文件），`hermes mcp add/list` 实测可用（当前无服务器）。' +
      '我们**没有自己的 MCP 客户端**。我们在 `apps/agent-ui/src/scenes/Capabilities.tsx` 里把 MCP 清单显示为空态 —— ' +
      '因为确实还没配，不拿示例条目凑数。',
  },
  B1: {
    state: '部分',
    evidence:
      '【借力·未自研】插件化内核是 hermes 的（plugin_api.json 白名单 50 模块 + contrib registry 贡献点），' +
      '`hermes plugins list` 实测可用。我们的贡献方式是**补丁集**（`hermes-patches/`，7 个文件，`apply.mjs --check` 全通过），' +
      '不是自己的内核。',
  },
  B3: {
    state: '部分',
    evidence:
      '【借力·未自研】跨工具可移植靠 hermes（`hermes acp` 支持 VS Code/Zed/JetBrains，26 平台 + 43 provider 插件）。' +
      '我们**没有自己的协议实现**；自研部分只是前端 fork 的构建链（`apps/vouch-web/` 可独立 vite build）。',
  },
  B4: {
    state: '部分',
    evidence:
      '【有自研】体积纪律我们用**可判定断言**管：`prototype/hermes-agents/audit-matrix-honesty.mjs` 断言矩阵每格有真实证据路径，' +
      '`prototype/agent-ui/verify-ui-layer.mjs` 断言前端产物结构，`prototype/hermes-agents/verify-goal.mjs` 8 条硬要求。' +
      '但**产品代码的单文件体量红线还没有**（hermes 侧靠记忆哨兵 PRIVATE=25600 字节，那是它的）。',
  },
  D3: {
    state: '部分',
    evidence:
      '【借力·未自研】运行时状态可见性来自 hermes insights（实测 16 会话/105 消息/39 工具调用/86,970 入 token 等，' +
      'session_model_usage 表含逐会话成本）。我们自研的是**验收侧**状态可见性：' +
      '`tools/gen-snapshot.mjs` 把 5 个验收器的四态结果 + 能力清单落成 `apps/agent-ui/src/data/snapshot.json`，' +
      '界面 `Verify.tsx` 显示真实计数（判不了单列，不并入通过）。产品运行时的状态面板尚未接入。',
  },
};

let changed = 0;
for (const [id, fix] of Object.entries(FIXES)) {
  const dim = byId.get(id);
  if (!dim) { console.log('  ✗ 找不到维度 ' + id); continue; }
  const before = dim.us[0];
  if (CHECK) {
    const same = dim.us[0] === fix.state && String(dim.us[1]).includes('【');
    console.log('  ' + (same ? '✓' : '✗') + ' ' + id + ' 当前[' + before + '] 目标[' + fix.state + ']');
    continue;
  }
  dim.us = [fix.state, fix.evidence];
  changed++;
  console.log('  ✓ ' + id + '  [' + before + ' → ' + fix.state + ']');
}

if (!CHECK) {
  fs.writeFileSync(DATA, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  console.log('\n  ✓ 已写回 matrix-data.json（' + changed + ' 项）');
  console.log('  下一步：node prototype/hermes-agents/render-matrix.mjs 重新生成对比矩阵.md');
}