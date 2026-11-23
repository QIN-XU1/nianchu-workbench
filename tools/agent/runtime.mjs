#!/usr/bin/env node
/**
 * 念初 · 主 agent 执行后端（conversation runtime）
 *
 * ══ 为什么要写这个文件 ═══════════════════════════════════════
 * 用户三次指出「主 agent 完全不可用」。查到根因（台账 H-0192）：
 *   前端 FloatingMiniChat 需要宿主提供会话通道，而 tools/hostapi/ws-host.mjs
 *   这 8 个方法一个都没实现 —— 界面永远落到 unavailable 分支。
 *
 * 本文件补的就是这层：**真的会话 + 真的模型调用 + 真的消息落盘**。
 *
 * ══ 模型从哪来（不是编的）════════════════════════════════════
 * 本机 127.0.0.1:3425 有一个真实模型网关，实测 /v1/models 返回 879 个模型，
 * 并且真发一次 chat/completions 拿到了真实 usage（in=151 out=20）。
 * tools/cost/sample-real.mjs:15 早就在用这个网关读真实计费。
 *
 * 网关不可达时**如实失败**，不做假回复。
 *
 * ══ 会话存哪 ═════════════════════════════════════════════════
 * evidence/agent/sessions/<sessionId>.jsonl —— 一行一条消息，只追加。
 * 与项目已有的 append-only 台账风格一致（tools/ledger/append-only.mjs）。
 *
 * ══ 四态 ═════════════════════════════════════════════════════
 * 每个返回值都带 state：PASS / WARN / FAIL / UNKNOWN。
 * 失败就是 FAIL，拿不到就是 UNKNOWN，绝不把失败伪装成成功。
 */
import { mkdirSync, existsSync, appendFileSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assembleMessages } from './context.mjs';
import { callWithFailover } from './models.mjs';
import { readContextFiles } from './workspace-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/**
 * ══ 用户数据放哪（2026-11-18「我们实际要做的是份软件」）══════════
 *
 * 之前把会话写在 `evidence/agent/sessions` —— 那是**开发证据目录**，
 * 用来放验证截图/报告的，不是用户数据。一份软件的用户数据应该：
 *   · 跟安装目录分开（升级/重装不丢）
 *   · 有平台约定的位置
 *
 * 优先级：
 *   1. NIANCHU_DATA_DIR 环境变量（部署/测试可指定）
 *   2. 平台用户数据目录
 *        Windows  %APPDATA%\Nianchu
 *        macOS    ~/Library/Application Support/Nianchu
 *        Linux    $XDG_DATA_HOME/nianchu 或 ~/.local/share/nianchu
 *   3. 兜底 <repo>/data（便携运行 / 没权限时）
 *
 * 边界如实说：单机单用户，没做多账号隔离；权限靠 OS 目录权限。
 */
function resolveDataDir() {
  if (process.env.NIANCHU_DATA_DIR) return process.env.NIANCHU_DATA_DIR;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'Nianchu');
  }
  if (process.platform === 'darwin' && home) {
    return join(home, 'Library', 'Application Support', 'Nianchu');
  }
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg) return join(xdg, 'nianchu');
    if (home) return join(home, '.local', 'share', 'nianchu');
  }
  return join(REPO, 'data');
}

const DATA_DIR = resolveDataDir();
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const INDEX_FILE = join(SESSIONS_DIR, '_index.json');

export const USER_DATA_DIR = DATA_DIR;
export const GATEWAY = process.env.NIANCHU_GATEWAY || 'http://127.0.0.1:3425/v1/chat/completions';
// 2026-11-21：原默认 auto/claude-haiku-5-5 在 3425 网关上被上游 GitHub Copilot
// 拒绝（model_not_supported）。换成 auto/claude-sonnet-5-5；要覆盖用 NIANCHU_MODEL 环境变量。
// 2026-11-22：网关再次上游改路由，auto/claude-sonnet-5-5 现返回 400 model_not_supported
// （实测 timeline）。实测当前可用的是 group/deepseek（200，带 system 也能正常回答），
// 改用它为默认；仍然失败就显式设 NIANCHU_MODEL，不静默回退成假回复。
export const DEFAULT_MODEL = process.env.NIANCHU_MODEL || 'group/deepseek';

/** 助手工作区（主 agent 的会话都挂在这里，不污染用户项目） */
export const ASSISTANT_WORKSPACE_ID = 'nianchu-assistant';

function ensureDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id) {
  return join(SESSIONS_DIR, id + '.jsonl');
}

function now() {
  return new Date().toISOString();
}

/**
 * 会话索引。索引本身是可重建的派生数据 ——
 * 真正的事实来源是 sessions/*.jsonl 文件本身。
 */
export function rebuildIndex() {
  ensureDir();
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'));
  const sessions = files.map((f) => {
    const id = f.replace(/\.jsonl$/, '');
    const lines = readFileSync(join(SESSIONS_DIR, f), 'utf8').split('\n').filter(Boolean);
    let first = null;
    let last = null;
    let title = '';
    let renamed = '';
    let count = 0;
    for (const line of lines) {
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      // 只把真正的对话消息算作「条数」：meta / system（失败记录、重命名）不算，
      // 否则「新建但没说话」的会话会显示成 1 条，列表里全是噪音。
      if (m.role === 'user' || m.role === 'assistant') count++;
      if (!first) first = m.at;
      last = m.at;
      if (!title && m.role === 'user' && m.content) title = String(m.content).slice(0, 40);
      // 用户重命名过就以最后一次改名为准（meta 记录，可重建）
      if (m.type === 'session-renamed' && m.sessionName) renamed = String(m.sessionName);
    }
    return {
      sessionId: id,
      sessionName: renamed || title || '新会话',
      agentType: 'nianchu',
      workspaceId: ASSISTANT_WORKSPACE_ID,
      workspacePath: '',
      createdAt: first,
      updatedAt: last,
      messageCount: count,
    };
  }).filter((s) => s.messageCount > 0)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const payload = { at: now(), count: sessions.length, sessions };
  // 索引是派生数据（真源是 sessions/*.jsonl），写失败不影响正确性
  try { writeFileSync(INDEX_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  return payload;
}

export function listSessions() {
  return rebuildIndex();
}

export function getSession(sessionId) {
  const p = sessionPath(sessionId);
  if (!existsSync(p)) return { state: 'UNKNOWN', reason: 'session not found', sessionId, messages: [] };
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return { state: 'PASS', sessionId, messages };
}

export function createSession({ sessionName, workspaceId } = {}) {
  ensureDir();
  const sessionId = 'ags-' + randomUUID().replace(/-/g, '').slice(0, 20);
  // 首行写一条 meta，保证文件存在且可被索引
  appendFileSync(sessionPath(sessionId), JSON.stringify({
    at: now(), role: 'meta', type: 'session-created',
    sessionName: sessionName || '新会话',
    workspaceId: workspaceId || ASSISTANT_WORKSPACE_ID,
  }) + '\n', 'utf8');
  return {
    state: 'PASS',
    sessionId,
    sessionName: sessionName || '新会话',
    agentType: 'nianchu',
    workspaceId: workspaceId || ASSISTANT_WORKSPACE_ID,
    workspacePath: '',
  };
}

/** 重命名会话：追加一条 meta 记录（索引是派生数据，重建后仍生效） */
export function renameSession(sessionId, sessionName) {
  if (!sessionId) return { state: 'FAIL', reason: 'sessionId 必填' };
  if (!existsSync(sessionPath(sessionId))) return { state: 'UNKNOWN', reason: '会话不存在：' + sessionId };
  const name = String(sessionName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) return { state: 'FAIL', reason: '名称不能为空' };
  appendMessage(sessionId, { role: 'meta', type: 'session-renamed', sessionName: name });
  return { state: 'PASS', sessionId, sessionName: name };
}

/** 删除会话：删掉 jsonl 真源（索引重建时自然消失） */
export function deleteSession(sessionId) {
  if (!sessionId) return { state: 'FAIL', reason: 'sessionId 必填' };
  const p = sessionPath(sessionId);
  if (!existsSync(p)) return { state: 'UNKNOWN', reason: '会话不存在：' + sessionId };
  try {
    rmSync(p, { force: true });
    return { state: 'PASS', sessionId };
  } catch (e) {
    return { state: 'FAIL', reason: '删除失败：' + String(e && e.message).slice(0, 160) };
  }
}

export function appendMessage(sessionId, msg) {
  ensureDir();
  const rec = { at: now(), ...msg };
  appendFileSync(sessionPath(sessionId), JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/**
 * 真调模型。
 *
 * @returns {{state:'PASS'|'FAIL'|'UNKNOWN', content?:string, model?:string, usage?:object, reason?:string}}
 *
 * 关键：**绝不伪造回复**。网关挂了就是 FAIL，模型返回空就是 UNKNOWN。
 */
/**
 * 网关会**瞬时抖动**。
 * 2026-11-18 实测：同一个模型连续请求，先是 401「Factory: User not affiliated with
 * an organization」，紧接着 200 —— 上游临时问题，不是我们的配置错。
 * 所以对瞬时类状态做**有界重试**（默认 2 次，间隔递增），仍失败才如实报。
 * 明确非瞬时的错误（如 404 模型不存在）不重试 —— 重试只会掩盖真问题。
 */
const TRANSIENT_STATUS = (s) => s === 408 || s === 425 || s === 429 || s >= 500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 发一次请求，带重试。成功返回 { res }，失败返回 { state, reason }。
 */
async function requestGateway(payload, signal) {
  const retries = Math.max(0, Number(process.env.NIANCHU_GATEWAY_RETRIES ?? 2));
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(GATEWAY, {
        method: 'POST',
        // 第 220 轮：此前**从不发** Authorization 头。网关目前不校验也能用，
        // 但只要它开始校验，所有调用都会 401——而错误会被误读成「模型不可用」。
        headers: {
          'content-type': 'application/json',
          ...(process.env.NIANCHU_API_KEY ? { authorization: 'Bearer ' + process.env.NIANCHU_API_KEY } : {}),
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      // 用户主动停止：立即返回，不按瞬时错误重试（否则「停止」还要再等两轮退避）
      if (signal?.aborted) return { state: 'ABORTED', reason: '用户已停止生成' };
      // 连接层失败也按瞬时处理
      last = { state: 'FAIL', reason: '模型网关不可达（' + GATEWAY + '）：' + String(e && e.message).slice(0, 160) };
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      return last;
    }
    if (res.ok) return { res };

    let body = '';
    try { body = (await res.text()).slice(0, 240); } catch { /* ignore */ }
    last = { state: 'FAIL', reason: '网关返回 ' + res.status + '：' + body };
    // 401 也算瞬时：实测它是上游账号状态抖动，重试常常就好
    const transient = TRANSIENT_STATUS(res.status) || res.status === 401;
    if (!transient || attempt === retries) return last;
    await sleep(800 * (attempt + 1));
  }
  return last;
}

export async function callModel({ messages, model = DEFAULT_MODEL, maxTokens = 1200, signal } = {}) {
  const attempt = await requestGateway({
    model,
    messages,
    max_tokens: maxTokens,
    stream: false,
  }, signal);
  if (!attempt.res) return attempt;

  let json;
  try {
    json = await attempt.res.json();
  } catch (e) {
    return { state: 'UNKNOWN', reason: '网关返回了非 JSON：' + String(e && e.message).slice(0, 120) };
  }

  const choice = json && json.choices && json.choices[0];
  const content = choice && choice.message && choice.message.content;
  const finishReason = (choice && choice.finish_reason) || null;
  if (typeof content !== 'string' || content.length === 0) {
    /**
     * 【第 220 轮】空内容要分两种，别混成一个「UNKNOWN」：
     *   · `finish_reason === 'length'` → 预算是真花完了（推理模型常把 8/24 token 全吃在
     *     reasoning 上），这是**截断**，是真实的交付失败 → 判 FAIL 并标 truncated；
     *   · 其他情况才是「模型/网关没给东西」→ UNKNOWN（环境问题，不该甩给代码）。
     * 混在一起的后果：`verify-team` 的「截断不算 PASS」反例拿到 UNKNOWN，
     * 于是把「预算太小」误报成「模型不可用」，测试永远绿不了。
     */
    if (finishReason === 'length') {
      return {
        state: 'FAIL',
        reason: '输出被 token 上限截断（finish_reason=length 且 content 为空）',
        model: json.model || model,
        usage: json.usage || null,
        finishReason,
        truncated: true,
      };
    }
    return { state: 'UNKNOWN', reason: '模型返回空内容（choices[0].message.content 为空）' };
  }

  return {
    state: 'PASS',
    content,
    model: json.model || model,
    usage: json.usage || null,
    finishReason: choice.finish_reason || null,
    /**
     * finish_reason === 'length' 表示**输出被 token 上限截断**。
     * 之前不区分，交付物中途断掉后审阅者只能凭「代码末尾是个 d」去猜 ——
     * 明明是运行时的预算问题，却变成被审阅的质量问题。
     */
    truncated: (choice.finish_reason || '') === 'length',
  };
}

/**
 * 正在跑的轮次（runToken → AbortController）。
 * 「停止生成」靠它真的中断在途 fetch —— 不是前端假装停止、后台继续烧 token。
 */
const ACTIVE_TURNS = new Map();

/** 停止某一轮；返回是否真的找到了在途请求（找不到就如实 false） */
export function interruptTurn(runToken) {
  const c = ACTIVE_TURNS.get(String(runToken || ''));
  if (!c) return false;
  c.abort();
  ACTIVE_TURNS.delete(String(runToken));
  return true;
}

/**
 * 提交一轮对话。
 *
 * 上下文装配交给 context.mjs：有界历史窗口（裁掉的显式标注）+ 跨会话记忆召回
 * （core 铁律受 2KB 预算约束，其余按当前问题检索）。
 * 之前是把**全部历史**塞进去 —— 长会话一定撑爆，而且撑爆后是模型静默丢内容，
 * 不是报错，行为不可预期。
 */
export async function submitTurn({
  sessionId, text, model = DEFAULT_MODEL, systemPrompt, maxTokens = 1200,
  memory = true, maxTurns = 30, historyTokens = 6000, runToken, images, files,
} = {}) {
  if (!sessionId) return { state: 'FAIL', reason: 'sessionId 必填' };
  if (!text || !String(text).trim()) return { state: 'FAIL', reason: '内容为空' };

  /**
   * 批次 W：`@` 引用的文件 → 本轮上下文。
   * 与图片同一原则：**只挂本轮**，历史里只存路径（否则 jsonl 线性膨胀）。
   * 读不到/超限/二进制一律记到 missing/skipped 里如实回给界面，不静默丢。
   */
  const refFiles = Array.isArray(files) ? files.map((p) => String(p || '').trim()).filter(Boolean) : [];
  const refCtx = refFiles.length
    ? readContextFiles(refFiles, { root: process.cwd() })
    : { text: '', blocks: [], missing: [], skipped: [], bytes: 0 };

  const token = String(runToken || ('run-' + randomUUID().slice(0, 12)));
  const sid = sessionId;
  if (!existsSync(sessionPath(sid))) {
    // 允许对不存在的会话直接说第一句：补建
    createSession({ sessionName: String(text).slice(0, 40) });
  }

  appendMessage(sid, {
    role: 'user',
    content: String(text),
    ...(refFiles.length ? { files: refFiles } : {}),
  });

  const assembled = assembleMessages({
    systemPrompt,
    messages: getSession(sid).messages,
    userText: String(text),
    memory,
    maxTurns,
    maxTokens: historyTokens,
  });

  /**
   * 批次 W：把 `@` 引用的文件内容拼到**本轮** user 消息末尾。
   * 必须在图片之前——图片那一步会把 content 改成数组，之后再拼就是 stringify 一个数组。
   */
  if (refCtx.blocks.length) {
    const last = assembled.messages[assembled.messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') {
      last.content = last.content + '\n\n' + refCtx.text;
    }
  }

  /**
   * 图片：只挂到**本轮**最后一条 user 消息上。
   * 历史里不存 base64（否则会话 jsonl 会膨胀到几十 MB），所以回看历史只有文字 —— 如实标注。
   * 网关实测支持 image_url（group/deepseek 200）；最多 4 张，单张大小由界面侧限制。
   */
  if (Array.isArray(images) && images.length) {
    const last = assembled.messages[assembled.messages.length - 1];
    if (last && last.role === 'user') {
      last.content = [
        { type: 'text', text: String(last.content || text) },
        ...images.slice(0, 4).map((url) => ({ type: 'image_url', image_url: { url: String(url) } })),
      ];
    }
  }

  /**
   * A14：走故障转移链（按用途 role 选候选）。
   * 主模型挂了会按链自动落到备用，而不是整轮失败。
   * signal：让「停止生成」能真的中断请求。
   */
  const controller = new AbortController();
  ACTIVE_TURNS.set(token, controller);
  let r;
  try {
    r = await callWithFailover({
      messages: assembled.messages,
      role: model ? undefined : 'default',
      chain: model ? [model] : undefined,
      maxTokens,
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      appendMessage(sid, { role: 'system', type: 'turn-interrupted', state: 'INTERRUPTED', reason: '用户已停止生成' });
      return { state: 'INTERRUPTED', sessionId: sid, reason: '用户已停止生成', runToken: token };
    }
    throw e;
  } finally {
    ACTIVE_TURNS.delete(token);
  }

  if (controller.signal.aborted) {
    appendMessage(sid, { role: 'system', type: 'turn-interrupted', state: 'INTERRUPTED', reason: '用户已停止生成' });
    return { state: 'INTERRUPTED', sessionId: sid, reason: '用户已停止生成', runToken: token };
  }

  if (r.state === 'PASS') {
    /**
     * 本轮上下文用量：**落盘**一份，界面重载/切会话后还能显示。
     * 只存 4 个标量，不存 memoryInjection 那种对象 —— 会话文件是长期资产，
     * 不该随着装配实现变化而膨胀。
     */
    const ctx = {
      historyDropped: assembled.history.dropped,
      historyTokens: assembled.history.tokens,
      /**
       * 本轮历史预算（= buildHistory 的 maxTokens）。
       * 必须由宿主给，不能让界面写死 6000 —— 那是装配侧的默认值，
       * 一旦按会话/配置调整，界面写死就会显示一个假的「用量/上限」。
       */
      historyBudget: historyTokens,
      memoryHits: assembled.memoryHits.length,
      /**
       * 命中了哪几条记忆：界面要能回答「这一轮用的是哪几条」，而不是只给个数。
       * 只存 key + 80 字预览（不存整条 value，也不存 score）：
       *   · 会话文件是长期资产，预览够界面展示即可；
       *   · score 是词法命中的中间量，摆给用户会被误读成「相关度」。
       * 上限 6 条，与 `recallMemory` 的默认 limit 一致。
       */
      memoryHitItems: assembled.memoryHits.slice(0, 6).map((h) => ({
        key: String(h && h.key ? h.key : '?'),
        preview: String(h && h.value ? h.value : '').replace(/\s+/g, ' ').slice(0, 80),
      })),
    };
    appendMessage(sid, {
      role: 'assistant', content: r.content, model: r.model, usage: r.usage,
      // 持久化用量：否则一刷新就只剩「本会话累计」，看不到上下文压力
      context: ctx,
    });
    return {
      state: 'PASS', sessionId: sid, content: r.content, model: r.model, usage: r.usage,
      userMessage: { role: 'user', content: String(text) },
      files: refFiles,
      fileRefs: refFiles.length
        ? { attached: refCtx.blocks.length, missing: refCtx.missing, skipped: refCtx.skipped, bytes: refCtx.bytes }
        : null,
      servedBy: r.servedBy,
      failoverIndex: r.failoverIndex,
      modelAttempts: r.attempts,
      runToken: token,
      context: {
        ...ctx,
        memoryInjection: assembled.memoryInjection,
        retrievalError: assembled.retrievalError,
      },
    };
  }

  // 失败也落盘，避免「用户说了但没记录」
  appendMessage(sid, {
    role: 'system', type: 'turn-failed', state: r.state, reason: r.reason,
  });
  return { state: r.state, sessionId: sid, reason: r.reason, runToken: token };
}

// ── CLI 自检：node tools/agent/runtime.mjs [--demo] ──
// 第 187 轮修：原来是 `process.argv[1].endsWith('runtime.mjs')`，会误命中任何
// `*runtime.mjs` 脚本（如 tmp/a16-trace-runtime.mjs）——一 import 就把进程 exit 掉。
// 改成取 basename 精确比较，只有真身为 runtime.mjs 才跑自检。
if (process.argv[1] && process.argv[1].split(/[\\/]/).pop() === 'runtime.mjs') {
  const demo = process.argv.includes('--demo');
  console.log('');
  console.log('  念初 主 agent 执行后端');
  console.log('  数据目录: ' + DATA_DIR);
  console.log('  网关: ' + GATEWAY);
  console.log('  默认模型: ' + DEFAULT_MODEL);

  const idx = listSessions();
  console.log('  现有会话: ' + idx.count + (idx.count ? '（最近：' + idx.sessions[0].sessionName + '）' : ''));

  if (!demo) {
    console.log('');
    console.log('  （加 --demo 会真发一次模型请求验证链路）');
    process.exit(0);
  }

  const s = createSession({ sessionName: 'CLI 自检' });
  console.log('  新建会话: ' + s.sessionId);
  const r = await submitTurn({
    sessionId: s.sessionId,
    text: '请只回复两个字：收到',
    maxTokens: 32,
  });
  console.log('  四态: ' + r.state);
  if (r.state === 'PASS') {
    console.log('  模型: ' + r.model);
    console.log('  回复: ' + String(r.content).slice(0, 120));
    console.log('  usage: in=' + (r.usage?.prompt_tokens ?? '?') + ' out=' + (r.usage?.completion_tokens ?? '?'));
  } else {
    console.log('  原因: ' + r.reason);
  }
  console.log('');
  process.exit(r.state === 'PASS' ? 0 : 1);
}

/**
 * 原始模型调用：支持 tools（function calling），返回**原始 message**。
 *
 * 【为什么不复用 callModel】callModel 假设「必须有 content」——那是纯对话的假设。
 * 但带工具时，模型常常 content=null、只返回 tool_calls（实测本网关就是这样：
 * finish_reason='tool_calls', message.content=null）。
 * 硬套 callModel 会把这种正常响应判成「模型返回空内容」。
 * 所以这里单独一条：把 message 原样交给上层，由 agent 循环自己解释。
 */
/**
 * 原始模型调用：支持 tools（function calling），返回**原始 message**。
 *
 * 【为什么不复用 callModel】callModel 假设「必须有 content」——那是纯对话的假设。
 * 但带工具时，模型常常 content=null、只返回 tool_calls（实测本网关就是这样：
 * finish_reason='tool_calls', message.content=null）。
 * 硬套 callModel 会把这种正常响应判成「模型返回空内容」。
 */
export async function callModelRaw({
  messages, model = DEFAULT_MODEL, maxTokens = 2000, tools, toolChoice, signal,
} = {}) {
  const payload = { model, messages, max_tokens: maxTokens, stream: false };
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = toolChoice || 'auto';
  }

  const attempt = await requestGateway(payload, signal);
  if (!attempt.res) return attempt;

  let json;
  try {
    json = await attempt.res.json();
  } catch (e) {
    return { state: 'UNKNOWN', reason: '网关返回了非 JSON：' + String(e && e.message).slice(0, 120) };
  }
  const choice = json && json.choices && json.choices[0];
  if (!choice || !choice.message) {
    return { state: 'UNKNOWN', reason: '网关没有返回 choices[0].message' };
  }
  return {
    state: 'PASS',
    message: choice.message,
    model: json.model || model,
    usage: json.usage || null,
    finishReason: choice.finish_reason || null,
    truncated: (choice.finish_reason || '') === 'length',
  };
}


