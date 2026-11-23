#!/usr/bin/env node
/**
 * 矩阵绑定验收器 · 反例自检
 * 证明 judgeCell 的判定真的会红，而不是恒真。
 */
import fs from 'node:fs';
import path from 'node:path';
import { judgeCell, extractPaths, makeExists } from './verify-matrix-binding.mjs';

let pass = 0, total = 0;
const lines = [];
const T = (n, ok, w) => { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)); };

const REPO = path.resolve(import.meta.dirname, '../..');
const realExists = makeExists(REPO);
const neverExists = () => false;
const alwaysExists = () => true;

// ── 正例：标「有」+ 路径存在 ⇒ BOUND ──
T('正例 · 标「有」且路径存在 ⇒ BOUND',
  judgeCell(['有', '见 `tools/plugin/kernel.mjs`'], realExists).state === 'BOUND', 'not bound');

// ── 反例：标「有」但没有任何路径 ⇒ VIOLATION ──
const v1 = judgeCell(['有', '我们自己实现了，很好用'], realExists);
T('反例 · 标「有」但无任何路径 ⇒ VIOLATION', v1.state === 'VIOLATION', v1.state);
T('反例 · violation 说明是「没有任何路径引用」', /没有任何路径/.test(v1.why), v1.why);

// ── 反例：标「有」但路径都不存在 ⇒ VIOLATION ──
const v2 = judgeCell(['有', '见 `tools/not-real-thing.mjs`'], realExists);
T('反例 · 标「有」但路径不存在 ⇒ VIOLATION', v2.state === 'VIOLATION', v2.state);
T('反例 · violation 说明是「路径都不存在」', /都不存在/.test(v2.why), v2.why);

// ── 反例：路径存在与否决定结果（同一文字，两种 existsFn 给相反结论）──
const txt = ['有', '见 `tools/plugin/kernel.mjs`'];
T('反例 · 同一文字，existsFn 说没有 ⇒ VIOLATION',
  judgeCell(txt, neverExists).state === 'VIOLATION', 'wrong');
T('正例 · 同一文字，existsFn 说有 ⇒ BOUND',
  judgeCell(txt, alwaysExists).state === 'BOUND', 'wrong');

// ── 正例：标「部分/借力」无路径 ⇒ 不算违规（不误伤如实标注）──
T('正例 · 标「部分」无路径 ⇒ BORROWED（不算违规）',
  judgeCell(['部分', '借力 hermes，我们没自研'], realExists).state === 'BORROWED', 'wrong');

// ── 正例：标「无」⇒ NONE ──
T('正例 · 标「无」⇒ NONE', judgeCell(['无', '声明非目标'], realExists).state === 'NONE', 'wrong');

// ── 正例：裸路径（无反引号）也要能识别 —— 这是本轮修掉的假红 ──
const bare = extractPaths('prototype/hermes-agents/make-patches.mjs + apps/vouch-web/src/mobile-web/src/components/WorkspaceFileEditor.tsx');
T('正例 · 裸路径也能识别（A1 那种写法）',
  bare.length >= 2 && bare.some((p) => p.includes('make-patches.mjs')), JSON.stringify(bare));

// ── 正例：反引号路径识别 ──
T('正例 · 反引号路径识别', extractPaths('见 `tools/state/collect.mjs`').includes('tools/state/collect.mjs'), 'wrong');

// ── 反例：空文字 ⇒ 无路径 ──
T('反例 · 空文字抽不出路径', extractPaths('').length === 0, 'wrong');

// ── 正例：非数组输入不崩 ──
T('正例 · 非数组输入 ⇒ SKIP（不崩）', judgeCell(null, realExists).state === 'SKIP', 'wrong');

const ok = pass === total;
console.log('  矩阵绑定验收器 · 反例自检');
console.log(lines.join('\n'));
console.log('\n  自检 ' + pass + '/' + total + ' · 四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
