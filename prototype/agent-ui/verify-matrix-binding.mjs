#!/usr/bin/env node
/**
 * 矩阵 ↔ 实现 绑定验收器 —— 防「标了『有』但没有实现」
 *
 * 规则（先立标准）：
 *   ① 我们这一列标「有」⇒ 必须至少引用一个**真实存在**的实现路径
 *   ② 标「部分/借力」⇒ 不强制要求路径（如实标注借力是允许的）
 *   ③ 标「无」⇒ 不要求
 *
 * 为什么需要它：T5 要求「每一格有我们自己的可运行实现或如实标注借力」。
 * audit-matrix-honesty 只查「有没有证据文字」，不查「证据指向的文件是否存在」。
 * 这条补上后半截：文字里说的路径，必须真的在磁盘上。
 *
 * 路径识别支持两种写法（实测两种都存在）：
 *   · 反引号包裹：`tools/plugin/kernel.mjs`
 *   · 裸路径：prototype/hermes-agents/make-patches.mjs + apps/...
 *
 * 反例（必须能红）：
 *   · 标「有」但没有任何路径 ⇒ violation
 *   · 标「有」但路径都不存在 ⇒ violation
 *   · 标「有」且路径存在 ⇒ 通过
 *   · 标「部分/借力」无路径 ⇒ 不算违规（不误伤如实标注）
 *
 * 四态：PASS 全部有绑定 / FAIL 有违规 / UNKNOWN 矩阵缺失
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const MATRIX = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');

const ROOTS = 'tools|prototype|apps|research|evidence|hermes|scripts|docs';
/** 反引号内的路径 */
const TICK_RE = /`([^`]+)`/g;
/** 裸路径：以已知根开头，到空白/中文/标点为止 */
const BARE_RE = new RegExp(`(?:^|[\\s(（+、,，;；])((?:${ROOTS})/[A-Za-z0-9_./@\\-]+)`, 'g');

/** 从一段证据文字里抽出所有像路径的东西 */
export function extractPaths(text) {
  const s = String(text || '');
  const out = new Set();
  let m;
  TICK_RE.lastIndex = 0;
  while ((m = TICK_RE.exec(s))) {
    const p = m[1].trim().replace(/\\/g, '/');
    if (p) out.add(p);
  }
  BARE_RE.lastIndex = 0;
  while ((m = BARE_RE.exec(s))) {
    out.add(m[1].trim().replace(/\\/g, '/').replace(/[.,;:]+$/, ''));
  }
  return [...out];
}

/** 判定单个格子（纯函数，可单测） */
export function judgeCell(cell, existsFn) {
  if (!Array.isArray(cell)) return { state: 'SKIP', refs: [], existing: [] };
  const st = cell[0];
  const refs = extractPaths(cell[1]);
  const existing = refs.filter((r) => { try { return existsFn(r); } catch { return false; } });
  if (st === '有') {
    return {
      state: existing.length > 0 ? 'BOUND' : 'VIOLATION',
      refs, existing,
      why: existing.length > 0 ? '' : (refs.length ? '引用的路径都不存在' : '没有任何路径引用'),
    };
  }
  return { state: st === '部分' ? 'BORROWED' : st === '无' ? 'NONE' : 'OTHER', refs, existing };
}

export function makeExists(repoRoot) {
  return (rel) => {
    const r = String(rel || '').replace(/\\/g, '/').replace(/^[./]+/, '');
    const cands = [path.join(repoRoot, r), path.join(repoRoot, 'hermes', r)];
    for (const c of cands) { try { if (fs.existsSync(c)) return true; } catch { /* */ } }
    return false;
  };
}

function main() {
  if (!fs.existsSync(MATRIX)) {
    console.log('  ✗ 矩阵不存在：' + MATRIX);
    console.log('\n  四态: UNKNOWN');
    return 2;
  }
  const m = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
  const all = [];
  for (const g of m.dimensions || []) for (const it of g.items || []) all.push(it);

  const exists = makeExists(REPO);
  let have = 0, bound = 0, borrowed = 0, noneN = 0;
  const violations = [];
  for (const it of all) {
    const r = judgeCell(it.us, exists);
    if (it.us && it.us[0] === '有') {
      have++;
      if (r.state === 'BOUND') bound++;
      else violations.push({ id: it.id, name: it.name, why: r.why, refs: r.refs });
    } else if (r.state === 'BORROWED') borrowed++;
    else if (r.state === 'NONE') noneN++;
  }

  console.log('  矩阵 ↔ 实现 绑定验收');
  console.log('  我方格子：有 ' + have + ' · 部分 ' + borrowed + ' · 无 ' + noneN);
  console.log('  标「有」且有真实实现路径：' + bound + '/' + have);
  for (const v of violations) {
    console.log('    ✗ ' + v.id + ' ' + String(v.name).slice(0, 28) + ' :: ' + v.why
      + (v.refs.length ? ' [' + v.refs.slice(0, 3).join(', ') + ']' : ''));
  }
  const state = violations.length === 0 && have > 0 ? 'PASS' : violations.length > 0 ? 'FAIL' : 'UNKNOWN';
  console.log('\n  违规 ' + violations.length + ' · 四态: ' + state);
  return state === 'PASS' ? 0 : state === 'FAIL' ? 1 : 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) process.exit(main());
