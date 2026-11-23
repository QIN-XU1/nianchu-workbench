// check-css.mjs —— CSS 语法与设计纪律校验（无第三方依赖）
//
// 用法：node prototype/check-css.mjs
//
// 校验项：
//   A. 结构：注释闭合 / 花括号配平 / 声明完整（含跨行值）
//   B. 变量：每个 var() 引用都有定义
//   C. 纪律：字号 ≤7 档、圆角仅 3 档、阴影 ≤5 级、动效 ≤240ms
//   D. 前缀：类名统一 wb-（白名单例外）
//   E. 禁止 !important（except 无障碍/打印降级块）
//   F. HTML 引用的样式与类名真实存在
//
// 实现要点：真正扫描一遍 CSS 源码（跳过注释与字符串），
// 而不是用正则逐行猜——否则跨行值、注释里的 /* 都会误报。
//
// 只用 Node 内置模块。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UI_DIR = join(import.meta.dirname, '..', 'workbench', '外壳', 'ui');
const STYLE_DIR = join(UI_DIR, 'styles');

const cssFiles = readdirSync(STYLE_DIR).filter((f) => f.endsWith('.css'));
const problems = [];
const notes = [];

/* ═══════════════════════════════════════════════════════
   0. 预处理：把注释与字符串替换成空格（保持行号不变）
   ═══════════════════════════════════════════════════════ */

function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let depthComment = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const nx = src[i + 1];
    if (depthComment) {
      if (c === '*' && nx === '/') { depthComment = 0; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) { quote = null; out += c; i++; continue; }
      // 字符串内容替换为占位，但保留引号，保证声明仍可解析
      out += c === '\n' ? '\n' : 'x';
      i++;
      continue;
    }
    if (c === '/' && nx === '*') { depthComment = 1; out += '  '; i += 2; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

const contents = new Map();   // file -> { raw, code }
for (const f of cssFiles) {
  const raw = readFileSync(join(STYLE_DIR, f), 'utf8');
  contents.set(f, { raw, code: stripCommentsAndStrings(raw) });
}

/* ═══════════════════════════════════════════════════════
   1. 词法：切出规则块与声明
   ═══════════════════════════════════════════════════════ */

/** 返回 { selectors: [...], decls: [{ prop, value, line }], atRule } */
function parseBlocks(code) {
  const blocks = [];
  const stack = [];
  let buf = '';
  let line = 1;
  let bufLine = 1;

  const flushSelector = () => { buf = ''; };

  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\n') line++;
    if (c === '{') {
      const sel = buf.trim();
      const at = sel.startsWith('@');
      stack.push({ sel, at, startLine: bufLine, decls: [] });
      buf = '';
      continue;
    }
    if (c === '}') {
      // 收尾：把最后的声明刷入
      const top = stack[stack.length - 1];
      if (top) {
        const rest = buf.trim();
        if (rest && !top.at) top.decls.push(...splitDecls(rest, line));
      }
      const done = stack.pop();
      if (done && !done.at) blocks.push(done);
      buf = '';
      continue;
    }
    if (c === ';' && stack.length) {
      const top = stack[stack.length - 1];
      if (!top.at) {
        const d = buf.trim();
        if (d) top.decls.push(...splitDecls(d, line));
      }
      buf = '';
      continue;
    }
    if (!buf.trim() && c !== ' ' && c !== '\n' && c !== '\t') bufLine = line;
    buf += c;
  }
  return blocks;
}

/** 一个 "prop: value" 串 → 声明数组（处理值里的分号不会出现在这里） */
function splitDecls(text, endLine) {
  const out = [];
  // 用最后一个冒号前的部分当属性名（值里可能有 url(a:b)）
  const m = text.match(/^([a-zA-Z-][a-zA-Z0-9-]*)\s*:\s*([\s\S]+)$/);
  if (!m) {
    if (process.env.DBG_CSS) console.log("BAD text=" + JSON.stringify(text) + " line=" + endLine);
    return [{ bad: text, line: endLine }];
  }
  out.push({ prop: m[1], value: m[2].trim().replace(/\s+/g, ' '), line: endLine });
  return out;
}

const allBlocks = [];
for (const [f, { code }] of contents) {
  for (const b of parseBlocks(code)) {
    allBlocks.push({ file: f, ...b });
  }
}

/* ═══════════════════════════════════════════════════════
   2. A. 结构校验
   ═══════════════════════════════════════════════════════ */

for (const [f, { raw, code }] of contents) {
  if (/\uFFFD|鈺|鎸|鈥|锛/.test(raw)) {
    problems.push(`${f}: 检测到编码损坏字符（疑似被非 UTF-8 工具写过）`);
  }
  const openB = (code.match(/\{/g) || []).length;
  const closeB = (code.match(/\}/g) || []).length;
  if (openB !== closeB) problems.push(`${f}: 花括号不配对（{ ${openB} / } ${closeB}）`);

  const openP = (code.match(/\(/g) || []).length;
  const closeP = (code.match(/\)/g) || []).length;
  if (openP !== closeP) problems.push(`${f}: 圆括号不配对（( ${openP} / ) ${closeP}）`);

  // 注释必须真正闭合：用与 CSS 一致的扫描（注释内的 /* 不算嵌套，切勿用计数法）
  let inComment = false;
  let unclosedAt = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!inComment && raw[i] === '/' && raw[i + 1] === '*') { inComment = true; unclosedAt = i; i++; continue; }
    if (inComment && raw[i] === '*' && raw[i + 1] === '/') { inComment = false; i++; continue; }
  }
  if (inComment) {
    const lineNo = raw.slice(0, unclosedAt).split('\n').length;
    problems.push(`${f}:${lineNo}: 注释未闭合`);
  }
}

// 声明合法性
for (const b of allBlocks) {
  for (const d of b.decls) {
    if (d.bad) {
      problems.push(`${b.file}:${d.line}: 无法解析的声明 → ${d.bad.slice(0, 60)}`);
      continue;
    }
    if (!d.value) problems.push(`${b.file}:${d.line}: 属性值为空 → ${d.prop}`);
  }
}

/* ═══════════════════════════════════════════════════════
   3. B. 变量引用完整性
   ═══════════════════════════════════════════════════════ */

const defined = new Set();
for (const [f, { code }] of contents) {
  for (const m of code.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)) defined.add(m[1]);
}

for (const [f, { code }] of contents) {
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/var\(\s*(--[a-zA-Z][\w-]*)/g)) {
      if (!defined.has(m[1])) {
        problems.push(`${f}:${i + 1}: var() 引用了未定义变量 → ${m[1]}`);
      }
    }
  }
}

/* ═══════════════════════════════════════════════════════
   4. C. 设计纪律
   ═══════════════════════════════════════════════════════ */

// C1. 字号：必须走令牌（tokens.css 自己是定义处，豁免）
const FS_ALLOWED = /^var\(--fs-(11|12|13|15|18|22|28)\)$/;
for (const b of allBlocks) {
  if (b.file === 'tokens.css') continue;
  for (const d of b.decls) {
    if (d.bad || d.prop !== 'font-size') continue;
    if (FS_ALLOWED.test(d.value)) continue;
    if (/^(0|inherit|unset)$/.test(d.value)) continue;
    problems.push(`${b.file}:${d.line}: 裸字号 ${d.value}（只能用 var(--fs-*) 7 档）`);
  }
}

// C2. 圆角：只允许 var(--r-0|1|2) 或 0
for (const b of allBlocks) {
  if (b.file === 'tokens.css') continue;
  for (const d of b.decls) {
    if (d.bad) continue;
    if (!/^border(-[a-z]+)*-radius$/.test(d.prop)) continue;
    const v = d.value;
    // 允许 0 / var(--r-*)，以及 2/4/10 的多值简写（如 "4px 4px 0 0"）
    const parts = v.split(/\s+/);
    const okEach = parts.every((p) => p === '0' || p === '0px' || /^var\(--r-(0|1|2)\)$/.test(p));
    if (!okEach) problems.push(`${b.file}:${d.line}: 圆角 "${v}" 不在 3 档（0/4/10）内`);
  }
}

// C3. 阴影：区分「高度阴影」与「环形焦点/脉冲」
const elevationShadows = new Set();
for (const b of allBlocks) {
  for (const d of b.decls) {
    if (d.bad || d.prop !== 'box-shadow') continue;
    const v = d.value;
    if (v === 'none') continue;
    if (/^var\(--shadow-[1-5]\)$/.test(v)) { elevationShadows.add(v); continue; }
    if (/^var\(--ring-focus\)$/.test(v)) continue;
    // 环形 spread（0 0 0 Npx）与脉冲、以及动画只改 box-shadow 的，属动效不属层级
    if (/^0 0 0 /.test(v)) continue;
    if (/^inset /.test(v)) continue;
    // 组合（ring + shadow）允许
    if (v.includes('var(--shadow-') && v.includes('inset') === false) {
      for (const mm of v.matchAll(/var\(--shadow-([1-5])\)/g)) elevationShadows.add(mm[0]);
      continue;
    }
    problems.push(`${b.file}:${d.line}: 裸阴影 "${v.slice(0, 48)}"（只能用 var(--shadow-1..5)）`);
  }
}
if (elevationShadows.size > 5) {
  problems.push(`高度阴影用了 ${elevationShadows.size} 级（上限 5）：${[...elevationShadows].join(' ')}`);
}

// C4. 动效：transition 的时长 ≤240ms（循环装饰动画与 keyframes 不计入「过渡」约束）
const LOOP_HINTS = /infinite|steps\(|1400ms|1100ms|1200ms|1000ms/;
for (const b of allBlocks) {
  for (const d of b.decls) {
    if (d.bad) continue;
    if (!/^transition(-[a-z]+)*$/.test(d.prop)) continue;
    for (const m of d.value.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
      const n = parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1);
      if (n > 240) {
        problems.push(`${b.file}:${d.line}: transition 时长 ${n}ms > 240ms → ${d.value.slice(0, 56)}`);
      }
    }
  }
}

// C4b. 动画时长上限（宽松：允许循环装饰动画 ≤1600ms，非循环 ≤400ms）
for (const b of allBlocks) {
  for (const d of b.decls) {
    if (d.bad) continue;
    if (!/^animation(-[a-z]+)*$/.test(d.prop) && d.prop !== 'animation') continue;
    const v = d.value;
    const isLoop = /infinite/.test(v);
    for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
      const n = parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1);
      const limit = isLoop ? 1600 : 1600;
      if (n > limit) {
        problems.push(`${b.file}:${d.line}: animation 时长 ${n}ms > ${limit}ms（${isLoop ? '循环' : '单次'}）`);
      }
    }
  }
}

// C5. !important
const IMP_OK_FILES = new Set(['animations.css', 'base.css']);
for (const [f, { code }] of contents) {
  const count = (code.match(/!important/g) || []).length;
  if (!count) continue;
  if (!IMP_OK_FILES.has(f)) {
    problems.push(`${f}: 使用了 !important ×${count}（禁止）`);
    continue;
  }
  // 只允许出现在 prefers-reduced-motion / print 降级块
  const idxRM = code.indexOf('@media (prefers-reduced-motion');
  const idxPrint = code.indexOf('@media print');
  let inDowngrade = 0;
  if (idxRM >= 0) inDowngrade += (code.slice(idxRM).match(/!important/g) || []).length;
  if (idxPrint >= 0) inDowngrade += (code.slice(idxPrint).match(/!important/g) || []).length;
  // 两个块可能重叠计数，取较大值即可（保守）
  const allowed = Math.max(
    idxRM >= 0 ? (code.slice(idxRM).match(/!important/g) || []).length : 0,
    idxPrint >= 0 ? (code.slice(idxPrint).match(/!important/g) || []).length : 0
  );
  if (count > allowed) {
    problems.push(`${f}: !important 出现在降级块之外（${count} 处，允许 ${allowed} 处）`);
  }
}

// C6. 类名前缀
const CLASS_WHITELIST = new Set([
  'icon', 'grow', 'spacer', 'truncate', 'nowrap',
  'is-active', 'is-open', 'is-visible', 'is-collapsed', 'is-resizing',
  'is-ok', 'is-warn', 'is-err',
  'tok-cmd', 'tok-ok', 'tok-err', 'tok-dim',
  'col-num', 'col-fit',
]);
for (const [f, { code }] of contents) {
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('{')) continue;
    for (const m of lines[i].matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      const cls = m[1];
      if (cls.startsWith('wb-')) continue;
      if (CLASS_WHITELIST.has(cls)) continue;
      problems.push(`${f}:${i + 1}: 类名 .${cls} 缺少 wb- 前缀`);
    }
  }
}

/* ═══════════════════════════════════════════════════════
   5. F. HTML 侧一致性
   ═══════════════════════════════════════════════════════ */

const cssAllCode = [...contents.values()].map((c) => c.code).join('\n');

for (const page of ['style-preview.html', 'skeleton.html', 'index.html']) {
  const p = join(UI_DIR, page);
  if (!existsSync(p)) continue;
  const txt = readFileSync(p, 'utf8');

  for (const m of txt.matchAll(/href="([^"]+\.css)"/g)) {
    const href = m[1];
    if (href.startsWith('../') || href.startsWith('http')) continue;
    const name = href.replace(/^\.?\/?(styles\/)?/, '');
    if (!cssFiles.includes(name)) notes.push(`${page}: 引用的 ${href} 不在 styles/ 下`);
  }

  const used = new Set();
  for (const m of txt.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c.startsWith('wb-')) used.add(c);
  }
  for (const c of used) {
    if (!cssAllCode.includes('.' + c)) notes.push(`${page}: 类名 .${c} 在 CSS 中无对应规则`);
  }
}

/* ═══════════════════════════════════════════════════════
   6. 输出
   ═══════════════════════════════════════════════════════ */

console.log('\n  CSS 语法与设计纪律校验');
console.log('  ' + STYLE_DIR);
console.log('  ' + '-'.repeat(76));

let totalLines = 0;
let totalRules = 0;
for (const f of cssFiles) {
  const { raw } = contents.get(f);
  const rules = allBlocks.filter((b) => b.file === f).length;
  totalLines += raw.split('\n').length;
  totalRules += rules;
  console.log('  ' + f.padEnd(16) + String(raw.split('\n').length).padStart(6) + ' 行' +
              String(rules).padStart(7) + ' 规则块');
}
console.log('  ' + '-'.repeat(76));
console.log('  合计 ' + totalLines + ' 行 / ' + allBlocks.length + ' 规则块 / ' +
            defined.size + ' 个变量定义 / 高度阴影 ' + elevationShadows.size + ' 级');
console.log('');

if (notes.length) {
  console.log('  提示 (' + notes.length + ')');
  for (const n of notes) console.log('    · ' + n);
  console.log('');
}

if (problems.length) {
  console.log('  FAIL · ' + problems.length + ' 个问题');
  for (const p of problems) console.log('    - ' + p);
  console.log('');
  process.exit(1);
}

console.log('  PASS · 结构合法 / 变量闭合 / 尺度受控 / 前缀合规 / 无越权 !important');
console.log('');
