const fs = require('fs');
const path = require('path');
const cn = /[\u4e00-\u9fff]/;
function scan(dir, label) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f)).slice(0, 30); } catch (e) { console.log(label, 'ERR', e.message); return; }
  const strings = new Set();
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const re = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m[2];
      if (s.length < 2 || s.length > 40 || !cn.test(s) || /[{}<>;=]/.test(s)) continue;
      strings.add(s);
      if (strings.size > 4000) break;
    }
  }
  const arr = [...strings];
  console.log(`\n=== ${label} === files=${files.length} uniqueCN=${arr.length}`);
  console.log('sample:', arr.slice(0, 25).join(' | '));
}
scan('D:/file/software/TapNow/resources/web', 'TapNow/resources/web');
scan('D:/file/software/raccoon-ai/resources/assets', 'raccoon-ai/resources/assets');
console.log('\n=== TapNow official-homepage.html title/head ===');
try {
  const h = fs.readFileSync('D:/file/software/TapNow/resources/web/official-homepage.html', 'utf8');
  const t = h.match(/<title>([^<]*)<\/title>/i);
  console.log('title:', t && t[1]);
  console.log('desc:', (h.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i) || [])[1]);
} catch (e) { console.log('ERR', e.message); }
