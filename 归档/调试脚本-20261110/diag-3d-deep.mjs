const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('连接失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 30000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 400) };
      return r.result?.value;
    },
    close() { try { ws.close(); } catch {} }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

console.log('═══ 3D 神经元内部状态 ═══');
console.log();

// 找 neuron 实例（可能挂在别处）
const found = await cdp.eval(`(function(){
  var G = window.__WB || {};
  return {
    hasNeuron3d: !!(G.neuron3d),
    len: G.neuron3d ? G.neuron3d.length : 0,
    hasRegistry: !!G.registry,
    panelTypes: G.registry && G.registry.types ? G.registry.types() : [],
    neuronPanelExists: !!document.querySelector('[data-panel-type="neuron"]'),
  };
})()`);
console.log(JSON.stringify(found, null, 2));

// 直接从 DOM 拿 canvas 并分析
console.log();
const canvasInfo = await cdp.eval(`(function(){
  var p = document.querySelector('[data-panel-type="neuron"]');
  if(!p) return {error:'no neuron panel'};
  var cv = p.querySelector('canvas');
  if(!cv) return {error:'no canvas'};
  var ctx = cv.getContext('2d');
  // 采样像素统计
  var W = cv.width, H = cv.height;
  var data = ctx.getImageData(0,0,W,H).data;
  var lit = 0, total = 0;
  for(var i=0;i<data.length;i+=4*100){
    total++;
    var r=data[i],g=data[i+1],b=data[i+2];
    if(r>40||g>40||b>40) lit++;
  }
  return {
    canvasW: W, canvasH: H,
    totalSampled: total,
    brightPixels: lit,
    brightRatio: (lit/total*100).toFixed(1)+'%',
  };
})()`);
console.log(JSON.stringify(canvasInfo, null, 2));

// 检查 neuron 实例的 state
console.log();
const st = await cdp.eval(`(function(){
  // 从 registry 拿不到实例，试从全局找
  if (window.__WB && window.__WB.neuron3d && window.__WB.neuron3d.length) {
    var S = window.__WB.neuron3d[0].state;
    var nodes = S.visNodes || S.nodes || [];
    return {
      count: nodes.length,
      layers: nodes.reduce(function(acc, n){
        var k = (n.shell===0||n.shell===0.0)?'core':(n.shell<0.9?'mem':'scene');
        acc[k]=(acc[k]||0)+1; return acc;
      }, {}),
      samples: nodes.slice(0,8).map(function(n){
        return {label:n.label, type:n.type, shell:n.shell, r:n.r,
          x: n.x===null?'NULL':Math.round(n.x*100)/100,
          y: n.y===null?'NULL':Math.round(n.y*100)/100,
          z: n.z===null?'NULL':Math.round(n.z*100)/100};
      }),
    };
  }
  return {error:'no instance'};
})()`);
console.log(JSON.stringify(st, null, 2).slice(0, 1200));

cdp.close();
