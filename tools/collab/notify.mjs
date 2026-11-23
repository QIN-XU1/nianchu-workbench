#!/usr/bin/env node
/**
 * 通知场景 —— 底层改动的「超级通道」。
 *
 * 照搬 luanyujia-workbench 05-协作与规矩/三-跨场景协作.md §四 的 ★ 那条：
 *
 *   原文：「底层改动要通知受影响方（用户要求"超级通道"，通知一次）：
 *          你改的是**会影响别的场景**的东西（引擎/外壳/规范/技能/清理规则…）⇒ 改完跑
 *          node <DSH根>\工具\通知场景.mjs "<变了什么+要它们做什么>" --affected <标签[,标签…]>
 *          它一次通知所有受影响场景：写看板（最新在最上）＋ 往每个目标记忆 §〇 顶部追加一行
 *          ＋ 记台账去重（**同一内容再跑会被跳过**，--force 可重发）。
 *          默认不发消息；确需它们立刻改行为才加 --wake。
 *          ⇒ 做底层改动的人不必再逐个场景打招呼；被影响的人先看这个看板。」
 *
 * 我们照搬后的形态（三个落点，一处不少）：
 *   ① 看板      evidence/collab/notice-board.json（最新在最上）
 *   ② 各场景    往 evidence/collab/inboxes/<场景>.jsonl 顶部追加（兜底，不加 --wake 也做）
 *   ③ 台账      evidence/collab/notice-ledger.json（按内容哈希去重）
 *
 * 原文还有一条，也照搬：
 *   「默认**不发消息**；确需它们立刻改行为才加 `--wake`（会花它们一轮 token）」
 *   ⇒ 不加 --wake 时 delivered 记 'board-only'，如实标注没打扰它们。
 *
 * 用法：
 *   node tools/collab/notify.mjs "<变了什么 + 要它们做什么>" --affected <场景id[,场景id…]>
 *   node tools/collab/notify.mjs "<...>" --affected all [--force] [--wake] [--dry]
 *   node tools/collab/notify.mjs --board [--limit 10]
 *
 * 四态：
 *   0 = PASS（已通知全部受影响方）
 *   3 = WARN（去重跳过 / 部分场景不存在）
 *   1 = FAIL（参数不合法）
 *   2 = UNKNOWN（读不到场景清单）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadScenes } from './request.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOARD = path.join(REPO, 'evidence/collab/notice-board.json');
const LEDGER = path.join(REPO, 'evidence/collab/notice-ledger.json');
const INBOX_DIR = path.join(REPO, 'evidence/collab/inboxes');

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
};

/** 内容哈希 —— 原文「同一内容再跑会被跳过」的去重键 */
export function noticeHash(content, affected) {
  return crypto.createHash('sha256')
    .update(String(content).trim() + '|' + [...affected].sort().join(','))
    .digest('hex').slice(0, 16);
}

/** 往某场景的信箱顶部追加（兜底通道，不加 --wake 也做） */
export function appendInbox(sceneId, row) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const p = path.join(INBOX_DIR, sceneId + '.jsonl');
  const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
  // 顶部追加：新行在前
  fs.writeFileSync(p, JSON.stringify(row) + '\n' + old.join('\n') + (old.length ? '\n' : ''), 'utf8');
  return path.relative(REPO, p);
}

function main(argv) {
  const dry = argv.includes('--dry');
  const force = argv.includes('--force');
  const wake = argv.includes('--wake');

  const sc = loadScenes();
  if (!sc.ok) {
    console.log('  ❔ ' + sc.why);
    console.log('  四态: UNKNOWN —— 读不到场景清单，判不了该通知谁');
    process.exit(2);
  }
  const ids = sc.scenes.map((s) => s.sceneId);

  // --board：看板
  if (argv.includes('--board')) {
    const board = readJson(BOARD, []);
    console.log('');
    console.log('  通知看板（最新在最上）');
    console.log('  ' + '─'.repeat(72));
    if (!board.length) console.log('    （还没有通知）');
    for (const r of board.slice(0, 10)) {
      console.log('    ' + r.at.slice(0, 16).replace('T', ' ') + '  [' + r.delivered + ']  ' + r.content.slice(0, 46));
      console.log('      → ' + r.affected.join('、'));
    }
    console.log('');
    console.log('  四态: PASS —— 共 ' + board.length + ' 条');
    console.log('');
    process.exit(0);
  }

  const get = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  const affectedRaw = get('--affected');
  const content = argv.filter((a) => !a.startsWith('--') && a !== affectedRaw).join(' ').trim();

  if (!content) {
    console.log('  ✗ 拒绝：没说「变了什么 + 要它们做什么」');
    console.log('  四态: FAIL');
    process.exit(1);
  }
  if (!affectedRaw) {
    console.log('  ✗ 拒绝：缺 --affected（受影响场景，逗号分隔；或 all）');
    console.log('  可用场景：' + ids.join('、'));
    console.log('  四态: FAIL —— 不知道该通知谁');
    process.exit(1);
  }

  const affected = affectedRaw === 'all' ? ids : affectedRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const missing = affected.filter((a) => !ids.includes(a));
  const real = affected.filter((a) => ids.includes(a));
  if (!real.length) {
    console.log('  ✗ 拒绝：--affected 里没有一个是真实场景（' + missing.join('、') + '）');
    console.log('  可用场景：' + ids.join('、'));
    console.log('  四态: FAIL');
    process.exit(1);
  }

  const hash = noticeHash(content, real);
  const ledger = readJson(LEDGER, { sent: {} });
  if (ledger.sent[hash] && !force) {
    console.log('');
    console.log('  🟡 跳过 —— 同一内容已经通知过这些场景（照搬原文去重）');
    console.log('    上次: ' + String(ledger.sent[hash].at).slice(0, 16).replace('T', ' ') + ' → ' + ledger.sent[hash].affected.join('、'));
    console.log('    要重发加 --force');
    console.log('');
    console.log('  四态: WARN —— 去重跳过，没有重复打扰它们');
    console.log('');
    process.exit(3);
  }

  // 【照搬原文】默认不发消息；--wake 才是「要它们立刻改行为」。
  // 但本仓库当前没有常驻 RPC/session-prompt 转发器（同 request.mjs 的 degraded 约束），
  // 所以 --wake 只能"请求唤醒"而不能"已唤醒"——如实降级，不谎报 woken。
  const wakeCapable = false; // UNKNOWN→按不可用处理：无已验证的直达通道
  const row = {
    id: 'NTC-' + Date.now().toString(36),
    at: new Date().toISOString(),
    hash,
    content,
    affected: real,
    delivered: wake ? (wakeCapable ? 'woken' : 'wake-requested-degraded') : 'board-only',
    note: wake
      ? (wakeCapable
        ? '已写看板 + 各场景信箱，并已唤醒'
        : '已写看板 + 各场景信箱；请求了 --wake 但无已验证 RPC 转发器，实际未直达会话（如实降级）')
      : '已写看板 + 各场景信箱；**没有打扰它们的会话**（默认行为，照搬原文）',
  };

  if (dry) {
    console.log('');
    console.log('  （--dry 空跑）将通知 ' + real.length + ' 个场景：' + real.join('、'));
    console.log('    ' + JSON.stringify(row, null, 2).split('\n').join('\n    '));
    console.log('');
    console.log('  四态: PASS —— 空跑通过');
    console.log('');
    process.exit(0);
  }

  const board = readJson(BOARD, []);
  board.unshift(row);
  writeJson(BOARD, board.slice(0, 200));

  for (const s of real) appendInbox(s, row);

  ledger.sent[hash] = { at: row.at, affected: real };
  writeJson(LEDGER, ledger);

  console.log('');
  console.log('  ✓ 已通知 ' + real.length + ' 个场景：' + real.join('、'));
  console.log('    ① 看板      evidence/collab/notice-board.json');
  console.log('    ② 各场景信箱 evidence/collab/inboxes/<场景>.jsonl（顶部追加）');
  console.log('    ③ 台账      evidence/collab/notice-ledger.json（按内容哈希去重）');
  console.log('    送达状态: ' + row.delivered + (wake ? '' : '（没有打扰它们的会话 —— 照搬原文默认行为）'));
  if (missing.length) console.log('    ⚠ 这些场景不存在，已跳过：' + missing.join('、'));
  console.log('');
  console.log('  四态: ' + (missing.length ? 'WARN' : 'PASS') + ' —— ' + (missing.length ? '部分场景不存在' : '全部受影响方已通知'));
  console.log('');
  process.exit(missing.length ? 3 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
