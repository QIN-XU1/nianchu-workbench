/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  场景会话绑定器（Scene Session Binder）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 场景孵化器造出了五件套，但缺第六件：**独立的 AI 会话**。
 *
 * 这一步做的事：
 *   ① 检查该场景是否已有 sessionId
 *   ② 没有 → 通过引擎 RPC 创建新会话
 *   ③ 把 sessionId 写回 外壳/scenarios/<id>.json 的 harness 面板
 *   ④ 更新 身份卡.md（会话绑定）
 *   ⑤ 更新 场景契约.json（sessionId）
 *
 * 用法：
 *   node 工具\scene-bind.mjs --scene <id>      # 为指定场景建会话
 *   node 工具\scene-bind.mjs --all             # 为所有缺会话的场景补
 *   node 工具\scene-bind.mjs --list            # 列出各场景会话状态
 *
 * 前置：引擎在跑（默认 127.0.0.1:3080），token 从环境变量或参数取
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCENARIOS = path.join(WB, '外壳', 'scenarios');
const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');
const MEMROOT = path.join(WB, '数据', '.dsh', '场景记忆');

const PORT = Number(process.env.DSH_PORT || 3080);
const TOKEN = process.env.DSH_ENGINE_TOKEN || '';

function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/\uFEFF/g, '')); }
  catch (e) { return fb; }
}
function writeJson(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');
}
function safeDirName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unnamed';
}

// ═══════════════════════════════════════════════════════════════
//  引擎 RPC（与 main.js 里 engineRpcCall 同样的鉴权链路）
// ═══════════════════════════════════════════════════════════════
let cookieCache = { cookie: '', at: 0 };

function fetchCookie() {
  if (cookieCache.cookie && Date.now() - cookieCache.at < 5 * 60 * 1000) {
    return Promise.resolve(cookieCache.cookie);
  }
  if (!TOKEN) return Promise.resolve('');

  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT,
      path: '/?token=' + encodeURIComponent(TOKEN),
      method: 'GET',
    }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      const cookie = sc.map(c => c.split(';')[0]).filter(Boolean).join('; ');
      res.on('data', () => {});
      res.on('end', () => {
        if (cookie) cookieCache = { cookie, at: Date.now() };
        resolve(cookie);
      });
    });
    req.on('error', () => resolve(''));
    req.setTimeout(8000, () => { try { req.destroy(); } catch (e) {} resolve(''); });
    req.end();
  });
}

function rpc(method, args) {
  return new Promise(async (resolve) => {
    const cookie = await fetchCookie();
    if (!cookie) return resolve({ ok: false, err: 'no cookie（检查 DSH_ENGINE_TOKEN）' });

    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'bind-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      method,
      payload: { args: args || {} },
    });

    const req = http.request({
      hostname: '127.0.0.1', port: PORT,
      path: '/api/' + method,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': cookie,
        'Origin': 'http://127.0.0.1:' + PORT,
        'Referer': 'http://127.0.0.1:' + PORT + '/',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (e) {}
        const r = j && j.result;
        resolve({
          ok: res.statusCode === 200 && (!r || r.ok !== false),
          status: res.statusCode,
          value: r ? (r.value !== undefined ? r.value : r) : null,
          err: r && r.error ? (r.error.message || r.error.code) : (res.statusCode !== 200 ? d.slice(0, 120) : null),
        });
      });
    });
    req.on('error', e => resolve({ ok: false, err: String(e.message || e) }));
    req.setTimeout(20000, () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, err: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
//  创建会话
// ═══════════════════════════════════════════════════════════════
async function createSession(sceneId, sceneName) {
  // 尝试 session/create（参数名逐个试，因为不同 RPC 不一致）
  const attempts = [
    { method: 'session/create', args: { _request: { cwd: process.cwd() } } },
    { method: 'session/create', args: { request: { cwd: process.cwd() } } },
    { method: 'session/create', args: {} },
    { method: 'session/new', args: { _request: {} } },
  ];

  for (const a of attempts) {
    const r = await rpc(a.method, a.args);
    if (r.ok && r.value) {
      const sid = r.value.sessionId || r.value.id || (typeof r.value === 'string' ? r.value : '');
      if (sid && String(sid).startsWith('session-')) {
        return { ok: true, sessionId: String(sid), via: a.method + ' ' + JSON.stringify(Object.keys(a.args)) };
      }
    }
  }
  return { ok: false, err: '所有 session/create 变体都失败' };
}

// ═══════════════════════════════════════════════════════════════
//  为场景绑定会话
// ═══════════════════════════════════════════════════════════════
async function bindScene(sceneId) {
  const fp = path.join(SCENARIOS, sceneId + '.json');
  const scene = readJson(fp, null);
  if (!scene) return { ok: false, err: '场景定义不存在: ' + sceneId };

  const panels = scene.panels || [];
  const harnesses = panels.filter(p => p.type === 'harness');
  if (!harnesses.length) return { ok: false, err: '该场景没有 harness 面板' };

  const h = harnesses[0];
  if (h.sessionId && String(h.sessionId).startsWith('session-')) {
    return { ok: true, already: true, sessionId: h.sessionId };
  }

  // 建会话
  const created = await createSession(sceneId, scene.name);
  if (!created.ok) return { ok: false, err: created.err };

  // 写回场景定义
  h.sessionId = created.sessionId;
  h.sessionTitle = scene.name;
  h.pinTarget = [scene.name];
  writeJson(fp, scene);

  // 写回契约
  const cfp = path.join(CONTRACTS, sceneId + '.json');
  const contract = readJson(cfp, null);
  if (contract) {
    contract.sessionId = created.sessionId;
    writeJson(cfp, contract);
  }

  // 更新身份卡
  const memDir = path.join(MEMROOT, safeDirName(scene.name));
  const idCard = path.join(memDir, '身份卡.md');
  if (fs.existsSync(idCard)) {
    let txt = fs.readFileSync(idCard, 'utf8');
    txt = txt.replace('- 会话绑定：待创建', '- 会话绑定：' + created.sessionId);
    fs.writeFileSync(idCard, txt, 'utf8');
  }

  return { ok: true, sessionId: created.sessionId, via: created.via };
}

// ═══════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════
const argv = process.argv.slice(2);
function arg(n) {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}
function has(n) { return argv.includes('--' + n); }

function listSessions() {
  const files = fs.readdirSync(SCENARIOS).filter(f => f.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    const s = readJson(path.join(SCENARIOS, f), null);
    if (!s) continue;
    const hs = (s.panels || []).filter(p => p.type === 'harness');
    rows.push({
      id: s.id,
      name: s.name,
      harnessCount: hs.length,
      sessionId: hs.length ? (hs[0].sessionId || '') : '(无 harness)',
    });
  }
  return rows;
}

(async () => {
  try {
    if (has('list')) {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('  场景会话绑定状态');
      console.log('═══════════════════════════════════════════════════════════');
      console.log();
      console.log('  ' + 'ID'.padEnd(20) + '名称'.padEnd(12) + '会话');
      console.log('  ' + '─'.repeat(78));
      for (const r of listSessions()) {
        const mark = r.sessionId.startsWith('session-') ? '✓' : '⚠';
        console.log('  ' + mark + ' ' + r.id.padEnd(18) + r.name.padEnd(12) + r.sessionId);
      }
      const missing = listSessions().filter(r => !r.sessionId.startsWith('session-'));
      console.log();
      console.log(missing.length
        ? '  ⚠ ' + missing.length + ' 个场景缺会话: ' + missing.map(m => m.id).join(', ')
        : '  ✓ 全部场景已绑定会话');
      return;
    }

    const one = arg('scene');
    if (one) {
      const r = await bindScene(one);
      if (r.ok) {
        console.log('✓ ' + one + (r.already ? ' 已有会话: ' : ' 已建会话: ') + r.sessionId);
        if (r.via) console.log('  （通过 ' + r.via + '）');
      } else {
        console.log('✗ ' + one + ': ' + r.err);
        process.exitCode = 1;
      }
      return;
    }

    if (has('all')) {
      const missing = listSessions().filter(r => !r.sessionId.startsWith('session-'));
      if (!missing.length) { console.log('✓ 无需补绑'); return; }
      let done = 0, fail = 0;
      for (const m of missing) {
        const r = await bindScene(m.id);
        if (r.ok) { done++; console.log('  ✓ ' + m.id + ' → ' + r.sessionId); }
        else { fail++; console.log('  ✗ ' + m.id + ': ' + r.err); }
      }
      console.log();
      console.log('补绑完成: ' + done + ' 成功 / ' + fail + ' 失败');
      if (fail) process.exitCode = 1;
      return;
    }

    console.log('用法:');
    console.log('  node 工具\\scene-bind.mjs --list            # 列出各场景会话状态');
    console.log('  node 工具\\scene-bind.mjs --scene <id>      # 为指定场景建会话');
    console.log('  node 工具\\scene-bind.mjs --all             # 为所有缺会话的场景补');
    console.log();
    console.log('环境变量: DSH_PORT（默认3080） DSH_ENGINE_TOKEN（必填）');
  } catch (e) {
    console.error('✗ ' + (e && e.message || e));
    process.exitCode = 1;
  }
})();
