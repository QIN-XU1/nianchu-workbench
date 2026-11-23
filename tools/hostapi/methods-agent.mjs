/**
 * 宿主方法 · 模型路由 / trace / 子代理 / 派单
 *
 * ══ 为什么单独拆一个文件 ═══════════════════════════════════════
 * `ws-host.mjs` 一度长到 32.6KB，撞了体量红线（单文件 32KB）。
 * 门禁的原话是「必须拆或加白名单说明」——**拆**才是对的，
 * 白名单只是把问题藏起来。这里按领域把 agent 侧的方法搬出来，
 * ws-host 只保留「装配 + 分发」。
 *
 * 导出的是一个**返回对象**的工厂：方法里用到的依赖都在本文件顶部 import，
 * 不依赖 ws-host 的内部状态，所以拆出去不会形成反向耦合。
 */
import { registrySummary as mdSummary, gatewayModelCount as mdCount, resolveChain as mdChain } from '../agent/models.mjs';
import { interruptTurn as rtInterrupt, renameSession as rtRename, deleteSession as rtDelete } from '../agent/runtime.mjs';
import { listTraces as trList, getTrace as trGet, traceStats as trStats } from '../agent/trace.mjs';
import { captureSession as ssCap, listSessions as ssList, loadSession as ssLoad, dropSession as ssDrop } from '../agent/session.mjs';
import { listResumable as ckList, loadCheckpoint as ckLoad, discardCheckpoint as ckDrop, repairSession as ckRepair } from '../agent/checkpoint.mjs';
import { spawnSubagent as saSpawn, spawnBatch as saBatch } from '../agent/subagent.mjs';
import {
  issue as hoIssue, ack as hoAck, startWork as hoStart, receipt as hoReceipt,
  close as hoClose, audit as hoAudit, list as hoList,
} from '../agent/handoff.mjs';
import { inferArtifacts } from '../agent/infer.mjs';
import { listWorkspaceFiles as wfList } from '../agent/workspace-files.mjs';

/** 组装这些方法（调用方直接 spread 进 methods 表） */
export function agentMethods() {
  return {
  /**
   * 停止生成：中断在途 fetch。返回 { aborted } 如实说明「是否真的停到了一条在跑的请求」。
   * 前端在发消息前自己生成 runToken 并随 start_dialog_turn 传下来，所以这里按 token 精确停。
   */
  interrupt_dialog_turn: (params) => {
    const r = (params && params.request) || params || {};
    const token = r.runToken ?? r.run_token ?? r.token;
    if (!token) return { aborted: false, reason: 'runToken 必填（前端发消息时应带上）' };
    return { aborted: rtInterrupt(token) };
  },
  /** 重命名会话（追加 meta 记录，索引重建后仍生效） */
  rename_session: (params) => {
    const r = (params && params.request) || params || {};
    return rtRename(r.sessionId, r.sessionName ?? r.name);
  },

  /** 删除会话（删 jsonl 真源） */
  delete_session: (params) => {
    const r = (params && params.request) || params || {};
    return rtDelete(r.sessionId);
  },

  // ══ 终端会话快照与环境抽象（A2）════════════════════════════
  capture_shell_session: (params) => {
    const r = (params && params.request) || params || {};
    if (!r.name) return { state: 'FAIL', reason: 'name 必填' };
    return ssCap(r.name, { cwd: r.cwd || process.cwd(), script: r.script || '' });
  },
  list_shell_sessions: () => ({ state: 'PASS', items: ssList() }),
  get_shell_session: (params) => {
    const r = (params && params.request) || params || {};
    const s = ssLoad(r.name);
    if (!s) return { state: 'UNKNOWN', reason: '没有这个会话快照：' + String(r.name) };
    if (s.corrupted) return { state: 'WARN', reason: '快照已损坏', snapshot: s };
    return { state: 'PASS', snapshot: s };
  },
  drop_shell_session: (params) => {
    const r = (params && params.request) || params || {};
    return ssDrop(r.name);
  },

  // ══ 自愈：检查点 / 会话修复（C4）════════════════════════════
  list_checkpoints: (params) => {
    const r = (params && params.request) || params || {};
    return { state: 'PASS', items: ckList(Number(r.limit) || 20) };
  },
  get_checkpoint: (params) => {
    const r = (params && params.request) || params || {};
    const c = ckLoad(r.runId);
    if (!c) return { state: 'UNKNOWN', reason: '没有这个检查点：' + String(r.runId) };
    if (c.corrupted) return { state: 'WARN', reason: '检查点文件已损坏，不可续跑', checkpoint: c };
    return { state: 'PASS', checkpoint: c };
  },
  discard_checkpoint: (params) => {
    const r = (params && params.request) || params || {};
    return ckDrop(r.runId);
  },
  /** 修复会话：把未闭合的 turn 补上结束标记（已闭合部分不动） */
  repair_session: (params) => {
    const r = (params && params.request) || params || {};
    if (!r.session || !Array.isArray(r.session.messages)) {
      return { state: 'FAIL', reason: '需要 session.messages 数组' };
    }
    return ckRepair(r.session);
  },

  /** 纯读：从一句话推断期望产出物（界面可用它先跟用户确认，再显式传 expectArtifacts） */
  infer_artifacts: (params) => {
    const r = (params && params.request) || params || {};
    return { state: 'PASS', ...inferArtifacts(String(r.text || r.task || '')) };
  },

  // ══ 可中断 / 可注入的 agent 运行（C1）════════════════════════
  /**
   * 起一次**可中断**的运行：返回 runId，之后可 cancel_run / inject_input。
   *
   * 为什么需要：原来 run_task 一旦发起就只能等它自己结束，
   * 用户想停停不掉、想补一句话也补不进去。dsh 的循环是
   * 「queued turns + step-boundary input」，我们原来两样都没有。
   */
  start_run: async (params, hostCtx) => {
    const ctxNotify = hostCtx && typeof hostCtx.notify === 'function' ? hostCtx.notify : null;
    const r = (params && params.request) || params || {};
    const task = r.task ?? r.content ?? r.text;
    if (!task || !String(task).trim()) return { state: 'FAIL', reason: 'task 为空' };

    const runId = 'run-' + Math.random().toString(36).slice(2, 12);
    const ac = new AbortController();
    const queue = [];
    // C1 的取消句柄表：按 runId 保存，供 cancel_run 使用
    if (!globalThis.__nianchuRuns) globalThis.__nianchuRuns = new Map();
    globalThis.__nianchuRuns.set(runId, { ac, queue });

    const runner = await import('../agent/loop.mjs');
    // 产出物兜底：显式传入则强校验；未传则只**建议**（不强加，避免误报）
    const explicitArtifacts = Array.isArray(r.expectArtifacts) && r.expectArtifacts.length ? r.expectArtifacts : null;
    const suggested = explicitArtifacts ? null : inferArtifacts(String(task));
    // 异步跑，立刻返回 runId（调用方用 wait 类方法或事件拿结果）
    const promise = runner.runWithTools({
      systemPrompt: r.systemPrompt,
      task: String(task),
      cwd: r.cwd || process.cwd(),
      maxSteps: Number(r.maxSteps) || 12,
      signal: ac.signal,
      expectArtifacts: explicitArtifacts,
      inbox: () => (queue.length ? queue.shift() : null),
      onPhase: (p) => {
        // 有通知通道就推送，让界面能看到"它在跑"
        if (ctxNotify) {
          try { ctxNotify({ event: 'nianchu://agent-phase', payload: { runId, ...p } }); } catch { /* ignore */ }
        }
      },
    }).finally(() => {
      globalThis.__nianchuRuns.delete(runId);
    });

    promise.then((result) => {
      if (ctxNotify) {
        try { ctxNotify({ event: 'nianchu://agent-done', payload: { runId, state: result.state, stopReason: result.stopReason, traceId: result.traceId } }); } catch { /* ignore */ }
      }
    }).catch(() => { /* 错误通过 cancel/done 事件体现 */ });

    return { state: 'PASS', runId, note: '已启动；用 cancel_run 取消，用 inject_input 补话',
      enforceArtifacts: Boolean(explicitArtifacts),
      suggestedArtifacts: suggested && suggested.confidence === 'high' ? suggested.artifacts : [],
      suggestedNote: suggested ? suggested.reason : '已启用显式产出物校验' };
  },

  /** 取消一次正在跑的运行（步边界生效，不硬杀） */
  cancel_run: (params) => {
    const r = (params && params.request) || params || {};
    const runs = globalThis.__nianchuRuns;
    const h = runs && runs.get(r.runId);
    if (!h) return { state: 'UNKNOWN', reason: '没有这个正在跑的 runId：' + String(r.runId) };
    h.ac.abort(r.reason || '用户取消');
    return { state: 'PASS', runId: r.runId, note: '已在步边界取消（已发生的工具副作用会保留）' };
  },

  /** 往一次正在跑的运行里补一句用户输入（步边界注入） */
  inject_input: (params) => {
    const r = (params && params.request) || params || {};
    const text = r.text ?? r.content;
    if (!text || !String(text).trim()) return { state: 'FAIL', reason: 'text 为空' };
    const runs = globalThis.__nianchuRuns;
    const h = runs && runs.get(r.runId);
    if (!h) return { state: 'UNKNOWN', reason: '没有这个正在跑的 runId：' + String(r.runId) };
    h.queue.push(String(text));
    return { state: 'PASS', runId: r.runId, queued: h.queue.length };
  },

  // ══ 工作区文件（批次 W：composer 的 `@` 引用面板）══════════
  list_workspace_files: (params) => {
    const r = (params && params.request) || params || {};
    return wfList({
      root: r.root || process.cwd(),
      query: r.query || '',
      limit: Number(r.limit) || 120,
    });
  },

  // ══ 模型路由（A14）══════════════════════════════════════════
  list_models: async () => {
    const g = await mdCount();
    return { state: 'PASS', roles: mdSummary(), gatewayModelCount: g };
  },
  resolve_models: (params) => {
    const r = (params && params.request) || params || {};
    return { state: 'PASS', role: r.role || 'default', chain: mdChain(r.role || 'default') };
  },

  // ══ 决策级 trace（A16）══════════════════════════════════════
  list_traces: (params) => {
    const r = (params && params.request) || params || {};
    return trList(Number(r.limit) || 20);
  },
  get_trace: (params) => {
    const r = (params && params.request) || params || {};
    const tr = trGet(r.traceId);
    // 找不到就 UNKNOWN，不返回空对象假装成功
    if (!tr) return { state: 'UNKNOWN', reason: '找不到这个 trace：' + String(r.traceId) };
    return { state: 'PASS', trace: tr };
  },
  trace_stats: () => trStats(),

  // ══ 子代理（隔离上下文 + 深度上限 + 并发）══════════════════
  spawn_subagent: async (params) => {
    const r = (params && params.request) || params || {};
    return saSpawn({
      task: r.task ?? r.content ?? r.text,
      systemPrompt: r.systemPrompt,
      depth: Number(r.depth) || 0,
      depthLimit: Number(r.depthLimit) || 2,
      cwd: r.cwd || process.cwd(),
      maxSteps: Number(r.maxSteps) || 8,
    });
  },
  spawn_batch: async (params) => {
    const r = (params && params.request) || params || {};
    return saBatch(Array.isArray(r.tasks) ? r.tasks : [], {
      concurrency: Number(r.concurrency) || 3,
      depth: Number(r.depth) || 0,
      depthLimit: Number(r.depthLimit) || 2,
      cwd: r.cwd || process.cwd(),
      maxSteps: Number(r.maxSteps) || 8,
    });
  },
  };
}
