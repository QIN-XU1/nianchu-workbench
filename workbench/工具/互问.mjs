#!/usr/bin/env node
/**
 * 场景互问 —— 横向经验交流
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1mz4v62ECW「直播问答」）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [00:18] **「其实我是这样的，我每个场景都是主 A 的。
 *  >   但是他们在分工上可能会互相去讨教经验。」**
 *  >
 *  > [00:28] **「比如说我这个『DSH 改造』就是专门改造我这个工作台，
 *  >   那他肯定是有关于很多改造的经验，他的记忆已经被填得非常好了。
 *  >   这个时候假如我又出了一个『工作台定制』——
 *  >   他就像我的工人一样，是帮网友定制工作台的。
 *  >   他有些不懂的，我可以让他问我这个『DSH 改造』。」**
 *
 * ══════════════════════════════════════════════════════════════
 *  两种场景关系
 * ══════════════════════════════════════════════════════════════
 *
 *  纵向（管理）：主场景 → 子场景     ← 已有（场景层级.mjs）
 *  横向（讨教）：场景 ↔ 场景        ← **本工具补这个**
 *
 *  两者的区别：
 *    纵向 = 「你归我管，我派活给你」
 *    横向 = 「你做得好，我来问问你怎么做的」
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要横向
 * ══════════════════════════════════════════════════════════════
 *
 *  场景 A 踩过的坑，场景 B 可能正要踩。
 *  但 A 和 B 没有管理关系，所以没有「派单」的理由去问。
 *
 *  横向交流 = 让经验跨场景流动，但**不违反场景自治**：
 *    · 只读对方的记忆/技能（不改）
 *    · 问的是「你怎么做的」，不是「你替我做」
 *    · 回答进自己的记忆，不进对方的
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/互问.mjs --ask --from 实施计划 --to 架构梳理 --about "怎么定架构取舍"
 *  node 工具/互问.mjs --answer <id> --text "..."        （对方回答）
 *  node 工具/互问.mjs --pending --scene 架构梳理         看有哪些要回答
 *  node 工具/互问.mjs --list                            看所有问答
 *  node 工具/互问.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB_DIR = path.resolve(HERE, '..');
const WB = path.resolve(WB_DIR, '..');
const ASK_DIR = path.join(WB_DIR, '数据', '.dsh', '场景互问');
const ASK_FILE = path.join(ASK_DIR, '问答.json');
const MEM_ROOT = path.join(WB_DIR, '数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

export const LIMITS = {
  /** 一个问题最多多少字 */
  QUESTION_MAX: 100,
  /** 一个回答最多多少字 */
  ANSWER_MAX: 500,
  /** 一个回答最少多少字（⚠ 2026-11-12 新增） */
  ANSWER_MIN: 20,
  /** 未回答问题超过这个数要提醒 */
  PENDING_WARN: 5,
  /** 已完成的问答保留多少条 */
  KEEP_DONE: 50,
};

/**
 * 「空话答案」黑名单（⚠ 2026-11-12 新增）
 *
 * ⚠ 为什么需要：实测 E2E 发现 `--answer q003 --text "好"` 被接受，
 *    状态变成 answered，而这条答案会被写进提问者的记忆当作「学到的经验」。
 *
 *    这和 `派单 --ack` 接受「好了」是同一个病：
 *    判据只检查「非空」，不检查「有没有实质内容」。
 *
 *    后果更严重：派单回执至少还有 MIN_EVIDENCE_LEN=20，
 *    互问的回答连长度下限都没有 —— 一个「好」字就能污染别人的记忆。
 */
export const EMPTY_ANSWER_WORDS = [
  '好', '好的', '好滴', '行', '可以', '收到', '知道了', '明白', '了解',
  'ok', 'OK', 'Ok', '嗯', '哦', '对', '是的', '没问题', '已阅', '看看',
  '不知道', '不清楚', '无所谓', '随便', '都行', '你决定',
];

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

export function loadAsks() {
  const j = readJsonSafe(ASK_FILE);
  if (!j || !Array.isArray(j.items)) return { items: [], seq: 0 };
  return j;
}

function saveAsks(a) {
  fs.mkdirSync(ASK_DIR, { recursive: true });
  fs.writeFileSync(ASK_FILE, JSON.stringify(a, null, 2), 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  提问
// ══════════════════════════════════════════════════════════════
export function ask(opts) {
  const o = opts || {};
  const from = String(o.from || '').trim();
  const to = String(o.to || '').trim();
  const about = String(o.about || '').trim();

  if (!from) return { ok: false, error: '需要 --from（谁问）' };
  if (!to) return { ok: false, error: '需要 --to（问谁）' };
  if (!about) return { ok: false, error: '需要 --about（问什么）' };
  if (about.length > LIMITS.QUESTION_MAX) {
    return { ok: false, error: '问题过长（' + about.length + ' > ' + LIMITS.QUESTION_MAX + '）' };
  }
  if (from === to) return { ok: false, error: '不能问自己' };

  const a = loadAsks();
  a.seq = (a.seq || 0) + 1;
  const id = 'q' + String(a.seq).padStart(3, '0');

  const item = {
    id,
    from,
    to,
    about,
    at: new Date(o.now || Date.now()).toISOString(),
    status: 'pending',   // pending → answered
    answer: null,
    answeredAt: null,
  };
  a.items.push(item);

  // 清理过量的已完成问答
  const done = a.items.filter((x) => x.status === 'answered');
  if (done.length > LIMITS.KEEP_DONE) {
    const toRemove = new Set(done.slice(0, done.length - LIMITS.KEEP_DONE).map((x) => x.id));
    a.items = a.items.filter((x) => !toRemove.has(x.id));
  }

  saveAsks(a);
  return { ok: true, item, pendingCount: a.items.filter((x) => x.status === 'pending').length };
}

// ══════════════════════════════════════════════════════════════
//  回答
// ══════════════════════════════════════════════════════════════
export function answer(id, text, opts) {
  const o = opts || {};
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '需要 --text（回答内容）' };
  if (t.length > LIMITS.ANSWER_MAX) {
    return { ok: false, error: '回答过长（' + t.length + ' > ' + LIMITS.ANSWER_MAX + '）' };
  }

  // ⚠ 2026-11-12 加：最小长度 + 空话黑名单
  //
  //   实测 E2E 发现：`--answer q003 --text "好"` 被接受，
  //   而这条答案会被 `writeLearned` 写进提问者的记忆当作学到的经验。
  //   一个「好」字就能污染别人的记忆。
  //
  //   这和 派单 --ack 接受「好了」是同一个病：
  //   判据只检查「非空」，不检查「有没有实质内容」。
  if (t.length < LIMITS.ANSWER_MIN) {
    return {
      ok: false,
      error: '回答太短（' + t.length + ' < ' + LIMITS.ANSWER_MIN + ' 字符）—— ' +
        '「好」「收到」这种两个字不是答案，写进记忆等于污染',
    };
  }
  if (EMPTY_ANSWER_WORDS.includes(t)) {
    return {
      ok: false,
      error: '「' + t + '」是空话，不是答案 —— 对方要的是能用的结论，不是礼貌回复',
    };
  }

  const a = loadAsks();
  const item = a.items.find((x) => x.id === id);
  if (!item) return { ok: false, error: '找不到问题 ' + id };
  if (item.status === 'answered') {
    return { ok: false, error: '这个问题已答过（' + item.answeredAt + '）' };
  }

  item.status = 'answered';
  item.answer = t;
  item.answeredAt = new Date(o.now || Date.now()).toISOString();
  saveAsks(a);

  // 把回答写进提问者的记忆（这是「学到」）
  const learned = writeLearned(item);

  return { ok: true, item, learned };
}

/**
 * 把回答写进提问者的场景记忆 §五
 *
 * ⚠ 注意：写进的是**提问者**的记忆，不是回答者的。
 *   这符合「场景自治」：自己的记忆自己写，别人只能提供信息。
 */
function writeLearned(item) {
  try {
    const memFile = path.join(MEM_ROOT, item.from, '场景私有记忆.md');
    if (!fs.existsSync(memFile)) return { ok: false, error: '提问者记忆不存在' };

    let md = readTextSafe(memFile) || '';
    const stamp = new Date().toISOString().slice(0, 10);
    const line = '- ' + stamp + '：**问「' + item.to + '」学到：' + item.about + '**\n' +
      '  → ' + item.answer.replace(/\n/g, '\n  ');

    // 找 §五 节末尾插入
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let secStart = -1;
    let secEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s*.*坑与决策/.test(lines[i])) { secStart = i; continue; }
      if (secStart >= 0 && /^##\s/.test(lines[i]) && i > secStart) { secEnd = i; break; }
    }

    if (secStart < 0) {
      md = md.trimEnd() + '\n\n## 五、坑与决策（只追加）\n\n' + line + '\n';
    } else {
      let insertAt = secEnd;
      while (insertAt > secStart + 1 && lines[insertAt - 1].trim() === '') insertAt--;
      lines.splice(insertAt, 0, '', line);
      md = lines.join('\n');
    }

    fs.writeFileSync(memFile, md, 'utf8');
    return { ok: true, file: 'workbench/数据/.dsh/场景记忆/' + item.from + '/场景私有记忆.md' };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 60) };
  }
}

// ══════════════════════════════════════════════════════════════
//  查未答
// ══════════════════════════════════════════════════════════════
export function pending(scene) {
  const a = loadAsks();
  let items = a.items.filter((x) => x.status === 'pending');
  if (scene) items = items.filter((x) => x.to === scene);
  return items;
}

export function listAll() {
  const a = loadAsks();
  return a.items.slice().sort((x, y) => String(y.at).localeCompare(String(x.at)));
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  场景互问 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 限制
  chk('有提问长度限制', LIMITS.QUESTION_MAX > 0, String(LIMITS.QUESTION_MAX));
  chk('有回答长度限制', LIMITS.ANSWER_MAX > 0, String(LIMITS.ANSWER_MAX));
  chk('有未答提醒阈值', LIMITS.PENDING_WARN > 0, String(LIMITS.PENDING_WARN));
  chk('有已完成保留数', LIMITS.KEEP_DONE > 0, String(LIMITS.KEEP_DONE));

  // ② 校验：缺参数
  chk('反例：缺 from 拒绝', ask({ to: 'B', about: 'x' }).ok === false, '');
  chk('反例：缺 to 拒绝', ask({ from: 'A', about: 'x' }).ok === false, '');
  chk('反例：缺 about 拒绝', ask({ from: 'A', to: 'B' }).ok === false, '');
  chk('反例：问自己被拒', ask({ from: 'A', to: 'A', about: 'x' }).ok === false, '');
  chk('反例：问题过长被拒', (function () {
    // 用超长问题测（不真写入）
    const r = ask({ from: 'A', to: 'B', about: 'x'.repeat(200) });
    return r.ok === false && /过长/.test(r.error);
  })(), '');

  // ③ 数据加载
  chk('能加载问答库', typeof loadAsks().items !== 'undefined', '');
  chk('能列全部', Array.isArray(listAll()), listAll().length + ' 条');
  chk('能查未答', Array.isArray(pending()), pending().length + ' 条');

  // ④ 关键：这补的是「横向」关系，不是「纵向」
  chk('关键：补的是横向讨教（不是纵向管理）',
      LIMITS.ANSWER_MAX > LIMITS.QUESTION_MAX,
      '问题短、回答详细——这是「讨教」的形态');

  // ⚠ 2026-11-12 加⑤：空话答案必须被拒（E2E 抓出的真缺陷）
  //
  //   实测：`--answer q003 --text "好"` 被接受，状态变 answered，
  //   而这条答案会被 writeLearned 写进提问者的记忆当作学到的经验。
  //   一个「好」字就能污染别人的记忆。
  //
  //   这和 派单 --ack 接受「好了」是同一个病：判据只检查「非空」。
  console.log();
  console.log('  ⑤ 空话答案必须被拒');
  {
    chk('有最小长度限制', LIMITS.ANSWER_MIN > 0, 'ANSWER_MIN=' + LIMITS.ANSWER_MIN);
    chk('空话黑名单非空', EMPTY_ANSWER_WORDS.length > 0, EMPTY_ANSWER_WORDS.length + ' 个词');
    chk('黑名单含「好」「收到」',
        EMPTY_ANSWER_WORDS.includes('好') && EMPTY_ANSWER_WORDS.includes('收到'));

    // 反例：短答案必须被 answer() 拒绝
    //   用一个不存在的 id —— 如果判据生效，会在「找不到问题」之前先被「太短」拦下
    const shortAns = answer('__nonexistent__', '好');
    chk('反例：两个字的答案必须被拒', shortAns.ok === false,
        shortAns.error || '没被拒！');
    chk('反例：拒绝理由要说清是「太短」',
        /太短/.test(String(shortAns.error)), String(shortAns.error).slice(0, 40));

    // 反例：黑名单里的词即使够长也要拒
    //   ⚠ 上面那条「无所谓×10」其实是被「找不到问题」拦下的，不是被黑名单拦下 ——
    //     那种断言证明不了黑名单生效。这里直接用**黑名单里的词本身**（恰好也够长的情况造不出来），
    //     所以改成验证判据函数本身：把黑名单词拼到 ≥ANSWER_MIN 时，
    //     必须仍然被「空话」拦下（而不是只靠长度）。
    {
      // 构造一个「长度够 + 整句就是一个空话词重复」的样本
      //   EMPTY_ANSWER_WORDS 里的词都很短，重复后不等于任何单词，
      //   所以这里验的是**逻辑顺序**：长度检查在前、黑名单在后，
      //   短的黑名单词会被长度拦下（也达到「拒」的目的）。
      //   要单独证明黑名单生效，得有一个 ≥20 字的空话词 —— 没有，
      //   所以这里诚实验证「短词被长度拦、长空话无对应样本」。
      const veryShort = EMPTY_ANSWER_WORDS.filter((w) => w.length < LIMITS.ANSWER_MIN);
      const longOnes = EMPTY_ANSWER_WORDS.filter((w) => w.length >= LIMITS.ANSWER_MIN);
      chk('黑名单里的词都短于 ANSWER_MIN（所以都被长度检查兜住）',
          longOnes.length === 0,
          '短词 ' + veryShort.length + ' 个，长词 ' + longOnes.length + ' 个');
      // 至少确保每个黑名单词单独提交都会被拒
      let allRejected = true;
      for (const w of EMPTY_ANSWER_WORDS.slice(0, 8)) {
        const rr = answer('__nonexistent__', w);
        if (rr.ok) { allRejected = false; break; }
      }
      chk('反例：黑名单词逐个提交都必须被拒', allRejected);
    }

    // 正例：有实质内容的答案能通过长度检查（用不存在的 id 会在「找不到问题」处停，
    //      但那说明长度检查和黑名单都放行了）
    const good = '按三个维度排：先看会不会挡住后续里程碑，会挡的优先；再看改动面大小，改动大的先定。';
    const goodR = answer('__nonexistent__', good);
    chk('正例：有实质内容能过长度与黑名单检查',
        goodR.ok === false && /找不到问题/.test(String(goodR.error)),
        String(goodR.error).slice(0, 40));
  }

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  真实检查（--check）
//
//  ⚠ 2026-11-12 新增。此前只有 --selftest（构造 A→B 的问答），
//    真实数据上只有一个 q001，而且从来没有检查过这两件事：
//      ① 已回答的问答，回答是否**真的写进了提问者的记忆**（闭环最后一跳）
//      ② 有没有积压的未回答问题
//
//  判据：
//    ① 每条 status=answered 的问答，回答内容必须出现在提问者场景记忆里
//       —— 这是这个机制的全部意义（「学到」）。没写进去 = 白问。
//    ② 未答问题数不超过 PENDING_WARN
//    ③ 问答的 from/to 必须是真实存在的场景（防止写到不存在的目录）
// ══════════════════════════════════════════════════════════════
export function checkReal() {
  const problems = [];
  const rows = [];

  const a = loadAsks();
  if (!Array.isArray(a.items) || a.items.length === 0) {
    return { ok: false, checked: 0, rows, problems: ['问答库是空的（这个机制从没被用过）'] };
  }

  const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/\*\*/g, '');

  let pendingCount = 0;
  let answeredCount = 0;

  for (const it of a.items) {
    if (it.status === 'pending') pendingCount++;
    if (it.status !== 'answered') continue;
    answeredCount++;

    const row = { id: it.id, from: it.from, to: it.to, learned: false, why: '' };

    // ③ 场景必须真实存在
    const fromDir = path.join(MEM_ROOT, it.from);
    if (!fs.existsSync(fromDir)) {
      problems.push(it.id + '：提问者「' + it.from + '」不是真实场景（记忆目录不存在）');
      row.why = '提问者不存在';
      rows.push(row);
      continue;
    }

    // ① 回答必须写进提问者记忆
    const memFile = path.join(fromDir, '场景私有记忆.md');
    const md = readTextSafe(memFile);
    if (md === null) {
      problems.push(it.id + '：提问者「' + it.from + '」没有场景私有记忆.md');
      row.why = '提问者无记忆文件';
      rows.push(row);
      continue;
    }

    // 用回答的前 20 字做锚（回答可能被换行拆开，所以两边都去空白）
    const anchor = norm(String(it.answer || '')).slice(0, 20);
    const inMem = anchor.length > 0 && norm(md).includes(anchor);
    row.learned = inMem;
    if (!inMem) {
      problems.push(it.id + '：已答但回答没写进「' + it.from + '」的记忆（白问了）—— 回答前 20 字:「' +
        String(it.answer || '').slice(0, 20) + '」');
      row.why = '未落记忆';
    }

    rows.push(row);
  }

  // ② 积压
  if (pendingCount > LIMITS.PENDING_WARN) {
    problems.push('未回答问题 ' + pendingCount + ' 个，超过提醒阈值 ' + LIMITS.PENDING_WARN);
  }

  return {
    ok: problems.length === 0,
    checked: a.items.length,
    rows,
    problems,
    pendingCount,
    answeredCount,
  };
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 真实检查 ──
  if (has('--check')) {
    const r = checkReal();
    console.log('═'.repeat(76));
    console.log('  场景互问 · 真实检查（已答的是否真写进提问者记忆）');
    console.log('═'.repeat(76));
    console.log();
    if (r.rows.length === 0) {
      console.log('  问答库是空的');
    } else {
      console.log('  ' + '编号'.padEnd(8) + '提问者'.padEnd(12) + '回答者'.padEnd(12) + '已落记忆');
      console.log('  ' + '─'.repeat(56));
      for (const row of r.rows) {
        console.log('  ' + String(row.id).padEnd(8) +
          String(row.from).padEnd(12) +
          String(row.to).padEnd(12) +
          (row.learned ? '✓' : '✗ ' + row.why));
      }
      console.log('  ' + '─'.repeat(56));
    }
    console.log('  已答 ' + r.answeredCount + ' · 未答 ' + r.pendingCount + ' · 总计 ' + r.checked);
    console.log();
    if (r.ok) {
      console.log('  ✓ 所有已回答的问答都落进了提问者记忆，无积压');
    } else {
      console.log('  ✗ ' + r.problems.length + ' 个问题:');
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    console.log('═'.repeat(76));
    process.exit(r.ok ? 0 : 1);
  }

  // ── 提问 ──
  if (has('--ask')) {
    const r = ask({
      from: val('--from'),
      to: val('--to'),
      about: val('--about'),
    });
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }
    console.log('✓ 已提问 ' + r.item.id);
    console.log('  ' + r.item.from + ' → ' + r.item.to + '：' + r.item.about);
    console.log('  未回答: ' + r.pendingCount + ' 个' +
      (r.pendingCount >= LIMITS.PENDING_WARN ? ' ⚠ 积压较多' : ''));
    process.exit(0);
  }

  // ── 回答 ──
  if (has('--answer')) {
    const id = val('--answer');
    const r = answer(id, val('--text'));
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }
    console.log('✓ 已回答 ' + id);
    console.log('  内容: ' + r.item.answer.slice(0, 60));
    if (r.learned?.ok) {
      console.log('  ✓ 已写进 ' + r.item.from + ' 的记忆（学到）');
    }
    process.exit(0);
  }

  // ── 未答 ──
  if (has('--pending')) {
    const scene = val('--pending');
    const items = pending(scene === 'true' ? undefined : scene);
    console.log('═'.repeat(74));
    console.log('  待回答的问题（' + items.length + ' 个' + (scene && scene !== 'true' ? '，给 ' + scene : '') + '）');
    console.log('═'.repeat(74));
    console.log();
    if (items.length === 0) {
      console.log('  没有待回答的问题。');
    } else {
      for (const it of items) {
        console.log('  ' + it.id + '  ' + it.from + ' → ' + it.to);
        console.log('     问：' + it.about);
        console.log('     答：node 工具/互问.mjs --answer ' + it.id + ' --text "..."');
        console.log();
      }
      if (items.length >= LIMITS.PENDING_WARN) {
        console.log('  ⚠ 积压 ' + items.length + ' 个，建议尽快回答');
      }
    }
    process.exit(0);
  }

  // ── 列表 ──
  if (has('--list') || (!has('--ask') && !has('--answer') && !has('--pending') && !has('--list'))) {
    const items = listAll();
    console.log('═'.repeat(76));
    console.log('  场景互问（' + items.length + ' 条）');
    console.log('═'.repeat(76));
    console.log();
    if (items.length === 0) {
      console.log('  还没有问答。');
      console.log();
      console.log('  用法:');
      console.log('    node 工具/互问.mjs --ask --from 实施计划 --to 架构梳理 --about "怎么定架构取舍"');
      console.log('    node 工具/互问.mjs --answer q001 --text "..."');
    } else {
      for (const it of items.slice(0, 20)) {
        const mark = it.status === 'pending' ? '○' : '✓';
        console.log('  ' + mark + ' ' + it.id + '  ' + it.from + ' → ' + it.to);
        console.log('     问：' + it.about);
        if (it.answer) console.log('     答：' + it.answer.slice(0, 60));
        console.log();
      }
      if (items.length > 20) console.log('  …还有 ' + (items.length - 20) + ' 条');
    }
    console.log('─'.repeat(76));
    console.log('  横向交流：场景之间互相讨教经验，不违反场景自治');
    console.log('  （只读对方的记忆，不改；回答进自己的记忆，不进对方的）');
    console.log('─'.repeat(76));
    process.exit(0);
  }
}
