#!/usr/bin/env node
/**
 * 念初 · 派单闭环（五态 + 超时升级 + 销账）
 *
 * ══ 为什么要单独做这一层 ═════════════════════════════════════
 * 参照 D:/refs/luanyujia-fresh/00-核心机制/README.md:21 点名的两个真实失败模式：
 *   · 「派单进黑洞」—— 交出去了，没人接，双方都以为对方在做
 *   · 「87% 的派单其实没送到」—— 发出去了，但对方根本没收到/没认领
 *
 * 我们原来有 tasks 状态机（pending/ready/dispatched/running/done/failed/blocked），
 * 但那是**任务生命周期**，不是**派单闭环**：没有「对方认领了吗」「回执呢」「销账了吗」。
 * 所以「活干完了但对方还不知道」这种情况，我们的系统判不出来。
 *
 * ══ 五态（照 luanyujia 的「一次派单 = 一条回执」）══════════════
 *   issued     已派：我发出去了
 *   acked      已接：对方明确认领（**这一步最容易缺**，缺了就是进黑洞）
 *   working    执行中
 *   receipted  已回执：给了结论 + 证据 + 路径
 *   closed     已销账：派单方确认收到并关单
 *
 * 非法转移一律拒绝；超时未接/未回执要能**升级告警**。
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 状态存文件（用户数据目录），单机单进程；多进程并发写没有加锁。
 * · 「送达」是靠对方显式 ack，不是网络层确认 —— 这正是它要防的场景。
 * · 超时判定靠读时计算（不依赖后台定时器），所以进程不在跑也不会漏判。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { USER_DATA_DIR } from './runtime.mjs';

export const STATES = ['issued', 'acked', 'working', 'receipted', 'closed'];

/** 合法转移。故意不允许跳级：issued → receipted 是「没认领就交活」，要拦。 */
export const TRANSITIONS = {
  issued: ['acked', 'closed'],          // 可以撤回（closed 带 cancelled 标记）
  acked: ['working', 'closed'],
  working: ['receipted', 'closed'],
  receipted: ['closed'],
  closed: [],
};

/** 默认超时（毫秒）：多久没被认领算「进黑洞」 */
export const DEFAULT_ACK_TIMEOUT_MS = 10 * 60 * 1000;
/** 多久没回执算「双方互等」 */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 60 * 60 * 1000;

function dir() {
  const d = join(USER_DATA_DIR, 'handoffs');
  mkdirSync(d, { recursive: true });
  return d;
}

function file() {
  return join(dir(), 'ledger.json');
}

const nowIso = () => new Date().toISOString();

function loadLedger() {
  const f = file();
  if (!existsSync(f)) return { at: nowIso(), items: [] };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (!j || !Array.isArray(j.items)) return { at: nowIso(), items: [] };
    return j;
  } catch {
    // 账本坏了不能静默重置（那是丢数据）；返回空但标记 corrupted 让上层可见
    return { at: nowIso(), items: [], corrupted: true };
  }
}

function saveLedger(ledger) {
  writeFileSync(file(), JSON.stringify({ ...ledger, at: nowIso() }, null, 2) + '\n', 'utf8');
}

export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/**
 * 派一单。
 * @returns {{state:string, item?:object, reason?:string}}
 */
export function issue({ title, to, spec, criteria, where, ackTimeoutMs, receiptTimeoutMs, by = 'lead' } = {}) {
  if (!title || !String(title).trim()) return { state: 'FAIL', reason: 'title 必填（写清要做什么）' };
  if (!to || !String(to).trim()) return { state: 'FAIL', reason: 'to 必填（派给谁）' };
  if (!spec || !String(spec).trim()) return { state: 'FAIL', reason: 'spec 必填（判据是什么）' };

  const ledger = loadLedger();
  const item = {
    id: 'ho-' + randomUUID().replace(/-/g, '').slice(0, 12),
    title: String(title).slice(0, 200),
    to: String(to),
    by: String(by),
    spec: String(spec),
    criteria: criteria ? String(criteria) : null,
    where: where ? String(where) : null,
    status: 'issued',
    issuedAt: nowIso(),
    ackedAt: null,
    workingAt: null,
    receiptedAt: null,
    closedAt: null,
    receipt: null,
    ackTimeoutMs: Number(ackTimeoutMs) || DEFAULT_ACK_TIMEOUT_MS,
    receiptTimeoutMs: Number(receiptTimeoutMs) || DEFAULT_RECEIPT_TIMEOUT_MS,
    history: [{ at: nowIso(), from: null, to: 'issued', by: String(by) }],
  };
  ledger.items.push(item);
  saveLedger(ledger);
  return { state: 'PASS', item };
}

/** 转移一次状态（内部用） */
function transition(item, to, by, extra = {}) {
  if (!canTransition(item.status, to)) {
    return { ok: false, reason: `非法转移 ${item.status} → ${to}（允许：${(TRANSITIONS[item.status] || []).join('/') || '无'}）` };
  }
  const at = nowIso();
  item.status = to;
  if (to === 'acked') item.ackedAt = at;
  if (to === 'working') item.workingAt = at;
  if (to === 'receipted') item.receiptedAt = at;
  if (to === 'closed') item.closedAt = at;
  if (extra.receipt !== undefined) item.receipt = extra.receipt;
  if (extra.reason) item.closeReason = extra.reason;
  item.history.push({ at, from: item.history[item.history.length - 1].to, to, by: String(by), ...(extra.reason ? { reason: extra.reason } : {}) });
  return { ok: true };
}

/** 对方认领（**这一步缺了就是进黑洞**） */
export function ack({ id, by } = {}) {
  return mutate(id, (item) => transition(item, 'acked', by || item.to));
}

/** 开始干 */
export function startWork({ id, by } = {}) {
  return mutate(id, (item) => transition(item, 'working', by || item.to));
}

/**
 * 交回执。必须带**结论 + 证据**（对应 luanyujia 的「回执写清：结论 + 证据 + 路径」）。
 * 缺证据不收 —— 这就是「干完但对方不知道」的反面。
 */
export function receipt({ id, by, conclusion, evidence, paths } = {}) {
  if (!conclusion || !String(conclusion).trim()) {
    return { state: 'FAIL', reason: '回执必须有结论' };
  }
  if (!evidence || !String(evidence).trim()) {
    return { state: 'FAIL', reason: '回执必须有证据（命令输出/路径/截图），不接受"我做了"' };
  }
  return mutate(id, (item) => transition(item, 'receipted', by || item.to, {
    receipt: {
      conclusion: String(conclusion),
      evidence: String(evidence),
      paths: Array.isArray(paths) ? paths.map(String) : [],
      at: nowIso(),
    },
  }));
}

/** 派单方销账 */
export function close({ id, by, reason } = {}) {
  return mutate(id, (item) => transition(item, 'closed', by || item.by, { reason }));
}

function mutate(id, fn) {
  if (!id) return { state: 'FAIL', reason: 'id 必填' };
  const ledger = loadLedger();
  const item = ledger.items.find((x) => x.id === id);
  if (!item) return { state: 'UNKNOWN', reason: '找不到这一单：' + id };
  const r = fn(item);
  if (!r.ok) return { state: 'FAIL', reason: r.reason };
  saveLedger(ledger);
  return { state: 'PASS', item };
}

/**
 * 体检：找出「进黑洞」「双方互等」「没证据就回执」「账上有但没销」的单。
 *
 * 这是这一层的**核心价值**：不是记录状态，而是**主动报出失败模式**。
 * @returns {{state:string, problems:Array, stats:object}}
 */
export function audit({ now = Date.now() } = {}) {
  const ledger = loadLedger();
  const problems = [];
  const stats = { total: 0, issued: 0, acked: 0, working: 0, receipted: 0, closed: 0 };

  for (const it of ledger.items) {
    stats.total++;
    stats[it.status] = (stats[it.status] || 0) + 1;
    const issuedMs = Date.parse(it.issuedAt) || 0;

    if (it.status === 'issued' && now - issuedMs > it.ackTimeoutMs) {
      problems.push({
        kind: 'blackhole', id: it.id, title: it.title, to: it.to,
        detail: '派出 ' + Math.round((now - issuedMs) / 60000) + ' 分钟仍无人认领（进黑洞）',
      });
    }
    if (it.status === 'working') {
      const startMs = Date.parse(it.workingAt || it.ackedAt || it.issuedAt) || 0;
      if (now - startMs > it.receiptTimeoutMs) {
        problems.push({
          kind: 'mutual-wait', id: it.id, title: it.title, to: it.to,
          detail: '执行 ' + Math.round((now - startMs) / 60000) + ' 分钟未回执（双方互等）',
        });
      }
    }
    if (it.status === 'receipted' && it.receipt && !String(it.receipt.evidence || '').trim()) {
      problems.push({ kind: 'no-evidence', id: it.id, title: it.title, detail: '回执没有证据' });
    }
    if (it.status === 'receipted') {
      problems.push({
        kind: 'unclosed', id: it.id, title: it.title, to: it.to,
        detail: '已回执但派单方还没销账（"干完但对方不知道"）',
      });
    }
  }

  return {
    // 有 blackhole / mutual-wait / no-evidence 才算 FAIL；unclosed 是提醒
    state: problems.some((p) => ['blackhole', 'mutual-wait', 'no-evidence'].includes(p.kind))
      ? 'FAIL'
      : (problems.length > 0 ? 'WARN' : 'PASS'),
    problems,
    stats,
    corrupted: ledger.corrupted === true,
  };
}

export function list({ status, limit = 50 } = {}) {
  const ledger = loadLedger();
  let items = ledger.items;
  if (status) items = items.filter((x) => x.status === status);
  return items.slice(-limit).reverse();
}