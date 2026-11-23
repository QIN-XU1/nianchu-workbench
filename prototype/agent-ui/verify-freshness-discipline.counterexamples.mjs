#!/usr/bin/env node
/**
 * 新鲜度纪律验收器 · 反例自检
 * 证明 checkScene 的判定真的会红，而不是恒真。
 */
import { checkScene } from './verify-freshness-discipline.mjs';

let pass = 0, total = 0;
const lines = [];
const T = (n, ok, w) => { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)); };

const WITH_TIME = { at: '2026-11-15T00:00:00Z', projects: [] };
const NO_TIME = { projects: [] };

// ── 正例：用了 FreshnessNotice ⇒ compliant ──
T('正例 · 有 timestamp + 用 FreshnessNotice ⇒ compliant',
  checkScene('A.tsx', "import p from './data/p.json';\n<FreshnessNotice at={p.at} />", WITH_TIME).status === 'compliant', 'not compliant');

T('正例 · 有 timestamp + 用 applyFreshness ⇒ compliant',
  checkScene('B.tsx', "import p from './data/p.json';\nconst f = applyFreshness('PASS', p.at);", WITH_TIME).status === 'compliant', 'not compliant');

// ── 反例：有 timestamp 但没用新鲜度 ⇒ violation（这就是本轮修的那类假绿）──
const v = checkScene('C.tsx', "import p from './data/p.json';\nconst n = p.projects.length;", WITH_TIME);
T('反例 · 有 timestamp 但没用新鲜度 ⇒ violation', v.status === 'violation', v.status);
T('反例 · violation 里带出时间字段名', v.violations.length === 1 && v.violations[0].timeKeys.includes('at'),
  JSON.stringify(v.violations));

// ── 正例：文件没有 timestamp ⇒ 不要求（不误伤）──
T('正例 · 数据无 timestamp ⇒ no_timestamp（不算违规）',
  checkScene('D.tsx', "import p from './data/p.json';\nconst n = p.projects.length;", NO_TIME).status === 'no_timestamp', 'wrong');

// ── 正例：不读 data 的场景 ⇒ 不要求 ──
T('正例 · 不 import data ⇒ no_data（不算违规）',
  checkScene('E.tsx', "import x from './foo';\nconst a = 1;", WITH_TIME).status === 'no_data', 'wrong');

// ── 反例：只显示年龄文字、不用机制 ⇒ 仍 violation ──
T('反例 · 只算年龄不用机制 ⇒ violation',
  checkScene('F.tsx', "import p from './data/p.json';\nconst age = Date.now() - new Date(p.at).getTime();", WITH_TIME).status === 'violation', 'wrong');

// ── 反例：generatedAt 也要被识别 ──
T('反例 · generatedAt 也识别 ⇒ violation',
  checkScene('G.tsx', "import p from './data/p.json';\nconst n = 1;", { generatedAt: '2026-11-14T00:00:00Z' }).status === 'violation', 'wrong');

const ok = pass === total;
console.log('  新鲜度纪律验收器 · 反例自检');
console.log(lines.join('\n'));
console.log('\n  自检 ' + pass + '/' + total + ' · 四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
