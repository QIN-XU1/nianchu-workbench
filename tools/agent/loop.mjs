#!/usr/bin/env node
/**
 * 念初 · 带工具的 agent 循环（CodeAct 模式）
 *
 * ══ 这是从 Claude Code / openclaude 搬的核心架构 ═══════════════
 * 不是"一次问答"，而是：
 *
 *    想 → 调工具 → 看结果 → 再想 → …（直到不再调工具或到达上限）
 *
 * 每次工具调用和结果都进 transcript，所以事后能复盘「它到底做了什么」。
 * 这一点和 openclaude 的 tool_use / tool_result 往返结构一致。
 *
 * ══ 四态 ═════════════════════════════════════════════════════
 * PASS     ：循环正常结束且有最终答复
 * WARN     ：到达步数/时间上限被强制停（有产出但不完整）
 * FAIL     ：模型网关/工具层致命错误
 * UNKNOWN  ：模型没给答复也没调工具（说不清发生了什么）
 */
import { callModelRaw } from './runtime.mjs';
import { createToolkit, pickTools, toOpenAITools } from './toolkit.mjs';
import { DEFAULT_TOOLS } from './modes.mjs';
import { createSkillLoader } from '../skills/loader.mjs';
import { catalogText, createLoadSkillTool } from '../skills/inject.mjs';
import { beginSet, endSet, makeChangesetHooks, addSnapshotRecord } from './changeset.mjs';
import { classifyStop } from './stop.mjs';
import { applyArtifactCheck } from './artifacts.mjs';
import { beginTrace } from './trace.mjs';
import { saveCheckpoint, discardCheckpoint } from './checkpoint.mjs';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join as joinPath, relative as relativePath, sep as pathSep } from 'node:path';

const now = () => new Date().toISOString();

/**
 * ══ A12 技能/插件生态：把「技能池」接进 agent 循环 ═══════════════
 * 原来 tools/skills/{loader,registry,inject}.mjs 都写好了，但**只有 api-handler 和测试在调**：
 * 模型既看不到技能目录，也没有 load_skill 工具 —— 这正是 A12 判「部分」的根因。
 * 这里补上两件事：
 *   ① 目录常驻 system prompt（catalogText）
 *   ② load_skill 工具按需取全文（createLoadSkillTool）
 * 技能池扫 prototype/scenes；惰性单例，一次运行只扫一次。
 */
const SKILLS_ROOT = joinPath(import.meta.dirname, '../../prototype/scenes');
let _skillLoader = null;
function getSkillLoader() {
  if (!_skillLoader) _skillLoader = createSkillLoader([SKILLS_ROOT]).scanAll();
  return _skillLoader;
}

/**
 * 本次运行是否具备「改东西」的能力（决定系统提示怎么写）。
 * 只看白名单：有 write/edit/apply_patch/bash 任一即算能动手。
 */
function canWriteThisRun(allowed) {
  return ['write', 'edit', 'apply_patch', 'bash'].some((n) => allowed.has(n));
}

/**
 * 跑一个带工具的 agent。
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt  角色设定
 * @param {string} opts.task          要它做的事
 * @param {string[]} [opts.tools]     可用工具名（白名单，含派发闸），默认给全套
 * @param {string} [opts.cwd]         工作目录（bash 在这里执行，相对路径按它解析）
 * @param {number} [opts.maxSteps=12] 最多几轮工具往返
 * @param {number} [opts.maxTokens=2500] 单次回复 token 上限
 * @param {string} [opts.model]
 */
export async function runWithTools({
  systemPrompt = '',
  task,
  tools: toolNames = DEFAULT_TOOLS,
  cwd = process.cwd(),
  maxSteps = 12,
  maxTokens = 2500,
  model,
  onStep = null,
  /** 可选变更集钩子 {before, after}，用于 diff 预览与回滚 */
  changeset = null,
  /** 子代理深度（供 spawn_subagent 工具做深度上限判定） */
  subagentDepth = 0,
  subagentDepthLimit = 2,
  /**
   * ══ C1 循环完整性（对标 dsh packages/core/agent-loop/src/agent.ts:2,53-61,192）══
   * dsh 的循环不是裸 for：它是「queued turns + step-boundary input」，
   * phase 有 idle/running 两态且带 AbortController + wakeRequested。
   * 我们原来没有中断、没有步边界注入 —— 跑起来就只能等它自己结束。
   */
  /** 外部取消信号（AbortSignal）。abort 后当前步结束即停，保留已有 transcript */
  signal = null,
  /** 步边界拉取新输入：() => string | null。返回值会作为 user 消息插入下一轮 */
  inbox = null,
  /** 阶段变化回调：({kind:'idle'|'running', turn, step}) => void */
  onPhase = null,
  /** 轮次号（仅用于上报，从 1 开始） */
  turn = 1,
  /**
   * ══ C4 自愈（对标 dsh packages/core/session/src/fork.ts:6 openTurnClosers）══
   * · runId：给了就每步写检查点，正常结束才删除；中途崩/取消则保留，供续跑
   * · seedMessages：续跑时把上次的历史喂进来，避免从头重做已完成的工作
   */
  runId = null,
  seedMessages = null,
  /** 可选：声明的期望产出物 [{path, contains?, minBytes?}]；跑完自动校验，缺失则 PASS→FAIL */
  expectArtifacts = null,
} = {}) {
  const __t0 = Date.now();
  /** A16：一次运行 = 一个 trace，内部按模型调用/工具调用记 span */
  const trace = beginTrace({ name: 'runWithTools', attributes: { cwd, maxSteps, tools: toolNames } });

  const at = now();
  const transcript = [];
  const usageTotal = { calls: 0, input: 0, output: 0 };

  if (!task || !String(task).trim()) {
    return { state: 'FAIL', reason: '任务为空', transcript, at, usage: usageTotal, traceId: trace.traceId };
  }

  let toolkit;
  let toolList;
  try {
    toolkit = createToolkit({ cwd, changeset, subagentDepth, subagentDepthLimit });
    /**
     * A12：把 load_skill 注册进工具表。
     * 形状对齐 toolkit 约定：`call(args)` 执行、`input_schema` 描述参数
     * （inject.mjs 的 createLoadSkillTool 用的是 `parameters`，这里转一道）。
     */
    const skillTool = createLoadSkillTool(getSkillLoader());
    toolkit.load_skill = {
      name: 'load_skill',
      readOnly: true,
      description: skillTool.description,
      input_schema: skillTool.parameters,
      call: (args) => skillTool.run(args),
    };
    toolList = pickTools(toolkit, toolNames);
  } catch (e) {
    return { state: 'FAIL', reason: '工具装载失败：' + e.message, transcript, at, usage: usageTotal, traceId: trace.traceId };
  }

  /**
   * 批次 Z.28：白名单必须在**派发处**生效。
   *
   * pickTools 只决定「给模型看哪些 schema」，而 toolkit 里仍是全量表。
   * 之前派发只查 `toolkit[name]`，于是 `tools: ['read']` 的只读运行
   * 照样能把 `write` 落盘（实测反例：传 tools=['read']、模型调 write，
   * 结果 ok:true 并真的建了文件）。白名单成了摆设。
   * 这里先算出「本次允许集」，派发时不在集合内一律拒绝执行。
   */
  const allowedTools = new Set(toolList.map((t) => t.name));

  /**
   * 系统提示补上工具使用规则。
   * 这几条是 Claude Code 的一贯做法：让模型知道「先读再改」「改完自己验」。
   */
  const toolPolicy = [
    '',
    '## 工具使用规则',
    canWriteThisRun(allowedTools)
      ? '· 你有真实工具，可以读写文件、执行命令。不要假装做了事 —— 要么真做，要么明说做不到。'
      : '· 本次运行是**只读**的：没有写文件 / 执行命令的工具。需要改动时如实说「这需要动手模式」，不要假装改了。',
    '· 改文件前先用 read 看过原文；改完用 read 或 bash 自己验证结果。',
    '· edit 的 old_string 必须在文件里唯一；不唯一就多带上下文，或用 replace_all。',
    '· 每次工具调用后你会看到结果，再决定下一步。做完给一句简短总结（做了什么、结果如何）。',
    allowedTools.has('todo_write')
      ? '· 任务需要 3 步以上时，先用 todo_write 写一份计划；每完成一项就更新它的状态（用户能看到进度）。'
      : '· 本次运行没有 todo_write，不要假装写了计划。',
    '· 如果目标无法完成（缺权限、缺依赖、信息不足），停下来如实说明，不要编造。',
    `· 工作目录：${cwd}`,
  ].join('\n');

  /**
   * 续跑：把上次的历史（含已完成的工具调用记录）作为起点。
   * 注意这是**消息级**续跑，不保证工具副作用不重复 —— 见 checkpoint.mjs 的边界说明。
   */
  const seeded = Array.isArray(seedMessages) && seedMessages.length > 0 ? seedMessages.slice() : null;
  /**
   * A12：技能目录常驻。只放 name + description（不到 1 行一个），
   * 正文靠 load_skill 按需取 —— 这就是「目录常驻 + 正文懒加载」的两段式。
   */
  const skillCatalog = catalogText(getSkillLoader()).text;
  const messages = seeded || [
    { role: 'system', content: (systemPrompt || '你是一个能动手的程序员 agent。') + toolPolicy + '\n\n' + skillCatalog },
    { role: 'user', content: String(task) },
  ];

  const openaiTools = toOpenAITools(toolList);
  let finalText = null;
  let hitLimit = false;
  let lastReason = null;
  let truncatedAny = false;

  const phase = (kind, extra = {}) => {
    if (typeof onPhase === 'function') {
      try { onPhase({ kind, turn, ...extra }); } catch { /* 上报失败不影响循环 */ }
    }
  };

  let aborted = false;
  let injectedCount = 0;
  phase('running', { step: 0 });

  /**
   * C4：**进入循环就写一次检查点**。
   * 否则如果第一步之前就被取消（或进程在第一步前崩掉），会没有任何可续点，
   * 「可续跑」就成了空话。这一条是实测发现补的。
   */
  if (runId) {
    saveCheckpoint(runId, { step: 0, messages, transcript, usage: usageTotal, cwd, task, traceId: trace.traceId });
  }

  for (let step = 0; step < maxSteps; step++) {
    /**
     * ① 取消：**在步边界检查**，不是随时硬杀 —— 这样已经发生的工具副作用与
     *    transcript 都是完整的，不会留下半个操作。
     */
    if (signal && signal.aborted) {
      aborted = true;
      transcript.push({ kind: 'abort', step, reason: String(signal.reason ?? 'aborted').slice(0, 200) });
      break;
    }

    /**
     * ② 步边界注入新输入（dsh 的 "step-boundary input"）：
     *    用户在 agent 跑到一半时说的话，不该被丢掉，也不该等下一次运行。
     */
    if (typeof inbox === 'function') {
      let extra = null;
      try { extra = inbox({ step, turn }); } catch { extra = null; }
      if (extra && String(extra).trim()) {
        messages.push({ role: 'user', content: String(extra) });
        transcript.push({ kind: 'inbox', step, text: String(extra).slice(0, 500) });
        injectedCount++;
      }
    }

    if (runId) {
      saveCheckpoint(runId, { step, messages, transcript, usage: usageTotal, cwd, task, traceId: trace.traceId });
    }

    const r = await trace.withSpan('model', { attributes: { step, toolCount: openaiTools.length } }, () =>
      callModelRaw({ messages, model, maxTokens, tools: openaiTools, toolChoice: 'auto' }));
    if (r.state !== 'PASS') {
      // 早退也要收尾 trace，否则失败运行没有 trace 可复盘
      trace.end({ state: r.state === 'FAIL' ? 'FAIL' : 'UNKNOWN', reason: r.reason || ('模型调用失败：' + r.state) });
      return {
        state: r.state === 'FAIL' ? 'FAIL' : 'UNKNOWN',
        reason: r.reason || ('模型调用失败：' + r.state),
        transcript, at, usage: usageTotal, steps: step,
        traceId: trace.traceId,
      };
    }
    usageTotal.calls++;
    usageTotal.input += r.usage?.prompt_tokens || 0;
    usageTotal.output += r.usage?.completion_tokens || 0;

    const msg = r.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    // 没有工具调用 → 这一轮就是最终答复
    if (toolCalls.length === 0) {
      finalText = typeof msg.content === 'string' ? msg.content : '';
      transcript.push({ kind: 'answer', at: now(), content: finalText, finishReason: r.finishReason });
      if (onStep) onStep({ kind: 'answer', content: finalText });
      break;
    }

    // 把 assistant 的 tool_calls 原样放回对话（OpenAI 协议要求）
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const name = tc?.function?.name;
      let args = {};
      let parseErr = null;
      try {
        args = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (e) {
        parseErr = e.message;
      }

      let result;
      let ms = 0;
      if (parseErr) {
        result = { ok: false, error: '工具参数不是合法 JSON：' + parseErr };
      } else if (!allowedTools.has(name)) {
        /*
         * 批次 Z.28：白名单外的调用**不执行**。
         * 文案要能直接给用户看（工具卡会原样显示 error），
         * 所以写清「不在本次允许范围」+ 本模式到底有什么。
         */
        result = {
          ok: false,
          error: '工具「' + String(name) + '」不在本次允许范围内（本次可用：'
            + ([...allowedTools].join(', ') || '（无）') + '）',
        };
      } else if (!toolkit[name]) {
        result = { ok: false, error: '没有这个工具：' + name };
      } else {
        const t0 = Date.now();
        try {
          result = await toolkit[name].call(args, { cwd, subagentDepth, subagentDepthLimit });
        } catch (e) {
          result = { ok: false, error: '工具执行异常：' + (e && e.message ? e.message : String(e)) };
        }
        ms = Date.now() - t0;
        // A16：工具调用也是一个 span，带耗时与成败
        trace.recordSpan('tool', {
          ok: result?.ok !== false,
          durationMs: ms,
          attributes: { tool: name, step, input: JSON.stringify(args).slice(0, 400) },
          error: result?.ok === false ? String(result?.error || 'failed').slice(0, 300) : null,
        });
      }

      const rec = {
        kind: 'tool', at: now(), step, tool: name, input: args,
        ok: result?.ok !== false, ms,
        output: result,
      };
      transcript.push(rec);
      if (onStep) onStep(rec);

      // 工具结果回填（OpenAI 协议：role=tool + tool_call_id）
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 12000),
      });
    }

    if (r.truncated) {
      truncatedAny = true;
      // 模型这一轮被截断，但工具调用已执行完 —— 继续，下一轮让它收尾
      lastReason = '上一轮回复被 token 上限截断，已继续';
    }
    if (step === maxSteps - 1) hitLimit = true;
  }

  const toolRecords = transcript.filter((x) => x.kind === 'tool');
  const failedTools = toolRecords.filter((x) => !x.ok);

  /**
   * 计划快照：取**最后一次成功的 todo_write**。
   *
   * 为什么用「最后一次」而不是累加：todo_write 是整表替换语义，
   * 每次提交都是完整清单，累加会得到重复项。失败的那次不算
   * （校验没过，清单没被接受），否则界面会显示一份没生效的计划。
   */
  const planRec = [...toolRecords].reverse().find((x) => x.tool === 'todo_write' && x.ok !== false);
  const plan = Array.isArray(planRec?.output?.todos) ? planRec.output.todos : null;

  /**
   * 停止判定交给 stop.mjs 的**显式表**，不再在这里 if-else。
   * 之前是「有答复就 PASS」，撞了步数上限也给 PASS —— 那就是把
   * 「跑完了」当「做成了」。现在只要撞预算就不许 PASS。
   */
  const stop = classifyStop({
    finalText,
    toolCalls: toolRecords.length,
    failedToolCalls: failedTools.length,
    hitStepLimit: hitLimit,
    truncated: truncatedAny,
    modelError: null,
    userAbort: aborted,
  });
  const state = stop.four;

  // C4：正常收尾才清检查点；被取消/异常则保留，供 resume 续跑
  if (runId && !aborted) discardCheckpoint(runId);

  phase('idle', { step: transcript.filter((x) => x.kind === 'tool').length });

  // A16：收尾也落一条 trace 汇总（含四态与失败 span 数）
  const traceSummary = trace.end({
    state,
    reason: stop.reason,
    attributes: { toolCalls: toolRecords.length, failedToolCalls: failedTools.length },
  });

  const __res = {
    state,
    traceId: trace.traceId,
    // D3：本轮耗时（界面用来显示「花了多久」）
    elapsedMs: Date.now() - __t0,
    // C4：中断时可续跑
    runId: runId || null,
    resumable: Boolean(runId && aborted),
    // C1：可审计的中断与注入计数
    aborted,
    injectedCount,
    stopReason: stop.reason,
    stopLabel: stop.label,
    stopDetail: stop.detail,
    finalText,
    reason: lastReason || (hitLimit ? '达到步数上限 ' + maxSteps + '，可能未完成' : undefined),
    transcript,
    toolCalls: toolRecords.length,
    failedToolCalls: failedTools.length,
    /** 计划图层：最后一次成功提交的清单（null = 本轮没写计划） */
    plan,
    // 有工具失败但最终有答复：如实标出，不掩盖
    toolFailures: failedTools.map((x) => ({ tool: x.tool, error: x.output?.error })),
    at,
    usage: usageTotal,
    steps: transcript.filter((x) => x.kind === 'tool').length ? undefined : 0,
  };
  // 可选产出物兜底：声明了期望产出但没产出 → PASS 降 FAIL（堵「模型撒谎→PASS」）
  if (expectArtifacts && expectArtifacts.length) return applyArtifactCheck(__res, expectArtifacts, cwd);
  return __res;
}

/**
 * 目录快照：相对路径 → "mtime:size"。
 *
 * 【为什么需要】变更集只记录 write/edit 的改动。但 agent 还会用 bash ——
 * `rm`、`sed -i`、`python 脚本.py`、`git checkout` 改的文件，变更集**看不到**。
 * 之前这会变成一个隐形坑：界面显示「1 个文件被改」，实际磁盘上多了 5 个。
 * 现在跑前跑后各拍一次快照，把差异里**不属于变更集**的部分单独列出来，
 * 如实告诉用户「这些是工具之外的改动，回滚不了」。
 *
 * 只拍 mtime+size，不读内容（读全部内容太重），所以能**发现**但不能**恢复**。
 * 这是有意的取舍：先保证"不隐形"，恢复能力留给 write/edit 那条路。
 */
function snapshotTree(root, {
  maxFiles = 5000,
  /** 是否读内容（base64）。开了才能**恢复**工具外改动；代价是内存与耗时 */
  withContent = false,
  /** 单文件内容上限：超过只记签名，回滚时如实报「无法恢复」 */
  maxFileBytes = 512 * 1024,
  /** 整次快照的内容总预算，防止在大仓库里吃爆内存 */
  maxTotalBytes = 48 * 1024 * 1024,
  skip = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build']),
} = {}) {
  const out = new Map();
  const stack = [root];
  let count = 0;
  let totalBytes = 0;
  while (stack.length && count < maxFiles) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = joinPath(cur, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        try {
          const st = statSync(full);
          const rel = relativePath(root, full).split(pathSep).join('/');
          const rec = { sig: st.mtimeMs + ':' + st.size, size: st.size, contentB64: null };
          if (withContent && st.size <= maxFileBytes && totalBytes + st.size <= maxTotalBytes) {
            try {
              rec.contentB64 = readFileSync(full).toString('base64');
              totalBytes += st.size;
            } catch { /* 读不了就算了 */ }
          }
          out.set(rel, rec);
          count++;
        } catch { /* ignore */ }
        if (count >= maxFiles) break;
      }
    }
  }
  void totalBytes;
  return out;
}

/** 比对两次快照，找出不属于变更集的变化 */
function diffSnapshots(before, after, attributedRelPaths) {
  const out = [];
  for (const [p, rec] of after) {
    if (attributedRelPaths.has(p)) continue;
    if (!before.has(p)) out.push({ path: p, status: 'created' });
    else if (before.get(p).sig !== rec.sig) out.push({ path: p, status: 'modified' });
  }
  for (const p of before.keys()) {
    if (attributedRelPaths.has(p)) continue;
    if (!after.has(p)) out.push({ path: p, status: 'deleted' });
  }
  return out;
}

/**
 * 跑一次带工具的 agent，并产出**变更集**（可 diff 预览、可整体回滚）。
 *
 * 这是界面「动手」模式用的入口：一次运行 = 一个变更集。
 * 返回 result.changeSet（含每个文件的 diff 行），result.changeSetId 供回滚用。
 */
export async function runTaskWithChangeset(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const set = beginSet({ cwd, label: opts.label || String(opts.task || '').slice(0, 40) });
  const hooks = makeChangesetHooks(set);

  // 跑前拍快照（带内容，这样工具外改动也能恢复）
  const beforeSnap = opts.detectUnattributed === false ? null : snapshotTree(cwd, { withContent: true });

  const result = await runWithTools({ ...opts, changeset: hooks });

  /**
   * 顺序很关键：工具外改动必须在 **endSet 之前**登记进变更集。
   * 踩过的坑：先 endSet（会把 set.closed 置 true），再 addSnapshotRecord 就会被
   * 「已关闭」直接挡掉，于是 diff 里有 diff、回滚时却一个文件都没有 —— 
   * 界面上显示「3 个工具外改动」，一点回滚什么都没恢复。
   * 所以：先按 set.files 算归属 → 登记快照记录 → 再 endSet（一次落盘，diff 含两部分）。
   */
  let unattributed = [];
  if (beforeSnap) {
    const afterSnap = snapshotTree(cwd, { withContent: true });
    const attributed = new Set(
      [...set.files.keys()].map((abs) => relativePath(cwd, abs).split(pathSep).join('/')),
    );
    const found = diffSnapshots(beforeSnap, afterSnap, attributed);

    for (const f of found.slice(0, 200)) {
      const abs = joinPath(cwd, f.path);
      const b = beforeSnap.get(f.path);
      const existed = Boolean(b);
      addSnapshotRecord(set, {
        absPath: abs,
        existed,
        beforeBase64: existed ? (b ? b.contentB64 : null) : null,
        note: existed && !(b && b.contentB64) ? '未快照内容（文件过大或超预算），无法恢复' : null,
      });
    }

    unattributed = found.slice(0, 60).map((f) => {
      const b = beforeSnap.get(f.path);
      const existed = Boolean(b);
      return { ...f, restorable: existed ? Boolean(b && b.contentB64) : true };
    });
  }

  const diff = endSet(set);

  return {
    ...result,
    changeSetId: set.id,
    changeSet: diff,
    changedFiles: (diff?.files || []).length,
    /**
     * 工具之外的改动。**不能回滚**，但必须让用户看见 ——
     * 否则「回滚了」是假的：bash 改的那些还在。
     */
    unattributed,
    unattributedCount: unattributed.length,
  };
}

// ── CLI 自检：node tools/agent/loop.mjs "任务" ──
const isMain = (() => {
  try { return process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/agent/loop.mjs'); }
  catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const cwdArg = argv.find((a) => a.startsWith('--cwd='));
  const cwd = cwdArg ? cwdArg.slice('--cwd='.length) : process.cwd();
  const task = argv.filter((a) => !a.startsWith('--cwd=')).join(' ').trim();
  if (!task) {
    console.log('');
    console.log('  用法: node tools/agent/loop.mjs "要做的事"');
    console.log('  工具: read / write / edit / bash / glob / grep');
    console.log('');
    process.exit(2);
  }
  console.log('');
  console.log('  agent 循环 · ' + task);
  console.log('  工作目录: ' + cwd);
  console.log('  ' + '─'.repeat(70));
  const r = await runWithTools({
    systemPrompt: '你是一个能动手的程序员 agent。做完给简短总结。',
    task,
    cwd,
    onStep: (s) => {
      if (s.kind === 'tool') {
        const brief = JSON.stringify(s.input).slice(0, 90);
        console.log('  → ' + s.tool + ' ' + brief + '  [' + (s.ok ? 'ok' : 'FAIL') + ' ' + s.ms + 'ms]');
      }
    },
  });
  console.log('');
  console.log('  四态: ' + r.state);
  if (r.reason) console.log('  原因: ' + r.reason);
  console.log('  工具调用: ' + r.toolCalls + ' 次，失败 ' + r.failedToolCalls + ' 次');
  console.log('  用量: ' + r.usage.calls + ' 次模型调用 · in ' + r.usage.input + ' / out ' + r.usage.output);
  console.log('');
  console.log('  最终答复:');
  for (const line of String(r.finalText || '(无)').split('\n')) console.log('  | ' + line);
  console.log('');
  process.exitCode = r.state === 'PASS' ? 0 : 1;
}