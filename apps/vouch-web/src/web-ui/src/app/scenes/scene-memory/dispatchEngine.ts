/**
 * 派单台账引擎 —— 照「淋雨家工作台」四-派单机制.md + 三-跨场景协作.md
 *
 * 状态机：想出 → 判据(要动手=派单/只知悉=公告) → 已投递 →(回执:结论+证据+落盘)→ 已回执
 *        已投递 超时无回执 → 未回执(黑洞，最易漏)，进「我发出没回」清单
 * 规矩：派单≠公告；四件套(现象/照哪做/怎么验/回一句)；≤3条/≤200字/【结束】；
 *       【不需要回执·知悉】不欠账；台账 {hash,from,to,at,kind,route,delivered,ack}；按 hash 去重(恰好一次)。
 */

export type Kind = 'dispatch' | 'notice';
export type TicketStatus = 'dispatched' | 'received' | 'overdue';

export type Ticket = {
  hash: string;
  from: string;
  to: string;
  at: number;          // ms
  kind: Kind;
  route: string;       // 'RPC-200' | '落盘' ...
  delivered: boolean;  // 真投递(RPC accepted=true)
  ack: boolean;        // 已回执/已销账
  note?: string;
};

export type Issue = { level: 'error' | 'warn'; code: string; message: string };

/**
 * 账本条目 = 引擎 Ticket + 人看的字段
 *
 * 【2026-11-17 修·两种形状一个账本】原先 DispatchScene 自己定义 Item，
 * 场景记忆面板写的是裸 Ticket —— 结果派单进了账本却**渲染成空卡片**。
 * 同一个账本只能有一种形状，统一到这里。
 */
export type DispatchItem = Ticket & {
  id: string;
  instruction: string;
  owner: string;
  phenomenon: string;
  howTo: string;
  howVerify: string;
};

/** 账本变更事件名：任何写账本的地方写完都要广播，否则已挂载的场景看不到 */
export const DISPATCH_CHANGED_EVENT = 'nianchu:dispatch-changed';

/** 阈值（ms）：>30min ⚠，>2h ⛔ 未回执 */
export const THRESHOLDS = { warnMs: 30 * 60 * 1000, overdueMs: 2 * 60 * 60 * 1000 } as const;
/** 同一件事消息上限 */
export const MAX_MESSAGES = 3;
export const MAX_CHARS = 200;

/** 派单 vs 公告 唯一判据（看句子）：含"请你/派单/做完回一句/改完跑/复验" ⇒ 派单。 */
export function isDispatch(text: string): boolean {
  return /请你|派单|做完回一句|改完跑|复验|请改/.test(text);
}

/** 校验派单四件套是否齐全（缺一件必须失败）。 */
export function validateFour(body: { phenomenon?: string; howTo?: string; howVerify?: string; wantReceipt?: boolean }): { ok: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  const map: [string, string | undefined, string][] = [
    ['phenomenon', body.phenomenon, '现象'],
    ['howTo', body.howTo, '照哪做'],
    ['howVerify', body.howVerify, '怎么验'],
  ];
  for (const [code, val, cn] of map) {
    if (!val || !String(val).trim()) issues.push({ level: 'error', code: 'missing_' + code, message: `四件套缺「${cn}」` });
  }
  if (body.wantReceipt === undefined) issues.push({ level: 'error', code: 'missing_receipt', message: '未声明是否要回执' });
  return { ok: issues.length === 0, issues };
}

/** 组装一条 AI 间消息：首行标记 + 正文 + 末行【结束】。正文 >200 字告警。 */
export function buildMessage(opts: { wantReceipt: boolean; body: string }): { ok: boolean; text: string; issues: Issue[] } {
  const issues: Issue[] = [];
  const head = opts.wantReceipt ? '【需要回执】' : '【不需要回执·知悉】';
  if (opts.body.length > MAX_CHARS) {
    issues.push({ level: 'warn', code: 'too_long', message: `正文 ${opts.body.length} 字 > ${MAX_CHARS}（回执给指针，报告放文件）` });
  }
  const text = `${head}${opts.body}\n【结束】`;
  return { ok: true, text, issues };
}

/** 计算某条派单当前状态（公告永不 overdue；派单未 ack 且超 2h ⇒ overdue）。 */
/**
 * 从一条校验问题生成**合规的**派单票据
 *
 * 为什么需要：记忆/身份面板发现超标时，人得手工去「任务分派」重填四件套，
 * 结果常常漏项（尤其「怎么验」）—— 于是派出去的单对方无法判断做没做完。
 * 这条链路让「发现问题」和「派单去修」用同一个引擎，四件套由引擎校验，
 * 不合格就拒绝生成（返回 issues 说明缺什么），而不是生成一张坏单。
 *
 * 判据（复用既有引擎，不另立标准）：
 *   · 四件套 validateFour 必须过
 *   · 消息体 buildMessage 必须过（含首行标记 + 【结束】，≤200 字）
 *   · 正文必须像派单（isDispatch）—— 否则退化成公告，对方不欠回执
 */
export function makeDispatchTicket(args: {
  id: string;
  from: string;
  to: string;
  at: number;
  phenomenon: string;
  howTo: string;
  howVerify: string;
  wantReceipt?: boolean;
}): { ok: boolean; ticket: DispatchItem | null; issues: Issue[]; message: string } {
  const wantReceipt = args.wantReceipt !== false;
  const four = validateFour({
    phenomenon: args.phenomenon,
    howTo: args.howTo,
    howVerify: args.howVerify,
    wantReceipt,
  });
  if (!four.ok) {
    return { ok: false, ticket: null, issues: four.issues, message: '' };
  }

  // 正文必须满足既有 isDispatch 判据（「做完回一句」等），否则退化成公告。
  const body = [
    args.phenomenon.trim(),
    '照 ' + args.howTo.trim() + ' 改',
    '做完回一句：跑 ' + args.howVerify.trim() + ' 的结果 + 证据 + 落盘',
  ].join('；');

  const built = buildMessage({ wantReceipt, body });
  if (!built.ok) {
    return { ok: false, ticket: null, issues: built.issues, message: built.text };
  }
  // 注：buildMessage 对 >200 字只**告警不阻断**（既定设计：回执给指针，报告放文件）。
  // 所以这里如实透传 issues，由调用方决定是否提醒，不擅自升级成拒绝。
  if (wantReceipt && !isDispatch(built.text)) {
    return {
      ok: false,
      ticket: null,
      issues: [{ level: 'error', code: 'not_dispatch', message: '正文不像派单（对方不会欠回执）' }],
      message: built.text,
    };
  }

  return {
    ok: true,
    ticket: {
      hash: args.id,
      id: args.id,
      from: args.from,
      to: args.to,
      at: args.at,
      kind: wantReceipt ? 'dispatch' : 'notice',
      route: 'UI',
      delivered: true,
      ack: false,
      note: body.slice(0, 120),
      // UI 字段：DispatchScene 渲染卡片要读这些，缺了就渲染成空卡片
      instruction: args.phenomenon.trim(),
      owner: args.to,
      phenomenon: args.phenomenon.trim(),
      howTo: args.howTo.trim(),
      howVerify: args.howVerify.trim(),
    },
    issues: built.issues,
    message: built.text,
  };
}

export function computeStatus(t: Ticket, now: number): TicketStatus {
  if (t.ack) return 'received';
  if (t.kind === 'notice') return 'dispatched'; // 公告不追回执
  return now - t.at > THRESHOLDS.overdueMs ? 'overdue' : 'dispatched';
}

/** 台账两条查询：「我发出还没回」/「别人在等我回」+ 未回执黑洞。 */
export function ledger(tickets: Ticket[], me: string, now: number) {
  const iOwe = tickets.filter((t) => t.from === me && !t.ack && t.kind === 'dispatch' && t.delivered && now - t.at > THRESHOLDS.warnMs);
  const othersAwaitMe = tickets.filter((t) => t.to === me && !t.ack && t.kind === 'dispatch' && t.delivered);
  const blackHole = tickets.filter((t) => computeStatus(t, now) === 'overdue');
  const received = tickets.filter((t) => t.ack);
  return { iOwe, othersAwaitMe, blackHole, received };
}

/** 按 hash 去重（同内容再跑跳过=恰好一次），返回新台账 + 是否新增。 */
export function dedupAppend(tickets: Ticket[], t: Ticket): { tickets: Ticket[]; added: boolean } {
  if (tickets.some((x) => x.hash === t.hash)) return { tickets, added: false };
  return { tickets: [...tickets, t], added: true };
}

/** 检查一个 thread 还能不能继续发（≤3 条消息上限，防 AI 互相客套烧 token）。 */
export function canSendMore(messagesInThread: number): { ok: boolean; issues: Issue[] } {
  if (messagesInThread >= MAX_MESSAGES) {
    return { ok: false, issues: [{ level: 'error', code: 'thread_limit', message: `同一件事已达 ${MAX_MESSAGES} 条上限（派单+回执+收尾），停手写文件` }] };
  }
  return { ok: true, issues: [] };
}

/** 收到知悉（【不需要回执·知悉】）时不许再回（返回提示，不产生新消息）。 */
export function receiptOfNoticeResponse(): { ok: false; issues: Issue[] } {
  return { ok: false, issues: [{ level: 'error', code: 'no_reply_to_notice', message: '收到「不需要回执·知悉」：一个字都不许回（连收到/好的都不行）' }] };
}
