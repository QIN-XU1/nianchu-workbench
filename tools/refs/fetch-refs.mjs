#!/usr/bin/env node
/**
 * 拉取/更新参照仓库。纯 ASCII 输出，避开 PowerShell 中文编码坑。
 * 绕过本机的 gh-proxy（它 TLS 失败），直连 GitHub。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REFS = 'D:\\refs';
const GIT_ARGS = ['-c', 'url.https://github.com/.insteadOf='];

const NEW = [
  ['nocobase', 'https://github.com/nocobase/nocobase.git'],
  ['agent-reach', 'https://github.com/Panniantong/Agent-Reach.git'],
  ['aionui-official', 'https://github.com/iOfficeAI/AionUi.git'],
  ['openclaude', 'https://github.com/Gitlawb/openclaude.git'],
  ['copilotkit', 'https://github.com/CopilotKit/CopilotKit.git'],
  ['siyuan', 'https://github.com/siyuan-note/siyuan.git'],
  ['cowagent', 'https://github.com/zhayujie/CowAgent.git'],
  ['career-ops', 'https://github.com/santifer/career-ops.git'],
  ['learn-claude-code', 'https://github.com/shareAI-lab/learn-claude-code.git'],
  ['dify', 'https://github.com/langgenius/dify.git'],
  ['ragflow', 'https://github.com/infiniflow/ragflow.git'],
  ['openhands', 'https://github.com/All-Hands-AI/OpenHands.git'],
  ['metagpt', 'https://github.com/FoundationAgents/MetaGPT.git'],
  ['deepseek-harness', 'https://github.com/deepseek-ai/deepseek-harness.git'],
  ['dsh-superagent-prototype', 'https://github.com/deepseek-ai/dsh-superagent-prototype.git'],
];

const run = (args, cwd) => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: String((e.stdout || '') + (e.stderr || '') || e.message) };
  }
};

const countFiles = (dir) => {
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 12) return;
    let es;
    try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name === '.git') continue;
      if (e.isDirectory()) walk(join(d, e.name), depth + 1);
      else n++;
    }
  };
  walk(dir, 0);
  return n;
};

console.log('=== CLONE NEW REPOS ===');
for (const [id, url] of NEW) {
  const dst = join(REFS, id);
  if (existsSync(dst)) { console.log('  = exists, skip: ' + id); continue; }
  console.log('  > ' + id);
  const r = run([...GIT_ARGS, 'clone', '--depth', '1', url, dst]);
  if (existsSync(dst)) console.log('    OK ' + countFiles(dst) + ' files');
  else console.log('    FAIL ' + r.out.split('\n').slice(-1)[0].slice(0, 120));
}

console.log('');
console.log('=== UPDATE EXISTING REPOS ===');
for (const name of readdirSync(REFS)) {
  if (name.startsWith('_')) continue;
  const dir = join(REFS, name);
  try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
  if (!existsSync(join(dir, '.git'))) continue;
  const r = run([...GIT_ARGS, 'pull', '--ff-only'], dir);
  const line = r.out.split('\n').filter(Boolean).slice(-1)[0] || '';
  console.log('  ' + (r.ok ? 'OK  ' : 'SKIP') + ' ' + name + '  ' + line.slice(0, 80));
}
console.log('');
console.log('=== DONE ===');
