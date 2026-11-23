#!/usr/bin/env node
/**
 * 念初 · 终端会话快照与环境抽象（A2 终端执行）
 *
 * ══ 对标依据 ═════════════════════════════════════════════════
 * D:/refs/hermes-agent（hermes-ecc.md:42-45）：
 *   「Unified spawn-per-call model: every command spawns a fresh `bash -c` process.
 *     A session snapshot (env vars, functions, aliases) is captured once at init and
 *     re-sourced before each command」
 * 以及 :152-159 「one BaseEnvironment ABC …（local, Docker, SSH…）」
 *
 * 关键洞察：**「有」不必须靠内核沙箱**。hermes 的「有」= fresh 进程 + 快照重放 + 环境抽象。
 * 我们原来有 fresh 进程（每次 spawn），但**没有快照**：每次调用都是"失忆"的，
 * 所以 `export FOO=1` 之后再跑一条命令就没了 —— 这跟人用终端的手感完全不同。
 *
 * ══ 这里提供什么 ═════════════════════════════════════════════
 *   ① captureSession(name)：跑一段脚本，把它设的环境变量抓成快照（白名单过滤）
 *   ② loadSession(name)：读快照 → 每次 spawn 前合并进 env（"re-sourced before each command"）
 *   ③ 环境抽象：kind = 'local'（用真实 HOME）| 'scratch'（隔离的临时 HOME/TMP/工作目录）
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · **不是内核沙箱**：scratch 只是把 HOME/TMP 指到临时目录，不能阻止绝对路径写盘。
 * · alias / shell 函数捕获**只在 POSIX bash 下有意义**；Windows cmd 没有 alias，
 *   所以 Windows 上快照只包含环境变量 —— 这点如实标注，不假装抓了 alias。
 * · 没有 docker / ssh / e2b 后端，只有 local 与 scratch 两种。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { USER_DATA_DIR } from './runtime.mjs';
import { buildSandboxEnv } from './toolkit.mjs';

const IS_WIN = process.platform === 'win32';

function sessDir() {
  const d = join(USER_DATA_DIR, 'sessions');
  mkdirSync(d, { recursive: true });
  return d;
}
const sessFile = (name) => join(sessDir(), String(name).replace(/[^\w.-]/g, '_') + '.json');

/** scratch 环境的根目录（每次调用用独立子目录，避免互相污染） */
function scratchRoot() {
  const d = join(USER_DATA_DIR, 'scratch');
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 抓一次会话快照。
 * @param {string} name
 * @param {{cwd?:string, script?:string}} opts  script 里设置的环境变量会被捕获
 */
export function captureSession(name, { cwd = process.cwd(), script = '' } = {}) {
  if (!name) return { ok: false, state: 'FAIL', reason: 'name 必填' };

  // 用一段脚本：先执行用户脚本，再把 env 打出来（用 %NAME% / $NAME 逐条打印太脆，
  // 统一用 node 读 process.env —— 但 node 看不到 shell 里 set 的变量，
  // 所以必须让 shell 自己打印。这里走 `set`（Windows）或 `env`（POSIX）。
  const probe = IS_WIN
    ? (script ? script + ' & ' : '') + 'set'
    : (script ? script + '; ' : '') + 'env';

  const r = spawnSync(probe, {
    shell: true, cwd, encoding: 'utf8', timeout: 20000,
    windowsHide: true, env: buildSandboxEnv(process.env),
  });
  if (r.error || (r.status !== 0 && r.status !== null)) {
    return { ok: false, state: 'FAIL', reason: '抓快照失败：' + String(r.error?.message || r.stderr || r.status).slice(0, 160) };
  }

  const env = {};
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    // Windows 上 `set A=v & set` 会把 `&` 前的空格带进值里（实测 "biz-42 "），
    // 那不是用户设置的值的本意，去掉尾随空白。POSIX 不动。
    let v = line.slice(eq + 1);
    if (IS_WIN) v = v.replace(/[ \t]+$/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    env[k] = v;
  }

  /**
   * 安全：快照要**只滤掉"像密钥的"**，不能用完整白名单 ——
   * 白名单会连用户故意 set 的业务变量一起丢掉（实测：set NIANCHU_SNAP_VAR 后
   * 快照里就没有它了），那快照就没意义了。
   * 所以这里只做敏感名过滤：保留业务变量，剥掉 KEY/TOKEN/SECRET/PASSWORD 等。
   */
  const SENSITIVE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;
  const safeEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SENSITIVE.test(k)) continue;
    safeEnv[k] = v;
  }
  if (!safeEnv.PATH && !safeEnv.Path) safeEnv.PATH = process.env.PATH || '';
  void buildSandboxEnv;

  const aliases = [];
  if (!IS_WIN) {
    try {
      const a = spawnSync('alias -p', { shell: true, cwd, encoding: 'utf8', timeout: 8000, env: buildSandboxEnv(process.env) });
      if (a.status === 0) {
        for (const line of String(a.stdout || '').split(/\r?\n/)) if (line.trim()) aliases.push(line.trim());
      }
    } catch { /* ignore */ }
  }

  const snap = {
    name,
    at: new Date().toISOString(),
    cwd,
    platform: process.platform,
    env: safeEnv,
    aliases,                       // Windows 上恒为空数组（cmd 无 alias），如实记录
    aliasSupported: !IS_WIN,
    note: IS_WIN ? 'Windows cmd 没有 alias/函数，快照只含环境变量' : null,
  };
  try {
    writeFileSync(sessFile(name), JSON.stringify(snap, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, state: 'FAIL', reason: '写快照失败：' + String(e && e.message).slice(0, 120) };
  }
  return { ok: true, state: 'PASS', snapshot: snap };
}

/** 读会话快照；不存在返回 null（不返回空对象假装有） */
export function loadSession(name) {
  if (!name) return null;
  const f = sessFile(name);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return j && j.name === name ? j : null;
  } catch {
    return { name, corrupted: true };
  }
}

export function listSessions() {
  try {
    return readdirSync(sessDir()).filter((f) => f.endsWith('.json')).map((f) => {
      const j = loadSession(f.slice(0, -5));
      return j ? { name: j.name, at: j.at, envCount: Object.keys(j.env || {}).length, platform: j.platform } : null;
    }).filter(Boolean);
  } catch { return []; }
}

export function dropSession(name) {
  try { rmSync(sessFile(name), { force: true }); return { ok: true }; } catch { return { ok: false }; }
}

/**
 * 为一次调用准备执行环境。
 * @param {{kind?:'local'|'scratch', session?:string, cwd?:string, baseEnv?:object}} o
 * @returns {{env:object, cwd:string, kind:string, session:object|null, scratchDir:string|null, warnings:string[]}}
 */
export function prepareEnv({ kind = 'local', session = null, cwd = process.cwd(), baseEnv = process.env } = {}) {
  const warnings = [];
  const env = buildSandboxEnv(baseEnv);

  // 会话快照：白名单之外不覆盖；PATH 不覆盖（否则命令可能找不到）
  let snap = null;
  if (session) {
    snap = loadSession(session);
    if (!snap) warnings.push('会话快照不存在：' + session + '（按无快照执行）');
    else if (snap.corrupted) { warnings.push('会话快照已损坏：' + session); snap = null; }
    else {
      for (const [k, v] of Object.entries(snap.env || {})) {
        if (k === 'PATH' || k === 'Path') continue;
        env[k] = v;
      }
    }
  }

  let scratchDir = null;
  let runCwd = cwd;
  if (kind === 'scratch') {
    scratchDir = join(scratchRoot(), 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    mkdirSync(scratchDir, { recursive: true });
    // 把 HOME/TMP 指到隔离目录，并切到隔离工作目录
    env.HOME = scratchDir;
    env.USERPROFILE = scratchDir;
    env.TMP = scratchDir;
    env.TEMP = scratchDir;
    runCwd = scratchDir;
  } else if (kind !== 'local') {
    warnings.push('未知环境 kind=' + kind + '，按 local 执行');
  }

  return { env, cwd: runCwd, kind: scratchDir ? 'scratch' : 'local', session: snap, scratchDir, warnings };
}