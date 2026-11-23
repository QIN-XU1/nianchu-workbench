#!/usr/bin/env node
/**
 * release-pipeline 技能「真跑」验证 —— 不是查引用存在，而是**按技能说的做**。
 *
 * 第 88 轮：真跑第 1~2 步（门禁项 + 版本号规则）。
 * 第 89 轮：补第 3 步「构建产物校验」—— 用本仓库真实产物 `.nianchu-hosts/`
 *          （canonical 技能投影到 12 宿主 + agents.json）做对象，把技能的产物校验规则真跑一遍。
 *
 * 仍标 UNKNOWN 的部分：第 4~6 步（回滚演练需真实预发环境、发布后验证需线上、记录靠人），
 * 本仓库无法自动化 → 不冒充已验证。
 *
 * 四态：0 全通过 · 1 有失败 · 2 工具自检失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createSkillLoader } from './loader.mjs';
import { HOSTS as PORTABLE_HOSTS } from '../portable/project.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOSTS = path.join(ROOT, '.nianchu-hosts');
const MIN_BYTES = 1024;
const audit = path.join(ROOT, 'tools/quality/audit-doc-numbers.mjs');

let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

// ── 第 2 步的版本号规则（技能原文：不兼容→主 / 新增→次 / 纯修复→修订）──
function versionBump(change) {
  if (change.kind === 'breaking') return 'major';
  if (change.kind === 'feature') return 'minor';
  return 'patch';
}

// ── 第 3 步的产物校验（可对任意目录复用，便于反例）──
function checkArtifacts(dir) {
  const problems = [];
  if (!fs.existsSync(dir)) return { ok: false, problems: ['产物目录不存在：' + dir], files: [] };

  const agentsPath = path.join(dir, 'agents.json');
  if (!fs.existsSync(agentsPath)) problems.push('缺入口文件 agents.json');
  // 递归收集**所有文件**（宿主目录可能是多层，如 kiro/steering/product.md）
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  })(dir);

  for (const f of files) {
    const st = fs.statSync(f);
    if (st.size === 0) problems.push('产物为空（0 字节）：' + path.relative(dir, f));
    else if (st.size < MIN_BYTES && path.basename(f) !== 'agents.json') problems.push('产物过小（可能漏打包）：' + path.relative(dir, f) + ' ' + st.size + 'B');
  }

  let manifest = null;
  if (fs.existsSync(agentsPath)) {
    try { manifest = JSON.parse(fs.readFileSync(agentsPath, 'utf8')); }
    catch (e) { problems.push('agents.json 无法解析：' + e.message); }
  }

  if (manifest) {
    for (const k of ['schema', 'generator', 'source', 'count', 'skills']) if (!(k in manifest)) problems.push('agents.json 缺字段：' + k);
    if (Array.isArray(manifest.skills) && manifest.count !== manifest.skills.length) problems.push(`agents.json count(${manifest.count}) ≠ skills.length(${manifest.skills.length})`);
  }
  return { ok: problems.length === 0, problems, files, manifest };
}

// ── 工具自检 ──
{
  if (versionBump({ kind: 'breaking' }) !== 'major' || versionBump({ kind: 'feature' }) !== 'minor' || versionBump({ kind: 'fix' }) !== 'patch') {
    console.error('  ✗ 自检失败：版本号规则'); process.exit(2);
  }
  if (checkArtifacts(path.join(ROOT, '__no_such_dir__')).ok) { console.error('  ✗ 自检失败：不存在的目录应判失败'); process.exit(2); }
}

console.log('  release-pipeline 技能真跑验证');
console.log('  ' + '─'.repeat(62));

// ══ 第 1 步：真跑技能点名的发布前必跑项 ══
{
  if (!fs.existsSync(audit)) { console.error('  ✗ 技能引用的 audit-doc-numbers 不存在'); process.exit(1); }
  const r1 = spawnSync('node', [audit], { cwd: ROOT, encoding: 'utf8' });
  const out1 = (r1.stdout || '') + (r1.stderr || '');
  // 技能判据是「全 PASS，或每个 WARN/UNKNOWN 都能解释」——不是必须 exit 0
  t('第1步：audit-doc-numbers 真实执行并给出明确判定', r1.status === 0 || r1.status === 3, 'exit=' + r1.status + ' ' + out1.slice(0, 80).replace(/\s+/g, ' '));
  t('第1步：WARN 时给出可解释原因（非崩溃）', r1.status !== 3 || /四态|未覆盖/.test(out1), r1.status === 3 ? out1.slice(0, 70).replace(/\s+/g, ' ') : '(PASS)');

  // 反例：文档数字过期必须 FAIL
  const doc = path.join(ROOT, 'README.md');
  const orig = fs.readFileSync(doc, 'utf8');
  const fake = orig.replace(/\|\s*改进台账\s*\|\s*\*\*\d+\s*条\*\*/, '| 改进台账 | **9999 条**');
  if (fake === orig) { t('反例前置：能注入过期数字', false, '未匹配到台账行'); }
  else {
    let rr;
    try { fs.writeFileSync(doc, fake, 'utf8'); rr = spawnSync('node', [audit], { cwd: ROOT, encoding: 'utf8' }); }
    finally { fs.writeFileSync(doc, orig, 'utf8'); }
    t('反例A：文档数字过期 → audit 必须 FAIL', rr.status !== 0, 'exit=' + rr.status + '（应非 0）');
  }
}

// ══ 第 2 步：版本号规则 ══
t('第2步：不兼容改动判「主版本」', versionBump({ kind: 'breaking' }) === 'major');
t('第2步：新增能力判「次版本」', versionBump({ kind: 'feature' }) === 'minor');
t('反例B：不兼容若判次版本会被识别为错误', versionBump({ kind: 'breaking' }) !== 'minor');

// ══ 第 3 步：构建产物校验（真实产物 .nianchu-hosts）══
const real = checkArtifacts(HOSTS);
t('第3步：真实产物目录存在', fs.existsSync(HOSTS));
t('第3步：产物非空且无过小文件', real.ok, real.problems.slice(0, 3).join(' | '));
t('第3步：产物文件数 = ' + (PORTABLE_HOSTS.length + 1) + '（' + PORTABLE_HOSTS.length + ' 宿主 + agents.json）', real.files.length === PORTABLE_HOSTS.length + 1, '实得 ' + real.files.length);
t('第3步：agents.json 可被 JSON 解析（入口可加载）', !!real.manifest, real.manifest ? '' : (real.problems || []).join('|'));
{
  const realSkillCount = createSkillLoader([path.join(ROOT, 'prototype/scenes')]).scanAll().list().length;
  t('第3步：产物 count 与真实技能数一致（产物未过期）', !!real.manifest && real.manifest.count === realSkillCount,
    `产物 ${real.manifest && real.manifest.count} vs 真实 ${realSkillCount}`);
  t('第3步：产物声明 generator 与 source（可追溯）', !!real.manifest && !!real.manifest.generator && !!real.manifest.source,
    JSON.stringify({ g: real.manifest && real.manifest.generator, s: real.manifest && real.manifest.source }).slice(0, 90));
}

// 反例（对应技能第 3 步「挪走资源必须被检出」）
const TMP = path.join(ROOT, '__artifact_probe__');
try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'claude'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'claude/CLAUDE.md'), 'x'.repeat(2048), 'utf8');
  const noEntry = checkArtifacts(TMP);
  t('反例C：缺 agents.json 入口 → 必须 FAIL', !noEntry.ok && noEntry.problems.some((p) => p.includes('agents.json')), JSON.stringify(noEntry.problems).slice(0, 80));

  fs.writeFileSync(path.join(TMP, 'agents.json'), JSON.stringify({ schema: 'x', generator: 'g', source: 's', count: 1, skills: [{ id: 'a' }] }), 'utf8');
  fs.writeFileSync(path.join(TMP, 'claude/CLAUDE.md'), '', 'utf8');
  const emptyFile = checkArtifacts(TMP);
  t('反例D：空产物文件 → 必须 FAIL', !emptyFile.ok && emptyFile.problems.some((p) => p.includes('0 字节')), JSON.stringify(emptyFile.problems).slice(0, 80));

  fs.writeFileSync(path.join(TMP, 'claude/CLAUDE.md'), 'x'.repeat(2048), 'utf8');
  fs.writeFileSync(path.join(TMP, 'agents.json'), JSON.stringify({ schema: 'x', generator: 'g', source: 's', count: 99, skills: [{ id: 'a' }] }), 'utf8');
  const stale = checkArtifacts(TMP);
  t('反例E：count≠skills.length（产物过期）→ 必须 FAIL', !stale.ok && stale.problems.some((p) => p.includes('count')), JSON.stringify(stale.problems).slice(0, 80));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('  ' + '─'.repeat(62));
console.log(`  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
console.log('  未真跑（UNKNOWN）：第 4~6 步（回滚演练需预发环境、发布后验证需线上、记录靠人）');
process.exit(fail === 0 ? 0 : 1);