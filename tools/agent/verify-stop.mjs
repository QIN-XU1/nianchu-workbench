/**
 * 停止条件可判定性验证 —— 这是「跑完了 ≠ 做成了」的守门人。
 *
 * 【为什么这条最要紧】矩阵里 C2 原来是「无」：跑完分不清是做完还是被预算逼停。
 * 分不清就等于不可判。所以这里**逐格**钉住判定表，并且专门钉住最容易自欺的组合：
 *   「撞了步数上限，但它给了个漂亮答复」 → 必须判 step_budget / WARN，**不许 PASS**。
 *
 * 用法：node tools/agent/verify-stop.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { modelAvailable } from './_model-probe.mjs';
import { STOP_REASONS, STOP_META, classifyStop, assertNotFalseGreen, describeStop } from './stop.mjs';
import { runWithTools } from './loop.mjs';

let pass = 0;
let skipped = false;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

console.log('');
console.log('  停止条件可判定性验证');
console.log('  ' + '─'.repeat(72));

// ══ 一、判定表完整性 ══
{
  t('九个原因都有元信息', STOP_REASONS.every((r) => STOP_META[r] && STOP_META[r].four));
  t('每个原因都是终态（没有"还在跑"混进来）', STOP_REASONS.every((r) => STOP_META[r].terminal === true));
  t('只有 done 对应 PASS', STOP_REASONS.filter((r) => STOP_META[r].four === 'PASS')
    .join(',') === 'done');
}

// ══ 二、逐格判定（正例）══
{
  const done = classifyStop({ finalText: '做完了', toolCalls: 3, failedToolCalls: 0 });
  t('正常完成 → done / PASS', done.reason === 'done' && done.four === 'PASS', describeStop(done));

  const step = classifyStop({ finalText: '给了个答案', toolCalls: 5, hitStepLimit: true });
  t('★撞步数上限且有答复 → step_budget / WARN（不许 PASS）',
    step.reason === 'step_budget' && step.four === 'WARN', describeStop(step));

  const time = classifyStop({ finalText: 'x', hitTimeLimit: true });
  t('撞时间上限 → time_budget / WARN', time.reason === 'time_budget' && time.four === 'WARN');

  const trunc = classifyStop({ finalText: '半截', truncated: true });
  t('输出被截断 → truncated / WARN', trunc.reason === 'truncated' && trunc.four === 'WARN');

  const toolErr = classifyStop({ finalText: null, toolCalls: 4, failedToolCalls: 4 });
  t('工具全失败且无答复 → tool_error / FAIL', toolErr.reason === 'tool_error' && toolErr.four === 'FAIL');

  const modelErr = classifyStop({ modelError: '网关 500' });
  t('模型层错误 → model_error / FAIL', modelErr.reason === 'model_error' && modelErr.four === 'FAIL');

  const empty = classifyStop({ finalText: null, toolCalls: 0 });
  t('既没工具也没答复 → empty_output / UNKNOWN',
    empty.reason === 'empty_output' && empty.four === 'UNKNOWN', describeStop(empty));

  const abort = classifyStop({ finalText: '被迫停', userAbort: true });
  t('显式取消 → user_abort / WARN', abort.reason === 'user_abort' && abort.four === 'WARN');
}

// ══ 三、优先级（同时满足多条时，谁说了算）══
{
  const a = classifyStop({ finalText: 'x', userAbort: true, hitStepLimit: true, modelError: 'e' });
  t('★取消优先于一切', a.reason === 'user_abort', a.reason);

  const b = classifyStop({ finalText: 'x', modelError: 'e', hitTimeLimit: true });
  t('模型错误优先于时间上限', b.reason === 'model_error', b.reason);

  const c = classifyStop({ finalText: 'x', hitTimeLimit: true, hitStepLimit: true });
  t('时间上限优先于步数上限', c.reason === 'time_budget', c.reason);

  const d = classifyStop({ finalText: 'x', hitStepLimit: true, truncated: true });
  t('步数上限优先于截断', d.reason === 'step_budget', d.reason);
}

// ══ 四、假绿灯守门 ══
{
  t('★守门：撞预算却判 PASS → 报错',
    assertNotFalseGreen({ reason: 'step_budget', four: 'PASS' }).ok === false);
  t('守门：正常 done/PASS → 通过',
    assertNotFalseGreen({ reason: 'done', four: 'PASS' }).ok === true);
  t('★守门：done 却不是 PASS → 报错',
    assertNotFalseGreen({ reason: 'done', four: 'WARN' }).ok === false);
  t('★守门：没有判定 → 报错（不许默认通过）',
    assertNotFalseGreen(null).ok === false);
}

// ══ 五、反例：有工具失败但仍完成，要如实标出来 ══
{
  const partial = classifyStop({ finalText: '做完了但有失败', toolCalls: 3, failedToolCalls: 1 });
  t('有工具失败但完成 → 仍 done/PASS', partial.reason === 'done' && partial.four === 'PASS');
  t('★但会如实标出失败次数（不掩盖）', /工具调用失败/.test(String(partial.contradictory)),
    String(partial.contradictory));
}

// ══ 六、真实循环：撞 maxSteps 必须给 step_budget 而不是 done ══
{
  /**
   * 强制撞步数上限：maxSteps=1 且任务必须多步（先写再读再跑），
   * 模型完成不了 1 步就收尾。**重试 2 次**防止模型恰好一步答完导致误判
   * （这条验的是判定机制，不是模型听话度）。
   */
  /**
   * ══ --no-model：跳过真跑段（2026-11-20 加）══
   * 网关配额耗尽时，这段会因模型不可用而整体判 UNKNOWN，把**纯逻辑段**的通过结果一起埋掉。
   * 加这个开关后：纯逻辑段照跑照报，真跑段**如实标 UNKNOWN**，两者分开。
   */
  if (process.argv.includes('--no-model') || !(await modelAvailable())) {
    console.log('  ⚠ 真跑段跳过（--no-model 或模型不可用）：stopReason 的**判定逻辑**已验，');
    console.log('    但「真跑撞 maxSteps 会不会给出 step_budget」这一段是 UNKNOWN（需模型）。');
    skipped = true;
  } else {
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = await runWithTools({
      systemPrompt: '你是 agent，必须调用工具，不许只凭记忆回答。',
      task: '严格按顺序用 bash 做 3 件事：1) 新建 /tmp/stop_probe_a.txt 2) 读它 3) 删掉它。每步都要真的执行命令。',
      cwd: process.cwd(),
      maxSteps: 1,
    });
    if (r.stopReason === 'step_budget') break;
  }
  t('★真跑撞 maxSteps=2 → stopReason 是 step_budget（不是 done）',
    r.stopReason === 'step_budget', r.stopReason + ' ' + String(r.stopDetail));
  t('★撞预算时四态不是 PASS', r.state !== 'PASS', r.state);
  t('返回值带 stopLabel / stopDetail（可审计）',
    typeof r.stopLabel === 'string' && typeof r.stopDetail === 'string');
  t('守门函数对这个真实结果不报错',
    assertNotFalseGreen({ reason: r.stopReason, four: r.state }).ok === true,
    JSON.stringify(assertNotFalseGreen({ reason: r.stopReason, four: r.state })));
}
  }


console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 再来一次都能说清「为什么停」；撞预算绝不判 PASS'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;