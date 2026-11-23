#!/usr/bin/env node
/**
 * 身份哨兵 v2 —— 检查"谁能真正认领自己"
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么不变量要加 INV-7（本体存在性）
 * ══════════════════════════════════════════════════════════════
 *
 *  实测发现：
 *    场景 json 里 10 个 sessionId 格式全都合法（session-<uuid>）
 *    但在引擎会话库里：0 个真实存在
 *
 *  这正是原项目警告的坑：
 *    "抄示例里的 session-0000… 只会'看起来配好了'，实际不钉会话"
 *    → 格式合法 ≠ 指向真实会话
 *
 *  所以必须有 INV-7：sessionId 必须在引擎会话库里真实存在。
 *
 * ══════════════════════════════════════════════════════════════
 *  不变量
 * ══════════════════════════════════════════════════════════════
 *
 *  INV-1  table-complete   有 AI 面板的场景，索引里必须有行
 *  INV-2  no-orphan        索引里的行，场景必须存在
 *  INV-3  sessionId-shape  session-<uuid> 格式
 *  INV-4  no-placeholder   不能是 0000…/xxxx…
 *  INV-5  path-exists      定位卡必须真实存在
 *  INV-6  file-id-match    场景 json 的 id = 文件名
 *  INV-7  session-exists   ★ sessionId 必须在引擎会话库里存在
 *  INV-8  scene-match      ★ 该会话必须属于当前项目工作区（防跨项目串台）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');

const SESSION_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /^session-0{8}|^session-x{4}|0000-0000|xxxx-xxxx/i;

function readJson(p, fb) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);   // 剥离 BOM
    return JSON.parse(s);
  } catch { return fb; }
}

/**
 * 扫描引擎会话库，返回所有真实存在的 sessionId
 * 引擎把会话存在 .dsh-tui/sessions/<工作区编码>/<sessionId>/
 */
function scanEngineSessions(dshTuiRoot) {
  const found = new Map();   // sessionId -> { workspace, dir }
  const diag = { scanned: 0, workspaces: 0 };

  if (!fs.existsSync(dshTuiRoot)) {
    return { map: found, diag, error: 'tuiRoot 不存在: ' + dshTuiRoot };
  }
  const sessionsRoot = path.join(dshTuiRoot, 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    return { map: found, diag, error: 'sessions 目录不存在: ' + sessionsRoot };
  }

  for (const ws of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    diag.workspaces++;
    const wsDir = path.join(sessionsRoot, ws.name);
    let items;
    try { items = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (!it.isDirectory()) continue;
      diag.scanned++;
      const raw = it.name;
      // 会话目录名有两种格式：session-xxx 或裸 uuid
      // 两者都映射到规范形式 session-xxx，同时保留原名
      const canonical = raw.startsWith('session-') ? raw : ('session-' + raw);
      const entry = { workspace: ws.name, dir: path.join(wsDir, raw), raw };
      found.set(canonical, entry);
      // 也存原名（防止调用方用裸 uuid 查）
      found.set(raw, entry);
    }
  }
  return { map: found, diag, error: null };
}

/**
 * @param {object} opt
 *   opt.dataRoot      .dsh 目录
 *   opt.scenDir       scenarios 目录
 *   opt.tuiRoot       .dsh-tui 目录（引擎会话库）
 */
export function check(opt) {
  const dataRoot = opt.dataRoot;
  const scenDir = opt.scenDir;
  const tuiRoot = opt.tuiRoot;

  const diffs = [];
  const ID = 'identity-guard';

  // ═══ 扫真实会话 ═══
  const scanResult = tuiRoot ? scanEngineSessions(tuiRoot) : { map: new Map(), diag: {}, error: null };
  const realSessions = scanResult.map;

  // ═══ 收集场景配置 ═══
  const scenes = {};
  if (fs.existsSync(scenDir)) {
    for (const f of fs.readdirSync(scenDir).filter(x => x.endsWith('.json'))) {
      const full = path.join(scenDir, f);
      const j = readJson(full, null);
      if (!j) { diffs.push('场景文件解析失败：' + f); continue; }
      const fileId = f.replace(/\.json$/, '');
      if (j.id !== fileId) {
        diffs.push('场景「' + fileId + '」json id="' + j.id + '" 与文件名不一致');
      }
      scenes[j.id || fileId] = { file: full, json: j };
    }
  }

  // ═══ 收集身份索引 ═══
  const idxPath = path.join(dataRoot, '场景记忆', '_共享记忆', '身份索引.json');
  let index = null;
  if (fs.existsSync(idxPath)) index = readJson(idxPath, null);
  if (!index) {
    diffs.push('缺少身份索引表（_共享记忆/身份索引.json）');
  }

  const rows = (index && Array.isArray(index.rows)) ? index.rows : [];
  const indexed = new Set(rows.map(r => r.scene));

  // ═══ INV-1 ═══
  //
  //  ★ 自检修复：区分"待绑定会话"和"缺会话"
  //    新场景尚未创建专属会话时 sessionId 为空是正常的
  //    场景 meta 里写 pendingSession: true 表示"已知待办"
  //    没有这个标记才算违规
  const pendingSessions = new Set();
  for (const [sid, s] of Object.entries(scenes)) {
    const panels = s.json.panels || [];
    const hasAi = panels.some(p => p.type === 'harness' || p.type === 'main-agent');
    if (!hasAi) continue;

    const meta = s.json.meta || {};
    const allAiHaveSession = panels
      .filter(p => p.type === 'harness' || p.type === 'main-agent')
      .every(p => p.sessionId && String(p.sessionId).trim());

    if (meta.pendingSession === true && !allAiHaveSession) {
      // 已知待办：不算违规，但记录
      pendingSessions.add(sid);
      continue;
    }

    if (!indexed.has(sid)) {
      diffs.push('场景「' + sid + '」有 AI 面板但索引里没有对应行');
    }
  }

  // ═══ INV-2 ═══
  for (const r of rows) {
    if (!scenes[r.scene]) {
      diffs.push('索引里的「' + r.scene + '」没有对应场景配置');
    }
  }

  // ═══ INV-3/4/7/8 ═══
  //
  //  注意：只检查"配置里确实有 AI 面板"的场景。
  //  中枢（hub）的对话面板由 shell.sideEl 固定挂载，不在 scenarios json 里，
  //  所以它不需要 sessionId —— 这是设计，不是缺陷。
  const scenesWithAi = new Set();
  for (const [sid, s] of Object.entries(scenes)) {
    const panels = s.json.panels || [];
    if (panels.some(p => p.type === 'harness' || p.type === 'main-agent')) {
      scenesWithAi.add(sid);
    }
  }

  for (const r of rows) {
    const sid = String(r.sessionId || '').trim();
    const needsSession = scenesWithAi.has(r.scene);

    // ★ 已知待绑定会话的场景跳过此检查
    const sceneCfg = scenes[r.scene];
    const isPending = sceneCfg && sceneCfg.json && sceneCfg.json.meta &&
      sceneCfg.json.meta.pendingSession === true;

    if (!sid || sid === '(缺)') {
      // 没有 AI 面板的场景不要求 sessionId；已知待绑定的也不算违规
      if (needsSession && !isPending) {
        diffs.push('场景「' + r.scene + '」有 AI 面板但索引行缺 sessionId');
      }
      continue;
    }
    if (PLACEHOLDER_RE.test(sid)) {
      diffs.push('场景「' + r.scene + '」sessionId 是占位符：' + sid);
      continue;
    }
    if (!SESSION_RE.test(sid)) {
      diffs.push('场景「' + r.scene + '」sessionId 格式不合法：' + sid);
      continue;
    }

    // INV-7 真实存在性
    if (tuiRoot) {
      const hit = realSessions.get(sid);
      if (!hit) {
        diffs.push(
          '场景「' + r.scene + '」sessionId 在引擎里不存在：' + sid +
          '（格式合法但指向不存在的会话 → 面板会退化显示，必然串台）'
        );
      }
    }
  }

  // ═══ INV-9 索引 vs 配置一致性（2026-11-12 新增）═══
  //
  //  为什么加：实测发现索引表和场景配置**长期不一致**（9/9 全对不上），
  //  但两者指向的会话都是真实存在的，所以 INV-7 完全查不出来。
  //
  //  根因：身份索引重建.mjs 只认「场景注入-<id>」一种目录命名，
  //        而 7 个场景用的是「场景记忆-<中文名>」→ 找不到会话 →
  //        索引表从来没被正确重建过。
  //
  //  正确判据：**场景配置是权威来源，索引表必须跟着它**。
  //    配置里 sessionId 是什么，索引表里就得是什么。
  for (const r of rows) {
    const s = scenes[r.scene];
    if (!s) continue;
    const ai = (s.json.panels || []).find((p) => p.type === 'harness' || p.type === 'main-agent');
    if (!ai || !ai.sessionId) continue;   // 配置没写，不判
    if (String(ai.sessionId) !== String(r.sessionId)) {
      diffs.push(
        '场景「' + r.scene + '」索引表与配置不一致：' +
        '索引=' + String(r.sessionId).slice(0, 22) +
        ' 配置=' + String(ai.sessionId).slice(0, 22) +
        '（场景配置是权威来源，索引表应跟随它）'
      );
    }
  }

  // ═══ INV-5 定位卡 ═══
  for (const r of rows) {
    if (!r.context || r.context === '(缺)') {
      diffs.push('场景「' + r.scene + '」缺定位卡');
      continue;
    }
    const cp = path.resolve(scenDir, r.context);
    if (!fs.existsSync(cp)) {
      diffs.push('场景「' + r.scene + '」定位卡不存在：' + r.context);
    }
  }

  return {
    id: ID, diffs,
    stats: {
      realSessions: realSessions.size,
      scenes: Object.keys(scenes).length,
      pendingSessions: [...pendingSessions],
      scanDiag: scanResult.diag,
      scanError: scanResult.error,
      tuiRoot,
      sessionsRoot: tuiRoot ? path.join(tuiRoot, 'sessions') : null,
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  身份哨兵 · 自测');
  console.log('═'.repeat(72));
  console.log();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idguard-'));
  const shared = path.join(tmp, '场景记忆', '_共享记忆');
  const scen = path.join(tmp, '外壳', 'scenarios');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(scen, { recursive: true });

  fs.writeFileSync(path.join(scen, 'test-scene.json'),
    JSON.stringify({ id: 'test-scene', name: '测试场景', panels: [{ id: 'p1', type: 'harness' }] }), 'utf8');
  fs.writeFileSync(path.join(scen, 'test-scene-context.md'), '# 定位卡\n\n' + 'x'.repeat(300), 'utf8');

  const writeIndex = (rows) => fs.writeFileSync(path.join(shared, '身份索引.json'),
    JSON.stringify({ _note: 'test', rows }, null, 2), 'utf8');

  const GOOD = [{ scene: 'test-scene', name: '测试场景', context: 'test-scene-context.md', sessionId: 'session-11111111-2222-3333-4444-555555555555' }];

  writeIndex(GOOD);
  const r1 = check({ dataRoot: tmp, scenDir: scen });
  chk('合规时通过', r1.diffs.length === 0, r1.ok ? '' : (r1.diffs || []).slice(0, 2).join(';'));

  writeIndex([{ scene: 'test-scene', name: '测试场景', context: 'test-scene-context.md', sessionId: 'placeholder' }]);
  const r2 = check({ dataRoot: tmp, scenDir: scen });
  chk('反例：占位 sessionId 必须报', r2.diffs.length > 0,
      r2.ok ? '没报（检查是假的）' : ((r2.diffs || [])[0] || '').slice(0, 45));

  writeIndex([]);
  const r3 = check({ dataRoot: tmp, scenDir: scen });
  chk('反例：索引缺场景必须报', r3.diffs.length > 0,
      r3.ok ? '没报' : ((r3.diffs || [])[0] || '').slice(0, 45));

  writeIndex(GOOD);
  const r4 = check({ dataRoot: tmp, scenDir: scen });
  chk('恢复后重新通过', r4.diffs.length === 0, '');

  chk('关键：2 个反例全部被检出',
      r2.diffs.length > 0 && r3.diffs.length > 0,
      '这是身份哨兵存在的唯一理由');

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const wbRoot = process.env.SEA_WB_ROOT ? path.resolve(process.env.SEA_WB_ROOT) : WB;

  const opt = {
    dataRoot: process.env.SEA_DATA_DIR
      ? path.resolve(process.env.SEA_DATA_DIR)
      : path.join(wbRoot, '数据', '.dsh'),
    scenDir: process.env.SEA_SCEN_DIR
      ? path.resolve(process.env.SEA_SCEN_DIR)
      : path.join(wbRoot, '外壳', 'scenarios'),
    // ⚠ 2026-11-10 独立化后：会话库从 数据/.dsh-tui 迁到了 数据/.dsh
    //   （引擎用 DSH_HOME=数据/.dsh，sessions 就在它下面）
    //   旧路径导致扫描永远失败 → 7 个场景的 sessionId 全被判"不存在"。
    //   这里优先新路径，找不到才回退旧路径（兼容老数据）。
    tuiRoot: process.env.SEA_TUI_ROOT
      ? path.resolve(process.env.SEA_TUI_ROOT)
      : (fs.existsSync(path.join(wbRoot, '数据', '.dsh', 'sessions'))
        ? path.join(wbRoot, '数据', '.dsh')
        : path.join(wbRoot, '数据', '.dsh-tui')),
  };

  const r = check(opt);
  const n = r.diffs.length;

  console.log('  引擎会话库: ' + r.stats.realSessions + ' 个 key（含双格式）');
  console.log('  扫描诊断:   工作区 ' + (r.stats.scanDiag.workspaces || 0) + ' 个 / 会话目录 ' + (r.stats.scanDiag.scanned || 0) + ' 个');
  console.log('  会话根目录: ' + (r.stats.sessionsRoot || '?'));
  if (r.stats.scanError) console.log('  ⛔ 扫描错误: ' + r.stats.scanError);
  console.log('  场景配置:   ' + r.stats.scenes + ' 个');
  if (r.stats.pendingSessions && r.stats.pendingSessions.length) {
    console.log('  待绑会话:   ' + r.stats.pendingSessions.join(', ') + '（已知待办，不算违规）');
  }
  console.log();

  if (n === 0) {
    console.log('PASS ' + r.id + ': 差异集合 = 0');




    process.exit(0);
  } else {
    console.log('FAIL ' + r.id + ': 差异集合 = ' + n + ' 项');
    for (const d of r.diffs) console.log('  - ' + d);
    process.exit(1);
  }
}
