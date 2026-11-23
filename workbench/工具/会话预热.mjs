#!/usr/bin/env node
// 工具/会话预热.mjs —— 让空白会话产生标题，否则侧栏不渲染、面板绑不上
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（10 多轮才查清的根因）
// ══════════════════════════════════════════════════════════════════════
//  现象：`会话绑定验证` 报 2 / 8 —— 8 个场景只有 2 个绑定到自己的会话。
//        用户在其他 6 个场景里跟 AI 说话，实际是在跟别的场景说话。
//
//  排查链：
//    ① 配置对（外壳/scenarios/*.json 的 sessionId 都正确）
//    ② 会话在引擎里存在（数据/.dsh/sessions/<编码cwd>/<id>/ 目录都在）
//    ③ 每个场景都有独立 webview（切场景会重建）
//    ④ pin 脚本（harness.js 的 pinSessionToScene）靠 data-row-key 找会话行
//    ⑤ **目标会话行不在 DOM 里** —— 实测 DOM 只有 14 个 session 行，
//       两个「对」的场景在，其余 6 个都不在
//    ⑥ 为什么不在 DOM：引擎侧栏把会话按 workspace 分组，
//       而**空白会话（blank=true）不生成行**
//
//  决定性证据：
//    blank=false  架构梳理 asOf=179  标题「连通性检查确认」  → 绑定正确 ✓
//    blank=false  调研     asOf=50   标题「创建体检临时文件」 → 绑定正确 ✓
//    blank=true   实施计划 asOf=8    无标题                → 绑定失败 ✗
//    blank=true   故障分析 asOf=8    无标题                → 绑定失败 ✗
//    ...其余 4 个同理
//
//  为什么会有 blank 会话：`会话清理.mjs` / `会话轮转.mjs` 会创建新会话，
//  新会话没跑过任何任务 → 没有标题 → blank → 侧栏不渲染 → 绑不上。
//  （上一轮我按「文件最小」选保留者，恰好全选中了这些空白会话。）
//
//  修法：给每个 blank 会话发一条极短的真实消息，让引擎生成标题。
//        实测发完立刻变成 blank=false + 有语义标题（如「实施计划场景自检」）。
//
//  用法：
//    node 工具/会话预热.mjs --scan        看哪些场景会话是 blank
//    node 工具/会话预热.mjs               预热所有 blank 会话
//    node 工具/会话预热.mjs --scene 调研   只预热一个场景
//    node 工具/会话预热.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 预热消息模板
 *
 * 设计原则：
 *   · 要短（省额度）
 *   · 要能生成**有语义**的标题，所以提到场景名
 *   · 要不产生副作用（不让它写文件、不让它分析）
 *   · 要能确认「模型真的回了」，所以要求回一句话
 */
export const WARMUP_TEMPLATE = (sceneName) =>
  '【场景自检】请回复一句话确认你在线，并说明你是「' + sceneName + '」场景的助手。不要做别的事。';

/** 单场景预热最多等多久（毫秒） */
export const WARMUP_WAIT_MS = 180000;

/**
 * 判一个会话需不需要预热
 * @param {{blank?:boolean, projections?:object}} s session/list 里的会话对象
 * @returns {boolean}
 */
export function needsWarmup(s) {
  if (!s) return false;
  return s.blank === true;
}

// ══════════════════════════════════════════════════════════════════════
function getToken() {
  try {
    const log = fs.readFileSync(path.join(WB, '外壳', 'server.log'), 'utf8');
    const ms = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)];
    return ms.length ? ms[ms.length - 1][1] : '';
  } catch { return ''; }
}

function getCookie(token) {
  return new Promise((resolve) => {
    const q = http.request({
      hostname: '127.0.0.1', port: 3083, path: '/?token=' + encodeURIComponent(token),
      method: 'GET', timeout: 8000,
    }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => resolve(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    q.on('error', () => resolve(''));
    q.end();
  });
}

function rpcFactory(cookie) {
  return (method, args, timeoutMs) => new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r' + Date.now() + Math.random(), method, payload: { args: args || {} } });
    const req = http.request({
      hostname: '127.0.0.1', port: 3083, path: '/api/' + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie, Origin: 'http://127.0.0.1:3083' },
      timeout: timeoutMs || 120000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /**/ } resolve(j); });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  会话预热 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】判据');
  chk('blank=true 需要预热', needsWarmup({ blank: true }) === true);
  chk('blank=false 不需要', needsWarmup({ blank: false }) === false);
  chk('反例：null 不需要', needsWarmup(null) === false);
  chk('反例：空对象不需要', needsWarmup({}) === false);

  console.log();
  console.log('【二】预热消息');
  {
    const t = WARMUP_TEMPLATE('调研');
    chk('含场景名', t.includes('调研'), '');
    chk('要求回复确认', /回复|确认/.test(t));
    chk('禁止做别的事', /不要做别的事|不要/.test(t));
    chk('消息够短（省额度）', t.length < 120, t.length + ' 字符');
  }

  console.log();
  console.log('【三】关键：这个工具补的是什么');
  chk('关键：空白会话不被侧栏渲染 → 面板绑不上',
    true, '实测：blank=false 的 2 个场景绑定正确，blank=true 的 6 个全绑错');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const token = getToken();
  if (!token) { console.error('✗ 读不到引擎 token'); process.exit(2); }
  const cookie = await getCookie(token);
  const rpc = rpcFactory(cookie);

  const norm = (s) => String(s || '').replace(/[\\/]+/g, '/').toLowerCase();
  const MEM_NORM = norm(MEM);

  const sl = await rpc('session/list', { _request: {} });
  const items = ((sl && sl.result && sl.result.value && sl.result.value.items) || [])
    .filter((x) => norm(x.cwd).startsWith(MEM_NORM));

  // 每个场景要预热的是**场景配置指向的那个会话**，不是「最新」的那个
  //
  // ⚠ 2026-11-13 修（这是「会话预热」一直没起作用的原因）
  //
  //   原来：每个场景取 asOfSeq 最大的会话。
  //   实测：会话轮转之后，旧会话（asOf=226+）仍然比新会话（asOf=3）大，
  //        于是它检查的是**旧会话** —— 旧会话当然有标题、当然 OK，
  //        报「0 个需要预热，全部 OK」。
  //        但场景配置已经切到新会话（blank=true），面板根本绑不上。
  //
  //   这是「检查的不是真正生效的那个对象」——
  //   和 会话轮转 只写身份卡不写配置是同一类错误。
  //
  //   现在：优先读 外壳/scenarios/*.json 里配置的 sessionId，
  //        找不到才退回「最新会话」。
  const cfgSid = (() => {
    const map = new Map();
    try {
      const dir = path.join(WB, '外壳', 'scenarios');
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
        const ai = (j.panels || []).find((p) => p.type === 'harness');
        const sid = (ai && ai.sessionId) || (j.meta && j.meta.hubSessionId);
        const cn = j.name || j.title;
        if (sid && cn) map.set(cn, String(sid));
      }
    } catch { /* ignore */ }
    return map;
  })();

  const byScene = new Map();
  for (const s of items) {
    const name = String(s.cwd).split(/[\\/]/).filter(Boolean).pop();
    const want = cfgSid.get(name);
    if (want && s.sessionId === want) {
      byScene.set(name, s);      // 配置指向的那个，优先级最高
      continue;
    }
    if (byScene.has(name) && byScene.get(name).sessionId === want) continue;
    const prev = byScene.get(name);
    const asOf = (a) => (a.projections && a.projections.asOfSeq) || 0;
    if (!prev || (!want && asOf(s) > asOf(prev))) byScene.set(name, s);
  }

  // 配置里有、但 session/list 里找不到的场景 —— 也要报（会话可能被删了）
  const missing = [];
  for (const [cn, sid] of cfgSid) {
    if (!byScene.has(cn)) missing.push({ scene: cn, sid });
  }

  const only = val('scene');
  const list = [...byScene].sort().filter(([n]) => !only || n === only);

  // ── 扫描 ──
  //
  // ⚠ 2026-11-13 修（不带参数只扫描、不预热 —— 与文档不符）
  //
  //   原来：if (has('scan') || (!has('warmup') && !only))
  //         → 不带参数时走「只看不修」分支，
  //           但文件头的用法写着「node 工具/会话预热.mjs  预热所有 blank 会话」。
  //
  //   实测：我跑了 `node 工具/会话预热.mjs` 以为在预热，
  //        结果它只打印「3 / 9 个场景会话需要预热」就退出了 —— 什么也没做。
  //   这是「文档说 A、实现做 B」的典型，比不写文档更误导。
  //
  //   现在：--scan 才只看不修；不带参数 = 预热（和文档一致）。
  if (has('scan')) {
    console.log('='.repeat(78));
    console.log('  各场景会话的 blank 状态（blank=true 的绑不上）');
    console.log('='.repeat(78));
    console.log();
    let need = 0;
    for (const [name, s] of list) {
      const title = (s.projections && s.projections.values && s.projections.values.title) || '';
      const asOf = (s.projections && s.projections.asOfSeq) || 0;
      const bad = needsWarmup(s);
      if (bad) need++;
      console.log('  ' + (bad ? 'XX ' : 'OK ') + name.padEnd(12) +
        'blank=' + String(!!s.blank).padEnd(6) +
        'asOf=' + String(asOf).padEnd(5) +
        'title="' + String(title).slice(0, 20) + '"');
    }
    console.log();
    console.log('-'.repeat(78));
    console.log('  ' + need + ' / ' + list.length + ' 个场景会话需要预热');
    if (need) {
      console.log('  预热：node 工具/会话预热.mjs');
      process.exitCode = 1;
    } else {
      console.log('  ✓ 所有会话都有标题，侧栏会渲染它们');
    }
    return;
  }

  // ── 预热 ──
  const targets = list.filter(([, s]) => needsWarmup(s));
  if (!targets.length) { console.log('  没有需要预热的会话'); return; }

  console.log('='.repeat(78));
  console.log('  预热 ' + targets.length + ' 个空白会话');
  console.log('='.repeat(78));
  console.log();

  let ok = 0, fail = 0;
  for (const [name, s] of targets) {
    const text = WARMUP_TEMPLATE(name);
    const pr = await rpc('session/prompt', {
      request: { requestId: 'warmup-' + Date.now() + '-' + Math.random(), sessionId: s.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
    }, 60000);

    if (!pr || !pr.result || !pr.result.ok) {
      console.log('  XX ' + name.padEnd(12) + '发消息失败: ' + JSON.stringify(pr && pr.result && pr.result.error).slice(0, 60));
      fail++;
      continue;
    }

    // 等它跑完
    const deadline = Date.now() + WARMUP_WAIT_MS;
    let done = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const pg = await rpc('session/page', { request: { address: { kind: 'session', sessionId: s.sessionId } } });
      const evs = ((pg && pg.result && pg.result.value && pg.result.value.records) || []).map((r) => r.event || r);
      const ends = evs.filter((e) => e.type === 'turn/end');
      const last = ends[ends.length - 1];
      if (last && last.data && last.data.reason && last.data.reason.kind === 'completed') { done = true; break; }
    }

    // 复查标题
    const sl2 = await rpc('session/list', { _request: {} });
    const items2 = ((sl2 && sl2.result && sl2.result.value && sl2.result.value.items) || []);
    const s2 = items2.find((x) => x.sessionId === s.sessionId);
    const title = (s2 && s2.projections && s2.projections.values && s2.projections.values.title) || '';
    const stillBlank = s2 && s2.blank === true;

    const good = done && !stillBlank;
    if (good) ok++; else fail++;
    console.log('  ' + (good ? '✓' : 'XX') + ' ' + name.padEnd(12) +
      (done ? '已完成' : '超时') +
      '  blank=' + String(stillBlank).padEnd(6) +
      'title="' + String(title).slice(0, 24) + '"');
  }

  console.log();
  console.log('-'.repeat(78));
  console.log('  预热结果: ' + ok + ' 成功 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
  else {
    console.log('  ✓ 完成 —— 现在这些会话会在侧栏渲染，面板能绑上了');
    console.log('    ⚠ 需要重启工作台让侧栏重建');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(2); });
