import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'search2');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function get(url, saveName) {
  const script = path.join(HERE, '_g.ps1');
  const f = path.join(OUT, saveName);
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 35 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'}
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
  let size = 0;
  if (fs.existsSync(f)) size = fs.statSync(f).size;
  return { res, size, f };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  直接抓取真实源码（示例代码 / 配置 / 数据）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ══════════════════════════════════════════════════════════════
//  直接抓取真实的示例源码 —— 这才是能学到东西的
// ══════════════════════════════════════════════════════════════
const TARGETS = [
  // ★ 3d-force-graph 的 bloom 示例源码
  {
    name: 'bloom-example',
    url: 'https://raw.githubusercontent.com/vasturiano/3d-force-graph/master/example/bloom-effect/index.html',
    why: 'Bloom 完整实现',
  },
  // ★ 3d-force-graph 的 large-graph 示例
  {
    name: 'large-graph-example',
    url: 'https://raw.githubusercontent.com/vasturiano/3d-force-graph/master/example/large-graph/index.html',
    why: '4000 节点如何渲染',
  },
  // ★ 粒子示例
  {
    name: 'particles-example',
    url: 'https://raw.githubusercontent.com/vasturiano/3d-force-graph/master/example/directional-links-particles/index.html',
    why: '连线粒子完整实现',
  },
  // ★ highlight 示例
  {
    name: 'highlight-example',
    url: 'https://raw.githubusercontent.com/vasturiano/3d-force-graph/master/example/highlight/index.html',
    why: '高亮交互',
  },
  // ★ 拖拽固定
  {
    name: 'drag-fix-example',
    url: 'https://raw.githubusercontent.com/vasturiano/3d-force-graph/master/example/fix-dragged-nodes/index.html',
    why: '拖拽后固定节点',
  },
  // G6 的暗色主题配置
  {
    name: 'g6-dark-config',
    url: 'https://raw.githubusercontent.com/antvis/G6/master/packages/g6/src/themes/dark.ts',
    why: 'G6 暗色主题（12k星项目）',
  },
  // G6 亮色主题对比
  {
    name: 'g6-light-config',
    url: 'https://raw.githubusercontent.com/antvis/G6/master/packages/g6/src/themes/light.ts',
    why: 'G6 亮色主题',
  },
];

const ok = [];
for (const t of TARGETS) {
  const r = get(t.url, t.name + '.txt');
  const good = r.res.startsWith('OK') && r.size > 400;
  console.log('  ' + (good ? '✓' : '✗') + ' ' + t.name.padEnd(22) + r.res.slice(0, 38).padEnd(40) + Math.round(r.size / 1024) + 'KB  ' + t.why);
  if (good) ok.push({ ...t, f: r.f, size: r.size });
}

console.log();
console.log('  成功 ' + ok.length + ' / ' + TARGETS.length);
