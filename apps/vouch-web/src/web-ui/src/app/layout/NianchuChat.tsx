import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { api } from '@/infrastructure/api';
import { MarkdownRenderer } from '@/infrastructure/markdown/MarkdownRenderer';
import RemotePanels from './RemotePanels';
import { buildRunStatusView, type RunStatusInput } from './runStatusView';
import { diagnoseError } from './errorDiagnosis';
import { activeTurnFromOffsets, clampTurnIndex } from './turnNav';
import { historyMessageId } from './messageIds';
import {
  HISTORY_PAGE_SIZE,
  hasMoreHistory,
  historyCountLabel,
  nextHistoryLimit,
  visibleHistoryCount,
} from './historyPaging';
import {
  movePinned,
  movePinnedToIndex,
  orderSessionsWithPinned,
  readPinned,
  togglePinned,
  writePinned,
} from './pinnedSessions';
import { shouldFoldReply } from './replyFold';
import { SESSION_DAY_LABEL, needsDayHeader, sessionDayKey } from './sessionDayGroup';
import { sessionDisplayName } from './sessionTitle';
import { stepArgText, type ToolStep } from './stepText';
import { activeResultMsgIndex, extractSnippets } from './searchSnippets';
import { ToolSteps } from './ToolSteps';
import {
  type CueSettings,
  notifyCompletion,
  playCompletionCue,
  readCueSettings,
  requestNotifyPermission,
  shouldCueTurn,
  writeCueSettings,
} from './completionCues';
import {
  type NccTheme,
  NCC_THEME_OPTIONS,
  NCC_THEME_TIP,
  readNccTheme,
  writeNccTheme,
} from './panelTheme';
import { isRadioNavKey, nextRadioIndex } from './rovingRadio';
import {
  MODE_LABELS,
  MODE_ORDER,
  MODE_PLACEHOLDERS,
  modeUsesTools,
  normalizeWorkMode,
  pickKnownModes,
  toolsHint,
  toolsTitle,
  type WorkModeId,
  type WorkModeInfo,
} from './workModes';
import {
  buildContextUsageView,
  CTX_CELLS,
  formatDropped,
  formatPercent,
  formatTokens,
  resolveContextUsage,
  resolveMemoryView,
} from './contextUsageView';
import './NianchuChat.scss';
import './density.scss';

/**
 * 念初 · 主 agent 对话面板（真实可用）
 *
 * ══ 为什么单独写这个组件，而不是用壳层自带的 ChatPane ══════════
 * 2026-11-18 一路排查下来，ChatPane 在这个自有宿主上跑不起来，原因是层层前置依赖：
 *   ① 它要求 flowChatStore.sessions 里有 session 记录；
 *   ② 会话来不了 store，因为 workspaceManager 初始化依赖 Tauri 事件通道
 *      （浏览器里 `transformCallback` 未定义，实测报错）；
 *   ③ 常驻控制会话 ensureControlConversation 只在 Tauri 下支持。
 * 这三条都是「桌面端专属能力」，在 web 宿主上不成立。
 *
 * 而**真正要紧的东西**——会话、对话、落盘——我自己已经实现并验证过了：
 *   tools/agent/runtime.mjs        （宿主侧，真调模型网关）
 *   tools/agent/verify-agent-channel.mjs 12/12
 *   tools/agent/verify-alias.mjs          9/9
 * 所以这里直接走那条通道，绕开所有桌面端专属依赖。
 *
 * ══ 它不是假界面 ═════════════════════════════════════════════
 * 每条回复都来自 agent/submitDialogTurn 的真实返回：
 *   · state 透传宿主四态（PASS/WARN/FAIL/UNKNOWN）
 *   · usage 是模型网关回的真数字
 *   · 失败时把 reason 显示出来，**不伪造回复**
 */
type Msg = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  state?: string;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  /**
   * 这一轮**真实装配**出来的上下文用量（宿主 submitTurn 给的，不是界面估算）。
   * 落盘在会话里，所以重载/切会话后仍能显示 —— 否则一刷新就看不到上下文压力。
   */
  context?: {
    historyTokens?: number; historyBudget?: number; historyDropped?: number;
    /** 本轮记忆命中条数 + 明细（宿主装配时落盘，见 tools/agent/runtime.mjs） */
    memoryHits?: number;
    memoryHitItems?: Array<{ key?: string; preview?: string }> | null;
  } | null;
  /**
   * 最近一次「动手」运行的状态：它在做什么 / 为什么停 / 花了多久 / 怎么复盘 / 花了多少。
   * 只在动手模式跑过 run_task 的消息上出现；历史里没有（run_task 结果不落盘）。
   */
  run?: RunStatusInput | null;
  /** 「动手」模式下真实执行过的工具步骤（来自 run_task 的 transcript） */
  steps?: ToolStep[];
  /** 本次动手产生的文件变更（run_task 的 changeSet：路径/状态/±行数/逐行 diff） */
  changeSet?: ChangeSet;
  /** 变更集 id：用于「撤销这次变更」 */
  changeSetId?: string;
  /** 是否已撤销（撤销成功后置 true） */
  rolledBack?: boolean;
  /** 批次 W：这条提问引用的工作区文件（内容只进本轮上下文，历史只留路径） */
  files?: string[];
  /** 计划图层：本轮 agent 用 todo_write 提交的清单（整表替换，取最后一次成功） */
  plan?: TodoItem[];
};

/** 计划项：status 只有三种，和宿主 todo_write 的校验一致 */
type TodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

type ChangeSet = {
  files?: DiffFile[];
  added?: number;
  removed?: number;
};

type DiffFile = {
  path?: string;
  status?: string;
  added?: number;
  removed?: number;
  lines?: Array<{ type?: string; text?: string }>;
};

type SessionRow = {
  sessionId: string;
  sessionName?: string;
  messageCount?: number;
  updatedAt?: string;
};

/** 技能清单的一行（宿主 get_skill_configs 的形状，只取前端要用的两个字段） */
type SkillRow = { name: string; description: string };

/**
 * 技能分类：把 186 个技能名按**语义前缀**归到少数几组，`/` 面板里分组显示。
 *
 * 为什么要分类：186 项平铺时用户只能靠「记得名字」去搜，等于没有目录。
 * 这里用名字里的稳定词根归类（不猜语义、不调模型），找不到就落「其他」——
 * **宁可少归也不要归错**：归错会让用户在一个不相干的组里翻。
 */
const SKILL_CATEGORIES: Array<[string, RegExp]> = [
  ['接口与协议', /^(api|graphql|grpc|http|webhook|websocket|ws-jsonrpc|event-driven|pagination|id-generation|idempotency)/],
  ['数据与存储', /^(data|sql|schema|etl|warehouse|feature-store|read-write|consistency|caching|distributed-cache|inventory|batch)/],
  ['可用性与容错', /(retry|backpressure|circuit-breaker|bulkhead|degradation|chaos|disaster|graceful|health-check|slo|incident|on-call|postmortem|rollback|recovery)/],
  ['交付与发布', /^(ci|deploy|release|feature-flag|iac|hot-update|dep-upgrade|dependency|changelog|changeset|preflight|postdeploy|one-command)/],
  ['安全与合规', /(security|secrets|compliance|threat|guardrails|input-validation|path-traversal|auth|tenancy|audit-log|code-owner)/],
  ['测试与质量', /(test|fuzz|mutation|contract|evaluation|experiment|false-green|false-red|verify|self-review|code-review|design-review|i18n-review|sql-review|size-guard|silent-catch|doc-number|doc-consistency)/],
  ['可观测与性能', /(observ|metric|log|trace|run-tracing|status|perf|load|capacity|memory|density|web-performance)/],
  ['架构与设计', /(arch|domain-model|design|plugin|rule-engine|scheduler|workflow|service-mesh|monorepo|twelve-factor|model-routing|multi-tenancy|multi-agent|orchestration|team|subagent)/],
  ['记忆与上下文', /^(memory|context|session|checkpoint|agent-memory|prompt|rag|search-design|web-crawling)/],
  ['文档与知识', /^(doc|readme|release-notes|decision-log|adr|task-breakdown|source-dive|tech-selection|technical-debt)/],
  ['技能与代理', /^(skill|agent-|mcp|handoff|support-assign)/],
  ['前端与体验', /(accessibility|web-performance|streaming|notification|file-upload|timezone|error-|pagination)/],
];

function skillCategory(name: string): string {
  const n = name.toLowerCase();
  for (const [cat, re] of SKILL_CATEGORIES) if (re.test(n)) return cat;
  return '其他';
}

const SYSTEM_PROMPT = [
  '你是念初，一个运行在自有工作台上的主 agent。',
  '回答要直接、具体，不要空话套话。',
  '不确定的事就说不确定，不要编造。',
].join('\n');

/** `@` 面板里不依赖工作区文件的两项固定上下文（批次 W） */
const AT_CONTEXT = [
  { label: '@当前会话', insert: '@当前会话 ', desc: '把当前会话的上下文带上', cat: '上下文' },
  { label: '@相关记忆', insert: '@记忆 ', desc: '召回跨会话的长期记忆', cat: '上下文' },
];

/** 变更文件路径：只留最后 3 段，避免一长串绝对路径把卡片撑爆（完整路径在 title） */
function shortPath(p?: string): string {
  const s = String(p || '').replace(/\\/g, '/');
  const parts = s.split('/').filter(Boolean);
  return parts.length <= 3 ? s : '…/' + parts.slice(-3).join('/');
}

/** 空态起手胶囊（对标 WorkBuddy 能力胶囊 / Cursor 建议行）：点击填入输入框 */
const STARTER_CHIPS = ['解释这段代码', '写一份内容方案', '分析一组数据', '帮我排查这个报错'];

/** 历史会话的相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / M-D */
function relTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  if (d < 0) return '刚刚';
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前';
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前';
  if (d < 172_800_000) return '昨天';
  const dt = new Date(t);
  return dt.getMonth() + 1 + '-' + dt.getDate();
}

/* ── 面板主题（批次 Z.17）──
   档位枚举 / 归一化 / 持久化在 `panelTheme.ts`（含单测），这里只负责渲染与交互：
   `system` 跟随应用；其余四套只改本面板的 `--ncc-*` 令牌（scss 里定义），
   不影响应用其他区域。 */

export default function NianchuChat({ onClose }: { onClose?: () => void }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [boot, setBoot] = useState<string>('正在连接宿主…');
  const [err, setErr] = useState<string | null>(null);
  // 【2026-11-21 用户要求】主 agent 只保留**单一对话**，不再分「对话/协同/动手」。
  // 顶部只留「新对话」：清空当前、下一条消息自动开一段新会话（会话由 send() 惰性创建）。
  const listRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // 当前这一轮的 runToken：停止生成时按它中断宿主的在途请求
  const runTokenRef = useRef<string | null>(null);

  // ── P0 输入增强（对标 Cursor / WorkBuddy）：`@` 添加上下文、`/` 调用技能指令、空态起手胶囊 ──
  const [skills, setSkills] = useState<SkillRow[]>([
    { name: '写作', description: '' }, { name: '分析', description: '' },
    { name: '编码', description: '' }, { name: '调研', description: '' },
  ]);
  const [sug, setSug] = useState<{
    kind: 'slash' | 'at';
    items: Array<{ label: string; insert: string; desc?: string; cat?: string; path?: string }>;
    start: number;
    query: string;
    total: number;
  } | null>(null);
  const [sugIdx, setSugIdx] = useState(0);
  /**
   * 批次 W：`@` 引用的工作区文件（真实路径列表 + 已挂上的附件）。
   * 列表按需拉一次（list_workspace_files），之后本地过滤——每次输入都打宿主太浪费。
   */
  const [files, setFiles] = useState<string[]>([]);
  const [wsFiles, setWsFiles] = useState<string[] | null>(null);
  // 复制回执：点「复制」后短暂显示「已复制」，避免用户不确定有没有复制上
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // ── 会话历史（对标 Qoder / WorkBuddy 侧栏）：真实 list_sessions + 搜索 + 切换 ──
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 完成提示（声音/桌面通知）开关：纯本地偏好，默认关。 */
  const [cuePrefs, setCuePrefs] = useState<CueSettings>(() => readCueSettings());
  const [cueOpen, setCueOpen] = useState(false);
  /** 面板主题（批次 Z.17）：持久化到 localStorage，data-ncc-theme 驱动 scss 令牌。 */
  const [theme, setTheme] = useState<NccTheme>(() => readNccTheme());
  const [themeOpen, setThemeOpen] = useState(false);
  const setThemePersisted = useCallback((next: NccTheme) => {
    // writeNccTheme 内部归一化 + 吞掉隐私模式的写失败：内存态始终生效
    setTheme(writeNccTheme(next));
  }, []);
  /** 弹层焦点管理（批次 Z.18）：按钮 ↔ 弹层之间可键盘往返。 */
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const themePopupRef = useRef<HTMLDivElement | null>(null);
  const cueBtnRef = useRef<HTMLButtonElement | null>(null);
  const cuePopupRef = useRef<HTMLDivElement | null>(null);

  /**
   * 点弹层外面就关（捕获阶段监听 pointerdown）：
   * 之前只能再点一次同一个按钮才关，用户点到别处弹层还挂着，像「没关掉」。
   * 用 pointerdown 而不是 click：拖选文字/长按不应该被当成「点了别处」。
   *
   * 同时接管 Esc：只靠弹层自己的 onKeyDown 有个洞——鼠标点开弹层时焦点可能还在
   * 触发按钮上（事件根本不进弹层），于是「按 Esc 没反应」。挂在 document 捕获阶段
   * 就没有这个前提：只要弹层开着，Esc 一律关掉并把焦点还给触发按钮。
   */
  useEffect(() => {
    if (!themeOpen && !cueOpen) return;
    const onDown = (e: globalThis.PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (themeOpen && !themePopupRef.current?.contains(target) && !themeBtnRef.current?.contains(target)) {
        setThemeOpen(false);
      }
      if (cueOpen && !cuePopupRef.current?.contains(target) && !cueBtnRef.current?.contains(target)) {
        setCueOpen(false);
      }
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (themeOpen) {
        e.preventDefault();
        setThemeOpen(false);
        themeBtnRef.current?.focus();
      } else if (cueOpen) {
        e.preventDefault();
        setCueOpen(false);
        cueBtnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [themeOpen, cueOpen]);

  /** 打开主题弹层时把焦点放到当前档位（键盘用户不用先 Tab 一轮）。 */
  useEffect(() => {
    if (!themeOpen) return;
    const el = themePopupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    el?.focus();
  }, [themeOpen]);

  /** 打开完成提示弹层时把焦点放到第一个开关（否则 Esc 只对鼠标用户有效）。 */
  useEffect(() => {
    if (!cueOpen) return;
    const el = cuePopupRef.current?.querySelector<HTMLElement>('[role="switch"]');
    el?.focus();
  }, [cueOpen]);
  /** 同一条 live 回复只响一次（轮询/重渲染不重复响）。 */
  const cuedTurnRef = useRef<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const histRef = useRef<HTMLDivElement | null>(null);
  // 会话管理：重命名（内联输入）/ 删除（二次确认）
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // 「对话」= 纯模型问答；「动手」= run_task（真读写文件/执行命令），工具步骤会渲染成卡片
  /**
   * 工作方式（批次 Z.28）：对话 / 只读 / 计划 / 动手 —— 对标 WorkBuddy 的 interactionmode。
   * 模式 = **显式工具白名单**：真实清单由宿主 `list_modes` 给（这里不抄一份），
   * 界面上要能看见「这个模式到底能用什么」。持久化按本机习惯记忆，脏值一律 normalize 回「对话」。
   */
  const [mode, setMode] = useState<WorkModeId>(() => {
    try { return normalizeWorkMode(window.localStorage.getItem('nianchu.workMode.v1')); } catch { return 'chat'; }
  });
  const [workModes, setWorkModes] = useState<WorkModeInfo[]>([]);
  const modeInfo = workModes.find((m) => m.id === mode) ?? null;

  const changeMode = useCallback((next: WorkModeId) => {
    setMode(next);
    try { window.localStorage.setItem('nianchu.workMode.v1', next); } catch { /* 存不了就只在本轮生效 */ }
    setErr(null);
  }, []);

  /** 模式清单：拉不到就只显示按钮，提示区如实写「工具清单不可用」，不编数字 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await api.invoke<WorkModeInfo[]>('list_modes');
        if (alive) setWorkModes(pickKnownModes(list));
      } catch { /* 宿主没这个方法时保持空表 */ }
    })();
    return () => { alive = false; };
  }, []);
  // 图片附件（data URL）：粘贴/拖拽/选择文件；只在对话模式可用（动手模式的工具读不了 data URL）
  const [images, setImages] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.invoke<Array<{ name?: string; key?: string; description?: string }>>('get_skill_configs');
        const rows = (Array.isArray(list) ? list : [])
          .map((s) => ({
            name: String(s.name || s.key || '').replace(/^scene:/, '').trim(),
            description: String(s.description || '').replace(/\s+/g, ' ').trim(),
          }))
          .filter((s) => s.name);
        // 按分类+名字排好再存：面板里分组显示时组是连续的，键盘上下也不跳组
        if (rows.length) {
          rows.sort((a, b) => {
            const ca = skillCategory(a.name), cb = skillCategory(b.name);
            return ca === cb ? a.name.localeCompare(b.name) : ca.localeCompare(cb);
          });
          setSkills(rows);
        }
      } catch { /* 宿主没有技能清单就保持默认 */ }
    })();
  }, []);

  /** 拉真实会话列表（宿主 list_sessions）；失败保持旧列表，不假装成功 */
  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.invoke<SessionRow[]>('list_sessions', {});
      setSessions(Array.isArray(list) ? list : []);
    } catch { /* 宿主不可用时保持现状，错误由调用方提示 */ }
  }, []);

  /** 把 get_session 的历史映射成界面消息（带 model/usage，历史也能显示模型与用量） */
  const loadSessionMessages = useCallback(async (id: string) => {
    const back = await api.invoke<{ messages?: Array<Record<string, unknown>> }>('get_session', { sessionId: id });
    /**
     * 消息 id 必须**带会话前缀**（批次 Z.21）：之前是 `'h' + i`，纯位置型。
     * 而「展开全文」状态是 `Set<id>`，切会话时不清 → A 会话展开过第 3 条，
     * 切到 B 会话，B 的第 3 条会莫名其妙是展开的。前缀只保留安全字符，
     * 因为它要进 `[data-mid="…"]` 选择器（引号/反斜杠会把选择器打断）。
     */
    return ((back?.messages) || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m, i) => ({
        id: historyMessageId(id, i),
        role: m.role as 'user' | 'assistant',
        content: String(m.content ?? ''),
        state: 'PASS',
        model: typeof m.model === 'string' ? m.model : undefined,
        usage: (m.usage && typeof m.usage === 'object')
          ? m.usage as { prompt_tokens?: number; completion_tokens?: number }
          : null,
        // 上下文用量与记忆命中都是落盘的（runtime.mjs 的 appendMessage 写了 context），历史也能显示
        context: (m.context && typeof m.context === 'object')
          ? m.context as {
            historyTokens?: number; historyBudget?: number; historyDropped?: number;
            memoryHits?: number; memoryHitItems?: Array<{ key?: string; preview?: string }> | null;
          }
          : null,
      }));
  }, []);

  /** 初始化：拿一个能用的会话 */
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        // 宿主侧的自检方法，确认通道活着
        await api.invoke('list_sessions', {});
        const sessions = await api.invoke<SessionRow[]>('list_sessions', {});
        if (dead) return;
        if (Array.isArray(sessions) && sessions.length > 0) {
          const s = sessions[0];
          setSessions(sessions);
          setSessionId(s.sessionId);
          const hist = await loadSessionMessages(s.sessionId);
          if (dead) return;
          setMsgs(hist);
          setBoot('');
          return;
        }
        // 没有会话 → 建一个
        const ws = await api.invoke<{ id: string }>('create_assistant_workspace', {});
        const made = await api.invoke<{ sessionId: string }>('create_session', {
          request: { sessionName: '念初', workspaceId: ws?.id },
        });
        if (dead) return;
        if (made?.sessionId) {
          setSessionId(made.sessionId);
          setBoot('');
          await refreshSessions();
        } else {
          setBoot('');
          setErr('宿主没有返回 sessionId');
        }
      } catch (e) {
        if (dead) return;
        setBoot('');
        setErr('连接宿主失败：' + String(e instanceof Error ? e.message : e).slice(0, 200));
      }
    })();
    return () => { dead = true; };
  }, [loadSessionMessages, refreshSessions]);

  /** 历史浮层：点击外部或 Esc 关闭（用 closest 排除开关按钮，避免点开关又立刻被关掉） */
  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('[data-history-toggle]')) return;
      if (histRef.current && t && !histRef.current.contains(t)) setHistoryOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setHistoryOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [historyOpen]);

  /** 切换到某段历史会话：真读 get_session，失败如实提示 */
  const openSession = useCallback(async (id: string) => {
    setHistoryOpen(false);
    if (id === sessionId) return;
    setHistoryBusy(true);
    setBoot('正在载入会话…');
    setErr(null);
    setMsgs([]);
    /**
     * 换会话时把**只属于上一段对话的视图状态**清掉（批次 Z.21）：
     * 「展开全文」是按消息 id 记的，搜索是按下标记的 —— 不清就会串到新会话上。
     */
    setExpandedReplies(new Set());
    setSearchQuery('');
    setSearchIdx(0);
    try {
      const hist = await loadSessionMessages(id);
      setSessionId(id);
      setMsgs(hist);
    } catch (e) {
      setErr('载入会话失败：' + String(e instanceof Error ? e.message : e).slice(0, 160));
    } finally {
      setBoot('');
      setHistoryBusy(false);
    }
  }, [loadSessionMessages, sessionId]);

  // 是否贴着底部：贴底才自动跟随新消息；用户往上翻时不抢滚动位置
  const [atBottom, setAtBottom] = useState(true);
  // 会话内搜索（Ctrl+F / 头部放大镜）：只做「命中定位 + 计数」，不改写 Markdown DOM
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIdx, setSearchIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  /**
   * 提问跳转（对标 Claude Code / dsh-claude-style 的 turn-nav）：
   * 长对话里「上一条 / 下一条用户提问」一键跳。纯前端滚动，不改任何消息 DOM。
   * activeTurn 由下方向上的滚动监听**按当前位置推导**（见 Z.20 的 derive 效果），
   * 所以手动翻到中间时，计数与「上一条」都从你正在看的那一条算起。
   */
  /**
   * 长回复折叠：助手消息超过阈值（字符或行数）默认折起，点「展开全文」看全。
   * 只折**已结束生成**的消息（m.state !== 'RUNNING'），流式中途折叠会把正在长出来的内容藏起来。
   */
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(() => new Set());
  const toggleReply = useCallback((id: string) => {
    setExpandedReplies((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [activeTurn, setActiveTurn] = useState(0);
  const userTurnIds = msgs.filter((m) => m.role === 'user').map((m) => m.id);
  const userTurnIdsRef = useRef<string[]>(userTurnIds);
  userTurnIdsRef.current = userTurnIds;
  /** 程序化跳转的抑制窗口（毫秒时间戳）：期间不按滚动位置反推，避免计数闪烁。 */
  const turnJumpUntilRef = useRef(0);

  // 提问数量变化（含历史加载完成）→ 跟到最新一条，避免计数器停在 0
  useEffect(() => {
    const total = userTurnIdsRef.current.length;
    if (total > 0) setActiveTurn(total - 1);
  }, [userTurnIds.length]);

  const jumpTurn = useCallback((dir: number) => {
    const body = listRef.current;
    const ids = userTurnIdsRef.current;
    if (!body || ids.length === 0) return;
    const next = clampTurnIndex(activeTurn, dir, ids.length);
    setActiveTurn(next);
    // 程序化跳转期间先别按滚动位置反推：平滑滚动会经过中间若干条，计数会闪。
    turnJumpUntilRef.current = performance.now() + 700;
    const el = body.querySelector('[data-mid="' + ids[next] + '"]') as HTMLElement | null;
    if (!el) return;
    /**
     * 不用 scrollIntoView：它有时会去滚外层文档而不是这个内部滚动容器（实测 scrollTop 不动）。
     * 直接按「目标相对滚动容器顶部的偏移」算绝对 scrollTop，稳。
     */
    const offset = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 8;
    body.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
  }, [activeTurn]);

  /**
   * 用**当前滚动位置**反推「在第几条提问」（批次 Z.20）。
   *
   * 批次 Z.9 的注释写着「activeTurn 由滚动位置推导」，但代码里从来没有这条链路：
   * `activeTurnFromOffsets()` 写了却没人调，用户手动翻到中间时计数器仍停在最后一条，
   * 按「上一条」会从末尾往回跳 —— 行为与注释相反。本批把线接上：
   * 滚动（rAF 合并）→ 取每条提问在内容坐标系里的偏移 → 纯函数算当前条 → setActiveTurn。
   */
  useEffect(() => {
    const body = listRef.current;
    if (!body) return;
    let raf = 0;
    const derive = () => {
      raf = 0;
      if (performance.now() < turnJumpUntilRef.current) return;
      const ids = userTurnIdsRef.current;
      if (ids.length < 2) return;
      const bodyTop = body.getBoundingClientRect().top;
      const scrollTop = body.scrollTop;
      // 到底了就直接算最后一条：末条提问通常滚不到顶部（后面还有回答），只按偏移会少一条
      const atBottom = body.scrollHeight - scrollTop - body.clientHeight < 24;
      const offsets: number[] = [];
      for (const id of ids) {
        const el = body.querySelector('[data-mid="' + id + '"]') as HTMLElement | null;
        if (!el) continue;
        offsets.push(el.getBoundingClientRect().top - bodyTop + scrollTop);
      }
      if (offsets.length === 0) return;
      setActiveTurn(activeTurnFromOffsets(offsets, scrollTop, 24, atBottom));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(derive);
    };
    body.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      body.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      setAtBottom(gap < 80);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [msgs, busy, atBottom]);

  // 命中：正文或工具参数里包含查询词（大小写不敏感）
  const searchMatches = (() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    msgs.forEach((m, i) => {
      const hay = [m.content, ...(m.steps || []).map((s) => (s.tool || '') + ' ' + stepArgText(s.input))]
        .join('\n').toLowerCase();
      if (hay.includes(q)) out.push(i);
    });
    return out;
  })();
  const activeMatch = searchMatches.length
    ? searchMatches[Math.min(searchIdx, searchMatches.length - 1)]
    : -1;

  // 跳转到命中消息（只滚动容器，不改写 Markdown DOM）
  useEffect(() => {
    if (!searchOpen || activeMatch < 0) return;
    const id = msgs[activeMatch]?.id;
    if (!id) return;
    const el = listRef.current?.querySelector('[data-mid="' + id + '"]');
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [searchOpen, activeMatch, msgs]);

  // 说明：不劫持全局 Ctrl+F（本机实测合成键事件到不了 React 的根处理器，且浏览器/应用
  // 快捷键层会先吃掉），搜索入口只保留头部的放大镜按钮；输入框内 Enter/Shift+Enter 跳转，
  // Esc 关闭 —— 这些都能被 CDP 真实派发验证。

  /**
   * 输入框随内容自动长高（ChatGPT / Claude 的做法）。
   * 先归零再读 scrollHeight，否则删字时不会缩回去。
   */
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 168) + 'px';
  }, [input]);

  /**
   * 发一轮对话：user 消息已进 msgs，这里只负责拿回复。
   *
   * 拆出来是为了「重新生成」：它复用同一条 user 消息再要一次回复，
   * 不能重复插入 user 气泡（否则界面上会出现两条一样的问题）。
   */
  const requestReply = useCallback(async (text: string, imgs?: string[], fileRefs?: string[]) => {
    let sid = sessionId;
    setErr(null);
    setBusy(true);
    try {
      // 没有会话时先补建（首次点击发送也能用）
      if (!sid) {
        const ws = await api.invoke<{ id: string }>('create_assistant_workspace', {});
        const made = await api.invoke<{ sessionId: string }>('create_session', {
          request: { sessionName: text.slice(0, 20), workspaceId: ws?.id },
        });
        sid = made?.sessionId ?? null;
        if (sid) setSessionId(sid);
      }
      if (!sid) throw new Error('没有可用会话');

      // 先取一个 runToken：停止生成时按它精确中断这一轮在途请求
      const runToken = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      runTokenRef.current = runToken;

      const r = await api.invoke<{
        state: string; content?: string; model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        reason?: string;
        context?: {
          historyTokens?: number; historyBudget?: number; historyDropped?: number;
          memoryHits?: number;
          memoryHitItems?: Array<{ key?: string; preview?: string }> | null;
        };
      }>('start_dialog_turn', {
        request: {
          sessionId: sid,
          content: text,
          systemPrompt: SYSTEM_PROMPT,
          runToken,
          images: imgs && imgs.length ? imgs : undefined,
          files: fileRefs && fileRefs.length ? fileRefs : undefined,
        },
      });

      if (r && r.state === 'PASS' && r.content) {
        setMsgs((m) => [...m, {
          id: 'a' + Date.now(),
          role: 'assistant',
          content: r.content!,
          state: r.state,
          model: r.model,
          usage: r.usage ?? null,
          /**
           * 上下文用量跟着消息走：这样切会话 / 重载后「最近一轮」自然就是
           * 该会话最后一条助手消息上的数字，不需要额外维护一份状态去同步。
           */
          context: r.context
            ? {
              historyTokens: r.context.historyTokens,
              historyBudget: r.context.historyBudget,
              historyDropped: r.context.historyDropped,
              // 记忆命中明细一起带上，界面才能摊开「这一轮参考了哪几条」
              memoryHits: r.context.memoryHits,
              memoryHitItems: r.context.memoryHitItems,
            }
            : null,
        }]);
        // 会话名/条数/时间都变了，历史列表跟着刷新（否则切回去看到的是旧快照）
        void refreshSessions();
      } else if (r && r.state === 'INTERRUPTED') {
        // 用户主动停止：如实标「已停止」，不当成错误
        setMsgs((m) => [...m, {
          id: 'i' + Date.now(), role: 'system', content: '已停止生成', state: 'INTERRUPTED',
        }]);
      } else {
        // 失败如实显示，不伪造回复
        setMsgs((m) => [...m, {
          id: 'e' + Date.now(),
          role: 'system',
          content: '没有拿到回复（' + (r?.state ?? 'UNKNOWN') + '）：' + (r?.reason ?? '未知原因'),
          state: r?.state ?? 'UNKNOWN',
        }]);
      }
    } catch (e) {
      const why = String(e instanceof Error ? e.message : e);
      setErr(why.slice(0, 240));
      setMsgs((m) => [...m, {
        id: 'e' + Date.now(), role: 'system', content: '请求失败：' + why.slice(0, 200), state: 'FAIL',
      }]);
    } finally {
      runTokenRef.current = null;
      setBusy(false);
    }
  }, [sessionId, refreshSessions]);

  /** 停止生成：调宿主中断在途请求；宿主找不到就如实提示，不假装停了 */
  const stop = useCallback(async () => {
    const token = runTokenRef.current;
    if (!token) return;
    try {
      const r = await api.invoke<{ aborted: boolean }>('interrupt_dialog_turn', { request: { runToken: token } });
      if (!r?.aborted) setErr('停止请求没有匹配到在跑的请求（可能已经结束）');
    } catch (e) {
      setErr('停止失败：' + String(e instanceof Error ? e.message : e).slice(0, 160));
    }
  }, []);

  /**
   * 「动手 / 只读 / 计划」模式：走宿主 run_task（真读写文件 / 执行命令），
   * 返回的 transcript 里 kind==='tool' 的步骤渲染成工具卡片 —— 不是装饰，是真执行记录。
   * 批次 Z.28：模式原样传给宿主（宿主按 modes.mjs 取白名单，未知模式会 FAIL 并提示切换）。
   */
  const requestTask = useCallback(async (text: string, runMode: WorkModeId = 'do') => {
    let sid = sessionId;
    setErr(null);
    setBusy(true);
    try {
      if (!sid) {
        const ws = await api.invoke<{ id: string }>('create_assistant_workspace', {});
        const made = await api.invoke<{ sessionId: string }>('create_session', {
          request: { sessionName: text.slice(0, 20), workspaceId: ws?.id },
        });
        sid = made?.sessionId ?? null;
        if (sid) setSessionId(sid);
      }
      const runToken = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      runTokenRef.current = runToken;

      /**
       * 流式：宿主每执行一个工具就推一条 nianchu://agent-step（ws-host 的 notify 通道）。
       * 先订阅再发请求，避免漏掉开头几步；用 runToken 过滤别的运行。
       */
      const liveId = 'live-' + Date.now();
      setMsgs((m) => [...m, { id: liveId, role: 'assistant', content: '', state: 'RUNNING', steps: [] }]);
      const offStep = api.listen<{ runToken?: string; tool?: string; ok?: boolean; ms?: number; input?: unknown }>(
        'nianchu://agent-step',
        (p) => {
          if (!p || p.runToken !== runToken) return;
          setMsgs((m) => m.map((x) => (x.id === liveId
            ? { ...x, steps: [...(x.steps || []), { kind: 'tool', tool: p.tool, ok: p.ok, ms: p.ms, input: p.input }] }
            : x)));
        },
      );
      const offAnswer = api.listen<{ runToken?: string; content?: string }>(
        'nianchu://agent-answer',
        (p) => {
          if (!p || p.runToken !== runToken) return;
          setMsgs((m) => m.map((x) => (x.id === liveId ? { ...x, content: String(p.content || '') } : x)));
        },
      );
      /**
       * 计划图层：todo_write 每次成功提交都整表替换。
       * 单独走 agent-plan 而不是从 agent-step 的 input 里抠 —— input 是截断预览，
       * 计划项多了会被切掉，界面会显示一份缺项的计划。
       */
      const offPlan = api.listen<{ runToken?: string; todos?: TodoItem[] }>(
        'nianchu://agent-plan',
        (p) => {
          if (!p || p.runToken !== runToken || !Array.isArray(p.todos)) return;
          setMsgs((m) => m.map((x) => (x.id === liveId ? { ...x, plan: p.todos } : x)));
        },
      );

      let r: {
        state: string; finalText?: string; reason?: string;
        transcript?: ToolStep[];
        plan?: TodoItem[] | null;
        changeSet?: ChangeSet;
        changeSetId?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; calls?: number; input?: number; output?: number };
        /** 判定层给的「为什么停 / 耗时 / trace」，状态条直接用，不自己再判一次。 */
        stopReason?: string;
        stopLabel?: string;
        traceId?: string;
        elapsedMs?: number;
      };
      try {
        r = await api.invoke('run_task', { request: { task: text, maxSteps: 8, runToken, mode: runMode } });
      } finally {
        offStep();
        offAnswer();
        offPlan();
      }

      const steps = (Array.isArray(r?.transcript) ? r.transcript : []).filter((s) => s && s.kind === 'tool');
      if (r && (r.state === 'PASS' || r.finalText)) {
        setMsgs((m) => m.map((x) => (x.id === liveId
          ? {
            ...x,
            content: String(r.finalText || x.content || '（没有产出文字总结，见上方工具结果）'),
            state: r.state,
            usage: r.usage ?? null,
            steps: steps.length ? steps : x.steps,
            plan: Array.isArray(r.plan) ? r.plan : x.plan,
            changeSet: r.changeSet,
            changeSetId: r.changeSetId,
            // 状态条的五个值原样收下：后端没给就留 undefined，交给 buildRunStatusView 显示占位，
            // 绝不在前端编一个「正常完成」。
            run: {
              state: r.state,
              stopReason: r.stopReason,
              stopLabel: r.stopLabel,
              traceId: r.traceId,
              elapsedMs: r.elapsedMs,
              usage: r.usage
                ? { calls: r.usage.calls, input: r.usage.input, output: r.usage.output }
                : null,
            },
          }
          : x)));
        // 完成提示：RUNNING → PASS 这条边上只响一次（失败/中断不响）
        if (r.state === 'PASS' && shouldCueTurn('RUNNING', r.state) && cuedTurnRef.current !== liveId) {
          cuedTurnRef.current = liveId;
          const prefs = readCueSettings();
          if (prefs.sound) playCompletionCue();
          if (prefs.notify) notifyCompletion('念初', String(r.finalText || '').slice(0, 120));
        }
        void refreshSessions();
      } else {
        // 失败：撤掉流式占位，落一条如实的系统消息
        setMsgs((m) => m.filter((x) => x.id !== liveId));
        setMsgs((m) => [...m, {
          id: 'e' + Date.now(),
          role: 'system',
          content: '动手任务未完成（' + (r?.state ?? 'UNKNOWN') + '）：' + (r?.reason ?? '未知原因'),
          state: r?.state ?? 'UNKNOWN',
        }]);
      }
    } catch (e) {
      const why = String(e instanceof Error ? e.message : e);
      setErr(why.slice(0, 240));
      setMsgs((m) => [...m, {
        id: 'e' + Date.now(), role: 'system', content: '动手请求失败：' + why.slice(0, 200), state: 'FAIL',
      }]);
    } finally {
      runTokenRef.current = null;
      setBusy(false);
    }
  }, [sessionId, refreshSessions]);

  /** 收图片：类型/大小/数量都做限制，超了如实提示而不是静默丢弃 */
  const addImages = useCallback((files: FileList | File[]) => {
    if (mode !== 'chat') { setErr('这个模式没有图片附件（工具读不了 data URL），请切回「对话」'); return; }
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!list.length) { setErr('只支持图片文件（png / jpg / webp 等）'); return; }
    const tooBig = list.find((f) => f.size > 4 * 1024 * 1024);
    if (tooBig) { setErr('单张图片不能超过 4MB：' + tooBig.name); return; }
    const room = Math.max(0, 4 - images.length);
    const take = list.slice(0, room);
    if (!take.length) { setErr('最多 4 张图片'); return; }
    void Promise.all(take.map((f) => new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('读取失败'));
      fr.readAsDataURL(f);
    }))).then((urls) => setImages((cur) => [...cur, ...urls].slice(0, 4)))
      .catch((e) => setErr('读取图片失败：' + String(e instanceof Error ? e.message : e)));
  }, [images.length, mode]);

  const send = useCallback(async () => {
    const text = input.trim();
    const refs = files.slice();
    if ((!text && images.length === 0 && refs.length === 0) || busy) return;
    const imgs = images.slice();
    setInput('');
    setImages([]);
    setFiles([]);
    setMsgs((m) => [...m, {
      id: 'u' + Date.now(),
      role: 'user',
      // 只挂文件、没写字时，消息内容就是那串路径（不编一句假话出来）
      content: text || refs.join(' ') || '（图片）',
      files: refs.length ? refs : undefined,
    }]);
    if (modeUsesTools(mode)) await requestTask(text, mode);
    else await requestReply(text, imgs, refs);
  }, [input, busy, mode, images, files, requestTask, requestReply]);

  /** 复制一条消息（writeText 被拒时回退 execCommand，两者都失败才报错） */
  const copyMsg = useCallback(async (id: string, text: string) => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* 权限/非安全上下文：走下面的兜底 */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch { ok = false; }
    }
    if (!ok) { setErr('复制失败：浏览器拒绝了剪贴板访问'); return; }
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1200);
  }, []);

  /**
   * 重新生成：找到该助手消息前一条 user 消息，截断到它为止，再要一次回复。
   * 会话侧是真再调一次模型（不是把旧回复贴回来）。
   */
  const regenerate = useCallback(async (id: string) => {
    if (busy) return;
    const idx = msgs.findIndex((m) => m.id === id);
    if (idx <= 0) return;
    const prev = msgs[idx - 1];
    if (prev.role !== 'user') { setErr('这条回复前面没有用户消息，无法重新生成'); return; }
    setMsgs(msgs.slice(0, idx));
    await requestReply(prev.content);
  }, [busy, msgs, requestReply]);

  /**
   * 编辑重发：把该条 user 消息放回输入框，并截断它及其之后的对话。
   * 这样重发等于「从这句重新开始」，不会在历史里留下两条相同提问。
   */
  const editMsg = useCallback((id: string) => {
    if (busy) return;
    const idx = msgs.findIndex((m) => m.id === id);
    if (idx < 0) return;
    setInput(msgs[idx].content);
    setMsgs(msgs.slice(0, idx));
    requestAnimationFrame(() => {
      const t = taRef.current;
      if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
    });
  }, [busy, msgs]);

  /** 撤销这次动手产生的文件变更（宿主 rollback_change，按 changeSet 粒度） */
  const undoChange = useCallback(async (msgId: string, changeSetId: string) => {
    try {
      const r = await api.invoke<{
        state: string; reason?: string;
        files?: Array<{ path?: string; ok?: boolean; reason?: string }>;
      }>('rollback_change', { request: { changeSetId } });
      const failed = (r?.files || []).filter((f) => f.ok === false);
      if (r?.state === 'PASS' && failed.length === 0) {
        setMsgs((m) => m.map((x) => (x.id === msgId ? { ...x, rolledBack: true } : x)));
      } else {
        setErr('撤销未完全成功：' + (failed[0]?.reason || r?.reason || '未知原因'));
      }
    } catch (e) {
      setErr('撤销失败：' + String(e instanceof Error ? e.message : e).slice(0, 160));
    }
  }, []);

  /** 重命名：内联输入 → 宿主 rename_session（追加 meta，索引重建后仍生效） */
  const commitRename = useCallback(async () => {
    const id = renamingId;
    const name = renameText.trim();
    if (!id || !name) return;
    try {
      const r = await api.invoke<{ state: string; reason?: string }>('rename_session', {
        request: { sessionId: id, sessionName: name },
      });
      if (r?.state !== 'PASS') { setErr(r?.reason || '重命名失败'); return; }
      setRenamingId(null);
      await refreshSessions();
    } catch (e) {
      setErr('重命名失败：' + String(e instanceof Error ? e.message : e).slice(0, 160));
    }
  }, [renameText, renamingId, refreshSessions]);

  /** 删除：删的是会话 jsonl 真源，删当前会话时清空消息区 */
  const removeSession = useCallback(async (id: string) => {
    try {
      const r = await api.invoke<{ state: string; reason?: string }>('delete_session', { request: { sessionId: id } });
      if (r?.state !== 'PASS') { setErr(r?.reason || '删除失败'); return; }
      setConfirmDeleteId(null);
      if (id === sessionId) { setSessionId(null); setMsgs([]); }
      await refreshSessions();
    } catch (e) {
      setErr('删除失败：' + String(e instanceof Error ? e.message : e).slice(0, 160));
    }
  }, [refreshSessions, sessionId]);

  /** 导出当前会话为 Markdown（含工具步骤与文件变更摘要），走浏览器下载 */
  const exportMarkdown = useCallback(() => {
    if (!msgs.length) return;
    const name = sessions.find((s) => s.sessionId === sessionId)?.sessionName || '念初会话';
    const lines = ['# ' + name, '', '_导出于 ' + new Date().toLocaleString() + '_', ''];
    for (const m of msgs) {
      if (m.role === 'system') { lines.push('> ' + m.content, ''); continue; }
      lines.push(m.role === 'user' ? '## 用户' : '## 念初', '', m.content, '');
      if (m.plan?.length) {
        lines.push('### 计划', '');
        for (const t of m.plan) {
          lines.push('- [' + (t.status === 'completed' ? 'x' : ' ') + '] ' + t.content
            + (t.status === 'in_progress' ? ' _(进行中)_' : ''));
        }
        lines.push('');
      }
      if (m.steps?.length) {
        lines.push('### 工具调用', '');
        for (const s of m.steps) {
          const arg = stepArgText(s.input);
          lines.push('- `' + (s.tool || 'tool') + '` '
            + (s.ok === false ? '失败' : '成功')
            + (typeof s.ms === 'number' ? ' · ' + s.ms + 'ms' : '')
            + (arg ? ' · ' + arg : ''));
        }
        lines.push('');
      }
      if (m.changeSet?.files?.length) {
        lines.push('### 文件变更', '');
        for (const f of m.changeSet.files) {
          lines.push('- `' + shortPath(f.path) + '` +' + (f.added ?? 0) + ' −' + (f.removed ?? 0));
        }
        lines.push('');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    a.href = url;
    a.download = '念初会话-' + ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate())
      + '-' + pad(ts.getHours()) + pad(ts.getMinutes()) + '.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, [msgs, sessionId, sessions]);

  /**
   * 批次 W：`@` 面板要列**真实**工作区文件，所以挂载时先拉一批浅层文件（`@` 空查询用）。
   * 拉不到就置空数组（面板里只剩「当前会话 / 相关记忆」两项），不编造路径。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await api.invoke<{ files?: string[] }>('list_workspace_files', { request: { limit: 200 } });
        if (alive) setWsFiles(Array.isArray(r?.files) ? r!.files! : []);
      } catch {
        if (alive) setWsFiles([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  /**
   * 有查询词时**让宿主过滤**：仓库里一万多个文件，本地只缓存了前 200 个浅层路径，
   * 靠本地 `includes` 会漏（`tools/agent/workspace-files.mjs` 就搜不到）。
   * 序号自增防串台：用户接着敲字后，上一次的慢响应回来直接丢弃。
   */
  const fileSeqRef = useRef(0);
  const searchFiles = useCallback((query: string, start: number) => {
    const seq = ++fileSeqRef.current;
    window.setTimeout(() => {
      if (seq !== fileSeqRef.current) return;
      void (async () => {
        try {
          const r = await api.invoke<{ files?: string[]; total?: number }>(
            'list_workspace_files', { request: { query, limit: 40 } },
          );
          if (seq !== fileSeqRef.current) return;
          const hit = Array.isArray(r?.files) ? r!.files! : [];
          const ctx = AT_CONTEXT.filter((it) => it.label.toLowerCase().includes(query.toLowerCase())
            || it.desc.toLowerCase().includes(query.toLowerCase()));
          const items = [
            ...ctx,
            ...hit.map((p) => ({
              label: p,
              insert: p + ' ',
              path: p,
              desc: modeUsesTools(mode) ? '填入路径（这个模式念初会自己读）' : '引用这份文件的真实内容',
              cat: '工作区文件',
            })),
          ];
          if (!items.length) { setSug(null); return; }
          setSug({ kind: 'at', items: items.slice(0, 50), start, query, total: Math.max(items.length, Number(r?.total) || 0) });
          setSugIdx(0);
        } catch { /* 宿主不可达：面板保持原样，不伪造文件 */ }
      })();
    }, 140);
  }, [mode]);

  const onInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setInput(v);
    const caret = e.target.selectionStart ?? v.length;
    const upto = v.slice(0, caret);
    // `@` 的查询允许带 `/`（文件路径），`/` 指令的查询不带
    const m = /(^|[\s(])([/@])([\p{L}\p{N}_.\/-]*)$/u.exec(upto);
    if (m) {
      const kind = m[2] === '/' ? 'slash' : 'at';
      // 定位用原始查询（含可能的 `/` 前缀），匹配时再归一化 —— 否则 slice 的偏移会错位
      const query = m[3] || '';
      const start = caret - query.length - 1;
      if (kind === 'slash') {
        const q = query.toLowerCase();
        // 技能：名字和描述都参与匹配（描述里有「什么时候用」，比名字更好找）
        const matched = skills.map((s) => ({
          label: '/' + s.name,
          insert: '/' + s.name + ' ',
          desc: s.description,
          cat: skillCategory(s.name),
        })).filter((it) => q === ''
          || it.label.toLowerCase().includes(q)
          || String(it.desc || '').toLowerCase().includes(q));
        if (matched.length) { setSug({ kind, items: matched.slice(0, 50), start, query, total: matched.length }); setSugIdx(0); return; }
      } else if (!query) {
        // 空查询：上下文两项 + 挂载时缓存的浅层文件
        const items = [
          ...AT_CONTEXT,
          ...(wsFiles || []).map((p) => ({
            label: p,
            insert: p + ' ',
            path: p,
            desc: modeUsesTools(mode) ? '填入路径（这个模式念初会自己读）' : '引用这份文件的真实内容',
            cat: '工作区文件',
          })),
        ];
        setSug({ kind, items: items.slice(0, 50), start, query, total: items.length });
        setSugIdx(0);
        return;
      } else {
        // 有查询词：先给上下文项（即时反馈），再让宿主按词过滤文件
        const q = query.replace(/^\/+/, '').toLowerCase();
        const ctx = AT_CONTEXT.filter((it) => it.label.toLowerCase().includes(q) || it.desc.toLowerCase().includes(q));
        setSug({ kind, items: ctx, start, query, total: ctx.length });
        setSugIdx(0);
        searchFiles(query.replace(/^\/+/, ''), start);
        return;
      }
    }
    setSug(null);
  };
  const pickSug = (it?: { label: string; insert: string; path?: string }) => {
    if (!sug || !it) return;
    const end = sug.start + 1 + sug.query.length;
    // 工作区文件：对话模式挂成附件（真的把内容带进本轮）；工具模式只填路径
    if (it.path && !modeUsesTools(mode)) {
      setFiles((cur) => (cur.includes(it.path!) ? cur : [...cur, it.path!].slice(0, 8)));
      const rest = (input.slice(0, sug.start) + input.slice(end)).replace(/[ \t]{2,}/g, ' ');
      setInput(rest);
      setSug(null);
      requestAnimationFrame(() => taRef.current?.focus());
      return;
    }
    const next = input.slice(0, sug.start) + it.insert + input.slice(end);
    setInput(next);
    setSug(null);
    requestAnimationFrame(() => {
      const t = taRef.current;
      if (t) { t.focus(); const pos = sug.start + it.insert.length; t.setSelectionRange(pos, pos); }
    });
  };
  const onInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (sug) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSugIdx((i) => Math.min(i + 1, sug.items.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSugIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSug(null); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault(); pickSug(sug.items[Math.min(sugIdx, sug.items.length - 1)]); return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };

  // 历史浮层的搜索结果（按会话名过滤；空查询显示全部）
  const historyItems = sessions.filter((s) => {
    const q = historyQuery.trim().toLowerCase();
    return !q || String(s.sessionName || '').toLowerCase().includes(q);
  });
  // 会话可能几百条（本机实测 996）：首屏只渲染 60 条，点「加载更多」再逐页加（批次 Z.22）
  const HISTORY_LIMIT = HISTORY_PAGE_SIZE;
  /** 当前允许渲染多少条（点「加载更多」递增；换查询/重开浮层时回到一页）。 */
  const [historyLimit, setHistoryLimit] = useState<number>(HISTORY_PAGE_SIZE);
  /**
   * 置顶（批次 Z.23）：本机视图偏好，存 localStorage。
   * 宿主 list_sessions 没有置顶字段，所以**不假装跨设备同步**。
   */
  const [pinned, setPinned] = useState<string[]>(() => readPinned());
  const pinnedSet = new Set(pinned);
  const orderedHistory = orderSessionsWithPinned(historyItems, pinned);
  const historyVisibleItems = orderedHistory.rest.slice(0, visibleHistoryCount(historyLimit, orderedHistory.rest.length));
  const togglePin = useCallback((id: string) => {
    setPinned((cur) => writePinned(togglePinned(cur, id)));
  }, []);
  /**
   * 拖动中的置顶项 id（批次 Z.27：置顶区拖动排序）。
   * 用 ref 而不是只靠 state：drop 时读 state 会拿到上一帧的旧值。
   */
  const [draggingPin, setDraggingPin] = useState<string | null>(null);
  const draggingPinRef = useRef<string | null>(null);
  const movePinTo = useCallback((toId: string) => {
    const fromId = draggingPinRef.current;
    draggingPinRef.current = null;
    setDraggingPin(null);
    if (!fromId || fromId === toId) return;
    setPinned((cur) => {
      const next = writePinned(movePinned(cur, fromId, toId));
      return next;
    });
  }, []);
  /** 键盘 Alt+↑/↓：置顶项在列表里上/下移一位（拖动之外的可达路径）。 */
  const movePinBy = useCallback((id: string, delta: number) => {
    setPinned((cur) => {
      const idx = cur.indexOf(id);
      if (idx < 0) return cur;
      return writePinned(movePinnedToIndex(cur, id, idx + delta));
    });
  }, []);
  const historyName = (s: SessionRow) => sessionDisplayName(s.sessionName);

  // 会话累计用量（来自每条真实回复的 usage），用于 composer 脚注。
  const aggUsage = (() => {    let i = 0; let o = 0;
    for (const m of msgs) if (m.usage) { i += m.usage.prompt_tokens || 0; o += m.usage.completion_tokens || 0; }
    return (i || o) ? { i, o } : null;
  })();

  /**
   * 上下文用量：取**最近一条**带 context 的助手消息（即最近一轮真实装配结果）。
   * 没有就返回 null —— 不显示一个「0 / 6,000」的空进度条假装在监控。
   * 阈值与格子数在 contextUsageView.ts 里，由单测锁住。
   */
  const ctxView = buildContextUsageView(resolveContextUsage(msgs));
  const fmtTok = formatTokens;

  /**
   * 记忆命中：从同一批消息的 context 里取最近一轮的召回明细。
   * 没有可展示信息时返回 null，界面**不渲染**这块（不显示「命中 0 条」的假面板）。
   */
  const memView = resolveMemoryView(msgs);

  /**
   * 状态条取**最近一条带 run 的消息**（最新一次动手运行）。
   * 没有任何运行记录时传 null → 显示「状态：空闲」，而不是把整条藏起来：
   * 「看不到状态」和「状态是空闲」对用户是两件事。
   */
  const lastRun = (() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].run) return msgs[i].run as RunStatusInput;
    }
    return null;
  })();
  const runView = buildRunStatusView(lastRun);

  // 模型展示名：`group/auto-claude-sonnet-5-5` 这类技术 id 不直接摆给用户看。
  const modelLabel = (id: string) => {
    const s = id
      .replace(/^group\//, '')
      .replace(/^(auto|fast|smart)-/, '')
      .replace(/-(\d)-(\d)$/, '-$1.$2')
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => (w === 'gpt' ? 'GPT' : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ');
    return s || id;
  };

  /**
   * 历史会话的一行（批次 Z.23）：置顶区与普通区共用同一份渲染，
   * 避免两处各写一遍导致「置顶行少了删除按钮」这类不对称。
   *
   * 批次 Z.27：置顶区传 `draggable`，整行可拖，拖到另一行上插到它前面。
   * 只有置顶区能拖 —— 普通区是「最近消息顺序」，拖它没有语义。
   */
  const historyRowJsx = (s: SessionRow, opts?: { draggable?: boolean }) => (
    <div
      className="ncc__history-row"
      data-current={s.sessionId === sessionId ? '1' : '0'}
      data-pinned={pinnedSet.has(s.sessionId) ? '1' : '0'}
      data-dragging={draggingPin === s.sessionId ? '1' : '0'}
      draggable={opts?.draggable === true}
      onDragStart={opts?.draggable ? (e) => {
        // 只带 sessionId：跨浏览器/跨窗口拖拽时 dataTransfer 才是唯一可靠载体
        e.dataTransfer.setData('text/plain', s.sessionId);
        e.dataTransfer.effectAllowed = 'move';
        draggingPinRef.current = s.sessionId;
        setDraggingPin(s.sessionId);
      } : undefined}
      onDragEnd={opts?.draggable ? () => {
        draggingPinRef.current = null;
        setDraggingPin(null);
      } : undefined}
      onDragOver={opts?.draggable ? (e) => {
        // 不 preventDefault 就收不到 drop
        if (draggingPinRef.current && draggingPinRef.current !== s.sessionId) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      } : undefined}
      onDrop={opts?.draggable ? (e) => {
        e.preventDefault();
        movePinTo(s.sessionId);
      } : undefined}
    >
      {renamingId === s.sessionId ? (
        <div className="ncc__history-rename">
          <input
            className="ncc__history-input"
            value={renameText}
            autoFocus
            maxLength={60}
            aria-label="会话名称"
            onChange={(e) => setRenameText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
              if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
            }}
          />
          <button type="button" className="ncc__history-mini" onClick={() => void commitRename()}>保存</button>
          <button type="button" className="ncc__history-mini" onClick={() => setRenamingId(null)}>取消</button>
        </div>
      ) : (
        <>
          {opts?.draggable && (
            <span
              className="ncc__history-grip"
              data-testid="ncc-pinned-grip"
              title="拖动排序（也可 Alt+↑/↓ 移动）"
              aria-label="拖动排序"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (!e.altKey) return;
                if (e.key === 'ArrowUp') { e.preventDefault(); movePinBy(s.sessionId, -1); }
                if (e.key === 'ArrowDown') { e.preventDefault(); movePinBy(s.sessionId, 1); }
              }}
            >⋮⋮</span>
          )}
          <button
            type="button"
            className="ncc__history-item"
            onClick={() => void openSession(s.sessionId)}
          >
            <span className="ncc__history-name" title={historyName(s)}>
              {historyName(s)}
            </span>
            <span className="ncc__history-meta">
              {s.messageCount ?? 0} 条 · {relTime(s.updatedAt)}
            </span>
          </button>
          <span className="ncc__history-acts">
            {confirmDeleteId === s.sessionId ? (
              <>
                <button
                  type="button"
                  className="ncc__history-mini ncc__history-mini--danger"
                  onClick={() => void removeSession(s.sessionId)}
                >确认删除</button>
                <button type="button" className="ncc__history-mini" onClick={() => setConfirmDeleteId(null)}>取消</button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="ncc__history-mini"
                  data-testid="ncc-history-pin"
                  aria-pressed={pinnedSet.has(s.sessionId)}
                  title={pinnedSet.has(s.sessionId) ? '取消置顶' : '置顶这个会话'}
                  onClick={() => togglePin(s.sessionId)}
                >{pinnedSet.has(s.sessionId) ? '取消置顶' : '置顶'}</button>
                <button
                  type="button"
                  className="ncc__history-mini"
                  title="重命名这个会话"
                  onClick={() => { setRenamingId(s.sessionId); setRenameText(historyName(s)); setConfirmDeleteId(null); }}
                >重命名</button>
                <button
                  type="button"
                  className="ncc__history-mini"
                  title="删除这个会话"
                  onClick={() => { setConfirmDeleteId(s.sessionId); setRenamingId(null); }}
                >删除</button>
              </>
            )}
          </span>
        </>
      )}
    </div>
  );

  return (
    <div className="ncc" data-ncc-theme={theme}>
      <header className="ncc__head">
        <span className="ncc__avatar">念</span>
        <span className="ncc__name">念初</span>
        {/*
          2026-11-18 用户指出：「在线」完全没出现的必要。
          对照主流 agent（ChatGPT / Claude / Cursor）的头部：
          只有 标题 + 新建 + 关闭，不摆在线状态 —— 面板本身开着就代表在线，
          状态徽标属于冗余信息。
        */}
        <span className="ncc__spacer" />
        <button
          type="button"
          className="ncc__icon"
          title="在会话里搜索（Ctrl+F）"
          aria-label="在会话里搜索"
          onClick={() => {
            setSearchOpen((v) => !v);
            window.setTimeout(() => searchRef.current?.focus(), 30);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
        </button>
        <button
          type="button"
          className="ncc__icon"
          title="导出为 Markdown"
          aria-label="导出为 Markdown"
          disabled={msgs.length === 0}
          onClick={exportMarkdown}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
          </svg>
        </button>
        <button
          type="button"
          className="ncc__icon"
          data-history-toggle="1"
          title="历史会话"
          aria-label="历史会话"
          aria-expanded={historyOpen}
          onClick={() => {
            const next = !historyOpen;
            setHistoryOpen(next);
            if (next) { setHistoryQuery(''); setHistoryLimit(HISTORY_PAGE_SIZE); void refreshSessions(); }
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" />
          </svg>
        </button>
        <button
          type="button"
          className="ncc__icon"
          data-testid="ncc-cues-toggle"
          ref={cueBtnRef}
          title="完成提示（声音 / 桌面通知）"
          aria-label="完成提示"
          aria-expanded={cueOpen}
          aria-haspopup="dialog"
          onClick={() => setCueOpen((v) => !v)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
        </button>
        <button
          type="button"
          className="ncc__icon"
          data-testid="ncc-theme-toggle"
          ref={themeBtnRef}
          title="面板主题"
          aria-label="面板主题"
          aria-expanded={themeOpen}
          aria-haspopup="dialog"
          onClick={() => setThemeOpen((v) => !v)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" opacity=".18" />
          </svg>
        </button>
        <button
          type="button"
          className="ncc__icon"
          title="新对话（开始一段新会话）"
          aria-label="新对话"
          onClick={() => {
            setMsgs([]);
            setSessionId(null);
            setErr(null);
            setBoot('');
            setHistoryOpen(false);
            // 新对话同样要清掉上一段对话的视图状态（批次 Z.21，与 openSession 一致）
            setExpandedReplies(new Set());
            setSearchQuery('');
            setSearchIdx(0);
            setSearchOpen(false);
            void refreshSessions();
          }}
        >＋</button>
        {onClose && (
          <button type="button" className="ncc__icon" title="收起（可用右下角 Hi 唤回）" onClick={onClose}>×</button>
        )}
      </header>

      {cueOpen && (
        <div
          className="ncc__cues"
          role="dialog"
          aria-label="完成提示"
          ref={cuePopupRef}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            setCueOpen(false);
            cueBtnRef.current?.focus();
          }}
        >
          <div className="ncc__cues-title">完成提示</div>
          <button
            type="button"
            role="switch"
            aria-checked={cuePrefs.sound}
            className="ncc__cues-row"
            onClick={() => setCuePrefs(writeCueSettings({ sound: !cuePrefs.sound }))}
          >
            <span>提示音</span><span className="ncc__cues-state">{cuePrefs.sound ? '开' : '关'}</span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={cuePrefs.notify}
            className="ncc__cues-row"
            onClick={async () => {
              const next = !cuePrefs.notify;
              if (next) await requestNotifyPermission();
              setCuePrefs(writeCueSettings({ notify: next }));
            }}
          >
            <span>桌面通知（页面在后台时）</span><span className="ncc__cues-state">{cuePrefs.notify ? '开' : '关'}</span>
          </button>
          <button type="button" className="ncc__cues-try" onClick={() => { playCompletionCue(); }}>试听</button>
          <p className="ncc__cues-tip">只在回复正常完成时提示；失败/中断不响。</p>
        </div>
      )}

      {themeOpen && (
        <div
          className="ncc__theme"
          role="dialog"
          aria-label="面板主题"
          ref={themePopupRef}
          onKeyDown={(e) => {
            // Esc：关弹层并把焦点还给触发按钮（不把用户丢在没有落点的 DOM 里）
            if (e.key === 'Escape') {
              e.preventDefault();
              setThemeOpen(false);
              themeBtnRef.current?.focus();
              return;
            }
            // 方向键 / Home / End：按原生 radio 约定换选中并移动焦点
            if (!isRadioNavKey(e.key)) return;
            const current = NCC_THEME_OPTIONS.findIndex((o) => o.id === theme);
            const next = nextRadioIndex(current, NCC_THEME_OPTIONS.length, e.key);
            if (next === null) return;
            e.preventDefault();
            const opt = NCC_THEME_OPTIONS[next];
            setThemePersisted(opt.id);
            themePopupRef.current
              ?.querySelector<HTMLButtonElement>(`[data-theme-id="${opt.id}"]`)
              ?.focus();
          }}
        >
          <div className="ncc__cues-title">面板主题</div>
          <div className="ncc__theme-group" role="radiogroup" aria-label="面板主题档位">
            {NCC_THEME_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={theme === opt.id}
                data-testid={`ncc-theme-${opt.id}`}
                data-theme-id={opt.id}
                title={opt.hint}
                tabIndex={theme === opt.id ? 0 : -1}
                className="ncc__theme-row"
                onClick={() => {
                  setThemePersisted(opt.id);
                  setThemeOpen(false);
                  // 选完弹层就收起，焦点必须有着落，否则键盘用户会掉到 body 上
                  themeBtnRef.current?.focus();
                }}
              >
                <span className={`ncc__theme-swatch ncc__theme-swatch--${opt.id}`} aria-hidden="true" />
                <span>{opt.label}</span>
                {theme === opt.id && <span className="ncc__theme-check">✓</span>}
              </button>
            ))}
          </div>
          <p className="ncc__cues-tip">{NCC_THEME_TIP}</p>
        </div>
      )}

      {searchOpen && (
        <div className="ncc__searchbar" role="search">
          <input
            ref={searchRef}
            className="ncc__searchinput"
            value={searchQuery}
            placeholder="在会话里搜索…"
            spellCheck={false}
            aria-label="在会话里搜索"
            onChange={(e) => { setSearchQuery(e.target.value); setSearchIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); return; }
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!searchMatches.length) return;
                const step = e.shiftKey ? -1 : 1;
                setSearchIdx((i) => (i + step + searchMatches.length) % searchMatches.length);
              }
            }}
          />
          <span className="ncc__searchcount" aria-live="polite">
            {searchQuery.trim()
              ? (searchMatches.length
                ? (Math.min(searchIdx, searchMatches.length - 1) + 1) + ' / ' + searchMatches.length
                : '无匹配')
              : ''}
          </span>
          <button
            type="button"
            className="ncc__searchbtn"
            title="上一个（Shift+Enter）"
            aria-label="上一个"
            disabled={!searchMatches.length}
            onClick={() => setSearchIdx((i) => (i - 1 + searchMatches.length) % Math.max(1, searchMatches.length))}
          >↑</button>
          <button
            type="button"
            className="ncc__searchbtn"
            title="下一个（Enter）"
            aria-label="下一个"
            disabled={!searchMatches.length}
            onClick={() => setSearchIdx((i) => (i + 1) % Math.max(1, searchMatches.length))}
          >↓</button>
          <button
            type="button"
            className="ncc__searchbtn"
            title="关闭（Esc）"
            aria-label="关闭搜索"
            onClick={() => setSearchOpen(false)}
          >×</button>
          {/* 命中片段（批次 Z.15，坐标换算 Z.19）：逐条给上下文 + 高亮，点一条跳到那条消息 */}
          {searchQuery.trim() && (
            <div className="ncc__searchlist" role="listbox" aria-label="搜索命中">
              {/* 当前项 = searchIdx 在命中列表里的位置 → 换算成 msgs 下标（不能拿 activeMatch 直接比） */}
              {(() => {
                const activeMsg = activeResultMsgIndex(searchMatches, searchIdx);
                return extractSnippets(msgs, searchQuery, { limit: 6 }).map((sn) => (
                  <button
                    key={sn.msgIndex}
                    type="button"
                    role="option"
                    aria-selected={activeMsg === sn.msgIndex}
                    data-result-msg={sn.msgIndex}
                    data-result-active={activeMsg === sn.msgIndex ? '1' : '0'}
                    className="ncc__searchhit"
                    onClick={() => {
                      const at = searchMatches.indexOf(sn.msgIndex);
                      if (at >= 0) setSearchIdx(at);
                    }}
                  >
                    <span className="ncc__searchrole">{sn.role === 'user' ? '你' : '念初'}</span>
                    <span className="ncc__searchtext">{sn.before}<mark>{sn.match}</mark>{sn.after}</span>
                  </button>
                ));
              })()}
              {searchMatches.length === 0 && <div className="ncc__searchempty">没有命中</div>}
            </div>
          )}
        </div>
      )}

      {/*
        历史会话浮层（对标 Qoder / WorkBuddy 侧栏的会话列表）：
        数据全部来自宿主 list_sessions / get_session，不是本地假数据；
        点一条是真读该会话并替换消息区。
      */}
      {historyOpen && (
        <div className="ncc__history" ref={histRef} role="dialog" aria-label="历史会话">
          <div className="ncc__history-head">
            <span>会话历史</span>
            <span className="ncc__history-count" title="会话总数">{sessions.length}</span>
            <button
              type="button"
              className="ncc__history-close"
              title="关闭"
              aria-label="关闭历史会话"
              onClick={() => setHistoryOpen(false)}
            >×</button>
          </div>
          <input
            className="ncc__history-search"
            value={historyQuery}
            onChange={(e) => { setHistoryQuery(e.target.value); setHistoryLimit(HISTORY_PAGE_SIZE); }}
            placeholder="搜索会话名…"
            spellCheck={false}
            aria-label="搜索会话"
          />
          <div className="ncc__history-list">
            {historyItems.length === 0 ? (
              <div className="ncc__history-empty">
                {historyBusy ? '载入中…' : (historyQuery ? '没有匹配的会话' : '还没有历史会话')}
              </div>
            ) : (
              <>
                {orderedHistory.pinned.length > 0 && (
                  <>
                    <div className="ncc__history-group-title ncc__history-group-title--pinned" data-testid="ncc-history-pinned-title">
                      置顶（{orderedHistory.pinned.length}）
                    </div>
                    {orderedHistory.pinned.map((s) => (
                      <Fragment key={s.sessionId}>{historyRowJsx(s, { draggable: true })}</Fragment>
                    ))}
                  </>
                )}
                {historyVisibleItems.map((s, si) => (
                  <Fragment key={s.sessionId}>
                    {needsDayHeader(s.updatedAt, si > 0 ? historyVisibleItems[si - 1].updatedAt : null) && (
                      <div className="ncc__history-group-title" data-testid="ncc-history-day">{SESSION_DAY_LABEL[sessionDayKey(s.updatedAt)]}</div>
                    )}
                    {historyRowJsx(s)}
                  </Fragment>
                ))}
              </>
            )}
          </div>
          {/* 翻页脚注放在滚动列表**外面**：列表能滚 300px 高，放里面用户要滚到底才看见 */}
          {orderedHistory.rest.length > HISTORY_LIMIT && (
            <div className="ncc__history-hint" data-testid="ncc-history-hint">
              {historyCountLabel(historyVisibleItems.length, orderedHistory.rest.length)}
              {hasMoreHistory(historyVisibleItems.length, orderedHistory.rest.length) && (
                <button
                  type="button"
                  className="ncc__history-more"
                  data-testid="ncc-history-more"
                  onClick={() => setHistoryLimit((n) => nextHistoryLimit(n, orderedHistory.rest.length))}
                >
                  加载更多（还有 {orderedHistory.rest.length - historyVisibleItems.length} 条）
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* 运行时插件条：/ui-plugins 下的界面改动免构建，刷新即生效 */}
      <RemotePanels slot="agent-bar" />

      <div className="ncc__body" ref={listRef}>
        {userTurnIds.length > 1 && (
          <div className="ncc-turnnav" data-testid="ncc-turnnav" role="group" aria-label="提问跳转">
            <button type="button" className="ncc-turnnav__btn" title="上一条提问" aria-label="上一条提问"
              disabled={activeTurn <= 0} onClick={() => jumpTurn(-1)}>↑</button>
            <span className="ncc-turnnav__count" title="当前第几条提问 / 共几条">{activeTurn + 1}/{userTurnIds.length}</span>
            <button type="button" className="ncc-turnnav__btn" title="下一条提问" aria-label="下一条提问"
              disabled={activeTurn >= userTurnIds.length - 1} onClick={() => jumpTurn(1)}>↓</button>
          </div>
        )}
        {boot && <div className="ncc__boot">{boot}</div>}
        {!boot && msgs.length === 0 && (
          <div className="ncc__empty">
            <div className="ncc__empty-title">想让念初做什么？</div>
            <div className="ncc__empty-sub">直接说；输入 @ 加上下文，/ 调技能与指令；回复来自真实模型，失败会如实报原因</div>
            <div className="ncc__chips">
              {STARTER_CHIPS.map((c) => (
                <button key={c} type="button" className="ncc__chip" onClick={() => { setInput(c); taRef.current?.focus(); }}>{c}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, mi) => (
          <div
            key={m.id}
            className="ncc-msg"
            data-role={m.role}
            data-mid={m.id}
            data-hit={activeMatch === mi ? '1' : '0'}
          >
            {/*
              计划图层（对标 Qoder 的计划面板）：agent 用 todo_write 提交的清单。
              整表替换语义，取最后一次成功的提交；状态只有待办/进行中/已完成三种，
              「已完成」用删除线 + 绿色对勾，「进行中」用高亮圆点 —— 一眼看出进度。
            */}
            {m.role === 'assistant' && m.plan && m.plan.length > 0 && (
              <div className="ncc-plan" aria-label="任务计划">
                <div className="ncc-plan__head">
                  <span className="ncc-plan__title">计划</span>
                  <span className="ncc-plan__count">
                    {m.plan.filter((t) => t.status === 'completed').length}/{m.plan.length}
                  </span>
                  <span className="ncc-plan__bar" aria-hidden="true">
                    <span
                      className="ncc-plan__bar-fill"
                      style={{ width: `${Math.round((m.plan.filter((t) => t.status === 'completed').length / m.plan.length) * 100)}%` }}
                    />
                  </span>
                </div>
                <ul className="ncc-plan__list">
                  {m.plan.map((t, i) => (
                    <li key={i} className="ncc-plan__item" data-status={t.status}>
                      <span className="ncc-plan__mark" aria-hidden="true">
                        {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}
                      </span>
                      <span className="ncc-plan__text">{t.content}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/*
              工具卡片（对标 Qoder / Cursor 的工具流）：每条都是 run_task 真实执行过的步骤，
              失败也如实标红；点开看完整输出。不做「假装调用」的装饰卡。
            */}
            {m.role === 'assistant' && m.steps && m.steps.length > 0 && (
              <ToolSteps steps={m.steps} />
            )}
            {m.role === 'assistant'
              ? (() => {
                const foldable = m.state !== 'RUNNING' && shouldFoldReply(m.content);
                const isOpen = expandedReplies.has(m.id);
                const collapsed = foldable && !isOpen;
                return (
                  <>
                    <div
                      className={'ncc-msg__body ncc-msg__body--md' + (collapsed ? ' ncc-folded' : '')}
                      data-folded={collapsed ? '1' : undefined}
                    >
                      <MarkdownRenderer content={m.content} />
                    </div>
                    {foldable && (
                      <button
                        type="button"
                        className="ncc-fold-btn"
                        data-testid="ncc-fold-btn"
                        aria-expanded={isOpen}
                        onClick={() => toggleReply(m.id)}
                      >
                        {collapsed ? '展开全文（约 ' + m.content.length + ' 字）' : '收起'}
                      </button>
                    )}
                  </>
                );
              })()
              : <div className="ncc-msg__body" data-state={m.state}>{m.content}</div>}
            {m.role === 'user' && m.files && m.files.length > 0 && (
              <div className="ncc-msg__files" aria-label="这条提问引用的文件">
                {m.files.map((p) => (
                  <span key={p} className="ncc-msg__file" title={p}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <path d="M14 2v6h6" />
                    </svg>
                    {p.split('/').pop()}
                  </span>
                ))}
              </div>
            )}
            {/*
              消息级操作（对标 ChatGPT / Claude / Cursor）：
              鼠标悬停或键盘聚焦时出现，不常驻 —— 常驻会把对话挤得满是按钮。
              每个按钮都是真动作：复制走剪贴板、重发生成真再调一次模型、编辑回填并截断。
            */}
            {(m.role === 'user' || m.role === 'assistant') && (
              <div className="ncc-msg__actions" role="group" aria-label={m.role === 'user' ? '这条提问的操作' : '这条回复的操作'}>
                <button
                  type="button"
                  className="ncc-msg__act"
                  data-copied={copiedId === m.id ? '1' : '0'}
                  onClick={() => void copyMsg(m.id, m.content)}
                  title="复制内容"
                >{copiedId === m.id ? '已复制' : '复制'}</button>
                {m.role === 'assistant' && (
                  <button
                    type="button"
                    className="ncc-msg__act"
                    disabled={busy}
                    onClick={() => void regenerate(m.id)}
                    title="用同一个问题再要一次回复"
                  >重新生成</button>
                )}
                {m.role === 'user' && (
                  <button
                    type="button"
                    className="ncc-msg__act"
                    disabled={busy}
                    onClick={() => editMsg(m.id)}
                    title="把这条提问放回输入框，并从这句重新开始"
                  >编辑重发</button>
                )}
              </div>
            )}
            {m.role === 'assistant' && m.changeSet?.files?.length ? (
              <div className="ncc-diff" aria-label="本次文件变更">
                <div className="ncc-diff__head">
                  变更 {m.changeSet.files.length} 个文件
                  <span className="ncc-diff__plus">+{m.changeSet.files.reduce((a, f) => a + (f.added || 0), 0)}</span>
                  <span className="ncc-diff__minus">−{m.changeSet.files.reduce((a, f) => a + (f.removed || 0), 0)}</span>
                  {m.changeSetId && (m.rolledBack ? (
                    <span className="ncc-diff__rolled">已撤销</span>
                  ) : (
                    <button
                      type="button"
                      className="ncc-diff__undo"
                      disabled={busy}
                      title="把这些文件恢复到本次变更之前（宿主 rollback_change）"
                      onClick={() => void undoChange(m.id, m.changeSetId!)}
                    >撤销</button>
                  ))}
                </div>
                {m.changeSet.files.slice(0, 20).map((f, i) => (
                  <details key={i} className="ncc-diff__file" data-status={f.status || 'modified'}>
                    <summary className="ncc-diff__sum">
                      <span className="ncc-diff__path" title={f.path}>{shortPath(f.path)}</span>
                      <span className="ncc-diff__stat">+{f.added ?? 0} −{f.removed ?? 0}</span>
                    </summary>
                    <pre className="ncc-diff__lines">
                      {(f.lines || []).slice(0, 200).map((l, j) => (
                        <div
                          key={j}
                          className="ncc-diff__line"
                          data-type={l.type === '+' ? 'add' : l.type === '-' ? 'del' : 'ctx'}
                        >{l.text}</div>
                      ))}
                    </pre>
                  </details>
                ))}
              </div>
            ) : null}
            {m.role === 'assistant' && m.usage
              && (m.usage.prompt_tokens != null || m.usage.completion_tokens != null) && (
              <div className="ncc-msg__meta" title={m.model ? '模型：' + m.model : undefined}>
                {m.model ? modelLabel(m.model) + ' · ' : ''}
                in {m.usage.prompt_tokens ?? '?'} / out {m.usage.completion_tokens ?? '?'}
              </div>
            )}
            {m.role === 'system' && <div className="ncc-msg__meta" data-state={m.state}>{m.state}</div>}
          </div>
        ))}
        {busy && <div className="ncc__typing">念初正在回复…</div>}
        {err && (() => {
          /*
            错误分类：能判定类别就显示「是哪一类 + 下一步」，判定不了就退回原文。
            不把「未知错误」硬套成网络类 —— 猜错类别会把用户带去做无效操作。
            原始错误串始终可展开（details），不吞原文。
          */
          const d = diagnoseError(err);
          if (!d) return <div className="ncc__err" data-testid="ncc-err-plain">{err}</div>;
          return (
            <div
              className={'ncc__err ncc-err ncc-err--' + d.category}
              role="alert"
              data-testid="ncc-err-diag"
              data-category={d.category}
            >
              <div className="ncc-err__head">
                <span className="ncc-err__badge">{d.badge}</span>
                <span className="ncc-err__title">{d.title}</span>
              </div>
              <div className="ncc-err__next">下一步：{d.nextStep}</div>
              <details className="ncc-err__detail">
                <summary>原始错误（点开复制给开发者）</summary>
                <pre className="ncc-err__raw">{d.detail}</pre>
              </details>
            </div>
          );
        })()}
      </div>

      {/* 回到底部（批次 Z.16，对标 Claude 的浮动下箭头）：往上滚出视口后出现，点击回最新 */}
      {msgs.length > 0 && !atBottom && (
        <button
          type="button"
          className="ncc__jump"
          title="回到最新"
          aria-label="回到最新"
          data-testid="ncc-jump-bottom"
          onClick={() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })}
        >
          ↓
        </button>
      )}

      {/*
        输入区照主流 agent（ChatGPT / Claude / Cursor）：
          · 一个圆角容器内嵌输入框 + 右下角发送键
          · **没有**「Ctrl+Enter 发送」这类提示行 —— 用户指出完全没必要
          · 回车发送、Shift+回车换行（主流默认，比 Ctrl+Enter 顺手）
      */}
      {!atBottom && (
        <button
          type="button"
          className="ncc__to-bottom"
          title="回到最新"
          aria-label="回到最新"
          onClick={() => {
            const el = listRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}
        >↓</button>
      )}
      <div
        className="ncc__compose"
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files);
        }}
      >
        {sug && (
          <div className="ncc__sug" role="listbox" aria-label={sug.kind === 'slash' ? '技能与指令' : '添加上下文'}>
            <div className="ncc__sug-head">
              {sug.kind === 'slash' ? '技能 / 指令' : '添加上下文'} · 共 {sug.total} 项
              {sug.total > sug.items.length ? `（仅示前 ${sug.items.length}，继续输入筛选）` : ''}
            </div>
            {sug.items.map((it, i) => {
              // 分组头：只在「分类变了」的那一行出现（列表已按分类排好，组是连续的）
              const showCat = !!it.cat
                && (i === 0 || sug.items[i - 1].cat !== it.cat);
              return (
                <Fragment key={it.label}>
                  {showCat && <div className="ncc__sug-cat">{it.cat}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === sugIdx}
                    className="ncc__sug-item"
                    data-on={i === sugIdx ? '1' : '0'}
                    title={it.desc || it.label}
                    onMouseDown={(e) => { e.preventDefault(); pickSug(it); }}
                  >
                    <span className="ncc__sug-name">{it.label}</span>
                    {it.desc && <span className="ncc__sug-desc">{it.desc}</span>}
                  </button>
                </Fragment>
              );
            })}
            <div className="ncc__sug-hint">↑↓ 选择 · ↵ 填入 · Esc 关闭</div>
          </div>
        )}
        <div className="ncc__modes" role="group" aria-label="工作方式">
          {MODE_ORDER.map((id) => {
            const info = workModes.find((m) => m.id === id) ?? null;
            return (
              <button
                key={id}
                type="button"
                className="ncc__mode"
                data-on={mode === id ? '1' : '0'}
                aria-pressed={mode === id}
                title={(info?.desc || MODE_LABELS[id]) + '\n' + toolsTitle(info)}
                onClick={() => changeMode(id)}
              >{MODE_LABELS[id]}</button>
            );
          })}
          {/* 「本模式可用工具」：数字/名字来自宿主 list_modes，拉不到就明说不可用，不编 */}
          <span className="ncc__mode-hint" title={toolsTitle(modeInfo)}>{toolsHint(modeInfo)}</span>
        </div>
        {files.length > 0 && (
          <div className="ncc__chips" aria-label="引用的工作区文件">
            {files.map((p) => (
              <span key={p} className="ncc__chip" title={p}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                </svg>
                <span className="ncc__chip-name">{p.split('/').pop()}</span>
                <button
                  type="button"
                  className="ncc__chip-x"
                  title={'移除 ' + p}
                  aria-label={'移除 ' + p}
                  onClick={() => setFiles((cur) => cur.filter((x) => x !== p))}
                >×</button>
              </span>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="ncc__thumbs" aria-label="图片附件">
            {images.map((src, i) => (
              <div key={i} className="ncc__thumb">
                <img src={src} alt={'图片 ' + (i + 1)} />
                <button
                  type="button"
                  className="ncc__thumb-x"
                  title="移除这张图片"
                  aria-label="移除图片"
                  onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                >×</button>
              </div>
            ))}
          </div>
        )}
        <div className="ncc__box">
          <button
            type="button"
            className="ncc__attach"
            title={mode !== 'chat' ? '这个模式不支持图片附件' : '添加图片（也可直接粘贴 / 拖入）'}
            aria-label="添加图片"
            disabled={mode !== 'chat'}
            onClick={() => fileRef.current?.click()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addImages(e.target.files);
              e.target.value = '';
            }}
          />
          <textarea
            ref={taRef}
            className="ncc__input"
            value={input}
            rows={1}
            spellCheck={false}
            placeholder={MODE_PLACEHOLDERS[mode]}
            onChange={onInputChange}
            onKeyDown={onInputKeyDown}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData?.items || []);
              const files = items
                .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
                .map((i) => i.getAsFile())
                .filter((f): f is File => Boolean(f));
              if (files.length) { e.preventDefault(); addImages(files); }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="ncc__send ncc__send--stop"
              onClick={() => void stop()}
              title="停止生成（中断这一轮）"
              aria-label="停止生成"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="ncc__send"
              onClick={() => void send()}
              disabled={(!input.trim() && images.length === 0)}
              title="发送"
              aria-label="发送"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
        {/* 底部元信息合并成一行：用户反馈上下文网格 / 记忆 / 运行状态 / 累计各自成块，
            在输入框下方「堆成一坨」。统一收进 .ncc-meta 弹性行，窄屏自动换行，不再四行堆叠。 */}
        <div className="ncc-meta" data-testid="ncc-meta">
        {/*
          上下文用量网格（对标 Cherry Studio 的彩色网格，但用「格子 + 文案」双编码）。
          数字来自宿主最近一轮真实装配结果，不是本地估算；没有任何一轮数据时不渲染。
          放在「会话累计」之前：它回答的是「现在还能塞多少」，比历史总账更该先看到。
        */}
        {ctxView && (
          <div
            className={'ncc__ctx ncc__ctx--' + ctxView.level}
            role="img"
            aria-label={
              '上下文已用 ' + fmtTok(ctxView.usage.tokens) + ' / ' + fmtTok(ctxView.usage.budget) + ' tokens（'
              + formatPercent(ctxView.ratio) + '%）'
              + (ctxView.usage.dropped > 0 ? '，已省略 ' + ctxView.usage.dropped + ' 条较早消息' : '')
            }
            title={
              '上下文用量：最近一轮真正发给模型的历史窗口\n'
              + fmtTok(ctxView.usage.tokens) + ' / ' + fmtTok(ctxView.usage.budget) + ' tokens（上限由会话装配预算决定）'
              + (ctxView.usage.dropped > 0
                ? '\n已省略 ' + ctxView.usage.dropped + ' 条较早消息 —— 省略处会在对话里显式标注，不静默丢。'
                : '\n没有消息被省略。')
            }
          >
            <span className="ncc__ctx-grid" aria-hidden="true">
              {Array.from({ length: CTX_CELLS }, (_, i) => (
                <span key={i} className={'ncc__ctx-cell' + (i < ctxView.lit ? ' is-on' : '')} />
              ))}
            </span>
            <span className="ncc__ctx-text">
              {fmtTok(ctxView.usage.tokens)} / {fmtTok(ctxView.usage.budget)}
              <span className="ncc__ctx-drop">{formatDropped(ctxView.usage.dropped)}</span>
            </span>
          </div>
        )}
        {/*
          记忆命中看板：宿主每轮从跨会话记忆里按词法召回若干条（recallMemory）。
          原来只有个数字，用户无从判断「它到底参考了什么」。这里把命中的 key + 预览
          摊开，点开才展开（默认收起，不抢上下文网格的位置）。
          召回是**词法**匹配不是语义检索，所以只陈述「命中了哪些」，不给相关度分数。
        */}
        {memView && memView.count > 0 && (
          <details className="ncc-mem" data-testid="ncc-mem">
            <summary className="ncc-mem__sum">
              记忆命中 {memView.count} 条
              {memView.items.length > 0
                ? <span className="ncc-mem__hint">（点开看命中了哪些）</span>
                : <span className="ncc-mem__hint">（这一轮没有落明细）</span>}
            </summary>
            {memView.items.length > 0 && (
              <ul className="ncc-mem__list">
                {memView.items.map((it, i) => (
                  <li key={i} className="ncc-mem__item">
                    <code className="ncc-mem__key">{it.key}</code>
                    <span className="ncc-mem__preview" title={it.preview}>{it.preview || '（无预览）'}</span>
                  </li>
                ))}
              </ul>
            )}
            {memView.truncated && memView.items.length > 0 && (
              <p className="ncc-mem__more">还有 {memView.count - memView.items.length} 条未展开（仅落盘前 {memView.items.length} 条明细）</p>
            )}
          </details>
        )}
        {/*
          运行状态条（对标 openclaw / orca 把「状态 / 用量 / 为什么停」摆到界面上）：
          五个字段全部来自宿主 run_task 的判定层输出，前端只做展示，不改判。
          空闲时也保留占位——「看不到状态」和「状态是空闲」是两件事。
        */}
        <div
          className="ncc-run-status"
          data-testid="ncc-run-status"
          data-state={lastRun ? String(lastRun.state || 'UNKNOWN') : 'idle'}
          aria-live="polite"
        >
          <span className="ncc-run-status__item ncc-run-status__item--state" data-testid="ncc-run-status__state">
            状态：{runView.stateLabel}
          </span>
          <span className="ncc-run-status__item" data-testid="ncc-run-status__stop" title="后端 stop.mjs 判定的停止原因">
            停止原因：{runView.stopLabel}
          </span>
          <span className="ncc-run-status__item" data-testid="ncc-run-status__elapsed">
            耗时：{runView.elapsedLabel}
          </span>
          <span className="ncc-run-status__item ncc-run-status__item--trace" data-testid="ncc-run-status__trace" title={runView.traceLabel}>
            {runView.traceLabel}
          </span>
          <span className="ncc-run-status__item" data-testid="ncc-run-status__usage">
            用量：{runView.usageLabel}
          </span>
        </div>
        {aggUsage && (
          <div className="ncc__usage" aria-live="polite" title={'输入 ' + aggUsage.i + ' + 输出 ' + aggUsage.o}>
            本会话累计 {aggUsage.i + aggUsage.o} tokens
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
