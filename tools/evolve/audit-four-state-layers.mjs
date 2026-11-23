#!/usr/bin/env node
/**
 * T3 审计 —— 四态在五层都成立，且**构造不可判定场景时确实输出 UNKNOWN**
 *
 * ── T3 的判据 ────────────────────────────────────────────
 *   「PASS/WARN/FAIL/UNKNOWN 在观测→验证→记忆→改进→证明五层都成立，
 *     UNKNOWN 永不被并入通过，且构造不可判定场景时确实输出 UNKNOWN」
 *
 * 三个成分：
 *   ① 五层各自的出口都遵守四态（退出码 0/3/1/2，或输出含四态词）
 *   ② UNKNOWN **不**被算成通过（看到 UNKNOWN 时退出码必须是 2，不是 0）
 *   ③ **构造**一个不可判定场景，看它是不是真的输出 UNKNOWN
 *
 * ── 第 ③ 条是硬要求 ──────────────────────────────────────
 * 「我们有 UNKNOWN 这个状态」和「UNKNOWN 真的会被输出」是两件事。
 * 本项目已经踩过：audit-coverage 曾经对 FAIL 情形返回 exit 0，
 * 输出里写着「达标 22/22」，但脚本对 22/22 和 0/22 返回同样的 0。
 *
 * 所以这一层必须**真的构造不可判定场景**，不能只检查代码里有 UNKNOWN 字样。
 *
 * ── 怎么构造不可判定场景 ───────────────────────────────────
 *   L1 观测  把采集目标指向不存在的环境（如不存在的端口）→ 应 UNKNOWN 而非 PASS
 *   L2 验证  把验收目标换成不存在的文件 → 应 UNKNOWN 而非 PASS
 *   L3 记忆  查一条从未写入的键 → 应返回「无」而不是报错或返回假值
 *   L4 改进  台账里留一条未结案 → verify 应 FAIL；构造样本不足 → C2 拒绝
 *   L5 证明  verify-goal 在证据缺失时 → 应 UNKNOWN 而非 PASS
 *
 * 用法：node tools/evolve/audit-four-state-layers.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 备份/还原辅助 —— **还原后必须逐字节校验**。
 *
 * 【为什么需要】本文件有 3 处「临时删掉/改掉证据文件来构造不可判定场景」。
 * 原来都是 `finally { writeFileSync(path, bak) }` 就完事，**没有校验**。
 * 2026-11-18 实测代价：本会话里 `evidence/cost/prices.json` 真的被丢过一次
 * （从 875 个模型掉到 3 条测试 fixture），只能重新从网关同步。
 * 同一类「注入残留」问题在这个仓库已经复发七次。
 *
 * 所以：还原不是「写回去」，是「写回去 + 读回来 + 逐字节比对」。
 * @returns {{ok:boolean, why?:string}}
 */
/**
 * 差分判据 —— 证明「UNKNOWN 是被我构造出来的」，而不是「那个验收器本来就说 UNKNOWN」。
 *
 * 【2026-11-18 加·起因：独立审计判 FAIL，攻击 #1】
 * 原判据是「删掉依赖后，输出里有 UNKNOWN」。
 * 审计员把目标脚本换成一个**永远打印 ❔、exit 2、不做任何检查**的假验收器，
 * 审计仍然报 5/5 · 11/11 · PASS —— 核心主张被证伪。
 *
 * 根因：只验证了「UNKNOWN 出现过」，没验证「UNKNOWN 是我删依赖导致的」。
 *
 * 差分判据要求**同一个脚本跑两次**：
 *   ① 依赖在时 ⇒ 不许是 UNKNOWN（否则这个验收器本来就不会判）
 *   ② 依赖删掉 ⇒ 必须是 UNKNOWN
 * 一个「永远 UNKNOWN」的假验收器在 ① 就被抓。
 *
 * @param {{withDep: {code:number,out:string}, withoutDep: {code:number,out:string}}} runs
 * @returns {{ok:boolean, why:string}}
 */
export function differential(runs) {
  const s1 = readState(runs.withDep);
  const s2 = readState(runs.withoutDep);
  if (s1 === null) {
    return { ok: false, why: '依赖在时读不出四态（exit=' + runs.withDep.code + '）—— 无法做差分' };
  }
  if (s1 === 'UNKNOWN') {
    return {
      ok: false,
      why: '依赖在时就已经是 UNKNOWN ⇒ 它本来就判不了，删依赖后的 UNKNOWN 不能算「被构造出来」',
    };
  }
  if (s2 !== 'UNKNOWN') {
    return { ok: false, why: '删掉依赖后仍不是 UNKNOWN（读到 ' + s2 + '）—— 该验收器对缺失依赖不敏感' };
  }
  return { ok: true, why: '依赖在时 ' + s1 + ' → 删掉后 UNKNOWN（差分成立）' };
}

/**
 * 四态与退出码的一致性 —— 看到 UNKNOWN 就必须 exit 2，看到 PASS 就必须 exit 0。
 *
 * 【2026-11-18 加·起因：审计攻击 #5】
 * 原实现里这条只在 L5 生效；L2 的 readState 优先读文本，文本命中就完全忽略退出码。
 * 审计员构造「打印 ❔ 但 exit 0」的脚本，L2 判 ✓、最终 PASS ——
 * 直接违反本文件开头自己写的判据②。
 */
export function stateMatchesExit(r) {
  const s = readState(r);
  if (s === null) return { ok: false, why: '读不出四态（exit=' + r.code + '）' };
  const want = { PASS: 0, WARN: 3, FAIL: 1, UNKNOWN: 2 }[s];
  if (r.code !== want) {
    return { ok: false, why: '四态 ' + s + ' 应配 exit ' + want + '，实际 ' + r.code + '（四态与退出码不一致）' };
  }
  return { ok: true, why: s + ' / exit ' + r.code };
}

function restoreExact(filePath, bak) {
  if (bak === null) return { ok: true };            // 本来就没有，不用还原
  try {
    fs.writeFileSync(filePath, bak);
    const back = fs.readFileSync(filePath);
    if (Buffer.compare(Buffer.from(back), Buffer.from(bak)) !== 0) {
      return { ok: false, why: '还原后内容与原文件不一致（长度 ' + back.length + ' vs ' + bak.length + '）' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, why: '还原失败：' + String(e && e.message).slice(0, 80) };
  }
}

const REPO = path.resolve(import.meta.dirname, '../..');

const CODE_MEANING = { 0: 'PASS', 3: 'WARN', 1: 'FAIL', 2: 'UNKNOWN' };

/**
 * 剥掉源码里的字符串字面量与注释，只留真代码
 *   /process\.exit\(([^)]*)\)/g
 * 扫源码，把 `'node -e "process.exit(7)"'`（**字符串里的测试夹具**）
 * 当成真的 exit(7) 报了出来 —— verify-scheduler.mjs:98 就是这种情况。
 *
 * 教训：查「代码里有没有 X」时，不剥字符串/注释就是在制造误报。
 */
export function stripStringsAndComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    // 行注释
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    // 块注释
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    // 字符串（含模板串）
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++;
      out += ' STR ';   // 用占位符保持分隔，避免把前后 token 粘连
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** 检查单文件里的 process.exit 码是否都在四态集合内 */
function checkExitCodes(rel) {
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const code = stripStringsAndComments(raw);
  const bad = [];
  for (const m of code.matchAll(/process\.exit\(([^)]*)\)/g)) {
    const arg = m[1].trim();
    if (/^\d+$/.test(arg) && ![0, 1, 2, 3].includes(Number(arg))) bad.push(arg);
  }
  return bad;
}

function run(script, args = [], timeout = 300000) {
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, script), ...args], {
      cwd: REPO, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** 从输出里读四态词（优先），回退到退出码 */
export function readState(r) {
  const m = /四态:\s*(PASS|WARN|FAIL|UNKNOWN)/.exec(r.out)
    || /(✅|🟡|❌|❔)\s/.exec(r.out);
  if (m) {
    if (m[1] in { PASS: 1, WARN: 1, FAIL: 1, UNKNOWN: 1 }) return m[1];
    return ({ '✅': 'PASS', '🟡': 'WARN', '❌': 'FAIL', '❔': 'UNKNOWN' })[m[1]];
  }
  return CODE_MEANING[r.code] ?? null;
}

/**
 * 自检 —— 反例钉住两类真实 bug
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  // ── 反例 1（真实 bug）：字符串里的 process.exit(7) 不许算真代码 ──
  // 历史 bug：直接正则扫源码，把 verify-scheduler.mjs:98 的
  //   ['acc-fail', 'node -e "process.exit(7)"', 'FAIL']
  // 当成真的 exit(7) 报了出来。
  const withStr = "const x = ['a', 'node -e \"process.exit(7)\"', 'FAIL'];\nprocess.exit(1);\n";
  const stripped = stripStringsAndComments(withStr);
  T('反例 · 字符串里的 process.exit(7) → 剥掉后不存在',
    !/process\.exit\(7\)/.test(stripped) && /process\.exit\(1\)/.test(stripped),
    '剥后=' + JSON.stringify(stripped.slice(0, 80)));

  // ── 反例 2：行注释里的 process.exit(9) 也不许算 ──
  const withComment = '// process.exit(9)\nprocess.exit(0);\n';
  T('反例 · 行注释里的 process.exit(9) → 剥掉',
    !/process\.exit\(9\)/.test(stripStringsAndComments(withComment)), '未剥干净');

  // ── 反例 3：块注释里的 ──
  const withBlock = '/* process.exit(5) */\nprocess.exit(2);\n';
  T('反例 · 块注释里的 process.exit(5) → 剥掉',
    !/process\.exit\(5\)/.test(stripStringsAndComments(withBlock)), '未剥干净');

  // ── 正例 1：真代码保留 ──
  T('正例 · 真代码里的 process.exit(2) 保留',
    /process\.exit\(2\)/.test(stripStringsAndComments('process.exit(2);')), '被误剥');

  // ── 正例 2：readState 从四态词读 ──
  const r1 = readState({ code: 0, out: '  四态: UNKNOWN —— x' });
  T('正例 · 读「四态: UNKNOWN」', r1 === 'UNKNOWN', 'got=' + r1);
  const r2 = readState({ code: 0, out: '  ❔ 某某' });
  T('正例 · 读 emoji ❔', r2 === 'UNKNOWN', 'got=' + r2);
  // ── 正例 3：没有四态词时退回退出码 ──
  const r3 = readState({ code: 3, out: 'nothing' });
  T('正例 · 无四态词时按退出码 3 → WARN', r3 === 'WARN', 'got=' + r3);
  // ── 反例 4：退出码 7 不在四态里 → 必须返回 null（不许乱猜）──
  const r4 = readState({ code: 7, out: 'nothing' });
  T('反例 · 未知退出码 7 → 返回 null（不许猜）', r4 === null, 'got=' + r4);

  // ══════════════════════════════════════════════════════════════
  // 反例 5-8：钉住**这个审计器自己的核心判据**。
  //
  // 【2026-11-18 加·起因：独立审计攻击 #4】
  // 审计员把 L5 的 `isUnknown = undState && undState[1]==='❔' && und.code===2`
  // 改成 `isUnknown = !!undState`（有输出就算过），再配一个「从不输出 UNKNOWN」的目标，
  // 审计仍然 PASS 5/5 · 11/11，**而且它的 --selftest 仍然 8/8 全绿**。
  // 也就是说：核心判据被削弱时，它自己不会红。
  // ══════════════════════════════════════════════════════════════

  // 反例 5：永远输出 UNKNOWN 的假验收器，差分必须判不成立
  {
    const stub = { code: 2, out: '❔ C6 —— 我什么都不检查' };
    const d = differential({ withDep: stub, withoutDep: stub });
    T('★反例 · 永远输出 UNKNOWN 的假验收器 ⇒ 差分必须不成立（这是审计攻击 #1 的核心）',
      d.ok === false && /本来就判不了/.test(d.why), d.why);
  }
  // 反例 6：依赖在时正常、删掉后不是 UNKNOWN ⇒ 差分不成立（验收器对缺失依赖不敏感）
  {
    const d = differential({
      withDep: { code: 0, out: '✅ C6 正常' },
      withoutDep: { code: 0, out: '✅ C6 还是正常' },
    });
    T('★反例 · 删依赖后仍报 PASS ⇒ 差分不成立（对缺失依赖不敏感）',
      d.ok === false && /不敏感/.test(d.why), d.why);
  }
  // 正例 4：真差分成立
  {
    const d = differential({
      withDep: { code: 0, out: '✅ C6 正常' },
      withoutDep: { code: 2, out: '❔ C6 价格表不存在' },
    });
    T('正例 · 依赖在 PASS → 删掉后 UNKNOWN ⇒ 差分成立', d.ok === true, d.why);
  }
  // 反例 7：四态 UNKNOWN 但 exit 0 ⇒ 一致性必须不成立（审计攻击 #5）
  {
    const s = stateMatchesExit({ code: 0, out: '❔ C6' });
    T('★反例 · 输出 UNKNOWN 但 exit 0 ⇒ 一致性必须不成立（审计攻击 #5）',
      s.ok === false && /不一致/.test(s.why), s.why);
  }
  // 反例 8：四态 PASS 但 exit 1 ⇒ 一致性必须不成立
  {
    const s = stateMatchesExit({ code: 1, out: '✅ C6' });
    T('★反例 · 输出 PASS 但 exit 1 ⇒ 一致性必须不成立', s.ok === false && /不一致/.test(s.why), s.why);
  }
  // 正例 5：四态与退出码一致
  {
    T('正例 · UNKNOWN + exit 2 一致', stateMatchesExit({ code: 2, out: '❔ C6' }).ok === true, '');
    T('正例 · PASS + exit 0 一致', stateMatchesExit({ code: 0, out: '✅ C6' }).ok === true, '');
  }

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  T3 审计器 · 自检（5 正例 + 8 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

const results = [];

// ══════════════════════════════════════════════════════════
// L1 观测层 —— 构造「观测不到」的场景
// ══════════════════════════════════════════════════════════
{
  const script = 'tools/state/collect.mjs';
  const label = 'L1 观测层';
  if (!fs.existsSync(path.join(REPO, script))) {
    results.push({ layer: label, script, ok: false, why: '脚本不存在', cases: [] });
  } else {
    const cases = [];

    // ① 正常跑：应当 PASS（或至少给出四态）
    const normal = run(script);
    const normalState = readState(normal);
    cases.push({
      name: '正常采集 → 有明确四态',
      ok: normalState !== null,
      detail: 'exit=' + normal.code + ' state=' + (normalState ?? '读不出'),
    });

    // ② 构造真正的不可判定场景：把网关地址指到一个没人监听的端口
    //
    // 【2026-11-15 修 · 本审计自己的误判】第一版是传一个未知参数
    // `--probe-nonexistent-target-xyz` 然后期望它「不冒充 PASS」。
    // 那测的是**CLI 对未知参数的处理**，不是四态 —— 采集器忽略未知参数是正常行为，
    // 第一版因此把 collect.mjs 判成「不可判定场景下仍报 PASS」，其实是我的用例不成立。
    //
    // 为了能真的构造出 UNKNOWN，给 collect.mjs 的网关地址加了
    // GATEWAY_URL 环境变量覆盖（这本身也是可测性改进）。
    const env = { ...process.env, GATEWAY_URL: 'http://127.0.0.1:59999/v1/models' };
    let und = { code: null, out: '' };
    try {
      const out = execFileSync(process.execPath, [path.join(REPO, script), '--json'], {
        cwd: REPO, encoding: 'utf8', timeout: 300000, env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      und = { code: 0, out };
    } catch (e) {
      und = { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
    }
    const unknowCount = (und.out.match(/"state":\s*"UNKNOWN"/g) || []).length;
    cases.push({
      name: '构造不可判定（网关指向不可达端口）→ 报 UNKNOWN',
      // 【2026-11-18 修·审计攻击 #2】原来只数整个 JSON 里 "state": "UNKNOWN" 的出现次数 > 0。
    // 实测：本机 9333/48032 两个端口天然关闭，任何一次采集都有 3 个 UNKNOWN ⇒
    // 把网关换成必然 PASS 的 data: URL，计数仍是 3，用例照样 ✓ ⇒ 这条用例不具区分力。
    // 现在必须**点名 gateway 这一段**是 UNKNOWN，因为构造的就是「网关不可达」。
    ok: /"gateway"\s*:\s*\{[^}]*"state"\s*:\s*"UNKNOWN"/.test(String(und?.out ?? '')),
      detail: 'UNKNOWN 出现 ' + unknowCount + ' 次 · exit=' + und.code,
    });

    results.push({
      layer: label, script, cases,
      ok: cases.every((c) => c.ok),
      why: normalState ? '正常态 ' + normalState : '读不出四态',
    });
  }
}

// ══════════════════════════════════════════════════════════
// L2 验证层 —— 25 个 verify-*.mjs 都要能给四态
// ══════════════════════════════════════════════════════════
{
  const label = 'L2 验证层';
  const dir = path.join(REPO, 'prototype/agent-ui');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^verify-.*\.mjs$/.test(f)) : [];
  const cases = [];

  // 不逐个跑（太慢）。用一个代表 + 检查全部是否都遵守退出码约定。
  // 代表选 verify-cost（快、有明确四态输出）
  const rep = 'prototype/agent-ui/verify-cost.mjs';
  const r = run(rep);
  cases.push({
    name: '代表 verify-cost 给出四态',
    ok: readState(r) !== null,
    detail: 'exit=' + r.code + ' state=' + (readState(r) ?? '读不出'),
  });

  // 全部脚本：退出码必须在 {0,1,2,3} 里（不许出现 4/5/127 这类未定义码）
  //   注意：必须**剥掉字符串与注释**再扫，否则会把
  //   'node -e "process.exit(7)"' 这种测试夹具误报成真 exit(7)
  //   （verify-scheduler.mjs:98 就是这种情况 —— 第一版在这里误判过）
  const illegal = [];
  for (const f of files) {
    for (const badCode of checkExitCodes('prototype/agent-ui/' + f)) {
      illegal.push(f + ' → exit(' + badCode + ')');
    }
  }
  cases.push({
    name: '所有 verify-* 的退出码只在 {0,1,2,3}',
    ok: illegal.length === 0,
    detail: illegal.length ? illegal.slice(0, 4).join('; ') : files.length + ' 个脚本全部合规',
  });

  // 构造不可判定：verify-cost 在没有价格表时应 UNKNOWN
  const pricePath = path.join(REPO, 'evidence/cost/prices.json');
  const ledgerPath = path.join(REPO, 'evidence/cost/ledger.json');
  const bakPrice = fs.existsSync(pricePath) ? fs.readFileSync(pricePath) : null;
  let undecidable = { code: null, out: '' };
  try {
    if (bakPrice) fs.unlinkSync(pricePath);
    undecidable = run(rep);
  } finally {
    const r = restoreExact(pricePath, bakPrice);
    if (!r.ok) throw new Error('[audit-four-state-layers] 价格表还原失败：' + r.why);
  }
  // 【2026-11-18 修·差分】原判据是 `readState(undecidable) === 'UNKNOWN'`，
  // 一个「永远 UNKNOWN」的假验收器就能通过（审计攻击 #1 实证）。
  // 现在必须证明「依赖在时不是 UNKNOWN、删掉后才是」。
  const undState = readState(undecidable);
  const diff = differential({ withDep: r, withoutDep: undecidable });
  cases.push({
    name: '构造不可判定（删掉价格表）→ 差分成立（依赖在时不是 UNKNOWN，删掉后才是）',
    ok: diff.ok,
    detail: diff.why + ' · 删除后 exit=' + undecidable.code + ' state=' + (undState ?? '读不出'),
  });
  cases.push({
    name: '四态与退出码一致（UNKNOWN 必须 exit 2，不许 exit 0）',
    ok: stateMatchesExit(undecidable).ok,
    detail: stateMatchesExit(undecidable).why,
  });

  results.push({ layer: label, script: '25 个 verify-*.mjs', cases, ok: cases.every((c) => c.ok), why: '' });
}

// ══════════════════════════════════════════════════════════
// L3 记忆层 —— 构造「查不到」的场景
// ══════════════════════════════════════════════════════════
{
  const label = 'L3 记忆层';
  const script = 'tools/memory/store.mjs';
  const cases = [];
  if (!fs.existsSync(path.join(REPO, script))) {
    results.push({ layer: label, script, ok: false, why: '脚本不存在', cases: [] });
  } else {
    const st = run(script, ['--selftest']);
    const concl = /结论:\s*✓\s*(\d+)\/(\d+)/.exec(st.out);
    cases.push({
      name: '自检通过（含 TTL / supersede 反例）',
      ok: !!concl && concl[1] === concl[2],
      detail: concl ? concl[1] + '/' + concl[2] : '无结论',
    });

    // 构造不可判定：查一条从未写入的键 → 必须返回「空」而不是假值
    const lookup = run(script, ['get', '--key', '__never_written_key_xyz__']);
    const saysFound = /找到|命中|"value"/.test(lookup.out) && !/未找到|没有|为空|none|not found/i.test(lookup.out);
    cases.push({
      name: '查不存在的键 → 不返回假值',
      ok: !saysFound,
      detail: 'exit=' + lookup.code + (saysFound ? '  ← 声称找到了' : ' 未声称找到'),
    });

    results.push({ layer: label, script, cases, ok: cases.every((c) => c.ok), why: '' });
  }
}

// ══════════════════════════════════════════════════════════
// L4 改进层 —— 构造「样本不足 / 未结案」
// ══════════════════════════════════════════════════════════
{
  const label = 'L4 改进层';
  const script = 'tools/evolve/evolve.mjs';
  const cases = [];

  const st = run(script, ['--selftest']);
  const concl = /结论:\s*✓\s*(\d+)\/(\d+)/.exec(st.out);
  cases.push({
    name: '自检通过（含 C2/C4/C5 反例）',
    ok: !!concl && concl[1] === concl[2],
    detail: concl ? concl[1] + '/' + concl[2] : '无结论',
  });

  // 构造不可判定：样本不足 → 必须拒绝下判定（C2）
  // 用一个临时台账避免污染真台账
  const L = path.join(REPO, 'research/改进台账.json');
  const bak = fs.existsSync(L) ? fs.readFileSync(L) : null;
  let insufficient = { code: 0, out: '' };
  try {
    // 先登记一条合法假设，再用样本 3 结案
    const reg = run(script, ['register', '--obs', 'T3 构造的观测值 0.5',
      '--hypo', 'T3 构造的假设：样本不足时不许下判定',
      '--metric', 'T3-probe', '--baseline', '0.5', '--expect', 'up',
      '--criterion', '样本 ≥8 才许判定', '--by', 'lead']);
    const id = /登记 (H-\d{4})/.exec(reg.out);
    if (id) {
      insufficient = run(script, ['record', '--id', id[1], '--after', '1.0',
        '--samples', '3', '--verdict', 'keep', '--verifier', 'lead']);
    }
  } finally {
    const r = restoreExact(L, bak);
    if (!r.ok) throw new Error('[audit-four-state-layers] 台账还原失败：' + r.why);
  }
  // 【2026-11-17 修·判据对齐实质】原来只认 exit≠0。但 evolve 的既定设计是
  // 「样本不足 ⇒ 记为 UNKNOWN，不下判定（不是拒写）」（见 commit 1a5c9590：
  // 拒写会让 unknown 条目永久死锁）。所以真正该验的是**实质**：
  //   ① 输出里出现 C2 说明；② 该条最终状态**不是 closed**（不许被当结案）。
  // 只认退出码会把正确实现判成失败（假红），也会漏掉「exit≠0 但其实写成了 closed」。
  const mentionedC2 = /C2/.test(insufficient.out);
  const statusM = /状态\s+(\w+)/.exec(insufficient.out);
  const finalStatus = statusM ? statusM[1] : '(未知)';
  const notClosed = finalStatus !== 'closed';
  const rejected = mentionedC2 && notClosed;
  cases.push({
    name: '构造样本不足（3<8）→ C2 不下判定（不变成 closed）',
    ok: rejected,
    detail: 'exit=' + insufficient.code + ' · C2=' + (mentionedC2 ? '有' : '无') + ' · 最终状态=' + finalStatus
      + (rejected ? ' 已按 C2 处理' : '  ← 竟然当成了判定'),
  });

  results.push({ layer: label, script, cases, ok: cases.every((c) => c.ok), why: '' });
}

// ══════════════════════════════════════════════════════════
// L5 证明层 —— verify-goal 在证据缺失时应 UNKNOWN
// ══════════════════════════════════════════════════════════
{
  const label = 'L5 证明层';
  const script = 'prototype/hermes-agents/verify-goal.mjs';
  const cases = [];

  const r = run(script, ['--only', 'R10']);
  const st = /✅ R10|🟡 R10|❌ R10|❔ R10/.exec(r.out);
  cases.push({
    name: '正常跑 → 有明确四态',
    ok: !!st,
    detail: st ? st[0] : '读不出',
  });

  /**
   * 构造不可判定：删掉价格表 → C6 验收器判不了 → verify-goal 该报 UNKNOWN
   *
   * 【2026-11-15 修 · 第二轮复审 A6 的主反驳】
   * 原来这一格是这样写的：
   *   清空矩阵维度 → 看 R2 是不是「不是 ✅」→ ok
   * 后果：R2 实际输出 **❌（FAIL）**，而判据 `!== '✅'` 把 FAIL 也放行了，
   * 汇总却宣称「不可判定场景均正确输出 UNKNOWN」、T3 判 5/5 PASS。
   *
   * **FAIL ≠ UNKNOWN。** T3 要求的是「构造不可判定场景时确实输出 UNKNOWN」，
   * 不是「不输出 PASS」。前者证明系统会说「我判不了」，后者只证明它会说「坏了」——
   * 那是两种完全不同的能力，后者任何系统都有。
   *
   * 现在改用 R10（C6 成本）：删掉 prices.json ⇒ C6 验收器返回 UNKNOWN ⇒
   * verify-goal R10 输出 ❔ 且 exit 2。判据收紧为**必须恰好是 UNKNOWN**。
   */
  const PRICE = path.join(REPO, 'evidence/cost/prices.json');
  const bakPrice = fs.existsSync(PRICE) ? fs.readFileSync(PRICE) : null;
  // 【2026-11-18 加】差分基线：依赖在时先跑一次。没有这个基线，
  // 「删依赖后是 UNKNOWN」就不能证明是**我删的**导致的（审计攻击 #1）。
  const n5 = run(script, ['--only', 'R10']);
  let und = { code: 0, out: '' };
  try {
    if (bakPrice) fs.unlinkSync(PRICE);
    und = run(script, ['--only', 'R10']);
  } finally {
    const r = restoreExact(PRICE, bakPrice);
    if (!r.ok) throw new Error('[audit-four-state-layers] 价格表还原失败：' + r.why);
  }
  const undState = /(✅|🟡|❌|❔) R10/.exec(und.out);
  const isUnknown = undState && undState[1] === '❔' && und.code === 2;
  cases.push({
    name: '构造不可判定（删价格表）→ 必须恰好是 UNKNOWN',
    ok: !!isUnknown,
    detail: (undState ? undState[0] : '读不出') + ' · exit=' + und.code
      + (isUnknown ? '' : '  ← 不是 UNKNOWN（FAIL/WARN 都算不合格）'),
  });

  // 【2026-11-18 加·差分】上面那格只要求「输出 ❔ 且 exit 2」——
  // 审计攻击 #1 用一个永远打印 ❔ 的假脚本就满足了它。
  // 差分要求：同一个脚本，依赖在时必须**不是** UNKNOWN。
  const diff5 = differential({ withDep: n5, withoutDep: und });
  cases.push({
    name: 'L5 差分成立（依赖在时不是 UNKNOWN，删掉后才是）',
    ok: diff5.ok,
    detail: diff5.why,
  });

  results.push({ layer: label, script, cases, ok: cases.every((c) => c.ok), why: '' });
}

// ── 汇总 ──
const allCases = results.flatMap((r) => r.cases);
const passedCases = allCases.filter((c) => c.ok).length;
const layersOk = results.filter((r) => r.ok).length;

console.log('');
console.log('  T3 审计 —— 四态在五层都成立 · 且不可判定场景确实输出 UNKNOWN');
console.log('  ' + '='.repeat(80));
console.log('');

for (const r of results) {
  console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.layer.padEnd(12) + r.script);
  for (const c of r.cases) {
    console.log('      ' + (c.ok ? '✓' : '✗') + ' ' + c.name.padEnd(42) + c.detail);
  }
  if (r.why) console.log('      · ' + r.why);
  console.log('');
}

// 【2026-11-18 修·审计攻击 #3/#8】
// 原来是 `layersOk === 0 ? 'FAIL' : passedCases > 0 ? 'WARN' : 'FAIL'` ——
// 1~4 层坏掉一律 WARN。审计员实测：把 L5 换成「从不输出 UNKNOWN」的脚本，
// 汇总报 4/5 · 10/11 · WARN · exit 3，**单层完全坏掉也报不了红**。
// 这个验收器的职责是「反例必须报红」，红线这么软等于它自己可以被骗过去。
//
// 现在：**任何一层不达标就是 FAIL**。WARN 只留给「五层都达标但有用例是 WARN 级」的情形
// （目前没有这种用例，所以实际上 WARN 不会出现 —— 如实标注）。
const state = layersOk === results.length ? 'PASS' : 'FAIL';

console.log('  ' + '─'.repeat(80));
console.log('  五层达标 ' + layersOk + '/' + results.length + ' · 用例 ' + passedCases + '/' + allCases.length);
console.log('');
console.log('  四态: ' + state + ' —— ' + (
  state === 'PASS' ? '五层四态贯通，不可判定场景均正确输出 UNKNOWN'
    : layersOk + '/' + results.length + ' 层达标 —— **有层不达标就是 FAIL**（不许用 WARN 掩盖）'
));

const OUT = {
  what: 'T3 审计：五层四态贯通 + 不可判定场景',
  at: new Date().toISOString(),
  state, layersOk, totalLayers: results.length, passedCases, totalCases: allCases.length,
  results,
};
const outPath = path.join(REPO, 'evidence/evolve/four-state-layers.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(OUT, null, 2) + '\n', 'utf8');
console.log('  → ' + path.relative(REPO, outPath));
console.log('');

if (process.argv.includes('--json')) console.log(JSON.stringify(OUT, null, 2));
process.exit(state === 'PASS' ? 0 : state === 'WARN' ? 3 : state === 'FAIL' ? 1 : 2);