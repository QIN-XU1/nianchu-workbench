/**
 * 共享层四块板（Shared Boards）
 *
 * 照 luanyujia 的设计：四块板各回答一个问题，因为**更新频率不同、读者不同、责任不同**。
 *
 *   | 板 | 回答 | 更新频率 |
 *   |---|---|---|
 *   | 通知板 | 发生了什么 | 一天几十条 |
 *   | 待办板 | 该做什么（全机唯一落点） | 一天几条 |
 *   | 总索引 | 东西在哪 | 一周几条 |
 *   | 体检结果 | 机器健康吗 | 一周一次 |
 *
 * 为什么必须分开（原文的真实教训）：
 *   "看板一天几十条，一周就把索引和体检顶到看不见的地方。之后没人再往下翻。"
 *
 * 关键纪律：
 *   - 待办：任何场景加一行，**同一件只许一行**，做完删行
 *   - 通知：最新在上，每场景只在自己记忆里留 ≤5 条摘要
 *   - 索引：只追加，不删别人的行
 *   - 体检：只显示上一次（覆盖写）
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

const HERE = import.meta.dirname;
const BOARD_DIR = join(HERE, 'boards');

const FILES = {
  notices: join(BOARD_DIR, '通知板.md'),
  todos: join(BOARD_DIR, '待办板.md'),
  index: join(BOARD_DIR, '总索引.md'),
  health: join(BOARD_DIR, '体检结果.json'),
};

function ensure() { mkdirSync(BOARD_DIR, { recursive: true }); }

function readBoard(kind) {
  const p = FILES[kind];
  if (!existsSync(p)) return kind === 'health' ? { at: null, items: [] } : '';
  try {
    if (kind === 'health') return JSON.parse(readFileSync(p, 'utf8'));
    return readFileSync(p, 'utf8');
  } catch {
    return kind === 'health' ? { at: null, items: [] } : '';
  }
}

// ---------- 通知板 ----------
export function postNotice({ scene, summary, detail = '', by = 'system' }) {
  ensure();
  const text = readBoard('notices');
  const entry = [
    `## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${scene}`,
    '',
    `- **${summary}**`,
    detail ? `- ${detail}` : '',
    `- 发布：${by}`,
    '',
  ].filter(Boolean).join('\n');

  // 最新在上
  const body = text || '# 通知板\n\n> 记录"发生了什么"。最新在上。每场景只在自己记忆里留 ≤5 条摘要。\n\n';
  const headerEnd = body.indexOf('\n\n', body.indexOf('> '));
  const head = headerEnd >= 0 ? body.slice(0, headerEnd + 2) : body;
  const rest = headerEnd >= 0 ? body.slice(headerEnd + 2) : '';

  const merged = head + entry + rest;
  writeFileSync(FILES.notices, merged, 'utf8');

  // 统计：该场景在通知板里的条数
  const count = (merged.match(new RegExp(`· ${scene}\\n`, 'g')) || []).length;
  return { ok: true, file: FILES.notices, sceneCount: count, warn: count > 5 ? `该场景已有 ${count} 条通知（建议只在自己记忆里留 ≤5 条摘要）` : null };
}

// ---------- 待办板 ----------
export function addTodo({ item, owner = '', by = 'system', scene = '' }) {
  ensure();
  const key = item.trim();
  if (!key) return { ok: false, error: '待办内容不能为空' };

  const text = readBoard('todos');
  const existing = parseTodos(text);

  // 同一件只许一行
  const dup = existing.find(t => t.item === key);
  if (dup) return { ok: true, duplicate: true, note: `已存在（第 ${dup.line} 行），未重复添加`, item: key };

  const line = `| ${key} | ${owner || '-'} | ${scene || '-'} | ${new Date().toISOString().slice(0, 10)} | ${by} |`;

  let body = text;
  if (!body) {
    body = [
      '# 待办板', '',
      '> 记录"该做什么"。**全机唯一落点**：任何场景加一行，同一件只许一行，做完删行。', '',
      '| 事项 | 负责 | 场景 | 加入日期 | 来源 |',
      '|---|---|---|---|---|', '',
    ].join('\n');
  }
  body = body.trimEnd() + '\n' + line + '\n';
  writeFileSync(FILES.todos, body, 'utf8');
  return { ok: true, added: true, item: key, total: existing.length + 1 };
}

export function parseTodos(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((l, i) => {
    const m = l.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
    if (!m) return;
    if (m[1] === '事项' || m[1].includes('---')) return;
    out.push({ item: m[1], owner: m[2], scene: m[3], date: m[4], by: m[5], line: i + 1 });
  });
  return out;
}

export function closeTodo(item) {
  const text = readBoard('todos');
  const lines = String(text || '').split(/\r?\n/);
  const key = item.trim();
  const before = lines.length;
  const kept = lines.filter(l => {
    const m = l.match(/^\|\s*(.+?)\s*\|/);
    return !(m && m[1].trim() === key);
  });
  if (kept.length === before) return { ok: false, error: `没有这条待办：${key}` };
  writeFileSync(FILES.todos, kept.join('\n'), 'utf8');
  return { ok: true, closed: key, remaining: parseTodos(kept.join('\n')).length };
}

// ---------- 总索引 ----------
export function indexEntry({ kind, name, path, note = '', by = 'system' }) {
  ensure();
  const text = readBoard('index');
  let body = text;
  if (!body) {
    body = [
      '# 总索引', '',
      '> 记录"东西在哪"。只追加，不删别人的行。', '',
      '| 类型 | 名称 | 位置 | 说明 | 登记 |',
      '|---|---|---|---|---|', '',
    ].join('\n');
  }
  // 同一路径不重复登记
  if (body.includes(`| ${path} |`)) {
    return { ok: true, duplicate: true, note: '该路径已登记' };
  }
  const line = `| ${kind} | ${name} | ${path} | ${note} | ${new Date().toISOString().slice(0, 10)} |`;
  body = body.trimEnd() + '\n' + line + '\n';
  writeFileSync(FILES.index, body, 'utf8');
  return { ok: true, added: true, kind, name };
}

// ---------- 体检结果 ----------
export function writeHealth(health) {
  ensure();
  const data = { at: new Date().toISOString(), ...health };
  writeFileSync(FILES.health, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, at: data.at };
}

export function readHealth() {
  return readBoard('health');
}

// ---------- 汇总 ----------
export function summary() {
  const todos = parseTodos(readBoard('todos'));
  const notices = readBoard('notices');
  const noticeCount = (String(notices).match(/^## /gm) || []).length;
  const index = readBoard('index');
  const indexCount = (String(index).match(/^\| (?!类型|---)/gm) || []).length;
  const health = readBoard('health');

  return {
    notices: noticeCount,
    todos: todos.length,
    todoItems: todos.map(t => t.item),
    index: indexCount,
    healthAt: health.at || null,
  };
}

// ---------- CLI ----------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/boards.mjs');
if (isDirect) {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
  const [, , cmd, ...args] = process.argv;

  if (cmd === 'summary' || !cmd) {
    const s = summary();
    console.log(`${C.bold}共享层四块板${C.reset} · ${C.dim}各回答一个问题${C.reset}\n`);
    console.log(`  ${C.bold}通知板${C.reset}   发生了什么        ${C.dim}${s.notices} 条${C.reset}`);
    console.log(`  ${C.bold}待办板${C.reset}   该做什么          ${C.dim}${s.todos} 条${C.reset}`);
    for (const t of s.todoItems) console.log(`      · ${t}`);
    console.log(`  ${C.bold}总索引${C.reset}   东西在哪          ${C.dim}${s.index} 条${C.reset}`);
    console.log(`  ${C.bold}体检${C.reset}     机器健康吗        ${C.dim}${s.healthAt || '（无）'}${C.reset}`);
    process.exit(0);
  }

  if (cmd === 'notice') {
    const [scene, summary, detail] = args;
    if (!scene || !summary) { console.log('用法：node boards.mjs notice <场景> "<摘要>" ["<细节>"]'); process.exit(2); }
    const r = postNotice({ scene, summary, detail, by: 'cli' });
    console.log(`${C.green}✓${C.reset} 通知已发${r.warn ? '\n  ' + C.yellow + r.warn + C.reset : ''}`);
    process.exit(0);
  }

  if (cmd === 'todo') {
    const [item, owner] = args;
    if (!item) { console.log('用法：node boards.mjs todo "<事项>" [负责]'); process.exit(2); }
    const r = addTodo({ item, owner, by: 'cli' });
    if (!r.ok) { console.log(`${C.red}✗ ${r.error}${C.reset}`); process.exit(1); }
    console.log(r.duplicate ? `${C.yellow}已存在，未重复添加${C.reset}  ${r.note}` : `${C.green}✓${C.reset} 已加入待办（共 ${r.total} 条）`);
    process.exit(0);
  }

  if (cmd === 'done') {
    const item = args.join(' ');
    const r = closeTodo(item);
    if (!r.ok) { console.log(`${C.red}✗ ${r.error}${C.reset}`); process.exit(1); }
    console.log(`${C.green}✓${C.reset} 已关闭「${r.closed}」（剩 ${r.remaining} 条）`);
    process.exit(0);
  }

  if (cmd === 'index') {
    const [kind, name, path, note] = args;
    if (!kind || !name || !path) { console.log('用法：node boards.mjs index <类型> <名称> <位置> [说明]'); process.exit(2); }
    const r = indexEntry({ kind, name, path, note, by: 'cli' });
    console.log(r.duplicate ? `${C.yellow}已登记${C.reset}` : `${C.green}✓${C.reset} 已登记索引`);
    process.exit(0);
  }

  if (cmd === 'selftest') {
    // 自检四块板的关键纪律
    console.log(`${C.bold}四块板自检${C.reset}\n`);
    let pass = 0, total = 0;
    const chk = (name, ok, detail) => { total++; if (ok) pass++; console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name.padEnd(26)} ${detail}`); };

    // ★用统一快照（比手工 backup 更可靠）★
    const { snapshotDir } = await import('./hygiene.mjs');
    const snaps = [snapshotDir(BOARD_DIR)];
    const snapAll = { restore() { for (const s of snaps) s.restore(); } };

    // 1 待办去重
    const t1 = addTodo({ item: '自检待办 A', by: 'selftest' });
    const t2 = addTodo({ item: '自检待办 A', by: 'selftest' });
    chk('待办同一件只许一行', t1.added && t2.duplicate, `第一次 added=${t1.added} 第二次 dup=${t2.duplicate}`);

    // 2 关闭待办（只验证"自检那条"被删掉，不要求全板为空）
    const beforeClose = parseTodos(readBoard('todos')).length;
    const c1 = closeTodo('自检待办 A');
    const afterTodos = parseTodos(readBoard('todos'));
    const stillThere = afterTodos.some(x => x.item === '自检待办 A');
    chk('待办做完可关行', c1.ok && !stillThere, `关闭=${c1.ok} 该条还在=${stillThere} 板上前=${beforeClose} 后=${afterTodos.length}`);

    // 3 通知最新在上
    postNotice({ scene: 'selftest', summary: '第一条', by: 'selftest' });
    postNotice({ scene: 'selftest', summary: '第二条', by: 'selftest' });
    const nText = readBoard('notices');
    const i1 = nText.indexOf('第一条'), i2 = nText.indexOf('第二条');
    chk('通知最新在上', i2 >= 0 && i1 >= 0 && i2 < i1, `第二条位置=${i2} 第一条=${i1}`);

    // 4 索引去重（用每次唯一的路径，避免上次残留干扰）
    const uniq = 'selftest/x-' + Date.now();
    const x1 = indexEntry({ kind: 'test', name: 'n1', path: uniq, by: 'selftest' });
    const x2 = indexEntry({ kind: 'test', name: 'n2', path: uniq, by: 'selftest' });
    chk('索引同路径不重复', !!x1.added && !!x2.duplicate, `第一次 added=${x1.added} 第二次 dup=${x2.duplicate}`);

    // ★整体恢复快照★
    snapAll.restore();
    chk('四块板文件独立', true, '通知/待办/索引/体检 各一个文件');

    console.log(`\n===== 四块板自检：${pass}/${total} =====`);
    process.exit(pass === total ? 0 : 1);
  }

  console.log('用法：');
  console.log('  node boards.mjs summary                          四块板概览');
  console.log('  node boards.mjs notice <场景> "<摘要>" [细节]     发通知');
  console.log('  node boards.mjs todo "<事项>" [负责]              加待办');
  console.log('  node boards.mjs done "<事项>"                     关待办');
  console.log('  node boards.mjs index <类型> <名称> <位置> [说明]  登记索引');
  console.log('  node boards.mjs selftest                          自检');
  process.exit(2);
}
