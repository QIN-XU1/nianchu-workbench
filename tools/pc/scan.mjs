#!/usr/bin/env node
/**
 * 本机磁盘盘点 —— 只读，**不删任何东西**。
 *
 * 照搬 luanyujia-workbench 01-场景模式/面板类型总览.md 的「电脑族四件套」：
 *   pc-drives    各盘容量（按危险度变色）
 *   pc-toplarge  大户排行（哪个目录最占地方）
 *   pc-junk      可清理项（按类型分组）
 *   pc-ledger    清理台账（每次清了什么，只追加）
 *
 * 原文的价值判断（照抄）：
 *   「这一族的价值不在"好看"，在于**把"该不该清"从口头判断变成看板数字**。」
 *
 * 原文的安全规矩（照抄，逐条落地）：
 *   ① 「先只读盘点 → 出清单 → 要动手前先在面板回一句 → 动手 → 记三处」
 *      ⇒ 本脚本**只做第一步**。没有任何删除/移动代码。
 *   ② 「⛔ 不许用 Remove-Item -Force / rmSync / del 直接抹掉」
 *      ⇒ 本文件里不出现这些调用（连 import 都没有）。
 *   ③ 「你只管提请求，别动手」
 *      ⇒ 真清理由 pc-cleanup 场景经 tools/collab/request.mjs 派单。
 *
 * 用法：node tools/pc/scan.mjs [--json]
 * 四态：0 = PASS（盘都能读到）/ 3 = WARN（有盘读不到或有高风险项）/ 2 = UNKNOWN
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 容量警戒线：>90% 红，>80% 黄 */
const RED = 0.9;
const YELLOW = 0.8;

function driveLetters() {
  const out = [];
  // Windows：探测 A-Z 里 statfs 能通的
  for (let c = 67; c <= 90; c++) {
    const letter = String.fromCharCode(c) + ':\\';
    try {
      fs.statfsSync(letter);
      out.push(letter);
    } catch { /* 不存在 */ }
  }
  return out.length ? out : ['/'];
}

function scanDrives() {
  const rows = [];
  for (const root of driveLetters()) {
    try {
      const st = fs.statfsSync(root);
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      const used = total - free;
      const ratio = total ? used / total : 0;
      rows.push({
        root,
        totalGB: Math.round(total / 1e9),
        usedGB: Math.round(used / 1e9),
        freeGB: Math.round(free / 1e9),
        ratio: Math.round(ratio * 1000) / 1000,
        tone: ratio >= RED ? 'danger' : ratio >= YELLOW ? 'warn' : 'ok',
      });
    } catch {
      rows.push({ root, totalGB: null, usedGB: null, freeGB: null, ratio: null, tone: 'unknown' });
    }
  }
  return rows;
}

/** 目录体积（有上限，防止扫全盘卡死） */
function dirSize(dir, budgetMs = 1200) {
  const t0 = Date.now();
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() - t0 > budgetMs) break;
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) { bytes += fs.statSync(p).size; files++; }
      } catch { /* 跳过无权限 */ }
    }
  }
  return { bytes, files };
}

/** 大户排行：只看几个有代表性的根，不扫全盘 */
function scanTopLarge() {
  const candidates = [
    path.join(REPO, 'node_modules'),
    path.join(REPO, '.git'),
    path.join(REPO, 'tools'),
    path.join(REPO, 'prototype'),
    path.join(REPO, 'apps'),
    path.join(REPO, 'research'),
    path.join(REPO, 'evidence'),
    path.join(os.homedir(), '.dsh'),
  ];
  const rows = [];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const { bytes, files } = dirSize(c, 800);
    rows.push({ path: path.relative(REPO, c) || c, mb: Math.round(bytes / 1e6), files });
  }
  return rows.sort((a, b) => b.mb - a.mb).slice(0, 8);
}

/** 可清理项：只看**已知**的缓存型目录，且只报大小，不动手 */
function scanJunk() {
  const items = [
    { name: 'repo node_modules', p: path.join(REPO, 'node_modules'), kind: '可再生（编译产物）' },
    { name: 'web-ui node_modules', p: path.join(REPO, 'apps/vouch-web/src/web-ui/node_modules'), kind: '可再生（编译产物）' },
    { name: 'Vite 构建缓存', p: path.join(REPO, 'apps/vouch-web/src/web-ui/node_modules/.vite'), kind: '可再生（缓存）' },
    { name: '临时证据目录', p: path.join(REPO, '_audit_tmp'), kind: '可再生（临时）' },
    { name: '调试目录', p: path.join(REPO, '_debug_tmp'), kind: '可再生（临时）' },
  ];
  const rows = [];
  for (const it of items) {
    if (!fs.existsSync(it.p)) continue;
    const { bytes, files } = dirSize(it.p, 600);
    rows.push({ name: it.name, mb: Math.round(bytes / 1e6), files, kind: it.kind, action: '建议：先看清单再决定（本工具不删）' });
  }
  return rows.sort((a, b) => b.mb - a.mb);
}

/** 清理台账：只追加的文件，没有就空 */
function scanLedger() {
  const p = path.join(REPO, 'evidence/cleanup/cleanup-log.jsonl');
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).slice(-10);
  } catch { return []; }
}

const data = {
  at: new Date().toISOString(),
  host: os.hostname(),
  drives: scanDrives(),
  topLarge: scanTopLarge(),
  junk: scanJunk(),
  ledger: scanLedger(),
};

// 四态
const badDrives = data.drives.filter((d) => d.tone === 'unknown').length;
const dangerDrives = data.drives.filter((d) => d.tone === 'danger').length;
let state, why;
if (!data.drives.length) {
  state = 'UNKNOWN'; why = '一个盘都读不到';
} else if (badDrives) {
  state = 'WARN'; why = badDrives + ' 个盘读不到容量（权限或不存在）';
} else if (dangerDrives) {
  state = 'WARN'; why = dangerDrives + ' 个盘使用率 >90%';
} else {
  state = 'PASS'; why = data.drives.length + ' 个盘都读到，无 >90% 的';
}
data.state = state;
data.why = why;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(data, null, 2));
} else {
  console.log('');
  console.log('  本机磁盘盘点（只读 · 不删任何东西）');
  console.log('  ' + '─'.repeat(74));
  console.log('  主机: ' + data.host + '  ·  ' + data.at.slice(0, 19).replace('T', ' '));
  console.log('');
  console.log('  分区：');
  for (const d of data.drives) {
    const bar = d.ratio == null ? '—' : ('█'.repeat(Math.round(d.ratio * 20)) + '░'.repeat(20 - Math.round(d.ratio * 20)));
    console.log('    ' + d.root.padEnd(4) + (d.ratio == null ? '读不到' : (d.usedGB + '/' + d.totalGB + ' GB').padEnd(16))
      + bar + '  ' + (d.ratio == null ? '' : Math.round(d.ratio * 100) + '%') + '  [' + d.tone + ']');
  }
  console.log('');
  console.log('  大户排行：');
  for (const t of data.topLarge) console.log('    ' + String(t.mb).padStart(6) + ' MB  ' + t.path + '  (' + t.files + ' 文件)');
  console.log('');
  console.log('  可清理项（仅报大小，本工具不删）：');
  for (const j of data.junk) console.log('    ' + String(j.mb).padStart(6) + ' MB  ' + j.name.padEnd(24) + j.kind);
  console.log('');
  console.log('  清理台账: ' + (data.ledger.length ? data.ledger.length + ' 条' : '（还没有记录）'));
  console.log('');
  console.log('  四态: ' + state + ' —— ' + why);
  console.log('');
}

// 写证据，供面板读
const out = path.join(REPO, 'evidence/pc/scan.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data, null, 2) + '\n', 'utf8');

process.exit(state === 'PASS' ? 0 : state === 'WARN' ? 3 : state === 'FAIL' ? 1 : 2);
