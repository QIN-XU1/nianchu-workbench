#!/usr/bin/env node
/**
 * A3 联网验收 —— 搜索 + 抓取 + 真的进到界面
 *
 * 背景：A3 之前记「部分」，证据原话：
 *   「联网能力来自 hermes 基线…我们没有自己的实现。我们自研的只有取证用途的抓取脚本。」
 *
 * 现在有 tools/net/search.mjs（搜索）+ tools/net/fetch.mjs（抓取），并接进了界面。
 *
 * 三层验收，缺一层都不算「有」：
 *   1. 解析器（离线可验，不依赖网络）
 *      · HTML 正文提取：去 script/style、抽 title、解实体（含数字实体）、块级换行
 *      · 搜索结果解析：Bing 结构 + DuckDuckGo 结构 + uddg 还原真实 URL
 *   2. 真实联网（会受网络影响，连不上记 UNKNOWN 而不是 FAIL）
 *      · 搜索能拿到真结果
 *      · 抓取能提出正文
 *   3. 进到界面（这是「产品的一部分」而不是命令行脚本）
 *      · net.json 有真实数据
 *      · Net.tsx 展示四块：统计 / 搜索结果 / 抓取正文 / 后端可达性
 *      · 构建产物里能找到
 *
 * 特别断言（反假绿）：
 *   · 后端可达性表里，不可达的必须记 UNKNOWN/FAIL，不许记 PASS
 *   · 搜索 state=UNKNOWN 时，results 必须为空（不许连不上却给出结果）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const SEARCH = path.join(REPO, 'tools/net/search.mjs');
const FETCH = path.join(REPO, 'tools/net/fetch.mjs');
const GEN = path.join(REPO, 'tools/net/gen-ui-data.mjs');
const NET_JSON = path.join(REPO, 'apps/agent-ui/src/data/net.json');
const NET_TSX = path.join(REPO, 'apps/agent-ui/src/scenes/Net.tsx');
const DIST = path.join(REPO, 'apps/agent-ui/dist');

let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };
const un = (m) => { unknown++; console.log('  ' + I.un + ' ' + m); };

// ── 核心判定抽成可导出的纯函数（自检可注入假输入）────────────────────
//
// 为什么要抽：这段判定的价值全在「反假绿」——
//   · 搜索记 UNKNOWN（连不上）时不许带结果
//   · 后端不可达时不许记 PASS
//   · 搜索记 PASS 时结果里必须有真 URL / 标题
// 这些规则一旦被放松，验收就成了装饰。抽成纯函数后，自检可以喂进
// 「后端全挂却记 PASS」「UNKNOWN 却给出结果」这类假数据，断言它必须报警。

const FOUR_STATE = ['PASS', 'WARN', 'FAIL', 'UNKNOWN'];

/** 搜索结果判定：四态合法 + 反假绿（UNKNOWN 不许带结果） */
export function judgeSearch(s = {}) {
  const out = [];
  const add = (name, ok) => out.push({ name, ok: !!ok });
  const results = Array.isArray(s.results) ? s.results : [];
  add('搜索状态是四态之一：' + s.state, FOUR_STATE.includes(s.state));
  if (s.state === 'UNKNOWN') {
    // 反假绿：连不上却给出结果，是最典型的「假联网」
    add('搜索记 UNKNOWN 时没有伪造结果（0 条）', results.length === 0);
  } else if (s.state === 'PASS') {
    add('搜索 PASS 且有 ' + results.length + ' 条结果', results.length > 0);
    add('每条结果都有可打开的 http(s) URL', results.every((r) => /^https?:/.test(r.url)));
    add('每条结果都有标题', results.every((r) => r.title && r.title.length > 0));
  }
  return out;
}

/** 抓取判定：PASS 必须真的有正文（短正文等于没抓到） */
export function judgeFetch(f = {}) {
  const out = [];
  const add = (name, ok) => out.push({ name, ok: !!ok });
  add('抓取状态是四态之一：' + f.state, FOUR_STATE.includes(f.state));
  if (f.state === 'PASS') {
    add('抓取 PASS 且正文 ' + f.chars + ' 字', f.chars > 200);
    add('正文摘录非空（界面能显示）', (f.excerpt || '').length > 0);
  }
  return out;
}

/** 后端可达性：不可达的不许记 PASS（「PASS 但备注说连不上」是矛盾记录） */
export function judgeBackends(backends = []) {
  const out = [];
  const add = (name, ok) => out.push({ name, ok: !!ok });
  const bad = (backends || []).filter((b) => b.state === 'PASS' && /连不上|失败/.test(b.note || ''));
  add('后端可达性表里没有「PASS 但备注说连不上」的矛盾记录', bad.length === 0);
  add('记录了 ' + (backends || []).length + ' 个候选后端（说明为什么选这个）', (backends || []).length >= 3);
  return out;
}

/** net.json 整体判定 = 时间戳 + 搜索 + 抓取 + 后端可达性 */
export function judgeNetData(net = {}) {
  const out = [{ name: '数据有时间戳（' + net.at + '）', ok: typeof net.at === 'string' }];
  return out.concat(judgeSearch(net.search || {}), judgeFetch(net.fetch || {}), judgeBackends(net.backends || []));
}

/**
 * 自检 —— 每条反例都断言「构造一个假绿，判定必须报出来」
 *
 * 【为什么必须有】A3 的核心风险是「假联网」：连不上却显示有结果。
 * 一个只会说「通过」的验收器无法证明这一点，所以这里用假数据把
 * 「后端全挂却记 PASS」「UNKNOWN 却带结果」等场景逐个钉死。
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);
  const has = (arr, sub) => arr.some((a) => a.name.includes(sub) && !a.ok);
  const allOk = (arr) => arr.length > 0 && arr.every((a) => a.ok);

  // ── 反例 1（最核心）：后端全部不可达，却记 PASS 并给出结果 ──
  //   这是「假联网」的典型：三个后端全连不上，界面却显示 PASS + 结果。
  const allDown = {
    at: '2026-11-15T10:00:00Z',
    search: { state: 'PASS', results: [{ url: 'https://a.example', title: 'A' }] },
    fetch: { state: 'FAIL' },
    backends: [
      { state: 'PASS', note: '连不上（超时）' },
      { state: 'PASS', note: '请求失败' },
      { state: 'FAIL', note: '连不上' },
    ],
  };
  T('反例 · 后端全部不可达却记 PASS → 必须报',
    has(judgeNetData(allDown), 'PASS 但备注说连不上'),
    JSON.stringify(judgeNetData(allDown).filter((a) => !a.ok).map((a) => a.name)));

  // ── 反例 2：搜索记 UNKNOWN 却带着结果（连不上却伪造结果）──
  const fakeResults = { state: 'UNKNOWN', results: [{ url: 'https://x', title: 'x' }] };
  T('反例 · 搜索 UNKNOWN 却带结果 → 必须报',
    has(judgeSearch(fakeResults), '没有伪造结果'), JSON.stringify(fakeResults));

  // ── 反例 3：搜索记 PASS 却 0 条结果（空口说成功）──
  T('反例 · 搜索 PASS 却 0 条结果 → 必须报',
    has(judgeSearch({ state: 'PASS', results: [] }), '搜索 PASS 且有'), 'results=0');

  // ── 反例 4：结果缺标题 / 不是 http(s) URL → 必须报 ──
  const badRes = { state: 'PASS', results: [{ url: 'ftp://x', title: '' }] };
  const jr = judgeSearch(badRes);
  T('反例 · 结果不是 http(s) 或无标题 → 必须报',
    has(jr, 'http(s) URL') && has(jr, '都有标题'), JSON.stringify(jr.map((a) => a.ok)));

  // ── 反例 5：抓取记 PASS 但正文太短 → 必须报 ──
  T('反例 · 抓取 PASS 但正文 10 字 → 必须报',
    has(judgeFetch({ state: 'PASS', chars: 10, excerpt: '' }), '正文'), 'chars=10');

  // ── 反例 6：候选后端不足 3 个（没比较就选）→ 必须报 ──
  T('反例 · 候选后端 <3 个 → 必须报',
    has(judgeBackends([{ state: 'PASS', note: 'ok' }]), '候选后端'), 'len=1');

  // ── 正例：合理数据 → 全绿 ──
  const healthy = {
    at: '2026-11-15T10:00:00Z',
    search: {
      state: 'PASS',
      results: [{ url: 'https://a.example', title: 'A' }, { url: 'https://b.example', title: 'B' }],
    },
    fetch: { state: 'PASS', chars: 800, excerpt: '正文…' },
    backends: [
      { state: 'PASS', note: '可达' },
      { state: 'FAIL', note: '连不上' },
      { state: 'UNKNOWN', note: '超时' },
    ],
  };
  T('正例 · 合理数据 → 全绿', allOk(judgeNetData(healthy)),
    JSON.stringify(judgeNetData(healthy).filter((a) => !a.ok)));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  A3 联网验收 · 自检（1 正例 + 6 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

console.log('');
console.log('  A3 联网验收 —— 搜索 + 抓取 + 进界面');
console.log('  ' + '─'.repeat(72));

// ── 1. 模块在位 ──
ok(fs.existsSync(SEARCH), '搜索模块在位（tools/net/search.mjs）');
ok(fs.existsSync(FETCH), '抓取模块在位（tools/net/fetch.mjs）');
ok(fs.existsSync(GEN), '界面数据生成器在位（tools/net/gen-ui-data.mjs）');

// ── 2. 解析器自检（离线）──
const st = execFileSync(process.execPath, [SEARCH, '--selftest'], {
  cwd: REPO, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'],
}).toString();
const stm = st.match(/结论: ✓ (\d+)\/(\d+)/);
ok(!!stm, '解析器自检有结论行');
if (stm) {
  ok(Number(stm[1]) === Number(stm[2]), '解析器自检 ' + stm[1] + '/' + stm[2] + ' 全过');
}
const src = fs.readFileSync(SEARCH, 'utf8');
// 关键能力必须在源码里真的实现
ok(/b_algo/.test(src), '实现 Bing 结果结构解析（实测可达的后端）');
ok(/result__a|uddg/.test(src), '实现 DuckDuckGo 结构解析（备选后端）');
ok(/decodeEntities/.test(src) && /fromCodePoint/.test(src), '实现实体解码（含数字实体 &#x...;）');
ok(/<script\\b/.test(src) || /<script/.test(src), '实现去 script/style（正文提取的前提）');

// 抓取模块的四态自检
const ft = execFileSync(process.execPath, [FETCH, '--selftest'], {
  cwd: REPO, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'],
}).toString();
const ftm = ft.match(/全部成立 (\d+)\/(\d+)/);
ok(!!ftm && ftm[1] === ftm[2], '抓取四态判定自检 ' + (ftm ? ftm[1] + '/' + ftm[2] : '?') + ' 全过');

// ── 3. 界面数据（真实联网结果）──
if (!fs.existsSync(NET_JSON)) {
  un('没有 apps/agent-ui/src/data/net.json —— 先跑 node tools/net/gen-ui-data.mjs');
} else {
  const net = JSON.parse(fs.readFileSync(NET_JSON, 'utf8'));
  // 判定全部走纯函数 judgeNetData，保证「自检测的」就是「正式跑的」逻辑
  for (const a of judgeNetData(net)) ok(a.ok, a.name);
}

// ── 4. 进到界面 ──
ok(fs.existsSync(NET_TSX), '联网场景组件在位（scenes/Net.tsx）');
if (fs.existsSync(NET_TSX)) {
  const tx = fs.readFileSync(NET_TSX, 'utf8');
  for (const [probe, label] of [
    ['联网能力', '标题「联网能力」'],
    ['搜索结果', '搜索结果列表'],
    ['抓取与正文提取', '抓取正文区'],
    ['后端可达性', '后端可达性表'],
    ['STATE_LABEL', '四态标签（判不了要说判不了）'],
  ]) {
    ok(tx.includes(probe), '界面含' + label);
  }
}

// 场景注册表必须真的挂上
const reg = fs.readFileSync(path.join(REPO, 'apps/agent-ui/src/scenes/registry.ts'), 'utf8');
ok(/'net'/.test(reg) && reg.includes('联网'), '场景注册表挂了「联网」场景');

if (!fs.existsSync(DIST)) {
  un('前端还没构建，产物层判不了');
} else {
  const assets = path.join(DIST, 'assets');
  const js = fs.existsSync(assets) ? fs.readdirSync(assets).filter((x) => x.endsWith('.js')) : [];
  let hit = false;
  for (const x of js) {
    const t = fs.readFileSync(path.join(assets, x), 'utf8');
    if (t.includes('联网能力') && t.includes('后端可达性')) { hit = true; break; }
  }
  ok(hit, '构建产物里含联网场景（' + js.length + ' 个 js 中已包含）');
}

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(fail ? 1 : unknown ? 2 : 0);