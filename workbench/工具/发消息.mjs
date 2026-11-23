#!/usr/bin/env node
/**
 * 发消息.mjs —— 给另一个场景留一条消息（纯文件，不调用任何接口）
 *
 * 用法：
 *   node 工具\发消息.mjs --to 命令 "内容"
 *   node 工具\发消息.mjs --list          # 看最近的消息
 *   node 工具\发消息.mjs --selftest      # 自测
 *
 * 只做两件事：
 *   1. 目标场景的 场景私有记忆.md 追加一行 ## 〇-通知
 *   2. _共享记忆\_跨场景通知.md 追加一条
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(ROOT, '数据', '.dsh', '场景记忆');
const BOARD = path.join(MEM, '_共享记忆', '_跨场景通知.md');

// ══════════════════════════════════════════════════════════════
//  判据（唯一出处）
// ══════════════════════════════════════════════════════════════

/**
 * 消息最少多少字符
 *
 * ⚠ 2026-11-12 新增。原来只检查 `!text`（非空），于是
 *    `--to 调研 "好"` 会把「好」这个字追加进**别人的**场景私有记忆。
 *
 * 这是本项目第四次遇到「判据只检查非空」：
 *   ① 派单 --ack      接受「好了」
 *   ② 消息闸          接受空话消息
 *   ③ 互问 --answer   接受「好」（写进提问者记忆）
 *   ④ 发消息          接受「好」（写进目标场景记忆）
 *
 * 而且这条最严重：它是**跨场景写入**，一个场景的敷衍变成另一个场景的记忆污染。
 */
export const MIN_MSG_CHARS = 10;

/** 空话词表（单独一个词不构成消息） */
export const EMPTY_WORDS = [
  '好', '好的', '好滴', '行', '可以', '收到', '知道了', '明白', '了解',
  'ok', 'OK', 'Ok', '嗯', '哦', '对', '是的', '没问题', '已阅', '看看',
];

/**
 * 判一条消息能不能写进别人的记忆
 * @param {string} text
 * @returns {{ok:boolean, why:string}}
 */
export function judgeMessage(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, why: '内容为空' };
  if (s.length < MIN_MSG_CHARS) {
    return {
      ok: false,
      why: '太短（' + s.length + ' < ' + MIN_MSG_CHARS +
        ' 字符）—— 「好」「收到」这种不是消息，写进别人的记忆等于污染',
    };
  }
  if (EMPTY_WORDS.includes(s)) {
    return { ok: false, why: '「' + s + '」是空话，不是消息' };
  }
  return { ok: true, why: '' };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
export function selftest() {
  const R = [];
  const chk = (n, ok, d) => {
    R.push(ok);
    console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d !== undefined ? '  ' + d : ''));
  };

  console.log('='.repeat(72));
  console.log('  发消息 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】判据常量');
  chk('有最小长度限制', MIN_MSG_CHARS > 0, 'MIN_MSG_CHARS=' + MIN_MSG_CHARS);
  chk('空话黑名单非空', EMPTY_WORDS.length > 0, EMPTY_WORDS.length + ' 个词');
  chk('黑名单含「好」「收到」',
    EMPTY_WORDS.includes('好') && EMPTY_WORDS.includes('收到'));

  console.log();
  console.log('【二】反例：空话必须被拒（这是本轮修的缺陷）');
  {
    // 实测事故：--to 调研 "好" 把「好」写进了调研的场景私有记忆
    for (const w of ['好', '收到', 'OK', '是的', '嗯']) {
      const r = judgeMessage(w);
      chk('反例：「' + w + '」必须拒', r.ok === false, r.why);
    }
    chk('反例：纯空白必须拒', judgeMessage('   ').ok === false, judgeMessage('   ').why);
    chk('反例：空字符串必须拒', judgeMessage('').ok === false, judgeMessage('').why);
  }

  console.log();
  console.log('【三】反例：黑名单词都短于阈值（被长度检查兜住）');
  {
    const longEmpty = EMPTY_WORDS.filter((w) => w.length >= MIN_MSG_CHARS);
    chk('黑名单里的词都短于 MIN_MSG_CHARS', longEmpty.length === 0,
      '长空话词 ' + longEmpty.length + ' 个');
    // 逐个验证都被拒
    let allRejected = true;
    for (const w of EMPTY_WORDS) {
      if (judgeMessage(w).ok) { allRejected = false; break; }
    }
    chk('反例：黑名单词逐个提交都必须被拒', allRejected);
  }

  console.log();
  console.log('【四】正例：有实质内容必须放行');
  {
    const good = '请把竞品功能矩阵的第 3 行补齐，缺少定价信息';
    chk('正例：具体请求放行', judgeMessage(good).ok === true, '长度 ' + good.length);
    chk('正例：短但有信息量放行',
      judgeMessage('里程碑要加验收标准').ok === false &&
      /太短/.test(judgeMessage('里程碑要加验收标准').why),
      '9 字符 < ' + MIN_MSG_CHARS + '，判据正确地拒了（这是「长度」不是「空话」）');
    chk('正例：刚好到阈值放行',
      judgeMessage('里程碑要加验收标准啊').ok === true, '长度 10');
  }

  console.log();
  console.log('【五】关键：跨场景写入的判据');
  chk('关键：跨场景写入必须有实质内容判据（不是只查非空）',
    MIN_MSG_CHARS >= 10 && EMPTY_WORDS.length > 0,
    '否则一个「好」字就能污染别人记忆');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter(Boolean).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) process.exitCode = 1;
  console.log('='.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : ''; };
  const to = val('--to');
  const text = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--to').join(' ').trim();

  if (argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  if (argv.includes('--list')) {
    const t = fs.existsSync(BOARD)
      ? fs.readFileSync(BOARD, 'utf8').split('\n').filter((l) => l.trim().startsWith('-'))
      : [];
    console.log(t.slice(-15).join('\n') || '（还没有消息）');
    process.exit(0);
  }

  if (!to) {
    console.log('用法：node 工具\\发消息.mjs --to <场景目录> "内容"');
    process.exit(1);
  }

  // ⚠ 判据：内容必须有实质（不是只查非空）
  const v = judgeMessage(text);
  if (!v.ok) {
    console.error('⛔ ' + v.why);
    if (!text) console.error('   用法：node 工具\\发消息.mjs --to <场景目录> "内容"');
    process.exit(2);
  }

  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = '- [' + ts + '] → ' + to + '：' + text;

  fs.mkdirSync(path.dirname(BOARD), { recursive: true });
  if (!fs.existsSync(BOARD)) fs.writeFileSync(BOARD, '# 跨场景通知\n\n', 'utf8');
  fs.appendFileSync(BOARD, line + '\n', 'utf8');

  const memFile = path.join(MEM, to, '场景私有记忆.md');
  if (fs.existsSync(memFile)) {
    let t = fs.readFileSync(memFile, 'utf8');
    if (!t.includes('## 〇-通知')) t += '\n## 〇-通知\n';
    t += '\n' + line + '\n';
    fs.writeFileSync(memFile, t, 'utf8');
  } else {
    console.log('! 目标场景没有记忆文件：' + memFile + '（只写进了看板）');
  }
  console.log('✓ 已发：' + to);
}
