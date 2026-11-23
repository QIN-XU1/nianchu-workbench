import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'research', 'workspace-design');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function get(url, saveName) {
  const script = path.join(HERE, '_g2.ps1');
  const f = path.join(OUT, saveName);
  fs.writeFileSync(script, `
$ProgressPreference = 'SilentlyContinue'
try {
  $r = Invoke-WebRequest -Uri $args[0] -UseBasicParsing -TimeoutSec 30 -Proxy 'http://127.0.0.1:7897' -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';'Accept'='text/html,application/json'}
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
console.log('  抓取：成熟工具的设计文档 / 源码');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// 直接抓 raw 源码（更可靠）
const TARGETS = [
  // Obsidian 风格的工作台（插件化、多面板）
  { n: 'vscode-layout', u: 'https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/browser/parts/editor/editorPart.ts', why: 'VSCode 编辑器分区（多面板+拖拽）' },
  // Excalidraw（画布工具）
  { n: 'excalidraw-app', u: 'https://raw.githubusercontent.com/excalidraw/excalidraw/master/packages/excalidraw/components/App.tsx', why: 'Excalidraw 画布应用主组件' },
  // tldraw（现代画布）
  { n: 'tldraw-readme', u: 'https://raw.githubusercontent.com/tldraw/tldraw/main/README.md', why: 'tldraw 画布 SDK' },
  // Flowise（AI 工作流）
  { n: 'flowise-readme', u: 'https://raw.githubusercontent.com/FlowiseAI/Flowise/main/README.md', why: 'Flowise AI 工作流 UI' },
  // Dify（AI 应用平台）
  { n: 'dify-readme', u: 'https://raw.githubusercontent.com/langgenius/dify/main/README.md', why: 'Dify AI 工作台' },
  // n8n（工作流）
  { n: 'n8n-readme', u: 'https://raw.githubusercontent.com/n8n-io/n8n/master/README.md', why: 'n8n 工作流编辑器' },
  // ComfyUI（用户提到过）
  { n: 'comfyui-readme', u: 'https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/README.md', why: 'ComfyUI 节点画布' },
  // Langflow
  { n: 'langflow-readme', u: 'https://raw.githubusercontent.com/langflow-ai/langflow/main/README.md', why: 'Langflow 可视化 AI 工作流' },
];

const got = [];
for (const t of TARGETS) {
  const r = get(t.u, t.n + '.txt');
  const ok = r.res.startsWith('OK') && r.size > 800;
  console.log('  ' + (ok ? 'OK' : 'XX') + ' ' + t.n.padEnd(20) + r.res.slice(0, 32).padEnd(36) + Math.round(r.size / 1024) + 'KB  ' + t.why);
  if (ok) got.push({ ...t, f: r.f, size: r.size });
  else if (fs.existsSync(r.f) && r.size < 800) { try { fs.unlinkSync(r.f); } catch (e) {} }
}

console.log();
console.log('  成功 %d / %d' % (got.length, TARGETS.length));
