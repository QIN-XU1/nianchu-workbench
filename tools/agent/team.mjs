#!/usr/bin/env node
/**
 * 念初 · 多智能体协同（自用；不做账号隔离）
 *
 * ══ 这一层解决什么 ═══════════════════════════════════════════
 * tools/agent/runtime.mjs 只有「一个 agent 跟人对话」。
 * 但真正要做成的事，一个人（一个 agent）独立干容易自说自话：
 *   · 自己拆的目标，自己实现，自己说"没问题" —— 这就是本项目明令禁止的
 *     「把已写入当已验证」。
 * 所以这里把工作拆给**不同的 agent**，并且**强制审阅者不能是实现者**
 * （对应台账里 T1 的「≥3 个非实现方验证」那条硬要求）。
 *
 * ══ 有哪几个 agent（都是真调模型，不是占位）══════════════════
 *   planner    规划者  —— 把目标拆成可执行子任务，指定负责人
 *   researcher 调研员  —— 查事实、给依据；拿不到就说拿不到
 *   implementer 实现者 —— 出方案/写东西
 *   reviewer   审阅者  —— **独立**挑错，只看交付物和验收标准
 *
 * ══ 四态 ═════════════════════════════════════════════════════
 * 每一步都带 state。任一环节失败，整轮如实标 WARN/FAIL，
 * 绝不把"跑完了"冒充"做成了"。
 */
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkArtifacts } from './artifacts.mjs';
import {
  USER_DATA_DIR,
  DEFAULT_MODEL,
  createSession,
  appendMessage,
  callModel,
  getSession,
} from './runtime.mjs';
import { runWithTools } from './loop.mjs';

/** 团队花名册。systemPrompt 写清职责边界，避免互相越界。 */
export const AGENTS = {
  planner: {
    id: 'planner',
    name: '规划者',
    role: '拆解目标',
    systemPrompt: [
      '你是规划者。把用户目标拆成 2~3 个可独立执行的子任务。',
      '可指派的负责人只有三个：researcher（查事实）、implementer（出方案/写东西）、reviewer（挑错，不能是实现者）。',
      '只输出 JSON，格式：{"subtasks":[{"title":"...","assignee":"researcher|implementer","spec":"要交付什么"}]}',
      '不要输出 JSON 以外的任何文字。子任务要具体、可验收，不要空话。',
    ].join('\n'),
  },
  researcher: {
    id: 'researcher',
    name: '调研员',
    role: '查事实、给依据',
    systemPrompt: [
      '你是调研员。只给事实和依据，不给建议。',
      '你不联网，只能基于已有知识回答。**任何你没有把握的事实必须明说「不确定」**，不要编造引用、版本号、链接。',
      '输出 3~6 条要点，每条前面标 [确定] 或 [不确定]。',
    ].join('\n'),
  },
  implementer: {
    id: 'implementer',
    name: '实现者',
    role: '出方案 / 写东西',
    systemPrompt: [
      '你是实现者。按子任务要求给出可落地的交付物。',
      '不要复述背景，直接给东西：方案要点、代码、步骤。',
      '如果你判断任务本身有问题，先说问题，再给替代做法。',
    ].join('\n'),
  },
  reviewer: {
    id: 'reviewer',
    name: '审阅者',
    role: '独立挑错',
    systemPrompt: [
      '你是审阅者，且**不是**这些交付物的作者，所以不要替作者辩护。',
      '按下面顺序检查，每条给出通过或不通过：',
      '1) 是否真的回答了目标（不是答了别的）2) 有没有编造/无依据的断言 3) 有没有把「计划」当成「已完成」',
      '最后单独一行输出判定：VERDICT: PASS 或 VERDICT: FAIL 或 VERDICT: UNKNOWN',
      '只要有一条不通过，就是 FAIL。不要为了让结果好看而放过问题。',
      '',
      '注意边界（实测踩过的坑）：',
      '· 你审的是**内容**质量，不是作者的指派过程。',
      '  如果目标本身在讨论「审阅为什么要独立」这类话题，不要因为交付物是 implementer 写的就判 FAIL。',
      '· 不要因为文风、篇幅、格式偏好判 FAIL；只针对事实错误、答非所问、把计划当完成。',
      '· 措辞不严谨到会造成误解的，算事实问题；纯粹用词朴素的不算。',
      '· 交付物里附了[工具执行记录]：请以记录里的真实退出码/输出为准判断「是否真的做到」，',
      '  不要仅凭交付物自述就相信，也不要仅凭自述就否定 —— 看记录。',
    ].join('\n'),
  },
};

/**
 * 子任务可以指派给谁。
 *
 * 【为什么要允许 reviewer】实测：规划者天然会把「审阅」也拆成一个子任务
 * （这很合理 —— 它不知道我们有一道独立的审阅阶段）。
 * 一开始我把它当非法输入直接拒绝，结果正常目标也跑不动。
 *
 * 正确处理不是"改判据放行"，也不是"偷偷改写它的指派"（那是造假），而是：
 *   允许 reviewer 子任务 → 记下 reviewRequested=true
 *   → 由**专门的第③阶段**承接审阅（本来就是独立 agent 做）
 * 这样规划者的意图被完整保留，也不会出现"自己审自己"。
 */
const WORKER_ROLES = ['researcher', 'implementer'];
const ASSIGNABLE_ROLES = ['researcher', 'implementer', 'reviewer'];

/** 能真正产出交付物的角色（reviewer 不算，它是审阅阶段） */
export function isValidWorker(id) {
  return WORKER_ROLES.includes(id);
}

/** 能被指派的角色（含 reviewer） */
export function isAssignable(id) {
  return ASSIGNABLE_ROLES.includes(id);
}

function now() {
  return new Date().toISOString();
}

function teamRunsDir() {
  const d = join(USER_DATA_DIR, 'team-runs');
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 让某个 agent 在自己的会话里做一件事。
 *
 * @returns {{state:'PASS'|'FAIL'|'UNKNOWN', content?:string, sessionId:string, agentId:string, usage?:object, reason?:string}}
 */
export async function runAgent(agentId, {
  task, model = DEFAULT_MODEL, maxTokens = 600, retryOnTruncate = true,
  tools = null, cwd = null,
  /** 可选：声明期望产出物 [{path, contains?, minBytes?}]；缺失则 PASS→FAIL（堵模型撒谎） */
  expectArtifacts = null,
} = {}) {
  const agent = AGENTS[agentId];
  if (!agent) {
    return { state: 'FAIL', agentId, sessionId: '', reason: '未知 agent：' + agentId };
  }
  if (!task || !String(task).trim()) {
    return { state: 'FAIL', agentId, sessionId: '', reason: '任务为空' };
  }

  /**
   * 给了 tools 就进入「真动手」模式：走 loop.mjs 的 tool_use/tool_result 循环，
   * 能读文件、改文件、跑命令。没给就保持纯对话（问答类任务不需要动手）。
   *
   * 会话同样落盘，transcript 一起存，事后能复盘它到底做了什么。
   */
  if (Array.isArray(tools) && tools.length) {
    const s0 = createSession({ sessionName: '[' + agent.name + '] ' + String(task).slice(0, 30) });
    appendMessage(s0.sessionId, { role: 'user', content: String(task) });
    const r = await runWithTools({
      systemPrompt: agent.systemPrompt,
      task,
      tools,
      cwd: cwd || process.cwd(),
      maxTokens: Math.max(maxTokens, 2500),
      model,
      expectArtifacts,
    });
    appendMessage(s0.sessionId, {
      role: r.state === 'PASS' ? 'assistant' : 'system',
      content: r.finalText || r.reason || '(无答复)',
      agent: agentId, usage: r.usage, state: r.state,
      toolCalls: r.toolCalls, failedToolCalls: r.failedToolCalls,
    });
    return {
      state: r.state,
      content: r.finalText || '',
      sessionId: s0.sessionId,
      agentId,
      usage: r.usage,
      toolCalls: r.toolCalls,
      failedToolCalls: r.failedToolCalls,
      toolTranscript: r.transcript,
      reason: r.reason,
    };
  }

  // 每个 agent 有自己的会话，便于事后单独回看它说的每一句
  const s = createSession({ sessionName: '[' + agent.name + '] ' + String(task).slice(0, 30) });
  appendMessage(s.sessionId, { role: 'user', content: String(task) });

  const r = await callModel({
    messages: [
      { role: 'system', content: agent.systemPrompt },
      { role: 'user', content: String(task) },
    ],
    model,
    maxTokens,
  });

  /**
   * 输出被 token 上限截断 → 自动翻倍重试一次。
   *
   * 实测：实现者产出完整 CLI 方案时 3000 token 不够，末尾被切断（`d` 结尾），
   * 审阅者发现「宣称完整可运行但代码断裂」判 FAIL —— 那是我们的预算问题。
   * 这里把截断当成可识别、可恢复的状态处理，而不是让下游猜。
   * 重试仍截断就**如实标注**，不假装完整。
   */
  let final = r;
  let truncated = r.truncated === true;
  let retried = false;
  if (truncated && retryOnTruncate) {
    retried = true;
    const bigger = await callModel({
      messages: [
        { role: 'system', content: agent.systemPrompt },
        { role: 'user', content: String(task) + '\n\n（上一版因为长度被截断。请更紧凑：给要点与关键代码，控制在 1200 字内。）' },
      ],
      model,
      maxTokens: Math.min(maxTokens * 2, 8000),
    });
    if (bigger.state === 'PASS') final = bigger;
    truncated = bigger.truncated === true;
  }

  if (final.state === 'PASS') {
    appendMessage(s.sessionId, {
      role: 'assistant', content: final.content, model: final.model, usage: final.usage, agent: agentId,
      truncated,
    });
    return {
      state: truncated ? 'WARN' : 'PASS',
      content: final.content, model: final.model, usage: final.usage ?? null,
      sessionId: s.sessionId, agentId,
      truncated, retried,
      // 截断时如实标 WARN：内容不完整，不能算 PASS
      reason: truncated ? '输出被 token 上限截断（已自动重试一次仍截断）' : undefined,
    };
  }
  appendMessage(s.sessionId, {
    role: 'system', type: 'agent-failed', state: r.state, reason: r.reason,
  });
  return { state: r.state, agentId, sessionId: s.sessionId, reason: r.reason };
}

/** 从模型输出里抠 JSON（模型常带 ```json 围栏或前后废话） */
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 校验规划者给的子任务表。
 * 这是「反例不报 = 检查是假的」的落地：不合格的拆解必须被拒，不能凑合执行。
 */
export function validatePlan(plan, { maxSubtasks = 3 } = {}) {
  const problems = [];
  if (!plan || !Array.isArray(plan.subtasks)) {
    return { ok: false, problems: ['没有 subtasks 数组'] };
  }
  const list = plan.subtasks;
  if (list.length === 0) problems.push('subtasks 为空');
  if (list.length > maxSubtasks) problems.push('子任务超过上限 ' + maxSubtasks + '（拆太碎没有收益）');

  list.forEach((st, i) => {
    const tag = '第' + (i + 1) + '个子任务';
    if (!st || typeof st !== 'object') { problems.push(tag + '不是对象'); return; }
    if (!st.title || !String(st.title).trim()) problems.push(tag + '缺 title');
    if (!isAssignable(st.assignee)) {
      problems.push(tag + '的 assignee 非法：' + String(st.assignee) + '（只允许 ' + ASSIGNABLE_ROLES.join('/') + '）');
    }
    if (!st.spec || !String(st.spec).trim()) problems.push(tag + '缺 spec');
  });

  return { ok: problems.length === 0, problems, subtasks: problems.length === 0 ? list : [] };
}

/** 从审阅输出里读判定 */
export function parseVerdict(text) {
  if (!text) return 'UNKNOWN';
  const m = String(text).match(/VERDICT:\s*(PASS|FAIL|UNKNOWN)/i);
  return m ? m[1].toUpperCase() : 'UNKNOWN';
}

/**
 * 跑一轮团队协作，**支持修复轮**。
 *
 * 【为什么要修复轮】实测：单轮 2 个 agent 产出的设计，被审阅者判 FAIL ——
 * 理由很具体（缺「如何判定来源」的机制、缺退出码空间、漏并发/信号场景）。
 * 那时只有两种选择：
 *   · 直接把 FAIL 丢给用户 → 多智能体协作退化成「一个只会挑刺的审稿人」
 *   · 让审阅意见回到实现者手里重做，再独立复审 → 这才是协作
 * 所以这里做后者：FAIL 且还有轮次，就把意见喂回实现者，产出 v2，再换审阅者复审。
 * 每轮都留痕（rounds 数组），不覆盖历史。
 *
 * @param {object} opts
 * @param {string} opts.objective
 * @param {number} [opts.maxSubtasks=3]
 * @param {number} [opts.maxRounds=2]  1 = 只做一轮；2 = 允许一次修复
 * @param {boolean} [opts.parallel=true]
 */
export async function runTeam({
  objective, maxSubtasks = 3, parallel = true, model = DEFAULT_MODEL, maxRounds = 2,
  /** 给了 tools 就让执行类 agent 真的读写文件/跑命令（自用场景默认给全套） */
  tools = null, cwd = null,
  /** 可选：声明团队整体期望产出物 [{path, contains?}]；缺失则 PASS→FAIL */
  expectArtifacts = null,
} = {}) {
  const runId = 'team-' + randomUUID().replace(/-/g, '').slice(0, 16);
  const at = now();
  const steps = [];
  const rounds = [];

  if (!objective || !String(objective).trim()) {
    return { state: 'FAIL', runId, reason: '目标为空', steps: [], rounds: [], at };
  }

  // ── ① 规划 ──
  const plan = await runAgent('planner', {
    task: '目标：' + String(objective)
      + '\n请拆成 2~' + Math.max(2, Math.min(maxSubtasks, 3)) + ' 个可独立执行的子任务。',
    model,
    maxTokens: 600,
  });
  steps.push({ stage: 'plan', ...plan });
  if (plan.state !== 'PASS') {
    return finish({ state: plan.state === 'FAIL' ? 'FAIL' : 'UNKNOWN', runId, at, objective, steps, rounds,
      reason: '规划阶段没有产出：' + (plan.reason || plan.state) });
  }

  const parsed = extractJson(plan.content);
  const valid = validatePlan(parsed, { maxSubtasks });
  if (!valid.ok) {
    return finish({ state: 'FAIL', runId, at, objective, steps, rounds,
      reason: '规划结果不合格，已拒绝执行：' + valid.problems.join('；'), planProblems: valid.problems });
  }

  const allSubtasks = valid.subtasks;
  const reviewSubtasks = allSubtasks.filter((st) => st.assignee === 'reviewer');
  const subtasks = allSubtasks.filter((st) => isValidWorker(st.assignee));
  const reviewRequested = reviewSubtasks.length > 0;

  if (subtasks.length === 0) {
    return finish({ state: 'FAIL', runId, at, objective, steps, rounds,
      reason: '拆出来的子任务全是审阅，没有可执行的产出任务' });
  }

  // ── ② 执行子任务（第 1 轮）──
  const runOne = async (st, i) => {
    // 实现者默认给工具（它要产出东西）；调研员保留纯文本（它是查事实，不该乱改文件）
    const useTools = Array.isArray(tools) && tools.length > 0
      ? (st.assignee === 'implementer' ? tools : null)
      : null;
    const r = await runAgent(st.assignee, {
      task: '总目标：' + String(objective) + '\n你的子任务（' + (i + 1) + '/' + subtasks.length + '）：'
        + String(st.title) + '\n要交付：' + String(st.spec),
      model,
      maxTokens: 3000,
      tools: useTools,
      cwd,
    });
    return { stage: 'work', index: i, title: st.title, assignee: st.assignee, ...r };
  };

  const workResults = parallel
    ? await Promise.all(subtasks.map((st, i) => runOne(st, i)))
    : await (async () => {
        const out = [];
        for (let i = 0; i < subtasks.length; i++) out.push(await runOne(subtasks[i], i));
        return out;
      })();
  steps.push(...workResults);
  rounds.push({ round: 1, work: workResults.map(summarize), verdict: null });

  const workOk = workResults.filter((r) => r.state === 'PASS');
  if (workOk.length === 0) {
    return finish({ state: 'FAIL', runId, at, objective, steps, rounds,
      reason: '所有子任务都失败，无从审阅' });
  }

  const authors = [...new Set(workOk.map((r) => r.assignee))];
  if (authors.includes('reviewer')) {
    return finish({ state: 'FAIL', runId, at, objective, steps, rounds,
      reason: '审阅者被当成作者，违反独立性' });
  }

  const reviewFocus = reviewRequested
    ? '\n规划者还特别要求审这几点：' + reviewSubtasks.map((st) => String(st.spec)).join('；')
    : '';

  /** 审阅一轮 */
  const doReview = async (deliverables, label) => {
    const digest = deliverables.map((r) => {
      const who = AGENTS[r.assignee]?.name || r.assignee;
      const head = '【' + who + ' · ' + (r.title || label) + '】';
      const body = String(r.content).slice(0, 2000);
      // 把工具执行记录作为**证据**附上：审阅者可以据此核对「它说跑了」是不是真的跑了
      const tools = Array.isArray(r.toolTranscript) ? r.toolTranscript.filter((x) => x.kind === 'tool') : [];
      const evidence = tools.length
        ? '\n\n[工具执行记录 · 共 ' + tools.length + ' 次]\n' + tools.slice(0, 24).map((x) => {
            const inp = JSON.stringify(x.input || {}).slice(0, 120);
            let out;
            if (x.tool === 'bash') {
              out = 'exit=' + (x.output?.exit_code ?? '?') + ' stdout=' + String(x.output?.stdout || '').slice(0, 220).replace(/\s+/g, ' ')
                + (x.output?.stderr ? ' stderr=' + String(x.output.stderr).slice(0, 120).replace(/\s+/g, ' ') : '');
            } else if (x.tool === 'read') {
              out = 'lines=' + (x.output?.total_lines ?? '?') + ' ' + String(x.output?.content || '').slice(0, 160).replace(/\s+/g, ' ');
            } else if (x.tool === 'write') {
              out = 'ok=' + x.ok + ' bytes=' + (x.output?.bytes ?? '?') + ' path=' + (x.output?.file_path || '');
            } else if (x.tool === 'edit') {
              out = 'ok=' + x.ok + ' ' + (x.output?.error || ('replacements=' + (x.output?.replacements ?? '?')));
            } else {
              out = x.ok ? 'ok' : (x.output?.error || 'failed');
            }
            return '  · ' + x.tool + '(' + inp + ') → ' + String(out).slice(0, 300);
          }).join('\n')
        : '\n\n[这一步没有工具执行记录 —— 若它声称"已执行/已验证"，只能算自述，不是证据]';
      return head + '\n' + body + evidence;
    }).join('\n\n');
    const rev = await runAgent('reviewer', {
      task: '目标：' + String(objective) + '\n\n下面是各 agent 的交付物：\n' + digest
        + reviewFocus + '\n\n请按你的检查项逐条判断，并给出 VERDICT。',
      model,
      maxTokens: 2000,
    });
    return { ...rev, stage: 'review', verdict: rev.state === 'PASS' ? parseVerdict(rev.content) : 'UNKNOWN' };
  };

  // ── ③ 审阅（第 1 轮）──
  let review = await doReview(workOk, '交付物');
  steps.push(review);
  rounds[rounds.length - 1].verdict = review.verdict;
  rounds[rounds.length - 1].review = review.content;

  // ── ④ 修复轮：FAIL 且还有轮次 ──
  let roundsUsed = 1;
  const maxR = Math.max(1, Math.min(Number(maxRounds) || 1, 3));
  while (review.verdict === 'FAIL' && roundsUsed < maxR) {
    roundsUsed++;
    const feedback = String(review.content || '').slice(0, 2200);

    // 修复交给实现者（即便上一轮实现者是别人，修复也归实现者 —— 它负责产出）
    const fixes = await Promise.all(workOk.map(async (prev, i) => {
      const r = await runAgent('implementer', {
        tools: Array.isArray(tools) && tools.length ? tools : null,
        cwd,
        task: [
          '总目标：' + String(objective),
          '你上一版交付物（' + (prev.title || '') + '）：',
          String(prev.content).slice(0, 2000),
          '',
          '独立审阅者判了不通过，意见如下：',
          feedback,
          '',
          '请**逐条**修掉它指出的问题，重新交付完整版本。',
          '不要辩解，不要复述意见，直接给改好的东西。',
        ].join('\n'),
        model,
        maxTokens: 3200,
      });
      return { stage: 'fix', round: roundsUsed, index: i, title: prev.title, assignee: 'implementer', ...r };
    }));
    steps.push(...fixes);

    const fixOk = fixes.filter((r) => r.state === 'PASS');
    if (fixOk.length === 0) {
      rounds.push({ round: roundsUsed, work: fixes.map(summarize), verdict: 'UNKNOWN', note: '修复轮全部失败' });
      break;
    }

    review = await doReview(fixOk, '修复版');
    steps.push(review);
    rounds.push({
      round: roundsUsed,
      work: fixes.map(summarize),
      verdict: review.verdict,
      review: review.content,
    });
  }

  const verdict = review.verdict;
  const finalWork = steps.filter((s) => s.stage === 'fix' || (s.stage === 'work' && roundsUsed === 1));

  let state;
  if (review.state !== 'PASS') state = 'UNKNOWN';
  else if (verdict === 'FAIL') state = 'FAIL';
  else if (verdict === 'PASS') state = finalWork.every((r) => r.state === 'PASS') ? 'PASS' : 'WARN';
  else state = 'UNKNOWN';

  // 可选产出物兜底：声明了期望产出但没产出 → PASS 降 FAIL（堵「模型撒谎→PASS」）
  let __artifactNote = '';
  let __artifacts = undefined;
  if (Array.isArray(expectArtifacts) && expectArtifacts.length) {
    const chk = checkArtifacts(expectArtifacts, cwd || process.cwd());
    __artifacts = chk;
    if (!chk.ok) {
      const missing = chk.results.filter((r) => !r.ok).map((r) => r.path + '(' + r.reason + ')').join('；');
      __artifactNote = '产出物校验失败：' + missing;
      if (state === 'PASS') state = 'FAIL';
    }
  }

  return finish({
    state, runId, at, objective, steps, rounds,
    verdict,
    roundsUsed,
    plan: subtasks,
    reviewRequested,
    reviewFocus: reviewSubtasks.map((st) => ({ title: st.title, spec: st.spec })),
    authors,
    failedSubtasks: steps.filter((s) => (s.stage === 'work' || s.stage === 'fix') && s.state !== 'PASS')
      .map((r) => ({ stage: r.stage, title: r.title, assignee: r.assignee, state: r.state, reason: r.reason })),
    reason: (__artifactNote ? __artifactNote + '；' : '') + (state === 'PASS' ? undefined
      : verdict === 'FAIL' ? ('审阅判定不通过（已用 ' + roundsUsed + ' 轮）')
        : '审阅无法判定'),
    artifacts: __artifacts,
    // 每条回复的真实 token 用量，累计成整轮成本
    usage: {
      calls: steps.filter((s) => s.usage).length,
      output: steps.reduce((a, s) => a + (s.usage?.completion_tokens || 0), 0),
      input: steps.reduce((a, s) => a + (s.usage?.prompt_tokens || 0), 0),
    },
  });
}

/** 步骤摘要（trace 里别塞全文，太长） */
function summarize(r) {
  return {
    title: r.title, assignee: r.assignee, state: r.state,
    chars: r.content ? String(r.content).length : 0,
    toolCalls: r.toolCalls ?? 0,
    failedToolCalls: r.failedToolCalls ?? 0,
    reason: r.reason ?? null,
    sessionId: r.sessionId ?? null,
  };
}

/** 落盘 trace 并返回最终结果 */
function finish(result) {
  const dir = teamRunsDir();
  const path = join(dir, result.runId + '.json');
  const payload = { ...result, at: result.at || now(), finishedAt: now() };
  try {
    writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch { /* 落盘失败不影响返回，但下面会标出来 */ }
  return { ...payload, tracePath: existsSync(path) ? path : null };
}

/** 列出历史团队 run（最近在前，读 trace 文件） */
export async function listTeamRuns(limit = 20) {
  const dir = teamRunsDir();
  let names = [];
  try {
    const { readdirSync, readFileSync } = await import('node:fs');
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const runs = names.map((f) => {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        return {
          runId: j.runId, at: j.at, state: j.state, objective: j.objective,
          verdict: j.verdict ?? null, reason: j.reason ?? null,
          authors: j.authors ?? [], stepCount: (j.steps || []).length,
        };
      } catch { return null; }
    }).filter(Boolean);
    runs.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return runs.slice(0, limit);
  } catch {
    return [];
  }
}

// ── CLI：node tools/agent/team.mjs "目标" ──
const isMain = (() => {
  try {
    return process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/agent/team.mjs');
  } catch { return false; }
})();

if (isMain) {
  const objective = process.argv.slice(2).join(' ').trim();
  if (!objective) {
    console.log('');
    console.log('  用法: node tools/agent/team.mjs "要做的目标"');
    console.log('  花名册: ' + Object.values(AGENTS).map((a) => a.name + '(' + a.id + ')').join(' · '));
    console.log('');
    process.exit(2);
  }
  console.log('');
  console.log('  多智能体协同 · ' + objective);
  console.log('  ' + '─'.repeat(70));
  const roundsArg = process.argv.find((a) => a.startsWith('--rounds='));
  const maxRounds = roundsArg ? Number(roundsArg.split('=')[1]) : 2;
  const r = await runTeam({ objective, maxRounds });
  console.log('  四态: ' + r.state + '（用了 ' + (r.roundsUsed ?? '?') + ' 轮）');
  if (r.verdict) console.log('  审阅: ' + r.verdict);
  if (r.reason) console.log('  原因: ' + r.reason);
  console.log('');
  for (const s of r.steps) {
    const label = s.stage === 'plan' ? '规划' : s.stage === 'review' ? '审阅' : ('执行·' + (s.title || ''));
    const who = s.agentId ? (AGENTS[s.agentId]?.name || s.agentId) : '?';
    console.log('    [' + s.stage + '] ' + who + ' · ' + label + ' · ' + s.state);
  }
  console.log('');
  if (r.usage) console.log('  用量: ' + r.usage.calls + ' 次调用 · in ' + r.usage.input + ' / out ' + r.usage.output + ' tokens');
  console.log('  trace: ' + (r.tracePath || '(落盘失败)'));
  console.log('');
  process.exit(r.state === 'PASS' ? 0 : 1);
}