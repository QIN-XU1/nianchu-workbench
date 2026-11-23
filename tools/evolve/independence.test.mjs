#!/usr/bin/env node
/**
 * 独立性检查的反例测试 —— 每条都要能红。
 * 用法：node tools/evolve/independence.test.mjs
 *
 * 为什么这些反例重要：
 *   `independent` 是我可以随手写 true 的字段。如果检查器只认这个布尔值，
 *   那 T1「≥3 轮由非实现方独立验证」就是我自己说了算 —— 那是假绿。
 *   这里锁住的是「台账自己说不算独立，就不许记 closed」。
 */
import { checkIndependence, countIndependentClosed, SELF_DENIES, INDEPENDENT_VERIFIER } from './independence.mjs';

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const eff = (e) => (e.disputedBy ? 'refuted' : e.status);

// ── 自认非独立却记 closed ──
{
  const e = {
    id: 'H-X1', status: 'closed', independent: true, verifier: 'v-y',
    notes: ['C5：验证方与实现方是同一个（lead）⇒ 状态降为「部分」，不算独立验证'],
  };
  const r = checkIndependence(e, eff);
  t('★反例：notes 自认「不算独立验证」却记 closed ⇒ 必须报出', !!r, String(r));
}
{
  const e = { id: 'H-X2', status: 'closed', independent: true, verifier: 'v-ok', notes: ['正常验证，独立子代理跑的'] };
  t('正例：notes 没自认非独立 ⇒ 不报', checkIndependence(e, eff) === null, String(checkIndependence(e, eff)));
}
{
  const e = { id: 'H-X3', status: 'partial', independent: false, notes: ['不算独立验证'] };
  t('正例：已是 partial ⇒ 不重复报（状态本来就对）', checkIndependence(e, eff) === null, String(checkIndependence(e, eff)));
}

// ── 自己验自己却记 closed ──
{
  const e = { id: 'H-X4', status: 'closed', independent: false, verifier: 'lead' };
  const r = checkIndependence(e, eff);
  t('★反例：independent=false 却记 closed ⇒ 必须报出', !!r, String(r));
}
{
  const e = { id: 'H-X5', status: 'closed', independent: true, verifier: 'independent-subagent(x)' };
  t('正例：真独立 ⇒ 不报', checkIndependence(e, eff) === null, String(checkIndependence(e, eff)));
}

// ── 被驳回的条目 ──
{
  const e = { id: 'H-X6', status: 'closed', independent: true, disputedBy: 'H-X99', notes: ['不算独立验证'] };
  t('正例：已被驳回（有效状态 refuted）⇒ 不按 closed 判', checkIndependence(e, eff) === null, String(checkIndependence(e, eff)));
}

// ── 坏输入 ──
{
  t('★反例：null 输入 ⇒ 不崩、返回 null', checkIndependence(null, eff) === null);
  t('★反例：字符串输入 ⇒ 不崩', checkIndependence('x', eff) === null);
}

// ── 独立数统计口径 ──
{
  const entries = [
    { id: 'a', status: 'closed', verifier: 'independent-subagent(p)' },
    { id: 'b', status: 'closed', verifier: 'v-y' },              // 名字没有独立性证据，不算
    { id: 'c', status: 'closed', verifier: 'independent-subagent(q)' },
    { id: 'd', status: 'closed', verifier: 'independent-subagent(r)', disputedBy: 'x' },  // 被驳回，不算
    { id: 'e', status: 'partial', verifier: 'independent-subagent(s)' },
  ];
  const r = countIndependentClosed(entries, eff);
  t('★反例：只数 verifier 明确是独立子代理的（v-y 这类不算）', r.independent === 2, JSON.stringify(r));
  t('★反例：被驳回的不计入', !r.ids.includes('d'), JSON.stringify(r.ids));
  t('★反例：partial 的不计入', !r.ids.includes('e'), JSON.stringify(r.ids));
}

// ── 正则本身 ──
{
  t('正例：SELF_DENIES 认得「不算独立」', SELF_DENIES.test('这不算独立验证'));
  t('★反例：SELF_DENIES 不该匹配「已由独立子代理验证」', !SELF_DENIES.test('已由独立子代理验证'));
  t('正例：INDEPENDENT_VERIFIER 认得 independent-subagent(audit-x)', INDEPENDENT_VERIFIER.test('independent-subagent(audit-x)'));
  t('★反例：INDEPENDENT_VERIFIER 不认 v-y', !INDEPENDENT_VERIFIER.test('v-y'));
}

console.log('\n  独立性检查反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
