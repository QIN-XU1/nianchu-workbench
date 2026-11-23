#!/usr/bin/env node
/**
 * 念初 · 子代理（隔离上下文 + 深度上限 + 并发批量）
 *
 * ══ 对标依据 ═════════════════════════════════════════════════
 * D:/refs/deepseek-harness/packages/subagent/subagent-spawn-in-process/src/index.ts:32-46
 *   「The spawn provider. Supports every start-time capability: `depthLimit`（it constructs
 *     the child, so it can enforce a recursion cap）…」
 *   `readonly inheritsParentContext = false`
 *   「Context contract: a spawned child starts fresh — it never sees the parent conversation.」
 *
 * 两条契约我们要照抄：
 *   ① **子代理不看父对话**（fresh context）—— 否则父的噪声会把子带偏，也没法独立判断
 *   ② **递归有深度上限**（depthLimit）—— 否则 A 派 B、B 派 A，无限套娃烧钱
 *
 * 我们原来只有 team.mjs 的**固定四角色**（规划/调研/实现/审阅），那是「流水线」，
 * 不是「子代理」：不能按需临时开、不能递归、不能并发一批。
 *
 * ══ 与 team.mjs 的区别 ═══
 *   team.mjs    ：固定的角色分工 + 独立审阅，跑一条流水线
 *   subagent.mjs：按需开子任务，隔离上下文，可并发一批，可递归（受 depthLimit 约束）
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 同一进程内并发（Promise.all + 并发上限），不是真进程隔离。崩溃会互相影响。
 * · 子代理共享同一个记忆库与工具集；没有按子代理隔离的权限。
 * · 没有 token 总预算控制（各子代理各自 maxSteps），批量大时成本会叠加。
 */
import { runWithTools } from './loop.mjs';
import { DEFAULT_MODEL } from './runtime.mjs';

/** 默认最大递归深度 */
export const DEFAULT_DEPTH_LIMIT = 2;
/** 默认批量并发上限 */
export const DEFAULT_CONCURRENCY = 3;

/**
 * 组装子代理的 system prompt。
 *
 * **纯度要求**：这个函数只能看到 task 与 systemPrompt，**拿不到父对话**。
 * 单独抽出来就是为了能被确定性验证 —— 「子代理看不到父上下文」这条契约，
 * 靠读代码说"应该不会"没有说服力，得能对一个 marker 断言它不在 prompt 里。
 */
export function composeSubagentPrompt(task, systemPrompt) {
  return [
    systemPrompt || '你是一个子代理。只完成交给你的这一个子任务。',
    '',
    '## 隔离约定',
    '· 你看不到父对话的上下文，也不应该假设自己知道。信息不足就**明确说出来**。',
    '· 只汇报：结论 + 你实际做了什么 + 证据（命令输出/文件路径）。不要客套。',
    '· 完成后给一句总结，不要复述任务。',
    '',
    '## 你的任务',
    String(task || ''),
  ].join('\n');
}

/**
 * 开一个子代理。**全新上下文**，只看得到 task 与 systemPrompt。
 *
 * @param {object} opts
 * @param {string} opts.task
 * @param {string} [opts.systemPrompt]
 * @param {number} [opts.depth=0]        当前深度（父调用时传自己 depth+1）
 * @param {number} [opts.depthLimit=2]   超过就拒绝
 * @param {string[]} [opts.tools]
 * @param {string} [opts.cwd]
 * @param {number} [opts.maxSteps=8]
 * @returns 结果里带 depth / isolated 标记，便于审计
 */
export async function spawnSubagent({
  task, systemPrompt, depth = 0, depthLimit = DEFAULT_DEPTH_LIMIT,
  tools, cwd, maxSteps = 8, model = DEFAULT_MODEL,
} = {}) {
  if (!task || !String(task).trim()) {
    return { state: 'FAIL', reason: '子任务为空', depth, isolated: true };
  }

  /**
   * 深度上限：**在构造子代理之前**就挡住。
   * 这是 dsh 的原话「it constructs the child, so it can enforce a recursion cap」。
   * 注意：到上限时返回 FAIL 而不是静默降级 —— 静默降级会让调用方以为派出去了。
   */
  if (depth >= depthLimit) {
    return {
      state: 'FAIL',
      reason: '达到递归深度上限 depthLimit=' + depthLimit + '（当前 depth=' + depth + '），拒绝再开子代理',
      depth, depthLimit, isolated: true, refused: true,
    };
  }

  const isolatedPrompt = composeSubagentPrompt(task, systemPrompt);

  const r = await runWithTools({
    systemPrompt: isolatedPrompt,
    task: String(task),
    tools,
    cwd,
    maxSteps,
    model,
  });

  return {
    ...r,
    depth,
    depthLimit,
    isolated: true, // 标记：这个结果来自全新上下文
  };
}

/**
 * 并发开一批子代理（带并发上限），返回**顺序对齐**的结果数组。
 * 顺序对齐很重要：调用方按索引取结果，不该因为谁先完成而错位。
 */
export async function spawnBatch(tasks, {
  concurrency = DEFAULT_CONCURRENCY, depth = 0, depthLimit = DEFAULT_DEPTH_LIMIT,
  tools, cwd, maxSteps = 8, model = DEFAULT_MODEL,
} = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return { state: 'FAIL', reason: '任务列表为空', results: [] };

  const limit = Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY);
  const results = new Array(list.length);
  let cursor = 0;
  let peak = 0;
  let active = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      active++;
      if (active > peak) peak = active;
      try {
        const item = list[i];
        const one = typeof item === 'string' ? { task: item } : (item || {});
        results[i] = await spawnSubagent({
          ...one, depth, depthLimit, tools, cwd, maxSteps, model,
        });
      } catch (e) {
        results[i] = { state: 'FAIL', reason: '子代理异常：' + String(e && e.message ? e.message : e), isolated: true, depth };
      } finally {
        active--;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => worker()));

  const ok = results.filter((r) => r.state === 'PASS').length;
  const failed = results.filter((r) => r.state === 'FAIL').length;
  return {
    // 全失败才是 FAIL；部分成功是 WARN（不掩盖失败数）
    state: ok === 0 ? 'FAIL' : (failed > 0 ? 'WARN' : 'PASS'),
    total: results.length,
    ok,
    failed,
    peakConcurrency: peak,
    concurrencyLimit: limit,
    results,
  };
}