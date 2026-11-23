#!/usr/bin/env node
/**
 * sea —— Agent 自检与完成判定。
 *
 * 设计目标（对应方案 10 篇 U1–U8）：
 *   U1 首值时间 < 30 秒    U2 零配置        U3 不撒谎（机器判据）
 *   U4 安静                U5 可撤回        U6 人话失败
 *   U7 渐进披露            U8 门禁可信
 *
 * 用法：
 *   sea [--root <dir>]           首屏（无需参数）
 *   sea check <scene>            跑一次判定
 *   sea verify                   自检：反例 + 门禁
 *   sea undo                     退回上一次快照
 *   sea --more                   展开细节
 *
 * 场景从 <root>/scenes/ 自动发现：新增场景 = 建一个目录，不改代码。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as undoStore from './undo.mjs';
import { discover, healthy } from './scene-loader.mjs';
import { gateSelfcheck, floorSelfcheck } from './selfcheck-cache.mjs';
import { validationOfAll } from './validation-cache.mjs';
import { check as memCheck } from './memory-guard.mjs';
import { check as docIdxCheck } from './doc-index-judge.mjs';
import { verify as identityVerify } from './identity.mjs';
import { activeCapabilities, estimateFixedCost } from './capabilities.mjs';
import { summary as boardSummary } from './boards.mjs';
import { pendingRequests } from './collab.mjs';

const HERE = import.meta.dirname;
const GATE = join(HERE, 'gate-cli.mjs');
const FLOOR = join(HERE, 'floor-selfcheck.mjs');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
};

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const more = argv.includes('--more');

function optValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}
const ROOT = optValue('--root') || join(HERE, 'scenes');
const positional = argv.filter((a, i) => !a.startsWith('--') &&
  !(i > 0 && argv[i - 1] === '--root'));
const [cmd, arg] = positional;

// ---------- 执行 ----------
function runNode(file, args, dataDir) {
  try {
    const out = execFileSync('node', [file, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: dataDir ? { ...process.env, SEA_DATA_DIR: dataDir } : { ...process.env },
    });
    return { code: 0, out: out.replace(/\x1b\[[0-9;]*m/g, '') };
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
    return { code: e.status ?? 1, out };
  }
}

function runCheck(scene, dataDir) {
  return runNode(scene.check, [scene.id], dataDir || scene.dataDir);
}

function parse(out) {
  const lines = out.split('\n');
  const head = lines[0] || '';
  const items = lines.filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2));
  if (head.startsWith('PASS')) return { verdict: 'PASS', diffCount: 0, items: [] };
  const m = head.match(/差异集合\s*=\s*(\d+)\s*项/);
  return { verdict: 'FAIL', diffCount: m ? Number(m[1]) : items.length, items };
}

/** 门禁自检：三条正式 check 是否都通过 DoneSpec 门禁 */
async function runGate() {
  if (!existsSync(GATE)) return { accepted: 0, total: 0, skipped: true, results: [] };
  const scenes = healthy(ROOT);
  const cached = await validationOfAll(scenes);
  const results = scenes.map((s, i) => ({ id: s.id, verdict: cached[i].verdict, cached: cached[i].cached }));
  const accepted = results.filter(x => x.verdict === 'ACCEPT').length;
  return { accepted, total: results.length, results };
}

/** 不变量下限自检：过弱的声明会不会被拦下 */
function runFloor() {
  const r = floorSelfcheck(ROOT);
  return { ok: Number(r.passed) === Number(r.total), passed: r.passed, total: r.total, cached: r.cached };
}

/** 反例自检：门禁本身会不会拒绝坏 check */
function runVerify() {
  if (!existsSync(GATE)) return { ok: false, passed: 0, total: 0, out: '门禁未安装', cached: false };
  const r = gateSelfcheck(ROOT);
  return { ok: Number(r.passed) === Number(r.total), passed: r.passed, total: r.total, out: '', cached: r.cached };
}

/** 并行执行全部 check（限制并发，避免进程过多） */
async function runChecksParallel(scenes, limit = 8) {
  const results = new Array(scenes.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= scenes.length) return;
      const s = scenes[i];
      const raw = runCheck(s);
      results[i] = { scene: s, r: parse(raw.out) };
    }
  }

  const n = Math.min(limit, scenes.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

// ---------- 首屏 ----------
async function home() {
  const all = discover(ROOT);
  const broken = all.filter(s => s.error);
  const scenes = all.filter(s => !s.error);

  if (scenes.length === 0) {
    if (broken.length > 0) {
      console.log(`${C.red}${C.bold}sea${C.reset} · ${C.bold}${broken.length} 个场景配置有误${C.reset}`);
      for (const s of broken) {
        console.log(`  ${C.red}✗${C.reset} ${s.id.padEnd(20)}`);
        for (const line of String(s.error).split('；')) {
          console.log(`     ${C.dim}${line}${C.reset}`);
        }
      }
      console.log(`${C.dim}  目录：${ROOT}${C.reset}`);
      return 2;
    }
    console.log(`${C.red}${C.bold}sea${C.reset} · ${C.bold}还没有任何场景${C.reset}`);
    console.log(`${C.dim}  在 ${ROOT} 下建一个目录，放入 scene.json + check.mjs + data/ 即可${C.reset}`);
    return 2;
  }

  // 并行跑全部 check
  const results = await runChecksParallel(scenes);
  const failing = results.filter(x => x.r.verdict !== 'PASS');

  // 坏场景必须显形
  if (broken.length > 0) {
    console.log(`${C.red}${C.bold}sea${C.reset} · ${C.bold}${broken.length} 个场景配置有误${C.reset}`);
    for (const s of broken) {
      console.log(`  ${C.red}✗${C.reset} ${s.id.padEnd(20)} ${C.dim}${s.error}${C.reset}`);
    }
    if (failing.length === 0) console.log(`${C.dim}  其余 ${scenes.length} 个场景正常${C.reset}`);
    return 1;
  }

  // ---- 三层信任链：任一不成立，就不能说"没事要你做"（U3 不撒谎）----
  const v = runVerify();
  const floor = runFloor();
  const gate = await runGate();
  const snaps = undoStore.count();

  const trustBroken = [];
  if (!v.ok) trustBroken.push(`门禁自检 ${v.passed}/${v.total} —— 它可能放过坏 check`);
  if (!floor.ok) trustBroken.push(`不变量下限 ${floor.passed}/${floor.total} —— 场景声明可能过弱`);
  if (gate.accepted !== gate.total) {
    const bad = gate.results.filter(x => x.verdict !== 'ACCEPT').map(x => x.id);
    trustBroken.push(`check 认证 ${gate.accepted}/${gate.total} —— 未通过：${bad.join(', ')}`);
  }

  // ---- 资产体检：记忆红线 + 文档索引（用户需求 3/6）----
  const assetProblems = [];
  for (const s of scenes) {
    const memPath = join(s.dir, 'MEMORY.md');
    const mr = memCheck(memPath);
    if (mr.measured.exists && !mr.ok) {
      assetProblems.push(`${s.id} 记忆超红线：${mr.problems.join('；')}`);
    }
  }
  const idxr = docIdxCheck(ROOT);
  if (!idxr.ok) {
    assetProblems.push(`${idxr.mustIndex.length} 个目录该有索引却没有：${idxr.mustIndex.map(m => m.rel + '(' + m.docCount + ')').join(', ')}`);
  }

  // 身份索引：每个场景必须有 .identity.json（否则无法认领身份）
  const idr = identityVerify(ROOT);
  const noIdentity = idr.problems.filter(x => x.kind === 'NO_IDENTITY');
  if (noIdentity.length > 0) {
    assetProblems.push(`${noIdentity.length} 个场景缺身份索引（无法认领）：${noIdentity.map(x => x.scene).join(', ')}`);
  }

  // 共享层：待办积压 & 未处理协作请求（这些是"该做但没做"的活）
  let boardInfo = { todos: 0, todoItems: [], notices: 0 };
  try { boardInfo = boardSummary(); } catch { /* 板未初始化 */ }
  let pendingCollab = 0;
  const pendingByScene = [];
  for (const s of scenes) {
    let n = 0;
    try { n = pendingRequests(s.id); } catch { /* ignore */ }
    if (n > 0) { pendingCollab += n; pendingByScene.push(`${s.id}(${n})`); }
  }

  if (trustBroken.length > 0) {
    console.log(`${C.red}${C.bold}sea${C.reset} · ${C.bold}我的检查本身不可信${C.reset}`);
    for (const b of trustBroken) console.log(`  ${C.red}✗${C.reset} ${b}`);
    console.log(`${C.dim}  含义：下面的结论不可信，先修信任链${C.reset}`);
    if (failing.length > 0) console.log(`${C.dim}  另有 ${failing.length} 个场景有问题（先修信任链）${C.reset}`);
    for (const ap of assetProblems) console.log(`  ${C.yellow}!${C.reset} ${C.dim}${ap}${C.reset}`);
    return 2;
  }

  if (failing.length === 0) {
    console.log(`${C.green}${C.bold}sea${C.reset} · ${C.dim}现在没事要你做${C.reset}`);
    const assetTag = assetProblems.length === 0 ? '资产 0 问题' : `资产 ${assetProblems.length} 问题`;

    // 能力开关：默认全关；开着的要显示（让人知道自己在花钱/占额度）
    const active = activeCapabilities();
    const fixed = estimateFixedCost();
    const capTag = active.length === 0
      ? '外挂 0 项（全关）'
      : `外挂 ${active.length} 项${fixed.tokens > 0 ? '（约 ' + fixed.tokens + ' token/轮）' : ''}`;

    const boardTag = boardInfo.todos > 0 ? `待办 ${boardInfo.todos}` : '待办 0';
    const collabTag = pendingCollab > 0 ? `协作 ${pendingCollab} 待处理` : null;
    console.log(`${C.dim}  ${scenes.length} 个场景 · 门禁 ${v.passed}/${v.total} · 下限 ${floor.passed}/${floor.total} · 认证 ${gate.accepted}/${gate.total} · ${assetTag} · ${boardTag}${collabTag ? ' · ' + collabTag : ''} · ${capTag}${C.reset}`);
    if (boardInfo.todos > 0) {
      for (const item of boardInfo.todoItems.slice(0, 3)) console.log(`  ${C.yellow}○${C.reset} ${C.dim}待办：${item}${C.reset}`);
    }
    if (pendingCollab > 0) {
      console.log(`  ${C.yellow}●${C.reset} ${C.dim}协作请求待处理：${pendingByScene.join(', ')}${C.reset}`);
    }
    if (more && active.length > 0) {
      for (const a of active) console.log(`  ${C.yellow}●${C.reset} ${C.dim}${a.label}（${a.cost}）${C.reset}`);
    }
    if (assetProblems.length > 0) {
      for (const ap of assetProblems) console.log(`  ${C.yellow}!${C.reset} ${C.dim}${ap}${C.reset}`);
      console.log(`${C.dim}  修复：sea-audit.mjs 可定位；记忆超限可 archive 归档${C.reset}`);
      return 3;      // 资产问题：需要处理，但不是信任问题
    }
    if (more) {
      for (const x of results) {
        console.log(`  ${C.green}PASS${C.reset} ${x.scene.name.padEnd(14)} ${C.dim}${x.scene.desc}${C.reset}`);
      }
      if (snaps > 0) console.log(`${C.dim}  撤销点：${snaps} 个${C.reset}`);
    }
    return 0;
  }

  console.log(`${C.yellow}${C.bold}sea${C.reset} · ${C.bold}${failing.length} 件事需要你${C.reset}`);
  for (const x of results) {
    if (x.r.verdict === 'PASS') {
      if (more) console.log(`  ${C.green}PASS${C.reset} ${x.scene.name.padEnd(14)} ${C.dim}差异 0${C.reset}`);
      continue;
    }
    console.log(`  ${C.red}FAIL${C.reset} ${x.scene.name.padEnd(14)} ${C.dim}${x.scene.desc}${C.reset}`);
    if (x.r.items.length > 0) {
      for (const item of x.r.items) console.log(`       ${C.dim}差${C.reset} ${item}`);
    } else {
      console.log(`       ${C.dim}差异 ${x.r.diffCount} 项（--more 看明细）${C.reset}`);
    }
  }
  console.log(`${C.dim}  细节：sea check <场景> · 自检：sea verify${C.reset}`);
  if (snaps > 0) {
    console.log(`${C.dim}  撤销点：${snaps} 个（sea undo 可退回）${C.reset}`);
  } else {
    console.log(`${C.yellow}  没有撤销点${C.reset}${C.dim}：这次我只读、没改动任何东西。${C.reset}`);
  }
  return 1;
}

// ---------- check ----------
function check(sceneId) {
  const all = discover(ROOT);
  const scene = all.find(s => s.id === sceneId || s.name === sceneId);
  if (!scene) {
    console.log(`${C.red}不认识这个场景${C.reset}：${sceneId}`);
    console.log(`${C.dim}可用的：${all.filter(s => !s.error).map(s => s.id).join(' · ')}${C.reset}`);
    return 2;
  }
  if (scene.error) {
    console.log(`${C.red}这个场景配置有误${C.reset}：${scene.id}`);
    console.log(`${C.dim}  ${scene.error}${C.reset}`);
    return 2;
  }
  const raw = runCheck(scene);
  const r = parse(raw.out);

  if (r.verdict === 'PASS') {
    console.log(`${C.green}${C.bold}PASS${C.reset}  ${scene.name}`);
    console.log(`${C.dim}      差异集合 = 0${C.reset}`);
    console.log(`${C.dim}      验证：check exit 0（机器结论，不是我的判断）${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}FAIL${C.reset}  ${scene.name}`);
    console.log(`${C.dim}      差 ${r.diffCount} 项：${C.reset}`);
    for (const item of r.items) console.log(`      ${C.red}·${C.reset} ${item}`);
    console.log(`${C.dim}      下一步：修正后重跑 sea check ${scene.id}${C.reset}`);
  }
  if (more) {
    console.log(`\n${C.dim}--- 原始输出 ---${C.reset}`);
    console.log(raw.out);
  }
  return r.verdict === 'PASS' ? 0 : 1;
}

// ---------- verify ----------
function verify() {
  const v = runVerify();
  console.log(`${C.bold}sea verify${C.reset} · ${C.dim}我的检查本身可信吗${C.reset}`);
  if (v.ok) {
    console.log(`  ${C.green}✓${C.reset} 门禁元验证 ${v.passed}/${v.total} 通过`);
    console.log(`${C.dim}     含义：它会拒绝漏报 / 谎报 / 说不清的 check${C.reset}`);
  } else {
    console.log(`  ${C.red}✗${C.reset} 门禁元验证 ${v.passed}/${v.total}`);
    console.log(`${C.red}     这意味着我的检查可能被改坏而无人发现，不能信任${C.reset}`);
  }
  if (more) {
    console.log(`\n${C.dim}--- 原始输出 ---${C.reset}`);
    console.log(v.out);
  }
  return v.ok ? 0 : 1;
}

// ---------- undo ----------
function undo() {
  const id = undoStore.undo();
  if (id === null) {
    console.log(`${C.dim}没有可撤销的改动${C.reset}`);
    return 0;
  }
  console.log(`${C.green}已退回${C.reset} 快照 #${id}`);
  console.log(`${C.dim}      还剩 ${undoStore.count()} 个撤销点${C.reset}`);
  return 0;
}

// ---------- 路由 ----------
let code;
if (!cmd) code = await home();
else if (cmd === 'check') code = check(arg);
else if (cmd === 'verify') code = verify();
else if (cmd === 'undo') code = undo();
else {
  console.log(`${C.red}不认识的命令${C.reset}：${cmd}`);
  console.log(`${C.dim}可用：sea · sea check <场景> · sea verify · sea undo${C.reset}`);
  code = 2;
}
process.exit(code);
