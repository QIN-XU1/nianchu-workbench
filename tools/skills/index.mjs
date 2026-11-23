#!/usr/bin/env node
/**
 * 技能索引层 —— 补齐 A12 机制缺口（对标 hermes 的 index / delta / quarantine）。
 *
 * 起因（第 74 轮）：深查 hermes 技能机制，发现它比我们深：`agent/skill_utils.py`（iter_skill_index_files、
 *   quarantine 隔离、60 字符截断）+ `prompt_builder.py`（_render_skills_index、ctx.register_skill 插件技能）
 *   + `skills_index_delta.py`（索引变化的 delta staging，提示词缓存字节稳定）。
 *   我们原来只有 loader（发现/校验/懒加载），缺：① 紧凑索引 ② 索引 delta ③ 隔离。
 *
 * 本模块补这三样：
 *   renderSkillIndex(skills)      —— 紧凑、**字节稳定**的索引（每技能一行，按 category→name 排序，desc 截断）
 *   diffSkillIndex(prev, next)     —— 相邻两次索引差（added/removed），对应 hermes 的 delta staging
 *   applyQuarantine(skills, q)     —— 隔离：被判隔离的技能不进索引/list/view（对应 hermes quarantine）
 *
 * ⛔ 只做文本与结构，不执行技能内容。
 */
export const INDEX_LIMITS = { descChars: 60 };

/** 紧凑索引：字节稳定（同输入同输出，无时间戳），按 category→name 排序 */
export function renderSkillIndex(skills, { descChars = INDEX_LIMITS.descChars } = {}) {
  const sorted = [...skills].sort((a, b) => {
    const ca = a.category || '未分类', cb = b.category || '未分类';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const lines = [];
  let lastCat = null;
  for (const s of sorted) {
    const cat = s.category || '未分类';
    if (cat !== lastCat) { lines.push(`[${cat}]`); lastCat = cat; }
    const raw = String(s.description || '').replace(/\s+/g, ' ').trim();
    const truncated = raw.length > descChars;
    const desc = truncated ? raw.slice(0, descChars) + '…' : raw;
    lines.push(`- ${s.name} — ${desc}`);
  }
  return { text: lines.join('\n') + '\n', truncatedCount: sorted.filter((s) => String(s.description || '').length > descChars).length };
}

/** 索引差：added / removed / unchanged（对应 hermes 的 index delta staging） */
export function diffSkillIndex(prevNames, nextNames) {
  const p = new Set(prevNames), n = new Set(nextNames);
  const added = [...n].filter((x) => !p.has(x)).sort();
  const removed = [...p].filter((x) => !n.has(x)).sort();
  const unchanged = [...n].filter((x) => p.has(x)).sort();
  return { added, removed, unchanged, changed: added.length + removed.length > 0 };
}

/** 隔离：按 name 过滤掉被隔离的技能（quarantine: [{name, reason}] 或 Set<name>） */
export function applyQuarantine(skills, quarantine) {
  const qset = quarantine instanceof Set ? quarantine : new Set((quarantine || []).map((x) => (typeof x === 'string' ? x : x.name)));
  const kept = [], quarantined = [];
  for (const s of skills) (qset.has(s.name) ? quarantined : kept).push(s);
  return { kept, quarantined };
}