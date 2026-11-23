#!/usr/bin/env node
/**
 * A12 技能装载器 · 验收器（含反例）
 * 证明真装载而非"清单读取"：发现/解析/校验/懒加载 全部可验，且坏输入必须被拒。
 */
import path from 'node:path';
import { parseFrontmatter, validateSkill, createSkillLoader, LIMITS } from '../../tools/skills/loader.mjs';

let pass = 0, total = 0;
const lines = [];
function T(name, ok, why) { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok ? '' : '  ← ' + why)); }

const REPO = path.resolve(import.meta.dirname, '../..');
const GOOD = '---\nname: demo\ndescription: 演示技能\n---\n\n# Demo\n正文\n';

// ── 正例 1：解析 frontmatter ──
const fm = parseFrontmatter(GOOD);
T('正例 · 解析 frontmatter（name/description/body）',
  fm.ok && fm.fields.name === 'demo' && fm.fields.description === '演示技能' && fm.body.includes('# Demo'),
  JSON.stringify(fm.fields));

// ── 正例 2：合法技能校验通过 ──
T('正例 · 合法技能校验通过', validateSkill('demo', GOOD).ok === true, '应通过');

// ── 反例 1：缺 frontmatter ⇒ 拒绝 ──
T('反例 · 缺 frontmatter ⇒ 拒绝', parseFrontmatter('# 无 frontmatter\n').ok === false, '不该通过');

// ── 反例 2：缺 name ⇒ 拒绝 ──
T('反例 · 缺 name ⇒ 拒绝',
  validateSkill('x', '---\ndescription: d\n---\nbody\n').ok === false, '不该通过');

// ── 反例 3：缺 description ⇒ 拒绝 ──
T('反例 · 缺 description ⇒ 拒绝',
  validateSkill('x', '---\nname: x\n---\nbody\n').ok === false, '不该通过');

// ── 反例 4：name 与目录名不一致 ⇒ 拒绝 ──
const mism = validateSkill('dir-name', GOOD);
T('反例 · name 与目录名不一致 ⇒ 拒绝',
  mism.ok === false && mism.issues.some((i) => i.code === 'name_mismatch'), '不该通过');

// ── 反例 5：正文超 12KB ⇒ 只 WARN 不阻断 ──
const big = '---\nname: big\ndescription: d\n---\n' + 'x'.repeat(LIMITS.bodyBytes + 10);
const bigV = validateSkill('big', big);
T('反例 · 正文超 12KB ⇒ WARN 但不阻断',
  bigV.ok === true && bigV.issues.some((i) => i.code === 'body_too_large' && i.level === 'warn'), JSON.stringify(bigV.issues));

// ── 正例 3：真实仓库装载 6 个技能 ──
const loader = createSkillLoader([path.join(REPO, 'prototype/scenes')]).scanAll();
const st = loader.stats();
T('正例 · 真实仓库发现 ≥6 个技能', st.count >= 6, 'count=' + st.count);
T('正例 · 真实仓库无 error 级问题', st.issues.filter((i) => i.level === 'error').length === 0, JSON.stringify(st.issues));

// ── 正例 4：list 不把正文塞进来（允许附加元数据）──
// 【第 110 轮修】原断言要求键名**恰好**是 description,name —— 太严：loader 后来加了
// `category`（配合 byCategory() API，是有意为之），断言就红了。
// 这条断言真正要守的是「list 不含正文 body」（性能/契约），所以改成
// 「必须有 name/description、必须没有 body」，允许其它附加字段。
const list = loader.list();
T('正例 · list 含 name+description 且不含正文 body（允许附加元数据）',
  list.length > 0
    && typeof list[0].name === 'string' && list[0].name.length > 0
    && typeof list[0].description === 'string'
    && !('body' in list[0]),
  JSON.stringify(Object.keys(list[0] || {})));

// ── 正例 5：懒加载正文 ──
const one = loader.load(st.names[0]);
T('正例 · load() 按需返回正文', typeof one.body === 'string' && one.body.length > 0, 'body 为空');

// ── 反例 6：装载不存在的技能 ⇒ 抛错（不静默）──
let threw = false;
try { loader.load('__nope__'); } catch { threw = true; }
T('反例 · 装载不存在技能 ⇒ 抛错', threw, '不该静默');

// ── 反例 7：重复 name ⇒ 拒绝 ──
const dupLoader = createSkillLoader([]);
// 直接构造：同一 name 两次（用真实目录扫描两次模拟）
const dup = createSkillLoader([path.join(REPO, 'prototype/scenes'), path.join(REPO, 'prototype/scenes')]).scanAll();
T('反例 · 同一 name 扫两次 ⇒ 记 dup_skill 错误',
  dup.stats().issues.some((i) => i.code === 'dup_skill'), JSON.stringify(dup.stats().issues.slice(0, 2)));

const ok = pass === total;
console.log('  A12 技能装载器验收 —— 自研（发现/解析/校验/懒加载）');
console.log(lines.join('\n'));
console.log('\n  验收 ' + pass + '/' + total + ' · 四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
