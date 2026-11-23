import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'design-refs');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function fetchDirect(url, outFile) {
  const script = path.join(HERE, '_fd.ps1');
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 30 -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}
  [IO.File]::WriteAllText($args[1], $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,45))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script, url, outFile], {
    encoding: 'utf8', timeout: 40000,
  });
  try { fs.unlinkSync(script); } catch (e) {}
  return (r.stdout || '').trim();
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  直连抓取设计参考（代理已关闭，改用直连）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ══════════════════════════════════════════════════════════════
//  真正有价值的设计参考：GitHub 上的热门可视化/UI 项目
// ══════════════════════════════════════════════════════════════
const TARGETS = [
  // ★ 3D 星空 / 知识图谱类（最相关）
  {
    name: 'three-forcegraph',
    url: 'https://raw.githubusercontent.com/vasturiano/three-forcegraph/master/README.md',
    why: '3D 力导向图，最接近我们要的星域效果',
  },
  {
    name: '3d-force-graph',
    url: 'https://raw.githubusercontent.com/vasturiano/3d-force-graph/master/README.md',
    why: '3D 力导向图主库，大量示例',
  },
  {
    name: 'sigma.js',
    url: 'https://raw.githubusercontent.com/jacomyal/sigma.js/main/README.md',
    why: '专业图可视化库，2D/WebGL',
  },
  {
    name: 'cosmograph',
    url: 'https://raw.githubusercontent.com/cosmograph-org/cosmos/main/README.md',
    why: 'GPU 加速的大规模图可视化',
  },
  // UI 设计系统
  {
    name: 'radix-themes-dark',
    url: 'https://raw.githubusercontent.com/radix-ui/themes/main/packages/colors/src/dark.ts',
    why: 'Radix 暗色色阶（专业设计系统）',
  },
  {
    name: 'shadcn-globals',
    url: 'https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/www/styles/globals.css',
    why: 'shadcn 全局样式',
  },
  // 星空效果
  {
    name: 'starfield-effect',
    url: 'https://raw.githubusercontent.com/search?q=starfield',
    why: '',
  },
];

const results = [];

for (const t of TARGETS) {
  if (!t.url.startsWith('https://raw.githubusercontent.com/')) continue;
  const f = path.join(OUT, t.name + '.md');
  const res = fetchDirect(t.url, f);
  let size = 0;
  if (fs.existsSync(f)) {
    size = fs.statSync(f).size;
    if (size < 500) { try { fs.unlinkSync(f); } catch (e) {} size = 0; }
  }
  const ok = res.startsWith('OK') && size > 500;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + t.name.padEnd(24) + res.slice(0, 40) + '  ' + Math.round(size / 1024) + 'KB');
  if (ok) results.push({ ...t, f, size });
}

console.log();
console.log('  成功: ' + results.length);
