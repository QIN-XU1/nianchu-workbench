#!/usr/bin/env node
/**
 * 工作方式（批次 Z.28）验证 —— 模式表 + **白名单在派发处真的生效**
 *
 * 为什么必须自带假网关：
 *   ① 白名单是「派发处」的闸，只有让模型**真的调一个没给它的工具**才能证明它拦得住；
 *      用真模型跑这个反例既贵又不稳定（模型可能根本不调）。
 *   ② 反例「传 tools:['read']，模型调 write」在本批次修复前是**真的落盘了**，
 *      所以这里除了断言返回 ok:false，还要断言文件**不存在**。
 *
 * 坑（实测踩过）：GATEWAY 是 runtime.mjs **import 时**读 env 的，而 toolkit.mjs
 * 经 session/context 间接把 runtime 拉了起来。所以这里一律先起服务、先把 env 写好，
 * 再动态 import 业务模块 —— 否则会打到本机已在跑的 1908 网关上（那是真环境，不是假网关）。
 *
 * 用法：node tools/agent/verify-work-modes.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✔ ' + name); } else {
    fails.push(name + (info ? '  → ' + info : ''));
    console.log('  ✗ ' + name + (info ? '  → ' + info : ''));
  }
};

const dir = mkdtempSync(join(tmpdir(), 'nianchu-work-modes-'));
const captured = [];

/** 脚本化网关：按 model 决定「模型想调哪个工具」；已经有 tool 结果就收尾 */
function scriptFor(model) {
  if (model === 'fake:write') {
    return { name: 'write', args: { file_path: 'blocked.txt', content: '不应该落盘' } };
  }
  if (model === 'fake:read') return { name: 'read', args: { file_path: 'seed.txt' } };
  if (model === 'fake:todo') {
    return { name: 'todo_write', args: { todos: [{ content: '写方案', status: 'in_progress' }] } };
  }
  return null;
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* 忽略 */ }
    captured.push(body);
    const model = String(body.model || '');
    const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m && m.role === 'tool');
    const script = scriptFor(model);
    const call = Boolean(script) && !hasToolResult;
    const out = {
      id: 'fake-' + captured.length,
      object: 'chat.completion',
      model,
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      choices: [{
        index: 0,
        finish_reason: call ? 'tool_calls' : 'stop',
        message: call
          ? {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_' + captured.length,
              type: 'function',
              function: { name: script.name, arguments: JSON.stringify(script.args) },
            }],
          }
          : { role: 'assistant', content: '已完成（脚本化模型）' },
      }],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

const { port } = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address()));
});

// 顺序很重要：先覆盖 env，再 import 任何会间接 import runtime.mjs 的模块
process.env.NIANCHU_GATEWAY = 'http://127.0.0.1:' + port + '/v1/chat/completions';
process.env.NIANCHU_GATEWAY_RETRIES = '0';
delete process.env.NIANCHU_API_KEY;
process.env.NIANCHU_DATA_DIR = dir;
process.env.NIANCHU_CHANGESET_AUTOPRUNE = '0';
process.env.NIANCHU_TRACE_AUTOPRUNE = '0';

const { createToolkit } = await import('./toolkit.mjs');
const {
  DEFAULT_TOOLS, MODE_IDS, MODES, describeAllModes, modeById, modeTools,
} = await import('./modes.mjs');
const { workModeMethods, resolveRunMode } = await import('../hostapi/methods-modes.mjs');
const { runWithTools } = await import('./loop.mjs');

const writeSeed = () => writeFileSync(join(dir, 'seed.txt'), '第一行\n第二行\n', 'utf8');
const toolSteps = (r) => (r.transcript || []).filter((x) => x.kind === 'tool');

try {
  console.log('');
  console.log('  工作方式（交互模式）验证 · ' + dir);
  console.log('  ' + '─'.repeat(72));

  // ══ 一、模式表（纯数据）══════════════════════════════════
  t('模式表恰好是 chat / ask / plan / do 四个',
    MODE_IDS.length === 4 && MODE_IDS.join(',') === 'chat,ask,plan,do', MODE_IDS.join(','));

  const ask = modeTools('ask');
  const plan = modeTools('plan');
  const doTools = modeTools('do');
  const tk = createToolkit({ cwd: dir });

  t('只读模式的清单里**没有**任何写工具',
    ask.every((n) => !['write', 'edit', 'apply_patch', 'bash', 'remember', 'todo_write', 'spawn_subagent'].includes(n)),
    ask.join(','));
  t('只读模式的每一项在 toolkit 里都是 readOnly（load_skill 由 loop 注册为只读）',
    ask.every((n) => (n === 'load_skill' ? true : tk[n]?.readOnly === true)), ask.join(','));
  t('计划模式 = 只读模式 + todo_write',
    plan.length === ask.length + 1 && plan.includes('todo_write') && ask.every((n) => plan.includes(n)),
    plan.join(','));
  t('动手模式 = null（表示宿主默认全量，不在模式表里抄第二份清单）', doTools === null);
  t('默认全量表与 loop 的默认参数同一份（13 项，含 load_skill）',
    DEFAULT_TOOLS.length === 13 && DEFAULT_TOOLS.includes('load_skill'), String(DEFAULT_TOOLS.length));

  t('未知模式 modeById 返回 null、modeTools 抛错（不静默放成 do）',
    modeById('craft') === null && (() => {
      try { modeTools('craft'); return false; } catch { return true; }
    })());
  t('空 id 不被当成任何模式', modeById('') === null && modeById(null) === null);

  const all = describeAllModes();
  t('describeAllModes 四项、顺序固定、do 的清单是全量 13 项',
    all.length === 4 && all.map((m) => m.id).join(',') === 'chat,ask,plan,do'
    && all[0].tools.length === 0 && all[1].tools.length === 8 && all[2].tools.length === 9
    && all[3].tools.length === 13 && all[3].openEnded === true,
    JSON.stringify(all.map((m) => [m.id, m.tools.length])));
  t('模式描述自带 label/desc（界面直接显示，不用再写一份文案）',
    all.every((m) => typeof m.label === 'string' && m.label && typeof m.desc === 'string' && m.desc));

  // ══ 二、宿主解析：mode 优先于 tools ════════════════════════
  const r1 = resolveRunMode({ mode: 'ask', tools: ['write', 'bash'] });
  t('给了 mode，req.tools 被忽略（不让「模式说只读、tools 传全量」两头打架）',
    r1.mode === 'ask' && r1.error === null
    && r1.tools.length === 8 && !r1.tools.includes('write'), JSON.stringify(r1.tools));
  const r2 = resolveRunMode({ mode: 'craft' });
  t('未知 mode → error 里给可选项（前端能直接提示「切回哪个」）',
    Boolean(r2.error) && r2.error.includes('未知的工作方式') && r2.error.includes('chat / ask / plan / do'), r2.error);
  const r3 = resolveRunMode({ tools: ['read'] });
  t('没给 mode → 沿用显式 tools（老调用方不受影响）',
    r3.mode === null && r3.error === null && r3.tools.join(',') === 'read');
  const r4 = resolveRunMode({});
  t('mode/tools 都没有 → tools 为 undefined（走默认全量）',
    r4.mode === null && r4.tools === undefined);
  const r5 = resolveRunMode({ mode: ' do ' });
  t('mode 前后空白会被去掉', r5.mode === 'do' && r5.tools === undefined);

  const listed = workModeMethods().list_modes();
  t('list_modes 返回四项，含 tools 数组与 openEnded 标记',
    Array.isArray(listed) && listed.length === 4
    && listed.every((m) => Array.isArray(m.tools) && typeof m.openEnded === 'boolean'));

  // ══ 三、派发闸：白名单外的工具**不执行** ════════════════════
  writeSeed();
  const c1 = await runWithTools({
    systemPrompt: '测试', task: '读一下 seed.txt', tools: ['read'], cwd: dir, model: 'fake:read', maxSteps: 2,
  });
  const c1tools = toolSteps(c1);
  t('白名单内的 read 正常执行（对照组）',
    c1tools.length === 1 && c1tools[0].ok === true
    && String(c1tools[0].output?.content || '').includes('第一行'),
    JSON.stringify(c1tools.map((x) => [x.tool, x.ok])));

  const before = captured.length;
  const c2 = await runWithTools({
    systemPrompt: '测试',
    task: '把内容写进 blocked.txt，用 write 工具',
    tools: ['read'],
    cwd: dir,
    model: 'fake:write',
    maxSteps: 2,
  });
  const c2tools = toolSteps(c2);
  t('★反例：只给 read，模型调 write → 返回 ok:false（真的调用了才算数）',
    c2tools.length === 1 && c2tools[0].tool === 'write' && c2tools[0].ok === false,
    JSON.stringify(c2tools.map((x) => [x.tool, x.ok])));
  t('★反例：拦截文案说明「不在本次允许范围」',
    /不在本次允许范围/.test(String(c2tools[0]?.output?.error || '')), String(c2tools[0]?.output?.error));
  t('★反例：被拦下的 write **没有落盘**（blocked.txt 不存在）', !existsSync(join(dir, 'blocked.txt')));
  t('★反例：错误文案列出了本次真实可用的工具（用户能看懂为什么被拦）',
    /本次可用：read/.test(String(c2tools[0]?.output?.error || '')));
  t('★反例：系统提示已改成「只读」，不再对模型说「可以读写文件」',
    captured.slice(before).length > 0
    && captured.slice(before).every((b) => String(b.messages?.[0]?.content || '').includes('本次运行是**只读**的')));

  const c2b = await runWithTools({
    systemPrompt: 't', task: '做个计划', tools: ask, cwd: dir, model: 'fake:todo', maxSteps: 2,
  });
  const c2bTools = toolSteps(c2b);
  t('只读运行里 todo_write 也不放行（计划模式才给）',
    c2bTools.length === 1 && c2bTools[0].ok === false, JSON.stringify(c2bTools.map((x) => [x.tool, x.ok])));

  // ══ 四、走宿主同一条路径：mode → 白名单 ══════════════════════
  const askRun = resolveRunMode({ mode: 'ask' });
  const c3 = await runWithTools({
    systemPrompt: 't', task: '写文件', tools: askRun.tools, cwd: dir, model: 'fake:write', maxSteps: 2,
  });
  const c3tools = toolSteps(c3);
  t('★mode=ask 经宿主解析后，write 同样被拦下且没有落盘',
    c3tools.length === 1 && c3tools[0].ok === false && !existsSync(join(dir, 'blocked.txt')));

  const planRun = resolveRunMode({ mode: 'plan' });
  const c4 = await runWithTools({
    systemPrompt: 't', task: '写个计划', tools: planRun.tools, cwd: dir, model: 'fake:todo', maxSteps: 2,
  });
  const c4tools = toolSteps(c4);
  t('mode=plan 时 todo_write 放行，且计划被结果收下',
    c4tools.length === 1 && c4tools[0].ok === true && Array.isArray(c4.plan) && c4.plan.length === 1,
    JSON.stringify(c4tools.map((x) => [x.tool, x.ok])));

  const chatRun = resolveRunMode({ mode: 'chat' });
  t('mode=chat 的白名单为空数组（不是 undefined，避免误走默认全量）',
    Array.isArray(chatRun.tools) && chatRun.tools.length === 0);
  const c5 = await runWithTools({
    systemPrompt: 't', task: '随便', tools: chatRun.tools, cwd: dir, model: 'fake:write', maxSteps: 2,
  });
  const c5tools = toolSteps(c5);
  t('★mode=chat 任何工具调用都被拦，错误里写「（无）」',
    c5tools.length === 1 && c5tools[0].ok === false
    && /本次可用：（无）/.test(String(c5tools[0].output?.error || '')));

  // ══ 五、前端同源：模式表与界面提示数据一致 ═══════════════════
  const ui = readFileSync(join(import.meta.dirname, '../../apps/vouch-web/src/web-ui/src/app/layout/workModes.ts'), 'utf8');
  t('前端只做映射、不抄工具清单（workModes.ts 里没有 write/bash 这类工具名）',
    !/'write'/.test(ui) && !/'bash'/.test(ui));
  t('前端四种模式的 label 与宿主一致',
    MODES.every((m) => new RegExp(m.id + ": '" + m.label + "'").test(ui)));
} catch (e) {
  fails.push('脚本异常：' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  console.log('  ✗ 脚本异常：' + String(e && e.message));
} finally {
  server.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('');
console.log('  ' + '─'.repeat(72));
console.log('  通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ PASS —— 模式即白名单，且白名单在派发处真的拦得住');
process.exit(0);
