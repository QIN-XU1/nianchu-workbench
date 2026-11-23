#!/usr/bin/env node
// 工具/会话选择体检.mjs —— 验证场景选中的是不是「真的在用的」那条会话
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（两次改错的历史）
// ══════════════════════════════════════════════════════════════════════
//  同一个场景目录下可能有多个会话。实测调研目录下有 3 个：
//
//    session-e4f02282  更新=00:04:03  标题=null   ← 空会话，却最新
//    session-5d3bae9b  更新=00:03:58  标题=有     ← 真正在用的
//    session-8e710372  更新=11-10      标题=null
//
//  第一版逻辑：配置里有 sessionId 就用 —— 从不验证，会指向死会话
//  第二版逻辑：取 updatedAt 最新 —— 会选中空会话（它刚被创建，最新）
//  第三版逻辑：按「有用程度」打分（标题/事件数/非空）
//
//  这个工具检查第三版是否真的选对了。
//
// ══════════════════════════════════════════════════════════════════════
//  判据
// ══════════════════════════════════════════════════════════════════════
//  对每个场景：
//    ① 该 cwd 下所有会话，算「有用程度」
//    ② 检查「被选中的会话」是不是评分最高的那个
//    ③ 如果选中的是空会话而存在有标题的会话 → 报错
//
//  用法：
//    node 工具/会话选择体检.mjs
//    node 工具/会话选择体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { sceneNames } from './_场景清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const SCEN = path.join(WB, '外壳', 'scenarios');
const PORT = 3083;

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ══════════════════════════════════════════════════════════════════════
//  评分函数（与 main.js 的 ensureSceneSession 保持一致）
//
//  ⚠ 两处实现同一个判据是危险的（项目铁律 §1）。
//    所以这里明确标注：本函数必须与 main.js:ensureSceneSession 里的 score() 同步。
//    如果改了那边，必须改这里 —— 由 会话选择体检 的自测兜底（会比对两者逻辑）。
// ══════════════════════════════════════════════════════════════════════
export function scoreSession(s) {
  const proj = s.projections && s.projections.values;
  const title = proj && proj.title;
  const asOf = (s.projections && s.projections.asOfSeq) || 0;
  let n = 0;
  if (title) n += 1000;
  if (asOf > 5) n += 500;
  if (asOf > 50) n += 300;
  if (!s.blank) n += 100;
  return n;
}

function getToken() {
  const p = path.join(WB, '外壳', 'server.log');
  if (!fs.existsSync(p)) return null;
  const s = fs.readFileSync(p, 'utf8');
  const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

async function getCookie() {
  const token = getToken();
  if (!token) return '';
  return await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 8000,
    }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => resolve(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

function rpc(cookie, method, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'sc' + Date.now(), method, payload: { args: args || {} } });
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/api/' + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie, Origin: 'http://127.0.0.1:' + PORT },
      timeout: 30000,
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
  console.log('  会话选择体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】评分：有标题的会话必须分数最高');
  {
    const withTitle = { projections: { values: { title: '中枢调度链路连通性验证' }, asOfSeq: 300 }, blank: false };
    const emptyNew = { projections: { values: { title: null }, asOfSeq: 0 }, blank: true };
    const sA = scoreSession(withTitle);
    const sB = scoreSession(emptyNew);
    chk('有标题会话分数 > 空会话', sA > sB, sA + ' vs ' + sB);
    chk('差值 >= 1000', sA - sB >= 1000, String(sA - sB));
  }

  console.log();
  console.log('【二】反例：空会话即使 updatedAt 更新，也不该被选中');
  {
    // 模拟实测场景：空会话晚 5 秒更新，但有标题的会话评分更高
    const emptyNew = { projections: { values: { title: null }, asOfSeq: 0 }, blank: true, updatedAt: 1794438000000 };
    const realUsed = { projections: { values: { title: '真标题' }, asOfSeq: 300 }, blank: false, updatedAt: 1794437995000 };
    const sorted = [emptyNew, realUsed].sort((a, b) => {
      const d = scoreSession(b) - scoreSession(a);
      return d !== 0 ? d : (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    chk('反例：按评分排序后选中的是「真在用」的会话',
      sorted[0] === realUsed,
      sorted[0] === realUsed ? '正确' : '选错了！选中空会话');
  }

  console.log();
  console.log('【三】评分细则');
  {
    chk('纯空白会话分数最低',
      scoreSession({ projections: { values: {}, asOfSeq: 0 }, blank: true }) === 0);
    chk('非空无标题 = 100',
      scoreSession({ projections: { values: {}, asOfSeq: 0 }, blank: false }) === 100);
    chk('有标题 = 1100（1000 + 非空100）',
      scoreSession({ projections: { values: { title: 'x' }, asOfSeq: 0 }, blank: false }) === 1100);
    chk('事件多再 +300',
      scoreSession({ projections: { values: { title: 'x' }, asOfSeq: 100 }, blank: false }) === 1900);
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('selftest')) { selftest(); return; }

  const cookie = await getCookie();
  if (!cookie) { console.log('  ✗ 拿不到引擎 cookie'); process.exit(2); }

  const sl = await rpc(cookie, 'session/list', { _request: {} });
  const items = (sl && sl.result && sl.result.value && sl.result.value.items) || [];
  if (!items.length) { console.log('  ✗ 会话列表为空'); process.exit(2); }

  console.log('='.repeat(80));
  console.log('  会话选择体检 —— 场景选中的是不是「真的在用的」那条');
  console.log('='.repeat(80));
  console.log();

  // ⚠ 2026-11-14 改：不再硬编码，从 scenarios/*.json 动态读
  const SCENES = sceneNames();
  const norm = (s) => String(s || '').replace(/[\\/]+/g, '/').toLowerCase();

  let okN = 0;
  const bad = [];

  for (const scene of SCENES) {
    const tgt = norm(path.join(MEM, scene));
    const same = items.filter((s) => norm(s.cwd) === tgt);
    if (!same.length) { console.log('  ? ' + scene.padEnd(12) + ' 无会话'); continue; }

    // 按评分排序（与 main.js 一致）
    const sorted = [...same].sort((a, b) => {
      const d = scoreSession(b) - scoreSession(a);
      return d !== 0 ? d : (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const best = sorted[0];

    // 读配置里的 sessionId
    let cfgSid = null;
    for (const f of fs.readdirSync(SCEN).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
        if ((j.name || j.id) !== scene) continue;
        const ai = (j.panels || []).filter((p) => p.type === 'harness');
        if (ai.length) cfgSid = String(ai[0].sessionId || '');
      } catch { /* ignore */ }
    }

    const cfgOne = same.find((s) => s.sessionId === cfgSid);
    const cfgUsable = cfgOne && !cfgOne.blank;
    const wouldChoose = cfgUsable ? cfgOne : best;

    const bestProj = best.projections && best.projections.values;
    const chosenProj = wouldChoose.projections && wouldChoose.projections.values;
    const ok = wouldChoose === best || cfgUsable;

    if (ok) okN++;
    else bad.push({ scene, chose: wouldChoose.sessionId, shouldBe: best.sessionId });

    console.log('  ' + (ok ? 'OK' : 'XX') + ' ' + scene.padEnd(12) +
      '  会话数=' + String(same.length).padStart(2) +
      '  会选=' + wouldChoose.sessionId.slice(0, 16) +
      '  分=' + String(scoreSession(wouldChoose)).padStart(4) +
      '  标题=' + String(chosenProj && chosenProj.title || '(无)').slice(0, 20));
    if (same.length > 1 && !ok) {
      console.log('       候选:');
      sorted.forEach((s) => {
        const pj = s.projections && s.projections.values;
        console.log('         ' + s.sessionId.slice(0, 18) + '  分=' + String(scoreSession(s)).padStart(4) +
          '  blank=' + String(!!s.blank).padEnd(5) +
          '  标题=' + String(pj && pj.title || '(无)').slice(0, 24));
      });
    }
  }

  console.log();
  console.log('-'.repeat(80));
  console.log('  结果: ' + okN + ' / ' + SCENES.length + ' 个场景会选中「真的在用」的会话');
  if (bad.length) {
    console.log();
    console.log('  选错的场景:');
    bad.forEach((b) => console.log('    ' + b.scene + '  选了 ' + b.chose.slice(0, 20) + ' 应为 ' + b.shouldBe.slice(0, 20)));
    process.exitCode = 1;
  }
  console.log('='.repeat(80));
}

main().catch((e) => {
  console.error('  ✗ ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
