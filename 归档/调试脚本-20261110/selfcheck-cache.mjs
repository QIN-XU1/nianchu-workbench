/**
 * 自检结果缓存：把慢的自检（gate selfcheck / floor selfcheck）结果缓存起来。
 *
 * 为什么（U1 首值实测）：
 *   gate selfcheck 占首屏 71% 的时间（3856ms / 5455ms）。
 *   它每次跑 5 场景 × 4 候选 × N 次子进程 —— 完全不该在每次打开时同步重跑。
 *
 * 设计：
 *   - 缓存键 = 所有 check.mjs + gate.mjs + mutations.mjs 的 mtime 摘要
 *   - 任一文件变化 → 缓存失效 → 重跑
 *   - 缓存存在 → 直接读结果（<5ms）
 *
 * 这是"快"与"真"的折中：缓存会陈旧，但键包含 mtime，所以陈旧窗口只到下次改动。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HERE = import.meta.dirname;
const CACHE_DIR = join(HERE, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'selfcheck.json');

/** 收集"影响自检结果"的文件 mtime 指纹 */
function fingerprint(scenesRoot) {
  const parts = [];
  const push = (p) => {
    try {
      const st = statSync(p);
      parts.push(`${p}:${st.mtimeMs}:${st.size}`);
    } catch { /* 缺失也算变化 */ parts.push(`${p}:missing`); }
  };

  // 门禁自身的代码
  for (const f of ['gate.mjs', 'mutations.mjs', 'invariant-floor.mjs', 'scene-loader.mjs']) {
    push(join(HERE, f));
  }
  // 场景的 check + scene.json + baseline 数据
  try {
    for (const d of readdirSync(scenesRoot)) {
      const dir = join(scenesRoot, d);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      push(join(dir, 'check.mjs'));
      push(join(dir, 'scene.json'));
      const base = join(dir, 'baseline');
      try {
        for (const f of readdirSync(base)) push(join(base, f));
      } catch { /* 无 baseline */ }
    }
  } catch { /* 目录不存在 */ }

  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

function readCache(fp) {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    return c.fingerprint === fp ? c : null;
  } catch { return null; }
}

function writeCache(fp, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({ fingerprint: fp, at: Date.now(), ...data }, null, 2), 'utf8');
}

/** 跑一个自检脚本并解析 */
function runSelfcheck(script, pattern, args = []) {
  try {
    const full = join(HERE, script);
    const out = execFileSync('node', [full, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (process.env.SEA_DEBUG) {
      console.error('[debug] script=' + full + ' outlen=' + out.length);
      console.error('[debug] tail=' + out.trim().split('\n').slice(-3).join(' | '));
    }
    const m = out.replace(/\x1b\[[0-9;]*m/g, '').match(pattern);
    if (process.env.SEA_DEBUG) console.error('[debug] matched=' + (m ? m[1] + '/' + m[2] : 'NULL'));
    return { ok: true, passed: m ? m[1] : '?', total: m ? m[2] : '?' };
  } catch (e) {
    if (process.env.SEA_DEBUG) {
      console.error('[debug] THREW on ' + script + ' status=' + e.status);
      console.error('[debug] stderr=' + String(e.stderr || '').slice(0, 300));
      console.error('[debug] stdout head=' + String(e.stdout || '').slice(0, 300));
    }
    const out = ((e.stdout || '') + (e.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
    const m = out.match(pattern);
    return { ok: false, passed: m ? m[1] : '0', total: m ? m[2] : '?' };
  }
}

/** 取门禁自检（带缓存） */
export function gateSelfcheck(scenesRoot, { force = false } = {}) {
  const fp = fingerprint(scenesRoot);
  if (!force) {
    const c = readCache(fp);
    if (c && c.gate) return { ...c.gate, cached: true };
  }
  const gate = runSelfcheck('gate-cli.mjs', /元验证：\s*(\d+)\/(\d+)/, ['selfcheck']);
  const floor = runSelfcheck('floor-selfcheck.mjs', /元验证：\s*(\d+)\/(\d+)/, []);
  writeCache(fp, { gate, floor });
  return { ...gate, cached: false };
}

/** 取不变量下限自检（带缓存） */
export function floorSelfcheck(scenesRoot, { force = false } = {}) {
  const fp = fingerprint(scenesRoot);
  if (!force) {
    const c = readCache(fp);
    if (c && c.floor) return { ...c.floor, cached: true };
  }
  const gate = runSelfcheck('gate-cli.mjs', /元验证：\s*(\d+)\/(\d+)/, ['selfcheck']);
  const floor = runSelfcheck('floor-selfcheck.mjs', /元验证：\s*(\d+)\/(\d+)/, []);
  writeCache(fp, { gate, floor });
  return { ...floor, cached: false };
}

/** 强制重算（sea verify 用） */
export function invalidate() {
  try {
    writeFileSync(CACHE_FILE, '{}', 'utf8');
  } catch { /* ignore */ }
}

/** CLI 调试：显示当前指纹与缓存状态 */
if (process.argv[1] && /selfcheck-cache\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const root = process.argv[2] || join(HERE, 'scenes');
  const fp = fingerprint(root);
  const c = readCache(fp);
  console.log('fingerprint:', fp);
  console.log('cache:', c ? `命中（${new Date(c.at).toISOString()}）` : '未命中');
  if (c) {
    console.log('  gate :', c.gate.passed + '/' + c.gate.total);
    console.log('  floor:', c.floor.passed + '/' + c.floor.total);
  }
}
