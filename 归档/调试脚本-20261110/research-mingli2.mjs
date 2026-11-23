import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'mingli');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function fetchUrl(url, outFile) {
  // 用 UTF-8 编码的 PowerShell 脚本，避免参数转义
  const script = path.join(HERE, '_fetch.ps1');
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 25 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
  [IO.File]::WriteAllText($args[1], $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
}
`, 'utf8');

  const r = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script, url, outFile], {
    encoding: 'utf8',
    timeout: 40000,
  });
  try { fs.unlinkSync(script); } catch (e) {}
  return (r.stdout || '').trim();
}

// 用正确的维基条目名（用 encodeURI 处理）
const TARGETS = [
  { name: 'ziwei', title: '紫微斗數', label: '紫微斗数' },
  { name: 'qimen', title: '奇門遁甲', label: '奇门遁甲' },
  { name: 'liuyao', title: '六爻', label: '六爻' },
  { name: 'yijing', title: '易經', label: '易经' },
  { name: 'bagua', title: '八卦', label: '八卦' },
  { name: 'wuxing', title: '五行', label: '五行' },
  { name: 'liuren', title: '大六壬', label: '大六壬' },
  { name: 'ziwei2', title: '七政四餘', label: '七政四余' },
  { name: 'bazi', title: '八字', label: '八字' },
  { name: 'tianGan', title: '天干', label: '天干' },
  { name: 'diZhi', title: '地支', label: '地支' },
];

console.log('═══════════════════════════════════════════════════════════════');
console.log('  抓取命理体系资料');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

const ok = [];
for (const t of TARGETS) {
  const url = 'https://zh.wikipedia.org/wiki/' + encodeURIComponent(t.title);
  const f = path.join(OUT, t.name + '.html');
  const res = fetchUrl(url, f);
  const status = res.slice(0, 30);
  console.log('  ' + t.label.padEnd(10) + status);

  if (fs.existsSync(f) && fs.statSync(f).size > 2000) {
    const html = fs.readFileSync(f, 'utf8');
    const txt = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    fs.writeFileSync(path.join(OUT, t.name + '.txt'), txt, 'utf8');
    ok.push({ name: t.name, label: t.label, len: txt.length });
    console.log('        文本 ' + txt.length + ' 字');
  }
}

console.log();
console.log('  成功: ' + ok.length + ' / ' + TARGETS.length);
