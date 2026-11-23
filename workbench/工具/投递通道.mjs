#!/usr/bin/env node
/**
 * 投递通道 —— 把派单真正送到目标场景会话
 *
 * ══════════════════════════════════════════════════════════════
 *  这补的是整个项目最致命的缺口
 * ══════════════════════════════════════════════════════════════
 *
 *  现状（实测确认）：
 *    派单.mjs --deliver 只是 `d.state = 'delivered'` + 打时间戳，
 *    **没有任何代码真的把任务送出去**。
 *
 *    派单工具自己的注释都写着：
 *      「⚠ 还差一步：必须真的投递到对方会话（否则只是"公告"）」
 *    这一步从来没实现。
 *
 *  实测验证的投递通道（引擎 RPC）：
 *    ① session/list   列出会话，按 cwd 找场景会话
 *    ② session/create 没有就建一个（cwd 指向该场景的注入目录）
 *    ③ session/prompt 投递任务  ← 真正的投递
 *    ④ session/page   读记录，判断跑完没
 *
 *  实测结果：任务文字真的出现在了目标会话里（[25] user/message）。
 *
 * ══════════════════════════════════════════════════════════════
 *  设计要点
 * ══════════════════════════════════════════════════════════════
 *
 *  1. 一个场景可能有多个会话 → 优先复用「最新」的那个
 *  2. 投递后必须能判定「跑完」→ 用 turn/end + reason.kind
 *  3. 超时不阻塞 → deadline 到点就标 unacked
 *  4. 不破坏现有五态机 → 只把 --deliver 从「手动改状态」改成「真投递」
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const LOG = path.join(WB, '外壳', 'server.log');

// ══════════════════════════════════════════════════════════════
//  引擎连接
// ══════════════════════════════════════════════════════════════
const DEFAULT_PORT = 3083;

// ── 429 速率限制重试（2026-11-12 新增）──────────────────────────────
//
//  实测：本地免费网关连续投递 8 个场景，前 3 个成功，后 5 个全 429。
//        错误信息：
//          429 user_model_rate_limited
//          "SenseNova Token Plan: rps exhausted"
//        等 60 秒后重试 → 恢复。
//
//  **是速率限制，不是余额。** 原来的行为一遇 429 就报失败，
//  派单卡在 failed，看起来像「模型坏了」，其实是打太快。

/** 429 最多重试几次 */
export const RATE_LIMIT_RETRIES = 4;

/** 退避时长（毫秒）：5s → 15s → 30s → 60s */
export const RATE_LIMIT_BACKOFF_MS = [5000, 15000, 30000, 60000];

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

/** 从 server.log 抓最新 token */
export function getEngineToken(logPath = LOG) {
  const s = readTextSafe(logPath);
  if (!s) return null;
  // ⚠ 2026-11-12 修（据 中枢/闭环断点诊断.md 断点2）：
//   原来这里用 {30,}，而 中枢代写.mjs 用 {20,}。
//   token 长度落在 20-29 时，这边抓不到 → connect 静默失败。
//   统一成 {20,}（实际 token 长度约 43 字符，20 是安全下限）。
const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

/** 探测引擎端口（从 server.log 的 dsh web 行） */
export function getEnginePort(logPath = LOG) {
  const s = readTextSafe(logPath);
  if (!s) return DEFAULT_PORT;
  const m = [...s.matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/g)];
  return m.length ? Number(m[m.length - 1][1]) : DEFAULT_PORT;
}

function httpRequest(port, method, urlPath, body, cookie, timeoutMs) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        ...(cookie ? { cookie } : {}),
      },
      timeout: timeoutMs || 60000,
    };
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on('error', (e) => resolve({ status: 0, error: String(e.message) }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.write(data);
    r.end();
  });
}

/**
 * 引擎客户端
 *
 * 协议（从 dsh-client-connection/lib/client.node.js 源码）：
 *   POST /api/{channel}/{endpoint}
 *   { type:'client-request', rpcId, method:'{channel}/{endpoint}', payload:{ args } }
 */
export class EngineClient {
  constructor(opts) {
    const o = opts || {};
    this.port = o.port || getEnginePort();
    this.token = o.token || getEngineToken();
    this.cookie = '';
    this.ready = false;
  }

  async connect() {
    if (!this.token) return { ok: false, error: '拿不到 token（引擎没跑？）' };
    const r = await httpRequest(this.port, 'GET', '/?token=' + this.token, null, '', 10000);
    if (r.status !== 303 && r.status !== 200) {
      return { ok: false, error: 'token 被拒 (HTTP ' + r.status + ')' };
    }
    const sc = r.headers['set-cookie'];
    this.cookie = Array.isArray(sc) ? sc.map((c) => c.split(';')[0]).join('; ') : '';
    this.ready = true;
    return { ok: true };
  }

  async call(channel, endpoint, args, timeoutMs) {
    const r = await httpRequest(this.port, 'POST', '/api/' + channel + '/' + endpoint, {
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: channel + '/' + endpoint,
      payload: { args: args || {} },
    }, this.cookie, timeoutMs);
    if (r.status === 0) return { ok: false, error: r.error };
    try {
      const j = JSON.parse(r.body);
      const res = j.result;
      if (res && res.ok === false) {
        return { ok: false, error: res.error?.message || res.error?.code || 'unknown' };
      }
      return { ok: true, value: res?.value };
    } catch {
      return { ok: false, error: 'JSON 解析失败: ' + r.body.slice(0, 120) };
    }
  }

  // ── 具体端点 ──

  async listSessions() {
    const r = await this.call('session', 'list', { _request: {} });
    if (!r.ok) return { ok: false, error: r.error };
    const v = r.value || {};
    return { ok: true, sessions: v.sessions || v.items || [] };
  }

  async createSession(cwd) {
    const r = await this.call('session', 'create', { request: { cwd } });
    if (!r.ok) return { ok: false, error: r.error };
    const sid = r.value?.sessionId;
    return sid ? { ok: true, sessionId: sid } : { ok: false, error: '无 sessionId' };
  }

  async prompt(sessionId, text) {
    // ══════════════════════════════════════════════════════════════
    //  ⚠ 2026-11-12 修（据 中枢/闭环断点诊断.md 断点4）：
    //
    //    原来：return this.call(...) —— 只判 RPC/HTTP 层。
    //          mode: 'queue' 意味着「投进队列」，HTTP 200 就算成功。
    //
    //    后果：余额不足（QUOTA）、模型拒绝、会话已满 等情况下，
    //          RPC 依然返回 ok:true，但任务根本不会执行。
    //          台账 d-20261110-001~007 全是「余额不足仍 delivered」。
    //
    //    修法：投递后**立刻检查会话里有没有错误事件**
    //          · 扫最近的 system/message 和 assistant/message
    //          · 找 QUOTA / quota / 余额 / insufficient / rate limit 等关键词
    //          · 命中就返回 ok:false 并带上原因
    // ══════════════════════════════════════════════════════════════
    const r = await this.call('session', 'prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    });

    // RPC 层就失败了 → 直接返回
    if (!r.ok) return r;

    // RPC 层成功，但实际可能没执行（余额不足 / 内容审查 / 限流）→ 探一下
    //
    // ⚠ 2026-11-12 修（第一版修错了位置）：
    //
    //   第一版去 system/message 和 assistant/message 的 content 里找关键词，
    //   实测**找不到** —— 402 根本不在那里。
    //
    //   真实位置（实测抓到的完整事件）：
    //     [587] turn/end {"kind":"error","error":{"message":"402: 余额不足，请充值后再使用"...}}
    //
    //   也就是说：错误在 turn/end 事件的 reason.error.message 里。
    //   正确做法：等这一轮结束，读 reason.kind 和 reason.error.message。
    const FAIL_PAT = /QUOTA|quota|余额不足|insufficient|rate.?limit|限流|额度已用|内容安全|安全策略|已拒绝|invalid_request_error|50[0-9]|40[0-9]/i;
    try {
      // 等这一轮真的结束（最多 60 秒；短超时是因为这里只想快速发现「立刻失败」）
      const probeDeadline = Date.now() + 60000;
      let lastReason = null;
      while (Date.now() < probeDeadline) {
        await new Promise((res) => setTimeout(res, 1500));
        const pg = await this.page(sessionId);
        if (!pg || !pg.ok) continue;
        const recs = (pg.records || []).map((x) => (x && x.event ? x.event : x)).filter(Boolean);
        const ends = recs.filter((e) => e.type === 'turn/end');
        if (!ends.length) continue;
        const last = ends[ends.length - 1];
        lastReason = last.data && last.data.reason;
        if (!lastReason) continue;
        // 已经拿到最新一轮的结束原因 → 停止等待
        break;
      }

      if (lastReason && lastReason.kind && lastReason.kind !== 'completed') {
        const errMsg = (lastReason.error && lastReason.error.message) || JSON.stringify(lastReason);
        if (FAIL_PAT.test(errMsg)) {
          return {
            ok: false,
            error: '投递后本轮未完成（' + lastReason.kind + '）: ' + String(errMsg).slice(0, 160),
            quota: /余额|QUOTA|402/i.test(errMsg),
          };
        }
      }
    } catch { /* 探不到就当成功（保守） */ }

    return r;
  }

  async page(sessionId, maxMessages) {
    const r = await this.call('session', 'page', {
      request: {
        address: { kind: 'session', sessionId },
        maxMessages: maxMessages || 200,
      },
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, records: r.value?.records || [] };
  }
}

// ══════════════════════════════════════════════════════════════
//  场景 → 会话解析
// ══════════════════════════════════════════════════════════════

/** 场景名/ID 归一化（支持中文名或英文 id） */
export function resolveSceneId(input) {
  if (!input) return null;
  const raw = String(input).trim();

  // 直接是 id
  if (fs.existsSync(path.join(SCEN_DIR, raw + '.json'))) return raw;

  // 中文名 → id
  if (fs.existsSync(SCEN_DIR)) {
    for (const f of fs.readdirSync(SCEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readTextSafe(path.join(SCEN_DIR, f)));
        if (j.name === raw || j.id === raw) return j.id;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/**
 * 场景的工作目录（会话 cwd）
 *
 * ⚠ 2026-11-10 改造（方案 A，端到端闭环暴露的真实障碍）：
 *
 *   原来 cwd 是 数据/.dsh/场景注入/<sceneId>/，
 *   但记忆文件在 数据/.dsh/场景记忆/<场景名>/，
 *   两者是兄弟目录 → 跨出 cwd → 沙箱拒绝：
 *     [sandbox: file access denied under workspace-write mode]
 *
 *   实测：场景 agent 能读到记忆（read 成功），
 *        但写回记忆时被沙箱拦住（edit 失败）。
 *        这意味着**所有场景都写不了自己的记忆**。
 *
 *   现在 cwd 改为「场景记忆目录」：
 *     · 记忆文件在 cwd 内 → 可直接写，不触发沙箱
 *     · 注入文件 AGENTS.local.md 也放在这里
 *     · 场景之间仍然隔离（各自目录）
 *     · 不需要放宽沙箱模式（安全）
 */
export function sceneInjectDir(sceneId) {
  // 场景 id → 记忆目录名（中文名）
  try {
    const j = JSON.parse(readTextSafe(path.join(SCEN_DIR, sceneId + '.json')));
    const name = j.name || sceneId;
    return path.join(DATA_ROOT, '场景记忆', name);
  } catch {
    return path.join(DATA_ROOT, '场景记忆', sceneId);
  }
}

/** 场景名 */
export function sceneDisplayName(sceneId) {
  try {
    const j = JSON.parse(readTextSafe(path.join(SCEN_DIR, sceneId + '.json')));
    return j.name || sceneId;
  } catch {
    return sceneId;
  }
}

/** 从会话对象里提取 cwd */
function sessionCwd(s) {
  return s.cwd || s.workspace || s.workingDirectory || '';
}

/**
 * 找到场景对应的会话
 *
 * 策略（按优先级）：
 *   ① cwd 精确匹配 场景注入/<sceneId>
 *   ② 有多个时取「最新」的（按 updatedAt/createdAt/最后活动）
 *   ③ 都没有 → 返回 null，由调用方决定是否创建
 */
export async function findSceneSession(client, sceneId) {
  const r = await client.listSessions();
  if (!r.ok) return { ok: false, error: r.error };

  const wantDir = sceneInjectDir(sceneId);
  const wantNorm = wantDir.replace(/\\/g, '/').toLowerCase();

  const matched = r.sessions.filter((s) => {
    const cwd = sessionCwd(s).replace(/\\/g, '/').toLowerCase();
    return cwd === wantNorm || cwd.startsWith(wantNorm + '/');
  });

  if (matched.length === 0) return { ok: true, sessionId: null, candidates: 0 };

  // ⚠ 2026-11-12 修（选「最近活跃」→ 轮转后失效）
  //
  //   原来：按 updatedAt 降序取第一个 = 「最近活跃的会话」。
  //
  //   实测问题：会话轮转（工具/会话轮转.mjs）创建了新会话并更新了身份卡，
  //   但下次投递时 findSceneSession 仍然返回**旧会话** ——
  //   因为旧会话被投递过，updatedAt 比新会话还新。
  //
  //   后果：轮转白做。实测轮转后 8 个场景的历史仍在 400+ 事件，
  //        因为投递一直往旧会话里塞。
  //
  //   修法：优先选「事件最少」的会话 —— 轮转出的新会话是 0 事件，
  //        天然优先级最高。更新频繁但历史长的旧会话排后面。
  //
  //   次要判据：同事件数时按 updatedAt 降序（保持「新会话优先」）。
  const withCount = await Promise.all(matched.map(async (m) => {
    const sid = m.sessionId || m.id;
    let count = Infinity;
    try {
      const pg = await client.page(sid);
      if (pg && pg.ok && Array.isArray(pg.records)) count = pg.records.length;
    } catch { /* 拿不到就当无穷大，排后面 */ }
    return { sid, count, updatedAt: Number(m.updatedAt || m.createdAt || 0) };
  }));

  withCount.sort((a, b) => {
    if (a.count !== b.count) return a.count - b.count;   // 事件少的优先
    return b.updatedAt - a.updatedAt;                     // 同事件数取更新的
  });

  const chosen = withCount[0];
  return {
    ok: true,
    sessionId: chosen.sid,
    candidates: matched.length,
    eventCount: chosen.count === Infinity ? null : chosen.count,
    all: withCount.map((m) => m.sid),
  };
}

/** 找到或创建场景会话 */
export async function ensureSceneSession(client, sceneId) {
  const found = await findSceneSession(client, sceneId);
  if (!found.ok) return found;
  if (found.sessionId) return { ok: true, sessionId: found.sessionId, created: false };

  const cwd = sceneInjectDir(sceneId);
  if (!fs.existsSync(cwd)) {
    return { ok: false, error: '场景工作目录不存在: ' + cwd + '（先跑 工具/场景注入.mjs）' };
  }
  const c = await client.createSession(cwd);
  if (!c.ok) return c;
  return { ok: true, sessionId: c.sessionId, created: true };
}

/**
 * 等待会话空闲（不在 running 状态）
 *
 * ⚠ 2026-11-10 补（端到端闭环第二次跑失败暴露的）
 *
 *   现象：第二次跑闭环，records 一直停在 79 不变，等了 5 分钟没动静。
 *   根因：上一次的会话还在 background running（running=true），
 *        新投递的任务排进队列，但前一个 turn 没结束。
 *
 *   这不是机制缺陷，是缺少并发控制。
 *   中枢派单前应该确认目标会话空闲，否则任务会堆积。
 *
 * @returns { ok, waited, stillRunning }
 */
export async function waitIdle(client, sessionId, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 60000;
  const pollMs = o.pollMs || 3000;
  const start = Date.now();
  let waited = 0;

  while (Date.now() - start < timeoutMs) {
    const list = await client.listSessions();
    if (!list.ok) return { ok: false, error: list.error };

    const s = list.sessions.find((x) => (x.sessionId || x.id) === sessionId);
    if (!s) return { ok: false, error: '会话不存在: ' + sessionId };

    if (!s.running) return { ok: true, waited };

    await new Promise((r) => setTimeout(r, pollMs));
    waited = Date.now() - start;
  }

  return { ok: false, stillRunning: true, waited, error: '等待 ' + Math.round(timeoutMs / 1000) + ' 秒仍在运行' };
}

// ══════════════════════════════════════════════════════════════
//  投递 + 判完
// ══════════════════════════════════════════════════════════════

/**
 * 构造投递文本
 *
 * 关键：这条文本会作为 user message 进入目标场景会话。
 * 场景 agent 靠 AGENTS.local.md 知道自己是谁，这里只需给任务。
 *
 * 四件套必须齐全（派单机制的要求）：
 *   subject / phenomenon / howto / verify
 */
export function buildDispatchText(d) {
  const L = [];
  L.push('【中枢派单 ' + d.id + '】');
  L.push('');
  L.push('## 任务');
  L.push(d.subject || '(未写标题)');
  L.push('');
  L.push('## 要解决什么');
  L.push(d.phenomenon || '(未写)');
  L.push('');
  L.push('## 怎么做');
  L.push(d.howto || '(未写)');
  L.push('');
  L.push('## 怎么算完成');
  L.push(d.verify || '(未写)');
  L.push('');
  L.push('---');
  L.push('完成后请用下面的命令回执（必须带证据，只说"好了"不算）：');
  L.push('```');
  L.push('node 工具/派单.mjs --ack --id ' + d.id + ' --evidence "产物路径 / 关键输出 / 结果数字"');
  L.push('```');
  return L.join('\n');
}

/**
 * 判断会话最后一轮是否已结束
 *
 * 从 page 记录里找 turn/end 或 turn/start，取最后一个 turn 事件。
 * 如果最后是 turn/end → 已结束
 * 如果最后是 turn/start（无对应 end）→ 还在跑
 */
export function judgeTurnState(records) {
  let lastTurnEvent = null;
  let lastError = null;

  for (const rec of records) {
    const ev = rec.event || rec;
    const type = ev.type || '';
    const data = ev.data || {};

    if (type === 'turn/start') {
      lastTurnEvent = { type: 'start', turn: data.turn, at: ev.time };
    } else if (type === 'turn/end') {
      const reason = data.reason || {};
      if (reason.kind === 'error') {
        lastError = reason.error?.message || reason.failure?.message || 'unknown error';
      } else {
        lastError = null;
      }
      lastTurnEvent = { type: 'end', turn: data.turn, at: ev.time, reason: reason.kind };
    }
  }

  return {
    done: lastTurnEvent ? lastTurnEvent.type === 'end' : false,
    lastEvent: lastTurnEvent,
    lastError,
  };
}

/**
 * 投递一条派单
 *
 * @returns { ok, sessionId, delivered, turnState }
 */
export async function deliverDispatch(client, dispatch, opts) {
  const o = opts || {};
  const sceneId = resolveSceneId(dispatch.to);
  if (!sceneId) return { ok: false, error: '找不到场景: ' + dispatch.to };

  // ① 找/建会话
  const s = await ensureSceneSession(client, sceneId);
  if (!s.ok) return { ok: false, error: s.error, stage: 'session' };

  // ② 确认会话空闲（避免任务堆积）
  //
  //    端到端闭环第二次跑失败暴露：上次会话还在 running，
  //    新任务排进队列但前一个 turn 没结束 → 等 5 分钟无变化。
  //    默认等 90 秒；超时则拒绝投递而不是盲目堆积。
  if (o.waitIdle !== false) {
    const idle = await waitIdle(client, s.sessionId, { timeoutMs: o.idleTimeoutMs || 90000 });
    if (!idle.ok) {
      return {
        ok: false,
        error: '目标会话仍在运行，任务会堆积。' + idle.error,
        stage: 'wait-idle',
        sessionId: s.sessionId,
        busy: true,
      };
    }
  }

  // ③ 投递
  //
  // ⚠ 2026-11-12 加：429 速率限制重试
  //
  //   实测（本地免费网关 magpie-local）：
  //     连续投递 8 个场景，前 3 个成功，后 5 个全是
  //       429 user_model_rate_limited / "SenseNova Token Plan: rps exhausted"
  //     而等 60 秒后重试就恢复了 —— **是速率限制，不是余额**。
  //
  //   原来的行为：一遇 429 就返回 ok:false，派单卡在 created/failed，
  //   看起来像「模型坏了」，其实是打太快。
  //
  //   修法：429 时按指数退避重试（5s → 15s → 30s → 60s），
  //        最多 RATE_LIMIT_RETRIES 次。仍失败才真报错。
  const text = buildDispatchText(dispatch);
  let p = null;
  let attempts = 0;
  for (let i = 0; i <= RATE_LIMIT_RETRIES; i++) {
    attempts = i + 1;
    p = await client.prompt(s.sessionId, text);
    if (p.ok) break;

    // 判断是不是速率限制
    //
    // ⚠ 2026-11-12：判据放宽
    //   实测 p.error 的实际内容是
    //     "投递后本轮未完成（error）: 429: {\"code\":\"user_model_rate_limited\",
    //      \"message\":\"商汤小浣熊: 您的模型请求频率超限，请稍后重试\"...}"
    //   也见过不含数字 429 而只有「频率超限」的版本，所以判据要覆盖多种写法。
    const errStr = String(p.error || '');
    const isRateLimit = /429|rate.?limit|rps exhausted|too many requests|频率超限|请求频率|稍后重试/i.test(errStr);
    if (!isRateLimit || i === RATE_LIMIT_RETRIES) {
      if (!isRateLimit && !p.ok) {
        console.log('  （不是速率限制，不重试）错误: ' + errStr.slice(0, 100));
      }
      break;
    }

    const wait = RATE_LIMIT_BACKOFF_MS[Math.min(i, RATE_LIMIT_BACKOFF_MS.length - 1)];
    console.log('  ⏳ 速率限制（429），等 ' + Math.round(wait / 1000) + ' 秒后重试（第 ' +
      (i + 1) + '/' + RATE_LIMIT_RETRIES + ' 次）…');
    await new Promise((r) => setTimeout(r, wait));
    // 重试前再确认会话空闲
    await waitIdle(client, s.sessionId, { timeoutMs: 60000 });
  }

  if (!p.ok) {
    return {
      ok: false, error: p.error, sessionId: s.sessionId, stage: 'prompt',
      rateLimited: /429|rate.?limit|rps exhausted/i.test(String(p.error || '')),
      attempts,
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  ④ 等任务自然跑完（不是固定 sleep）
  //
  //  ⚠ 2026-11-12 修（据 中枢/闭环断点诊断.md 断点5）：
  //
  //    原来是 `await sleep(o.waitMs || 8000)` —— 固定等 8 秒然后判状态。
  //
  //    后果：AI 任务通常要 1-5 分钟。8 秒时它必然还在跑，
  //          于是判成「仍在运行」，但真正的问题是：
  //          如果传了更大的 waitMs，它也不会「提前结束」——
  //          只是在傻等，等到时间到了再看一眼。
  //          既可能白等（任务早完成了），也可能不够（任务还没完成）。
  //
  //    修法：轮询到「本轮真的结束」为止：
  //      · 看 turn/end 是否出现
  //      · 且读 reason.kind（completed 才是真完成）
  //      · 有上限（maxWaitMs，默认 180 秒）
  //      · 一旦确实结束就立刻返回，不白等
  // ══════════════════════════════════════════════════════════════
  let turnResult = null;
  if (o.waitMs !== 0) {
    const maxWait = o.maxWaitMs || Math.max(o.waitMs || 0, 180000);
    const pollMs = 2000;
    const deadline = Date.now() + maxWait;

    // 记基线：投递前该会话的事件数
    let baseSeq = -1;
    try {
      const pre = await client.page(s.sessionId);
      if (pre && typeof pre.cursor === "number") baseSeq = pre.cursor;
    } catch { /* ignore */ }

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      let pg = null;
      try { pg = await client.page(s.sessionId); } catch { continue; }
      if (!pg) continue;

      const recs = (pg.records || []).map((x) => (x && x.event ? x.event : x)).filter(Boolean);
      const last = recs[recs.length - 1];
      if (!last || last.type !== 'turn/end') continue;
      // 必须是我们投递之后的那一轮
      if (baseSeq >= 0 && typeof last.seq === "number" && last.seq <= baseSeq) continue;

      const kind = (last.data && last.data.reason && last.data.reason.kind) || 'unknown';
      const errMsg = String(
        (last.data && last.data.reason && last.data.reason.error &&
         last.data.reason.error.message) || ''
      );
      turnResult = {
        kind, seq: last.seq, waitedMs: Date.now() - (deadline - maxWait),
        error: errMsg,
        rateLimited: /429|rate.?limit|rps exhausted|频率超限|too many requests/i.test(errMsg),
      };
      break;
    }
  }

  // ── ④b 429 重试（2026-11-12 加）──
  //
  //   ⚠ 关键发现：429 **不在 prompt 的返回值里**，而是在 turn/end 的
  //      data.reason.error.message 里冒出来：
  //        {"kind":"error","error":{"message":"429: {\"code\":\"user_model_rate_limited\"..."}}
  //
  //   所以第一次改在 prompt 处重试是错的 —— 那个分支根本捕获不到。
  //   正确位置是这里：轮次已结束、但结束原因是 429。
  //
  //   实测：连续投递 8 个场景，前 3 成功后 5 个全 429；
  //        等 60 秒重试就恢复 → 是速率限制，不是余额。
  if (turnResult && turnResult.rateLimited && o.retryRateLimit !== false) {
    let retried = 0;
    while (retried < RATE_LIMIT_RETRIES) {
      const wait = RATE_LIMIT_BACKOFF_MS[Math.min(retried, RATE_LIMIT_BACKOFF_MS.length - 1)];
      console.log('  ⏳ 第 ' + (retried + 1) + '/' + RATE_LIMIT_RETRIES +
        ' 次 429 重试，等 ' + Math.round(wait / 1000) + ' 秒…');
      await new Promise((r) => setTimeout(r, wait));
      await waitIdle(client, s.sessionId, { timeoutMs: 60000 });

      const p2 = await client.prompt(s.sessionId, text);
      if (!p2.ok) { retried++; continue; }

      // 再等这一轮结束
      const deadline2 = Date.now() + maxWait;
      let done2 = null;
      while (Date.now() < deadline2) {
        await new Promise((r) => setTimeout(r, pollMs));
        let pg2 = null;
        try { pg2 = await client.page(s.sessionId); } catch { continue; }
        if (!pg2) continue;
        const recs2 = (pg2.records || []).map((x) => (x && x.event ? x.event : x)).filter(Boolean);
        const last2 = recs2[recs2.length - 1];
        if (!last2 || last2.type !== 'turn/end') continue;
        const err2 = String(
          (last2.data && last2.data.reason && last2.data.reason.error &&
           last2.data.reason.error.message) || ''
        );
        done2 = {
          kind: (last2.data && last2.data.reason && last2.data.reason.kind) || 'unknown',
          error: err2,
          rateLimited: /429|rate.?limit|rps exhausted|频率超限|too many requests/i.test(err2),
        };
        break;
      }

      if (done2) {
        turnResult = { ...done2, retried: retried + 1 };
        if (!done2.rateLimited) break;   // 成功或别的错误，停
      }
      retried++;
    }
    if (turnResult) turnResult.totalRetries = retried;
  }
  let state = null;
  if (o.checkState !== false) {
    const pg = await client.page(s.sessionId);
    if (pg.ok) state = judgeTurnState(pg.records);
  }

  return {
    ok: true,
    sessionId: s.sessionId,
    created: s.created,
    scene: sceneId,
    delivered: true,
    turnState: state,
  };
}

// ══════════════════════════════════════════════════════════════
//  CLI（供 派单.mjs 调用，也可独立排查）
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const has = (k) => argv.includes(k);
  const val = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const client = new EngineClient();

  (async () => {
    // ── 自测 ──
    if (has('--selftest')) {
      const R = [];
      const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d ? '  ' + d : '')); };
      console.log('═'.repeat(70));
      console.log('  投递通道 · 自测');
      console.log('═'.repeat(70));
      console.log();

      chk('resolveSceneId 英文 id', resolveSceneId('arch-review') === 'arch-review');
      chk('resolveSceneId 中文名', resolveSceneId('架构梳理') === 'arch-review', String(resolveSceneId('架构梳理')));
      chk('resolveSceneId 无效输入', resolveSceneId('不存在的场景') === null);

      const t = buildDispatchText({
        id: 'd-test', subject: '标题', phenomenon: '现象', howto: '做法', verify: '验收',
      });
      chk('投递文本含四件套', t.includes('标题') && t.includes('现象') && t.includes('做法') && t.includes('验收'));
      chk('投递文本含回执命令', t.includes('--ack') && t.includes('d-test'));

      // judgeTurnState 三种情况
      const ended = judgeTurnState([
        { event: { type: 'turn/start', data: { turn: 1 } } },
        { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'done' } } } },
      ]);
      chk('judgeTurnState: 已结束', ended.done === true);

      const running = judgeTurnState([
        { event: { type: 'turn/start', data: { turn: 1 } } },
        { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'done' } } } },
        { event: { type: 'turn/start', data: { turn: 2 } } },
      ]);
      chk('judgeTurnState: 在跑', running.done === false);

      const errState = judgeTurnState([
        { event: { type: 'turn/start', data: { turn: 1 } } },
        { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'QUOTA' } } } } },
      ]);
      chk('judgeTurnState: 捕获错误', errState.lastError === 'QUOTA', String(errState.lastError));

      chk('引擎端口可解析', Number.isInteger(getEnginePort()), String(getEnginePort()));

      // waitIdle 存在性
      chk('waitIdle 是函数', typeof waitIdle === 'function', typeof waitIdle);

      // 反例：不存在的会话必须报错（不挂死）
      const fakeClient = {
        listSessions: async () => ({ ok: true, sessions: [] }),
      };
      const r1 = await waitIdle(fakeClient, 'session-不存在', { timeoutMs: 500 });
      chk('反例：会话不存在时报错', r1.ok === false && /不存在/.test(r1.error || ''), r1.error || '');

      // 空闲会话应立即返回
      const idleClient = {
        listSessions: async () => ({ ok: true, sessions: [{ sessionId: 'session-x', running: false }] }),
      };
      const r2 = await waitIdle(idleClient, 'session-x', { timeoutMs: 1000 });
      chk('空闲会话立即返回', r2.ok === true && r2.waited < 500, 'waited=' + r2.waited);

      // 运行中的会话应超时报错
      const busyClient = {
        listSessions: async () => ({ ok: true, sessions: [{ sessionId: 'session-y', running: true }] }),
      };
      const r3 = await waitIdle(busyClient, 'session-y', { timeoutMs: 800, pollMs: 200 });
      chk('运行中会话超时报错', r3.ok === false && r3.stillRunning === true, r3.error || '');

      // ⚠ 2026-11-12 加：429 速率限制判据
      //
      //   实测事故：连续投递 8 个场景，前 3 成功，后 5 全是 429
      //   （"user_model_rate_limited" / "rps exhausted" / "频率超限"），
      //   而等 60 秒就恢复 —— 是速率限制，不是余额。
      //   原来一遇 429 就判失败，看起来像「模型坏了」。
      //
      //   这里验「判据能认出各种 429 写法」。
      console.log();
      console.log('【429 速率限制判据】');
      {
        const isRate = (s) => /429|rate.?limit|rps exhausted|too many requests|频率超限|请求频率|稍后重试/i.test(String(s || ''));

        // 正例：真 429 的各种写法
        chk('正例：含 429 数字', isRate('429: user_model_rate_limited'), '');
        chk('正例：rps exhausted', isRate('SenseNova Token Plan: rps exhausted'), '');
        chk('正例：中文频率超限', isRate('商汤小浣熊: 您的模型请求频率超限，请稍后重试'), '');
        chk('正例：too many requests', isRate('429 Too Many Requests'), '');
        chk('正例：rate limit 写法', isRate('rate_limit_error'), '');

        // 反例：不是 429 的不能误判
        chk('反例：余额不足不是 429', !isRate('402: 余额不足，请充值后再使用'), '');
        chk('反例：内容安全不是 429', !isRate('请求命中内容安全策略（网络攻击）'), '');
        chk('反例：空字符串不是 429', !isRate(''), '');
        chk('反例：普通超时不是 429', !isRate('connect timeout'), '');

        // 判据常量
        chk('有重试次数常量', RATE_LIMIT_RETRIES > 0, 'RATE_LIMIT_RETRIES=' + RATE_LIMIT_RETRIES);
        chk('有退避序列', Array.isArray(RATE_LIMIT_BACKOFF_MS) && RATE_LIMIT_BACKOFF_MS.length > 0,
          RATE_LIMIT_BACKOFF_MS.map((x) => x / 1000 + 's').join(' → '));
        chk('退避是递增的',
          RATE_LIMIT_BACKOFF_MS.every((v, i) => i === 0 || v >= RATE_LIMIT_BACKOFF_MS[i - 1]));
      }

      console.log();
      const passed = R.filter(Boolean).length;
      console.log('─'.repeat(70));
      console.log('  自测结果: ' + passed + ' / ' + R.length);
      console.log('─'.repeat(70));
      process.exit(R.every(Boolean) ? 0 : 1);
    }

    // ── 连引擎 ──
    const c = await client.connect();
    if (!c.ok) {
      console.log('✗ 连不上引擎: ' + c.error);
      process.exit(2);
    }
    console.log('引擎: 127.0.0.1:' + client.port + '  ✓\n');

    // ── --scenes：列所有场景的会话状态 ──
    if (has('--scenes')) {
      console.log('═'.repeat(70));
      console.log('  场景会话状态');
      console.log('═'.repeat(70));
      console.log();
      for (const f of fs.readdirSync(SCEN_DIR)) {
        if (!f.endsWith('.json')) continue;
        let j;
        try { j = JSON.parse(readTextSafe(path.join(SCEN_DIR, f))); } catch { continue; }
        if (!j.id) continue;
        const r = await findSceneSession(client, j.id);
        const st = r.sessionId ? '✓ ' + r.sessionId : '✗ 无会话';
        console.log('  ' + (j.name || j.id).padEnd(12) + st);
      }
      process.exit(0);
    }

    // ── --to <scene> --text <text>：直接投递一段文本 ──
    if (has('--to')) {
      const sceneId = resolveSceneId(val('--to'));
      if (!sceneId) { console.log('✗ 找不到场景: ' + val('--to')); process.exit(2); }
      const text = val('--text') || '【测试投递】请回复：收到';
      const s = await ensureSceneSession(client, sceneId);
      if (!s.ok) { console.log('✗ ' + s.error); process.exit(2); }
      console.log('会话: ' + s.sessionId + (s.created ? '（新建）' : '（复用）'));

      // ⚠ 2026-11-12 加：429 速率限制重试
      //
      //   实测问题：CLI 这条路径**不走 deliverDispatch**，所以
      //   deliverDispatch 里加的重试对它无效 —— 连投 8 个场景，
      //   前 3 成功后面全 429，看起来像「模型坏了」。
      //
      //   而 429 是速率限制（等 60 秒就恢复），不该直接判失败。
      //   这里按 5s → 15s → 30s → 60s 退避重试，最多 4 次。
      let p = null;
      for (let i = 0; i <= RATE_LIMIT_RETRIES; i++) {
        p = await client.prompt(s.sessionId, text);
        if (p.ok) break;

        const errStr = String(p.error || '');
        const isRateLimit = /429|rate.?limit|rps exhausted|too many requests|频率超限|请求频率|稍后重试/i.test(errStr);
        if (!isRateLimit || i === RATE_LIMIT_RETRIES) break;

        const wait = RATE_LIMIT_BACKOFF_MS[Math.min(i, RATE_LIMIT_BACKOFF_MS.length - 1)];
        console.log('  ⏳ 速率限制（429），等 ' + Math.round(wait / 1000) +
          ' 秒后重试（第 ' + (i + 1) + '/' + RATE_LIMIT_RETRIES + ' 次）…');
        await new Promise((r) => setTimeout(r, wait));
        await waitIdle(client, s.sessionId, { timeoutMs: 60000 });
      }

      console.log('投递: ' + (p.ok ? '✓ 成功' : '✗ ' + p.error));
      // 429 是「重试后仍失败」才报 2；其他错误也报 2
      process.exit(p.ok ? 0 : 2);
    }

    console.log('用法:');
    console.log('  node 工具/投递通道.mjs --selftest          自测');
    console.log('  node 工具/投递通道.mjs --scenes            列场景会话状态');
    console.log('  node 工具/投递通道.mjs --to <场景> --text "..."  直接投递');
  })().catch((e) => {
    console.error('✗ ' + (e && e.message));
    process.exit(2);
  });
}
