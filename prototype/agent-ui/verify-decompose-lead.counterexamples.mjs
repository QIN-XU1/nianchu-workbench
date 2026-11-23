#!/usr/bin/env node
/**
 * 领先幅度分解 · 反例自检
 * 证明 decompose/verdictOf 的判定会红，不是恒真。
 */
import { decompose, verdictOf, score, classify } from '../../tools/evolve/decompose-lead.mjs';

let pass = 0, total = 0;
const lines = [];
const T = (n, ok, w) => { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)); };

// ── 分值口径 ──
T('正例 · 有=1', score('有') === 1, 'wrong');
T('正例 · 部分=0.5', score('部分') === 0.5, 'wrong');
T('正例 · 无=0', score('无') === 0, 'wrong');

// ── classify 支持对象数组（本轮修的 bug）──
const confObj = { both: [{ id: 'X1' }], mixed: [{ id: 'X2' }], ours: [{ id: 'X3' }], none: [{ id: 'X4' }] };
T('正例 · classify 支持对象数组 both', classify('X1', confObj) === 'both', classify('X1', confObj));
T('正例 · classify 支持对象数组 mixed', classify('X2', confObj) === 'mixed', 'wrong');
T('正例 · classify 未收录 ⇒ none', classify('ZZ', confObj) === 'none', 'wrong');
T('正例 · classify 无 conf ⇒ none', classify('X1', null) === 'none', 'wrong');

// ── 构造场景：全部 both 且我们领先 ⇒ PASS ──
const mkDim = (id, us, ref) => ({ id, name: id, us: [us, 'x'], openclaw: [ref, 'y'] });
const dimsLead = [mkDim('D1', '有', '部分'), mkDim('D2', '有', '有')];
const confAllBoth = { both: [{ id: 'D1' }, { id: 'D2' }], mixed: [], ours: [], none: [] };
const dLead = decompose(dimsLead, confAllBoth);
T('正例 · 双方可核验且我们领先 ⇒ margin>0', dLead.bothOnly.margin > 0, JSON.stringify(dLead.bothOnly));
T('正例 · 判 PASS', verdictOf(dLead) === 'PASS', verdictOf(dLead));

// ── 反例：自评领先但可信口径不领先 ⇒ WARN（领先不可信）──
const dimsTrap = [
  { id: 'B1', name: 'B1', us: ['有', 'x'], openclaw: ['无', 'y'] },      // both，我们领先
  { id: 'O1', name: 'O1', us: ['有', 'x'], openclaw: ['无', 'y'] },      // ours（不可核验）
  { id: 'O2', name: 'O2', us: ['有', 'x'], openclaw: ['无', 'y'] },      // ours
];
const confTrap = { both: [{ id: 'B1' }], mixed: [], ours: [{ id: 'O1' }, { id: 'O2' }], none: [] };
// 让 both 维我们与参照打平，靠 ours 维撑出领先
const dimsTrap2 = [
  { id: 'B1', name: 'B1', us: ['有', 'x'], openclaw: ['有', 'y'] },      // both，打平
  { id: 'O1', name: 'O1', us: ['有', 'x'], openclaw: ['无', 'y'] },      // ours，我们领先
  { id: 'O2', name: 'O2', us: ['有', 'x'], openclaw: ['无', 'y'] },      // ours，我们领先
];
const dTrap = decompose(dimsTrap2, confTrap);
T('反例 · 自评领先但可信打平 ⇒ 判 WARN（不是 PASS）',
  dTrap.all.margin > 0 && dTrap.bothOnly.margin === 0 && verdictOf(dTrap) === 'WARN',
  JSON.stringify({ all: dTrap.all.margin, both: dTrap.bothOnly.margin, v: verdictOf(dTrap) }));

// ── 反例：自评也落后 ⇒ FAIL ──
const dimsBehind = [{ id: 'B1', name: 'B1', us: ['无', 'x'], openclaw: ['有', 'y'] }];
const dBehind = decompose(dimsBehind, { both: [{ id: 'B1' }], mixed: [], ours: [], none: [] });
T('反例 · 自评也落后 ⇒ FAIL', verdictOf(dBehind) === 'FAIL', verdictOf(dBehind));

// ── 反例：both 为 0 ⇒ UNKNOWN（不是 PASS）──
const dNoBoth = decompose([mkDim('O1', '有', '无')], { both: [], mixed: [], ours: [{ id: 'O1' }], none: [] });
T('反例 · 没有双方可核验维 ⇒ UNKNOWN（不判 PASS）', verdictOf(dNoBoth) === 'UNKNOWN', verdictOf(dNoBoth));

// ── 正例：可复算（同输入两次一致）──
T('正例 · 可复算', JSON.stringify(decompose(dimsLead, confAllBoth)) === JSON.stringify(decompose(dimsLead, confAllBoth)), '不一致');

// ── 反例：不存在的 id 不会被算进 both ──
const dGhost = decompose([mkDim('G1', '有', '无')], { both: [{ id: 'NOT_THERE' }], mixed: [], ours: [], none: [] });
T('反例 · conf 里的 id 与矩阵不符 ⇒ 归 none（不虚增 both）', dGhost.counts.both === 0, JSON.stringify(dGhost.counts));

const ok = pass === total;
console.log('  领先幅度分解 · 反例自检');
console.log(lines.join('\n'));
console.log('\n  自检 ' + pass + '/' + total + ' · 四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
