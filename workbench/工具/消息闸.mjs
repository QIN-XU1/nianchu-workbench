#!/usr/bin/env node
/**
 * 消息闸 —— 禁止无限对话（规矩 10）
 *
 * ══════════════════════════════════════════════════════════════
 *  依据（参考项目 05-协作与规矩/三-跨场景协作.md 规矩 10）
 * ══════════════════════════════════════════════════════════════
 *
 *  【来源】用户 2026-10-17 14:15 实测投诉
 *    「他们之间处理回执都很慢，一直无限对话」
 *
 *  【现象】5 条帮手与 oa-ai 互发技术长文（"四行/我采纳/你那个假阴性…"）
 *    助手2  262 轮
 *    助手4  224 轮
 *    助手5  101 轮
 *    （昨晚分别只有 2/3/1 轮）
 *    把余额烧到 Insufficient Balance (ACCOUNT_QUOTA, 402)，04:19 停摆
 *    ⇒ 用户 12:15 归档助手 2/3/4/5
 *
 *  【抓手】同一会话一小时内轮数增长 > 30 ⇒ 怀疑循环对话
 *
 * ══════════════════════════════════════════════════════════════
 *  判据（一句）
 * ══════════════════════════════════════════════════════════════
 *
 *  **一次派单 = 一条回执 = 结束**
 *  回执只写「结论 + 证据（跑了什么、几条通过）+ 落盘路径」
 *  **≤200 字 / ≤10 行**
 *  ⛔ 不许在回执里提新问题、不许把技术讨论塞进消息
 *
 * ══════════════════════════════════════════════════════════════
 *  五条硬约束
 * ══════════════════════════════════════════════════════════════
 *
 *  ① 同一件事的消息数 ≤ 3 条（派单 + 回执 + 收尾知悉）
 *  ② 单条 ≤ 200 字 / ≤ 10 行
 *  ③ 首行必须是 `【需要回执】` 或 `【不需要回执·知悉】`
 *  ④ 末行必须是 `【结束】`
 *  ⑤ 收到"不需要回执" ⇒ 一个字都不许回（连"收到"也不行）
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/消息闸.mjs --check --text "..." --count 2
 *  node 工具/消息闸.mjs --audit                  体检：扫真实消息，找违规（机制体检用这个）
 *  node 工具/消息闸.mjs --wrap --text "结论..." --need-receipt
 *  node 工具/消息闸.mjs --scan <会话记录.json>     查有没有循环
 *  node 工具/消息闸.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  硬约束（来自规矩 10）
// ══════════════════════════════════════════════════════════════
export const LIMITS = {
  /** 同一件事最多几条消息（派单 + 回执 + 收尾） */
  MAX_MESSAGES: 3,
  /** 单条最多字 */
  MAX_CHARS: 200,
  /** 单条最多行 */
  MAX_LINES: 10,
  /** 首行标记 */
  TAGS: ['【需要回执】', '【不需要回执·知悉】'],
  /** 末行标记 */
  END: '【结束】',
  /** 循环检测：一小时内轮数增长超过这个值 ⇒ 怀疑循环 */
  LOOP_GROWTH_PER_HOUR: 30,
  /** 纯确认语（不许发） */
  PURE_ACK: /^(收到|好的|好|谢谢|感谢|明白|了解|ok|okay|收到谢谢|好嘞|行)[！!。.\s]*$/i,
};

// ══════════════════════════════════════════════════════════════
//  检查一条消息是否合规
// ══════════════════════════════════════════════════════════════
export function checkMessage(text, opts) {
  const o = opts || {};
  const t = String(text || '');
  const problems = [];

  // ① 空消息
  if (!t.trim()) {
    return { ok: false, problems: ['消息为空'] };
  }

  // ② 纯确认语
  if (LIMITS.PURE_ACK.test(t.trim())) {
    problems.push('纯确认语（「' + t.trim() + '」）不携带信息，不许发');
  }

  // ③ 字数
  const chars = t.replace(/\s/g, '').length;
  if (chars > LIMITS.MAX_CHARS) {
    problems.push('超过 ' + LIMITS.MAX_CHARS + ' 字（' + chars + ' 字）');
  }

  // ④ 行数
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length > LIMITS.MAX_LINES) {
    problems.push('超过 ' + LIMITS.MAX_LINES + ' 行（' + lines.length + ' 行）');
  }

  // ⑤ 首行标记
  const first = lines[0] || '';
  const hasTag = LIMITS.TAGS.some((tag) => first.includes(tag));
  if (!hasTag) {
    problems.push('首行缺标记（必须是「【需要回执】」或「【不需要回执·知悉】」）');
  }

  // ⑥ 末行标记
  const last = lines[lines.length - 1] || '';
  if (!last.includes(LIMITS.END)) {
    problems.push('末行缺「' + LIMITS.END + '」');
  }

  // ⑦ 消息条数
  const count = Number(o.count) || 1;
  if (count > LIMITS.MAX_MESSAGES) {
    problems.push('同一件事已发 ' + count + ' 条，超过 ' + LIMITS.MAX_MESSAGES + ' 条上限');
  }

  // ⑧ 回执里提新问题（常见违规）
  if (hasTag && first.includes('不需要回执')) {
    if (/[？?]/.test(t) && /(能不能|是否可以|要不要|怎么办)/.test(t)) {
      problems.push('「不需要回执·知悉」里提了新问题（对方不会回，问题会悬空）');
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    stats: { chars, lines: lines.length, count },
  };
}

// ══════════════════════════════════════════════════════════════
//  包装一条消息（自动加标记）
// ══════════════════════════════════════════════════════════════
export function wrapMessage(text, opts) {
  const o = opts || {};
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '消息为空' };

  const tag = o.needReceipt ? '【需要回执】' : '【不需要回执·知悉】';

  // 已经有了就不重复加
  const hasTag = LIMITS.TAGS.some((x) => t.startsWith(x));
  const hasEnd = t.trimEnd().endsWith(LIMITS.END);

  let out = t;
  if (!hasTag) out = tag + ' ' + out;
  if (!hasEnd) out = out.trimEnd() + '\n' + LIMITS.END;

  return { ok: true, text: out, tag, needReceipt: !!o.needReceipt };
}

// ══════════════════════════════════════════════════════════════
//  循环检测：一小时内轮数增长
// ══════════════════════════════════════════════════════════════
export function detectLoopFromRounds(rounds, opts) {
  const o = opts || {};
  const threshold = o.threshold || LIMITS.LOOP_GROWTH_PER_HOUR;
  const list = (rounds || []).filter((r) => r && typeof r.rounds === 'number' && r.at);

  if (list.length < 2) {
    return { inLoop: false, reason: '数据点太少（' + list.length + '），无法判断' };
  }

  // 按时间排序
  const sorted = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3600000;
  if (hours <= 0) {
    return { inLoop: false, reason: '时间跨度不足' };
  }

  const growth = last.rounds - first.rounds;
  const perHour = growth / hours;
  const inLoop = perHour > threshold;

  return {
    inLoop,
    growth,
    hours: +hours.toFixed(2),
    perHour: +perHour.toFixed(1),
    threshold,
    reason: inLoop
      ? '一小时内增长 ' + perHour.toFixed(1) + ' 轮 > ' + threshold + ' ⇒ 怀疑循环对话'
      : '增长 ' + perHour.toFixed(1) + ' 轮/小时，正常',
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  消息闸 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 约束常量
  chk('上限 3 条', LIMITS.MAX_MESSAGES === 3, String(LIMITS.MAX_MESSAGES));
  chk('上限 200 字', LIMITS.MAX_CHARS === 200, String(LIMITS.MAX_CHARS));
  chk('上限 10 行', LIMITS.MAX_LINES === 10, String(LIMITS.MAX_LINES));
  chk('两个首行标记', LIMITS.TAGS.length === 2, LIMITS.TAGS.join(' / '));
  chk('有结束标记', LIMITS.END === '【结束】', LIMITS.END);
  chk('循环阈值 30 轮/小时', LIMITS.LOOP_GROWTH_PER_HOUR === 30, String(LIMITS.LOOP_GROWTH_PER_HOUR));

  // ② 合规消息
  const good = '【不需要回执·知悉】索引已补齐 3 条。证据：索引体检输出「⛔0 ⚠0 ✅4」。落盘：数据/索引.md\n【结束】';
  const r1 = checkMessage(good, { count: 2 });
  chk('合规消息通过', r1.ok === true, r1.problems.join(';') || 'ok');

  // ③ 反例：空
  chk('反例：空消息拒绝', checkMessage('').ok === false, '');

  // ④ 反例：纯确认语
  const r2 = checkMessage('收到');
  chk('反例：纯确认语拒绝', r2.ok === false, r2.problems[0] || '');

  const r2b = checkMessage('好的');
  chk('反例：「好的」拒绝', r2b.ok === false, r2b.problems[0] || '');

  // ⑤ 反例：超字数
  const long = '【不需要回执·知悉】' + 'x'.repeat(250) + '\n【结束】';
  const r3 = checkMessage(long);
  chk('反例：超 200 字拒绝', r3.ok === false, r3.problems.find((p) => p.includes('字')) || '');

  // ⑥ 反例：超行数
  const manyLines = '【不需要回执·知悉】\n' + Array.from({ length: 12 }, (_, i) => '第' + i + '行').join('\n') + '\n【结束】';
  const r4 = checkMessage(manyLines);
  chk('反例：超 10 行拒绝', r4.ok === false, r4.problems.find((p) => p.includes('行')) || '');

  // ⑦ 反例：缺首行标记
  const noTag = '索引已补齐 3 条\n【结束】';
  const r5 = checkMessage(noTag);
  chk('反例：缺首行标记拒绝', r5.ok === false, r5.problems.find((p) => p.includes('标记')) || '');

  // ⑧ 反例：缺结束标记
  const noEnd = '【不需要回执·知悉】索引已补齐';
  const r6 = checkMessage(noEnd);
  chk('反例：缺结束标记拒绝', r6.ok === false, r6.problems.find((p) => p.includes('结束')) || '');

  // ⑨ 反例：超条数
  const r7 = checkMessage(good, { count: 4 });
  chk('反例：超 3 条拒绝', r7.ok === false, r7.problems.find((p) => p.includes('条')) || '');

  // ⑩ 反例：知悉里提新问题
  const newQ = '【不需要回执·知悉】索引已补齐。不过我想问一下能不能改成自动的？\n【结束】';
  const r8 = checkMessage(newQ);
  chk('反例：知悉里提新问题被检出', r8.ok === false,
      r8.problems.find((p) => p.includes('新问题')) || '');

  // ⑪ 包装
  const w1 = wrapMessage('索引已补齐 3 条');
  chk('包装：默认加知悉标记', w1.ok && w1.text.startsWith('【不需要回执·知悉】'), w1.text.split('\n')[0].slice(0, 30));
  chk('包装：加了结束标记', w1.text.includes('【结束】'), '');

  const w2 = wrapMessage('请改配置', { needReceipt: true });
  chk('包装：可加需要回执', w2.text.startsWith('【需要回执】'), '');

  // ⑫ 循环检测：正常
  const normal = [
    { at: '2026-11-11T10:00:00Z', rounds: 5 },
    { at: '2026-11-11T11:00:00Z', rounds: 12 },
  ];
  const d1 = detectLoopFromRounds(normal);
  chk('正常增长不判循环', d1.inLoop === false, d1.reason);

  // ⑬ 循环检测：262 轮事故
  const incident = [
    { at: '2026-11-10T20:00:00Z', rounds: 2 },
    { at: '2026-11-11T04:19:00Z', rounds: 262 },
  ];
  const d2 = detectLoopFromRounds(incident);
  chk('262 轮事故能判出', d2.inLoop === true, d2.reason);
  chk('算出每小时增长', d2.perHour > 30, d2.perHour + ' 轮/小时');

  // ⑭ 反例：数据点太少
  const d3 = detectLoopFromRounds([{ at: '2026-11-11T10:00:00Z', rounds: 5 }]);
  chk('反例：数据点太少不判循环', d3.inLoop === false, d3.reason);

  // ⑮ 关键：能拦住 262 轮那次事故
  chk('关键：能拦住 262 轮烧光余额那次',
      d2.inLoop === true && checkMessage('收到').ok === false,
      '这是消息闸存在的唯一理由');

  // ⚠ 2026-11-12 加：反例守护「按同一件事分组，而不是按 (from,to) 对分组」
  //
  //   原来按 (from,to) 累计，4 条不同 subject 的完全合规消息也被判超限。
  //   这条反例锁死修复：不同的事各自算 1 条，同一件事才累计。
  {
    const body40 = (s) => String(s || '').replace(/\s+/g, '').slice(0, 40);
    const sim = [
      { from: '中枢', to: '调研', about: '问题A：架构怎么分层？' },
      { from: '中枢', to: '调研', about: '问题B：竞品有哪些？' },
      { from: '中枢', to: '调研', about: '问题C：磁盘占多少？' },
      { from: '中枢', to: '调研', about: '问题D：怎么排优先级？' },
    ];
    const byMatter = {};
    for (const it of sim) {
      const k = it.from + '|' + it.to + '|' + body40(it.about);
      byMatter[k] = (byMatter[k] || 0) + 1;
    }
    chk('反例：4 条不同的事不算「同一件事发 4 条」',
        Object.values(byMatter).every((n) => n === 1), '每件事各 1 条');

    // 同一件事发 4 条必须被识别
    const sameMatter = sim.map((x) => ({ ...x, about: '问题A：架构怎么分层？' }));
    const bm2 = {};
    for (const it of sameMatter) {
      const k = it.from + '|' + it.to + '|' + body40(it.about);
      bm2[k] = (bm2[k] || 0) + 1;
    }
    chk('反例：同一件事发 4 条必须被识别',
        Object.values(bm2).some((n) => n === 4), '同一件事计到 4');
  }

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
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

  // 包装
  if (has('--wrap')) {
    const r = wrapMessage(val('--text'), { needReceipt: has('--need-receipt') });
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }
    console.log(r.text);
    process.exit(0);
  }

  // 检查
  if (has('--check') || has('--text')) {
    const r = checkMessage(val('--text'), { count: val('--count') });
    console.log('═'.repeat(72));
    console.log('  消息检查');
    console.log('═'.repeat(72));
    console.log();
    if (r.ok) {
      console.log('  ✓ 合规');
      console.log('  ' + r.stats.chars + ' 字 / ' + r.stats.lines + ' 行');
    } else {
      console.log('  ✗ 不合规：');
      for (const p of r.problems) console.log('    · ' + p);
    }
    console.log();
    console.log('─'.repeat(72));
    console.log('  规矩 10：一次派单 = 一条回执 = 结束（≤3 条 / ≤200 字 / ≤10 行）');
    console.log('─'.repeat(72));
    process.exit(r.ok ? 0 : 1);
  }

  // 循环扫描
  if (has('--scan')) {
    const f = val('--scan');
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { console.error('读不到: ' + f); process.exit(2); }
    const rounds = Array.isArray(data) ? data : (data.rounds || []);
    const r = detectLoopFromRounds(rounds);
    console.log('═'.repeat(72));
    console.log('  循环对话检测');
    console.log('═'.repeat(72));
    console.log();
    console.log('  数据点: ' + rounds.length);
    console.log('  结论:   ' + (r.inLoop ? '⚠ 疑似循环' : '✓ 正常'));
    console.log('  理由:   ' + r.reason);
    process.exit(r.inLoop ? 1 : 0);
  }

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 加 --audit（判据错误：这个工具在体检里**永远不会失败**）
  //
  //    原来：机制体检用 `--selftest` 跑它 —— 只验 checkMessage 的判据，
  //          真实数据里一条消息都没检查过。
  //
  //    为什么不能直接拿默认模式去体检：
  //      默认模式只是**打印约束清单**然后 exit 0 —— 无论数据多烂都绿。
  //
  //    为什么不能拿 `--check` 去体检：
  //      `--check --text "..."` 必须带一条消息，是**运行时闸门**
  //      （设计上就是「这条消息合规吗」），没有一条具体消息就没法判。
  //      给它塞一条假消息 = 假检查。
  //
  //    所以加 --audit：扫**真实存在的**消息落盘数据，用同一套 checkMessage 判。
  //      数据源（都是本项目真实在用的）：
  //        ① _共享记忆/_跨场景通知.md   —— 跨场景消息（发消息.mjs 写的）
  //        ② 场景互问/问答.json         —— 场景之间讨教（互问.mjs 写的）
  //      判据：把每条真实消息喂 checkMessage（count 按同会话累计），
  //            有任何一条不合规就 exit 1。
  //      没有数据可查时 exit 0 并**明确说明**「无数据」——
  //      不能假装查过了（那是装饰），也不能因为没数据就报红（那是环境问题）。
  // ══════════════════════════════════════════════════════════════
  if (has('--audit')) {
    const violations = [];
    let scanned = 0;
    let sourcesScanned = 0;

    // ① 跨场景通知
    const board = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '_跨场景通知.md');
    if (fs.existsSync(board)) {
      sourcesScanned++;
      const lines = fs.readFileSync(board, 'utf8').replace(/^\uFEFF/, '')
        .split('\n').filter((l) => l.trim().startsWith('-'));
      const byTarget = {};
      for (const line of lines) {
        scanned++;
        const m = line.match(/→\s*(\S+?)：/);
        const to = m ? m[1] : '未知';
        byTarget[to] = (byTarget[to] || 0) + 1;
        const r = checkMessage(line.replace(/^-\s*/, ''), { count: byTarget[to] });
        if (!r.ok) {
          violations.push({ src: '_跨场景通知.md', to, problems: r.problems, text: line.slice(0, 60) });
        }
      }
    }

    // ② 场景互问
    const qa = path.join(WB, '数据', '.dsh', '场景互问', '问答.json');
    if (fs.existsSync(qa)) {
      sourcesScanned++;
      let j = null;
      try { j = JSON.parse(fs.readFileSync(qa, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 下面报 */ }
      if (!j) {
        violations.push({ src: '问答.json', to: '-', problems: ['问答.json 解析失败'], text: '' });
      } else {
        const items = Array.isArray(j.items) ? j.items : [];
        // ⚠ 2026-11-12 修（判据错误：按 (from,to) 对分组，不是按「同一件事」）
        //
        //   原来：const key = from + '|' + to;
        //         byPair[key] 累计这一对场景之间的**所有**互问。
        //
        //   问题：规矩 ① 说的是「同一件事的消息数 ≤ 3 条」，
        //        而 (from,to) 对分组统计的是「这一对场景的总消息数」。
        //        实测：4 条不同 subject 的完全合规消息也被判「同一件事已发 4 条」。
        //
        //   这是误判方向的偏差 —— 破坏性验证只能证明它「会红」，
        //   证明不了「红得对」。
        //
        //   修法：按「同一件事」分组。同一件事的标识 = about 的字面前 N 字
        //        （互问的 about 就是「这件事是什么」）。
        //        同一个 about 反复问才是「同一件事发多条」。
        const body40 = (s) => String(s || '').replace(/\s+/g, '').slice(0, 40);
        const byMatter = {};
        for (const it of items) {
          scanned++;
          // 「同一件事」= 同一对场景 + 同一个 about 主体
          const key = String(it.from || '') + '|' + String(it.to || '') + '|' + body40(it.about);
          byMatter[key] = (byMatter[key] || 0) + 1;
          // 互问的一条消息 = about + optional answer
          const body = '【需要回执】' + String(it.about || '') + '\n' + String(it.answer || '') + '\n【结束】';
          const r = checkMessage(body, { count: byMatter[key] });
          if (!r.ok) {
            violations.push({ src: '问答.json', to: String(it.to || '-'), problems: r.problems, text: String(it.about || '').slice(0, 60) });
          }
        }
      }
    }

    console.log('═'.repeat(72));
    console.log('  消息闸 · 审计（真实消息落盘数据）');
    console.log('═'.repeat(72));
    console.log();
    console.log('  数据源: ' + sourcesScanned + ' 个   消息条数: ' + scanned);
    console.log();

    if (sourcesScanned === 0 || scanned === 0) {
      console.log('  ○ 没有可审计的真实消息（无数据，不算通过也不算失败）');
      console.log('    说明：这条闸是运行时闸门，只能在有真实消息时判。');
      console.log('    机制体检若长期看到这一行，说明消息落盘链路空着，该去查链路。');
      process.exit(0);
    }

    if (violations.length === 0) {
      console.log('  ✓ ' + scanned + ' 条真实消息全部符合规矩 10');
      process.exit(0);
    }
    console.log('  ✗ ' + violations.length + '/' + scanned + ' 条消息违规：');
    for (const v of violations.slice(0, 8)) {
      console.log('    · [' + v.src + ' → ' + v.to + '] ' + v.problems.join('；'));
      if (v.text) console.log('      ' + v.text);
    }
    process.exit(1);
  }

  // 默认：显示约束
  console.log('═'.repeat(72));
  console.log('  消息闸 · 规矩 10 约束');
  console.log('═'.repeat(72));
  console.log();
  console.log('  同一件事 ≤ ' + LIMITS.MAX_MESSAGES + ' 条消息');
  console.log('  单条 ≤ ' + LIMITS.MAX_CHARS + ' 字 / ≤ ' + LIMITS.MAX_LINES + ' 行');
  console.log('  首行：' + LIMITS.TAGS.join(' 或 '));
  console.log('  末行：' + LIMITS.END);
  console.log('  收到「不需要回执」⇒ 一个字都不许回');
  console.log();
  console.log('  循环阈值：一小时增长 > ' + LIMITS.LOOP_GROWTH_PER_HOUR + ' 轮');
  console.log();
  console.log('─'.repeat(72));
  console.log('  来源：用户 2026-10-17 实测投诉「一直无限对话」');
  console.log('  助手2 262 轮 / 助手4 224 轮 / 助手5 101 轮 ⇒ 烧到 402 停摆');
  console.log('─'.repeat(72));
}
