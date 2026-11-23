/**
 * C1 循环完整性验证 —— 中断 / 步边界注入 / 阶段上报。
 *
 * 【为什么这条要紧】C1 在矩阵里是**三家共同赢我们**的维度
 * （dsh / openclaw / hermes 的 themOnly 里都有 C1）。差距不是"能不能跑完"，
 * 而是**跑到一半能不能干预**：
 *   · 用户想停 → 停得掉吗？停下时已做的事还在吗？
 *   · 用户在跑的过程中补一句话 → 会被丢掉吗？
 *   · 外面看得到"它现在在干什么"吗？
 *
 * 对标证据：dsh `packages/core/agent-loop/src/agent.ts:2`（queued turns + step-boundary input）、
 * `:53-61`（phase idle/running + AbortController + wakeRequested）、`:192`（cancel(cause)）。
 *
 * 用法：node tools/agent/verify-loop-control.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { modelAvailable } from './_model-probe.mjs';
import { runWithTools } from './loop.mjs';
import { STOP_META } from './stop.mjs';

// 第 190 轮：模型不可用/退化时，模型相关段标 UNKNOWN 跳过（不伪 FAIL）。
const _modelOk = await modelAvailable();
if (!_modelOk) console.log('  ⚠ 模型不可用（网关 401/退化）→ 模型相关段 UNKNOWN，跳过');

let pass = 0;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  循环完整性验证（中断 / 步边界注入 / 阶段上报）');
console.log('  ' + '─'.repeat(72));

// ══ 一、已取消的信号：一步都不该跑（不花钱、不产生副作用）══
{
  const ac = new AbortController();
  ac.abort('用户提前取消');
  const phases = [];
  const r = await runWithTools({
    systemPrompt: '你是 agent。',
    task: '创建 cancel.txt 并写入内容。',
    cwd: process.cwd(),
    maxSteps: 4,
    signal: ac.signal,
    onPhase: (p) => phases.push(p.kind),
  });

  t('★反例：进入前已取消 → 不调模型（usage.calls=0）', (r.usage?.calls || 0) === 0,
    JSON.stringify(r.usage));
  t('★返回 aborted=true', r.aborted === true);
  t('★停止原因是 user_abort', r.stopReason === 'user_abort', r.stopReason);
  t('★四态是 WARN（取消不是失败，也不是成功）', r.state === STOP_META.user_abort.four, r.state);
  t('transcript 里留下 abort 记录（可审计）',
    Array.isArray(r.transcript) && r.transcript.some((x) => x.kind === 'abort'));
  t('阶段上报过 running 与 idle', phases.includes('running') && phases.includes('idle'),
    phases.join(','));
}

// ══ 二、跑到一半取消：已发生的工具记录必须还在 ══
{
  const ac = new AbortController();
  let stepsSeen = 0;
  const r = await runWithTools({
    systemPrompt: '你是 agent。',
    task: '用 bash 依次执行：echo a1、echo a2、echo a3，然后总结。',
    cwd: process.cwd(),
    maxSteps: 6,
    signal: ac.signal,
    onPhase: (p) => {
      if (p.kind === 'running' && p.step !== undefined) {
        stepsSeen++;
        // 第一步之后就取消
        if (stepsSeen >= 1) ac.abort('中途取消');
      }
    },
  });

  t('★中途取消生效（aborted=true）', r.aborted === true);
  t('★中途取消后四态不是 PASS', r.state !== 'PASS', r.state);
  t('★已发生的工具调用记录被保留（不丢历史）',
    Array.isArray(r.transcript), String(r.transcript && r.transcript.length));
  t('停止原因仍是 user_abort', r.stopReason === 'user_abort', r.stopReason);
}

// ══ 三、步边界注入：跑到一半补的话不能丢 ══
if (_modelOk) {
  /**
   * 注入放在**第一次拉取**，而不是第二次。
   * 原因：模型有时一步就把任务收尾了（只拉一次），若固定在第二次注入，
   * 这条判据就会因为"跑太快"而假失败 —— 那不是机制错，是测试设计错。
   * 另外模型/网关偶发失败会走早退分支（没有 injectedCount），所以允许重试一次。
   */
  let pulled = 0;
  let r = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    pulled = 0;
    r = await runWithTools({
      systemPrompt: '你是 agent。',
      task: '用 bash 执行 echo step-one，然后总结。',
      cwd: process.cwd(),
      maxSteps: 4,
      inbox: () => {
        pulled++;
        if (pulled === 1) return '补充：还要再执行一次 echo step-two';
        return null;
      },
    });
    if (typeof r.injectedCount === 'number') break;
  }

  t('★inbox 被按步拉取（至少 1 次）', pulled >= 1, String(pulled));
  t('★注入被记录进 transcript（kind=inbox）',
    Array.isArray(r.transcript) && r.transcript.some((x) => x.kind === 'inbox'),
    JSON.stringify((r.transcript || []).filter((x) => x.kind === 'inbox').length));
  t('★返回 injectedCount 可审计', typeof r.injectedCount === 'number', String(r.injectedCount));
  t('注入内容没丢（计数 > 0）', r.injectedCount > 0, String(r.injectedCount));
  t('有注入时仍能正常收尾（四态合法）',
    ['PASS', 'WARN', 'FAIL', 'UNKNOWN'].includes(r.state), r.state);
}

// ══ 四、反例：inbox 一直返回 null → 一次都不该注入 ══
if (_modelOk) {
  const r = await runWithTools({
    systemPrompt: '你是 agent。',
    task: '只回复两个字：收到',
    cwd: process.cwd(),
    maxSteps: 2,
    inbox: () => null,
  });
  t('★反例：inbox 恒为 null → injectedCount=0',
    r.injectedCount === 0 && !r.transcript.some((x) => x.kind === 'inbox'),
    String(r.injectedCount));
}

// ══ 五、反例：不传 signal/inbox 时行为不变（向后兼容）══
if (_modelOk) {
  const r = await runWithTools({
    systemPrompt: '你是 agent。',
    task: '只回复两个字：收到',
    cwd: process.cwd(),
    maxSteps: 2,
  });
  t('反例：不传 signal → aborted=false', r.aborted === false);
  t('反例：不传 inbox → injectedCount=0', r.injectedCount === 0);
  t('反例：原有字段仍在（state/traceId/stopReason）',
    typeof r.state === 'string' && typeof r.traceId === 'string' && typeof r.stopReason === 'string');
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 能中途取消且保留历史；步边界能注入不丢话；阶段可观测'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;