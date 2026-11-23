#!/usr/bin/env node
/**
 * L4 · 改进闭环：假设登记 + 台账（只追加）
 *
 * 做→观测→假设→改→验→记
 *
 * C4 无基线不登记 / C2 样本不足只 UNKNOWN / C5 自验自降 partial
 *
 * 用法：register|record|attest|dispute|reopen|list|verify|--selftest
 */
import fs from 'node:fs';
import { checkIndependence, countIndependentClosed } from './independence.mjs';
import os from 'node:os';
import { makeReopen } from './reopen.mjs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
let LEDGER = path.join(REPO, 'research/改进台账.json');
const REAL_LEDGER = LEDGER;

/** 读取台账（不存在就初始化） */
export function load() {
  if (!fs.existsSync(LEDGER)) {
    return { what: '改进台账 —— 只追加', rule: '每条必须有基线值、前后度量、样本量、验证方', at: new Date().toISOString(), entries: [] };
  }
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); }
  catch (e) { throw new Error('台账损坏：' + e.message); }
}

function save(j) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(j, null, 2) + '\n', 'utf8');
}

/** 下一条 id */
function nextId(j) {
  const n = j.entries.length + 1;
  return 'H-' + String(n).padStart(4, '0');
}

/**
 * 登记假设 —— C4：无基线不许登记
 *
 * 返回 { ok, id?, reasons[] }，不抛异常（便于自检）
 */
export function register({ obs, hypo, metric, baseline, expect, criterion, by }) {
  const reasons = [];

  // C4：没有基线值不许登记
  if (baseline === undefined || baseline === null || String(baseline).trim() === '') {
    reasons.push('C4 违反：没有基线值 —— 没有基线就无法证明「改进了」，只会有事后叙事');
  }
  if (baseline !== undefined && baseline !== null && String(baseline).trim() !== '' && !/^-?\d+(\.\d+)?$/.test(String(baseline).trim())) {
    reasons.push('基线值必须是数字（实测得到），不能是描述：' + baseline);
  }

  // 假设必须可判定
  if (!criterion || !String(criterion).trim()) {
    reasons.push('没有判据 —— 不知道什么算「支持假设」，结论就无法反驳');
  }
  if (!observeIsConcrete(obs)) {
    reasons.push('观测太笼统 —— 必须是具体现象（含数字或可定位的事实）');
  }
  if (!hypo || String(hypo).trim().length < 8) {
    reasons.push('假设太短或为空 —— 写不成可检验的命题');
  }
  if (!metric || !String(metric).trim()) {
    reasons.push('没有指标 —— 无法度量');
  }
  if (expect !== 'up' && expect !== 'down') {
    reasons.push('expect 必须是 up 或 down（预期方向）');
  }

  if (reasons.length) return { ok: false, reasons };

  const j = load();
  const id = nextId(j);
  const entry = {
    id,
    at: new Date().toISOString(),
    by: by || 'unknown',
    obs: String(obs).trim(),
    hypo: String(hypo).trim(),
    metric: String(metric).trim(),
    baseline: Number(baseline),
    expect,
    criterion: String(criterion).trim(),
    status: 'open',
    after: null,
    samples: null,
    verdict: null,
    verifier: null,
    independent: null,
  };
  j.entries.push(entry);
  save(j);
  return { ok: true, id, entry };
}

function observeIsConcrete(obs) {
  if (!obs || String(obs).trim().length < 6) return false;
  // 含数字，或含可定位的事实（路径/引号/反引号）
  return /\d/.test(obs) || /[`"']/.test(obs) || /\//.test(obs);
}

/**
 * 记录结论 —— C2（样本量）+ C5（独立验证）
 */
export function record({ id, after, samples, verdict, verifier }) {
  const reasons = [];
  const j = load();
  const e = j.entries.find((x) => x.id === id);
  if (!e) return { ok: false, reasons: ['找不到 ' + id] };
  // 【修】原来一律说「已结案」—— 但 partial/refuted 不是结案。如实报状态。
  if (e.status !== 'open') return { ok: false, reasons: [id + ' 已记录（status=' + e.status + '），只追加，不许改历史'] };

  if (after === undefined || after === null || String(after).trim() === '') reasons.push('没有改后值');
  if (!/^-?\d+(\.\d+)?$/.test(String(after).trim())) reasons.push('改后值必须是数字');
  const n = Number(samples);
  if (!Number.isFinite(n) || n <= 0) reasons.push('没有样本量 —— 无样本的结论是印象');

  const C2_MIN = 8;
  let state = 'closed';

  // 【2026-11-15 修 · 机制自身的 bug】
  // 原来样本 <8 直接 return ok:false ⇒ **拒绝记录**。
  // 但 C2 的原话是「结论只能是 UNKNOWN」—— 应当**记为 UNKNOWN**，而不是拒写。
  // 拒写的后果：台账永远留一个 open 条目 ⇒ 台账完整性问题 ⇒ 整条链跟着红。
  // 四态哲学是「判不了就说判不了」，不是「判不了就什么都不说」。
  if (n > 0 && n < C2_MIN) {
    state = 'unknown';
    reasons.push('C2：样本量 ' + n + ' < ' + C2_MIN + ' ⇒ 记为 UNKNOWN，不下判定（不是拒写）');
  }

  if (state !== 'unknown' && verifier && e.by && verifier === e.by) {
    // C5：自己验自己 ⇒ 降为「部分」（但已判 unknown 的保持 unknown，不许被降级掩盖）
    state = 'partial';
    reasons.push('C5：验证方与实现方是同一个（' + verifier + '）⇒ 状态降为「部分」，不算独立验证');
  }

  // C2 已判 unknown 时允许 verdict=unknown（否则小样本条目永远无法落账）
  if (state !== 'unknown' && verdict !== 'keep' && verdict !== 'revert') reasons.push('verdict 必须是 keep 或 revert');
  if (reasons.filter((r) => !r.startsWith('C5') && !r.startsWith('C2')).length) return { ok: false, reasons };

  // 已被 C2 判为 unknown ⇒ 直接以 unknown 落账，不许被后面的 keep/revert 覆盖成 closed
  if (state === 'unknown') {
    // 【2026-11-15 修】原来这里直接 delta:0 返回 —— 把**度量值丢掉了**。
    // 但「判定未知」和「度量未知」是两件事：
    //   · 样本不足 ⇒ **判定** unknown（C2 正确行为）
    //   · 但 222→215 这个事实是量到的，Δ 就是 -7，不该因为判定不了就记成 0
    // 后果：所有小样本改进都显示 Δ 0，读起来像「没改进」，C4「改进有度量」被架空。
    const a0 = Number(after);
    const base0 = Number(e.baseline);
    e.after = Number.isFinite(a0) ? a0 : String(after);
    e.samples = n;
    e.verdict = 'unknown';
    e.verifier = verifier || 'unknown';
    e.independent = !(verifier && e.by && verifier === e.by);
    e.status = 'unknown';
    // 度量照记，只是不给 verdict
    e.delta = Number.isFinite(a0) && Number.isFinite(base0) ? Math.round((a0 - base0) * 1000) / 1000 : null;
    e.moved = Number.isFinite(a0) && Number.isFinite(base0)
      ? (e.expect === 'up' ? a0 > base0 : a0 < base0)
      : null;
    e.notes = reasons;
    save(j);
    return { ok: true, id, state: 'unknown', delta: e.delta, moved: e.moved, notes: reasons };
  }

  const a = Number(after);
  const moved = e.expect === 'up' ? a > e.baseline : a < e.baseline;

  e.after = a;
  e.samples = n;
  e.verdict = verdict;
  e.verifier = verifier || 'unknown';
  e.independent = !(verifier && e.by && verifier === e.by);
  e.status = state;
  e.moved = moved;
  e.delta = Math.round((a - e.baseline) * 1000) / 1000;
  e.closedAt = new Date().toISOString();
  e.notes = reasons;   // 保留降级理由
  save(j);

  return { ok: true, id, state, moved, delta: e.delta, notes: reasons };
}

/**
 * 记录独立验证的驳回 —— 不改历史，只追加一条指向原条目的驳回记录。
 * 实例：H-0001 结案为 partial（自己验自己），独立方判 refuted（4 条可复现反驳）。
 * ⛔ 换个签名就说「现在算独立」是禁止的 —— 详见 tools/evolve/INDEPENDENT-REVIEW.md 第四节。
 */

/**
 * 独立确认（attest）—— 事后由非实现方确认某轮改进真的成立
 *
 * 无此入口则只能改 JSON = 伪造留痕
 *
 * 要求：evidence>=20 · 验证方!=实现方 · 非 unknown · samples>=8 · attacks 非空 · 不可覆盖
 */
export function attest({ id, verifier, evidence, attacks }) {
  const reasons = [];
  if (!id) return { ok: false, reasons: ['必须指定 id'] };
  if (!verifier || !String(verifier).trim()) return { ok: false, reasons: ['必须指定 verifier（谁独立确认的）'] };
  if (!evidence || String(evidence).trim().length < 20) {
    return { ok: false, reasons: ['必须写 evidence（至少 20 字）—— 没有证据的确认等于没确认'] };
  }

  const j = load();
  const e = (j.entries || []).find((x) => x.id === id);
  if (!e) return { ok: false, reasons: ['找不到 ' + id] };

  // C5：验证方必须不是实现方
  if (e.by && verifier === e.by) {
    return { ok: false, reasons: ['C5：验证方与实现方是同一个（' + verifier + '）⇒ 不算独立确认'] };
  }
  // 已经独立确认过：不许覆盖（只追加，保证留痕可信）
  if (e.attestedBy) {
    return { ok: false, reasons: [id + ' 已有独立确认（' + e.attestedBy + '），不许覆盖'] };
  }
  // 必须有基线值 + 前后度量 + 样本量，否则这轮改进本身不成立
  if (e.baseline === null || e.baseline === undefined) reasons.push('缺基线值 —— 没有基线的改进无法判断是否变好');
  if (e.after === null || e.after === undefined) reasons.push('缺改后值');
  if (!Number.isFinite(Number(e.samples)) || Number(e.samples) <= 0) reasons.push('缺样本量');
  if (reasons.length) return { ok: false, reasons };

  // 【2026-11-16 修·T1 独立复审抓到的硬伤】
  // 原实现直接 e.status = 'closed'，不检查 verdict 与样本量，
  // 导致 3 条 verdict='unknown' 的记录被洗成 closed
  // （H-0031/H-0034/H-0035，attestUpgradedFrom 正是 "unknown"）。
  //
  // 这直接违反 C2「UNKNOWN 永不并入通过」——而且是**机制层面**的违反，
  // 不是人为改写。attest 本是为了防「直接改 JSON 伪造留痕」（见 L224 的设计动机），
  // 却自己成了洗白 UNKNOWN 的后门。
  // 协议要求：attacks 不能为空（INDEPENDENT-REVIEW.md:93「attacks 为空 ⇒ 验证无效」）
  const atk = Array.isArray(attacks) ? attacks : null;
  if (!atk || atk.length === 0) {
    return {
      ok: false,
      reasons: ['协议:93 attacks 为空 ⇒ 验证无效'],
    };
  }

  if (String(e.verdict || '').toLowerCase() === 'unknown') {
    return {
      ok: false,
      reasons: ['C2：verdict 是 unknown ⇒ 结论本身是「判不了」，不许 attest 成 closed。'
        + '要么补够样本重测，要么保持 unknown'],
    };
  }
  const ATTEST_MIN_SAMPLES = 8;
  if (Number(e.samples) < ATTEST_MIN_SAMPLES) {
    return {
      ok: false,
      reasons: ['C2：样本量 ' + e.samples + ' < ' + ATTEST_MIN_SAMPLES
        + ' ⇒ 统计上判不了，不许 attest 成 closed'],
    };
  }

  const prev = e.status;
  e.status = 'closed';
  e.independent = true;
  e.verifier = verifier;
  e.attestedBy = verifier;
  e.attestAt = new Date().toISOString();
  e.attestEvidence = String(evidence).trim();
  e.attacks = (attacks || []).map((a) => ({
    surface: String(a.surface || '').slice(0, 200),
    method: String(a.method || '').slice(0, 200),
    result: String(a.result || '').slice(0, 200),
  }));
  e.attackCount = e.attacks.length;
  e.attestUpgradedFrom = prev;
  save(j);

  return { ok: true, id, from: prev, to: 'closed', verifier, evidence: e.attestEvidence };
}

export function dispute({ id, verdict, reasons, report, attacks }) {
  const errs = [];
  if (!id) errs.push('没有指向哪一条');
  if (!['refuted', 'unverifiable'].includes(verdict)) {
    errs.push('verdict 必须是 refuted 或 unverifiable（not-refuted 请用 record 正常结案）');
  }
  if (!reasons || !String(reasons).trim()) errs.push('没有驳回理由');
  if (!report) errs.push('没有验证报告路径（无报告的验证不算验证）');
  if (attacks !== undefined && Number(attacks) <= 0) {
    errs.push('攻击清单为空 ⇒ 按协议这次验证无效');
  }

  const j = load();
  const target = j.entries.find((e) => e.id === id);
  if (!target) errs.push('找不到 ' + id);
  // 重复驳回 = 已经有指向它的驳回记录（或它自己就是驳回记录）
  const alreadyDisputed = target && (target.disputedBy
    || j.entries.some((e) => e.target === id && ['refuted', 'unverifiable'].includes(e.status)));
  if (target && target.status === 'refuted') errs.push(id + ' 本身就是一条驳回记录');
  else if (alreadyDisputed) errs.push(id + ' 已被驳回过了（' + (target.disputedBy || '见台账') + '）');
  if (errs.length) return { ok: false, reasons: errs };

  const newId = nextId(j);
  const entry = {
    id: newId,
    at: new Date().toISOString(),
    by: 'independent-verifier',
    target: id,
    obs: '独立验证 ' + id + ' 的结论',
    hypo: '（本条是驳回记录，不是新假设）',
    metric: target.metric,
    baseline: target.baseline,
    expect: target.expect,
    criterion: target.criterion,
    status: verdict,          // 'refuted' | 'unverifiable'
    after: target.after,
    samples: target.samples,
    verdict: verdict,
    verifier: 'independent-verifier',
    independent: true,
    reasons: String(reasons).trim(),
    report,
    attackCount: attacks !== undefined ? Number(attacks) : null,
    closedAt: new Date().toISOString(),
  };
  // 原条目加一个反向指针（只加字段，不改它的结论）
  target.disputedBy = newId;
  j.entries.push(entry);
  save(j);
  return { ok: true, id: newId, entry };
}



/** 台账完整性（不是「有没有改进」，是「记录全不全」） */
export function verify() {
  const j = load();
  const issues = [];

  /** 有效状态：被驳回的条目，有效状态是 refuted（不要求改原记录 —— 只追加） */
  const effectiveStatus = (e) => (e.disputedBy ? 'refuted' : e.status);

  for (const e of j.entries) {
    const st = effectiveStatus(e);
    if (st === 'open') { issues.push(e.id + ' 未结案'); continue; }

    if (st === 'refuted') {
      // 被驳回：本身是驳回记录则查它自己的字段；
      // 被驳回的原条目则查指向它的那条驳回记录是否完整
      const rec = e.status === 'refuted' && e.target ? e : j.entries.find((x) => x.id === e.disputedBy);
      if (!rec) { issues.push(e.id + ' 被驳回但找不到驳回记录'); continue; }
      if (!rec.report) issues.push(rec.id + ' 驳回但没写报告路径');
      if (!rec.reasons) issues.push(rec.id + ' 驳回但没写理由');
      if (rec.attackCount !== null && rec.attackCount !== undefined && rec.attackCount <= 0) {
        issues.push(rec.id + ' 驳回但攻击清单为空（按协议验证无效）');
      }
      continue;
    }

    if (e.baseline === null || e.after === null) issues.push(e.id + ' 缺前后值');
    if (!e.samples) issues.push(e.id + ' 缺样本量');
    if (!e.verifier || e.verifier === 'unknown') issues.push(e.id + ' 缺验证方');
    const bad = checkIndependence(e, effectiveStatus);   // 规则与理由见 independence.mjs
    if (bad) issues.push(bad);
  }

  // 统计
  const stat = { closed: 0, partial: 0, refuted: 0 };
  for (const e of j.entries) {
    const st = effectiveStatus(e);
    if (st === 'closed' && e.independent === true && !checkIndependence(e, effectiveStatus)) stat.closed++;
    else if (st === 'partial') stat.partial++;
    else if (st === 'refuted') stat.refuted++;
  }

  stat.independentClosed = countIndependentClosed(j.entries, effectiveStatus).independent;
  return { ok: issues.length === 0, total: j.entries.length, issues, stat };
}

// ── 自检：三条硬约束的反例 ──
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const ATK = [{ surface: '协议攻面', method: '读码+突变', result: '未推翻' }];

  // 自检用 pid 唯一临时台账（并发会踩踏真实台账）
  const TMPL = path.join(os.tmpdir(), 'evolve-st-' + process.pid + '.json');
  LEDGER = TMPL;
  const BAK = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : null;
  try {
    // 用临时台账
    if (BAK) fs.unlinkSync(LEDGER);

      const r1 = register({ obs: 'recall 是 0.750', hypo: '补反例能提升召回', metric: 'recall', baseline: '', expect: 'up', criterion: 'recall=1' });
    T('C4 · 无基线 → 拒绝登记', !r1.ok && r1.reasons.some((x) => /C4/.test(x)), JSON.stringify(r1.reasons));

    // 反例 2：基线不是数字 → 拒绝
    const r2 = register({ obs: 'recall 很低', hypo: '补反例能提升召回', metric: 'recall', baseline: '挺低的', expect: 'up', criterion: 'recall=1' });
    T('基线非数字 → 拒绝', !r2.ok, JSON.stringify(r2.reasons));

    // 反例 3：无判据 → 拒绝
    const r3 = register({ obs: 'recall 是 0.750', hypo: '补反例能提升召回', metric: 'recall', baseline: '0.75', expect: 'up', criterion: '' });
    T('无判据 → 拒绝', !r3.ok, JSON.stringify(r3.reasons));

    // 反例 4：观测太笼统 → 拒绝
    const r4 = register({ obs: '不太好', hypo: '补反例能提升召回', metric: 'recall', baseline: '0.75', expect: 'up', criterion: 'recall=1' });
    T('观测笼统 → 拒绝', !r4.ok, JSON.stringify(r4.reasons));

    // 正例：合法登记
    const ok1 = register({ obs: 'recall 实测 0.750（6/8）', hypo: '补 expectOutput 判据后 recall 会到 1.0', metric: 'recall', baseline: '0.75', expect: 'up', criterion: 'recall=1.000 且两次一致', by: 'lead' });
    T('合法假设 → 登记成功', ok1.ok && /^H-\d{4}$/.test(ok1.id || ''), JSON.stringify(ok1));

    // 反例 5（C2）：样本不足 → 只能是 UNKNOWN
    const r5 = record({ id: ok1.id, after: '1.0', samples: 3, verdict: 'keep', verifier: 'lead' });
    T('C2 · 样本量 3 < 8 → 记为 UNKNOWN（不是拒写）', r5.ok && r5.state === 'unknown', JSON.stringify(r5.state));

    // 反例 6（C5）：自己验自己 → 降级为部分
    const okB = register({ obs: 'tools/b.mjs 的 z 判据写反导致 w 漏报', hypo: '改正后 w 能报出', metric: 'b 通过条数', baseline: '1', expect: 'up', criterion: '2/2', by: 'lead' });
  const r6 = record({ id: okB.id, after: '1.0', samples: 8, verdict: 'keep', verifier: 'lead' });
    T('C5 · 验证方==实现方 → 状态降为部分', r6.ok && r6.state === 'partial', JSON.stringify(r6));

    // 正例：独立验证方 → closed
    // （先补一条独立的）
    const ok2 = register({ obs: 'recall 实测 0.750', hypo: '补判据后到 1.0', metric: 'recall', baseline: '0.75', expect: 'up', criterion: 'recall=1', by: 'lead' });
    const r7 = record({ id: ok2.id, after: '1.0', samples: 8, verdict: 'keep', verifier: 'independent-reviewer' });
    T('独立验证方 → 结案 closed', r7.ok && r7.state === 'closed' && r7.moved === true, JSON.stringify(r7));

    // 反例 7：已结案不许改（只追加）
    const r8 = record({ id: ok2.id, after: '0.5', samples: 8, verdict: 'revert', verifier: 'x' });
    T('已结案 → 拒绝改历史（只追加）', !r8.ok, JSON.stringify(r8.reasons));

    // ── 驳回（独立验证）的五个反例 ──
    // 为什么要这组：2026-11-15 真的用到了 —— 独立验证方判 H-0001 refuted。
    // 「换个签名就说现在算独立验证」必须被机制挡住。

    // 反例 8：无报告 → 拒绝（无报告的验证不算验证）
    const d1 = dispute({ id: ok2.id, verdict: 'refuted', reasons: '因为我不同意', report: '' });
    T('驳回 · 无报告路径 → 拒绝', !d1.ok && d1.reasons.some((x) => /报告/.test(x)), JSON.stringify(d1.reasons));

    // 反例 9：无理由 → 拒绝
    const d2 = dispute({ id: ok2.id, verdict: 'refuted', reasons: '', report: 'research/x.md' });
    T('驳回 · 无理由 → 拒绝', !d2.ok, JSON.stringify(d2.reasons));

    // 反例 10：攻击清单为 0 → 拒绝（空攻击 = 验证无效）
    const d3 = dispute({ id: ok2.id, verdict: 'refuted', reasons: '有报告', report: 'research/x.md', attacks: 0 });
    T('驳回 · 攻击清单 0 条 → 拒绝', !d3.ok && d3.reasons.some((x) => /攻击/.test(x)), JSON.stringify(d3.reasons));

    // 反例 11：verdict 只能是 refuted / unverifiable（not-refuted 走正常结案）
    const d4 = dispute({ id: ok2.id, verdict: 'not-refuted', reasons: '有报告', report: 'research/x.md' });
    T('驳回 · verdict=not-refuted → 拒绝（应走 record）', !d4.ok, JSON.stringify(d4.reasons));

    // 正例：合法驳回
    const d5 = dispute({ id: ok2.id, verdict: 'refuted', reasons: '独立验证方给出 4 条可复现反驳', report: 'research/独立验证-H0001.md', attacks: 19 });
    T('合法驳回 → 成功且原条目加反向指针',
      d5.ok && d5.entry.verdict === 'refuted' && d5.entry.attackCount === 19,
      JSON.stringify(d5));

    // 反例 12：同一条不许重复驳回
    const d6 = dispute({ id: ok2.id, verdict: 'refuted', reasons: '再驳一次', report: 'research/x.md', attacks: 1 });
    T('同一条 · 重复驳回 → 拒绝', !d6.ok, JSON.stringify(d6.reasons));

    // ── attest（事后独立确认）—— 这条机制**产出 T1 的数字**，它自己必须先有反例 ──
  {
    const okA = register({
      obs: 'tools/none.mjs 的判据把 a 写成了 b，导致 c 漏报',
      hypo: '改成 a 后 c 能被报出来',
      metric: 'none 自检通过条数', baseline: '1', expect: 'up',
      criterion: '2/2 通过', by: 'alice',
    });
    T('准备 · 登记一条给 attest 用', okA.ok, JSON.stringify(okA));
    if (okA.ok) {
      record({ id: okA.id, after: '2', samples: 10, verdict: 'keep', verifier: 'alice' });
      const EV = '独立复核：读代码确认真实比较，实跑 2/2 通过，反例确实能变红，不是装饰';
      const a1 = attest({ id: okA.id, verifier: 'bob', evidence: '短', attacks: ATK });
      T('attest · 证据太短 → 拒（没有证据的确认等于没确认）',
        !a1.ok && a1.reasons.some((x) => /evidence/.test(x)), JSON.stringify(a1.reasons));
      const a2 = attest({ id: okA.id, verifier: 'alice', evidence: EV, attacks: ATK });
      T('attest · C5 验证方==实现方 → 拒', !a2.ok && a2.reasons.some((x) => /C5/.test(x)), JSON.stringify(a2.reasons));
      const a3 = attest({ id: 'H-9999', verifier: 'bob', evidence: EV, attacks: ATK });
      T('attest · 找不到 id → 拒', !a3.ok && a3.reasons.some((x) => /找不到/.test(x)), JSON.stringify(a3.reasons));
      const a4 = attest({ id: okA.id, verifier: 'bob', evidence: EV, attacks: ATK });
      T('attest · 合法确认 → closed', a4.ok && a4.to === 'closed', JSON.stringify(a4));
      const a5 = attest({ id: okA.id, verifier: 'carol', evidence: EV + '另一段用于覆盖测试', attacks: ATK });
      T('attest · 已有确认不许覆盖（只追加）', !a5.ok && a5.reasons.some((x) => /不许覆盖/.test(x)), JSON.stringify(a5.reasons));
    }
  }

  // 台账完整性检查
    const v = verify();
    T('台账完整性检查可跑', typeof v.ok === 'boolean', JSON.stringify(v.issues));
    // ── 反例：小样本条目必须仍记录真实 Δ（不许记成 0）──
    // 2026-11-15：原来 state==='unknown' 分支直接 delta:0 返回，把度量丢了。
    // 「判定未知」和「度量未知」是两件事 —— 这条钉住这个区别。
    {
      const rr = register({
        obs: 'i18n 审计 CJK 硬编码 222 行（src/web-ui/src/locales 基线）',
        hypo: '清掉 NeuronScene 的 7 行后应降到 215',
        metric: 'cjk-lines', baseline: '222', expect: 'down',
        criterion: '降到 215', by: 'selftest-impl',
      });
      if (rr && rr.ok) {
        const rec = record({ id: rr.id, after: '215', samples: 2, verdict: 'keep', verifier: 'selftest-verify' });
        T('反例 · 小样本判 unknown 但 Δ 必须仍为 -7（不许丢度量）',
          rec && rec.ok && rec.state === 'unknown' && rec.delta === -7,
          JSON.stringify({ state: rec && rec.state, delta: rec && rec.delta }));
        T('反例 · 小样本 moved 必须为 true（222→215 确实是下降）',
          rec && rec.moved === true, JSON.stringify({ moved: rec && rec.moved }));
      } else {
        T('反例 · 小样本判 unknown 但 Δ 必须仍为 -7（不许丢度量）', false, 'register failed');
        T('反例 · 小样本 moved 必须为 true（222→215 确实是下降）', false, 'register failed');
      }
    }



  // 协议:93 attacks 为空 ⇒ 验证无效

  const okP = register({ obs: 'recall 实测 0.750', hypo: '补判据后到 1.0', metric: 'recall',

    baseline: '0.750', expect: 'up', criterion: '到 1.0', by: 'lead' });

  record({ id: okP.id, after: '1.0', samples: 10, verdict: 'keep', verifier: 'lead' });

  const pNo = attest({ id: okP.id, verifier: 'v-x', evidence: '这是一段足够长的独立确认证据文本内容在这里' });

  T('反例 · attest 缺 attacks ⇒ 必须拒绝（协议:93 验证无效）',

    !pNo.ok && pNo.reasons.some((x) => /attacks/.test(x)), JSON.stringify(pNo.reasons));

  const pOk = attest({ id: okP.id, verifier: 'v-y', evidence: '第三段足够长的独立确认证据内容含补充说明文字',

    attacks: [{ surface: '攻面A', method: '读码', result: '未推翻' }] });

  T('正例 · attest 带非空 attacks ⇒ 允许升为 closed',

    pOk.ok && pOk.to === 'closed', JSON.stringify(pOk));

  const rec = load().entries.find((x) => x.id === okP.id);

  T('正例 · attacks 必须落到台账上（attackCount=1）',

    rec && Array.isArray(rec.attacks) && rec.attacks.length === 1 && rec.attackCount === 1,

    JSON.stringify(rec && { a: rec.attacks, n: rec.attackCount }));

  } finally {
    LEDGER = REAL_LEDGER;
    if (fs.existsSync(TMPL)) fs.unlinkSync(TMPL);
  }
  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const arg = (k) => {
    const i = process.argv.indexOf('--' + k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const cmd = process.argv[2];

  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  L4 改进闭环 · 自检（3 正例 + 6 反例）');
    console.log('  ' + '─'.repeat(72));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'register') {
    const r = register({ obs: arg('obs'), hypo: arg('hypo'), metric: arg('metric'), baseline: arg('baseline'), expect: arg('expect'), criterion: arg('criterion'), by: arg('by') });
    if (!r.ok) {
      console.log('');
      console.log('  ❌ 登记被拒 —— 下列硬约束不满足：');
      for (const x of r.reasons) console.log('      · ' + x);
      console.log('');
      process.exit(1);
    }
    console.log('');
    console.log('  ✓ 登记 ' + r.id);
    console.log('      观测   ' + r.entry.obs);
    console.log('      假设   ' + r.entry.hypo);
    console.log('      指标   ' + r.entry.metric + '  基线 ' + r.entry.baseline + '  预期 ' + r.entry.expect);
    console.log('      判据   ' + r.entry.criterion);
    console.log('');
    process.exit(0);
  }

  if (cmd === 'record') {
    const r = record({ id: arg('id'), after: arg('after'), samples: arg('samples'), verdict: arg('verdict'), verifier: arg('verifier') });
    if (!r.ok) {
      console.log('');
      console.log('  ❌ 记录被拒：');
      for (const x of r.reasons) console.log('      · ' + x);
      console.log('');
      process.exit(1);
    }
    console.log('');
    console.log('  ✓ ' + r.id + ' 结案 · 状态 ' + r.state + ' · Δ ' + (r.delta > 0 ? '+' : '') + r.delta
      + ' · ' + (r.moved ? '方向符合预期' : '方向不符预期'));
    for (const n of r.notes) console.log('      ⚠ ' + n);
    console.log('');
    process.exit(0);
  }

  if (cmd === 'attest') {
    let atkArg = [];
  try { atkArg = JSON.parse(arg('attacks') || '[]'); } catch { atkArg = []; }
  const r = attest({ id: arg('id'), verifier: arg('verifier'), evidence: arg('evidence'), attacks: atkArg });
    if (!r.ok) {
      console.log('');
      console.log('  ❌ 独立确认被拒：');
      for (const x of r.reasons) console.log('      · ' + x);
      console.log('');
      process.exit(1);
    }
    console.log('');
    console.log('  ✓ ' + r.id + ' 独立确认 · ' + r.from + ' → closed · 确认方 ' + r.verifier);
    console.log('    证据: ' + r.evidence.slice(0, 100));
    console.log('');
    process.exit(0);
  }

  const reopen = makeReopen({ load, save });
  if (cmd === 'reopen') {
    const r = reopen({ id: arg('id'), why: arg('why'), by: arg('by') || 'lead' });
    console.log(r.ok ? '\n  ✓ ' + r.id + ' 重开 · unknown → open\n' : '\n  ❌ 重开被拒：\n'
      + r.reasons.map((x) => '      · ' + x).join('\n') + '\n');
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'dispute') {
    const r = dispute({ id: arg('id'), verdict: arg('verdict'), reasons: arg('reasons'), report: arg('report'), attacks: arg('attacks') });
    if (!r.ok) {
      console.log('');
      console.log('  ❌ 驳回记录被拒：');
      for (const x of r.reasons) console.log('      · ' + x);
      console.log('');
      process.exit(1);
    }
    console.log('');
    console.log('  ✓ ' + r.id + ' 驳回 ' + r.entry.target + ' · 判定 ' + r.entry.verdict);
    console.log('      攻击清单 ' + (r.entry.attackCount ?? '未记') + ' 条 · 报告 ' + r.entry.report);
    console.log('');
    process.exit(0);
  }

  if (cmd === 'list') {
    const j = load();
    /**
     * 【2026-11-15 修 · 第二轮复审 A8】
     * 原来用 e.status 直接展示，于是：
     *   H-0001（status=partial + disputedBy=H-0004）显示成「部分」而不是「被驳回」
     *   H-0004（status=refuted，是驳回记录）显示成「已结案」
     * 和 verify 里「被驳回 2」自相矛盾 —— 展示层不诚实。
     * 现在统一用 effectiveStatus（与 verify 同一口径）。
     */
    const effectiveStatus = (e) => (e.disputedBy ? 'refuted' : e.status);
    const labelOf = (e) => {
      const st = effectiveStatus(e);
      if (e.target) return '驳回记录(' + e.target + ')';     // 驳回记录本身
      if (st === 'open') return '进行中';
      if (st === 'partial') return '部分';
      if (st === 'refuted') return '被驳回' + (e.disputedBy ? '(' + e.disputedBy + ')' : '');
      if (st === 'unverifiable') return '无法验证';
      return '已结案';
    };
    console.log('');
    console.log('  改进台账（只追加）· ' + j.entries.length + ' 条');
    console.log('  ' + '─'.repeat(78));
    for (const e of j.entries) {
      console.log('  ' + e.id + '  [' + labelOf(e) + ']  ' + e.metric + '  ' + e.baseline + ' → ' + (e.after ?? '?')
        + (e.delta != null ? '  (Δ' + (e.delta > 0 ? '+' : '') + e.delta + ')' : '')
        + '  验证方 ' + (e.verifier || '—'));
      console.log('        ' + (e.target ? '驳回 ' + e.target + '：' + String(e.reasons || '').slice(0, 60) : e.hypo.slice(0, 78)));
      if (e.notes && e.notes.length) for (const n of e.notes) console.log('        ⚠ ' + n.slice(0, 76));
    }
    console.log('');
    process.exit(0);
  }

  if (cmd === 'verify') {
    const v = verify();
    console.log('');
    console.log('  ' + (v.ok ? '✅' : '❌') + ' 台账完整性 · ' + v.total + ' 条 · ' + v.issues.length + ' 个问题');
    if (v.stat) {
      console.log('      独立验证结案 ' + v.stat.closed + ' · 自己验证(partial) ' + v.stat.partial + ' · 被驳回 ' + v.stat.refuted);
    }
    for (const i of v.issues) console.log('      · ' + i);
    console.log('');
    process.exit(v.ok ? 0 : 1);
  }

  console.error('用法: evolve.mjs register|record|list|verify|--selftest');
  process.exit(2);
}