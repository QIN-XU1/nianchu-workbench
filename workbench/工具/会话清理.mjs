#!/usr/bin/env node
// 工具/会话清理.mjs —— 一个场景有多个会话时，保留一个，删掉其余
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（会话轮转的副作用）
// ══════════════════════════════════════════════════════════════════════
//  `会话轮转.mjs` 每次换新会话，旧会话都留着。
//  实测后果：一个场景积累 4 个会话：
//
//    故障分析:
//      session-f66c6447  478 事件   ← 轮转前的旧大会话
//      session-15a1f611   40 事件   ← 又一次轮转
//      session-13f125e4   38 事件   ← 身份卡指向这个
//      session-c433a410    9 事件
//
//  然后三类工具各绑不同的：
//    · 身份卡 → session-13f125e4
//    · 投递   → 选「事件最少的」→ 可能选到 session-15a1f611
//    · 界面面板 → 引擎按它自己的记录，可能是 session-f66c6447
//
//  于是「消息到达会话」这一步在界面体检里必红 ——
//  因为界面发到的会话，和检查看的会话不是同一个。
//
//  这个工具：保留「最新且事件最少」的那个，其余删掉。
//
//  用法：
//    node 工具/会话清理.mjs --scan            看每个场景有几个会话
//    node 工具/会话清理.mjs --clean           所有多会话场景只留一个
//    node 工具/会话清理.mjs --clean 故障分析   只清理指定场景
//    node 工具/会话清理.mjs --selftest
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
 * 一个场景保留几个会话
 *
 * 只能留 1 个 —— 因为身份卡、投递、界面面板三方必须指向同一个。
 */
export const KEEP_PER_SCENE = 1;

/**
 * 选哪个会话保留
 *
 * 判据：事件最少的（= 最新的新会话，历史干净，不会撞模型额度）。
 * 事件数相同时取 updatedAt 更新的。
 *
 * @param {Array<{sessionId:string, events:number, updatedAt:number}>} list
 * @returns {object|null} 要保留的那个
 */
export function chooseKeeper(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const sorted = [...list].sort((a, b) => {
    if ((a.events || 0) !== (b.events || 0)) return (a.events || 0) - (b.events || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return sorted[0];
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
    const q = http.request({ hostname: '127.0.0.1', port: 3083, path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 8000 }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => resolve(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    q.on('error', () => resolve(''));
    q.end();
  });
}

function rpcFactory(cookie) {
  return (method, args) => new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r' + Date.now() + Math.random(), method, payload: { args: args || {} } });
    const req = http.request({
      hostname: '127.0.0.1', port: 3083, path: '/api/' + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie, Origin: 'http://127.0.0.1:3083' },
      timeout: 60000,
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
  console.log('  会话清理 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】判据常量');
  chk('每个场景只留 1 个', KEEP_PER_SCENE === 1);

  console.log();
  console.log('【二】选保留者：事件最少的');
  {
    const list = [
      { sessionId: 'A', events: 478, updatedAt: 1794505269130 },
      { sessionId: 'B', events: 40, updatedAt: 1794504921334 },
      { sessionId: 'C', events: 38, updatedAt: 1794501485771 },
      { sessionId: 'D', events: 9, updatedAt: 1794352327317 },
    ];
    const k = chooseKeeper(list);
    chk('选事件最少的', k && k.sessionId === 'D', k ? k.sessionId + ' (' + k.events + ' 事件)' : 'null');
    chk('不选事件最多的', k && k.sessionId !== 'A');
  }

  console.log();
  console.log('【三】事件数相同取更新的');
  {
    const list = [
      { sessionId: 'X', events: 10, updatedAt: 1000 },
      { sessionId: 'Y', events: 10, updatedAt: 2000 },
    ];
    const k = chooseKeeper(list);
    chk('同事件数取 updatedAt 大的', k && k.sessionId === 'Y', k ? k.sessionId : 'null');
  }

  console.log();
  console.log('【四】反例：边界情况');
  {
    chk('空数组返回 null', chooseKeeper([]) === null);
    chk('null 返回 null', chooseKeeper(null) === null);
    chk('单元素返回它自己', chooseKeeper([{ sessionId: 'Z', events: 5 }])?.sessionId === 'Z');
  }

  console.log();
  console.log('【五】关键：为什么必须只留一个');
  chk('关键：身份卡/投递/界面三方必须指向同一会话',
    KEEP_PER_SCENE === 1,
    '实测：4 个会话并存时，三方各绑不同的 → 「消息到达会话」必红');

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

  // 按场景分组（全部会话，不只最新的）
  const byScene = new Map();
  for (const s of items) {
    const name = String(s.cwd).split(/[\\/]/).filter(Boolean).pop();
    if (!byScene.has(name)) byScene.set(name, []);
    byScene.get(name).push(s);
  }

  // 统计每个会话的事件数
  const sceneData = [];
  for (const [name, sess] of [...byScene].sort()) {
    const list = [];
    for (const s of sess) {
      const p = await rpc('session/page', { request: { address: { kind: 'session', sessionId: s.sessionId } } });
      const n = ((p && p.result && p.result.value && p.result.value.records) || []).length;
      list.push({ sessionId: s.sessionId, events: n, updatedAt: Number(s.updatedAt || 0), running: !!s.running });
    }
    sceneData.push({ name, sessions: list, keeper: chooseKeeper(list) });
  }

  const multi = sceneData.filter((x) => x.sessions.length > KEEP_PER_SCENE);

  // ── 扫描 ──
  if (has('scan') || (!has('clean') && !has('clean-all'))) {
    console.log('='.repeat(78));
    console.log('  各场景的会话数（每场景应只留 ' + KEEP_PER_SCENE + ' 个）');
    console.log('='.repeat(78));
    console.log();
    for (const x of sceneData) {
      const mark = x.sessions.length > KEEP_PER_SCENE ? 'XX' : 'OK';
      console.log('  ' + mark + ' ' + x.name.padEnd(12) + x.sessions.length + ' 个会话' +
        (x.sessions.length > KEEP_PER_SCENE ? '   ← 该清理' : ''));
      if (x.sessions.length > KEEP_PER_SCENE) {
        for (const s of x.sessions) {
          const isKeeper = s.sessionId === x.keeper.sessionId;
          console.log('       ' + (isKeeper ? '保留' : '删除') + '  ' +
            s.sessionId.slice(0, 26) + '  ' + String(s.events).padStart(4) + ' 事件' +
            (s.running ? '  ⚠ 正在跑' : ''));
        }
      }
    }
    console.log();
    console.log('-'.repeat(78));
    console.log('  ' + multi.length + ' 个场景有多个会话');
    if (multi.length) {
      console.log('  清理：node 工具/会话清理.mjs --clean');
      process.exitCode = 1;
    } else {
      console.log('  ✓ 每个场景只有一个会话');
    }
    return;
  }

  // ── 清理 ──
  const only = val('clean');
  const targets = only ? multi.filter((x) => x.name === only) : multi;
  if (!targets.length) {
    console.log('  没有需要清理的场景');
    return;
  }

  console.log('='.repeat(78));
  console.log('  清理 ' + targets.length + ' 个场景的多余会话');
  console.log('='.repeat(78));
  console.log();

  let ok = 0, fail = 0;
  for (const t of targets) {
    const keeper = t.keeper;
    const toDelete = t.sessions.filter((s) => s.sessionId !== keeper.sessionId);

    // 正在跑的不删
    const running = toDelete.filter((s) => s.running);
    const deletable = toDelete.filter((s) => !s.running);

    if (running.length) {
      console.log('  ⚠ ' + t.name.padEnd(12) + ' 有 ' + running.length + ' 个正在跑的会话，跳过');
    }

    let deleted = 0;
    for (const s of deletable) {
      const r = await rpc('session/delete', { request: { sessionId: s.sessionId } });
      const good = r && r.result && r.result.ok;
      if (good) deleted++;
    }

    // 更新身份卡指向保留者
    let cardOk = false;
    const idCard = path.join(MEM, t.name, '身份卡.md');
    if (fs.existsSync(idCard)) {
      try {
        let c = fs.readFileSync(idCard, 'utf8');
        if (/sessionId\s*[:：]/i.test(c)) {
          c = c.replace(/sessionId\s*[:：].*/i, 'sessionId: ' + keeper.sessionId);
        } else {
          c = c.trimEnd() + '\n\nsessionId: ' + keeper.sessionId + '\n';
        }
        fs.writeFileSync(idCard, c, 'utf8');
        cardOk = true;
      } catch { /* ignore */ }
    }

    const good = deleted === deletable.length;
    if (good) ok++; else fail++;
    console.log('  ' + (good ? '✓' : 'XX') + ' ' + t.name.padEnd(12) +
      '删除 ' + deleted + '/' + deletable.length + ' 个，保留 ' +
      keeper.sessionId.slice(0, 26) + '（' + keeper.events + ' 事件）' +
      (cardOk ? '  ✓ 身份卡已更新' : '  ⚠ 身份卡没更新'));
  }

  console.log();
  console.log('-'.repeat(78));
  console.log('  清理结果: ' + ok + ' 成功 / ' + fail + ' 失败');
  if (fail > 0) process.exitCode = 1;
  else console.log('  ✓ 完成 —— 现在每个场景只有一个会话，三方绑定不会再分裂');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(2); });
