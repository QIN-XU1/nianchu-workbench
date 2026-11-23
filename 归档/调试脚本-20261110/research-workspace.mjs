import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'workspace-design');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function get(url, saveName, useProxy = true) {
  const script = path.join(HERE, '_g.ps1');
  const f = path.join(OUT, saveName);
  const proxyArg = useProxy ? "-Proxy 'http://127.0.0.1:7897'" : '';
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 30 ${proxyArg} -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';'Accept'='text/plain,application/json,text/html'}
  [IO.File]::WriteAllText($args[1], $r.Content, [Text.Encoding]::UTF8)
  Write-Output ('OK ' + $r.Content.Length)
} catch {
  Write-Output ('ERR ' + $_.Exception.Message.Substring(0,42))
}
`, 'utf8');
  const r = spawnSync('powershell', ['-ExecutionPolicy','Bypass','-File', script, url, f], {
    encoding: 'utf8', timeout: 45000,
  });
  try { fs.unlinkSync(script); } catch (e) {}
  const res = (r.stdout || '').trim();
  const size = fs.existsSync(f) ? fs.statSync(f).size : 0;
  return { res, size, f };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  搜索：AI Agent 工作台 / 多面板 / 场景化 工具的成熟做法');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// ═══ A. GitHub 搜索 ═══
const QUERIES = [
  { q: 'AI+agent+workspace+in:name+stars:>1000', label: 'AI Agent 工作台' },
  { q: 'multi+panel+dashboard+electron', label: '多面板 Electron' },
  { q: 'topic:ai-agent+topic:ui+stars:>500', label: 'AI Agent UI' },
  { q: 'topic:workflow-automation+stars:>2000', label: '工作流自动化' },
  { q: 'canvas+node+editor+stars:>3000', label: '画布节点编辑器' },
];

for (const item of QUERIES) {
  const url = 'https://api.github.com/search/repositories?q=' + item.q + '&sort=stars&per_page=6';
  const r = get(url, 'gh-' + item.q.replace(/[^a-z0-9]/gi, '') + '.json');
  if (!r.res.startsWith('OK')) { console.log('  XX ' + item.label + '  ' + r.res.slice(0, 30)); continue; }

  let j;
  try { j = JSON.parse(fs.readFileSync(r.f, 'utf8')); } catch (e) { continue; }
  if (j.message) { console.log('  XX ' + item.label + '  ' + j.message.slice(0, 30)); continue; }

  console.log('  ── ' + item.label + ' ──');
  for (const repo of (j.items || [])) {
    console.log('    ★' + String(repo.stargazers_count).padStart(6) + '  ' +
      repo.full_name.padEnd(38) + (repo.description || '').slice(0, 50));
  }
  console.log();
}
