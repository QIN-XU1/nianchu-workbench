import fs from 'node:fs';
import { computeLayout } from './src/scene-star-map.js';
const d = JSON.parse(fs.readFileSync('data.json','utf8'));
const lay = computeLayout(d.nodes, d.edges, 960, 340);
const key = e => `${e.from}\u0000${e.to}\u0000${e.kind||'flow'}`;
function qbez(p0,p1,p2,t){const u=1-t;return{x:u*u*p0.x+2*u*t*p1.x+t*t*p2.x, y:u*u*p0.y+2*u*t*p1.y+t*t*p2.y};}
let bad=0;
console.log('routes size', lay.routes.size, 'edges', d.edges.length);
for(const e of d.edges){
  const a=lay.pos.get(e.from), b=lay.pos.get(e.to);
  const bow = lay.routes.get(key(e)) || 0;
  const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy)||1;
  const nx=-dy/len, ny=dx/len;
  const mx=(a.x+b.x)/2, my=(a.y+b.y)/2;
  const ctrl={x:mx+nx*bow*2, y:my+ny*bow*2};
  const hit=[];
  for(let t=0;t<=1.0001;t+=0.01){
    const p=qbez({x:a.x,y:a.y},ctrl,{x:b.x,y:b.y},t);
    for(const [id,q] of lay.pos){ if(id===e.from||id===e.to)continue;
      if(Math.hypot(p.x-q.x,p.y-q.y)<q.r+2 && !hit.includes(id)) hit.push(id); }
  }
  if(hit.length)bad++;
  console.log(`${hit.length?'X':'ok'} ${e.from.padEnd(20)}-> ${e.to.padEnd(20)} bow=${String(bow).padStart(4)} ${hit.join(',')}`);
}
console.log(bad? `\nFAIL ${bad}` : '\nPASS all edges clear of nodes');
