#!/usr/bin/env node
/**
 * 批次 X · 计划图层（todo_write）判据验证
 *
 * 为什么要有这一批：长任务里「它到底做到哪一步」看不见，
 * 只能等它跑完。计划面板把进度摊开，但**面板的前提是清单可信** ——
 * 所以这里验的全是校验逻辑：非法状态、重复项、多项 in_progress、空项
 * 必须被**拒绝并给出可读原因**，而不是静默纠正成一份「看起来对」的计划。
 *
 * 跑法：node tools/agent/verify-plan.mjs
 */
import { createToolkit } from './toolkit.mjs';

let pass = 0;
const fails = [];
function t(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ✓ ' + name); } else {
    fails.push(name + (detail ? ' · ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? ' · ' + detail : ''));
  }
}

const tk = createToolkit({ cwd: process.cwd() });
const todo = tk.todo_write;
console.log('\n══ 一、工具形状 ══');
t('toolkit 里有 todo_write', Boolean(todo));
t('schema 要求 todos', (todo.input_schema.required || []).includes('todos'));
t('status 枚举只有三种', JSON.stringify(todo.input_schema.properties.todos.items.properties.status.enum)
  === JSON.stringify(['pending', 'in_progress', 'completed']));

console.log('\n══ 二、正常提交 ══');
const ok = todo.call({
  todos: [
    { content: '读一遍现有实现', status: 'completed' },
    { content: '改计划面板', status: 'in_progress' },
    { content: '跑端到端验证', status: 'pending' },
  ],
});
t('合法清单被接受', ok.ok === true, JSON.stringify(ok).slice(0, 120));
t('计数自洽（done=1 / doing=1 / todo=1）',
  ok.counts.completed === 1 && ok.counts.inProgress === 1 && ok.counts.pending === 1,
  JSON.stringify(ok.counts));
t('未全完成时 allDone=false', ok.allDone === false);
t('清单按输入顺序原样返回', ok.todos.map((x) => x.content).join('|') === '读一遍现有实现|改计划面板|跑端到端验证');
t('content 两端空白被裁掉',
  todo.call({ todos: [{ content: '  带空格  ', status: 'pending' }] }).todos[0].content === '带空格');

const all = todo.call({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] });
t('全部完成时 allDone=true', all.allDone === true);

console.log('\n══ 三、反例：必须拒绝，不静默纠正 ══');
const badStatus = todo.call({ todos: [{ content: 'x', status: 'done' }] });
t('★反例：非法 status 被拒', badStatus.ok === false && /status 非法/.test(badStatus.error), String(badStatus.error));

const empty = todo.call({ todos: [{ content: '   ', status: 'pending' }] });
t('★反例：空 content 被拒', empty.ok === false && /content 为空/.test(empty.error), String(empty.error));

const dup = todo.call({ todos: [{ content: '同一个', status: 'pending' }, { content: '同一个', status: 'pending' }] });
t('★反例：重复项被拒', dup.ok === false && /重复项/.test(dup.error), String(dup.error));

const two = todo.call({
  todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }],
});
t('★反例：两项 in_progress 被拒', two.ok === false && /只能有一项 in_progress/.test(two.error), String(two.error));

const notArr = todo.call({ todos: 'x' });
t('★反例：todos 不是数组被拒', notArr.ok === false && /必须是数组/.test(notArr.error), String(notArr.error));

const tooLong = todo.call({ todos: [{ content: 'a'.repeat(201), status: 'pending' }] });
t('★反例：超长 content 被拒', tooLong.ok === false && /超过 200 字/.test(tooLong.error), String(tooLong.error));

const emptyList = todo.call({ todos: [] });
t('空清单被接受但 allDone=false（不能算「做完了」）', emptyList.ok === true && emptyList.allDone === false);

console.log('\n══ 四、整表替换语义 ══');
const v1 = todo.call({ todos: [{ content: 'a', status: 'in_progress' }] });
const v2 = todo.call({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] });
t('第二次提交得到完整新清单（不是追加）', v2.todos.length === 2 && v1.todos.length === 1, JSON.stringify(v2.todos));

/**
 * ══ 五、循环里的计划快照（假网关，不烧模型）══
 * 这条链路是「工具输出 → run.plan → 界面面板」，只验工具本身不够：
 * 快照取错了（比如取失败那次、或取成累加）界面就会显示一份假计划。
 */
console.log('\n══ 五、循环输出计划快照 ══');
{
  const { runWithTools } = await import('./loop.mjs');
  const scripted = (steps) => {
    let i = 0;
    return async () => {
      const body = steps[Math.min(i, steps.length - 1)];
      i++;
      return { ok: true, status: 200, async json() { return body; }, async text() { return ''; } };
    };
  };
  const callResp = (name, args) => ({
    choices: [{
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const textResp = (s) => ({ choices: [{ message: { role: 'assistant', content: s }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

  const origFetch = globalThis.fetch;
  try {
    // 先提交一版（进行中），再提交一版（全部完成）—— 最终快照应该是后者
    globalThis.fetch = scripted([
      callResp('todo_write', {
        todos: [
          { content: '第一步', status: 'in_progress' },
          { content: '第二步', status: 'pending' },
        ],
      }),
      callResp('todo_write', {
        todos: [
          { content: '第一步', status: 'completed' },
          { content: '第二步', status: 'completed' },
        ],
      }),
      textResp('两步都做完了'),
    ]);
    const r = await runWithTools({ task: '走一遍计划', tools: ['todo_write'], cwd: process.cwd(), maxSteps: 5, maxTokens: 300 });
    t('run.plan 存在且是数组', Array.isArray(r.plan), JSON.stringify(r.plan));
    t('★快照取最后一次提交（两项都 completed）',
      (r.plan || []).length === 2 && (r.plan || []).every((x) => x.status === 'completed'),
      JSON.stringify(r.plan));
    t('两次 todo_write 都进了 transcript', (r.transcript || []).filter((x) => x.tool === 'todo_write').length === 2);

    // 反例：校验失败的那次不能覆盖已生效的计划
    globalThis.fetch = scripted([
      callResp('todo_write', { todos: [{ content: '好的计划', status: 'in_progress' }] }),
      callResp('todo_write', { todos: [{ content: 'bad', status: 'done' }] }),
      textResp('结束'),
    ]);
    const r2 = await runWithTools({ task: '失败提交不覆盖', tools: ['todo_write'], cwd: process.cwd(), maxSteps: 5, maxTokens: 300 });
    t('★反例：校验失败的提交不覆盖上一份有效计划',
      (r2.plan || []).length === 1 && r2.plan[0].content === '好的计划',
      JSON.stringify(r2.plan));

    // 反例：从没写过计划 → plan 是 null（界面据此不渲染面板）
    globalThis.fetch = scripted([textResp('直接回答')]);
    const r3 = await runWithTools({ task: '不写计划', tools: ['todo_write'], cwd: process.cwd(), maxSteps: 3, maxTokens: 200 });
    t('★没写计划时 plan=null（不渲染空面板）', r3.plan === null, JSON.stringify(r3.plan));
  } finally {
    globalThis.fetch = origFetch;
  }
}


console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 清单校验严格、反例明确、整表替换语义正确'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;
