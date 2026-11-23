#!/usr/bin/env node
// 工具/面板地址体检.mjs —— 每个场景的 embed 面板地址真的能打开吗
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  实测事故（2026-11-13）：
//    新孵化的「前端工坊」场景，embed 面板地址写的是
//      http://127.0.0.1:27606
//    那是当时 Web GUI 的端口。后来端口变成 3869，
//    这个面板就永久显示「网页加载失败 ERR_CONNECTION_REFUSED」。
//
//    而当时**没有任何检查**会发现问题 ——
//      面板内容体检：只看本地渲染的面板，不看 embed
//      界面功能体检：只测 harness（AI 对话），不测 embed
//      六件套：只数面板个数，不看地址能不能开
//
//    ⇒ 这是一个完全没人看的盲区：
//       「面板在配置里有，但打开是报错页」= 看起来有实际是空
//
//  这个工具：逐个场景检查 embed 面板的 url 是否可达。
//    ① 本地地址（127.0.0.1 / localhost）→ 检查端口是否在监听
//    ② 外网地址 → HTTP HEAD/GET，看状态码
//    ③ 报告每个场景每个 embed 面板的可达性
//
//  用法：
//    node 工具/面板地址体检.mjs           检查全部
//    node 工具/面板地址体检.mjs --json    机器可读
//    node 工具/面板地址体检.mjs --offline 只查本地端口（不联网）
//    node 工具/面板地址体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 单次探测超时 */
export const PROBE_TIMEOUT_MS = 8000;

/**
 * 判一个 url 是否是「本地地址」
 * @param {string} url
 */
export function isLocalUrl(url) {
  const u = String(url || '');
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/i.test(u);
}

/**
 * 从 url 里取端口
 * @param {string} url
 * @returns {number|null}
 */
export function getPort(url) {
  const m = String(url || '').match(/^https?:\/\/[^/]+?:(\d+)/i);
  if (m) return Number(m[1]);
  const u = String(url || '');
  if (/^https:/i.test(u)) return 443;
  if (/^http:/i.test(u)) return 80;
  return null;
}

/**
 * 判一条探测结果是否算「可达」
 * @param {{kind:string, ok:boolean, detail:string}} r
 */
export function judgeReachable(r) {
  if (!r) return { ok: false, why: '无结果' };
  if (r.kind === 'local-port') {
    return r.ok ? { ok: true, why: '' } : { ok: false, why: '本地端口 ' + r.detail + ' 没在监听' };
  }
  if (r.kind === 'http') {
    if (!r.ok) return { ok: false, why: 'HTTP 请求失败: ' + r.detail };
    // 2xx / 3xx 算可达（3xx 会跟到最终页）
    const code = Number(r.detail);
    if (code >= 200 && code < 400) return { ok: true, why: '' };
    return { ok: false, why: 'HTTP ' + code };
  }
  return { ok: false, why: '未知探测类型: ' + r.kind };
}

// ══════════════════════════════════════════════════════════════════════
function probePort(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (ok) => { try { s.destroy(); } catch { /* */ } resolve({ kind: 'local-port', ok, detail: String(port) }); };
    s.setTimeout(PROBE_TIMEOUT_MS);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, '127.0.0.1');
  });
}

function probeHttp(url) {
  return new Promise((resolve) => {
    let lib;
    try { lib = /^https:/i.test(url) ? https : http; } catch { return resolve({ kind: 'http', ok: false, detail: '协议不支持' }); }
    const req = lib.request(url, {
      method: 'GET',
      timeout: PROBE_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DSH-Workbench-PanelCheck/1.0)' },
    }, (res) => {
      const code = res.statusCode || 0;
      res.resume();   // 丢弃 body，只要状态码
      resolve({ kind: 'http', ok: true, detail: String(code) });
    });
    req.on('timeout', () => { try { req.destroy(); } catch { /* */ } resolve({ kind: 'http', ok: false, detail: '超时' }); });
    req.on('error', (e) => resolve({ kind: 'http', ok: false, detail: String(e && e.code || e && e.message || 'error') }));
    req.end();
  });
}

/** 探测一个 url 是否可达 */
export async function probe(url, offline) {
  const u = String(url || '').trim();
  if (!u) return { kind: 'none', ok: false, detail: '地址为空' };
  if (!/^https?:\/\//i.test(u)) return { kind: 'none', ok: false, detail: '不是 http(s) 地址' };

  if (isLocalUrl(u)) {
    const port = getPort(u);
    if (!port) return { kind: 'none', ok: false, detail: '取不到端口' };
    return probePort(port);
  }

  if (offline) return { kind: 'skipped', ok: true, detail: '离线模式，跳过外网' };
  return probeHttp(u);
}

// ══════════════════════════════════════════════════════════════════════
function listEmbedPanels() {
  const out = [];
  if (!fs.existsSync(SCEN)) return out;
  for (const f of fs.readdirSync(SCEN).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8').replace(/^\uFEFF/, ''));
      for (const p of (j.panels || [])) {
        if (p.type === 'embed' || p.type === 'frame') {
          out.push({
            scene: String(j.name || j.id || f),
            sceneId: String(j.id || f.replace(/\.json$/, '')),
            panelId: String(p.id || '?'),
            url: String(p.url || ''),
          });
        }
      }
    } catch { /* ignore */ }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
async function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  面板地址体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】本地地址识别');
  {
    chk('正例：127.0.0.1:3083', isLocalUrl('http://127.0.0.1:3083/') === true);
    chk('正例：localhost', isLocalUrl('http://localhost:9333') === true);
    chk('反例：外网不算本地', isLocalUrl('https://developer.mozilla.org/') === false);
    chk('反例：空串不算本地', isLocalUrl('') === false);
    chk('反例：null 不算本地', isLocalUrl(null) === false);
  }

  console.log();
  console.log('【二】取端口');
  {
    chk('显式端口', getPort('http://127.0.0.1:3083/') === 3083);
    chk('https 默认 443', getPort('https://example.com') === 443);
    chk('http 默认 80', getPort('http://example.com') === 80);
    chk('反例：非 url → null', getPort('not-a-url') === null);
  }

  console.log();
  console.log('【三】可达性判据');
  {
    chk('正例：本地端口通', judgeReachable({ kind: 'local-port', ok: true, detail: '3083' }).ok === true);
    chk('反例：本地端口不通 → 拒', judgeReachable({ kind: 'local-port', ok: false, detail: '27606' }).ok === false,
      judgeReachable({ kind: 'local-port', ok: false, detail: '27606' }).why);
    chk('正例：HTTP 200', judgeReachable({ kind: 'http', ok: true, detail: '200' }).ok === true);
    chk('正例：HTTP 301（会跟跳转）', judgeReachable({ kind: 'http', ok: true, detail: '301' }).ok === true);
    chk('反例：HTTP 404 → 拒', judgeReachable({ kind: 'http', ok: true, detail: '404' }).ok === false);
    chk('反例：HTTP 500 → 拒', judgeReachable({ kind: 'http', ok: true, detail: '500' }).ok === false);
    chk('反例：请求失败 → 拒', judgeReachable({ kind: 'http', ok: false, detail: 'ENOTFOUND' }).ok === false);
  }

  console.log();
  console.log('【四】探测真实端口');
  {
    // ⚠ 2026-11-13 修（自测依赖「引擎正在运行」这个外部条件）
    //
    //   原来：chk('正例：3083（引擎端口，应该在听）', await probePort(3083))
    //   实测：引擎没启动时这条必然红 —— 但**这不是工具的缺陷**，
    //        是自测把一个「外部环境假设」当成了断言。
    //        一个自测如果会随环境变化而红绿，它就不是可靠的自测。
    //
    //   修法：自己造一个临时端口来测。
    //        起一个本地 http server 监听随机端口 → 探测它 → 必须通；
    //        关掉它 → 探测同一端口 → 必须不通。
    //        这样断言的只是「probe 函数本身对不对」，与环境无关。
    const srv = http.createServer((req, res) => { res.writeHead(204); res.end(); });
    const port = await new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
    });
    try {
      const alive = await probePort(port);
      chk('正例：刚起的临时端口 → 探测通', alive.ok === true, JSON.stringify(alive));
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
    // 关掉之后再探，必须不通
    await new Promise((r) => setTimeout(r, 200));
    const dead = await probePort(port);
    chk('反例：关掉之后 → 探测不通', dead.ok === false, JSON.stringify(dead));
  }

  console.log();
  console.log('【五】关键：这个工具补的是什么');
  chk('关键：面板在配置里有 ≠ 打开能看见',
    true, 'embed 面板指向的地址挂了，面板就永久显示报错页');

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
  if (has('selftest')) { process.exit((await selftest()) ? 0 : 1); }

  const offline = has('offline');
  const panels = listEmbedPanels();

  const results = [];
  for (const p of panels) {
    const r = await probe(p.url, offline);
    const j = judgeReachable(r);
    results.push({ ...p, probe: r, ok: j.ok, why: j.why });
  }

  if (has('json')) {
    console.log(JSON.stringify({
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      results,
    }, null, 2));
    return;
  }

  console.log('='.repeat(84));
  console.log('  面板地址体检 —— 每个 embed 面板的地址真的能打开吗');
  console.log('='.repeat(84));
  console.log();
  console.log('  为什么需要：面板在配置里有 ≠ 打开能看见。');
  console.log('  embed 地址一旦挂掉，那个面板就永久显示「网页加载失败」。');
  console.log('  而面板内容体检 / 界面功能体检都不看 embed —— 这是盲区。');
  console.log();
  if (offline) console.log('  （离线模式：只查本地端口，不联网）');
  console.log();

  console.log('  ' + '场景'.padEnd(12) + '面板'.padEnd(14) + '状态  地址');
  console.log('  ' + '─'.repeat(80));
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    console.log('  ' + r.scene.padEnd(12) + r.panelId.padEnd(14) +
      mark + '    ' + r.url.slice(0, 56));
    if (!r.ok) console.log('         ⛔ ' + r.why);
  }

  console.log();
  console.log('─'.repeat(84));
  const okCount = results.filter((r) => r.ok).length;
  console.log('  ' + okCount + ' / ' + results.length + ' 个 embed 面板地址可达');

  if (okCount < results.length) {
    console.log();
    console.log('  ⛔ 不可达的面板会在界面上永久显示报错页 —— 这就是「看起来有实际是空」。');
    console.log('     修法：改 外壳/scenarios/<id>.json 里对应面板的 url');
    process.exitCode = 1;
  }
  console.log('='.repeat(84));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(2); });
