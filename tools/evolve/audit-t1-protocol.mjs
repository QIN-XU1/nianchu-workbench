#!/usr/bin/env node
/**
 * T1 协议合规性审计 —— 按项目**自己的**独立验证协议重算 T1
 *
 * ── 为什么需要它 ────────────────────────────────────────
 * 2026-11-16 一个独立 agent 复审 T1，判定 refuted。四条硬伤里最重的一条：
 *
 *   `tools/evolve/INDEPENDENT-REVIEW.md:22` 明写
 *     「独立验证方的产出里如果没有任何攻击记录，这次验证无效。」
 *   同文件 :93 再强调
 *     「`attacks` 为空 ⇒ 验证无效」
 *
 *   而台账里 12 条 closed **全部没有** `attacks` / `report` 字段。
 *
 * ⇒ **按项目自己的协议，这 12 次验证全部无效。**
 *
 * 这个脚本把「按协议算」和「按裸 status 算」两个口径并列出来，
 * 让人一眼看出差距 —— 而不是选一个对自己有利的报。
 *
 * ── 口径定义（从协议与代码里抄的，不是我编的）────────────────
 *   裸口径      status === 'closed'
 *   有效口径    再加：无 disputedBy（evolve.mjs:329 effectiveStatus）
 *   协议口径    再加：有非空 attacks（INDEPENDENT-REVIEW.md:93）
 *   严格口径    再加：samples >= 8 且 verdict === 'keep'（C2 规则）
 *
 * ── 四态 ────────────────────────────────────────────────
 *   PASS     协议口径 >= 10
 *   WARN     3 <= 协议口径 < 10
 *   FAIL     协议口径 < 3
 *   UNKNOWN  台账读不出来
 *
 * 用法：node tools/evolve/audit-t1-protocol.mjs [--selftest] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const LEDGER = path.join(REPO, 'research/改进台账.json');
const T1_MIN = 10;
const T1_INDEP = 3;
const MIN_SAMPLES = 8;

/**
 * 纯函数：给定条目数组，按四个口径分别统计
 * @param entries 台账条目
 */
export function tally(entries) {
  const out = { raw: 0, effective: 0, protocol: 0, strict: 0, total: 0 };
  const detail = [];
  out.total = entries.length;
  out.external = 0;   // 【2026-11-17 加】外部独立口径：attacks 来自与实现方不同的实体
  for (const e of entries) {
    if (e.status !== 'closed') continue;
    out.raw++;
    const disputed = !!e.disputedBy;
    const hasAttacks = Array.isArray(e.attacks) && e.attacks.length > 0;
    const samplesOk = Number(e.samples) >= MIN_SAMPLES;
    const verdictOk = String(e.verdict || '').toLowerCase() !== 'unknown';

    if (!disputed) out.effective++;
    if (!disputed && hasAttacks) out.protocol++;
    if (!disputed && hasAttacks && samplesOk && verdictOk) out.strict++;

    // 【2026-11-17 加】外部独立：攻击发起方必须 ≠ 实现方，且记录不自述「同属一个 lead」
    const impl = String(e.by || e.implementer || 'lead').toLowerCase();
    const atkFrom = String(e.attacksFrom || e.attestedBy || e.verifier || '').toLowerCase();
    const selfAdmitsSameLead = /同属一个\s*lead|same lead|实现方与验证方是同一个/i.test(
      String(e.independenceNote || '') + ' ' + ((e.notes || []).join ? (e.notes || []).join(' ') : String(e.notes || '')));
    const externalOk = atkFrom && atkFrom !== impl && !selfAdmitsSameLead;
    if (!disputed && hasAttacks && externalOk && samplesOk && verdictOk) out.external++;

    detail.push({
      id: e.id,
      verdict: e.verdict,
      samples: e.samples,
      disputed: disputed ? e.disputedBy : null,
      attacks: Array.isArray(e.attacks) ? e.attacks.length : 0,
      countsAsProtocol: !disputed && hasAttacks,
      countsAsStrict: !disputed && hasAttacks && samplesOk && verdictOk,
      problems: [
        disputed ? 'disputedBy=' + e.disputedBy : null,
        !hasAttacks ? '缺 attacks（协议要求，为空则验证无效）' : null,
        !samplesOk ? 'samples=' + e.samples + ' < ' + MIN_SAMPLES : null,
        !verdictOk ? 'verdict=' + e.verdict + '（判不了却标 closed）' : null,
      ].filter(Boolean),
    });
  }
  return { ...out, detail };
}

/** 四态判定 —— 只看协议口径，不看裸口径 */
export function verdictOf(t, min = T1_MIN, minIndep = T1_INDEP) {
  if (t.protocol >= min && t.protocol >= minIndep) {
    return { state: 'PASS', why: '协议口径 ' + t.protocol + ' >= ' + min };
  }
  if (t.protocol >= minIndep) {
    return {
      state: 'WARN',
      why: '协议口径 ' + t.protocol + ' 条（需 >= ' + min + '）'
        + '；裸口径 ' + t.raw + ' 条里有 ' + (t.raw - t.protocol) + ' 条按协议无效',
    };
  }
  return { state: 'FAIL', why: '协议口径 ' + t.protocol + ' < ' + minIndep };
}

/** 自检 —— 2 正例 + 5 反例 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const mk = (o) => ({ id: 'x', status: 'closed', verdict: 'keep', samples: 10, ...o });

  // 正例：完全合规
  const good = [mk({ id: 'G1', attacks: [{ surface: 's', method: 'm', result: 'r' }] })];
  const tg = tally(good);
  T('正例 · 有 attacks 且无 disputed ⇒ 四个口径都算 1',
    tg.raw === 1 && tg.effective === 1 && tg.protocol === 1 && tg.strict === 1, JSON.stringify(tg));

  // 反例：缺 attacks
  const noAtk = [mk({ id: 'N1' })];
  const tn = tally(noAtk);
  T('反例 · 缺 attacks ⇒ 裸口径算 1 但协议口径必须算 0（协议:93）',
    tn.raw === 1 && tn.protocol === 0, JSON.stringify(tn));

  // 反例：被驳回
  const disp = [mk({ id: 'D1', attacks: [{ surface: 's', method: 'm', result: 'r' }], disputedBy: 'H-9' })];
  const td = tally(disp);
  T('反例 · 有 disputedBy ⇒ 有效口径必须算 0（evolve.mjs:329）',
    td.raw === 1 && td.effective === 0, JSON.stringify(td));

  // 反例：小样本
  const small = [mk({ id: 'S1', samples: 5, attacks: [{ surface: 's', method: 'm', result: 'r' }] })];
  const ts = tally(small);
  T('反例 · samples=5 < 8 ⇒ 严格口径必须算 0（C2 规则）',
    ts.protocol === 1 && ts.strict === 0, JSON.stringify(ts));

  // 反例：unknown 洗成 closed
  const unk = [mk({ id: 'U1', verdict: 'unknown', attacks: [{ surface: 's', method: 'm', result: 'r' }] })];
  const tu = tally(unk);
  T('反例 · verdict=unknown ⇒ 严格口径必须算 0（C2：UNKNOWN 不并入通过）',
    tu.protocol === 1 && tu.strict === 0, JSON.stringify(tu));

  // 反例：空 attacks 数组不算
  const empty = [mk({ id: 'E1', attacks: [] })];
  T('反例 · attacks 是空数组 ⇒ 等同于缺失，协议口径算 0',
    tally(empty).protocol === 0, JSON.stringify(tally(empty)));

  // 四态：协议口径不足 10 必须 WARN 不许 PASS
  const many = Array.from({ length: 12 }, (_, i) => mk({ id: 'M' + i }));
  T('反例 · 12 条裸 closed 但全缺 attacks ⇒ 不许 PASS（协议口径 0 => FAIL）',
    verdictOf(tally(many)).state !== 'PASS', verdictOf(tally(many)).state);

  // 正例：凑够 10 条协议有效 -> PASS
  const ten = Array.from({ length: 10 }, (_, i) =>
    mk({ id: 'P' + i, attacks: [{ surface: 's', method: 'm', result: 'r' }] }));
  T('正例 · 10 条都有 attacks ⇒ 协议口径 10 => PASS',
    verdictOf(tally(ten)).state === 'PASS', verdictOf(tally(ten)).state);

  // ── 【2026-11-17 加】外部独立口径的反例（验证方 v-h0027b 硬伤②）──
  // 协议口径只判 attacks.length>0，从不看谁做的攻击 ⇒ 同 lead 子智能体补个
  // attacks 就能涨 T1。外部独立口径要求 attacksFrom ≠ 实现方，且不自述「同属一个 lead」。
  const A = [{ surface: 's', method: 'm', result: 'r' }];
  T('反例 · attacksFrom === 实现方 ⇒ 外部独立算 0（自己验自己）',
    tally([mk({ id: 'X1', by: 'lead', attacksFrom: 'lead', attacks: A })]).external === 0, '');
  T('反例 · independenceNote 自述「同属一个 lead」⇒ 外部独立算 0',
    tally([mk({ id: 'X2', by: 'lead', attacksFrom: 'v-x', independenceNote: '实体独立性有限（同属一个 lead）', attacks: A })]).external === 0, '');
  const ext1 = tally([mk({ id: 'X3', by: 'lead', attacksFrom: 'v-external', attacks: A })]);
  T('正例 · attacksFrom 是另一个实体 ⇒ 外部独立算 1',
    ext1.external === 1 && ext1.protocol === 1, JSON.stringify(ext1));
  const gap = tally([mk({ id: 'X4', by: 'lead', attacksFrom: 'v-same', independenceNote: '同属一个 lead', attacks: A })]);
  T('反例 · 协议口径 1 但外部独立 0（补 attacks 不等于外部独立）',
    gap.protocol === 1 && gap.external === 0, JSON.stringify(gap));
  T('反例 · 无 attacksFrom ⇒ 外部独立算 0（不许默认）',
    tally([mk({ id: 'X5', by: 'lead', attacks: A })]).external === 0, '');

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = /[\\/]audit-t1-protocol\.mjs$/.test(process.argv[1] || '');

if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  T1 协议合规性审计 · 自检');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (isMain) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  } catch (e) {
    console.log('  ❔ 台账读不出来: ' + e.message);
    process.exit(2);
  }
  const entries = j.entries || j;
  const t = tally(entries);
  const v = verdictOf(t);

  console.log('');
  console.log('  T1 协议合规性 —— 按项目自己的协议重算（不是按裸 status）');
  console.log('  ' + '='.repeat(76));
  console.log('  协议依据：');
  console.log('    tools/evolve/INDEPENDENT-REVIEW.md:22  「没有任何攻击记录 ⇒ 这次验证无效」');
  console.log('    tools/evolve/INDEPENDENT-REVIEW.md:93  「attacks 为空 ⇒ 验证无效」');
  console.log('    tools/evolve/evolve.mjs:329            disputedBy ⇒ effectiveStatus=refuted');
  console.log('    tools/evolve/evolve.mjs:143-146        samples<8 ⇒ 只能 UNKNOWN');
  console.log('');
  console.log('  台账总条数 ' + t.total);
  console.log('  ' + '-'.repeat(76));
  console.log('  裸口径    status===closed                      ' + String(t.raw).padStart(3) + ' 条');
  console.log('  有效口径  + 无 disputedBy                       ' + String(t.effective).padStart(3) + ' 条');
  console.log('  协议口径  + 有非空 attacks                      ' + String(t.protocol).padStart(3) + ' 条');
  console.log('  严格口径  + samples>=8 且 verdict!=unknown       ' + String(t.strict).padStart(3) + ' 条');
  console.log('  外部独立  + attacks 来自非实现方实体          ' + String(t.external || 0).padStart(3));
  console.log('  ' + '-'.repeat(76));
  console.log('  T1 要求 >= ' + T1_MIN + ' 条按协议有效，且 >= ' + T1_INDEP + ' 条独立验证');
  console.log('');
  console.log('  四态: ' + v.state + ' —— ' + v.why);
  console.log('');

  const bad = t.detail.filter((d) => !d.countsAsProtocol);
  if (bad.length) {
    console.log('  按协议不算数的 ' + bad.length + ' 条：');
    for (const d of bad) {
      console.log('    ' + String(d.id).padEnd(8) + d.problems.join(' · '));
    }
    console.log('');
  }

  const op = path.join(REPO, 'evidence/evolve/t1-protocol.json');
  fs.mkdirSync(path.dirname(op), { recursive: true });
  fs.writeFileSync(op, JSON.stringify({
    at: new Date().toISOString(),
    counts: { raw: t.raw, effective: t.effective, protocol: t.protocol, strict: t.strict },
    total: t.total,
    verdict: v,
    detail: t.detail,
  }, null, 2) + '\n', 'utf8');
  console.log('  → ' + path.relative(REPO, op));
  console.log('');

  process.exit(v.state === 'PASS' ? 0 : v.state === 'WARN' ? 3 : 1);
}
