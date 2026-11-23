#!/usr/bin/env node
/**
 * 跨场景请求 —— 场景 A 找场景 B 办事的**唯一**入口。
 *
 * 照搬 luanyujia-workbench 05-协作与规矩/三-跨场景协作.md §二 规矩 1：
 *
 *   原文：「要清 → 给它的会话发消息（首选，直达，不用等它开工）：
 *          node <DSH根>\工具\清理请求.mjs "<要清理什么/在哪/为什么>" --from <你的场景>
 *          —— 它走引擎 RPC session/prompt 把请求当一个用户回合发进 pc-ai 的会话；
 *             RPC 不通会自动降级，把同一句话落进场景记忆……并照样留痕。
 *          加 --dry 先看要发什么。」
 *
 * 原文两条硬规矩，照搬：
 *   ① 「你只管提请求，别动手」—— 发送方不许自己执行被请求的动作
 *   ② 「清理请求.mjs 只发消息：脚本里不许出现 Remove-Item/rmSync/del，它自己绝不删/移任何东西」
 *
 * 我们照搬后的形态：
 *   · 请求写进 `evidence/collab/requests.jsonl`（只追加，带 from/to/content/tone/at/降级标记）
 *   · 同时在 `research/改进台账.json` 不写 —— 请求不是改进，别污染台账
 *   · RPC 通道：起 `tools/workbench/serve.mjs` 的 `/api/collab` 转发；不通则标记 `delivered: 'degraded'`
 *     （**不假装送达** —— 这是四态纪律在协作层的落地）
 *
 * 用法：
 *   node tools/collab/request.mjs "<要办什么>" --from <发起场景> --to <承接场景> [--dry]
 *   node tools/collab/request.mjs --list [--scene <id>]
 *
 * 四态：
 *   0 = 已受理（written 或 delivered）
 *   3 = 降级（写进队列但没能直达承接方 —— 如实标 degraded，不谎报送达）
 *   1 = 拒绝（参数不合法 / 承接场景不存在）
 *   2 = 判不了（读不到场景清单）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOG = path.join(REPO, 'evidence/collab/requests.jsonl');
const IDENTITY = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/workbench/scenePanels/identity.json');
const TERRITORY = path.join(REPO, 'evidence/collab/territory.json');

/** 读取场景清单（身份索引是唯一权威，照搬原文「§一 只能从定位卡与身份索引抄，不许自己编」） */
export function loadScenes() {
  try {
    const j = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
    const rows = Array.isArray(j.rows) ? j.rows : [];
    const byScene = new Map();
    for (const r of rows) {
      if (!byScene.has(r.sceneId)) byScene.set(r.sceneId, { sceneId: r.sceneId, panels: [], name: r.sessionTitle ?? r.sceneId });
      byScene.get(r.sceneId).panels.push(r.panelId);
    }
    return { ok: true, scenes: [...byScene.values()], rows };
  } catch (e) {
    return { ok: false, why: '读不到身份索引：' + String(e && e.message).slice(0, 80) };
  }
}

/** 地盘表 —— 照搬原文 §一 的五列（职能 / 地盘 / 不该碰的 / 记忆写回点） */
export function loadTerritory() {
  try {
    return { ok: true, ...JSON.parse(fs.readFileSync(TERRITORY, 'utf8')) };
  } catch (e) {
    return { ok: false, why: '读不到地盘表：' + String(e && e.message).slice(0, 80) };
  }
}

/**
 * 校验一次跨场景请求能不能成立。
 * 【照搬原文的机械抓手】原文说「第 ⑧ 项会核对 §一 的行数 = 身份索引 §二 的面板数，缺谁/多谁点名」。
 * 这里做同样的事：请求里的 from/to 必须是**身份索引里真实存在的场景**，否则拒绝。
 */
export function validateRequest(req, scenes) {
  const ids = new Set(scenes.map((s) => s.sceneId));
  const why = [];
  if (!req.content || !String(req.content).trim()) why.push('请求内容为空');
  if (!req.from) why.push('缺少 --from（发起场景）');
  if (!req.to) why.push('缺少 --to（承接场景）');
  if (req.from && !ids.has(req.from)) why.push('发起场景不存在：' + req.from);
  if (req.to && !ids.has(req.to)) why.push('承接场景不存在：' + req.to);
  if (req.from && req.from === req.to) why.push('不能给自己派单');
  return { ok: why.length === 0, why: why.join('；') };
}

/** 追加一行（只追加，不改历史） */
export function appendRequest(row) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(row) + '\n', 'utf8');
  return { ok: true, file: path.relative(REPO, LOG) };
}

export function readRequests(scene = null) {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return scene ? rows.filter((r) => r.from === scene || r.to === scene) : rows;
  } catch { return []; }
}

/**
 * 三段式请求格式 —— 照搬 luanyujia §四：
 *   `【请求·来自<你的场景>·<日期>】要什么 / 为什么 / 期望什么时候`
 *
 * 原文那行例子的三段是：
 *   「<工作区>\_临时\...\ 我已不用，可清」 / 「占 12 MB」 / 「本周内」
 *
 * 为什么要机械解析：原文的格式是给人读的，但**回执要靠它闭环** ——
 * 承接方要能一眼看出「这活要什么、急不急」，才谈得上回执。
 * 所以这里把三段拆成字段，缺段不算请求（判 WARN 并指出缺哪段）。
 */
export function parseThreePart(content) {
  const parts = String(content ?? '').split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  const [want, why, when] = parts;
  const missing = [];
  if (!want) missing.push('要什么');
  if (!why) missing.push('为什么');
  if (!when) missing.push('期望什么时候');
  return {
    ok: missing.length === 0,
    missing,
    want: want ?? '',
    why: why ?? '',
    when: when ?? '',
    // 只有 1 段（没写斜杠）时不当成错误 —— 兼容旧写法，但标出来
    segments: parts.length,
  };
}

/** 渲染成原文那种一行格式（便于人读 / 可 grep） */
export function formatRequestLine(r) {
  const p = r.parts ?? {};
  return '【请求·来自 ' + r.from + '·' + String(r.at).slice(0, 10) + '】'
    + (p.want || r.content) + ' / ' + (p.why || '—') + ' / ' + (p.when || '—');
}

const RECEIPT = path.join(REPO, 'evidence/collab/receipts.jsonl');

/**
 * 回执 —— 承接方干完活必须写回（照搬原文「干完活必须写回」）。
 * 原文的三类写回点：新决策→§五、进度/下一步/卡点→覆盖§〇、新坑→技能。
 * 我们对应成回执的 kind 字段：decision / progress / pitfall。
 */
export function appendReceipt(row) {
  fs.mkdirSync(path.dirname(RECEIPT), { recursive: true });
  fs.appendFileSync(RECEIPT, JSON.stringify(row) + '\n', 'utf8');
  return path.relative(REPO, RECEIPT);
}

export function readReceipts(reqId = null) {
  try {
    const rows = fs.readFileSync(RECEIPT, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return reqId ? rows.filter((r) => r.reqId === reqId) : rows;
  } catch { return []; }
}

// ── CLI ──

function getFlag(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null;
}

function main(argv) {
  const dry = argv.includes('--dry');
  const list = argv.includes('--list');
  const listReceipts = argv.includes('--receipts');
  const ackId = getFlag(argv, '--ack');
  const showId = getFlag(argv, '--show');
  const get = (flag) => getFlag(argv, flag);
  const sc = loadScenes();
  if (!sc.ok) {
    console.log('  ❔ ' + sc.why);
    console.log('  四态: UNKNOWN —— 读不到场景清单，判不了谁该接这个请求');
    process.exit(2);
  }

  if (listReceipts) {
    const reqId = get('--req');
    const rows = readReceipts(reqId);
    console.log('');
    console.log('  回执（' + (reqId ? reqId : '全部') + '）');
    console.log('  ' + '─'.repeat(72));
    if (!rows.length) console.log('    （还没有回执）');
    for (const r of rows.slice(-30)) {
      console.log('    ' + String(r.at || '').slice(0, 16).replace('T', ' ') + '  ' + String(r.reqId || '').padEnd(14)
        + '  [' + String(r.kind || 'progress') + ']  ' + String(r.from || '?') + '  ' + String(r.note || '').slice(0, 50));
    }
    console.log('');
    console.log('  四态: PASS —— 共 ' + rows.length + ' 条回执');
    console.log('');
    process.exit(0);
  }

  if (showId) {
    const all = readRequests();
    const r = all.find((x) => x.id === showId);
    if (!r) {
      console.log('');
      console.log('  ✗ 找不到请求: ' + showId);
      console.log('  四态: FAIL');
      console.log('');
      process.exit(1);
    }
    const recs = readReceipts(showId);
    console.log('');
    console.log('  请求 ' + r.id);
    console.log('  ' + formatRequestLine(r));
    console.log('  状态: ' + r.delivered + '  from=' + r.from + '  to=' + r.to);
    if (recs.length) {
      console.log('  回执:');
      for (const rc of recs) console.log('    - [' + rc.kind + '] ' + rc.from + '  ' + rc.note);
    } else {
      console.log('  回执: （无）');
    }
    console.log('');
    console.log('  四态: PASS');
    console.log('');
    process.exit(0);
  }

  if (ackId) {
    const kind = get('--kind') || 'progress';
    const from = get('--from');
    const skip = new Set([ackId, kind, from].filter(Boolean));
    const note = argv.filter((a) => !a.startsWith('--') && !skip.has(a)).join(' ').trim();
    const kinds = ['decision', 'progress', 'pitfall'];
    const why = [];
    if (!kinds.includes(kind)) why.push('kind 必须是 decision/progress/pitfall');
    if (!from) why.push('缺少 --from（回执方/承接场景）');
    else if (!sc.scenes.map((s) => s.sceneId).includes(from)) why.push('回执方不存在：' + from);
    if (!note) why.push('缺少回执内容');
    const all = readRequests();
    const target = all.find((r) => r.id === ackId);
    if (!target) why.push('找不到请求: ' + ackId);
    else if (from && target.to !== from) why.push('回执方必须是承接方 ' + target.to + '（你填的是 ' + from + '）');
    if (why.length) {
      console.log('');
      console.log('  ✗ 回执拒绝：' + why.join('；'));
      console.log('  四态: FAIL');
      console.log('');
      process.exit(1);
    }
    const row = {
      id: 'RCP-' + Date.now().toString(36),
      reqId: ackId,
      at: new Date().toISOString(),
      from,
      to: target.from,
      kind,
      note,
    };
    if (dry) {
      console.log('');
      console.log('  （--dry 空跑）将追加回执：');
      console.log('    ' + JSON.stringify(row, null, 2).split('\n').join('\n    '));
      console.log('  四态: PASS —— 空跑通过');
      console.log('');
      process.exit(0);
    }
    appendReceipt(row);
    console.log('');
    console.log('  ✓ 已回执 ' + ackId);
    console.log('    kind: ' + kind + '  from: ' + from + '  → ' + target.from);
    console.log('    落点: evidence/collab/receipts.jsonl');
    console.log('  四态: PASS —— 回执已写入（照搬原文「干完活必须写回」）');
    console.log('');
    process.exit(0);
  }

  if (list) {
    const scene = get('--scene');
    const rows = readRequests(scene);
    const receipts = readReceipts();
    const byReq = new Map();
    for (const rc of receipts) byReq.set(rc.reqId, (byReq.get(rc.reqId) || 0) + 1);
    console.log('');
    console.log('  跨场景请求（' + (scene ? '与 ' + scene + ' 相关' : '全部') + '）');
    console.log('  ' + '─'.repeat(72));
    if (!rows.length) console.log('    （还没有请求）');
    for (const r of rows.slice(-20)) {
      const rc = byReq.get(r.id) || 0;
      console.log('    ' + r.id.padEnd(14) + ' ' + r.at.slice(0, 16).replace('T', ' ') + '  ' + r.from.padEnd(14) + '→ ' + r.to.padEnd(14)
        + ' [' + r.delivered + '] rcpt=' + rc + '  ' + String(r.content).slice(0, 34));
    }
    console.log('');
    console.log('  四态: PASS —— 共 ' + rows.length + ' 条请求 / ' + receipts.length + ' 条回执');
    console.log('');
    process.exit(0);
  }

  const content = argv.filter((a) => !a.startsWith('--') && a !== get('--from') && a !== get('--to')).join(' ').trim();
  const req = { from: get('--from'), to: get('--to'), content };
  const v = validateRequest(req, sc.scenes);
  if (!v.ok) {
    console.log('');
    console.log('  ✗ 拒绝：' + v.why);
    console.log('  可用场景：' + sc.scenes.map((s) => s.sceneId).join('、'));
    console.log('');
    console.log('  四态: FAIL —— 请求不合法');
    console.log('');
    process.exit(1);
  }

  const row = {
    id: 'REQ-' + Date.now().toString(36),
    at: new Date().toISOString(),
    from: req.from,
    to: req.to,
    content,
    // 【照搬原文「RPC 不通会自动降级」】我们这里没有常驻 RPC 转发器时，
    // 一律标 degraded —— **不假装送达**。
    delivered: 'degraded',
    note: '已写入队列；承接方下次开工时读 evidence/collab/requests.jsonl 认领',
  };

  // 【照搬 §四 三段式】要什么 / 为什么 / 期望什么时候
  const three = parseThreePart(content);
  row.parts = { want: three.want, why: three.why, when: three.when };
  row.line = null; // 下面补（需要 row.at）
  if (!three.ok) {
    row.note += '；⚠ 缺段：' + three.missing.join('、') + '（照搬原文格式：要什么 / 为什么 / 期望什么时候）';
  }

  if (dry) {
    console.log('');
    console.log('  （--dry 空跑，不写盘）将追加一行：');
    console.log('    ' + JSON.stringify(row, null, 2).split('\n').join('\n    '));
    console.log('');
    console.log('  四态: PASS —— 空跑通过，换成不带 --dry 就真的写');
    console.log('');
    process.exit(0);
  }

  appendRequest(row);
  console.log('');
  console.log('  ✓ 已受理 ' + row.from + ' → ' + row.to);
  console.log('    请求 id: ' + row.id);
  console.log('    落点:    evidence/collab/requests.jsonl');
  console.log('    送达状态: degraded（没有常驻转发器，如实标注，不谎报送达）');
  if (three.ok) {
    console.log('    三段式: ✓ 要什么「' + three.want.slice(0, 20) + '」/ 为什么「' + three.why.slice(0, 16)
      + '」/ 期望「' + three.when.slice(0, 12) + '」');
  } else {
    console.log('    ⚠ 三段式不全，缺：' + three.missing.join('、'));
    console.log('      原文格式：要什么 / 为什么 / 期望什么时候（用斜杠分隔）');
  }
  console.log('');
  console.log('  四态: WARN —— 已入队但未直达承接方（降级）'
    + (three.ok ? '' : '；且三段式不全') + '。承接方开工时读队列认领。');
  console.log('');
  process.exit(3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
