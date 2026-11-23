#!/usr/bin/env node
/**
 * 场景三方一致 —— isHub / first 这类「同一个事实存三处」的对账
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么要有这个工具
 * ══════════════════════════════════════════════════════════════
 *
 *  2026-11-11 实测发现一个真实缺陷：
 *
 *  枢纽（中枢）的「我是入口」这个事实，存在三个地方：
 *    ① sceneboard/scenes/hub.json   → isHub: true      ✅
 *    ② 外壳/scenarios/hub.json       → first: true      ✅
 *    ③ 数据/.dsh/场景记忆/_共享记忆/索引.json → **缺失**  ❌
 *
 *  而 main.js 的 listScenarios() **只读 ③**：
 *    isHub: !!a.isHub    →  全部 false
 *
 *  后果链：
 *    · 排序不优先中枢
 *    · index.js 第 238 行 `find(s => s.isHub) || r.items[0]`
 *    · → 兜底到 r.items[0]（按字母序 = arch-review = 架构梳理）
 *    · → **启动时进的不是中枢，是架构梳理**
 *
 *  参考项目全局铁律 §1：
 *  「两处判据 = 两份结论 = 早晚打架」
 *
 * ══════════════════════════════════════════════════════════════
 *  查什么
 * ══════════════════════════════════════════════════════════════
 *
 *  ① 中枢：三个地方都要标 isHub / first
 *  ② 每个场景：索引里的 name 要和配置里的 name 一致
 *  ③ 每个场景：索引里的 panel 要在场景配置里真实存在
 *  ④ 每个场景：sceneboard 契约 id 要和配置 id 一致
 *  ⑤ 每个场景：会话三处对账（配置 panels[].sessionId /
 *              身份索引.json rows[].sessionId / 引擎真实会话目录）
 *
 * ══════════════════════════════════════════════════════════════
 *  ⚠ 2026-11-12 修：原来只报「不一致」，没定「谁是权威」
 *
 *  原判据：发现两边取值不同就 problems.push，**不说该信谁**。
 *  错在哪：这类检查一旦没有权威方向，两个方向都会打架 ——
 *         检查器说「你不一样」，重建工具按另一头重建，
 *         下次跑又不一样，来回翻烙饼（本项目已踩过这个坑：
 *         索引表和配置表指向的会话都真实存在，但完全不同，
 *         任何单向检查都不报错）。
 *  改成：**明确声明权威源 = 外壳/scenarios/<id>.json**，
 *         其余两处是镜像，只允许「跟随」。
 *         不一致时报「索引未跟随配置」，并给出唯一修法：
 *         把配置里的值抄到索引（`--fix --apply`），
 *         绝不反向覆盖配置。
 *
 *  为什么配置是权威（依据 工具/身份索引重建.mjs 自己的注释）：
 *    「场景配置里的 sessionId 是『用户实际看到的面板绑定的会话』，
 *      它是唯一权威来源。索引表只是它的镜像，不该自己选。」
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/三方一致.mjs
 *  node 工具/三方一致.mjs --json
 *  node 工具/三方一致.mjs --fix --apply     自动补齐能补的
 *  node 工具/三方一致.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SHARED = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const SBOARD_DIR = path.join(WB, 'sceneboard', 'scenes');
const INDEX_FILE = path.join(SHARED, '索引.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  加载三个源
// ══════════════════════════════════════════════════════════════
export function loadSources(opts) {
  const o = opts || {};
  const wb = o.wb || WB;

  const index = readJsonSafe(o.indexFile || path.join(wb, '数据', '.dsh', '场景记忆', '_共享记忆', '索引.json')) || { areas: [] };

  // ⚠ 2026-11-12 加：会话那个事实的「镜像」在 身份索引.json，不在 索引.json。
  //   两个文件长得很像但存的是两件事：
  //     索引.json      areas[]  —— 场景 id / 名字 / 面板 / isHub（决定启动进哪）
  //     身份索引.json  rows[]   —— 场景 → 会话 sessionId（决定消息发给谁）
  //   一开始我拿 索引.json 对账会话，结果 9 个场景全报「索引缺 sessionId」，
  //   那不是数据坏了，是**我对错了文件**。判据必须落在真正存这个事实的地方。
  const identity = readJsonSafe(o.identityFile ||
    path.join(wb, '数据', '.dsh', '场景记忆', '_共享记忆', '身份索引.json')) || { rows: [] };

  const configs = {};
  const scenDir = o.scenDir || path.join(wb, '外壳', 'scenarios');
  if (fs.existsSync(scenDir)) {
    for (const f of fs.readdirSync(scenDir)) {
      if (!f.endsWith('.json')) continue;
      const j = readJsonSafe(path.join(scenDir, f));
      if (j && j.id) configs[j.id] = j;
    }
  }

  const boards = {};
  const sboardDir = o.sboardDir || path.join(wb, 'sceneboard', 'scenes');
  if (fs.existsSync(sboardDir)) {
    for (const f of fs.readdirSync(sboardDir)) {
      if (!f.endsWith('.json')) continue;
      const j = readJsonSafe(path.join(sboardDir, f));
      if (j && j.id) boards[j.id] = j;
    }
  }

  return { index, identity, configs, boards };
}

// ══════════════════════════════════════════════════════════════
//  ⚠ 2026-11-12 新增：会话三处对账
//
//  为什么加：上面 ②③④ 只对账「场景名 / 面板 id」，
//  但真正会让人发错消息的那件事 —— **这个场景绑的是哪个会话** ——
//  一个字都没查。
//
//  三处存同一事实：
//    ① 权威：外壳/scenarios/<id>.json 里 type:'harness' 的 sessionId
//    ② 镜像：数据/.dsh/场景记忆/_共享记忆/身份索引.json 的 rows[].sessionId
//    ③ 落地：数据/.dsh/sessions/<工作区>/session-* 目录里真的存在
//
//  本项目踩过的坑：② 和 ① 指向的会话**都真实存在，但完全不同**。
//  任何单向检查都不报错 —— 因为两边都不「假」。
//  所以判据必须是「② 是否跟随 ①」，不是「② 和 ① 一不一样」。
//
//  另外 hub 是个特例：它把会话 id 写在 meta.hubSessionId（没有 harness 面板，
//  中枢对话由 ui/index.js 直接挂到 shell.sideEl）。这个也要认，否则会把
//  正常配置误判成「没绑定会话」。
// ══════════════════════════════════════════════════════════════

/** 从一份场景配置里取「它绑定的会话 id」（含 hub 的 meta.hubSessionId 特例） */
export function configSessionId(cfg) {
  if (!cfg) return '';
  const harness = (cfg.panels || []).find((p) => p && p.type === 'harness');
  if (harness && harness.sessionId) return String(harness.sessionId);
  // hub 特例：没有 harness 面板，会话挂在 meta.hubSessionId
  if (cfg.meta && cfg.meta.hubSessionId) return String(cfg.meta.hubSessionId);
  return '';
}

/**
 * 扫「引擎里真实存在的会话 id」。
 * 只读目录名，不读会话内容 —— 判据只需要「存在」。
 */
export function loadLiveSessions(opts) {
  const o = opts || {};
  const root = o.sessionsRoot || path.join(o.wb || WB, '数据', '.dsh', 'sessions');
  const live = new Set();
  if (!fs.existsSync(root)) return { ok: false, live, root };
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    let items;
    try { items = fs.readdirSync(path.join(root, ws.name), { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (it.isDirectory() && /^session-/.test(it.name)) live.add(it.name);
    }
  }
  return { ok: true, live, root };
}

/**
 * 对账会话三处。
 * 返回 problems（带权威说法）+ fixes（只有「索引跟随配置」这一个方向）
 */
export function checkSessions(opts) {
  const o = opts || {};
  const { configs } = o.sources || loadSources(o);
  const identity = (o.sources && o.sources.identity) || { rows: [] };
  const idRows = Array.isArray(identity.rows) ? identity.rows : [];
  const rowById = {};
  for (const r of idRows) if (r && r.scene) rowById[r.scene] = r;

  const live = o.live || loadLiveSessions(o).live;
  const problems = [];
  const fixes = [];
  const rows = [];

  for (const [id, cfg] of Object.entries(configs)) {
    const want = configSessionId(cfg);        // ① 权威
    const idRow = rowById[id];
    const got = idRow ? String(idRow.sessionId || '') : '';   // ② 镜像

    const row = {
      id,
      name: cfg.name || id,
      want,
      got,
      inConfig: !!want,
      inIndex: !!got,
      live: want ? live.has(want) : null,
      follows: want === got,
    };
    rows.push(row);

    // 权威源自己就没有会话 → 这是「还没启动过」，不是不一致。
    // （和六件套里「没会话不算失效」同一条判据）
    if (!want) {
      // 但索引里留着幽灵会话 → 索引没跟随，仍要报
      if (got) {
        problems.push('「' + row.name + '」配置没有会话，索引却写着 ' + got.slice(0, 20) +
          '…（索引该跟随配置清空）');
        fixes.push({ type: 'index-session', id, want: '' });
      }
      continue;
    }

    // ① 权威值在引擎里不存在 → 真问题（配置指向了不存在的会话）
    if (live.size > 0 && !live.has(want)) {
      problems.push('「' + row.name + '」配置里的会话 ' + want.slice(0, 20) +
        '… 在引擎里不存在（配置说要绑它，实际没有这条会话）');
    }

    // ② 镜像没跟随权威 → 真问题，方向明确：索引该跟配置
    if (!got) {
      problems.push('「' + row.name + '」身份索引缺 sessionId，未跟随配置（权威=' +
        want.slice(0, 20) + '…）');
      fixes.push({ type: 'index-session', id, want });
    } else if (got !== want) {
      problems.push('「' + row.name + '」身份索引未跟随配置：配置=' + want.slice(0, 20) +
        '… / 索引=' + got.slice(0, 20) + '…（权威是配置，索引该改成配置的值）');
      fixes.push({ type: 'index-session', id, want });
    }
  }

  return { problems, fixes, rows, liveCount: live.size };
}

// ══════════════════════════════════════════════════════════════
//  检查
// ══════════════════════════════════════════════════════════════
export function check(opts) {
  const o = opts || {};
  // ⚠ 必须把整个 sources 原样传给 checkSessions —— 只传 {index,configs,boards}
  //   会把 identity（身份索引）丢掉，会话对账就永远看不到镜像那一侧。
  const sources = o.sources || loadSources(o);
  const { index, configs, boards } = sources;
  const areas = Array.isArray(index.areas) ? index.areas : [];

  const problems = [];
  const fixes = [];

  const areaById = {};
  for (const a of areas) if (a && a.id) areaById[a.id] = a;

  const allIds = new Set([
    ...Object.keys(configs),
    ...Object.keys(boards),
    ...Object.keys(areaById),
  ]);

  // ═══ ① 中枢必须三处都标 ═══
  const hubConfig = configs.hub;
  const hubBoard = boards.hub;
  const hubArea = areaById.hub;

  if (hubConfig || hubBoard || hubArea) {
    // 哪个是「入口」？按 first / isHub 判断
    const hubName = (hubConfig && hubConfig.name) || (hubArea && hubArea.name) || '中枢';

    if (hubConfig && !hubConfig.first) {
      problems.push('中枢：外壳/scenarios/hub.json 缺 first: true');
      fixes.push({ type: 'config-first', id: 'hub' });
    }
    if (hubBoard && !hubBoard.isHub) {
      problems.push('中枢：sceneboard/scenes/hub.json 缺 isHub: true');
    }
    if (hubArea && !hubArea.isHub) {
      problems.push('中枢：索引.json 缺 isHub: true（⚠ main.js 只读这个 → 启动进错场景）');
      fixes.push({ type: 'index-hub', id: 'hub' });
    }
  }

  // ═══ ②③④ 逐场景对账 ═══
  for (const id of allIds) {
    const cfg = configs[id];
    const brd = boards[id];
    const area = areaById[id];

    // ② name 一致
    if (cfg && area) {
      const cn = String(cfg.name || '');
      const an = String(area.name || '');
      if (cn && an && cn !== an) {
        problems.push('「' + id + '」name 不一致：配置=' + cn + ' / 索引=' + an);
      }
    }

    // ③ panel 真实存在
    if (cfg && area && area.panel) {
      const panels = (cfg.panels || []).map((p) => String(p.id));
      if (panels.length > 0 && !panels.includes(String(area.panel))) {
        problems.push('「' + id + '」索引里的 panel「' + area.panel +
          '」在配置里不存在（配置有：' + panels.join(', ') + '）');
      }
    }

    // ④ 三处是否都存在
    const missing = [];
    if (!cfg) missing.push('外壳配置');
    if (!brd) missing.push('sceneboard 契约');
    if (!area) missing.push('索引条目');
    if (missing.length > 0 && missing.length < 3) {
      problems.push('「' + id + '」缺：' + missing.join('、'));
    }
  }

  // ═══ ⑤ 启动会进哪个场景（模拟 index.js 的逻辑）═══
  //  main.js: 按 isHub 优先排序，然后 id 字母序
  const sorted = [...areas]
    .filter((a) => a && a.id)
    .sort((x, y) => {
      if (x.isHub && !y.isHub) return -1;
      if (!x.isHub && y.isHub) return 1;
      return String(x.id).localeCompare(String(y.id));
    });
  const hubEntry = sorted.find((a) => a.isHub) || sorted[0];
  const bootScene = hubEntry ? hubEntry.id : null;

  const bootProblem = bootScene !== 'hub'
    ? '启动会进入「' + (hubEntry ? hubEntry.name || hubEntry.id : '未知') + '」而不是中枢'
    : null;
  if (bootProblem) problems.push(bootProblem);

  // ═══ ⑥ 会话三处对账（配置=权威，索引=镜像）═══
  //  ⚠ 2026-11-12 加：原来只查名字和面板 id，不查「这个场景绑的是哪个会话」。
  //  这是最容易让人发错消息的一项，却一直没纳入对账。
  const sess = checkSessions({ sources, live: o.live });
  for (const p of sess.problems) problems.push(p);
  for (const f of sess.fixes) fixes.push(f);

  return {
    ok: problems.length === 0,
    totalScenes: allIds.size,
    problems,
    fixes,
    bootScene,
    bootOk: bootScene === 'hub',
    // 会话对账明细（给 --json / 自测用）
    sessions: sess.rows,
    liveSessions: sess.liveCount,
    reason: problems.length === 0
      ? '三方一致：' + allIds.size + ' 个场景（启动进入中枢 ✓）'
      : problems.length + ' 处不一致',
  };
}

// ══════════════════════════════════════════════════════════════
//  自动补齐（只补能确定补的：中枢 isHub、first）
// ══════════════════════════════════════════════════════════════
export function applyFixes(fixes, opts) {
  const o = opts || {};
  const wb = o.wb || WB;
  const done = [];

  for (const f of fixes) {
    if (f.type === 'index-hub') {
      const p = o.indexFile || path.join(wb, '数据', '.dsh', '场景记忆', '_共享记忆', '索引.json');
      const j = readJsonSafe(p);
      if (!j) continue;
      const a = (j.areas || []).find((x) => x.id === 'hub');
      if (a && !a.isHub) {
        a.isHub = true;
        j._at = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
        done.push('索引.json: hub.isHub = true');
      }
    }
    if (f.type === 'config-first') {
      const p = o.scenFile || path.join(wb, '外壳', 'scenarios', 'hub.json');
      const j = readJsonSafe(p);
      if (j && !j.first) {
        j.first = true;
        fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
        done.push('scenarios/hub.json: first = true');
      }
    }
    // ⚠ 2026-11-12 加：索引跟随配置
    //
    //  方向是**单向**的：只把配置里的 sessionId 抄进索引，
    //  绝不反向改配置。理由见 checkSessions 上面的注释：
    //  配置是权威（用户实际看到的面板绑的就是它）。
    //
    //  这条修法存在的意义：让「重建工具」和「检查器」不打架 ——
    //  两边都朝同一个方向收敛，跑多少次结果都一样。
    if (f.type === 'index-session') {
      const p = o.identityFile || path.join(wb, '数据', '.dsh', '场景记忆', '_共享记忆', '身份索引.json');
      const j = readJsonSafe(p);
      if (!j) continue;
      const a = (j.rows || []).find((x) => x.scene === f.id);
      if (!a) continue;
      if (String(a.sessionId || '') === String(f.want)) continue;
      if (f.want) a.sessionId = f.want;
      else delete a.sessionId;
      j._at = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
      done.push('身份索引.json: ' + f.id + '.sessionId = ' +
        (f.want ? f.want.slice(0, 20) + '…' : '(删除)'));
    }
  }
  return { ok: true, done };
}

// ══════════════════════════════════════════════════════════════
//  自测（含反例：造一个缺 isHub 的索引，必须报）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  三方一致 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 合规样本
  const good = {
    index: { areas: [{ id: 'hub', name: '中枢', panel: 'hub-neuron', isHub: true }] },
    configs: { hub: { id: 'hub', name: '中枢', first: true, panels: [{ id: 'hub-neuron' }] } },
    boards: { hub: { id: 'hub', isHub: true } },
  };
  const c1 = check({ sources: good });
  chk('合规样本通过', c1.ok === true, c1.problems.join(';') || 'ok');
  chk('合规时启动进中枢', c1.bootScene === 'hub', c1.bootScene);

  // ② 反例：索引缺 isHub
  const bad1 = {
    index: { areas: [{ id: 'hub', name: '中枢', panel: 'hub-neuron' }] },   // 缺 isHub
    configs: { hub: { id: 'hub', name: '中枢', first: true, panels: [{ id: 'hub-neuron' }] } },
    boards: { hub: { id: 'hub', isHub: true } },
  };
  const c2 = check({ sources: bad1 });
  chk('反例：索引缺 isHub 被检出', c2.ok === false, c2.problems.join(';').slice(0, 60));
  chk('反例：能指出缺 isHub', c2.problems.some(function(p){return p.indexOf('isHub') >= 0;}), c2.problems.filter(function(p){return p.indexOf('isHub')>=0;})[0] || '');

  // ③ 反例：索引里有多个场景，缺 isHub 时启动进字母序第一个
  const bad2 = {
    index: {
      areas: [
        { id: 'arch-review', name: '架构梳理', panel: 'ar-ai' },
        { id: 'hub', name: '中枢', panel: 'hub-neuron' },
      ],
    },
    configs: {
      'arch-review': { id: 'arch-review', name: '架构梳理', panels: [{ id: 'ar-ai' }] },
      hub: { id: 'hub', name: '中枢', first: true, panels: [{ id: 'hub-neuron' }] },
    },
    boards: { 'arch-review': { id: 'arch-review' }, hub: { id: 'hub', isHub: true } },
  };
  const c3 = check({ sources: bad2 });
  chk('反例：多场景时启动进 arch-review', c3.bootScene === 'arch-review', c3.bootScene);

  // ④ 反例：panel 不存在
  const bad3 = {
    index: { areas: [{ id: 'hub', name: '中枢', panel: 'no-such-panel', isHub: true }] },
    configs: { hub: { id: 'hub', name: '中枢', first: true, panels: [{ id: 'hub-neuron' }] } },
    boards: { hub: { id: 'hub', isHub: true } },
  };
  const c4 = check({ sources: bad3 });
  chk('反例：panel 不存在被检出', c4.ok === false,
      c4.problems.find((p) => p.includes('panel')) || '');

  // ⑤ 反例：name 不一致
  const bad4 = {
    index: { areas: [{ id: 'hub', name: '中枢纽', panel: 'hub-neuron', isHub: true }] },
    configs: { hub: { id: 'hub', name: '中枢', first: true, panels: [{ id: 'hub-neuron' }] } },
    boards: { hub: { id: 'hub', isHub: true } },
  };
  const c5 = check({ sources: bad4 });
  chk('反例：name 不一致被检出', c5.ok === false,
      c5.problems.find((p) => p.includes('name')) || '');

  // ⑥ 真实数据
  const real = check();
  chk('能检查真实数据', typeof real.totalScenes === 'number', real.totalScenes + ' 个场景');
  chk('真实数据启动进中枢', real.bootScene === 'hub', 'boot=' + real.bootScene);

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 新增：会话三处对账的反例
  //
  //  这一段是本次修改的核心验证 —— 「索引和配置不一致」必须报，
  //  而且必须**说清谁是权威**，不能只说「你俩不一样」。
  //  本项目踩过的坑：两边指向的会话都真实存在，任何单向检查都不报错。
  // ══════════════════════════════════════════════════════════════
  const LIVE = { live: new Set(['sess-A', 'sess-B']) };

  // 正例：索引跟随配置
  {
    const src = {
      index: { areas: [{ id: 'hub', name: '中枢', panel: 'hub-neuron', isHub: true }] },
      identity: { rows: [{ scene: 'hub', name: '中枢', sessionId: 'sess-A' }] },
      configs: { hub: { id: 'hub', name: '中枢', first: true, meta: { hubSessionId: 'sess-A' }, panels: [{ id: 'hub-neuron' }] } },
      boards: { hub: { id: 'hub', isHub: true } },
    };
    const c = check({ sources: src, ...LIVE });
    chk('会话正例：索引跟随配置 ⇒ 通过', c.ok === true, c.problems.join(';') || 'ok');
  }

  // 反例①：两边都真实存在，但指向不同会话 —— 这是本项目最阴的坑
  {
    const src = {
      index: { areas: [{ id: 'hub', name: '中枢', panel: 'hub-neuron', isHub: true }] },
      identity: { rows: [{ scene: 'hub', name: '中枢', sessionId: 'sess-B' }] },  // 也真实存在！
      configs: { hub: { id: 'hub', name: '中枢', first: true, meta: { hubSessionId: 'sess-A' }, panels: [{ id: 'hub-neuron' }] } },
      boards: { hub: { id: 'hub', isHub: true } },
    };
    const c = check({ sources: src, ...LIVE });
    chk('反例：两侧会话都真但不同 ⇒ 必须报', c.ok === false,
        c.problems.find((p) => p.includes('未跟随')) || '没检出');
    chk('反例：必须指明权威是「配置」',
        c.problems.some((p) => p.includes('权威是配置') || p.includes('未跟随配置')),
        '不能只说「不一致」—— 那样两个方向会互相打架');
    chk('反例：修法方向唯一（索引跟随配置）',
        c.fixes.length === 1 && c.fixes[0].type === 'index-session' && c.fixes[0].want === 'sess-A',
        JSON.stringify(c.fixes));
  }

  // 反例②：配置指向引擎里不存在的会话
  {
    const src = {
      index: { areas: [{ id: 'hub', name: '中枢', panel: 'hub-neuron', isHub: true }] },
      identity: { rows: [{ scene: 'hub', name: '中枢', sessionId: 'sess-GHOST' }] },
      configs: { hub: { id: 'hub', name: '中枢', first: true, meta: { hubSessionId: 'sess-GHOST' }, panels: [{ id: 'hub-neuron' }] } },
      boards: { hub: { id: 'hub', isHub: true } },
    };
    const c = check({ sources: src, ...LIVE });
    chk('反例：配置指向幽灵会话 ⇒ 必须报', c.ok === false,
        c.problems.find((p) => p.includes('不存在')) || '没检出');
  }

  // 反例③：配置没有会话、索引却留着幽灵 —— 索引未跟随
  {
    const src = {
      index: { areas: [{ id: 'hub', name: '中枢', panel: 'hub-neuron', isHub: true }] },
      identity: { rows: [{ scene: 'hub', name: '中枢', sessionId: 'sess-B' }] },
      configs: { hub: { id: 'hub', name: '中枢', first: true, panels: [{ id: 'hub-neuron' }] } },
      boards: { hub: { id: 'hub', isHub: true } },
    };
    const c = check({ sources: src, ...LIVE });
    chk('反例：配置无会话但索引留着 ⇒ 必须报', c.ok === false,
        c.problems.find((p) => p.includes('配置没有会话')) || '没检出');
  }

  // 反例④：hub 用 meta.hubSessionId（没有 harness 面板）也要被认出来
  chk('能认出 hub 的 meta.hubSessionId',
      configSessionId({ id: 'hub', meta: { hubSessionId: 'sess-A' }, panels: [] }) === 'sess-A',
      '否则会把正常的 hub 配置误判成「没绑定会话」');

  // ⑦ 关键：这个检查能发现「同一个事实存三处」的不一致
  chk('关键：能发现三方不一致',
      c2.ok === false && c3.bootScene !== 'hub',
      '参考项目：「两处判据 = 两份结论 = 早晚打架」');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  const r = check();

  // ── 自动补齐 ──
  if (has('--fix')) {
    console.log('═'.repeat(74));
    console.log('  三方一致 · 自动补齐' + (has('--apply') ? '' : '（预览）'));
    console.log('═'.repeat(74));
    console.log();

    if (r.fixes.length === 0) {
      console.log('  ✓ 没有可自动补的项');
    } else {
      for (const f of r.fixes) console.log('  → ' + f.type + ' (' + f.id + ')');
      if (has('--apply')) {
        const a = applyFixes(r.fixes);
        console.log();
        for (const d of a.done) console.log('  ✓ ' + d);
      } else {
        console.log();
        console.log('  （预览。加 --apply 真改）');
      }
    }
    console.log();
    console.log('─'.repeat(74));
    process.exit(0);
  }

  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  console.log('═'.repeat(76));
  console.log('  场景三方一致检查');
  console.log('═'.repeat(76));
  console.log();
  console.log('  场景数: ' + r.totalScenes);
  console.log('  启动进入: ' + r.bootScene + (r.bootOk ? '  ✓ 是中枢' : '  ✗ 不是中枢'));
  console.log();
  if (r.ok) {
    console.log('  ✓ ' + r.reason);
  } else {
    console.log('  ✗ ' + r.reason + '：');
    console.log();
    for (const p of r.problems) console.log('    · ' + p);
    if (r.fixes.length > 0) {
      console.log();
      console.log('  可自动补齐 ' + r.fixes.length + ' 项：node 工具/三方一致.mjs --fix --apply');
    }
  }
  console.log();
  console.log('─'.repeat(76));
  console.log('  依据：参考项目全局铁律 §1「两处判据 = 两份结论 = 早晚打架」');
  console.log('  本案：中枢的「我是入口」存在三处（配置 first / 契约 isHub / 索引 isHub）');
  console.log('        main.js 只读索引 → 索引缺 isHub → 启动进错场景');
  console.log('─'.repeat(76));

  process.exit(r.ok ? 0 : 1);
}
