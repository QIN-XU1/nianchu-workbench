#!/usr/bin/env node
/**
 * load_skill 工具描述验收 —— 「模型会不会用技能」的第二层证明
 *
 * ══ 为什么描述这么重要 ══════════════════════════════════════════
 * 目录（3974 字符）只告诉模型「有哪些技能」，但**没告诉它「什么时候该读正文」**。
 * 如果工具描述只说「看起来相关时调用」，模型很可能：
 *   · 只看目录里那一行 description 就动手（漏掉正文里的判据与反例）
 *   · 或者干脆不调用（觉得目录已经够了）
 * 所以描述必须写清「什么时候必须调 / 不调的代价」。
 *
 * ══ 本脚本锁住的约束 ═══════════════════════════════════════════
 * 1. 描述里点名的技能**必须真实存在**（否则模型会 load 一个不存在的名字）
 * 2. 描述里不能出现「看起来相关」这类模糊引导
 * 3. 描述必须包含「不调的代价」说明（否则模型没有动机调）
 * 4. 描述不能长到撑爆 prompt（有上限）
 *
 * ══ 四态 ══════════════════════════════════════════════════════
 * 0 全通过 · 1 有失败 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const t = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

async function main() {
  const { createSkillLoader } = await import('../skills/loader.mjs');
  const { createLoadSkillTool } = await import('../skills/inject.mjs');
  const loader = createSkillLoader([path.join(ROOT, 'prototype/scenes')]).scanAll();
  const tool = createLoadSkillTool(loader);
  const desc = String(tool.description || '');
  const realNames = new Set(loader.list().map((x) => x.name));

  console.log('\n  1. 描述存在且非空');
  t('有 description', desc.length > 100, '长度 ' + desc.length);
  t('name 是 load_skill', tool.name === 'load_skill');

  console.log('\n  2. ★ 描述里点名的技能必须真实存在（防硬编码过期）');
  // 从描述里抽出看起来像技能名的 token（小写字母+连字符，至少 2 段）
  const mentioned = [...new Set((desc.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g) || []))];
  console.log('    点名了 ' + mentioned.length + ' 个技能: ' + mentioned.join(', '));
  t('至少点名 5 个技能（否则引导太弱）', mentioned.length >= 5, '实际 ' + mentioned.length);
  const ghosts = mentioned.filter((n) => !realNames.has(n));
  t('点名的技能全部真实存在（无死引用）', ghosts.length === 0, '不存在: ' + ghosts.join(', '));

  console.log('\n  3. ★ 必须说明「不调的代价」（给模型动机）');
  t('含「不要只凭」或等价说明', /不要只凭|只有一句话|漏掉|否则会/.test(desc), desc.slice(0, 120));
  t('含「正文才有」类说明', /正文才有|正文里|正文中有/.test(desc));

  console.log('\n  4. 必须说明「什么时候不用调用」（防过度调用）');
  t('含「不用调用」或「不需要」', /不用调用|不需要调用|不必调用/.test(desc), desc.slice(0, 120));

  console.log('\n  5. 反例：不许用模糊引导');
  const vague = ['看起来相关', '如果相关', '必要时', '酌情', '视情况'];
  const foundVague = vague.filter((v) => desc.includes(v));
  t('没有模糊引导词', foundVague.length === 0, '发现: ' + foundVague.join(', '));

  console.log('\n  6. 反例：不许承诺「自动选择」');
  t('没说「会自动选」', !/自动选择|自动匹配|自动挑/.test(desc));
  t('明确要求 name 精确匹配', /完全一致|必须是|必须与/.test(desc));

  console.log('\n  7. 体量上限（不能撑爆 prompt）');
  t('描述 < 1200 字符', desc.length < 1200, '实际 ' + desc.length);
  t('描述 > 200 字符（太短则引导不足）', desc.length > 200, '实际 ' + desc.length);

  console.log('\n  8. 参数 schema 正确');
  t('required 含 name', Array.isArray(tool.parameters.required) && tool.parameters.required.includes('name'));
  t('additionalProperties=false', tool.parameters.additionalProperties === false);
  t('name 参数有说明', !!tool.parameters.properties?.name?.description);

  console.log('\n  9. ★ 描述与目录一致：目录里有的技能，描述提到的必须能 load');
  for (const n of mentioned.slice(0, 8)) {
    let ok = false;
    try { const r = tool.run({ name: n }); ok = r.ok === true && String(r.body || '').length > 0; } catch { ok = false; }
    t('能真的 load ' + n, ok);
  }

  console.log('\n  10. 反例：不存在的名字必须报错（不静默）');
  const bad = tool.run({ name: 'no-such-skill-xyz' });
  t('未知技能 → ok=false', bad.ok === false);
  t('未知技能 → 有 error 字段', typeof bad.error === 'string' && bad.error.length > 0, JSON.stringify(bad));

  console.log('\n  ──────────────────────────────────────────');
  console.log('  通过 ' + pass + ' · 失败 ' + fail);
  const state = fail > 0 ? 'FAIL' : (pass > 0 ? 'PASS' : 'UNKNOWN');
  console.log('  四态: ' + state);
  console.log('  ⚠ 本脚本只证明「描述写得够清楚」；模型是否照做需真模型（本环境无 API key，UNKNOWN）。');
  process.exit(state === 'FAIL' ? 1 : state === 'UNKNOWN' ? 2 : 0);
}

main().catch((e) => {
  console.error('  ✗ 工具自检失败：' + (e && e.stack || e));
  process.exit(2);
});
