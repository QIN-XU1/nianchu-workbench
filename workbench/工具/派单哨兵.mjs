#!/usr/bin/env node
/**
 * 派单哨兵 —— 检查派单台账的不变量
 *
 * ══════════════════════════════════════════════════════════════
 *  不变量
 * ══════════════════════════════════════════════════════════════
 *
 *  INV-1  dispatch-body     dispatch 类型必须有四件套（现象/照哪做/怎么验）
 *  INV-2  announce-no-ack   announce 类型不该被要求回执、不该有 receipt
 *  INV-3  ack-has-evidence  acked 状态的回执必须非空且 ≥ 20 字符
 *  INV-4  no-unacked        dispatch 超过 deadline 未回执 → 违规（进待办）
 *  INV-5  no-orphan-ack     acked 但 deliveredAt 为空 → 不可能（没投递怎么回执）
 *  INV-6  id-format         id 必须 d-YYYYMMDD-NNN 格式
 *  INV-7  state-valid       状态必须是五态之一
 *  INV-8  no-closed-unacked closed 的 dispatch 必须有 ackedAt
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么 INV-4 最重要
 * ══════════════════════════════════════════════════════════════
 *
 *  原项目："没有'未回执'这个状态，派单就等于扔进黑洞。"
 *  实测：36 条通知只有 8 条真投递 = 22% 执行率
 *
 *  INV-4 是唯一能发现"扔进黑洞"的检查。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

const VALID_STATES = ['created', 'delivered', 'acked', 'unacked', 'closed', 'cancelled'];
const ID_RE = /^d-\d{8}-\d{3}$/;
const MIN_EVIDENCE_LEN = 20;

function readJson(p, fb) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // 剥离 BOM
    return JSON.parse(s);
  } catch { return fb; }
}

/**
 * @param {string} dataRoot .dsh 目录
 * @param {number} [nowMs]  测试用的当前时间（默认 Date.now()）
 */
export function check(dataRoot, nowMs) {
  const diffs = [];
  const ID = 'dispatch-guard';
  const now = nowMs || Date.now();

  const ledgerFile = path.join(dataRoot, '场景记忆', '_共享记忆', '派单台账.json');
  if (!fs.existsSync(ledgerFile)) {
    // 台账不存在不算违规（还没派过单）
    return { id: ID, diffs, stats: { total: 0 } };
  }

  const ledger = readJson(ledgerFile, null);
  if (!ledger) {
    diffs.push('派单台账 JSON 解析失败：' + ledgerFile);
    return { id: ID, diffs, stats: { total: 0 } };
  }

  const list = Array.isArray(ledger.dispatches) ? ledger.dispatches : [];
  const stats = { total: list.length, byState: {} };

  const seenIds = new Set();

  for (const d of list) {
    const tag = d.id || '(无 id)';

    // ── INV-6 id 格式 ──
    if (!d.id) {
      diffs.push('存在无 id 的派单记录');
    } else if (!ID_RE.test(String(d.id))) {
      diffs.push('派单 ' + tag + ' 的 id 格式不合法（应为 d-YYYYMMDD-NNN）');
    } else if (seenIds.has(d.id)) {
      diffs.push('派单 id 重复：' + tag);
    }
    if (d.id) seenIds.add(d.id);

    // ── INV-7 状态合法 ──
    if (d.state && !VALID_STATES.includes(d.state)) {
      diffs.push('派单 ' + tag + ' 状态不合法：' + d.state);
    }

    // ── INV-7b 作废必须留原因（2026-11-10 新增）──
    //
    //  cancelled 和 closed 语义不同：
    //    closed    = 做完了
    //    cancelled = 不做了（必须写原因，否则无法追溯为什么放弃）
    if (d.state === 'cancelled' && (!d.cancelReason || String(d.cancelReason).trim().length < 5)) {
      diffs.push('派单 ' + tag + ' 已作废但没有原因（cancelReason 缺失或过短）');
    }

    const st = d.state || 'created';
    stats.byState[st] = (stats.byState[st] || 0) + 1;

    if (d.type === 'dispatch') {
      // ── INV-1 四件套 ──
      const missing = [];
      if (!d.phenomenon || String(d.phenomenon).trim().length < 5) missing.push('现象');
      if (!d.howto || String(d.howto).trim().length < 5) missing.push('照哪做');
      if (!d.verify || String(d.verify).trim().length < 5) missing.push('怎么验');
      if (missing.length) {
        diffs.push('派单 ' + tag + ' 缺四件套：' + missing.join('、'));
      }

      // ── INV-4 超时未回执（最重要）──
      if (st === 'created' || st === 'delivered') {
        const created = new Date(d.createdAt).getTime();
        if (Number.isFinite(created)) {
          const hours = (now - created) / 3600000;
          const deadline = d.deadlineHours || 24;
          if (hours > deadline) {
            diffs.push(
              '派单 ' + tag + ' → ' + d.to + ' 已 ' + hours.toFixed(1) + ' 小时未回执（超过 ' + deadline + 'h）' +
              '  主题：' + String(d.subject || '').slice(0, 30)
            );
          }
        } else {
          diffs.push('派单 ' + tag + ' 的 createdAt 不合法：' + d.createdAt);
        }
      }

      // ── INV-8 closed 必须有 ackedAt ──
      if (st === 'closed' && !d.ackedAt) {
        diffs.push('派单 ' + tag + ' 已销账但从未回执（closed 必须有 ackedAt）');
      }
    }

    if (d.type === 'announce') {
      // ── INV-2 公告不该有回执 ──
      if (d.receipt) {
        diffs.push('公告 ' + tag + ' 不该有回执（公告只落盘，不要求回执）');
      }
    }

    // ── INV-3 acked 必须有证据 ──
    if (st === 'acked') {
      const ev = String(d.receipt || '').trim();
      if (!ev) {
        diffs.push('派单 ' + tag + ' 已回执但没有证据（"只说好了等于没说"）');
      } else if (ev.length < MIN_EVIDENCE_LEN) {
        diffs.push('派单 ' + tag + ' 的回执证据太短（' + ev.length + ' < ' + MIN_EVIDENCE_LEN + ' 字符）');
      }
    }

    // ── INV-5 acked 但没投递 ──
    if (st === 'acked' && d.type === 'dispatch' && !d.deliveredAt) {
      diffs.push('派单 ' + tag + ' 已回执但从未标记投递（没投递怎么回执？）');
    }
  }

  return { id: ID, diffs, stats };
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  派单哨兵 · 自测');
  console.log('═'.repeat(72));
  console.log();

  chk('状态集合含 6 态', VALID_STATES.length === 6, VALID_STATES.join(','));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispguard-'));
  const shared = path.join(tmp, '场景记忆', '_共享记忆');
  fs.mkdirSync(shared, { recursive: true });

  const writeLedger = (list) => fs.writeFileSync(path.join(shared, '派单台账.json'),
    JSON.stringify({ dispatches: list }, null, 2), 'utf8');

  const GOOD = {
    id: 'd-20261111-001', type: 'dispatch', from: 'hub', to: '架构梳理',
    subject: '测试派单', phenomenon: '现象描述足够长', howto: '照哪做足够长', verify: '怎么验足够长',
    state: 'acked', createdAt: new Date().toISOString(),
    ackedAt: new Date().toISOString(), receipt: '产物路径 workbench/数据/x.md，机制体检 41/41 通过，差异集合 0', deliveredAt: new Date().toISOString(),
  };

  writeLedger([GOOD]);
  const r1 = check(tmp);
  chk('合规台账通过', r1.diffs.length === 0, r1.ok ? '' : (r1.diffs || []).slice(0, 2).join(';'));

  writeLedger([{ ...GOOD, id: 'bad-id' }]);
  const r2 = check(tmp);
  chk('反例：id 格式错必须报', r2.diffs.length > 0, r2.ok ? '没报' : ((r2.diffs || [])[0] || '').slice(0, 40));

  writeLedger([{ ...GOOD, receipt: null }]);
  const r3 = check(tmp);
  chk('反例：acked 无证据必须报', r3.diffs.length > 0, r3.ok ? '没报' : ((r3.diffs || [])[0] || '').slice(0, 40));

  writeLedger([{ ...GOOD, state: 'whatever' }]);
  const r4 = check(tmp);
  chk('反例：非法状态必须报', r4.diffs.length > 0, r4.ok ? '没报' : ((r4.diffs || [])[0] || '').slice(0, 40));

  writeLedger([{ ...GOOD, state: 'cancelled', cancelReason: null }]);
  const r5 = check(tmp);
  chk('反例：作废无原因必须报', r5.diffs.length > 0, r5.ok ? '没报' : ((r5.diffs || [])[0] || '').slice(0, 40));

  writeLedger([GOOD]);
  const r6 = check(tmp);
  chk('恢复后重新通过', r6.diffs.length === 0, '');

  chk('关键：4 个反例全部被检出',
      [r2, r3, r4, r5].every((x) => x.diffs.length > 0),
      '这是派单哨兵存在的唯一理由');

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const dataRoot = process.env.SEA_DATA_DIR
    ? path.resolve(process.env.SEA_DATA_DIR)
    : path.join(WB, '数据', '.dsh');

  // ★ 自检修复：支持 SEA_NOW 注入"当前时间"，让时间相关判定可复现
  //   不注入就用真实时间
  let nowMs;
  if (process.env.SEA_NOW) {
    const raw = process.env.SEA_NOW;
    nowMs = /^\d+$/.test(raw) ? parseInt(raw, 10) : Date.parse(raw);
    if (!Number.isFinite(nowMs)) {
      console.error('SEA_NOW 无法解析：' + raw);




      process.exit(2);
    }
  }

  const r = check(dataRoot, nowMs);
  const n = r.diffs.length;

  console.log('  台账: ' + r.stats.total + ' 条');
  if (r.stats.total) {
    const parts = Object.entries(r.stats.byState || {}).map(([k, v]) => k + '=' + v);
    console.log('  分布: ' + parts.join('  '));
  }
  console.log();

  if (n === 0) {
    console.log('PASS ' + r.id + ': 差异集合 = 0');
    process.exit(0);
  } else {
    console.log('FAIL ' + r.id + ': 差异集合 = ' + n + ' 项');
    for (const d of r.diffs) console.log('  - ' + d);
    process.exit(1);
  }
}
