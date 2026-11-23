/**
 * 重开（reopen）—— 把 status=unknown 的条目退回 open，以便补足样本后重测
 *
 * 【2026-11-17 加】起因：独立验证方 v-h0085 发现 record() 只接受 status==='open'，
 * 而 attest() 一律拒绝 verdict==='unknown'，CLI 又没有 reopen ——
 * 于是台账里 31 条 unknown 条目**永久锁死**，即使后来补够样本也无处可写。
 *
 * 这违背 C2 原则的后半句：「判不了就说判不了」做到了，
 * 但「后来判得了怎么办」没有出口。没有出口的 C2 会变成永久黑洞。
 *
 * 放在独立文件是因为 evolve.mjs 有 32KB 硬红线。
 * 用 makeReopen({load, save}) 注入依赖，避免循环 import。
 */

export function makeReopen({ load, save }) {
  return function reopen({ id, why, by = 'lead' }) {
    if (!id) return { ok: false, reasons: ['必须指定 id'] };
    if (!why || String(why).trim().length < 10) {
      return { ok: false, reasons: ['必须写明重开理由（至少 10 字）—— 无理由重开等于把 C2 当摆设'] };
    }
    const j = load();
    const e = j.entries.find((x) => x.id === id);
    if (!e) return { ok: false, reasons: [id + ' 不存在'] };
    if (e.status !== 'unknown') {
      return {
        ok: false,
        reasons: [id + ' 当前 status=' + e.status
          + '，只有 unknown 可以重开（不许动已结案或已判定的）'],
      };
    }
    if (e.disputedBy) return { ok: false, reasons: [id + ' 已被驳回，不许重开'] };

    const now = new Date().toISOString();
    e.reopenReasons = e.reopenReasons || [];
    e.reopenReasons.push({ at: now, by, why: String(why).slice(0, 300) });
    e.reopenedAt = now;
    e.reopenedBy = by;
    e.statusBeforeReopen = 'unknown';
    e.status = 'open';
    save(j);
    return { ok: true, id, from: 'unknown', to: 'open' };
  };
}

/** 自检：3 正例 + 4 反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const mk = (entries) => makeReopen({
    load: () => ({ entries: JSON.parse(JSON.stringify(entries)) }),
    save: (j) => { entries.length = 0; entries.push(...j.entries); },
  });

  // 正例：unknown → open
  const a = [{ id: 'H-1', status: 'unknown' }];
  const r1 = mk(a)({ id: 'H-1', why: '补够了 12 个样本，重新测一次' });
  T('正例 · unknown 可以重开', r1.ok && r1.to === 'open', JSON.stringify(r1));
  T('正例 · 重开后 status 变成 open', a[0].status === 'open', a[0].status);
  T('正例 · 留痕写明理由', Array.isArray(a[0].reopenReasons)
    && a[0].reopenReasons.length === 1, JSON.stringify(a[0].reopenReasons));

  // 反例
  const b = [{ id: 'H-2', status: 'closed' }];
  T('反例 · closed 不许重开（防篡改已结案）',
    !mk(b)({ id: 'H-2', why: '想重新测一遍这个已结案的' }).ok, '');
  const c = [{ id: 'H-3', status: 'unknown' }];
  T('反例 · 无理由不许重开', !mk(c)({ id: 'H-3', why: '' }).ok, '');
  T('反例 · 理由太短不许重开', !mk(c)({ id: 'H-3', why: '重开' }).ok, '');
  const d = [{ id: 'H-4', status: 'unknown', disputedBy: 'H-9' }];
  T('反例 · 已被驳回的不许重开', !mk(d)({ id: 'H-4', why: '这个其实是对的让我再测' }).ok, '');

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = /[\\/]reopen\.mjs$/.test(process.argv[1] || '');
if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  reopen 自检');
  console.log('  ' + '─'.repeat(64));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}
