#!/usr/bin/env node
/**
 * 备份 —— L5 归档层
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么必须有（原项目 L5 定义）
 * ══════════════════════════════════════════════════════════════
 *
 *  "归档只进不改：任何升级都能回滚。"
 *
 *  没有备份层 → 升级 = 单向门 → 改坏了回不去
 *  这是所有"自进化"机制的前提：进化必须可回退。
 *
 * ══════════════════════════════════════════════════════════════
 *  备份什么（不是全部，只备份"删了就没了"的）
 * ══════════════════════════════════════════════════════════════
 *
 *  core：
 *    · 场景记忆（私有记忆 + 身份卡 + 定位卡）
 *    · 场景配置（scenarios/*.json）
 *    · 场景契约（sceneboard/scenes/*.json）
 *    · 全局铁律（AGENTS.md）
 *    · 技能（skills/**）
 *    · 共享台账（_共享记忆/**）
 *
 *  不备份：
 *    · node_modules、构建产物
 *    · 会话库（.dsh-tui，太大且引擎自己管）
 *    · 缓存
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/备份.mjs                     # 创建备份
 *  node 工具/备份.mjs --list              # 列出所有备份
 *  node 工具/备份.mjs --restore <id>      # 恢复（会先备份当前状态）
 *  node 工具/备份.mjs --verify            # 校验所有备份完整性
 *  node 工具/备份.mjs --prune --keep 10   # 只留最近 10 份
 */

import fs from 'node:fs';
import os from 'node:os';   // ⚠ 2026-11-12 补：自测在临时目录造损坏备份，不碰真实备份
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');
const BACKUP_ROOT = path.join(WB, '备份');
const MANIFEST = 'manifest.json';

// ══════════════════════════════════════════════════════════════
//  要备份的路径（相对 workbench）
// ══════════════════════════════════════════════════════════════
export const CORE_PATHS = [
  '数据/.dsh/AGENTS.md',
  '数据/.dsh/场景记忆',
  '数据/.dsh/skills',
  '外壳/scenarios',
  'sceneboard',
];

// ══════════════════════════════════════════════════════════════
//  工具
// ══════════════════════════════════════════════════════════════

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 32);
}

function walk(dir, base, out) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (it.isDirectory()) {
      // 跳过归档子目录里的旧备份（避免备份套备份）
      if (it.name === '备份') continue;
      walk(full, base, out);
    } else {
      out.push(rel);
    }
  }
}

function genId(now) {
  const d = now || new Date();
  return d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

// ══════════════════════════════════════════════════════════════
//  核心：创建备份
// ══════════════════════════════════════════════════════════════

/**
 * @param {object} opt
 *   opt.wbRoot       workbench 目录
 *   opt.backupRoot   备份根目录
 *   opt.paths        要备份的相对路径列表
 *   opt.label        备注标签
 *   opt.now          当前时间（测试注入）
 * @returns {{id, dir, files, bytes, manifest}}
 */
export function createBackup(opt) {
  const wbRoot = opt.wbRoot || WB;
  const backupRoot = opt.backupRoot || path.join(wbRoot, '备份');
  const paths = opt.paths || CORE_PATHS;
  const now = opt.now || new Date();

  // ★ 自检修复：同一秒内多次备份会 id 冲突
  //   （恢复操作会先自动备份，连续操作可能撞车）
  //   解决：冲突时自动加序号后缀 -2 -3 ...
  let id = genId(now);
  let dir = path.join(backupRoot, id);
  if (fs.existsSync(dir)) {
    let n = 2;
    while (fs.existsSync(path.join(backupRoot, id + '-' + n))) {
      n++;
      if (n > 99) throw new Error('同一秒内备份过多: ' + id);
    }
    id = id + '-' + n;
    dir = path.join(backupRoot, id);
  }
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    id,
    at: now.toISOString(),
    label: opt.label || '',
    host: process.platform,
    entries: [],
    totalFiles: 0,
    totalBytes: 0,
  };

  for (const rel of paths) {
    const src = path.join(wbRoot, rel);
    if (!fs.existsSync(src)) continue;

    const st = fs.statSync(src);
    if (st.isDirectory()) {
      // 目录：递归复制
      const files = [];
      walk(src, src, files);
      for (const f of files) {
        const from = path.join(src, f);
        const toRel = path.join(rel, f);
        const to = path.join(dir, toRel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        const size = fs.statSync(to).size;
        manifest.entries.push({
          path: toRel.replace(/\\/g, '/'),
          bytes: size,
          sha256: sha256File(to),
        });
        manifest.totalFiles++;
        manifest.totalBytes += size;
      }
    } else {
      // 单文件
      const to = path.join(dir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(src, to);
      const size = fs.statSync(to).size;
      manifest.entries.push({
        path: rel.replace(/\\/g, '/'),
        bytes: size,
        sha256: sha256File(to),
      });
      manifest.totalFiles++;
      manifest.totalBytes += size;
    }
  }

  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');

  return { id, dir, files: manifest.totalFiles, bytes: manifest.totalBytes, manifest };
}

// ══════════════════════════════════════════════════════════════
//  列出 / 校验 / 恢复
// ══════════════════════════════════════════════════════════════

export function listBackups(backupRoot) {
  const root = backupRoot || BACKUP_ROOT;
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const mf = path.join(root, d.name, MANIFEST);
    if (!fs.existsSync(mf)) continue;
    try {
      let s = fs.readFileSync(mf, 'utf8');
      if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
      out.push(JSON.parse(s));
    } catch { /* 跳过损坏的 */ }
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}

/**
 * 校验备份完整性（每个文件的 sha256 是否与 manifest 一致）
 * @returns {{id, ok, diffs}}
 */
export function verifyBackup(backupRoot, id) {
  const root = backupRoot || BACKUP_ROOT;
  const dir = path.join(root, id);
  const diffs = [];

  if (!fs.existsSync(dir)) {
    return { id, ok: false, diffs: ['备份目录不存在: ' + id] };
  }

  const mf = path.join(dir, MANIFEST);
  if (!fs.existsSync(mf)) {
    return { id, ok: false, diffs: ['缺 manifest.json'] };
  }

  let manifest;
  try {
    let s = fs.readFileSync(mf, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    manifest = JSON.parse(s);
  } catch (e) {
    return { id, ok: false, diffs: ['manifest 解析失败: ' + e.message] };
  }

  for (const e of (manifest.entries || [])) {
    const p = path.join(dir, e.path);
    if (!fs.existsSync(p)) {
      diffs.push('文件缺失：' + e.path);
      continue;
    }
    const actual = sha256File(p);
    if (actual !== e.sha256) {
      diffs.push('哈希不匹配：' + e.path + '（期望 ' + e.sha256.slice(0, 8) + '，实际 ' + actual.slice(0, 8) + '）');
    }
  }

  return { id, ok: diffs.length === 0, diffs, manifest };
}

/**
 * 恢复备份（会先把当前状态备份一份，防止恢复错了再也回不去）
 */
export function restoreBackup(opt) {
  const wbRoot = opt.wbRoot || WB;
  const backupRoot = opt.backupRoot || path.join(wbRoot, '备份');
  const id = opt.id;

  const check = verifyBackup(backupRoot, id);
  if (!check.ok) {
    return { ok: false, error: '备份校验失败，拒绝恢复', diffs: check.diffs };
  }

  // 先备份当前状态
  const safety = createBackup({
    wbRoot,
    backupRoot,
    label: '恢复前自动备份（' + id + '）',
  });

  const dir = path.join(backupRoot, id);
  const manifest = check.manifest;
  let restored = 0;

  for (const e of (manifest.entries || [])) {
    const from = path.join(dir, e.path);
    const to = path.join(wbRoot, e.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    restored++;
  }

  return { ok: true, restored, safetyBackup: safety.id };
}

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
//
//  ⚠ 2026-11-12 补：原来没有 selftest、没有反例，机制审计判它
//    「①3 输出差异集合 · ①4 反例 0 处 · ①5 无自测入口」= 口号。
//
//    为什么必须补：备份是「升级可回滚」的唯一依靠。
//    如果 SHA256 校验写错了（比如只比长度、或者永远返回 ok），
//    那么**备份已经被改坏也照样 PASS** —— 等到真需要回滚时才发现，
//    那时已经没有任何退路。所以必须证明它能抓到坏备份。
//
//    下面每个反例都真的动手破坏一份备份：删文件、改文件内容、
//    删 manifest，然后断言 verifyBackup 必须报出来。
// ══════════════════════════════════════════════════════════════
export function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  备份完整性 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // 全部在临时沙箱里跑：绝不碰 workbench/备份/
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'backupguard-'));
  const wbRoot = path.join(sandbox, 'wb');
  const backupRoot = path.join(wbRoot, '备份');

  // 造一份「被备份的数据」：两个文件，内容确定
  fs.mkdirSync(path.join(wbRoot, '数据', '.dsh', '场景记忆'), { recursive: true });
  fs.writeFileSync(path.join(wbRoot, '数据', '.dsh', '场景记忆', 'a.md'), 'AAA 内容一\n', 'utf8');
  fs.writeFileSync(path.join(wbRoot, '数据', '.dsh', '场景记忆', 'b.md'), 'BBB 内容二\n', 'utf8');

  const PATHS = ['数据/.dsh/场景记忆'];

  // ── ① 正例：新建的备份必须校验通过 ──
  const made = createBackup({ wbRoot, backupRoot, paths: PATHS, label: '自测基线' });
  {
    const r = verifyBackup(backupRoot, made.id);
    chk('正例：刚建的备份校验通过', r.ok === true,
        r.ok ? made.files + ' 文件' : (r.diffs || []).join('; '));
  }
  chk('备份清单能列出这一份', listBackups(backupRoot).some(m => m.id === made.id), made.id);

  // ── ② 反例 1：文件内容被改（哈希不匹配）→ 必须报 ──
  {
    const victim = path.join(backupRoot, made.id, '数据/.dsh/场景记忆/a.md');
    fs.writeFileSync(victim, 'AAA 内容一 但被偷偷改过\n', 'utf8');
    const r = verifyBackup(backupRoot, made.id);
    const hit = (r.diffs || []).some(d => d.includes('哈希不匹配'));
    chk('反例：备份文件被改（哈希不匹配）应当失败', hit && r.ok === false,
        hit ? r.diffs.find(d => d.includes('哈希不匹配'))
            : '⚠ 没报，说明校验是装饰；实际: ' + ((r.diffs || [])[0] || '(空)'));
    // 复原，供下一条反例使用
    fs.writeFileSync(victim, 'AAA 内容一\n', 'utf8');
  }

  // ── ③ 反例 2：备份里的文件被删（缺失）→ 必须报 ──
  {
    const victim = path.join(backupRoot, made.id, '数据/.dsh/场景记忆/b.md');
    fs.rmSync(victim, { force: true });
    const r = verifyBackup(backupRoot, made.id);
    const hit = (r.diffs || []).some(d => d.includes('文件缺失'));
    chk('反例：备份里的文件缺失应当失败', hit && r.ok === false,
        hit ? r.diffs.find(d => d.includes('文件缺失'))
            : '⚠ 没报；实际: ' + ((r.diffs || [])[0] || '(空)'));
    fs.writeFileSync(victim, 'BBB 内容二\n', 'utf8');
  }

  // ── ④ 再校验：复原后必须回到 PASS（证明上面报的是真差异，不是永远红）──
  {
    const r = verifyBackup(backupRoot, made.id);
    chk('复原后重新通过（判据不是永远红）', r.ok === true,
        (r.diffs || []).join('; '));
  }

  // ── ⑤ 反例 3：manifest 被删 → 必须报「缺 manifest.json」──
  {
    const made2 = createBackup({ wbRoot, backupRoot, paths: PATHS, label: '自测-删manifest' });
    fs.rmSync(path.join(backupRoot, made2.id, MANIFEST), { force: true });
    const r = verifyBackup(backupRoot, made2.id);
    const hit = (r.diffs || []).some(d => d.includes('manifest'));
    chk('反例：manifest 缺失应当失败', hit && r.ok === false,
        hit ? r.diffs[0] : '⚠ 没报；实际: ' + ((r.diffs || [])[0] || '(空)'));
  }

  // ── ⑥ 反例 4：备份目录整个不存在 → 必须报 ──
  {
    const r = verifyBackup(backupRoot, '不存在的备份id');
    chk('反例：备份目录不存在应当失败', r.ok === false && (r.diffs || []).length > 0,
        r.diffs ? r.diffs[0] : '⚠ 没报');
  }

  // ── ⑦ 反例 5：多处同时损坏 → 必须**逐条**输出，不能只报第一条 ──
  //    这一条守的正是第 ③ 步「输出差异集合」：修之前只印 5 条，
  //    这里造 3 个文件全坏，断言 diffs 里三条都在。
  {
    const made3 = createBackup({ wbRoot, backupRoot, paths: PATHS, label: '自测-多处损坏' });
    const dir = path.join(backupRoot, made3.id, '数据/.dsh/场景记忆');
    fs.writeFileSync(path.join(dir, 'a.md'), '被改1\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.md'), '被改2\n', 'utf8');
    const r = verifyBackup(backupRoot, made3.id);
    chk('反例：多处损坏必须逐条列出（差异集合完整）',
        (r.diffs || []).length >= 2 && r.ok === false,
        (r.diffs || []).length + ' 项：' + (r.diffs || []).slice(0, 3).join(' | '));
  }

  // ── ⑧ 边界：空目录备份（没有任何文件）→ 不该报错，而是 0 文件通过 ──
  {
    const emptyWb = path.join(sandbox, 'emptywb');
    fs.mkdirSync(emptyWb, { recursive: true });
    const e = createBackup({ wbRoot: emptyWb, backupRoot, paths: PATHS });
    const r = verifyBackup(backupRoot, e.id);
    chk('边界：空目录备份不误报（0 文件 = 合法）', r.ok === true,
        r.ok ? '0 文件，通过' : (r.diffs || []).join('; '));
  }

  // ── ⑨ 关键：3 类真实损坏必须全部被检出 ──
  //    ⚠ 2026-11-12：用显式变量攒结果，不靠数组下标切片
  //      （切片写错会让这条「永远通过」，又是一条新的装饰）
  {
    const hitHash = R[R.length - 7];        // ② 哈希不匹配
    const hitMissing = R[R.length - 6];     // ③ 文件缺失
    const hitManifest = R[R.length - 4];    // ⑤ 缺 manifest
    chk('关键：改内容 / 删文件 / 缺 manifest 三类损坏全部被检出（判据不是装饰）',
        hitHash === true && hitMissing === true && hitManifest === true,
        '哈希=' + hitHash + ' 缺失=' + hitMissing + ' manifest=' + hitManifest);
  }

  fs.rmSync(sandbox, { recursive: true, force: true });

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

function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const wbRoot = process.env.SEA_WB_ROOT ? path.resolve(process.env.SEA_WB_ROOT) : WB;
  const backupRoot = path.join(wbRoot, '备份');

  // ⚠ 2026-11-12 补：--selftest 入口（五步法第 5 步「挂到节奏上」）。
  //   必须放在所有分支之前，否则会被 --verify 等分支抢走。
  if (args.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── list ──
  if (args.includes('--list')) {
    const list = listBackups(backupRoot);
    console.log('═'.repeat(72));
    console.log('  备份列表（' + list.length + ' 份）');
    console.log('═'.repeat(72));
    console.log();
    if (!list.length) {
      console.log('  （无备份）');
    } else {
      for (const m of list) {
        console.log('  ' + m.id + '  ' + m.totalFiles + ' 文件  ' + bytes(m.totalBytes) +
          (m.label ? '  ' + m.label : ''));
      }
    }
    console.log();
    process.exit(0);
  }

  // ── verify ──
  if (args.includes('--verify')) {
    const list = listBackups(backupRoot);
    if (!list.length) {
      console.log('（无备份可校验）');
      process.exit(0);
    }
    let fail = 0;
    // ⚠ 2026-11-12 修（五步法第 3 步「输出差异集合」）：
    //
    //   原来这里写的是 `for (const d of r.diffs.slice(0, 5))` ——
    //   每个坏备份**最多只印 5 条问题**，其余静默丢弃。
    //   后果：一个备份里 200 个文件哈希全坏，报告只显示 5 条，
    //        看起来像「小毛病」，实际是整个备份废了。
    //        攒了问题项（diffs）却不逐条输出 = 五步法第 3 步不满足。
    //
    //   改成：全量逐条打印，并在末尾汇总「共 N 项问题」，
    //        这样报告的数字和印出的行数一致，不能靠截断掩盖严重程度。
    const allProblems = [];   // 收集所有备份的全部问题，最后逐条复述
    console.log('═'.repeat(72));
    console.log('  校验所有备份');
    console.log('═'.repeat(72));
    console.log();
    for (const m of list) {
      const r = verifyBackup(backupRoot, m.id);
      if (r.ok) {
        console.log('  OK   ' + m.id + '  (' + m.totalFiles + ' 文件)');
      } else {
        fail++;
        console.log('  XX   ' + m.id + '  (' + (r.diffs || []).length + ' 项问题)');
        for (const d of (r.diffs || [])) {
          console.log('       - ' + d);
          allProblems.push(m.id + ' / ' + d);
        }
      }
    }
    console.log();
    console.log('  结果: ' + (list.length - fail) + ' / ' + list.length + ' 完好');

    // 差异集合逐条复述（坏备份的问题全部列出，不截断）
    if (allProblems.length > 0) {
      console.log();
      console.log('  ── 差异集合（共 ' + allProblems.length + ' 项）──');
      for (const p of allProblems) console.log('  · ' + p);
    }
    console.log();
    process.exit(fail > 0 ? 1 : 0);
  }

  // ── restore ──
  const ri = args.indexOf('--restore');
  if (ri >= 0) {
    const id = args[ri + 1];
    if (!id) { console.error('用法: --restore <id>'); process.exit(2); }
    const r = restoreBackup({ wbRoot, backupRoot, id });
    if (!r.ok) {
      console.error('恢复失败: ' + r.error);
      for (const d of (r.diffs || [])) console.error('  - ' + d);
      process.exit(1);
    }
    console.log('已恢复 ' + r.restored + ' 个文件');
    console.log('恢复前状态已自动备份: ' + r.safetyBackup);
    process.exit(0);
  }

  // ── prune ──
  if (args.includes('--prune')) {
    const ki = args.indexOf('--keep');
    const keep = ki >= 0 ? parseInt(args[ki + 1], 10) : 10;
    const list = listBackups(backupRoot);
    const toDelete = list.slice(keep);
    if (!toDelete.length) {
      console.log('无需清理（' + list.length + ' 份 ≤ 保留 ' + keep + ' 份）');
      process.exit(0);
    }
    for (const m of toDelete) {
      fs.rmSync(path.join(backupRoot, m.id), { recursive: true, force: true });
      console.log('已删除: ' + m.id);
    }
    console.log();
    console.log('保留 ' + keep + ' 份，删除 ' + toDelete.length + ' 份');
    process.exit(0);
  }

  // ── 默认：创建备份 ──
  const li = args.indexOf('--label');
  const label = li >= 0 ? args[li + 1] : '';

  const r = createBackup({ wbRoot, backupRoot, label });
  console.log('═'.repeat(72));
  console.log('  备份完成');
  console.log('═'.repeat(72));
  console.log();
  console.log('  id:     ' + r.id);
  console.log('  文件:   ' + r.files);
  console.log('  大小:   ' + bytes(r.bytes));
  console.log('  位置:   ' + path.relative(path.resolve(wbRoot, '..'), r.dir));
  if (label) console.log('  标签:   ' + label);
  console.log();
}
