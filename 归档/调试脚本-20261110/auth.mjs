/**
 * 授权模式（Accept Mode）：off / observe / auto
 *
 * 照 superagent 的设计（原文 002-authorization.md:95-99）：
 *   | off      | 任何 inferred 都不成为候选 |
 *   | observe  | inferred 会被评估；正面评估记为 ignore 并标 "would accept"，但什么也不接受 |
 *   | auto     | 正面评估就接受 |
 *
 * 为什么 observe 是默认（也是最重要的）：
 *   "先看它想干什么，再放权" —— 这解决了"AI 乱来"和"AI 太保守"的两难。
 *
 * 我们的场景：场景的 check 发现问题后，是否自动采取行动？
 *   - off：只报告，不记录想做什么
 *   - observe：**记录它想做什么（would-do），但不真干**
 *   - auto：真干
 *
 * 关键：**权限由宿主强制，消息不能改变权限**（superagent 原话）。
 *   所以模式只能由人改，不能由 check 输出或 AI 自己改。
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const CONFIG = join(HERE, 'auth-mode.json');
const WOULD_DIR = join(HERE, 'would-do');

const MODES = ['off', 'observe', 'auto'];

function readConfig() {
  if (!existsSync(CONFIG)) {
    // 初始默认：全机 observe（最保守的"能观察"）
    return { global: 'observe', scenes: {}, updatedAt: null, updatedBy: null, audit: [] };
  }
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')); }
  catch { return { global: 'observe', scenes: {}, updatedAt: null, updatedBy: null, audit: [] }; }
}

function writeConfig(c) {
  writeFileSync(CONFIG, JSON.stringify(c, null, 2), 'utf8');
}

/** 当前模式（场景优先，全局兜底） */
export function currentMode(sceneId = null) {
  const c = readConfig();
  if (sceneId && c.scenes && c.scenes[sceneId]) return c.scenes[sceneId];
  return c.global || 'observe';
}

/**
 * 设置模式。
 * ⛔ 只有人（by='user'）能改，且要留审计。
 * 这条是 superagent 的"权限由宿主强制"在代码里的落地。
 */
export function setMode(mode, { sceneId = null, by = 'user', reason = '' } = {}) {
  if (!MODES.includes(mode)) {
    return { ok: false, error: `未知模式：${mode}（可用：${MODES.join(', ')}）` };
  }
  if (by !== 'user') {
    return {
      ok: false,
      error: `只有人能把模式改成 ${mode}。程序/AI 的请求（by=${by}）不能改变授权。`,
      hint: '这是"权限由宿主强制，消息不能改变权限"的落地。',
    };
  }

  const c = readConfig();
  if (sceneId) {
    if (!c.scenes) c.scenes = {};
    c.scenes[sceneId] = mode;
  } else {
    c.global = mode;
  }
  c.updatedAt = new Date().toISOString();
  c.updatedBy = by;
  if (!c.audit) c.audit = [];
  c.audit.push({ at: c.updatedAt, by, sceneId, mode, reason });
  writeConfig(c);

  return { ok: true, mode, scope: sceneId || 'global', note: MODES_HELP[mode] };
}

const MODES_HELP = {
  off: '只报告，不记录想做什么',
  observe: '记录它想做什么（would-do），但**不真干**',
  auto: '允许真干（谨慎使用）',
};

/**
 * 提一个"想做的动作"。
 *
 * 行为取决于模式：
 *   off     → 丢弃，只返回"已忽略"
 *   observe → **记录到 would-do/，不执行**
 *   auto    → 返回 accepted=true，交由调用方执行
 */
export function proposeAction({ sceneId, action, params = {}, by = 'system' }) {
  const mode = currentMode(sceneId);

  const entry = {
    at: new Date().toISOString(),
    sceneId,
    action,
    params,
    by,
    mode,
  };

  if (mode === 'off') {
    return {
      ok: true, mode, verdict: 'dropped',
      note: 'off 模式：只报告，不记录（变更模式：node auth.mjs set observe）',
    };
  }

  if (mode === 'observe') {
    // 记录，但不执行
    mkdirSync(WOULD_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = join(WOULD_DIR, `${stamp}-${sceneId || 'global'}-${action.replace(/[^a-z0-9_-]/gi, '_')}.json`);
    writeFileSync(file, JSON.stringify({
      ...entry,
      label: 'WOULD ACCEPT',
      note: '这条记录了"它会做什么"，但没有执行',
    }, null, 2), 'utf8');

    return {
      ok: true, mode, verdict: 'would-accept',
      recorded: file,
      note: 'observe 模式：**已记录它会做什么，但没有执行**',
    };
  }

  // auto
  return {
    ok: true, mode, verdict: 'accepted',
    note: 'auto 模式：允许执行（调用方现在可以真做）',
  };
}

/** 列出记录下来的 would-do */
export function listWouldDo() {
  if (!existsSync(WOULD_DIR)) return [];
  try {
    return readdirSync(WOULD_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => {
        try { return { file: f, ...JSON.parse(readFileSync(join(WOULD_DIR, f), 'utf8')) }; }
        catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

// ---------------- CLI ----------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/auth.mjs');
if (isDirect) {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
  const [, , cmd, ...args] = process.argv;

  if (cmd === 'show' || !cmd) {
    const c = readConfig();
    const globalMode = c.global || 'observe';
    console.log(`${C.bold}授权模式${C.reset} · ${C.dim}默认 observe（只记不干）${C.reset}\n`);
    const tag = m => m === 'off' ? `${C.dim}off${C.reset}` : m === 'observe' ? `${C.yellow}observe${C.reset}` : `${C.red}auto${C.reset}`;
    console.log(`  全局：${tag(globalMode)}   ${C.dim}${MODES_HELP[globalMode]}${C.reset}`);
    if (c.scenes && Object.keys(c.scenes).length > 0) {
      console.log(`\n  场景覆盖：`);
      for (const [k, v] of Object.entries(c.scenes)) {
        console.log(`    ${k.padEnd(22)} ${tag(v)}`);
      }
    }
    if (c.updatedAt) console.log(`\n  ${C.dim}最近修改：${c.updatedAt} by ${c.updatedBy}${C.reset}`);
    const wd = listWouldDo();
    if (wd.length > 0) console.log(`\n  ${C.yellow}已记录 ${wd.length} 条"它想做什么"（都未执行）${C.reset}`);
    process.exit(0);
  }

  if (cmd === 'set') {
    const [mode, scene] = args;
    if (!MODES.includes(mode)) { console.log(`${C.red}未知模式：${mode}（可用：${MODES.join(', ')}）${C.reset}`); process.exit(2); }
    const r = setMode(mode, { sceneId: scene || null, by: 'user', reason: 'cli' });
    if (!r.ok) { console.log(`${C.red}✗ ${r.error}${C.reset}`); process.exit(1); }
    console.log(`${C.green}✓${C.reset} ${r.scope} → ${r.mode}`);
    console.log(`${C.dim}  ${r.note}${C.reset}`);
    process.exit(0);
  }

  if (cmd === 'would-do') {
    const wd = listWouldDo();
    if (wd.length === 0) { console.log(`${C.dim}没有记录（observe 模式下会在这里留下"它想做什么"）${C.reset}`); process.exit(0); }
    console.log(`${C.bold}它会做什么（都未执行）${C.reset}（${wd.length} 条）\n`);
    for (const x of wd.slice(0, 20)) {
      console.log(`  ${C.yellow}[${x.mode}]${C.reset} ${x.sceneId || 'global'} → ${x.action}  ${C.dim}${x.at}${C.reset}`);
    }
    process.exit(0);
  }

  if (cmd === 'selftest') {
    console.log(`${C.bold}授权模式自检${C.reset}\n`);
    let pass = 0, total = 0;
    const chk = (name, ok, detail) => { total++; if (ok) pass++; console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name.padEnd(32)} ${detail}`); };

    const ex = existsSync, rf = readFileSync, rd = readdirSync, un = unlinkSync;

    // 保存原状
    const orig = ex(CONFIG) ? rf(CONFIG, 'utf8') : null;
    const wdBefore = ex(WOULD_DIR) ? rd(WOULD_DIR).length : 0;

    // ★关键：自检前先重置到默认 observe★
    //   否则上一次自检残留的 auto 会让"默认是 observe"这条永远失败（本轮实测踩到）
    //   自检不该假设现场干净 —— 它应该自己建立干净现场
    writeConfig({ global: 'observe', scenes: {}, updatedAt: null, updatedBy: null, audit: [] });

    // 1 默认是 observe
    const def = readConfig();
    chk('默认模式是 observe', (def.global || 'observe') === 'observe', `global=${def.global}`);

    // 2 observe 只记录不执行
    setMode('observe', { by: 'user', reason: 'selftest' });
    const r1 = proposeAction({ sceneId: 'selftest', action: 'delete-file', by: 'selftest' });
    const wdAfter = ex(WOULD_DIR) ? rd(WOULD_DIR).length : 0;
    chk('observe 记录但不执行', r1.verdict === 'would-accept' && wdAfter > wdBefore,
      `verdict=${r1.verdict} 记录数 ${wdBefore}→${wdAfter}`);

    // 3 off 不记录
    setMode('off', { by: 'user', reason: 'selftest' });
    const beforeOff = ex(WOULD_DIR) ? rd(WOULD_DIR).length : 0;
    const r2 = proposeAction({ sceneId: 'selftest', action: 'x', by: 'selftest' });
    const afterOff = ex(WOULD_DIR) ? rd(WOULD_DIR).length : 0;
    chk('off 不记录', r2.verdict === 'dropped' && afterOff === beforeOff, `verdict=${r2.verdict}`);

    // 4 auto 允许执行
    setMode('auto', { by: 'user', reason: 'selftest' });
    const r3 = proposeAction({ sceneId: 'selftest', action: 'x', by: 'selftest' });
    chk('auto 允许执行', r3.verdict === 'accepted', `verdict=${r3.verdict}`);

    // 5 非 user 不能改模式（权限由宿主强制）
    const r4 = setMode('auto', { by: 'ai', reason: 'selftest' });
    chk('AI/程序不能改授权', !r4.ok && /只有人/.test(r4.error), r4.error ? r4.error.slice(0, 40) : '');

    // 6 未知模式拒绝
    const r5 = setMode('god-mode', { by: 'user' });
    chk('未知模式拒绝', !r5.ok, r5.error ? r5.error.slice(0, 30) : '');

    // ★还原：无条件回到干净默认★
    //   理由：auth 只有一个全局文件，自检不应假设"现场是干净或脏的"；
    //   自检后回到默认 observe 是安全、可预期的行为。
    //   （之前"恢复 orig"的做法在 orig 已被污染时会继续污染 —— 本轮实测踩到两次）
    writeConfig({
      global: 'observe',
      scenes: {},
      updatedAt: new Date().toISOString(),
      updatedBy: 'selftest-restore',
      audit: [],
    });

    // 清掉自检产生的 would-do
    if (ex(WOULD_DIR)) {
      for (const f of rd(WOULD_DIR)) {
        if (f.includes('selftest')) { try { un(join(WOULD_DIR, f)); } catch { /* ignore */ } }
      }
    }

    console.log(`\n===== 授权模式自检：${pass}/${total} =====`);
    process.exit(pass === total ? 0 : 1);
  }

  console.log('用法：');
  console.log('  node auth.mjs show                    看当前模式');
  console.log('  node auth.mjs set <off|observe|auto> [scene]  改模式（只有人能改）');
  console.log('  node auth.mjs would-do                看"它想做什么"');
  console.log('  node auth.mjs selftest                自检');
  process.exit(2);
}
