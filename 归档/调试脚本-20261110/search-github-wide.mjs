import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'search2');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function req(url) {
  const script = path.join(HERE, '_r.ps1');
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 30 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';'Accept'='application/json,text/html'}
  Write-Output $r.Content
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,50))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy','Bypass','-File', script, url], {
    encoding: 'utf8', timeout: 45000, maxBuffer: 20 * 1024 * 1024,
  });
  try { fs.unlinkSync(script); } catch (e) {}
  return (r.stdout || '').trim();
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  GitHub 广泛搜索：可视化 / 星域 / 图谱 / 布局');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ══════════════════════════════════════════════════════════════
//  多角度 GitHub 搜索
// ══════════════════════════════════════════════════════════════
const QUERIES = [
  // 视觉/图形
  { q: 'galaxy visualization three.js', label: '星系可视化' },
  { q: 'starfield canvas animation', label: '星空动画' },
  { q: 'particle nebula webgl', label: '粒子星云' },
  // 知识图谱
  { q: 'knowledge graph visualization web', label: '知识图谱' },
  { q: 'force graph 3d layout', label: '力导向3D布局' },
  { q: 'graph layout algorithm sphere', label: '球面图布局' },
  // 暗色 UI
  { q: 'dark theme dashboard design system', label: '暗色设计系统' },
  { q: 'observability dashboard UI', label: '可观测性面板' },
  { q: 'cyberpunk UI CSS', label: '赛博朋克UI' },
  // 中文项目
  { q: '知识图谱 可视化 前端', label: '知识图谱(中)' },
  { q: '大屏可视化 数据', label: '大屏可视化' },
];

const results = [];

for (const item of QUERIES) {
  const url = 'https://api.github.com/search/repositories?q=' +
    encodeURIComponent(item.q) + '&sort=stars&order=desc&per_page=6';
  const raw = req(url);
  if (!raw.startsWith('{')) {
    console.log('  ✗ ' + item.label.padEnd(16) + raw.slice(0, 40));
    continue;
  }

  let j;
  try { j = JSON.parse(raw); } catch (e) {
    console.log('  ✗ ' + item.label.padEnd(16) + 'JSON 解析失败');
    continue;
  }

  console.log('  ── ' + item.label + ' ──');
  for (const repo of (j.items || [])) {
    const stars = repo.stargazers_count;
    if (stars < 300) continue;
    const line = {
      name: repo.full_name,
      stars,
      desc: (repo.description || '').slice(0, 90),
      url: repo.html_url,
      lang: repo.language,
      topics: (repo.topics || []).slice(0, 5),
    };
    results.push({ ...line, category: item.label });
    console.log('    ★' + String(stars).padStart(6) + '  ' + repo.full_name.padEnd(42) + line.desc);
  }
  console.log();
}

// 去重
const uniq = [];
const seen = new Set();
for (const r of results) {
  if (seen.has(r.name)) continue;
  seen.add(r.name);
  uniq.push(r);
}

fs.writeFileSync(path.join(OUT, 'github-search.json'), JSON.stringify(uniq, null, 2), 'utf8');
console.log('  共找到 ' + uniq.length + ' 个高星项目（★300+）');
console.log('  存于 research/search2/github-search.json');
