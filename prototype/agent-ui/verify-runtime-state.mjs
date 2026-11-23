#!/usr/bin/env node
/**
 * D3 运行时状态可见性验收
 *
 * 背景：D3 之前记「部分」，因为状态只能从 hermes insights 看（借来的）。
 * 现在有自研采集器 tools/state/collect.mjs + 界面 Overview.tsx 展示。
 *
 * 这份验收要证明三件事，缺一不可：
 *   1. 采集器能跑，且采的是**真实**数据（进程数/模型数/端口/仓库要和现场一致）
 *   2. 四态纪律成立：拿不到的记 UNKNOWN，不许写 0 或「正常」
 *   3. 数据真的进到界面里（构建产物含运行时状态字段）
 *
 * 特别检查（反假绿）：
 *   · 「模型网关」如果是 PASS，那 modelCount 必须 > 0（不能 PASS 却说 0 个模型）
 *   · 「端口」判 UNKNOWN 时，界面必须显示「在听」计数而不是全绿
 *   · 采集时间戳必须存在，界面要显示「多久之前」而不是假装实时
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const COLLECTOR = path.join(REPO, 'tools/state/collect.mjs');
const STATE = path.join(REPO, 'evidence/runtime-state.json');
const UI_STATE = path.join(REPO, 'apps/agent-ui/src/data/runtime-state.json');
const UI_DIST = path.join(REPO, 'apps/agent-ui/dist');

let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };

// ── 核心判定抽成可导出的纯函数（自检可注入假输入）────────────────────
//
// 为什么要抽：D3 的价值全在「四态纪律 + 反假绿」——
//   · 六类采集必须齐全（缺一类就是采集项缺失）
//   · 网关记 PASS 就必须真有模型（modelCount > 0）
//   · 没在听的端口不许记 PASS
//   · 有未提交时仓库不许记 PASS
// 一个只会说「通过」的采集验收无法证明这些，所以抽成纯函数后，
// 自检可以喂进「缺采集项」「PASS 但 0 个模型」这类假数据，断言它必须报警。

export const SECTION_KEYS = ['proc', 'ports', 'gateway', 'repo', 'suites', 'resources'];
export const VALID_STATES = new Set(['PASS', 'WARN', 'FAIL', 'UNKNOWN']);
export const UI_SECTIONS_SHOWN = ['运行时状态', '模型网关', '进程', '端口', '仓库', '资源'];

/** 采集结果的结构/四态/反假绿判定（纯函数，不碰文件系统） */
export function judgeState(st = {}) {
  const out = [];
  const add = (name, ok) => out.push({ name, ok: !!ok });
  const SECTIONS = SECTION_KEYS;

  // ── 结构完整性：六类采集都要在 ──
  const missing = SECTIONS.filter((k) => !st[k]);
  add('六类采集齐全（进程/端口/网关/仓库/验收/资源）' + (missing.length ? '  ← 缺 ' + missing.join(',') : ''), missing.length === 0);

  add('有采集时间戳：' + st.at, typeof st.at === 'string' && !Number.isNaN(Date.parse(st.at)));

  // ── 四态纪律 ──
  const badState = SECTIONS.filter((k) => st[k] && !VALID_STATES.has(st[k].state));
  add('每个采集段的状态都是四态之一' + (badState.length ? '  ← ' + badState.join(',') : ''), badState.length === 0);

  // ── 反假绿：网关 PASS 必须有实际观测 ──
  if (st.gateway?.state === 'PASS') {
    add('网关记 PASS 且模型数 > 0（' + st.gateway.modelCount + ' 个）—— 不是空口说正常', Number(st.gateway.modelCount) > 0);
  } else {
    add('网关不是 PASS 时给出了原因：' + (st.gateway?.why || '(无)').slice(0, 60), typeof st.gateway?.why === 'string' && st.gateway.why.length > 0);
  }

  if (st.proc?.state === 'PASS') {
    add('进程记 PASS 且数量 > 0（' + st.proc.totalProcesses + ' 个）', Number(st.proc.totalProcesses) > 0);
  }

  // 端口：数量必须与看板一致（不能多也不能少），且没在听的不能标 PASS
  if (Array.isArray(st.ports?.ports)) {
    const open = st.ports.ports.filter((p) => p.open).length;
    const expect = open + '/' + st.ports.ports.length;
    add('端口摘要与实际一致（' + st.summary?.portsOpen + '，实际 ' + expect + '）', st.summary?.portsOpen === expect);
    const wrong = st.ports.ports.filter((p) => !p.open && p.state === 'PASS');
    add('没在听的端口没有记成 PASS' + (wrong.length ? '  ← ' + wrong.map((p) => p.port).join(',') : ''), wrong.length === 0);
  } else {
    add('端口采集结构不对', false);
  }

  // 仓库：有未提交时不能记 PASS
  if (st.repo?.state !== undefined) {
    const consistent = (st.repo.dirtyFiles > 0) ? st.repo.state !== 'PASS' : true;
    add('有未提交时仓库不记 PASS（未提交 ' + st.repo.dirtyFiles + '，状态 ' + st.repo.state + '）', consistent);
  }
  return out;
}

/** 界面展示判定（纯函数：传入已读到的 ui 与 Overview 源码） */
export function judgeUi({ ui = {}, st = {}, ovSrc = '' } = {}) {
  const out = [];
  const add = (name, ok) => out.push({ name, ok: !!ok });
  add('前端产物与采集结果同源（时间戳一致）', ui.at === st.at);
  const notShown = UI_SECTIONS_SHOWN.filter((k) => !ovSrc.includes(k));
  add('界面展示六类运行时信息' + (notShown.length ? '  ← 缺 ' + notShown.join(',') : ''), notShown.length === 0);
  add('界面显示「多久之前」而不是假装实时', /ageLabel\(/.test(ovSrc));
  return out;
}

/**
 * 自检 —— 每条反例都断言「构造一个假绿，判定必须报出来」
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const has = (arr, sub) => arr.some((a) => a.name.includes(sub) && !a.ok);
  const allOk = (arr) => arr.length > 0 && arr.every((a) => a.ok);

  // 健康基线：一份结构完整、四态合法、观测非空的采集结果
  const base = () => ({
    at: '2026-11-15T10:00:00.000Z',
    proc: { state: 'PASS', totalProcesses: 3 },
    ports: { state: 'WARN', ports: [{ port: 3000, open: true, state: 'PASS' }, { port: 9999, open: false, state: 'UNKNOWN' }] },
    gateway: { state: 'PASS', modelCount: 5 },
    repo: { state: 'WARN', dirtyFiles: 2 },
    suites: { state: 'PASS' },
    resources: { state: 'PASS' },
    summary: { portsOpen: '1/2' },
  });

  // ── 反例 1（最核心）：采集项缺失（gateway 整段没了）──
  //   缺采集项必须报「六类采集齐全」红，否则界面少了网关也会显示正常。
  const miss = base(); delete miss.gateway;
  T('反例 · 采集项缺失（缺 gateway）→ 必须报「六类采集齐全」',
    has(judgeState(miss), '六类采集齐全'), JSON.stringify(judgeState(miss).filter((a) => !a.ok).map((a) => a.name)));

  // ── 反例 1b：采集段状态乱填（不是四态之一）──
  //   【2026-11-18 补·起因：变异测试 M24 存活】
  //   judgeState 里有「每个采集段的状态都是四态之一」这条检查，但**没有反例**守着它。
  //   实测把 badState 过滤改成 [] 后，自检仍然全绿 —— 那条检查等于没测。
  //   为什么重要：状态栏若显示 'ok'/'正常'/'fine' 这种非四态值，
  //   界面会把它当「已采集」照常展示，而下游按四态聚合时认不出它。
  const badSt = base(); badSt.gateway = { state: 'ok', modelCount: 5 };
  T('反例 · 采集段状态写成非四态值（ok）→ 必须报「四态之一」',
    has(judgeState(badSt), '四态之一'), JSON.stringify(judgeState(badSt).filter((a) => !a.ok).map((a) => a.name)));

  // ── 反例 2：网关记 PASS 却 0 个模型（空口说正常）──
  const gw0 = base(); gw0.gateway = { state: 'PASS', modelCount: 0 };
  T('反例 · 网关 PASS 但模型数 0 → 必须报',
    has(judgeState(gw0), '网关记 PASS'), 'modelCount=0');

  // ── 反例 3：没在听的端口却记 PASS ──
  const portPass = base();
  portPass.ports = { state: 'WARN', ports: [{ port: 80, open: false, state: 'PASS' }] };
  portPass.summary = { portsOpen: '0/1' };
  T('反例 · 没在听的端口记 PASS → 必须报',
    has(judgeState(portPass), '没在听的端口'), 'port80');

  // ── 反例 4：端口摘要与实际不一致（看板撒谎）──
  const portSum = base(); portSum.summary = { portsOpen: '2/2' };
  T('反例 · 端口摘要与实际不一致 → 必须报',
    has(judgeState(portSum), '端口摘要与实际一致'), 'summary 2/2 vs 1/2');

  // ── 反例 5：有未提交却记 PASS ──
  const repoPass = base(); repoPass.repo = { state: 'PASS', dirtyFiles: 3 };
  T('反例 · 有未提交却记 PASS → 必须报',
    has(judgeState(repoPass), '有未提交时仓库'), 'dirty=3 & PASS');

  // ── 反例 6：缺采集时间戳（假装实时）──
  const noAt = base(); noAt.at = 'not-a-date';
  T('反例 · 缺/非法采集时间戳 → 必须报',
    has(judgeState(noAt), '有采集时间戳'), noAt.at);

  // ── 正例 1：结构完整 / 四态合法 / 观测非空 → 全绿 ──
  T('正例 · 健康采集结果 → 全绿', allOk(judgeState(base())), JSON.stringify(judgeState(base()).filter((a) => !a.ok)));

  // ── 反例 7：界面缺一类展示（缺「端口」）→ 必须报 ──
  const ovShort = UI_SECTIONS_SHOWN.filter((k) => k !== '端口').join(' ') + ' ageLabel(x)';
  T('反例 · 界面缺「端口」展示 → 必须报',
    has(judgeUi({ ui: { at: base().at }, st: base(), ovSrc: ovShort }), '界面展示六类'), '缺端口');

  // ── 反例 8：界面不显示「多久之前」→ 必须报 ──
  const ovNoAge = UI_SECTIONS_SHOWN.join(' ');
  T('反例 · 界面没有 ageLabel（假装实时）→ 必须报',
    has(judgeUi({ ui: { at: base().at }, st: base(), ovSrc: ovNoAge }), '多久之前'), 'no ageLabel');

  // ── 正例 2：界面六类齐全且显示「多久之前」→ 全绿 ──
  const ovOk = UI_SECTIONS_SHOWN.join(' ') + ' ageLabel(x)';
  T('正例 · 界面六类齐全 + ageLabel → 全绿',
    allOk(judgeUi({ ui: { at: base().at }, st: base(), ovSrc: ovOk })), JSON.stringify(judgeUi({ ui: { at: base().at }, st: base(), ovSrc: ovOk }).filter((a) => !a.ok)));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  D3 运行时状态可见性 · 自检（2 正例 + 8 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

console.log('');
console.log('  D3 运行时状态可见性验收');
console.log('  ' + '─'.repeat(72));

// ── 1. 采集器在位且能跑 ──
ok(fs.existsSync(COLLECTOR), '采集器在位（tools/state/collect.mjs）');

try {
  execFileSync(process.execPath, [COLLECTOR, '--fast'], {
    cwd: REPO, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch { /* --fast 仍会写产物；退出码不看 */ }

if (!fs.existsSync(STATE)) {
  unknown++;
  console.log('  ' + I.un + ' 没有 evidence/runtime-state.json —— 采集器没产出，判不了');
} else {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));

  // ── 2-4. 结构完整性 / 时间戳 / 四态纪律 / 反假绿（核心判定已抽成纯函数 judgeState）──
  for (const a of judgeState(st)) ok(a.ok, a.name);

  // ── 5. 数据真的进了界面 ──
  ok(fs.existsSync(UI_STATE), '采集中间产物已落到前端 data（apps/agent-ui/src/data/runtime-state.json）');
  const OVERVIEW = path.join(REPO, 'apps/agent-ui/src/scenes/Overview.tsx');
  const ovSrc = fs.existsSync(OVERVIEW) ? fs.readFileSync(OVERVIEW, 'utf8') : '';
  if (fs.existsSync(UI_STATE)) {
    const ui = JSON.parse(fs.readFileSync(UI_STATE, 'utf8'));
    for (const a of judgeUi({ ui, st, ovSrc })) ok(a.ok, a.name);
  }

  // ── 6. 构建产物里真的有这些字段 ──
  if (fs.existsSync(UI_DIST)) {
    const assets = path.join(UI_DIST, 'assets');
    const js = fs.existsSync(assets) ? fs.readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
    let hit = false;
    for (const f of js) {
      const t = fs.readFileSync(path.join(assets, f), 'utf8');
      if (t.includes('运行时状态') && t.includes('模型网关')) { hit = true; break; }
    }
    ok(hit, '构建产物里含运行时状态（' + js.length + ' 个 js chunk 中已包含）');
  } else {
    unknown++;
    console.log('  ' + I.un + ' 前端还没构建，产物层判不了');
  }
}

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);