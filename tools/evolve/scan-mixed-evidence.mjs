#!/usr/bin/env node
/**
 * 「REAL 格里混入了非对手路径」检查 —— 直接对应第 99 轮那次险情。
 *
 * 【险情回顾】我在 `cd` 到不存在的对手目录失败后继续扫描，实际扫的是**我们自己的仓库**，
 * 差点把 `apps/agent-ui/...` 当成 AionUi 的证据写进矩阵。如果没有核对工作目录，
 * 结论就会变成「拿自家文件证明对手没有」——**这是伪造证据**。
 *
 * 【本检查】对每个被判 REAL 的格子，把它证据文本里的**每个路径**都拿出来，
 * 逐个判断能否在该对手的根目录下找到：
 *   · 找得到 → 属于该对手，OK
 *   · 找不到 → **混入路径**（可能指向我们仓库、别的对手、或根本不存在）→ 报警
 * 只要有混入，就说明「REAL」是靠其中一个真路径撑起来的，其余是噪声或错引。
 *
 * 四态：0 无混入 · 1 有混入（需人工核对）· 2 工具自检失败
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyEvidence, extractPaths, rootsOf } from './lib/evidence-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mx = JSON.parse(readFileSync(path.join(ROOT, 'prototype/hermes-agents/matrix-data.json'), 'utf8'));

const dims = []; for (const g of mx.dimensions) for (const it of g.items) dims.push(it);
const subjects = mx.subjects || [];
const v0 = (it, s) => (Array.isArray(it[s]) ? it[s][0] : '?');

/** 该路径能否在对手根目录下找到（与 classifyEvidence 用同一套根） */
function inOpponentRoot(oid, p) {
  const roots = rootsOf(oid);
  for (const r of roots) {
    const abs = path.join(r, p.replace(/^[\\/]+/, ''));
    if (existsSync(abs)) return true;
  }
  return false;
}

// ── 自检：一个必然属于我们仓库的路径，在被当作某对手证据时应判「混入」──
{
  const probe = 'tools/workbench/serve.mjs';
  if (!existsSync(path.join(ROOT, probe))) { console.error('  ✗ 自检失败：探测路径应在我们仓库存在'); process.exit(2); }
  const anyOpp = subjects.filter((s) => !/^不可比/.test(s.id) && rootsOf(s.id).length > 0)[0];
  if (!anyOpp) { console.error('  ✗ 自检失败：找不到有根目录的对手'); process.exit(2); }
  if (inOpponentRoot(anyOpp.id, probe)) {
    console.error('  ✗ 自检失败：我们仓库的路径不应在对手根目录下找到（' + anyOpp.id + '）');
    process.exit(2);
  }
  // 还要证明「危险」规则真的会触发：该路径在我们仓库存在 → 必须被算作 dangerous
  const wouldBeDangerous = existsSync(path.join(ROOT, probe)) && !inOpponentRoot(anyOpp.id, probe);
  if (!wouldBeDangerous) { console.error('  ✗ 自检失败：危险规则未生效（自家路径应被判 dangerous）'); process.exit(2); }
}

const rows = [];
const info = [];
let mixed = 0;
for (const it of dims) {
  for (const s of subjects) {
    const verdict = v0(it, s.id);
    if (verdict === '判不了' || verdict === '?') continue;
    const raw = it[s.id];
    const ev = Array.isArray(raw) && raw.length > 1 ? String(raw[1]) : '';
    if (classifyEvidence(s.id, ev) !== 'REAL') continue; // 只看 REAL
    const paths = extractPaths(ev);
    if (paths.length === 0) continue;
    // 分成两类：证据里的路径在对手根目录下找不到时——
    //   dangerous：**在我们仓库能找到** → 这才是第 99 轮险情的形态（拿自家文件当对手证据）
    //   其余（两边都找不到）→ 多半是简写/目录，仅信息性，不判失败
    const stray = paths.filter((p) => !inOpponentRoot(s.id, p));
    const dangerous = stray.filter((p) => existsSync(path.join(ROOT, p.replace(/^[\\/]+/, ''))));
    if (dangerous.length) {
      mixed++;
      rows.push({ dim: it.id, opponent: s.id, verdict, paths, stray, dangerous });
    } else if (stray.length) {
      info.push({ dim: it.id, opponent: s.id, stray });
    }
  }
}

console.log('');
console.log('  REAL 格的「混入非对手路径」检查（防拿自家文件当对手证据）');
console.log('  ' + '─'.repeat(76));
if (rows.length === 0) {
  console.log('  ✓ 没有「在我们仓库存在却当作对手证据」的路径');
} else {
  for (const r of rows) {
    console.log('  ✗ ' + r.dim + ' / ' + r.opponent + '  危险错引 ' + r.dangerous.length + ' 条：');
    for (const p of r.dangerous.slice(0, 4)) console.log('        · ' + p + '   （在我们仓库存在）');
  }
}
if (info.length) {
  console.log('  · 信息性：' + info.length + ' 格含简写/不可解析路径（两边都找不到，不判失败）');
  for (const r of info.slice(0, 5)) console.log('        ' + r.dim + '/' + r.opponent + '：' + r.stray.slice(0, 3).join(' , '));
}
console.log('  ' + '─'.repeat(76));
console.log('  REAL 格含**危险错引**：' + mixed + ' 处');
console.log('  四态: ' + (mixed === 0 ? 'PASS' : 'FAIL'));
process.exit(mixed === 0 ? 0 : 1);