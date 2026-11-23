#!/usr/bin/env node
/**
 * 技能索引层验证 —— 证明 index/diff/quarantine 真的有用且真会失败（反例）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillLoader } from './loader.mjs';
import { renderSkillIndex, diffSkillIndex, applyQuarantine } from './index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

const loader = createSkillLoader([path.join(ROOT, 'prototype/scenes')]).scanAll();
const skills = loader.list();
t('装载器发现技能 > 0', skills.length > 0, String(skills.length));

// 1) 字节稳定
const a = renderSkillIndex(skills).text;
const b = renderSkillIndex([...skills].reverse()).text; // 顺序打乱也应同样输出（内部排序）
t('索引字节稳定（顺序无关）', a === b);

// 2) 排序 + 截断
const idx = renderSkillIndex(skills, { descChars: 20 });
t('每技能一行（- name — desc）', idx.text.split('\n').filter((l) => l.startsWith('- ')).length === skills.length);
t('分类头存在（[工程]/[审查]…）', /\[工程\]|\[审查\]|\[写作\]|\[数据\]/.test(idx.text));
const longOnes = skills.filter((s) => String(s.description || '').length > 20).length;
t('截断计数正确', idx.truncatedCount === longOnes, idx.truncatedCount + ' vs ' + longOnes);

// 3) diff
const d1 = diffSkillIndex(['a', 'b', 'c'], ['b', 'c', 'd']);
t('diff 检出 added=[d]', JSON.stringify(d1.added) === '["d"]', JSON.stringify(d1.added));
t('diff 检出 removed=[a]', JSON.stringify(d1.removed) === '["a"]', JSON.stringify(d1.removed));
t('diff changed=true', d1.changed === true);
const d2 = diffSkillIndex(['x', 'y'], ['y', 'x']);
t('diff 无变化时 changed=false', d2.changed === false);

// 4) quarantine 过滤
const q = applyQuarantine(skills, [skills[0].name]);
t('隔离后少 1 个', q.kept.length === skills.length - 1);
t('隔离的技能在 quarantined 里', q.quarantined[0] && q.quarantined[0].name === skills[0].name);

// 5) ★反例 A：被隔离的技能绝不出现在渲染索引里
const qA = applyQuarantine(skills, [skills[0].name]);
const idxQ = renderSkillIndex(qA.kept).text;
t('反例:隔离技能不出现在索引', !idxQ.includes('- ' + skills[0].name + ' —'), skills[0].name);

// 6) ★反例 B：diff 必须反映删除（不能把 removed 漏成 unchanged）
const d3 = diffSkillIndex(['keep', 'gone'], ['keep']);
t('反例:删除的技能被 removed 检出', d3.removed.includes('gone'), JSON.stringify(d3.removed));

// 7) ★反例 C：截断确实是「截断」，长描述末尾有 … 且长度受限
const oneLong = [{ name: 'x', category: 'c', description: 'A'.repeat(200) }];
const r = renderSkillIndex(oneLong, { descChars: 20 });
t('反例:超长描述被截断且带…', /…$/.test(r.text.split('\n').find((l) => l.startsWith('- x'))), '应带省略号');

console.log(`\n  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);