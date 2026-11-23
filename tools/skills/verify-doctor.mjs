#!/usr/bin/env node
/**
 * 技能体检(doctor) 自测 —— 证明它真会失败/告警，不是摆设。
 * 直接测 diagnose() 的判定逻辑（合成样本），并对真实技能跑一遍确认 PASS。
 */
import { diagnose, readSkills, LIMIT } from './doctor.mjs';

let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

// 1) 真实技能：不得有 FAIL（我们声称已精简）
{
  const real = diagnose(readSkills());
  const fails = real.rows.filter((r) => r.flags.some((f) => f.level === 'FAIL'));
  t('真实技能 0 个 FAIL', fails.length === 0, fails.map((f) => f.name).join(','));
}

// 2) ★反例A：13KB 技能 → 必 FAIL(too_big)
{
  const d = diagnose([{ name: 'bloated-skill', category: '工程', bytes: 13 * 1024, kb: 13, hard: 0, hardPerKB: 0, codeBlocks: 0, egLines: 0, body: 'x\n' }]);
  t('反例A 13KB → FAIL too_big', d.rows[0].flags.some((f) => f.level === 'FAIL' && f.code === 'too_big'), JSON.stringify(d.rows[0].flags));
}

// 3) ★反例B：普通技能硬约束密度过高 → WARN overconstrained
{
  const d = diagnose([{ name: 'plain-skill', category: '工程', bytes: 1024, kb: 1, hard: 10, hardPerKB: 10, codeBlocks: 0, egLines: 0, body: 'x\n' }]);
  t('反例B 普通技能 10/KB → WARN overconstrained', d.rows[0].flags.some((f) => f.code === 'overconstrained'), JSON.stringify(d.rows[0].flags));
}

// 4) ★反例C：关键领域(gate)同样的硬约束密度 → 应放行（不 overconstrained）
{
  const d = diagnose([{ name: 'release-gate-x', category: '审查', bytes: 1024, kb: 1, hard: 10, hardPerKB: 10, codeBlocks: 0, egLines: 0, body: 'x\n' }]);
  t('反例C 关键领域(gate) 同密度 → 不报 overconstrained', !d.rows[0].flags.some((f) => f.code === 'overconstrained'), JSON.stringify(d.rows[0].flags));
}

// 5) ★反例D：7KB 技能 → WARN split（介于 6~12KB）
{
  const d = diagnose([{ name: 'medium-skill', category: '写作', bytes: 7 * 1024, kb: 7, hard: 0, hardPerKB: 0, codeBlocks: 0, egLines: 0, body: 'x\n' }]);
  t('反例D 7KB → WARN split', d.rows[0].flags.some((f) => f.code === 'split'), JSON.stringify(d.rows[0].flags));
}

// 6) ★反例E：重复行检出（两技能含同一长行）
{
  const line = '这是一条被复制到多个技能里的相同说明文字占位符';
  const d = diagnose([
    { name: 'a', category: 'x', bytes: 100, kb: 0.1, hard: 0, hardPerKB: 0, codeBlocks: 0, egLines: 0, body: line + '\n' },
    { name: 'b', category: 'x', bytes: 100, kb: 0.1, hard: 0, hardPerKB: 0, codeBlocks: 0, egLines: 0, body: line + '\n' },
  ]);
  t('反例E 跨技能重复行被检出', d.dupLines.length >= 1, 'dup=' + d.dupLines.length);
}

console.log(`\n  结果：通过 ${pass} · 失败 ${fail}`);
console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);