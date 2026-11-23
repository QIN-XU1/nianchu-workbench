#!/usr/bin/env node
/**
 * A7 记忆治理验收 —— 溯源 + 冲突 + TTL
 *
 * 背景：A7 之前记「部分」，证据只有一句
 *   「有经验真实性体检/记忆注入效果体检守卫，无 TTL」——
 *   那两张体检表在 hermes 侧，TTL 完全没有。
 *
 * 现在有自研的 tools/memory/store.mjs。这份验收分三层：
 *
 *   1. 逻辑层（离线自检，注入时钟，可复现）—— 21 项
 *      · 溯源：无来源拒绝写入（这是底线，不是建议）
 *      · 幂等：同 key 同值只 touch 不堆条目
 *      · 冲突：同 key 不同值 → 旧的标 superseded，旧值仍可查
 *      · TTL：过期不进结果，但历史留着
 *      · 审计：能找出无源条目、未解决冲突
 *      · gc：只删「过期且被推翻」，仅过期/仅被推翻的保留
 *
 *   2. IO 层（真读写磁盘）
 *      · CLI 退出码三态：0 有值 / 1 仅历史 / 2 不存在
 *
 *   3. 界面层
 *      · memory.json 有真实治理数据
 *      · Memory.tsx 显示四态计数 + 有效区 + 历史区
 *      · 构建产物里含
 *
 * 特别断言（反假绿）：
 *   · 过期条目不许出现在「有效」区
 *   · 被推翻的条目不许被静默删除（必须可在历史里查到）
 *   · noSource 计数必须为 0（否则治理不达标）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const STORE_MJS = path.join(REPO, 'tools/memory/store.mjs');
const GEN = path.join(REPO, 'tools/memory/gen-ui-data.mjs');
const MEM_JSON = path.join(REPO, 'apps/agent-ui/src/data/memory.json');
const MEM_TSX = path.join(REPO, 'apps/agent-ui/src/scenes/Memory.tsx');
const DIST = path.join(REPO, 'apps/agent-ui/dist');

let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };
const un = (m) => { unknown++; console.log('  ' + I.un + ' ' + m); };

function run(args, timeout = 90000) {
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, args, {
      cwd: REPO, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 2; }
  return { out, code };
}

/**
 * 判定「一条记忆在 nowMs 这一刻是否已过期」
 *
 * 【为什么单独抽出来】这是本验收里最容易出错的边界：
 *   ① 判据必须是 `expiresAt <= now`（到点即过期），不是 `expiresAt < now`；
 *   ② **解析不了的时间戳必须当成「已过期」**，不能当成「未过期」。
 *      历史实现用的是 `new Date(x).getTime() <= nowMs`，而 `Date.parse('垃圾')` = NaN，
 *      `NaN <= nowMs` 恒为 false ⇒ **一个坏时间戳就能让过期条目永远留在有效区**。
 *      这类「坏数据静默放行」正是治理验收要挡的假绿。
 */
export function expiredAt(expiresAt, nowMs) {
  const ms = new Date(expiresAt).getTime();
  if (!Number.isFinite(ms)) return true;   // 解析不了 ⇒ 不能证明「还没过期」，按过期处理
  return ms <= nowMs;                      // 到点即过期
}

/**
 * 核心判定 —— 抽成纯函数便于自检注入假数据（不读磁盘、不取真实时钟）
 *
 * @param mem    memory.json 的内容 { at, totals, entries }
 * @param opts.nowMs  当前时刻（自检注入固定值，保证可复现）
 * @returns [{ name, ok }]  —— 正式运行和 --selftest 用的是同一份判定，不存在两份逻辑
 */
export function auditMemoryData(mem, { nowMs = Date.now() } = {}) {
  const out = [];
  const push = (name, okc) => { out.push({ name, ok: !!okc }); return !!okc; };

  const m = mem && typeof mem === 'object' ? mem : {};
  const t = m.totals && typeof m.totals === 'object' ? m.totals : {};
  const entries = Array.isArray(m.entries) ? m.entries : [];

  push('数据有时间戳', typeof m.at === 'string');
  push('有治理统计', typeof m.totals === 'object' && m.totals !== null);

  push('无来源条目为 0（治理底线）', t.noSource === 0);
  push('未解决冲突为 0', t.unresolvedConflict === 0);

  push('有 ' + entries.length + ' 条记忆', entries.length > 0);

  // 反假绿：每条都必须有来源（空白字符串也算没有来源）
  const noSrc = entries.filter((e) => !e || !e.source || !String(e.source).trim());
  // 注意这里显示的是「有来源的条数/总条数」：旧版写死成 N/N，即使有条目缺来源也显示满分，
  // 会让失败时也看不出缺了几条。判定仍是 noSrc.length === 0，没有放松。
  push('每条记忆都带来源（' + (entries.length - noSrc.length) + '/' + entries.length + '）', noSrc.length === 0);

  // 反假绿：过期条目不许混在 fresh 里
  const wrongFresh = entries.filter((e) => e && e.state === 'fresh' && e.expiresAt && expiredAt(e.expiresAt, nowMs));
  push('没有「已过期却标 fresh」的条目' + (wrongFresh.length ? '  ← ' + wrongFresh.length + ' 条' : ''), wrongFresh.length === 0);

  // 反假绿：被推翻的必须还在（不许静默删）
  const superseded = entries.filter((e) => e && e.state === 'superseded');
  push('被推翻的条目仍在存储里（' + superseded.length + ' 条，未被静默删除）', superseded.every((e) => e.value));

  // 有效条目数应与统计一致
  const freshN = entries.filter((e) => e && e.state === 'fresh').length;
  push('有效条目数与统计一致（' + freshN + ' = ' + t.fresh + '）', freshN === t.fresh);

  return out;
}

/**
 * 退出码裁决 —— 抽成纯函数便于自检
 *
 * 【为什么重要】三态（有值 0 / 仅历史 1 / 不存在 2）里，最容易被写错的是
 * `unknown`：一句 `process.exit(fail ? 1 : 0)` 就会把「判不了」算成「通过」。
 * 那正是本项目四态纪律禁止的事。
 */
export function exitCodeFor({ fail = 0, unknown = 0 } = {}) {
  return fail ? 1 : unknown ? 2 : 0;
}

/**
 * 自检 —— 用假记忆数据验证「该报的报、不该报的不报」
 *
 * 【为什么必须有】一个只会说「通过」的验收器不是验收器，是装饰。
 * 下面每条反例都构造一个**真实可能出现的坏数据**，断言判定会变红；
 * 尤其反例 1、2 打的是「过期条目混进有效区」这类最隐蔽的假绿。
 */
export function selfTest() {
  const cases = [];
  const T = (n, okc, why) => cases.push([n, !!okc, why]);
  const NOW = Date.parse('2026-11-15T12:00:00Z');
  const ISO = (ms) => new Date(ms).toISOString();
  const base = (entries, totals) => ({
    at: ISO(NOW), totals: { noSource: 0, unresolvedConflict: 0, fresh: 0, ...totals }, entries,
  });
  /** 取某条断言的 ok */
  const get = (res, re) => (res.find((r) => re.test(r.name)) || {}).ok;

  // ── 反例 1（核心）：全部条目都已过期，却全被标成 fresh ──
  //   典型来源：gen-ui-data 忘了按 TTL 判状态，一律写 fresh。这会让「有效区」
  //   塞满过期条目 —— 界面看起来满满当当，实际全是死记忆。
  const c1 = auditMemoryData(base([
    { key: 'a', value: 'v', source: 's', state: 'fresh', expiresAt: ISO(NOW - 1000) },
    { key: 'b', value: 'v', source: 's', state: 'fresh', expiresAt: ISO(NOW - 999999) },
  ], { fresh: 2 }), { nowMs: NOW });
  T('反例 · 全部条目已过期却全标 fresh → 必须报「过期却标 fresh」',
    get(c1, /已过期却标 fresh/) === false, JSON.stringify(c1.map((r) => r.name)));

  // ── 反例 2（隐蔽）：expiresAt 是不可解析的垃圾 ──
  //   历史 bug：Date.parse('垃圾') = NaN，NaN <= now 恒 false ⇒ 永远判「没过期」。
  //   一个坏时间戳就能让过期记忆永久霸占有效区，而验收器还全绿。
  const c2 = auditMemoryData(base([
    { key: 'bad', value: 'v', source: 's', state: 'fresh', expiresAt: '不是时间 2026-13-45T99' },
  ], { fresh: 1 }), { nowMs: NOW });
  T('反例 · expiresAt 无法解析 + 标 fresh → 必须报（不许「解析失败=没过期」）',
    get(c2, /已过期却标 fresh/) === false, JSON.stringify(c2.map((r) => r.name)));

  // ── 反例 3（边界）：恰好到点（expiresAt === now）即过期 ──
  //   判据是 `<=` 不是 `<`。若写成 `<`，到点那一毫秒仍算有效 —— 边界错一位，
  //   正是 size-guard 那类「32769 字节漏网」的同型 bug。
  const c3 = auditMemoryData(base([
    { key: 'edge', value: 'v', source: 's', state: 'fresh', expiresAt: ISO(NOW) },
  ], { fresh: 1 }), { nowMs: NOW });
  T('反例 · 恰好到点（expiresAt = now）→ 必须算过期并报出',
    get(c3, /已过期却标 fresh/) === false, JSON.stringify(c3.map((r) => r.name)));

  // ── 反例 4：被推翻的条目值被清空（等于静默删除）──
  //   「旧值仍可查」是冲突治理的核心承诺；如果 superseded 的 value 被抹成空串，
  //   历史区还在但内容没了，等于变相删除，必须报。
  const c4 = auditMemoryData(base([
    { key: 'k', value: 'new', source: 's', state: 'fresh', expiresAt: ISO(NOW + 1e9) },
    { key: 'k#old', value: '', source: 's', state: 'superseded' },
  ], { fresh: 1 }), { nowMs: NOW });
  T('反例 · 被推翻条目值被清空（静默删除）→ 必须报',
    get(c4, /被推翻的条目仍在存储里/) === false, JSON.stringify(c4.map((r) => r.name)));

  // ── 反例 5：来源是空白字符串 ──
  //   `'   '` 是真值，不做 trim 就会当成「有来源」。溯源底线被一个空格绕过。
  const c5 = auditMemoryData(base([
    { key: 'w', value: 'v', source: '   ', state: 'fresh', expiresAt: ISO(NOW + 1e9) },
  ], { fresh: 1 }), { nowMs: NOW });
  T('反例 · 来源是空白字符串 → 必须报无来源',
    get(c5, /每条记忆都带来源/) === false, JSON.stringify(c5.map((r) => r.name)));

  // ── 反例 6：统计与真实条数不一致（per-totals 撒谎）──
  //   totals.fresh 说 3，实际只有 1 条 fresh ⇒ 界面数字是编出来的。必须交叉核对。
  const c6 = auditMemoryData(base([
    { key: 'r', value: 'v', source: 's', state: 'fresh', expiresAt: ISO(NOW + 1e9) },
  ], { fresh: 3 }), { nowMs: NOW });
  T('反例 · totals.fresh 与真实 fresh 数不一致 → 必须报',
    get(c6, /有效条目数与统计一致/) === false, JSON.stringify(c6.map((r) => r.name)));

  // ── 反例 7：noSource 统计声称 0，但确有缺来源条目 ──
  const c7 = auditMemoryData(base([
    { key: 'n', value: 'v', source: '', state: 'fresh', expiresAt: ISO(NOW + 1e9) },
  ], { noSource: 0, fresh: 1 }), { nowMs: NOW });
  T('反例 · noSource=0 但确有缺来源条目 → 本条仍须抱住（独立复算，不信统计）',
    get(c7, /无来源条目为 0/) === true && get(c7, /每条记忆都带来源/) === false,
    JSON.stringify(c7.map((r) => [r.name, r.ok])));

  // ── 正例：健康数据（有效项 + 已过期且如实标 expired + 被推翻但值在）→ 全绿 ──
  //
  // 【说明边界】「全部条目都过期、且状态如实标成 expired」这种情况本函数**不会**报错：
  //   治理判据管的是「有没有溯源/冲突/TTL」，不是「必须还有有效记忆」。
  //   把它写成硬门槛属于新增判定，超出「只抽函数、加自检」的授权范围，
  //   所以这里如实标注：这是本验收器的已知边界，不假装它被覆盖了。
  const c8 = auditMemoryData(base([
    { key: 'live', value: 'v', source: 'tool:1', state: 'fresh', expiresAt: ISO(NOW + 86400000) },
    { key: 'old', value: 'v0', source: 'tool:2', state: 'expired', expiresAt: ISO(NOW - 86400000) },
    { key: 'k', value: 'v1', source: 'tool:3', state: 'superseded' },
  ], { fresh: 1 }), { nowMs: NOW });
  T('正例 · 健康数据（1 有效 + 1 如实过期 + 1 被推翻）→ 九项全绿',
    c8.every((r) => r.ok), JSON.stringify(c8.filter((r) => !r.ok).map((r) => r.name)));

  // ── 反例 8：条目数组为空 → 不许当「有记忆」──
  const c9 = auditMemoryData(base([], { fresh: 0 }), { nowMs: NOW });
  T('反例 · 零条记忆 → 「有 N 条记忆」必须红',
    get(c9, /有 \d+ 条记忆/) === false, JSON.stringify(c9.map((r) => [r.name, r.ok])));

  // ── 反例 9（四态纪律）：退出码不许把「无法判断」算成「通过」──
  T('反例 · 只有 unknown 时退出码必须是 2（不是 0）', exitCodeFor({ fail: 0, unknown: 1 }) === 2,
    'got=' + exitCodeFor({ fail: 0, unknown: 1 }));
  T('反例 · 有 fail 也有 unknown 时退出码 1（失败优先，但绝不 0）', exitCodeFor({ fail: 2, unknown: 3 }) === 1,
    'got=' + exitCodeFor({ fail: 2, unknown: 3 }));
  T('正例 · 全过 → 退出码 0', exitCodeFor({ fail: 0, unknown: 0 }) === 0);

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
  console.log('  A7 记忆治理验收 · 自检（2 正例 + 10 反例）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (isMain) {
console.log('');
console.log('  A7 记忆治理验收 —— 溯源 + 冲突 + TTL');
console.log('  ' + '─'.repeat(72));

// ── 1. 模块在位 ──
ok(fs.existsSync(STORE_MJS), '记忆存储在位（tools/memory/store.mjs）');
ok(fs.existsSync(GEN), '界面数据生成器在位（tools/memory/gen-ui-data.mjs）');

// ── 2. 逻辑层自检（21 项，注入时钟可复现）──
const st = run([STORE_MJS, '--selftest']);
const stm = st.out.match(/结论: ✓ (\d+)\/(\d+)/);
ok(!!stm, '逻辑层自检有结论行');
if (stm) {
  ok(Number(stm[1]) === Number(stm[2]), '逻辑层自检 ' + stm[1] + '/' + stm[2] + ' 全过');
}
// 关键能力必须在自检里被覆盖
for (const [probe, label] of [
  ['无来源拒绝写入', '溯源：无来源拒绝写入'],
  ['同 key 同值只 touch', '幂等：同值不堆条目'],
  ['同 key 不同值触发 supersede', '冲突：覆盖改为标 superseded'],
  ['历史仍可查', '冲突：旧值仍可查'],
  ['TTL 过期后不在结果里', 'TTL：过期不进结果'],
  ['过期不是删除', 'TTL：过期保留历史'],
  ['审计发现未解决冲突', '审计：能发现未解决冲突'],
  ['gc 只删过期且被推翻的', 'gc：只删双条件满足的'],
]) {
  ok(st.out.includes(probe), label);
}

// 源码确实实现了这些判据（不是只写在自检里）
const src = fs.readFileSync(STORE_MJS, 'utf8');
ok(/拒绝写入：没有来源/.test(src), '源码实现「无来源拒绝」');
ok(/expiresAt/.test(src) && /effectiveState/.test(src), '源码实现 TTL（expiresAt + effectiveState）');
ok(/SUPERSEDED/.test(src) && /supersededBy/.test(src), '源码实现 supersede 链（supersededBy）');

// ── 3. IO 层：退出码三态 ──
const tmpKey = 'acc.exitcode.' + Date.now();
run([STORE_MJS, 'put', '--key=' + tmpKey, '--value=v1', '--source=test:' + tmpKey]);
const r0 = run([STORE_MJS, 'get', '--key=' + tmpKey]);
ok(r0.code === 0, '退出码 0：有有效值');

run([STORE_MJS, 'put', '--key=' + tmpKey + '.ttl', '--value=v', '--source=test', '--ttl=1']);
await new Promise((r) => setTimeout(r, 1200));
const r1 = run([STORE_MJS, 'get', '--key=' + tmpKey + '.ttl', '--all']);
ok(r1.code === 1, '退出码 1：仅历史（已过期）');

const r2 = run([STORE_MJS, 'get', '--key=definitely-not-exist-' + Date.now()]);
ok(r2.code === 2, '退出码 2：key 完全不存在');

// ── 4. 界面数据 ──
if (!fs.existsSync(MEM_JSON)) {
  un('没有 apps/agent-ui/src/data/memory.json —— 先跑 node tools/memory/gen-ui-data.mjs');
} else {
  const mem = JSON.parse(fs.readFileSync(MEM_JSON, 'utf8'));
  // 判定全部走纯函数 auditMemoryData，正式运行与自检共用同一份逻辑
  for (const r of auditMemoryData(mem)) ok(r.ok, r.name);
}

// ── 5. 界面 ──
ok(fs.existsSync(MEM_TSX), '记忆场景组件在位（scenes/Memory.tsx）');
if (fs.existsSync(MEM_TSX)) {
  const tx = fs.readFileSync(MEM_TSX, 'utf8');
  for (const [probe, label] of [
    ['记忆治理', '标题「记忆治理」'],
    ['溯源底线', '溯源底线说明'],
    ['有效记忆', '有效记忆区'],
    ['历史（被推翻 / 已过期）', '历史区（被推翻/已过期）'],
    ['ttlLabel', 'TTL 剩余时间显示'],
  ]) {
    ok(tx.includes(probe), '界面含' + label);
  }
}

if (!fs.existsSync(DIST)) {
  un('前端还没构建，产物层判不了');
} else {
  const assets = path.join(DIST, 'assets');
  const js = fs.existsSync(assets) ? fs.readdirSync(assets).filter((x) => x.endsWith('.js')) : [];
  let hit = false;
  for (const x of js) {
    const t2 = fs.readFileSync(path.join(assets, x), 'utf8');
    if (t2.includes('记忆治理') && t2.includes('被推翻')) { hit = true; break; }
  }
  ok(hit, '构建产物里含记忆治理场景');
}

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(exitCodeFor({ fail, unknown }));
}
