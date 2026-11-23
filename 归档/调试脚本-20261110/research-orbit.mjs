import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'orbit');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function get(url, saveName) {
  const script = path.join(HERE, '_g.ps1');
  const f = path.join(OUT, saveName);
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 35 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0';'Accept'='text/plain,application/json,text/html'}
  [IO.File]::WriteAllText($args[1], $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,42))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy','Bypass','-File', script, url, f], {
    encoding: 'utf8', timeout: 50000,
  });
  try { fs.unlinkSync(script); } catch (e) {}
  const res = (r.stdout || '').trim();
  const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
  return { res, size, f };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  调研：专业项目的轨道相机/旋转控制实现');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ═══ Three.js OrbitControls（业界标准）═══
const TARGETS = [
  {
    n: 'orbitcontrols',
    u: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/controls/OrbitControls.js',
    why: '★ Three.js 官方 OrbitControls（所有 3D 项目的标准）',
  },
  {
    n: 'arcball',
    u: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/controls/ArcballControls.js',
    why: 'Arcball（轨迹球，另一种交互范式）',
  },
  {
    n: 'trackball',
    u: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/controls/TrackballControls.js',
    why: 'Trackball（不受上下方向限制）',
  },
  {
    n: 'mapbox-gl-drag',
    u: 'https://raw.githubusercontent.com/mapbox/mapbox-gl-js/main/src/ui/handler/drag_rotate.js',
    why: 'Mapbox 旋转手势（地图行业标杆）',
  },
];

const got = [];
for (const t of TARGETS) {
  const r = get(t.u, t.n + '.js');
  const ok = r.res.startsWith('OK') && r.size > 2000;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + t.n.padEnd(20) + r.res.slice(0, 34).padEnd(38) + Math.round(r.size / 1024) + 'KB  ' + t.why);
  if (ok) got.push({ ...t, f: r.f, size: r.size });
  else if (fs.existsSync(r.f) && r.size < 2000) { try { fs.unlinkSync(r.f); } catch (e) {} }
}

console.log();
console.log('  成功 ' + got.length + ' / ' + TARGETS.length);
fs.writeFileSync(path.join(OUT, 'got.json'), JSON.stringify(got.map(g => ({ n: g.n, size: g.size })), null, 2), 'utf8');
