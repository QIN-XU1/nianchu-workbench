#!/usr/bin/env node
/**
 * 前置探活（第 105 轮）—— 跑验证套件前先确认「被测环境真的在」。
 *
 * 【为什么】第 104 轮 verify-goal 报 R8 FAIL（界面层 7/8），追查发现是**我在后台重启 47124
 * 的同时跑了 verify-goal**，界面层正好落在服务不可用窗口。这类「假失败」会浪费一轮排查，
 * 更糟的是——它可能让人误以为产品坏了，或者反过来让人习惯性「重跑一次就算了」。
 *
 * 所以把前置条件显式化：**先探活，再验证**。探活失败就别往下跑，也别把失败归因给产品。
 *
 * 检查项：
 *   ① HTTP /api/host-status 返回 200 且 ok:true
 *   ② 该方法表非空（implemented 是数组且长度 > 0）
 *   ③ WebSocket 端口可连（同一端口，/ws 握手能收到响应）
 *
 * 用法：
 *   node tools/quality/preflight.mjs                 # 默认 http://127.0.0.1:47124
 *   node tools/quality/preflight.mjs --base=<url>    # 指定别的地址（自测/反例用）
 * 四态：0 环境就绪 · 1 环境不可用（不要继续跑依赖它的验证）· 2 参数错误
 */
const argBase = (process.argv.find((a) => a.startsWith('--base=')) || '').slice('--base='.length);
const BASE = (argBase || process.env.NIANCHU_BASE || 'http://127.0.0.1:47124').replace(/\/+$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const TIMEOUT = 6000;

const problems = [];
const notes = [];

/** ① + ② HTTP 探活 */
async function probeHttp() {
  try {
    const r = await fetch(BASE + '/api/host-status', { signal: AbortSignal.timeout(TIMEOUT) });
    if (r.status !== 200) { problems.push('HTTP /api/host-status 返回 ' + r.status + '（应为 200）'); return null; }
    let j = null;
    try { j = await r.json(); } catch { problems.push('/api/host-status 返回的不是 JSON'); return null; }
    if (!j || j.ok !== true) { problems.push('/api/host-status 的 ok 不是 true'); return null; }
    const impl = j.implemented;
    if (!Array.isArray(impl) || impl.length === 0) { problems.push('implemented 方法表为空或不是数组'); return null; }
    notes.push('HTTP 就绪 · 方法 ' + impl.length + ' 个 · wsPath=' + (j.wsPath || '?'));
    return j;
  } catch (e) {
    problems.push('连不上 ' + BASE + '：' + String(e && e.message || e));
    return null;
  }
}

/** ③ WebSocket 握手探活 */
function probeWs() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, msg) => { if (done) return; done = true; try { ws.close(); } catch { /* 忽略 */ } resolve({ ok, msg }); };
    let ws;
    try {
      ws = new WebSocket(WS);
    } catch (e) {
      finish(false, 'WebSocket 构造失败：' + String(e && e.message || e));
      return;
    }
    const timer = setTimeout(() => finish(false, 'WebSocket 握手超时（' + TIMEOUT + 'ms）'), TIMEOUT);
    ws.onopen = () => { clearTimeout(timer); finish(true, 'WebSocket 可连'); };
    ws.onerror = () => { clearTimeout(timer); finish(false, 'WebSocket 连接错误（' + WS + '）'); };
  });
}

const hs = await probeHttp();
if (hs) {
  const w = await probeWs();
  if (!w.ok) problems.push(w.msg); else notes.push(w.msg);
}

console.log('');
console.log('  前置探活 · ' + BASE);
console.log('  ' + '─'.repeat(60));
for (const n of notes) console.log('  ✓ ' + n);
for (const p of problems) console.log('  ✗ ' + p);
if (problems.length) {
  console.log('  ' + '─'.repeat(60));
  console.log('  → 环境未就绪。请先启动服务再跑依赖它的验证：');
  console.log('      node tools/workbench/serve.mjs');
  console.log('    （探活失败 ≠ 产品有问题；不要把这类失败归因给被测对象）');
}
console.log('  ' + '─'.repeat(60));
console.log('  四态: ' + (problems.length === 0 ? 'PASS（环境就绪）' : 'FAIL（环境不可用）'));
process.exit(problems.length === 0 ? 0 : 1);
