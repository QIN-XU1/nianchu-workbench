#!/usr/bin/env node
/**
 * 从"有真界面截图"的页面抓图：文档站 + 更新日志 + 功能页。
 *
 * 教训：营销首页（workbuddy / amp / qoder）拿到的是大字标题和 cookie 横幅，
 * 不是产品界面。开发者产品的文档和 changelog 才有真正的 UI 截图。
 *
 * 用法：node ui-survey-docs.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:/file/AI Temp/DeepSeek/Agent自研/research/ui-survey';
const SHOTS = path.join(ROOT, 'docs-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const SOURCES = [
  ['cursor-changelog', 'https://cursor.com/changelog'],
  ['cursor-docs', 'https://docs.cursor.com/en/welcome'],
  ['zed-blog', 'https://zed.dev/blog'],
  ['zed-docs', 'https://zed.dev/docs/'],
  ['kiro-docs', 'https://kiro.dev/docs/'],
  ['qoder-docs', 'https://docs.qoder.com/'],
  ['trae-docs', 'https://docs.trae.ai/'],
  ['cline-docs', 'https://docs.cline.bot/'],
  ['amp-manual', 'https://ampcode.com/manual'],
  ['claude-code-docs', 'https://docs.anthropic.com/en/docs/claude-code/overview'],
  ['codex-docs', 'https://developers.openai.com/codex/'],
  ['windsurf-docs', 'https://docs.windsurf.com/'],
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const curl = (args) => execFileSync('curl.exe', ['-s', '-L', '--max-time', '45', '-x', 'http://127.0.0.1:7897', ...args], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });

const out = [];
for (const [id, url] of SOURCES) {
  process.stdout.write('  ' + id.padEnd(18));
  let html;
  try { html = curl(['-A', UA, url]).toString('utf8'); } catch { console.log('✗ 抓取失败'); continue; }

  const cands = [];
  const seen = new Set();
  // img / source / og:image / video poster
  const push = (src, alt, extra = '') => {
    if (!src) return;
    let abs;
    try { abs = new URL(src, url).href; } catch { return; }
    if (seen.has(abs)) return;
    if (/\.svg(\?|$)|\.ico(\?|$)|logo|favicon|avatar|icon-/i.test(abs)) return;
    seen.add(abs);
    const score =
      (/screenshot|shot-|panel|ui|editor|dashboard|interface|preview|hero|chat|agent|terminal|diff/i.test(abs + alt) ? 6 : 0) +
      (/screenshot|界面|面板|编辑器|对话/i.test(alt) ? 4 : 0) +
      (/\.(png|jpg|jpeg|webp|avif)/i.test(abs) ? 2 : 0) + (extra ? 1 : 0);
    cands.push({ abs, alt: (alt || '').slice(0, 80), score });
  };
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const t = m[0];
    push((t.match(/(?:src|data-src)=["']([^"'\s]+)/i) || [])[1], (t.match(/alt=["']([^"']*)/i) || [])[1]);
  }
  for (const m of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/gi)) push(m[1], 'og', 'meta');
  for (const m of html.matchAll(/<video[^>]+poster=["']([^"']+)/gi)) push(m[1], 'poster', 'video');
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp|avif)/gi)) push(m[0], '');

  cands.sort((a, b) => b.score - a.score);
  const got = [];
  for (const c of cands.slice(0, 5)) {
    const ext = (c.abs.match(/\.(png|jpg|jpeg|webp|avif)/i) || [, 'png'])[1].toLowerCase();
    const f = path.join(SHOTS, id + '-' + (got.length + 1) + '.' + (ext === 'jpeg' ? 'jpg' : ext));
    try {
      curl(['-A', UA, '-o', f, c.abs]);
      const st = fs.statSync(f);
      if (st.size < 25000) { fs.unlinkSync(f); continue; }   // <25KB 基本是装饰图
      got.push({ file: f, src: c.abs, alt: c.alt, kb: Math.round(st.size / 1024) });
    } catch {}
  }
  console.log('图 ' + got.length + '  ' + got.map((g) => g.kb + 'KB').join(' '));
  out.push({ id, url, shots: got, candidates: cands.slice(0, 8) });
}

fs.writeFileSync(path.join(ROOT, 'docs-survey.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('');
console.log('  共 ' + fs.readdirSync(SHOTS).length + ' 张 → ' + SHOTS);
