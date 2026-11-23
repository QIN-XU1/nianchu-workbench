import { computeLayout, layoutForce2D } from './src/scene-star-map.js';
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('data.json','utf8'));

// 1) 确定性：同一输入 3 次，坐标必须逐位相同
const a = computeLayout(d.nodes,d.edges,960,340);
const b = computeLayout(d.nodes,d.edges,960,340);
const c = computeLayout(d.nodes,d.edges,960,340);
const same = JSON.stringify([...a.pos])===JSON.stringify([...b.pos]) && JSON.stringify([...b.pos])===JSON.stringify([...c.pos]);
console.log('确定性 x3:', same ? 'PASS' : 'FAIL');

// 2) 不同尺寸下都不重叠不越界
for(const [W,H] of [[1000,400],[900,340],[800,320],[700,340],[680,320],[1200,400]]){
  const L = computeLayout(d.nodes,d.edges,W,H);
  let ok=true, minGap=Infinity;
  const pts=[...L.pos.values()];
  for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){
    const dd=Math.hypot(pts[i].x-pts[j].x,pts[i].y-pts[j].y)-pts[i].r-pts[j].r;
    minGap=Math.min(minGap,dd);
    if(dd<0) ok=false;
  }
  for(const p of pts) if(p.x-p.r<0||p.x+p.r>W||p.y-p.r<0||p.y+p.r>H) ok=false;
  // 标签重叠
  const boxes=[...L.labels.entries()].map(([id,l])=>{
    const w=(()=>{let t=0;for(const ch of l.text)t+=/[\u2e80-\u9fff]/.test(ch)?1:0.55;return t*11;})();
    return {id,x0:l.x-w/2,x1:l.x+w/2,y0:l.y-10,y1:l.y+3};
  });
  let lbl=0;
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
    const A=boxes[i],B=boxes[j];
    if(A.x0<B.x1&&B.x0<A.x1&&A.y0<B.y1&&B.y0<A.y1) lbl++;
  }
  console.log(`  ${W}x${H}: 圆 ${ok?'ok':'FAIL'} minGap=${minGap.toFixed(1)} 标签重叠=${lbl}`);
}

// 3) 边界输入：空 / 单节点 / 无连线 / 环
const cases=[
  ['空',[],[]],
  ['单节点',[{id:'a',name:'A'}],[]],
  ['两节点无边',[{id:'a',name:'A'},{id:'b',name:'B'}],[]],
  ['环',[{id:'a',name:'A'},{id:'b',name:'B'}],[{from:'a',to:'b',kind:'flow'},{from:'b',to:'a',kind:'flow'}]],
  ['自环',[{id:'a',name:'A'}],[{from:'a',to:'a',kind:'flow'}]],
];
for(const [name,nodes,edges] of cases){
  try{
    const L=computeLayout(nodes,edges,960,340);
    const finite=[...L.pos.values()].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.r));
    console.log(`  ${name}: ${finite?'ok':'NaN!'} pos=${JSON.stringify([...L.pos.entries()].map(([k,v])=>[k,Math.round(v.x),Math.round(v.y)]))}`);
  }catch(e){ console.log(`  ${name}: THROW ${e.message}`); }
}
