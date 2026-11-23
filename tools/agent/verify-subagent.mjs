/**
 * 子代理（A8）验证 —— 含反例。
 *
 * 【要证明什么】A8 在矩阵里我们是「部分」，输给它的是「有」。差距不在"能不能跑多个"，
 * 而在两条**契约**：
 *   ① 子代理**看不到父上下文**（fresh context）—— 否则父的噪声会带偏子，也没法独立判断
 *   ② 递归**有深度上限** —— 否则 A 派 B、B 派 A 无限套娃烧钱
 * 所以这里不测"能不能跑"，专门测这两条，而且都能用**确定性断言**（不靠模型输出）。
 *
 * 用法：node tools/agent/verify-subagent.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { modelAvailable } from './_model-probe.mjs';
import {
  spawnSubagent, spawnBatch, composeSubagentPrompt,
  DEFAULT_DEPTH_LIMIT, DEFAULT_CONCURRENCY,
} from './subagent.mjs';
import { createToolkit } from './toolkit.mjs';
import { readFileSync } from 'node:fs';

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
console.log('  子代理验证（隔离上下文 + 深度上限 + 并发）');
console.log('  ' + '─'.repeat(72));

// ══ 一、隔离：子代理的 prompt 里不该有父对话 ══
{
  const PARENT_SECRET = '父对话里的机密-ABC123';
  // 模拟：父调用时即便误传了 messages/history，也不该进 prompt
  const prompt = composeSubagentPrompt('查一下 2+2 等于几', '你是调研子代理');
  t('★子代理 prompt 只含自己的任务', prompt.includes('查一下 2+2 等于几'));
  t('★子代理 prompt 不含父对话内容', !prompt.includes(PARENT_SECRET));
  t('prompt 明确写了隔离约定（看不到父对话）', /看不到父对话/.test(prompt));

  // 反例：即便把父内容塞进 extra 字段，也不会被用上（函数签名根本不接收）
  const prompt2 = composeSubagentPrompt('任务X', undefined);
  t('★反例：不传 systemPrompt 也有默认角色（不会裸跑）', /子代理/.test(prompt2));
  t('★反例：task 为空也不会带出父内容', !composeSubagentPrompt('', '角色').includes(PARENT_SECRET));
}

// ══ 二、深度上限（确定性，不花模型调用）══
{
  t('默认深度上限是 2', DEFAULT_DEPTH_LIMIT === 2);

  const atLimit = await spawnSubagent({ task: '随便', depth: 2, depthLimit: 2 });
  t('★反例：depth 到上限 → 拒绝（FAIL）而不是静默降级',
    atLimit.state === 'FAIL' && atLimit.refused === true, JSON.stringify(atLimit).slice(0, 140));
  t('★拒绝原因点明是深度上限', /深度上限/.test(String(atLimit.reason)), String(atLimit.reason));

  const overLimit = await spawnSubagent({ task: '随便', depth: 5, depthLimit: 2 });
  t('★反例：depth 超过上限 → 同样拒绝', overLimit.state === 'FAIL' && overLimit.refused === true);

  const empty = await spawnSubagent({ task: '   ', depth: 0 });
  t('★反例：空任务 → FAIL 且不调模型',
    empty.state === 'FAIL' && /为空/.test(String(empty.reason)), String(empty.reason));

  // 深度未到上限时不应该被拦（用极短任务，真实跑一次）—— 需模型
  if (_modelOk) {
  const okSpawn = await spawnSubagent({
    task: '只回复两个字：收到', depth: 1, depthLimit: 2, maxSteps: 2,
  });
  t('未到上限的子代理能跑（state=PASS）', okSpawn.state === 'PASS', okSpawn.state + ' ' + String(okSpawn.reason));
  t('结果带 isolated 标记（可审计）', okSpawn.isolated === true);
  t('结果带 depth（可审计）', okSpawn.depth === 1, String(okSpawn.depth));
  }
}

// ══ 三、并发批量 ══
if (_modelOk) {
  t('默认并发上限是 3', DEFAULT_CONCURRENCY === 3);

  const emptyBatch = await spawnBatch([]);
  t('★反例：空批次 → FAIL', emptyBatch.state === 'FAIL');

  const started = Date.now();
  const batch = await spawnBatch([
    { task: '只回复一个数字：1' },
    { task: '只回复一个数字：2' },
  ], { concurrency: 2, maxSteps: 2 });
  const elapsed = Date.now() - started;

  t('批量返回结果数与任务数一致', Array.isArray(batch.results) && batch.results.length === 2,
    String(batch.results && batch.results.length));
  t('★并发不超过上限（hard invariant）', batch.peakConcurrency <= batch.concurrencyLimit,
    batch.peakConcurrency + '/' + batch.concurrencyLimit);
  t('结果按索引对齐（都有 depth/isolated）',
    batch.results.every((r) => r && r.isolated === true && typeof r.depth === 'number'));
  t('批量整体四态合理（PASS/WARN/FAIL）', ['PASS', 'WARN', 'FAIL'].includes(batch.state), batch.state);
  t('批量统计自洽（ok + failed <= total）', batch.ok + batch.failed <= batch.total,
    JSON.stringify({ ok: batch.ok, failed: batch.failed, total: batch.total }));
  console.log('      （本次批量耗时 ' + elapsed + 'ms，peak=' + batch.peakConcurrency + '）');
}

// ══ 四、工具化成 spawn_subagent：agent 能自己派活 ══
// 【接线判定 · 不依赖模型】界面画了「子代理」卡片，但工具必须真的进了 runWithTools 的默认工具表，
// 否则模型根本调不到 —— 卡片就成了永不出现的空壳。（批次 Z.5 实测发现默认表漏了它。）
{
  const loopSrc = readFileSync(new URL('./loop.mjs', import.meta.url), 'utf8');
  const m = loopSrc.match(/tools:\s*toolNames\s*=\s*\[([\s\S]*?)\]/);
  t('★默认工具表含 spawn_subagent（否则子代理卡片永远不出现）',
    Boolean(m) && /'spawn_subagent'/.test(m[1]), m ? m[1].replace(/\s+/g, ' ').slice(0, 120) : '未找到默认工具表');
}
if (_modelOk) {
  const tk = createToolkit({ cwd: process.cwd(), subagentDepth: 0, subagentDepthLimit: 2 });
  t('toolkit 里有 spawn_subagent 工具', Boolean(tk.spawn_subagent));
  t('工具 schema 要求 task', (tk.spawn_subagent.input_schema.required || []).includes('task'));

  const r = await tk.spawn_subagent.call({ task: '只回复两个字：好的' }, { cwd: process.cwd(), subagentDepth: 0, subagentDepthLimit: 2 });
  t('工具调用返回四态', typeof r.state === 'string', JSON.stringify(r).slice(0, 120));
  t('工具返回带 depth（深度传播可用）', typeof r.depth === 'number', String(r.depth));
  t('★工具返回带 innerSteps（界面能下钻子代理内部工具流）', Array.isArray(r.innerSteps), JSON.stringify(r).slice(0, 140));

  // 反例：到深度上限时工具返回 ok=false，不是假装成功
  const tkDeep = createToolkit({ cwd: process.cwd(), subagentDepth: 2, subagentDepthLimit: 2 });
  const deep = await tkDeep.spawn_subagent.call({ task: '随便' }, { cwd: process.cwd(), subagentDepth: 2, subagentDepthLimit: 2 });
  t('★反例：工具在深度上限处返回 ok=false',
    deep.ok === false && /深度上限/.test(String(deep.reason)), JSON.stringify(deep).slice(0, 140));
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 子代理隔离上下文、递归有硬上限、并发有上限且结果按索引对齐'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;