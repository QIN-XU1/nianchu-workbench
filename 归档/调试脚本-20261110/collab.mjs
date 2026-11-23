/**
 * 场景间协作（Cross-Scene Collaboration）
 *
 * 用户需求 1 + 7.7：
 *   "支持多场景协同运作"
 *   "让场景之间知道彼此的存在，可以互相对话，互相协作"
 *
 * 照 luanyujia 的三条纪律：
 *   ① **修改权五档**：别人的地盘只许写"请求"，一个字都不许写别人的内容
 *   ② **派单 ≠ 公告**：派单要指定承接者；公告是让大家知道
 *   ③ **请求四件套**：现象 + 该谁做 + 怎么做 + 做完怎么验
 *
 * 本模块只做三件事：
 *   - notify(target, msg)      发给某场景的通知
 *   - request(target, req)     请求（带四件套校验）
 *   - inbox(sceneId)           看自己收到的
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const SCENES = join(HERE, 'scenes');
const COLLAB_DIR = join(HERE, 'collab');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

function ensure(dir) { mkdirSync(dir, { recursive: true }); }

/** 已存在的场景 id */
export function sceneIds() {
  try {
    return readdirSync(SCENES)
      .filter(d => {
        try { return statSync(join(SCENES, d)).isDirectory(); } catch { return false; }
      })
      .filter(d => existsSync(join(SCENES, d, 'scene.json')));
  } catch { return []; }
}

/** 每个场景自己的信箱目录 */
function inboxDir(sceneId) { return join(COLLAB_DIR, sceneId, 'inbox'); }
function outboxDir(sceneId) { return join(COLLAB_DIR, sceneId, 'outbox'); }

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/**
 * 发通知（公告式：让对方知道，但不要求它动手）
 */
export function notify(from, to, message) {
  const ids = sceneIds();
  if (!ids.includes(to)) {
    return { ok: false, error: `不存在的场景：${to}（可用：${ids.join(', ')}）` };
  }
  if (from === to) return { ok: false, error: '不能给自己发通知' };

  const entry = {
    kind: 'notice',
    from, to,
    at: new Date().toISOString(),
    message,
  };

  // 写进对方信箱
  const d = inboxDir(to);
  ensure(d);
  writeFileSync(join(d, `${stamp()}-from-${from}.json`), JSON.stringify(entry, null, 2), 'utf8');

  // 同时写进自己的发件箱（可审计）
  const od = outboxDir(from);
  ensure(od);
  writeFileSync(join(od, `${stamp()}-to-${to}.json`), JSON.stringify(entry, null, 2), 'utf8');

  // 同时进通知板（让所有人知道）
  postNoticeToBoard(from, to, message);

  return { ok: true, from, to, message };
}

/**
 * 发请求（要求对方做事）
 *
 * 必须满足"请求四件套"：现象 + 该谁做 + 怎么做 + 做完怎么验
 * 空泛的请求 = 对方无法执行 = 等于没提
 */
export function request(from, to, req) {
  const ids = sceneIds();
  if (!ids.includes(to)) {
    return { ok: false, error: `不存在的场景：${to}（可用：${ids.join(', ')}）` };
  }
  if (from === to) return { ok: false, error: '不能给自己发请求' };

  // 四件套校验
  const missing = [];
  if (!req.phenomenon || !req.phenomenon.trim()) missing.push('现象');
  if (!req.owner || !req.owner.trim()) missing.push('该谁做');
  if (!req.how || !req.how.trim()) missing.push('怎么做');
  if (!req.verify || !req.verify.trim()) missing.push('做完怎么验');

  if (missing.length > 0) {
    return {
      ok: false,
      error: `请求不完整，缺：${missing.join(', ')}`,
      hint: '空泛的请求 = 对方无法执行 = 等于没提。请补齐四件套。',
    };
  }

  const entry = {
    kind: 'request',
    from, to,
    at: new Date().toISOString(),
    phenomenon: req.phenomenon.trim(),
    owner: req.owner.trim(),
    how: req.how.trim(),
    verify: req.verify.trim(),
    priority: req.priority || 'normal',
  };

  const d = inboxDir(to);
  ensure(d);
  writeFileSync(join(d, `${stamp()}-req-from-${from}.json`), JSON.stringify(entry, null, 2), 'utf8');

  const od = outboxDir(from);
  ensure(od);
  writeFileSync(join(od, `${stamp()}-req-to-${to}.json`), JSON.stringify(entry, null, 2), 'utf8');

  // 请求也要进待办板（否则会被忘掉）
  addTodoToBoard(`${from}→${to}：${req.phenomenon.slice(0, 40)}`, from);

  return { ok: true, from, to, entry };
}

/** 看某场景收到的东西 */
export function inbox(sceneId) {
  const d = inboxDir(sceneId);
  if (!existsSync(d)) return [];
  const files = readdirSync(d).filter(f => f.endsWith('.json')).sort().reverse();
  return files.map(f => {
    try { return { file: f, ...JSON.parse(readFileSync(join(d, f), 'utf8')) }; }
    catch { return null; }
  }).filter(Boolean);
}

/** 未读请求数（用于首屏提醒） */
export function pendingRequests(sceneId) {
  return inbox(sceneId).filter(x => x.kind === 'request').length;
}

// ---- 与 boards.mjs 的轻耦合（避免循环 import，这里内联最小实现）----
function postNoticeToBoard(from, to, message) {
  try {
    const boardFile = join(HERE, 'boards', '通知板.md');
    ensure(join(HERE, 'boards'));
    const line = [
      `## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${from} → ${to}`,
      '',
      `- **${message}**`,
      '',
    ].join('\n');

    let body = existsSync(boardFile) ? readFileSync(boardFile, 'utf8')
      : '# 通知板\n\n> 记录"发生了什么"。最新在上。\n\n';
    const i = body.indexOf('\n\n，');
    const headerEnd = body.indexOf('> ');
    const splitAt = headerEnd >= 0 ? body.indexOf('\n\n', headerEnd) : -1;
    const head = splitAt >= 0 ? body.slice(0, splitAt + 2) : body;
    const rest = splitAt >= 0 ? body.slice(splitAt + 2) : '';
    writeFileSync(boardFile, head + line + rest, 'utf8');
  } catch { /* 板挂了不影响协作 */ }
}

function addTodoToBoard(item, by) {
  try {
    const f = join(HERE, 'boards', '待办板.md');
    ensure(join(HERE, 'boards'));
    let body = existsSync(f) ? readFileSync(f, 'utf8')
      : '# 待办板\n\n> 全机唯一落点。同一件只许一行。\n\n| 事项 | 负责 | 场景 | 加入日期 | 来源 |\n|---|---|---|---|---|\n\n';
    if (body.includes(`| ${item} |`)) return;
    body = body.trimEnd() + `\n| ${item} | - | - | ${new Date().toISOString().slice(0, 10)} | ${by} |\n`;
    writeFileSync(f, body, 'utf8');
  } catch { /* ignore */ }
}

// ---------------- CLI ----------------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/collab.mjs');
if (isDirect) {
  const [, , cmd, ...args] = process.argv;

  if (cmd === 'scenes' || !cmd) {
    const ids = sceneIds();
    console.log(`${C.bold}场景清单${C.reset}（${ids.length} 个）\n`);
    for (const id of ids) {
      const p = pendingRequests(id);
      const tag = p > 0 ? `  ${C.yellow}${p} 个待处理请求${C.reset}` : '';
      console.log(`  ${id.padEnd(24)}${tag}`);
    }
    process.exit(0);
  }

  if (cmd === 'notify') {
    const [from, to, ...msg] = args;
    if (!from || !to || msg.length === 0) { console.log('用法：node collab.mjs notify <from> <to> "<消息>"'); process.exit(2); }
    const r = notify(from, to, msg.join(' '));
    if (!r.ok) { console.log(`${C.red}✗ ${r.error}${C.reset}`); process.exit(1); }
    console.log(`${C.green}✓${C.reset} ${from} → ${to} 通知已发`);
    process.exit(0);
  }

  if (cmd === 'request') {
    const [from, to, ...rest] = args;
    if (!from || !to) { console.log('用法：node collab.mjs request <from> <to> --phenomenon "..." --owner "..." --how "..." --verify "..."'); process.exit(2); }
    const req = {};
    for (const a of rest) {
      const m = a.match(/--(\w+)=(.*)/);
      if (m) req[m[1]] = m[2];
    }
    const r = request(from, to, req);
    if (!r.ok) {
      console.log(`${C.red}✗ ${r.error}${C.reset}`);
      if (r.hint) console.log(`${C.dim}  ${r.hint}${C.reset}`);
      process.exit(1);
    }
    console.log(`${C.green}✓${C.reset} ${from} → ${to} 请求已发（四件套齐全）`);
    process.exit(0);
  }

  if (cmd === 'inbox') {
    const scene = args[0];
    if (!scene) { console.log('用法：node collab.mjs inbox <sceneId>'); process.exit(2); }
    const items = inbox(scene);
    if (items.length === 0) { console.log(`${C.dim}${scene} 的信箱是空的${C.reset}`); process.exit(0); }
    console.log(`${C.bold}${scene} 的信箱${C.reset}（${items.length} 条）\n`);
    for (const it of items) {
      const kindTag = it.kind === 'request' ? `${C.yellow}[请求]` : `${C.dim}[通知]`;
      console.log(`${kindTag}${C.reset} 来自 ${it.from}  ${C.dim}${it.at}${C.reset}`);
      if (it.kind === 'request') {
        console.log(`  现象：${it.phenomenon}`);
        console.log(`  该谁做：${it.owner}`);
        console.log(`  怎么做：${it.how}`);
        console.log(`  怎么验：${it.verify}`);
      } else {
        console.log(`  ${it.message}`);
      }
      console.log('');
    }
    process.exit(0);
  }

  if (cmd === 'selftest') {
    console.log(`${C.bold}协作自检${C.reset}\n`);

    // ★自检前先拍快照，结束后整体恢复★
    //   （这是本轮实测教训：只删"含 selftest 字样"的文件不够，
    //     outbox 结构与待办板里的自检行都会残留）
    const { snapshotDirs } = await import('./hygiene.mjs');
    const snap = snapshotDirs([COLLAB_DIR, join(HERE, 'boards')]);
    let pass = 0, total = 0;
    const chk = (name, ok, detail) => { total++; if (ok) pass++; console.log(`${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${name.padEnd(30)} ${detail}`); };

    const ids = sceneIds();
    const a = ids[0], b = ids[1];
    if (!a || !b) { console.log(`${C.red}场景不足 2 个，无法自检${C.reset}`); process.exit(1); }

    // 1 请求四件套强制
    const r1 = request(a, b, {});
    chk('缺四件套必须拒绝', !r1.ok && /缺/.test(r1.error), r1.error || '');

    // 2 完整请求可发
    const r2 = request(a, b, {
      phenomenon: '自检：索引漏登', owner: b, how: '跑 refresh 后补登', verify: 'check 归零',
    });
    chk('完整请求可发', r2.ok, r2.ok ? '已发' : r2.error);

    // 3 收件箱能看到
    const inb = inbox(b);
    chk('对方信箱能收到', inb.length > 0, `${inb.length} 条`);

    // 4 不能给自己发
    const r4 = notify(a, a, '自检');
    chk('不能给自己发', !r4.ok, r4.error || '');

    // 5 不存在的场景拒绝
    const r5 = notify(a, 'no-such-scene', '自检');
    chk('不存在的场景拒绝', !r5.ok, r5.error || '');

    // ★整体恢复快照★（比逐文件删更可靠）
    snap.restore();

  // 下面这段保留作为兜底（若快照恢复也失败）
    try {
      const { unlinkSync, rmSync } = await import('node:fs');
      for (const kind of ['inbox', 'outbox']) {
        for (const d of [a, b]) {
          const dir = join(COLLAB_DIR, d, kind);
          if (!existsSync(dir)) continue;
          for (const f of readdirSync(dir)) {
            if (f.includes('selftest') || readFileSync(join(dir, f), 'utf8').includes('自检')) {
              try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
            }
          }
          // 清空目录也删掉
          if (readdirSync(dir).length === 0) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
        }
        // 场景目录空则删
        const sceneDir = join(COLLAB_DIR, d);
        if (existsSync(sceneDir) && readdirSync(sceneDir).length === 0) {
          try { rmSync(sceneDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
      // 整个 collab 空则删
      if (existsSync(COLLAB_DIR) && readdirSync(COLLAB_DIR).length === 0) {
        try { rmSync(COLLAB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    console.log(`\n===== 协作自检：${pass}/${total} =====`);
    process.exit(pass === total ? 0 : 1);
  }

  console.log('用法：');
  console.log('  node collab.mjs scenes                              场景清单');
  console.log('  node collab.mjs notify <from> <to> "<消息>"          发通知');
  console.log('  node collab.mjs request <from> <to> --phenomenon=... --owner=... --how=... --verify=...');
  console.log('  node collab.mjs inbox <sceneId>                     看信箱');
  console.log('  node collab.mjs selftest                            自检');
  process.exit(2);
}
