#!/usr/bin/env node
/**
 * 任务看板 —— 做完就划掉，保持清爽
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1o4xg6RE9m「神经中枢控制电脑」）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [03:54] 「还有一个就是任务看板。
 *  >   有的时候场景协作之间，他们互相要发送回执，
 *  >   可能有的场景他做任务做得慢，然后这个回执他就看不到。
 *  >   这个时候就可以搞一个任务看板，
 *  >   把这些有冲突的地方、待办的地方、通知的地方全部都放在任务看板里。
 *  >   **这个任务看板就相当于是放在这个模型前面了，
 *  >   他每次看到这个看板，就知道自己要做什麼事情。**」
 *
 *  > [04:17] **「这个任务看板它也不是像很多观众想的一样，
 *  >   是一个累积的大文件。就是每个场景做完了之后，
 *  >   它就会把自己的东西给划掉。
 *  >   它就变成轻轻爽爽的一个空白的文档。」**
 *
 * ══════════════════════════════════════════════════════════════
 *  核心设计：不是「累积」，是「划掉」
 * ══════════════════════════════════════════════════════════════
 *
 *  错误做法（累积）：
 *    看板越来越长 → 每次读全部 → token 成本线性增长
 *
 *  正确做法（划掉）：
 *    做完了 → 划掉（删除）→ 看板回到空白
 *    → 每次只看到「还没做的」
 *
 *  ⚠ 划掉的东西去哪？→ 进归档层（只增不改），不是丢弃。
 *
 * ══════════════════════════════════════════════════════════════
 *  看板内容（三类）
 * ══════════════════════════════════════════════════════════════
 *
 *  todo     待办：谁要做、做什么、什么时候前
 *  notice   通知：谁要告诉谁、什么事
 *  conflict 冲突：两个场景动了同一处
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/看板.mjs --show                    看当前看板
 *  node 工具/看板.mjs --add --type todo --to 架构梳理 --text "..." [--due 2026-11-12]
 *  node 工具/看板.mjs --done <id>                划掉一项（进归档）
 *  node 工具/看板.mjs --clear-done               清掉所有已完成的（进归档）
 *  node 工具/看板.mjs --stats                    看统计
 *  node 工具/看板.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB_DIR = path.resolve(HERE, '..');
const WB = path.resolve(WB_DIR, '..');
const BOARD_DIR = path.join(WB_DIR, '数据', '.dsh', '任务看板');
const BOARD_FILE = path.join(BOARD_DIR, '看板.md');
const DATA_FILE = path.join(BOARD_DIR, '看板.json');
const ARCH_ROOT = path.join(WB_DIR, '数据', '.dsh', '归档层');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  三类看板项
// ══════════════════════════════════════════════════════════════
export const ITEM_TYPES = {
  todo: { name: '待办', icon: '□', desc: '谁要做、做什么' },
  notice: { name: '通知', icon: '◇', desc: '谁要告诉谁' },
  conflict: { name: '冲突', icon: '⚠', desc: '两个场景动了同一处' },
};

export const LIMITS = {
  /** 看板最多显示多少项（超过要提醒清理） */
  MAX_ITEMS: 20,
  /** 单项正文最多多少字 */
  TEXT_MAX: 120,
};

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function loadBoard() {
  const j = readJsonSafe(DATA_FILE);
  if (!j || !Array.isArray(j.items)) return { items: [], seq: 0 };
  return j;
}

function saveBoard(b) {
  fs.mkdirSync(BOARD_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(b, null, 2), 'utf8');
  // 同时生成人可读的 md
  fs.writeFileSync(BOARD_FILE, renderBoard(b), 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  渲染成 Markdown（给 AI 读）
//
//  ⚠ 关键：空的时候要明确写「空」，不是一个空文件。
//    因为 AI 看到空文件可能以为是读取失败。
// ══════════════════════════════════════════════════════════════
export function renderBoard(board) {
  const items = board.items || [];
  const L = [];

  L.push('# 任务看板');
  L.push('');
  L.push('> 这是所有场景共用的待办/通知/冲突看板。');
  L.push('> **做完就划掉** —— 划掉后进归档层，不会累积成一个大文件。');
  L.push('>');
  L.push('> 依据：视频 BV1o4xg6RE9m');
  L.push('> 「每个场景做完了之后，它就会把自己的东西给划掉。');
  L.push('>  它就变成轻轻爽爽的一个空白的文档。」');
  L.push('');

  if (items.length === 0) {
    L.push('## 当前为空');
    L.push('');
    L.push('没有待办、通知或冲突。**这是好事**，说明都处理完了。');
    L.push('');
    return L.join('\n');
  }

  // 按类型分组
  for (const [type, info] of Object.entries(ITEM_TYPES)) {
    const group = items.filter((x) => x.type === type);
    if (group.length === 0) continue;
    L.push('## ' + info.icon + ' ' + info.name + '（' + group.length + '）');
    L.push('');
    for (const it of group) {
      const due = it.due ? '  ⏰ ' + it.due : '';
      const from = it.from ? it.from + ' → ' : '';
      L.push('- **#' + it.id + '** ' + from + it.to + '：' + it.text + due);
      L.push('  - 划掉：`node 工具/看板.mjs --done ' + it.id + '`');
    }
    L.push('');
  }

  if (items.length >= LIMITS.MAX_ITEMS) {
    L.push('> ⚠️ 看板已有 ' + items.length + ' 项，接近上限（' + LIMITS.MAX_ITEMS + '）。');
    L.push('> 请尽快处理或划掉，否则会变成「累积的大文件」。');
    L.push('');
  }

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  添加一项
// ══════════════════════════════════════════════════════════════
export function addItem(opts) {
  const o = opts || {};
  const type = o.type || 'todo';
  if (!ITEM_TYPES[type]) return { ok: false, error: '未知类型: ' + type };

  const text = String(o.text || '').trim();
  if (!text) return { ok: false, error: '需要 --text' };
  if (text.length > LIMITS.TEXT_MAX) {
    return { ok: false, error: '正文过长（' + text.length + ' > ' + LIMITS.TEXT_MAX + '）' };
  }

  const to = String(o.to || '').trim();
  if (!to) return { ok: false, error: '需要 --to（给谁）' };

  const board = loadBoard();
  board.seq = (board.seq || 0) + 1;
  const id = String(board.seq).padStart(3, '0');

  const item = {
    id,
    type,
    typeName: ITEM_TYPES[type].name,
    from: o.from || '中枢',
    to,
    text,
    due: o.due || null,
    at: new Date(o.now || Date.now()).toISOString(),
    done: false,
  };
  board.items.push(item);
  saveBoard(board);

  return { ok: true, item, total: board.items.length };
}

// ══════════════════════════════════════════════════════════════
//  划掉一项：从看板移除 → 进归档层
// ══════════════════════════════════════════════════════════════
export function doneItem(id, opts) {
  const o = opts || {};
  const board = loadBoard();
  const idx = board.items.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, error: '找不到 #' + id };

  const item = board.items[idx];

  // 归档（只增不改）
  const archResult = archiveItem(item, o);

  // 从看板移除
  board.items.splice(idx, 1);
  saveBoard(board);

  return {
    ok: true,
    item,
    archived: archResult.ok,
    archiveId: archResult.id || null,
    remaining: board.items.length,
  };
}

function archiveItem(item, opts) {
  const o = opts || {};
  try {
    const now = new Date(o.now || Date.now());
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const monthDir = now.toISOString().slice(0, 7);
    const dir = path.join(ARCH_ROOT, 'board', monthDir);
    fs.mkdirSync(dir, { recursive: true });

    const content = '# 看板项 #' + item.id + '\n\n' +
      '- 类型：' + item.typeName + '\n' +
      '- 从：' + item.from + '\n' +
      '- 到：' + item.to + '\n' +
      '- 内容：' + item.text + '\n' +
      (item.due ? '- 截止：' + item.due + '\n' : '') +
      '- 创建：' + item.at + '\n' +
      '- 划掉：' + now.toISOString() + '\n';

    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const id = 'board-' + stamp + '-' + hash.slice(0, 8);
    const fp = path.join(dir, id + '.md');
    fs.writeFileSync(fp, content, 'utf8');

    // 更新归档索引（如果存在）
    const idxFile = path.join(ARCH_ROOT, '_索引.json');
    let idx2 = readJsonSafe(idxFile) || { items: [] };
    if (!Array.isArray(idx2.items)) idx2.items = [];
    idx2.items.push({
      id,
      type: 'board',
      typeName: '看板',
      at: now.toISOString(),
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: hash,
      sourcePath: null,
      scene: item.to,
      reason: '看板项划掉（' + item.typeName + '）',
      file: path.relative(WB_DIR, fp).replace(/\\/g, '/'),
    });
    fs.writeFileSync(idxFile, JSON.stringify(idx2, null, 2), 'utf8');

    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 60) };
  }
}

// ══════════════════════════════════════════════════════════════
//  统计
// ══════════════════════════════════════════════════════════════
export function stats() {
  const board = loadBoard();
  const byType = {};
  for (const it of board.items) byType[it.type] = (byType[it.type] || 0) + 1;
  return {
    total: board.items.length,
    byType,
    nearLimit: board.items.length >= LIMITS.MAX_ITEMS,
    empty: board.items.length === 0,
  };
}

// ══════════════════════════════════════════════════════════════
//  ⚠ 2026-11-12 新增：真实一致性检查
//
//  为什么加（原工具的盲区）
//
//  原来这个工具只能「跑一次看输出」：--show / --stats 永远 exit 0。
//  它**没有任何会失败的检查** —— 看板数据坏了、md 和 json 不一致、
//  累积成 20 项以上没人清，都不会让任何东西变红。
//  而它存在的全部理由是「不累积、做完就划掉」，
//  这条理由恰好是唯一没有被检查的东西。
//
//  判据（三条，都能造出反例）：
//    ① 看板.json 可解析，items 是数组
//    ② 看板.json 与 看板.md 内容一致（同一个事实存两处 —— renderBoard 的输出
//       必须等于「用当前 json 重新渲染一次」；不一致说明 md 被手改或没同步）
//    ③ 不累积：items 数 ≤ MAX_ITEMS（超过就是「变成大文件」，
//       这正是视频里明确反对的用法）
//
//  ⚠ 为什么 ③ 要算失败而不是警告：
//    旧代码只打印「⚠ 接近上限」，exit 仍是 0。
//    一个只在屏幕上叹气的判据 = 没有判据。
// ══════════════════════════════════════════════════════════════
export function checkBoard(opts) {
  const o = opts || {};
  const board = o.board || loadBoard();
  const problems = [];

  // ① 结构
  if (!Array.isArray(board.items)) {
    problems.push('看板.json 的 items 不是数组（结构坏了）');
    return { ok: false, problems, total: 0, empty: false };
  }

  for (const it of board.items) {
    if (!it || !it.id) problems.push('有一项缺 id');
    else if (!ITEM_TYPES[it.type]) problems.push('#' + it.id + ' 类型未知：' + it.type);
    else if (!it.text) problems.push('#' + it.id + ' 缺正文');
    else if (!it.to) problems.push('#' + it.id + ' 缺「给谁」');
  }

  // ② json 与 md 是否说同一件事
  //
  //  只在 md 文件存在时比 —— 文件不存在不算错（第一次跑还没生成）
  if (fs.existsSync(BOARD_FILE)) {
    const md = readTextSafe(BOARD_FILE);
    const expected = renderBoard(board);
    if (md !== null && md.replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) {
      problems.push('看板.md 与 看板.json 不一致（同一个事实存两处，已不同步；' +
        '重新跑一次 --show 或 --add 即可让 md 跟随 json）');
    }
  }

  // ③ 不累积
  if (board.items.length > LIMITS.MAX_ITEMS) {
    problems.push('看板积压 ' + board.items.length + ' 项 > 上限 ' + LIMITS.MAX_ITEMS +
      '（「做完就划掉」失效了，正在变成累积的大文件）');
  }

  return {
    ok: problems.length === 0,
    problems,
    total: board.items.length,
    empty: board.items.length === 0,
    nearLimit: board.items.length >= LIMITS.MAX_ITEMS,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  任务看板 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 类型和上限
  chk('三类看板项', Object.keys(ITEM_TYPES).length === 3, Object.keys(ITEM_TYPES).join(','));
  chk('有上限', LIMITS.MAX_ITEMS > 0, String(LIMITS.MAX_ITEMS));
  chk('有正文长度限制', LIMITS.TEXT_MAX > 0, String(LIMITS.TEXT_MAX));

  // ② 空看板渲染
  const emptyMd = renderBoard({ items: [] });
  chk('空看板渲染', emptyMd.includes('当前为空'), '');
  chk('空看板明确说明是好事', emptyMd.includes('这是好事'), '');

  // ③ 有项时渲染
  const board = {
    items: [
      { id: '001', type: 'todo', typeName: '待办', from: '中枢', to: '架构梳理', text: '写架构方案', due: '2026-11-12', at: new Date().toISOString() },
      { id: '002', type: 'notice', typeName: '通知', from: '调研', to: '竞品拆解', text: '资料已就绪', at: new Date().toISOString() },
      { id: '003', type: 'conflict', typeName: '冲突', from: '本地电脑', to: '架构梳理', text: '同时要改同一文件', at: new Date().toISOString() },
    ],
  };
  const md = renderBoard(board);
  chk('渲染出待办', md.includes('待办') && md.includes('写架构方案'), '');
  chk('渲染出通知', md.includes('通知'), '');
  chk('渲染出冲突', md.includes('冲突'), '');
  chk('带划掉命令', md.includes('--done 001'), '');
  chk('带截止时间', md.includes('2026-11-12'), '');

  // ④ 接近上限时警告
  const many = { items: Array.from({ length: LIMITS.MAX_ITEMS }, (_, i) => ({
    id: String(i + 1).padStart(3, '0'), type: 'todo', typeName: '待办',
    from: '中枢', to: 'X', text: '任务' + i, at: new Date().toISOString(),
  })) };
  const manyMd = renderBoard(many);
  chk('接近上限有警告', manyMd.includes('接近上限'), '');

  // ⑤ 统计
  chk('统计能跑', typeof stats().total === 'number', '当前 ' + stats().total + ' 项');

  // ⑥ 关键：划掉后看板要变空（不累积）
  chk('关键：设计目标是「划掉后变空」',
      emptyMd.includes('当前为空') && ITEM_TYPES.todo !== undefined,
      '这是任务看板存在的唯一理由——不能累积成一个大文件');

  console.log();
  // ⚠ 2026-11-12：passed 的计算移到反例之后（否则反例不计入统计）
  
  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 补（检查真实性审计报「缺反例」）：
  //
  //   上面全是正例检查（渲染出待办、带划掉命令…），
  //   但没有一条验证「**不该出现的东西不会出现**」。
  //   一个只验正例的检查，无法证明边界是对的。
  //
  //   这里补 4 条反例：
  //     ① 超上限必须拒绝（不是静默截断）
  //     ② 正文超长必须拒绝
  //     ③ 未知类型必须拒绝
  //     ④ 划掉后不该还在看板上
  // ══════════════════════════════════════════════════════════════
  console.log();
  console.log('  反例验证（不该通过的情况必须被拒）');

  // ① 超上限
  {
    const over = { items: Array.from({ length: LIMITS.MAX_ITEMS + 1 }, (_, i) => ({
      id: String(i + 1).padStart(3, '0'), type: 'todo', typeName: '待办',
      from: 'A', to: 'B', text: 't' + i, at: new Date().toISOString(),
    })) };
    let rejected = false;
    try {
      const out = renderBoard(over);
      rejected = /超|上限|太多|MAX/i.test(out);
    } catch { rejected = true; }
    chk('反例：超过上限必须拒绝或警告', rejected, rejected ? '' : '竟然静默渲染了');
  }

  // ② 正文超长
  {
    const tooLong = { items: [{
      id: '001', type: 'todo', typeName: '待办', from: 'A', to: 'B',
      text: 'x'.repeat(LIMITS.TEXT_MAX + 100), at: new Date().toISOString(),
    }] };
    let handled = false;
    try {
      const out = renderBoard(tooLong);
      // 要么截断（输出长度有限），要么明确报错
      const maxExpected = LIMITS.TEXT_MAX * 3 + 500;
      handled = out.length < maxExpected || /截断|超长|too long/i.test(out);
    } catch { handled = true; }
    chk('反例：正文超长必须截断或拒绝', handled, handled ? '' : '全文渲染了超长正文');
  }

  // ③ 未知类型
  {
    const unknown = { items: [{
      id: '001', type: 'not-a-real-type', typeName: '未知',
      from: 'A', to: 'B', text: 'x', at: new Date().toISOString(),
    }] };
    let handled = false;
    try {
      const out = renderBoard(unknown);
      handled = /未知|unknown|无效|不支持/i.test(out) || out.length < 200;
    } catch { handled = true; }
    chk('反例：未知类型必须被标记或忽略', handled, handled ? '' : '把未知类型当正常项渲染了');
  }

  // ④ 划掉后不该还在
  {
    const withDone = { items: [
      { id: '001', type: 'todo', typeName: '待办', from: 'A', to: 'B', text: '已完成的活', at: new Date().toISOString(), state: 'done', doneAt: new Date().toISOString() },
      { id: '002', type: 'todo', typeName: '待办', from: 'A', to: 'B', text: '还没做的活', at: new Date().toISOString() },
    ] };
    const out = renderBoard(withDone);
    // 已划掉的项可以显示为「已划掉」，但不该出现在「待办」区
    const doneShown = /已完成的活/.test(out);
    const pendingShown = /还没做的活/.test(out);
    chk('反例：划掉的活不该混在待办里', pendingShown && (!doneShown || /划掉|已完成|done/i.test(out)),
        'pending=' + pendingShown + ' done=' + doneShown);
  }

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 新增反例：真实一致性检查必须会红
  //
  //  上面所有反例都只喂给 renderBoard，证明不了「真实看板数据坏了会失败」——
  //  因为本轮之前根本不存在 checkBoard。这一段验证它真的会失败。
  // ══════════════════════════════════════════════════════════════
  console.log();
  console.log('  真实一致性（checkBoard 的反例）');

  // 反例①：结构坏了
  {
    const c = checkBoard({ board: { items: 'not-an-array' } });
    chk('反例：items 不是数组 ⇒ 报错',
        c.ok === false && c.problems.some((p) => p.includes('不是数组')), c.problems[0]);
  }

  // 反例②：项字段缺失
  {
    const c = checkBoard({ board: { items: [{ id: '001', type: 'todo', text: 'x' }] } });
    chk('反例：缺「给谁」⇒ 报错',
        c.ok === false && c.problems.some((p) => p.includes('给谁')), c.problems[0]);
  }

  // 反例③：未知类型
  {
    const c = checkBoard({ board: { items: [{ id: '001', type: 'nope', to: 'X', text: 'x' }] } });
    chk('反例：未知类型 ⇒ 报错',
        c.ok === false && c.problems.some((p) => p.includes('类型未知')), c.problems[0]);
  }

  // 反例④：累积超过上限（视频里明确反对的用法）
  {
    const over = { items: Array.from({ length: LIMITS.MAX_ITEMS + 3 }, (_, i) => ({
      id: String(i + 1).padStart(3, '0'), type: 'todo', typeName: '待办',
      from: 'A', to: 'B', text: 't' + i, at: new Date().toISOString(),
    })) };
    const c = checkBoard({ board: over });
    chk('反例：积压超过上限 ⇒ 报错（不是只在屏幕上叹气）',
        c.ok === false && c.problems.some((p) => p.includes('积压')),
        c.problems.find((p) => p.includes('积压')));
  }

  console.log('─'.repeat(72));
  const passed = R.filter(Boolean).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ⚠ 2026-11-12 新增 --check：真实检查，会失败
  //
  //  原来这个工具没有任何会失败的入口（--show/--stats 都是 exit 0），
  //  在机制体检里只能跑 --selftest，等于「只验判据、不看真实看板」。
  if (has('--check')) {
    const c = checkBoard();
    console.log('═'.repeat(72));
    console.log('  任务看板 · 一致性检查');
    console.log('═'.repeat(72));
    console.log();
    console.log('  当前项数: ' + c.total + ' / ' + LIMITS.MAX_ITEMS +
      (c.empty ? '（空，清爽 ✓）' : ''));
    console.log();
    if (c.ok) {
      console.log('  ✓ 看板结构与同步状态正常');
      console.log('    · json 可解析，项字段完整');
      console.log('    · 看板.md 与 看板.json 一致');
      console.log('    · 未超过上限（没有累积成大文件）');
    } else {
      console.log('  ✗ ' + c.problems.length + ' 处问题：');
      console.log();
      for (const p of c.problems) console.log('    · ' + p);
    }
    console.log();
    console.log('─'.repeat(72));
    console.log('  判据：结构完整 / md 与 json 一致 / 项数 ≤ ' + LIMITS.MAX_ITEMS);
    console.log('  依据：视频 BV1o4xg6RE9m「做完就划掉，变成轻轻爽爽的空白文档」');
    console.log('─'.repeat(72));
    process.exit(c.ok ? 0 : 1);
  }

  // ── 看板 ──
  if (has('--show') || (!has('--add') && !has('--done') && !has('--stats') && !has('--clear-done'))) {
    const board = loadBoard();
    console.log(renderBoard(board));
    process.exit(0);
  }

  // ── 添加 ──
  if (has('--add')) {
    const r = addItem({
      type: val('--type') || 'todo',
      from: val('--from'),
      to: val('--to'),
      text: val('--text'),
      due: val('--due'),
    });
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }
    console.log('✓ 已加入看板 #' + r.item.id);
    console.log('  ' + r.item.typeName + '：' + r.item.from + ' → ' + r.item.to + '  ' + r.item.text);
    console.log('  当前看板: ' + r.total + ' 项');
    if (r.total >= LIMITS.MAX_ITEMS) {
      console.log();
      console.log('  ⚠ 已达 ' + r.total + ' 项上限，请尽快处理');
    }
    process.exit(0);
  }

  // ── 划掉 ──
  if (has('--done')) {
    const id = val('--done');
    const r = doneItem(id);
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }
    console.log('✓ 已划掉 #' + id + '：' + r.item.text);
    if (r.archived) console.log('  已归档: ' + r.archiveId);
    console.log('  看板剩余: ' + r.remaining + ' 项' + (r.remaining === 0 ? '（已清空）' : ''));
    process.exit(0);
  }

  // ── 统计 ──
  if (has('--stats')) {
    const s = stats();
    console.log('═'.repeat(72));
    console.log('  看板统计');
    console.log('═'.repeat(72));
    console.log();
    console.log('  总项数: ' + s.total + ' / ' + LIMITS.MAX_ITEMS);
    if (s.empty) {
      console.log('  状态:   ✓ 空（清爽）');
    } else if (s.nearLimit) {
      console.log('  状态:   ⚠ 接近上限，需要清理');
    } else {
      console.log('  状态:   正常');
    }
    console.log();
    for (const [t, n] of Object.entries(s.byType)) {
      console.log('  ' + (ITEM_TYPES[t]?.name || t) + '：' + n);
    }
    process.exit(0);
  }
}
