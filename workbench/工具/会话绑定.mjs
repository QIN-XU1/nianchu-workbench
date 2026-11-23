#!/usr/bin/env node
/**
 * 会话绑定 —— 场景 json 里三个字段必须有
 *
 * ══════════════════════════════════════════════════════════════
 *  依据（参考项目 02-会话定位与跟随/二-会话绑定三字段.md）
 *  他自己标注为「★ 全仓库最核心的一页」
 * ══════════════════════════════════════════════════════════════
 *
 *  > 「场景 json 里那三个字段 —— `sessionTitle` / `sessionId` / `pinTarget` ——
 *  >   决定『点开这个场景时，AI 面板显示的是哪一条会话』。
 *  >   **三个字段少写一个不会报错，只会悄悄退化成『随便显示一条』或『让用户自己选』。**」
 *
 *  | 字段 | 一句话 | 作用 |
 *  |---|---|---|
 *  | `pinTarget`    | 找谁     | 候选名列表，模糊匹配 |
 *  | `sessionTitle` | 精确是谁 | 完整真实标题，要求完全相等 |
 *  | `sessionId`    | 验明正身 | 引擎真实 id，能核对画面、写键直达 |
 *
 *  【少了会怎样】
 *  | 写了什么 | 结果 |
 *  |---|---|
 *  | 三个都不写 | 不钉会话，切场景时跟着上一条跑 |
 *  | 只写 pinTarget | 标题会重名、差空格、被改名——认错人 |
 *  | pinTarget + sessionTitle | 基本可靠，但**「画面到底切过去了没有」无从验证** |
 *  | 再加 sessionId | 才能**核对** |
 *
 *  【他的三条硬结论】
 *  1. 必须给会话 id，不能只靠标题认人
 *  2. **判断「到位了没有」只能看画面**——存储值是你自己写的，画面才是结果
 *  3. 一个 AI 面板一个独立分区（否则多面板抢同一个「当前会话」键）
 *
 * ══════════════════════════════════════════════════════════════
 *  我们实测的问题
 * ══════════════════════════════════════════════════════════════
 *
 *  8 个 AI 面板全部只有 pinTarget + sessionTitle，**没有 sessionId**。
 *  按他的标准：这是「基本可靠但无法核对画面」的状态。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/会话绑定.mjs --check            检查三字段完整性
 *  node 工具/会话绑定.mjs --fix --apply      自动补齐（从身份索引读真实 id）
 *  node 工具/会话绑定.mjs --verify-engine    验证 sessionId 在引擎里真实存在
 *  node 工具/会话绑定.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN = path.join(WB, '外壳', 'scenarios');
const SHARED = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆');
const PORT = 3083;

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

// ══════════════════════════════════════════════════════════════
//  三字段定义
// ══════════════════════════════════════════════════════════════
export const BINDING_FIELDS = [
  { key: 'pinTarget', name: '找谁', required: true, why: '候选名列表，模糊匹配' },
  { key: 'sessionTitle', name: '精确是谁', required: true, why: '完整真实标题，要求完全相等' },
  { key: 'sessionId', name: '验明正身', required: true, why: '引擎真实 id，能核对画面' },
];

/** 会话 id 格式 */
export const SESSION_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 占位符（抄了就等于没配） */
export const PLACEHOLDER_RE = /^session-0{8}|^session-x{4}|0000-0000|xxxx-xxxx|^$/i;

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  读身份索引
// ══════════════════════════════════════════════════════════════
export function loadIdentity() {
  const j = readJsonSafe(path.join(SHARED, '身份索引.json')) || { rows: [] };
  const map = {};
  for (const r of (j.rows || [])) {
    if (r.scene) map[r.scene] = { sessionId: r.sessionId || null, name: r.name || null };
  }
  return map;
}

// ══════════════════════════════════════════════════════════════
//  检查一个场景的三个字段
// ══════════════════════════════════════════════════════════════
export function checkScene(sceneJson, identity) {
  const j = sceneJson || {};
  const panels = (j.panels || []).filter((p) => p.type === 'harness');
  const id = identity || {};

  const results = panels.map((p) => {
    const problems = [];

    // ① pinTarget
    const pt = p.pinTarget;
    if (!Array.isArray(pt) || pt.length === 0) {
      problems.push('缺 pinTarget（找谁）');
    }

    // ② sessionTitle
    if (!p.sessionTitle || String(p.sessionTitle).trim().length === 0) {
      problems.push('缺 sessionTitle（精确是谁）');
    }

    // ③ sessionId
    const sid = p.sessionId;
    if (!sid || String(sid).trim().length === 0) {
      problems.push('缺 sessionId（验明正身）—— 无法核对画面');
    } else if (PLACEHOLDER_RE.test(String(sid))) {
      problems.push('sessionId 是占位符（' + String(sid).slice(0, 20) + '）—— 抄占位符等于没配');
    } else if (!SESSION_RE.test(String(sid))) {
      problems.push('sessionId 格式不合法：' + String(sid).slice(0, 24));
    } else if (id.sessionId && String(sid) !== String(id.sessionId)) {
      problems.push('sessionId 与身份索引不一致（配置：' + String(sid).slice(0, 16) +
        '… / 索引：' + String(id.sessionId).slice(0, 16) + '…）');
    }

    return {
      panelId: p.id,
      title: p.title || '',
      ok: problems.length === 0,
      problems,
      has: {
        pinTarget: Array.isArray(pt) && pt.length > 0,
        sessionTitle: !!(p.sessionTitle && String(p.sessionTitle).trim()),
        sessionId: !!(sid && String(sid).trim() && !PLACEHOLDER_RE.test(String(sid)) && SESSION_RE.test(String(sid))),
      },
    };
  });

  // ⚠ 2026-11-12 修（判据错误，导致 --check 永远 FAIL）：
  //
  //   原来：const allOk = results.length > 0 && results.every((r) => r.ok);
  //   问题：没有 AI 面板的场景（results.length === 0）→ allOk = false → 判不合格。
  //
  //   实测：中枢的场景配置只有 hub-neuron（neuron 类型），没有 harness 面板。
  //        那是设计如此 —— 中枢是调度者，不执行业务，不需要 AI 对话面板。
  //        但 --check 因此永远报「缺 sessionId = 无法核对画面」并 exit 1。
  //
  //   正确判据：
  //     · 有 AI 面板 → 三个字段必须齐全
  //     · 没有 AI 面板 → 不适用，不算失败（但要在输出里明示「无AI面板」）
  const allOk = results.length === 0 ? true : results.every((r) => r.ok);

  return {
    sceneId: j.id,
    sceneName: j.name || j.id,
    panelCount: results.length,
    panels: results,
    ok: allOk,
    // 分级判定
    level: results.length === 0 ? '无AI面板'
      : allOk ? '完整（可核对画面）'
      : results.every((r) => r.has.pinTarget && r.has.sessionTitle && !r.has.sessionId)
        ? '基本可靠但无法核对画面'
        : '有缺陷',
  };
}

// ══════════════════════════════════════════════════════════════
//  检查所有场景
// ══════════════════════════════════════════════════════════════
export function checkAll(opts) {
  const o = opts || {};
  const scenes = o.scenes || loadSceneFiles();
  const identity = o.identity || loadIdentity();
  const results = scenes.map((s) => checkScene(s.json, identity[s.json.id] || {}));

  const byLevel = {};
  for (const r of results) byLevel[r.level] = (byLevel[r.level] || 0) + 1;

  return {
    ok: results.every((r) => r.ok),
    total: results.length,
    results,
    byLevel,
    incomplete: results.filter((r) => !r.ok).length,
  };
}

export function loadSceneFiles() {
  const out = [];
  if (!fs.existsSync(SCEN)) return out;
  for (const f of fs.readdirSync(SCEN)) {
    if (!f.endsWith('.json')) continue;
    const j = readJsonSafe(path.join(SCEN, f));
    if (j && j.id) out.push({ file: f, json: j, path: path.join(SCEN, f) });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  补齐（从身份索引读真实 id）
// ══════════════════════════════════════════════════════════════
export function fixScene(sceneFile, identity, opts) {
  const o = opts || {};
  const j = JSON.parse(JSON.stringify(sceneFile.json));
  const id = identity[j.id] || {};
  const changes = [];

  if (!id.sessionId) {
    return { ok: false, error: '身份索引里没有这个场景的 sessionId', sceneId: j.id };
  }

  for (const p of (j.panels || [])) {
    if (p.type !== 'harness') continue;

    // pinTarget
    if (!Array.isArray(p.pinTarget) || p.pinTarget.length === 0) {
      p.pinTarget = [j.name || j.id];
      changes.push(p.id + '.pinTarget = ' + JSON.stringify(p.pinTarget));
    }

    // sessionTitle
    if (!p.sessionTitle) {
      p.sessionTitle = j.name || j.id;
      changes.push(p.id + '.sessionTitle = ' + p.sessionTitle);
    }

    // sessionId
    if (!p.sessionId || PLACEHOLDER_RE.test(String(p.sessionId)) || !SESSION_RE.test(String(p.sessionId))) {
      p.sessionId = id.sessionId;
      changes.push(p.id + '.sessionId = ' + id.sessionId.slice(0, 24) + '…');
    }
  }

  return { ok: true, json: j, changes, sceneId: j.id, file: sceneFile.path };
}

// ══════════════════════════════════════════════════════════════
//  验证 sessionId 在引擎里真实存在（他的第 2 条硬结论：判据看画面）
// ══════════════════════════════════════════════════════════════
function getToken() {
  const s = readTextSafe(path.join(WB, '外壳', 'server.log'));
  if (!s) return null;
  const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

function request(method, p, body, cookie) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), ...(cookie ? { cookie } : {}) },
      timeout: 30000,
    }, (re) => { let b = ''; re.on('data', (c) => { b += c; }); re.on('end', () => res({ h: re.headers, b })); });
    r.on('error', (e) => res({ h: {}, b: JSON.stringify({ error: e.message }) }));
    r.on('timeout', () => { r.destroy(); res({ h: {}, b: JSON.stringify({ error: 'timeout' }) }); });
    r.write(d); r.end();
  });
}

export async function verifyInEngine() {
  const token = getToken();
  if (!token) return { ok: false, error: '读不到引擎 token（引擎没运行？）' };

  const r1 = await request('GET', '/?token=' + token);
  const sc = r1.h['set-cookie'];
  const cookie = Array.isArray(sc) ? sc.map((c) => c.split(';')[0]).join('; ') : '';

  const r = await request('POST', '/api/session/list', {
    type: 'client-request', rpcId: 'x', method: 'session/list', payload: { args: { _request: {} } },
  }, cookie);

  let j;
  try { j = JSON.parse(r.b); } catch { return { ok: false, error: '返回不是 JSON' }; }

  const items = j?.result?.value?.items || [];
  const realIds = new Set(items.map((x) => x.sessionId).filter(Boolean));

  // 逐场景核对
  const scenes = loadSceneFiles();
  const report = [];
  for (const s of scenes) {
    const panels = (s.json.panels || []).filter((p) => p.type === 'harness');
    for (const p of panels) {
      const sid = String(p.sessionId || '');
      report.push({
        scene: s.json.name || s.json.id,
        panel: p.id,
        sessionId: sid,
        exists: realIds.has(sid),
      });
    }
  }

  return {
    ok: report.every((x) => x.exists),
    engineSessions: realIds.size,
    report,
    missing: report.filter((x) => !x.exists),
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  会话绑定 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 三字段定义
  chk('三个字段', BINDING_FIELDS.length === 3, BINDING_FIELDS.map((f) => f.name).join(' / '));
  chk('三个都必需', BINDING_FIELDS.every((f) => f.required), '');

  const SID = 'session-11111111-2222-3333-4444-555555555555';

  // ② 完整配置通过
  const good = {
    id: 'test', name: '测试',
    panels: [{ id: 'p1', type: 'harness', pinTarget: ['测试'], sessionTitle: '测试', sessionId: SID }],
  };
  const r1 = checkScene(good, { sessionId: SID });
  chk('完整配置通过', r1.ok === true, r1.level);

  // ③ 反例：缺 sessionId
  const noSid = {
    id: 'test', name: '测试',
    panels: [{ id: 'p1', type: 'harness', pinTarget: ['测试'], sessionTitle: '测试' }],
  };
  const r2 = checkScene(noSid, { sessionId: SID });
  chk('反例：缺 sessionId 被检出', r2.ok === false, r2.level);
  chk('分级为「无法核对画面」', r2.level === '基本可靠但无法核对画面', r2.level);

  // ④ 反例：sessionId 是占位符
  const placeholder = {
    id: 'test', name: '测试',
    panels: [{ id: 'p1', type: 'harness', pinTarget: ['测试'], sessionTitle: '测试', sessionId: 'session-00000000-0000-0000-0000-000000000000' }],
  };
  const r3 = checkScene(placeholder, { sessionId: SID });
  chk('反例：占位符 sessionId 被检出', r3.ok === false,
      r3.panels[0].problems.find((p) => p.includes('占位符')) || '');

  // ⑤ 反例：空字符串
  const empty = {
    id: 'test', name: '测试',
    panels: [{ id: 'p1', type: 'harness', pinTarget: ['测试'], sessionTitle: '测试', sessionId: '' }],
  };
  const r4 = checkScene(empty, { sessionId: SID });
  chk('反例：空 sessionId 被检出', r4.ok === false, '');

  // ⑥ 反例：与身份索引不一致
  const mismatch = {
    id: 'test', name: '测试',
    panels: [{ id: 'p1', type: 'harness', pinTarget: ['测试'], sessionTitle: '测试',
      sessionId: 'session-99999999-2222-3333-4444-555555555555' }],
  };
  const r5 = checkScene(mismatch, { sessionId: SID });
  chk('反例：与索引不一致被检出', r5.ok === false,
      r5.panels[0].problems.find((p) => p.includes('不一致')) || '');

  // ⑦ 反例：缺 pinTarget
  const noPin = {
    id: 'test', name: '测试',
    panels: [{ id: 'p1', type: 'harness', sessionTitle: '测试', sessionId: SID }],
  };
  const r6 = checkScene(noPin, { sessionId: SID });
  chk('反例：缺 pinTarget 被检出', r6.ok === false,
      r6.panels[0].problems.find((p) => p.includes('pinTarget')) || '');

  // ⑧ 补齐
  const fix = fixScene({ file: 'x.json', json: noSid }, { test: { sessionId: SID } });
  chk('能补齐 sessionId', fix.ok && fix.json.panels[0].sessionId === SID,
      fix.changes.join('; ') || '');

  // ⑨ 反例：索引里没有就拒绝
  const fixBad = fixScene({ file: 'x.json', json: noSid }, {});
  chk('反例：索引没 id 时拒绝补', fixBad.ok === false, fixBad.error);

  // ⑩ 真实场景检查
  const all = checkAll();
  chk('能检查真实场景', all.total > 0, all.total + ' 个');
  chk('能分级', Object.keys(all.byLevel).length > 0, JSON.stringify(all.byLevel));

  // ⑪ 关键：缺 sessionId 是「悄悄退化」，要能查出来
  const silent = checkScene(noSid, { sessionId: SID });
  chk('关键：能查出「悄悄退化」的状态',
      silent.ok === false && silent.level === '基本可靠但无法核对画面',
      '他说的：「三个字段少写一个不会报错，只会悄悄退化」');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 验证引擎 ──
  if (has('--verify-engine')) {
    const r = await verifyInEngine();
    if (!r.ok && r.error) { console.error('✗ ' + r.error); process.exit(2); }
    console.log('═'.repeat(76));
    console.log('  验证 sessionId 在引擎里真实存在');
    console.log('═'.repeat(76));
    console.log();
    console.log('  引擎会话数: ' + r.engineSessions);
    console.log();
    for (const x of r.report) {
      console.log('  ' + (x.exists ? '✓' : '✗') + ' ' +
        x.scene.padEnd(12) + x.panel.padEnd(10) + String(x.sessionId).slice(0, 40));
    }
    console.log();
    console.log('─'.repeat(76));
    if (r.missing.length === 0) {
      console.log('  ✓ 全部 ' + r.report.length + ' 个面板的 sessionId 都真实存在');
    } else {
      console.log('  ✗ ' + r.missing.length + ' 个 sessionId 在引擎里找不到');
      console.log('     可能：会话已被归档 / id 写错 / 引擎数据目录不同');
    }
    console.log('─'.repeat(76));
    console.log();
    console.log('  他的判据：「判断到位了没有只能看画面——存储值是你自己写的，画面才是结果」');
    process.exit(r.ok ? 0 : 1);
  }

  // ── 检查 ──
  if (has('--check') || (!has('--fix') && !has('--check'))) {
    const all = checkAll();
    console.log('═'.repeat(78));
    console.log('  会话绑定三字段检查（' + all.total + ' 个场景）');
    console.log('═'.repeat(78));
    console.log();
    console.log('  ' + '场景'.padEnd(12) + '面板'.padEnd(12) + 'pin  title  id     判定');
    console.log('  ' + '─'.repeat(72));

    for (const r of all.results) {
      if (r.panelCount === 0) continue;
      for (const p of r.panels) {
        const m = (b) => (b ? '✓' : '✗');
        console.log('  ' + r.sceneName.padEnd(12) + p.panelId.padEnd(12) +
          ' ' + m(p.has.pinTarget).padEnd(4) +
          ' ' + m(p.has.sessionTitle).padEnd(6) +
          ' ' + m(p.has.sessionId).padEnd(6) +
          ' ' + (p.ok ? '✓ 完整' : '✗ ' + p.problems[0].slice(0, 24)));
      }
    }

    console.log();
    console.log('─'.repeat(78));
    for (const [level, n] of Object.entries(all.byLevel)) {
      console.log('  ' + level + '：' + n);
    }
    console.log('─'.repeat(78));
    console.log();
    if (all.incomplete > 0) {
      console.log('  ⚠ 缺 sessionId = 无法核对画面（他的原话：「只会悄悄退化」）');
      console.log('  补齐: node 工具/会话绑定.mjs --fix --apply');
      console.log();
    }
    console.log('  依据：参考项目 02/二-会话绑定三字段.md（他标注为「★ 全仓库最核心的一页」）');
    process.exit(all.ok ? 0 : 1);
  }

  // ── 补齐 ──
  if (has('--fix')) {
    const identity = loadIdentity();
    const scenes = loadSceneFiles();

    console.log('═'.repeat(78));
    console.log('  补齐会话绑定' + (has('--apply') ? '' : '（预览）'));
    console.log('═'.repeat(78));
    console.log();

    let fixed = 0;
    for (const s of scenes) {
      const r = fixScene(s, identity);
      if (!r.ok) {
        console.log('  ○ ' + (s.json.name || s.json.id).padEnd(12) + r.error);
        continue;
      }
      if (r.changes.length === 0) {
        console.log('  ✓ ' + (s.json.name || s.json.id).padEnd(12) + '已完整');
        continue;
      }
      console.log('  ' + (has('--apply') ? '✓' : '→') + ' ' +
        (s.json.name || s.json.id).padEnd(12) + r.changes.join(' · '));
      fixed++;

      if (has('--apply')) {
        fs.writeFileSync(r.file, JSON.stringify(r.json, null, 2) + '\n', 'utf8');
      }
    }

    console.log();
    console.log('─'.repeat(78));
    if (has('--apply')) {
      console.log('  ✓ 已修 ' + fixed + ' 个场景');
      console.log();
      console.log('  ⚠ 注意：改 json 不会当场改变已经开着的面板');
      console.log('     需要切走再切回（面板重建）才生效');
      console.log();
      console.log('  验证: node 工具/会话绑定.mjs --verify-engine');
    } else {
      console.log('  （预览。加 --apply 真改）');
    }
    console.log('─'.repeat(78));
    process.exit(0);
  }
}
