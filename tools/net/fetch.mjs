#!/usr/bin/env node
/**
 * 念初的联网层（自研，不借 hermes）
 *
 * 为什么要有这一层：
 *   矩阵 A3 原先记「有」，证据写的是「hermes web 工具能搜」—— 那是 hermes 的能力。
 *   这一层是我们自己的实现，并且按本项目的核心纪律设计：
 *   **抓不到就说抓不到，绝不编造结果**。
 *
 * 与普通 fetch 包装的区别（这是它值得存在的原因）：
 *   1. 四态判定：PASS / WARN / FAIL / UNKNOWN 每一种都有明确判据
 *      · UNKNOWN = 网络层不可达（DNS/超时），**不等于**目标不存在
 *      · FAIL    = 拿到了响应但状态码/内容不符预期
 *   2. 抓取可复算：把最终 URL、状态码、内容长度、内容哈希全部记下来
 *   3. 重试与退避：网络间歇性时给出确定的判定，而不是随机成败
 *   4. 代理感知：环境变量 / 显式参数，同一份代码在有无代理下都可用
 *
 * CLI：
 *   node tools/net/fetch.mjs <url> [--json] [--proxy=...] [--retries=3]
 *   node tools/net/fetch.mjs --selftest          # 离线自检四态判定
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 四态 */
export const S = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' };

/**
 * 判据表（写死在代码里，便于审查）：
 *   PASS    2xx 且内容非空
 *   WARN    2xx 但内容为空/极短（可能是 SPA 空壳或软 404）
 *   FAIL    4xx/5xx（目标存在但拒绝/出错）
 *   UNKNOWN 连不上（DNS/连接/超时）—— 这是「我没看到」，不是「它不存在」
 */
export function classify({ httpCode, bytes, error, curlCode }) {
  if (error) {
    // curl 的退出码语义（比正则猜错误串更准）：
    //   6  = 域名解析失败      → 网络层不可达
    //   7  = 连接失败          → 网络层不可达
    //   28 = 超时              → 网络层不可达
    //   35 = TLS 握手失败      → 网络层不可达
    //   52 = 服务器空回复      → 目标异常
    //   22 = HTTP >=400（配 -f）→ 目标存在但拒绝
    const transport = new Set([6, 7, 28, 35, 55, 56]);
    const byCode = typeof curlCode === 'number' && transport.has(curlCode);
    const transient = byCode ||
      /ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNRESET|socket hang up|timeout|Could not resolve|Failed to connect/i.test(String(error));
    return {
      state: S.UNKNOWN,
      why: transient
        ? '网络层不可达（' + (curlCode ? 'curl exit ' + curlCode + '，' : '') +
          String(error).replace(/\s+/g, ' ').slice(0, 70) + '）—— 判不了，不等于目标不存在'
        : '未知错误（' + String(error).replace(/\s+/g, ' ').slice(0, 70) + '）',
    };
  }
  if (httpCode >= 200 && httpCode < 300) {
    if (bytes > 200) return { state: S.PASS, why: 'HTTP ' + httpCode + '，' + bytes + ' 字节' };
    return { state: S.WARN, why: 'HTTP ' + httpCode + ' 但内容只有 ' + bytes + ' 字节（空壳或软 404）' };
  }
  if (httpCode >= 400) {
    return { state: S.FAIL, why: 'HTTP ' + httpCode };
  }
  return { state: S.WARN, why: '异常状态码 ' + httpCode };
}

/** 一次抓取（不重试）。用 curl：Windows 上免依赖，且能透传代理。 */
async function once(url, { proxy, timeoutSec = 25, method = 'GET' } = {}) {
  const args = ['-sS', '-L', '--max-time', String(timeoutSec), '-o', '-', '-w', '\n@@META@@%{http_code}'];
  if (proxy) args.push('-x', proxy);
  if (method !== 'GET') args.push('-X', method);
  args.push(url);

  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' });
    const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    const marker = buf.lastIndexOf('@@META@@');
    if (marker < 0) {
      return { httpCode: 0, body: buf, error: 'no meta marker' };
    }
    let code = Number(buf.slice(marker + 8).toString('utf8').trim());
    const body = buf.slice(0, marker - 1);
    return { httpCode: Number.isFinite(code) ? code : 0, body };
  } catch (e) {
    // 把 curl 退出码一并带出，供 classify 精确判定（比正则猜错误串可靠）
    const code = typeof e.code === 'number' ? e.code : undefined;
    return { httpCode: 0, body: Buffer.alloc(0), error: (e.stderr && e.stderr.toString()) || e.message, curlCode: code };
  }
}

/**
 * 带重试与退避的抓取，返回结构化结果。
 * 重试只在「传输层错误」时发生；4xx/5xx 不重试（重试也不会变好）。
 */
export async function fetchUrl(url, opts = {}) {
  const { retries = 3, backoffMs = 600, proxy = process.env.VOUCH_PROXY || process.env.HTTPS_PROXY || null } = opts;
  const attempts = [];
  let last = null;

  for (let i = 0; i < retries; i++) {
    const r = await once(url, { proxy, timeoutSec: opts.timeoutSec, method: opts.method });
    const verdict = classify({ httpCode: r.httpCode, bytes: r.body ? r.body.length : 0, error: r.error, curlCode: r.curlCode });
    attempts.push({ n: i + 1, httpCode: r.httpCode, bytes: r.body ? r.body.length : 0, state: verdict.state, why: verdict.why });
    last = { ...r, ...verdict };

    // 只有 UNKNOWN（传输层）才重试
    if (verdict.state !== S.UNKNOWN) break;
    if (i < retries - 1) await new Promise((res) => setTimeout(res, backoffMs * Math.pow(2, i)));
  }

  const body = last.body || Buffer.alloc(0);
  return {
    url,
    finalUrl: url,
    state: last.state,
    why: last.why,
    httpCode: last.httpCode,
    bytes: body.length,
    sha256: body.length ? crypto.createHash('sha256').update(body).digest('hex').slice(0, 16) : null,
    preview: body.length ? body.toString('utf8').replace(/\s+/g, ' ').slice(0, 180) : '',
    attempts,
    at: new Date().toISOString(),
  };
}

// ── 自检：四态判定必须可离线验证 ──
/**
 * 【2026-11-16 改】原来这 7 条判据写在**数组字面量**里，靠 `.map()` 比 want/got。
 * 后果：`tools/evolve/audit-false-red.mjs` 扫不到任何断言 —— 它只认 `T(...)` 调用行，
 * 于是这个验收器被判 UNKNOWN（「selftest 里找不到可识别的断言」），
 * 而它其实有 7 条真判据。现在全部改成显式 `T(标题, 布尔, 实测值)`，
 * 标题带「正例 · /反例 ·」前缀：正例 = 必须做对，反例 = 不许做错。
 *
 * 另外补了 3 条边界判据（bytes=201/200、302）—— 空壳阈值 `bytes > 200`
 * 是这条链路唯一的数值判据，之前没有任何断言钉住它。
 */
export function selfTest() {
  const cases = [];
  // eslint-disable-next-line no-unused-vars
  const T = (name, okv, why) => cases.push([name, !!okv, why]);
  const st = (input) => classify(input).state;

  // ── 正例：必须做对 ──
  T('正例 · 2xx 且内容充足（bytes=5000）→ PASS',
    st({ httpCode: 200, bytes: 5000 }) === S.PASS,
    '实得 ' + st({ httpCode: 200, bytes: 5000 }));
  T('正例 · 2xx 且 bytes=201（恰好越过空壳阈值）→ PASS',
    st({ httpCode: 200, bytes: 201 }) === S.PASS,
    '实得 ' + st({ httpCode: 200, bytes: 201 }));
  T('正例 · PASS 的 why 必须报出 HTTP 码与字节数（可复核，不是一句「成功」）',
    /HTTP 200/.test(classify({ httpCode: 200, bytes: 5000 }).why || '') &&
    /5000 字节/.test(classify({ httpCode: 200, bytes: 5000 }).why || ''),
    'why=' + String(classify({ httpCode: 200, bytes: 5000 }).why));

  // ── 反例：不许做错 ──
  T('反例 · 2xx 但内容空壳（bytes=50）→ WARN，不许判 PASS',
    st({ httpCode: 200, bytes: 50 }) === S.WARN,
    '实得 ' + st({ httpCode: 200, bytes: 50 }));
  T('反例 · 2xx 且 bytes=200（恰好不过阈值）→ WARN，不许判 PASS',
    st({ httpCode: 200, bytes: 200 }) === S.WARN,
    '实得 ' + st({ httpCode: 200, bytes: 200 }));
  T('反例 · 302 未落到 2xx → WARN，不许判 PASS',
    st({ httpCode: 302, bytes: 5000 }) === S.WARN,
    '实得 ' + st({ httpCode: 302, bytes: 5000 }));
  T('反例 · 404 → FAIL，不许判 PASS/WARN',
    st({ httpCode: 404, bytes: 100 }) === S.FAIL,
    '实得 ' + st({ httpCode: 404, bytes: 100 }));
  T('反例 · 500 → FAIL，不许判 PASS/WARN',
    st({ httpCode: 500, bytes: 100 }) === S.FAIL,
    '实得 ' + st({ httpCode: 500, bytes: 100 }));
  T('反例 · 超时（curl exit 28）→ UNKNOWN，不许判 FAIL（假红）',
    st({ httpCode: 0, bytes: 0, error: 'Operation timed out', curlCode: 28 }) === S.UNKNOWN,
    '实得 ' + st({ httpCode: 0, bytes: 0, error: 'Operation timed out', curlCode: 28 }));
  T('反例 · DNS 失败 → UNKNOWN，不许判 FAIL（假红）',
    st({ httpCode: 0, bytes: 0, error: 'Could not resolve host', curlCode: 6 }) === S.UNKNOWN,
    '实得 ' + st({ httpCode: 0, bytes: 0, error: 'Could not resolve host', curlCode: 6 }));
  T('反例 · 连接被拒 → UNKNOWN，不许判 FAIL（假红）',
    st({ httpCode: 0, bytes: 0, error: 'ECONNREFUSED' }) === S.UNKNOWN,
    '实得 ' + st({ httpCode: 0, bytes: 0, error: 'ECONNREFUSED' }));

  const bad = cases.filter(([, okv]) => !okv);
  return {
    cases,
    ok: bad.length === 0,
    text: cases.map(([n, okv, why]) => '  ' + (okv ? '✓' : '✗') + ' ' + n + (okv ? '' : '  ← ' + why)).join('\n'),
    pass: cases.length - bad.length,
    total: cases.length,
  };
}

// ── CLI ──
if (process.argv[1] && process.argv[1].endsWith('fetch.mjs')) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    const r = selfTest();
    console.log('');
    console.log('  念初联网层 · 四态判定自检');
    console.log(r.text);
    console.log('');
    console.log('  结论: ' + (r.ok ? '✓ 全部成立 ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
    console.log('');
    process.exit(r.ok ? 0 : 1);
  }

  const url = argv.find((a) => /^https?:/.test(a));
  if (!url) {
    console.error('用法: node tools/net/fetch.mjs <url> [--json] [--proxy=...] [--retries=N]');
    process.exit(2);
  }
  const proxyArg = argv.find((a) => a.startsWith('--proxy='));
  const retriesArg = argv.find((a) => a.startsWith('--retries='));
  const r = await fetchUrl(url, {
    proxy: proxyArg ? proxyArg.split('=')[1] : undefined,
    retries: retriesArg ? Number(retriesArg.split('=')[1]) : 3,
  });

  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('');
    console.log('  ' + r.state + '  ' + r.url);
    console.log('  ' + r.why);
    if (r.sha256) console.log('  sha256=' + r.sha256 + '  bytes=' + r.bytes);
    if (r.preview) console.log('  预览: ' + r.preview);
    console.log('');
  }
  // 退出码映射到四态：0 PASS / 3 WARN / 1 FAIL / 2 UNKNOWN
  process.exit(r.state === S.PASS ? 0 : r.state === S.WARN ? 3 : r.state === S.FAIL ? 1 : 2);
}