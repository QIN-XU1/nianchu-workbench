import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'search2');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function fetchHtml(url, saveName) {
  const script = path.join(HERE, '_fh.ps1');
  const f = path.join(OUT, saveName);
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 30 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';'Accept'='text/html,application/xhtml+xml'}
  [IO.File]::WriteAllText($args[1], $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,45))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy','Bypass','-File', script, url, f], {
    encoding: 'utf8', timeout: 45000,
  });
  try { fs.unlinkSync(script); } catch (e) {}
  return (r.stdout || '').trim();
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  设计参考源（网页抓取）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

const SOURCES = [
  // ★ 图可视化项目主页（有大量实时 demo）
  ['antvis G6',        'https://g6.antv.antgroup.com/examples'],
  ['antvis G6 官网',    'https://g6.antv.antgroup.com/'],
  ['3d-force-graph',   'https://vasturiano.github.io/3d-force-graph/example/large-graph/'],
  ['bloom 示例',        'https://vasturiano.github.io/3d-force-graph/example/bloom-effect/'],
  ['cosmograph',       'https://cosmograph.app/run/'],
  ['sigma 官网',        'https://www.sigmajs.org/'],
  // 设计灵感
  ['Awwwards 暗色',     'https://www.awwwards.com/websites/dark/'],
  ['Dribbble 暗色',     'https://dribbble.com/search/dark-dashboard'],
  ['CodePen 星空',      'https://codepen.io/search/pens?q=starfield'],
  ['CodePen 粒子',      'https://codepen.io/search/pens?q=particles+nebula'],
  // 中文大屏
  ['DataV 大屏',        'http://datav.aliyun.com/portal/school/atlas/area_selector'],
];

const ok = [];

for (const [name, url] of SOURCES) {
  const fname = name.replace(/[^\w\u4e00-\u9fa5]/g, '-') + '.html';
  const res = fetchHtml(url, fname);
  let size = 0;
  const f = path.join(OUT, fname);
  if (fs.existsSync(f)) size = fs.statSync(f).size;

  const status = res.startsWith('OK') ? '✓' : '✗';
  console.log('  ' + status + ' ' + name.padEnd(18) + res.slice(0, 40).padEnd(42) + Math.round(size / 1024) + 'KB');

  if (res.startsWith('OK') && size > 8000) ok.push({ name, url, f, size });
}

console.log();
console.log('  可用: ' + ok.length + ' / ' + SOURCES.length);
fs.writeFileSync(path.join(OUT, 'sources.json'), JSON.stringify(ok, null, 2), 'utf8');
