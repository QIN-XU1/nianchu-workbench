#!/usr/bin/env node
/**
 * 矩阵诚实性审计 —— 防止「拿参照系统自己的能力当我们的」
 *
 * 背景（为什么需要这个）：
 *   本项目最早的实现方式是「在 hermes-agent 上打补丁」。而 hermes-agent
 *   **本身就是 7 个参照系统之一**。于是矩阵的「我们」那一列里，大量证据写的是
 *   「hermes 能做什么」—— 这在逻辑上等于「hermes 超过 hermes」，
 *   是典型的假绿：看起来有证据，实际没有自己的实现。
 *
 *   这个脚本把这件事变成可判定的：
 *     · 扫描 matrix-data.json 里 us[1]（证据文本）
 *     · 若证据只是描述 hermes 的行为，而没有指明**我们自己的代码位置**，
 *       就记一条违规
 *     · 有违规 → 退出 1（不许当成通过）
 *
 * 什么算「我们自己的代码位置」：
 *   hermes-patches/、tools/、prototype/、apps/、design-system/ 下的路径，
 *   且该路径真实存在。
 *
 * 什么算「借力声明」：
 *   显式写了「经 hermes 衍生」「依赖 hermes」「上游」等字样 —— 这类不算假绿，
 *   因为它们**承认**自己是借来的，且状态通常记「部分」。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');

const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const dims = raw.dimensions.flatMap((g) => g.items);

// 允许的「我们的代码」路径前缀
const OUR_PREFIXES = [
  'hermes-patches/',
  'tools/',
  'prototype/',
  'apps/',
  'design-system/',
  'brand/',
  'research/',
];

// 显式借力声明（承认借的是别人的，不算假绿）
// 真正的「空白」判据：trim() 只吃 ECMAScript WhiteSpace + LineTerminator，
// **不含零宽字符**。所以 ["有", "\u200b"] 这种「填个零宽空格当证据」能绕过假绿检测。
// 2026-11-16 由独立验证方 H-0080-B 抓到并端到端复现（A1 填单个 U+200B → 仍报 0 假绿 exit 0）。
const ZERO_WIDTH = /[\u200b-\u200f\u2060-\u2064\u3164\ufeff\u115f\u1160\u180e\u2800\u00ad]/g;
const isBlankEvidence = (s) => !String(s == null ? '' : s).replace(ZERO_WIDTH, '').trim();

const BORROWED = /经\s*hermes\s*衍生|依赖\s*hermes|借\s*hermes|上游\s*hermes|hermes[/\\]/i;

// 声明非目标：这一格本来就明说「我们不做」，不是能力声明，不该按假绿处理
const NON_GOAL = /声明非目标|非目标|换赛道/;

// 证据里出现这些词，说明主语是 hermes 而不是我们
const HERMES_SUBJECT = /\bhermes\b/i;

/** 从证据文本里抽出所有看起来像仓库路径的片段 */
function pathsIn(text) {
  const hits = new Set();
  /**
   * 抽出后必须**剥掉 `:行号` 后缀**
   *
   * 【2026-11-15 · 自检抓到的真 bug】原来不剥，于是
   *   「见 tools/memory/store.mjs:42」抽出的是 `tools/memory/store.mjs:42`，
   * `exists()` 判它不存在 ⇒ realPaths = [] ⇒ 误判成「没有任何我们自己的代码路径」。
   *
   * 而 `路径:行号` 正是本项目**全程使用的标准证据格式**（verify-goal R1/R7 都在数它）。
   * 也就是说：**引用得越精确，越会被误判成假绿。**
   *
   * 这个 bug 不是靠读代码发现的 —— 是给本审计加自检时，
   * 「正例：主语是 hermes 但有我们真实路径 → 不报」这条断言当场红了才暴露的。
   * 这正是 T4「每条主张要有反例」的价值：反例逼出被测代码的真问题。
   */
  const stripLoc = (s) => s.replace(/:\d+(-\d+)?$/, '');
  // 形如 hermes-patches/x.py、prototype/a/b.mjs、tools/c.mjs
  for (const m of text.matchAll(/((?:hermes-patches|tools|prototype|apps|design-system|brand|research)[/\\][^\s，。；、)）」"'`]+)/g)) {
    hits.add(stripLoc(m[1].replace(/\\/g, '/').replace(/[.。,;；:：]+$/, '')));
  }
  // 形如 verify-a15.py:12 / foo.mjs:96（裸文件名，视作 prototype 下）
  for (const m of text.matchAll(/([A-Za-z0-9_\-\u4e00-\u9fa5]+\.(?:mjs|py|ts|tsx|json))(?::\d+)?/g)) {
    hits.add(stripLoc(m[1]));
  }
  return [...hits];
}

/** 该路径是否真实存在（允许裸文件名在 prototype 下递归找） */
function exists(p) {
  if (OUR_PREFIXES.some((pre) => p.startsWith(pre))) {
    if (fs.existsSync(path.join(REPO, p))) return true;
  }
  // 裸文件名：在 prototype / tools / hermes-patches 下找
  const name = path.basename(p);
  const roots = ['prototype/hermes-agents', 'prototype/agent-ui', 'tools', 'hermes-patches', 'apps/agent-ui/src'];
  for (const r of roots) {
    const dir = path.join(REPO, r);
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.isDirectory()) {
          if (!/node_modules|dist|\.git/.test(e.name)) stack.push(path.join(cur, e.name));
        } else if (e.name === name) return true;
      }
    }
  }
  return false;
}

/**
 * 核心审计 —— 抽成纯函数便于自检
 *
 * @param dims      维度数组，每项形如 { id, name, us: ['有'|'部分'|'无', '证据文本'] }
 * @param existsFn  判定「某个路径是否真实存在」的函数（自检时注入假实现）
 * @returns { violations, borrowAcks, checked }
 */
export function auditDims(dims, existsFn = exists) {
  const violations = [];
  const borrowAcks = [];
  let checked = 0;

  for (const it of dims) {
    const us = it.us;

    // ── 证据整条缺失 ──────────────────────────────────────────
    //
    // 【2026-11-15 修】原来这里是 `if (!Array.isArray(us) || us.length < 2) continue;`
    // —— 把「证据被清空」的行**直接跳过**。
    //
    // 后果：一个维度声称状态为「有」，却**连一条证据都没有**（us = ['有']），
    // 这是**最该报的假绿**，审计却当它不存在。
    //
    // 发现方式：L4 度量（tools/evolve/measure-verifier-efficacy.mjs）的
    // 难度注入 F10 —— 清空某维证据但保留状态「有」，本审计 exit 0（漏报）。
    // 这是第一轮「难度提高后 recall 从 1.000 掉到 0.833」抓到的两个真 gap 之一。
    if (!Array.isArray(us) || us.length === 0) {
      violations.push({
        id: it.id, name: it.name, state: '?',
        evidence: '(无 us 字段)',
        why: '维度没有任何 us 字段 —— 无法判断我们是否有这个能力，属于未填而非「无」',
      });
      continue;
    }
    if (us.length < 2) {
      const st = String(us[0] || '?');
      // 状态声称「有」但零证据 ⇒ 违规；状态是「无/部分」且无证据 ⇒ 只需说明（非违规）
      if (st === '有') {
        violations.push({
          id: it.id, name: it.name, state: st,
          evidence: '(证据为空)',
          why: '声称状态为「有」但没有任何证据 —— 这是最典型的假绿',
        });
      } else {
        borrowAcks.push({ id: it.id, name: it.name, state: st, note: '无证据但未声称「有」' });
      }
      continue;
    }

    checked++;
    const [state, evidence] = us;
    const ev = String(evidence || '');

    // 【2026-11-16 修】us = ['有', ''] 时 us.length === 2，会绕过上面的
    // `us.length < 2` 分支；而空字符串不匹配 BORROWED / NON_GOAL / HERMES_SUBJECT
    // 任何一个，于是**静默通过** —— 最典型的假绿漏报。
    //
    // 发现方式：突变检验（把 A1 的 us 改成 ['有','']，本审计仍报「疑似假绿: 0」）。
    // 教训：只检查「数组长度」不够，还要检查**内容是否为空**。
    if (isBlankEvidence(ev)) {
      if (state === '有') {
        violations.push({
          id: it.id, name: it.name, state,
          evidence: '(证据为空白字符串)',
          why: '声称状态为「有」但证据是空字符串 —— 这是最典型的假绿',
        });
      } else {
        borrowAcks.push({ id: it.id, name: it.name, state, note: '无证据但未声称「有」' });
      }
      continue;
    }

    const paths = pathsIn(ev);
    const realPaths = paths.filter(existsFn);

    const isBorrow = BORROWED.test(ev);
    // 判据：证据若只描述 hermes 行为、且没有任何一条我们的真实路径 → 违规
    const onlyHermes = HERMES_SUBJECT.test(ev) && realPaths.length === 0;

    if (isBorrow) {
      borrowAcks.push({ id: it.id, name: it.name, state, note: '已声明借力' });
    } else if (NON_GOAL.test(ev)) {
      borrowAcks.push({ id: it.id, name: it.name, state, note: '声明非目标' });
    } else if (onlyHermes) {
      violations.push({
        id: it.id,
        name: it.name,
        state,
        evidence: ev.slice(0, 120),
        why: '证据主语是 hermes，且没有任何我们自己的代码路径',
      });
    }
  }

  return { violations, borrowAcks, checked };
}

/**
 * 自检 —— 用假维度验证「该报的报、不该报的不报」
 *
 * 【为什么必须有】T4 要求每条主张「有可运行的验收器**与反例**」。
 * 一个审计如果只会说「通过」，那不是审计，是装饰。
 * 这里每条反例都断言：**构造一个假绿，审计必须报出来**。
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // 假的存在性判定：只有这两个路径"存在"
  const fakeExists = (p) => ['tools/memory/store.mjs', 'prototype/agent-ui/verify-cost.mjs'].includes(p);

  // ── 反例 1：证据主语是 hermes，且没有我们的路径 ──
  const v1 = auditDims([{ id: 'A1', name: 'x', us: ['有', 'hermes 有完整的 session 管理，实测可用。'] }], fakeExists);
  T('反例 · 主语是 hermes 且无我们的路径 → 报假绿',
    (v1?.violations || []).length === 1, JSON.stringify((v1?.violations || []).map((x) => x.why)));

  // ── 反例 2：状态「有」但证据整条清空（F10 抓到的真 gap）──
  const v2 = auditDims([{ id: 'A2', name: 'y', us: ['有'] }], fakeExists);
  // 【2026-11-16 加】钉住一个真实漏报：
  // us = ['有', ''] 时数组长度是 2，绕过了「长度 < 2」的检查；
  // 而空字符串不匹配 BORROWED / NON_GOAL / HERMES_SUBJECT 任何一条，
  // 于是**静默通过**。发现方式：突变检验（清空 A1 证据，审计仍报 0）。
  const gBlank = auditDims(
    [{ id: 'B1', name: '空白证据', us: ['有', ''] }],
    fakeExists,
  );
  // 【2026-11-16 加】独立验证方 H-0080-B 抓到的残余缺口：
  // trim() 只吃 WhiteSpace + LineTerminator，不吃零宽字符。
  // 于是把证据填成单个 U+200B，「填个零宽空格当证据」就能绕过假绿检测。
  // 端到端复现过：A1 填 \u200b → 审计仍报「疑似假绿: 0」exit 0。
  for (const zw of ['\u200b', '\u200c', '\u200d', '\ufeff', '\u3164', '\u2800', '\u00ad']) {
    const gz = auditDims([{ id: 'Z', name: '零宽', us: ['有', zw] }], fakeExists);
    T('反例 · 零宽字符 U+' + zw.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
      + ' 当证据必须报假绿（trim 拦不住它）',
      (gz?.violations || []).length === 1, JSON.stringify(gz?.violations || []));
  }

  T('反例 · 声称「有」但证据是空字符串 → 必须报假绿（不许静默通过）',
  (gBlank?.violations || []).length === 1 && /空白/.test(gBlank?.violations?.[0]?.evidence ?? ''),
  JSON.stringify(gBlank?.violations || []));

  T('反例 · 声称「有」但零证据 → 报假绿',
  (v2?.violations || []).length === 1 && /证据为空/.test(v2?.violations?.[0]?.evidence ?? ''),
  JSON.stringify((v2?.violations || []).map((x) => x.evidence)));

  // ── 反例 3：完全没有 us 字段 ──
  const v3 = auditDims([{ id: 'A3', name: 'z' }], fakeExists);
  T('反例 · 没有 us 字段 → 报未填',
  (v3?.violations || []).length === 1 && /未填/.test(v3?.violations?.[0]?.why ?? ''),
  JSON.stringify((v3?.violations || []).map((x) => x.why)));

  // ── 正例 1：主语是 hermes 但**有**我们真实路径 → 不报 ──
  const v4 = auditDims([{ id: 'A4', name: 'w', us: ['有', 'hermes 也有，但我们自己实现了 tools/memory/store.mjs:42'] }], fakeExists);
  T('正例 · 主语是 hermes 但有我们真实路径 → 不报',
    (v4?.violations || []).length === 0 && (v4?.checked || []) === 1, JSON.stringify(v4?.violations));

  // ── 正例 2：显式声明借力 → 不报（但记为借力）──
  const v5 = auditDims([{ id: 'A5', name: 'v', us: ['部分', '经 hermes 衍生，未自研。'] }], fakeExists);
  T('正例 · 显式声明借力 → 不报且记为借力',
    (v5?.violations || []).length === 0 && (v5?.borrowAcks || []).length === 1, JSON.stringify(v5));

  // ── 正例 3：声明非目标 → 不报 ──
  const v6 = auditDims([{ id: 'A6', name: 'u', us: ['无', '声明非目标：我们不打算做这个。'] }], fakeExists);
  T('正例 · 声明非目标 → 不报',
    (v6?.violations || []).length === 0 && (v6?.borrowAcks || []).some((b) => b.note === '声明非目标'), JSON.stringify(v6));

  // ── 正例 4：状态「无」且无证据 → 不报（不是假绿，是诚实说没有）──
  const v7 = auditDims([{ id: 'A7', name: 't', us: ['无'] }], fakeExists);
  T('正例 · 状态「无」且无证据 → 不报',
    (v7?.violations || []).length === 0, JSON.stringify(v7?.violations));

  // ── 反例 4：路径写了但**不存在** → 也算无我们的实现 ──
  const v8 = auditDims([{ id: 'A8', name: 's', us: ['有', 'hermes 有，见 tools/does-not-exist.mjs:1'] }], fakeExists);
  T('反例 · 引用的路径不存在 → 仍报假绿（不许拿假路径充数）',
    (v8?.violations || []).length === 1, JSON.stringify((v8?.violations || []).map((x) => x.why)));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  矩阵诚实性审计 · 自检（4 正例 + 4 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

// ── 正式审计（只在直接运行时执行）──
if (isMain) {
  const { violations, borrowAcks, checked } = auditDims(dims);

  console.log('');
  console.log('  矩阵诚实性审计 —— 「我们」这一列是不是真的我们');
  console.log('  ' + '─'.repeat(72));
  console.log('  检查维度: ' + checked + ' / ' + dims.length);
  console.log('  已声明借力（允许）: ' + borrowAcks.length);
  if (borrowAcks.length) {
    for (const b of borrowAcks) console.log('    · ' + b.id + ' ' + b.name + '  [' + b.state + ']');
  }
  console.log('  疑似假绿: ' + violations.length);
  for (const v of violations) {
    console.log('');
    console.log('    ✗ ' + v.id + ' ' + v.name + '  [' + v.state + ']');
    console.log('       证据: ' + v.evidence + '…');
    console.log('       原因: ' + v.why);
  }

  console.log('');
  console.log('  ' + '─'.repeat(72));
  if (violations.length) {
    console.log('  ✗ ' + violations.length + ' 项把参照系统（hermes）的能力当成了我们的');
    console.log('    处置：要么补上我们自己的实现与路径，要么把状态降级并写明借力。');
    console.log('');
    process.exit(1);
  }
  console.log('  ✓ 全部「我们」的格子都有我们自己的实现依据');
  console.log('');
}