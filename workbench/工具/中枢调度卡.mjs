/**
 * 中枢调度卡 v2 —— 按业界实践重写
 *
 * ══════════════════════════════════════════════════════════════
 *  这是 v2，不是 v1 的小改
 * ══════════════════════════════════════════════════════════════
 *
 *  v1（930 B）的定位基本对，但缺了业界最关键的三条硬约束，
 *  而且把「名册细节」和「流程步骤」都塞进了注入。
 *
 *  依据 方案/121 调研（Magentic-One / Anthropic / MAST，三处独立证据）：
 *
 *  1. 主 agent 的核心工作不是「分派 + 拼接」，
 *     而是：把模糊需求变成可验收的工单 + 维护一本台账 + 判定何时算完。
 *
 *  2. 注入只承担「身份 + 名册 + 契约 + 不变量 + 输出格式」；
 *     流程做成工具与校验（Claude Code：必须每次都发生的事做成 hook，
 *     不要写成 prompt 文字）。
 *
 *  3. 名册细节不进注入。Claude Code 实测：subagent 描述总和超 15k token
 *     启动时会告警。所以注入里只放「何时派给它」一行，细节查 route 工具。
 *
 *  4. 三条 v1 缺的硬约束（必须补）：
 *     · 填不出 verify 就不许派   ← 填不出说明没搞清这场景干什么
 *     · 同一 subject 不得挂在两个场景
 *     · 调度动作对用户不可见（不汇报「我转给了谁」）
 *
 *  5. 「50 行代码」判据要换掉。
 *     它是代理指标，可被绕过（写 49 行 / 写 300 字「短但完整」文档 /
 *     做一次架构判断），且覆盖不到「读源码做归因」。
 *     改成产物归属判据（见下）。
 *
 * ══════════════════════════════════════════════════════════════
 *  两条判据的分工（调研 §2.5 指出的坑）
 * ══════════════════════════════════════════════════════════════
 *
 *  中枢私有记忆里原来的「派单前四个问题」（会反复回来吗 / 有资产目录吗 /
 *  有专业流程吗 / 能说清不碰什么吗）是**建场景**判据，不是派单判据。
 *  两套混在一起，中枢会在「要不要派」和「要不要新建场景」之间反复横跳。
 *
 *  → 建场景判据搬到场景工厂 skill
 *  → 中枢只留派单判据（产物归属）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrefs, buildPrefInjection } from './偏好记忆.mjs';
import { buildPortrait } from './场景画像.mjs';
import { buildSignature } from './身份.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
// ⚠ 2026-11-11 补：画像段需要 SCEN_DIR，之前没定义
//   → 抛 ReferenceError → 被 try/catch 静默吞掉 → 画像段静默失效
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const ROUTE_YAML = path.join(WB, '数据', '.dsh', '场景路由.yaml');
// ⚠ 2026-11-10 修正：会话 cwd 已迁移到 场景记忆/<场景名>/
//   原来写 场景注入/hub 是旧路径，AI 读不到（和 场景注入.mjs 同一个 bug）
const OUT_DIR = path.join(WB, '数据', '.dsh', '场景记忆', '中枢');

const BUDGET = 2800;   // 2026-11-11 从 2400 提高：加场景画像后不够   // 2026-11-10 从 2000 提高：加偏好注入后不够   // v1 930 B，v2 补三条硬约束 + 换判据，实测 1897 B
//
//  为什么不压到 930：调研明确指出三条硬约束是 v1 缺的关键
//  （填不出 verify 不许派 / 同一 subject 不双挂 / 调度动作不可见），
//  它们能避免的失败远大于 967 B 的注入成本。

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  从 route.yaml 读名册
//
//  注入里每个场景只放一行「何时派给它」，
//  细节（does_not / deliverable / verify_hint）让中枢按需查 route 工具。
// ══════════════════════════════════════════════════════════════
function loadRoster() {
  const t = readTextSafe(ROUTE_YAML);
  if (!t) return [];

  const out = [];
  let cur = null;
  for (const raw of t.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const mId = line.match(/^-\s+id:\s*(.+)$/);
    if (mId) {
      if (cur) out.push(cur);
      cur = { id: mId[1].trim() };
      continue;
    }
    if (!cur) continue;
    const mKv = line.match(/^  (name|dispatch_when):\s*(.+)$/);
    if (mKv) cur[mKv[1]] = mKv[2].trim();
  }
  if (cur) out.push(cur);
  return out.filter((s) => s.id && s.name);
}

// ══════════════════════════════════════════════════════════════
//  生成中枢调度卡 v2
// ══════════════════════════════════════════════════════════════
function buildCard(roster) {
  // 名册：dispatch_when 截到 ≤14 字（细节在 route.yaml，用工具查）
  const SHORT = {
    'research': '找资料、找参考实现、出清单',
    'competitor-analyze': '拆竞品功能矩阵、能力边界',
    'reverse-eng': '拆目录结构、模块、数据流',
    'arch-review': '出架构方案、定分层、列风险',
    'build-plan': '排阶段、里程碑、验收标准',
    'incident-analysis': '崩溃日志归因（只分析不改码）',
    'pc-cleanup': '清磁盘、查容量、本机杂事',
    'self-review': '读历史数据、归档个人资料',
  };

  const L = [];

  // ═══ 身份（2 行）═══
  L.push('# 中枢');
  L.push('唯一交互入口。只做四件事：**判断归属、派单、跟踪、汇总**。');
  L.push('不产出专业内容——不写码、不写文档、不做架构判断、不读日志归因、不清磁盘。');
  L.push('');

  // ⚠ 2026-11-12 精简（原来 668B，占中枢卡 21%）
  //
  //   原版给了两段完整示例（cd + 绝对路径）+ 一段「⚠ 会报 Cannot find module」。
  //   对中枢来说这些是冗余的 —— 中枢只需要知道「命令要在项目根跑」这一条事实。
  //   压缩到约 330B，保留：cwd 在哪、工具在哪、一个可直接复制的写法、失败症状。
  const projRoot = path.resolve(WB);
  L.push('## 命令执行目录');
  L.push('');
  L.push('你的 cwd 是 `数据/.dsh/场景记忆/中枢`，但**工具在项目根**。');
  L.push('技能里写的 `工具/xxx.mjs` 是相对项目根的，直接跑会 `Cannot find module`。');
  L.push('');
  L.push('先切到项目根再跑：');
  L.push('```powershell');
  L.push('cd "' + projRoot + '"');
  L.push('node 工具/派单.mjs --list');
  L.push('```');
  L.push('');

  // ═══ 名册（一行一个）═══
  //
  //  ⚠ 2026-11-12 精简：排除「中枢自己」
  //
  //    原来名册里有一行「**中枢**：用户直接提需求、要判断归属、要汇总多场景结果、要跟踪派单进度」——
  //    但中枢就是读这份卡的 AI，它当然知道自己是谁。
  //    这一行 80B，只是把身份那两行重复了一遍。
  L.push('## 名册');
  for (const s of roster) {
    if (s.id === 'hub') continue;   // 不列自己
    L.push('- **' + s.name + '**：' + (SHORT[s.id] || s.dispatch_when));
  }
  L.push('细节查 `node 工具/路由表.mjs --scene <id>`。');
  L.push('');

  // ═══ 固定动作 ═══
  L.push('## 动作');
  L.push('1. 复述要什么产物。说不清 → 问 ≤3 题，不派。');
  L.push('2. `node 工具/路由表.mjs --route-json "<需求>"` 判归属。');
  L.push('   `scene` 只能是 8 个之一或 null；`needs_clarification: true` → 问用户，**不许猜**。');
  L.push('3. 四件套 subject/phenomenon/howto/verify。**填不出 verify 不许派。**');
  L.push('4. `--deliver` 投递；`node 工具/进度判定.mjs --json` 看五问。');
  L.push('5. 拿 verify 对证据；对不上 → 打回，不许销账。');
  L.push('');

  // ═══ 汇总格式 ═══
  L.push('## 汇总（≤400 字）');
  L.push('```');
  L.push('## 结论  ≤3 句，直接回答用户原话');
  L.push('## 证据  每条一行，末尾挂 [场景 · 产物路径]');
  L.push('## 分歧与缺口  不一致 / 没覆盖 / 我的推断');
  L.push('## 下一步  ≤3 条，可省');
  L.push('```');
  L.push('**正文不出场**：只给指针，要细节给路径或派「成稿」单。写完跑 `汇总校验`。');
  L.push('');

  // ═══ 硬不变量 ═══
  L.push('## 不变量');
  L.push('- 填不出 verify 不许派');
  L.push('- 同一 subject 不双挂场景');
  L.push('- 别人的产物只读不改；没读过不替它下结论');
  L.push('- 每句判断要么有证据，要么标「我的推断」');
  L.push('- **调度动作对用户不可见**：不汇报转给了谁，只汇报结果');
  L.push('');

  // ═══ 越界判据 ═══
  L.push('## 越界判据');
  L.push('- 我要产出的东西，是某个场景的产物吗？是 → 派单。');
  L.push('- 我为下判断读源码/日志超 3 分钟？→ 那是场景的活。');
  L.push('');

  // ═══ 我的偏好（六类）═══
  //
  //  ⚠ 2026-11-10 补（中枢是唯一直接和用户对话的角色，
  //    交互偏好对它最重要，之前完全没注入）
  //
  //  设计依据（视频 BV1H1nU6bEJ5）：
  //    「这套记忆不只记事实，还记偏好。我分六类：
  //      交互/工具/文件/协作/安全/记忆」
  //
  //  中枢直接对用户说话，所以「叫我什么」「用什么语言」
  //  「要不要空话开头」这些偏好必须让它知道。
  try {
    const prefs = loadPrefs();
    if (prefs.length > 0) {
      const inj = buildPrefInjection(prefs);
      if (inj.items.length > 0) {
        L.push('## 我的偏好');
        for (const p of inj.items) {
          L.push('- ' + p.text);
        }
      }
    }
  } catch { /* fail-open */ }

  // ═══ 我的界面（场景画像摘要）═══
  //
  //  ⚠ 2026-11-12 精简（原来 212B → 约 120B）
  //
  //   中枢只有 1 个面板（hub-neuron 记忆神经元），把每个面板列一行是冗余的。
  //   压成一句话：面板数 + 改哪个文件 + 改前先快照。
  //   细节让 AI 自己去读 场景画像.md（它本来就在那个目录里）。
  try {
    const sj = JSON.parse(readTextSafe(path.join(SCEN_DIR, 'hub.json')) || '{}');
    const pt = buildPortrait(sj);
    if (pt.panelCount > 0) {
      L.push('');
      L.push('## 我的界面');
      L.push('网格 ' + pt.grid.cols + '×' + pt.grid.rows + '，' + pt.panelCount +
        ' 个面板（' + pt.panels.map((x) => '`' + x.id + '`').join(' ') + '）。');
      L.push('改自己 = 改 `' + pt.configPath + '` 的 panels 数组；改前先跑 `node 工具/回滚.mjs --snapshot --type ui`。');
    }
  } catch { /* fail-open */ }

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════
const roster = loadRoster();
if (roster.length === 0) {
  console.error('✗ 读不到名册（检查 ' + ROUTE_YAML + '）');
  process.exit(2);
}

const card = buildCard(roster);
const bytes = Buffer.byteLength(card, 'utf8');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'AGENTS.local.md'), card, 'utf8');

console.log('═'.repeat(72));
console.log('  中枢调度卡 v2');
console.log('═'.repeat(72));
console.log();
console.log('  名册场景: ' + roster.length);
console.log('  体积:     ' + bytes + ' B  (预算 ' + BUDGET + ' B, 占用 ' +
  Math.round(bytes / BUDGET * 100) + '%)');
console.log('  v1:       930 B');
console.log('  变化:     ' + (bytes >= 930 ? '+' : '') + (bytes - 930) + ' B ' +
  '(补了三条硬约束 + 换掉越界判据)');
console.log();

// ⚠ 2026-11-12 修（假预算：只打印警告，不停、不报错）
//
//   原来：if (bytes > BUDGET) console.log('  ⚠ 超出预算');
//         —— 打印一句警告，然后 exit 0，文件照写。
//
//   实测：中枢的 AGENTS.local.md 已经 3212B / 预算 2800B（115%），
//        每次跑都打印「⚠ 超出预算」，但没人当回事，因为 exit 0。
//        同时 中枢调度卡哨兵 测的是**废弃目录**的旧文件（2223B），
//        所以那条 INV-1 也是绿的 —— 两处加起来，一个 43% 超标的 prompt
//        一直没人发现。
//
//   修法：超预算必须 exit 1（与哨兵的 INV-1 一致）。
//        文件仍然写（否则 AI 完全读不到），但退出码要红 ——
//        让机制体检能判出失败。
if (bytes > BUDGET) {
  console.log('  XX 超出预算：' + bytes + ' B > ' + BUDGET + ' B（' +
    Math.round(bytes / BUDGET * 100) + '%）');
  console.log('     超预算意味着中枢的 prompt 太长 —— 会挤掉真正重要的约束。');
  console.log('     修法：删掉可省的章节，或提高 BUDGET 并说明理由。');
  process.exitCode = 1;
} else {
  console.log('  ✓ 在预算内');
}

console.log('─'.repeat(72));
console.log(card);
console.log('─'.repeat(72));
