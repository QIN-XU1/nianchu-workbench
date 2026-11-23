#!/usr/bin/env node
// 工具/模型健康.mjs —— 所有模型 provider 现在能不能用
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  实测事故（2026-11-13）：
//    重启工作台后截图，发现每个场景的 AI 面板都显示：
//      「本轮运行失败  Connection error.  TRANSPORT」
//
//    查下去：默认 provider 是 pursueray（余额耗尽），
//    备用 magpie-local 指向 127.0.0.1:3425（网关根本没启动）。
//
//    ⇒ **两个 provider 全挂了，整个工作台的 AI 能力归零。**
//      但在那之前，没有任何检查会发现这件事：
//        · 机制体检 100 项，跑的全是本地文件检查
//        · 界面功能体检 会失败，但它报的是「找不到输入框」这类症状，
//          不会说「模型全挂了」
//        · 真实模型体检 会失败，但一次要跑几分钟，不会每轮都跑
//
//  这个工具：**秒级**检查所有 provider 的连通性，并明确告诉你
//    「哪个能用、哪个不能用、为什么、该换哪个」。
//
//  用法：
//    node 工具/模型健康.mjs            检查全部
//    node 工具/模型健康.mjs --json     机器可读
//    node 工具/模型健康.mjs --quick    只检查默认 provider（最快）
//    node 工具/模型健康.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const CONFIG = path.join(DATA, 'profiles', 'web', 'cordis.patch.yml');
const CRED = path.join(DATA, '.credentials.yaml');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 单次探测超时 */
export const PROBE_TIMEOUT_MS = 10000;

/**
 * 判一个 provider 是否算「可用」
 *
 * @param {{reachable:boolean, status:number, error:string}} r
 * @returns {{ok:boolean, why:string}}
 */
export function judgeProvider(r) {
  const x = r || {};
  if (!x.reachable) {
    return { ok: false, why: '连不上: ' + (x.error || '未知原因') };
  }
  const s = Number(x.status) || 0;
  if (s === 0) return { ok: false, why: '无响应' };
  if (s >= 200 && s < 300) return { ok: true, why: '' };
  if (s === 401 || s === 403) return { ok: false, why: 'HTTP ' + s + '（密钥无效或权限不足）' };
  if (s === 402) return { ok: false, why: 'HTTP 402（余额不足）' };
  if (s === 429) return { ok: false, why: 'HTTP 429（限流，稍后可重试）' };
  if (s === 404) return { ok: false, why: 'HTTP 404（地址或模型名不对）' };
  if (s >= 500) return { ok: false, why: 'HTTP ' + s + '（服务端错误）' };
  return { ok: false, why: 'HTTP ' + s };
}

// ══════════════════════════════════════════════════════════════════════
/** 从 yml 里粗略解析 provider 定义（不引入 yaml 依赖） */
function parseProviders() {
  const out = [];
  let c = '';
  try { c = fs.readFileSync(CONFIG, 'utf8'); } catch { return out; }

  const lines = c.split(/\r?\n/);
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    // provider 块开始：形如 `  - name: xxx` 或 `  provider: xxx` 两种都可能有
    const mName = line.match(/^\s{2,6}name:\s*['"]?([\w@/.-]+)['"]?\s*$/);
    const mBase = line.match(/^\s+baseURL:\s*['"]?([^'"\s]+)['"]?\s*$/);
    const mKey = line.match(/^\s+apiKeyEnv:\s*['"]?([\w-]+)['"]?\s*$/);
    const mProv = line.match(/^\s+provider:\s*['"]?([\w-]+)['"]?\s*$/);
    const mModel = line.match(/^\s+model:\s*['"]?([\w@/.-]+)['"]?\s*$/);

    if (mBase) {
      // 遇到 baseURL 就开一个新块
      cur = { baseURL: mBase[1], apiKeyEnv: '', model: '', provider: '' };
      out.push(cur);
    }
    if (cur && mKey) cur.apiKeyEnv = mKey[1];
    if (cur && mModel && !cur.model) cur.model = mModel[1];
    if (cur && mProv && !cur.provider) cur.provider = mProv[1];
  }
  return out.filter((p) => p.baseURL);
}

/** 从 credentials.yaml 里取 key */
function readKey(envName) {
  try {
    const c = fs.readFileSync(CRED, 'utf8');
    const re = new RegExp('^\\s*' + envName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + ':\\s*[\'"]?([^\'"\\r\\n]+)', 'm');
    const m = c.match(re);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (ok) => { try { s.destroy(); } catch { /* */ } resolve(ok); };
    s.setTimeout(PROBE_TIMEOUT_MS);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, '127.0.0.1');
  });
}

/** 探测一个 provider 是否可用（发一个最小请求） */
export async function probeProvider(p) {
  const url = String(p.baseURL || '').replace(/\/+$/, '');
  const key = readKey(p.apiKeyEnv) || p.apiKey || '';
  const model = p.model || 'deepseek';

  // 本地地址先查端口
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(url);
  if (isLocal) {
    const m = url.match(/:(\d+)/);
    if (m) {
      const alive = await probePort(Number(m[1]));
      if (!alive) {
        return { reachable: false, status: 0, error: '本地端口 ' + m[1] + ' 未监听（服务没启动）' };
      }
    }
  }

  return new Promise((resolve) => {
    let lib;
    try { lib = /^https:/i.test(url) ? https : http; } catch {
      return resolve({ reachable: false, status: 0, error: '协议不支持' });
    }
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8,
    });
    let u;
    try { u = new URL(url + '/chat/completions'); } catch {
      return resolve({ reachable: false, status: 0, error: '地址无效' });
    }
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (/^https:/i.test(url) ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      timeout: PROBE_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: 'Bearer ' + key,
      },
    }, (res) => {
      res.resume();
      resolve({ reachable: true, status: res.statusCode || 0, error: '' });
    });
    req.on('timeout', () => { try { req.destroy(); } catch { /* */ } resolve({ reachable: false, status: 0, error: '超时' }); });
    req.on('error', (e) => resolve({ reachable: false, status: 0, error: String((e && e.code) || (e && e.message) || 'error') }));
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  模型健康 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】判据：可用');
  {
    chk('正例：200 → 可用', judgeProvider({ reachable: true, status: 200 }).ok === true);
    chk('正例：201 → 可用', judgeProvider({ reachable: true, status: 201 }).ok === true);
  }

  console.log();
  console.log('【二】反例：各种失败都要判不可用');
  {
    chk('反例：连不上 → 不可用', judgeProvider({ reachable: false, status: 0, error: 'ECONNREFUSED' }).ok === false,
      judgeProvider({ reachable: false, status: 0, error: 'ECONNREFUSED' }).why);
    chk('反例：401 → 不可用', judgeProvider({ reachable: true, status: 401 }).ok === false,
      judgeProvider({ reachable: true, status: 401 }).why);
    chk('反例：402（余额不足）→ 不可用', judgeProvider({ reachable: true, status: 402 }).ok === false,
      judgeProvider({ reachable: true, status: 402 }).why);
    chk('反例：429（限流）→ 不可用', judgeProvider({ reachable: true, status: 429 }).ok === false);
    chk('反例：500 → 不可用', judgeProvider({ reachable: true, status: 500 }).ok === false);
    chk('反例：null → 不可用', judgeProvider(null).ok === false);
  }

  console.log();
  console.log('【三】解析 provider 配置');
  {
    const ps = parseProviders();
    chk('至少解析出 1 个 provider', ps.length >= 1, ps.length + ' 个');
    chk('每个都有 baseURL', ps.every((p) => p.baseURL), ps.map((p) => p.baseURL).join(', '));
  }

  console.log();
  console.log('【四】读密钥');
  {
    chk('反例：不存在的 env 返回空串', readKey('__不存在的变量__') === '');
  }

  console.log();
  console.log('【五】关键：这个工具补的是什么');
  chk('关键：之前模型全挂时，没有任何检查会直接说出来',
    true, '界面只会显示 Connection error，不说为什么');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const ps = parseProviders();

  // 找出默认 provider 是哪个
  let defaultProvider = '';
  try {
    const c = fs.readFileSync(CONFIG, 'utf8');
    const m = c.match(/agent-default-model[\s\S]{0,300}?provider:\s*['"]?([\w-]+)/);
    if (m) defaultProvider = m[1];
  } catch { /* ignore */ }

  const list = has('quick')
    ? ps.filter((p) => p.provider === defaultProvider || p.baseURL.includes('3425') || ps[0] === p).slice(0, 1)
    : ps;

  const results = [];
  for (const p of list) {
    const probe = await probeProvider(p);
    const j = judgeProvider(probe);
    results.push({ ...p, probe, ok: j.ok, why: j.why, isDefault: p.provider === defaultProvider });
  }

  if (has('json')) {
    console.log(JSON.stringify({
      defaultProvider, total: results.length, ok: results.filter((r) => r.ok).length, results,
    }, null, 2));
    return;
  }

  console.log('='.repeat(84));
  console.log('  模型健康 —— 所有 provider 现在能不能用');
  console.log('='.repeat(84));
  console.log();
  console.log('  为什么需要：模型全挂时，界面只会显示「Connection error」，');
  console.log('  不会告诉你「是哪个 provider、为什么挂、该换哪个」。');
  console.log();

  if (defaultProvider) console.log('  默认 provider: ' + defaultProvider);
  console.log();

  console.log('  ' + 'provider'.padEnd(20) + '地址'.padEnd(34) + '状态');
  console.log('  ' + '─'.repeat(80));
  for (const r of results) {
    const mark = r.ok ? '✓ 可用' : '✗ 不可用';
    const defMark = r.isDefault ? ' ★默认' : '';
    console.log('  ' + (r.provider || '(未命名)').padEnd(20) + r.baseURL.slice(0, 32).padEnd(34) + mark + defMark);
    if (!r.ok) console.log('         ⛔ ' + r.why);
  }

  console.log();
  console.log('─'.repeat(84));
  const okCount = results.filter((r) => r.ok).length;
  console.log('  ' + okCount + ' / ' + results.length + ' 个 provider 可用');

  if (okCount === 0) {
    console.log();
    console.log('  ⛔ 没有任何 provider 可用 —— 整个工作台的 AI 功能会全部失效。');
    console.log();
    console.log('  怎么修：');
    console.log('    ① 本地网关（127.0.0.1:3425）：启动它');
    console.log('    ② 云端 provider：看是不是余额不足（HTTP 402）或密钥过期（401）');
    console.log('    ③ 换一个能用的：node 工具/切模型.mjs --list 看有哪些可选');
    process.exitCode = 1;
  } else if (okCount < results.length) {
    console.log();
    console.log('  ⚠ 有 provider 不可用，但只要还有能用的就不致命。');
    console.log('    建议：node 工具/切模型.mjs --to <能用的provider> 把场景切过去');
  }
  console.log('='.repeat(84));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(2); });
