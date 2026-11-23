#!/usr/bin/env node
/**
 * 念初 · 统一 diff 应用（A1 代码编辑与 diff 应用）
 *
 * ══ 为什么需要（真实缺口）══
 * 独立审计早就降级过 A1：「prototype/hermes-agents/make-patches.mjs:86 只用
 * `git diff --no-index` **生成**补丁，不应用」。我们有 edit（唯一 old_string 替换），
 * 但**没有 apply_patch** —— 也就是拿到一份 patch 文件时，agent 只能靠 edit 一条条手改。
 * 对照 pi/claude 都有 edit + diff 应用。
 *
 * ══ 严格性（这是本模块的全部价值）══
 * 补丁应用最容易「看起来成功、实际改错」。所以规矩：
 *   ① 上下文必须**逐行精确匹配**（含行尾），不匹配就整文件放弃、**一个字节都不改**
 *   ② 支持 dryRun：只报告能不能应用，不落盘
 *   ③ 多文件时**原子性按文件**：任一文件失败，其余成功文件仍写入，但整体判 WARN 并逐文件报
 *      （比"全有或全无"更实用：真实场景常是多文件补丁里有 1 个与本地漂移）
 *   ④ 不猜、不模糊匹配、不做 fuzzy —— fuzzy 是"改错而不自知"的主要来源
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 只支持 unified diff（`--- a/x` `+++ b/x` `@@ -1,3 +1,4 @@`）；
 *   git 的 binary patch / rename / mode change **不支持**，遇到明确报错。
 * · 不做 3-way merge；本地已漂移就失败，让人来合。
 * · 行尾统一按原文件的换行风格写回（不擅自改成 LF/CRLF）。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

/** 解析 unified diff → [{ path, hunks }] */
export function parsePatch(text) {
  const lines = String(text || '').split(/\r?\n/);
  const files = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // 文件头：--- a/path 与 +++ b/path
    const mMinus = /^--- (?:a\/)?(.+?)(?:\t.*)?$/.exec(ln);
    if (mMinus && /^\+\+\+ /.test(lines[i + 1] || '')) {
      const mPlus = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(lines[i + 1]);
      cur = { path: (mPlus && mPlus[1]) || mMinus[1], hunks: [] };
      files.push(cur);
      i++;
      continue;
    }

    const mHunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(ln);
    if (mHunk && cur) {
      const oldStart = Number(mHunk[1]);
      const oldLines = mHunk[2] === undefined ? 1 : Number(mHunk[2]);
      const newStart = Number(mHunk[3]);
      const newLines = mHunk[4] === undefined ? 1 : Number(mHunk[4]);
      const hunk = { oldStart, oldLines, newStart, newLines, lines: [] };
      cur.hunks.push(hunk);
      // 收集 hunk 正文，直到行数凑够
      let oldSeen = 0;
      let newSeen = 0;
      let j = i + 1;
      while (j < lines.length && (oldSeen < oldLines || newSeen < newLines)) {
        const b = lines[j];
        if (b.startsWith('\\')) { j++; continue; }  // "\ No newline at end of file"
        const tag = b[0];
        if (tag === ' ' || tag === '' || tag === undefined) { hunk.lines.push({ t: ' ', s: b.slice(1) }); oldSeen++; newSeen++; }
        else if (tag === '-') { hunk.lines.push({ t: '-', s: b.slice(1) }); oldSeen++; }
        else if (tag === '+') { hunk.lines.push({ t: '+', s: b.slice(1) }); newSeen++; }
        else break;
        j++;
      }
      i = j - 1;
      continue;
    }

    if (/^(Binary files|GIT binary patch|rename from|rename to|old mode|new mode|similarity index|index )/.test(ln) && cur) {
      cur.unsupported = true;
    }
  }
  return files.filter((f) => f.path && !/^\/dev\/null$/.test(f.path));
}

/**
 * 应用一份补丁。
 * @returns {{state, files: Array<{path, ok, reason, added, removed}>, dryRun}}
 */
export function applyPatch(text, { cwd = process.cwd(), dryRun = false } = {}) {
  const parsed = parsePatch(text);
  if (parsed.length === 0) {
    return { state: 'FAIL', reason: '没解析出任何文件（不是 unified diff 格式？）', files: [], dryRun };
  }

  const results = [];
  for (const f of parsed) {
    const abs = isAbsolute(f.path) ? f.path : join(cwd, f.path);
    const rec = { path: f.path, ok: false, reason: null, added: 0, removed: 0 };

    if (f.unsupported) { rec.reason = '不支持的补丁类型（binary / rename / mode change）'; results.push(rec); continue; }
    if (!existsSync(abs)) { rec.reason = '文件不存在：' + f.path; results.push(rec); continue; }
    try { if (!statSync(abs).isFile()) { rec.reason = '不是普通文件'; results.push(rec); continue; } } catch (e) {
      rec.reason = '无法读取：' + String(e && e.message).slice(0, 120); results.push(rec); continue;
    }

    const raw = readFileSync(abs, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const hadTrailing = raw.endsWith('\n');
    const srcLines = raw.split(/\r?\n/);
    if (hadTrailing) srcLines.pop();

    const out = [];
    let cursor = 0;
    let failed = null;

    for (const h of f.hunks) {
      const start = Math.max(0, h.oldStart - 1);
      // 上下文必须逐行精确匹配
      const expected = h.lines.filter((l) => l.t !== '+').map((l) => l.s);
      const actual = srcLines.slice(start, start + expected.length);
      const same = expected.length === actual.length && expected.every((s, k) => s === actual[k]);
      if (!same) {
        failed = '第 ' + (h.oldStart) + ' 行起的上下文不匹配（本地已漂移？）';
        break;
      }
      // 拷贝 hunk 之前的行
      for (let k = cursor; k < start; k++) out.push(srcLines[k]);
      // 应用 hunk
      for (const l of h.lines) {
        if (l.t === ' ') out.push(l.s);
        else if (l.t === '-') { rec.removed++; }
        else if (l.t === '+') { out.push(l.s); rec.added++; }
      }
      cursor = start + expected.length;
    }

    if (failed) { rec.reason = failed; results.push(rec); continue; }

    for (let k = cursor; k < srcLines.length; k++) out.push(srcLines[k]);

    if (!dryRun) {
      const body = out.join(eol) + (hadTrailing ? eol : '');
      writeFileSync(abs, body, 'utf8');
    }
    rec.ok = true;
    results.push(rec);
  }

  const okCount = results.filter((r) => r.ok).length;
  const badCount = results.length - okCount;
  const state = badCount === 0 ? 'PASS' : (okCount === 0 ? 'FAIL' : 'WARN');
  return {
    state,
    dryRun,
    files: results,
    reason: badCount ? (badCount + ' 个文件应用失败（' + results.filter((r) => !r.ok).map((r) => r.path).join(', ') + '）') : null,
  };
}