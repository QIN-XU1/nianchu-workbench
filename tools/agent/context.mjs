#!/usr/bin/env node
/**
 * 念初 · 上下文装配（会话历史窗口 + 跨会话记忆召回）
 *
 * ══ 为什么需要 ═══════════════════════════════════════════════
 * 之前 submitTurn 把**全部历史**塞进请求：
 *   · 长会话必然撑爆上下文（不是"可能"，是"一定"）
 *   · 撑爆后不是报错，而是模型开始丢前面的内容 —— 行为变得不可预期
 * 同时 memory 子系统（tools/memory，32KB 的 store + 冲突/保鲜/查询）**完全没被 agent 用过**，
 * 所以「跨会话记忆」这一维一直是空的。
 *
 * 这里补上两件：
 *   ① 历史窗口：按条数 + 字符预算裁剪，**裁掉的部分显式标注**（不静默丢）
 *   ② 记忆召回：按当前这句话去 memory 检索相关条目，拼成一段可引用的「已知事实」
 *
 * ══ 设计取向 ═════════════════════════════════════════════════
 * · 宁可显式写「省略了 N 条」，也不要假装上下文完整 —— 让模型知道信息有缺口。
 * · 记忆是**证据**不是命令：注入时标明来源与时间，模型可以据此判断是否仍然成立。
 * · 拿不到记忆（文件不存在/损坏）就静默降级为空，但会返回 retrievalError 让上层可观测。
 */

import { existsSync } from 'node:fs';
import { loadDb as memLoadDb } from '../memory/query.mjs';
import { effectiveState as effState } from '../memory/store.mjs';
import { planInjection } from './memory-budget.mjs';

/** 粗略 token 估算：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token。够用且不引依赖。 */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x2e80) cjk++;
  }
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

/**
 * 取有界历史。
 *
 * @param {Array<{role:string,content:string}>} messages 完整消息（已按时间升序）
 * @param {object} opts
 * @param {number} [opts.maxTurns=30]   最多保留最近多少轮（一问一答算 2 条）
 * @param {number} [opts.maxTokens=6000] 历史部分 token 预算
 * @returns {{history:Array, dropped:number, droppedChars:number, tokens:number, elided:boolean}}
 */
export function buildHistory(messages, { maxTurns = 30, maxTokens = 6000 } = {}) {
  const chat = (messages || []).filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
  );
  if (chat.length === 0) {
    return { history: [], dropped: 0, droppedChars: 0, tokens: 0, elided: false };
  }

  // 先按轮数截（只看最近 maxTurns*2 条）
  const byTurn = chat.slice(-Math.max(2, maxTurns * 2));

  // 再从**最新**往前累加，直到超出 token 预算
  const kept = [];
  let tokens = 0;
  for (let i = byTurn.length - 1; i >= 0; i--) {
    const m = byTurn[i];
    const t = estimateTokens(m.content);
    if (kept.length > 0 && tokens + t > maxTokens) break;
    kept.unshift(m);
    tokens += t;
  }

  const dropped = chat.length - kept.length;
  const droppedChars = chat.slice(0, chat.length - kept.length)
    .reduce((a, m) => a + m.content.length, 0);

  /**
   * 显式标注省略：把「省略」作为一条 system 消息放最前面。
   * 这样模型知道「前面还有内容但没给它」，而不是以为对话从这里开始。
   */
  const history = dropped > 0
    ? [{ role: 'system', content: `（此前还有 ${dropped} 条较早消息未纳入本次上下文，约 ${droppedChars} 字。如有需要可让用户重述或从记忆检索。）` }, ...kept]
    : kept;

  return { history, dropped, droppedChars, tokens, elided: dropped > 0 };
}

/**
 * 跨会话记忆召回。
 *
 * ══ 为什么不直接用 memory/query.mjs 的 search ══════════════════
 * 它的匹配是**字面子串**：`hay.includes(needle)`。
 * 实测：库里存了「部署目标是 127.0.0.1:47124」，用户问「部署目标是哪个端口」，
 * 因为含空格、词序不同，**一条都搜不到** —— 自然语句下几乎不可用。
 *
 * 所以这里自己做**词元级**匹配（轻量、不引模型）：
 *   · 中文切成 2 字滑窗（bigram），英文按词切
 *   · 命中数计分：key 命中权重 3，value 命中权重 1
 *   · 取 topN，命中 0 的直接不返回（不硬塞）
 * 这不是语义检索，是词法检索 —— 边界如实标注。
 *
 * @param {object} opts
 * @param {number} [opts.limit=6]
 * @param {number} [opts.maxChars=1200]
 */
export function recallMemory(query, { limit = 6, maxChars = 1200 } = {}) {
  const out = { block: '', hits: [], retrievalError: null };
  const q = String(query || '').trim();
  if (!q) return out;

  const terms = tokenize(q);
  if (terms.length === 0) return out;

  try {
    const db = memLoadDb();
    if (!db) return out;
    const entries = Array.isArray(db.entries) ? db.entries : [];
    if (entries.length === 0) return out;

    const now = new Date();
    const scored = [];
    for (const e of entries) {
      const st = effState(e, now);
      // 只召回仍然有效（fresh）的条目；superseded/expired/conflicted 不注入，避免用过期事实
      if (st !== 'fresh') continue;
      const keyS = String(e.key || '').toLowerCase();
      const valS = String(e.value || '').toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (keyS.includes(term)) score += 3;
        else if (valS.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ entry: e, score });
    }
    if (scored.length === 0) return out;

    scored.sort((a, b) => b.score - a.score
      || String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || '')));

    const lines = [];
    let chars = 0;
    for (const { entry } of scored) {
      if (out.hits.length >= limit) break;
      const key = entry.key || '?';
      const value = String(entry.value || '').replace(/\s+/g, ' ').slice(0, 200);
      const when = entry.source || entry.createdAt || '';
      const line = '- [' + key + '] ' + value + (when ? '（来源：' + when + '）' : '');
      if (chars + line.length > maxChars) break;
      lines.push(line);
      chars += line.length;
      out.hits.push({ key, value, score: 0 });
    }
    if (lines.length === 0) return out;
    out.block = [
      '## 已知事实（来自长期记忆，按当前问题检索；可能过时，必要时向用户确认）',
      ...lines,
    ].join('\n');
    return out;
  } catch (e) {
    return { ...out, retrievalError: String(e && e.message ? e.message : e) };
  }
}

/** 轻量分词：中文 2 字滑窗 + 英文/数字按词 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  // 英文/数字词
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  // 中文 bigram（连续汉字）
  for (const m of s.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const run = m[0];
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

/**
 * 组装最终 messages（systemPrompt + 记忆 + 有界历史）。
 * 这是 submitTurn / runWithTools 的统一入口，避免两处各写一套。
 */
export function assembleMessages({
  systemPrompt, messages, userText, memory = true, maxTurns = 30, maxTokens = 6000, memoryLimit = 6,
} = {}) {
  const sysParts = [];
  if (systemPrompt) sysParts.push(String(systemPrompt));

  let memHits = [];
  let retrievalError = null;
  let memoryInjection = null;
  if (memory) {
    /**
     * 记忆注入按 luanyujia 的「记忆三层 + 硬预算」来：
     *   ① core.* 是每轮必注入的铁律，但**受 2KB 预算约束**（超了按最近更新取，其余不注入并报告）
     *   ② 其余作用域的条目**只按当前问题检索**注入，不整库倒进来
     * 这样既不会「每轮烧一堆 token」，也不会「记忆库里有什么就全塞」。
     */
    const db = memLoadDb();
    const corePlan = db ? planInjection(db, 'core') : { injected: [], skipped: 0, chars: 0, cap: 2048, over: false };
    const coreLines = corePlan.injected.map((e) => '- 【铁律】' + String(e.value).replace(/\s+/g, ' '));
    const coreKeys = new Set(corePlan.injected.map((e) => e.key));

    let hitLines = [];
    if (userText) {
      const rec = recallMemory(userText, { limit: memoryLimit });
      // 已经在 core 里注入过的不重复
      hitLines = rec.hits.filter((h) => !coreKeys.has(h.key))
        .map((h) => '- [' + h.key + '] ' + String(h.value).replace(/\s+/g, ' ').slice(0, 200));
      memHits = rec.hits;
      retrievalError = rec.retrievalError;
    }

    const allLines = [...coreLines, ...hitLines];
    if (allLines.length > 0) {
      sysParts.push([
        '## 已知事实（长期记忆；可能过时，必要时向用户确认）',
        ...allLines,
      ].join('\n'));
    }
    memoryInjection = {
      coreInjected: corePlan.injected.length,
      coreSkipped: corePlan.skipped,
      coreChars: corePlan.chars,
      coreCap: corePlan.cap,
      recalled: hitLines.length,
    };
  }

  const win = buildHistory(messages, { maxTurns, maxTokens });
  const msgs = [];
  if (sysParts.length) msgs.push({ role: 'system', content: sysParts.join('\n\n') });
  msgs.push(...win.history);
  return { messages: msgs, memoryHits: memHits, retrievalError, history: win, memoryInjection };
}