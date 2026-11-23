#!/usr/bin/env node
/**
 * 技能安装器 —— A12 技能/插件生态的「安装 / 卸载」层
 *
 * ══ 为什么需要这个（第 121 轮）═════════════════════════════════════
 * 我们有 loader（发现/校验/懒加载）、registry（分类）、inject（注入）、doctor（体检），
 * 但**没有安装能力** —— 技能只能靠手工往 prototype/scenes 里放目录。
 * 对手有：openclaw 的 skill_library（个人库，发布前校验+扫描）、
 *          hermes 的 optional-skills、weknora 的 ClawHub/SkillHub/Git/ZIP 安装。
 * 这一层补的就是「从外部来源装进来 / 卸掉」。
 *
 * ══ 设计规矩（每一条都有对应的反例测试）══════════════════════════
 * 1. **先校验后落盘**：安装前必须过 loader.validateSkill（name/description/目录名一致）。
 *    不合格的包**绝不落盘** —— 不允许「先装上再修」。
 * 2. **原子写入**：先写临时目录，全部成功后再 rename 到位。
 *    中途失败不留半成品（半成品会让 loader 扫到坏技能）。
 * 3. **不覆盖已存在的**：目标目录已存在 ⇒ 拒绝（不静默覆盖）。
 *    要升级必须显式 `--force`，且 force 会先把旧的移到 .bak 再装。
 * 4. **路径不许穿越**：安装源与目标名都要过安全校验（拒绝 `..`、绝对路径、盘符）。
 * 5. **有清单可查**：每次安装写一条记录到 installed.json（含来源、时间、哈希）。
 *    卸载时靠它判断「这是装进来的还是自带的」—— 自带技能不允许被卸载。
 * 6. **卸载要可逆**：卸载前把目录移到 .trash（不是 rm），留后悔药。
 *
 * ⛔ 不做越界拦截：本模块只做文件搬运与校验，不执行技能里的任何命令、不联网。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateSkill } from './loader.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
export const DEFAULT_TARGET = path.join(REPO, 'prototype/scenes');
export const MANIFEST_NAME = 'installed.json';

/** 目标技能名必须是「安全的单段目录名」 */
export function safeName(name) {
  if (typeof name !== 'string' || !name) return { ok: false, error: '技能名不能为空' };
  if (name.includes('/') || name.includes('\\')) return { ok: false, error: '技能名不能含路径分隔符：' + name };
  if (name.includes('..')) return { ok: false, error: '技能名不能含 ..：' + name };
  if (path.isAbsolute(name)) return { ok: false, error: '技能名不能是绝对路径：' + name };
  if (/^[A-Za-z]:/.test(name)) return { ok: false, error: '技能名不能含盘符：' + name };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return { ok: false, error: '技能名只允许字母数字 . _ -，且以字母数字开头：' + name };
  if (name === '.' || name === '..') return { ok: false, error: '技能名不能是 . 或 ..' };
  return { ok: true, name };
}

/** 计算目录内容哈希（用于判断"装进来之后有没有被改过"） */
export function hashDir(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel ? rel + '/' + name : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, r);
      else { h.update(r); h.update('\0'); h.update(fs.readFileSync(full)); h.update('\0'); }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return h.digest('hex');
}

/** 读清单（不存在则空清单） */
export function readManifest(target = DEFAULT_TARGET) {
  const p = path.join(target, MANIFEST_NAME);
  if (!fs.existsSync(p)) return { version: 1, installed: {} };
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!m || typeof m !== 'object' || !m.installed) return { version: 1, installed: {} };
    return m;
  } catch {
    // 清单坏了：不静默当空（否则会以为「什么都没装」，进而允许覆盖）
    return { version: 1, installed: {}, corrupt: true };
  }
}

function writeManifest(m, target) {
  fs.writeFileSync(path.join(target, MANIFEST_NAME), JSON.stringify(m, null, 2) + '\n', 'utf8');
}

/**
 * 安装一个技能。
 * @param {object} opts
 * @param {string} opts.source   源目录（含 SKILL.md）
 * @param {string} [opts.name]   目标技能名（默认取源目录名）
 * @param {string} [opts.target] 技能池根目录
 * @param {boolean} [opts.force] 已存在时是否覆盖（旧目录移到 .bak）
 * @param {boolean} [opts.dryRun] 只校验不落盘
 * @param {string} [opts.origin] 来源标记（如 'local:/path' / 'git:url' / 'manual'）
 */
export function installSkill(opts = {}) {
  const { source, name: rawName, target = DEFAULT_TARGET, force = false, dryRun = false, origin = 'local' } = opts;

  // ── 1. 源校验 ──
  if (!source) return { ok: false, code: 'no_source', error: '必须指定 source（源目录）' };
  const src = path.resolve(source);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    return { ok: false, code: 'source_missing', error: '源目录不存在：' + src };
  }
  const skillFile = path.join(src, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    return { ok: false, code: 'no_skill_md', error: '源目录缺 SKILL.md：' + src };
  }

  // ── 2. 目标名校验（防路径穿越）──
  const name = rawName || path.basename(src);
  const sn = safeName(name);
  if (!sn.ok) return { ok: false, code: 'bad_name', error: sn.error };

  // ── 3. 技能内容校验（先校验后落盘）──
  let text;
  try { text = fs.readFileSync(skillFile, 'utf8'); } catch (e) {
    return { ok: false, code: 'read_fail', error: '读 SKILL.md 失败：' + e.message };
  }
  // 延迟 import 避免循环依赖
  const v = validateSkill(name, text);
  if (!v.ok) {
    return { ok: false, code: 'invalid_skill', error: '技能校验未通过，拒绝安装', issues: v.issues };
  }
  const warns = v.issues.filter((i) => i.level === 'warn');

  // ── 4. 目标冲突检查 ──
  const dest = path.join(target, name);
  const manifest = readManifest(target);
  if (manifest.corrupt) {
    return { ok: false, code: 'manifest_corrupt', error: '清单 installed.json 损坏，拒绝安装（先修复或删除它）' };
  }
  const exists = fs.existsSync(dest);
  if (exists && !force) {
    return { ok: false, code: 'already_exists', error: '技能已存在：' + name + '（要覆盖请用 --force）' };
  }

  if (dryRun) {
    return {
      ok: true, dryRun: true, name, source: src, dest,
      wouldOverwrite: exists, warns,
      bodyBytes: v.bodyBytes,
      hash: hashDir(src),
    };
  }

  // ── 5. 原子写入：先复制到 .staging/<name>.<pid>，成功后再 rename ──
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  const stagingRoot = path.join(target, '.staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staging = path.join(stagingRoot, name + '.' + process.pid + '.' + Date.now());

  try {
    copyDir(src, staging);
    // 复制后再校验一次（防复制过程中被改）
    const stagedFile = path.join(staging, 'SKILL.md');
    if (!fs.existsSync(stagedFile)) throw new Error('复制后 SKILL.md 丢失');
    const v2 = validateSkill(name, fs.readFileSync(stagedFile, 'utf8'));
    if (!v2.ok) throw new Error('复制后校验失败：' + JSON.stringify(v2.issues));

    // 旧目录先移到 .bak（force 时）
    let backup = null;
    if (exists) {
      backup = path.join(target, '.bak', name + '.' + Date.now());
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(dest, backup);
    }

    try {
      fs.renameSync(staging, dest);
    } catch (e) {
      // rename 失败要把旧目录还回去，否则等于把技能弄丢了
      if (backup && !fs.existsSync(dest)) fs.renameSync(backup, dest);
      throw e;
    }

    // ── 6. 写清单 ──
    const entry = {
      name,
      origin,
      source: src,
      installedAt: new Date().toISOString(),
      hash: hashDir(dest),
      bodyBytes: v.bodyBytes,
      warns: warns.map((w) => w.code),
      ...(backup ? { replacedBackup: path.relative(target, backup) } : {}),
    };
    manifest.installed[name] = entry;
    writeManifest(manifest, target);

    return { ok: true, name, dest, backup, entry, warns };
  } catch (e) {
    // 清理暂存：删不掉也不该掩盖真正的安装错误，所以只记录不抛
    try {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    } catch (cleanupErr) {
      // 暂存目录残留不影响正确性（下次安装会新建带时间戳的目录），
      // 但要在返回里带出来，避免「以为清干净了」
      return {
        ok: false,
        code: 'install_failed',
        error: e.message,
        stagingLeftover: staging,
        cleanupError: cleanupErr.message,
      };
    }
    return { ok: false, code: 'install_failed', error: e.message };
  }
}

/** 卸载一个技能（只允许卸自己装的；移到 .trash 而非删除） */
export function uninstallSkill(opts = {}) {
  const { name, target = DEFAULT_TARGET, dryRun = false, purge = false } = opts;
  const sn = safeName(name);
  if (!sn.ok) return { ok: false, code: 'bad_name', error: sn.error };

  const manifest = readManifest(target);
  if (manifest.corrupt) {
    return { ok: false, code: 'manifest_corrupt', error: '清单损坏，无法判断该技能是否由安装器装入' };
  }
  const entry = manifest.installed[name];
  if (!entry) {
    const dest = path.join(target, name);
    if (fs.existsSync(dest)) {
      return { ok: false, code: 'not_installed', error: '技能 ' + name + ' 存在但不在安装清单里（内置技能不允许卸载）' };
    }
    return { ok: false, code: 'not_found', error: '技能不存在：' + name };
  }

  const dest = path.join(target, name);
  if (!fs.existsSync(dest)) {
    // 清单有记录但目录没了：清掉记录并如实报告（不假装成功）
    delete manifest.installed[name];
    if (!dryRun) writeManifest(manifest, target);
    return { ok: false, code: 'dir_missing', error: '清单有记录但目录已不存在，已清理记录：' + name, cleaned: true };
  }

  // 检测「装进来之后被改过」
  const nowHash = hashDir(dest);
  const modified = nowHash !== entry.hash;

  if (dryRun) {
    return { ok: true, dryRun: true, name, dest, modified, wouldMoveTo: path.join(target, '.trash') };
  }

  const trash = path.join(target, '.trash', name + '.' + Date.now());
  fs.mkdirSync(path.dirname(trash), { recursive: true });
  fs.renameSync(dest, trash);
  delete manifest.installed[name];
  writeManifest(manifest, target);

  let purgeError = null;
  if (purge) {
    try {
      fs.rmSync(trash, { recursive: true, force: true });
    } catch (e) {
      // purge 是「顺手删干净」的可选动作；失败时技能已经移进 .trash，
      // 功能上仍是卸载成功，但必须如实报告没删掉，不能假装已彻底删除。
      purgeError = e.message;
    }
  }

  return {
    ok: true,
    name,
    movedTo: path.relative(target, trash),
    modified,
    purged: !!purge && !purgeError,
    ...(purgeError ? { purgeError } : {}),
  };
}

/** 列出安装记录（与磁盘对账） */
export function listInstalled(target = DEFAULT_TARGET) {
  const manifest = readManifest(target);
  const rows = [];
  for (const [name, e] of Object.entries(manifest.installed)) {
    const dest = path.join(target, name);
    const onDisk = fs.existsSync(dest);
    let modified = null;
    if (onDisk) {
      try { modified = hashDir(dest) !== e.hash; } catch { modified = null; }
    }
    rows.push({ name, origin: e.origin, installedAt: e.installedAt, onDisk, modified, bodyBytes: e.bodyBytes });
  }
  return { corrupt: !!manifest.corrupt, count: rows.length, rows };
}

// ── 内部工具 ──
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
