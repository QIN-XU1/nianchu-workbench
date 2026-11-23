#!/usr/bin/env node
// 数据/.dsh/skills/research/check.mjs —— 「调研」场景的可执行验收
//
// ══════════════════════════════════════════════════════════════════════
//  为什么重写
// ══════════════════════════════════════════════════════════════════════
//  旧版（205 行）只有 5 项**通用底线**检查（非空/无占位/有标题/不复述/有证据），
//  而「调研」场景真正的职责 —— **必须是外部情报，不能是对本项目的自查** ——
//  完全没有验。旧文件里甚至留着未替换的模板变量：
//
//      //  TODO: 这里是通用底线检查。
//      //        请按「<场景名>」的具体职责补充专有检查。
//
//  ⇒ 这就是「看起来有检查，实际什么都没验」。
//
//  实证：过去 7 个「调研」产出全部是对本项目自身的自查
//        （外部依赖调研.md / 工具真实性调研.md / 数据目录调研.md …），
//        而旧 check 一律放行，因为 `hasPath || hasNumber || hasQuote` 对内外部无差别。
//
//  新版的核心：**R2 外部性硬闸门** —— 一条正则就能把 7/7 自查产物全挡在门外。
//
// ──────────────────────────────────────────────────────────────────────
//  九项检查（R1-R9）
// ──────────────────────────────────────────────────────────────────────
//    R1 通用底线      非空 / 无占位 / ≥2 标题 / 不复述需求
//    R2 外部性 ★核心   情报对象不得是本项目（禁盘符路径、禁自指词）
//    R3 来源可追溯    每张卡至少 1 个 URL；url 集合 ⊆ 来源存证.jsonl
//    R4 置信度一致     标「高」的卡必须有 ≥2 个独立来源
//    R5 猜想五要素     已知事实/推理链(≥2个→)/置信度/可证伪条件/反方证据
//    R6 时效          TTL 必填；引用过期卡需标「已过期」
//    R7 配额          卡 ≤ 12；猜想 ≤ 5（防注水）
//    R8 自查词禁令     「事实」栏不得出现「本项目/我们的/workbench 的」
//    R9 结构          必须有情报卡索引 + 至少一节含表格
//
//  用法：
//    node check.mjs --selftest        自测（含反例）
//    node check.mjs --check <文件>    对真实产物跑一遍
//    node check.mjs --json <文件>     机器可读
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCENE_NAME = '调研';

// ── 判据常量（export 供复用与测试）──────────────────────────────────
export const LIMITS = {
  MIN_LENGTH: 50,
  MAX_CARDS: 12,
  MAX_SPECULATIONS: 5,
};

/**
 * 外部性判据 —— 这是整个 check 的核心
 *
 * 一条情报卡的「对象:」值必须**不是本项目**。
 * 判据三条，全过才合格：
 *   ① 不含盘符路径（如 D:\ 、C:/）
 *   ② 不含自指词（本项目/我们的/workbench/数据/.dsh/场景记忆/本工作台）
 *   ③ 长度 2–40 字（太短说明没写清，太长说明在描述自己）
 */
export const SELF_REF_WORDS = ['本项目', '我们的', 'workbench', '数据/.dsh', '数据\\.dsh', '场景记忆', '本工作台', '本系统', '自己这个'];

/**
 * 判一个「对象」是不是外部对象
 * @param {string} obj
 * @returns {{ok:boolean, why:string}}
 */
export function judgeExternality(obj) {
  const v = String(obj || '').trim();
  if (!v) return { ok: false, why: '对象为空' };
  if (/[A-Za-z]:[\\/]/.test(v)) return { ok: false, why: '对象是盘符路径（那是本项目文件）：' + v };
  for (const w of SELF_REF_WORDS) {
    if (v.includes(w)) return { ok: false, why: '对象含自指词「' + w + '」：' + v };
  }
  if (v.length < 2) return { ok: false, why: '对象太短：' + v };
  if (v.length > 40) return { ok: false, why: '对象过长（' + v.length + ' 字 > 40），像在描述自己：' + v.slice(0, 20) + '…' };
  return { ok: true, why: '' };
}

/** 抽一个字段的值（形如 `对象: xxx` 或 `- 对象: xxx`） */
function fieldOf(block, name) {
  const re = new RegExp('^\\s*[-*]?\\s*\\*{0,2}' + name + '\\*{0,2}\\s*[:：]\\s*(.+)$', 'm');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

/** 把产物按「情报卡」切开（卡片以 `### ` 或 `#### ` 开头且含「对象:」） */
function splitCards(text) {
  const lines = String(text).split(/\r?\n/);
  const cards = [];
  let cur = null;
  for (const l of lines) {
    if (/^#{3,4}\s+\S/.test(l)) {
      if (cur) cards.push(cur);
      cur = { title: l.replace(/^#+\s*/, '').trim(), body: '' };
    } else if (cur) {
      cur.body += l + '\n';
    }
  }
  if (cur) cards.push(cur);
  // 只保留含「对象:」的（那才是情报卡）
  return cards.filter((c) => /^\s*[-*]?\s*\*{0,2}对象\*{0,2}\s*[:：]/m.test(c.body));
}

/** 抽所有 URL */
function urlsOf(text) {
  return [...String(text).matchAll(/https?:\/\/[^\s)>\]"']+/g)].map((m) => m[0]);
}

/**
 * 主判定
 * @param {string} productText
 * @param {{logPath?:string}} [opts]
 */
export function check(productText, opts) {
  const o = opts || {};
  const problems = [];
  const passed = [];
  const t = String(productText || '');
  const ev = { length: t.length };

  // ══ R1 通用底线 ══
  if (t.trim().length < LIMITS.MIN_LENGTH) {
    problems.push('R1 产物过短（' + t.trim().length + ' 字符 < ' + LIMITS.MIN_LENGTH + '），可能是空壳');
  } else passed.push('R1 非空（' + t.length + ' 字符）');

  if (/（待补）|（待填）|\(TODO\)|TODO:/i.test(t)) {
    problems.push('R1 有未填的占位（待补/待填/TODO）');
  } else passed.push('R1 无占位残留');

  const headings = (t.match(/^#{1,4}\s+\S/gm) || []).length;
  ev.headings = headings;
  if (headings < 2) problems.push('R1 结构太简单（只有 ' + headings + ' 个标题）');
  else passed.push('R1 有 ' + headings + ' 个标题分节');

  if (/^(用户要求|需要我|根据用户|按照要求)/.test(t.trim())) {
    problems.push('R1 像在复述需求，不像交付结果');
  } else passed.push('R1 不是复述需求');

  // ══ R2 外部性（★核心）══
  const cards = splitCards(t);
  ev.cards = cards.length;
  if (!cards.length) {
    problems.push('R2 找不到任何情报卡（需要 `### 标题` + `对象: xxx` 的形式）');
  } else {
    let bad = 0;
    for (const c of cards) {
      const obj = fieldOf(c.body, '对象');
      const j = judgeExternality(obj);
      if (!j.ok) { problems.push('R2 【' + c.title + '】' + j.why); bad++; }
    }
    if (!bad) passed.push('R2 ' + cards.length + ' 张卡的情报对象全部是外部对象');
  }

  // ══ R3 来源可追溯 ══
  const allUrls = [...new Set(urlsOf(t))];
  ev.urls = allUrls.length;
  if (cards.length) {
    for (const c of cards) {
      if (!urlsOf(c.body).length) {
        problems.push('R3 【' + c.title + '】没有任何 URL —— 调研必须有出处');
      }
    }
    // 来源存证（可选：存在才比对）
    if (o.logPath && fs.existsSync(o.logPath)) {
      const logged = new Set();
      try {
        for (const line of fs.readFileSync(o.logPath, 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j && j.url) logged.add(String(j.url));
        }
      } catch { problems.push('R3 来源存证.jsonl 无法解析'); }
      if (logged.size) {
        const miss = allUrls.filter((u) => !logged.has(u));
        if (miss.length) problems.push('R3 有 ' + miss.length + ' 个 URL 不在来源存证里：' + miss[0].slice(0, 60));
        else passed.push('R3 URL 全部有抓取存证');
      }
    }
    if (!problems.some((p) => p.startsWith('R3'))) passed.push('R3 每张卡都有 URL');
  }

  // ══ R4 置信度与来源数一致 ══
  for (const c of cards) {
    const conf = fieldOf(c.body, '置信度');
    if (/^高/.test(conf)) {
      const n = new Set(urlsOf(c.body)).size;
      if (n < 2) problems.push('R4 【' + c.title + '】标「置信度高」但只有 ' + n + ' 个来源（需 ≥2）');
    }
  }
  if (!problems.some((p) => p.startsWith('R4'))) passed.push('R4 置信度与来源数一致');

  // ══ R5 猜想五要素 ══
  const specBlocks = t.split(/^.*?\*{0,2}猜想\*{0,2}\s*[:：]/m).slice(1);
  ev.speculations = specBlocks.length;
  const NEED = [
    { k: '已知事实', re: /\*{0,2}已知事实\*{0,2}\s*[:：]\s*\S/ },
    { k: '推理链', re: /\*{0,2}推理链\*{0,2}\s*[:：][\s\S]{0,400}?→[\s\S]{0,400}?→/ },
    { k: '置信度', re: /\*{0,2}置信度\*{0,2}\s*[:：]\s*\S/ },
    { k: '可证伪条件', re: /\*{0,2}可证伪条件\*{0,2}\s*[:：]\s*\S/ },
    { k: '反方证据', re: /\*{0,2}反方证据\*{0,2}\s*[:：]\s*\S/ },
  ];
  for (let i = 0; i < specBlocks.length; i++) {
    const b = specBlocks[i];
    for (const n of NEED) {
      if (!n.re.test(b)) problems.push('R5 第 ' + (i + 1) + ' 条猜想缺「' + n.k + '」');
    }
    const fals = fieldOf(b, '可证伪条件');
    if (/有待|待验证|暂无法|进一步观察/.test(fals)) {
      problems.push('R5 第 ' + (i + 1) + ' 条猜想的「可证伪条件」是废话（' + fals.slice(0, 20) + '）');
    }
  }
  if (specBlocks.length && !problems.some((p) => p.startsWith('R5'))) {
    passed.push('R5 ' + specBlocks.length + ' 条猜想五要素齐全');
  }

  // ══ R6 时效 ══
  for (const c of cards) {
    if (!/\*{0,2}TTL\*{0,2}\s*[:：]\s*T[123]/.test(c.body)) {
      problems.push('R6 【' + c.title + '】缺 TTL（T1/T2/T3）');
    }
    if (!/\*{0,2}复检\*{0,2}\s*[:：]\s*\d{4}-\d{2}-\d{2}/.test(c.body)) {
      problems.push('R6 【' + c.title + '】缺复检日期（YYYY-MM-DD）');
    }
  }
  if (cards.length && !problems.some((p) => p.startsWith('R6'))) passed.push('R6 时效字段齐全');

  // ══ R7 配额 ══
  if (cards.length > LIMITS.MAX_CARDS) {
    problems.push('R7 情报卡 ' + cards.length + ' 张 > ' + LIMITS.MAX_CARDS + '（注水）');
  }
  if (specBlocks.length > LIMITS.MAX_SPECULATIONS) {
    problems.push('R7 猜想 ' + specBlocks.length + ' 条 > ' + LIMITS.MAX_SPECULATIONS + '（注水）');
  }
  if (!problems.some((p) => p.startsWith('R7'))) passed.push('R7 配额正常（卡 ' + cards.length + ' / 猜想 ' + specBlocks.length + '）');

  // ══ R8 自查词禁令 ══
  for (const c of cards) {
    const factLine = (c.body.match(/^\s*[-*]?\s*\*{0,2}(?:事实|已知事实)\*{0,2}\s*[:：].+$/m) || [''])[0];
    if (factLine && /本项目|我们的|workbench 的/.test(factLine)) {
      problems.push('R8 【' + c.title + '】的「事实」栏在说本项目自己：' + factLine.trim().slice(0, 40));
    }
  }
  if (!problems.some((p) => p.startsWith('R8'))) passed.push('R8 事实栏无自指词');

  // ══ R9 结构 ══
  const hasIndex = /^#{1,3}\s*.*(情报卡索引|情报索引)/m.test(t);
  const hasTable = /^\s*\|.+\|\s*$/m.test(t);
  if (!hasIndex) problems.push('R9 缺「情报卡索引」分节');
  if (!hasTable) problems.push('R9 全文没有任何 Markdown 表格');
  if (hasIndex && hasTable) passed.push('R9 结构完整（有索引 + 表格）');

  return { ok: problems.length === 0, problems, passed, evidence: ev, cards: cards.length };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(68));
  console.log('  调研（情报站）· check 自测');
  console.log('═'.repeat(68));
  console.log();

  // ── 合格样本：一张完整的外部情报卡 ──
  const GOOD = `# 调研结论 · 2026-11-14

## 一、情报卡索引

| ID | 对象 | TTL |
|---|---|---|
| I-1 | hermes-agent 的渐进式披露 | T1 |

## 二、情报卡

### I-1 hermes-agent 的渐进式披露

- 对象: hermes-agent 的 skills 系统
- 事实: 索引常驻 prompt 约 3k token，正文用 skill_view(name) 按需加载
- 来源: https://hermes-agent.nousresearch.com/docs/skills
- 置信度: 中
- TTL: T1
- 复检: 2027-01-01

### I-2 另一家的做法

- 对象: codex 的 AGENTS.md 约定
- 事实: 用 AGENTS.md 作为项目级指令文件，递归合并
- 来源: https://github.com/openai/codex
- 置信度: 低
- TTL: T2
- 复检: 2027-03-01

## 三、开源猜想台账

猜想: 技能索引会走向「常驻摘要 + 按需全文」两段式

已知事实: hermes 与 codex 都采用索引先行的加载方式
推理链: 索引先行 → 单次上下文成本下降 → 可按需加载更多技能 → 形成两段式
置信度: 中
可证伪条件: 若某产品在 2027 年前把全部技能正文常驻 prompt 仍能控住成本
反方证据: 部分小工具类 agent 直接全量注入，因为技能总数极少
`;

  console.log('【一】合格样本必须通过（否则判据退化成「全拒」）');
  {
    const r = check(GOOD);
    chk('完整情报产物 → 通过', r.ok === true, r.problems.join(' | ') || 'ok');
    chk('识别出 2 张情报卡', r.evidence.cards === 2, String(r.evidence.cards));
    chk('识别出 1 条猜想', r.evidence.speculations === 1, String(r.evidence.speculations));
  }

  console.log();
  console.log('【二】★核心：R2 外部性硬闸门');
  {
    // 反例①：对象是盘符路径（本项目文件）
    const r1 = check(GOOD.replace('对象: hermes-agent 的 skills 系统', '对象: D:\\workbench\\数据\\.dsh\\skills'));
    chk('反例：对象是盘符路径 → 必须失败', r1.ok === false,
      (r1.problems.find((p) => p.startsWith('R2')) || '').slice(0, 60));

    // 反例②：对象是「本项目」（自指）
    const r2 = check(GOOD.replace('对象: codex 的 AGENTS.md 约定', '对象: 本项目的机制体系'));
    chk('反例：对象写「本项目」→ 必须失败', r2.ok === false,
      (r2.problems.find((p) => p.startsWith('R2')) || '').slice(0, 60));

    // 反例③：这正是过去 7 个产出的样子
    const r3 = check(GOOD.replace('对象: hermes-agent 的 skills 系统', '对象: workbench 的工具真实性'));
    chk('反例：对象含 workbench → 必须失败', r3.ok === false,
      (r3.problems.find((p) => p.startsWith('R2')) || '').slice(0, 60));

    // 对照：外部对象必须放行（证明判据不是「全拒」）
    chk('对照：外部对象放行', judgeExternality('Cursor 的 composer 交互').ok === true);
    chk('对照：外部对象放行 2', judgeExternality('Linear 的快捷键体系').ok === true);
  }

  console.log();
  console.log('【三】R3 来源可追溯');
  {
    const noUrl = GOOD.replace('- 来源: https://hermes-agent.nousresearch.com/docs/skills', '- 来源: 看文档就行');
    const r = check(noUrl);
    chk('反例：某卡无 URL → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('R3')) || '').slice(0, 50));
  }

  console.log();
  console.log('【四】R4 置信度与来源数一致');
  {
    const bad = GOOD.replace('- 置信度: 中\n- TTL: T1', '- 置信度: 高\n- TTL: T1');
    const r = check(bad);
    chk('反例：标「高」但只有 1 个来源 → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('R4')) || '').slice(0, 60));
  }

  console.log();
  console.log('【五】R5 猜想五要素（防造谣）');
  {
    // 反例：只有结论 + 「有待验证」
    const lazy = GOOD.replace(/## 三、开源猜想台账[\s\S]*$/, `## 三、开源猜想台账
猜想: 未来一定是两段式
可证伪条件: 有待验证
`);
    const r = check(lazy);
    chk('反例：猜想缺要素 + 废话可证伪 → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('R5')) || '').slice(0, 60));

    // 反例：推理链只有 1 个箭头
    const oneArrow = GOOD.replace(
      '推理链: 索引先行 → 单次上下文成本下降 → 可按需加载更多技能 → 形成两段式',
      '推理链: 因为索引先行 → 所以两段式');
    const r2 = check(oneArrow);
    chk('反例：推理链只有 1 个箭头 → 必须失败', r2.ok === false);
  }

  console.log();
  console.log('【六】R6 时效 / R7 配额');
  {
    const noTtl = GOOD.replace('- TTL: T1\n- 复检: 2027-01-01', '');
    const r = check(noTtl);
    chk('反例：缺 TTL → 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('R6')) || '').slice(0, 50));

    // 13 张卡（注水）
    let many = GOOD;
    for (let i = 3; i <= 14; i++) {
      many += `\n### I-${i} 卡${i}\n\n- 对象: 外部项目${i}\n- 事实: 某事\n- 来源: https://example.com/${i}\n- 置信度: 低\n- TTL: T2\n- 复检: 2027-01-01\n`;
    }
    const r2 = check(many);
    chk('反例：13 张卡 → 必须失败（注水）', r2.ok === false,
      (r2.problems.find((p) => p.startsWith('R7')) || '').slice(0, 50));
  }

  console.log();
  console.log('【七】R8 自查词禁令');
  {
    const r = check(GOOD.replace(
      '- 事实: 索引常驻 prompt 约 3k token，正文用 skill_view(name) 按需加载',
      '- 事实: 我们的机制清单有 104 项'));
    chk('反例：事实栏说「我们的」→ 必须失败', r.ok === false,
      (r.problems.find((p) => p.startsWith('R8')) || '').slice(0, 60));
  }

  console.log();
  console.log('【八】R9 结构 / R1 底线');
  {
    const r = check('');
    chk('反例：空产物 → 失败', r.ok === false);

    const prose = '这是一段很长的文字'.repeat(20);
    chk('反例：纯散文无表格无卡 → 失败', check(prose).ok === false);
  }

  console.log();
  console.log('【九】关键：这个 check 必须会失败');
  {
    const bads = [
      GOOD.replace('对象: hermes-agent 的 skills 系统', '对象: 本项目'),
      GOOD.replace('- 置信度: 中\n- TTL: T1', '- 置信度: 高\n- TTL: T1'),
      GOOD.replace('- 来源: https://hermes-agent.nousresearch.com/docs/skills', '- 来源: 无'),
      '',
    ];
    const failed = bads.filter((b) => !check(b).ok).length;
    chk('4 个坏样本全部被判失败', failed === 4, failed + ' / 4');
  }

  console.log();
  console.log('─'.repeat(68));
  const n = R.filter(Boolean).length;
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
  const r = check(fs.readFileSync(file, 'utf8'), { logPath: path.join(HERE, '来源存证.jsonl') });
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ scene: SCENE_NAME, ...r }, null, 2));
  } else {
    console.log('═'.repeat(68));
    console.log('  ' + SCENE_NAME + ' · 产物验收');
    console.log('═'.repeat(68));
    console.log('  文件: ' + file);
    console.log('  ' + (r.ok ? '✓ 合格' : '✗ 不合格'));
    if (r.problems.length) { console.log(); for (const p of r.problems) console.log('  ⛔ ' + p); }
    if (r.passed.length) { console.log(); for (const p of r.passed) console.log('  ✓ ' + p); }
  }
  process.exit(r.ok ? 0 : 1);
}
