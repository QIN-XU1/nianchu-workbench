#!/usr/bin/env node
/**
 * A5 上下文压缩（自研）
 *
 * 之前 A5 记「部分」，证据原话：
 *   「经 hermes 衍生：context_compressor.py 321KB，两层阈值 + 结构化摘要 + fallback chain。
 *     能力在产品里，未在本项目真跑过」—— 典型的借力未自研。
 *
 * ── 压缩的真正难点不是「截断」──────────────────────────────────
 * 谁都会 slice(0, N)。难的是**压缩后仍能做对事**：
 *   · 工具调用的**结果**不能丢（丢了模型会重复调用或凭空猜）
 *   · 错误信息不能丢（丢了会重犯同一个错）
 *   · 用户明确的**约束**不能丢（「用 pnpm 不要用 npm」这类）
 *   · 最近几轮必须原样保留（当前任务的上下文在最近处）
 *   · 中间的探索过程可以大幅压缩（试错路径的价值低）
 *
 * 所以这一层做的是**结构化压缩**，不是字符截断：
 *
 *   1. 分轮：把对话切成「轮」（user/assistant/tool）
 *   2. 分级：每轮定重要性 —— system/user 约束 > 错误 > 工具结果 > 最近 > 中间探索
 *   3. 保留：预算内按重要性择优保留，最近 N 轮**强制**保留
 *   4. 摘要：被丢弃的中间部分压成一条结构化摘要（谁、做了什么、结论是什么）
 *   5. 校验：压缩后必须仍能从上下文里答出「关键事实」（有对应断言）
 *
 * ── 四态 ──────────────────────────────────────────────────────
 *   PASS    压缩到预算内，且关键事实全部保留
 *   WARN    压到预算内，但有非关键内容被标记为「已丢失」
 *   FAIL    压不到预算内（预算太小或不可压缩内容太多）
 *   UNKNOWN 输入不合法（无法判断）
 *
 * 用法：
 *   node tools/context/compress.mjs --selftest
 *   node tools/context/compress.mjs --file=evidence/context/sample.json --budget=2000
 */
import fs from 'node:fs';
import path from 'node:path';

export const S = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' };

/** 粗略 token 估算：CJK 按 1 字 ≈ 1 token，ASCII 按 4 字符 ≈ 1 token */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0, other = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * 重要性分级 —— 这是压缩质量的来源
 *
 * 分数越高越该留。规则都可解释，不是黑箱：
 */
export function scoreItem(item) {
  const text = String(item.text ?? '');
  let score = 0;
  const reasons = [];

  // 角色权重
  if (item.role === 'system') { score += 100; reasons.push('system'); }
  if (item.role === 'user') { score += 40; reasons.push('user'); }
  if (item.role === 'assistant') { score += 10; reasons.push('assistant'); }
  if (item.role === 'tool') { score += 20; reasons.push('tool'); }

  // 错误必须留
  if (/error|失败|exception|traceback|ENOENT|EACCES|denied|fatal/i.test(text)) {
    score += 60; reasons.push('错误');
  }
  // 用户约束/决定必须留
  if (/不要|必须|请用|禁止|只能用|don't|must|never|always/i.test(text) && item.role === 'user') {
    score += 50; reasons.push('约束');
  }
  // 决策/结论
  if (/决定|结论|因此|所以|结论是|决定用|chose|decided/i.test(text)) {
    score += 30; reasons.push('结论');
  }
  // 工具结果：成功的大段输出价值递减（长输出往往可压）
  if (item.role === 'tool') {
    const t = estimateTokens(text);
    if (t > 800) { score -= 25; reasons.push('长工具输出'); }
    else if (t < 200) { score += 10; reasons.push('短工具结果'); }
  }
  // 代码块 / diff：中等价值（可能需要复述）
  if (/```|\+\+\+|---|\bdiff\b/.test(text)) { score += 8; reasons.push('代码'); }

  return { score, reasons };
}

/**
 * 压缩主函数
 *
 * @param {Array<{role:string,text:string,name?:string}>} items  按时间顺序
 * @param {object} opts
 *   budget        目标 token 预算
 *   keepRecent    强制保留的最近轮数
 *   now           注入时钟（本函数不用，保留接口一致）
 */
export function compress(items, { budget = 2000, keepRecent = 3 } = {}) {
  if (!Array.isArray(items)) {
    return { state: S.UNKNOWN, why: '输入不是数组，判不了' };
  }
  if (!items.length) {
    return { state: S.PASS, why: '空上下文，无需压缩', output: [], keptAll: true, stats: { before: 0, after: 0 } };
  }
  if (!(budget > 0)) {
    return { state: S.UNKNOWN, why: '预算必须 > 0，判不了' };
  }

  const withMeta = items.map((it, i) => {
    const { score, reasons } = scoreItem(it);
    const tokens = estimateTokens(it.text);
    return { ...it, idx: i, score, reasons, tokens };
  });

  const beforeTokens = withMeta.reduce((a, x) => a + x.tokens, 0);

  // 【2026-11-17 修】非空输入却估出 0 token ⇒ 说明这些条目没有可读的 text 字段，
  // 我们根本没看懂输入。此时若按 beforeTokens <= budget 走下去会返回 PASS「无需压缩」——
  // 那是「对看不懂的输入报成功」，属于看起来有实际是空。按四态纪律改成 UNKNOWN。
  if (beforeTokens === 0) {
    return {
      state: S.UNKNOWN,
      why: '输入有 ' + items.length + ' 条但可读文本为 0（条目缺少 text 字段？），判不了',
      output: items,
      keptAll: true,
      stats: { before: 0, after: 0, kept: items.length, dropped: 0 },
    };
  }

  if (beforeTokens <= budget) {
    return {
      state: S.PASS,
      why: '上下文 ' + beforeTokens + ' tokens 已在预算 ' + budget + ' 内，无需压缩',
      output: items,
      keptAll: true,
      stats: { before: beforeTokens, after: beforeTokens, kept: items.length, dropped: 0 },
    };
  }

  const n = withMeta.length;
  const recentStart = Math.max(0, n - keepRecent);

  /**
   * 分成三组：必须留、候选、丢弃
   *
   * 必须留的三类：
   *   · system 提示
   *   · 最近 N 轮（当前任务的上下文在最近处）
   *   · **承载关键事实的条目**（错误 / 约束 / 结论）
   *
   * 第三条是实测补的：第一版只按分数排序挑选，结果「结论」条目的分（30）
   * 低于一堆工具结果（20 分但条数多，累计占满预算）被挤掉，
   * 自检报「压缩丢了关键事实：结论「因此决定用 pnpm 并改写脚本」」。
   * 关键事实既然定义成「压缩后必须还能查到」，就不能交给分数去赌。
   */
  const keyIdx = new Set(extractKeyFacts(withMeta).map((f) => f.idx));
  const forced = [];
  const candidates = [];
  for (const it of withMeta) {
    const isRecent = it.idx >= recentStart;
    const isSystem = it.role === 'system';
    if (isSystem || isRecent || keyIdx.has(it.idx)) forced.push(it);
    else candidates.push(it);
  }

  // 最近轮次按原顺序全留；system 也全留
  const forcedTokens = forced.reduce((a, x) => a + x.tokens, 0);

  /**
   * 预算里必须预留**摘要成本** —— 第一版没留，结果挑了 26 条候选后
   * 加上摘要段反而超出预算（实测 1500 预算出 1922，直接 FAIL）。
   *
   * 摘要成本估算：每段摘要约 40-120 tokens 取决于区间数量。
   * 保守按「每个候选段一条摘要、每条 60 tokens」预留。
   */
  const SUMMARY_RESERVE = 60 * 2;   // 最多两段摘要
  let remaining = budget - forcedTokens - SUMMARY_RESERVE;
  if (remaining < 0) remaining = 0;

  // 候选按分数降序挑，分数相同按「更靠近现在」优先
  candidates.sort((a, b) => (b.score - a.score) || (b.idx - a.idx));
  const kept = [];
  const dropped = [];
  for (const c of candidates) {
    if (c.tokens <= remaining) { kept.push(c); remaining -= c.tokens; }
    else dropped.push(c);
  }

  // 二次收敛：如果仍可能超，逐步回退最低分的保留项
  // （摘要成本是估算值，这里用真实结果兜底）

  // 组装：按原顺序输出保留项，在被丢弃的位置插入一条摘要
  const keepSet = new Set([...forced, ...kept].map((x) => x.idx));
  const output = [];
  let droppedRun = [];
  const flushDropped = () => {
    if (!droppedRun.length) return;
    output.push({
      role: 'summary',
      text: summarizeDropped(droppedRun),
      synthesized: true,
      coversIdx: droppedRun.map((x) => x.idx),
    });
    droppedRun = [];
  };
  for (let i = 0; i < n; i++) {
    const it = withMeta[i];
    if (keepSet.has(i)) { flushDropped(); output.push({ role: it.role, text: it.text, name: it.name }); }
    else droppedRun.push(it);
  }
  flushDropped();

  let afterTokens = output.reduce((a, x) => a + estimateTokens(x.text), 0);

  /**
   * 收敛：摘要成本是估算的，真实值可能更大。
   * 超预算就从「保留里分数最低的」开始退回丢弃，直到进预算。
   * 最多回退 30 轮，避免病态输入下死循环。
   */
  if (afterTokens > budget) {
    const shrinkable = kept.slice().sort((a, b) => (a.score - b.score) || (a.idx - b.idx));
    for (const victim of shrinkable) {
      if (afterTokens <= budget) break;
      const pos = output.findIndex((x) => x.role === victim.role && x.text === victim.text);
      if (pos < 0) continue;
      // 用摘要替换这一条（保持顺序信息）
      const oldTokens = estimateTokens(output[pos].text);
      const repl = { role: 'summary', text: '[压缩] 省略 1 条 ' + victim.role + ' 消息（' + victim.reasons.join('/') + '）', synthesized: true };
      output[pos] = repl;
      afterTokens += estimateTokens(repl.text) - oldTokens;
    }
  }

  // ── 校验：关键事实是否还在 ──
  const keyFacts = extractKeyFacts(withMeta);
  const afterText = output.map((x) => String(x.text)).join('\n');
  const missing = keyFacts.filter((f) => !afterText.includes(f.probe));

  if (afterTokens > budget) {
    return {
      state: S.FAIL,
      why: '压不到预算内：' + afterTokens + ' > ' + budget +
        '（强制保留 ' + forcedTokens + ' tokens 已超预算，需调大 budget 或减 keepRecent）',
      output, stats: { before: beforeTokens, after: afterTokens, kept: keepSet.size, dropped: dropped.length, forcedTokens },
    };
  }

  if (missing.length) {
    return {
      state: S.FAIL,
      why: '压缩丢了关键事实：' + missing.map((m) => m.kind + '「' + m.probe.slice(0, 20) + '」').join('、'),
      output, missing, stats: { before: beforeTokens, after: afterTokens, kept: keepSet.size, dropped: dropped.length },
    };
  }

  return {
    state: dropped.length ? S.WARN : S.PASS,
    why: '压缩 ' + beforeTokens + ' → ' + afterTokens + ' tokens（预算 ' + budget + '）' +
      '· 保留 ' + keepSet.size + ' 条 · 摘要 ' + output.filter((x) => x.synthesized).length + ' 段 · 丢弃 ' + dropped.length + ' 条' +
      '· 关键事实 ' + keyFacts.length + ' 条全部保留',
    output,
    keyFacts: keyFacts.map((k) => k.kind),
    stats: { before: beforeTokens, after: afterTokens, kept: keepSet.size, dropped: dropped.length, ratio: Math.round((afterTokens / beforeTokens) * 100) / 100 },
  };
}

/**
 * 提取「关键事实」—— 压缩后必须还能查到的东西
 * 这是压缩正确性的判据，不是可选项
 */
export function extractKeyFacts(items) {
  const facts = [];
  for (const it of items) {
    const t = String(it.text ?? '');
    // 错误：取错误行前 40 字符作为 probe
    const err = t.match(/(?:error|失败|exception|ENOENT|EACCES|denied|fatal)[^\n]{0,60}/i);
    if (err) facts.push({ kind: '错误', probe: err[0].trim().slice(0, 40), idx: it.idx });
    // 约束：用户说「不要/必须/请用」的整句
    if (it.role === 'user') {
      const cons = t.match(/(?:不要|必须|请用|禁止|只能用|don't|must|never|always)[^\n。.]{0,50}/i);
      if (cons) facts.push({ kind: '约束', probe: cons[0].trim().slice(0, 40), idx: it.idx });
    }
    // 结论
    const dec = t.match(/(?:决定|结论|因此|所以|chose|decided)[^\n。.]{0,50}/i);
    if (dec) facts.push({ kind: '结论', probe: dec[0].trim().slice(0, 40), idx: it.idx });
  }
  // 去重（同一 probe 只留一次）
  const seen = new Set();
  return facts.filter((f) => {
    if (seen.has(f.probe)) return false;
    seen.add(f.probe);
    return true;
  });
}

/** 把被丢弃的中间段压成一条结构化摘要 */
function summarizeDropped(run) {
  const byRole = {};
  for (const x of run) byRole[x.role] = (byRole[x.role] || 0) + 1;
  const parts = Object.entries(byRole).map(([r, c]) => c + ' 条 ' + r);
  // 把其中的错误与结论点名（这些即使被丢也要在摘要里留痕）
  const errs = run.filter((x) => /error|失败|exception|ENOENT|EACCES|denied|fatal/i.test(String(x.text)));
  const decs = run.filter((x) => /决定|结论|因此|所以|chose|decided/i.test(String(x.text)));
  const bits = [];
  bits.push('[压缩摘要] 省略了 ' + run.length + ' 条中间消息（' + parts.join('、') + '）');
  if (errs.length) {
    bits.push('其中 ' + errs.length + ' 条含错误：' +
      errs.slice(0, 2).map((e) => String(e.text).replace(/\s+/g, ' ').slice(0, 60)).join(' / '));
  }
  if (decs.length) {
    bits.push('其中 ' + decs.length + ' 条含结论：' +
      decs.slice(0, 2).map((d) => String(d.text).replace(/\s+/g, ' ').slice(0, 60)).join(' / '));
  }
  return bits.join('；');
}

// ── 自检（离线，构造大数据集，可复现）──
export function selfTest() {
  const cases = [];
  const T = (name, fn) => {
    let r;
    try { r = fn(); } catch (e) { r = { ok: false, why: '异常 ' + e.message }; }
    cases.push([name, !!r.ok, r.why]);
  };

  // 构造：60 轮，含系统提示 / 用户约束 / 错误 / 工具大输出 / 结论
  const mk = () => {
    const items = [{ role: 'system', text: '你是 agent。' + 'x'.repeat(400) }];
    for (let i = 0; i < 20; i++) {
      items.push({ role: 'user', text: '任务 ' + i + '：请帮我看看 ' + 'y'.repeat(200) });
      items.push({ role: 'assistant', text: '好的，我先读文件 ' + i + '。' + 'z'.repeat(200) });
      items.push({ role: 'tool', text: '文件内容 ' + i + '：' + 'w'.repeat(1500) });
    }
    // 中间插一条错误与一条约束与一条结论
    items[10] = { role: 'tool', text: 'Error: ENOENT no such file: config.json —— 路径拼错了' + 'e'.repeat(100) };
    items[5] = { role: 'user', text: '必须用 pnpm，不要用 npm。' + 'u'.repeat(150) };
    items[20] = { role: 'assistant', text: '因此决定用 pnpm 并改写脚本。' + 'd'.repeat(150) };
    // 最近 3 轮
    items.push({ role: 'user', text: '最后一步：把结果汇总给我。' });
    items.push({ role: 'assistant', text: '好的，汇总中。' });
    items.push({ role: 'tool', text: '汇总完成：3 个文件已改。' });
    return items;
  };

  T('正例 · 无需压缩时原样返回（条目数 1 且文本逐字不变）', () => {
    const r = compress([{ role: 'user', text: 'hi' }], { budget: 1000 });
    // 精确期望：不是「压不坏就行」，而是「必须原样返回 1 条、文本一个字符都不改」
    const same = r.output.length === 1 && String(r.output[0].text) === 'hi';
    return { ok: r.keptAll === true && r.state === S.PASS && same, why: r.why };
  });

  T('正例 · 压缩到预算内（after ≤ 1500 且严格小于 before）', () => {
    const items = mk();
    const before = items.reduce((a, x) => a + estimateTokens(x.text), 0);
    const r = compress(items, { budget: 1500, keepRecent: 3 });
    // 精确期望：真的压了（after > 0、输出非空）、真进了预算（after ≤ 1500）、真变小了（after < before）。
    // 只判「≤1500 且 < before」会让「永远返回空」的突变体蒙混过关 —— 0 也满足这两条。
    return {
      ok: (r.state === S.WARN || r.state === S.PASS) && r.stats.after > 0 &&
        r.stats.after <= 1500 && r.stats.after < before && r.output.length > 0,
      why: before + ' → ' + r.stats.after + '（' + r.state + '，输出 ' + r.output.length + ' 条）',
    };
  });

  T('正例 · 错误信息不丢（ENOENT 必须在输出里）', () => {
    const r = compress(mk(), { budget: 1500, keepRecent: 3 });
    const all = r.output.map((x) => String(x.text)).join('\n');
    return { ok: /ENOENT/.test(all), why: /ENOENT/.test(all) ? '错误保留在上下文里' : 'ENOENT 丢失了' };
  });

  T('正例 · 用户约束不丢（「必须用 pnpm」必须在输出里）', () => {
    const r = compress(mk(), { budget: 1500, keepRecent: 3 });
    const all = r.output.map((x) => String(x.text)).join('\n');
    return { ok: /必须用 pnpm/.test(all), why: /必须用 pnpm/.test(all) ? '约束保留' : '约束丢失' };
  });

  T('正例 · 最近 N 轮强制保留（最近 3 轮逐字且顺序不变）', () => {
    const r = compress(mk(), { budget: 1500, keepRecent: 3 });
    // 精确期望：输出末 3 条 == 输入末 3 条（逐字、同序）——「保留」不是「还剩下几个字」
    const want = ['最后一步：把结果汇总给我。', '好的，汇总中。', '汇总完成：3 个文件已改。'];
    const tail = r.output.slice(-3).map((x) => String(x.text));
    const okTail = JSON.stringify(tail) === JSON.stringify(want);
    return { ok: okTail, why: '末 3 条 = ' + JSON.stringify(tail.map((t) => t.slice(0, 12))) };
  });

  T('正例 · 生成压缩摘要标记（摘要段必须带「压缩摘要」字样）', () => {
    const r = compress(mk(), { budget: 1200, keepRecent: 2 });
    const sums = r.output.filter((x) => x.synthesized);
    return { ok: sums.length > 0 && /压缩摘要/.test(sums[0].text), why: '摘要段数 ' + sums.length };
  });

  T('正例 · 摘要机制本身可用（摘要段说清了省略了什么）', () => {
    const r = compress(mk(), { budget: 900, keepRecent: 1 });
    const sums = r.output.filter((x) => x.synthesized);
    // 判据说明：第一版要求「摘要里点名错误与结论」，但那与「关键事实必须保留」冲突 ——
    // 关键事实已被强制留在正文里，摘要自然不必重复。所以这里的判据是
    // 「摘要段存在且说清了省略了什么」，而不是「摘要复述了哪些内容」。
    const all = sums.map((x) => x.text).join('\n');
    return {
      ok: sums.length > 0 && /压缩摘要|省略/.test(all),
      why: sums.length + ' 段摘要，示例：' + (sums[0]?.text || '').slice(0, 60),
    };
  });

  T('反例 · 预算太小 → FAIL（不许假装成功）', () => {
    const r = compress(mk(), { budget: 50, keepRecent: 5 });
    return { ok: r.state === S.FAIL, why: r.why.slice(0, 60) };
  });

  T('反例 · 非法输入 → UNKNOWN（不许塌到 PASS 或 FAIL）', () => {
    const r = compress(null, { budget: 100 });
    return { ok: r.state === S.UNKNOWN, why: r.why };
  });

  T('正例 · 空上下文 → PASS 无需压缩（0 条进 0 条出）', () => {
    const r = compress([], { budget: 100 });
    // 精确期望：空进空出（0 条），状态 PASS 且 keptAll
    return { ok: r.state === S.PASS && r.keptAll === true && r.output.length === 0, why: r.why };
  });

  T('正例 · token 估算：CJK 按字算（「你好世界」必须 = 4）', () => {
    const t = estimateTokens('你好世界');
    return { ok: t === 4, why: '4 字 = ' + t + ' tokens' };
  });

  T('正例 · token 估算：ASCII 按 4 字符算（「abcdefgh」必须 = 2）', () => {
    const t = estimateTokens('abcdefgh');
    return { ok: t === 2, why: '8 字符 = ' + t + ' tokens' };
  });

  const bad = cases.filter(([, okv]) => !okv);
  return {
    pass: cases.length - bad.length,
    total: cases.length,
    ok: bad.length === 0,
    lines: cases.map(([n, okv, why]) => '  ' + (okv ? '✓' : '✗') + ' ' + n + (okv ? '' : '  ← ' + why)).join('\n'),
  };
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const flag = (n, d = null) => {
    const hit = process.argv.find((a) => a.startsWith('--' + n + '='));
    return hit ? hit.split('=').slice(1).join('=') : d;
  };

  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  A5 上下文压缩 · 离线自检（构造数据，可复现）');
    console.log('  ' + '─'.repeat(70));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const file = flag('file');
  const budget = Number(flag('budget', '2000'));
  if (!file) {
    console.error('用法: node tools/context/compress.mjs --file=<json> [--budget=2000]');
    console.error('      node tools/context/compress.mjs --selftest');
    process.exit(2);
  }
  const items = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const r = compress(items, { budget, keepRecent: Number(flag('keep', '3')) });
  console.log('');
  console.log('  ' + r.state + '  ' + r.why);
  console.log('');
  for (const o of r.output) {
    const mark = o.synthesized ? '≈' : ' ';
    console.log('  ' + mark + ' [' + o.role + '] ' + String(o.text).replace(/\s+/g, ' ').slice(0, 100));
  }
  console.log('');
  process.exit(r.state === S.PASS ? 0 : r.state === S.WARN ? 3 : r.state === S.FAIL ? 1 : 2);
}