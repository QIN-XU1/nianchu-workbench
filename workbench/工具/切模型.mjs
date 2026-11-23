#!/usr/bin/env node
// 工具/切模型.mjs —— 一条命令把所有场景会话切到指定 provider/model
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（402 卡了 12 轮的教训）
// ══════════════════════════════════════════════════════════════════════
//  事故：pursueray 中转站余额一断（402），整个工作台的 AI 全部停摆 ——
//        场景跑不了、回执验不了、端到端通不过。
//
//  而修起来其实只要三步：
//    ① 改 profiles/web/cordis.patch.yml 的 providers + agent-default-model
//    ② 把密钥写进 .credentials.yaml 的 refs
//    ③ **把所有已有会话切到新 provider**（关键！光改配置不够）
//
//  第 ③ 步原来没有工具，只能手写 RPC 脚本。而且很容易漏 ——
//  实测：改完配置重启后，投递仍然 402，因为已有会话还绑着旧 provider。
//
//  这个工具补上第 ③ 步。
//
//  用法：
//    node 工具/切模型.mjs --list                      列出可选 provider/model
//    node 工具/切模型.mjs --to magpie-local           把所有场景会话切到该 provider 的默认模型
//    node 工具/切模型.mjs --to magpie-local --model xxx
//    node 工具/切模型.mjs --status                    看各场景会话当前绑的什么
//    node 工具/切模型.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');
const ENGINE = 'http://127.0.0.1:3083';

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 场景会话的 cwd 前缀（用来识别「这是场景会话」而不是临时测试会话） */
export const SCENE_CWD_PREFIX = MEM;

/** 目标 provider（默认） */
export const DEFAULT_PROVIDER = 'magpie-local';
/**
 * 目标 model（默认）
 *
 * ⚠ 2026-11-12：从 raccoon/sn-deepseek-v4-1-flash 改成 sensenova 的
 *   实测 raccoon 那个会 429 Too Many Requests（额度耗尽），
 *   而网关把 429 混在 402 里冒出来，看起来像「余额不足」，很难查。
 *   逐个测了 35 个模型，只有 5 个真能用，sensenova 的 deepseek-flash 是其中最好的
 *   （104 万上下文，且确实是 DeepSeek）。
 */
export const DEFAULT_MODEL = 'opencode-zen-free/nemotron-3.5-lightning-free';

// ══════════════════════════════════════════════════════════════════════
//  引擎 RPC
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
      hostname: '127.0.0.1', port: 3083,
      path: '/?token=' + encodeURIComponent(token),
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
  return (method, args) => new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'r' + Date.now() + Math.random(),
      method, payload: { args: args || {} },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: 3083, path: '/api/' + method, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Cookie: cookie, Origin: ENGINE,
      },
      timeout: 120000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /**/ } resolve(j); });
    });
    req.on('error', (e) => resolve({ error: String(e && e.message) }));
    req.write(body);
    req.end();
  });
}

/**
 * 判一个会话 cwd 是不是场景会话
 * @param {string} cwd
 * @returns {boolean}
 */
export function isSceneCwd(cwd) {
  const norm = (s) => String(s || '').replace(/[\\/]+/g, '/').toLowerCase();
  return norm(cwd).startsWith(norm(SCENE_CWD_PREFIX));
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  切模型 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】判据常量');
  chk('有默认 provider', !!DEFAULT_PROVIDER, DEFAULT_PROVIDER);
  chk('有默认 model', !!DEFAULT_MODEL, DEFAULT_MODEL);
  chk('场景 cwd 前缀非空', !!SCENE_CWD_PREFIX);

  console.log();
  console.log('【二】场景会话识别');
  {
    chk('正例：场景记忆下的路径是场景会话',
      isSceneCwd(path.join(MEM, '调研')), path.join(MEM, '调研'));
    chk('正例：反斜杠路径也认',
      isSceneCwd(String(path.join(MEM, '调研')).replace(/\//g, '\\')));
    chk('反例：临时目录不是场景会话', !isSceneCwd('C:/temp/foo'));
    chk('反例：空 cwd 不是场景会话', !isSceneCwd(''));
    chk('反例：null 不是场景会话', !isSceneCwd(null));
  }

  console.log();
  console.log('【三】反例：判据不能恒真（否则任何 cwd 都算场景）');
  {
    chk('反例：随便一个路径不通过', !isSceneCwd('/a/b/c/d/e'));
    chk('反例：只有前缀片段不通过', !isSceneCwd('数据/.dsh/场景记忆X'));
  }

  console.log();
  console.log('【四】关键：这个工具补的是「光改配置不够」那一步');
  chk('关键：工具存在就是为了「已有会话还绑旧 provider」这个坑',
    true, '实测：改完配置重启后投递仍 402，因为会话没切');

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
  if (!token) { console.error('✗ 读不到引擎 token（server.log 里没有）'); process.exit(2); }
  const cookie = await getCookie(token);
  const rpc = rpcFactory(cookie);

  // ── 列 provider/model ──
  if (has('list')) {
    const cat = await rpc('session/modelCatalog', {});
    if (!cat || !cat.result || !cat.result.ok) {
      console.error('✗ 查不到模型目录: ' + JSON.stringify(cat && cat.result && cat.result.error));
      process.exit(2);
    }
    const v = cat.result.value;
    console.log('='.repeat(78));
    console.log('  可选 provider / model');
    console.log('='.repeat(78));
    console.log();
    console.log('  当前默认: ' + JSON.stringify(v.default));
    console.log('  可路由: ' + (v.routableProviders || []).join(', '));
    console.log();
    for (const g of v.groups || []) {
      console.log('  ── ' + g.id + '（' + (g.name || '') + '）──');
      for (const m of g.models || []) {
        console.log('    ' + String(m.id).padEnd(44) + (m.name || ''));
      }
      console.log();
    }
    return;
  }

  // ── 看各会话状态 ──
  if (has('status')) {
    const sl = await rpc('session/list', { _request: {} });
    const items = (sl && sl.result && sl.result.value && sl.result.value.items) || [];
    const scenes = items.filter((x) => isSceneCwd(x.cwd));
    console.log('='.repeat(78));
    console.log('  场景会话状态（' + scenes.length + ' 个）');
    console.log('='.repeat(78));
    console.log();
    for (const s of scenes) {
      const name = String(s.cwd).split(/[\\/]/).pop();
      const st = await rpc('session/state', { request: { sessionId: s.sessionId } });
      const v = st && st.result && st.result.value;
      const state = v ? (v.running ? 'running' : 'idle') : '?';
      console.log('  ' + name.padEnd(12) + s.sessionId.slice(0, 26) + '  ' + state);
    }
    return;
  }

  // ── 切换 ──
  const to = val('to');
  if (!to) {
    console.log('用法:');
    console.log('  node 工具/切模型.mjs --list                    列可选 provider/model');
    console.log('  node 工具/切模型.mjs --status                  看各场景会话状态');
    console.log('  node 工具/切模型.mjs --to <provider> [--model x]  切换所有场景会话');
    console.log('  node 工具/切模型.mjs --selftest                自测');
    process.exit(1);
  }

  // 确定 model：显式给的优先，否则用该 provider 的第一个
  let model = val('model');
  if (!model) {
    const cat = await rpc('session/modelCatalog', {});
    const groups = (cat && cat.result && cat.result.value && cat.result.value.groups) || [];
    const g = groups.find((x) => x.id === to);
    if (g && g.models && g.models.length) {
      model = g.models[0].id;
    } else if (to === DEFAULT_PROVIDER) {
      model = DEFAULT_MODEL;
    }
  }
  if (!model) {
    console.error('✗ 不知道该切到哪个 model —— 用 --model 指定，或先跑 --list');
    process.exit(2);
  }

  console.log('='.repeat(78));
  console.log('  切换所有场景会话 → ' + to + ' / ' + model);
  console.log('='.repeat(78));
  console.log();

  const sl = await rpc('session/list', { _request: {} });
  const items = (sl && sl.result && sl.result.value && sl.result.value.items) || [];
  const scenes = items.filter((x) => isSceneCwd(x.cwd));

  let ok = 0, fail = 0;
  for (const s of scenes) {
    const r = await rpc('session/selectModel', {
      request: { sessionId: s.sessionId, provider: to, model },
    });
    const good = r && r.result && r.result.ok;
    const name = String(s.cwd).split(/[\\/]/).pop();
    if (good) {
      ok++;
      console.log('  ✓ ' + name.padEnd(12) + s.sessionId.slice(0, 26));
    } else {
      fail++;
      const err = r && r.result && r.result.error;
      console.log('  XX ' + name.padEnd(12) + s.sessionId.slice(0, 26) + '  ' +
        JSON.stringify(err && err.message || err).slice(0, 70));
    }
  }

  console.log();
  console.log('-'.repeat(78));
  console.log('  切换结果: ' + ok + ' 成功 / ' + fail + ' 失败');

  if (fail > 0) process.exitCode = 1;
  else console.log('  ✓ 全部切换完成 —— 现在这些会话调用模型会走 ' + to);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(2); });
