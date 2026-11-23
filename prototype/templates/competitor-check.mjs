#!/usr/bin/env node
// 数据/.dsh/skills/competitor-analyze/check.mjs —— 「竞品拆解 / 拿来主义」的可执行验收
//
// ══════════════════════════════════════════════════════════════════════
//  为什么重写（与 research 是两个不同场景，判据必须不同）
// ══════════════════════════════════════════════════════════════════════
//  旧版与 research 的 check.mjs **只差 6 行** —— 验收是抄的，没有各自的判据。
//
//  这个场景的职责与调研根本不同：
//    调研      要「外面有什么」          → 核心判据是外部性
//    竞品拆解  要「我们能拿什么、代价多大」 → 核心判据是不拿 + 代价
//
//  最核心的两条：
//    C3「不拿 ≥1」    不做取舍的拆解（全是「拿」）= 没做判断
//    C4「代价有数字」  代价写「较复杂」= 写不出代价 = 不该批
//
// ──────────────────────────────────────────────────────────────────────
//  十项检查（C1-C10）
// ──────────────────────────────────────────────────────────────────────
//    C1  通用底线      非空 / 无占位 / ≥2 标题
//    C2  两张表齐全    对标差距 + 拿来决策
//    C3  不拿 ≥1 ★     必须有「不拿」的行，且写清为什么
//    C4  代价有数字 ★  每个「拿/改着拿」的代价列必须有数字 + 单位
//    C5  许可证白名单  GPL 族/无/商业 → 不许「拿」
//    C6  无代码搬运    带语言标记的代码块 > 5 行 或总数 > 2
//    C7  维度可判定    表头含「维度」「我们」；值只允许 1-5 / 有 / 无 / 部分
//    C8  竞品数量      1–3 家（拆 6 家 = 摊大饼）
//    C9  不比什么      必须有「本次不评估」小节且有内容
//    C10 落地可派单    每条「拿」必须指向一个真实存在的 workbench 文件
//
//  用法：
//    node check.mjs --selftest
//    node check.mjs --check <产物.md>
//    node check.mjs --json <产物.md>
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..', '..');   // workbench/
export const SCENE_NAME = '竞品拆解';

// ── 判据常量 ────────────────────────────────────────────────────────
export const LIMITS = {
  MIN_LENGTH: 50,
  MAX_COMPETITORS: 3,
  MAX_CODE_LINES: 5,
  MAX_CODE_BLOCKS: 2,
};

/** 许可证白名单 */
export const LICENSES = ['MIT', 'BSD-2', 'BSD-3', 'Apache-2.0', 'MPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'SSPL', '无', '商业'];

/** 不允许「拿」的许可证（GPL 族有传染性；无/商业不能抄） */
export const NO_TAKE_LICENSES = ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'SSPL', '无', '商业'];

/** 代价列必须出现的单位（须与数字同格） */
export const COST_UNITS = ['个文件', '行', '处', '天', '小时', '个概念', '个状态', '个开关', '个接口', '个依赖'];

/** 差距表允许的单元格取值 */
export const DIM_VALUES = /^(?:[1-5]|有|无|部分|—|-|N\/A)$/;

/**
 * 判一行「拿来决策」是否合格
 *
 * 这是本场景最核心的判据：**没有代价的「拿」是不该批的**。
 */
export function judgeDecisionRow(row) {
  const r = row || {};
  const problems = [];
  const action = String(r.action || '').trim();
  const cost = String(r.cost || '').trim();
  const license = String(r.license || '').trim();
  const target = String(r.target || '').trim();

  if (!action) return { ok: false, problems: ['动作列为空'] };

  const isTake = /^(拿|改着拿)/.test(action);
  const isDrop = /^不拿/.test(action);

  // ① 「拿」必须有代价数字 + 单位
  if (isTake) {
    if (!/\d/.test(cost)) {
      problems.push('「拿」的代价列没有数字：' + (cost || '(空)'));
    } else if (!COST_UNITS.some((u) => cost.includes(u))) {
      problems.push('「拿」的代价列没有单位（' + COST_UNITS.join('/') + '）：' + cost);
    }
  }

  // ② 「不拿」必须写为什么
  if (isDrop && !String(r.why || '').trim()) {
    problems.push('「不拿」没写为什么');
  }

  // ③ 许可证
  if (!LICENSES.includes(license)) {
    problems.push('许可证未判或不在白名单：' + (license || '(空)'));
  } else if (isTake && NO_TAKE_LICENSES.includes(license)) {
    problems.push('许可证 ' + license + ' 不许「拿」（传染性/不可抄）');
  }

  // ④ 落点必须真实存在
  if (isTake) {
    if (!target) {
      problems.push('「拿」没写落点路径');
    } else {
      const m = target.match(/(workbench[\/\\][^\s|`"'）)]+\.\w{2,4})/);
      if (!m) {
        problems.push('落点不是 workbench/ 下的文件路径：' + target.slice(0, 40));
      } else {
        const abs = path.join(path.dirname(PROJECT_ROOT), m[1].replace(/\\/g, '/'));
        if (!fs.existsSync(abs)) problems.push('落点文件不存在：' + m[1]);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/** 抽 Markdown 表格 */
export function parseTables(text) {
  const lines = String(text || '').split(/\r?\n/);
  const tables = [];
  let cur = null;
  for (const l of lines) {
    const isRow = /^\s*\|.*\|\s*$/.test(l);
    if (isRow) {
      const cells = l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (!cur) { cur = { headers: cells, rows: [] }; tables.push(cur); }
      else if (/^[\s:|-]+$/.test(l.replace(/\|/g, ''))) { /* 分隔行 */ }
      else cur.rows.push(cells);
    } else {
      cur = null;
    }
  }
  return tables;
}

/** 找某个标题下的第一张表 */
function tableUnder(text, headingRe) {
  const lines = String(text).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i]) && headingRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,4}\s/.test(lines[i])) { end = i; break; }
  }
  const ts = parseTables(lines.slice(start, end).join('\n'));
  return ts.length ? ts[0] : null;
}

/**
 * 主判定
 * @param {string} productText
 * @param {{root?:string}} [opts]
 */
export function check(productText, opts) {
  const o = opts || {};
  const problems = [];
  const passed = [];
  const t = String(productText || '');
  const ev = { length: t.length };

  // ══ C1 通用底线 ══
  if (t.trim().length < LIMITS.MIN_LENGTH) {
    problems.push('C1 产物过短（' + t.trim().length + ' 字符）');
  } else passed.push('C1 非空（' + t.length + ' 字符）');

  if (/（待补）|（待填）|\(TODO\)|TODO:/i.test(t)) {
    problems.push('C1 有未填的占位');
  } else passed.push('C1 无占位残留');

  const headings = (t.match(/^#{1,4}\s+\S/gm) || []).length;
  ev.headings = headings;
  if (headings < 2) problems.push('C1 结构太简单（' + headings + ' 个标题）');
  else passed.push('C1 有 ' + headings + ' 个标题分节');

  // ══ C2 两张表齐全 ══
  const gapTable = tableUnder(t, /对标差距|项目功能矩阵|功能矩阵/);
  const decTable = tableUnder(t, /拿来决策|拿什么|取舍/);
  ev.hasGapTable = !!gapTable;
  ev.hasDecisionTable = !!decTable;
  if (!gapTable) problems.push('C2 缺「对标差距 / 项目功能矩阵」表');
  if (!decTable) problems.push('C2 缺「拿来决策」表');
  if (gapTable && decTable) passed.push('C2 两张表齐全');

  // ══ C3 / C4 / C5 / C10：逐行判拿来决策 ══
  if (decTable) {
    const H = decTable.headers;
    const idx = (name) => H.findIndex((h) => h.includes(name));
    const iAction = idx('动作');
    const iWhy = idx('为什么');
    const iCost = idx('代价');
    const iLic = idx('许可证');
    const iTarget = idx('落点');

    ev.decisionRows = decTable.rows.length;

    if (iAction < 0) {
      problems.push('C2 决策表缺「动作」列');
    } else {
      let take = 0, drop = 0, badRows = 0, costBad = 0;
      for (let r = 0; r < decTable.rows.length; r++) {
        const cells = decTable.rows[r];
        const row = {
          action: cells[iAction] || '',
          why: iWhy >= 0 ? (cells[iWhy] || '') : '',
          cost: iCost >= 0 ? (cells[iCost] || '') : '',
          license: iLic >= 0 ? (cells[iLic] || '') : '',
          target: iTarget >= 0 ? (cells[iTarget] || '') : '',
        };
        if (/^(拿|改着拿)/.test(row.action.trim())) take++;
        if (/^不拿/.test(row.action.trim())) drop++;

        const j = judgeDecisionRow(row);
        if (!j.ok) {
          badRows++;
          if (j.problems.some((p) => p.includes('代价列'))) costBad++;
          for (const p of j.problems) problems.push('第 ' + (r + 1) + ' 行：' + p);
        }
      }

      // C3：不拿 ≥ 1
      if (drop < 1) problems.push('C3 没有任何「不拿」行 —— 没做取舍，不该批');
      else passed.push('C3 有 ' + drop + ' 条「不拿」（做了取舍）');

      // C4 汇总
      if (take > 0 && costBad === 0) {
        passed.push('C4 ' + take + ' 条「拿」的代价都有数字 + 单位');
      }

      if (badRows === 0) passed.push('C5/C10 许可证与落点全部合规');
    }
  }

  // ══ C6 无代码搬运 ══
  {
    const fences = [...t.matchAll(/```(\w*)\r?\n([\s\S]*?)```/g)];
    const LANGS = ['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'sh', 'bash'];
    let langBlocks = 0, tooLong = 0;
    for (const f of fences) {
      const lang = (f[1] || '').toLowerCase();
      if (!LANGS.includes(lang)) continue;
      langBlocks++;
      const n = f[2].split(/\r?\n/).filter((x) => x.trim()).length;
      if (n > LIMITS.MAX_CODE_LINES) tooLong++;
    }
    ev.langBlocks = langBlocks;
    if (tooLong) problems.push('C6 有 ' + tooLong + ' 个代码块超过 ' + LIMITS.MAX_CODE_LINES + ' 行（不许搬运实现）');
    if (langBlocks > LIMITS.MAX_CODE_BLOCKS) problems.push('C6 带语言标记的代码块 ' + langBlocks + ' 个 > ' + LIMITS.MAX_CODE_BLOCKS);
    if (!tooLong && langBlocks <= LIMITS.MAX_CODE_BLOCKS) passed.push('C6 无代码搬运（' + langBlocks + ' 个小代码块）');
  }

  // ══ C7 维度可判定 / C8 竞品数量 ══
  if (gapTable) {
    const H = gapTable.headers;
    const hasDim = H.some((h) => h.includes('维度'));
    const hasUs = H.some((h) => h.includes('我们'));
    if (!hasDim) problems.push('C7 差距表缺「维度」列');
    if (!hasUs) problems.push('C7 差距表缺「我们」列');

    const iDim = H.findIndex((h) => h.includes('维度'));
    let badCell = 0;
    for (let r = 0; r < gapTable.rows.length; r++) {
      const cells = gapTable.rows[r];
      for (let c = 0; c < cells.length; c++) {
        if (c === iDim) continue;
        if (H[c] && /证据|差距方向|来源|备注/.test(H[c])) continue;
        const v = String(cells[c] || '').trim();
        if (!v) continue;
        if (!DIM_VALUES.test(v)) {
          badCell++;
          if (badCell <= 2) {
            problems.push('C7 差距表第 ' + (r + 1) + ' 行「' + H[c] + '」的值不可判定：' + v.slice(0, 20));
          }
        }
      }
    }
    if (badCell) problems.push('C7 共 ' + badCell + ' 个不可判定的单元格');

    const compCols = H.filter((h) => h && !/维度|我们|差距方向|证据|来源|备注/.test(h));
    ev.competitors = compCols.length;
    if (compCols.length > LIMITS.MAX_COMPETITORS) {
      problems.push('C8 竞品 ' + compCols.length + ' 家 > ' + LIMITS.MAX_COMPETITORS + '（摊大饼）');
    }
    if (compCols.length < 1) problems.push('C8 差距表里没有竞品列');

    if (hasDim && hasUs && !badCell) passed.push('C7 维度都可判定');
    if (compCols.length >= 1 && compCols.length <= LIMITS.MAX_COMPETITORS) {
      passed.push('C8 竞品 ' + compCols.length + ' 家');
    }
  }

  // ══ C9 不比什么 ══
  {
    const m = t.match(/^#{1,4}\s*.*(本次不评估|不比什么|不在范围)/m);
    if (!m) {
      problems.push('C9 缺「本次不评估 / 不比什么」小节 —— 没说清边界');
    } else {
      const i = t.indexOf(m[0]);
      const after = t.slice(i + m[0].length, i + m[0].length + 300);
      if (!/\S/.test(after.replace(/^[#\s|-]*/, ''))) problems.push('C9「不比什么」小节是空的');
      else passed.push('C9 写清了不评估的范围');
    }
  }

  return { ok: problems.length === 0, problems, passed, evidence: ev };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(68));
  console.log('  竞品拆解（拿来主义）· check 自测');
  console.log('═'.repeat(68));
  console.log();

  const GOOD = `# 竞品拆解 · 拿来主义 2026-11-14

## 一、对标差距

| 维度 | 我们 | hermes | cursor | 差距方向 | 证据 |
|---|---|---|---|---|---|
| 技能按需加载 | 无 | 5 | 4 | 落后 | 官方文档 |
| 命令面板 | 部分 | 5 | 5 | 落后 | 截图 |
| 本地数据隔离 | 5 | 3 | 2 | 领先 | — |

## 二、拿来决策

| 动作 | 拿什么 | 为什么 | 代价 | 许可证 | 落点 |
|---|---|---|---|---|---|
| 拿 | 三级技能加载 | 上下文成本直降 | 改 2 个文件 约 120 行 | MIT | workbench/工具/机制体检.mjs |
| 改着拿 | 命令面板模糊搜索 | 比现有匹配准 | 新增 1 个状态 约 60 行 | MIT | workbench/外壳/ui/core/commands.js |
| 不拿 | curator 后台归并 | 实现细节未公开，抄不了机制 | — | MIT | — |

## 三、本次不评估

- 多平台网关（Telegram/Discord）：与桌面端定位无关
- 语音交互：当前版本不做
`;

  console.log('【一】合格样本必须通过');
  {
    const r = check(GOOD);
    chk('完整拆解决策 → 通过', r.ok === true, r.problems.join(' | ') || 'ok');
    chk('识别出 3 行决策', r.evidence.decisionRows === 3, String(r.evidence.decisionRows));
    chk('识别出 2 家竞品', r.evidence.competitors === 2, String(r.evidence.competitors));
  }

  console.log();
  console.log('【二】★C3：不拿 ≥ 1（没做取舍 = 没做判断）');
  {
    const allTake = GOOD.replace('| 不拿 | curator 后台归并 | 实现细节未公开，抄不了机制 | — | MIT | — |', '');
    const r = check(allTake);
    chk('反例：全是「拿」→ 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('C3')) || '').slice(0, 50));

    const noWhy = GOOD.replace('| 不拿 | curator 后台归并 | 实现细节未公开，抄不了机制 | — | MIT | — |',
      '| 不拿 | curator 后台归并 |  | — | MIT | — |');
    const r2 = check(noWhy);
    chk('反例：「不拿」不写为什么 → 必须失败', r2.ok === false,
      (r2.problems.find((p) => p.includes('没写为什么')) || r2.problems[0] || '').slice(0, 50));
  }

  console.log();
  console.log('【三】★C4：代价必须有数字+单位');
  {
    const vague = GOOD.replace('改 2 个文件 约 120 行', '较复杂');
    const r = check(vague);
    chk('反例：代价写「较复杂」→ 必须失败', r.ok === false,
      (r.problems.find((p) => p.includes('代价列')) || '').slice(0, 55));

    const noUnit = GOOD.replace('改 2 个文件 约 120 行', '改 2');
    const r2 = check(noUnit);
    chk('反例：代价只有数字没单位 → 必须失败', r2.ok === false,
      (r2.problems.find((p) => p.includes('单位')) || '').slice(0, 55));

    chk('对照：合法代价通过', judgeDecisionRow({
      action: '拿', cost: '改 2 个文件 约 120 行', license: 'MIT',
      target: 'workbench/工具/机制体检.mjs',
    }).ok === true);
  }

  console.log();
  console.log('【四】C5 许可证：GPL 族不许「拿」');
  {
    const gpl = GOOD.replace('| 拿 | 三级技能加载 | 上下文成本直降 | 改 2 个文件 约 120 行 | MIT |',
      '| 拿 | 三级技能加载 | 上下文成本直降 | 改 2 个文件 约 120 行 | GPL-3.0 |');
    const r = check(gpl);
    chk('反例：GPL-3.0 却「拿」→ 必须失败', r.ok === false,
      (r.problems.find((p) => p.includes('GPL')) || '').slice(0, 55));

    const unknown = GOOD.replace('| MIT | workbench/工具/机制体检.mjs |', '| 未知自定义 | workbench/工具/机制体检.mjs |');
    const r2 = check(unknown);
    chk('反例：许可证没判 → 必须失败', r2.ok === false,
      (r2.problems.find((p) => p.includes('许可证')) || '').slice(0, 55));
  }

  console.log();
  console.log('【五】C6 无代码搬运');
  {
    const code = GOOD + '\n```js\n' + 'function a(){}\n'.repeat(10) + '```\n';
    const r = check(code);
    chk('反例：贴 10 行代码 → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('C6')) || '').slice(0, 55));
  }

  console.log();
  console.log('【六】C7 维度可判定 / C8 竞品数量');
  {
    const vagueDim = GOOD.replace('| 技能按需加载 | 无 | 5 | 4 | 落后 | 官方文档 |',
      '| 体验好不好 | 一般 | 挺好 | 还行 | 落后 | — |');
    const r = check(vagueDim);
    chk('反例：维度写「体验好不好」值写「一般」→ 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('C7')) || '').slice(0, 55));

    const many = GOOD.replace('| 维度 | 我们 | hermes | cursor | 差距方向 | 证据 |',
      '| 维度 | 我们 | hermes | cursor | windsurf | codex | claude | 差距方向 | 证据 |')
      .replace('| 技能按需加载 | 无 | 5 | 4 | 落后 | 官方文档 |',
        '| 技能按需加载 | 无 | 5 | 4 | 3 | 2 | 1 | 落后 | 官方文档 |');
    const r2 = check(many);
    chk('反例：拆 5 家 → 必须失败（摊大饼）', r2.ok === false,
      (r2.problems.find((p) => p.startsWith('C8')) || '').slice(0, 55));
  }

  console.log();
  console.log('【七】C9 不比什么 / C10 落点必须存在');
  {
    const noScope = GOOD.replace(/## 三、本次不评估[\s\S]*$/, '');
    const r = check(noScope);
    chk('反例：没写「不评估」范围 → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('C9')) || '').slice(0, 50));

    const badTarget = GOOD.replace('workbench/工具/机制体检.mjs', 'workbench/不存在的目录/假文件.mjs');
    const r2 = check(badTarget);
    chk('反例：落点文件不存在 → 必须失败', r2.ok === false,
      (r2.problems.find((p) => p.includes('不存在')) || '').slice(0, 55));
  }

  console.log();
  console.log('【八】关键：这个 check 必须会失败');
  {
    const bads = [
      GOOD.replace('| 不拿 | curator 后台归并 | 实现细节未公开，抄不了机制 | — | MIT | — |', ''),
      GOOD.replace('改 2 个文件 约 120 行', '较复杂'),
      '',
      '完全不符合格式的一段话'.repeat(5),
    ];
    const failed = bads.filter((b) => !check(b).ok).length;
    chk('4 个坏样本全部被判失败', failed === 4, failed + ' / 4');
  }

  console.log();
  console.log('─'.repeat(68));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(68));
  return passed === R.length;
}

// ══════════════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.log('用法: node check.mjs --selftest | --check <产物.md> | --json <产物.md>');
    process.exit(2);
  }
  if (!fs.existsSync(file)) { console.log('文件不存在: ' + file); process.exit(2); }
  const r = check(fs.readFileSync(file, 'utf8'));
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ scene: SCENE_NAME, ...r }, null, 2));
  } else {
    console.log('═'.repeat(68));
    console.log('  ' + SCENE_NAME + ' · 产物验收');
    console.log('═'.repeat(68));
    console.log('  ' + (r.ok ? '✓ 合格' : '✗ 不合格'));
    if (r.problems.length) { console.log(); for (const p of r.problems) console.log('  ⛔ ' + p); }
    if (r.passed.length) { console.log(); for (const p of r.passed) console.log('  ✓ ' + p); }
  }
  process.exit(r.ok ? 0 : 1);
}
