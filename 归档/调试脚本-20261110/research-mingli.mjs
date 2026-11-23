/**
 * 研究命理体系的算法机制（不是术语，是算法）
 *
 * 目标：找出这些体系中「可计算、可移植到软件架构」的机制
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'mingli');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// 用 PowerShell Invoke-WebRequest 抓页面（避免 Node 的 TLS/代理问题）
function fetchUrl(url, outFile) {
  const ps = `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 25 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
  [IO.File]::WriteAllText('${outFile}', $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
}
`;
  const r = spawnSync('powershell', ['-Command', ps], { encoding: 'utf8', timeout: 40000 });
  return (r.stdout || '').trim();
}

// ═══════════════════════════════════════════════════════════════
//  目标：各体系的算法机制（不是百科介绍，要算法）
// ═══════════════════════════════════════════════════════════════
const TARGETS = [
  // 紫微斗数：十二宫 + 安星
  { name: 'ziwei', url: 'https://zh.wikipedia.org/wiki/%E7%B6%BA%E7%B7%86%E6%96%96%E5%A6%99', label: '紫微斗数' },
  // 奇门遁甲：九宫 + 阴阳遁
  { name: 'qimen', url: 'https://zh.wikipedia.org/wiki/%E8%A1%8D%E5%A6%83%E5%B8%97%E5%BC%BE%E5%85%89', label: '奇门遁甲' },
  // 六爻
  { name: 'liuyao', url: 'https://zh.wikipedia.org/wiki/%E5%8D%9C%E5%AD%98', label: '卜卦' },
  // 易经
  { name: 'yijing', url: 'https://zh.wikipedia.org/wiki/%E5%91%B1%E6%98%99%E7%B8%A6%E7%B7%A4', label: '易经' },
  // 七政四余
  { name: 'qizheng', url: 'https://zh.wikipedia.org/wiki/%E5%A6%83%E6%BC%BC%E6%95%B8', label: '七政四余' },
  // 大六壬
  { name: 'liuren', url: 'https://zh.wikipedia.org/wiki/%E6%9D%B6%E6%8E%96%E5%BA%A6%E5%92%88', label: '六壬' },
];

console.log('═══════════════════════════════════════════════════════════════');
console.log('  研究命理体系的算法机制');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

for (const t of TARGETS) {
  const f = path.join(OUT, t.name + '.html');
  const res = fetchUrl(t.url, f);
  console.log('  ' + t.label.padEnd(12) + res.slice(0, 60));

  if (fs.existsSync(f)) {
    const html = fs.readFileSync(f, 'utf8');
    // 提取纯文本（粗略）
    const txt = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    fs.writeFileSync(path.join(OUT, t.name + '.txt'), txt, 'utf8');
    console.log('        文本长度: ' + txt.length);
  }
}

console.log();
console.log('  输出目录: ' + OUT);
