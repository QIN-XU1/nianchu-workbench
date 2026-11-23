#!/usr/bin/env node
/**
 * 并行克隆：按「与我们卡住的问题的相关度」排序，先拉最相关的。
 * 用法：node fetch-refs-par.mjs [并发数] [分组]
 *   分组 p1 = 插件生态/agent 循环（最相关）
 *   分组 p2 = 其余
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REFS = 'D:\\refs';
const GIT = ['-c', 'url.https://github.com/.insteadOf='];

const GROUPS = {
  // 最相关：插件架构、agent 循环、UI、记忆
  p1: [
    ['deepseek-harness', 'https://github.com/deepseek-ai/deepseek-harness.git'],
    ['dify', 'https://github.com/langgenius/dify.git'],
    ['openhands', 'https://github.com/All-Hands-AI/OpenHands.git'],
    ['copilotkit', 'https://github.com/CopilotKit/CopilotKit.git'],
    ['openclaude', 'https://github.com/Gitlawb/openclaude.git'],
    ['learn-claude-code', 'https://github.com/shareAI-lab/learn-claude-code.git'],
    ['dsh-superagent-prototype', 'https://github.com/deepseek-ai/dsh-superagent-prototype.git'],
  ],
  // 次相关：插件架构、记忆、多代理、存储
  p2: [
    ['nocobase', 'https://github.com/nocobase/nocobase.git'],
    ['ragflow', 'https://github.com/infiniflow/ragflow.git'],
    ['metagpt', 'https://github.com/FoundationAgents/MetaGPT.git'],
    ['siyuan', 'https://github.com/siyuan-note/siyuan.git'],
    ['cowagent', 'https://github.com/zhayujie/CowAgent.git'],
    ['agent-reach', 'https://github.com/Panniantong/Agent-Reach.git'],
    ['career-ops', 'https://github.com/santifer/career-ops.git'],
    ['aionui-official', 'https://github.com/iOfficeAI/AionUi.git'],
  ],
};

const group = process.argv[2] || 'p1';
const conc = Number(process.argv[3] || 3);
const list = GROUPS[group] || GROUPS.p1;

const todo = list.filter(([id]) => !existsSync(join(REFS, id)));
console.log('group=' + group + '  待拉 ' + todo.length + ' / 共 ' + list.length + '  并发 ' + conc);

let idx = 0;
let done = 0;

function next() {
  if (idx >= todo.length) return Promise.resolve();
  const [id, url] = todo[idx++];
  const dst = join(REFS, id);
  return new Promise((resolve) => {
    console.log('  > ' + id);
    const p = spawn('git', [...GIT, 'clone', '--depth', '1', url, dst], { stdio: 'ignore', windowsHide: true });
    p.on('exit', (code) => {
      done++;
      let n = 0;
      if (existsSync(dst)) {
        const walk = (d, dep) => { if (dep > 12) return; let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.name === '.git') continue; if (e.isDirectory()) walk(join(d, e.name), dep + 1); else n++; } };
        walk(dst, 0);
      }
      console.log('  ' + (code === 0 && n > 0 ? 'OK  ' : 'FAIL') + ' ' + id + '  ' + n + ' files');
      resolve();
    });
  }).then(() => next());
}

const runners = Array.from({ length: conc }, () => next());
Promise.all(runners).then(() => {
  console.log('DONE ' + done + '/' + todo.length);
});
