import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'search2');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function req(url) {
  const script = path.join(HERE, '_r2.ps1');
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 30 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0';'Accept'='application/vnd.github+json'}
  Write-Output $r.Content
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,40))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy','Bypass','-File', script, url], {
    encoding: 'utf8', timeout: 45000, maxBuffer: 20 * 1024 * 1024,
  });
  try { fs.unlinkSync(script); } catch (e) {}
  return (r.stdout || '').trim();
}

// ══════════════════════════════════════════════════════════════
//  更精确的查询 + 不限制 stars（先看有什么）
// ══════════════════════════════════════════════════════════════
const QUERIES = [
  { q: 'topic:threejs+topic:visualization', label: 'ThreeJS 可视化' },
  { q: 'galaxy+in:name+language:JavaScript', label: 'galaxy 命名' },
  { q: 'starfield+in:name', label: 'starfield 命名' },
  { q: 'topic:graph-visualization', label: '图可视化主题' },
  { q: 'topic:knowledge-graph', label: '知识图谱主题' },
  { q: 'topic:force-graph', label: '力导向图主题' },
  { q: 'topic:dark-theme+language:TypeScript', label: '暗色主题' },
  { q: 'topic:dashboard+stars:>1000', label: '面板(★1000+)' },
  { q: 'topic:data-visualization+stars:>2000', label: '数据可视化(★2000+)' },
  { q: 'topic:solar-system', label: '太阳系' },
  { q: 'topic:particle-system+stars:>500', label: '粒子系统' },
  { q: 'topic:canvas+stars:>3000', label: 'Canvas(★3000+)' },
];

console.log('═══════════════════════════════════════════════════════════════');
console.log('  GitHub 精确搜索（第二轮）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

const all = [];

for (const item of QUERIES) {
  const url = 'https://api.github.com/search/repositories?q=' +
    item.q + '&sort=stars&order=desc&per_page=8';
  const raw = req(url);

  if (!raw.startsWith('{')) {
    console.log('  ✗ ' + item.label + '  ' + raw.slice(0, 40));
    continue;
  }

  let j;
  try { j = JSON.parse(raw); } catch (e) { console.log('  ✗ ' + item.label + ' JSON错误'); continue; }

  if (j.message) {
    console.log('  ✗ ' + item.label + '  ' + j.message.slice(0, 50));
    continue;
  }

  console.log('  ── ' + item.label + ' (' + (j.total_count || 0) + ' 个) ──');
  for (const repo of (j.items || [])) {
    const line = {
      name: repo.full_name,
      stars: repo.stargazers_count,
      desc: (repo.description || '').slice(0, 85),
      url: repo.html_url,
      lang: repo.language,
      category: item.label,
      topics: (repo.topics || []).slice(0, 6),
    };
    all.push(line);
    console.log('    ★' + String(repo.stargazers_count).padStart(6) + '  ' +
      repo.full_name.padEnd(44) + line.desc);
  }
  console.log();
}

const uniq = [];
const seen = new Set();
for (const r of all) {
  if (seen.has(r.name)) continue;
  seen.add(r.name);
  uniq.push(r);
}
uniq.sort((a, b) => b.stars - a.stars);

fs.writeFileSync(path.join(OUT, 'github-search2.json'), JSON.stringify(uniq, null, 2), 'utf8');
console.log('  共 ' + uniq.length + ' 个（去重后）');
