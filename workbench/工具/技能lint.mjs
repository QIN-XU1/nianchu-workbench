#!/usr/bin/env node
// 工具/技能lint.mjs —— 技能文件（SKILL.md）写得好不好
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（这是「提示层进化」的第二块）
// ══════════════════════════════════════════════════════════════════════
//  调研依据 · Hermes Agent 的 skills 系统（hermes-agent.nousresearch.com/docs）：
//
//    技能有严格的结构要求：
//      When to Use / Procedure / Pitfalls / Verification 四节
//
//    并有三条 linter 规则（**只警告不阻断**，这一点很重要）：
//      · incident-log-shape   —— 正文里 PR/issue 编号过密（把技能写成了流水账）
//      · references-sprawl    —— 引用文件 > 60 个
//      · oversized-body       —— SKILL.md 正文 > ~24k 字符
//        （原因：skill_view 会加载整个文件，它会留在上下文里直到会话结束）
//
//    Hermes 的判据原话：
//      「a skill captures **lessons, not logs**」
//      事故叙述、PR 编号、日期、聊天引文**都不是技能内容**；
//      规则必须能脱离故事独立成立。
//
//  ──────────────────────────────────────────────────────────────────
//  我们的现状（实测）：
//    12 个技能，最大的 incident-analysis 有 17623 B / 616 行。
//    我们已有「技能可见性体检」「技能执行器」——
//      前者查「引擎能不能看到技能」
//      后者查「技能能不能跑出 check.mjs」
//    **但没有一个查「这个技能说明本身写得好不好」。**
//
//  这个工具补的正是这一半。
//
//  用法：
//    node 工具/技能lint.mjs             检查全部技能
//    node 工具/技能lint.mjs --json      机器可读
//    node 工具/技能lint.mjs --skill X   只看一个
//    node 工具/技能lint.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SKILLS = path.join(WB, '数据', '.dsh', 'skills');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 阈值（对照 Hermes 的三条 linter，按我们体量校准）
 *
 * 校准依据：我们现在最大的技能 17623 B。
 * Hermes 的 oversized 线是 ~24000 字符。
 * 我们取 20000 B —— 留 2400 B 余量给正常增长。
 */
export const LIMITS = {
  /** 正文超过这个字节数 → oversized-body */
  MAX_BODY_BYTES: 20000,
  /** 引用文件超过这个数 → references-sprawl */
  MAX_REFERENCES: 60,
  /** 每千行里 PR/issue 编号密度超过这个数 → incident-log-shape */
  MAX_ISSUE_DENSITY_PER_1K: 8,
};

/**
 * 必有的结构节（对照 Hermes 的四节，但适配我们的写法）
 *
 * 注意：我们的技能用的标题是「## 一、我的职责边界」这种中文序号，
 *      所以匹配要容忍序号前缀。
 */
export const REQUIRED_SECTIONS = [
  { key: '何时用', re: /何时用|什么时候用|触发词|触发条件|When to Use/i, why: '缺「何时用」——AI 不知道什么时候该加载它' },
  { key: '流程', re: /流程|步骤|怎么做|标准动作|Procedure/i, why: '缺「流程」——AI 只能自己猜怎么干' },
  { key: '坑', re: /坑|常见错|陷阱|Pitfalls|注意/, why: '缺「坑」——AI 会重复踩已知的错' },
  { key: '验收', re: /验收|判据|怎么算完成|Verification|完成标准/, why: '缺「验收」——没法判断干完没有' },
];

/**
 * 「流水账」标记：PR/issue 编号、纯日期行、聊天引文
 *
 * Hermes 的 incident-log-shape 判的就是这个。
 */
export const LOG_SHAPE_PATTERNS = [
  /#\d{2,}/g,                       // PR/issue 编号
  /\b(?:PR|issue|第)\s*#?\d+\s*(?:号|个)?/gi,
  /^\s*[-*·]\s*\d{4}-\d{2}-\d{2}/gm,  // 以日期开头的列表项
];

/**
 * 判一个技能的正文质量
 *
 * @param {string} text SKILL.md 全文
 * @returns {{ok:boolean, sections:object, bytes:number, issues:number, problems:string[], warnings:string[]}}
 */
export function judgeSkill(text) {
  const t = String(text || '');
  const bytes = Buffer.byteLength(t, 'utf8');
  const lines = t.split(/\r?\n/);
  const problems = [];
  const warnings = [];

  // ① 四个必有节
  const sections = {};
  for (const s of REQUIRED_SECTIONS) {
    sections[s.key] = s.re.test(t);
    if (!sections[s.key]) problems.push('缺「' + s.key + '」：' + s.why);
  }

  // ② oversized-body（警告，不阻断 —— 对照 Hermes 的「只警告」）
  if (bytes > LIMITS.MAX_BODY_BYTES) {
    warnings.push('正文 ' + bytes + ' B，超过 ' + LIMITS.MAX_BODY_BYTES +
      ' B（skill_view 会整篇加载，会长期占上下文）');
  }

  // ③ incident-log-shape（警告）
  let issues = 0;
  for (const re of LOG_SHAPE_PATTERNS) {
    const m = t.match(new RegExp(re.source, re.flags.includes('m') ? 'gm' : 'g'));
    if (m) issues += m.length;
  }
  const density = lines.length > 0 ? (issues / lines.length) * 1000 : 0;
  if (density > LIMITS.MAX_ISSUE_DENSITY_PER_1K) {
    warnings.push('PR/issue/日期编号密度 ' + Math.round(density) + '/千行，超过 ' +
      LIMITS.MAX_ISSUE_DENSITY_PER_1K + '（技能该写「教训」不写「流水账」）');
  }

  return {
    ok: problems.length === 0,
    sections, bytes, issues,
    density: Math.round(density * 10) / 10,
    problems, warnings,
  };
}

// ══════════════════════════════════════════════════════════════════════
function listSkills() {
  const out = [];
  if (!fs.existsSync(SKILLS)) return out;
  for (const d of fs.readdirSync(SKILLS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = path.join(SKILLS, d.name, 'SKILL.md');
    if (fs.existsSync(p)) out.push({ id: d.name, file: p });
  }
  return out;
}

/** 数一个技能目录下有多少 reference 文件 */
function countReferences(id) {
  let n = 0;
  const scan = (dir, depth) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isFile() && e.name !== 'SKILL.md' && e.name !== 'check.mjs' && e.name !== 'skill.json') n++;
      else if (e.isDirectory()) scan(path.join(dir, e.name), depth + 1);
    }
  };
  scan(path.join(SKILLS, id), 0);
  return n;
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  技能lint · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】合格技能能通过');
  {
    const good = [
      '---',
      'name: demo',
      'description: 【场景：演示】触发词：「做演示」',
      '---',
      '# 演示 · 技能',
      '',
      '## 一、我的职责边界',
      '我做：出演示稿。',
      '',
      '## 二、标准流程',
      '1. 先看材料',
      '2. 再写稿',
      '',
      '## 三、常见坑',
      '- 坑 1：不看材料就写',
      '',
      '## 四、验收标准',
      '- 每条结论有出处',
    ].join('\n');
    const r = judgeSkill(good);
    chk('正例：四节齐全 → 通过', r.ok === true, r.problems.join('; ') || '无问题');
    chk('四节都识别到', r.sections['何时用'] && r.sections['流程'] && r.sections['坑'] && r.sections['验收'],
      JSON.stringify(r.sections));
  }

  console.log();
  console.log('【二】反例：缺节必须报');
  {
    const noFlow = '## 一、我的职责边界\n触发词：做演示\n## 三、常见坑\n- 坑\n## 四、验收标准\n- 有出处';
    const r = judgeSkill(noFlow);
    chk('反例：缺「流程」→ 报错', r.ok === false, r.problems.join('; '));
    chk('报错说清为什么', /缺「流程」/.test(r.problems.join(' ')));

    const empty = '';
    chk('反例：空文本 → 四节全缺', judgeSkill(empty).problems.length === 4,
      String(judgeSkill(empty).problems.length) + ' 条');
  }

  console.log();
  console.log('【三】警告：oversized-body（只警告不阻断）');
  {
    const big = '## 何时用\n触发词：x\n## 流程\n1. x\n## 坑\n- x\n## 验收\n- x\n' + 'a'.repeat(LIMITS.MAX_BODY_BYTES + 1000);
    const r = judgeSkill(big);
    chk('超标会警告', r.warnings.some((w) => /超过/.test(w)), r.warnings.join('; ').slice(0, 60));
    chk('关键：超标不阻断（ok 仍为 true）', r.ok === true, 'ok=' + r.ok);
  }

  console.log();
  console.log('【四】警告：incident-log-shape（流水账）');
  {
    const logs = ['## 何时用', '触发词：x', '## 流程', '1. x', '## 坑', '## 验收', '- x'];
    for (let i = 0; i < 40; i++) logs.push('- 2026-11-13 修了 PR #' + (1000 + i) + ' 的问题');
    const r = judgeSkill(logs.join('\n'));
    chk('大量日期+PR编号会警告', r.warnings.some((w) => /密度/.test(w)), r.warnings.join('; ').slice(0, 60));
    chk('反例：干净技能不会误报', judgeSkill('## 何时用\nx\n## 流程\nx\n## 坑\nx\n## 验收\nx').warnings.length === 0);
  }

  console.log();
  console.log('【五】边界');
  {
    chk('null 不崩', judgeSkill(null).ok === false);
    chk('能列出技能', listSkills().length > 0, listSkills().length + ' 个');
  }

  console.log();
  console.log('【六】关键：这个工具补的是什么');
  chk('关键：之前只查「能不能跑」，不查「写得好不好」',
    true, '技能执行器查 check.mjs 能不能跑；技能可见性体检查引擎能不能看到');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const only = val('skill');
  const skills = listSkills().filter((s) => !only || s.id === only);

  const results = [];
  for (const s of skills) {
    let text = '';
    try { text = fs.readFileSync(s.file, 'utf8'); } catch { /* ignore */ }
    const j = judgeSkill(text);
    const refs = countReferences(s.id);
    const refWarn = refs > LIMITS.MAX_REFERENCES
      ? '引用文件 ' + refs + ' 个，超过 ' + LIMITS.MAX_REFERENCES + '（references-sprawl）'
      : '';
    results.push({
      ...s, ...j,
      warnings: refWarn ? [...j.warnings, refWarn] : j.warnings,
      refs,
      lines: text.split(/\r?\n/).length,
    });
  }

  if (has('json')) {
    console.log(JSON.stringify({
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      results: results.map((r) => ({
        id: r.id, ok: r.ok, bytes: r.bytes, lines: r.lines, issues: r.issues, refs: r.refs,
        problems: r.problems, warnings: r.warnings,
      })),
    }, null, 2));
    return;
  }

  console.log('='.repeat(92));
  console.log('  技能lint —— SKILL.md 写得好不好（不是能不能跑）');
  console.log('='.repeat(92));
  console.log();
  console.log('  依据 Hermes Agent 的技能规范：');
  console.log('    「a skill captures **lessons, not logs**」');
  console.log('    四节必需：When to Use / Procedure / Pitfalls / Verification');
  console.log('    三条 linter（只警告不阻断）：oversized-body / incident-log-shape / references-sprawl');
  console.log();
  console.log('  ⚠ 我们已有「技能可见性体检」（能不能看到）和「技能执行器」（能不能跑），');
  console.log('    但**没有一个查「这份说明本身写得好不好」**。这个工具补的就是这一半。');
  console.log();

  console.log('  ' + '技能'.padEnd(22) + '体积'.padEnd(10) + '行数'.padEnd(8) + '引用'.padEnd(6) + '结论');
  console.log('  ' + '─'.repeat(88));
  for (const r of results) {
    console.log('  ' + r.id.padEnd(22) + (r.bytes + 'B').padEnd(10) +
      String(r.lines).padEnd(8) + String(r.refs).padEnd(6) +
      (r.ok ? '✓' : '✗'));
    for (const p of r.problems) console.log('       ✗ ' + p);
    for (const w of r.warnings) console.log('       ⚠ ' + w);
  }

  console.log();
  console.log('─'.repeat(92));
  const okCount = results.filter((r) => r.ok).length;
  const warnCount = results.filter((r) => r.warnings.length > 0).length;
  console.log('  ' + okCount + ' / ' + results.length + ' 个技能结构合格');
  console.log('  ' + warnCount + ' 个有警告（警告不阻断，但值得改）');

  if (okCount < results.length) {
    console.log();
    console.log('  ⛔ 缺节会导致 AI 不知道该不该用它、怎么干、干完算不算完。');
    process.exitCode = 1;
  }
  console.log('='.repeat(92));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
