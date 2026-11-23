#!/usr/bin/env node
// 工具/工作区同步.mjs —— 把 workspace.json 的 sessionIds 同步成「场景配置指向的会话」
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（这是「会话绑定」最后一环）
// ══════════════════════════════════════════════════════════════════════
//  引擎侧栏**不是**按目录扫会话渲染的，而是按 `workspace.json` 渲染：
//
//    数据/.dsh/storages/workspace.json
//      tables.workspaces.<workspaceId>.sessionIds = [sessionId, ...]
//
//  也就是说：**一个会话哪怕真实存在，只要没被列进某个 workspace 的
//  sessionIds，它在侧栏里就完全不可见。**
//
//  ──────────────────────────────────────────────────────────────────
//  实测事故（2026-11-13）：
//    会话轮转把「逆向分析」切到新会话 session-82189326，
//    配置（reverse-eng.json）✓ 更新了
//    身份索引（身份索引.json）✓ 更新了
//    新会话也 ✓ 预热了（有标题、blank=false）
//
//    但 会话绑定验证 仍报 7/8：
//      期望 session-82189326  实际 session-587c9493（旧会话）
//
//    查下去：workspace.json 里逆向分析仍是 ["session-587c9493"]，
//    而调研/故障分析更糟 —— 存的是**两个已经不存在的会话 id**。
//
//    → pin 脚本在侧栏 DOM 里找不到新会话（它压根没渲染），
//      于是保留旧值。这就是「配置对了但界面没动」的真因。
//
//  这是第 30 轮同一个坑的更深处：
//    那次修的是「空白会话不被渲染」，这次是「workspace 名单没更新」。
//    两件事叠加，才导致「看起来绑定了，其实是旧会话」。
//
//  用法：
//    node 工具/工作区同步.mjs           只读核对（默认）
//    node 工具/工作区同步.mjs --scan    同只读核对
//    node 工具/工作区同步.mjs --apply   真写
//    node 工具/工作区同步.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const WS_FILE = path.join(DATA, 'storages', 'workspace.json');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const INDEX_FILE = path.join(DATA, '场景记忆', '_共享记忆', '身份索引.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/** 同步模式 */
export const MODES = ['scan', 'apply'];

/**
 * 读场景配置 → 场景中文名 → 期望的 sessionId
 * @returns {Map<string,string>} 中文名 → sessionId
 */
export function readSceneWanted() {
  const out = new Map();
  if (!fs.existsSync(SCEN_DIR)) return out;
  for (const f of fs.readdirSync(SCEN_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8').replace(/^\uFEFF/, ''));
      const ai = (j.panels || []).find((p) => p.type === 'harness');
      const sid = (ai && ai.sessionId) || (j.meta && j.meta.hubSessionId);
      const cn = j.name || j.title;
      if (sid && cn) out.set(String(cn), String(sid));
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * 计算 workspace.json 需要怎么改
 *
 * @param {object} wsJson workspace.json 内容
 * @param {Map<string,string>} wanted 中文名 → 期望 sessionId
 * @param {Set<string>} alive 引擎里真实存在的 sessionId
 * @returns {Array<{workspaceId, scene, oldIds, newIds, change:'update'|'ok'}>}
 */
export function planChanges(wsJson, wanted, alive) {
  const rows = [];
  const workspaces = (wsJson && wsJson.tables && wsJson.tables.workspaces) || {};
  for (const [wsId, w] of Object.entries(workspaces)) {
    const cn = String(w.path || '').split(/[\\/]/).filter(Boolean).pop();
    if (!cn) continue;
    const want = wanted.get(cn);
    const oldIds = Array.isArray(w.sessionIds) ? w.sessionIds.slice() : [];
    // 只留「真实存在」的，再确保期望的那个在第一位
    const aliveOld = oldIds.filter((s) => alive.has(s));

    // ⚠ 2026-11-13 修（只保证「期望的在名单里」不够，还得保证「没有多余的」）
    //
    //   实测事故：
    //     调研 workspace 的 sessionIds 变成 5 个：
    //       ["4f31df13(空)", "2a3df593(空)", "a99594fd(空)", "de4875d1(空)", "35165f92(配置指向)"]
    //     前 4 个都是**界面功能体检反复跑时引擎自动建的空会话**。
    //
    //     而 pin 脚本点击侧栏第一个匹配行，
    //     有时就点到了空会话 → 会话绑定验证报「实际 4f31df13」。
    //
    //   判据应该是：
    //     **有配置指向时，名单里只留那一个**（其它都是垃圾）。
    //     没配置指向时才保留仍存在的其它会话（避免丢历史）。
    let newIds;
    if (want) {
      newIds = [want];                       // 只留期望的，清掉所有多余的
    } else {
      newIds = aliveOld;                     // 没配置就保留仍存在的
    }
    newIds = [...new Set(newIds)];
    // ⚠ 2026-11-13 修（判据用 JSON.stringify 比数组 = 顺序变了也算不一致）
    //
    //   实测：预热/轮转之后反复报「旧 2 → 新 2」「旧 3 → 新 3」——
    //   数量一样、成员也一样，只是**顺序不同**。
    //   而顺序对渲染没有影响（引擎自己会按 updatedAt 排）。
    //
    //   正确判据：**只比集合**。顺序差异不该算不一致，
    //   否则这个检查会永远在「预览模式红 → apply → 又红」之间反复。
    const setEq = (a, b) => {
      const A = new Set(a), B = new Set(b);
      if (A.size !== B.size) return false;
      for (const x of A) if (!B.has(x)) return false;
      return true;
    };
    const same = setEq(newIds, oldIds);
    rows.push({
      workspaceId: wsId,
      scene: cn,
      oldIds,
      newIds,
      want: want || '',
      change: same ? 'ok' : 'update',
    });
  }
  return rows;
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  工作区同步 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】能读场景配置');
  {
    const w = readSceneWanted();
    chk('读到场景数 > 0', w.size > 0, w.size + ' 个');
    chk('每个值都像 sessionId', [...w.values()].every((v) => /^session-/.test(v)));
  }

  console.log();
  console.log('【二】planChanges 逻辑');
  {
    const wsJson = {
      tables: {
        workspaces: {
          w1: { path: 'X/场景记忆/甲场景', sessionIds: ['session-old1', 'session-old2'] },
          w2: { path: 'X/场景记忆/乙场景', sessionIds: ['session-ok'] },
        },
      },
    };
    const wanted = new Map([['甲场景', 'session-new'], ['乙场景', 'session-ok']]);
    const alive = new Set(['session-ok', 'session-new']);   // old1/old2 已死

    const rows = planChanges(wsJson, wanted, alive);
    const A = rows.find((r) => r.scene === '甲场景');
    const B = rows.find((r) => r.scene === '乙场景');

    chk('甲场景：期望的会话排第一', A.newIds[0] === 'session-new', JSON.stringify(A.newIds));
    chk('甲场景：死会话被清掉', !A.newIds.includes('session-old1') && !A.newIds.includes('session-old2'));
    chk('甲场景：判为需要改', A.change === 'update');
    chk('正例：乙场景本来对 → 不改', B.change === 'ok', JSON.stringify(B.newIds));
  }

  console.log();
  console.log('【三】反例：死会话必须被清');
  {
    const wsJson = { tables: { workspaces: { w: { path: 'X/场景记忆/丙', sessionIds: ['session-ghost'] } } } };
    const rows = planChanges(wsJson, new Map([['丙', 'session-really']]), new Set(['session-really']));
    chk('反例：幽灵会话不会留在 newIds', !rows[0].newIds.includes('session-ghost'), JSON.stringify(rows[0].newIds));
    chk('反例：而且会被判为需要改', rows[0].change === 'update');
  }

  console.log();
  console.log('【四】关键：这个工具补的是什么');
  chk('关键：引擎侧栏按 workspace.json 渲染，不在名单里的会话不可见',
    true, '配置/索引对 ≠ 界面能看到');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
function liveSessionIds() {
  // 从 sessions 目录反推（不依赖引擎 RPC，工具要能离线跑）
  const root = path.join(DATA, 'sessions');
  const out = new Set();
  try {
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      for (const it of fs.readdirSync(path.join(root, ws.name), { withFileTypes: true })) {
        if (it.isDirectory() && /^session-/.test(it.name)) out.add(it.name);
      }
    }
  } catch { /* ignore */ }
  return out;
}

function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  if (!fs.existsSync(WS_FILE)) {
    console.log('  ✗ 找不到 workspace.json: ' + WS_FILE);
    process.exit(2);
  }

  const wsJson = JSON.parse(fs.readFileSync(WS_FILE, 'utf8').replace(/^\uFEFF/, ''));
  const wanted = readSceneWanted();
  const alive = liveSessionIds();

  // ⚠ 2026-11-13 修（「alive」不能只看目录存在，还要看它是不是空壳）
  //
  //   实测死循环：
  //     界面功能体检每跑一次 → 在场景里发消息 → 引擎自动建会话 →
  //     留下 blank 空壳（asOf=2，目录里只有几 KB）。
  //     这些空壳「目录存在」所以被 alive 认为是合法会话，
  //     于是它们留在 workspace 名单里 → pin 点到它们 → 绑定错 →
  //     同步一次好了，下次体检又冒出新的空壳 → 又错。
  //
  //   判据修正：**空壳不算「活会话」**。
  //     一个会话如果是空的（没有真实对话），它对「面板该绑哪个会话」
  //     这件事毫无价值，反而会抢 pin 的位置。
  const blankIds = new Set();
  try {
    const root = path.join(DATA, 'sessions');
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      for (const it of fs.readdirSync(path.join(root, ws.name), { withFileTypes: true })) {
        if (!it.isDirectory() || !/^session-/.test(it.name)) continue;
        const p = path.join(root, ws.name, it.name);
        const files = fs.readdirSync(p, { withFileTypes: true }).filter((f) => f.isFile());
        const total = files.reduce((a, f) => a + (fs.statSync(path.join(p, f.name)).size), 0);
        if (total < 2000) blankIds.add(it.name);
      }
    }
  } catch { /* ignore */ }

  // 真正「值得放进名单」的会话 = 存在 且 不是空壳
  const fromPlan = planChanges(wsJson, wanted, alive);
  const rows = fromPlan.map((r) => {
    // 把空壳从 oldIds 里剔掉，再看还是否需要改
    const cleanedOld = r.oldIds.filter((s) => !blankIds.has(s));
    const want = r.want;
    const newIds = want ? [want] : cleanedOld.filter((s) => alive.has(s));
    const setEq = (a, b) => {
      const A = new Set(a), B = new Set(b);
      if (A.size !== B.size) return false;
      for (const x of A) if (!B.has(x)) return false;
      return true;
    };
    return {
      ...r,
      oldIds: r.oldIds,
      newIds: [...new Set(newIds)],
      change: setEq([...new Set(newIds)], r.oldIds) ? 'ok' : 'update',
      blankRemoved: r.oldIds.filter((s) => blankIds.has(s)).length,
    };
  });

  const changes = rows.filter((r) => r.change === 'update');

  console.log('='.repeat(78));
  console.log('  工作区同步 —— 引擎侧栏按 workspace.json 渲染');
  console.log('='.repeat(78));
  console.log();
  console.log('  为什么需要：会话哪怕真实存在，只要没被列进某个 workspace 的');
  console.log('  sessionIds，它在侧栏里就**完全不可见** —— 于是 pin 脚本找不到它，');
  console.log('  面板就留着旧会话。反过来，名单里混进空会话，pin 也可能点到它。');
  console.log();
  console.log('  磁盘上真实存在的会话: ' + alive.size + ' 个');
  console.log('  场景配置期望的映射:   ' + wanted.size + ' 个');
  console.log();

  // ── 额外报告：名单里的「多余会话」和磁盘上的「空会话」 ──
  //
  // ⚠ 2026-11-13 加：这两类垃圾是「pin 点到空会话」的根源。
  //
  //   实测：界面功能体检每跑一次，就会在场景里发一条消息，
  //        引擎自动建一个新会话 → 留下 blank=true 的空壳。
  //        跑几次之后 调研 有 8 个会话（其中 1 个空）、中枢有 9 个（8 个空）。
  //        而 pin 脚本点击侧栏第一个匹配行，有时就点到空壳上。
  //
  //   本工具负责：把 workspace 名单**收敛成配置指向的那一个**，
  //   并把「磁盘上的空会话」列出来（不删，只报，删是用户的决定）。
  const blankDirs = [];
  try {
    const root = path.join(DATA, 'sessions');
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      for (const it of fs.readdirSync(path.join(root, ws.name), { withFileTypes: true })) {
        if (!it.isDirectory() || !/^session-/.test(it.name)) continue;
        const p = path.join(root, ws.name, it.name);
        // 空会话 = 目录里只有极小的文件（没有真实对话内容）
        const files = fs.readdirSync(p, { withFileTypes: true }).filter((f) => f.isFile());
        const total = files.reduce((a, f) => a + (fs.statSync(path.join(p, f.name)).size), 0);
        if (total < 2000) blankDirs.push({ id: it.name, dir: p, bytes: total });
      }
    }
  } catch { /* ignore */ }

  for (const r of rows) {
    const mark = r.change === 'ok' ? '·' : '✗';
    console.log('  ' + mark + ' ' + r.scene.padEnd(12) +
      '旧 ' + r.oldIds.length + ' → 新 ' + r.newIds.length);
    if (r.change === 'update') {
      if (r.want) console.log('      期望: ' + r.want);
      for (const s of r.newIds) console.log('      → ' + s);
      const ghost = r.oldIds.filter((s) => !alive.has(s));
      if (ghost.length) console.log('      （清掉 ' + ghost.length + ' 个不存在的会话引用）');
      const extra = r.oldIds.filter((s) => alive.has(s) && !r.newIds.includes(s));
      if (extra.length) console.log('      （清掉 ' + extra.length + ' 个多余会话引用）');
    }
  }

  console.log();
  console.log('-'.repeat(78));
  console.log('  ' + changes.length + ' / ' + rows.length + ' 个 workspace 需要同步');

  if (blankDirs.length) {
    console.log();
    console.log('  ⚠ 磁盘上有 ' + blankDirs.length + ' 个空会话（< 2KB，没有真实对话）:');
    for (const b of blankDirs.slice(0, 8)) {
      console.log('      ' + b.id.slice(0, 30) + '  ' + b.bytes + 'B');
    }
    if (blankDirs.length > 8) console.log('      ... 还有 ' + (blankDirs.length - 8) + ' 个');
    console.log();
    console.log('  它们不删也不影响（workspace 名单修好后 pin 不会再点到），');
    console.log('  但会占磁盘。清理：node 工具/会话清理.mjs');
  }

  if (!changes.length) {
    console.log();
    console.log('  ✓ workspace.json 与场景配置一致');
    return;
  }

  if (has('apply')) {
    for (const r of changes) {
      const w = wsJson.tables.workspaces[r.workspaceId];
      w.sessionIds = r.newIds;
      w.updatedAt = new Date().toISOString();
    }
    fs.writeFileSync(WS_FILE, JSON.stringify(wsJson, null, 2), 'utf8');
    console.log();
    console.log('  ✓ 已写入 workspace.json（' + changes.length + ' 处）');
    console.log('    ⚠ 需要重启工作台让侧栏重建');
  } else {
    console.log();
    console.log('  预览模式。加 --apply 真写。');
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
