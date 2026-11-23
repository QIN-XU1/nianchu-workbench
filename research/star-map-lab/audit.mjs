/**
 * 布局体检：不靠肉眼，用数字判定
 *   - 节点圆是否互不重叠
 *   - 节点圆是否越界
 *   - 标签是否互相重叠（矩形相交）
 *   - 标签是否和别的节点圆压在一起
 *   - 展开长度是否超出画布
 *   - 确定性（同一输入跑两次结果必须逐位相同）
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeLayout, layoutForce2D } from './src/scene-star-map.js';

const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data.json'), 'utf8'));
const W = 960;
const H = 340;

function w2(s, fs) {
  let t = 0;
  for (const ch of String(s)) t += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  return t * fs;
}

function audit(lay, label) {
  const pts = [...lay.pos.entries()];
  const issues = [];

  // 1. 圆重叠
  let minGap = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const [, a] = pts[i];
      const [, b] = pts[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      minGap = Math.min(minGap, d - a.r - b.r);
      if (d < a.r + b.r) issues.push(`圆重叠 ${pts[i][0]} / ${pts[j][0]}  d=${d.toFixed(1)} < ${(a.r + b.r).toFixed(1)}`);
    }
  }

  // 2. 越界
  for (const [id, p] of pts) {
    if (p.x - p.r < 0 || p.x + p.r > W || p.y - p.r < 0 || p.y + p.r > H) {
      issues.push(`圆越界 ${id} (${p.x.toFixed(0)},${p.y.toFixed(0)},r=${p.r.toFixed(1)})`);
    }
  }

  // 3. 标签框
  const boxes = [];
  for (const [id, l] of lay.labels) {
    const bw = w2(l.text, 11);
    boxes.push({ id, x0: l.x - bw / 2, x1: l.x + bw / 2, y0: l.y - 10, y1: l.y + 3, text: l.text });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i];
      const B = boxes[j];
      if (A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1) {
        issues.push(`标签重叠 ${A.id}("${A.text}") / ${B.id}("${B.text}")`);
      }
    }
  }

  // 4. 标签压到别的节点圆
  for (const bx of boxes) {
    for (const [id, p] of pts) {
      if (id === bx.id) continue;
      const cx = Math.max(bx.x0, Math.min(p.x, bx.x1));
      const cy = Math.max(bx.y0, Math.min(p.y, bx.y1));
      if (Math.hypot(p.x - cx, p.y - cy) < p.r) issues.push(`标签压节点 ${bx.id} 压到 ${id}`);
    }
  }

  // 5. 标签出画布
  for (const bx of boxes) {
    if (bx.x0 < 0 || bx.x1 > W || bx.y0 < 0 || bx.y1 > H) issues.push(`标签越界 ${bx.id}`);
  }

  // 6. 边的长度
  const lens = [];
  for (const e of data.edges) {
    const a = lay.pos.get(e.from);
    const b = lay.pos.get(e.to);
    if (a && b) lens.push(Math.hypot(a.x - b.x, a.y - b.y));
  }
  lens.sort((x, y) => x - y);

  console.log(`\n── ${label} ────────────────────────────`);
  console.log(`  节点 ${pts.length} / 边 ${lens.length}`);
  console.log(`  最小圆间距 ${minGap.toFixed(1)}px`);
  console.log(`  边长 min/中位/max = ${lens[0].toFixed(0)} / ${lens[(lens.length / 2) | 0].toFixed(0)} / ${lens[lens.length - 1].toFixed(0)}`);
  console.log(`  列分布 ${[...new Set(pts.map(([, p]) => p.x.toFixed(0)))].join(', ')}`);
  if (issues.length) {
    console.log(`  ❌ ${issues.length} 个问题`);
    issues.forEach((s) => console.log('     - ' + s));
  } else {
    console.log('  ✅ 无重叠 / 无越界');
  }
  return { minGap, issues, lens };
}

const a = computeLayout(data.nodes, data.edges, W, H);
audit(a, '分层布局 (推荐)');

const b = computeLayout(data.nodes, data.edges, W, H);
const same = JSON.stringify([...a.pos]) === JSON.stringify([...b.pos]);
console.log(`\n确定性：两次布局逐位相同 → ${same ? '✅' : '❌'}`);

const f = layoutForce2D(data.nodes, data.edges, W, H);
audit(f, '二维力导向 (对照)');

// 出口给报告用
const dump = [...a.pos.entries()].map(([id, p]) => ({
  id, x: +p.x.toFixed(1), y: +p.y.toFixed(1), r: +p.r.toFixed(1), layer: p.layer,
}));
fs.writeFileSync(path.join(process.cwd(), 'layout-layered.json'), JSON.stringify(dump, null, 2));
const dumpF = [...f.pos.entries()].map(([id, p]) => ({ id, x: +p.x.toFixed(1), y: +p.y.toFixed(1) }));
fs.writeFileSync(path.join(process.cwd(), 'layout-force.json'), JSON.stringify(dumpF, null, 2));
