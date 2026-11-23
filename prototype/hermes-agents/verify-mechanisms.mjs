#!/usr/bin/env node
/**
 * 执行逻辑四机制验证：调度 / 记忆 / 自愈 / 验证。
 *
 * 目标第 6 条要求「四件事必须各有可运行的机制和被真实触发的记录」。
 * 所以每件事都验三层，缺一层不算：
 *
 *   A 机制在位   —— 代码确实存在，且不是空壳（有体积、有实现）
 *   B 可运行     —— 它被 106 项机制体检注册成守卫（体检今天真跑过，91/106）
 *   C 真实触发   —— 台账/记忆里有真实记录，不是"我写了个机制但没人用"
 *
 * 只读：不跑会写盘的 selftest，不改任何数据。
 *
 * 用法：node verify-mechanisms.mjs
 *       node verify-mechanisms.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/file/AI Temp/DeepSeek/Agent自研';
const WB = path.join(REPO, 'workbench');
const TOOLS = path.join(WB, '工具');
const SHARED = 'C:/Users/15282/AppData/Local/hermes/dsh-shared';

const has = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');

// ════════════════════════════════════════════════════════════════════
//  核心判据（全部抽成纯函数，便于注入假输入做自检）
// ════════════════════════════════════════════════════════════════════

/**
 * 体积判定 —— 用**原始字节**，不用四舍五入后的 KB
 *
 * 【为什么这条重要】历史上 size-guard 就栽在这：把 32769 字节四舍五入成
 * 32.0KB，判据 `kb > 32` 为假 ⇒ 漏过红线。这里同样：3069 字节
 * （差 3 字节不到 3KB）会被舍入显示成 3.0KB，若拿 `kb >= 3` 判就会漏。
 * 所以判定一律用 bytes，kb 只用于显示。
 */
export function judgeSize(bytes, minKB = 3) {
  return { ok: bytes >= minKB * 1024, kb: Math.round((bytes / 1024) * 10) / 10 };
}

/** 剥掉注释与 shebang（只看可执行体，别被注释骗了） */
export function stripComments(src) {
  return String(src == null ? '' : src)
    .replace(/^#![^\n\r]*/gm, ' ')                          // shebang
    .replace(/\/\*[\s\S]*?\*\//g, ' ')                      // 块注释
    .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1');              // 行注释（避开 http://）
}

/**
 * 空壳判定（内容层）—— 文件在、体积也够，但「一跑就退出 0」
 *
 * 【为什么必须加】A 层原来只判体积。一个 10KB 的脚本，里面
 * `#!/usr/bin/env node` + 大段注释 + 一句 `process.exit(0);`，
 * 体积达标、`node x.mjs` 永远退出 0 —— 这就是「脚本存在但退出码永远是 0」
 * 的假绿：验收时它永远绿，因为它什么都没验。
 * 这里把两种最赤裸的空壳揪出来：剥完注释后没有代码 / 只剩一句 exit(0)。
 */
export function looksLikeShell(text) {
  const code = stripComments(text).replace(/\s+/g, ' ').trim();
  if (!code) return true;                                        // 全是注释/空白
  if (/^process\.exit\(\s*0\s*\)\s*;?$/.test(code)) return true;  // 只剩 exit(0)
  return false;
}

/**
 * 纯函数：A 层「机制在位」
 * deps: { resolve?, exists?, sizeOf?, readText? } —— 自检时注入假文件系统
 */
export function judgeInPlace(M, deps = {}) {
  const resolve = deps.resolve || ((rel) => path.join(WB, rel));
  const exists = deps.exists || has;
  const sizeOf = deps.sizeOf || ((p) => fs.statSync(p).size);
  const readText = deps.readText || read;
  const out = [];
  for (const [rel, label] of M.code) {
    const p = resolve(rel);
    if (!exists(p)) { out.push({ ok: false, msg: label, detail: '缺失 ' + rel }); continue; }
    const bytes = sizeOf(p);
    const sz = judgeSize(bytes);
    if (!sz.ok) { out.push({ ok: false, msg: label, detail: '只有 ' + sz.kb + 'KB，疑似空壳' }); continue; }
    // 体积达标但要防「文件在、内容是空的 / 只有一句 exit(0)」
    if (looksLikeShell(readText(p))) {
      out.push({ ok: false, msg: label, detail: '疑似空壳（剥注释后无实质实现）' });
      continue;
    }
    out.push({ ok: true, msg: label, detail: sz.kb + 'KB' });
  }
  return out;
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 纯函数：B 层「已注册为体检守卫」
 *
 * 【为什么不能只看子串】原判据是 `AUDIT.includes(守卫名)`。子串匹配意味着
 * 「守卫名只在一句注释里被提到」也算已注册 —— 一个从未真正接进体检流水线的
 * 名字，只要在文件里出现过一次就蒙混过关。这里要求它以**注册记录**
 * （`name: '守卫名'`）的形式出现，才算真注册。
 */
export function judgeGuards(guards, auditText) {
  const text = String(auditText == null ? '' : auditText);
  const hit = (g) => new RegExp('name\\s*:\\s*[\'"]' + escRe(g) + '[\'"]').test(text);
  const hits = guards.filter(hit);
  const missing = guards.filter((g) => !hit(g));
  return { ok: missing.length === 0, hits, missing };
}

/** 纯函数：B 层「体检脚本直接引用」该工具 */
export function judgeRef(tool, auditText, src) {
  const text = String(auditText == null ? '' : auditText);
  return { ok: text.includes(tool) || /派生|调用/.test(String(src || '')) };
}

/** 纯函数：C 层 ① 调度 —— 派单台账 */
export function judgeLedger(L) {
  if (!L || !Array.isArray(L.dispatches)) return [{ ok: false, msg: '派单台账读不到' }];
  const rows = L.dispatches;
  const out = [];
  const complete = rows.filter((r) => r.from && r.to && r.subject && r.verify && r.createdAt && r.state);
  out.push(rows.length >= 50
    ? { ok: true, msg: '派单台账真实记录', detail: rows.length + ' 条' }
    : { ok: false, msg: '派单记录过少', detail: rows.length + ' 条' });
  out.push(complete.length === rows.length
    ? { ok: true, msg: '每条都有 from/to/subject/verify/state' }
    : { ok: false, msg: '有 ' + (rows.length - complete.length) + ' 条字段不全' });
  const states = [...new Set(rows.map((r) => r.state))];
  out.push(states.every((s) => s && s !== 'unknown')
    ? { ok: true, msg: '状态全部明确', detail: states.join('/') }
    : { ok: false, msg: '存在不明状态', detail: states.join('/') });
  return out;
}

/** 纯函数：C 层 ② 记忆 —— files = [{ name, len }] */
export function judgeMemory(files) {
  const arr = Array.isArray(files) ? files : [];
  const substantive = arr.filter((f) => f.len > 2000).length;   // >2KB 说明不是模板骨架
  return [
    arr.length > 0 ? { ok: true, msg: '记忆文件存在', detail: arr.length + ' 个 .md' } : { ok: false, msg: '没有记忆文件' },
    substantive > 0
      ? { ok: true, msg: '记忆有实质内容（非模板）', detail: substantive + ' 个 >2KB' }
      : { ok: false, msg: '记忆全是模板' },
  ];
}

/**
 * 纯函数：C 层 ③自愈 + ④验证 —— 进化台账
 * 返回 { verdicts, levels }；levels 是等级分布（仅供人看，不是断言）
 */
export function judgeEvolution(evo) {
  if (!evo || !Array.isArray(evo.evolutions)) return { verdicts: [{ ok: false, msg: '进化台账读不到' }], levels: null };
  const evs = evo.evolutions;
  const out = [];
  out.push(evs.length > 0 ? { ok: true, msg: '进化台账真实记录', detail: evs.length + ' 条' } : { ok: false, msg: '进化台账为空' });
  const withTrigger = evs.filter((e) => e.trigger && String(e.trigger).length > 8);
  out.push(withTrigger.length === evs.length
    ? { ok: true, msg: '每条进化都有 trigger（记录了是什么 bug 驱动的）' }
    : { ok: false, msg: (evs.length - withTrigger.length) + ' 条没有 trigger' });
  const hasTarget = evs.every((e) => e.id && e.level && e.target);
  out.push(hasTarget ? { ok: true, msg: '每条都有 id/level/target（可回滚）' } : { ok: false, msg: '有缺字段的进化记录' });

  // 回测要求按等级分：这是 进化.mjs:151 的设计，不是所有等级都要回测。
  //   L1 记忆：只追加、可回滚 → 不要求回测
  //   L2 技能：改了行为 → 必须回测且全通过（进化.mjs:151-161、进化哨兵 INV-3）
  //   L3 身份：必须人工确认
  // 之前的断言错在「一律要回测」，会把 L1 的正确设计判成失败 —— 判据错比没判据更糟。
  const l2 = evs.filter((e) => e.level === 'L2');
  const l2bad = l2.filter((e) => {
    const bt = e.backtest;
    return !bt || !(Number(bt.cases) >= 1) || Number(bt.passed) !== Number(bt.cases);
  });
  out.push(l2bad.length === 0
    ? { ok: true, msg: 'L2 技能进化回测规则成立', detail: l2.length ? l2.length + ' 条 L2 全部通过回测' : '当前无 L2 记录（规则待触发）' }
    : { ok: false, msg: 'L2 回测不合规', detail: l2bad.map((e) => e.id).join(',') });

  const l3 = evs.filter((e) => e.level === 'L3');
  const l3bad = l3.filter((e) => !e.humanConfirmed);
  out.push(l3bad.length === 0
    ? { ok: true, msg: 'L3 身份进化需人工确认', detail: l3.length ? l3.length + ' 条已确认' : '当前无 L3 记录（规则待触发）' }
    : { ok: false, msg: 'L3 未经人工确认', detail: l3bad.map((e) => e.id).join(',') });

  const byLevel = {};
  for (const e of evs) byLevel[e.level] = (byLevel[e.level] || 0) + 1;
  const levels = Object.entries(byLevel).map(([k, v]) => k + '=' + v).join(' ');
  return { verdicts: out, levels };
}

/** 纯函数：C 层 ③ 回滚锚点（基线） */
export function judgeBaseline(base) {
  if (!base) return [{ ok: false, msg: '基线不存在，回滚无锚点' }];
  const n = Object.keys(base).length;
  return [n >= 2 ? { ok: true, msg: '回滚锚点（基线）存在', detail: n + ' 个字段' } : { ok: false, msg: '基线内容过少' }];
}

/** 纯函数：C 层 ④ 验证 —— 健康度按场景算出来（说明不是自评，是从台账重算） */
export function judgeHealth(h) {
  if (!h) return [{ ok: false, msg: '健康度不存在' }];
  const scenes = Object.keys(h.scenes || {});
  const withEvidence = scenes.filter((s) => (h.scenes[s].evidenceIds || []).length > 0);
  return [
    scenes.length > 0 ? { ok: true, msg: '健康度按场景重算', detail: scenes.length + ' 个场景' } : { ok: false, msg: '健康度为空' },
    withEvidence.length > 0
      ? { ok: true, msg: '健康度带 evidenceIds 回指台账（可复算）', detail: withEvidence.length + '/' + scenes.length }
      : { ok: false, msg: '健康度没有证据回指' },
  ];
}

/**
 * 自检 —— 每条反例都构造一种「看起来通过、其实是假绿」的输入，断言判据必须红
 *
 * 【为什么反例是这些】这个验收器全是「在位 / 注册 / 有记录」这类容易造假的正向信号：
 *   · 文件在 ≠ 实现（0 字节 / 只 exit(0)）
 *   · 体积够 ≠ 达标（舍入把 3069 显示成 3.0KB）
 *   · 名字出现过 ≠ 注册（只在注释里提到）
 *   · 记录条数够 ≠ 真触发（字段不全 / 状态 unknown / 记忆全是模板）
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 反例 1：3069 字节（差 3 字节不到 3KB）四舍五入成 3.0KB → 必须判空壳 ──
  //   这是 size-guard F11 同类 bug：显示取整污染判定。判定必须用原始字节。
  const s1 = judgeSize(3069);
  T('反例 · 3069 字节（显示 3.0KB 但实际不到 3KB）→ 判为空壳',
    s1.ok === false && s1.kb === 3.0, 'ok=' + s1.ok + ' kb=' + s1.kb);

  // ── 反例 2：体积 10KB、但可执行体只剩一句 process.exit(0) → 判空壳 ──
  //   「脚本存在但退出码永远是 0」的假绿：它永远绿，因为什么都没验。
  const r2 = judgeInPlace({ code: [['a.mjs', 'A']] }, {
    resolve: (rel) => 'X/' + rel, exists: () => true, sizeOf: () => 10 * 1024,
    readText: () => '#!/usr/bin/env node\n// 只写了注释，没实现\nprocess.exit(0);\n',
  });
  T('反例 · 10KB 但只有 process.exit(0) → 判空壳（退出码永远 0 不算实现）',
    r2.length === 1 && r2[0].ok === false && /空壳/.test(r2[0].detail), JSON.stringify(r2));

  // ── 反例 3：守卫名只出现在注释里 → 不算已注册 ──
  //   子串匹配时代，一句「以后加 派单哨兵」就能冒充注册。要求 name: '派单哨兵' 才算。
  const g3 = judgeGuards(['派单哨兵'], '// TODO: 以后加 派单哨兵 这个守卫\nconst x = 1;\n');
  T('反例 · 守卫名只在注释里出现 → 不算已注册',
    g3.ok === false && g3.hits.length === 0, JSON.stringify(g3));

  // ── 反例 4：台账 100 条，但其中 1 条 state=unknown → 报不明状态 ──
  const rows4 = Array.from({ length: 100 }, (_, i) => ({
    from: 'a', to: 'b', subject: 's', verify: 'v', createdAt: '2026-11-15', state: i === 0 ? 'unknown' : 'closed',
  }));
  const v4 = judgeLedger({ dispatches: rows4 });
  T('反例 · 台账 100 条但有 state=unknown → 存在不明状态',
    v4.some((x) => !x.ok && x.msg === '存在不明状态'), JSON.stringify(v4.filter((x) => !x.ok)));

  // ── 反例 5：台账 100 条但 3 条缺 verify 字段 → 报字段不全 ──
  //   「条数达标」不等于「记录完整」：凑够 50 条垃圾照样能骗过条数闸。
  const rows5 = rows4.map((r, i) => (i < 3 ? { ...r, verify: '' } : r));
  const v5 = judgeLedger({ dispatches: rows5 });
  T('反例 · 条数够但 3 条缺 verify → 报字段不全',
    v5.some((x) => !x.ok && /字段不全/.test(x.msg)), JSON.stringify(v5.filter((x) => !x.ok)));

  // ── 反例 6：164 个记忆文件全是模板（<2000 字）→ 文件在但内容假 ──
  //   「记忆文件存在 ✓」不能被当成「记忆机制在真实触发」：模板骨架不算记忆。
  const mem6 = Array.from({ length: 164 }, (_, i) => ({ name: 'm' + i + '.md', len: 300 }));
  const v6 = judgeMemory(mem6);
  T('反例 · 164 个记忆文件但全是模板 → 只认「存在」不算数（实质内容必须红）',
    v6.some((x) => x.ok && x.msg === '记忆文件存在') && v6.some((x) => !x.ok && x.msg === '记忆全是模板'),
    JSON.stringify(v6));

  // ── 反例 7：L2 进化回测 passed < cases → 报不合规 ──
  const v7 = judgeEvolution({ evolutions: [
    { id: 'E1', level: 'L2', target: 't', trigger: '够长的触发原因描述', backtest: { cases: 3, passed: 2 } },
  ] });
  T('反例 · L2 回测 3 例只过 2 例 → 报不合规',
    v7.verdicts.some((x) => !x.ok && /L2 回测不合规/.test(x.msg)), JSON.stringify(v7.verdicts.filter((x) => !x.ok)));

  // ── 反例 8：L3 身份进化没有人工确认 → 报未经确认 ──
  const v8 = judgeEvolution({ evolutions: [
    { id: 'E2', level: 'L3', target: 't', trigger: '够长的触发原因描述', humanConfirmed: false },
  ] });
  T('反例 · L3 未人工确认 → 报未经确认',
    v8.verdicts.some((x) => !x.ok && /L3 未经人工确认/.test(x.msg)), JSON.stringify(v8.verdicts.filter((x) => !x.ok)));

  // ── 反例 9：健康度有 9 个场景但 evidenceIds 全空 → 无证据回指 = 自评 ──
  const h9 = { scenes: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['s' + i, { evidenceIds: [] }])) };
  const v9 = judgeHealth(h9);
  T('反例 · 健康度场景都在但 evidenceIds 全空 → 报无证据回指',
    v9.some((x) => !x.ok && /没有证据回指/.test(x.msg)), JSON.stringify(v9));

  // ── 反例 10：基线只有 1 个字段 → 回滚无锚点，报过少 ──
  const v10 = judgeBaseline({ only: 1 });
  T('反例 · 基线只有 1 个字段 → 报内容过少（回滚没锚点）',
    v10.length === 1 && v10[0].ok === false, JSON.stringify(v10));

  // ── 正例：全套合格 → 必须全绿（防止自检把判据写成「永远红」）──
  const goodRows = Array.from({ length: 60 }, () => ({ from: 'a', to: 'b', subject: 's', verify: 'v', createdAt: '2026-11-15', state: 'closed' }));
  const allGreen = [
    ...judgeInPlace({ code: [['a.mjs', 'A']] }, { resolve: (r) => r, exists: () => true, sizeOf: () => 20 * 1024, readText: () => 'const real = 1;\nfunction work(){ return real; }\n' }),
    ...judgeLedger({ dispatches: goodRows }),
    ...judgeMemory([{ name: 'a.md', len: 5000 }]),
    ...judgeEvolution({ evolutions: [{ id: 'E3', level: 'L2', target: 't', trigger: '够长的触发原因描述', backtest: { cases: 4, passed: 4 } }] }).verdicts,
    ...judgeBaseline({ a: 1, b: 2 }),
    ...judgeHealth({ scenes: { s0: { evidenceIds: ['x'] } } }),
    judgeGuards(['派单哨兵'], "name: '派单哨兵', file: '派单哨兵.mjs',"),
    judgeRef('派单.mjs', 'AUDIT includes 派单.mjs somewhere', ''),
  ];
  T('正例 · 全套输入合格 → 全绿（判据不是「永远红」）',
    allGreen.every((x) => x.ok), JSON.stringify(allGreen.filter((x) => !x.ok)));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  执行逻辑四机制验证 · 自检（1 正例 + 10 反例，反例全打「假绿」）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

// ════════════════════════════════════════════════════════════════════
//  正式验证（只在直接运行时执行）
// ════════════════════════════════════════════════════════════════════

let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('    ✓ ' + n + (d ? '  ' + d : '')); };
const no = (n, d) => { fail++; console.log('    ✗ ' + n + (d ? '  ' + d : '')); };
const emit = (verdicts) => { for (const v of verdicts) (v.ok ? ok(v.msg, v.detail) : no(v.msg, v.detail)); };

/** 体检脚本里是否注册了这个工具（= 它在流水线里真被执行） */
const AUDIT = read(path.join(TOOLS, '机制体检.mjs'));

/** C 层通用：台账里有没有真实记录 */
function ledger() {
  const p = path.join(SHARED, '派单台账.json');
  if (!has(p)) return null;
  try { return JSON.parse(read(p)); } catch { return null; }
}

const MECHANISMS = [
  // ─────────────────────────────────────────────
  {
    id: '①',
    name: '调度',
    what: '中枢判断该派给谁、派出去、收回来，全程留痕',
    code: [
      ['工具/派单.mjs', '派单执行'],
      ['工具/派单闭环验证.mjs', '闭环校验'],
      ['工具/管线调度.mjs', '管线编排'],
      ['工具/中枢调度卡.mjs', '调度卡生成'],
    ],
    guards: ['派单哨兵', '派单验证生成', '派单闭环'],
  },
  {
    id: '②',
    name: '记忆',
    what: '三层记忆（注入/私有/共享）：写得进、召回得到、能评估',
    code: [
      ['工具/记忆写入.mjs', '写入协议'],
      ['工具/记忆注入.mjs', '注入'],
      ['工具/记忆召回哨兵.mjs', '召回校验'],
      ['工具/记忆评估.mjs', '效果评估'],
    ],
    guards: ['记忆哨兵', '记忆召回哨兵', '记忆注入效果体检', '记忆写入协议'],
  },
  {
    id: '③',
    name: '自愈',
    what: '发现退化 → 登记进化 → 可回滚。没有回滚锚点的"自愈"是赌博',
    code: [
      ['工具/后置审查.mjs', '事后审查抓失信'],
      ['工具/回滚.mjs', '回滚'],
      ['工具/进化.mjs', '进化登记'],
      ['工具/进化账本.mjs', '进化台账维护'],
    ],
    guards: ['进化哨兵', '回滚', '体检进化'],
  },
  {
    id: '④',
    name: '验证',
    what: '判断「做完了」的独立机制：不看自称，看证据',
    code: [
      ['工具/验证闸.mjs', '验收闸门'],
      ['工具/机制体检.mjs', '106 项机制守卫'],
      ['工具/破坏性验证.mjs', '反例验证（证明守卫真的会红）'],
      ['工具/验收反例验证.mjs', '验收器的反例'],
    ],
    guards: ['验证闸', '破坏性验证'],
  },
];

console.log('  执行逻辑四机制：每件验「在位 + 可运行 + 真实触发」三层');
console.log('');

for (const M of MECHANISMS) {
  console.log('  ── ' + M.id + ' ' + M.name + '：' + M.what);

  // ── A 机制在位 ──
  emit(judgeInPlace(M));

  // ── B 可运行（被体检注册）──
  const g = judgeGuards(M.guards, AUDIT);
  g.ok ? ok('已注册为体检守卫', g.hits.join(' / ')) : no('守卫注册不全', '缺: ' + g.missing.join(','));
  const src = M.code.map(([rel]) => (has(path.join(WB, rel)) ? read(path.join(WB, rel)) : '')).join('\n');
  const ref = judgeRef(path.basename(M.code[0][0]), AUDIT, src);
  ref.ok ? ok('体检脚本直接引用', path.basename(M.code[0][0])) : no('体检脚本未引用', path.basename(M.code[0][0]));

  console.log('');
}

// ── C 真实触发记录（每个机制各自的实证）──
console.log('  ── 真实触发记录 ──');

// ① 调度：派单台账
emit(judgeLedger(ledger()));

// ② 记忆：场景记忆有实质内容（不是模板骨架）
const memRoot = path.join(WB, '数据/.dsh/场景记忆');
if (has(memRoot)) {
  const memFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      memFiles.push({ name: e.name, len: read(p).length });
    }
  };
  walk(memRoot);
  emit(judgeMemory(memFiles));
} else {
  no('记忆目录不存在');
}

// ③④ 自愈 + 验证：进化台账
let evo = null;
if (has(path.join(SHARED, '进化台账.json'))) {
  evo = JSON.parse(read(path.join(SHARED, '进化台账.json')));
}
const evoR = judgeEvolution(evo);
emit(evoR.verdicts);
if (evoR.levels !== null) {
  console.log('    · 等级分布：' + evoR.levels + '（L1 记忆 / L2 技能 / L3 身份）');
}

// 回滚锚点
let base = null;
if (has(path.join(SHARED, '基线.json'))) base = JSON.parse(read(path.join(SHARED, '基线.json')));
emit(judgeBaseline(base));

// 验证：健康度按场景算出来（说明验证不是自评，是从台账重算）
let health = null;
if (has(path.join(SHARED, '健康度.json'))) health = JSON.parse(read(path.join(SHARED, '健康度.json')));
emit(judgeHealth(health));

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// ── D 真跑 —— 真的执行机制，不是「文件在不在、注释里有没有这个词」──
//
// 【为什么必须加这一层（2026-11-15 独立复审第三轮的攻击）】
// 复审指出：R6 的 PASS 全靠「文件存在 + 体积 + 正则 + 台账条数」，**从没执行过四机制**。
// 这是对的。文件存在 ≠ 机制能用；台账有记录 ≠ 机制此刻真的跑得动。
//
// 所以这一层**真的启动子进程去执行**，只看退出码：
//   · 记忆机制：跑 store.mjs --selftest，必须 exit 0（真的把记忆逻辑跑一遍）
//   · 验证机制：跑 evolve.mjs verify，必须 exit 0（真的把台账校验一遍）
//   · 门禁机制：跑 size-guard.mjs，必须 exit 0（真的把体积红线扫一遍）
//
// 这三条是**动态证据**，和上面 C 层的静态痕迹不是一回事。
console.log('');
console.log('  ── D 真跑（执行，不是看文件）──');

function runOnce(label, cmd, args) {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: 'ignore', timeout: 180000 });
    ok(label + '：真跑通过（exit 0）');
  } catch (e) {
    const code = e.status === undefined ? '?' : e.status;
    // 退出码 3=WARN / 2=UNKNOWN 也是「跑起来了」——但它们**不是通过**
    no(label + '：真跑未通过', 'exit=' + code);
  }
}

runOnce('记忆机制 store.mjs --selftest', process.execPath, [path.join(REPO_ROOT, 'tools/memory/store.mjs'), '--selftest']);
runOnce('验证机制 evolve verify', process.execPath, [path.join(REPO_ROOT, 'tools/evolve/evolve.mjs'), 'verify']);
runOnce('门禁机制 size-guard', process.execPath, [path.join(REPO_ROOT, 'tools/quality/size-guard.mjs')]);


console.log('');
console.log('  ──────────────────────────────────────────────');
console.log('    断言：通过 ' + pass + '  失败 ' + fail);
console.log('  ──────────────────────────────────────────────');
process.exit(fail ? 1 : 0);
