import { computeLayout } from './src/scene-star-map.js';
import fs from 'node:fs';
const d=JSON.parse(fs.readFileSync('data.json','utf8'));
function tw(s){let t=0;for(const c of s)t+=/[\u2e80-\u9fff\uff00-\uffef]/.test(c)?1:0.55;return t*11;}
for(const [W,H] of [[960,340],[720,340],[800,320],[680,320]]){
  const L=computeLayout(d.nodes,d.edges,W,H);
  const q=(p0,p1,p2,t)=>{const u=1-t;return{x:u*u*p0.x+2*u*t*p1.x+t*t*p2.x,y:u*u*p0.y+2*u*t*p1.y+t*t*p2.y};};
  let hits=0, names=[];
  for(const e of d.edges){
    const a=L.pos.get(e.from),b=L.pos.get(e.to);
    const bow=(L.routes.get(`${e.from}\u0000${e.to}\u0000${e.kind||'flow'}`)||0)+(e.bow||0);
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;
    const ctrl={x:(a.x+b.x)/2+(-dy/len)*bow*2,y:(a.y+b.y)/2+(dx/len)*bow*2};
    for(let t=0.02;t<=0.98;t+=0.02){
      const p=q({x:a.x,y:a.y},ctrl,{x:b.x,y:b.y},t);
      for(const [id,l] of L.labels){
        const w=tw(l.text);
        if(p.x>l.x-w/2-1&&p.x<l.x+w/2+1&&p.y>l.y-10&&p.y<l.y+3){ if(!names.includes(`${e.from}->${e.to}@${id}`)) names.push(`${e.from}->${e.to}@${id}`); }
      }
    }
  }
  console.log(`${W}x${H}: 标签被边穿过 ${names.length} 处 ${names.length?names.join(', '):''}`);
}
