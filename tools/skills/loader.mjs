#!/usr/bin/env node
/**
 * 技能装载器 —— A12 技能/插件生态 自研实现
 *
 * 原来我们只有"清单读取"（gen-snapshot 扫目录生成快照），**不提供运行时装载**。
 * 本模块补上真正的装载能力：
 *   发现（扫 SKILL.md）→ 解析 frontmatter → 契约校验 → 按需装载正文（懒加载）
 *
 * 设计要点（对齐参照系统的技能生态，但按我们的规矩）：
 *  - **frontmatter 必填 name + description**；缺任一 ⇒ 拒绝装载（不静默跳过）。
 *  - **name 必须与目录名一致**（防止"看起来装了其实指错"）。
 *  - **正文懒加载**：发现阶段只读 frontmatter（省上下文），
 *    `load()` 才读全文 —— 这对应"只有 name+description 进注入目录，正文按需读"。
 *  - **体量红线**：正文 > 12KB ⇒ WARN（提示拆分，不阻断）。
 *  - 重复 name ⇒ 拒绝（不静默覆盖）。
 *
 * ⛔ 不做越界拦截：本模块只装载/校验文本，不执行技能里的任何命令；执行靠宿主。
 */
import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = { bodyBytes: 12 * 1024 };

/** 解析 SKILL.md 的 frontmatter（极简 YAML：仅取顶层 key: value） */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { ok: false, issues: [{ level: 'error', code: 'no_frontmatter', message: '缺少 --- 包裹的 frontmatter' }] };
  const raw = m[1];
  const body = m[2] || '';
  const fields = {};
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { ok: true, fields, body, issues: [] };
}

/** 校验一份技能（frontmatter + 目录名一致性 + 体量） */
export function validateSkill(dirName, text) {
  const issues = [];
  const fm = parseFrontmatter(text);
  if (!fm.ok) return { ok: false, issues: fm.issues };
  const { fields, body } = fm;
  if (!fields.name) issues.push({ level: 'error', code: 'missing_name', message: 'frontmatter 缺 name' });
  if (!fields.description) issues.push({ level: 'error', code: 'missing_description', message: 'frontmatter 缺 description' });
  if (fields.name && dirName && fields.name !== dirName) {
    issues.push({ level: 'error', code: 'name_mismatch', message: `name(${fields.name}) 与目录名(${dirName}) 不一致` });
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > LIMITS.bodyBytes) {
    issues.push({ level: 'warn', code: 'body_too_large', message: `正文 ${bytes}B > ${LIMITS.bodyBytes}B（建议拆 reference）` });
  }
  return { ok: issues.every((i) => i.level !== 'error'), issues, fields, bodyBytes: bytes };
}

/** 技能装载器 */
export function createSkillLoader(roots) {
  const found = new Map(); // name -> { dir, file, fields, bodyBytes, issues }
  const issues = [];

  function scan(root) {
    if (!fs.existsSync(root)) return;
    for (const dir of fs.readdirSync(root)) {
      const dirPath = path.join(root, dir);
      let st;
      try { st = fs.statSync(dirPath); } catch { continue; }
      if (!st.isDirectory()) continue;
      const file = path.join(dirPath, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
        issues.push({ level: 'error', code: 'read_fail', message: dir + ' 读失败：' + e.message });
        continue;
      }
      const v = validateSkill(dir, text);
      if (!v.ok) { for (const i of v.issues) issues.push({ ...i, message: dir + ' :: ' + i.message }); continue; }
      for (const i of v.issues) if (i.level === 'warn') issues.push({ ...i, message: dir + ' :: ' + i.message });
      const name = v.fields.name;
      if (found.has(name)) {
        issues.push({ level: 'error', code: 'dup_skill', message: '重复技能 name：' + name });
        continue;
      }
      found.set(name, { dir: dirPath, file, fields: v.fields, bodyBytes: v.bodyBytes });
    }
  }

  return {
    scanAll() { for (const r of roots) scan(r); return this; },
    /** 发现阶段只暴露 name + description（对应"只进注入目录"） */
    list() {
      return [...found.entries()].map(([name, v]) => ({ name, description: v.fields.description, category: v.fields.category || '未分类' }));
    },
    /** 按分类聚合（供注册表/索引使用） */
    byCategory() {
      const m = new Map();
      for (const s of this.list()) {
        if (!m.has(s.category)) m.set(s.category, []);
        m.get(s.category).push({ name: s.name, description: s.description });
      }
      return m;
    },
    /** 按需装载正文（懒加载） */
    load(name) {
      const v = found.get(name);
      if (!v) throw new Error('技能不存在：' + name);
      const text = fs.readFileSync(v.file, 'utf8');
      const fm = parseFrontmatter(text);
      return { name, description: v.fields.description, body: fm.body || '', path: v.file };
    },
    stats() { return { count: found.size, names: [...found.keys()].sort(), issues }; },
  };
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const REPO = path.resolve(import.meta.dirname, '../..');
  const roots = [path.join(REPO, 'prototype/scenes'), path.join(REPO, '.claude/skills')];
  const loader = createSkillLoader(roots).scanAll();
  const st = loader.stats();
  const errs = st.issues.filter((i) => i.level === 'error');
  console.log('  技能装载器 · 扫描 ' + roots.map((r) => path.relative(REPO, r)).join(' + '));
  console.log('  发现技能 ' + st.count + ' 个：' + st.names.join(', '));
  for (const s of loader.list()) console.log('    · ' + s.name + ' — ' + String(s.description).slice(0, 60));
  for (const i of st.issues) console.log('    ' + (i.level === 'error' ? '✗' : '⚠') + ' ' + i.message);
  const state = errs.length ? 'FAIL' : (st.count > 0 ? 'PASS' : 'UNKNOWN');
  console.log('\n  四态: ' + state);
  process.exit(state === 'FAIL' ? 1 : state === 'UNKNOWN' ? 2 : 0);
}
