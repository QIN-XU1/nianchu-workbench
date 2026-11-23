#!/usr/bin/env node
/**
 * 批量：抓多个产品官网 → 提炼界面结构 → 下载最可能是界面截图的图。
 *
 * 为什么要下载图：界面设计调研**必须有视觉证据**。文案只能告诉我"它有什么功能"，
 * 看不出"它怎么排布"。所以每个产品都要抓到真实截图，我逐张看。
 *
 * 用法：node ui-survey-batch.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:/file/AI Temp/DeepSeek/Agent自研/research/ui-survey';
const RAW = path.join(ROOT, 'raw');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const PRODUCTS = [
  ['chatgpt', 'https://openai.com/index/chatgpt/'],
  ['chatgpt-app', 'https://chatgpt.com/'],
  ['qoder', 'https://qoder.com'],
  ['trae', 'https://www.trae.ai'],
  ['workbuddy', 'https://www.workbuddy.ai'],
  ['cursor', 'https://www.cursor.com'],
  ['windsurf', 'https://windsurf.com'],
  ['kiro', 'https://kiro.dev'],
  ['codex', 'https://openai.com/codex/'],
  ['manus', 'https://manus.im'],
  ['devin', 'https://devin.ai'],
  ['cline', 'https://cline.bot'],
  ['zed', 'https://zed.dev'],
  ['amp', 'https://ampcode.com'],
  ['goose', 'https://block.github.io/goose/'],
  ['openhands', 'https://www.all-hands.dev'],
  ['gemini-cli', 'https://github.com/google-gemini/gemini-cli'],
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function curlBuf(args) {
  return execFileSync('curl.exe', ['-s', '-L', '--max-time', '45', '-x', 'http://127.0.0.1:7897', ...args], {
    encoding: 'buffer', maxBuffer: 128 * 1024 * 1024,
  });
}

function clean(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 HTML 里挑最可能是"界面截图"的图 */
function pickShots(html, base) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = (tag.match(/(?:src|data-src)=["']([^"'\s]+)/i) || [])[1];
    const alt = (tag.match(/alt=["']([^"']*)/i) || [])[1] || '';
    const w = Number((tag.match(/width=["']?(\d+)/i) || [])[1] || 0);
    const h = Number((tag.match(/height=["']?(\d+)/i) || [])[1] || 0);
    if (!src || /\.svg(\?|$)|\.ico(\?|$)/i.test(src)) continue;
    if (/logo|favicon|sprite|avatar|badge|flag|emoji/i.test(src + alt)) continue;
    let abs;
    try { abs = new URL(src, base).href; } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    const score =
      (/screenshot|hero|product|dashboard|panel|preview|interface|editor|app|window|showcase|feature/i.test(abs + alt) ? 5 : 0) +
      (/chat|code|coding|agent|ide|workbench/i.test(abs + alt) ? 3 : 0) +
      (w >= 800 || h >= 500 ? 3 : 0) +
      (/\.(png|jpg|jpeg|webp)/i.test(abs) ? 1 : 0);
    out.push({ abs, alt: alt.slice(0, 90), score });
  }
  return out.sort((a, b) => b.score - a.score);
}

const report = [];
for (const [id, url] of PRODUCTS) {
  process.stdout.write('  ' + id.padEnd(13));
  let html;
  try {
    html = curlBuf(['-A', UA, url]).toString('utf8');
  } catch (e) {
    console.log('✗ 抓取失败');
    report.push({ id, url, ok: false });
    continue;
  }
  fs.writeFileSync(path.join(RAW, id + '.html'), html, 'utf8');
  const text = clean(html);
  const shots = pickShots(html, url);

  // 下载前 4 张候选中体积合适的（跳过 1x1 像素和数据 URI）
  const downloaded = [];
  for (const s of shots.slice(0, 4)) {
    const ext = (s.abs.match(/\.(png|jpg|jpeg|webp)/i) || [, 'png'])[1].toLowerCase();
    const file = path.join(SHOTS, id + '-' + (downloaded.length + 1) + '.' + (ext === 'jpeg' ? 'jpg' : ext));
    try {
      curlBuf(['-A', UA, '-o', file, s.abs]);
      const st = fs.statSync(file);
      if (st.size < 15000) { fs.unlinkSync(file); continue; }   // <15KB 基本是图标
      downloaded.push({ file, src: s.abs, alt: s.alt, kb: Math.round(st.size / 1024) });
    } catch {}
  }

  console.log('✓ ' + String(text.length).padStart(6) + ' 字  图 ' + downloaded.length +
    '  ' + downloaded.map((d) => d.kb + 'KB').join(' '));
  report.push({ id, url, ok: true, chars: text.length, text: text.slice(0, 3000), shots: downloaded, allShots: shots.slice(0, 10) });
}

fs.writeFileSync(path.join(ROOT, 'survey.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('');
console.log('  汇总: ' + path.join(ROOT, 'survey.json'));
console.log('  截图: ' + SHOTS + '  共 ' + fs.readdirSync(SHOTS).length + ' 张');
