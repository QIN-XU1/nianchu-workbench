/**
 * agent 步骤 → 界面事件的翻译层。
 *
 * 为什么单独成文件：ws-host.mjs 已经贴着 32KB 红线（`size-guard` 会拦），
 * 而「哪个步骤该推哪个事件、推之前怎么裁剪」是一块完整的、能自己说清的逻辑。
 * 放在 ws-host 里会让那个文件继续长，抽出来两边都干净。
 */

/**
 * 工具参数预览（推给界面的 agent-step 用）。
 *
 * 为什么不直接 `JSON.parse(JSON.stringify(input).slice(0, 1200))`：
 * 那是**先序列化再按字符截断**，截出来的不是合法 JSON，`JSON.parse` 会抛，
 * 而这里抛异常会把整个 onStep 打穿、连带 run_task 失败 ——
 * 只要一次 `write` 的内容超过 1200 字符就会复现。改成按字段安全截断。
 */
export function previewInput(input) {
  if (input == null) return undefined;
  if (typeof input !== 'object') return String(input).slice(0, 400);
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  }
  return out;
}

/**
 * 把一个 agent 步骤翻译成 WebSocket 事件推给界面。
 *
 * 三条规矩：
 *   1. 只推**工具步骤**；最终答复走 `agent-answer`，别和工具流混在一起。
 *   2. 只推必要字段 —— 界面要正文再走 RPC 取，别把整份输出塞进事件。
 *   3. 计划（`todo_write`）单独推一份**完整清单**：`agent-step` 的 input 是截断预览，
 *      计划项多了会被切掉，界面会显示一份缺项的计划 —— 那比不显示更糟。
 *      清单本身很小，整份发。
 */
export function emitStep(notify, runToken, step) {
  if (!notify) return;
  if (step.kind !== 'tool') {
    if (step.kind === 'answer') {
      notify('nianchu://agent-answer', { runToken, content: String(step.content || '').slice(0, 4000) });
    }
    return;
  }
  notify('nianchu://agent-step', {
    runToken,
    kind: step.kind,
    tool: step.tool,
    ok: step.ok,
    ms: step.ms,
    input: previewInput(step.input),
    step: step.step,
    at: step.at,
  });
  if (step.tool === 'todo_write' && step.ok !== false && Array.isArray(step.output?.todos)) {
    notify('nianchu://agent-plan', { runToken, todos: step.output.todos });
  }
}
