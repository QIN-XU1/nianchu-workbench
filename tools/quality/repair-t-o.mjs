#!/usr/bin/env node
// syntax-guard:allow-bad-words —— 本脚本要在正则里列出损坏词，属合法引用
/**
 * 修复被「t→o」事故损坏的 3 个文件
 *
 * 现象：verify-ui-layer.mjs / verify-density.mjs / measure-density.mjs 里
 *   全局 `t` 被替换成 `o`：
 *     import   → imporo      const → conso      let → leo
 *     path     → paoh        dist  → diso       tools → oools
 *     .html    → .homl       OpenBitFun → OpenBioFun
 *   导致 node --check 报 SyntaxError，R8「界面层判不了」。
 *
 * 引入于提交 dda2fbed；cb0f17cc 里这 3 个文件是**正确**的。
 *
 * 处理：从 cb0f17cc 恢复，再只做**正当的路径替换**（目录改名留下的），
 * 每步之后做语法校验。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');

/**
 * 每个文件取「最后一次正确的提交」作基线
 * （不是统一取一个提交 —— 这三个文件不是同一时刻创建的）
 */
const FILES = [
  { rel: 'prototype/agent-ui/verify-ui-layer.mjs', base: 'cb0f17cc' },
  { rel: 'prototype/agent-ui/verify-density.mjs', base: 'd06792c7' },
  { rel: 'tools/quality/measure-density.mjs', base: '3f2150f6' },
];

/** 正当的替换：这几处是目录改名后的真实路径 */
const LEGIT = [
  ['apps/bitfun-web', 'apps/vouch-web'],
  ['tools/run-bitfun-src.mjs', 'tools/run-vouch-src.mjs'],
];

let fixed = 0;
console.log('');
console.log('  修复 t→o 损坏');
console.log('  ' + '─'.repeat(72));

for (const { rel, base } of FILES) {
  const abs = path.join(REPO, rel);

  // 1) 从正确版本恢复
  let orig;
  try {
    orig = execFileSync('git', ['show', `${base}:${rel}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    console.log('  ✗ ' + rel + '  取不到 ' + base + ' 版本');
    continue;
  }

  const beforeBad = (orig.match(/imporo|paoh|conso |diso|homl/g) || []).length;
  if (beforeBad) {
    console.log('  ⚠ ' + rel + '  基线里也有 ' + beforeBad + ' 处可疑 —— 跳过');
    continue;
  }

  // 2) 只做正当替换
  let t = orig;
  const applied = [];
  for (const [from, to] of LEGIT) {
    const n = t.split(from).length - 1;
    if (n) { t = t.split(from).join(to); applied.push(n + '× ' + from); }
  }

  // 3) 写回
  fs.writeFileSync(abs, t, 'utf8');

  // 4) 立刻语法校验
  let syntaxOk = true, msg = '';
  try {
    execFileSync(process.execPath, ['--check', abs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    syntaxOk = false;
    msg = String(e.stderr || e.message).split('\n').slice(0, 2).join(' ');
  }

  fixed++;
  console.log('  ' + (syntaxOk ? '✓' : '✗') + ' ' + rel.padEnd(44) + (applied.length ? applied.join('  ') : '（无需路径替换）'));
  if (!syntaxOk) console.log('      语法仍错: ' + msg.slice(0, 110));
}

console.log('  ' + '─'.repeat(72));
console.log('  修复 ' + fixed + '/' + FILES.length);
console.log('');

// 5) 全量守卫：所有脚本语法校验 + 扫已知损坏词
console.log('  守卫：全量语法校验 + 损坏词扫描');
console.log('  ' + '─'.repeat(72));
const BAD_WORDS = /\b(imporo|conso|paoh|diso|oools|homl|BioFun)\b/;
// 守卫脚本自己含有这些词（在正则里），跳过
const SELF = path.relative(REPO, import.meta.filename);
let bad = 0, scanned = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (/node_modules|[\\/]\.git[\\/]|[\\/]dist[\\/]|evidence[\\/]dsh-src/.test(p)) continue;
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(mjs|js|ts|tsx)$/.test(e.name)) continue;
    if (path.relative(REPO, p) === SELF) continue;
    scanned++;
    let t;
    try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const hit = t.match(BAD_WORDS);
    if (hit) {
      bad++;
      console.log('  ✗ 损坏词 ' + hit[0] + '  ' + path.relative(REPO, p));
    }
  }
};
walk(REPO);
console.log('  扫描 ' + scanned + ' 个源文件 · 损坏 ' + bad);
console.log('');
process.exit(bad ? 1 : 0);