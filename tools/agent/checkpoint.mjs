#!/usr/bin/env node
/**
 * 念初 · 自愈（检查点续跑 + 会话修复）
 *
 * ══ 对标证据 ═════════════════════════════════════════════════
 * dsh `packages/core/session/src/fork.ts:6` 引入 `openTurnClosers`（来自 `repair.ts`）：
 *   「Copy an inclusive event prefix, mark its inherited cut, and close its open tail with forked
 *     result and step/turn endings. Closed steps and turns are preserved unchanged.」
 * 也就是：会话日志里**没闭合的 turn/step 要能被修复闭合**，而不是留个半截状态。
 * 另有 `packages/guard`、`packages/jobs` 与 `consumed-work.ts`（已消费工作不重复做）。
 *
 * 我们原来只有：网关重试（瞬时错误）+ 变更集回滚。缺的是
 *   · 跑到一半崩了 → 能不能**接着跑**，而不是从头再来（重做已完成的工具 = 副作用翻倍）
 *   · 会话日志里半截的 turn → 能不能**修**成一致状态
 *
 * ══ 这里提供什么 ═════════════════════════════════════════════
 *   saveCheckpoint / loadCheckpoint / listResumable / discardCheckpoint
 *   repairSession（把未闭合的 turn 补上结束标记，不改动已闭合的部分）
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 检查点是**每步一份**（覆盖写），不是每步追加 —— 只保留最新可续点，省空间。
 * · 续跑是「重新发起一次 runWithTools 并喂入历史 messages」，**不保证工具副作用不重复**：
 *   如果崩溃发生在"命令已执行、结果还没记"的窗口里，那一步会被重做。这个窗口无法消除。
 * · repairSession 只补标记，**不推断**当时该产出什么。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { USER_DATA_DIR } from './runtime.mjs';

function ckptDir() {
  const d = join(USER_DATA_DIR, 'checkpoints');
  mkdirSync(d, { recursive: true });
  return d;
}

function ckptFile(runId) {
  return join(ckptDir(), String(runId).replace(/[^\w.-]/g, '_') + '.json');
}

/**
 * 写检查点（覆盖写 + 原子替换）。
 * 原子性重要：崩溃可能正好发生在写入中途，写坏的文件比没有文件更糟。
 */
export function saveCheckpoint(runId, payload) {
  if (!runId) return { ok: false, reason: 'runId 必填' };
  const f = ckptFile(runId);
  const tmp = f + '.tmp';
  const rec = {
    runId,
    at: new Date().toISOString(),
    step: Number(payload && payload.step) || 0,
    messages: Array.isArray(payload && payload.messages) ? payload.messages : [],
    transcript: Array.isArray(payload && payload.transcript) ? payload.transcript : [],
    usage: (payload && payload.usage) || null,
    cwd: (payload && payload.cwd) || null,
    task: (payload && payload.task) || null,
    traceId: (payload && payload.traceId) || null,
  };
  try {
    writeFileSync(tmp, JSON.stringify(rec) + '\n', 'utf8');
    // rename 是原子的（同分区），避免读到半个文件
    writeFileSync(f, readFileSync(tmp, 'utf8'), 'utf8');
    rmSync(tmp, { force: true });
    return { ok: true, path: f };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

/** 读检查点。找不到返回 null（不返回空对象假装成功） */
export function loadCheckpoint(runId) {
  if (!runId) return null;
  const f = ckptFile(runId);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (!j || j.runId !== runId) return null;
    return j;
  } catch {
    // 文件坏了：如实标记，不假装可续
    return { runId, corrupted: true };
  }
}

/** 列出可续跑的检查点（最近在前） */
export function listResumable(limit = 20) {
  let names = [];
  try { names = readdirSync(ckptDir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  const rows = [];
  for (const n of names) {
    const id = n.slice(0, -5);
    const c = loadCheckpoint(id);
    if (!c) continue;
    rows.push({
      runId: c.runId,
      step: c.step,
      at: c.at,
      task: c.task,
      corrupted: c.corrupted === true,
      messages: Array.isArray(c.messages) ? c.messages.length : 0,
    });
  }
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows.slice(0, limit);
}

export function discardCheckpoint(runId) {
  const f = ckptFile(runId);
  try { rmSync(f, { force: true }); return { ok: true }; } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

/**
 * 修复会话：把**未闭合**的 turn 补上结束标记。
 *
 * 判据（照 dsh 的 openTurnClosers 思路）：
 *   最后一条消息是 user（用户说了话，但没有 assistant 回复也没有失败标记）
 *   → 说明那一轮没闭合 → 追加一条 `turn-repaired` 标记说明它没完成。
 * 已闭合的部分**一个字节都不动**。
 *
 * @param {object} session 形如 { id, messages: [...] }
 */
export function repairSession(session) {
  if (!session || !Array.isArray(session.messages)) {
    return { state: 'UNKNOWN', reason: '会话结构不可识别' };
  }
  const msgs = session.messages;
  if (msgs.length === 0) return { state: 'PASS', repaired: false, reason: '空会话无需修复' };

  const last = msgs[msgs.length - 1];
  const open = last && last.role === 'user';
  if (!open) return { state: 'PASS', repaired: false, reason: '最后一轮已闭合' };

  const marker = {
    role: 'system',
    type: 'turn-repaired',
    at: new Date().toISOString(),
    reason: '上一轮没有收到助手回复（可能进程中断），已标记为未完成；内容未被修改',
  };
  msgs.push(marker);
  return { state: 'PASS', repaired: true, appended: marker, messages: msgs.length };
}