#!/usr/bin/env node
/**
 * A13 MCP 客户端验收
 *
 * 背景：A13 之前记「部分」，证据原话：
 *   「MCP 来自 hermes（optional-mcps 66 文件）…我们**没有自己的 MCP 客户端**」。
 * 现在有自研的 tools/mcp/client.mjs（stdio + JSON-RPC 2.0）。
 *
 * 这份验收分两层，缺一层都不算「有」：
 *
 *  第一层 · 自检（不依赖外部）：用内置假 server 验协议实现的正确性
 *    · 握手 + 协议版本协商
 *    · tools/list + inputSchema
 *    · tools/call 正常路（echo / add）
 *    · isError 通路（工具执行失败 ≠ 协议失败）
 *    · JSON-RPC error 通路（未知工具）
 *    · 传输层失败 → UNKNOWN（不是 FAIL）
 *
 *  第二层 · 真 server（证明不是只能连自己写的假货）
 *    用官方 @modelcontextprotocol/sdk 起的真 server，
 *    验 add 计算、reverse 字符串、fail 抛异常、未知工具。
 *
 * 如果第二层的 SDK 没装，第二层记 UNKNOWN（不当成通过，也不当成失败）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const CLIENT = path.join(REPO, 'tools/mcp/client.mjs');
const REAL_SERVER = path.join(REPO, 'evidence/mcp-realserver/server.mjs');
const REAL_MODULES = path.join(REPO, 'evidence/mcp-realserver/node_modules/@modelcontextprotocol/sdk');

let pass = 0, fail = 0, unknown = 0;
const I = { ok: '✓', no: '✗', un: '❔' };
const ok = (c, m) => { if (c) { pass++; console.log('  ' + I.ok + ' ' + m); } else { fail++; console.log('  ' + I.no + ' ' + m); } return c; };

function run(args, timeout = 120000) {
  const t0 = Date.now();
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [CLIENT, ...args], {
      cwd: REPO, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status ?? 2;
  }
  return { out, code, ms: Date.now() - t0 };
}

/**
 * 带**显式重试**的 run —— 用于真 server 层。
 *
 * 【为什么需要】2026-11-20 第 90 轮观察到 A13 间歇失败（4 次里坏 1 次：verify-goal 报 20/1，
 * 而单独跑 verify-mcp 又 20/0）。属真 server 冷启动的传输层抖动，不是逻辑错。
 * 处理方式：**只在「无输出 / 明确是起不来」时重试一次，并把重试打印出来**——
 * 不静默吞掉，让 flakiness 可见；逻辑性失败（工具该 FAIL 就是 FAIL）绝不重试。
 */
function runRetry(args, timeout = 120000) {
  let r = run(args, timeout);
  const transportLike = !r.out || /UNKNOWN|ENOENT|ECONNREFUSED|EADDRINUSE|timed? ?out/i.test(r.out);
  if (transportLike) {
    console.log('  ⚠ 疑似传输层抖动（非逻辑失败），重试一次：' + String(r.out).slice(0, 60).replace(/\s+/g, ' '));
    r = run(args, timeout);
  }
  return r;
}

/**
 * ───────────────────────── 纯函数区 ─────────────────────────
 * 下面这些是把「JSON-RPC 探测输出」翻译成判定的全部逻辑。
 * 抽成纯函数的意义：自检可以喂**假的探测输出**，断言判定会红，
 * 而不必真的去起一个坏 server（起不来/超时那类情况本来就难以稳定复现）。
 */

/** 解析 client 的探测输出：拿到了哪个状态、哪个 server 名、几个工具 */
export function parseProbe(out) {
  const text = String(out || '');
  // 客户端探测行形如：`  ✓ PASS  node xxx/server.mjs`
  const state = (/^\s*[✓✗?❔]\s+(PASS|FAIL|UNKNOWN)\s/m.exec(text) || [, null])[1];
  // 握手成功的措辞：`握手成功：<name> <version> · protocol ...`
  const serverName = (/握手成功：(\S+)/.exec(text) || [, null])[1];
  // 工具清单头：`工具（3）:`；**零工具时客户端根本不打印这一行**
  const toolCount = (/工具（(\d+)）/.exec(text) || [, null])[1];
  return { state, serverName, toolCount };
}

/**
 * 判定一次真 server 探测是否合格
 *
 * 【反例针对什么】「握手成功但工具列表为空」：PASS + serverInfo 正常，
 * 却一个工具都没有 —— 这种 server 连上了也没用，绝不能算「MCP 客户端可用」。
 * 判定必须同时要求 handshakeOk 与 toolsOk。
 */
export function judgeProbe(parsed, { expectServer = 'nianchu-real-probe', expectTools = 3 } = {}) {
  const toolCountLabel = parsed.toolCount === null ? '?' : parsed.toolCount;
  return {
    handshakeOk: parsed.state === 'PASS' && parsed.serverName === expectServer,
    toolsOk: parsed.toolCount === String(expectTools),
    toolCountLabel,
  };
}

/** 解析一次 tools/call 的输出与进程退出码 */
export function parseCallResult(out, code) {
  const text = String(out || '');
  // 调用行形如：`  ✓ tools/call add → PASS  调用成功`
  const state = (/tools\/call.*?→\s+(PASS|FAIL|UNKNOWN)/.exec(text) || [, null])[1];
  // 内容行形如：`[{"type":"text","text":"42"}]`
  const content = (/\[\{"type":"text","text":"([^"]*)"/.exec(text) || [, ''])[1];
  return { state, content, code };
}

/**
 * 判定一次 tools/call 是否符合期望
 *
 * 【反例针对什么】MCP 规范把「工具执行失败」放在 result.isError（状态 FAIL、退出码 1），
 * 与「协议层 JSON-RPC error」和「传输层连不上 UNKNOWN」是三件不同的事。
 * 最容易写错的是把 isError 当成功（PASS/0）—— 于是工具永远报错也判通过。
 * 所以这里 state / 退出码 / 内容三项必须同时成立。
 */
export function judgeCall(expect, actual) {
  return actual.state === expect.state
    && actual.code === expect.code
    && actual.content.includes(expect.content);
}

/** 解析 client `--selftest` 的汇总行：`通过 10   失败 0` */
export function parseSelfTally(out) {
  const m = /通过 (\d+)\s+失败 (\d+)/.exec(String(out || ''));
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
}

/**
 * 判定第一层（内置假 server 自检）的结论
 *
 * 【反例针对什么】汇总行说「0 失败」但进程退出码非 0 —— 二者矛盾，
 * 说明自检自己崩了/提前退出，那批断言根本没跑完。只看汇总文本会把它当通过。
 */
export function auditSelfLayer(out, code) {
  const tally = parseSelfTally(out);
  const results = [{ name: '自检有汇总行', ok: !!tally }];
  if (tally) {
    results.push({ name: '自检 ' + tally.pass + ' 项全过（' + tally.fail + ' 失败）', ok: tally.fail === 0 && code === 0 });
    results.push({ name: '握手成功并读出 serverInfo', ok: /握手：/.test(out) });
    results.push({ name: '协议版本协商', ok: /协议版本协商/.test(out) });
    results.push({ name: 'isError 通路：工具执行失败记 FAIL 但协议通', ok: /isError 通路/.test(out) });
    results.push({ name: '传输层失败记 UNKNOWN（不是 FAIL）', ok: /起不来的命令记 UNKNOWN/.test(out) });
  }
  return { results, tally };
}

/** 三态退出码裁决：fail → 1，unknown（判不了）→ 2，全过 → 0 */
export function exitCodeFor({ fail = 0, unknown = 0 } = {}) {
  return fail ? 1 : unknown ? 2 : 0;
}

/**
 * 自检 —— 用假输出验证「该报的报、不该报的不报」
 * 反例全部集中在协议层最容易混淆的地方：isError / UNKNOWN / 空工具表 / 汇总撒谎。
 */
export function selfTest() {
  const cases = [];
  const T = (n, okc, why) => cases.push([n, !!okc, why]);

  // ── 反例 1（核心）：握手成功但工具列表为空 ──
  //   PASS + serverInfo 正常，但一行 `工具（N）` 都没有 ⇒ 一个工具都没列出来。
  //   连上了却没有能力 = 这个 MCP 客户端不可用。只看 /PASS/ 就会误判成通过。
  const p1 = parseProbe('  ✓ PASS  node server.mjs\n  握手成功：nianchu-real-probe 0.1.0 · protocol 2024-11-05 · 列出 0 个工具\n');
  const j1 = judgeProbe(p1);
  T('反例 · 握手就绪但工具列表为空（0 个）→ 工具项必须红',
    j1.handshakeOk === true && j1.toolsOk === false, JSON.stringify(j1));

  // ── 反例 2：连上了别的 server（名字不对）→ 不算验证了真 server ──
  //   典型事故：--server 指错到另一个进程，握手很顺，实际验的不是它。
  const p2 = parseProbe('  ✓ PASS  node other.mjs\n  握手成功：some-other-server 9.9 · protocol 2024-11-05\n\n  工具（3）:\n');
  const j2 = judgeProbe(p2);
  T('反例 · serverInfo 名字不对（连上了别的 server）→ 握手项必须红',
    j2.handshakeOk === false && j2.toolsOk === true, JSON.stringify(j2));

  // ── 反例 3：进程起不来（无任何输出）→ 两项都必须红，不许默认通过 ──
  const p3 = parseProbe('');
  const j3 = judgeProbe(p3);
  T('反例 · 无输出（server 起不来）→ 握手与工具项都红',
    j3.handshakeOk === false && j3.toolsOk === false, JSON.stringify(j3));

  // ── 反例 4（核心）：把 isError（工具执行失败）当成成功 ──
  //   fail 工具的期望是 FAIL/1「故意失败」。若客户端把 isError 忽略成 PASS/0，
  //   这条判定必须红 —— 否则「工具永远报错」也过验收。
  const a4 = parseCallResult('  ✗ tools/call fail → PASS  调用成功\n  [{"type":"text","text":"故意失败：这个工具永远报错"}]\n', 0);
  T('反例 · isError 被当成 PASS/exit0 → 必须红（FAIL/1）',
    judgeCall({ state: 'FAIL', code: 1, content: '故意失败' }, a4) === false, JSON.stringify(a4));

  // ── 反例 5（四态混淆）：传输层 UNKNOWN 被记成协议层 FAIL ──
  //   「没连上」不等于「服务器报错」。期望 UNKNOWN/2，实际 FAIL/1 → 必须红。
  const a5 = parseCallResult('  ✗ tools/call add → FAIL  起不来\n', 1);
  T('反例 · 起不来（应为 UNKNOWN/2）却记成 FAIL/1 → 必须红',
    judgeCall({ state: 'UNKNOWN', code: 2, content: '' }, a5) === false, JSON.stringify(a5));

  // ── 反例 6：状态和退出码都对，但返回内容不对（计算错了）──
  //   add 17+25 必须等于 42。若客户端把 {a,b} 传错、或 server 算错，内容不符要抓。
  const a6 = parseCallResult('  ✓ tools/call add → PASS  调用成功\n  [{"type":"text","text":"43"}]\n', 0);
  T('反例 · 状态/退出码对但结果 43≠42 → 必须红',
    judgeCall({ state: 'PASS', code: 0, content: '42' }, a6) === false, JSON.stringify(a6));

  // ── 反例 7：汇总行说 0 失败，但退出码非 0 → 自检不可信 ──
  //   两者矛盾说明断言没跑完就被异常打断。只读汇总文本会当成通过。
  const s7 = auditSelfLayer('  握手：fake 0.0.1\n  协议版本协商\n  isError 通路\n  起不来的命令记 UNKNOWN\n  通过 10   失败 0\n', 1);
  T('反例 · 汇总 0 失败但 exit≠0 → 「全过」必须红',
    (s7.results.find((r) => /项全过/.test(r.name)) || {}).ok === false, JSON.stringify(s7.results.map((r) => [r.name, r.ok])));

  // ── 反例 8：自检缺关键断言（没有 UNKNOWN 那条）→ 对应项必须红 ──
  //   覆盖度缺失也是一种假绿：自检绿只是因为没测那条。
  const s8 = auditSelfLayer('  握手：fake\n  协议版本协商\n  isError 通路\n  通过 8   失败 0\n', 0);
  T('反例 · 自检缺「起不来记 UNKNOWN」断言 → 该项必须红',
    (s8.results.find((r) => /UNKNOWN（不是 FAIL）/.test(r.name)) || {}).ok === false,
    JSON.stringify(s8.results.map((r) => [r.name, r.ok])));

  // ── 反例 9：完全没有汇总行 → 不许当通过 ──
  const s9 = auditSelfLayer('  ✗ 崩了\n', 1);
  T('反例 · 自检没有汇总行 → 判定为红且只输出一行',
    s9.results.length === 1 && s9.results[0].ok === false, JSON.stringify(s9.results));

  // ── 反例 10（四态纪律）：只有 unknown 时退出码必须是 2 ──
  T('反例 · 只 unknown → 退出码 2（不是 0，不是 1）', exitCodeFor({ fail: 0, unknown: 2 }) === 2,
    'got=' + exitCodeFor({ fail: 0, unknown: 2 }));
  T('反例 · 有 fail 时退出码 1（失败优先）', exitCodeFor({ fail: 1, unknown: 5 }) === 1);

  // ── 正例 1：真 server 探测正常 ──
  const pOK = parseProbe('  ✓ PASS  node evidence/mcp-realserver/server.mjs\n  握手成功：nianchu-real-probe 0.1.0 · protocol 2024-11-05 · 列出 3 个工具\n\n  工具（3）:\n    · add\n');
  const jOK = judgeProbe(pOK);
  T('正例 · 真 server 握手 + 3 个工具 → 两项全绿', jOK.handshakeOk && jOK.toolsOk, JSON.stringify(jOK));

  // ── 正例 2：add 17+25=42 ──
  const aOK = parseCallResult('  ✓ tools/call add → PASS  调用成功\n  [{"type":"text","text":"42"}]\n', 0);
  T('正例 · add 返回 42 → 判定通过',
    judgeCall({ state: 'PASS', code: 0, content: '42' }, aOK) === true, JSON.stringify(aOK));

  // ── 正例 3：fail 工具 isError → FAIL/1 是正确的期望 ──
  const aFail = parseCallResult('  ✗ tools/call fail → FAIL  工具返回 isError=true\n  [{"type":"text","text":"故意失败：这个工具永远报错"}]\n', 1);
  T('正例 · isError 记 FAIL/1 且内容含「故意失败」→ 判定通过',
    judgeCall({ state: 'FAIL', code: 1, content: '故意失败' }, aFail) === true, JSON.stringify(aFail));

  // ── 正例 4：完整且健康的自检输出 → 六项全绿 ──
  const sOK = auditSelfLayer('  握手：fake 0.0.1\n  协议版本协商：2024-11-05\n  isError 通路：…\n  起不来的命令记 UNKNOWN（不是 FAIL）：…\n  通过 10   失败 0\n', 0);
  T('正例 · 健康自检输出 → 六项全绿', sOK.results.length === 6 && sOK.results.every((r) => r.ok),
    JSON.stringify(sOK.results.filter((r) => !r.ok).map((r) => r.name)));

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
  console.log('  A13 MCP 客户端验收 · 自检（4 正例 + 11 反例，反例集中在协议四态边界）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (isMain) {
console.log('');
console.log('  A13 MCP 客户端验收 —— 自研，stdio + JSON-RPC 2.0');
console.log('  ' + '─'.repeat(72));

ok(fs.existsSync(CLIENT), 'MCP 客户端在位（tools/mcp/client.mjs）');
const src = fs.existsSync(CLIENT) ? fs.readFileSync(CLIENT, 'utf8') : '';
// 协议四要素必须在源码里真的实现（不是只写在注释里）
for (const [probe, label] of [
  ["'initialize'", 'initialize 握手'],
  ['notifications/initialized', '规范要求的 initialized 通知'],
  ["'tools/list'", 'tools/list'],
  ["'tools/call'", 'tools/call'],
  ['jsonrpc: \'2.0\'', 'JSON-RPC 2.0 封包'],
]) {
  ok(src.includes(probe), '实现 ' + label);
}
// 按行解析（stdio 上一条消息一行，必须自己维护缓冲）
ok(/indexOf\('\\n'\)/.test(src) || /split\('\\n'\)/.test(src), '实现按行 JSON-RPC 缓冲解析（stdio 传输的关键）');

// ── 第一层：自检 ──
console.log('');
console.log('  第一层 · 自检（内置假 server，不依赖外部）');
const self = run(['--selftest']);
const selfLayer = auditSelfLayer(self.out, self.code);
for (const r of selfLayer.results) ok(r.ok, r.name);

// ── 第二层：真 server ──
console.log('');
console.log('  第二层 · 真 MCP server（官方 @modelcontextprotocol/sdk）');
if (!fs.existsSync(REAL_MODULES)) {
  unknown++;
  console.log('  ' + I.un + ' 官方 SDK 没装（evidence/mcp-realserver/node_modules 缺失）—— 真 server 层判不了');
  console.log('     补：cd evidence/mcp-realserver && npm i @modelcontextprotocol/sdk --registry=https://registry.npmmirror.com');
} else if (!fs.existsSync(REAL_SERVER)) {
  unknown++;
  console.log('  ' + I.un + ' 真 server 脚本缺失（evidence/mcp-realserver/server.mjs）');
} else {
  const ver = JSON.parse(fs.readFileSync(path.join(REPO, 'evidence/mcp-realserver/node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8')).version;
  ok(true, '官方 SDK 在位：@modelcontextprotocol/sdk ' + ver);

  const SERVER_ARG = '--server=node evidence/mcp-realserver/server.mjs';
  const probe = runRetry([SERVER_ARG]);
  const pj = judgeProbe(parseProbe(probe.out));
  const initOk = pj.handshakeOk;
  ok(initOk, '连真 server 握手成功' + (initOk ? '' : '：' + probe.out.slice(0, 120)));
  ok(pj.toolsOk, '列出真 server 的 ' + pj.toolCountLabel + ' 个工具');

  // 真调用：每条的期望值都是可独立复算的
  const CALLS = [
    ['add', { a: 17, b: 25 }, '42', 'PASS', 0],
    ['reverse', { text: '念初 Nianchu' }, 'uhcnaiN 初念', 'PASS', 0],
    ['fail', {}, '故意失败', 'FAIL', 1],
    ['nonexistent', {}, '-32602', 'FAIL', 1],
  ];
  for (const [tool, args, expectText, expectState, expectCode] of CALLS) {
    const r = runRetry([SERVER_ARG, '--call=' + tool, '--args=' + JSON.stringify(args)]);
    const got = parseCallResult(r.out, r.code);
    const good = judgeCall({ state: expectState, code: expectCode, content: expectText }, got);
    const gotText = got.content;
    ok(good, 'tools/call ' + tool.padEnd(12) + '→ ' + got.state + ' exit=' + r.code +
      (gotText ? '  「' + gotText.slice(0, 30) + '」' : '') +
      (good ? '' : '  期望 ' + expectState + '/' + expectCode + '/含「' + expectText + '」'));
  }
}

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + '   失败 ' + fail + '   无法判断 ' + unknown);
console.log('');
process.exit(exitCodeFor({ fail, unknown }));
}
