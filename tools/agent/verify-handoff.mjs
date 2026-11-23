/**
 * 派单闭环验证 —— 反例密集。
 *
 * 【要证明什么】这套东西的价值不在「能记录状态」，而在**能主动报出失败模式**。
 * 所以每条判据都对着一个真实翻车场景：
 *   进黑洞（派出没人接）/ 双方互等（都以为对方在做）/
 *   没证据就回执（"我做了"）/ 跳级（没认领就交活）/ 干完没销账
 *
 * 用法：node tools/agent/verify-handoff.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATES, TRANSITIONS, canTransition, issue, ack, startWork, receipt, close, audit, list,
} from './handoff.mjs';
import { USER_DATA_DIR } from './runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(USER_DATA_DIR, 'handoffs', 'ledger.json');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  派单闭环验证（五态 / 超时升级 / 销账）');
console.log('  ' + '─'.repeat(72));

// ══ 一、状态机本身 ══
{
  t('五态齐全', STATES.length === 5 && ['issued', 'acked', 'working', 'receipted', 'closed']
    .every((s) => STATES.includes(s)));
  t('合法转移：issued → acked', canTransition('issued', 'acked') === true);
  t('★反例：不许跳级 issued → receipted（没认领就交活）',
    canTransition('issued', 'receipted') === false);
  t('★反例：不许跳级 issued → working', canTransition('issued', 'working') === false);
  t('★反例：closed 是终态，不能再转', (TRANSITIONS.closed || []).length === 0
    && canTransition('closed', 'issued') === false);
  t('允许撤回：issued → closed', canTransition('issued', 'closed') === true);
}

// ══ 二、正常闭环 + 反例（临时污染账本 → 还原）══
{
  mkdirSync(dirname(LEDGER), { recursive: true });
  const backup = existsSync(LEDGER) ? readFileSync(LEDGER) : null;
  try {
    // 参数校验
    t('★反例：缺 title 拒绝', issue({ to: 'a', spec: 'b' }).state === 'FAIL');
    t('★反例：缺 to 拒绝', issue({ title: 'a', spec: 'b' }).state === 'FAIL');
    t('★反例：缺 spec 拒绝', issue({ title: 'a', to: 'b' }).state === 'FAIL');

    // 正常一单，走完五态
    const r1 = issue({ title: '补 A6 记忆分层', to: 'implementer', spec: 'core 预算 2KB 生效', criteria: 'verify-memory-budget 20/20' });
    t('派单成功且初始 issued', r1.state === 'PASS' && r1.item.status === 'issued', JSON.stringify(r1).slice(0, 120));
    const id1 = r1.item.id;

    t('★反例：未认领就回执 → 被拒（非法转移）',
      receipt({ id: id1, conclusion: '做完了', evidence: 'xxx' }).state === 'FAIL');

    t('认领成功 → acked', ack({ id: id1 }).state === 'PASS');
    t('开工成功 → working', startWork({ id: id1 }).state === 'PASS');

    t('★反例：回执缺结论 → 拒收', receipt({ id: id1, evidence: 'x' }).state === 'FAIL');
    t('★反例：回执缺证据 → 拒收（不接受"我做了"）',
      receipt({ id: id1, conclusion: '做完了' }).state === 'FAIL');

    const rc = receipt({ id: id1, conclusion: '已生效', evidence: 'verify-memory-budget.mjs 20/20 PASS', paths: ['tools/agent/memory-budget.mjs'] });
    t('带结论+证据的回执成功 → receipted', rc.state === 'PASS' && rc.item.status === 'receipted');
    t('回执里存了证据与路径',
      rc.item.receipt.evidence.length > 0 && rc.item.receipt.paths.length > 0);

    const cl = close({ id: id1, reason: '验收通过' });
    t('销账成功 → closed', cl.state === 'PASS' && cl.item.status === 'closed');
    t('★反例：销账后再操作 → 拒绝（终态）', close({ id: id1 }).state === 'FAIL');

    t('历史留痕完整（5 步）', cl.item.history.length >= 5,
      String(cl.item.history.length));

    // ── 失败模式：进黑洞 ──
    const bh = issue({ title: '没人接的活', to: 'ghost', spec: 'x', ackTimeoutMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const audit1 = audit();
    t('★体检报出「进黑洞」（超时未认领）',
      audit1.problems.some((p) => p.kind === 'blackhole' && p.id === bh.item.id),
      JSON.stringify(audit1.problems.map((p) => p.kind)));
    t('★有黑洞时整体判 FAIL（不是 WARN）', audit1.state === 'FAIL', audit1.state);

    // ── 失败模式：双方互等 ──
    const mw = issue({ title: '互等的活', to: 'implementer', spec: 'y', receiptTimeoutMs: 1 });
    ack({ id: mw.item.id });
    startWork({ id: mw.item.id });
    await new Promise((r) => setTimeout(r, 10));
    const audit2 = audit();
    t('★体检报出「双方互等」（执行超时未回执）',
      audit2.problems.some((p) => p.kind === 'mutual-wait' && p.id === mw.item.id),
      JSON.stringify(audit2.problems.map((p) => p.kind)));

    // ── 提醒：干完没销账 ──
    const un = issue({ title: '干完没销账', to: 'implementer', spec: 'z' });
    ack({ id: un.item.id });
    startWork({ id: un.item.id });
    receipt({ id: un.item.id, conclusion: 'done', evidence: 'evidence' });
    const audit3 = audit();
    t('★报出「已回执未销账」（干完但对方不知道）',
      audit3.problems.some((p) => p.kind === 'unclosed' && p.id === un.item.id));

    // ── 未知 id ──
    t('★反例：未知 id → UNKNOWN 而不是假装成功',
      ack({ id: 'ho-nope' }).state === 'UNKNOWN');

    // ── list 过滤 ──
    const closedList = list({ status: 'closed' });
    t('list 能按状态过滤', Array.isArray(closedList) && closedList.every((x) => x.status === 'closed'));

    // ── 全部销账后体检应干净（清掉刚才造的失败单）──
    for (const it of list({ limit: 200 })) {
      if (it.status !== 'closed') close({ id: it.id, reason: '测试清理' });
    }
    const audit4 = audit();
    t('全部销账后体检无致命问题',
      !audit4.problems.some((p) => ['blackhole', 'mutual-wait', 'no-evidence'].includes(p.kind)),
      JSON.stringify(audit4.problems.map((p) => p.kind)));
  } finally {
    if (backup !== null) writeFileSync(LEDGER, backup);
    else if (existsSync(LEDGER)) writeFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), items: [] }, null, 2));
  }
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 五态不可跳级、回执必须有证据、黑洞/互等/未销账都能主动报出'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;