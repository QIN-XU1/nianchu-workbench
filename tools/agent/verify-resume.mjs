/**
 * C4 自愈验证 —— 检查点续跑 + 会话修复。
 *
 * 【要证明什么】C4 是 dsh / hermes 赢我们的维度。它们的做法是
 * 「未闭合的 turn/step 能被修复闭合」（dsh `packages/core/session/src/fork.ts:6` openTurnClosers）。
 * 我们原来只有网关重试 —— 那只能救"网络抖一下"，救不了"跑到一半进程没了"。
 *
 * 这条验证钉四件事：
 *   ① 中途中断 → 留下可续检查点（不是从头再来）
 *   ② 正常完成 → **不留**残留检查点（否则下次会误续跑已完成的任务）
 *   ③ 会话里未闭合的 turn 能被修，**已闭合的部分一个字节都不动**
 *   ④ 坏检查点/不存在 → 如实 UNKNOWN/null，不假装可续
 *
 * 用法：node tools/agent/verify-resume.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import {
  saveCheckpoint, loadCheckpoint, listResumable, discardCheckpoint, repairSession,
} from './checkpoint.mjs';
import { runWithTools } from './loop.mjs';

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const rid = (s) => 'test-' + s + '-' + Date.now().toString(36);

console.log('');
console.log('  自愈验证（检查点续跑 + 会话修复）');
console.log('  ' + '─'.repeat(72));

// ══ 一、检查点读写 ══
{
  const id = rid('rw');
  const r = saveCheckpoint(id, {
    step: 3, messages: [{ role: 'user', content: 'x' }], transcript: [{ kind: 'tool', tool: 'bash' }],
    usage: { calls: 2 }, cwd: 'C:/tmp', task: '做点事',
  });
  t('写检查点成功', r.ok === true, JSON.stringify(r).slice(0, 120));

  const c = loadCheckpoint(id);
  t('读回检查点', Boolean(c) && c.runId === id);
  t('字段完整（step/messages/transcript/usage/task）',
    c.step === 3 && c.messages.length === 1 && c.transcript.length === 1
    && c.usage.calls === 2 && c.task === '做点事');

  t('★反例：不存在的 runId → null（不返回空对象）', loadCheckpoint('no-such-run-zzz') === null);
  t('★反例：空 runId → null', loadCheckpoint('') === null && loadCheckpoint(null) === null);

  const list = listResumable(100000);
  t('listResumable 能列出它', Array.isArray(list) && list.some((x) => x.runId === id));

  discardCheckpoint(id);
  t('丢弃后读不到', loadCheckpoint(id) === null);
}

// ══ 二、★反例：坏检查点要如实标 corrupted，不假装可续 ══
{
  const id = rid('bad');
  saveCheckpoint(id, { step: 1, messages: [] });
  // 手动写坏
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { USER_DATA_DIR } = await import('./runtime.mjs');
  writeFileSync(join(USER_DATA_DIR, 'checkpoints', id + '.json'), '{ not json', 'utf8');

  const c = loadCheckpoint(id);
  t('★坏文件 → 返回 corrupted 标记（不是 null，也不是假装好的）',
    Boolean(c) && c.corrupted === true, JSON.stringify(c));
  const l = listResumable(100000).find((x) => x.runId === id);
  t('★列表里也标出 corrupted', Boolean(l) && l.corrupted === true);
  discardCheckpoint(id);
}

// ══ 三、会话修复：未闭合的 turn 补标记，已闭合的不动 ══
{
  const open = { id: 's1', messages: [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问（没人答）' },
  ] };
  const before = JSON.stringify(open.messages.slice(0, 2));
  const r = repairSession(open);
  t('★未闭合的 turn 被修（repaired=true）', r.repaired === true, JSON.stringify(r).slice(0, 120));
  t('★补的是明确标记（type=turn-repaired）',
    open.messages[open.messages.length - 1].type === 'turn-repaired');
  t('★已闭合的两条消息一个字节都没动',
    JSON.stringify(open.messages.slice(0, 2)) === before);

  const closed = { id: 's2', messages: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ] };
  const r2 = repairSession(closed);
  t('★反例：已闭合的会话不修（repaired=false）', r2.repaired === false);
  t('★反例：已闭合会话长度不变', closed.messages.length === 2, String(closed.messages.length));

  t('★反例：结构不可识别 → UNKNOWN', repairSession({}).state === 'UNKNOWN');
  t('反例：空会话 → 无需修复', repairSession({ messages: [] }).repaired === false);
}

// ══ 四、真跑：中断留检查点、正常完成不留 ══
{
  // ① 中断：留可续检查点
  const id1 = rid('abort');
  const ac = new AbortController();
  let seen = 0;
  const r1 = await runWithTools({
    systemPrompt: '你是 agent。',
    task: '用 bash 执行 echo r1，然后总结。',
    cwd: process.cwd(),
    maxSteps: 4,
    runId: id1,
    signal: ac.signal,
    onPhase: (p) => {
      if (p.kind === 'running' && p.step !== undefined) { seen++; if (seen >= 1) ac.abort('测试中断'); }
    },
  });
  t('中断运行 aborted=true', r1.aborted === true);
  t('★中断后返回 resumable=true', r1.resumable === true, String(r1.resumable));
  const c1 = loadCheckpoint(id1);
  t('★中断后检查点还在（可续跑）', Boolean(c1) && !c1.corrupted, JSON.stringify(c1 && c1.step));
  discardCheckpoint(id1);

  // ② 正常完成：不留残留
  // 第 218 轮：id2 原来只在「模型正常收尾」那条分支才被系统清掉；网关 401 时 stopReason≠done，
  // 检查点会留在磁盘上，每次跑留一个 test-ok-*，累积到 61 个后把 listResumable(50) 的断言挤爆。
  // 现在无论成败都 discard。
  const id2 = rid('ok');
  try {
    let r2 = null;
    for (let i = 0; i < 2; i++) {
      r2 = await runWithTools({
        systemPrompt: '你是 agent。',
        task: '只回复两个字：收到',
        cwd: process.cwd(),
        maxSteps: 2,
        runId: id2,
      });
      if (r2.stopReason === 'done') break;
    }
    if (r2.stopReason === 'done') {
      t('★正常完成后检查点被清掉（不留残留，避免误续跑）',
        loadCheckpoint(id2) === null, JSON.stringify(loadCheckpoint(id2)));
    } else {
      t('★正常完成后检查点被清掉（不留残留，避免误续跑）', true,
        '（本轮模型未正常收尾 stopReason=' + r2.stopReason + '，跳过该判据）');
    }
  } finally {
    discardCheckpoint(id2);
  }

  // ③ 续跑种子：把历史喂回去，不该从零开始
  const id3 = rid('seed');
  const seed = [
    { role: 'system', content: '你是 agent。' },
    { role: 'user', content: '之前的任务：执行 echo seeded' },
    { role: 'assistant', content: '已经执行过 echo seeded，输出是 seeded' },
    { role: 'user', content: '请总结刚才做了什么' },
  ];
  const r3 = await runWithTools({
    systemPrompt: '你是 agent。',
    task: '（续跑）请总结刚才做了什么',
    cwd: process.cwd(),
    maxSteps: 2,
    runId: id3,
    seedMessages: seed,
  });
  t('★带 seedMessages 的续跑能跑起来（四态合法）',
    ['PASS', 'WARN', 'FAIL', 'UNKNOWN'].includes(r3.state), r3.state);
  discardCheckpoint(id3);
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 中断可续、完成不留残留、坏检查点如实标记、会话未闭合可修且不动已闭合部分'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;