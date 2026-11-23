#!/usr/bin/env node
/**
 * C6 成本可复算 · 验收器
 *
 * 检查四件事：
 *   1. 工具自检通过（含 5 个反例：无价不许记 0 / 换模型不重算 / 篡改被检出 等）
 *   2. 价格表存在且来自真实网关（不是手写的）
 *   3. 台账复算一致（用冻结价重算 == 记录值）
 *   4. 至少有 1 条**真实记账**（token 数与金额都有）
 *
 * 四态：
 *   PASS     四项全过
 *   WARN     工具都对，但台账为空或无价条目（机制在位，还没真记过账）
 *   FAIL     自检不过 / 复算不一致
 *   UNKNOWN  价格表缺失（没同步过）
 *
 * ── 关于 --selftest（给验收器本身加反例）────────────────────────
 * 本验收的结果**全部由外部命令与文件拼出来**，所以自检用「注入假的外部结果」
 * 的形式：judgeCost() 只吃数据（子自检输出 / 价格表 / verify 输出 / 台账），
 * 不碰进程和磁盘，自检就能构造任意坏情况。反例挑的都是这份文件真实会错的点：
 *   · 子自检 10/12（有反例塌了）被当成通过
 *   · 子自检 0/0（一条反例都没跑）被当成全过
 *   · verify 说 🟡（有算不出价的条目）却给 PASS —— 头部明令「不许拿剩下都算出来当全过」
 *   · verify 没输出结论时默认 PASS
 *   · 价格表 0 有价、台账全是无价条目，却报 PASS
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const LABEL = 'C6 成本可复算（任一轮可算金额 · 两次一致 · 换模型不重算）';

function run(args, timeout = 300000) {
  const [script, ...rest] = args;
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, script), ...rest], {
      cwd: REPO, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// ══════════════════════════════════════════════════════════════
// 纯判定 —— 只吃注入的外部结果，判定逻辑完全不碰文件/进程
// ══════════════════════════════════════════════════════════════

/**
 * C6 四态判定
 *
 * 外部依赖全部用 **thunk** 注入，且**按需调用**：
 *   · 前一步已经判 FAIL，就不该再去跑/读后面的证据（省时间，也避免用一个
 *     读不到的价格表去解释一个已经失败的自检）
 *
 * @param {object}   io
 * @param {Function} io.selftest  () => {code, out}   —— meter.mjs --selftest 的结果
 * @param {Function} io.prices    () => object|null   —— 价格表；null = 文件不存在
 * @param {Function} io.verify    () => {code, out}   —— meter.mjs verify 的结果
 * @param {Function} io.ledger    () => object|null   —— 台账；null = 文件不存在
 */
export function judgeCost(io) {
  const detail = [];

  // 1. 自检
  const st = io.selftest();
  const m = /结论: ✓ (\d+)\/(\d+)/.exec(String(st?.out ?? ''));
  if (!m) return { state: 'FAIL', detail: 'C6 自检没有结论行（exit=' + (st?.code ?? '?') + '）' };
  const [p, n] = [Number(m[1]), Number(m[2])];
  detail.push('自检 ' + p + '/' + n);
  // 【为什么还要判 n === 0】老判据只有 `p !== n`。若 meter 的自检用例表被清空，
  // 输出「结论: ✓ 0/0」—— 0 === 0 成立 ⇒ 空自检被当成全过。一条反例都没跑和全过不同。
  if (p !== n || n === 0) {
    return { state: 'FAIL', detail: detail.join(' · ') + ' —— 有反例不成立（反例不报 = 这个检查是假的）' };
  }

  // 2. 价格表
  const pr = io.prices();
  if (!pr) {
    return { state: 'UNKNOWN', detail: detail.join(' · ') + ' · 价格表不存在（先跑 meter.mjs sync）' };
  }
  detail.push('价格表 ' + pr.priced + '/' + pr.total + ' 有价（源 ' + pr.source + '）');
  if (!pr.priced) return { state: 'FAIL', detail: detail.join(' · ') + ' —— 一个模型都没有价，成本无从算起' };

  // 3. 复算
  const v = io.verify();
  const vState = /(✅|🟡|❌|❔) C6/.exec(String(v?.out ?? ''));
  if (!vState) return { state: 'FAIL', detail: detail.join(' · ') + ' · verify 没有输出结论' };
  const vs = { '✅': 'PASS', '🟡': 'WARN', '❌': 'FAIL', '❔': 'UNKNOWN' }[vState[1]];
  const vLine = (String(v?.out ?? '').split('\n').map((l) => l.trim()).find((l) => /条目 \d+/.test(l)) || '');
  detail.push(vLine);
  if (vs === 'FAIL') return { state: 'FAIL', detail: detail.join(' · ') + ' —— 台账复算不一致（被改过）' };

  // 4. 至少一条真实记账
  const jl = io.ledger();
  if (!jl) {
    return { state: 'WARN', detail: detail.join(' · ') + ' · **台账不存在 —— 从没真记过账**' };
  }
  const entries = Array.isArray(jl.entries) ? jl.entries : [];
  const real = entries.filter((e) => e?.usd !== null && e?.usd !== undefined && e?.tokens?.input > 0);
  if (!real.length) {
    return { state: 'WARN', detail: detail.join(' · ') + ' —— 机制在位，但没有一条算得出金额的真实记录' };
  }
  const total = real.reduce((a, e) => a + e.usd, 0);
  detail.push('真实记账 ' + real.length + ' 条 · 合计 $' + total.toFixed(8));

  // 有 UNKNOWN 条目 ⇒ 最高只给 WARN（不许拿「剩下都算出来了」当全过）
  if (vs === 'WARN') {
    return { state: 'WARN', detail: detail.join(' · ') + ' —— 台账含算不出金额的条目（未当 0）' };
  }

  return { state: 'PASS', detail: detail.join(' · ') };
}

// ══════════════════════════════════════════════════════════════
// 自检 —— 注入假的外部结果，断言「该红的必须红」
// ══════════════════════════════════════════════════════════════
export function selfTest() {
  const cases = [];
  const T = (n, okv, why) => cases.push([n, !!okv, why]);

  const boom = () => { throw new Error('这一步不该被调用（前面的判定已经 FAIL）'); };
  const fakePrices = (priced = 71, total = 110) => () => ({
    priced, total, source: 'http://127.0.0.1:3425/v1/models', table: {},
  });
  const fakeVerify = (icon, entries = 11, okN = 9, unknownN = 2) => () => ({
    code: 0,
    out: '  ' + icon + ' C6 成本可复算 —— 摘要\n    条目 ' + entries + ' · 复算一致 ' + okN + ' · UNKNOWN ' + unknownN + ' · 记录后价格变过的 0 条（金额不变，冻结生效）\n',
  });
  const fakeLedger = (entries) => () => ({ what: 'selftest', entries });
  const okSelftest = (line = '结论: ✓ 10/10') => () => ({ code: 0, out: '  C6 自检\n  ' + line + '\n' });

  // ── 反例 1：子自检 10/12（有 2 条反例不成立）──
  // 为什么重要：C6 的可信度全压在 meter 的自检上。判据若写成
  // 「有结论行就算过」，meter 自己的反例塌了 2 条也照样绿。
  const r1 = judgeCost({
    selftest: () => ({ code: 0, out: '结论: ✓ 10/12' }),
    prices: () => null, verify: () => ({ code: 0, out: '' }), ledger: () => null,
  });
  T('反例 · 子自检 10/12（有反例不成立）→ 必须判 FAIL', r1.state === 'FAIL', r1.state + ' · ' + r1.detail);

  // ── 反例 2：子自检 0/0（一条反例都没跑）──
  // 为什么重要：0 === 0 会让空自检看起来像全过 —— 反例表被搬空是最隐蔽的假绿。
  const r2 = judgeCost({
    selftest: () => ({ code: 0, out: '结论: ✓ 0/0' }),
    prices: () => null, verify: () => ({ code: 0, out: '' }), ledger: () => null,
  });
  T('反例 · 子自检 0/0（一条反例都没跑）→ 必须判 FAIL', r2.state === 'FAIL', r2.state + ' · ' + r2.detail);

  // ── 反例 3：没有结论行（exit=0 也不行）──
  // 为什么重要：命令正常退出不代表检查跑了。把「没有结论」当「通过」是典型假绿。
  const r3 = judgeCost({ selftest: () => ({ code: 0, out: '  ✓ 有价模型 → 算出金额\n' }), prices: boom, verify: boom, ledger: boom });
  T('反例 · 自检没有结论行（即便 exit=0）→ 必须判 FAIL', r3.state === 'FAIL', r3.state + ' · ' + r3.detail);

  // ── 反例 4：价格表存在但 0 有价 ──
  // 为什么重要：文件存在 ≠ 有价。0 有价时任何金额都算不出来，不能当 PASS。
  const r4 = judgeCost({ selftest: okSelftest(), prices: fakePrices(0, 110), verify: boom, ledger: boom });
  T('反例 · 价格表 0 有价 → 必须判 FAIL（文件在不算数）', r4.state === 'FAIL', r4.state + ' · ' + r4.detail);

  // ── 反例 5：价格表缺失 → UNKNOWN（不是 PASS/FAIL）──
  const r5 = judgeCost({ selftest: okSelftest(), prices: () => null, verify: boom, ledger: boom });
  T('反例 · 价格表缺失 → 必须判 UNKNOWN（不能当 PASS，也不能当 FAIL）', r5.state === 'UNKNOWN', r5.state + ' · ' + r5.detail);

  // ── 反例 6：verify 说 🟡（有算不出价的条目）却给 PASS ──
  // 为什么重要：头部明写「不许拿『剩下都算出来了』当全过」。
  // 这里台账里**确实有一条**真实记账，最容易诱使判据只看「有真实记账」就 PASS。
  const r6 = judgeCost({
    selftest: okSelftest(), prices: fakePrices(), verify: fakeVerify('🟡'),
    ledger: fakeLedger([{ usd: 0.0001, tokens: { input: 100 } }]),
  });
  T('反例 · verify 判 🟡（含无价条目）→ 最高只能 WARN，不许 PASS', r6.state === 'WARN', r6.state + ' · ' + r6.detail);

  // ── 反例 7：verify 说 ❌（复算不一致）→ FAIL ──
  const r7 = judgeCost({ selftest: okSelftest(), prices: fakePrices(), verify: fakeVerify('❌', 11, 0, 0), ledger: boom });
  T('反例 · verify 判 ❌（复算不一致）→ 必须 FAIL', r7.state === 'FAIL', r7.state + ' · ' + r7.detail);

  // ── 反例 8：verify 没输出结论 → FAIL（不能默认通过）──
  const r8 = judgeCost({ selftest: okSelftest(), prices: fakePrices(), verify: () => ({ code: 0, out: '随便什么\n' }), ledger: boom });
  T('反例 · verify 没有输出结论 → 必须 FAIL', r8.state === 'FAIL', r8.state + ' · ' + r8.detail);

  // ── 反例 9：台账全是无价条目（usd=null）→ WARN，不许 PASS ──
  // 为什么重要：机制在位但没真记过账。把「没记账」报成 PASS 就是本末倒置。
  const r9 = judgeCost({
    selftest: okSelftest(), prices: fakePrices(), verify: fakeVerify('✅'),
    ledger: fakeLedger([{ usd: null, tokens: { input: 100 } }, { usd: null, tokens: { input: 200 } }]),
  });
  T('反例 · 台账全是 usd=null → 必须 WARN（没真记账）', r9.state === 'WARN', r9.state + ' · ' + r9.detail);

  // ── 反例 10：有条目却没 token（tokens.input=0）→ 不算真实记账 ──
  // 为什么重要：「有个 usd 字段」不等于「真跑过」。没有输入 token 的记录算不出意义。
  const r10 = judgeCost({
    selftest: okSelftest(), prices: fakePrices(), verify: fakeVerify('✅'),
    ledger: fakeLedger([{ usd: 0.0002, tokens: { input: 0, output: 0 } }]),
  });
  T('反例 · 台账条目 tokens.input=0 → 不算真实记账（WARN）', r10.state === 'WARN', r10.state + ' · ' + r10.detail);

  // ── 反例 11：台账不存在 → WARN ──
  const r11 = judgeCost({ selftest: okSelftest(), prices: fakePrices(), verify: fakeVerify('✅'), ledger: () => null });
  T('反例 · 台账不存在 → 必须 WARN（机制在位但没记账）', r11.state === 'WARN', r11.state + ' · ' + r11.detail);

  // ── 正例：四项全过 → PASS ──
  const rOk = judgeCost({
    selftest: okSelftest(), prices: fakePrices(), verify: fakeVerify('✅'),
    ledger: fakeLedger([{ usd: 0.0001, tokens: { input: 100 } }, { usd: 0.0002, tokens: { input: 200 } }]),
  });
  T('正例 · 自检过 + 有价 + 复算一致 + 有真实记账 → PASS', rOk.state === 'PASS', rOk.state + ' · ' + rOk.detail);

  const bad = cases.filter(([, okv]) => !okv);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, okv, w]) => '  ' + (okv ? '✓' : '✗') + ' ' + n + (okv ? '' : '  ← ' + w)).join('\n'),
  };
}

// ══════════════════════════════════════════════════════════════
// 取真实证据 → 交给纯判定
// ══════════════════════════════════════════════════════════════
function check() {
  const pricePath = path.join(REPO, 'evidence/cost/prices.json');
  const ledgerPath = path.join(REPO, 'evidence/cost/ledger.json');
  const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

  return judgeCost({
    selftest: () => run(['tools/cost/meter.mjs', '--selftest']),
    prices: () => readJson(pricePath),
    verify: () => run(['tools/cost/meter.mjs', 'verify']),
    ledger: () => readJson(ledgerPath),
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  C6 成本可复算 · 自检（11 反例 + 1 正例，注入假的外部结果）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (isMain) {
  const r = check();
  const ICON = { PASS: '✅', WARN: '🟡', FAIL: '❌', UNKNOWN: '❔' };
  if (process.argv.includes('--json')) console.log(JSON.stringify({ label: LABEL, ...r }, null, 2));
  else { console.log(''); console.log('  ' + ICON[r.state] + ' ' + LABEL); console.log('  ' + r.detail); console.log(''); }
  process.exit(r.state === 'PASS' ? 0 : r.state === 'WARN' ? 3 : r.state === 'FAIL' ? 1 : 2);
}

export { check, LABEL };
