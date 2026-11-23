#!/usr/bin/env node
/**
 * claude doctor 的念初版 —— 上下文工程体检 + 技能瘦身建议。
 *
 * 依据 claude.dev《The new rules of context engineering for Claude 5 generation models》：
 *   模型越强，越要「unhobble」——删掉过度约束，让模型用判断；用渐进披露；别拿例子当说明书；
 *   别重复；skill 保持轻量、只在关键处强硬。该文的 /doctor 就是在给 skills 和 CLAUDE.md「rightsize」。
 *
 * 本工具对每个 SKILL.md（及可选 system prompt）体检：
 *   ① 体量：>12KB 必拆（与 loader 上限一致）、>6KB 建议拆（progressive disclosure）
 *   ② 硬约束密度：MUST/NEVER/DO NOT/必须/绝不/严禁/禁止 每 KB 条数；过高 = 过度约束
 *      （gate/security/review 类「关键领域」允许更硬，白名单放行）
 *   ③ 例子体量：围栏代码块 / 「例如」越多，越提示「该用接口设计而非堆例子」
 *   ④ 重复：跨 skill 完全相同的行（常见于把同一段复制到每个 skill）
 *
 * 四态：0 全通过 · 3 有 WARN（建议但不阻断）· 1 有 FAIL（如超 12KB 必拆）· 2 工具自检失败。
 * 用法：node tools/skills/doctor.mjs [--json] [--strict]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillLoader, parseFrontmatter } from './loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCENES = path.join(ROOT, 'prototype/scenes');

// 关键领域：这些 skill 适度强硬是合理的（文章：avoid overconstrained "except in highly important areas"）
const HARD_OK = /gate|security|threat|review|verdict|migrat|release/i;
const HARD_WORDS = /MUST|NEVER|DO NOT|必须|绝不|严禁|禁止|务必/g;

const LIMIT = {
  mustSplitBytes: 12 * 1024, suggestSplitBytes: 6 * 1024, hardPerKB: 6,
  // 深度技能（depth: deep）：承载多阶段流程，允许更大；超过仍要求拆 reference
  mustSplitDeepBytes: 24 * 1024, suggestSplitDeepBytes: 16 * 1024,
};

function readSkills() {
  const loader = createSkillLoader([SCENES]).scanAll();
  const list = loader.list();
  const out = [];
  for (const s of list) {
    const dir = path.join(SCENES, s.name);
    const file = path.join(dir, 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    const body = fm.body || '';
    const bytes = Buffer.byteLength(body, 'utf8');
    const kb = bytes / 1024;
    const hard = (body.match(HARD_WORDS) || []).length;
    const hardPerKB = kb > 0 ? hard / kb : hard;
    const codeBlocks = (body.match(/```/g) || []).length / 2;
    const egLines = (body.match(/例如|比如|示例|e\.g\./gi) || []).length;
    const depth = String((fm.fields && fm.fields.depth) || 'guide').trim(); // guide=轻量指南 / deep=深度技能
    out.push({ name: s.name, category: s.category, depth, bytes, kb: +kb.toFixed(2), hard, hardPerKB: +hardPerKB.toFixed(2), codeBlocks, egLines, body });
  }
  return out;
}

function diagnose(skills) {
  const issues = [];
  // ④ 跨 skill 重复行
  const lineOwners = new Map();
  for (const s of skills) for (const ln of s.body.split(/\r?\n/)) {
    const t = ln.trim();
    if (t.length < 12 || /^[-#>|`]/.test(t)) continue; // 忽略短行/纯标记行
    if (!lineOwners.has(t)) lineOwners.set(t, new Set());
    lineOwners.get(t).add(s.name);
  }
  const dupLines = [...lineOwners.entries()].filter(([, set]) => set.size >= 2);

  const rows = [];
  for (const s of skills) {
    const flags = [];
    // 深度技能（depth: deep）允许更大：它是承载多阶段流程的，不是轻量指南
    const isDeep = s.depth === 'deep';
    const mustSplit = isDeep ? LIMIT.mustSplitDeepBytes : LIMIT.mustSplitBytes;
    const suggestSplit = isDeep ? LIMIT.suggestSplitDeepBytes : LIMIT.suggestSplitBytes;
    if (s.bytes > mustSplit) flags.push({ level: 'FAIL', code: 'too_big', msg: `${s.kb}KB > ${Math.round(mustSplit/1024)}KB，必拆（${isDeep?'深度技能上限':'渐进披露：拆成多个 reference，正文留索引'}）` });
    else if (s.bytes > suggestSplit) flags.push({ level: 'WARN', code: 'split', msg: `${s.kb}KB > ${Math.round(suggestSplit/1024)}KB，建议拆分` });
    if (!HARD_OK.test(s.name) && s.hardPerKB > LIMIT.hardPerKB) flags.push({ level: 'WARN', code: 'overconstrained', msg: `硬约束密度 ${s.hardPerKB}/KB 偏高（${s.hard} 条），建议改为「让模型判断」+关键处才强硬` });
    if (s.codeBlocks >= 3) flags.push({ level: 'WARN', code: 'examples', msg: `含 ${s.codeBlocks} 个代码块 —— 考虑用「接口/枚举设计」替代堆例子（文章：examples constrain）` });
    if (s.egLines >= 5) flags.push({ level: 'WARN', code: 'examples_words', msg: `「例如」等出现 ${s.egLines} 次 —— 考虑减少举例` });
    rows.push({ name: s.name, category: s.category, kb: s.kb, hard: s.hard, hardPerKB: s.hardPerKB, codeBlocks: s.codeBlocks, flags });
  }
  return { rows, dupLines };
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const skills = readSkills();
  // 工具自检：抽取器/计数器要在已知输入上给出正确结果
  {
    const probe = 'MUST do X NEVER do Y 必须 Z';
    const cnt = (probe.match(HARD_WORDS) || []).length;
    if (cnt !== 3) { console.error('  ✗ 自检失败：硬约束词计数应为 3，实得 ' + cnt); process.exit(2); }
    if (skills.length === 0) { console.error('  ✗ 自检失败：未发现任何 skill'); process.exit(2); }
  }
  const { rows, dupLines } = diagnose(skills);

  if (process.argv.includes('--json')) {
    const out = path.join(ROOT, 'evidence/skills/doctor-report.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), limits: LIMIT, skills: rows, duplicateLines: dupLines.map(([t, s]) => ({ line: t.slice(0, 80), inSkills: [...s] })) }, null, 2) + '\n', 'utf8');
    console.log('  已写 ' + path.relative(ROOT, out));
  }

  console.log('');
  console.log('  技能体检（claude doctor 的念初版）· ' + skills.length + ' 个 skill');
  console.log('  ' + '─'.repeat(74));
  let nFail = 0, nWarn = 0;
  for (const r of rows) {
    const lvl = r.flags.some((f) => f.level === 'FAIL') ? '✗' : r.flags.some((f) => f.level === 'WARN') ? '⚠' : '✓';
    if (lvl === '✗') nFail++; else if (lvl === '⚠') nWarn++;
    const fmsg = r.flags.map((f) => f.code + ':' + f.msg).join(' | ');
    console.log(`  ${lvl} ${r.name.padEnd(20)} ${String(r.kb).padStart(5)}KB 硬${String(r.hard).padStart(2)}(${r.hardPerKB}/KB) 码块${r.codeBlocks}  ${fmsg}`);
  }
  console.log('  ' + '─'.repeat(74));
  console.log('  跨技能重复行: ' + dupLines.length + ' 行' + (dupLines.length ? '（建议抽公共 reference）' : ''));
  const state = nFail ? 'FAIL' : nWarn ? 'WARN' : 'PASS';
  console.log('\n  四态: ' + state + ' —— FAIL ' + nFail + ' · WARN ' + nWarn + ' · PASS ' + (rows.length - nFail - nWarn));
  process.exit(state === 'FAIL' ? 1 : state === 'WARN' ? 3 : 0);
}

export { readSkills, diagnose, LIMIT, HARD_WORDS };