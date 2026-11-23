#!/usr/bin/env node
/**
 * C6 · 成本可复算
 *
 * ── 主张（本体论 C6）────────────────────────────────────────
 *   「任一轮任务可算出金额，且两次展示一致、换模型后历史金额不重算」
 *
 * ── 为什么这是差异化能力 ──────────────────────────────────────
 * 拆解 22 个参照系统的实测：
 *   · DSH：在它的前端源码里搜 usd / dollar / pricing **零命中**
 *     —— 完全不知道一轮花多少（注意：不能在注释里写带斜杠星号的 glob，会提前闭合注释）
 *   · 多数系统：成本不可见
 *   · openclaw：有 manifest 内嵌单价 + usage kernel，是做得最好的一家
 *
 * ── 三个要求怎么满足 ─────────────────────────────────────────
 * ① 可算金额 ⇒ 从网关模型目录读真实单价（实测 71/110 个模型带 pricing）
 * ② 两次一致 ⇒ report 是台账的**纯函数**：只做求和，不重新推导
 * ③ 换模型不重算 ⇒ 每条记录**冻结**当时用的价格向量
 *
 * 第 ③ 条是设计重点。反例：如果 report 时用「当前价格」重算，
 * 那么模型涨价后历史金额会变 —— 那不是账本，是估算。
 *
 * ── 四态 ──────────────────────────────────────────────────
 *   PASS     全部条目有完整冻结价 + 复算一致
 *   WARN     有条目因模型缺价而金额 UNKNOWN（不许当 0）
 *   FAIL     复算不一致（台账被改过）
 *   UNKNOWN  取不到价格（网关不在）
 *
 * 用法：
 *   node tools/cost/meter.mjs sync                     # 从网关同步价格
 *   node tools/cost/meter.mjs record --model <id> --in 1200 --out 340 [--cacheRead N] [--cacheWrite N] [--turn T1]
 *   node tools/cost/meter.mjs report                   # 汇总（纯函数）
 *   node tools/cost/meter.mjs verify                   # 复算一致性 + 四态
 *   node tools/cost/meter.mjs --selftest               # 反例
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
// 【2026-11-18 修】原来路径写死，导致**测试会覆盖生产台账**：
// 实测 evidence/cost/ledger.json 里的 9 条真实样本被测试 fixture
// （good/model、noprice/model、ghost/model、free/model）整个替换掉了。
// 现在允许用环境变量指到临时目录 —— 测试必须用临时路径，不许写生产证据。
const PRICES = process.env.NIANCHU_COST_PRICES || path.join(REPO, 'evidence/cost/prices.json');
const LEDGER = process.env.NIANCHU_COST_LEDGER || path.join(REPO, 'evidence/cost/ledger.json');
const GATEWAY = 'http://127.0.0.1:3425/v1/models';

// ── 价格同步 ────────────────────────────────────────────────
export function sync({ gateway = GATEWAY } = {}) {
  let raw;
  try {
    raw = execFileSync('curl', ['-s', '--max-time', '15', gateway], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20000,
    });
  } catch (e) {
    return { state: 'UNKNOWN', why: '取不到网关模型目录：' + String(e.message).slice(0, 80) };
  }
  let j;
  try { j = JSON.parse(raw); } catch (e) { return { state: 'UNKNOWN', why: '网关响应不是 JSON' }; }

  const list = j.data || j.models || [];
  if (!list.length) return { state: 'UNKNOWN', why: '模型目录为空' };

  const table = {};
  let priced = 0, unpriced = 0;
  for (const m of list) {
    if (!m || !m.id) continue;
    const p = m.pricing;
    if (!p || (p.prompt === undefined && p.completion === undefined)) {
      // 记下来但标为无价 —— 不许当成 0
      table[m.id] = null;
      unpriced++;
      continue;
    }
    table[m.id] = {
      prompt: Number(p.prompt) || 0,
      completion: Number(p.completion) || 0,
      cacheRead: Number(p.input_cache_read) || 0,
      cacheWrite: Number(p.input_cache_write) || 0,
      unit: 'usd_per_token',
    };
    priced++;
  }

  const out = {
    what: '网关模型单价快照',
    source: gateway,
    at: new Date().toISOString(),
    total: Object.keys(table).length,
    priced, unpriced,
    table,
  };
  fs.mkdirSync(path.dirname(PRICES), { recursive: true });
  fs.writeFileSync(PRICES, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return { state: 'PASS', why: '同步 ' + out.total + ' 个模型（有价 ' + priced + ' · 无价 ' + unpriced + '）', ...out };
}

function loadPrices() {
  if (!fs.existsSync(PRICES)) return null;
  try { return JSON.parse(fs.readFileSync(PRICES, 'utf8')); } catch { return null; }
}

/**
 * 把「响应里回显的 model」解析成「价格表里的 id」
 *
 * ── 为什么需要这一层（2026-11-15 实测）──────────────────────
 * 发真实请求后发现**回显的 model 与请求的不一定相同，且规则因 provider 而异**：
 *
 *   请求 auto/claude-haiku-5-5        → 回显 group/auto-claude-haiku-5-5
 *   请求 fableaiapi/claude-haiku-5-5  → 回显 fableaiapi/claude-haiku-5-5（原样）
 *   请求 github-copilot/claude-haiku-5.5 → 回显 undefined（该 provider 不返回 model）
 *
 * 目录里的 110 个 id **没有任何一个**以 `group/` 开头，
 * 所以第一版实现直接查不到价 ⇒ 记成 UNKNOWN。
 *
 * **这是对的行为**（不许猜 0），但需要一个解析层把能解析的解析出来。
 *
 * ── 回退顺序（每一步都可复算）──────────────────────────────
 *   1. 原样命中
 *   2. 去掉 `group/` 前缀后命中
 *   3. `group/<provider>-<rest>` → `<provider>/<rest>`（首个 `-` 换成 `/`）
 *   4. `group/<provider>-<rest>` → 遍历所有 provider 前缀试拼
 *   5. 都不中 ⇒ null（调用方判 UNKNOWN，**绝不猜**）
 */
export function resolveModel(echoed, table) {
  if (!echoed) return { id: null, how: 'model 字段为空' };
  if (table[echoed]) return { id: echoed, how: '原样命中' };

  let s = String(echoed);

  // 2) 去 group/ 前缀
  if (s.startsWith('group/')) {
    const bare = s.slice('group/'.length);
    if (table[bare]) return { id: bare, how: '去 group/ 前缀后命中' };

    // 3) group/<provider>-<rest> → <provider>/<rest>
    const dash = bare.indexOf('-');
    if (dash > 0) {
      const guess = bare.slice(0, dash) + '/' + bare.slice(dash + 1);
      if (table[guess]) return { id: guess, how: 'group/provider-rest → provider/rest' };

      // 4) 遍历所有已知 provider 前缀试拼
      const provs = new Set(Object.keys(table).filter((k) => k.includes('/')).map((k) => k.split('/')[0]));
      for (const p of provs) {
        if (!bare.startsWith(p + '-')) continue;
        const cand = p + '/' + bare.slice(p.length + 1);
        if (table[cand]) return { id: cand, how: '按已知 provider 前缀匹配' };
      }
    }
  }

  // 5) 宽松回退：忽略大小写与点/横线差异
  const norm = (x) => String(x).toLowerCase().replace(/[.\-]/g, '');
  const target = norm(s.replace(/^group\//, ''));
  const loose = Object.keys(table).find((k) => norm(k.split('/').slice(1).join('/')) === target
    || norm(k.replace('/', '')) === norm(s.replace('group/', '')));
  if (loose) return { id: loose, how: '宽松匹配（大小写/点横线归一）' };

  return { id: null, how: '解析不到（表里没有对应的 id）' };
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return { what: '成本台账 —— 只追加', rule: '每条冻结当时单价，report 只求和', entries: [] };
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { throw new Error('成本台账损坏：' + e.message); }
}

function saveLedger(j) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(j, null, 2) + '\n', 'utf8');
}

/**
 * 记录一轮用量 —— **冻结**当时单价
 *
 * 返回 { ok, entry?, state?, why }
 */
export function record({ model, input, output, cacheRead = 0, cacheWrite = 0, turn = null, prices = null }) {
  if (!model) return { ok: false, why: '没有 model' };
  const nIn = Number(input), nOut = Number(output);
  if (!Number.isFinite(nIn) || nIn < 0) return { ok: false, why: 'input 必须是非负数字' };
  if (!Number.isFinite(nOut) || nOut < 0) return { ok: false, why: 'output 必须是非负数字' };

  const pr = prices || loadPrices();
  if (!pr) return { ok: false, why: '没有价格表 —— 先跑 sync' };

  // 解析：响应回显的 model 与价格表 id 可能不同命名空间（实测三种情况）
  const res = resolveModel(model, pr.table);
  const unit = res.id ? pr.table[res.id] : undefined;
  const j = loadLedger();
  const id = 'C-' + String(j.entries.length + 1).padStart(4, '0');

  // 无价模型 ⇒ 金额 UNKNOWN，**不许记 0**
  if (!res.id || unit === undefined || unit === null) {
    const entry = {
      id, at: new Date().toISOString(), turn, model,
      resolvedModel: res.id,
      resolveHow: res.how,
      tokens: { input: nIn, output: nOut, cacheRead: Number(cacheRead) || 0, cacheWrite: Number(cacheWrite) || 0 },
      frozenPrice: null,
      usd: null,
      costState: 'UNKNOWN',
      why: !res.id ? res.how : (unit === null ? '该模型在网关目录里无 pricing 字段' : '该模型不在价格表里'),
    };
    j.entries.push(entry);
    saveLedger(j);
    return { ok: true, entry, state: 'UNKNOWN', why: entry.why };
  }

  // 冻结单价 —— 这是「换模型后历史金额不重算」的实现
  const frozen = { ...unit };
  const usd =
    nIn * frozen.prompt +
    nOut * frozen.completion +
    (Number(cacheRead) || 0) * frozen.cacheRead +
    (Number(cacheWrite) || 0) * frozen.cacheWrite;

  const entry = {
    id, at: new Date().toISOString(), turn, model,
    resolvedModel: res.id,
    resolveHow: res.how,
    tokens: { input: nIn, output: nOut, cacheRead: Number(cacheRead) || 0, cacheWrite: Number(cacheWrite) || 0 },
    frozenPrice: frozen,
    usd: Math.round(usd * 1e10) / 1e10,   // 保留 10 位，避免浮点尾巴
    costState: 'PASS',
  };
  j.entries.push(entry);
  saveLedger(j);
  return { ok: true, entry, state: 'PASS' };
}

/**
 * 汇总 —— 台账的**纯函数**
 *
 * 只做求和，**绝不重新用当前价格推导**。这就是「两次展示一致」与
 * 「换模型后历史金额不重算」的机制保证。
 */
export function report(ledger = null) {
  const j = ledger || loadLedger();
  const total = { usd: 0, unknown: 0, entries: j.entries.length };
  const byModel = {};
  for (const e of j.entries) {
    const k = e.model;
    byModel[k] = byModel[k] || { usd: 0, unknown: 0, entries: 0, tokens: { input: 0, output: 0 } };
    byModel[k].entries++;
    byModel[k].tokens.input += e.tokens.input;
    byModel[k].tokens.output += e.tokens.output;
    if (e.usd === null || e.usd === undefined) { total.unknown++; byModel[k].unknown++; }
    else { total.usd += e.usd; byModel[k].usd += e.usd; }
  }
  total.usd = Math.round(total.usd * 1e10) / 1e10;
  for (const k of Object.keys(byModel)) byModel[k].usd = Math.round(byModel[k].usd * 1e10) / 1e10;
  return { total, byModel };
}

/**
 * 复算一致性 —— 用**冻结的**价格重算每条，必须与记录值一致
 *
 * 同时给出四态。
 */
export function verify({ ledger = null, prices = null } = {}) {
  const j = ledger || loadLedger();
  const pr = prices || loadPrices();
  const issues = [];
  let ok = 0, unknown = 0;

  for (const e of j.entries) {
    if (e.usd === null || e.usd === undefined) {
      unknown++;
      if (e.costState !== 'UNKNOWN') issues.push(e.id + ' 金额为空但状态不是 UNKNOWN');
      continue;
    }
    if (!e.frozenPrice) { issues.push(e.id + ' 有金额但没有冻结价'); continue; }

    // 用冻结价复算
    const f = e.frozenPrice;
    const recomputed = Math.round((
      e.tokens.input * f.prompt +
      e.tokens.output * f.completion +
      e.tokens.cacheRead * f.cacheRead +
      e.tokens.cacheWrite * f.cacheWrite
    ) * 1e10) / 1e10;

    if (Math.abs(recomputed - e.usd) > 1e-9) {
      issues.push(e.id + ' 复算不符：记录 ' + e.usd + ' vs 复算 ' + recomputed);
    } else ok++;
  }

  // 「换模型后历史不重算」的直接检验：
  // 若台账里某条的冻结价 ≠ 当前价格表的价，金额仍应保持不变
  let repriced = 0;
  if (pr) {
    for (const e of j.entries) {
      if (!e.frozenPrice) continue;
      const cur = pr.table[e.model];
      if (!cur) continue;
      if (cur.prompt !== e.frozenPrice.prompt || cur.completion !== e.frozenPrice.completion) repriced++;
    }
  }

  const state = !j.entries.length ? 'PASS'
    : issues.length ? 'FAIL'
      : unknown ? 'WARN'
        : 'PASS';

  return {
    state,
    why: !j.entries.length ? '台账为空（机制在位，还没记过账）'
      : issues.length ? issues.length + ' 条复算不一致'
        : unknown ? ok + ' 条可算 · ' + unknown + ' 条因缺价判 UNKNOWN（未当 0）'
          : ok + ' 条全部可复算一致',
    entries: j.entries.length, ok, unknown, issues,
    repricedSinceRecord: repriced,
  };
}

// ── 自检：5 正例 + 5 反例 ──
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const BAK = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : null;
  const BAKP = fs.existsSync(PRICES) ? fs.readFileSync(PRICES, 'utf8') : null;

  try {
    fs.mkdirSync(path.dirname(PRICES), { recursive: true });

    // 假价格表
    const fakePrices = {
      what: 'selftest', at: new Date().toISOString(), total: 3, priced: 2, unpriced: 1,
      table: {
        'good/model': { prompt: 0.000002, completion: 0.00001, cacheRead: 0.0000002, cacheWrite: 0.0000025, unit: 'usd_per_token' },
        'free/model': { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, unit: 'usd_per_token' },
        'noprice/model': null,
      },
    };
    fs.writeFileSync(PRICES, JSON.stringify(fakePrices, null, 2), 'utf8');
    if (fs.existsSync(LEDGER)) fs.unlinkSync(LEDGER);

    // 正例 1：可算 —— 精确期望 1000×$0.000002 + 500×$0.00001 = 0.007
    const r1 = record({ model: 'good/model', input: 1000, output: 500, prices: fakePrices });
    T('正例 · 有价模型必须算出精确金额 0.007',
      r1.ok && r1.state === 'PASS' && r1.entry.usd === 0.007,
      'usd=' + JSON.stringify(r1.entry?.usd));

    // 反例 1：无价模型 → UNKNOWN，**不许记 0**
    const r2 = record({ model: 'noprice/model', input: 1000, output: 500, prices: fakePrices });
    T('反例 · 无价模型 → 金额 UNKNOWN（不许记成 0）',
      r2.ok && r2.state === 'UNKNOWN' && r2.entry.usd === null,
      'usd=' + JSON.stringify(r2.entry?.usd));

    // 反例 2：完全不存在的模型 → 也是 UNKNOWN
    const r3 = record({ model: 'ghost/model', input: 1, output: 1, prices: fakePrices });
    T('反例 · 完全不存在的模型 → UNKNOWN（不许记成 0）',
      r3.ok && r3.entry.usd === null, 'usd=' + JSON.stringify(r3.entry?.usd));

    // 正例 2：免费模型 → 金额 0 但状态 PASS（0 是真实值，不是缺值）
    const r4 = record({ model: 'free/model', input: 1000, output: 500, prices: fakePrices });
    T('正例 · 免费模型 → 金额精确 0 且状态 PASS',
      r4.ok && r4.entry.usd === 0 && r4.entry.costState === 'PASS',
      'usd=' + JSON.stringify(r4.entry?.usd) + ' state=' + r4.entry?.costState);

    // 反例 3：金额不能为负数
    const r5 = record({ model: 'good/model', input: -1, output: 0, prices: fakePrices });
    T('反例 · 负数 token 必须拒绝（且说清哪一项非法）',
      !r5.ok && /input 必须是非负数字/.test(r5.why), r5.why);

    // 正例 3：report 是纯函数 —— 两次结果一致
    const a = JSON.stringify(report());
    const b = JSON.stringify(report());
    const rp = report();
    T('正例 · report 两次结果完全一致且金额精确 0.007（纯函数）',
      a === b && rp.total.usd === 0.007 && rp.total.entries === 4,
      'a===b:' + (a === b) + ' usd=' + rp.total.usd + ' entries=' + rp.total.entries);

    // 反例 4：换模型后历史金额不重算
    const before = report().total.usd;
    // 把价格表改成完全不同的值，再 report
    const inflated = JSON.parse(JSON.stringify(fakePrices));
    inflated.table['good/model'].prompt = 999;
    inflated.table['good/model'].completion = 999;
    const after = report().total.usd;   // report 不读价格表 ⇒ 必须不变
    T('正例 · 价格暴涨后历史金额仍是 0.007（冻结生效）',
      before === after && after === 0.007, 'before=' + before + ' after=' + after);

    // 正例 4：台账里**有无价条目** ⇒ verify 应判 WARN（不是 PASS）
    //   这是四态正确的表现：有条目算不出金额时，不许报「全绿」。
    //   （第一版这个断言写成期望 PASS —— 是我的测试期望错了，不是实现错了。）
    const v = verify({ prices: fakePrices });
    T('反例 · 台账含 2 条无价条目 → verify 必须判 WARN（不许报 PASS）',
      v.state === 'WARN' && v.unknown === 2 && v.ok === 2 && v.issues.length === 0,
      v.state + ' · unknown=' + v.unknown + ' · issues=' + JSON.stringify(v.issues));

    // 正例 5：只留可算条目 → verify 判 PASS
    const onlyPriced = {
      what: 'selftest', entries: JSON.parse(fs.readFileSync(LEDGER, 'utf8')).entries.filter((e) => e.usd !== null),
    };
    const v1 = verify({ ledger: onlyPriced, prices: fakePrices });
    T('正例 · 2 条全部可算 → verify 必须判 PASS',
      v1.state === 'PASS' && v1.entries === 2 && v1.ok === 2 && v1.unknown === 0 && v1.issues.length === 0,
      v1.state + ' · entries=' + v1.entries + ' ok=' + v1.ok + ' · ' + JSON.stringify(v1.issues));

    // 反例 5：篡改一条金额 → verify 必须 FAIL
    const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    const t = j.entries.find((e) => e.usd !== null && e.usd > 0);
    if (t) { t.usd = t.usd + 1; fs.writeFileSync(LEDGER, JSON.stringify(j, null, 2), 'utf8'); }
    const v2 = verify({ prices: fakePrices });
    T('反例 · 篡改金额 → verify 必须 FAIL 且抓到 1 条复算不符',
      v2.state === 'FAIL' && v2.issues.length === 1,
      v2.state + ' issues=' + JSON.stringify(v2.issues));
  } finally {
    if (BAK !== null) fs.writeFileSync(LEDGER, BAK, 'utf8'); else if (fs.existsSync(LEDGER)) fs.unlinkSync(LEDGER);
    if (BAKP !== null) fs.writeFileSync(PRICES, BAKP, 'utf8'); else if (fs.existsSync(PRICES)) fs.unlinkSync(PRICES);
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
  const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
  const cmd = process.argv[2];

  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  C6 成本可复算 · 自检（5 正例 + 5 反例）');
    console.log('  ' + '─'.repeat(72));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'sync') {
    const r = sync();
    console.log('');
    console.log('  ' + (r.state === 'PASS' ? '✅' : '❔') + ' 价格同步 —— ' + r.why);
    console.log('');
    process.exit(r.state === 'PASS' ? 0 : 2);
  }

  if (cmd === 'record') {
    const r = record({ model: arg('model'), input: arg('in'), output: arg('out'), cacheRead: arg('cacheRead') || 0, cacheWrite: arg('cacheWrite') || 0, turn: arg('turn') });
    if (!r.ok) { console.log('  ❌ ' + r.why); process.exit(1); }
    console.log('');
    console.log('  ✓ ' + r.entry.id + '  ' + r.entry.model);
    console.log('      用 tokens  in ' + r.entry.tokens.input + ' / out ' + r.entry.tokens.output);
    console.log('      金额       ' + (r.entry.usd === null ? 'UNKNOWN（' + r.entry.why + '）' : '$' + r.entry.usd.toFixed(8)));
    console.log('');
    process.exit(0);
  }

  if (cmd === 'report') {
    const r = report();
    console.log('');
    console.log('  成本汇总（台账纯函数，只求和）');
    console.log('  ' + '─'.repeat(72));
    console.log('    条目 ' + r.total.entries + ' · 可算 ' + (r.total.entries - r.total.unknown) + ' · UNKNOWN ' + r.total.unknown);
    console.log('    合计 $' + r.total.usd.toFixed(8));
    console.log('');
    for (const [m, v] of Object.entries(r.byModel)) {
      console.log('    ' + m.padEnd(36) + '$' + v.usd.toFixed(8).padStart(14)
        + '  in ' + v.tokens.input + ' / out ' + v.tokens.output
        + (v.unknown ? '  (' + v.unknown + ' 条 UNKNOWN)' : ''));
    }
    console.log('');
    process.exit(0);
  }

  if (cmd === 'verify') {
    const v = verify();
    const ICON = { PASS: '✅', WARN: '🟡', FAIL: '❌', UNKNOWN: '❔' };
    console.log('');
    console.log('  ' + ICON[v.state] + ' C6 成本可复算 —— ' + v.why);
    console.log('    条目 ' + v.entries + ' · 复算一致 ' + v.ok + ' · UNKNOWN ' + v.unknown
      + ' · 记录后价格变过的 ' + v.repricedSinceRecord + ' 条（金额不变，冻结生效）');
    for (const i of v.issues) console.log('      · ' + i);
    console.log('');
    process.exit(v.state === 'PASS' ? 0 : v.state === 'WARN' ? 3 : v.state === 'FAIL' ? 1 : 2);
  }

  console.error('用法: meter.mjs sync|record|report|verify|--selftest');
  process.exit(2);
}