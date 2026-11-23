#!/usr/bin/env node
/**
 * 回滚 —— 改坏了能退回去
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1o4xg6RE9m「神经中枢控制电脑」）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [12:06] 「我的这个版本就是最新版本。我每次升级都不会遇到各种各样的问题，
 *  >   是因为我做了一个**回滚快照**。
 *  >   现在的话这个都没有用了，因为它自己踩了很多坑，
 *  >   它都知道自己更新可能会因为什么原因而拉不起来这个窗口。
 *  >   不过我还是做了一个保险的，就是这边有一个回退。」
 *  >
 *  > [12:17] 「回退的话，我是分为**界面回退**和**引擎回退**：
 *  >   界面回退很简单，就是比如说我这个场景改得有点太丑了，
 *  >   我就直接让他回到之前的一版重新改；
 *  >   引擎回退就是比如说他更新完之后，他打不开了，
 *  >   那他直接回到最近的，他就可以打开了。」
 *
 * ══════════════════════════════════════════════════════════════
 *  我们完全没有这个机制
 * ══════════════════════════════════════════════════════════════
 *
 *  现状：改了代码/配置/场景，改坏了只能靠 git 回退（如果记得提交）。
 *  但 git 是整个仓库级别的，不能「只回退某个场景」。
 *
 *  需要的是「细粒度快照 + 一键回退」：
 *    · 改之前自动存快照
 *    · 改坏了能精确回到某个快照
 *    · 分类型：界面 / 引擎 / 配置 / 记忆
 *
 * ══════════════════════════════════════════════════════════════
 *  四类快照
 * ══════════════════════════════════════════════════════════════
 *
 *  ui      界面：外壳/ui/、外壳/scenarios/*.json
 *  engine  引擎：引擎/ 的关键配置（不含 node_modules）
 *  config  配置：数据/.dsh/ 的所有配置文件
 *  memory  记忆：数据/.dsh/场景记忆/
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/回滚.mjs --snapshot --type ui           存界面快照
 *  node 工具/回滚.mjs --snapshot --type config       存配置快照
 *  node 工具/回滚.mjs --snapshot --all               存全部
 *  node 工具/回滚.mjs --list                         列出快照
 *  node 工具/回滚.mjs --rollback <id>                回退到某个快照
 *  node 工具/回滚.mjs --diff <id>                    看和快照的差异
 *  node 工具/回滚.mjs --prune --keep 10              只留最近 10 个
 *  node 工具/回滚.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ⚠ 2026-11-10 修正（实测暴露：快照 0 个文件）
//
//  和 关键资产.mjs 犯过同样的错：
//    SNAP_TYPES 里的路径都是 'workbench/...' 开头，
//    但 WB 指向 workbench 本身 → 拼出 workbench/workbench/... → 全不存在。
//
//  现在分两个：
//    WB_DIR = .../workbench      （内部目录用）
//    WB     = .../Agent自研      （路径配置用，因为都带 workbench/ 前缀）
const WB_DIR = path.resolve(HERE, '..');
const WB = path.resolve(WB_DIR, '..');
const SNAP_ROOT = path.join(WB_DIR, '数据', '.dsh', '回滚快照');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  四类快照的范围定义
// ══════════════════════════════════════════════════════════════
export const SNAP_TYPES = {
  ui: {
    name: '界面',
    desc: '外壳 UI + 场景配置',
    paths: [
      'workbench/外壳/ui',
      'workbench/外壳/scenarios',
    ],
    // 排除
    exclude: [/node_modules/, /\.log$/, /server\.log/],
  },
  engine: {
    name: '引擎',
    desc: '引擎的关键配置（不含 node_modules）',
    paths: [
      'workbench/引擎/package.json',
      'workbench/引擎/cordis.patch.yml',
      'workbench/启动.ps1',
      'workbench/启动.vbs',
      'workbench/外壳/main.js',
      'workbench/外壳/tui-bridge.cjs',
    ],
    exclude: [/node_modules/],
  },
  config: {
    name: '配置',
    desc: '数据/.dsh 的配置文件',
    paths: [
      'workbench/数据/.dsh/AGENTS.md',
      'workbench/数据/.dsh/场景路由.yaml',
      'workbench/数据/.dsh/场景层级.yaml',
      'workbench/数据/.dsh/偏好记忆',
      'workbench/数据/.dsh/成本预算.json',
      'workbench/数据/.dsh/画像',
      'workbench/数据/.dsh/场景记忆/_共享记忆',
    ],
    exclude: [/\.log$/, /派单台账\.json$/],   // 台账不纳入（会持续变）
  },
  memory: {
    name: '记忆',
    desc: '场景私有记忆',
    paths: [
      'workbench/数据/.dsh/场景记忆',
    ],
    exclude: [/_共享记忆/, /AGENTS\.local\.md$/, /影子记忆/],
  },
};

/** 单次快照最多多少文件（防止太大） */
export const MAX_FILES = 500;
/** 单文件最大字节（超过不存内容，只记 hash） */
export const MAX_FILE_BYTES = 512 * 1024;
/** 每类保留多少个快照 */
export const KEEP_PER_TYPE = 10;

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  收集要快照的文件
// ══════════════════════════════════════════════════════════════
export function collectFiles(typeKey, opts) {
  const o = opts || {};
  const root = o.root || WB;
  const cfg = SNAP_TYPES[typeKey];
  if (!cfg) return { ok: false, error: '未知快照类型: ' + typeKey };

  const files = [];

  function shouldExclude(rel) {
    return (cfg.exclude || []).some((re) => re.test(rel));
  }

  function walk(absPath, relPath) {
    if (files.length >= MAX_FILES) return;
    let st;
    try { st = fs.statSync(absPath); } catch { return; }

    if (st.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(absPath, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const childAbs = path.join(absPath, e.name);
        const childRel = relPath ? relPath + '/' + e.name : e.name;
        if (shouldExclude(childRel)) continue;
        walk(childAbs, childRel);
        if (files.length >= MAX_FILES) return;
      }
    } else if (st.isFile()) {
      if (shouldExclude(relPath)) return;
      let content = null;
      let truncated = false;
      if (st.size <= MAX_FILE_BYTES) {
        content = readTextSafe(absPath);
      } else {
        truncated = true;
      }
      const hash = crypto.createHash('sha256')
        .update(content !== null ? content : String(st.size))
        .digest('hex').slice(0, 16);
      files.push({ path: relPath, size: st.size, hash, content, truncated });
    }
  }

  for (const p of cfg.paths) {
    const abs = path.join(root, p);
    if (!fs.existsSync(abs)) continue;
    walk(abs, p);
  }

  return { ok: true, files, type: typeKey };
}

// ══════════════════════════════════════════════════════════════
//  存快照
// ══════════════════════════════════════════════════════════════
export function takeSnapshot(typeKey, opts) {
  const o = opts || {};
  const collected = collectFiles(typeKey, o);
  if (!collected.ok) return collected;

  const at = new Date(o.now || Date.now());
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = typeKey + '-' + stamp;

  const dir = path.join(o.snapRoot || SNAP_ROOT, typeKey, id);
  fs.mkdirSync(dir, { recursive: true });

  // 存文件内容
  const manifest = {
    id,
    type: typeKey,
    typeName: SNAP_TYPES[typeKey].name,
    at: at.toISOString(),
    fileCount: collected.files.length,
    totalBytes: collected.files.reduce((a, f) => a + f.size, 0),
    files: [],
  };

  for (const f of collected.files) {
    const rec = { path: f.path, size: f.size, hash: f.hash, truncated: f.truncated };
    if (f.content !== null) {
      // 内容存到同目录的 content/ 下，路径扁平化
      const flat = f.path.replace(/[\\/]/g, '__');
      const contentDir = path.join(dir, 'content');
      fs.mkdirSync(contentDir, { recursive: true });
      try {
        fs.writeFileSync(path.join(contentDir, flat), f.content, 'utf8');
        rec.contentFile = 'content/' + flat;
      } catch {
        rec.contentFile = null;
      }
    }
    manifest.files.push(rec);
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return { ok: true, id, dir, manifest };
}

export function listSnapshots(typeKey, opts) {
  const o = opts || {};
  const root = o.snapRoot || SNAP_ROOT;
  const types = typeKey ? [typeKey] : Object.keys(SNAP_TYPES);
  const out = [];

  for (const t of types) {
    const dir = path.join(root, t);
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const m = readJsonSafe(path.join(dir, d.name, 'manifest.json'));
      if (m) out.push({ ...m, _dir: path.join(dir, d.name) });
    }
  }

  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// ══════════════════════════════════════════════════════════════
//  回滚
// ══════════════════════════════════════════════════════════════
export function rollback(snapId, opts) {
  const o = opts || {};
  const root = o.root || WB;
  const snaps = listSnapshots(null, o);
  const snap = snaps.find((s) => s.id === snapId);
  if (!snap) return { ok: false, error: '找不到快照: ' + snapId };

  const restored = [];
  const failed = [];
  const missing = [];

  for (const f of snap.files) {
    if (!f.contentFile) {
      missing.push({ path: f.path, reason: f.truncated ? '文件太大未存内容' : '内容未保存' });
      continue;
    }
    const src = path.join(snap._dir, f.contentFile);
    const content = readTextSafe(src);
    if (content === null) {
      failed.push({ path: f.path, reason: '快照内容丢失' });
      continue;
    }
    const dst = path.join(root, f.path);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, content, 'utf8');
      restored.push(f.path);
    } catch (e) {
      failed.push({ path: f.path, reason: String(e.message).slice(0, 60) });
    }
  }

  return {
    ok: failed.length === 0,
    snapshot: { id: snap.id, type: snap.type, at: snap.at },
    restored,
    failed,
    missing,
    reason: '已恢复 ' + restored.length + ' 个文件' +
      (failed.length ? '，失败 ' + failed.length + ' 个' : '') +
      (missing.length ? '，跳过 ' + missing.length + ' 个' : ''),
  };
}

// ══════════════════════════════════════════════════════════════
//  差异对比
// ══════════════════════════════════════════════════════════════
export function diffSnapshot(snapId, opts) {
  const o = opts || {};
  const root = o.root || WB;
  const snaps = listSnapshots(null, o);
  const snap = snaps.find((s) => s.id === snapId);
  if (!snap) return { ok: false, error: '找不到快照: ' + snapId };

  const added = [];     // 快照之后新增的
  const changed = [];
  const removed = [];

  const snapPaths = new Set(snap.files.map((f) => f.path));

  for (const f of snap.files) {
    const abs = path.join(root, f.path);
    if (!fs.existsSync(abs)) {
      removed.push(f.path);
      continue;
    }
    const cur = readTextSafe(abs) || '';
    const h = crypto.createHash('sha256').update(cur).digest('hex').slice(0, 16);
    if (h !== f.hash) changed.push(f.path);
  }

  // 找当前新增的
  const curCollected = collectFiles(snap.type, o);
  if (curCollected.ok) {
    for (const f of curCollected.files) {
      if (!snapPaths.has(f.path)) added.push(f.path);
    }
  }

  return {
    ok: true,
    snapshot: { id: snap.id, type: snap.type, at: snap.at },
    added,
    changed,
    removed,
    summary: '新增 ' + added.length + ' / 改动 ' + changed.length + ' / 删除 ' + removed.length,
  };
}

// ══════════════════════════════════════════════════════════════
//  清理旧快照
// ══════════════════════════════════════════════════════════════
export function pruneSnapshots(keep, opts) {
  const o = opts || {};
  const root = o.snapRoot || SNAP_ROOT;
  const n = keep || KEEP_PER_TYPE;
  let removed = 0;

  for (const t of Object.keys(SNAP_TYPES)) {
    const dir = path.join(root, t);
    if (!fs.existsSync(dir)) continue;
    const dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();   // 时间戳命名，字符串排序即时间序
    if (dirs.length <= n) continue;
    for (const d of dirs.slice(0, dirs.length - n)) {
      try {
        fs.rmSync(path.join(dir, d), { recursive: true, force: true });
        removed++;
      } catch { /* ignore */ }
    }
  }

  return { ok: true, removed };
}

// ══════════════════════════════════════════════════════════════
//  真实检查（--check）
//
//  ⚠ 2026-11-12 新增。此前只有 --selftest（在 prototype/_tmp-rb 里造临时目录），
//    从来没检查过真实快照库的可用性。
//
//  为什么必须检查：回滚是**事故时才用**的东西。
//    如果它坏了，平时毫无感觉，出事时才发现救不回来 —— 是最危险的「假机制」。
//
//  判据（每次检查都真的验证可用性，而不只是看文件在不在）：
//    ① 四类快照每类至少有 1 个（没有 = 对应类型改坏了救不回来）
//    ② 每个快照的 manifest.json 可解析、fileCount 与实际 content 文件数对得上
//    ③ 抽查快照里每个文件：内容文件存在，且 sha256 与 manifest 记录一致
//       —— 不一致 = 快照已损坏，回滚会恢复出错误内容（比不恢复更糟）
//    ④ 最近一次快照不能超过 STALE_DAYS 天
//       —— 太久没存快照 = 回滚点太旧，出事时恢复要丢很多工作
// ══════════════════════════════════════════════════════════════
export const CHECK_STALE_DAYS = 14;

export function checkReal() {
  const problems = [];
  const rows = [];

  if (!fs.existsSync(SNAP_ROOT)) {
    return { ok: false, checked: 0, rows, problems: ['快照根目录不存在: ' + SNAP_ROOT] };
  }

  const now = Date.now();
  const staleMs = CHECK_STALE_DAYS * 86400000;

  for (const typeKey of Object.keys(SNAP_TYPES)) {
    const snaps = listSnapshots(typeKey);
    const label = SNAP_TYPES[typeKey].name;

    if (snaps.length === 0) {
      problems.push(label + '类：一个快照都没有（这一类改坏了救不回来）');
      rows.push({ type: label, count: 0, files: 0, badHash: 0, ageDays: null });
      continue;
    }

    // 最新一个做完整校验，其余只校验 manifest 可读
    const sorted = snaps.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const latest = sorted[sorted.length - 1];
    const ageDays = Number.isFinite(Date.parse(latest.at))
      ? Math.floor((now - Date.parse(latest.at)) / 86400000)
      : null;

    if (ageDays === null) {
      problems.push(label + '类：快照 at 无法解析 —— ' + JSON.stringify(latest.at));
    } else if (ageDays > CHECK_STALE_DAYS) {
      problems.push(label + '类：最近快照 ' + ageDays + ' 天前（超过 ' + CHECK_STALE_DAYS +
        ' 天）—— 回滚点太旧，跑 --snapshot --type ' + typeKey);
    }

    // ② manifest 与实际内容文件对账 + ③ 逐个校验 hash
    let badHash = 0;
    let missingContent = 0;
    let truncated = 0;
    const files = Array.isArray(latest.files) ? latest.files : [];
    for (const rec of files) {
      if (rec.truncated) { truncated++; continue; }   // 超过 MAX_FILE_BYTES，只记 hash
      if (!rec.contentFile) { missingContent++; continue; }
      const abs = path.join(latest._dir, rec.contentFile);
      if (!fs.existsSync(abs)) {
        missingContent++;
        continue;
      }
      let content;
      try { content = fs.readFileSync(abs, 'utf8'); } catch { missingContent++; continue; }
      const h = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
      // manifest 里的 hash 是完整 sha256（存的是完整值或前 16 位？统一按前缀比）
      if (!String(rec.hash || '').startsWith(h) && h !== rec.hash) badHash++;
    }

    if (missingContent > 0) {
      problems.push(label + '类：最新快照 ' + latest.id + ' 有 ' + missingContent +
        ' 个文件的内容文件缺失（回滚会恢复不出内容）');
    }
    if (badHash > 0) {
      problems.push(label + '类：最新快照 ' + latest.id + ' 有 ' + badHash +
        ' 个文件 hash 不符（快照已损坏，回滚会恢复出错内容）');
    }
    if (files.length === 0) {
      problems.push(label + '类：最新快照 ' + latest.id + ' 的 manifest 里没有任何文件');
    }

    rows.push({
      type: label,
      count: snaps.length,
      files: files.length,
      badHash,
      missingContent,
      truncated,
      ageDays,
    });
  }

  return { ok: problems.length === 0, checked: rows.length, rows, problems };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  回滚 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 四类定义
  chk('四类快照', Object.keys(SNAP_TYPES).length === 4, Object.keys(SNAP_TYPES).join(','));
  chk('有界面类', !!SNAP_TYPES.ui, SNAP_TYPES.ui?.desc);
  chk('有引擎类', !!SNAP_TYPES.engine, SNAP_TYPES.engine?.desc);
  chk('有配置类', !!SNAP_TYPES.config, SNAP_TYPES.config?.desc);
  chk('有记忆类', !!SNAP_TYPES.memory, SNAP_TYPES.memory?.desc);

  // 准备临时项目
  const tmp = path.join(WB, 'prototype', '_tmp-rb');
  const snapRoot = path.join(tmp, '_snaps');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'workbench', '外壳', 'ui'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'workbench', '外壳', 'scenarios'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'workbench', '外壳', 'ui', 'a.js'), 'const A = 1;\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'workbench', '外壳', 'scenarios', 's.json'), '{"id":"s"}\n', 'utf8');

  // ② 存快照
  const s1 = takeSnapshot('ui', { root: tmp, snapRoot });
  chk('能存快照', s1.ok === true, s1.id || s1.error);
  chk('快照包含文件', s1.manifest.fileCount === 2, s1.manifest.fileCount + ' 个');

  // ③ 列出快照
  const list1 = listSnapshots('ui', { snapRoot });
  chk('能列出快照', list1.length === 1, list1.length + ' 个');

  // ④ 改坏文件
  fs.writeFileSync(path.join(tmp, 'workbench', '外壳', 'ui', 'a.js'), 'BAD CODE HERE\n', 'utf8');

  // ⑤ diff 能检出改动
  const d1 = diffSnapshot(s1.id, { root: tmp, snapRoot });
  chk('diff 能检出改动', d1.changed.length === 1, d1.summary);

  // ⑥ 回滚恢复
  const r1 = rollback(s1.id, { root: tmp, snapRoot });
  chk('能回滚', r1.ok === true, r1.reason);
  const restored = readTextSafe(path.join(tmp, 'workbench', '外壳', 'ui', 'a.js'));
  chk('回滚后内容恢复', restored === 'const A = 1;\n', JSON.stringify(restored));

  // ⑦ 删除文件后回滚能恢复
  fs.unlinkSync(path.join(tmp, 'workbench', '外壳', 'scenarios', 's.json'));
  const r2 = rollback(s1.id, { root: tmp, snapRoot });
  chk('删除后回滚能恢复', fs.existsSync(path.join(tmp, 'workbench', '外壳', 'scenarios', 's.json')),
      r2.reason);

  // ⑧ 反例：不存在的快照要报错
  const r3 = rollback('no-such-snap', { root: tmp, snapRoot });
  chk('反例：快照不存在报错', r3.ok === false, r3.error);

  // ⑨ 反例：未知类型
  const c1 = collectFiles('unknown-type', { root: tmp });
  chk('反例：未知类型报错', c1.ok === false, c1.error);

  // ⑩ prune
  for (let i = 0; i < 3; i++) {
    const t = new Date(Date.now() + i * 1000).toISOString();
    takeSnapshot('ui', { root: tmp, snapRoot, now: Date.parse(t) });
  }
  const before = listSnapshots('ui', { snapRoot }).length;
  const p1 = pruneSnapshots(2, { snapRoot });
  const after = listSnapshots('ui', { snapRoot }).length;
  chk('prune 能裁剪', after <= 2, '之前 ' + before + ' → 之后 ' + after);

  // ⑪ 关键：能救回「改坏了」
  chk('关键：改坏了能救回来', r1.ok === true && restored === 'const A = 1;\n',
      '这是回滚机制存在的唯一理由');

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 真实检查 ──
  if (has('--check')) {
    const r = checkReal();
    console.log('═'.repeat(78));
    console.log('  回滚 · 真实检查（快照是否可用、是否损坏、是否太旧）');
    console.log('═'.repeat(78));
    console.log();
    console.log('  ' + '类型'.padEnd(8) + '快照数'.padEnd(8) + '最新文件数'.padEnd(12) +
      '损坏'.padEnd(6) + '缺内容'.padEnd(8) + '距今天数');
    console.log('  ' + '─'.repeat(70));
    for (const row of r.rows) {
      console.log('  ' + String(row.type).padEnd(8) +
        String(row.count).padEnd(8) +
        String(row.files).padEnd(12) +
        String(row.badHash || 0).padEnd(6) +
        String(row.missingContent || 0).padEnd(8) +
        (row.ageDays === null ? '—' : row.ageDays));
    }
    console.log('  ' + '─'.repeat(70));
    console.log('  检查了 ' + r.checked + ' 类快照');
    console.log();
    if (r.ok) {
      console.log('  ✓ 四类快照齐全、内容校验通过、回滚点新鲜');
    } else {
      console.log('  ✗ ' + r.problems.length + ' 个问题:');
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    console.log('═'.repeat(78));
    process.exit(r.ok ? 0 : 1);
  }

  // ── 存快照 ──
  if (has('--snapshot')) {
    const typeArg = val('--type');
    const types = has('--all') ? Object.keys(SNAP_TYPES) : (typeArg ? [typeArg] : Object.keys(SNAP_TYPES));

    console.log('═'.repeat(72));
    console.log('  存回滚快照');
    console.log('═'.repeat(72));
    console.log();

    for (const t of types) {
      if (!SNAP_TYPES[t]) { console.log('  ✗ 未知类型: ' + t); continue; }
      const r = takeSnapshot(t);
      if (!r.ok) { console.log('  ✗ ' + t + ': ' + r.error); continue; }
      console.log('  ✓ ' + SNAP_TYPES[t].name.padEnd(6) +
        String(r.manifest.fileCount).padStart(4) + ' 个文件  ' +
        String(Math.round(r.manifest.totalBytes / 1024)).padStart(6) + ' KB   ' + r.id);
    }

    console.log();
    console.log('─'.repeat(72));
    console.log('  位置: ' + path.relative(WB, SNAP_ROOT).replace(/\\/g, '/'));
    console.log('─'.repeat(72));
    process.exit(0);
  }

  // ── 列出 ──
  if (has('--list') || (!has('--snapshot') && !has('--rollback') && !has('--diff') && !has('--prune'))) {
    const snaps = listSnapshots();
    console.log('═'.repeat(78));
    console.log('  回滚快照（' + snaps.length + ' 个）');
    console.log('═'.repeat(78));
    console.log();
    if (snaps.length === 0) {
      console.log('  还没有快照。跑 --snapshot --all 存一份。');
    } else {
      for (const s of snaps.slice(0, 20)) {
        console.log('  ' + s.id);
        console.log('     ' + s.typeName + '  ' + s.fileCount + ' 文件  ' +
          Math.round(s.totalBytes / 1024) + ' KB  ' + s.at.slice(0, 19).replace('T', ' '));
      }
      if (snaps.length > 20) console.log('  …还有 ' + (snaps.length - 20) + ' 个');
    }
    console.log();
    console.log('─'.repeat(78));
    console.log('  回退: node 工具/回滚.mjs --rollback <id>');
    console.log('  对比: node 工具/回滚.mjs --diff <id>');
    console.log('─'.repeat(78));
    process.exit(0);
  }

  // ── 回滚 ──
  if (has('--rollback')) {
    const id = val('--rollback');
    const r = rollback(id);
    if (!r.ok && r.error) { console.error('✗ ' + r.error); process.exit(2); }

    console.log('═'.repeat(72));
    console.log('  回滚');
    console.log('═'.repeat(72));
    console.log();
    console.log('  快照: ' + r.snapshot.id + '（' + r.snapshot.at + '）');
    console.log();
    for (const p of r.restored.slice(0, 20)) console.log('  ✓ ' + p);
    if (r.restored.length > 20) console.log('  …还有 ' + (r.restored.length - 20) + ' 个');
    for (const f of r.failed) console.log('  ✗ ' + f.path + '  ' + f.reason);
    for (const m of r.missing) console.log('  ○ ' + m.path + '  ' + m.reason);
    console.log();
    console.log('─'.repeat(72));
    console.log('  ' + r.reason);
    console.log('─'.repeat(72));
    process.exit(r.ok ? 0 : 1);
  }

  // ── 对比 ──
  if (has('--diff')) {
    const id = val('--diff');
    const r = diffSnapshot(id);
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }

    console.log('═'.repeat(72));
    console.log('  与快照的差异');
    console.log('═'.repeat(72));
    console.log();
    console.log('  快照: ' + r.snapshot.id + '（' + r.snapshot.at + '）');
    console.log('  ' + r.summary);
    console.log();
    if (r.changed.length) {
      console.log('  改动:');
      for (const p of r.changed.slice(0, 15)) console.log('    ~ ' + p);
      if (r.changed.length > 15) console.log('    …还有 ' + (r.changed.length - 15) + ' 个');
    }
    if (r.added.length) {
      console.log('  新增:');
      for (const p of r.added.slice(0, 15)) console.log('    + ' + p);
      if (r.added.length > 15) console.log('    …还有 ' + (r.added.length - 15) + ' 个');
    }
    if (r.removed.length) {
      console.log('  删除:');
      for (const p of r.removed.slice(0, 15)) console.log('    - ' + p);
      if (r.removed.length > 15) console.log('    …还有 ' + (r.removed.length - 15) + ' 个');
    }
    process.exit(0);
  }

  // ── 清理 ──
  if (has('--prune')) {
    const keep = Number(val('--keep')) || KEEP_PER_TYPE;
    const r = pruneSnapshots(keep);
    console.log('✓ 已清理 ' + r.removed + ' 个旧快照（每类保留 ' + keep + ' 个）');
    process.exit(0);
  }
}
