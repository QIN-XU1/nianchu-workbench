/**
 * 技能引用完整性验证 —— 含反例。
 *
 * 【要证明什么】技能正文里写的「参考实现指路」（tools/xxx.mjs、prototype/xxx 等）
 * 必须**真实存在**。写一个不存在的路径 = 把「已写入」当「已验证」，
 * 读者照着找会找不到，或被误导。
 *
 * 【反例】构造一个含不存在路径的假技能，验证本脚本能 FAIL（不是永远 PASS）。
 *
 * 用法：node tools/skills/verify-references.mjs
 * 四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCENES = path.join(ROOT, 'prototype/scenes');
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

// 后缀长的在前，避免 js|json 把 .json 截成 .js（踩过这个坑）
const EXT = '(?:json|mjs|tsx|ts|js|md|scss|css)';
const REF_RE = new RegExp('((?:tools|prototype|apps|evidence)\\/[A-Za-z0-9_\\/\\.\\-]+\\.' + EXT + ')', 'g');

function refsOf(text) {
  const set = new Set();
  for (const m of text.matchAll(REF_RE)) set.add(m[1].replace(/[.,;:]+$/, ''));
  return set;
}

function scanSkills() {
  const dirs = fs.readdirSync(SCENES).filter((d) => fs.statSync(path.join(SCENES, d)).isDirectory());
  const missing = [];
  let total = 0;
  for (const d of dirs) {
    const f = path.join(SCENES, d, 'SKILL.md');
    if (!exists(f)) continue;
    const t2 = fs.readFileSync(f, 'utf8');
    for (const p of refsOf(t2)) {
      total++;
      if (!exists(path.join(ROOT, p))) missing.push(d + ' → ' + p);
    }
  }
  return { dirs: dirs.length, total, missing };
}

console.log('');
console.log('  技能引用完整性验证');
console.log('  ' + '─'.repeat(64));

const { dirs, total, missing } = scanSkills();
t('扫描到技能', dirs > 100, '只有 ' + dirs + ' 个');
t('技能引用的本仓库路径全部真实存在（' + total + ' 处）', missing.length === 0, missing.slice(0, 5).join(' | '));

// 反例：造一个含不存在路径的临时技能，本脚本的判定逻辑必须能识别
{
  const fake = '参考：tools/agent/this-file-does-not-exist-zzz.mjs 与 prototype/nope/x.ts';
  const refs = refsOf(fake);
  const fakeMissing = [...refs].filter((p) => !exists(path.join(ROOT, p)));
  t('★反例：不存在的路径能被检出', fakeMissing.length === 2, '检出 ' + fakeMissing.length);
}
{
  // 反例：.json 不应被截成 .js（正则顺序坑）
  const refs = refsOf('evidence/evolve/project-verdict.json');
  t('★反例：.json 不被截成 .js', refs.has('evidence/evolve/project-verdict.json') && !refs.has('evidence/evolve/project-verdict.js'),
    [...refs].join(','));
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 全部技能引用的本仓库路径真实存在'
  : 'FAIL —— 有技能引用了不存在的路径'));
console.log('');
process.exit(fails.length === 0 ? 0 : 1);