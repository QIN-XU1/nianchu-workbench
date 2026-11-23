#!/usr/bin/env node
/**
 * 深度技能「可执行性」验证 —— 技能里写的每个命令 / 引用的每个技能，都必须在仓库里真实存在。
 *
 * 为什么需要：一个深度技能写出来，不等于它能被执行。如果技能里让你跑 `tools/xxx/yyy.mjs`，
 * 而该文件不存在，那就是一份「看起来专业、实际会失败」的文档 —— 正是「已写入 ≠ 已验证」。
 *
 * 检查：
 *   ① 技能正文里出现的命令路径（`tools/...`、`prototype/...`、`research/...`、`evidence/...`）
 *      → 逐个校验真实存在
 *   ② 技能引用的其他技能名（「与其他技能的关系」段 / 正文提到的技能）
 *      → 校验该技能目录存在
 * 四态：0 全通过 · 1 有死引用 · 2 工具自检失败。
 * 用法：node tools/skills/verify-deep-skills.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillLoader, parseFrontmatter } from './loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCENES = path.join(ROOT, 'prototype/scenes');

// 技能正文里出现过的技能名（通过目录名集合 + 文本提及）
const skillNames = new Set(createSkillLoader([SCENES]).scanAll().list().map((s) => s.name));

function findDeep(list) {
  const out = [];
  for (const s of list) {
    const file = path.join(SCENES, s.name, 'SKILL.md');
    const text = fs.readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    if (String((fm.fields && fm.fields.depth) || '').trim() === 'deep') {
      out.push({ name: s.name, file, body: fm.body || '' });
    }
  }
  return out;
}

// 命令引用：匹配以 tools/ prototype/ research/ evidence/ 开头的、带扩展名的路径（正反斜杠、是否带反引号都认）
const CMD = /\b((?:tools|prototype|research|evidence)[\\/][^\s`，。;；)）\]\"']*\.[A-Za-z]+)/g;
// 引用的技能名：正文里以「技能名」形式出现的已知技能（word 边界）
function refSkillNames(body) {
  const refs = [];
  for (const name of skillNames) {
    const re = new RegExp('[`\\[（(，,]\\s*' + name + '\\s*[`\\]）)、，,]|^' + name + '\\b', 'm');
    if (re.test(body)) refs.push(name);
  }
  return refs;
}

function verify(skill) {
  const dead = [];
  const deadSkills = [];
  const cmds = [...new Set([...skill.body.matchAll(CMD)].map((m) => m[1]))];
  for (const c of cmds) {
    if (!fs.existsSync(path.join(ROOT, c))) dead.push(c);
  }
  // 引用技能名必须真实存在（防止「技能里说去用 X，X 其实不存在」）
  const refSkills = refSkillNames(skill.body).filter((n) => n !== skill.name);
  for (const n of refSkills) {
    if (!fs.existsSync(path.join(SCENES, n, 'SKILL.md'))) deadSkills.push(n);
  }
  // ★「与其他技能的关系」段里的每个反引号词都必须是真实技能 —— 该段只谈技能，词义明确，不会误判
  const relation = /##\s*与其他技能的关系\b[\s\S]*$/.exec(skill.body);
  if (relation) {
    for (const tok of [...relation[0].matchAll(/`([^`]+)`/g)].map((m) => m[1])) {
      const t = tok.trim();
      if (!skillNames.has(t)) deadSkills.push('(关系段) ' + t);
    }
  }
  return { cmds, dead, refSkills, deadSkills };
}

// ── 工具自检 ──
{
  const probe = '`tools/skills/loader.mjs` 和 `tools/skills/doctor.mjs` 与 `tools/skills/nope.mjs`';
  const cmds = [...probe.matchAll(CMD)].map((m) => m[1].replace(/`/g, ''));
  if (cmds.length !== 3) { console.error('  ✗ 自检失败：应抽 3 条命令，实得 ' + cmds.length); process.exit(2); }
  const loaderOk = fs.existsSync(path.join(ROOT, 'tools/skills/loader.mjs'));
  if (!loaderOk) { console.error('  ✗ 自检失败：真实文件应存在'); process.exit(2); }
}

const deep = findDeep(createSkillLoader([SCENES]).scanAll().list());
console.log('  深度技能可执行性验证 · ' + deep.length + ' 个深度技能');
console.log('  ' + '─'.repeat(64));

let fail = 0;

// ── 反例自测（证明检查真会失败，不是摆设）──
{
  // 正反斜杠都能提取路径
  const a = 'tools/skills/loader.mjs';
  const b = 'tools\\skills\\loader.mjs';
  const m1 = new RegExp(CMD).exec('  ' + a + '  ');
  const m2 = new RegExp(CMD).exec('  ' + b + '  ');
  if (!m1 || m1[1] !== a) { console.error('  ✗ 反例：正斜杠路径未被提取'); process.exit(2); }
  if (!m2 || m2[1] !== b) { console.error('  ✗ 反例：反斜杠路径未被提取'); process.exit(2); }
  // 不存在的路径必须判死
  if (fs.existsSync(path.join(ROOT, 'tools/skills/__no_such__.mjs'))) { console.error('  ✗ 反例：死引用不应存在'); process.exit(2); }
  // 关系段里指向不存在技能必须被识别
  const rel = '## 与其他技能的关系\n- 前置：`release-gate`、`__no_such_skill__`';
  const toks = [...rel.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => !skillNames.has(t));
  if (!toks.includes('__no_such_skill__')) { console.error('  ✗ 反例：不存在的技能名未被识别'); process.exit(2); }
  console.log('  ✓ 反例自测：正/反斜杠提取、死命令、关系段死技能名均能识别');
}

for (const s of deep) {
  const r = verify(s);
  const ok = r.dead.length === 0 && r.deadSkills.length === 0;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${s.name.padEnd(20)} 命令 ${String(r.cmds.length).padStart(2)} 条 / 引用技能 ${String(r.refSkills.length).padStart(2)} 个 · 死引用 ${(r.dead.length + r.deadSkills.length)} ${r.dead.length || r.deadSkills.length ? '→ ' + [...r.dead, ...r.deadSkills].join('、') : ''}`);
}

console.log('  ' + '─'.repeat(64));
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL') + ' —— 死引用 ' + fail + ' 个技能');
process.exit(fail === 0 ? 0 : 1);