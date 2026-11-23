import { layoutForce2D, computeLayout } from './src/scene-star-map.js';
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('data.json','utf8'));
const f = layoutForce2D(d.nodes,d.edges,960,340);
const pts=[...f.pos.values()];
let minGap=Infinity, ok=true;
for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){
  const dd=Math.hypot(pts[i].x-pts[j].x,pts[i].y-pts[j].y)-pts[i].r-pts[j].r;
  minGap=Math.min(minGap,dd); if(dd<0)ok=false;
}
const arr=[...f.pos.entries()].map(([id,p])=>`${id}:${p.x.toFixed(0)},${p.y.toFixed(0)}`);
console.log('力导向 无重叠:', ok?'PASS':'FAIL', 'minGap='+minGap.toFixed(1));
console.log(arr.join('  '));

// 力导向确定性
const f2 = layoutForce2D(d.nodes,d.edges,960,340);
console.log('力导向确定性:', JSON.stringify([...f.pos])===JSON.stringify([...f2.pos])?'PASS':'FAIL');

// 9 节点 3x3 网格化程度：看是否"摊成一个团"
const L = computeLayout(d.nodes,d.edges,960,340);
const lp=[...L.pos.values()];
const ys=new Set(lp.map(p=>Math.round(p.y/40)));
console.log('\n分层布局 纵向占位档数:', ys.size, '(越少越像摊平)');
