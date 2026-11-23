import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'mingli');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function fetchPs(url, outFile) {
  const script = path.join(HERE, '_f.ps1');
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 25 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
  [IO.File]::WriteAllText($args[1], $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,40))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script, url, outFile], { encoding: 'utf8', timeout: 40000 });
  try { fs.unlinkSync(script); } catch (e) {}
  return (r.stdout || '').trim();
}

// 用百度百科（中文，不用维基）
const TARGETS = [
  { name: 'ziwei', kw: '紫微斗数', label: '紫微斗数' },
  { name: 'qimen', kw: '奇门遁甲', label: '奇门遁甲' },
  { name: 'liuyao', kw: '六爻', label: '六爻' },
  { name: 'bazi', kw: '四柱八字', label: '八字' },
  { name: 'yijing', kw: '易经', label: '易经' },
  { name: 'wuxing', kw: '五行', label: '五行' },
  { name: 'liuren', kw: '大六壬', label: '大六壬' },
];

console.log('═══════════════════════════════════════════════════════════════');
console.log('  抓取命理资料（百度百科）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

for (const t of TARGETS) {
  const url = 'https://baike.baidu.com/item/' + encodeURIComponent(t.kw);
  const f = path.join(OUT, t.name + '-baidu.html');
  const res = fetchPs(url, f);
  let size = 0;
  if (fs.existsSync(f)) size = fs.statSync(f).size;
  console.log('  ' + t.label.padEnd(10) + res.slice(0, 55) + '  文件 ' + Math.round(size / 1024) + 'KB');
}

console.log();
console.log('  输出: ' + OUT);
