import fs from 'node:fs';

const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 8000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
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
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const page = targets.find(t => t.type === 'page');
const cdp = CDP(page.webSocketDebuggerUrl);
await cdp.connect();

const OUT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\screens`;

// 等布局稳定
await new Promise(r => setTimeout(r, 2000));

const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
if (s && s.data) {
  const f = OUT + '\\ui-v2-01.png';
  fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
  console.log('OK ' + f + '  ' + Math.round(fs.statSync(f).size / 1024) + ' KB');
}

// 详细布局测量：找出溢出/挤压问题
const m = await cdp.eval(`(function(){
  var out = [];
  function chk(el, name){
    if(!el) return;
    var r = el.getBoundingClientRect();
    out.push({
      name: name,
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y),
    });
  }
  chk(document.querySelector('.wb-titlebar'), 'titlebar');
  chk(document.querySelector('.wb-scenebar'), 'scenebar');
  chk(document.querySelector('.wb-main'), 'main');
  chk(document.querySelector('.wb-side'), 'side');
  chk(document.querySelector('.wb-grid'), 'grid');
  chk(document.querySelector('.wb-footbar'), 'footbar');

  var panels = document.querySelectorAll('.wb-panel');
  for(var i=0;i<panels.length;i++){
    var r = panels[i].getBoundingClientRect();
    out.push({ name:'panel'+i+'['+(panels[i].dataset.panelType||'?')+']', w:Math.round(r.width), h:Math.round(r.height) });
  }

  // 检查竖排文字（旧界面的老毛病）
  var vertical = 0;
  document.querySelectorAll('*').forEach(function(el){
    var t = (el.textContent||'').trim();
    if(t.length>2 && t.length<40 && el.children.length===0){
      var r = el.getBoundingClientRect();
      if(r.width>0 && r.height>0 && r.width < 28 && r.height > r.width*3) vertical++;
    }
  });

  return { boxes: out, verticalText: vertical, winW: window.innerWidth, winH: window.innerHeight };
})()`);

console.log();
console.log('═══ 布局测量 ═══');
console.log('  窗口: ' + m.winW + ' x ' + m.winH);
for (const b of m.boxes) {
  console.log('  ' + b.name.padEnd(22) + b.w + ' x ' + b.h + '  @(' + b.x + ',' + b.y + ')');
}
console.log();
console.log('  竖排文字元素数: ' + m.verticalText + (m.verticalText > 0 ? '  ⚠ 有问题' : '  ✓ 正常'));

cdp.close();
