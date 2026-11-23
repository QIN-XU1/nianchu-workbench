#!/usr/bin/env node
/**
 * 力导向布局的反例测试 —— 证明「这不是思维导图，是真图谱」。
 *
 * 【为什么需要这个文件】2026-11-18 用户指出：我做的分层带状布局像思维导图，
 * 不像知识图谱/记忆元。改成力导向后，必须能证明它**真的**有聚团行为，
 * 否则改了个形状也算不上"类似知识图谱"。
 *
 * 判据（三条全过才算真力导向）：
 *   ① 可复算：同样输入跑两次，坐标必须完全一致（否则每次刷新图都变形）
 *   ② 有聚团：相连节点的平均距离 < 不相连节点的平均距离（力导向的定义性质）
 *   ③ 不重叠：最近两点距离 > 20（否则挤成一坨看不清）
 *
 * 反例（应当失败）：把弹簧强度设为 0（等于没有边引力），聚团必须消失 ——
 * 如果关掉引力后仍然"看起来聚团"，说明聚团来自初始位置而非算法，是假的。
 *
 * 用法：node apps/vouch-web/scripts/check-force-layout.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forceLayout } from '../src/web-ui/src/app/scenes/workbench/forceLayout.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TOPO = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/vouch/data/topology.json');

let data;
try {
  data = JSON.parse(fs.readFileSync(TOPO, 'utf8'));
} catch (e) {
  console.log('  ❔ 读不到拓扑数据：' + String(e && e.message).slice(0, 80));
  console.log('  四态: UNKNOWN');
  process.exit(2);
}

const nodes = data.nodes.map((n) => ({ id: n.id, layer: n.layer }));
const edges = data.edges.map((e) => ({ from: e.from, to: e.to }));

let pass = 0;
let fail = 0;
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const t0 = Date.now();
const pos = forceLayout(nodes, edges);
const ms = Date.now() - t0;

/** ① 可复算 */
const pos2 = forceLayout(nodes, edges);
let identical = pos.size === pos2.size;
for (const [id, p] of pos) {
  const q = pos2.get(id);
  if (!q || p.x !== q.x || p.y !== q.y) { identical = false; break; }
}
t('可复算：两次运行坐标完全一致（否则每次刷新图都变形）', identical);

/** 统计辅助 */
function stats(p) {
  const ids = [...p.keys()];
  const linked = new Set(edges.map((e) => e.from + '|' + e.to));
  let sumIn = 0, nIn = 0, sumOut = 0, nOut = 0, minD = Infinity;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = p.get(ids[i]);
      const b = p.get(ids[j]);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < minD) minD = d;
      const isLinked = linked.has(ids[i] + '|' + ids[j]) || linked.has(ids[j] + '|' + ids[i]);
      if (isLinked) { sumIn += d; nIn++; } else { sumOut += d; nOut++; }
    }
  }
  return { inAvg: nIn ? sumIn / nIn : 0, outAvg: nOut ? sumOut / nOut : 0, minD };
}

const s = stats(pos);
t('有聚团：相连平均距 < 不相连平均距（力导向的定义性质）',
  s.inAvg < s.outAvg,
  s.inAvg.toFixed(1) + ' vs ' + s.outAvg.toFixed(1));
t('不重叠：最近两点距离 > 20', s.minD > 20, s.minD.toFixed(1));

/**
 * ★反例：把**所有**聚团来源都关掉（边引力 + 同层聚团），聚团必须基本消失。
 *
 * 【2026-11-18 实测修正】原来只关 link=0，结果 97.3 vs 120.6 —— 仍然聚团，
 * 用例失败。查下来**不是 bug**：`layerCluster` 还在起作用，同层节点仍会被拉近。
 * 也就是说这个反例设计得不严：它想验「聚团来自边」，但实际聚团有**两个**来源。
 *
 * 所以改成关掉两个来源再看。判据：相连距 / 不相连距 的比值必须回到接近 1。
 * 保留真实数字在输出里，不藏起来。
 */
const posNoCluster = forceLayout(nodes, edges, { link: 0, layerCluster: 0 });
const sNoCluster = stats(posNoCluster);
const ratioWithClusters = s.inAvg / s.outAvg;
const ratioNoClusters = sNoCluster.inAvg / sNoCluster.outAvg;
t('★反例：关掉全部聚团来源（link=0 + layerCluster=0）⇒ 聚团基本消失',
  ratioNoClusters > 0.9,
  '有聚团时比值 ' + ratioWithClusters.toFixed(2)
  + ' → 关掉后 ' + ratioNoClusters.toFixed(2)
  + '（' + sNoCluster.inAvg.toFixed(1) + ' vs ' + sNoCluster.outAvg.toFixed(1) + '）');

/** 归因：分别关掉两个来源，看各自贡献多少（如实报告，不挑对自己有利的那个） */
const posNoLinkOnly = forceLayout(nodes, edges, { link: 0 });
const sNoLinkOnly = stats(posNoLinkOnly);
console.log('');
console.log('  ── 聚团归因（两个来源各自贡献）──');
console.log('  边引力 + 同层聚团: ' + (s.inAvg / s.outAvg).toFixed(2));
console.log('  只关边引力      : ' + (sNoLinkOnly.inAvg / sNoLinkOnly.outAvg).toFixed(2)
  + '  （剩下的来自 layerCluster）');
console.log('  两个都关        : ' + ratioNoClusters.toFixed(2) + '  （≈1 = 无聚团）');

/** ★反例：同层聚团关掉后，层内节点不应更近 */
const posNoLayer = forceLayout(nodes, edges, { layerCluster: 0 });
function layerGap(p) {
  let sumSame = 0, nSame = 0, sumDiff = 0, nDiff = 0;
  const ids = [...p.keys()];
  const layerOf = new Map(nodes.map((n) => [n.id, n.layer]));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = p.get(ids[i]);
      const b = p.get(ids[j]);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (layerOf.get(ids[i]) === layerOf.get(ids[j])) { sumSame += d; nSame++; }
      else { sumDiff += d; nDiff++; }
    }
  }
  return { same: sumSame / nSame, diff: sumDiff / nDiff };
}
const lgOn = layerGap(pos);
const lgOff = layerGap(posNoLayer);
t('同层聚团参数有效：关掉 layerCluster 后同层平均距变大',
  lgOff.same > lgOn.same,
  lgOn.same.toFixed(1) + ' → ' + lgOff.same.toFixed(1));

/** 布局规模（供人看，不作为判据） */
const xs = [...pos.values()].map((p) => p.x);
const ys = [...pos.values()].map((p) => p.y);

console.log('');
console.log('  规模: ' + nodes.length + ' 节点 / ' + edges.length + ' 边 · 收敛 ' + ms + 'ms');
console.log('  范围: X ' + Math.round(Math.min(...xs)) + '..' + Math.round(Math.max(...xs))
  + ' · Y ' + Math.round(Math.min(...ys)) + '..' + Math.round(Math.max(...ys)));
console.log('  相连平均距 ' + s.inAvg.toFixed(1) + ' · 不相连 ' + s.outAvg.toFixed(1)
  + ' · 最近 ' + s.minD.toFixed(1));
console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fail);
console.log('  四态: ' + (fail === 0 ? 'PASS —— 真力导向（可复算 + 有聚团 + 反例有效）' : 'FAIL —— 不满足力导向判据'));
console.log('');
process.exit(fail === 0 ? 0 : 1);