import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'interactive');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function get(url, saveName) {
  const script = path.join(HERE, '_g3.ps1');
  const f = path.join(OUT, saveName);
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 32 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';'Accept'='text/html,application/json'}
  [IO.File]::WriteAllText($args[1], $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,42))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy','Bypass','-File', script, url, f], { encoding: 'utf8', timeout: 45000 });
  try { fs.unlinkSync(script); } catch (e) {}
  const res = (r.stdout || '').trim();
  const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
  return { res, size, f };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  搜索：交互式星空 / 星点随机闪烁 / 背景与前景互动');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ══════════════════════════════════════════════════════════════
//  A. Google 搜索（抓 HTML 提取链接）
// ══════════════════════════════════════════════════════════════
const GOOGLE_QUERIES = [
  'interactive starfield canvas mouse parallax tutorial',
  'canvas stars random appear twinkle disappear respawn',
  'particle background react to mouse canvas codepen',
  'constellation lines interactive background canvas',
];

console.log('【A】Google 搜索（提取结果链接）');
console.log();

for (let qi = 0; qi < GOOGLE_QUERIES.length; qi++) {
  const q = GOOGLE_QUERIES[qi];
  const url = 'https://www.google.com/search?q=' + encodeURIComponent(q) + '&num=10';
  const r = get(url, 'google-' + qi + '.html');

  if (!r.res.startsWith('OK')) {
    console.log('  ✗ ' + q.slice(0, 50) + '  ' + r.res.slice(0, 35));
    continue;
  }

  const html = fs.readFileSync(r.f, 'utf8');
  // 提取外部链接
  const links = new Set();
  const re = /https?:\/\/(?:www\.)?([a-zA-Z0-9.-]+)\/[^\s"'<>]{0,80}/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const host = m[1];
    if (host.includes('google') || host.includes('gstatic') || host.includes('schema')) continue;
    if (host.includes('youtube.com') || host.includes('w3.org')) continue;
    links.add(m[0]);
  }

  console.log('  ── ' + q + ' ──');
  console.log('     抓到 ' + links.size + ' 个链接，HTML ' + Math.round(r.size/1024) + 'KB');
  const arr = [...links].slice(0, 6);
  for (const l of arr) console.log('       ' + l.slice(0, 100));
  console.log();
}

// ══════════════════════════════════════════════════════════════
//  B. 直接抓取已知的高质量实现（GitHub raw）
// ══════════════════════════════════════════════════════════════
console.log();
console.log('【B】直接抓取高质量实现源码');
console.log();

const CODE_TARGETS = [
  {
    name: 'react-starfield-animation',
    url: 'https://raw.githubusercontent.com/transitive-bullshit/react-starfield-animation/master/README.md',
    why: '★114 星，Canvas 星空动画',
  },
  {
    name: 'dwmkerr-starfield',
    url: 'https://raw.githubusercontent.com/dwmkerr/starfield/master/index.html',
    why: '★56 纯 JS 星空',
  },
  {
    name: 'three-nebula',
    url: 'https://raw.githubusercontent.com/creativelifeform/three-nebula/master/README.md',
    why: '★1249 WebGL 粒子引擎',
  },
  // 常见的 canvas 星点交互实现
  {
    name: 'particles-js',
    url: 'https://raw.githubusercontent.com/VincentGarreau/particles.js/master/README.md',
    why: '★28000+ 粒子背景（背景与鼠标互动标杆）',
  },
  {
    name: 'particles-config',
    url: 'https://raw.githubusercontent.com/VincentGarreau/particles.js/master/particles.js',
    why: 'particles.js 源码（可直接看交互实现）',
  },
  // react-tsparticles
  {
    name: 'tsparticles-readme',
    url: 'https://raw.githubusercontent.com/tsparticles/tsparticles/main/README.md',
    why: '★7000+ 粒子引擎（粒子与鼠标互动）',
  },
];

const got = [];
for (const t of CODE_TARGETS) {
  const r = get(t.url, t.name + '.txt');
  const good = r.res.startsWith('OK') && r.size > 500;
  console.log('  ' + (good ? '✓' : '✗') + ' ' + t.name.padEnd(28) + r.res.slice(0, 34).padEnd(38) + Math.round(r.size/1024) + 'KB  ' + t.why);
  if (good) got.push({ ...t, f: r.f, size: r.size });
}

console.log();
console.log('  成功 ' + got.length + ' / ' + CODE_TARGETS.length);
fs.writeFileSync(path.join(OUT, 'got.json'), JSON.stringify(got.map(g => ({name:g.name,why:g.why,size:g.size})), null, 2), 'utf8');
