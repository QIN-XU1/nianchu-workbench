import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { ensureServer, stopServer } from '../workbench/_serve.mjs';
import { modelAvailable } from './_model-probe.mjs';
// 第 201 轮：WS 需服务；不可达则自起（起不来如实 UNKNOWN）
const _srv = await ensureServer('http://127.0.0.1:47124');
if (!_srv.ok) {
  console.log('  ⚠ ' + _srv.why + ' → UNKNOWN（环境问题，不是代码缺陷）');
  await stopServer(_srv.child);
  process.exit(2);
}
// 本测试依赖模型完成一轮对话（run_task）；模型不可用时整段无法验证 → UNKNOWN
if (!(await modelAvailable())) {
  console.log('  ⚠ 模型不可用（网关 401/400）→ UNKNOWN（本测试依赖模型完成一轮对话）');
  await stopServer(_srv.child);
  process.exit(2);
}

const probe = process.env.TEMP + '\\nianchu_cs_rpc';
rmSync(probe, { recursive: true, force: true });
mkdirSync(probe, { recursive: true });
const target = probe + '\\app.conf';
const ORIGINAL = 'timeout=10\nretries=3\n';
writeFileSync(target, ORIGINAL, 'utf8');

const ws = new WebSocket('ws://127.0.0.1:47124/ws');
const pending = new Map();
let id = 0;
const call = (method, params) => new Promise((res, rej) => {
  const myId = 'x' + (++id);
  pending.set(myId, { res, rej });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }));
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 240000);
});
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
};

ws.onopen = async () => {
  const out = { checks: [], ok: true };
  const t = (name, ok, info) => {
    out.checks.push({ name, ok, info });
    if (!ok) out.ok = false;
  };
  try {
    const r = await call('run_task', { request: {
      task: `把 ${target} 里的 timeout=10 改成 timeout=30，读回确认，然后一句话总结。`,
      cwd: probe,
      maxSteps: 8,
    } });
    t('run_task 四态', r.state === 'PASS' || r.state === 'WARN', r.state);
    t('有变更集 id', typeof r.changeSetId === 'string' && r.changeSetId.startsWith('cs-'));
    t('diff 里有 1 个文件', (r.changeSet?.files || []).length === 1, String((r.changeSet?.files || []).length));
    const f = (r.changeSet?.files || [])[0];
    t('diff 状态是 modified', f?.status === 'modified', String(f?.status));
    t('diff 有 +30/-10 行',
      (f?.lines || []).some((l) => l.type === '+' && String(l.text).includes('30'))
      && (f?.lines || []).some((l) => l.type === '-' && String(l.text).includes('10')));
    t('文件真的被改了', readFileSync(target, 'utf8').includes('timeout=30'));

    // list_changes 能看到它
    const ls = await call('list_changes', { request: { limit: 10 } });
    t('list_changes 能列出这次变更', Array.isArray(ls) && ls.some((x) => x.setId === r.changeSetId));

    // get_change_set 能取回 diff
    const gs = await call('get_change_set', { request: { changeSetId: r.changeSetId } });
    t('get_change_set 能取回 diff', gs.state === 'PASS' && (gs.changeSet?.files || []).length === 1);

    // 回滚
    const rb = await call('rollback_change', { request: { changeSetId: r.changeSetId } });
    t('rollback_change 返回 PASS', rb.state === 'PASS', rb.state + ' ' + (rb.reason || ''));
    t('★回滚后文件恢复成原始内容（逐字节）', readFileSync(target, 'utf8') === ORIGINAL,
      JSON.stringify(readFileSync(target, 'utf8')));

    // 反例：重复回滚
    const rb2 = await call('rollback_change', { request: { changeSetId: r.changeSetId } });
    t('★反例：重复回滚返回 WARN（不静默成功）', rb2.state === 'WARN', rb2.state);

    // 反例：未知变更集
    const rb3 = await call('rollback_change', { request: { changeSetId: 'cs-nope' } });
    t('★反例：未知变更集 → UNKNOWN', rb3.state === 'UNKNOWN', rb3.state);
  } catch (e) {
    t('RPC 过程无异常', false, e.message);
  }
  for (const c of out.checks) {
    console.log('    ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.ok ? '' : '  ← ' + (c.info || '')));
  }
  console.log('');
  const _p = out.checks.filter((c) => c.ok).length;
  const _f = out.checks.length - _p;
  console.log('  结果：通过 ' + _p + ' · 失败 ' + _f);
  rmSync(probe, { recursive: true, force: true });
  ws.close();
  await stopServer(_srv.child);
  process.exitCode = out.ok ? 0 : 1;
};
ws.onerror = () => { if (process.exitCode === undefined) { console.log('    WS error → UNKNOWN'); process.exitCode = 2; } };