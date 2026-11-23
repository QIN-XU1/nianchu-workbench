#!/usr/bin/env node
/**
 * 多代理协作协议（A9）的反例测试。
 *
 * 纪律：每条规则都要有「该发生」和「**不该发生**」两面。
 * 尤其是「私有收件箱」和「按 cause_by 过滤」—— 只测「能收到」是假检查，
 * 必须测「**收不到**」。
 */
import { makeMessage, createBus, runTeam } from './bus.mjs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ← ' + detail : '')); }
};

// ── 1. 消息三字段 ──
{
  let threw = false;
  try { makeMessage({ causeBy: 'x' }); } catch { threw = true; }
  t('反例：缺 sentFrom 抛错（不静默造消息）', threw);

  threw = false;
  try { makeMessage({ sentFrom: 'a' }); } catch { threw = true; }
  t('反例：缺 causeBy 抛错（订阅靠它，不能空）', threw);

  const m = makeMessage({ sentFrom: 'a', causeBy: 'req', content: 'hi' });
  t('正例：消息带 id/sentFrom/causeBy', !!m.id && m.sentFrom === 'a' && m.causeBy === 'req', JSON.stringify(m));
}

// ── 2. 路由：点名 vs 订阅 ──
{
  const bus = createBus();
  bus.join('writer', { watch: ['task'] });
  bus.join('reviewer', { watch: ['draft'] });
  bus.join('bystander', { watch: [] });

  const d1 = bus.publish(makeMessage({ sentFrom: 'pm', causeBy: 'task', content: 'write' }));
  t('正例：订阅了 task 的角色收到', d1.includes('writer'), JSON.stringify(d1));
  t('★反例：没订阅 task 的角色**收不到**', !d1.includes('reviewer'), JSON.stringify(d1));
  t('★反例：无订阅的旁观者收不到任何广播', !d1.includes('bystander'), JSON.stringify(d1));

  const d2 = bus.publish(makeMessage({ sentFrom: 'writer', causeBy: 'draft', content: 'done' }));
  t('正例：订阅了 draft 的 reviewer 收到', d2.includes('reviewer'), JSON.stringify(d2));
  t('★反例：writer 没订阅 draft，收不到自己的下游', !d2.includes('writer'), JSON.stringify(d2));
}

// ── 3. 私有收件箱（关键）──
{
  const bus = createBus();
  bus.join('a', { watch: ['x'] });
  bus.join('b', { watch: ['x'] });
  bus.publish(makeMessage({ sentFrom: 'z', causeBy: 'x' }));

  t('正例：a 的收件箱有 1 条', bus.inboxOf('a').length === 1);
  t('正例：b 的收件箱也有 1 条（订阅相同各收一份）', bus.inboxOf('b').length === 1);

  bus.drain('a');
  t('★反例：a 取走后，b 的收件箱**不受影响**', bus.inboxOf('a').length === 0 && bus.inboxOf('b').length === 1);
  t('★反例：访问不存在的角色抛错', (() => { try { bus.inboxOf('nope'); return false; } catch { return true; } })());
}

// ── 4. 点名投递优先于订阅 ──
{
  const bus = createBus();
  bus.join('a', { watch: ['x'] });
  bus.join('b', { watch: ['x'] });
  const d = bus.publish(makeMessage({ sentFrom: 'z', causeBy: 'x', sendTo: 'a' }));
  t('正例：点名发给 a，只有 a 收到', d.length === 1 && d[0] === 'a', JSON.stringify(d));
  t('★反例：点名时订阅了同一 causeBy 的 b **收不到**', bus.pending('b') === 0);
}

// ── 5. 重复加入 ──
{
  const bus = createBus();
  bus.join('a', {});
  let threw = false;
  try { bus.join('a', {}); } catch { threw = true; }
  t('反例：同名角色重复加入抛错（不静默覆盖）', threw);
}

// ── 6. 收敛四闸 ──
{
  // ① 自然结束
  const bus = createBus();
  bus.join('a', { watch: ['x'] });
  const r = runTeam(bus, [{ name: 'a', handle() {} }], { maxRounds: 5 });
  t('正例：没消息 ⇒ idle（不空转）', r.state === 'idle' && r.rounds === 0, JSON.stringify(r));
}
{
  // ② 轮数上限：两个角色互相喂消息，必须被 capped 截住
  const bus = createBus();
  bus.join('a', { watch: ['fromB'] });
  bus.join('b', { watch: ['fromA'] });
  bus.publish(makeMessage({ sentFrom: 'seed', causeBy: 'fromA' }));
  const roles = [
    { name: 'a', handle(m, bs) { bs.publish(makeMessage({ sentFrom: 'a', causeBy: 'fromB' })); } },
    { name: 'b', handle(m, bs) { bs.publish(makeMessage({ sentFrom: 'b', causeBy: 'fromA' })); } },
  ];
  const r = runTeam(bus, roles, { maxRounds: 4 });
  t('正例：互相喂消息时被 maxRounds 截住（不死循环）', r.state === 'capped' && r.rounds === 4, JSON.stringify(r));
}
{
  // ③ 预算
  const bus = createBus();
  bus.join('a', { watch: ['x'] });
  for (let i = 0; i < 10; i++) bus.publish(makeMessage({ sentFrom: 'z', causeBy: 'x' }));
  const r = runTeam(bus, [{ name: 'a', handle() {} }], { maxRounds: 10, budget: 3 });
  t('正例：预算 3 ⇒ 只处理 3 条后 budget_exhausted', r.state === 'budget_exhausted' && r.handled === 3, JSON.stringify(r));
}
{
  // ④ 处理抛错
  const bus = createBus();
  bus.join('a', { watch: ['x'] });
  bus.publish(makeMessage({ sentFrom: 'z', causeBy: 'x' }));
  const r = runTeam(bus, [{ name: 'a', handle() { throw new Error('boom'); } }], { maxRounds: 3 });
  t('正例：角色处理抛错 ⇒ error（不吞）', r.state === 'error' && /boom/.test(r.why), JSON.stringify(r));
}
{
  // 正常跑完
  const bus = createBus();
  bus.join('writer', { watch: ['task'] });
  bus.join('reviewer', { watch: ['draft'] });
  bus.publish(makeMessage({ sentFrom: 'pm', causeBy: 'task' }));
  const roles = [
    { name: 'writer', handle(m, bs) { bs.publish(makeMessage({ sentFrom: 'writer', causeBy: 'draft' })); } },
    { name: 'reviewer', handle() {} },
  ];
  const r = runTeam(bus, roles, { maxRounds: 5 });
  t('正例：任务→草稿→评审 两轮内自然结束', (r.state === 'drained' || r.state === 'idle') && r.handled === 2, JSON.stringify(r));
}

// ── 7. journal 完整（可回放）──
{
  const bus = createBus();
  bus.join('a', { watch: ['x'] });
  bus.publish(makeMessage({ sentFrom: 'z', causeBy: 'x' }));
  bus.publish(makeMessage({ sentFrom: 'z', causeBy: 'y' }));
  t('正例：journal 记录所有发布（含没人订阅的）', bus.journal().length === 2, String(bus.journal().length));
}

console.log('');
// ── 存活变异体 M11（2026-11-18 独立审计）：inboxOf 必须返回**拷贝** ──
// 审计员把 `return m.inbox.slice()` 改成 `return m.inbox`（返回内部数组），
// 21 条测试**全部仍然绿**。这条锁住它：改动返回值不许影响内部状态。
{
  const bus = createBus();
  bus.join('a');
  bus.join('b');
  bus.publish(makeMessage({ sentFrom: 'a', sendTo: 'b', causeBy: 'k', content: 'x' }));
  const got = bus.inboxOf('b');
  got.length = 0;                                   // 外部清空返回值
  t('★反例：清空 inboxOf 的返回值不许影响内部收件箱（必须返回拷贝，M11）',
    bus.pending('b') === 1, 'pending=' + bus.pending('b'));
}
{
  const bus = createBus();
  bus.join('a');
  bus.join('b');
  bus.publish(makeMessage({ sentFrom: 'a', sendTo: 'b', causeBy: 'k', content: 'x' }));
  const got = bus.inboxOf('b');
  got.push({ id: 'fake', causeBy: 'k' });           // 外部往返回值里塞假消息
  t('★反例：往 inboxOf 返回值里塞消息不许进内部收件箱（M11）',
    bus.pending('b') === 1, 'pending=' + bus.pending('b'));
}

console.log('  多代理协作协议反例测试：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
