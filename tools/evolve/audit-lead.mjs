#!/usr/bin/env node
/**
 * T5 审计 —— 横向领先：我们在 31 维矩阵上真的比全部参照系统强吗
 *
 * ── T5 的判据 ────────────────────────────────────────────
 *   「31 维矩阵上我们的覆盖率高于全部参照系统，
 *     且每一格有我们自己的可运行实现或如实标注「借力」；
 *     无假绿（audit-matrix-honesty 保持 0）」
 *
 * 三个可判定成分：
 *   ① 覆盖率：我们「有」的维数 > 每个参照系统「有」的维数
 *   ② 每格诚实：我们的「有/部分」必须有真实路径支撑（audit-matrix-honesty 管）
 *   ③ 无假绿
 *
 * ── 为什么要单独审计 ────────────────────────────────────
 * 「我们领先」是个很容易自欺的主张。render-matrix 只校验「有状态有证据」，
 * 不校验「我们真的比他们多」。这个脚本把覆盖率真算出来。
 *
 * 用法：node tools/evolve/audit-lead.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  T5 审计器 · 自检（3 正例 + 3 反例，钉住「名字含空格被漏」）');
  console.log('  ' + '-'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}


const REPO = path.resolve(import.meta.dirname, '../..');
const MX = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');

const M = JSON.parse(fs.readFileSync(MX, 'utf8'));
const SUBJECTS = M.subjects;   // [{ id, name, ... }]
const allDims = M.dimensions.flatMap((g) => g.items);

/**
 * 状态计分
 *
 * 为什么不把「部分」算成 1：那会把「做了一点点」和「做完」混为一谈。
 * 也不把「部分」算成 0：那会假装我们什么都没做。
 * 用 0.5 是折中，**并且同时报出「有」的绝对数** —— 两个数一起看才不会被单项蒙住。
 */
const SCORE = { '有': 1, '部分': 0.5, '无': 0, '借力': 0.5, '声明非目标': 0 };

console.log('');
console.log('  T5 审计 —— 31 维矩阵上的横向领先');
console.log('  ' + '='.repeat(78));
console.log('  ' + allDims.length + ' 维 × ' + SUBJECTS.length + ' 方 = ' + (allDims.length * SUBJECTS.length) + ' 格');
console.log('');

const stats = [];
for (const s of SUBJECTS) {
  let full = 0, part = 0, none = 0, other = 0, score = 0;
  for (const d of allDims) {
    const cell = d[s.id];
    if (!Array.isArray(cell)) { other++; continue; }
    const st = String(cell[0] || '').trim();
    if (st === '有') { full++; score += 1; }
    else if (st === '部分' || st === '借力') { part++; score += 0.5; }
    else if (st === '无') { none++; }
    else { other++; score += SCORE[st] ?? 0; }
  }
  stats.push({ id: s.id, name: s.name, full, part, none, other, score, dims: allDims.length });
}

// 按得分排序
stats.sort((a, b) => b.score - a.score);

console.log('  排名（按加权得分，「有」=1 · 「部分/借力」=0.5 · 「无」=0）');
console.log('  ' + '─'.repeat(78));
console.log('  ' + '#'.padEnd(4) + '主体'.padEnd(18) + '有'.padEnd(6) + '部分'.padEnd(8) + '无'.padEnd(6) + '加权'.padEnd(9) + '覆盖率');
for (let i = 0; i < stats.length; i++) {
  const s = stats[i];
  const cover = (s.score / s.dims * 100).toFixed(1) + '%';
  const mark = s.id === 'us' ? '  ← 我们' : '';
  console.log('  ' + String(i + 1).padEnd(4) + s.name.padEnd(18)
    + String(s.full).padEnd(6) + String(s.part).padEnd(8) + String(s.none).padEnd(6)
    + s.score.toFixed(1).padEnd(9) + cover + mark);
}

// ── 判据 ①：我们是不是第一 ──
const us = stats.find((s) => s.id === 'us');
const rank = stats.findIndex((s) => s.id === 'us') + 1;
const second = stats.find((s) => s.id !== 'us');

const leading = rank === 1 && us.score > second.score;

console.log('');
console.log('  ' + '─'.repeat(78));
console.log('  ① 覆盖率领先');
console.log('     我们排名 ' + rank + '/' + stats.length
  + ' · 加权 ' + us.score.toFixed(1) + ' vs 第二名（' + second.name + '）' + second.score.toFixed(1)
  + ' · 差距 ' + (us.score - second.score).toFixed(1));
console.log('     ' + (leading ? '✓ 我们领先' : '✗ **没有领先**'));

// ── 判据 ②：假绿 ──
console.log('');
console.log('  ② 无假绿（audit-matrix-honesty）');
let honesty = { code: null, out: '' };
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [path.join(REPO, 'prototype/hermes-agents/audit-matrix-honesty.mjs')],
    { cwd: REPO, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  honesty = { code: 0, out };
} catch (e) {
  honesty = { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
}
const fakeN = /疑似假绿:\s*(\d+)/.exec(honesty.out);
const fakes = fakeN ? Number(fakeN[1]) : -1;
console.log('     疑似假绿 ' + (fakes < 0 ? '读不出' : fakes) + ' 项 · exit ' + honesty.code);
console.log('     ' + (fakes === 0 ? '✓ 无假绿' : '✗ **有假绿或读不出**'));

// ── 判据 ③：我们的「有」格子有没有实现依据 ──
console.log('');
console.log('  ③ 我们「有」的格子有没有实现依据');
const ourFull = allDims.filter((d) => String(d.us?.[0] || '') === '有');
const ourPart = allDims.filter((d) => String(d.us?.[0] || '') === '部分');
const ourNone = allDims.filter((d) => String(d.us?.[0] || '') === '无');
console.log('     有 ' + ourFull.length + ' · 部分 ' + ourPart.length + ' · 无 ' + ourNone.length);
console.log('     （依据由 audit-matrix-honesty 逐格核对，它 0 假绿即视为通过）');

/**
 * ── 判据 ④：可执行对照（比自评强）─────────────────────────
 *
 * 【2026-11-15 新加 · 这一条推翻了我自己的 T5 结论】
 *
 * 上面 ①②③ 用的都是**自评矩阵**。为了不只靠自评，另跑
 * tools/benchmark/executable-compare.mjs —— 同一把尺子量所有系统源码里的痕迹。
 *
 * 实测结果：8 个探测项里我们 **3 项落后 openclaw**（记忆 TTL / 改进前后度量 / 记忆冲突）。
 *
 * 这直接证明「我们全维度领先」是错的。所以 T5 不能再给 PASS。
 *
 * ⚠ 但这个探测本身也有局限，必须一起说：
 *   · 它数的是**痕迹次数**，不是质量。openclaw 的 TTL 命中多，可能只是
 *     变量命名习惯不同（每个文件都写 ttl），不代表它的 TTL 做得更好。
 *   · 所以「落后」的正确读法是「需要做真正的功能对照」，
 *     不是「已经证明我们更差」。
 *   · 同理「领先」也不能当质量优势的证据。
 *
 * 结论：这一条的作用是**防止自评独大**，不是给出最终评分。
 */
console.log('');
console.log('  ④ 可执行对照（同一把尺子量源码痕迹，防自评独大）');
let execCompare = null;
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [path.join(REPO, 'tools/benchmark/executable-compare.mjs')],
    { cwd: REPO, encoding: 'utf8', timeout: 900000, stdio: ['ignore', 'pipe', 'pipe'] });
  // 用 parseProbeRows()（与自检同一份实现，不留第二份）
  execCompare = { ok: true, rows: parseProbeRows(out) };
} catch (e) {
  execCompare = { ok: false, rows: [], why: String(e.message).slice(0, 80) };
}

if (execCompare.ok && execCompare.rows.length) {
  const behind = execCompare.rows.filter((r) => r.verdict === '✗ 落后');
  const ahead = execCompare.rows.filter((r) => r.verdict === '✓ 领先');
  console.log('     探测 ' + execCompare.rows.length + ' 项 · 领先 ' + ahead.length
    + ' · 落后 ' + behind.length);
  for (const b of behind) {
    console.log('     ✗ ' + b.id + ' ' + b.name + '：我们 ' + b.ours + ' vs ' + b.bestWho + ' ' + b.best);
  }
  if (behind.length) {
    console.log('     → 「全维度领先」不成立。需要做真正的功能对照，不是继续数痕迹。');
  }
  execCompare.behind = behind.map((b) => b.id + ' ' + b.name);
  execCompare.aheadCount = ahead.length;
} else {
  console.log('     ❔ 可执行对照跑不了：' + (execCompare.why || '无输出'));
}

/**
 * ⑤ 绝对口径对照（第 130 轮新增）
 *
 * ══ 为什么要补这一段 ══════════════════════════════════════════════
 * ④ 用的是「每千文件命中率」。它自己的 limitation 写着：
 *   「每千文件命中率 = 能力散布在多少个文件里，**不是能力有多强**。
 *     分母越小，单个文件命中对结果影响越大」。
 * 实测我们 2357 个文件，最大对手 56264 个 —— **分母差 23.9 倍**。
 * 这种量级差下，「率」的高低主要反映库的大小，不是能力强度。
 *
 * 所以 ④ 判「落后」的 4 项，必须再用**不依赖分母**的口径复核一遍：
 *   绝对命中数（有几个实现点）+ 关键形态（有没有那个能力的核心字段/逻辑）
 *   + 闭环（有没有配套验证）。
 * 三段都过 = 有能力；只在「率」上落后 = 分母效应。
 *
 * ⛔ 这**不是**为了把落后洗成领先 —— 如果关键形态缺失或没有闭环，
 *    这里照样会报 FAIL。它只是把「率」和「有没有」分开说。
 */
console.log('');
console.log('  ⑤ 绝对口径复核（不除以文件数，看「有没有」而非「散布多广」）');
let absAudit = null;
try {
  const { execFileSync } = await import('node:child_process');
  const out2 = execFileSync(process.execPath, [path.join(REPO, 'tools/evolve/audit-capability-absolute.mjs')],
    { cwd: REPO, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
  const mState = /四态:\s*(PASS|WARN|FAIL|UNKNOWN)/.exec(out2);
  const mPass = /通过 (\d+) · 失败 (\d+)/.exec(out2);
  const mRatio = /分母比 ([\d.]+) 倍/.exec(out2);
  absAudit = {
    ok: true,
    state: mState ? mState[1] : 'UNKNOWN',
    pass: mPass ? Number(mPass[1]) : 0,
    fail: mPass ? Number(mPass[2]) : 0,
    ratio: mRatio ? Number(mRatio[1]) : null,
  };
  console.log('     实现点 + 关键形态 + 闭环：通过 ' + absAudit.pass + ' · 失败 ' + absAudit.fail
    + '（四态 ' + absAudit.state + '）');
  if (absAudit.ratio) {
    console.log('     分母差异：' + absAudit.ratio + ' 倍 —— 「每千文件命中率」在此量级差下不可比');
  }
  if (execCompare && execCompare.behind && execCompare.behind.length && absAudit.state === 'PASS') {
    console.log('     → ④ 判落后的 ' + execCompare.behind.length + ' 项，在绝对口径下**都有实现点 + 关键形态 + 闭环**');
    console.log('       即：落后主要来自分母效应（我们库小），不是能力缺失。');
    console.log('       但仍**不能**据此说「我们更强」—— 强度需功能对照实验。');
  }
} catch (e) {
  console.log('     ❔ 绝对口径复核跑不了：' + String(e.message).slice(0, 80));
}

// ── 四态 ──
let state, why;
if (!stats.length) {
  state = 'UNKNOWN'; why = '矩阵没有主体';
} else if (!us) {
  state = 'UNKNOWN'; why = '矩阵里找不到「我们」（us）这一列';
} else if (fakes < 0) {
  state = 'UNKNOWN'; why = '审计读不出假绿数';
} else if (fakes > 0) {
  state = 'FAIL'; why = fakes + ' 项假绿 —— 先把「我们」那一列做实';
} else if (!leading) {
  state = 'FAIL'; why = '覆盖率不是第一（排名 ' + rank + '）';
} else if (!execCompare.ok) {
  // 自评领先但无法做可执行对照 ⇒ 不许给 PASS（自评独大就是假绿的温床）
  state = 'WARN';
  why = '自评矩阵领先（' + us.score.toFixed(1) + ' vs ' + second.score.toFixed(1) + '）'
    + '，但可执行对照跑不了 —— 只有自评，不许当 PASS';
} else if ((execCompare.behind || []).length > 0) {
  // 【2026-11-15 第三改 · 诚实的终点】
  //
  // 前两次我拿这个可执行对比当判据：先按原始计数判「4 项落后」，再按每千文件判「6 项落后」。
  // 但把两种口径摆在一起看，**结论互相矛盾**：
  //   原始计数偏大仓库（openclaw 56264 文件 vs 我们 28024）
  //   每千文件偏超小仓库（luanyujia 43 文件 → P4 325/千文件，登顶）
  // 同一个「谁更强」的问题，换个分母就换答案 ⇒ **这个度量测的是词汇密度，不是能力。**
  //
  // 按 C2：判不了就说判不了。所以 T5 记 UNKNOWN，不拿一个自相矛盾的指标去判。
  state = 'UNKNOWN';
  why = '矩阵加权第一（' + us.score.toFixed(1) + ' vs ' + second.score.toFixed(1) + '）但**其它各列是我们自己的估计、未经独立核验**；'
    + '可执行对比两种口径结论相反（原始计数偏大库 P1/P4/P6/P8 判落后，每千文件偏小库又判不同）⇒ '
    + '**没有有效方法验证「覆盖率高于全部参照系统」**。'
    /**
     * 【第 130 轮补】把「分母效应」这一层单独说清。
     *
     * ⑤ 的绝对口径复核证明：④ 判落后的 4 项，在「实现点 + 关键形态 + 闭环」口径下都有。
     * 分母差 23.9 倍 —— 说明 ④ 的「落后」主要是度量缺陷，不是能力缺失。
     *
     * 但这**不能**把 T5 推成 PASS：
     *  · 它只解释了 8 项里的 4 项
     *  · 「有能力」不等于「比对手强」，强度需要功能对照实验
     *  · 更根本的是：矩阵里对手那些分数仍是我们自己打的
     * 所以结论仍是 UNKNOWN，但理由更精确了 ——
     * 不是「我们落后」，也不是「我们领先」，而是「没有有效方法验证」。
     */
    + (absAudit && absAudit.state === 'PASS'
      ? '【第 130 轮复核】④ 判落后的 ' + (execCompare.behind || []).length + ' 项，在「实现点+关键形态+闭环」绝对口径下'
        + '全部通过（' + absAudit.pass + '/' + (absAudit.pass + absAudit.fail) + '），'
        + '且分母差 ' + (absAudit.ratio || '?') + ' 倍 ⇒ 那 4 项「落后」主要是**每千文件命中率的分母效应**，不是能力缺失。'
        + '但这只解释了 8 项里的 4 项，且「有能力」≠「比对手强」（强度需功能对照实验）。'
      : '')
    + (() => {
      // 引用 evidence-grade 的量化结果：竞品格里有多少是「只能信记录者」的纯文字
      try {
        const ep = path.join(REPO, 'evidence/evolve/evidence-grade.json');
        const eg = JSON.parse(fs.readFileSync(ep, 'utf8'));
        return '实测：竞品 ' + eg.totHave + ' 个「有」格里只有 ' + eg.totProv
          + ' 格可核验（' + (eg.provRate * 100).toFixed(1) + '%），其余 '
          + ((1 - eg.provRate) * 100).toFixed(1) + '% 是**我们自己的文字描述**。';
      } catch { return ''; }
    })()
    + '按 C2 记 UNKNOWN，不用推测填空。';
} else {
  state = 'PASS';
  why = '覆盖率第一（' + us.score.toFixed(1) + ' vs ' + second.score.toFixed(1) + '）'
    + '· 0 假绿 · 有 ' + ourFull.length + ' 维度实做到'
    + '· 可执行对照 ' + execCompare.rows.length + ' 项无落后';
}

/**
 * ── 这个 PASS 有多强？必须说清 ────────────────────────────
 *
 * 三条限制，任何一条都足以让「我们领先」这个结论变弱：
 *
 *   ① **这是自评**。矩阵里其他 7 方的分数是**我们打的**，不是他们自评，也不是第三方评。
 *      「我们比他们强」目前的真实含义是「我们认为我们比他们强」。
 *      唯一的外部约束是 audit-matrix-honesty —— 它只保证**我们这一列**有我们自己的
 *      真实代码路径，不能保证我们对别人的评分准确。
 *
 *   ② **领先幅度很薄**。见上面第 ① 项的数字：差距 0.5 分。
 *      一次评分调整就能翻转。
 *
 *   ③ **加权口径是我定的**（有=1 / 部分=0.5 / 无=0）。
 *      换个口径结论可能不同。同时报「有」的绝对数就是为了对冲这一点。
 *
 * 所以 T5 的正确读法是：
 *   **「在我们自己的评估口径下，我们不是落后的」** —— 而不是「客观上最强」。
 * 要变成后者，需要第三方评分或可执行的功能对等测试。
 */
const margin = us.score - second.score;
const limits = [
  '自评：其他 7 方的分数由我们打，不是第三方评分',
  '领先幅度 ' + margin.toFixed(1) + ' 分（1 次评分调整就能翻转）',
  '加权口径由我们定（有=1/部分=0.5/无=0），换口径可能不同',
];

console.log('');
console.log('  四态: ' + state + ' —— ' + why);
console.log('');
console.log('  ⚠ 这个 PASS 的强度限制（必须一起读）：');
for (const l of limits) console.log('      · ' + l);

const OUT = {
  what: 'T5 审计：横向领先',
  at: new Date().toISOString(),
  state, why,
  rank, dims: allDims.length, subjects: SUBJECTS.length,
  stats,
  ourFull: ourFull.map((d) => d.id),
  ourPart: ourPart.map((d) => d.id),
  ourNone: ourNone.map((d) => d.id),
  fakeGreen: fakes,
  margin,
  limits,
  execCompare: execCompare ? { ok: execCompare.ok, behind: execCompare.behind || [], aheadCount: execCompare.aheadCount || 0, rows: execCompare.rows || [] } : null,
};
const outPath = path.join(REPO, 'evidence/evolve/lead-audit.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(OUT, null, 2) + '\n', 'utf8');
console.log('  → ' + path.relative(REPO, outPath));
console.log('');

if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
process.exit(state === 'PASS' ? 0 : state === 'FAIL' ? 1 : 2);

/**
 * 解析 executable-compare 的「我们 vs 参照系统」段落
 *
 * 【2026-11-15 修】原来用 (\S+) 匹配探测名 —— 名字**含空格**就匹配不上。
 * 实测 'P3 第三态 UNKNOWN' 被静默漏掉：8 项只解析出 7 项，
 * 而 P3 正是我们领先最多的一项 —— 漏掉它会让「落后项数」被高估。
 * 改成 (.+?) 惰性匹配到 '我们 N' 之前。
 */
export function parseProbeRows(out) {
  const re = /^  (P\d) (.+?)\s+我们 ([\d.]+)\s+最强 ([\d.]+)（([^）]*)）\s+(✓ 领先|= 持平|✗ 落后)/gm;
  const rows = [];
  let mm;
  while ((mm = re.exec(out)) !== null) {
    rows.push({ id: mm[1], name: mm[2].trim(), ours: Number(mm[3]), best: Number(mm[4]), bestWho: mm[5], verdict: mm[6] });
  }
  return rows;
}

export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const sample = [
    '  P1 成本核算              我们 173    最强 198（openclaw）        ✗ 落后',
    '  P2 记忆老化（TTL）         我们 131    最强 399（openclaw）        ✗ 落后',
    '  P3 第三态 UNKNOWN       我们 157    最强 74（hermes-a）         ✓ 领先',
    '  P7 成本冻结/快照           我们 1      最强 0（OpenBitF）          ✓ 领先',
    '',
  ].join('\n');

  const rows = parseProbeRows(sample);

  T('反例 · 名字含空格「第三态 UNKNOWN」不许漏（真实 bug）',
    rows.some((r) => r.id === 'P3'), 'P3 没解析出来 · rows=' + rows.map((r) => r.id).join(','));
  T('反例 · 4 行输入必须解析出 4 行（不许静默丢）',
    rows.length === 4, 'rows=' + rows.length + ' [' + rows.map((r) => r.id).join(',') + ']');
  T('正例 · 普通名字解析正确', rows.find((r) => r.id === 'P1').name === '成本核算', '');
  T('正例 · 含全角括号「记忆老化（TTL）」解析正确',
    rows.find((r) => r.id === 'P2').name === '记忆老化（TTL）', '');
  T('正例 · 最强为 0 的项也能解析', rows.some((r) => r.id === 'P7' && r.best === 0), '');
  T('反例 · 「有 N/M」那种行不许被当成对比行',
    parseProbeRows('  P1 成本核算              有 12/16   没有：x\n').length === 0, '误匹配');

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

