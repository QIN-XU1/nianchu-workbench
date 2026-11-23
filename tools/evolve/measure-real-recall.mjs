#!/usr/bin/env node
// syntax-guard:allow-bad-words
//   本脚本的 RT-01 就要把 `import` 换成 `imporo` 来复现历史缺陷，
//   所以那个词必须出现在本文件里。这是**合法引用**，不是损坏。
// abspath-guard:allow-literal-root
//   本脚本的职责是「把历史缺陷塞回去」，其中 RT-05 的历史缺陷正是硬编码仓库根，
//   所以它必须把那个字符串原样写出来。这是合法引用，不是遗漏。
/**
 * 真实验收器召回 —— 用**真实发生过的缺陷**测，不是人为构造的故障
 *
 * ── 为什么需要这个（独立验证方 R2 指出的缺口）─────────────────
 * R2 驳倒了我的说法「fpr 0.375→0.000」，指出 fpr 测的是「度量器算得对不对」，
 * 不是「验收器准不准」。
 *
 * 那什么才测验收器准不准？—— **拿真实历史缺陷回放**。
 * 人为构造的故障有个致命弱点：**出题人就是我自己**。
 * 真实历史缺陷不会 —— 它们是**真的漏过去了**的东西。
 *
 * ── 两类缺陷，判法不同（第一版我搞混了，实测 0/4 全漏）──────────
 *
 *   A 类：**被测系统**的缺陷 —— 检查层应当红
 *        RT-01 脚本被 t→o 损坏 ⇒ verify-syntax-guard 应当红
 *
 *   B 类：**检查层自身**的缺陷 —— 需要「缺陷态 + 触发条件」才测得出
 *        RT-02 audit-coverage 无退出码：光去掉 exit 没用（没有不达标项时本来就该 exit 0）；
 *              必须**同时**注入一个不达标项，然后看它 **是否红**。
 *              第一版只去掉 exit、不加触发条件 → 当然 exit 0 → 我误判成「验收器漏了」。
 *        RT-03 size-guard 取整判定：必须同时放一个「32KB+1 字节」的文件
 *        RT-04 matrix-honesty 跳过证据清空：必须同时清空某个「有」维度的证据
 *
 * ── 判据 ──────────────────────────────────────────────────
 *   recall_real = 缺陷态下**正确变红**的项 / 总数
 *
 *   关键：这不只测「验收器能不能红」，而是测
 *   **「缺陷修复是否真的生效」** —— 如果把修复回退掉，它还红不红。
 *   如果不红了 ⇒ 说明那个修复是装饰。
 *
 * 用法：node tools/evolve/measure-real-recall.mjs [--runs 2]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');

const RUNS = (() => {
  const i = process.argv.indexOf('--runs');
  return i > 0 ? Math.max(1, Math.min(5, Number(process.argv[i + 1]) || 2)) : 2;
})();

/**
 * 真实缺陷清单
 *
 * 每项：把缺陷**连同它的触发条件**一起塞回去，看现在的检查还红不红。
 */
const DEFECTS = [
  {
    id: 'RT-01',
    kind: 'A',
    name: '脚本被 t→o 全局替换损坏（import→imporo）',
    history: '引入于 dda2fbed。当时 R8 报「界面层判不了」而不是「脚本坏了」，'
      + '直到改名后重跑才发现 3 个文件语法错误。',
    watch: { script: 'prototype/agent-ui/verify-syntax-guard.mjs', expectOutput: '损坏词' },
    defect: [
      { kind: 'replaceInFile', path: 'tools/benchmark/survey.mjs', find: 'import ', replace: 'imporo ' },
    ],
    trigger: null,   // A 类不需要单独触发：缺陷本身就是触发
  },
  {
    id: 'RT-02',
    kind: 'B',
    name: 'audit-coverage.mjs 没有退出码（永远 exit 0）',
    history: '从创建起就存在。输出写「达标 22/22」，但对 0/22 返回同样的 0 —— '
      + '只能靠人读输出，不能当门禁。由 L4 度量的 F02 发现。',
    defectEffect: '不达标时仍 exit 0',
    watch: { script: 'tools/benchmark/audit-coverage.mjs' },
    defect: [{ kind: 'stripExitCode', path: 'tools/benchmark/audit-coverage.mjs' }],
    trigger: [{ kind: 'editJson',
      path: 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/analysis.json',
      mutate: 'emptyFirstStrengths' }],
  },
  {
    id: 'RT-03',
    kind: 'B',
    name: 'size-guard.mjs 用取整后的 kb 判定（漏网 ~50 字节）',
    history: '从创建起就存在。判据 `f.kb > 32` 而 kb 是 `Math.round(kb*10)/10`，'
      + '于是 32769 字节被舍入成 32.0、不标红。由 L4 度量的 F11 发现。',
    defectEffect: '超红线 1 字节不被发现',
    watch: { script: 'tools/quality/size-guard.mjs' },
    defect: [{ kind: 'revertToRoundedKb', path: 'tools/quality/size-guard.mjs' }],
    trigger: [{ kind: 'createExactSizeFile', path: 'prototype/agent-ui/_rt03_probe.mjs', bytes: 32769 }],
  },
  {
    id: 'RT-04',
    kind: 'B',
    name: 'audit-matrix-honesty.mjs 跳过证据清空的行',
    history: '从创建起就存在。`if (us.length < 2) continue;` 让「声称有却零证据」'
      + '这种最典型的假绿被当没看见。由 L4 度量的 F10 发现。',
    defectEffect: '声称「有」却零证据不被发现',
    watch: { script: 'prototype/hermes-agents/audit-matrix-honesty.mjs' },
    defect: [{ kind: 'revertEvidenceSkip', path: 'prototype/hermes-agents/audit-matrix-honesty.mjs' }],
    trigger: [{ kind: 'editJson', path: 'prototype/hermes-agents/matrix-data.json', mutate: 'emptyFirstUsEvidence' }],
  },
  {
    id: 'RT-05',
    kind: 'A',
    name: 'verify-goal.mjs 硬编码仓库根（换目录结果就变）',
    history: '从创建起就存在。独立验证方 R4 实测：同一把键换个目录从 1.000/0.000 '
      + '变 0.750/0.125，且 F07「抓到」/F08「漏掉」与注入物无关。',
    // 【为什么是 A 类而不是 B 类】这里有两个东西：
    //   · 历史缺陷 = verify-goal 曾经硬编码根路径（B 类）
    //   · 但我们要测的是**现在新建的守卫能不能抓到这种缺陷**（A 类）
    // 把「硬编码」重新注入 → 守卫必须报红。这就是 A 类的形态：
    // 被测系统有缺陷，检查层应当红。
    watch: { script: 'prototype/agent-ui/verify-no-abspath.mjs' },
    defect: [{ kind: 'replaceInFile', path: 'prototype/hermes-agents/verify-goal.mjs',
      find: "const REPO = path.resolve(import.meta.dirname, '../..');",
      replace: "const REPO = 'D:/file/AI Temp/DeepSeek/Agent自研';" }],
    trigger: null,
  },
];

function run(script) {
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, script)], {
      cwd: REPO, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** 注入一组（返回按顺序的恢复函数） */
function injectAll(specs) {
  const restores = [];
  for (const spec of specs) {
    const abs = path.join(REPO, spec.path);

    if (spec.kind === 'replaceInFile') {
      const old = fs.readFileSync(abs, 'utf8');
      if (!old.includes(spec.find)) throw new Error('锚点不在：' + spec.find.slice(0, 40));
      fs.writeFileSync(abs, old.replace(spec.find, spec.replace), 'utf8');
      restores.unshift(() => fs.writeFileSync(abs, old));
    } else if (spec.kind === 'stripExitCode') {
      const old = fs.readFileSync(abs, 'utf8');
      const t = old.replace(/^process\.exit\([^;]*\);\s*$/gm, '// [fault] exit 被移除');
      if (t === old) throw new Error('没找到 process.exit');
      fs.writeFileSync(abs, t, 'utf8');
      restores.unshift(() => fs.writeFileSync(abs, old));
    } else if (spec.kind === 'revertToRoundedKb') {
      const old = fs.readFileSync(abs, 'utf8');
      // 锚点随重构更新：判定行已搬进 classify()，变量名 bytes/redBytes/allow
      let t = old.replace(
        /red: own\.filter\(\(f\) => f\.bytes > redBytes && !allow\[f\.rel\]\),/,
        'red: own.filter((f) => f.kb > RED_KB && !ALLOW[f.rel]),   // [fault] 取整判定');
      if (!t.includes('[fault] 取整判定')) throw new Error('没找到字节判定行');
      fs.writeFileSync(abs, t, 'utf8');
      restores.unshift(() => fs.writeFileSync(abs, old));
    } else if (spec.kind === 'revertEvidenceSkip') {
      const old = fs.readFileSync(abs, 'utf8');
      // 锚点随重构更新：证据缺失分支已搬进 auditDims()，且内部结构变了。
      // 现在直接让「状态为有但零证据」那个分支永远不进入。
      const t = old.replace(
        /if \(st === '有'\) \{/,
        "if (false) {   // [fault] 退回跳过「有但零证据」");
      if (t === old) throw new Error('替换失败');
      fs.writeFileSync(abs, t, 'utf8');
      restores.unshift(() => fs.writeFileSync(abs, old));
    } else if (spec.kind === 'createExactSizeFile') {
      const had = fs.existsSync(abs);
      const old = had ? fs.readFileSync(abs) : null;
      const header = '// 真实缺陷回归探针\n';
      const pad = Math.max(0, spec.bytes - Buffer.byteLength(header, 'utf8'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, header + 'x'.repeat(pad), 'utf8');
      const actual = fs.statSync(abs).size;
      if (actual !== spec.bytes) throw new Error('尺寸不符 ' + actual + ' ≠ ' + spec.bytes);
      restores.unshift(() => { if (had) fs.writeFileSync(abs, old); else if (fs.existsSync(abs)) fs.unlinkSync(abs); });
    } else if (spec.kind === 'editJson') {
      const old = fs.readFileSync(abs, 'utf8');
      const j = JSON.parse(old);
      if (spec.mutate === 'emptyFirstStrengths') {
        const v = Object.keys(j.byId).find((k) => Array.isArray(j.byId[k].strengths) && j.byId[k].strengths.length);
        if (!v) throw new Error('找不到含 strengths 的项目');
        j.byId[v].strengths = [];
      } else if (spec.mutate === 'emptyFirstUsEvidence') {
        const dim = j.dimensions.flatMap((g) => g.items).find((d) => d.us[0] === '有' && d.us.length > 1);
        if (!dim) throw new Error('找不到有证据的「有」维度');
        dim.us = ['有'];
      } else throw new Error('未知 mutate ' + spec.mutate);
      fs.writeFileSync(abs, JSON.stringify(j, null, 2) + '\n', 'utf8');
      restores.unshift(() => fs.writeFileSync(abs, old));
    } else {
      throw new Error('未知注入 ' + spec.kind);
    }
  }
  return restores;
}

console.log('');
console.log('  真实验收器召回 —— 用真实发生过的缺陷回放');
console.log('  ' + '='.repeat(78));
console.log('  与人造故障的区别：出题人不是我。这些是**真的漏过去了**的东西。');
console.log('  B 类（检查层自身缺陷）必须**缺陷态 + 触发条件**一起注入才测得出。');
console.log('');

/**
 * 判定 —— 每类缺陷有自己的「成功判据」（明写，不用猜）
 *
 * 【2026-11-15 三次迭代的教训，记下来免得再犯】
 *
 * 第一版：两类都用「缺陷态 exit != 0」→ 3/5 判错。
 *   因为 B 类（检查层自身有缺陷）注入后 exit=0 **恰恰是缺陷被复现**。
 *
 * 第二版：B 类改成「比较缺陷态 vs 修复态行为差异」→ 还是错。
 *   因为「修复态」跑的时候触发条件（探针文件/清空的数据）已经恢复掉了，
 *   于是修复态也是 exit 0 ⇒ 判成「修复没改变行为」。
 *   **这个对照根本不需要** —— 修复态跑「没有触发的干净状态」当然是 0。
 *
 * 第三版（当前）：**每类明写判据**，不搞抽象对照：
 *   A 类（被测系统有缺陷）           ⇒ 检查层必须红
 *   B 类（检查层自身有缺陷）         ⇒ 缺陷态下**必须不报**（这才是缺陷）
 *                                      且「修复的证据」是：**触发条件单独存在时它会报**
 *
 * 所以 B 类要跑两次，但第二次是「只放触发条件、不放缺陷」——
 * 那才证明「修复真的能抓到这类问题」。
 */
export function judge(d, defectRun, triggerOnlyRun) {
  const broken = (r) => r.code === 127 || (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(r.out) && !/SyntaxError/.test(r.out));

  // A 类：被测系统有缺陷 ⇒ 检查层应当红
  if (d.kind === 'A') {
    if (broken(defectRun)) return { caught: false, why: '检查跑不起来（exit ' + defectRun.code + '）' };
    if (d.watch.expectOutput) {
      const hit = defectRun.out.includes(d.watch.expectOutput);
      return hit
        ? { caught: true, why: '缺陷态 exit ' + defectRun.code + ' + 输出含「' + d.watch.expectOutput + '」' }
        : { caught: false, why: '缺陷态 exit ' + defectRun.code + ' 但缺「' + d.watch.expectOutput + '」' };
    }
    return defectRun.code !== 0
      ? { caught: true, why: '缺陷态 exit ' + defectRun.code }
      : { caught: false, why: '缺陷态 exit 0（没报）' };
  }

  // B 类：双向判据
  // ① 缺陷态必须**不报**（缺陷被成功复现）
  // ② 只放触发条件时必须**报**（修复真的能抓这类问题）
  const defectSilent = defectRun.code === 0;
  const triggerCaught = triggerOnlyRun.code !== 0;

  if (defectSilent && triggerCaught) {
    return {
      caught: true,
      why: '缺陷态 exit=0（复现了「' + d.defectEffect + '」）· 仅触发条件时 exit=' + triggerOnlyRun.code + '（修复抓到了）',
    };
  }
  if (!defectSilent) {
    return { caught: false, why: '缺陷态 exit=' + defectRun.code + ' —— 缺陷没复现（注入无效）' };
  }
  return {
    caught: false,
    why: '仅触发条件时 exit=0 —— 现在的检查抓不到这类问题（' + d.defectEffect + '）',
  };
}
/**
 * 自检 —— 反例钉住**三代判定逻辑**的错误
 *
 * 这个函数改了三版才对，每一版的错都该被钉住：
 *   第一版：A/B 两类都用「缺陷态 exit != 0」
 *     → B 类注入后 exit=0 **恰恰是缺陷被复现**，却被判成「没报」⇒ 3/5 判错
 *   第二版：B 类改成「比缺陷态 vs 修复态」
 *     → 修复态跑时触发条件已恢复，当然也 0 ⇒ 判成「修复没改变行为」，对照不成立
 *   第三版（当前）：A 类看缺陷态红不红；B 类看「缺陷态静默 + 仅触发时报」
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const R = (code, out = '') => ({ code, out });

  // ══════ A 类 ══════
  const dA = { kind: 'A', watch: {} };
  T('A 类 · 缺陷态 exit 1 → 抓到', judge(dA, R(1), R(0)).caught === true, '');
  T('A 类 · 缺陷态 exit 0 → 必须判漏', judge(dA, R(0), R(0)).caught === false,
    JSON.stringify(judge(dA, R(0), R(0))));

  const dAe = { kind: 'A', watch: { expectOutput: '损坏词' } };
  T('A 类 · 输出含期望串 → 抓到',
    judge(dAe, R(1, '... 损坏词: imporo ...'), R(0)).caught === true, '');
  T('A 类 · exit 1 但缺期望串 → 不算抓到（结构性红≠抓到）',
    judge(dAe, R(1, 'SyntaxError: something else'), R(0)).caught === false,
    JSON.stringify(judge(dAe, R(1, 'SyntaxError: something else'), R(0))));

  // ══════ B 类 ══════
  const dB = { kind: 'B', defectEffect: '漏网' };
  T('B 类 · 缺陷态 exit 0 + 仅触发 exit 1 → 抓到',
    judge(dB, R(0), R(1)).caught === true, JSON.stringify(judge(dB, R(0), R(1))));

  // 反例（第一版的错）
  const v1 = judge(dB, R(0), R(1));
  T('反例（第一版）· B 类缺陷态 exit 0 不许判成「没报」',
    v1.caught === true && !/没报/.test(v1.why), JSON.stringify(v1));

  T('反例 · B 类缺陷态 exit 1 → 判「注入无效」',
    judge(dB, R(1), R(1)).caught === false && /注入无效/.test(judge(dB, R(1), R(1)).why),
    JSON.stringify(judge(dB, R(1), R(1))));

  T('反例 · B 类缺陷态 0 + 仅触发 0 → 判漏（修了也抓不到）',
    judge(dB, R(0), R(0)).caught === false && /抓不到/.test(judge(dB, R(0), R(0)).why),
    JSON.stringify(judge(dB, R(0), R(0))));

  T('反例（第二版）· B 类判定只依赖两个 run（不引入第三个对照）',
    judge.length === 3, '形参个数=' + judge.length);

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  真实召回 · 判定逻辑自检（3 正例 + 5 反例，钉住三代逻辑的错）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}
const rounds = [];
for (let r = 0; r < RUNS; r++) {
  if (RUNS > 1) { console.log('  第 ' + (r + 1) + ' 轮'); console.log('  ' + '─'.repeat(78)); }
  const res = [];
  for (const d of DEFECTS) {
    let restores = [];
    let defectRun = { code: null, out: '' }, triggerRun = { code: null, out: '' };
    let err = '', verdict = { caught: false, why: '' };
    try {
      // ① 缺陷态 = 缺陷注入（+ 触发条件，若该缺陷需要它才显形）
      restores = injectAll([...(d.defect || []), ...(d.trigger || [])]);
      defectRun = run(d.watch.script);
      for (const f of restores) { try { f(); } catch { /* */ } }
      restores = [];

      // ② 仅触发条件 = 证明「修复真的能抓到这类问题」
      //    A 类不需要这一步（缺陷本身就是触发）
      if (d.kind === 'B' && d.trigger) {
        restores = injectAll(d.trigger);
        triggerRun = run(d.watch.script);
        for (const f of restores) { try { f(); } catch { /* */ } }
        restores = [];
      } else if (d.kind === 'B') {
        // 无独立触发条件的 B 类：缺陷本身就是触发 ⇒ 缺陷态必须**报**
        triggerRun = defectRun;
      }

      verdict = judge(d, defectRun, triggerRun);
    } catch (e) {
      err = String(e.message).slice(0, 60);
    } finally {
      for (const f of restores) { try { f(); } catch { /* */ } }
    }

    console.log('    ' + (verdict.caught ? '✓' : '✗') + ' ' + d.id + ' [' + d.kind + ']  '
      + d.name.slice(0, 40).padEnd(42) + (err ? '注入失败: ' + err : verdict.why));
    res.push({ id: d.id, kind: d.kind, name: d.name, caught: verdict.caught, why: verdict.why, err });
  }
  const measurable = res.filter((x) => !x.err);
  const caught = measurable.filter((x) => x.caught).length;
  const recall = measurable.length ? caught / measurable.length : null;
  rounds.push({ res, recall, measurable: measurable.length, injectFail: res.length - measurable.length });
  if (RUNS > 1) {
    console.log('    → recall_real = ' + caught + '/' + measurable.length + ' = '
      + (recall === null ? 'n/a' : recall.toFixed(3)));
    console.log('');
  }
}

const recalls = rounds.map((x) => x.recall);
const reproducible = recalls.length >= 2 && recalls.every((v) => v === recalls[0]);
const recall = recalls[0];
const anyFail = rounds[0].injectFail > 0;
const missed = rounds[0].res.filter((x) => !x.caught && !x.err);

let state, why;
if (anyFail) { state = 'UNKNOWN'; why = rounds[0].injectFail + ' 件注入失败，度量不完整'; }
else if (recalls.length < 2) { state = 'WARN'; why = 'recall_real ' + (recall ?? 0).toFixed(3) + ' · 单轮，可复算性未验证'; }
else if (!reproducible) { state = 'FAIL'; why = '多轮不一致 —— 度量本身不可信'; }
else if (recall === 1) { state = 'PASS'; why = '全部 ' + rounds[0].measurable + ' 件真实缺陷在缺陷态下都能被正确的检查抓到 · ' + recalls.length + ' 轮一致'; }
else { state = 'WARN'; why = 'recall_real ' + (recall ?? 0).toFixed(3) + ' · 漏掉 ' + missed.map((x) => x.id).join(','); }

const OUT = {
  what: '真实验收器召回（真实历史缺陷回放，非人造故障）',
  metric: { recallReal: recall, reproducible, runs: recalls.length, measurable: rounds[0].measurable },
  state, why,
  at: new Date().toISOString(),
  defects: DEFECTS.map((d) => ({ id: d.id, kind: d.kind, name: d.name, history: d.history })),
  rounds,
  missed: missed.map((x) => x.id),
};

const outPath = path.join(REPO, 'evidence/evolve/real-recall.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(OUT, null, 2) + '\n', 'utf8');

console.log('  ' + '='.repeat(78));
console.log('  汇总');
console.log('  ' + '─'.repeat(78));
console.log('    真实缺陷数         ' + DEFECTS.length);
console.log('    召回率 recall_real  ' + recalls.map((v) => v === null ? 'n/a' : v.toFixed(3)).join(' / ')
  + (recalls.length >= 2 ? (reproducible ? '  ✓ 一致' : '  ✗ 不一致') : '  （单轮）'));
console.log('');
console.log('  四态: ' + state + ' —— ' + why);
console.log('  → ' + path.relative(REPO, outPath));
console.log('');
process.exit(state === 'PASS' ? 0 : state === 'WARN' ? 3 : state === 'FAIL' ? 1 : 2);