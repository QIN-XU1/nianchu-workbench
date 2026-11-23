#!/usr/bin/env node
/**
 * 静默吞异常扫描（API/服务层）—— 每个空 catch 都必须写明「为什么吞掉是安全的」。
 *
 * 【为什么需要】第 95 轮发现 `tools/memory/bulk.mjs` 把「文件存在但解析失败（损坏）」当成「新库」，
 * 继续跑就会用空库覆盖损坏文件 → **静默丢数据**。这类 bug 的形状是：错误被 catch 吞掉，
 * 程序继续跑，对外看起来一切正常（假成功）。
 *
 * 【第 106 轮改：白名单从「行号」改成「片段」】
 * 起因：第 104 轮我只在 ws-host.mjs 加了 1 行 import + 3 行展开，**7 条按行号登记的白名单条目全部过期**，
 * 另 7 条新位置未解释 —— 一次无害的编辑就把检查搞成红灯。
 * 现在每条白名单登记的是 `{file, snippet, nth}`：同文件里第 nth 个「包含该片段」的空 catch。
 * 这样**上下插行不再漂移**；只有「这段代码真的没了/多了」才会报。
 *
 * 范围：只扫 API/服务/agent 层（agent / memory / hostapi / workbench / schedule / plugin / skills）。
 * 判定：括号配对提取 catch 块体 → 剥注释与字符串 → 空即静默。
 *
 * 四态：0 全部有解释 · 1 有未解释或过期 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_DIRS = ['tools/agent', 'tools/memory', 'tools/hostapi', 'tools/workbench', 'tools/schedule', 'tools/plugin', 'tools/skills'];
const WL = path.join(ROOT, 'tools/quality/silent-catch-whitelist.json');

/** 把注释与字符串内容替换成空格（保留换行与偏移） */
export function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let mode = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode === null) {
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = null; out += '\n'; } else out += ' '; i++; continue; }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = null; out += '  '; i += 2; continue; }
      out += (c === '\n') ? '\n' : ' '; i++; continue;
    }
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === mode) { mode = null; out += ' '; i++; continue; }
    out += (c === '\n') ? '\n' : ' '; i++;
  }
  return out;
}

/** 提取所有空 catch；返回 [{line, empty, text}]，text 是**原始源码那一行**（用于片段匹配） */
export function catchBlocks(srcRaw) {
  const src = stripCommentsAndStrings(srcRaw);
  const rawLines = srcRaw.split(/\r?\n/);
  const out = [];
  const re = /catch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex - 1, depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(start + 1, i);
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ line, empty: body.replace(/\s+/g, '') === '', text: (rawLines[line - 1] || '').trim() });
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain) {
  const dirsArg = (process.argv.find((x) => x.startsWith('--dirs=')) || '').slice('--dirs='.length);
  const DIRS = dirsArg ? dirsArg.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_DIRS;

  // ── 自检 ──
  {
    const a = catchBlocks('try { x(); } catch { /* ignore */ }');
    const b = catchBlocks('try { x(); } catch (e) { log(e); }');
    const c = catchBlocks('try { x(); } catch {\n  // note\n}');
    if (a.length !== 1 || !a[0].empty) { console.error('  ✗ 自检失败：注释空块应判静默'); process.exit(2); }
    if (b.length !== 1 || b[0].empty) { console.error('  ✗ 自检失败：有代码的 catch 不该判静默'); process.exit(2); }
    if (c.length !== 1 || !c[0].empty) { console.error('  ✗ 自检失败：仅注释块应判静默'); process.exit(2); }
    if (!a[0].text || !a[0].text.includes('catch')) { console.error('  ✗ 自检失败：候选应带原始行文本'); process.exit(2); }
  }

  const candidates = [];
  for (const d of DIRS) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.name.endsWith('.mjs')) continue;
      if (/^verify|\.test\.|\.selftest\./.test(e.name)) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(ROOT, p).replace(/\\/g, '/');
      for (const b of catchBlocks(fs.readFileSync(p, 'utf8'))) {
        if (b.empty) candidates.push({ file: rel, line: b.line, text: b.text });
      }
    }
  }

  const wl = fs.existsSync(WL) ? JSON.parse(fs.readFileSync(WL, 'utf8').replace(/^\uFEFF/, '')) : { explained: [] };
  const explained = Array.isArray(wl.explained) ? wl.explained : [];

  // 按 file + snippet 分组，用于 nth 定位
  const groups = new Map(); // key = file||snippet -> [candidates...]
  for (const c of candidates) {
    for (const e of explained) {
      if (e.file !== c.file) continue;
      if (!c.text.includes(e.snippet)) continue;
      const key = e.file + '||' + e.snippet;
      if (!groups.has(key)) groups.set(key, []);
      if (!groups.get(key).includes(c)) groups.get(key).push(c);
    }
  }

  const matched = new Set();
  let unexplained = 0;
  const explainedCands = [];
  const stale = [];
  for (const e of explained) {
    const key = e.file + '||' + e.snippet;
    const list = (groups.get(key) || []).sort((a, b) => a.line - b.line);
    const c = list[Number(e.nth || 0)];
    if (c && !matched.has(c.file + ':' + c.line)) {
      matched.add(c.file + ':' + c.line);
      explainedCands.push({ c, e });
    } else {
      stale.push(e);
    }
  }

  console.log('');
  console.log('  静默吞异常扫描（API/服务/agent 层）· 空 catch 候选 ' + candidates.length + ' 处');
  console.log('  ' + '─'.repeat(74));
  for (const { c, e } of explainedCands) {
    console.log('  ✓ ' + (c.file + ':' + c.line).padEnd(42) + ' — ' + String(e.reason).slice(0, 40));
  }
  for (const c of candidates) {
    if (matched.has(c.file + ':' + c.line)) continue;
    unexplained++;
    console.log('  ✗ ' + (c.file + ':' + c.line).padEnd(42) + ' — 未解释：' + c.text.slice(0, 46));
  }
  for (const s of stale) {
    console.log('  ✗ 过期条目 ' + s.file + ' · 片段「' + String(s.snippet).slice(0, 40) + '」已找不到对应空 catch');
  }
  console.log('  ' + '─'.repeat(74));
  console.log('  白名单 ' + explained.length + ' · 候选 ' + candidates.length + ' · 未解释 ' + unexplained + ' · 过期 ' + stale.length);
  // 第 212 轮：显式打扫描范围，防止「未解释 0」被误读成「全仓干净」。
  console.log('  扫描范围: ' + DIRS.join(', '));
  if (!dirsArg) {
    console.log('  ⚠ 范围外未扫（工具/原型层，非产品运行时）: tools/evolve, tools/quality, tools/portable, apps, prototype');
    console.log('    实测这些目录另有约 15 处未解释空 catch（用 --dirs= 显式扩范围才会被发现）。');
  }
  const bad = unexplained + stale.length;
  console.log('  四态: ' + (bad === 0 ? 'PASS' : 'FAIL'));
  process.exit(bad === 0 ? 0 : 1);
}
