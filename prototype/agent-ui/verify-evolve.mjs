#!/usr/bin/env node
/**
 * L4 改进闭环 · 验收器
 *
 * 检查四件事：
 *   1. 闭环工具的三条硬约束自检通过（C4 无基线不许登记 / C2 样本不足判 UNKNOWN / C5 自验降级）
 *   2. 验收器效能度量可跑，且结论与它自己的四态一致
 *   3. 台账完整性：每条已结案记录都有前后值、样本量、验证方
 *   4. **至少有一条真实的改进记录** —— 空台账 = 闭环没跑过 = 不能算「会自己变强」
 *
 * 四态：
 *   PASS     四项全过，且台账里至少 1 条真实记录
 *   WARN     工具都对，但台账是空的（机制在，还没跑过）
 *   FAIL     自检不通过 / 台账integrity 有问题
 *   UNKNOWN  跑不了（文件缺失）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const LABEL = 'L4 改进闭环（假设→改→量→留或退→留痕）';

function run(args, timeout = 600000) {
  // 只有第一个参数是脚本路径，其余（如 --selftest）必须原样传
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

/* ═══════════════════════════ 纯函数区 ═══════════════════════════
 * L4 是「汇总器」：它自己不产生数据，只把三层结果（闭环工具自检 /
 * 人造故障度量 / 真实召回度量 / 台账）合成一个四态结论。
 * 所以它最容易错、也最该单独测的，就是**合成规则**本身。
 * 下面把「解析」与「合成」都抽成纯函数，自检可以喂假的三层结果。
 */

/** 解析某脚本自检的结论行：`结论: ✓ 16/16` */

/**
 * 台账计数 —— 把「结案」的口径钉死
 *
 * 【为什么必须抽出来单测】
 * 2026-11-15 独立复审第三轮抓到：这里原来写的是 `status !== 'open'`，
 * 于是 **refuted（被驳回）也算「已结案」**，再从中筛 independent，
 * **2 条 refuted 被报成「独立验证 2」**。
 *
 * 意思完全反了 —— 那是别人把我驳倒了，不是「独立验证通过」。
 * 实际是 19 partial + 2 refuted + 0 closed，却被报成「已结案 21 · 独立验证 2」。
 *
 * 这个函数的唯一职责：**只有 status === 'closed' 才算结案**。
 *
 * 【2026-11-16 修 · 第二处真假绿：同一个仓库两个计数器】
 * 上一版只读 `e.status`，于是 H-0022（status='closed'，但已被 H-0025 正式驳回
 * ⇒ 字段 `disputedBy`）在本函数里仍算「结案」。而 tools/evolve/evolve.mjs 的
 * `verify()` 用的是 `effectiveStatus = e.disputedBy ? 'refuted' : e.status` —— 同一个仓库
 * 于是算出两个数：evolve verify 报 11，本函数报 12。差的就是 H-0022。
 *
 * 驳回就是驳回：一条记录被正式驳回后，它的 status 字段不会（也不该）被改，
 * 但它的**有效状态**是 refuted。所以这里统一到 evolve 的口径，
 * 有 `disputedBy` ⇒ 算 refuted，不进 closed / partial 桶。
 */
export function countLedger(entries) {
  const all = Array.isArray(entries) ? entries : [];
  const effectiveStatus = (e) => (e.disputedBy ? 'refuted' : e.status);
  const closed = all.filter((e) => effectiveStatus(e) === 'closed');
  const partials = all.filter((e) => effectiveStatus(e) === 'partial');
  const refuted = all.filter((e) => effectiveStatus(e) === 'refuted');
  const independent = closed.filter((e) => e.independent === true);
  return {
    total: all.length,
    closed: closed.length,
    partials: partials.length,
    refuted: refuted.length,
    independent: independent.length,
  };
}

export function parseTally(out) {
  const m = /结论: ✓ (\d+)\/(\d+)/.exec(String(out || ''));
  return m ? { p: Number(m[1]), n: Number(m[2]) } : null;
}

/** 解析人造故障度量输出：召回率 / 误报率 / 四态 */
export function parseEfficacy(out) {
  const text = String(out || '');
  const recall = /召回率 recall\s+([\d.]+) \/ ([\d.]+)/.exec(text);
  const fpr = /误报率 fpr\s+([\d.]+)/.exec(text);
  const state = /四态: (\w+)/.exec(text);
  return {
    recall: recall ? recall[1] : null,
    fpr: fpr ? fpr[1] : null,
    state: state ? state[1] : null,
  };
}

/** 解析真实召回度量输出：recall_real / 四态 */
/** 解析变异测试输出：守住 N · 没守住 M · 判不了 K */
export function parseMutation(out) {
  const m = /守住 (\d+) · 没守住 (\d+) · 判不了 (\d+)/.exec(String(out ?? ''));
  if (!m) return { caught: null, total: null, survived: null, unknown: null };
  const caught = Number(m[1]);
  const survived = Number(m[2]);
  const unknown = Number(m[3]);
  return { caught, survived, unknown, total: caught + survived + unknown };
}

export function parseRealRecall(out) {
  const text = String(out || '');
  const recall = /召回率 recall_real\s+([\d.]+)/.exec(text);
  const state = /四态: (\w+)/.exec(text);
  return { recall: recall ? recall[1] : null, state: state ? state[1] : null };
}

/**
 * 三层结果 → 四态结论（本验收器的核心逻辑）
 *
 * ── 为什么这是全项目最危险的一段 ──────────────────────────────
 * 汇总是**单向降级**的：下层任何一层说「判不了」，上层就必须至少是 UNKNOWN，
 * 绝不能因为「其他几层都绿」就把它抬成 PASS。四态纪律的原话是：
 * 「没连上」不等于「没问题」；「判不了」不等于「通过」。
 *
 * 历史上有过一种典型错法：只写 `if (state === 'FAIL') return FAIL`，
 * 于是下层回 UNKNOWN 时会**继续往下走**，被后面的「台账有记录」兜成 PASS
 * —— 一个跑不起来的度量被层层绿灯掩盖。这正是本自检反例 1、2 钉住的点。
 *
 * @param io.toolSelf         {p,n} | null   闭环工具自检结论
 * @param io.toolSelfExit     number         自检进程退出码（无结论行时用于报错）
 * @param io.efficacy         {recall,fpr,state} | null
 * @param io.realRecall       {recall,state} | null
 * @param io.mutation         {caught,total,survived,unknown} | null —— 变异测试结果（反例是否真能红）
 * @param io.t2cov            {state,covered,total,ratio,missing} | null —— T2 覆盖率（「所有验收器」覆盖了多少）
 * @param io.fprSweep         {state,total,fail,fpr,honestUnknown} | null —— 干净树上全量验收器的误报率
 * @param io.ledgerIntegrity  {ok, snippet?} 台账完整性（evolve verify）
 * @param io.ledger           {entries} | null   台账内容；null = 台账文件不存在
 * @param io.ledgerReadError  string | null  台账读不出来（JSON 坏）时的原因
 * @returns {state, detail}
 */
export function composeVerdict(io = {}) {
  const {
    toolSelf = null, toolSelfExit = 0,
    efficacy = null, realRecall = null, mutation = null, t2cov = null, fprSweep = null, fprStale = null,
    ledgerIntegrity = null, ledger = null, ledgerReadError = null,
  } = io;
  const detail = [];

  // ── 1. 工具自检 ──
  if (!toolSelf) return { state: 'FAIL', detail: '闭环工具自检没有结论行（exit=' + toolSelfExit + '）' };
  detail.push('硬约束自检 ' + toolSelf.p + '/' + toolSelf.n);
  if (toolSelf.p !== toolSelf.n) return { state: 'FAIL', detail: detail.join(' · ') + ' —— 有硬约束不成立' };

  // ── 2. 效能度量（人造故障）──
  if (!efficacy || !efficacy.state) return { state: 'FAIL', detail: detail.join(' · ') + ' · 度量没有四态结论' };
  detail.push('人造故障 recall ' + (efficacy.recall ?? '?') + ' · fpr ' + (efficacy.fpr ?? '?') + ' · 判 ' + efficacy.state);
  if (efficacy.state === 'FAIL') return { state: 'FAIL', detail: detail.join(' · ') + ' —— 度量本身不可信' };
  // 【关键】判不了 ≠ 通过。UNKNOWN 必须原样上报，不许落进后面的绿灯路径。
  if (efficacy.state === 'UNKNOWN') {
    return { state: 'UNKNOWN', detail: detail.join(' · ') + ' —— 度量判不了（UNKNOWN），不能当成通过' };
  }

  // ── 2b. 真实召回（真实历史缺陷回放）──
  //   为什么单独一项：人造故障的致命弱点是**出题人就是我自己**。
  //   真实历史缺陷不会 —— 它们是**真的漏过去了**的东西。
  if (!realRecall || !realRecall.state) {
    detail.push('真实召回 无结论');
    return { state: 'FAIL', detail: detail.join(' · ') + ' —— 真实召回度量没输出四态' };
  }
  detail.push('真实缺陷召回 ' + (realRecall.recall ?? '?') + ' · 判 ' + realRecall.state);
  if (realRecall.state === 'FAIL' || realRecall.state === 'UNKNOWN') {
    return { state: realRecall.state, detail: detail.join(' · ') + ' —— 真实召回度量不可信' };
  }

  // ── 2c. 变异测试（反例是否真的能红）──
  //
  // 【2026-11-18 加·起因】两个独立审计员各做了一遍变异测试，分别发现
  // 「12 个变异体 3 个存活」和「3 个存活 + 1 条恒真断言」。
  // 存活 = 把实现改坏、测试仍然全绿 ⇒ 那条测试等于没测。
  //
  // 这一步是 T2「所有验收器经过反例检验」的直接证据：
  // 不是「我写了反例」，而是「我把实现改坏，反例真的报红」。
  if (mutation) {
    if (mutation.caught === null || mutation.caught === undefined) {
      detail.push('变异测试 无结论');
      return { state: 'UNKNOWN', detail: detail.join(' · ') + ' —— 变异测试没输出结论' };
    }
    detail.push('变异测试 守住 ' + mutation.caught + '/' + mutation.total);
    if (mutation.survived > 0) {
      return {
        state: 'FAIL',
        detail: detail.join(' · ') + ' —— **有 ' + mutation.survived + ' 个变异体存活：改坏实现测试仍绿，那些反例是假的**',
      };
    }
    if (mutation.unknown > 0) {
      return {
        state: 'UNKNOWN',
        detail: detail.join(' · ') + ' —— 有 ' + mutation.unknown + ' 个变异体判不了（锚点找不到），不能当成通过',
      };
    }
  } else {
    detail.push('变异测试 未跑');
    return { state: 'UNKNOWN', detail: detail.join(' · ') + ' —— 没有变异测试证据，反例可信度判不了' };
  }

  // ── 2d. T2 覆盖率（「所有验收器」到底覆盖了多少）──
  //
  // 【2026-11-18 加】2c 只证明「我选的 10 个变异体都能被抓到」，
  // 但 T2 的原话是「**所有**验收器经过反例检验」。说全了必须能列出每一，
  // 或者说清哪些没有。这一步就是把覆盖率算成数字并**如实报缺口**。
  if (t2cov) {
    if (!t2cov.state) {
      detail.push('T2 覆盖率 无结论');
      return { state: 'UNKNOWN', detail: detail.join(' · ') + ' —— 覆盖率报告没输出四态' };
    }
    detail.push('T2 覆盖率 ' + t2cov.covered + '/' + t2cov.total
      + '（' + Math.round((t2cov.ratio ?? 0) * 100) + '%）');
    if (t2cov.state === 'FAIL') {
      return { state: 'FAIL', detail: detail.join(' · ') + ' —— ' + t2cov.why };
    }
    if (t2cov.state === 'UNKNOWN') {
      return { state: 'UNKNOWN', detail: detail.join(' · ') + ' —— ' + t2cov.why };
    }
    // WARN 不阻断，但**必须把缺口说清楚**（不然「覆盖率」会被读成「全覆盖」）
    if (t2cov.state === 'WARN') {
      detail.push('**覆盖率不是 100%，缺口 ' + (t2cov.missing || []).length + ' 个**');
    }
  } else {
    detail.push('T2 覆盖率 未跑');
    return { state: 'UNKNOWN', detail: detail.join(' · ') + ' —— 没有覆盖率证据，判不了「所有」' };
  }

  // ── 2e. fpr 全量扫描（「所有验收器」的误报率）──
  //
  // 【2026-11-18 加·起因】2c/2d 解决的是「反例能不能红」，但 T2 还有一半是 fpr=0。
  // 原来的 fpr 来自 measure-verifier-efficacy：13 个故障注入 **7 个**目标文件，
  // 而 t2-coverage 的验收器有 **20 个** —— 集合不对齐，7 个覆盖不到 20 个。
  // 这一步换个问法直接量：**树上没有注入时，哪些验收器仍然报红？**
  if (fprSweep) {
    if (!fprSweep.state) {
      detail.push('fpr 全量 无结论');
      return { state: 'UNKNOWN', detail: detail.join(' · ') + ' —— fpr 扫描没输出四态' };
    }
    detail.push('fpr 全量 ' + fprSweep.fail + '/' + (fprSweep.scored ?? fprSweep.total)
      + '（' + Number(fprSweep.fpr).toFixed(3) + ' · 证据 ' + (fprSweep._ageH ?? '?') + 'h 前）');
    if (fprSweep.state === 'FAIL') {
      return { state: 'FAIL', detail: detail.join(' · ') + ' —— ' + fprSweep.why };
    }
    if (fprSweep.state === 'UNKNOWN') {
      return { state: 'UNKNOWN', detail: detail.join(' · ') + ' —— ' + fprSweep.why };
    }
    if (fprSweep.state === 'WARN') {
      // 不是误报，但也不能并进 PASS —— 把「哪些验收器如实报 UNKNOWN」说清楚
      detail.push('其中 ' + (fprSweep.honestUnknown || []).length + ' 个如实报 UNKNOWN（不是误报）');
    }
  } else {
    detail.push('fpr 全量 ' + (fprStale || '没有证据文件'));
    return {
      state: 'UNKNOWN',
      detail: detail.join(' · ') + ' —— 没有新鲜的全量 fpr 证据，判不了「所有验收器」的误报率'
        + '（跑 `node tools/evolve/fpr-sweep.mjs` 生成，约 20 分钟，需干净树）',
    };
  }

  // ── 3. 台账完整性 ──
  if (ledgerIntegrity && ledgerIntegrity.ok === false) {
    return { state: 'FAIL', detail: detail.join(' · ') + ' · 台账完整性有问题：' + (ledgerIntegrity.snippet || '') };
  }
  if (ledgerReadError) {
    return { state: 'FAIL', detail: detail.join(' · ') + ' · 台账读不出来：' + ledgerReadError };
  }

  // ── 4. 至少一条真实记录 ──
  if (!ledger) {
    return { state: 'WARN', detail: detail.join(' · ') + ' · **台账不存在 —— 闭环从没跑过**' };
  }
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  // 【2026-11-15 修 · 独立复审第三轮抓到的真假绿】
  // 原来写的是 `status !== 'open'` ⇒ **refuted（被驳回）也算已结案**；
  // 再从中筛 independent ⇒ **2 条 refuted 被算成「独立验证 2」**。
  // 意思完全反了：那是**别人把我驳倒了**，不是「独立验证通过」。
  // 实际数字：19 partial（自己验自己）+ 2 refuted（被驳回）+ 0 closed。
  // 结果却被报成「已结案 21 · 其中独立验证 2」—— 这是拿假数字冒充进度。
  const L = countLedger(entries);
  const { closed, partials, refuted, independent } = {
    closed: Array(L.closed).fill(0), partials: Array(L.partials).fill(0),
    refuted: Array(L.refuted).fill(0), independent: Array(L.independent).fill(0),
  };
  detail.push('台账 ' + entries.length + ' 条（**真正结案 ' + closed.length
    + '** · 自己验自己 ' + partials.length + ' · 被驳回 ' + refuted.length
    + ' · 其中非实现方独立验证 ' + independent.length + '）');

  if (!closed.length) {
    return {
      state: 'WARN',
      detail: detail.join(' · ')
        + ' —— 机制在位，但 **0 条真正结案**（'
        + partials.length + ' 条是自己验自己，' + refuted.length + ' 条被驳回）。'
        + 'T1 的「≥3 轮非实现方独立验证」仍是 0。',
    };
  }

  // 有记录就算达成；独立验证数一并报出，但不作为硬门槛（避免为了绿灯造记录）
  return {
    state: 'PASS',
    detail: detail.join(' · ')
      + ' · 已跑完 ' + closed.length + ' 轮真实改进'
      + (independent.length ? '' : '（全部为自己验证 ⇒ 状态为「部分」，独立验证仍待补）'),
  };
}

/**
 * 自检 —— 用假的三层结果验证合成规则
 *
 * 【为什么必须有】这个审计如果只会说「通过」，那不是审计，是装饰。
 * 反例 1、2 打的就是「下层 UNKNOWN 被上层兜成 PASS」——
 * 这是四态汇总里最容易犯、也最致命的错：跑不起来的东西看起来像全绿。
 */
export function selfTest() {
  const cases = [];
  const T = (n, okc, why) => cases.push([n, !!okc, why]);

  // 一套「本来全绿」的样板，各反例只改动其中一层
  const green = () => ({
    toolSelf: { p: 16, n: 16 }, toolSelfExit: 0,
    efficacy: { recall: '1.000', fpr: '0.077', state: 'WARN' },
    realRecall: { recall: '1.000', state: 'PASS' },
    ledgerIntegrity: { ok: true },
    ledger: { entries: [{ id: 'e1', status: 'closed', independent: true }] },
  });

  // ── 反例 1（核心）：效能度量 UNKNOWN，其余全绿 → 整体必须 UNKNOWN，不许 PASS ──
  //   这就是「UNKNOWN 被并进 PASS」：只看 FAIL 分支的实现会一路走到末尾的 PASS。
  const c1 = composeVerdict({ ...green(), efficacy: { recall: null, fpr: null, state: 'UNKNOWN' } });
  T('反例 · 效能度量 UNKNOWN（其余全绿）→ 必须 UNKNOWN，不许 PASS',
    c1.state === 'UNKNOWN', 'got=' + c1.state + ' detail=' + c1.detail);

  // ── 反例 2（核心）：真实召回 UNKNOWN → 整体必须 UNKNOWN ──
  const c2 = composeVerdict({ ...green(), realRecall: { recall: null, state: 'UNKNOWN' } });
  T('反例 · 真实召回 UNKNOWN → 必须 UNKNOWN，不许被台账兜成 PASS',
    c2.state === 'UNKNOWN', 'got=' + c2.state);

  // ── 反例 3：台账空（0 条已结案）→ WARN，不是 PASS ──
  //   「机制在位但一轮都没跑过」正是 WARN 的定义；算成 PASS 等于「没跑也变强了」。
  const c3 = composeVerdict({ ...green(), ledger: { entries: [{ id: 'o1', status: 'open' }] } });
  T('反例 · 台账 0 条已结案 → 必须 WARN，不许 PASS',
    c3.state === 'WARN', 'got=' + c3.state);

  // ── 反例 4：台账文件不存在 → WARN（不是 PASS，也不是 FAIL）──
  const c4 = composeVerdict({ ...green(), ledger: null });
  T('反例 · 台账不存在 → 必须 WARN（机制在，没跑过）',
    c4.state === 'WARN', 'got=' + c4.state);

  // ── 反例 5：闭环工具自检 15/16 → FAIL ──
  const c5 = composeVerdict({ ...green(), toolSelf: { p: 15, n: 16 } });
  T('反例 · 硬约束自检 15/16（有一条不成立）→ 必须 FAIL',
    c5.state === 'FAIL', 'got=' + c5.state);

  // ── 反例 6：闭环工具自检没有结论行 → FAIL（不许把「没输出」当通过）──
  const c6 = composeVerdict({ ...green(), toolSelf: null, toolSelfExit: 1 });
  T('反例 · 自检没有结论行 → 必须 FAIL',
    c6.state === 'FAIL' && /没有结论行/.test(c6.detail), 'got=' + c6.state);

  // ── 反例 7：效能度量判 FAIL → 整体 FAIL（即便台账有记录）──
  const c7 = composeVerdict({ ...green(), efficacy: { recall: '0.300', fpr: '0.900', state: 'FAIL' } });
  T('反例 · 度量判 FAIL → 必须 FAIL，不许被台账兜成 PASS',
    c7.state === 'FAIL', 'got=' + c7.state);

  // ── 反例 8：度量没有四态结论 → FAIL（缺结论不是通过）──
  const c8 = composeVerdict({ ...green(), efficacy: { recall: null, fpr: null, state: null } });
  T('反例 · 度量没有四态结论 → 必须 FAIL',
    c8.state === 'FAIL', 'got=' + c8.state);

  // ── 反例 9：台账完整性有问题（evolve verify 报错）→ FAIL ──
  const c9 = composeVerdict({ ...green(), ledgerIntegrity: { ok: false, snippet: '第 3 条缺样本量' } });
  T('反例 · 台账完整性有问题 → 必须 FAIL',
    c9.state === 'FAIL' && /缺样本量/.test(c9.detail), 'got=' + c9.state);

  // ── 反例 10：台账 JSON 读不出来 → FAIL（不许当成「没有台账」的 WARN 混过去）──
  const c10 = composeVerdict({ ...green(), ledger: null, ledgerReadError: 'Unexpected token' });
  T('反例 · 台账 JSON 解析失败 → 必须 FAIL（不是 WARN）',
    c10.state === 'FAIL', 'got=' + c10.state);

  // ── 正例 1：四层全过 + 1 条独立验证记录 → PASS ──
  const c11 = composeVerdict(green());
  T('正例 · 四层全过 + 1 条已结案 → PASS', c11.state === 'PASS', 'got=' + c11.state);

  // ── 正例 2（诚实性）：全过但无独立验证 → 仍是 PASS，但 detail 必须写明「部分」──
  //   这是不许为了绿灯造记录的软化处理：状态不硬拦，但必须把「自己验自己」说出来。
  const c12 = composeVerdict({ ...green(), ledger: { entries: [{ id: 'e1', status: 'closed', independent: false }] } });
  T('正例 · 无独立验证 → PASS 但 detail 必须标注「全部为自己验证」',
    c12.state === 'PASS' && /全部为自己验证/.test(c12.detail), 'got=' + c12.state + ' / ' + c12.detail);

  // ── 解析器反例：输出了半截也不能默认通过 ──
  T('反例 · parseTally 对空输出返回 null（不许默认 100%）', parseTally('') === null);
  T('反例 · parseEfficacy 缺四态时 state 为 null（不许默认 PASS）',
    parseEfficacy('召回率 recall 1.000 / 1.000').state === null,
    JSON.stringify(parseEfficacy('召回率 recall 1.000 / 1.000')));
  T('反例 · parseRealRecall 缺四态时 state 为 null',
    parseRealRecall('召回率 recall_real 1.000').state === null);

  // ── countLedger 反例：钉住「refuted 不算结案」这个真假绿 ──
  {
    const l = countLedger([
      { status: 'partial', independent: false },
      { status: 'partial', independent: false },
      { status: 'refuted', independent: true },
      { status: 'closed', independent: true },
    ]);
    T('反例 · refuted 不许算「结案」（被驳回 ≠ 结案）', l.closed === 1, 'closed=' + l.closed);
    T('反例 · refuted 不许算「独立验证」（别人驳倒我 ≠ 独立通过）', l.independent === 1, 'independent=' + l.independent);
    T('反例 · 19 partial + 2 refuted + 0 closed 必须报 0 结案', countLedger([
      ...Array(19).fill({ status: 'partial' }), ...Array(2).fill({ status: 'refuted', independent: true }),
    ]).closed === 0, '');
    T('正例 · 4 类计数各自独立', l.total === 4 && l.partials === 2 && l.refuted === 1, JSON.stringify(l));
  }

  // ── countLedger 口径反例：disputedBy 生效（与 tools/evolve/evolve.mjs 的 verify() 同口径）──
  //   2026-11-16 修：原来本函数只读 e.status，H-0022（closed + disputedBy）仍算结案，
  //   而 evolve verify 用 effectiveStatus 把它算被驳回 ⇒ 同一个仓库 12 vs 11。
  //   下面两条必须成对存在：只钉「有 disputedBy 不计」的话，把它写成「一律不计」
  //   也能过 —— 所以必须配一条「无 disputedBy 必须计」。
  {
    // 反例：status='closed' 但有 disputedBy（已被正式驳回）⇒ 不许计入 closed
    const disputed = countLedger([{ id: 'H-0022', status: 'closed', independent: true, disputedBy: 'H-0025' }]);
    T('反例 · status=closed 但有 disputedBy ⇒ 不许算结案（必须是被驳回）',
      disputed.closed === 0 && disputed.independent === 0 && disputed.refuted === 1,
      'closed=' + disputed.closed + ' independent=' + disputed.independent + ' refuted=' + disputed.refuted);

    // 正例：status='closed' 且无 disputedBy ⇒ 必须计入 closed
    //   （否则「有驳回的不算」可以退化成「谁都不算」，上面那条反例照样绿）
    const solid = countLedger([{ id: 'H-0023', status: 'closed', independent: true }]);
    T('正例 · status=closed 且无 disputedBy ⇒ 必须算结案',
      solid.closed === 1 && solid.independent === 1 && solid.refuted === 0,
      JSON.stringify(solid));

    // 反例：partial + disputedBy 同样要归到被驳回，否则 partial 桶又和 evolve 对不上
    const disputedPartial = countLedger([{ id: 'H-0006', status: 'partial', disputedBy: 'H-0009' }]);
    T('反例 · partial 有 disputedBy ⇒ 算被驳回，不算自己验自己',
      disputedPartial.partials === 0 && disputedPartial.refuted === 1,
      JSON.stringify(disputedPartial));
  }

  const bad = cases.filter(([, okc]) => !okc);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, okc, w]) => '  ' + (okc ? '✓' : '✗') + ' ' + n + (okc ? '' : '  ← ' + w)).join('\n'),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain && process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  // 条数从实际用例算出来，不写死 —— 原来写死「2 正例 + 13 反例」，实际已有 19 条，
  // 数字本身就是假的（虽然不影响判定，但一个验收器的输出不该自带假数字）。
  console.log('  L4 改进闭环验收 · 自检 ' + r.total + ' 条（反例集中在「三层如何合成四态」与「台账口径 disputedBy」）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

function check() {
  // 1. 工具自检
  const st = run(['tools/evolve/evolve.mjs', '--selftest']);
  const toolSelf = parseTally(st.out);

  // 2. 效能度量（人造故障）
  const m = run(['tools/evolve/measure-verifier-efficacy.mjs', '--runs', '2']);
  const efficacy = parseEfficacy(m.out);

  // 2b. 真实召回（真实历史缺陷回放）
  const rr = run(['tools/evolve/measure-real-recall.mjs', '--runs', '2'], 900000);
  // 变异测试：改坏实现看反例是否真的报红（T2 的直接证据）
  const mu = run(['tools/quality/mutation-check.mjs'], 900000);
  // T2 覆盖率：verify-goal 调用的验收器里有多少经过突变检验
  const tc = run(['tools/evolve/t2-coverage.mjs'], 300000);
  // fpr 全量：**读证据文件，不现场跑**。
  // 理由：实测扫一次要 ~20 分钟（要跑 20 个验收器，其中 verify-goal 自己就要几分钟）。
  // 塞进每次 verify-goal 会让它从 ~5 分钟涨到 ~25 分钟，不可接受。
  // 改成与 audit-selftest-reality 同样的模式：单独跑、产出证据、这里读 + 查新鲜度。
  // 证据过期 ⇒ UNKNOWN（旧快照不许冒充此刻，这是 R12 数据新鲜度纪律）。
  let fprSweep = null;
  let fprStale = null;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'evidence/evolve/fpr-sweep.json'), 'utf8'));
    const ageH = (Date.now() - new Date(doc.at).getTime()) / 3600000;
    if (!Number.isFinite(ageH) || ageH > 24) {
      fprStale = '证据已 ' + (Number.isFinite(ageH) ? Math.round(ageH) : '?') + ' 小时未更新（>24h）';
    } else {
      fprSweep = doc;
      fprSweep._ageH = Math.round(ageH * 10) / 10;
    }
  } catch { fprSweep = null; }
  let t2cov = null;
  try { t2cov = JSON.parse(fs.readFileSync(path.join(REPO, 'evidence/evolve/t2-coverage.json'), 'utf8')); }
  catch { t2cov = null; }
  const realRecall = parseRealRecall(rr.out);

  // 3. 台账完整性
  const v = run(['tools/evolve/evolve.mjs', 'verify']);
  const ledgerIntegrity = {
    ok: v.code === 0,
    snippet: v.out.split('\n').filter((l) => l.includes('·')).slice(0, 2).join(' '),
  };

  // 4. 台账内容
  const ledgerPath = path.join(REPO, 'research/改进台账.json');
  let ledger = null, ledgerReadError = null;
  if (fs.existsSync(ledgerPath)) {
    try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
    catch (e) { ledgerReadError = String(e.message || e).slice(0, 120); }
  }

  return composeVerdict({
    toolSelf, toolSelfExit: st.code,
    efficacy, realRecall, mutation: parseMutation(mu.out), t2cov, fprSweep, fprStale,
    ledgerIntegrity, ledger, ledgerReadError,
  });
}

if (isMain) {
  const r = check();
  const ICON = { PASS: '✅', WARN: '🟡', FAIL: '❌', UNKNOWN: '❔' };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ label: LABEL, ...r }, null, 2));
  } else {
    console.log('');
    console.log('  ' + ICON[r.state] + ' ' + LABEL);
    console.log('  ' + r.detail);
    console.log('');
  }
  process.exit(r.state === 'PASS' ? 0 : r.state === 'WARN' ? 3 : r.state === 'FAIL' ? 1 : 2);
}

export { check, LABEL };
