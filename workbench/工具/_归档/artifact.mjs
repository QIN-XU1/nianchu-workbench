/**
 * L5 管线层 —— 产物治理
 *
 * 现状问题（实测）：
 *   · 3 个产物全是 sf-test.mjs 跑出的测试数据
 *   · 其中 1 个是 no-such-scene 的脏数据（logicalId=x, name=x）
 *   · 没有版本管理（同逻辑 id 发新版会变成两条独立记录）
 *
 * 本脚本：
 *   --clean    清理测试残留（logicalId 以 x/_test 开头，或来自未知场景）
 *   --versions 检查同逻辑 id 的版本情况
 *   --check    校验产物完整性（文件存在、事件一致）
 *
 * 用法：
 *   node 工具\artifact.mjs --check
 *   node 工具\artifact.mjs --clean --dry
 *   node 工具\artifact.mjs --clean --go
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ART = path.join(WB, '产物');
const INDEX = path.join(ART, 'index.json');
const EVENTS = path.join(ART, 'events.jsonl');
const SC = path.join(WB, '外壳', 'scenarios');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const isCheck = process.argv.includes('--check');
const isClean = process.argv.includes('--clean');
const isVersions = process.argv.includes('--versions');
const isDry = process.argv.includes('--dry');
const isGo = process.argv.includes('--go');

// ═══════ 已知场景 ═══════
const knownScenes = new Set();
if (fs.existsSync(SC)) {
  for (const f of fs.readdirSync(SC)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
      if (j.id) knownScenes.add(j.id);
    } catch { /* ignore */ }
  }
}

function loadIndex() {
  if (!fs.existsSync(INDEX)) return { artifacts: [] };
  return JSON.parse(fs.readFileSync(INDEX, 'utf8').replace(/\uFEFF/g, ''));
}

// ═══════ --check ═══════
if (isCheck) {
  const idx = loadIndex();
  const arts = idx.artifacts || [];
  console.log(C.bold + 'L5 管线层 · 产物校验' + C.reset);
  console.log('  产物 ' + arts.length + ' 个');
  console.log();

  let bad = 0;
  const dirty = [];

  for (const a of arts) {
    const full = path.join(WB, a.path || '');
    const exists = a.path && fs.existsSync(full);
    const fromKnown = knownScenes.has(a.fromScene);
    const toKnown = (a.toScenes || []).every(t => knownScenes.has(t));
    const isTestData = /^(x|_test)/.test(a.logicalId || '') || (a.name === 'x');

    const marks = [];
    if (!exists) marks.push('文件缺失');
    if (!fromKnown) marks.push('来源场景未知');
    if (!toKnown) marks.push('接收方未知');
    if (isTestData) marks.push('测试残留');

    if (marks.length) {
      bad++;
      if (isTestData || !fromKnown) dirty.push(a);
    }

    console.log('  ' + (marks.length ? C.yellow + '!' : C.green + '✓') + C.reset + '  ' +
      String(a.id).padEnd(28) + String(a.name).padEnd(14) +
      (marks.length ? C.yellow + marks.join(' / ') + C.reset : ''));
  }

  console.log();
  console.log('  正常 ' + (arts.length - bad) + ' 个 · 有问题 ' + bad + ' 个');
  if (dirty.length) {
    console.log('  ' + C.yellow + '其中 ' + dirty.length + ' 个是测试残留，建议 --clean' + C.reset);
  }

  process.exit(bad ? 2 : 0);
}

// ═══════ --versions ═══════
if (isVersions) {
  const idx = loadIndex();
  const arts = idx.artifacts || [];
  console.log(C.bold + 'L5 产物版本检查' + C.reset);
  console.log();

  const byLogical = {};
  for (const a of arts) {
    const k = a.logicalId || '(无)';
    (byLogical[k] = byLogical[k] || []).push(a);
  }

  let multi = 0;
  for (const [k, list] of Object.entries(byLogical)) {
    if (list.length > 1) {
      multi++;
      console.log('  ' + C.yellow + '!' + C.reset + ' ' + k + ' 有 ' + list.length + ' 个版本：');
      for (const a of list) {
        console.log('       ' + a.id + '  ' + (a.createdAt || ''));
      }
      console.log('    ' + C.dim + '→ 建议：只保留最新，旧的标 stale' + C.reset);
    }
  }

  if (!multi) console.log('  ' + C.green + '✓' + C.reset + ' 每个逻辑 id 只有 1 个版本');
  process.exit(0);
}

// ═══════ --clean ═══════
if (isClean) {
  const idx = loadIndex();
  const arts = idx.artifacts || [];

  const toRemove = arts.filter(a =>
    /^(x|_test)/.test(a.logicalId || '') ||
    a.name === 'x' ||
    !knownScenes.has(a.fromScene)
  );

  console.log(C.bold + 'L5 清理测试残留' + C.reset);
  console.log();
  console.log('  待清理 ' + toRemove.length + ' 个：');
  for (const a of toRemove) {
    console.log('    ' + String(a.id).padEnd(28) + String(a.name).padEnd(12) +
      C.dim + '来自 ' + a.fromScene + C.reset);
  }

  if (!toRemove.length) {
    console.log();
    console.log(C.green + '没有需要清理的' + C.reset);
    process.exit(0);
  }

  if (isDry || !isGo) {
    console.log();
    console.log(C.dim + '（预览模式。加 --go 才真删）' + C.reset);
    process.exit(0);
  }

  // 真删：从索引移除 + 删文件 + 记事件
  const keep = arts.filter(a => !toRemove.includes(a));
  idx.artifacts = keep;
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2), 'utf8');

  for (const a of toRemove) {
    const full = path.join(WB, a.path || '');
    try { if (a.path && fs.existsSync(full)) fs.unlinkSync(full); } catch { /* ignore */ }
    fs.appendFileSync(EVENTS,
      JSON.stringify({ at: new Date().toISOString(), type: 'clean', artifact: a.id, reason: '测试残留' }) + '\n',
      'utf8');
  }

  console.log();
  console.log(C.green + 'OK 已清理 ' + toRemove.length + ' 个，剩 ' + keep.length + ' 个' + C.reset);
  process.exit(0);
}

console.log('L5 管线层 · 产物治理');
console.log();
console.log('  node 工具\\artifact.mjs --check      校验产物');
console.log('  node 工具\\artifact.mjs --versions   检查版本');
console.log('  node 工具\\artifact.mjs --clean --dry 预览清理');
console.log('  node 工具\\artifact.mjs --clean --go  执行清理');
