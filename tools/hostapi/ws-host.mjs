#!/usr/bin/env node
/**
 * 念初 · 自有 WebSocket 宿主（最小实现，零依赖，手写 RFC 6455）
 *
 * 为什么需要：产品在浏览器环境下由 `createTransportAdapter()` 连 WebSocket 宿主
 * （apps/vouch-web/src/web-ui/src/infrastructure/api/adapters/index.ts:30-39，
 *   默认 ws://localhost:8080/ws）。我们一直没实现它，所以首页的用量/智能体/
 *   技能/小应用全显示「无法加载」。
 *
 * 本文件做三件事：
 *   1. 真正完成 WebSocket 握手与帧收发（不依赖 ws 包）
 *   2. **记录 app 实际请求了哪些方法** → 把静态清点的 277 个可能项，
 *      收敛成「启动时真的会要的」真实需求（写 evidence/host-api/runtime-demand.json）
 *   3. 对每个请求如实回 -32601（未实现），**不编造数据**
 *
 * 边界如实说：
 *   · 这不是完整宿主，只是传输层 + 需求探针
 *   · 已实现的方法在 IMPLEMENTED 里逐个登记；没登记的返回 -32601
 *   · 不做鉴权/隔离（单机本地）
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitReadMethods } from './git-methods.mjs';
import { emitStep } from './step-events.mjs';
import { createSkillLoader } from '../skills/loader.mjs';
import { skillMethods } from './methods-skills.mjs';
import { configMethods } from './methods-config.mjs';
import { hostGapMethods } from './methods-host-gaps.mjs';
import { createUsageStore } from './usage-store.mjs';
import {
  listSessions as agentListSessions,
  getSession as agentGetSession,
  createSession as agentCreateSession,
  submitTurn as agentSubmitTurn,
  ASSISTANT_WORKSPACE_ID,
} from '../agent/runtime.mjs';
import { createToolkit } from '../agent/toolkit.mjs';
import { agentMethods } from './methods-agent.mjs';
import { runWithTools as agentRunWithTools, runTaskWithChangeset } from '../agent/loop.mjs';
import { resolveRunMode, workModeMethods } from './methods-modes.mjs';
import {
  rollbackSet as csRollback, getSet as csGet, listSets as csList, computeDiff as csDiff,
  pruneSets, changesetUsage, maybeAutoPrune,
} from '../agent/changeset.mjs';
import {
  AGENTS as TEAM_AGENTS,
  runTeam as agentRunTeam,
  listTeamRuns as agentListTeamRuns,
} from '../agent/team.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const usageStore = createUsageStore(REPO);

/** 对话轮次入口：透传 runToken（停止生成）与附件 */
function dialogTurn(params) {
  const req = (params && params.request) || params || {};
  return agentSubmitTurn({
    sessionId: req.sessionId,
    text: req.content ?? req.text ?? req.message,
    model: req.model,
    systemPrompt: req.systemPrompt,
    runToken: req.runToken,
    images: req.images,
    files: req.files,
  });
}
const PORT = Number(process.env.WS_PORT || 8080);
const PATH = process.env.WS_PATH || '/ws';
const OUT = join(REPO, 'evidence/host-api/runtime-demand.json');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 我们真正实现的方法。
 *
 * 依据：浏览器实测首页只请求 12 个方法（evidence/host-api/runtime-demand.json），
 * 不是静态清点出来的 277 个。这里只实现「能如实回答」的那些 ——
 * **绝不为了界面好看而编造数据**。
 *
 *   · 布尔/空值类：我们没有这个能力，就如实说 false / null / []
 *   · 有真数据的（技能、调度 job）走我们自己的 /api/skills、/api/scheduler，
 *     不在这里硬编码
 */
const IMPLEMENTED = {
  check_path_exists: (params) => {
    const p = params && (params.path || params.filePath);
    return typeof p === 'string' && existsSync(p);
  },
  // 不做 PATH 探测，宁可 false 也不假装
  check_command_exists: () => false,
  // ── 如实否定的能力（我们没有，就不装作有）──
  computer_use_control_status: () => false,      // 不做 computer use
  account_token_expired: () => false,            // 未登录，不存在过期
  account_github_info: () => null,               // 未登录
  remote_connect_status: () => ({ connected: false }),
  remote_connect_get_device_info: () => null,
  // ── 如实的空集合（确实一个都没有）──
  list_miniapps: () => [],
  miniapp_worker_list_running: () => [],
  list_subagents: () => [],
  get_available_modes: () => [],
  // ── 引导期无副作用的方法：做了就是「什么都不用做」──
  show_main_window: () => null,
  mark_miniapp_web_surface_ready: () => null,
  initialize_mcp_servers: () => null,
  initialize_acp_clients: () => null,
  // 语言：我们就是 zh-CN（不是猜，是产品当前唯一语言）
  'i18n/getCurrentLanguage': () => 'zh-CN',
  // 权限请求：我们不做越界拦截类机制，因此永远没有待审请求
  'agent/listPendingPermissionRequests': () => [],
  // ── 配置中心（真持久化，拆到 methods-config.mjs）：主题/外观/开关等依赖这些 ──
  ...configMethods(REPO),
  // ── 设置各页实测缺失的方法（拆到 methods-host-gaps.mjs）：终端/ACP/外部导入/模型/订阅 ──
  ...hostGapMethods(REPO),
  // 派单「执行任务」：我们没有 worker 在跑，确实一条都没有
  // （注意：不要拿 tools/schedule 的 cron job 去填 —— 那是两回事，填了就是造假）
  dispatch_list_jobs: () => [],
  /**
   * 技能清单 —— 这是**唯一一处用真数据回答**的方法。
   * 数据源：我们自己的 tools/skills/loader.mjs 扫 prototype/scenes（6 个技能）。
   * 形状对齐 infrastructure/config/types/index.ts:561 SkillInfo（level 只能是 user|project）。
   */
  get_skill_configs: () => {
    const loader = createSkillLoader([join(REPO, 'prototype/scenes')]).scanAll();
    return loader.list().map((s) => ({
      key: 'scene:' + s.name,
      name: s.name,
      description: s.description || '',
      path: join(REPO, 'prototype/scenes', s.name),
      entryFile: 'SKILL.md',
      level: 'project',
      sourceSlot: 'project',
      dirName: s.name,
      isBuiltin: false,
    }));
  },

  /* ══════════════════════════════════════════════════════════
     会话 / 对话通道（2026-11-18 补）
     ──────────────────────────────────────────────────────────
     之前这 8 个方法一个都没有，导致主 agent 面板永远显示 unavailable
     （台账 H-0192 记的就是这件事）。现在接到 tools/agent/runtime.mjs，
     背后是真实模型网关，不做假回复。
     ══════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════
     工作区启动快照（2026-11-18 补）
     ──────────────────────────────────────────────────────────
     浏览器控制台实测报错：
       [WorkspaceManager] Failed to initialize workspace state
       TauriCommandError: Request timeout
     原因就是 `initialize_workspace_startup_state` 没实现，前端等 30s 超时。
     而 workspaceManager 一旦初始化失败，currentWorkspace 永远是 null，
     后面的 createChatSession 就必然抛 "Workspace ID is required"。

     形状按 GlobalAPI.ts:157-177 的 WorkspaceStartupStateSnapshot 对齐。
     ══════════════════════════════════════════════════════════ */
  initialize_workspace_startup_state: () => {
    const assistant = {
      id: ASSISTANT_WORKSPACE_ID,
      name: '念初助手',
      // 给「动手」面板一个可用的默认目录（不返回空串，否则界面要用户手打）
      path: process.cwd(),
      cwd: process.cwd(),
      workspaceKind: 'assistant',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return {
      currentWorkspace: assistant,
      openedWorkspaces: [assistant],
      recentWorkspaces: [assistant],
      assistantWorkspaces: [assistant],
      primaryAssistantWorkspaceId: ASSISTANT_WORKSPACE_ID,
    };
  },

  /** workspaceManager 初始化过程中可能顺带要的读取 */
  get_workspace_state: () => ({
    currentWorkspace: {
      id: ASSISTANT_WORKSPACE_ID, name: '念初助手', path: '',
      workspaceKind: 'assistant',
    },
    openedWorkspaces: [{
      id: ASSISTANT_WORKSPACE_ID, name: '念初助手', path: '',
      workspaceKind: 'assistant',
    }],
    recentWorkspaces: [],
  }),

  initialize_workspace_startup_state_impl: () => null,

  /** 事件订阅：浏览器没有 Tauri event，如实返回「不支持」而不是骗前端已订阅 */
  subscribe_workspace_catalog_updates: () => ({
    subscribed: false,
    reason: '自有宿主不做事件推送；前端可轮询',
  }),

  subscribe_workspace_identity_updates: () => ({
    subscribed: false,
    reason: '自有宿主不做事件推送；前端可轮询',
  }),

  /** 日志/遥测：如实空 */
  get_runtime_logging_info: () => ({ level: 'info', path: null }),
  // 调用统计走真实用量账本聚合（旧 not-tracked 桩已被覆盖）。
  get_token_usage_statistics: (params) => usageStore.statistics((params && params.request) || params || {}),
  list_cron_jobs: () => [],

  /** 助手工作区 —— 主 agent 的会话都挂这里 */
  create_assistant_workspace: () => ({
    id: ASSISTANT_WORKSPACE_ID,
    name: '念初助手',
    path: '',
    workspaceKind: 'assistant',
    createdAt: new Date().toISOString(),
  }),

  get_current_workspace: () => ({
    id: ASSISTANT_WORKSPACE_ID,
    name: '念初助手',
    path: '',
    workspaceKind: 'assistant',
  }),

  get_opened_workspaces: () => [{
    id: ASSISTANT_WORKSPACE_ID,
    name: '念初助手',
    path: '',
    workspaceKind: 'assistant',
  }],

  get_recent_workspaces: () => [],

  list_sessions: () => {
    const idx = agentListSessions();
    return idx.sessions.map((s) => ({
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      agentType: s.agentType,
      workspaceId: s.workspaceId,
      workspacePath: s.workspacePath || '',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount,
    }));
  },

  create_session: (params) => {
    const req = (params && params.request) || params || {};
    const s = agentCreateSession({
      sessionName: req.sessionName || req.sessionName === '' ? req.sessionName : '新会话',
      workspaceId: req.workspaceId || ASSISTANT_WORKSPACE_ID,
    });
    return {
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      agentType: s.agentType,
      workspaceId: s.workspaceId,
      workspacePath: s.workspacePath || '',
    };
  },

  get_session: (params) => {
    const id = (params && (params.sessionId || (params.request && params.request.sessionId))) || '';
    return agentGetSession(id);
  },

  /**
   * 发一句话，真调模型。
   * 返回 { state, content, model, usage, runToken } 或 { state:'FAIL', reason }
   * —— 失败如实带 reason，不返回假内容。runToken 供「停止生成」中断在途请求。
   */
  start_dialog_turn: async (params) => {
    const r = await dialogTurn(params);
    usageStore.recordFromTurn(r);
    return r;
  },

  /** 前端有的版本用这个别名 */
  submit_dialog_turn: async (params) => {
    const r = await dialogTurn(params);
    usageStore.recordFromTurn(r);
    return r;
  },

  // ══ 多智能体协同 ══════════════════════════════════════════════
  // 界面要能看到「有哪几个 agent」和「它们怎么协作的」，所以这三条必须有：
  //   list_agents     —— 花名册（谁负责什么）
  //   run_team        —— 真跑一轮（含修复轮），返回逐阶段 trace
  //   list_team_runs  —— 历史
  list_agents: () => Object.values(TEAM_AGENTS).map((a) => ({
    id: a.id, name: a.name, role: a.role,
    // systemPrompt 不下发全文，只给前 80 字摘要，避免界面被长文本撑爆
    promptHint: String(a.systemPrompt).replace(/\s+/g, ' ').slice(0, 80),
  })),

  run_team: async (params) => {
    const req = (params && params.request) || params || {};
    const objective = req.objective ?? req.content ?? req.text;
    return agentRunTeam({
      objective,
      maxSubtasks: Number(req.maxSubtasks) || 3,
      maxRounds: Number(req.maxRounds) || 2,
      parallel: req.parallel !== false,
      model: req.model,
      // 透传工具与工作目录：给了工具，实现者就会真的改文件（协同不再只是出方案）
      tools: Array.isArray(req.tools) && req.tools.length ? req.tools : null,
      cwd: req.cwd || process.cwd(),
    });
  },

  list_team_runs: async (params) => {
    const req = (params && params.request) || params || {};
    return agentListTeamRuns(Number(req.limit) || 20);
  },

  // ══ 带工具的 agent（能真读写文件 / 跑命令）══════════════════
  // 这是「搬 Claude Code 架构」的落点：tool_use → 执行 → tool_result 循环。
  list_tools: () => Object.values(createToolkit({})).map((x) => ({
    name: x.name, readOnly: x.readOnly === true,
    description: String(x.description).split('\n')[0].slice(0, 90),
  })),

  /**
   * 批次 Z.28：工作方式表（模式 → 工具清单），供界面显示「本模式可用工具」。
   * 与 run_task 用的是**同一份** `modes.mjs`，界面上的数字不会和真实派发能力对不上。
   */
  ...workModeMethods(),

  run_task: async (params, ctx) => {
    const req = (params && params.request) || params || {};
    /**
     * 流式：每发生一次工具调用就往前端推一条 nianchu://agent-step。
     * 之前是"跑完才一次性返回"，长任务期间界面只能显示"正在执行"，
     * 看不到它到底在干什么 —— 这在让 agent 动真实文件时是不可接受的。
     *
     * runToken 让前端能过滤掉不属于本次运行的旧事件。
     */
    // 前端可以自带 runToken：这样它在发请求**之前**就能订阅对应事件，不会漏掉开头几条
    const runToken = String(req.runToken || '').trim()
      || ('run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
    const notify = ctx && typeof ctx.notify === 'function' ? ctx.notify : null;

    // 批次 Z.28：工作方式 = 显式工具白名单（解析逻辑在 methods-modes.mjs，mode 优先于 tools）
    const wm = resolveRunMode(req);
    if (wm.error) return { state: 'FAIL', runToken, reason: wm.error };
    const { mode } = wm;
    const toolWhitelist = wm.tools;

    const result = await runTaskWithChangeset({
      systemPrompt: req.systemPrompt || '你是念初的动手 agent，能读写文件、执行命令。做完给简短总结。',
      task: req.task ?? req.content ?? req.text,
      cwd: req.cwd || process.cwd(),
      tools: toolWhitelist,
      maxSteps: Number(req.maxSteps) || 12,
      model: req.model,
      label: req.label,
      onStep: (step) => {
        emitStep(notify, runToken, step);
      },
    });

    // 跑完顺手清一次旧变更集（内部节流 10 分钟，不会每次都扫目录）
    try {
      const pr = maybeAutoPrune();
      if (pr.ran && pr.removed > 0 && notify) {
        notify('nianchu://changes-pruned', { removed: pr.removed, kept: pr.kept });
      }
    } catch { /* 清理失败不影响本次结果 */ }

    if (notify) notify('nianchu://agent-done', {
      runToken,
      state: result.state,
      toolCalls: result.toolCalls,
      changedFiles: result.changedFiles,
      unattributedCount: result.unattributedCount,
    });

    return { ...result, runToken, mode };
  },

  // ══ 变更集：看 diff / 回滚 ══════════════════════════════════
  list_changes: (params) => {
    const req = (params && params.request) || params || {};
    return csList(Number(req.limit) || 30);
  },

  get_change_set: (params) => {
    const req = (params && params.request) || params || {};
    const set = csGet(req.changeSetId);
    if (!set) return { state: 'UNKNOWN', reason: '找不到变更集：' + req.changeSetId };
    return { state: 'PASS', changeSet: csDiff(set) };
  },

  /**
   * 清理旧变更集。变更集里可能含 base64 原内容，不清理会一直涨。
   * 默认保留最近 100 个 + 30 天，可覆盖。
   */
  prune_changes: (params) => {
    const req = (params && params.request) || params || {};
    const r = pruneSets({
      maxCount: Number(req.maxCount) > 0 ? Number(req.maxCount) : 100,
      maxAgeDays: Number(req.maxAgeDays) > 0 ? Number(req.maxAgeDays) : 30,
    });
    return { state: 'PASS', ...r };
  },

  // ══ 模型路由 / trace / 子代理 / 派单（已拆到 methods-agent.mjs）════
  ...agentMethods(),

  // ══ 派单闭环（五态 + 超时升级 + 销账）══════════════════════
  // 防两个真实失败模式：派单进黑洞、双方互等。
  issue_handoff: (params) => {
    const r = (params && params.request) || params || {};
    return hoIssue(r);
  },
  ack_handoff: (params) => {
    const r = (params && params.request) || params || {};
    return hoAck(r);
  },
  start_handoff: (params) => {
    const r = (params && params.request) || params || {};
    return hoStart(r);
  },
  receipt_handoff: (params) => {
    const r = (params && params.request) || params || {};
    return hoReceipt(r);
  },
  close_handoff: (params) => {
    const r = (params && params.request) || params || {};
    return hoClose(r);
  },
  /** 体检：报出进黑洞/双方互等/没证据/未销账 */
  audit_handoffs: () => hoAudit(),
  list_handoffs: (params) => {
    const r = (params && params.request) || params || {};
    return hoList({ status: r.status, limit: Number(r.limit) || 50 });
  },

  /** 记忆分层用量（每层占多少 / 预算多少 / 是否超） */
  memory_usage: () => {
    const rows = memUsageAll();
    return {
      state: rows.some((r) => r.over) ? 'WARN' : 'PASS',
      scopes: rows.map((r) => ({ scope: r.scope, chars: r.chars, cap: r.cap, over: r.over, entries: r.rows.length })),
    };
  },

  /** 换会话闸门：交接没写/超预算就不许换 */
  check_handoff: () => {
    const r = memCheckHandoff();
    return { state: r.ok ? 'PASS' : 'FAIL', ...r };
  },

  /** 变更集目录用量（条数 + 字节数），给界面/运维看 */
  changeset_usage: () => ({ state: 'PASS', ...changesetUsage() }),

  rollback_change: (params) => {
    const req = (params && params.request) || params || {};
    const set = csGet(req.changeSetId);
    if (!set) return { state: 'UNKNOWN', reason: '找不到变更集：' + req.changeSetId };
    return csRollback(set);
  },

  // ── git（第 103 轮补：界面 GitStateManager 需要 git/isRepository）──
  ...gitReadMethods,

  // ── 技能（第 121 轮抽出到 methods-skills.mjs，避免单文件破 32KB 红线）──
  // 提供 get_skill_configs / miniapp_market_installed_origins /
  //      skill_market_search / skill_manage
  ...skillMethods(REPO),
};

/**
 * ══ 方法名别名（2026-11-18 实测补）═══════════════════════════════
 *
 * 前端 websocket-adapter.ts 会把桌面端的方法名映射成 `group/verb` 形式再发出去：
 *   list_sessions        → agent/listSessions      (L74)
 *   create_session       → agent/createSession     (L73)
 *   start_dialog_turn    → agent/submitDialogTurn  (L101)
 *   create_assistant_workspace → 原样
 *
 * 我第一次只注册了下划线名，结果前端发的是 `agent/listSessions`，
 * 落到 -32601 → 前端 30s 后报 "Request timeout"。
 * （实测：直接发下划线名全部 1-11ms 就返回，所以不是慢，是名字对不上。）
 *
 * 这里两套名字都指向同一批实现，谁发过来都能答。
 */
const ALIASES = {
  'agent/listSessions': 'list_sessions',
  'agent/createSession': 'create_session',
  'agent/getSession': 'get_session',
  'agent/deleteSession': 'delete_session', 'agent/renameSession': 'rename_session',
  'agent/submitDialogTurn': 'start_dialog_turn',
  'agent/submitTurn': 'start_dialog_turn',
  'agent/createAssistantWorkspace': 'create_assistant_workspace',
  'workspace/getCurrentWorkspace': 'get_current_workspace',
  'workspace/getOpenedWorkspaces': 'get_opened_workspaces',
  'workspace/getRecentWorkspaces': 'get_recent_workspaces',
  'workspace/initializeStartupState': 'initialize_workspace_startup_state',
  'globalState/initializeWorkspaceStartupState': 'initialize_workspace_startup_state',
};

/** 把发过来的方法名解析到真实实现名 */
function resolveMethod(name) {
  if (!name) return name;
  if (name in IMPLEMENTED) return name;
  if (name in ALIASES) return ALIASES[name];
  return name;
}

/** 需求统计：method -> {count, firstAt, lastParams} */
const demand = new Map();
const log = [];

function record(method, params) {
  const e = demand.get(method) || { count: 0, firstAt: new Date().toISOString(), lastParams: null };
  e.count++;
  e.lastParams = params === undefined ? null : params;
  demand.set(method, e);
}

function dumpDemand(reason) {
  mkdirSync(dirname(OUT), { recursive: true });
  const payload = {
    what: 'app 运行时真实请求的宿主方法（由自有 WS 宿主记录）',
    at: new Date().toISOString(),
    reason,
    port: PORT,
    path: PATH,
    summary: { distinctMethods: demand.size, totalRequests: [...demand.values()].reduce((a, b) => a + b.count, 0), implemented: Object.keys(IMPLEMENTED).length },
    methods: [...demand.entries()].map(([name, v]) => ({ name, count: v.count, firstAt: v.firstAt, implemented: name in IMPLEMENTED || name in ALIASES }))
      .sort((a, b) => b.count - a.count),
    tailLog: log.slice(-40),
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log('  [demand] ' + payload.summary.distinctMethods + ' 个不同方法 / ' + payload.summary.totalRequests + ' 次请求 → ' + OUT);
}

// ── 帧编解码（最小：文本 + 关闭 + ping）──
function encodeFrame(payloadStr) {
  const payload = Buffer.from(payloadStr, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}

function decodeFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const maskLen = masked ? 4 : 0;
    if (p + maskLen + len > buf.length) break;
    const mask = masked ? buf.slice(p, p + 4) : null;
    p += maskLen;
    const data = Buffer.from(buf.slice(p, p + len));
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    out.push({ opcode, data });
    off = p + len;
  }
  return { frames: out, rest: buf.slice(off) };
}

/**
 * 处理一次 WebSocket 升级。
 *
 * 【为什么单独抽出来】2026-11-18 用户提醒「我们实际要做的是份软件」——
 * 之前 WebSocket 宿主是**独立进程**（8080），产品服务器是另一个进程（47124），
 * 用户必须手动开两个 node 才能用。那不是软件。
 * 现在抽成可挂载的 handler，由产品服务器在同一端口承载。
 */
function handleUpgrade(req, socket) {
  // 只接管约定路径，别把别的 upgrade 抢走
  const url = String(req.url || '');
  const reqPath = url.split('?')[0];
  if (reqPath !== PATH) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  /**
   * 【2026-11-18 实测根因】open 之后 2ms 就 close，浏览器报
   *   WebSocket connection to 'ws://localhost:8080/ws' failed
   *
   * 原因：Node 的 http server 在 upgrade 之后，如果 socket 仍带默认的
   * 空闲超时/没有设置 noDelay，会在响应写完后按 HTTP 语义收尾把连接关掉。
   * 修法（标准做法）：
   *   · socket.setNoDelay(true)   —— 关 Nagle，避免小帧被合并延迟
   *   · socket.setTimeout(0)      —— 清掉 server 的默认空闲超时
   *   · 显式 removeAllListeners('timeout')
   * 三条都加上之后连接才能长期保持。
   */
  socket.setNoDelay(true);
  socket.setTimeout(0);
  socket.removeAllListeners('timeout');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  log.push({ at: new Date().toISOString(), ev: 'open', url: req.url });

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, rest } = decodeFrames(buf);
    buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) { try { socket.end(); } catch { /* ignore */ } return; }
      if (f.opcode === 0x9) { // ping → pong
        const pong = Buffer.alloc(2 + f.data.length);
        pong[0] = 0x8a; pong[1] = f.data.length;
        f.data.copy(pong, 2);
        try { socket.write(pong); } catch { /* ignore */ }
        continue;
      }
      if (f.opcode !== 0x1 && f.opcode !== 0x2) continue;
      const text = f.data.toString('utf8');
      let msg;
      try { msg = JSON.parse(text); } catch { log.push({ at: new Date().toISOString(), ev: 'badjson', head: text.slice(0, 120) }); continue; }

      // JSON-RPC 请求：{jsonrpc,id,method,params}
      const method = msg && msg.method;
      const id = msg && msg.id;
      if (method) {
        record(method, msg.params);
        log.push({ at: new Date().toISOString(), ev: 'request', method, id: id === undefined ? null : id });
      } else {
        log.push({ at: new Date().toISOString(), ev: 'nonmethod', head: text.slice(0, 160) });
      }
      if (id === undefined || id === null) continue; // 通知，不回

      const realMethod = resolveMethod(method);
      if (realMethod && realMethod in IMPLEMENTED) {
        // handler 可能是 async（对话要真调模型）—— 统一 await
        /**
         * 第二参数 ctx 给 handler 一个「往前端推事件」的通道。
         * 协议对齐前端已有的 decodeWsNotification：method='agent/frontendEvent'，
         * params={event, payload}。前端用 getTransportAdapter().listen(event, cb) 订阅。
         */
        Promise.resolve()
          .then(() => IMPLEMENTED[realMethod](msg.params, {
            notify: (event, payload) => {
              try {
                socket.write(encodeFrame(JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'agent/frontendEvent',
                  params: { event, payload },
                })));
              } catch { /* 连接已断，忽略 */ }
            },
          }))
          .then((result) => {
            try { socket.write(encodeFrame(JSON.stringify({ jsonrpc: '2.0', id, result }))); } catch { /* ignore */ }
          })
          .catch((e) => {
            try {
              socket.write(encodeFrame(JSON.stringify({
                jsonrpc: '2.0', id,
                error: { code: -32603, message: String(e && e.message) },
              })));
            } catch { /* ignore */ }
          });
        continue;
      }

      // 走到这里 = 方法未实现。必须回 JSON-RPC -32601 错误，
      // 不能静默不回（此前是 `if (false)`，导致未知方法永不回复、客户端超时挂死 —— 第 76 轮 WS e2e 反例抓到）。
      const reply = {
        jsonrpc: '2.0', id,
        error: {
          code: -32601,
          message: '本机自有服务器尚未实现该方法：' + String(method) + '（如实返回，不编造数据）',
        },
      };
      try { socket.write(encodeFrame(JSON.stringify(reply))); } catch { /* ignore */ }
    }
  });
  socket.on('error', () => { /* ignore */ });
  socket.on('close', () => { log.push({ at: new Date().toISOString(), ev: 'close' }); dumpDemand('connection closed'); });
}

export { IMPLEMENTED, ALIASES, demand, dumpDemand };

/**
 * 把 WebSocket 宿主挂到一个已有的 http server 上。
 *
 * 这是「让产品成为一份软件」的关键改动：产品服务器（tools/workbench/serve.mjs）
 * 在 47124 一个端口上同时提供 静态页面 + /api/* + WebSocket，
 * 用户只需要启动一个进程。
 *
 * @param {import('node:http').Server} httpServer 已创建的 http server
 * @param {{ path?: string }} [opts]
 */
export function attachWebSocketHost(httpServer, opts = {}) {
  const path = opts.path || PATH;
  // 长连接：清理 HTTP 语义的超时，否则 upgrade 之后会被自动收尾关掉
  httpServer.timeout = 0;
  httpServer.keepAliveTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.requestTimeout = 0;
  httpServer.on('upgrade', handleUpgrade);
  return { path, methods: Object.keys(IMPLEMENTED), aliases: ALIASES };
}

// ── 仅在**直接运行本文件**时自起服务（保留独立调试能力）──
const isMain = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch { return false; }
})();

if (isMain) {
  const standalone = createServer((req, res) => {
    const reqPath = String(req.url || '').split('?')[0];
    if (reqPath !== '/') { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      what: '念初 WebSocket 宿主（独立调试模式）',
      note: '产品运行时这个能力挂在 tools/workbench/serve.mjs 的同一端口上，不需要单独启动',
      ws: 'ws://127.0.0.1:' + PORT + PATH,
      implemented: Object.keys(IMPLEMENTED),
      aliases: ALIASES,
      demandSoFar: demand.size,
      demand: [...demand.entries()]
        .map(([name, v]) => ({ name, count: v.count, implemented: name in IMPLEMENTED || name in ALIASES }))
        .sort((a, b) => b.count - a.count),
    }, null, 2));
  });

  attachWebSocketHost(standalone);

  const HOST = process.env.WS_HOST || undefined;
  // 启动清一次旧变更集（只保留最近 N 个/天数）
  try { const pr = maybeAutoPrune({ force: true }); if (pr.removed > 0) console.log('  已清理旧变更集 ' + pr.removed + ' 个，保留 ' + pr.kept + ' 个'); } catch { /* ignore */ }

  standalone.listen(PORT, HOST, () => {
    console.log('');
    console.log('  念初 WebSocket 宿主（独立调试模式）· 监听 ' + (HOST || '(双栈)') + ':' + PORT + PATH);
    console.log('  注意：产品运行时不需要单独启动这个进程 ——');
    console.log('        node tools/workbench/serve.mjs 会在 47124 同端口提供 WS。');
    console.log('  已实现方法: ' + Object.keys(IMPLEMENTED).length + ' 个');
    console.log('');
  });

  process.on('SIGINT', () => { dumpDemand('SIGINT'); process.exit(0); });
  process.on('SIGTERM', () => { dumpDemand('SIGTERM'); process.exit(0); });
}
