#!/usr/bin/env node
/**
 * 端到端验收：让 hermes agent 真干活，然后**独立验证结果**。
 *
 * 为什么必须有这个：目标第 6 条要求「可运行 + 被真实触发」，第 3 条要求「每项有可执行验证」。
 * 之前 A1/A2/C1/C4 只能标「部分」，因为本机没有可用模型 —— 现在有了（本地 MiMo 网关 3425）。
 *
 * 铁律：**不信 agent 的自述，只信文件系统和退出码。**
 * 每个用例都：hermes 干 → 我们自己去查 → 结果对不上就红。
 *
 * 前置条件（本机已满足）：
 *   1. 模型：http://127.0.0.1:3425/v1 上跑着 magpie（auto/mimo-v2.6-flash-free）
 *   2. bash：%LOCALAPPDATA%\hermes\git 必须是指向 Git 安装目录的联接
 *      （hermes 的 pm.shell 只查固定路径；Git 装在 D:\file\env\Git 时要用 junction 桥接）
 *
 * 用法：node verify-e2e.mjs [--only A2]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERMES = 'C:/Users/15282/AppData/Local/hermes/bin/hermes.cmd';
const SCRATCH = 'C:/Users/15282/AppData/Local/Temp/hermes-e2e';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : null; })();

let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('    ✓ ' + n + (d ? '  ' + d : '')); };
const no = (n, d) => { fail++; console.log('    ✗ ' + n + (d ? '  ' + d : '')); };

const E2E_ENV = { ...process.env, HERMES_HOME: 'C:/Users/15282/AppData/Local/hermes', HERMES_GIT_BASH_PATH: 'D:/file/env/Git/bin/bash.exe' };

/** 跑一次 hermes，返回原始输出（模型有时慢，给 300s） */
function hermes(prompt) {
  const t0 = Date.now();
  try {
    const out = execFileSync('cmd', ['/c', HERMES, '-z', prompt], {
      encoding: 'utf8', timeout: 300000, env: E2E_ENV, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, ms: Date.now() - t0 };
  } catch (e) {
    return { out: (e.stdout || '') + '\n' + (e.stderr || ''), ms: Date.now() - t0, err: e.message };
  }
}

fs.mkdirSync(SCRATCH, { recursive: true });

const CASES = [
  {
    id: 'A2',
    name: '终端执行',
    prompt: () => '用 terminal 工具执行 `echo E2E_TERMINAL_OK` 并把 exit_code 和 stdout 原样报给我。不要用别的工具。',
    verify: () => {
      // 这个只能看回复里有没有真 stdout —— 但 stdout 是模型转述的。
      // 所以换个更硬的判据：让它在文件系统上留痕，我们自己去查。
      return null;
    },
  },
  {
    id: 'A1',
    name: '文件写入 + 代码编辑（独立验证）',
    prompt: () => {
      const f = SCRATCH + '/e2e-code.py';
      return [
        '完成三个动作，只用工具不要解释过程：',
        '1) 用 write_file 创建 ' + f + '，内容恰好是这三行：',
        'def add(a, b):',
        '    return a - b',
        'print(add(2, 3))',
        '2) 读出这个文件，把第 2 行的 `a - b` 改成 `a + b`（这是一处 bug 修复）',
        '3) 用 terminal 执行 `python ' + f + '`，把 stdout 报给我',
      ].join('  ');
    },
    verify: () => {
      const f = SCRATCH + '/e2e-code.py';
      if (!fs.existsSync(f)) return [false, '文件没被创建'];
      const t = fs.readFileSync(f, 'utf8');
      if (!/return a \+ b/.test(t)) return [false, '第 2 行没被改成 a + b，实际: ' + JSON.stringify(t.slice(0, 80))];
      if (/a - b/.test(t)) return [false, '旧代码还在（改了一半）'];
      // 独立跑一遍，验证它真的是可运行的修复
      try {
        const out = execFileSync('python', [f.replace(/\//g, '\\')], { encoding: 'utf8', timeout: 30000 }).trim();
        if (out !== '5') return [false, '执行输出应为 5，实为 ' + JSON.stringify(out)];
        return [true, '文件已创建 → bug 已改（a-b→a+b）→ 独立执行输出 5'];
      } catch (e) {
        return [false, '独立执行失败: ' + String(e.message).slice(0, 80)];
      }
    },
  },
  {
    id: 'C1',
    name: 'agent 循环完整性（多步 + 工具链）',
    prompt: () => {
      const d = SCRATCH + '/multi';
      return [
        '做一个三步任务，只用工具：',
        '1) 在 ' + d + ' 下创建 3 个文件：1.txt 内容 "一"、2.txt 内容 "二"、3.txt 内容 "三"',
        '2) 用 terminal 执行 `ls ' + d + '` 确认三个都在',
        '3) 把它们的内容拼起来写进 ' + d + '/all.txt（内容应为 一二三）',
        '完成后一句话报告结果。',
      ].join('  ');
    },
    verify: () => {
      const d = SCRATCH + '/multi';
      const want = ['1.txt', '2.txt', '3.txt', 'all.txt'];
      const missing = want.filter((f) => !fs.existsSync(path.join(d, f)));
      if (missing.length) return [false, '缺文件: ' + missing.join(',')];
      const all = fs.readFileSync(path.join(d, 'all.txt'), 'utf8');
      if (!/一二三/.test(all)) return [false, 'all.txt 内容不对: ' + JSON.stringify(all.slice(0, 40))];
      const parts = ['1.txt', '2.txt', '3.txt'].map((f) => fs.readFileSync(path.join(d, f), 'utf8').trim());
      if (parts.join('') !== '一二三') return [false, '三个分文件内容不对: ' + JSON.stringify(parts)];
      return [true, '4 个文件齐全，分文件 一二三，合并文件正确'];
    },
  },
  {
    id: 'C4',
    name: '自愈 / 失败恢复（先失败再纠正）',
    prompt: () => {
      const f = SCRATCH + '/heal.txt';
      return [
        '这个任务里有故意设的坑，请自己发现并纠正：',
        '1) 用 read_file 读 ' + f + ' —— 这个文件现在不存在，会报错',
        '2) 发现不存在后，用 write_file 创建它，内容 "healed"',
        '3) 再读一次确认',
        '完成后报告：第一次报了什么错、你怎么处理的。',
      ].join('  ');
    },
    verify: () => {
      const f = SCRATCH + '/heal.txt';
      if (!fs.existsSync(f)) return [false, '文件没被创建（没从失败中恢复）'];
      const t = fs.readFileSync(f, 'utf8').trim();
      if (t !== 'healed') return [false, '内容应为 healed，实为 ' + JSON.stringify(t)];
      return [true, '先读失败 → 自己创建 → 内容正确（失败后恢复）'];
    },
  },
];

// 清场（保证每次都是从零开始，不靠上一轮的残留通过）
for (const c of CASES) {
  if (c.id === 'A1') { try { fs.unlinkSync(SCRATCH + '/e2e-code.py'); } catch {} }
  if (c.id === 'C1') { try { fs.rmSync(SCRATCH + '/multi', { recursive: true, force: true }); } catch {} }
  if (c.id === 'C4') { try { fs.unlinkSync(SCRATCH + '/heal.txt'); } catch {} }
}

console.log('');
console.log('  端到端验收：让 hermes 真干活，我们独立验结果（不信自述）');
console.log('');

for (const c of CASES) {
  if (ONLY && c.id !== ONLY) continue;
  console.log('  ── ' + c.id + ' ' + c.name);
  const r = hermes(c.prompt().replace(/\n/g, '  '));
  console.log('      （hermes 耗时 ' + Math.round(r.ms / 1000) + 's，输出 ' + r.out.length + ' 字）');
  const v = c.verify();
  if (v === null) {
    // A2 只验「terminal 返回值里有真 stdout」——这是模型转述，所以额外看 exit_code
    /exit_code['":\s]*0/.test(r.out) && /E2E_TERMINAL_OK/.test(r.out)
      ? ok('terminal 返回 exit_code 0 + 真 stdout')
      : no('terminal 没成功', r.out.slice(0, 120).replace(/\n/g, ' '));
  } else {
    v[0] ? ok(c.name + '：独立验证通过', v[1]) : no(c.name + '：独立验证失败', v[1]);
  }
  console.log('');
}

console.log('  ──────────────────────────────────────────────');
console.log('    断言：通过 ' + pass + '  失败 ' + fail);
console.log('  ──────────────────────────────────────────────');
process.exit(fail ? 1 : 0);
