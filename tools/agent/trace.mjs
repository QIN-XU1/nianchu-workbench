#!/usr/bin/env node
/**
 * 念初 · 决策级 trace（一次 agent 运行 = 一个 trace，内部有 span 树）
 *
 * ══ 为什么需要（A16）══
 * 矩阵里 A16「审计与决策级 trace」我们是「部分」，dsh 也是「部分」，openclaw 是「有」。
 * 我们原来只有 transcript（一段数组）和台账（一个 json），问题是：
 *   · 不同运行之间**没有关联 id**，事后没法把「这次模型调用」和「那次工具执行」串起来
 *   · 没有**耗时/父子关系**，看不出一个工具慢在哪、嵌套在哪
 *   · 失败没有独立记录点，只能靠翻文本
 *
 * 这里补的是最小可用的一套：traceId + span（kind/duration/ok/parent）+ 落盘 + 可查。
 * 不是 OpenTelemetry（不引依赖、不接 collector），但**结构与它同构**：
 *   trace → spans[]，span 有 spanId / parentSpanId / start / end / durationMs / attributes。
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 不是 OTel：没有 exporter、没有分布式上下文传播、没有采样策略。
 * · 落盘是 JSONL 追加，没有轮转（量大时需要 prune）。
 * · 只记录我们自己的 agent 循环；HTTP/DB 之类的自动埋点没有。
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { USER_DATA_DIR } from './runtime.mjs';

function dir() {
  const d = join(USER_DATA_DIR, 'traces');
  mkdirSync(d, { recursive: true });
  return d;
}

function fileOf(traceId) {
  return join(dir(), String(traceId).replace(/[^\w.-]/g, '_') + '.jsonl');
}

/** 开一个 trace；返回句柄，用来记 span */
export function beginTrace({ name = 'agent-run', attributes = {} } = {}) {
  // 第 219 轮：节流自动清理旧 trace（默认保留 500 条 / 30 天），防止目录无界增长
  try { maybeAutoPruneTraces(); } catch { /* 清理失败不影响开 trace，下一次再试 */ }
  const traceId = 'tr-' + randomUUID().replace(/-/g, '').slice(0, 16);
  const startedAt = new Date().toISOString();
  const spans = [];
  let spanSeq = 0;
  let closed = false;

  function write(rec) {
    try {
      appendFileSync(fileOf(traceId), JSON.stringify(rec) + '\n', 'utf8');
    } catch { /* 落盘失败不影响运行，但结果里会标 persisted=false */ }
  }

  const handle = {
    traceId,
    name,
    startedAt,
    attributes,
    get spans() { return spans; },

    /**
     * 记一个 span。用 `await withSpan(...)` 包住耗时操作；
     * 也可以在操作完成后用 `recordSpan(...)` 补记。
     */
    async withSpan(kind, attrs, fn) {
      const spanId = 'sp' + String(++spanSeq).padStart(3, '0');
      const t0 = Date.now();
      const startAt = new Date(t0).toISOString();
      let ok = true;
      let error = null;
      try {
        const out = await fn();
        return out;
      } catch (e) {
        ok = false;
        error = String(e && e.message ? e.message : e);
        throw e;
      } finally {
        const t1 = Date.now();
        const span = {
          traceId, spanId, parentSpanId: attrs && attrs.parentSpanId ? String(attrs.parentSpanId) : null,
          kind, ok, error,
          startAt, endAt: new Date(t1).toISOString(), durationMs: t1 - t0,
          attributes: (attrs && attrs.attributes) || {},
        };
        spans.push(span);
        write({ t: 'span', ...span });
      }
    },

    recordSpan(kind, { ok = true, durationMs = 0, attributes = {}, parentSpanId = null, error = null } = {}) {
      const spanId = 'sp' + String(++spanSeq).padStart(3, '0');
      const span = {
        traceId, spanId, parentSpanId: parentSpanId ? String(parentSpanId) : null,
        kind, ok, error,
        startAt: new Date().toISOString(), endAt: new Date().toISOString(),
        durationMs, attributes,
      };
      spans.push(span);
      write({ t: 'span', ...span });
      return span;
    },

    end({ state, reason, attributes: extra } = {}) {
      if (closed) return summary();
      closed = true;
      const summaryRec = {
        t: 'trace',
        traceId, name,
        startedAt,
        endedAt: new Date().toISOString(),
        state: state || 'UNKNOWN',
        reason: reason || null,
        attributes: { ...attributes, ...(extra || {}) },
        spanCount: spans.length,
        failedSpans: spans.filter((s) => !s.ok).length,
      };
      write(summaryRec);
      return summaryRec;
    },
  };

  function summary() {
    return {
      t: 'trace', traceId, name, startedAt,
      state: 'UNKNOWN', spanCount: spans.length,
      failedSpans: spans.filter((s) => !s.ok).length,
    };
  }

  write({ t: 'trace-start', traceId, name, startedAt, attributes });
  return handle;
}

/** 读一个 trace（含所有 span）。找不到返回 null —— 不返回空对象假装成功 */
export function getTrace(traceId) {
  if (!traceId) return null;
  const f = fileOf(traceId);
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  let head = null;
  let tail = null;
  const spans = [];
  for (const ln of lines) {
    let rec;
    try { rec = JSON.parse(ln); } catch { continue; }
    if (rec.t === 'trace-start') head = rec;
    else if (rec.t === 'trace') tail = rec;
    else if (rec.t === 'span') spans.push(rec);
  }
  if (!head && spans.length === 0) return null;
  return {
    traceId,
    name: (head && head.name) || (tail && tail.name) || '?',
    startedAt: (head && head.startedAt) || null,
    endedAt: (tail && tail.endedAt) || null,
    state: (tail && tail.state) || 'UNKNOWN',
    attributes: (head && head.attributes) || {},
    spanCount: spans.length,
    failedSpans: spans.filter((s) => !s.ok).length,
    spans,
    persisted: true,
  };
}

/** 列出最近的 trace 摘要（按文件修改时间倒序） */
export function listTraces(limit = 20) {
  let names = [];
  try {
    names = readdirSync(dir()).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const rows = [];
  for (const f of names) {
    const id = f.slice(0, -6);
    const tr = getTrace(id);
    if (tr) rows.push({
      traceId: tr.traceId, name: tr.name, startedAt: tr.startedAt, endedAt: tr.endedAt,
      state: tr.state, spanCount: tr.spanCount, failedSpans: tr.failedSpans,
    });
  }
  rows.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return rows.slice(0, limit);
}

/** 统计：给界面/体检看 */
export function traceStats() {
  const all = listTraces(1000);
  const byState = {};
  let spans = 0;
  let failed = 0;
  for (const r of all) {
    byState[r.state] = (byState[r.state] || 0) + 1;
    spans += r.spanCount;
    failed += r.failedSpans;
  }
  return { traces: all.length, spans, failedSpans: failed, byState };
}

/**
 * trace 保留策略（第 219 轮补）。
 *
 * 【为什么需要】此前 traces 目录**没有任何清理**——实测累积到 2026 个 .jsonl
 * （全是我反复跑 verify 产生的）。会话/变更集都有保留策略，唯独 trace 没有，
 * 结果是磁盘无界增长，而且没人会去看。
 *
 * 可用环境变量控制：
 *   NIANCHU_TRACE_AUTOPRUNE=0      关掉
 *   NIANCHU_TRACE_KEEP=500         条数阈值
 *   NIANCHU_TRACE_DAYS=30          天数阈值
 *   NIANCHU_TRACE_PRUNE_INTERVAL_MS=600000  节流间隔
 */
export function pruneTraces({ maxCount = 500, maxAgeDays = 30, nowMs = Date.now() } = {}) {
  let removed = 0;
  let kept = 0;
  const d = dir();
  const rows = readdirSync(d)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const p = join(d, f);
      let mtime = 0;
      try { mtime = statSync(p).mtimeMs; } catch { mtime = 0; /* 取不到 mtime 就当 0，仅用于按年龄清理 */ }
      return { p, mtime };
    });
  rows.sort((a, b) => b.mtime - a.mtime);
  const cutoff = nowMs - maxAgeDays * 24 * 3600 * 1000;
  for (let i = 0; i < rows.length; i++) {
    const tooMany = i >= maxCount;
    const tooOld = rows[i].mtime > 0 && rows[i].mtime < cutoff;
    if (tooMany || tooOld) {
      try { unlinkSync(rows[i].p); removed++; } catch { kept++; /* 删不掉就留着，下次再试 */ }
    } else {
      kept++;
    }
  }
  return { removed, kept };
}

let lastTracePruneAt = 0;

/** 节流自动清理：每次 beginTrace 时看一眼，10 分钟内只扫一次目录 */
export function maybeAutoPruneTraces({ force = false, nowMs = Date.now() } = {}) {
  if (process.env.NIANCHU_TRACE_AUTOPRUNE === '0') return { ran: false, reason: 'disabled' };
  const interval = Number(process.env.NIANCHU_TRACE_PRUNE_INTERVAL_MS) || 10 * 60 * 1000;
  if (!force && nowMs - lastTracePruneAt < interval) return { ran: false, reason: 'throttled' };
  lastTracePruneAt = nowMs;
  const maxCount = Number(process.env.NIANCHU_TRACE_KEEP) || 500;
  const maxAgeDays = Number(process.env.NIANCHU_TRACE_DAYS) || 30;
  return { ran: true, ...pruneTraces({ maxCount, maxAgeDays, nowMs }) };
}