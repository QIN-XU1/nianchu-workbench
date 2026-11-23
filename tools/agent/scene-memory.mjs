#!/usr/bin/env node
/**
 * 念初 · 场景隔离记忆（D4 多场景）
 *
 * ══ 为什么需要 ═════════════════════════════════════════════════
 * D4 判决看的不只是「界面上有几个 tab」，而是**多场景之间有没有隔离模型**。
 * 参照 omp-studio（matrix D4）：「工作区 + 会话 + 停靠面板多场景：WorkspaceTree +
 * 项目/会话历史 useProjectHistories、面板由 dock/types.ts 的 PanelDefinition 注册」——
 * 关键点是**每个工作区有自己的历史**，不是同一个界面换皮。
 *
 * 我们原来记忆是全局一个池子：场景 A 记的东西，场景 B 也能搜到。
 * 那不叫多场景，叫多标签。
 *
 * ══ 这里做什么 ═════════════════════════════════════════════
 *   key 约定 `scene.<sceneId>.<key>`，检索时**只在本场景内搜**。
 *   core.* 仍是全局（铁律要人人可见），其余 scene/project 受隔离约束。
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 隔离是**命名空间级**的，不是权限级：知道 sceneId 就能读到（本地单用户产品，
 *   不做账号隔离是早先明确的目标边界）。
 * · 只隔离记忆；工具、工作目录仍共享。
 */
import { load as memLoad, save as memSave, put as memPut, effectiveState } from '../memory/store.mjs';
import { tokenize } from './context.mjs';

const PREFIX = 'scene.';

/** 从 key 里解析场景 id；不是场景键返回 null */
export function sceneIdOf(key) {
  const k = String(key || '');
  if (!k.startsWith(PREFIX)) return null;
  const rest = k.slice(PREFIX.length);
  const i = rest.indexOf('.');
  if (i <= 0) return null;
  return rest.slice(0, i);
}

/** 场景键的完整 key */
export function sceneKey(sceneId, key) {
  if (!sceneId || !key) throw new Error('sceneId 与 key 都必填');
  return PREFIX + String(sceneId) + '.' + String(key);
}

/** 写一条场景记忆 */
export function putScene(sceneId, key, value, { source = 'scene', ttlSec = null } = {}) {
  const db = memLoad();
  memPut(db, {
    key: sceneKey(sceneId, key),
    value,
    source,
    by: 'scene:' + sceneId,
    onConflict: 'supersede',
    ttlSec,
  });
  memSave(db);
  return { ok: true, key: sceneKey(sceneId, key) };
}

/** 列出某场景的全部有效条目（不外泄别的场景） */
export function listScene(sceneId, now = new Date()) {
  const db = memLoad();
  const entries = Array.isArray(db && db.entries) ? db.entries : [];
  return entries
    .filter((e) => sceneIdOf(e.key) === sceneId && effectiveState(e, now) === 'fresh')
    .map((e) => ({ key: String(e.key).slice((PREFIX + sceneId + '.').length), value: e.value, at: e.updatedAt || e.createdAt }));
}

/**
 * 在**指定场景内**检索。
 * 返回的命中一定属于该场景；core.* 作为全局铁律单独返回（可选）。
 */
export function recallScene(sceneId, query, { limit = 6, includeCore = false } = {}) {
  const q = String(query || '').trim();
  const out = { hits: [], core: [], retrievalError: null };
  if (!q) return out;
  const terms = tokenize(q);
  if (terms.length === 0) return out;

  try {
    const db = memLoad();
    const entries = Array.isArray(db && db.entries) ? db.entries : [];
    const now = new Date();
    const scored = [];
    for (const e of entries) {
      if (effectiveState(e, now) !== 'fresh') continue;
      const sid = sceneIdOf(e.key);
      const isCore = String(e.key).startsWith('core.');
      if (!isCore && sid !== sceneId) continue;   // ★ 隔离：别的场景一律不看
      if (isCore && !includeCore) continue;
      const hay = (String(e.key) + ' ' + String(e.value || '')).toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      if (score > 0) scored.push({ e, score, isCore });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const { e, isCore } of scored.slice(0, limit)) {
      const rec = {
        key: isCore ? e.key : String(e.key).slice((PREFIX + sceneId + '.').length),
        value: e.value,
      };
      (isCore ? out.core : out.hits).push(rec);
    }
    return out;
  } catch (err) {
    return { ...out, retrievalError: String(err && err.message ? err.message : err) };
  }
}