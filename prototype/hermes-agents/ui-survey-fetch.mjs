#!/usr/bin/env node
/**
 * 抓取产品官网：提取正文文本 + 图片 URL。
 *
 * 为什么自己写：web_search / web_fetch 都因为 DeepSeek 余额 402 不可用，
 * 只能走系统代理 127.0.0.1:7897 用 curl。
 *
 * 目的不是"读介绍"，是**找界面截图** —— 界面设计调研必须有视觉证据，
 * 光看文案描述等于二手信息（目标第 1 条明确要求：本地源码 > 联网文档 > 二手描述）。
 *
 * 用法：node ui-survey-fetch.mjs <url> [--out 目录]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const url = process.argv[2];
const outDir = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : 'D:/file/AI Temp/DeepSeek/Agent自研/research/ui-survey/raw'; })();
if (!url) { console.log('用法: node ui-survey-fetch.mjs <url> [--out 目录]'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const name = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_').replace(/\./g, '-');
const htmlPath = path.join(outDir, name + '.html');

function curl(args) {
  return execFileSync('curl.exe', ['-s', '-L', '--max-time', '40', '-x', 'http://127.0.0.1:7897', ...args], {
    encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
}

let html;
try {
  html = curl(['-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', url]).toString('utf8');
} catch (e) {
  console.log('  ✗ 抓取失败: ' + String(e.message).slice(0, 120));
  process.exit(1);
}
fs.writeFileSync(htmlPath, html, 'utf8');

// ── 正文文本：去 script/style 后取可读文本 ──
const text = html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

// ── 图片候选：hero / screenshot / product / dashboard 优先 ──
const imgs = new Set();
for (const m of html.matchAll(/<img[^>]+>/gi)) {
  const tag = m[0];
  const src = (tag.match(/(?:src|data-src|srcset)=["']([^"'\s]+)/i) || [])[1];
  const alt = (tag.match(/alt=["']([^"']*)/i) || [])[1] || '';
  if (!src) continue;
  if (/\.(svg|ico)(\?|$)/i.test(src)) continue;
  try { imgs.add(JSON.stringify({ src: new URL(src, url).href, alt: alt.slice(0, 80) })); } catch {}
}
for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp)/gi)) {
  if (!/logo|icon|favicon|sprite|avatar/i.test(m[0])) imgs.add(JSON.stringify({ src: m[0], alt: '' }));
}
const imgList = [...imgs].map((s) => JSON.parse(s));
const ranked = imgList.sort((a, b) => {
  const score = (x) => (/screenshot|hero|product|dashboard|panel|chat|editor|window|dark|light|feature/i.test(x.src + x.alt) ? 3 : 0) + (/\.webp|\.png/i.test(x.src) ? 1 : 0);
  return score(b) - score(a);
});

console.log('');
console.log('  URL:  ' + url);
console.log('  HTML: ' + Math.round(html.length / 1024) + 'KB → ' + htmlPath);
console.log('  正文: ' + text.length + ' 字符');
console.log('  图片: ' + imgList.length + ' 个（按界面相关度排序取前 8）');
console.log('');
console.log('  ── 正文前 600 字 ──');
console.log('  ' + text.slice(0, 600).replace(/(.{110})/g, '$1\n  '));
console.log('');
console.log('  ── 图片候选 ──');
for (const im of ranked.slice(0, 8)) console.log('  ' + im.src.slice(0, 150) + (im.alt ? '   [' + im.alt + ']' : ''));

fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify({ url, text, images: ranked }, null, 2), 'utf8');
