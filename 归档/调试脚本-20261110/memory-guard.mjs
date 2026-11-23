/**
 * 记忆体量红线检查器（需求 3 + 6 的最小实现）
 *
 * 用户要的红线（原话）：
 *   - 主文件不许超过 25KB
 *   - 其中"当前交接"那一段不许超过 4KB
 *   - 超了就把旧内容搬进归档
 *   - 每次开场只读开头那几段
 *   - 换会话时把进度覆盖写进当前交接
 *
 * 本模块只做三件事：
 *   1. measure(path)   —— 量出主文件大小、各分节大小
 *   2. check(path)     —— 判定是否超红线，超了给差异集合
 *   3. archive(path)   —— 把已完结分节搬进 归档/（保留审计）
 *
 * 为什么先做这个：
 *   记忆是工作台的地基 —— 界面要显示它、桥的结果要落进它、协作要靠它。
 *   没有"体量红线"，记忆一定膨胀到没人读（这是 luanyujia 的真实教训：
 *   "曾经有一份场景记忆涨到 40 KB，结果没人读，交接形同虚设"）。
 */

import {
  existsSync, statSync, readFileSync, writeFileSync, mkdirSync,
  copyFileSync, readdirSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const LIMITS = {
  mainBytes: 25 * 1024,        // 主文件 ≤25KB
  handoffBytes: 4 * 1024,      // §〇 交接段 ≤4KB
  projectBytes: 8 * 1024,      // 单项目记忆 ≤8KB
};

const HANDOFF_MARKERS = [
  '## §〇 当前交接',
  '## §0 当前交接',
  '## 当前交接',
  '# 当前交接',
];

/** 按 markdown 分节切分（## 开头为界） */
export function splitSections(text) {
  // 统一换行（Windows CRLF / 老 Mac CR 都归一成 \n）
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const sections = [];
  let cur = { level: 0, title: '(文件头)', body: [] };

  let started = false;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      // 第一个标题前的空行/内容作为文件头（只在有实际内容时才保留）
      if (!started) {
        const head = cur.body.join('\n').trim();
        if (head) sections.push({ level: 0, title: '(文件头)', body: cur.body });
        started = true;
      } else if (cur.body.length > 0 || cur.level > 0) {
        sections.push(cur);
      }
      cur = { level: m[1].length, title: m[2].trim(), body: [line] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.length > 0) sections.push(cur);
  return sections;
}

/** 找"当前交接"段 */
export function findHandoff(text) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const startIdx = lines.findIndex(l => {
    const m = l.match(/^(#{1,6})\s+(.*)$/);
    if (!m) return false;
    return m[2].includes('当前交接');
  });
  if (startIdx < 0) return null;

  const startMatch = lines[startIdx].match(/^(#{1,6})\s+(.*)$/);
  const level = startMatch[1].length;
  const title = startMatch[2].trim();

  // 向下收集，直到遇到「同级或更高级」的标题
  const body = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && m[1].length <= level) break;
    body.push(lines[i]);
  }
  return { level, title, body };
}

const bytes = s => Buffer.byteLength(s, 'utf8');

/** 量一个记忆文件 */
export function measure(path) {
  if (!existsSync(path)) {
    return { path, exists: false, error: '文件不存在' };
  }
  const text = readFileSync(path, 'utf8');
  const st = statSync(path);
  const sections = splitSections(text);
  const handoff = findHandoff(text);

  const sectionSizes = sections.map(s => ({
    title: s.title,
    level: s.level,
    bytes: bytes(s.body.join('\n')),
  }));

  return {
    path,
    exists: true,
    bytes: st.size,
    bytesUtf8: bytes(text),
    mtime: st.mtimeMs,
    sections: sectionSizes,
    handoff: handoff ? { title: handoff.title, bytes: bytes(handoff.body.join('\n')) } : null,
  };
}

/** 判定是否超红线；返回差异集合（不是布尔） */
export function check(path, limits = LIMITS) {
  const m = measure(path);
  if (!m.exists) {
    return { ok: false, path, problems: [`文件不存在：${path}`], measured: m };
  }

  const problems = [];

  if (m.bytesUtf8 > limits.mainBytes) {
    const over = m.bytesUtf8 - limits.mainBytes;
    problems.push(`主文件超红线 ${fmt(over)}（${fmt(m.bytesUtf8)} > ${fmt(limits.mainBytes)}）`);
  }

  if (m.handoff === null) {
    problems.push('缺少「§〇 当前交接」段 —— 换会话后无法接上');
  } else if (m.handoff.bytes > limits.handoffBytes) {
    const over = m.handoff.bytes - limits.handoffBytes;
    problems.push(`交接段超红线 ${fmt(over)}（${fmt(m.handoff.bytes)} > ${fmt(limits.handoffBytes)}）`);
  }

  return { ok: problems.length === 0, path, problems, measured: m };
}

/** 把「非交接、非核心」的旧分节搬进归档，主文件保留入口 + 指针 */
export function archive(path, { keepSections = ['核心职责', '当前交接'], dryRun = true } = {}) {
  const m = measure(path);
  if (!m.exists) return { ok: false, error: '文件不存在' };

  const text = readFileSync(path, 'utf8');

  // 按顶层分节（level<=2）切，子标题（###及以下）跟随其父节
  const raw = splitSections(text);
  const topSections = [];
  for (const s of raw) {
    if (s.level === 0 || s.level <= 2) topSections.push({ level: s.level, title: s.title, body: [...s.body] });
    else if (topSections.length > 0) topSections[topSections.length - 1].body.push(...s.body);
    else topSections.push({ level: 0, title: '(文件头)', body: [...s.body] });
  }

  const kept = [];
  const moved = [];
  for (const s of topSections) {
    // 文件头、主标题（level<=1）、以及名字匹配保留清单的，一律保留
    const isMainTitle = s.level <= 1;
    const matchesKeep = keepSections.some(k => s.title.includes(k)) ||
                        keepSections.some(k => k.includes(s.title));
    const keep = s.level === 0 || isMainTitle || matchesKeep;
    if (keep) kept.push(s);
    else moved.push(s);
  }

  if (moved.length === 0) {
    return { ok: true, moved: 0, note: '没有可归档的分节' };
  }

  const archiveDir = join(dirname(path), '归档');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const archiveFile = join(archiveDir, `${basename(path, '.md')}.${stamp}.md`);

  const movedText = moved.map(s => s.body.join('\n')).join('\n\n');
  const pointerLines = moved.map(s => `- ${s.title}（已归档）`);

  const newText = [
    ...kept.map(s => s.body.join('\n')),
    '',
    '## 已归档分节（指针）',
    '',
    ...pointerLines,
    '',
    `指针：拿到了归档文件 \`归档/${basename(archiveFile)}\` 再读。`,
  ].join('\n');

  const result = {
    ok: true,
    moved: moved.length,
    keptTitles: kept.map(s => s.title),
    movedTitles: moved.map(s => s.title),
    archiveFile,
    beforeBytes: bytes(text),
    afterBytes: bytes(newText),
  };

  if (dryRun) {
    result.dryRun = true;
    return result;
  }

  // 先快照，再动手（luanyujia 的硬规矩："先快照再动手，否则无法证明没丢"）
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(archiveFile, movedText, 'utf8');
  const snapshot = join(archiveDir, `${basename(path, '.md')}.${stamp}.snapshot.md`);
  writeFileSync(snapshot, text, 'utf8');
  writeFileSync(path, newText, 'utf8');

  // 审计记录（只追加）
  const audit = join(archiveDir, '归档审计.jsonl');
  const line = JSON.stringify({
    at: new Date().toISOString(),
    file: path,
    archiveFile,
    snapshotHash: createHash('sha256').update(text).digest('hex').slice(0, 12),
    movedTitles: result.movedTitles,
    beforeBytes: result.beforeBytes,
    afterBytes: result.afterBytes,
  });
  const prev = existsSync(audit) ? readFileSync(audit, 'utf8') : '';
  writeFileSync(audit, prev + line + '\n', 'utf8');

  result.audit = audit;
  result.snapshot = snapshot;
  return result;
}

/** 验证归档没有丢内容：搬前非归档行 == 搬后非归档行 */
export function verifyArchive(path, archiveResult) {
  if (!archiveResult.snapshot || !existsSync(archiveResult.snapshot)) {
    return { ok: false, error: '没有快照，无法证明' };
  }
  const norm = s => s.replace(/\r\n?/g, '\n');
  const before = norm(readFileSync(archiveResult.snapshot, 'utf8'));
  const after = norm(readFileSync(path, 'utf8'));
  const archiveText = norm(readFileSync(archiveResult.archiveFile, 'utf8'));

  // 粗校验：before 里每个非空行，要么还在 after，要么进了 archive
  const beforeLines = before.split('\n').filter(l => l.trim());
  const combined = new Set([...after.split('\n'), ...archiveText.split('\n')]);
  const missing = beforeLines.filter(l => !combined.has(l));

  return {
    ok: missing.length === 0,
    checkedLines: beforeLines.length,
    missing: missing.slice(0, 10),
  };
}

function fmt(b) {
  if (b >= 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${b}B`;
}

function fmtSize(b) { return fmt(b); }
