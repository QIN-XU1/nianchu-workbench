#!/usr/bin/env node
// 工具/破坏性验证备份.mjs —— 给破坏性验证加一层「跑前快照」保险
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要（实测数据）
// ══════════════════════════════════════════════════════════════════════
//  实测：破坏性验证跑一次会**改动 20 多个真实文件**：
//
//    外壳/scenarios/arch-review.json          ← 界面配置
//    外壳/ui/panels/main-agent.js             ← UI 代码
//    工具/中枢代写.mjs / 派单.mjs / 硬规矩.mjs / 负载闸.mjs
//    数据/.dsh/skills/research/SKILL.md        ← 技能
//    数据/.dsh/产物契约.json                   ← 契约
//    数据/.dsh/偏好记忆/偏好.yaml
//    数据/.dsh/场景互问/问答.json
//    数据/.dsh/场景层级.yaml
//    数据/.dsh/场景记忆/**（多处）
//
//  它有 20 多处 unlinkSync / renameSync / writeFileSync，
// 靠 break() 返回的 restore 恢复。**如果进程在任何一处被 kill，
//  数据就可能永久丢失** —— 已经踩过三次（虚构经验残留、台账残单、判据被改坏）。
//
//  修法：跑破坏性验证前，先把受影响的文件快照一份到
//  `数据/.dsh/破坏性验证快照/<时间戳>/`，跑完对比并自动恢复不一致的。
//
//  用法：
//    node 工具/破坏性验证备份.mjs --snapshot    # 跑前拍快照
//    node 工具/破坏性验证备份.mjs --restore     # 跑后对比并恢复
//    node 工具/破坏性验证备份.mjs --status      # 看有没有未清理的快照
//    node 工具/破坏性验证备份.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// ⚠ 同一判据只存一处：结构化对比的规则从 破坏性验证 复用
import { STRUCTURED_COMPARE, diffJsonIgnoringTimestamps } from './破坏性验证.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const SNAP_ROOT = path.join(DATA, '破坏性验证快照');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 破坏性验证会碰的路径（相对 DATA 或 WB）
 *
 * ⚠ 这份清单必须与 破坏性验证.mjs 的 CASES 保持同步。
 *   漏一个文件 = 漏一层保险。
 */
export const WATCHED = [
  // ── 工具源码（会被 break() 改写判据）──
  { root: 'WB', rel: '工具/派单.mjs' },
  { root: 'WB', rel: '工具/负载闸.mjs' },
  { root: 'WB', rel: '工具/硬规矩.mjs' },
  { root: 'WB', rel: '工具/中枢代写.mjs' },
  { root: 'WB', rel: '工具/机制体检.mjs' },
  // ── UI 代码与场景配置 ──
  { root: 'WB', rel: '外壳/ui/panels/main-agent.js' },
  { root: 'WB', rel: '外壳/scenarios/arch-review.json' },
  { root: 'WB', rel: '外壳/scenarios/hub.json' },
  // ── 技能 ──
  { root: 'DATA', rel: 'skills/research/SKILL.md' },
  // ── 契约与配置 ──
  { root: 'DATA', rel: '产物契约.json' },
  { root: 'DATA', rel: '场景层级.yaml' },
  { root: 'DATA', rel: '偏好记忆/偏好.yaml' },
  // ── 共享台账 ──
  { root: 'DATA', rel: '场景记忆/_共享记忆/派单台账.json' },
  { root: 'DATA', rel: '场景记忆/_共享记忆/健康度.json' },
  { root: 'DATA', rel: '场景记忆/_共享记忆/进化台账.json' },
  { root: 'DATA', rel: '场景记忆/_共享记忆/身份索引.json' },
  { root: 'DATA', rel: '场景记忆/_共享记忆/_跨场景通知.md' },
  // ⚠ 2026-11-13 加：文件索引（破坏性验证会 unlinkSync 它，之前没监视 → 丢了不恢复）
  //
  //   实测事故：破坏性验证的「文件索引写入」用例会删掉
  //     数据/.dsh/场景记忆/调研/_文件索引.md
  //   靠 break() 返回的 restore 恢复。但：
  //     · 进程被中断 → restore 不跑 → 索引永久丢失
  //     · 而 文档体检 立刻报「漏登记」→ 机制体检红
  //
  //   这就是「改别人的文件却没进快照」的漏洞：
  //   快照本该覆盖**所有会被改的文件**，漏一个就是隐患。
  { root: 'DATA', rel: '场景记忆/调研/_文件索引.md' },
  { root: 'DATA', rel: '场景记忆/架构梳理/_文件索引.md' },
  // ── 场景互问 ──
  { root: 'DATA', rel: '场景互问/问答.json' },
  // ── 中枢卡片 ──
  { root: 'DATA', rel: '场景注入/hub/AGENTS.local.md' },
  { root: 'DATA', rel: '场景记忆/中枢/AGENTS.local.md' },
  // ── 会被追加内容的记忆 ──
  { root: 'DATA', rel: '场景记忆/架构梳理/身份卡.md' },
  { root: 'DATA', rel: '场景记忆/架构梳理/场景私有记忆.md' },
  { root: 'DATA', rel: '场景记忆/调研/场景私有记忆.md' },
  { root: 'DATA', rel: '场景记忆/调研/身份卡.md' },
  { root: 'DATA', rel: '场景记忆/调研/AGENTS.local.md' },
];

function resolvePath(w) {
  return w.root === 'WB' ? path.join(WB, w.rel) : path.join(DATA, w.rel);
}

function snapName() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function latestSnap() {
  if (!fs.existsSync(SNAP_ROOT)) return null;
  const dirs = fs.readdirSync(SNAP_ROOT).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
  return dirs.length ? path.join(SNAP_ROOT, dirs[dirs.length - 1]) : null;
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  破坏性验证备份 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】监视清单');
  {
    chk('监视文件数 >= 20', WATCHED.length >= 20, String(WATCHED.length));
    chk('清单里没有重复', new Set(WATCHED.map((w) => w.root + ':' + w.rel)).size === WATCHED.length);
    // 至少覆盖工具源码、UI代码、契约、台账四类
    const kinds = {
      工具: WATCHED.some((w) => w.rel.startsWith('工具/')),
      UI: WATCHED.some((w) => w.rel.includes('外壳/')),
      契约: WATCHED.some((w) => w.rel.includes('产物契约')),
      台账: WATCHED.some((w) => w.rel.includes('派单台账')),
    };
    for (const [k, v] of Object.entries(kinds)) {
      chk('覆盖 ' + k, v);
    }
  }

  console.log();
  console.log('【二】快照 / 恢复闭环');
  {
    // 用真实文件做一次快照-改动-恢复
    const target = path.join(WB, '工具', '负载闸.mjs');
    if (!fs.existsSync(target)) {
      chk('目标文件存在', false, target);
    } else {
      const origBuf = fs.readFileSync(target);
      const snapDir = path.join(SNAP_ROOT, '_selftest_' + Date.now());

      // 手工快照
      fs.mkdirSync(snapDir, { recursive: true });
      const rel = 'WB:工具/负载闸.mjs';
      fs.writeFileSync(path.join(snapDir, rel.replace(/[:/\\]/g, '_')), origBuf);
      chk('能写快照', fs.existsSync(path.join(snapDir, rel.replace(/[:/\\]/g, '_'))));

      // 改动
      fs.appendFileSync(target, '\n// selftest 改动\n', 'utf8');
      const changedBuf = fs.readFileSync(target);
      chk('反例：改动后内容确实不同', !changedBuf.equals(origBuf));

      // 恢复
      fs.writeFileSync(target, origBuf);
      const restored = fs.readFileSync(target);
      chk('能恢复原样', restored.equals(origBuf), restored.equals(origBuf) ? '逐字节一致' : '不一致');

      // 清理
      try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch { /* ignore */ }
      chk('能清理快照目录', !fs.existsSync(snapDir));
    }
  }

  console.log();
  console.log('【三】反例：清单必须包含会被改写的源文件');
  {
    // 这几个是 break() 明确会改的，漏一个就等于漏一层保险
    const MUST = ['工具/派单.mjs', '工具/负载闸.mjs', '工具/硬规矩.mjs', '工具/中枢代写.mjs'];
    const missing = MUST.filter((m) => !WATCHED.some((w) => w.rel === m));
    chk('反例：4 个会被改写的工具都在清单里', missing.length === 0,
        missing.length ? '漏了: ' + missing.join(', ') : '齐全');
  }

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
}

/** 最多保留几个快照（每个约 0.26MB） */
export const MAX_SNAPSHOTS = 5;

/**
 * 轮转：只保留最近 MAX_SNAPSHOTS 个快照
 * @returns {string[]} 被删掉的快照名
 */
export function rotateSnapshots() {
  if (!fs.existsSync(SNAP_ROOT)) return [];
  const dirs = fs.readdirSync(SNAP_ROOT).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
  const removed = [];
  while (dirs.length > MAX_SNAPSHOTS) {
    const old = dirs.shift();
    try {
      fs.rmSync(path.join(SNAP_ROOT, old), { recursive: true, force: true });
      removed.push(old);
    } catch { /* ignore */ }
  }
  return removed;
}

// ══════════════════════════════════════════════════════════════════════
function doSnapshot() {
  const name = snapName();
  const dir = path.join(SNAP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = { at: new Date().toISOString(), files: [] };
  for (const w of WATCHED) {
    const p = resolvePath(w);
    const key = (w.root + ':' + w.rel).replace(/[:/\\]/g, '_');
    if (!fs.existsSync(p)) {
      manifest.files.push({ root: w.root, rel: w.rel, missing: true });
      continue;
    }
    const buf = fs.readFileSync(p);
    fs.writeFileSync(path.join(dir, key), buf);
    manifest.files.push({
      root: w.root,
      rel: w.rel,
      key,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const ok = manifest.files.filter((f) => !f.missing).length;
  console.log('  ✓ 已快照 ' + ok + ' / ' + WATCHED.length + ' 个文件');
  console.log('    位置: ' + path.relative(WB, dir));

  // ⚠ 2026-11-12 加：轮转，防止快照无限增长
  //   实测每个快照约 0.26MB、25 个文件；不轮转的话跑 100 次就 26MB。
  const removed = rotateSnapshots();
  if (removed.length) {
    console.log('    轮转：删掉旧快照 ' + removed.length + ' 个（保留最近 ' + MAX_SNAPSHOTS + ' 个）');
  }
  return dir;
}

function doRestore() {
  const dir = latestSnap();
  if (!dir) {
    console.log('  ✗ 没有找到快照');
    process.exitCode = 2;
    return;
  }
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  console.log('  快照: ' + path.basename(dir) + '（' + mf.files.length + ' 个文件）');
  console.log();

  const changed = [];
  const restored = [];
  for (const f of mf.files) {
    if (f.missing) continue;
    const p = resolvePath(f);
    const snapFile = path.join(dir, f.key);

    // 当前状态
    let curHash = null;
    if (fs.existsSync(p)) {
      curHash = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }

    // ⚠ 2026-11-12 修：台账/健康度这类文件用结构化对比（忽略时间戳）
    //
    //   逐字节 hash 会把「时间戳被重写」当成内容变化，每次跑都报假不一致。
    //   实测：派单台账的 ackedAt、健康度的 window.from/to 每次都会被重算，
    //        但数据内容完全一致。
    const isStructured = STRUCTURED_COMPARE.some((re) => re.test(f.rel));
    if (isStructured && fs.existsSync(p) && fs.existsSync(snapFile)) {
      const diffs = diffJsonIgnoringTimestamps(
        fs.readFileSync(snapFile, 'utf8'), fs.readFileSync(p, 'utf8'));
      if (!diffs.length) continue;   // 内容一致（只有时间戳变了）
      changed.push(f.rel + '（内容差异 ' + diffs.length + ' 处）');
      if (has('apply')) {
        fs.writeFileSync(p, fs.readFileSync(snapFile));
        restored.push(f.rel);
      }
      continue;
    }

    if (curHash === f.sha256) continue;   // 没变
    changed.push(f.rel);

    // 自动恢复（只在文件确实变了时）
    if (has('apply')) {
      if (fs.existsSync(snapFile)) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, fs.readFileSync(snapFile));
        restored.push(f.rel);
      }
    }
  }

  if (!changed.length) {
    console.log('  ✓ 所有监视文件与快照一致（破坏性验证的 restore 是干净的）');
    return;
  }

  console.log('  ⚠ 有 ' + changed.length + ' 个文件与快照不一致:');
  for (const c of changed) console.log('     · ' + c);
  console.log();
  if (has('apply')) {
    console.log('  ✓ 已恢复 ' + restored.length + ' 个文件');
    // 恢复后复查
    let stillBad = 0;
    for (const f of mf.files) {
      if (f.missing) continue;
      const p = resolvePath(f);
      const h = fs.existsSync(p)
        ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
      if (h !== f.sha256) stillBad++;
    }
    if (stillBad) {
      console.log('  XX 恢复后仍有 ' + stillBad + ' 个不一致');
      process.exitCode = 1;
    } else {
      console.log('  ✓ 恢复后全部一致');
    }
  } else {
    console.log('  恢复：node 工具/破坏性验证备份.mjs --restore --apply');
    process.exitCode = 1;
  }
}

function doStatus() {
  if (!fs.existsSync(SNAP_ROOT)) {
    console.log('  ○ 还没有快照');
    return;
  }
  const dirs = fs.readdirSync(SNAP_ROOT).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
  console.log('  快照数: ' + dirs.length);
  for (const d of dirs) {
    const mf = path.join(SNAP_ROOT, d, 'manifest.json');
    if (!fs.existsSync(mf)) { console.log('    ' + d + '  (缺 manifest)'); continue; }
    const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
    console.log('    ' + d + '  ' + j.files.length + ' 个文件');
  }
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  console.log('='.repeat(78));
  console.log('  破坏性验证备份 —— 跑前快照，跑后对比');
  console.log('='.repeat(78));
  console.log();
  console.log('  监视 ' + WATCHED.length + ' 个会被破坏性验证改动的文件');
  console.log();

  if (has('snapshot')) { doSnapshot(); return; }
  if (has('restore')) { doRestore(); return; }
  if (has('status')) { doStatus(); return; }

  console.log('  用法:');
  console.log('    --snapshot   跑破坏性验证前拍快照');
  console.log('    --restore    跑后对比（加 --apply 自动恢复不一致的）');
  console.log('    --status     看有多少快照');
  console.log('    --selftest');
}

main();
