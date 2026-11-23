import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'design-refs');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function fetchPs(url, outFile, useProxy) {
  const script = path.join(HERE, '_f2.ps1');
  const proxyLine = useProxy
    ? "-Proxy 'http://127.0.0.1:7897'"
    : '';
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 25 ${proxyLine} -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';'Accept'='text/html,application/xhtml+xml'}
  [IO.File]::WriteAllText($args[1], $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,50))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script, url, outFile], {
    encoding: 'utf8', timeout: 35000,
  });
  try { fs.unlinkSync(script); } catch (e) {}
  return (r.stdout || '').trim();
}

// ══════════════════════════════════════════════════════════════
//  目标：可访问的设计参考源
// ══════════════════════════════════════════════════════════════

// 1. 先测基本连通性
const TESTS = [
  ['GitHub Trending', 'https://github.com/trending'],
  ['Dribbble', 'https://dribbble.com/shots/popular/web-design'],
  ['Awwwards', 'https://www.awwwards.com/websites/'],
  ['CodePen', 'https://codepen.io/topic/dark-theme'],
  ['CSS Design Awards', 'https://www.cssdesignawards.com/'],
];

console.log('═══════════════════════════════════════════════════════════════');
console.log('  设计参考源连通性测试');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

const working = [];

for (const [name, url] of TESTS) {
  const f = path.join(OUT, name.replace(/\s+/g, '-').toLowerCase() + '.html');
  const res = fetchPs(url, f, true);
  let size = 0;
  if (fs.existsSync(f)) size = fs.statSync(f).size;
  console.log('  ' + name.padEnd(24) + res.slice(0, 45) + '  ' + Math.round(size / 1024) + 'KB');
  if (res.startsWith('OK') && size > 10000) working.push({ name, url, f });
}

console.log();
console.log('  可用源: ' + working.length + ' / ' + TESTS.length);
if (working.length) {
  for (const w of working) console.log('    ✓ ' + w.name);
}
