#!/usr/bin/env node
/**
 * 联网取证：把矩阵里引用的所有 URL 抓一遍，四态落盘
 *
 * 为什么需要：矩阵的证据列里有大量 URL（参照系统的文档/仓库/发布页）。
 * 「我引用了 URL」不等于「URL 真的可达」。这个脚本把它变成可复算的：
 *   抓取 → 四态判定 → 落 evidence/net-evidence.json
 *   下次任何人跑一遍，就能核对「当时说的这条证据，现在还成立吗」。
 *
 * 重点：**UNKNOWN 不等于不存在**。
 *   · FAIL    = 服务器说没有（404/410）
 *   · UNKNOWN = 我没连上（DNS/超时）→ 不许写成「证据失效」
 * 这两者在报告里分开统计，不许合并。
 *
 * 用法：
 *   node tools/net/collect-evidence.mjs            # 抓全部
 *   node tools/net/collect-evidence.mjs --limit=10 # 只抓前 10 条（省时）
 *   node tools/net/collect-evidence.mjs --check    # 只校验已有结果，不联网
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchUrl, S } from './fetch.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const MATRIX = path.join(REPO, 'prototype/hermes-agents/matrix-data.json');
const OUT = path.join(REPO, 'evidence/net-evidence.json');
const CHECK = process.argv.includes('--check');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0);

/** 从矩阵所有证据文本里抽出 http(s) URL */
function collectUrls() {
  const raw = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
  const dims = raw.dimensions.flatMap((g) => g.items);
  const urlToDims = new Map();

  for (const it of dims) {
    for (const subj of ['us', 'chatgpt', 'claude', 'dsh', 'openclaw', 'hermes', 'ecc', 'luanyujia']) {
      const cell = it[subj];
      if (!Array.isArray(cell) || cell.length < 2) continue;
      const text = String(cell[1]);
      for (const m of text.matchAll(/https?:\/\/[^\s，。；、)）」"'`\]<>]+/g)) {
        const url = m[0].replace(/[.,;:]+$/, '');
        if (!urlToDims.has(url)) urlToDims.set(url, new Set());
        urlToDims.get(url).add(subj === 'us' ? it.id + '(我们)' : it.id + '(' + subj + ')');
      }
    }
  }
  return urlToDims;
}

const urlMap = collectUrls();
let urls = [...urlMap.keys()].sort();
console.log('');
console.log('  联网取证 —— 矩阵引用的 URL 是否真的可达');
console.log('  ' + '─'.repeat(72));
console.log('  从矩阵抽出 ' + urls.length + ' 个唯一 URL');
if (LIMIT > 0) { urls = urls.slice(0, LIMIT); console.log('  --limit=' + LIMIT + ' → 本次只抓 ' + urls.length + ' 个'); }

// ── --check：只读已有结果 ──
if (CHECK) {
  if (!fs.existsSync(OUT)) {
    console.log('\n  ✗ 还没有 evidence/net-evidence.json，先跑一次不带 --check 的');
    process.exit(1);
  }
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const by = (st) => prev.results.filter((r) => r.state === st);
  const pass = by(S.PASS), warn = by(S.WARN), fail = by(S.FAIL), unk = by(S.UNKNOWN);
  console.log('\n  上次结果（' + prev.at + '）');
  console.log('    PASS ' + pass.length + ' · WARN ' + warn.length + ' · FAIL ' + fail.length + ' · UNKNOWN ' + unk.length);
  // FAIL 与 UNKNOWN 必须分开报告 —— 一个说「没有」，一个说「没看到」
  if (fail.length) {
    console.log('\n  FAIL（服务器说不存在，证据需更新）:');
    for (const r of fail) console.log('    ✗ ' + r.url + '  ' + r.why);
  }
  if (unk.length) {
    console.log('\n  UNKNOWN（本次没连上，不等于不存在）:');
    for (const r of unk) console.log('    ? ' + r.url + '  ' + r.why);
  }
  const bad = fail.length;
  console.log('\n  ' + (bad ? '✗ ' + bad + ' 条证据已失效（FAIL）' : '✓ 没有 FAIL；UNKNOWN ' + unk.length + ' 条下次重试'));
  process.exit(bad ? 1 : 0);
}

// ── 抓取 ──
const results = [];
for (const url of urls) {
  const r = await fetchUrl(url, { retries: 2 });
  const dims = [...(urlMap.get(url) || [])];
  results.push({
    url,
    state: r.state,
    why: r.why,
    httpCode: r.httpCode,
    bytes: r.bytes,
    sha256: r.sha256,
    citedBy: dims,
    at: r.at,
  });
  const mark = r.state === S.PASS ? '✓' : r.state === S.WARN ? '🟡' : r.state === S.FAIL ? '✗' : '?';
  console.log('  ' + mark + ' ' + r.state.padEnd(8) + url.slice(0, 70) + (dims.length ? '  ← ' + dims.join(',') : ''));
}

const tally = {
  pass: results.filter((r) => r.state === S.PASS).length,
  warn: results.filter((r) => r.state === S.WARN).length,
  fail: results.filter((r) => r.state === S.FAIL).length,
  unknown: results.filter((r) => r.state === S.UNKNOWN).length,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  what: '矩阵引用 URL 的实测可达性（四态）',
  rule: 'UNKNOWN 表示本次没连上，不等于目标不存在；只有 FAIL 才算证据失效',
  at: new Date().toISOString(),
  total: results.length,
  tally,
  results,
}, null, 2) + '\n', 'utf8');

console.log('\n  ' + '─'.repeat(72));
console.log('  PASS ' + tally.pass + ' · WARN ' + tally.warn + ' · FAIL ' + tally.fail + ' · UNKNOWN ' + tally.unknown);
console.log('  → ' + path.relative(REPO, OUT));
console.log('');
process.exit(tally.fail > 0 ? 1 : 0);