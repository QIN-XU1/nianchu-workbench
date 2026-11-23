/**
 * check 认证结果缓存：gate validate 很贵（每场景 ~270ms × 6 次子进程）。
 *
 * 与 selfcheck-cache 的区别：
 *   - selfcheck 缓存「门禁本身可信吗」——变化极少
 *   - 本缓存「每个 check 是否被认证」——check 改了就变
 *
 * 因此指纹必须包含：
 *   - check.mjs 的 mtime+size
 *   - scene.json 的 protects
 *   - baseline/ 数据的 mtime+size
 *   - gate.mjs / mutations.mjs / invariant-floor.mjs 的 mtime+size（门禁改了就重算）
 *
 * 这样：check 没改 → 秒出；check 改了 → 重算（正确）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HERE = import.meta.dirname;
const CACHE_DIR = join(HERE, '.cache');
const CACHE_FILE = join(CACHE_DIR, 'validations.json');

function fileSig(p) {
  try {
    const st = statSync(p);
    return `${p}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${p}:missing`;
  }
}

export function sceneFingerprint(scene) {
  const parts = [
    fileSig(scene.check),
    fileSig(join(scene.dir, 'scene.json')),
    fileSig(join(HERE, 'gate.mjs')),
    fileSig(join(HERE, 'mutations.mjs')),
    fileSig(join(HERE, 'invariant-floor.mjs')),
  ];
  const base = scene.baselineDir || scene.dataDir;
  try {
    for (const f of readdirSync(base).sort()) parts.push(fileSig(join(base, f)));
  } catch { parts.push(`${base}:missing`); }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

function readAll() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

function writeAll(data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** 取某场景的认证结果（带缓存） */
export function validationOf(scene, { force = false } = {}) {
  const fp = sceneFingerprint(scene);
  const all = readAll();
  const hit = all[scene.id];
  if (!force && hit && hit.fingerprint === fp) {
    return { verdict: hit.verdict, cached: true };
  }

  let verdict = 'REJECT';
  try {
    const out = execFileSync('node', [join(HERE, 'gate-cli.mjs'), 'validate', scene.check, scene.id], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    verdict = /ACCEPT/.test(out.replace(/\x1b\[[0-9;]*m/g, '')) ? 'ACCEPT' : 'REJECT';
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
    verdict = /ACCEPT/.test(out) ? 'ACCEPT' : 'REJECT';
  }

  all[scene.id] = { fingerprint: fp, verdict, at: Date.now() };
  writeAll(all);
  return { verdict, cached: false };
}

/** 批量取（并行，限并发） */
export async function validationOfAll(scenes, { force = false, limit = 8 } = {}) {
  const results = new Array(scenes.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= scenes.length) return;
      results[i] = validationOf(scenes[i], { force });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, scenes.length) }, () => worker()));
  return results;
}

/** CLI 调试 */
if (process.argv[1] && /validation-cache\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const { discover } = await import('./scene-loader.mjs');
  const root = process.argv[2] || join(HERE, 'scenes');
  const scenes = discover(root).filter(s => !s.error);
  for (const s of scenes) {
    const r = validationOf(s);
    console.log(`${r.cached ? 'cached ' : 'computed'}  ${s.id.padEnd(20)} ${r.verdict}`);
  }
}
