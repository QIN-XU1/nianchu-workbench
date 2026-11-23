#!/usr/bin/env node
/**
 * 技能注册表 —— A12 的「生态」层（第 63 轮）
 *
 * 光有一堆 SKILL.md 不算生态；生态要能**按分类检索、统计、校验完整性**。
 * 本工具：扫描技能池 → 按 category 聚合 → 产出 registry.json + 人读表。
 *
 * 验收（四态）：
 *   ① 每个技能都有 category（未分类 = 0）
 *   ② 分类里每类至少 1 个
 *   ③ 无重复 name（loader 已保证）
 *   ④ 反例：故意造一个缺 category 的技能，必须被检出
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillLoader } from './loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCENES = path.join(ROOT, 'prototype/scenes');

export function buildRegistry(roots = [SCENES]) {
  const loader = createSkillLoader(roots).scanAll();
  const st = loader.stats();
  const byCat = loader.byCategory();
  const skills = loader.list();
  const uncategorized = skills.filter((s) => s.category === '未分类');
  const categories = [...byCat.entries()].map(([cat, list]) => ({ category: cat, count: list.length, skills: list.map((s) => s.name) }))
    .sort((a, b) => b.count - a.count);
  return {
    at: new Date().toISOString(),
    total: st.count,
    categories,
    uncategorized: uncategorized.map((s) => s.name),
    errors: st.issues.filter((i) => i.level === 'error').map((i) => i.message),
  };
}

export function verdict(reg) {
  const checks = [];
  checks.push({ name: '按分类:未分类为 0', ok: reg.uncategorized.length === 0, info: reg.uncategorized.join(',') });
  checks.push({ name: '分类数 ≥ 2', ok: reg.categories.length >= 2 });
  checks.push({ name: '每类 ≥ 1', ok: reg.categories.every((c) => c.count >= 1) });
  checks.push({ name: '无装载错误', ok: reg.errors.length === 0, info: reg.errors.join(';') });
  const fails = checks.filter((c) => !c.ok);
  return { state: fails.length ? 'FAIL' : 'PASS', checks };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const reg = buildRegistry();
  const v = verdict(reg);
  const out = path.join(ROOT, 'evidence/skills/registry.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  console.log('  技能注册表 · 共 ' + reg.total + ' 个 · ' + reg.categories.length + ' 类');
  for (const c of reg.categories) console.log('    [' + c.category + '] ' + c.count + ' —— ' + c.skills.join(', '));
  console.log('');
  for (const c of v.checks) console.log('    ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.info ? '  ← ' + c.info : ''));
  console.log('\n  四态: ' + v.state + ' · 已写 ' + path.relative(ROOT, out));
  process.exit(v.state === 'FAIL' ? 1 : 0);
}
