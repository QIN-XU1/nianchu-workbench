#!/usr/bin/env node
/**
 * A12 技能/插件生态 · 「默认生效」验收
 *
 * ══ 为什么需要这个脚本（第 118 轮）═══════════════════════════════
 * 矩阵 A12 一直判「部分」：tools/skills/{loader,registry,inject}.mjs 都写好了，
 * 但**只有 api-handler 和测试在调** —— 模型既看不到技能目录，也没有 load_skill 工具。
 * 本轮把两件事接进 tools/agent/loop.mjs：
 *   ① 目录常驻 system prompt（catalogText）
 *   ② load_skill 工具按需取正文（createLoadSkillTool）
 * 本脚本证明「接线真的生效」，而不是「文件存在」。
 *
 * ══ 怎么证明 ══════════════════════════════════════════════════
 * 用 globalThis.fetch 脚本化假模型（同 verify-e2e-scripted.mjs 的手法），
 * 让真 loop.mjs 原样跑一遍，**截获它真正发给模型的请求体**，断言：
 *   · system 消息里有没有技能目录（# Skills + 每个技能名）
 *   · 请求的 tools 里有没有 load_skill
 *   · 模型调 load_skill 时能不能拿到正文（真读盘）
 *   · 未知技能 / 路径穿越 是否被拒（不静默）
 *
 * 四态：0 全通过 · 1 有失败 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const t = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

/** 截获请求体 + 按剧本回应的假网关 */
function makeCaptureFetch(script) {
  let i = 0;
  const captured = [];
  async function fakeFetch(url, opts) {
    const body = JSON.parse(opts.body);
    captured.push(body);
    const step = script[Math.min(i, script.length - 1)];
    i++;
    const resp = typeof step === 'function' ? step(body) : step;
    return { ok: true, status: 200, async json() { return resp; }, async text() { return JSON.stringify(resp); } };
  }
  return { fetch: fakeFetch, captured };
}
const toolCall = (name, args) => ({
  model: 'scripted',
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const textResp = (text) => ({
  model: 'scripted',
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const origFetch = globalThis.fetch;

async function main() {
  // ── 0. 组件自检（先证工具本身没坏）──
  console.log('\n  0. 组件自检：loader / catalogText / load_skill 独立可用');
  const { createSkillLoader } = await import('../skills/loader.mjs');
  const { catalogText, createLoadSkillTool } = await import('../skills/inject.mjs');
  const scenes = path.join(ROOT, 'prototype/scenes');
  const loader = createSkillLoader([scenes]).scanAll();
  const stats = loader.stats();
  t('loader 扫到技能 ≥ 20 个', stats.count >= 20, '实际 ' + stats.count);
  t('loader 无错误', stats.issues.filter((i) => i.level === 'error').length === 0, JSON.stringify(stats.issues));
  const cat = catalogText(loader);
  t('目录文本以 # Skills 开头', /^# Skills/.test(cat.text), cat.text.slice(0, 30));
  t('目录条数 = 技能数', cat.count === stats.count, cat.count + ' vs ' + stats.count);
  const tool = createLoadSkillTool(loader);
  const first = loader.list()[0].name;
  const loaded = tool.run({ name: first });
  t('load_skill 能取到正文（真读盘）', loaded.ok === true && String(loaded.body || '').length > 0, JSON.stringify(loaded).slice(0, 80));
  t('未知技能被拒（不静默）', tool.run({ name: 'no-such-skill-xyz' }).ok === false);
  t('路径穿越被拒', tool.run({ name: '../../etc/passwd' }).ok === false);
  // ── 0b. 共享参考内联（第 144 轮）：薄壳技能的 load_skill 必须带回 _shared 正文，不能只给指针 ──
  const dr = tool.run({ name: 'data-reconcile' });
  t('薄壳技能 load_skill 内联了共享参考', dr.ok === true && /共享参考（已自动内联/.test(String(dr.body || '')), 'data-reconcile 正文 ' + (dr.ok ? Buffer.byteLength(dr.body, 'utf8') : 0) + 'B');
  t('内联后正文显著大于磁盘薄壳(0.35KB)', dr.ok === true && Buffer.byteLength(dr.body, 'utf8') > 4096, dr.ok ? Buffer.byteLength(dr.body, 'utf8') + 'B' : 'fail');

  // ── 1. 端到端：真 loop.mjs 跑假模型，截获请求体 ──
  console.log('\n  1. 端到端：真 loop.mjs 的请求体里必须有技能目录 + load_skill');
  const { runWithTools } = await import('./loop.mjs');
  const tmp = fs.mkdtempSync(path.join(ROOT, 'tmp', 'a12-'));
  // 剧本：第一步调 load_skill(adr)，第二步给结束语
  const { fetch: fakeFetch, captured } = makeCaptureFetch([
    toolCall('load_skill', { name: 'adr' }),
    textResp('已读取 adr 技能正文'),
  ]);
  globalThis.fetch = fakeFetch;
  let r;
  try {
    // 不传 tools ⇒ 用默认全套（验证「默认生效」）
    r = await runWithTools({ task: '读一下 adr 技能正文', cwd: tmp, maxSteps: 3, maxTokens: 400 });
  } finally {
    globalThis.fetch = origFetch;
  }

  t('循环跑完（state=PASS）', r.state === 'PASS', r.state + ' / ' + (r.reason || ''));
  t('截获到 ≥ 2 次请求', captured.length >= 2, String(captured.length));

  const sysMsg = (captured[0].messages || []).find((m) => m.role === 'system');
  t('请求体有 system 消息', !!sysMsg);
  const sysText = String((sysMsg && sysMsg.content) || '');
  t('system 含技能目录标题 # Skills', sysText.includes('# Skills'));
  t('system 含 adr 技能名', /(^|\n)- adr:/.test(sysText));
  t('system 含 load_skill 调用提示', sysText.includes('load_skill'));
  // 目录里应有 ≥20 行技能
  const catLines = sysText.split('\n').filter((l) => /^- [A-Za-z0-9_-]+:/.test(l)).length;
  t('目录行数 ≥ 20', catLines >= 20, '实际 ' + catLines);

  const toolNames = (captured[0].tools || []).map((x) => x.function && x.function.name);
  t('请求 tools 含 load_skill', toolNames.includes('load_skill'), JSON.stringify(toolNames));
  t('请求 tools 仍含基础工具（read/bash）', toolNames.includes('read') && toolNames.includes('bash'));

  // 模型调 load_skill 的结果必须进 transcript 且 ok=true
  const tr = (r.transcript || []).find((x) => x.kind === 'tool' && x.tool === 'load_skill');
  t('transcript 有 load_skill 结果', !!tr);
  const trBody = tr && tr.output && String(tr.output.body || '');
  t('load_skill 结果 ok=true 且有正文', !!(tr && tr.ok === true && trBody && trBody.length > 0), tr ? ('ok=' + tr.ok + ' bodyLen=' + (trBody ? trBody.length : 0)) : 'no record');

  // ── 2. 反假绿：目录不能是空的/假的 ──
  console.log('\n  2. 反假绿：目录必须来自真磁盘，而不是硬编码');
  const adrFile = path.join(scenes, 'adr', 'SKILL.md');
  t('adr/SKILL.md 真存在', fs.existsSync(adrFile));
  const adrText = fs.readFileSync(adrFile, 'utf8');
  const adrDesc = (() => { const m = /description\s*:\s*(.+)/.exec(adrText); return m ? m[1].trim().slice(0, 20) : ''; })();
  t('目录里的 adr 描述与磁盘一致', adrDesc.length > 0 && sysText.includes(adrDesc), '描述=' + adrDesc);

  // 收尾
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log('\n  ──────────────────────────────────────────');
  console.log('  通过 ' + pass + ' · 失败 ' + fail);
  const state = fail > 0 ? 'FAIL' : (pass > 0 ? 'PASS' : 'UNKNOWN');
  console.log('  四态: ' + state);
  process.exit(state === 'FAIL' ? 1 : state === 'UNKNOWN' ? 2 : 0);
}

main().catch((e) => {
  console.error('  ✗ 工具自检失败：' + (e && e.stack || e));
  process.exit(2);
});
