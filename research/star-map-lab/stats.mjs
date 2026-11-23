import { computeLayout, computeLayers } from './src/scene-star-map.js';
import fs from 'node:fs';
const d=JSON.parse(fs.readFileSync('data.json','utf8'));
const L=computeLayout(d.nodes,d.edges,960,340);
console.log('层:',JSON.stringify([...L.layer.entries()]));
console.log('度数:',JSON.stringify([...L.degree.entries()]));
console.log('半径:',[...L.pos.entries()].map(([k,v])=>`${k}=${v.r.toFixed(1)}`).join(' '));
console.log('列数:',L.maxLayer+1);
// 交叉数
let cross=0;
for(let li=0;li<L.maxLayer;li++){
  const A=[...L.pos.entries()].filter(([,p])=>p.layer===li);
  const B=[...L.pos.entries()].filter(([,p])=>p.layer===li+1);
  const ai=new Map(A.map(([k,p],i)=>[k,i])), bi=new Map(B.map(([k,p],i)=>[k,i]));
  const links=[];
  for(const e of d.edges){ if(ai.has(e.from)&&bi.has(e.to)) links.push([ai.get(e.from),bi.get(e.to)]); }
  for(let i=0;i<links.length;i++)for(let j=i+1;j<links.length;j++)
    if((links[i][0]-links[j][0])*(links[i][1]-links[j][1])<0) cross++;
}
console.log('相邻层交叉数:',cross);
