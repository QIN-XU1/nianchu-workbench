#!/usr/bin/env node
/**
 * 缺席声明复核器 —— 对某个维度，把判「无」的对手仓库用**宽关键词族**再扫一遍，
 * 列出命中文件，供人工判断是否假阴性（把有判成了无）。
 *
 * 起因（第 71 轮）：C2 连续多轮把 5 家判「无」，其实是关键词太窄（只搜 abort 没搜 StopReason）。
 * 教训：判「无」必须用**宽词族**扫过，否则「扫了等于没扫」。
 *
 * 用法：node tools/evolve/scan-absence.mjs <dimId> "<regex>"
 * 只打印命中（>0 即需人工复核），不自动改矩阵。
 */
import { readFileSync, readdirSync, readFileSync as rf, statSync } from 'node:fs';
import path from 'node:path';

const ROOTS = {
  'dsh': 'D:/refs/dsh.git',
  'openclaw': 'D:/refs/openclaw.git',
  'hermes': 'D:/refs/hermes.git',
  'ecc': 'D:/refs/ECC/ECC-main',
  'luanyujia': 'D:/refs/luanyujia.git',
  'openbitfun': 'D:/refs/openbitfun.git',
  'pi': 'D:/refs/pi-main/pi-main',
  'open-design': 'D:/refs/open-design/open-design-main',
  'weknora': 'D:/refs/WeKnora/WeKnora-main',
  'craft-anything': 'D:/refs/craft-anything/craft-anything-main',
  'solo-to-team-skills': 'D:/refs/solo-to-team-skills',
  'orca': 'D:/refs/orca',
  'omp-studio': 'D:/refs/omp-studio',
  'aionui': 'D:/refs/aionui/AionUi-main',
};

const [,, dimId, pattern] = process.argv;
if (!dimId || !pattern) { console.error('用法: scan-absence.mjs <dimId> "<regex>"'); process.exit(2); }
const re = new RegExp(pattern);
const mx = JSON.parse(readFileSync(path.resolve('prototype/hermes-agents/matrix-data.json'), 'utf8'));
let dim = null;
for (const g of mx.dimensions) for (const it of g.items) if (it.id === dimId) dim = it;
if (!dim) { console.error('无此维度: ' + dimId); process.exit(2); }

const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.rs', '.go', '.vue'];
const SKIP = /(node_modules|[\\/]\.git[\\/]|\/dist\/|\/target\/|\.test\.|\/tests?\/|\/__tests__\/|\.spec\.|\.min\.)/;

function scan(root, max) {
  const hits = [];
  (function walk(d) {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (hits.length >= max) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.test(p)) walk(p); continue; }
      if (!EXTS.some((x) => p.endsWith(x))) continue;
      let t; try { t = rf(p, 'utf8'); } catch { continue; }
      const lines = t.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { hits.push(path.relative(root, p).replace(/\\/g, '/') + ':' + (i + 1) + '  ' + lines[i].trim().slice(0, 60)); break; }
      }
    }
  })(root);
  return hits;
}

console.log(`\n  维度 ${dimId} ${dim.name || ''} —— 复核判「无」的对手（关键词: ${pattern}）`);
let flagged = 0;
for (const [k, v] of Object.entries(dim)) {
  if (k === 'id' || k === 'name' || k === 'desc' || k === 'us' || k.startsWith('_')) continue;
  if (!Array.isArray(v) || v[0] !== '无') continue;
  const root = ROOTS[k];
  if (!root || !statSync(root, { throwIfNoEntry: false })) { console.log(`  [${k}] 无源码/根不存在，跳过`); continue; }
  const hits = scan(root, 4);
  if (hits.length) { flagged++; console.log(`  ⚠ [${k}] 命中（需复核）:`); for (const h of hits) console.log('      ' + h); }
  else console.log(`  ✓ [${k}] 0 命中`);
}
console.log(`\n  小结：判无共扫描若干，${flagged} 家命中关键词 → 需人工复核是否假阴性。`);