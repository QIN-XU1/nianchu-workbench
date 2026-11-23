#!/usr/bin/env node
/**
 * 脚本化假模型的端到端测试 —— 不依赖真 LLM，验证「循环 + 真工具」能真的改文件。
 *
 * 为什么需要（第 64 轮）：
 *   网关长期不可用，7 项真跑段一直 UNKNOWN。但「模型是否聪明」与「循环+工具能否真的落盘」
 *   是两件事，后者可以**不靠 LLM 验证**：把 globalThis.fetch 换成按剧本返回固定 tool_calls 的假网关，
 *   真实 loop.mjs / toolkit.mjs / changeset.mjs 原样运行，工具真的写文件。
 *
 * ⚠ 重要语义（本测试顺带查清）：
 *   `runWithTools` 返回的 state=PASS 只表示「**循环正常结束**」，不表示「**任务完成**」。
 *   模型可以撒谎说「我做了」而不调工具 → 循环仍 PASS，但文件并不存在。
 *   任务是否完成必须由上层 reviewer / verify-goal / 产出物检查来判定 —— 不得把 PASS 当做成。
 *   本测试不对 B 断言 PASS，而是断言「文件没被伪造」这一真实性质。
 *
 * 覆盖：
 *   A. 单 agent：假模型发 write 工具调用 → 真文件被写、内容正确、state=PASS
 *   B. 假模型只说「我完成了」不调工具 → 文件确实不存在（未被伪造）；state=PASS 仅代表循环结束
 *   C. 假模型调用不存在的工具 → transcript 里必须留下 ok=false 的工具记录（错误可见、不静默吞掉）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const t = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

function makeScriptedFetch(script) {
  let i = 0;
  return async function fakeFetch(url, opts) {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    const body = typeof step === 'function' ? step(JSON.parse(opts.body)) : step;
    return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
  };
}
const toolCallResponse = (name, args) => ({
  model: 'scripted',
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const textResponse = (text) => ({
  model: 'scripted',
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const origFetch = globalThis.fetch;

async function main() {
  const { runWithTools } = await import('./loop.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-scripted-'));

  // ── A. 单 agent 真写文件 ──
  console.log('\n  A. 单 agent：假模型发 write 调用 → 真落盘');
  {
    globalThis.fetch = makeScriptedFetch([
      toolCallResponse('write', { file_path: 'out.txt', content: 'team-ok-777' }),
      textResponse('已完成：文件 out.txt 已写入 team-ok-777'),
    ]);
    const r = await runWithTools({ task: '在 cwd 创建 out.txt 内容 team-ok-777', tools: ['write', 'read', 'bash'], cwd: tmp, maxSteps: 5, maxTokens: 500 });
    const file = path.join(tmp, 'out.txt');
    const exists = fs.existsSync(file);
    t('文件被真实创建', exists);
    t('文件内容正确', exists && fs.readFileSync(file, 'utf8') === 'team-ok-777');
    t('本次运行 state=PASS（循环正常结束且工具成功）', r.state === 'PASS', r.state);
    t('transcript 里有成功的 write 工具记录', (r.transcript || []).some((x) => x.kind === 'tool' && x.tool === 'write' && x.ok));
  }

  // ── B. 模型撒谎：说完成但不调工具 ──
  console.log('\n  B. 假模型只说「我完成了」但不调工具');
  {
    fs.rmSync(path.join(tmp, 'out2.txt'), { force: true });
    globalThis.fetch = makeScriptedFetch([textResponse('我已经创建了 out2.txt，里面是 done')]);
    const r = await runWithTools({ task: '创建 out2.txt', tools: ['write'], cwd: tmp, maxSteps: 3, maxTokens: 300 });
    t('文件确实不存在（系统没有伪造产出物）', !fs.existsSync(path.join(tmp, 'out2.txt')));
    t('没有任何成功的工具调用记录', !(r.transcript || []).some((x) => x.kind === 'tool' && x.ok));
    // 如实标注语义：state=PASS 只代表循环结束，不代表任务完成
    console.log('    · 本次 state=' + r.state + '（仅代表循环正常结束；文件并未创建，任务实际未完成）');
  }

  // ── C. 未知工具 → 必须留下失败记录，不静默吞掉 ──
  console.log('\n  C. 假模型调用不存在的工具');
  {
    globalThis.fetch = makeScriptedFetch([
      toolCallResponse('nonexistent_tool_xyz', {}),
      textResponse('继续'),
    ]);
    const r = await runWithTools({ task: '调用一个不存在的工具', tools: ['write'], cwd: tmp, maxSteps: 3, maxTokens: 300 });
    const badTool = (r.transcript || []).find((x) => x.kind === 'tool' && x.tool === 'nonexistent_tool_xyz');
    t('transcript 里有该未知工具的记录', Boolean(badTool));
    t('该记录 ok=false（失败可见）', badTool && badTool.ok === false);
    t('错误信息写明「没有这个工具」', badTool && /没有这个工具|unknown tool/i.test(JSON.stringify(badTool.output || '')));
  }

  // ── D. 团队：规划→执行(实现者真写文件)→审阅 端到端 ──
  console.log('\n  D. 团队 4 角色：planner 拆任务 → implementer 真写文件 → reviewer 审阅');
  {
    const { runTeam } = await import('./team.mjs');
    const makeTeamFetch = (verdictLine) => {
      const calls = [];
      const f = async (url, opts) => {
        const body = JSON.parse(opts.body);
        const msgs = body.messages || [];
        const last = msgs[msgs.length - 1] || {};
        const all = msgs.map((m) => m.content).join('\n');
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
        calls.push({ hasTools, lastRole: last.role });
        let content = ''; let toolCalls = null;
        if (!hasTools && /拆成|子任务/.test(all)) {
          content = JSON.stringify({ subtasks: [{ title: '创建 out.txt', assignee: 'implementer', spec: '写入 team-ok-777' }] });
        } else if (hasTools && last.role !== 'tool') {
          toolCalls = [{ id: 'c1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ file_path: 'team.txt', content: 'team-ok-777' }) } }];
        } else if (hasTools && last.role === 'tool') { content = '已完成 team.txt 的写入'; }
        else { content = '评审意见。\nVERDICT: ' + verdictLine; }
        const message = { role: 'assistant', content: toolCalls ? null : content };
        if (toolCalls) message.tool_calls = toolCalls;
        return { ok: true, status: 200, async json() { return { model: 'scripted', choices: [{ message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }; }, async text() { return '{}'; } };
      };
      return { f, calls };
    };

    // D1：审阅通过 → 文件真的被实现者写入
    globalThis.fetch = makeTeamFetch('PASS').f;
    fs.rmSync(path.join(tmp, 'team.txt'), { force: true });
    const r1 = await runTeam({ objective: '创建 team.txt 内容 team-ok-777', tools: ['write', 'read'], cwd: tmp, maxSubtasks: 2, maxRounds: 1 });
    const f1 = path.join(tmp, 'team.txt');
    t('团队实现者真的创建了 team.txt', fs.existsSync(f1));
    t('team.txt 内容正确', fs.existsSync(f1) && fs.readFileSync(f1, 'utf8') === 'team-ok-777');
    t('三个阶段的 plan/work/review 都走过', ['plan', 'work', 'review'].every((s) => (r1.steps || []).some((x) => x.stage === s)));
    t('审阅通过时团队整体 PASS', r1.state === 'PASS', r1.state + ' verdict=' + JSON.stringify(r1.verdict));

    // D2（反例）：审阅者否决 → 团队不得判 PASS（独立审阅不是橡皮图章）
    globalThis.fetch = makeTeamFetch('FAIL').f;
    fs.rmSync(path.join(tmp, 'team2.txt'), { force: true });
    const r2 = await runTeam({ objective: '再创建一个文件', tools: ['write', 'read'], cwd: tmp, maxSubtasks: 2, maxRounds: 1 });
    t('审阅者判 FAIL 时团队整体不得 PASS', r2.state !== 'PASS', 'state=' + r2.state + ' verdict=' + JSON.stringify(r2.verdict));
  }

  // ── F/G/H. 产出物兜底（expectArtifacts）：堵「模型撒谎→PASS」──
  console.log('\n  F/G. 单 agent + expectArtifacts');
  {
    // F：模型只说不做 → 声明的产出缺失 → 必须 FAIL（不再 PASS）
    fs.rmSync(path.join(tmp, 'must.txt'), { force: true });
    globalThis.fetch = makeScriptedFetch([textResponse('我已经写好了 must.txt')]);
    const rF = await runWithTools({ task: '写 must.txt', tools: ['write'], cwd: tmp, maxSteps: 2, maxTokens: 200, expectArtifacts: [{ path: 'must.txt' }] });
    t('F 模型撒谎未产出 → state=FAIL', rF.state === 'FAIL', 'state=' + rF.state);
    t('F reason 标明产出物校验失败', /产出物校验失败/.test(String(rF.reason || '')), String(rF.reason || '').slice(0, 80));

    // G：模型真写且内容正确 → PASS，artifacts.ok=true
    fs.rmSync(path.join(tmp, 'good.txt'), { force: true });
    globalThis.fetch = makeScriptedFetch([
      toolCallResponse('write', { file_path: 'good.txt', content: 'hello-777' }),
      textResponse('done'),
    ]);
    const rG = await runWithTools({ task: '写 good.txt 内容 hello-777', tools: ['write'], cwd: tmp, maxSteps: 4, maxTokens: 300, expectArtifacts: [{ path: 'good.txt', contains: 'hello-777' }] });
    t('G 真产出 → state=PASS', rG.state === 'PASS', 'state=' + rG.state);
    t('G artifacts.ok=true', rG.artifacts && rG.artifacts.ok === true);
  }

  console.log('\n  H. 团队 + expectArtifacts：缺产出 → 团队 FAIL');
  {
    const { runTeam } = await import('./team.mjs');
    const f = async (url, opts) => {
      const body = JSON.parse(opts.body);
      const msgs = body.messages || []; const last = msgs[msgs.length - 1] || {};
      const all = msgs.map((m) => m.content).join('\n');
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      let content = '';
      if (!hasTools && /拆成|子任务/.test(all)) content = JSON.stringify({ subtasks: [{ title: '产出 x', assignee: 'implementer', spec: '创建 never.txt' }] });
      else if (hasTools && last.role !== 'tool') content = '我完成了，不需要工具'; // 不调工具（撒谎）
      else content = '评审通过。\nVERDICT: PASS';
      return { ok: true, status: 200, async json() { return { model: 's', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} }; }, async text() { return '{}'; } };
    };
    globalThis.fetch = f;
    fs.rmSync(path.join(tmp, 'never.txt'), { force: true });
    const rH = await runTeam({ objective: '创建 never.txt', tools: ['write'], cwd: tmp, maxSubtasks: 2, maxRounds: 1, expectArtifacts: [{ path: 'never.txt' }] });
    t('H 团队未产出声明物 → state!=PASS', rH.state !== 'PASS', 'state=' + rH.state);
    t('H reason 标明产出物校验失败', /产出物校验失败/.test(String(rH.reason || '')), String(rH.reason || '').slice(0, 80));
  }

  // ── I. checkArtifacts 单元反例 ──
  console.log('\n  I. checkArtifacts 单元反例');
  {
    const { checkArtifacts } = await import('./artifacts.mjs');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
    fs.writeFileSync(path.join(d, 'a.txt'), 'abc');
    t('I 存在且内容匹配 → ok', checkArtifacts([{ path: 'a.txt', contains: 'abc' }], d).ok === true);
    t('I 内容不匹配 → 失败', checkArtifacts([{ path: 'a.txt', contains: 'zzz' }], d).ok === false);
    t('I 不存在 → 失败', checkArtifacts([{ path: 'nope.txt' }], d).ok === false);
    t('I minBytes 不满足 → 失败', checkArtifacts([{ path: 'a.txt', minBytes: 999 }], d).ok === false);
    t('I 空声明列表 → 视为通过（不启用）', checkArtifacts([], d).ok === true);
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ── J. inferArtifacts 保守推断单元测试 ──
  console.log('\n  J. inferArtifacts 保守推断');
  {
    const { inferArtifacts } = await import('./infer.mjs');
    const j1 = inferArtifacts('创建 out.txt 内容 team-ok-777');
    t('J 写动词+文件名 → high', j1.confidence === 'high' && j1.artifacts.some((a) => a.path === 'out.txt'));
    t('J 抽取到内容提示', j1.artifacts.some((a) => a.path === 'out.txt' && a.contains === 'team-ok-777'), JSON.stringify(j1.artifacts));
    const j2 = inferArtifacts('帮我看看 config.json 里有什么');
    t('J 只有文件名无写动词 → 不推断（防误报）', j2.confidence === 'none' && j2.artifacts.length === 0, JSON.stringify(j2));
    t('J 但要给出 candidates 供人确认', j2.candidates.includes('config.json'));
    const j3 = inferArtifacts('随便聊聊天气');
    t('J 完全无文件名 → none', j3.confidence === 'none' && j3.candidates.length === 0);
    const j4 = inferArtifacts('把结果写入 report.md');
    t('J 英文/中文写动词都识别', j4.confidence === 'high' && j4.artifacts.some((a) => a.path === 'report.md'));
  }

  // ── K. 产品主路径：hostapi start_run 端到端（显式 ask 产出 → 缺失则 FAIL）──
  console.log('\n  K. 产品主路径 start_run：显式 expectArtifacts 缺失 → FAIL');
  {
    const { agentMethods } = await import('../../tools/hostapi/methods-agent.mjs');
    const methods = agentMethods();
    // 假模型：只说不做
    globalThis.fetch = makeScriptedFetch([textResponse('我已经完成了')]);
    let done = null;
    const notify = (evt) => { if (evt && evt.event === 'nianchu://agent-done') done = evt.payload; };
    const start = await methods.start_run({ request: { task: '创建 must2.txt', cwd: tmp, maxSteps: 2, expectArtifacts: [{ path: 'must2.txt' }] } }, { notify });
    // 等 agent-done 事件（最多 8s）
    const t0 = Date.now();
    while (!done && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    t('K start_run 返回 runId', Boolean(start && start.runId), JSON.stringify(start).slice(0, 80));
    t('K 显式启用产出物校验', start && start.enforceArtifacts === true);
    t('K 收到 agent-done 事件', Boolean(done));
    t('K 模型未产出声明文件 → 结果 state=FAIL', done && done.state === 'FAIL', done ? 'state=' + done.state : 'no-event');
  }

  globalThis.fetch = origFetch;
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n  结果：通过 ' + pass + ' · 失败 ' + fail);
  console.log('  四态: ' + (fail === 0 ? 'PASS' : 'FAIL'));
  console.log('  ⚠ 本测试只证明「给定 tool_calls → 系统真的执行并落盘，错误不静默」；模型质量仍需真跑（UNKNOWN）。');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { globalThis.fetch = origFetch; console.error('  ✗ 异常：' + e.stack); process.exit(1); });