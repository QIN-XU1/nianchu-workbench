#!/usr/bin/env node
/**
 * 证据溯源 v2：更准的关键词 + 闭源系统走 URL
 *
 * v1 的问题（实测 4/60 命中）：
 *   关键词抽得太泛 —— "local/docker"、"owner/agent" 这种描述性短语
 *   被当成源码标识符去 grep，自然找不到。
 *   另外闭源系统（ChatGPT/Claude）本来就无本地源码，不该混进统计。
 *
 * v2 策略：
 *   · 关键词优先级：反引号内容 > 带下划线的 snake_case 函数名
 *     > CamelCase 类型名 > 形如 ./a/b 的路径 > src/xxx 目录
 *     过滤掉表格式描述（含 / 但两边都是常见词）
 *   · 分两类处理：
 *       有本地源码 → 源码 grep，产出 路径:行号
 *       闭源        → 记 official-doc-required，由联网层去核官网/文档
 *   · 每条都给「核查建议」，便于人工或下一轮自动补 URL
 *
 * 用法：node tools/net/resolve-provenance.mjs [--limit=N] [--only=hermes,openclaw]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '../..');
const MATRIX = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');
const OUT = path.join(REPO, 'evidence/provenance.json');
const RG = 'D:/file/software/raccoon-ai/resources/rg/rg.exe';

const ROOTS = {
  chatgpt: null,
  claude: null,
  dsh: 'D:/file/software/DeepSeek Harness/resources/app.asar',
  openclaw: 'D:/refs/openclaw',
  hermes: 'C:/hermes',
  ecc: 'D:/refs/ECC',
  luanyujia: 'D:/refs/luanyujia-workbench',
};

/** 官方文档入口（闭源系统只能靠这个） */
const DOCS = {
  chatgpt: 'https://platform.openai.com/docs',
  claude: 'https://docs.anthropic.com',
  dsh: 'https://github.com/deepseek-ai/deepseek-harness',
  openclaw: 'local-source',
  hermes: 'local-source',
  ecc: 'local-source',
  luanyujia: 'https://github.com/mashanglinyu/luanyujia-workbench',
};

// 描述性短语（含 /，但两边是通用词）—— 不是源码标识符
const DESCRIPTIVE = /^(local|owner|agent|src|lib|app|core|main|base|util|shared|common|test|type|util|auto|manual|full|part|yes|no)\//i;

/** 抽「像源码标识符」的关键词，按可信度排序 */
function keywords(text) {
  const score = new Map(); // kw -> 分越高越可信
  const bump = (k, w) => { if (!k) return; const s = k.trim(); if (s.length < 5 || s.length > 60) return; score.set(s, (score.get(s) || 0) + w); };

  // 1) 反引号里像命令/路径/标识符的（最高可信）
  for (const m of text.matchAll(/`([^`\n]{4,60})`/g)) {
    const v = m[1].trim();
    if (/^(node|hermes|pnpm|git|npm)\s/.test(v)) { bump(v.split(/\s+/)[1] || v, 5); continue; }
    if (/^[\w./-]+$/.test(v)) bump(v, 5);
  }
  // 2) snake_case（含下划线，很可能是函数/字段）
  for (const m of text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})\b/g)) {
    if (!DESCRIPTIVE.test(m[1])) bump(m[1], 4);
  }
  // 3) CamelCase / PascalCase（>=9 字符，类型名）
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z0-9]+){1,4})\b/g)) bump(m[1], 3);
  // 4) 带扩展名的文件名
  for (const m of text.matchAll(/\b([A-Za-z0-9_-]{3,40}\.(?:py|ts|tsx|mjs|js|rs|yaml|yml|json|md))\b/g)) bump(m[1], 6);
  // 5) 形如 src/foo 且不是描述性短语
  for (const m of text.matchAll(/\b((?:src|lib|tools|plugins|packages)\/[a-z0-9_.-]{3,40})\b/g)) {
    if (!DESCRIPTIVE.test(m[1])) bump(m[1], 3);
  }

  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 8);
}

const SKIP_EXT = /node_modules|\.git[\\/]|dist[\\/]|build[\\/]|\.map$|\.min\./;

function locate(root, kw) {
  if (!root || !fs.existsSync(root)) return null;
  try {
    const out = execFileSync(fs.existsSync(RG) ? RG : 'rg',
      ['-n', '--no-heading', '--no-messages', '-m', '1', '-F', kw, root],
      { encoding: 'utf8', timeout: 40000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const line = out.split('\n').find((l) => l.trim() && !SKIP_EXT.test(l));
    if (!line) return null;
    const m = line.match(/^(.+?):(\d+):/) || line.match(/^(.+?):(\d+)?$/);
    if (!m) return null;
    const file = m[1].replace(/\\/g, '/');
    return { file: file.replace(root.replace(/\\/g, '/') + '/', ''), line: m[2] ? Number(m[2]) : null, root };
  } catch {
    return null;
  }
}

const raw = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
const dims = raw.dimensions.flatMap((g) => g.items);
const SUBJ = ['us', 'chatgpt', 'claude', 'dsh', 'openclaw', 'hermes', 'ecc', 'luanyujia'];
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0);
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',')) : null;

const HARD = {
  url: /https?:\/\//,
  pathLine: /[A-Za-z0-9_\u4e00-\u9fa5\\/.-]+\.(?:py|ts|tsx|mjs|js|json|md|rs|yaml|yml|css|scss)(?::\d+)?/,
  screenshot: /\.png|\.jpg|截图/,
};

const results = [];
let pending = 0;

for (const it of dims) {
  for (const s of SUBJ) {
    const cell = it[s];
    if (!Array.isArray(cell) || cell.length < 2) continue;
    const [state, evidence] = cell;
    const text = String(evidence || '');
    if (HARD.url.test(text) || HARD.pathLine.test(text) || HARD.screenshot.test(text)) continue;
    if (onlySet && !onlySet.has(s)) continue;
    pending++;
    if (LIMIT && results.length >= LIMIT) continue;

    const root = ROOTS[s];
    const hasSrc = !!(root && fs.existsSync(root));
    let hit = null;
    const tried = [];

    if (hasSrc) {
      for (const kw of keywords(text)) {
        tried.push(kw);
        const r = locate(root, kw);
        if (r) { hit = { ...r, keyword: kw }; break; }
      }
    }

    results.push({
      dim: it.id,
      name: it.name,
      subject: s,
      state,
      hasLocalSource: hasSrc,
      tried,
      hit,
      verdict: hit ? 'located'
        : hasSrc ? 'searched-not-found'
        : 'closed-source',
      nextStep: hit ? null
        : hasSrc ? '关键词未命中：需人工在源码里定位，或换更具体的标识符'
        : '闭源：需引用官方文档 URL（' + (DOCS[s] || '?') + '）',
    });
  }
}

const tally = {};
for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  what: '缺硬证据格子的溯源结果',
  rule: 'located=找到文件:行号｜searched-not-found=有源码但关键词没命中（不等于不存在）｜closed-source=闭源，只能用官方文档 URL',
  at: new Date().toISOString(),
  roots: ROOTS,
  docs: DOCS,
  totalPendingInMatrix: pending,
  thisRun: results.length,
  tally,
  results,
}, null, 2) + '\n', 'utf8');

console.log('');
console.log('  证据溯源 v2');
console.log('  ' + '─'.repeat(72));
console.log('  全矩阵缺硬证据: ' + pending + '　本轮处理: ' + results.length);
console.log('');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log('    ' + k.padEnd(20) + String(v).padStart(4));
}
console.log('');
const located = results.filter((r) => r.verdict === 'located');
console.log('  命中（' + located.length + '）:');
for (const r of located.slice(0, 20)) {
  console.log('    ✓ ' + (r.dim + '.' + r.subject).padEnd(16) + r.hit.file + (r.hit.line ? ':' + r.hit.line : '') + '   ← ' + r.hit.keyword);
}
console.log('');
console.log('  → ' + path.relative(REPO, OUT));
console.log('');