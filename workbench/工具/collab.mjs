/**
 * L4 协作层 —— 四块板 + 派单回执
 *
 * luanyujia 的四块板（各回答一个问题）：
 *   ① 通知看板 → 发生了什么
 *   ② 待办板   → 该做什么
 *   ③ 总索引   → 东西在哪
 *   ④ 体检结果 → 机器健康吗
 *
 * 协作机制的核心是「防无限对话」：
 *   一次派单 = 一条回执 = 一条收尾 = 结束（≤200 字）
 *   收到【不需要回执·知悉】一个字都不许回
 *   同一任务 ≤3 条消息
 *
 * 用法：
 *   node 工具\collab.mjs board                    看四块板
 *   node 工具\collab.mjs send --to <场景> --msg "..."   派单（自动补标记）
 *   node 工具\collab.mjs inbox --scene <场景>      看收件箱
 *   node 工具\collab.mjs ack --id <n>              销账
 *   node 工具\collab.mjs check                    校验四块板完整性
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
const INBOX_DIR = path.join(SHARED, '_收件箱');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const cmd = process.argv[2] || 'board';
const val = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? (process.argv[i + 1] || '') : ''; };

const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const msgs = () => {
  const f = path.join(SHARED, '_跨场景通知.md');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().startsWith('- '));
};

// ═══════ board ═══════
if (cmd === 'board') {
  console.log(C.bold + 'L4 协作层 · 四块板' + C.reset);
  console.log();

  // ① 通知看板
  const noticeLines = msgs();
  console.log(C.cyan + '① 通知看板' + C.reset + '（发生了什么）  ' + noticeLines.length + ' 条');
  for (const l of noticeLines.slice(-6)) console.log('   ' + l.slice(0, 100));
  if (!noticeLines.length) console.log('   ' + C.dim + '（空）' + C.reset);

  // ② 待办板
  const todoFile = path.join(SHARED, '_待办.md');
  const todoLines = fs.existsSync(todoFile)
    ? fs.readFileSync(todoFile, 'utf8').split('\n').filter(l => l.trim().startsWith('-'))
    : [];
  console.log();
  console.log(C.cyan + '② 待办板' + C.reset + '（该做什么）  ' + todoLines.length + ' 项');
  for (const l of todoLines) console.log('   ' + l.slice(0, 100));
  if (!todoLines.length) console.log('   ' + C.dim + '（空）' + C.reset);

  // ③ 总索引
  const idxFile = path.join(SHARED, '索引.md');
  console.log();
  console.log(C.cyan + '③ 总索引' + C.reset + '（东西在哪）');
  if (fs.existsSync(idxFile)) {
    const t = fs.readFileSync(idxFile, 'utf8');
    const rowCount = (t.match(/^\|/gm) || []).length - 2;
    console.log('   ' + Math.max(0, rowCount) + ' 行登记');
  } else {
    console.log('   ' + C.dim + '（缺失）' + C.reset);
  }

  // ④ 体检结果
  const healthFile = path.join(SHARED, '体检结果.json');
  console.log();
  console.log(C.cyan + '④ 体检结果' + C.reset + '（机器健康吗）');
  if (fs.existsSync(healthFile)) {
    try {
      const h = JSON.parse(fs.readFileSync(healthFile, 'utf8').replace(/\uFEFF/g, ''));
      console.log('   上次：' + (h.at || '(无)'));
      if (h.summary) console.log('   ' + h.summary.ok + '/' + h.summary.total + ' 场景通过');
    } catch (e) { console.log('   ' + C.red + 'JSON 非法' + C.reset); }
  } else {
    console.log('   ' + C.dim + '（缺失）' + C.reset);
  }

  process.exit(0);
}

// ═══════ send ═══════
if (cmd === 'send') {
  const to = val('--to');
  let msg = val('--msg');
  if (!to || !msg) {
    console.error('用法：send --to <场景> --msg "..."');
    process.exit(1);
  }

  // 自动补标记（luanyujia 的规则）
  const needReply = !msg.includes('【');
  if (needReply) msg = '【需要回执】' + msg;
  if (!msg.includes('【结束】')) msg = msg + '  【结束】';

  // 字数限制
  if (msg.length > 200) {
    console.log(C.yellow + '! 消息超过 200 字（' + msg.length + '），建议精简' + C.reset);
  }

  const line = '- [' + now() + '] → ' + to + '：' + msg;
  fs.appendFileSync(path.join(SHARED, '_跨场景通知.md'), line + '\n', 'utf8');

  // 写进目标的收件箱
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const inboxFile = path.join(INBOX_DIR, to + '.md');
  if (!fs.existsSync(inboxFile)) fs.writeFileSync(inboxFile, '# ' + to + ' 的收件箱\n\n', 'utf8');
  fs.appendFileSync(inboxFile, line + '\n', 'utf8');

  console.log(C.green + 'OK' + C.reset + ' 已发给 ' + to);
  console.log('   ' + msg);
  console.log(C.dim + '   （标记已自动补齐，≤200 字）' + C.reset);
  process.exit(0);
}

// ═══════ inbox ═══════
if (cmd === 'inbox') {
  const scene = val('--scene');
  if (!scene) { console.error('用法：inbox --scene <场景>'); process.exit(1); }
  const f = path.join(INBOX_DIR, scene + '.md');
  if (!fs.existsSync(f)) { console.log('（收件箱为空）'); process.exit(0); }
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim().startsWith('- '));
  console.log(C.bold + scene + ' 的收件箱' + C.reset + '  ' + lines.length + ' 条');
  for (const l of lines) console.log('   ' + l);
  process.exit(0);
}

// ═══════ check ═══════
if (cmd === 'check') {
  console.log(C.bold + 'L4 协作层校验' + C.reset);
  console.log();

  const boards = [
    { name: '通知看板', file: '_跨场景通知.md', required: true },
    { name: '待办板', file: '_待办.md', required: true },
    { name: '总索引', file: '索引.md', required: true },
    { name: '体检结果', file: '体检结果.json', required: true },
  ];

  let bad = 0;
  for (const b of boards) {
    const p = path.join(SHARED, b.file);
    const exists = fs.existsSync(p);
    console.log('  ' + (exists ? C.green + '✓' : C.red + 'X') + C.reset + ' ' + b.name.padEnd(12) +
      (exists ? (fs.statSync(p).size / 1024).toFixed(1) + ' KB' : C.red + '缺失' + C.reset));
    if (!exists && b.required) bad++;
  }

  console.log();
  console.log(bad === 0 ? C.green + 'L4 完整' + C.reset : C.red + 'L4 缺 ' + bad + ' 块板' + C.reset);
  process.exit(bad ? 2 : 0);
}

// ═══════ help ═══════
console.log('L4 协作层');
console.log();
console.log('  node 工具\\collab.mjs board                    看四块板');
console.log('  node 工具\\collab.mjs send --to <场景> --msg "..."');
console.log('  node 工具\\collab.mjs inbox --scene <场景>');
console.log('  node 工具\\collab.mjs check');
