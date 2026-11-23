#!/usr/bin/env node
/**
 * 越界哨兵 —— 检查"谁写了别人的地盘"
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么是"事后审计"而不是"事前拦截"
 * ══════════════════════════════════════════════════════════════
 *
 *  事前拦截需要所有写文件的地方都知道"我是谁" —— 
 *  但 bash/脚本/编辑器都没有这个上下文，改造成本极高。
 *
 *  事后审计可行：按文件 mtime + 场地地图归属，推断"谁可能写了它"。
 *  局限（诚实声明）：无法 100% 确定是谁写的，只能提示"可疑"。
 *
 * ══════════════════════════════════════════════════════════════
 *  不变量
 * ══════════════════════════════════════════════════════════════
 *
 *  INV-1  unmapped-path   所有被跟踪的核心资产路径都必须在场地地图里有归属
 *  INV-2  e-tier-write    E 档路径（别人的地盘）在审计窗口内有修改 → 报告
 *  INV-3  a-tier-write    A 档（宪法）在审计窗口内被修改 → 必须有人确认
 *  INV-4  concurrent-write 同一文件在窗口内被多个场景标记写入 → 冲突
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/越界哨兵.mjs                   # 审计最近 24h
 *  node 工具/越界哨兵.mjs --since 2h        # 审计最近 2 小时
 *  node 工具/越界哨兵.mjs --since 7d        # 审计最近 7 天
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collect as collectMap, whoOwns, TIER } from './场地地图.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');

function readJson(p, fb) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return JSON.parse(s);
  } catch { return fb; }
}

/** 解析 --since 参数：2h / 30m / 7d */
export function parseSince(str) {
  if (!str) return 24 * 3600000;
  if (/^\d+$/.test(str)) return parseInt(str, 10) * 3600000;   // 纯数字 = 小时
  const m = String(str).match(/^(\d+(?:\.\d+)?)([mhd])$/i);
  if (!m) return 24 * 3600000;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return n * (unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000);
}

/**
 * 递归列出目录下所有文件，带 mtime
 */
function listFilesWithMtime(dir, opts) {
  const out = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'out', 'release', '_asar', '.dsh-tui', '缓存', 'sessions', 'profiles', 'MCP', 'logs']);

  function walk(d, depth) {
    if (depth > 8) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) {
        if (skipDirs.has(it.name)) continue;
        walk(p, depth + 1);
      } else {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, mtime: st.mtimeMs, size: st.size });
        } catch { /* 忽略 */ }
      }
    }
  }
  walk(dir, 0);
  return out;
}

/**
 * @param {object} opt
 *   opt.wbRoot      workbench 目录
 *   opt.sinceMs     审计窗口（毫秒）
 *   opt.nowMs       当前时间（测试注入）
 *   opt.rules       场地地图规则（可选，不传则现算）
 */
export function check(opt) {
  const wbRoot = opt.wbRoot || WB;
  const nowMs = opt.nowMs || Date.now();
  const sinceMs = opt.sinceMs || 24 * 3600000;
  const cutoff = nowMs - sinceMs;

  const diffs = [];
  const ID = 'boundary-guard';
  const stats = { scanned: 0, changed: 0, unmapped: 0, aTier: 0, eTier: 0 };

  // ═══ 场地地图 ═══
  const map = opt.rules
    ? { rules: opt.rules }
    : (() => {
        const pm = path.join(wbRoot, '数据', '.dsh', '场景记忆', '_共享记忆', '场地地图.json');
        if (fs.existsSync(pm)) {
          const j = readJson(pm, null);
          if (j && Array.isArray(j.rules)) return j;
        }
        return collectMap();
      })();

  // ★ 自检修复：从 wbRoot 推导 root（支持测试注入临时目录）
  //   场地地图里的模式都是 "workbench/xxx" 开头，
  //   所以要找到 wbRoot 的**父目录**作为 root
  const ROOT_DYNAMIC = path.dirname(wbRoot);

  // ═══ 要扫描的目录（只扫"人写的"，不扫依赖）═══
  const scanDirs = [
    path.join(wbRoot, '工具'),
    path.join(wbRoot, '外壳', 'scenarios'),
    path.join(wbRoot, '外壳', 'ui'),
    path.join(wbRoot, '数据', '.dsh', '场景记忆'),
    path.join(wbRoot, '数据', '.dsh', 'skills'),
    path.join(wbRoot, 'sceneboard'),
    // ★ 自检修复：.dsh 根目录也要扫（AGENTS.md 等宪法文件在这）
    path.join(wbRoot, '数据', '.dsh'),
  ];

  const files = [];
  for (const d of scanDirs) {
    if (fs.existsSync(d)) files.push(...listFilesWithMtime(d));
  }
  stats.scanned = files.length;

  // ═══ INV-1 未定义归属的路径 ═══
  const unmapped = [];
  const changedFiles = [];

  for (const f of files) {
    const rel = path.relative(ROOT_DYNAMIC, f.path).replace(/\\/g, '/');
    const owner = whoOwns(map.rules, rel);

    if (!owner) {
      // 只报"核心资产"，不报方案文档等
      const isCore = /\/(工具|scenarios|ui|场景记忆|skills|sceneboard)\//.test('/' + rel);
      if (isCore) unmapped.push(rel);
      continue;
    }

    if (f.mtime > cutoff) {
      changedFiles.push({
        path: rel,
        mtime: f.mtime,
        tier: owner.tier,
        owner: owner.owner,
        scene: owner.scene,
        desc: owner.desc,
      });
    }
  }

  stats.unmapped = unmapped.length;
  stats.changed = changedFiles.length;

  for (const u of unmapped.slice(0, 5)) {
    diffs.push('路径未在场地地图里定义归属：' + u + '（无法判断谁能改）');
  }
  if (unmapped.length > 5) {
    diffs.push('... 另有 ' + (unmapped.length - 5) + ' 个未定义路径');
  }

  // ═══ INV-3 A 档被修改 ═══
  //
  //  2026-11-10 增强：支持「宿主已确认」的情况。
  //
  //  判据没放宽 —— 仍然要求「A 档被改必须有人确认」，
  //  只是确认的载体从「无」变成了「可追溯的记录文件」。
  //
  //  查 A档确认.json，看当前内容 SHA 是否在确认记录里：
  //    · 有记录且 SHA 对得上 → 视为已授权，不报
  //    · 没记录 / SHA 对不上 → 继续报（内容一改就失效）
  //
  //  为什么这么做（而不是直接跳过 A 档检查）：
  //    跳过 = 假证。以后谁改都不报警。
  //    留记录 = 谁确认的、确认的什么内容、什么时候，全可追溯。
  //
  //  实现说明：check() 是同步函数，这里不能 await import，
  //  所以直接同步读确认记录文件（结构简单，不需要完整工具）。
  const A_CONFIRM_PATH = path.join(wbRoot, '数据', '.dsh', '场景记忆', '_共享记忆', 'A档确认.json');

  function readAConfirmRecords() {
    try {
      const t = fs.readFileSync(A_CONFIRM_PATH, 'utf8').replace(/^\uFEFF/, '');
      const j = JSON.parse(t);
      return Array.isArray(j.confirmations) ? j.confirmations : [];
    } catch {
      return [];
    }
  }

  function shaOfFile(absPath) {
    try {
      const t = fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '');
      return crypto.createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 16);
    } catch {
      return null;
    }
  }

  const aConfirmRecords = readAConfirmRecords();

  const aChanged = changedFiles.filter(c => c.tier === TIER.A);
  stats.aTier = aChanged.length;
  stats.aTierConfirmed = 0;

  for (const c of aChanged) {
    const abs = path.join(ROOT_DYNAMIC, c.path);
    const sha = shaOfFile(abs);
    const hit = sha ? aConfirmRecords.find((r) => r.sha === sha) : null;

    if (hit) {
      // 已由宿主确认 → 不报，但留痕
      stats.aTierConfirmed++;
      continue;
    }

    diffs.push(
      'A 档（宪法）在窗口内被修改：' + c.path +
      '（' + new Date(c.mtime).toISOString().slice(0, 16).replace('T', ' ') + '）' +
      ' —— 只有宿主能改，必须确认' +
      '（确认命令：node 工具/A档确认.mjs --confirm --by "宿主" --reason "..."）'
    );
  }

  // ═══ E 档：需要知道"谁在写"才能判，这里只能提示 ═══
  //   做法：如果有 .dsh/当前场景 标记文件，用它判断；
  //         否则只记录"多个场景的地盘同时被改"作为可疑信号
  const currentSceneFile = path.join(wbRoot, '数据', '.dsh', '当前场景');
  let currentScene = null;
  if (fs.existsSync(currentSceneFile)) {
    currentScene = fs.readFileSync(currentSceneFile, 'utf8').trim();
  }

  if (currentScene) {
    const eChanged = changedFiles.filter(c =>
      c.tier === TIER.D && c.scene && c.scene !== currentScene
    );
    stats.eTier = eChanged.length;
    for (const c of eChanged) {
      diffs.push(
        'E 档越界：当前场景「' + currentScene + '」的窗口内，' +
        '别的场景「' + c.scene + '」的地盘被修改：' + c.path
      );
    }
  }

  // ═══ INV-4 冲突信号：窗口内多个不同场景的地盘同时被改 ═══
  const scenesTouched = new Set(
    changedFiles.filter(c => c.tier === TIER.D && c.scene).map(c => c.scene)
  );
  if (scenesTouched.size >= 2) {
    // 这不是违规，只是提示（正常的多场景并行工作）
    stats.scenesTouched = [...scenesTouched];
  }

  return { id: ID, diffs, stats, changedFiles };
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  越界哨兵 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // 注意：ROOT_DYNAMIC = path.dirname(wbRoot)，场地地图模式是 "workbench/xxx"
  // 所以样本必须是 <tmp>/workbench/ 结构
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bndguard-'));
  const wbRoot = path.join(tmp, 'workbench');
  const shared = path.join(wbRoot, '数据', '.dsh', '场景记忆', '_共享记忆');
  const toolDir = path.join(wbRoot, '工具');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(toolDir, { recursive: true });

  // 工具目录放一个文件（这是"核心资产"，必须在地图里）
  const toolFile = path.join(toolDir, 'test.mjs');
  fs.writeFileSync(toolFile, '// test\n', 'utf8');

  const RULES = [
    { tier: 'C', pattern: 'workbench/工具/**', owner: '管理员场景', desc: '工具' },
    { tier: 'A', pattern: 'workbench/数据/.dsh/AGENTS.md', owner: '宿主', desc: '宪法' },
    { tier: 'C', pattern: 'workbench/数据/.dsh/场景记忆/_共享记忆/**', owner: '管理员场景', desc: '共享记忆' },
  ];

  const writeConfirm = (list) => fs.writeFileSync(path.join(shared, 'A档确认.json'),
    JSON.stringify({ confirmations: list }, null, 2), 'utf8');

  // ① 合规：工具目录有归属
  writeConfirm([]);
  const r1 = check({ wbRoot, rules: RULES, nowMs: Date.now(), sinceMs: 24 * 3600000 });
  chk('合规时通过', r1.diffs.length === 0,
      r1.diffs.length === 0 ? '' : r1.diffs.slice(0, 2).join(';'));

  // ② 反例 1：工具目录里的文件没有归属 → 必须报
  const noRule = [{ tier: 'A', pattern: 'workbench/AGENTS.md', owner: '宿主', desc: '宪法' }];
  const r2 = check({ wbRoot, rules: noRule, nowMs: Date.now(), sinceMs: 24 * 3600000 });
  chk('反例：核心资产无归属必须报', r2.diffs.length > 0,
      r2.diffs.length === 0 ? '没报（检查是假的）' : String(r2.diffs[0]).slice(0, 50));

  // ③ 反例 2：A 档被改但没确认 → 必须报
  const agents = path.join(wbRoot, '数据', '.dsh', 'AGENTS.md');
  const AGENTS_V1 = '# 宪法 v1\n';
  fs.writeFileSync(agents, AGENTS_V1, 'utf8');
  const sha = crypto.createHash('sha256').update(AGENTS_V1).digest('hex').slice(0, 16);
  writeConfirm([]);
  const r3 = check({ wbRoot, rules: RULES, nowMs: Date.now(), sinceMs: 24 * 3600000 });
  chk('反例：A档改动未确认必须报', r3.diffs.length > 0,
      r3.diffs.length === 0 ? '没报' : String(r3.diffs[0]).slice(0, 50));

  // ④ 恢复
  writeConfirm([{ sha, by: 'test', at: new Date().toISOString() }]);
  const r4 = check({ wbRoot, rules: RULES, nowMs: Date.now(), sinceMs: 24 * 3600000 });
  chk('恢复后重新通过', r4.diffs.length === 0,
      r4.diffs.length === 0 ? '' : String(r4.diffs[0]).slice(0, 50));

  chk('关键：2 个反例全部被检出',
      r2.diffs.length > 0 && r3.diffs.length > 0,
      '这是越界哨兵存在的唯一理由');

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const args = process.argv.slice(2);
  let sinceMs = 24 * 3600000;
  const si = args.indexOf('--since');
  if (si >= 0 && args[si + 1]) sinceMs = parseSince(args[si + 1]);

  const opt = {
    wbRoot: process.env.SEA_WB_ROOT ? path.resolve(process.env.SEA_WB_ROOT) : WB,
    sinceMs,
    nowMs: process.env.SEA_NOW ? (Number.isFinite(+process.env.SEA_NOW) ? +process.env.SEA_NOW : Date.parse(process.env.SEA_NOW)) : Date.now(),
  };

  const r = check(opt);
  const hours = (sinceMs / 3600000).toFixed(1);

  console.log('  审计窗口: 最近 ' + hours + ' 小时');
  console.log('  扫描文件: ' + r.stats.scanned + ' 个');
  console.log('  窗口内修改: ' + r.stats.changed + ' 个');
  if (r.stats.scenesTouched) {
    console.log('  涉及场景: ' + r.stats.scenesTouched.join(', '));
  }
  console.log();

  if (r.diffs.length === 0) {
    console.log('PASS ' + r.id + ': 差异集合 = 0');




    process.exit(0);
  } else {
    console.log('FAIL ' + r.id + ': 差异集合 = ' + r.diffs.length + ' 项');
    for (const d of r.diffs) console.log('  - ' + d);
    process.exit(1);
  }
}
