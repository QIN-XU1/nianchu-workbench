/**
 * 自起服务助手（第 199 轮）—— 给「需服务」的 verify 脚本用。
 *
 * 背景：http-e2e / ws-e2e / api-error-contract 等脚本原先要求「外部先起 serve.mjs」，
 * 否则报 UNKNOWN 退出 2。这让「一条命令复算」要人先手动起服务。
 * 本助手：服务不可达就 spawn serve.mjs（stdio:'ignore' 避开沙箱 pipe 限制），
 * 最多等 10s；起不来如实返回 ok:false（调用方标 UNKNOWN，不伪 FAIL）；测完 stopServer 杀掉。
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

async function probe(base, ms) {
  try {
    const r = await fetch(base + '/api/host-status', { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureServer(base, opts = {}) {
  const quick = opts.quickMs || 1200;
  if (await probe(base, quick)) return { started: false, ok: true, why: '外部服务已在跑', child: null };

  const port = (() => { try { return new URL(base).port || '47124'; } catch { return '47124'; } })();
  const attempts = opts.attempts || 3;
  let lastWhy = '';

  // 第 213 轮：串行跑多个脚本时，上一个脚本的服务可能还没完全释放端口（TIME_WAIT），
  // 新 server 起来会 bind 失败并立即退出。这里检测「子进程早退」→ 递增退避重试，根治偶发争用。
  for (let a = 1; a <= attempts; a++) {
    let child;
    let exited = null;
    try {
      child = spawn(process.execPath, [join(ROOT, 'tools/workbench/serve.mjs')], {
        cwd: ROOT, env: { ...process.env, PORT: port }, stdio: 'ignore', windowsHide: true,
      });
    } catch (e) {
      lastWhy = 'spawn 失败：' + e.message;
      continue;
    }
    child.on('exit', (code) => { exited = code; });

    let ok = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await probe(base, 800)) { ok = true; break; }
      if (exited !== null) break; // 子进程已退出（多半端口被占），本轮提前结束
    }
    if (ok) {
      return {
        started: true, ok: true,
        why: a === 1 ? '自起服务成功' : '自起服务成功（第 ' + a + ' 次尝试，前次疑似端口争用）',
        child,
      };
    }
    lastWhy = exited !== null ? '服务进程早退（exit=' + exited + '，疑似端口被占）' : '自起后 10s 内仍不可达';
    await stopServer(child);
    await new Promise((r) => setTimeout(r, 400 * a)); // 递增退避，给 TIME_WAIT 一点时间
  }
  return { started: true, ok: false, why: lastWhy + '（已重试 ' + attempts + ' 次）', child: null };
}

export async function stopServer(child) {
  if (!child) return;
  try { child.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 300));
}