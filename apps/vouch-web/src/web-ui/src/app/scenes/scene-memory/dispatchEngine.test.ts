import { describe, it, expect } from 'vitest';
import {
  isDispatch,
  validateFour,
  buildMessage,
  computeStatus,
  ledger,
  dedupAppend,
  canSendMore,
  receiptOfNoticeResponse,
  makeDispatchTicket,
  THRESHOLDS,
  type Ticket,
} from './dispatchEngine';

const now = 1_000_000_000_000;
const mk = (o: Partial<Ticket>): Ticket => ({
  hash: 'h1', from: 'A', to: 'B', at: now, kind: 'dispatch', route: 'RPC-200', delivered: true, ack: false, ...o,
});

describe('dispatchEngine · 派单/回执状态机（含反例）', () => {
  it('判据：公告句不算派单，派单句算', () => {
    expect(isDispatch('以后就这么办了，请注意一下')).toBe(false);
    expect(isDispatch('请你改一下，做完回一句')).toBe(true);
  });

  it('反例1：四件套缺「怎么验」必须失败', () => {
    const r = validateFour({ phenomenon: '报错', howTo: '§6.4', howVerify: '', wantReceipt: true });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_howVerify')).toBe(true);
  });

  it('四件套齐全 ⇒ 通过', () => {
    const r = validateFour({ phenomenon: '报错', howTo: '§6.4', howVerify: '跑 mjs 应 0', wantReceipt: true });
    expect(r.ok).toBe(true);
  });

  it('消息首行标记 + 末行【结束】', () => {
    expect(buildMessage({ wantReceipt: true, body: 'x' }).text.startsWith('【需要回执】')).toBe(true);
    expect(buildMessage({ wantReceipt: false, body: 'x' }).text.startsWith('【不需要回执·知悉】')).toBe(true);
    expect(buildMessage({ wantReceipt: true, body: 'x' }).text.endsWith('【结束】')).toBe(true);
  });

  it('反例2：派单超 2h 未回执 ⇒ overdue', () => {
    expect(computeStatus(mk({ at: now - THRESHOLDS.overdueMs - 1 }), now)).toBe('overdue');
    expect(computeStatus(mk({ at: now - 1000 }), now)).toBe('dispatched');
    expect(computeStatus(mk({ ack: true }), now)).toBe('received');
  });

  it('公告永不 overdue（不追回执）', () => {
    expect(computeStatus(mk({ kind: 'notice', at: now - THRESHOLDS.overdueMs - 1 }), now)).toBe('dispatched');
  });

  it('台账：黑洞 / 我欠人 / 人等我', () => {
    const tickets = [
      mk({ hash: 'x1', from: 'A', to: 'B', at: now - THRESHOLDS.overdueMs - 1 }), // A 发出，超时 → 黑洞 + iOwe
      mk({ hash: 'x2', from: 'C', to: 'A', at: now - 1000 }),                    // 人等我（A）
      mk({ hash: 'x3', from: 'A', to: 'B', ack: true }),                          // 已回执
    ];
    const l = ledger(tickets, 'A', now);
    expect(l.blackHole.map((t) => t.hash)).toContain('x1');
    expect(l.iOwe.map((t) => t.hash)).toContain('x1');
    expect(l.othersAwaitMe.map((t) => t.hash)).toContain('x2');
    expect(l.received.map((t) => t.hash)).toContain('x3');
  });

  it('反例3：按 hash 去重，同内容只进一次', () => {
    let st = dedupAppend([], mk({ hash: 'same' }));
    expect(st.added).toBe(true);
    st = dedupAppend(st.tickets, mk({ hash: 'same', note: 'again' }));
    expect(st.added).toBe(false);
    expect(st.tickets.length).toBe(1);
  });

  it('反例4：同一件事 ≥3 条禁止再发', () => {
    expect(canSendMore(2).ok).toBe(true);
    expect(canSendMore(3).ok).toBe(false);
  });

  it('反例5：收到知悉不许回', () => {
    expect(receiptOfNoticeResponse().ok).toBe(false);
  });

  it('反例6：正文超 200 字告警', () => {
    const r = buildMessage({ wantReceipt: true, body: 'x'.repeat(201) });
    expect(r.issues.some((i) => i.code === 'too_long')).toBe(true);
  });
});

describe('makeDispatchTicket —— 从校验问题生成合规派单', () => {
  const base = {
    id: 'h1', from: '场景记忆', to: '记忆维护', at: 1,
    phenomenon: '场景记忆主文件 26,000B 超过 25,600B 上限',
    howTo: '00-核心机制/六-记忆机制.md §4.2',
    howVerify: 'node tools/memory/check.mjs 应 exit=0',
  };

  it('正例：四件套齐全 => 生成票据且 kind=dispatch', () => {
    const r = makeDispatchTicket(base);
    expect(r.ok).toBe(true);
    expect(r.ticket?.kind).toBe('dispatch');
    expect(r.ticket?.ack).toBe(false);
  });

  it('正例：消息体带首行标记与【结束】', () => {
    const r = makeDispatchTicket(base);
    expect(r.message).toContain('【');
    expect(r.message).toContain('【结束】');
  });

  it('反例：缺「怎么验」=> 拒绝生成（不许派出无法验收的单）', () => {
    const r = makeDispatchTicket({ ...base, howVerify: '' });
    expect(r.ok).toBe(false);
    expect(r.ticket).toBeNull();
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('反例：缺「现象」=> 拒绝生成', () => {
    const r = makeDispatchTicket({ ...base, phenomenon: '' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /phenomenon/i.test(i.code))).toBe(true);
  });

  it('反例：缺「照哪做」=> 拒绝生成', () => {
    const r = makeDispatchTicket({ ...base, howTo: '' });
    expect(r.ok).toBe(false);
  });

  it('正例：wantReceipt=false => kind=notice（公告不欠回执）', () => {
    const r = makeDispatchTicket({ ...base, wantReceipt: false });
    expect(r.ok).toBe(true);
    expect(r.ticket?.kind).toBe('notice');
  });

  it('超长现象 => 仍生成，但如实带 too_long 告警（引擎既定：告警不阻断）', () => {
    const r = makeDispatchTicket({ ...base, phenomenon: '问'.repeat(300) });
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.code === 'too_long')).toBe(true);
  });

  it('反例：票据必须带 UI 渲染字段（缺了会渲染成空卡片）', () => {
    const r = makeDispatchTicket(base);
    const tk = r.ticket as unknown as Record<string, unknown>;
    expect(tk.instruction).toBeTruthy();
    expect(tk.owner).toBe(base.to);
    expect(tk.phenomenon).toBe(base.phenomenon);
    expect(tk.howTo).toBe(base.howTo);
    expect(tk.howVerify).toBe(base.howVerify);
    expect(tk.id).toBe(base.id);
  });
  it('正例：可复算（同输入两次一致）', () => {
    const a = makeDispatchTicket(base);
    const b = makeDispatchTicket(base);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
