import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'star-render');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function req(url, saveName) {
  const script = path.join(HERE, '_r.ps1');
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 30 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0';'Accept'='application/json'}
  [IO.File]::WriteAllText($args[1], $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,40))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy','Bypass','-File', script, url, path.join(OUT, saveName)], {
    encoding: 'utf8', timeout: 45000, maxBuffer: 20 * 1024 * 1024,
  });
  try { fs.unlinkSync(script); } catch (e) {}
  return (r.stdout || '').trim();
}

console.log('═══════════════════════════════════════════════════════');
console.log('  搜索：星点/发光节点的专业渲染技法');
console.log('═══════════════════════════════════════════════════════');
console.log();

// ═══ A. GitHub 搜索真实渲染代码 ═══
const QUERIES = [
  'star+glow+canvas+in:name',
  'diffraction+spikes+glsl',
  'airy+disk+shader',
  'bloom+particle+canvas',
  'star+shader+twinkle',
];

for (const q of QUERIES) {
  const url = 'https://api.github.com/search/repositories?q=' + q + '&sort=stars&per_page=5';
  const raw = req(url, 'gh-' + q.replace(/[^a-z]/gi, '') + '.json');
  if (!raw.startsWith('{')) {
    console.log('  ✗ ' + q + '  ' + raw.slice(0, 35));
    continue;
  }
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(OUT, 'gh-' + q.replace(/[^a-z]/gi, '') + '.json'), 'utf8')); } catch (e) { continue; }
  if (j.message) { console.log('  ✗ ' + q + '  ' + j.message.slice(0, 40)); continue; }

  console.log('  ── ' + q + ' ──');
  for (const repo of (j.items || []).slice(0, 4)) {
    console.log('    ★' + String(repo.stargazers_count).padStart(5) + '  ' +
      repo.full_name.padEnd(40) + (repo.description || '').slice(0, 55));
  }
}

// ═══ B. 抓取已知的高质量技术文章/代码 ═══
console.log();
console.log('═══ 抓取技术参考 ═══');
console.log();

const CODE = [
  {
    n: 'shadertoy-airy',
    u: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/README.md',
    why: '探路',
  },
  {
    n: 'canvas-glow-tutorial',
    u: 'https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/canvas_api/tutorial/applying_styles_and_colors/index.md',
    why: 'MDN canvas 样式',
  },
  {
    n: 'threejs-stars',
    u: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgl_points_sprites.html',
    why: 'Three.js 星点渲染官方示例',
  },
  {
    n: 'threejs-bloom',
    u: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgl_postprocessing_unreal_bloom.html',
    why: 'Bloom 后处理官方示例',
  },
];

for (const c of CODE) {
  const r = req(c.u, c.n + '.txt');
  const f = path.join(OUT, c.n + '.txt');
  const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
  const ok = r.startsWith('OK') && size > 500;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + c.n.padEnd(26) + r.slice(0, 32).padEnd(38) + Math.round(size / 1024) + 'KB');
  if (!ok && fs.existsSync(f) && size < 500) { try { fs.unlinkSync(f); } catch (e) {} }
}
