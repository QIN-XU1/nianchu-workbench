/**
 * 流式推送验证：run_task 期间，工具步骤必须**边跑边到**。
 *
 * 反例要求：不能等全部跑完才一起到（那就不是流式）。
 * 这里用「收到第一条事件的时间」对比「最终返回的时间」来证明真的是流式。
 */
import { rmSync, mkdirSync } from 'node:fs';
import { ensureServer, stopServer } from '../workbench/_serve.mjs';
import { modelAvailable } from './_model-probe.mjs';
// 第 201 轮：WS 需服务；不可达则自起（起不来如实 UNKNOWN）
const _srv = await ensureServer('http://127.0.0.1:47124');
if (!_srv.ok) {
  console.log('  ⚠ ' + _srv.why + ' → UNKNOWN（环境问题，不是代码缺陷）');
  await stopServer(_srv.child);
  process.exit(2);
}
// 本测试依赖模型真跑一轮（run_task 边跑边推）；模型不可用时整段无法验证 → UNKNOWN
if (!(await modelAvailable())) {
  console.log('  ⚠ 模型不可用（网关 401/400）→ UNKNOWN（本测试依赖模型真跑一轮）');
  await stopServer(_srv.child);
  process.exit(2);
}

const probe = process.env.TEMP + '\\nianchu_stream';
rmSync(probe, { recursive: true, force: true });
mkdirSync(probe, { recursive: true });

const ws = new WebSocket('ws://127.0.0.1:47124/ws');
const pending = new Map();
const events = [];
let id = 0;
const call = (method, params) => new Promise((res, rej) => {
  const myId = 's' + (++id);
  pending.set(myId, { res, rej });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }));
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 240000);
});

ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === 'agent/frontendEvent' && m.params?.event) {
    events.push({ at: Date.now(), event: m.params.event, payload: m.params.payload });
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
};

ws.onopen = async () => {
  const checks = [];
  const t = (name, ok, info) => { checks.push({ name, ok, info }); console.log('    ' + (ok ? '✓' : '✗') + ' ' + name + (ok ? '' : '  ← ' + (info || ''))); };

  const startedAt = Date.now();
  const r = await call('run_task', { request: {
    task: '创建 s1.txt 写 one，创建 s2.txt 写 two，然后用 bash 列出目录，最后一句总结。',
    cwd: probe,
    maxSteps: 8,
  } });
  const finishedAt = Date.now();

  const steps = events.filter((e) => e.event === 'nianchu://agent-step' && e.payload?.runToken === r.runToken);
  const answers = events.filter((e) => e.event === 'nianchu://agent-answer' && e.payload?.runToken === r.runToken);
  const dones = events.filter((e) => e.event === 'nianchu://agent-done' && e.payload?.runToken === r.runToken);

  t('收到了流式步骤事件（>=2 条）', steps.length >= 2, String(steps.length));
  t('步骤事件带工具名与成败', steps.every((e) => typeof e.payload.tool === 'string' && typeof e.payload.ok === 'boolean'));
  t('收到了最终答复事件', answers.length >= 1, String(answers.length));
  t('收到了 done 事件且四态一致', dones.length === 1 && dones[0].payload.state === r.state,
    JSON.stringify(dones.map((d) => d.payload.state)));

  // 关键反例：第一条事件必须明显早于最终返回
  const firstEventAt = steps.length ? steps[0].at : finishedAt;
  const lead = finishedAt - firstEventAt;
  t('★反例：第一条步骤事件早于返回（证明是流式，不是跑完才给）',
    steps.length > 0 && firstEventAt < finishedAt && lead > 50,
    'lead=' + lead + 'ms');

  // 事件顺序应大致递增
  const ordered = steps.every((e, i) => i === 0 || e.at >= steps[i - 1].at);
  t('事件按时间顺序到达', ordered);

  // 结果本身仍完整
  t('返回值仍是完整结果（有 changeSetId）', typeof r.changeSetId === 'string');
  t('变更集记录了 2 个文件', r.changedFiles === 2, String(r.changedFiles));

  const passed = checks.filter((c) => c.ok).length;
  console.log('');
  console.log('    事件明细: step=' + steps.length + ' answer=' + answers.length + ' done=' + dones.length);
  console.log('    首事件比返回早 ' + lead + 'ms');
  console.log('  结果：通过 ' + passed + ' · 失败 ' + (checks.length - passed));

  rmSync(probe, { recursive: true, force: true });
  ws.close();
  await stopServer(_srv.child);
  process.exitCode = passed === checks.length ? 0 : 1;
};
ws.onerror = () => { if (process.exitCode === undefined) { console.log('    WS error → UNKNOWN'); process.exitCode = 2; } };