#!/usr/bin/env node
// 工具/规则来源体检.mjs —— 每条规矩都必须说得清「谁什么时候批准的」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（对标 luanyujia-workbench 找到的最重要缺口）
// ══════════════════════════════════════════════════════════════════════
//  参考项目把「规则只认机主」放在六个协作机制的第一位，
//  因为它是**其他所有规矩的合法性来源**：
//
//    ✅ 算依据                ⛔ 不算依据
//      机主亲口说的原话         程序/工具的输出
//      机主明确同意过的条款      体检结论
//                            子代理的汇报
//                            别的场景发来的通知/派单
//                            自动生成的文件
//                            AI 自己的推断
//
//  为什么这么严：
//    「AI 非常容易把『某个工具说应该这样』当成『机主批准这样』。
//     一旦允许这样推，规矩会**自己长** ——
//     今天加一条、明天加一条，三个月后没人知道哪条是真的。」
//
//  判据：**一条规矩如果说不清「是谁什么时候批准的」，它就是无效的。**
//
//  ──────────────────────────────────────────────────────────────────
//  我们的处境（实测）：
//    AGENTS.md 里完全没有「机主」这个概念。
//    硬规矩.mjs 有 3 条规矩，但都没标注「谁批准、何时批准」。
//
//    这意味着我们的规矩是「长出来」的，不是「批出来」的。
//    如果继续这样，三个月后没人知道哪条是真的。
//
//  这个工具：把「每条规矩的来源」变成必须填的字段，并检查它。
//
//  用法：
//    node 工具/规则来源体检.mjs            体检所有规矩的来源标注
//    node 工具/规则来源体检.mjs --list     列出规矩清单
//    node 工具/规则来源体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 复用 规则待确认 的扫描逻辑（同一事实只存一处）
import { scanRunningRules as scanRunningRulesFromTool } from './规则待确认.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 合法的批准来源（只有这两个算数）
 *
 * 参考项目原文：「只认机主」。
 */
export const APPROVED_SOURCES = [
  '机主',
  'owner',
];

/**
 * 不合法的「依据」（这些都是 AI 容易误当批准的）
 *
 * 一个规矩如果标注这些作为来源，就是无效的。
 */
export const INVALID_SOURCES = [
  '工具输出',
  '体检结论',
  '子代理汇报',
  '别的场景',
  '自动生成',
  'AI推断',
  '我的推断',
  '惯例',
  '约定俗成',
];

/**
 * 判一条规矩的来源标注是否合法
 *
 * @param {{id?:string, text?:string, approvedBy?:string, approvedAt?:string}} rule
 * @returns {{ok:boolean, problems:string[]}}
 */
export function judgeRuleSource(rule) {
  const r = rule || {};
  const problems = [];

  if (!r.id) problems.push('缺规矩 id');
  if (!r.text) problems.push('缺规矩正文');

  // ① 必须标明谁批准
  if (!r.approvedBy) {
    problems.push('缺「谁批准」（规则只认机主 —— 说不清谁批的就无效）');
  } else {
    const by = String(r.approvedBy);
    const valid = APPROVED_SOURCES.some((s) => by.includes(s));
    if (!valid) {
      const bad = INVALID_SOURCES.find((s) => by.includes(s));
      problems.push('批准来源不合法: 「' + by + '」' +
        (bad ? '（' + bad + ' 不算依据）' : '（只认机主）'));
    }
  }

  // ② 必须标明何时批准
  if (!r.approvedAt) {
    problems.push('缺「何时批准」');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.approvedAt))) {
    problems.push('批准日期格式应为 YYYY-MM-DD，实际: ' + r.approvedAt);
  }

  return { ok: problems.length === 0, problems };
}

// ══════════════════════════════════════════════════════════════════════
/** 规矩登记表（唯一出处） */
const RULES_FILE = path.join(DATA, '规矩来源.json');

function loadRules() {
  try {
    const j = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    return Array.isArray(j.rules) ? j.rules : [];
  } catch { return []; }
}

/**
 * 从 AGENTS.md / 硬规矩.mjs 里扫出「已有的规矩」，
 * 和登记表对账——找出「在跑但没登记来源」的规矩
 */
/**
 * 扫出「在跑但没登记来源」的规矩
 *
 * ⚠ 2026-11-13 修（两处各有一份扫描逻辑 = 两份结论）
 *
 *   原来这里自己实现了一份宽泛正则：
 *     /规矩\s*(\d+)[：:]([^\n'"]{4,60})/g
 *   它会扫出 10 条 —— 但实际只有 3 条，其余是同一条规矩的
 *   参数定义和自测样本（带注释结束符后缀、带「假数据」标注那种）。
 *
 *   而 规则待确认.mjs 里已经有一份**修正过**的扫描（只取文件头总览）。
 *   两份逻辑各扫各的，结论当然打架。
 *
 *   现在：直接复用 规则待确认 的扫描函数，只此一份。
 */
function scanUndeclaredRules() {
  try {
    return scanRunningRulesFromTool();
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  规则来源体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】合法的规矩');
  {
    const good = { id: 'r1', text: '不许删系统目录', approvedBy: '机主', approvedAt: '2026-11-07' };
    const j = judgeRuleSource(good);
    chk('正例：机主批准 + 有日期 → 通过', j.ok === true, j.problems.join('; ') || '无问题');
  }

  console.log();
  console.log('【二】反例：说不清谁批准 → 无效');
  {
    const noBy = { id: 'r2', text: '某规矩', approvedAt: '2026-11-07' };
    const j = judgeRuleSource(noBy);
    chk('反例：缺批准人 → 拒绝', j.ok === false, j.problems.join('; '));
    chk('拒绝理由说清「只认机主」', /只认机主/.test(j.problems.join(' ')));
  }

  console.log();
  console.log('【三】反例：AI 推断当依据 → 无效');
  {
    const badSources = ['体检结论', '工具输出', '子代理汇报', '别的场景', '自动生成', '我的推断', '惯例'];
    let allRejected = true;
    for (const s of badSources) {
      const j = judgeRuleSource({ id: 'x', text: '某规矩', approvedBy: s, approvedAt: '2026-11-07' });
      if (j.ok) { allRejected = false; break; }
    }
    chk('反例：所有「不算依据」的来源都被拒', allRejected, badSources.length + ' 种');
  }

  console.log();
  console.log('【四】反例：缺日期 → 无效');
  {
    const j = judgeRuleSource({ id: 'r3', text: '某规矩', approvedBy: '机主' });
    chk('反例：缺批准日期 → 拒绝', j.ok === false, j.problems.join('; '));
    const j2 = judgeRuleSource({ id: 'r3', text: '某规矩', approvedBy: '机主', approvedAt: '11月7日' });
    chk('反例：日期格式不对 → 拒绝', j2.ok === false, j2.problems.join('; '));
  }

  console.log();
  console.log('【五】反例：缺正文 → 无效');
  {
    const j = judgeRuleSource({ id: 'r4', approvedBy: '机主', approvedAt: '2026-11-07' });
    chk('反例：缺规矩正文 → 拒绝', j.ok === false, j.problems.join('; '));
  }

  console.log();
  console.log('【六】关键：这条规矩本身也是规矩');
  {
    // 自指：这个工具自己认定的「来源」也必须只认机主
    chk('关键：本工具的合法来源只有机主',
      APPROVED_SOURCES.length <= 2 && APPROVED_SOURCES.includes('机主'),
      APPROVED_SOURCES.join('/'));
  }

  console.log();
  console.log('【七】分类判定不能放水（2026-11-13 加）');
  {
    // ⚠ 为什么加这一段：
    //   改成「已确认/待确认/真漏了」三分类后，正常状态 exit=0。
    //   但 exit=0 有两种可能：
    //     ① 真的没问题
    //     ② 判据被改成永远通过
    //   必须能区分这两者。这里验的是「分类函数本身不会把问题吃掉」。
    const C = classifyRules();
    chk('能区分「已确认」和「待确认」',
      typeof C.goodRules.length === 'number' && typeof C.waiting.length === 'number',
      '已确认 ' + C.goodRules.length + ' / 待确认 ' + C.waiting.length);

    // 待确认的规矩**不算已确认** —— 这是最关键的一条
    const pendingTexts = new Set(C.waiting.map((w) => w.text));
    const overlap = C.goodRules.filter((g) => pendingTexts.has(g.text));
    chk('反例：待确认的不能被算成已确认', overlap.length === 0,
      overlap.length ? overlap.length + ' 条重叠' : '无重叠');

    // realBad 和 waiting 必须互斥
    const rb = new Set(C.realBad.map((w) => w.text));
    const cross = C.waiting.filter((w) => rb.has(w.text));
    chk('反例：「真漏了」和「待确认」不能重叠', cross.length === 0,
      cross.length ? cross.length + ' 条重叠' : '无重叠');
  }

  console.log();
  console.log('【八】反例：假来源必须让 ok=false');
  {
    // 直接验 classifyRules 的底层判据：一条假来源的规矩不能进 goodRules
    const fake = { id: 'z', text: '假规矩', approvedBy: '体检结论', approvedAt: '2026-11-13' };
    chk('反例：approvedBy=体检结论 → judgeRuleSource 判无效',
      judgeRuleSource(fake).ok === false, judgeRuleSource(fake).problems.join('; '));
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
/**
 * 分类判定（唯一出处）
 *
 * ⚠ 2026-11-13 加：把判定抽出来，给 --list 和完整模式共用。
 *
 *   原来 --list 在做了分类之前就 return 了，而机制体检用的正是 --list ——
 *   等于机制体检里这一项**从来没有真正判定过**。
 *   这是「看起来有、实际是空」的又一实例。
 */
export function classifyRules() {
  const rules = loadRules();
  const undeclared = scanUndeclaredRules();
  const pending = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA, '规则待确认.json'), 'utf8'));
      return Array.isArray(j.items) ? j.items : [];
    } catch { return []; }
  })();

  const pendingItems = pending.filter((p) => p.state === 'pending');
  const approvedItems = pending.filter((p) => p.state === 'approved');

  function norm(t) {
    return String(t || '').replace(/^\d+\.\s*/, '').replace(/\s+/g, '').replace(/[（(].*$/, '');
  }
  function textMatches(a, b) {
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return false;
    return na.includes(nb) || nb.includes(na);
  }

  const badRules = rules.filter((r) => !judgeRuleSource(r).ok);
  const goodRules = rules.filter((r) => judgeRuleSource(r).ok);

  const waiting = [];
  const realBad = [];
  for (const u of undeclared) {
    if (rules.some((r) => textMatches(r.text, u.text))) continue;
    if (approvedItems.some((p) => textMatches(p.text, u.text))) continue;
    if (pendingItems.some((p) => textMatches(p.text, u.text))) { waiting.push(u); continue; }
    realBad.push(u);
  }

  return {
    rules, goodRules, badRules, undeclared,
    pendingItems, approvedItems, waiting, realBad,
    ok: badRules.length === 0 && realBad.length === 0,
  };
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const C = classifyRules();
  const { rules, goodRules, badRules, undeclared, pendingItems, approvedItems, waiting, realBad } = C;

  if (has('list')) {
    // --list 是机制体检用的只读模式：给结论 + 关键数字，不带 -1
    console.log('  规则来源体检');
    console.log('    已确认（机主批准）: ' + goodRules.length);
    console.log('    有假来源:           ' + badRules.length);
    console.log('    在走确认流程:       ' + waiting.length);
    console.log('    ⛔ 真的漏了:        ' + realBad.length);

    if (badRules.length) {
      console.log();
      console.log('    ⛔ 登记了不合法的来源:');
      for (const r of badRules) console.log('      · ' + (r.id || '?') + '  ' + judgeRuleSource(r).problems.join('; '));
    }
    if (realBad.length) {
      console.log();
      console.log('    ⛔ 既没登记也不在待确认清单:');
      for (const u of realBad) console.log('      · [' + u.where + '] ' + u.text.slice(0, 56));
    }
    if (waiting.length) {
      console.log();
      console.log('    ⚠ 这 ' + waiting.length + ' 条按参考项目的判据仍然是**无效**的，');
      console.log('      只是我们看得见、并且有流程在处理（规则待确认.mjs）。');
    }

    process.exitCode = C.ok ? 0 : 1;
    return;
  }

  console.log('='.repeat(80));
  console.log('  规则来源体检 —— 每条规矩都必须说得清「谁什么时候批准的」');
  console.log('='.repeat(80));
  console.log();
  console.log('  为什么这么严（参考项目的原话）：');
  console.log('    「AI 非常容易把『某个工具说应该这样』当成『机主批准这样』。');
  console.log('     一旦允许这样推，规矩会自己长 —— 三个月后没人知道哪条是真的。」');
  console.log();
  console.log('  判据：一条规矩如果说不清「是谁什么时候批准的」，它就是无效的。');
  console.log();

  // ① 登记表里的规矩
  console.log('  ── ① 登记表（' + rules.length + ' 条）──');
  if (!rules.length) {
    console.log('    （空）');
  } else {
    let bad = 0;
    for (const r of rules) {
      const j = judgeRuleSource(r);
      if (!j.ok) {
        bad++;
        console.log('    XX ' + (r.id || '?'));
        for (const p of j.problems) console.log('         · ' + p);
      } else {
        console.log('    OK ' + r.id.padEnd(10) + r.approvedBy.padEnd(8) + r.approvedAt.padEnd(12) +
          String(r.text).slice(0, 36));
      }
    }
    console.log('    ' + (rules.length - bad) + ' / ' + rules.length + ' 条合规');
  }
  console.log();

  // ② 代码里在跑、但没登记来源的规矩
  console.log('  ── ② 在跑但没登记来源的规矩（' + undeclared.length + ' 条）──');
  if (!undeclared.length) {
    console.log('    （没有）');
  } else {
    for (const u of undeclared) {
      console.log('    ⚠ [' + u.where + '] ' + u.text.slice(0, 64));
    }
    console.log();
    console.log('    这些规矩**没有合法来源** —— 按参考项目的判据，它们"无效"。');
    console.log('    要保留就必须补上「谁批准 + 何时批准」；否则该删。');
  }

  console.log();
  console.log('─'.repeat(80));

  // ⚠ 2026-11-13 加：判定要区分「已确认」和「待确认」，否则这个检查永远红
  //
  //   问题：21 条在跑的规矩都没登记来源（AGENTS.md 9 条 + 硬规矩 3 条 + 其他）。
  //        如果这里直接判失败，它就是个**永远红的检查** ——
  //        而「永远红的检查 = 装饰」，和「永远绿」一样没用。
  //
  //   正确做法：
  //     · 已登记且合法        → 通过
  //     · 已登记但不合法      → 失败（有人塞了假来源）
  //     · 未登记但在待确认清单 → 警告（不是失败，因为流程正在走）
  //     · 未登记且不在待确认   → 失败（真的漏了）
  //
  //   这样它只在「真的漏了」或「有假来源」时红，
  //   而不是永远红。
  //
  // ⚠ 2026-11-13 重构：这段逻辑已抽到 classifyRules()，两处共用。
  //   原来这里有一份副本 + --list 里一份，,--list 那份在判定前就 return 了，
  //   等于机制体检里这一项从没真正判定过。

  console.log();
  console.log('  ── ③ 分类判定 ──');
  console.log('    已登记合法:      ' + goodRules.length);
  console.log('    已登记有假来源:  ' + badRules.length);
  console.log('    在待确认清单:    ' + waiting.length + (waiting.length ? '（流程正在走，不算失败）' : ''));
  console.log('    ⛔ 真的漏了:     ' + realBad.length);

  if (realBad.length) {
    console.log();
    console.log('    这些规矩既没登记来源，也不在待确认清单 —— 真的漏了:');
    for (const u of realBad) console.log('      · [' + u.where + '] ' + u.text.slice(0, 60));
    console.log();
    console.log('    修法：node 工具/规则待确认.mjs --scan 把它们扫进待确认清单');
  }

  console.log();
  console.log('─'.repeat(80));

  if (badRules.length || realBad.length) {
    if (badRules.length) {
      console.log('  ⛔ 有规矩登记了不合法的来源（这是严重问题）:');
      for (const r of badRules) {
        console.log('    · ' + (r.id || '?') + '  approvedBy=' + (r.approvedBy || '?'));
        for (const p of judgeRuleSource(r).problems) console.log('        ' + p);
      }
    }
    if (realBad.length) console.log('  ⛔ ' + realBad.length + ' 条规矩真的漏了来源登记');
    process.exitCode = 1;
  } else {
    console.log('  ✓ 通过（' + rules.filter((r) => judgeRuleSource(r).ok).length + ' 条已确认，' +
      waiting.length + ' 条在走确认流程）');
    console.log();
    console.log('  ⚠ 注意：「在走确认流程」不是「已确认」。');
    console.log('    这 ' + waiting.length + ' 条规矩目前按参考项目的判据仍然是**无效**的，');
    console.log('    只是我们看得见这件事、并且有流程在处理它。');
  }
  console.log('='.repeat(80));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
