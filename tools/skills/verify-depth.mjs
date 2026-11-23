import fs from 'node:fs';
import path from 'node:path';
import { diagnose } from './doctor.mjs';

// 纯逻辑测试：直接喂合成样本，验证 depth 是否改变 split 判定
const mk = (depth, kb) => ({ name: 'probe-' + depth, category: '工程', depth, bytes: kb * 1024, kb, hard: 0, hardPerKB: 0, codeBlocks: 0, egLines: 0, body: 'x\n' });
let pass = 0, fail = 0;
const t = (n, c, i = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (i ? ' ← ' + i : '')); } };

// guide 7KB → 应报 split（阈值 6KB）
{
  const r = diagnose([mk('guide', 7)]).rows[0];
  t('guide 7KB → split WARN', r.flags.some((f) => f.code === 'split'), JSON.stringify(r.flags.map((f) => f.code)));
}
// deep 7KB → 不应报 split（阈值 16KB）
{
  const r = diagnose([mk('deep', 7)]).rows[0];
  t('deep 7KB → 不报 split', !r.flags.some((f) => f.code === 'split'), JSON.stringify(r.flags.map((f) => f.code)));
}
// deep 20KB → 应报 split（>16KB 建议拆）
{
  const r = diagnose([mk('deep', 20)]).rows[0];
  t('deep 20KB → split WARN', r.flags.some((f) => f.code === 'split'), JSON.stringify(r.flags.map((f) => f.code)));
}
// deep 25KB → 应 FAIL too_big（>24KB）
{
  const r = diagnose([mk('deep', 25)]).rows[0];
  t('deep 25KB → FAIL too_big', r.flags.some((f) => f.code === 'too_big' && f.level === 'FAIL'), JSON.stringify(r.flags.map((f) => f.code)));
}
// guide 13KB → FAIL too_big（>12KB）
{
  const r = diagnose([mk('guide', 13)]).rows[0];
  t('guide 13KB → FAIL too_big', r.flags.some((f) => f.code === 'too_big' && f.level === 'FAIL'), JSON.stringify(r.flags.map((f) => f.code)));
}

console.log(`\n  结果：通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);