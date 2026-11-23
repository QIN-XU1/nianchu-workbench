// 把独立审计结果与我们的自评逐维对照，算出「假绿」清单。
// 反例保护：若审计结果缺失、维度数对不上、或审计全部给「有」，必须报红 ——
// 否则这个对照本身就成了摆设。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const load = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const matrix = load('prototype/hermes-agents/matrix-data.json');
const auditPath = 'evidence/evolve/independent-audit-result.json';

const issues = [];
if (!existsSync(join(ROOT, auditPath))) {
  issues.push('审计结果不存在: ' + auditPath);
  console.log('  ❌ ' + issues.join(' · '));
  process.exit(1);
}
const audit = load(auditPath);

/** 我们自己的判定 */
const ours = [];
for (const g of matrix.dimensions) {
  for (const it of g.items) {
    ours.push({ id: it.id, name: it.name, group: g.group, ourVerdict: Array.isArray(it.us) ? it.us[0] : String(it.us) });
  }
}

const auditById = new Map((audit.items || []).map((x) => [x.id, x]));

// ── 反例保护 ──
if (ours.length === 0) issues.push('矩阵没有维度');
if ((audit.items || []).length !== ours.length) {
  issues.push('审计维度数 ' + (audit.items || []).length + ' ≠ 矩阵维度数 ' + ours.length);
}
const missing = ours.filter((o) => !auditById.has(o.id)).map((o) => o.id);
if (missing.length) issues.push('审计漏了这些维度: ' + missing.join(','));
const allPass = ours.every((o) => (auditById.get(o.id) || {}).verdict === '有');
if (allPass) issues.push('审计把所有维度都判成「有」—— 这个审计没有区分力，不可信');

const rows = ours.map((o) => {
  const a = auditById.get(o.id) || {};
  const verdict = a.verdict || '缺失';
  return {
    id: o.id,
    name: o.name,
    group: o.group,
    ourVerdict: o.ourVerdict,
    auditVerdict: verdict,
    reason: a.reason || '',
    // 假绿 = 我们声称「有」，独立审计不认可「有」
    fakeGreen: o.ourVerdict === '有' && verdict !== '有',
    // 误伤 = 我们声称「部分/无」，审计认为「有」（可能是我们过于保守）
    underClaimed: (o.ourVerdict === '部分' || o.ourVerdict === '无') && verdict === '有',
  };
});

const count = (k) => rows.filter((r) => r[k]).length;
const byAudit = {};
for (const r of rows) byAudit[r.auditVerdict] = (byAudit[r.auditVerdict] || 0) + 1;

const out = {
  _what: '独立审计 ↔ 自评 逐维对照。fakeGreen = 我们声称「有」但独立审计不认可。',
  at: new Date().toISOString(),
  auditor: audit.auditor || 'unknown',
  total: rows.length,
  issues,
  ok: issues.length === 0,
  summary: {
    ourVerdicts: rows.reduce((m, r) => ((m[r.ourVerdict] = (m[r.ourVerdict] || 0) + 1), m), {}),
    auditVerdicts: byAudit,
    fakeGreen: count('fakeGreen'),
    underClaimed: count('underClaimed'),
  },
  rows,
};

writeFileSync(join(ROOT, 'evidence/evolve/matrix-vs-audit.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log('  对照 ' + rows.length + ' 维');
console.log('  我们的判定: ' + JSON.stringify(out.summary.ourVerdicts));
console.log('  审计的判定: ' + JSON.stringify(byAudit));
console.log('  ❌ 假绿（我们说「有」、审计不认）: ' + count('fakeGreen'));
for (const r of rows.filter((x) => x.fakeGreen)) {
  console.log('    ' + r.id + ' ' + r.name + '  审计=' + r.auditVerdict);
}
console.log('  ⚠ 我们偏保守（我们说部分/无、审计说「有」）: ' + count('underClaimed'));
console.log('  反例保护: ' + (issues.length ? '❌ ' + issues.join(' · ') : '✅ 通过（审计有区分力、无漏项）'));
process.exit(issues.length === 0 ? 0 : 1);
