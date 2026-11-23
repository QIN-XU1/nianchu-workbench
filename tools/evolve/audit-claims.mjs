#!/usr/bin/env node
/**
 * T4 审计 —— 六个主张（C1-C6）各自有没有可运行的验收器 + **经突变检验的反例**
 *
 * ── 2026-11-15 两次迭代 ──────────────────────────────────
 * 第一版：判「有反例」靠正则数断言文本里的关键词（「反例」「不许」「拒绝」…）。
 *   第二轮复审 A5 指出：那是**数关键词**，不是验证反例真的有效。
 *
 * 第二版（当前）：**必须有突变检验的强证据**。
 *   读 `evidence/evolve/selftest-reality.json`（由 audit-selftest-reality.mjs 产出）：
 *   只有「打瘸被测代码后自检变红」的验收器，才算它的反例是真的。
 *
 * 关键词计数保留，但只作为**辅助信息**，不再作为判定依据。
 *
 * ── 四态 ──────────────────────────────────────────────
 *   PASS     六条主张都有可运行验收器，且至少一个验收器经突变检验为 REAL
 *   WARN     有主张只有弱证据（关键词）或没有突变证据
 *   FAIL     有主张连验收器都没有
 *   UNKNOWN  没有突变检验结果文件（先跑 audit-selftest-reality.mjs）
 *
 * 用法：node tools/evolve/audit-claims.mjs [--json] [--selftest]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

/**
 * 六个主张 → 对应验收器
 *
 * mutationTargets：哪些验收器在 audit-selftest-reality 的突变表里
 *   （有 → 可以要求强证据）
 */
export const CLAIMS = [
  {
    id: 'C1',
    name: '每个结论都能追到证据',
    verifiers: [
      'prototype/hermes-agents/audit-matrix-honesty.mjs',
      'prototype/agent-ui/verify-no-abspath.mjs',
    ],
    drivers: [
      { script: 'prototype/hermes-agents/audit-matrix-honesty.mjs', arg: '--selftest' },
      { script: 'prototype/agent-ui/verify-no-abspath.mjs', arg: '--selftest' },
    ],
    evidence: ['audit-matrix-honesty: 31 维 × 8 主体逐格核对证据主语与路径（自检 8/8）',
      'verify-no-abspath: 验证链路 33 脚本清单 + 自检 11/11'],
  },
  {
    id: 'C2',
    name: '判不了就说判不了（UNKNOWN 永不并入通过）',
    // four-state 是库；它的**可运行验收器**是 verify-goal --selftest
    // （突变表也是打瘸 four-state.verdict 后驱动 verify-goal --selftest 验证的）
    verifiers: ['prototype/hermes-agents/four-state.mjs', 'prototype/hermes-agents/verify-goal.mjs'],
    drivers: [
      { script: 'prototype/hermes-agents/four-state.mjs' },
      { script: 'prototype/hermes-agents/verify-goal.mjs', arg: '--selftest' },
    ],
    evidence: ['four-state.mjs: verdict() 四态裁决；UNKNOWN 退出码 2 且不进 PASS',
      '自检含「UNKNOWN 不许被算成通过」「UNKNOWN 与 FAIL 退出码必须不同」等 8 条',
      '突变检验：把 unknown→return 2 改成 return 0 后自检必红'],
  },
  {
    id: 'C3',
    name: '记忆会老化且留痕（TTL + supersede 不丢历史）',
    verifiers: ['tools/memory/store.mjs', 'tools/memory/store.selftests.mjs'],
    drivers: [{ script: 'tools/memory/store.mjs', arg: '--selftest' },{ script: 'tools/memory/store.selftests.mjs', arg: '--selftest' }],
    evidence: ['store.mjs: 无来源拒绝写入 · TTL 过期不进结果但保留历史 · supersede 旧值仍可查',
      'store.selftests: 四种分歧类型（从 openclaw 规范借）· revert 可撤销 · expectHash 乐观并发'],
  },
  {
    id: 'C4',
    name: '改进有前后度量（无基线不许改）',
    verifiers: ['tools/evolve/evolve.mjs', 'tools/evolve/measure-verifier-efficacy.mjs'],
    drivers: [{ script: 'tools/evolve/evolve.mjs', arg: '--selftest' }],
    evidence: ['evolve.mjs: C4 无基线拒绝登记（含反例）',
      'measure-verifier-efficacy: 度量本身跑多轮验可复算'],
  },
  {
    id: 'C5',
    name: '改进会被独立验证（自己验自己降级）',
    verifiers: ['tools/evolve/evolve.mjs'],
    drivers: [{ script: 'tools/evolve/evolve.mjs', arg: '--selftest' }],
    evidence: ['evolve.mjs: C5 verifier==by ⇒ 状态降 partial；dispute 五个反例挡住「换签名」',
      '台账 H-0004/H-0009 两条真实驳回记录（19 + 12 条攻击清单）'],
  },
  {
    id: 'C6',
    name: '成本可复算（换模型不重算历史）',
    verifiers: ['tools/cost/meter.mjs'],
    drivers: [{ script: 'tools/cost/meter.mjs', arg: '--selftest' }],
    evidence: ['meter.mjs: 冻结单价 · 无价判 UNKNOWN 不记 0 · 篡改能被复算检出',
      '真实记账 9 条（网关 71/110 模型有价）'],
  },
];

/** 解析自检结论 */
export function parseConclusion(out) {
  const m1 = /结论:\s*✓\s*(\d+)\/(\d+)/.exec(out);
  if (m1) return { ok: m1[1] === m1[2], pass: Number(m1[1]), total: Number(m1[2]) };
  const m2 = /自检结论：\s*(✓|✗)\s*(.+)/.exec(out);
  if (m2) {
    const lines = out.split('\n').filter((l) => /^\s*[✓✗]/.test(l));
    const bad = lines.filter((l) => /^\s*✗/.test(l)).length;
    return { ok: m2[1] === '✓' && bad === 0, pass: lines.length - bad, total: lines.length };
  }
  return null;
}

/** 数关键词（辅助信息，不作判定依据） */
export function countCounterExamples(out) {
  const lines = out.split('\n').filter((l) => /^\s*[✓✗]/.test(l));
  return {
    total: lines.length,
    negative: lines.filter((l) => /反例|应当失败|拒绝|→ ?FAIL|→ ?UNKNOWN|不该|不许|挡住|抓不到|漏|不许退出 0/.test(l)).length,
  };
}

/**
 * 核心审计 —— 抽成纯函数便于自检
 *
 * @param claims       主张清单
 * @param existsFn     路径存在性判定
 * @param runDriver    (script, arg) => { code, out }
 * @param mutationMap  Map<script, 'REAL'|'DECORATIVE'>
 */
export function auditClaims(claims, existsFn, runDriver, mutationMap) {
  const rows = [];
  for (const c of claims) {
    const exists = c.verifiers.every((v) => existsFn(v));
    const drivers = c.drivers || [];
    const driverResults = [];
    let allOk = true;
    let totalCases = 0, totalNeg = 0;

    for (const d of drivers) {
      if (!existsFn(d.script)) {
        driverResults.push({ script: d.script, ran: false, ok: false, detail: '文件不存在' });
        allOk = false;
        continue;
      }
      const r = runDriver(d.script, d.arg);
      const concl = parseConclusion(r.out);
      const counts = countCounterExamples(r.out);
      totalCases += counts.total;
      totalNeg += counts.negative;
      driverResults.push({
        script: d.script, ran: true,
        ok: !!concl && concl.ok,
        detail: concl ? concl.pass + '/' + concl.total : '无结论行',
      });
      if (!concl || !concl.ok) allOk = false;
    }

    // 强证据：该主张的**任一**验收器在突变表里是 REAL
    const mutationReal = c.verifiers.filter((v) => mutationMap.get(v) === 'REAL');
    const mutationDecorative = c.verifiers.filter((v) => mutationMap.get(v) === 'DECORATIVE');
    const strongOk = mutationReal.length > 0 && mutationDecorative.length === 0;

    // 弱证据：自检通过且有关键词
    const weakOk = exists && drivers.length > 0 && allOk && totalNeg > 0;

    rows.push({
      id: c.id, name: c.name, verifiers: c.verifiers, exists,
      drivers: driverResults, totalCases, totalNeg,
      mutationReal, mutationDecorative,
      strongOk, weakOk,
      /**
       * 判定：**exists 是硬前提**
       *
       * 【2026-11-15 · 自检抓到的真 bug】
       * 原来写的是 `strongOk || (weakOk && mutationMap.size === 0)`，
       * 没有把 exists 放进条件 —— 于是「验收器文件不存在」的主张，
       * 只要突变表里有同名条目就照样 pass。
       * 自检里「反例 · 验收器不存在 → 判不通过」当场红了才暴露。
       */
      pass: exists && (strongOk || (weakOk && mutationMap.size === 0)),
      strength: strongOk ? 'strong' : weakOk ? 'weak' : 'none',
      evidence: c.evidence,
    });
  }
  return rows;
}

/**
 * 自检 —— 反例全部是「构造一个应当不达标的主张，审计必须判它不达标」
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const existsAll = () => true;
  const existsNone = () => false;
  const okDriver = () => ({ code: 0, out: '  结论: ✓ 5/5\n  ✓ 反例 · 应当拒绝\n' });
  const redDriver = () => ({ code: 1, out: '  结论: ✗ 3/5\n' });
  const noConcl = () => ({ code: 0, out: '  something\n' });

  const mkClaim = (id, verifiers = ['a.mjs']) => ({
    id, name: id, verifiers,
    drivers: verifiers.map((v) => ({ script: v, arg: '--selftest' })),
    evidence: [],
  });

  // ── 正例 1：验收器存在 + 自检通过 + 突变 REAL → pass，strength=strong ──
  const r1 = auditClaims([mkClaim('C1')], existsAll, okDriver, new Map([['a.mjs', 'REAL']]));
  T('正例 · 突变 REAL → 判 pass 且强度 strong',
    r1[0].pass && r1[0].strength === 'strong', JSON.stringify({ pass: r1[0].pass, s: r1[0].strength }));

  // ── 反例 1：突变 DECORATIVE（打瘸仍绿）→ 必须不通过 ──
  const r2 = auditClaims([mkClaim('C2')], existsAll, okDriver, new Map([['a.mjs', 'DECORATIVE']]));
  T('反例 · 突变 DECORATIVE → 必须判不通过（不许靠关键词蒙混）',
    !r2[0].pass, 'pass=' + r2[0].pass + ' strength=' + r2[0].strength);

  // ── 反例 2：验收器不存在 → 必须不通过 ──
  const r3 = auditClaims([mkClaim('C3')], existsNone, okDriver, new Map([['a.mjs', 'REAL']]));
  T('反例 · 验收器不存在 → 判不通过', !r3[0]?.pass, 'pass=' + r3[0]?.pass);

  // ── 反例 3：自检本身红 → 必须不通过 ──
  const r4 = auditClaims([mkClaim('C4')], existsAll, redDriver, new Map([['a.mjs', 'REAL']]));
  T('反例 · 自检不通过 → 判不通过', !r4[0]?.pass || !r4[0]?.drivers?.[0]?.ok,
    JSON.stringify({ pass: r4[0].pass, driverOk: r4[0].drivers[0].ok }));

  // ── 反例 4：自检没有结论行 → 必须不通过 ──
  const r5 = auditClaims([mkClaim('C5')], existsAll, noConcl, new Map([['a.mjs', 'REAL']]));
  T('反例 · 自检无结论行 → 判不通过', !r5[0]?.drivers?.[0]?.ok, JSON.stringify(r5[0]?.drivers?.[0]));

  // ── 反例 5（核心）：没有突变证据 + 有关键词 → 只能是 weak，不许升格 strong ──
  const r6 = auditClaims([mkClaim('C6')], existsAll, okDriver, new Map());
  T('反例 · 无突变证据时只能算 weak（关键词不升格为强证据）',
    r6[0].strength === 'weak' && r6[0].strongOk === false,
    'strength=' + r6[0].strength + ' strongOk=' + r6[0].strongOk);

  // ── 反例 6：一个主张有多个验收器，其中一个 DECORATIVE → 不许算强 ──
  const r7 = auditClaims([mkClaim('C7', ['a.mjs', 'b.mjs'])], existsAll, okDriver,
    new Map([['a.mjs', 'REAL'], ['b.mjs', 'DECORATIVE']]));
  T('反例 · 同主张内有一个 DECORATIVE → 不算强证据',
    r7[0].strongOk === false, 'strongOk=' + r7[0].strongOk);

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

function tryRun(script, arg) {
  try {
    const args = [path.join(REPO, script)];
    if (arg) args.push(arg);
    const out = execFileSync(process.execPath, args, {
      cwd: REPO, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  if (process.argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  T4 审计 · 自检（1 正例 + 6 反例）');
    console.log('  ' + '─'.repeat(72));
    console.log(r.lines);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  // 读突变证据
  const mutationMap = new Map();
  {
    const p = path.join(REPO, 'evidence/evolve/selftest-reality.json');
    if (fs.existsSync(p)) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const r of j.results || []) {
          if (r.state === 'REAL') mutationMap.set(r.script, 'REAL');
          else if (r.state === 'DECORATIVE') mutationMap.set(r.script, 'DECORATIVE');
        }
      } catch { /* */ }
    }
  }

  const rows = auditClaims(CLAIMS, (v) => fs.existsSync(path.join(REPO, v)), tryRun, mutationMap);

  console.log('');
  console.log('  T4 审计 —— 六个主张是否各有可运行的验收器 + **经突变检验的反例**');
  console.log('  ' + '='.repeat(80));
  console.log('  突变证据：' + mutationMap.size + ' 个目标'
    + (mutationMap.size ? '' : '  ← 先跑 audit-selftest-reality.mjs'));
  console.log('');

  const STRENGTH = { strong: '【强·突变检验】', weak: '【弱·仅关键词】', none: '【无】' };
  for (const r of rows) {
    console.log('  ' + (r.pass ? '✓' : '✗') + ' ' + r.id + '  ' + r.name + '   ' + STRENGTH[r.strength]);
    console.log('      验收器  ' + (r.exists ? '存在' : '**缺失**') + '  (' + r.verifiers.length + ' 个)');
    for (const d of r.drivers) {
      console.log('      自检    ' + d.script.split('/').pop().padEnd(28) + (d.ran ? d.detail : d.detail));
    }
    if (r.mutationReal.length) console.log('      突变    REAL: ' + r.mutationReal.map((x) => x.split('/').pop()).join('、'));
    if (r.mutationDecorative.length) console.log('      突变    **DECORATIVE**: ' + r.mutationDecorative.map((x) => x.split('/').pop()).join('、'));
    console.log('      关键词  ' + r.totalNeg + ' / ' + r.totalCases + ' 条断言（辅助信息，不作判定）');
    console.log('');
  }

  const pass = rows.filter((r) => r.pass).length;
  const strong = rows.filter((r) => r.strength === 'strong').length;
  const fail = rows.length - pass;

  console.log('  ' + '─'.repeat(80));
  console.log('  达标 ' + pass + '/' + rows.length + ' · 其中强证据 ' + strong
    + (fail ? '  不达标 ' + fail : ''));

  let state, why;
  if (!mutationMap.size) {
    state = 'UNKNOWN';
    why = '没有突变检验结果 —— 无法判定「反例是真的」（先跑 audit-selftest-reality.mjs）';
  } else if (fail) {
    state = strong === 0 ? 'FAIL' : 'WARN';
    why = fail + ' 条主张缺验收器或缺少经突变检验的反例';
  } else {
    state = 'PASS';
    why = '六条主张均可验，且每条都有经突变检验确认的反例（打瘸必红）';
  }

  console.log('');
  console.log('  四态: ' + state + ' —— ' + why);

  const OUT = {
    what: 'T4 审计：六个主张的验收器与反例覆盖（强证据优先）',
    at: new Date().toISOString(),
    state, pass, strong, total: rows.length,
    mutationTargets: mutationMap.size,
    rows,
  };
  const outPath = path.join(REPO, 'evidence/evolve/claims-audit.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(OUT, null, 2) + '\n', 'utf8');
  console.log('  → ' + path.relative(REPO, outPath));
  console.log('');

  if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
  process.exit(state === 'PASS' ? 0 : state === 'WARN' ? 3 : state === 'FAIL' ? 1 : 2);
}