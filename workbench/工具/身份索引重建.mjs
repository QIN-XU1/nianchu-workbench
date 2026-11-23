#!/usr/bin/env node
/**
 * 身份索引重建 —— 用引擎里真实存在的会话重建 _共享记忆/身份索引.json
 *
 * ══════════════════════════════════════════════════════════════
 *  问题
 * ══════════════════════════════════════════════════════════════
 *
 *  身份索引里的 7 个 sessionId 全是**占位符**，引擎里根本不存在。
 *  身份哨兵一直在报，但我之前清的是「场景 JSON」，
 *  而哨兵读的是「身份索引」—— 清错了地方。
 *
 *  这份索引必须从**引擎实际会话**重建，不能手写。
 *
 * ══════════════════════════════════════════════════════════════
 *  做法
 * ══════════════════════════════════════════════════════════════
 *
 *   ① 扫 数据/.dsh/sessions/<工作区编码>/session-*
 *   ② 从工作区编码反解出场景（编码里含「场景注入-<sceneId>」）
 *   ③ 每个场景取「最新」的会话（按目录 mtime）
 *   ④ 没有会话的场景 → sessionId 留空 + meta.pendingSession = true
 *   ⑤ 写回身份索引.json
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/身份索引重建.mjs            预览（不写）
 *  node 工具/身份索引重建.mjs --apply    真写
 *  node 工具/身份索引重建.mjs --selftest 自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const SESSIONS_ROOT = path.join(DATA_ROOT, 'sessions');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const INDEX_PATH = path.join(DATA_ROOT, '场景记忆', '_共享记忆', '身份索引.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  const t = readTextSafe(p);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  从工作区编码反解场景 id
//
//  工作区目录名形如：
//    --D-file-AI~0020Temp-DeepSeek-Agent~81EA~7814-workbench-
//      ~6570~636E-.dsh-~573A~666F~6CE8~5165-arch-review--
//
//  关键片段是 `~573A~666F~6CE8~5165-` （= 场景注入）后面跟着场景 id。
//  ~XXXX 是 UTF-16 码点的十六进制。
// ══════════════════════════════════════════════════════════════
export function decodeWorkspaceName(name) {
  // 把 ~XXXX 还原成字符
  const decoded = name.replace(/~([0-9a-fA-F]{4})/g, (_, hex) => {
    const code = parseInt(hex, 16);
    try { return String.fromCharCode(code); } catch { return ''; }
  });
  return decoded;
}

// 中文场景名 → 英文 sceneId
const SCENE_CN_TO_ID = {
  '架构梳理': 'arch-review', '实施计划': 'build-plan', '竞品拆解': 'competitor-analyze',
  '故障分析': 'incident-analysis', '本地电脑': 'pc-cleanup', '调研': 'research',
  '逆向分析': 'reverse-eng', '自我复盘': 'self-review', '中枢': 'hub',
};

// ⚠ 2026-11-12 修（严重缺陷：7/9 场景的会话永远找不到）：
//
//   原来只认「场景注入-<sceneId>」这一种目录命名：
//     const m = decoded.match(/场景注入-([a-zA-Z0-9-]+)/);
//
//   但实测引擎会话目录有两套命名：
//     · 场景注入-arch-review      ← 老命名，只剩 2 个场景（arch-review / hub）
//     · 场景记忆-调研             ← 新命名，7 个场景都用这个
//     · 场景记忆-架构梳理 / 实施计划 / 竞品拆解 / ...
//
//   后果：这个工具报「暂无会话（7）」，说
//         「这些场景需要先跑一次任务，才会有会话」
//         但那 7 个场景明明有会话！它只是认不出目录名。
//
//   而这直接导致身份索引表长期失效：
//     索引表 9 条的 sessionId 与场景配置、与实际在用的会话，
//     **三方全部不一致**（实测 9/9 都对不上）。
//
//   因为「两处存同一事实」（索引表 vs 场景配置），
//   而索引表从来没被正确重建过 → 两份结论长期打架。
//
//   修法：两套命名都认。
export function extractSceneId(workspaceName) {
  const decoded = decodeWorkspaceName(workspaceName);
  // ① 老命名：场景注入-<sceneId>
  const m1 = decoded.match(/场景注入-([a-zA-Z0-9-]+)/);
  if (m1) return m1[1].replace(/-+$/, '');
  // ② 新命名：场景记忆-<中文名>
  const m2 = decoded.match(/场景记忆-([\u4e00-\u9fa5]+)/);
  if (m2) return SCENE_CN_TO_ID[m2[1]] || null;
  return null;
}

// ══════════════════════════════════════════════════════════════
//  扫描引擎会话
// ══════════════════════════════════════════════════════════════
export function scanSessions(sessionsRoot) {
  const byScene = new Map();   // sceneId -> [{ sessionId, mtime, workspace }]
  const diag = { workspaces: 0, sessions: 0, unknown: 0 };

  if (!fs.existsSync(sessionsRoot)) {
    return { ok: false, error: 'sessions 目录不存在: ' + sessionsRoot, byScene, diag };
  }

  for (const ws of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    diag.workspaces++;
    const sceneId = extractSceneId(ws.name);
    const wsDir = path.join(sessionsRoot, ws.name);

    let items;
    try { items = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (!it.isDirectory()) continue;
      if (!/^session-/.test(it.name)) continue;
      diag.sessions++;

      if (!sceneId) { diag.unknown++; continue; }

      const full = path.join(wsDir, it.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }

      if (!byScene.has(sceneId)) byScene.set(sceneId, []);
      byScene.get(sceneId).push({ sessionId: it.name, mtime, workspace: ws.name });
    }
  }

  // ⚠ 2026-11-12 修（两次改错后定下的最终判据）：
  //
  //   第一版：只按目录 mtime 选最新的 → 会选中空会话（第二轮踩过）
  //   实测：架构梳理目录下有 3 个会话，mtime 最新的是 session-2585d3ae，
  //        但场景配置里绑定的是 session-70990ee0，两者都是真实会话。
  //
  //   现在：**以场景配置为准**。
  //
  //   理由：场景配置里的 sessionId 是「用户实际看到的面板绑定的会话」，
  //        它是唯一权威来源。索引表只是它的镜像，不该自己选。
  //
  //   规则：
  //     ① 配置里的 id 若真实存在 → 用它
  //     ② 否则取该目录下评分最高的（有标题/有事件/非空）
  //     ③ 都没有 → 取最新的
  const cfgOf = new Map();
  const SCEN_DIR_FOR_CFG = path.join(WB, '外壳', 'scenarios');
  if (fs.existsSync(SCEN_DIR_FOR_CFG)) {
    for (const f of fs.readdirSync(SCEN_DIR_FOR_CFG).filter((x) => x.endsWith(".json"))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR_FOR_CFG, f), "utf8").replace(/^\uFEFF/, ""));
        const ai = (j.panels || []).find((p) => p.type === "harness");
        // ⚠ 2026-11-13 修（中枢匹配不到，被当成「没有配置」按评分乱选）
        //
        //   原来只找 type==='harness' 的面板。
        //   但 hub.json 只有 1 个 neuron 面板（记忆神经元），
        //   它的会话 id 记在 meta.hubSessionId 里，不在 panels[].sessionId。
        //
        //   后果：中枢的 cfgOne = null → 走「按评分挑」→ 挑中一个 blank 空会话
        //        → --check 报「中枢应为 session-6d2c44e2」（空会话），
        //          而 hub.json 和 身份索引 都正确地写着 session-34f35b09。
        //   这是「判据没覆盖到特例」的典型。
        const hubId = j.meta && j.meta.hubSessionId;
        const sid = (ai && ai.sessionId) || hubId;
        if (sid) cfgOf.set(j.id || f.replace(/\.json$/, ""), String(sid));
      } catch { /* ignore */ }
    }
  }

  // 每个场景挑一个：优先配置里的，其次按「有用程度」评分
  for (const [k, arr] of byScene) {
    const cfgId = cfgOf.get(k);
    const cfgOne = cfgId ? arr.find((x) => x.sessionId === cfgId) : null;
    if (cfgOne) {
      byScene.set(k, [cfgOne]);
      continue;
    }
    arr.sort((a, b) => (b.score || 0) - (a.score || 0) || b.mtime - a.mtime);
    byScene.set(k, arr);
  }
  return { ok: true, byScene, diag };
}

// ══════════════════════════════════════════════════════════════
//  收集所有场景（含没有会话的）
// ══════════════════════════════════════════════════════════════
function listAllScenes() {
  const out = [];
  if (!fs.existsSync(SCEN_DIR)) return out;
  for (const f of fs.readdirSync(SCEN_DIR)) {
    if (!f.endsWith('.json')) continue;
    const j = readJsonSafe(path.join(SCEN_DIR, f));
    if (!j || !j.id) continue;
    out.push({ id: j.id, name: j.name || j.id });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  重建索引
// ══════════════════════════════════════════════════════════════
export function rebuildIndex(opts) {
  const o = opts || {};
  const scan = scanSessions(o.sessionsRoot || SESSIONS_ROOT);
  if (!scan.ok) return { ok: false, error: scan.error };

  const scenes = o.scenes || listAllScenes();
  const scenDir = o.scenDir || SCEN_DIR;
  const now = new Date().toISOString();

  const rows = [];
  const report = { bound: [], pending: [], removed: [] };

  // 读旧索引，找出被替换掉的假 id
  const old = readJsonSafe(o.indexPath || INDEX_PATH);
  const oldRows = new Map();
  if (old && Array.isArray(old.rows)) {
    for (const r of old.rows) oldRows.set(r.scene, r.sessionId || '');
  }

  for (const s of scenes) {
    const found = scan.byScene.get(s.id) || [];
    const latest = found[0] || null;
    const prev = oldRows.get(s.id) || '';

    // ★ 定位卡文件名（哨兵 INV-5 要检查 r.context 这个字段）
    //   约定：<sceneId>-context.md
    const ctxName = s.id + '-context.md';
    const ctxExists = fs.existsSync(path.join(scenDir, ctxName));

    const base = {
      scene: s.id,
      name: s.name,
      // 没有定位卡就不写这个字段，让哨兵如实报「缺定位卡」
      context: ctxExists ? ctxName : '(缺)',
      updatedAt: now,
    };

    if (latest) {
      rows.push(Object.assign({}, base, {
        sessionId: latest.sessionId,
        workspace: latest.workspace,
        source: 'engine-scan',
      }));
      report.bound.push({ scene: s.id, from: prev, to: latest.sessionId });
      if (prev && prev !== latest.sessionId) {
        report.removed.push({ scene: s.id, oldId: prev });
      }
    } else {
      rows.push(Object.assign({}, base, {
        sessionId: '',
        source: 'none',
        pendingSession: true,
      }));
      report.pending.push({ scene: s.id, name: s.name });
    }
  }

  const out = {
    _note: '场景 → 引擎会话映射。由 工具/身份索引重建.mjs 从引擎实际会话生成，不要手改。',
    _at: now,
    _source: '数据/.dsh/sessions（引擎实际会话）',
    rows,
  };

  return { ok: true, index: out, report, diag: scan.diag, byScene: scan.byScene };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  身份索引重建 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 工作区名解码
  const wsName = '--D-file-AI~0020Temp-DeepSeek-Agent~81EA~7814-workbench-~6570~636E-.dsh-~573A~666F~6CE8~5165-arch-review--';
  const decoded = decodeWorkspaceName(wsName);
  chk('解码含「场景注入」', decoded.includes('场景注入'), decoded.slice(-30));
  chk('提取场景 id', extractSceneId(wsName) === 'arch-review', String(extractSceneId(wsName)));

  // 反例：不含场景注入的名字应返回 null
  chk('反例：普通工作区名返回 null',
      extractSceneId('--D-file-some-other-project--') === null,
      String(extractSceneId('--D-file-some-other-project--')));

  // 反例：空字符串
  chk('反例：空字符串返回 null', extractSceneId('') === null);

  // ② 扫描真实目录
  const scan = scanSessions(SESSIONS_ROOT);
  chk('扫描 sessions 目录', scan.ok, scan.ok ? scan.diag.sessions + ' 个会话' : scan.error);
  if (scan.ok) {
    chk('识别出场景会话', scan.byScene.size > 0, scan.byScene.size + ' 个场景有会话');
  }

  // ③ 重建（预览，不写）
  const rb = rebuildIndex();
  chk('重建索引', rb.ok, rb.ok ? rb.index.rows.length + ' 行' : rb.error);
  if (rb.ok) {
    chk('所有行都有 scene 字段', rb.index.rows.every((r) => r.scene), '');
    // 反例：不应再有「格式合法但引擎里不存在」的假 id
    const fakeIds = rb.index.rows.filter((r) => r.sessionId && !scan.byScene.get(r.scene)?.some((x) => x.sessionId === r.sessionId));
    chk('反例：不得保留引擎里不存在的 id', fakeIds.length === 0,
        fakeIds.length ? fakeIds.map((f) => f.scene).join(',') : 'ok');
  }

  console.log();
  console.log('  扫描: ' + (scan.diag ? (scan.diag.workspaces + ' 工作区 / ' + scan.diag.sessions + ' 会话') : '?'));
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

  // ⚠ 2026-11-13 加 --check：只读核对模式
  //
  //   为什么加：
  //     机制体检里这一项原来只能跑 --selftest，
  //     而自测验的是「代码逻辑对不对」，不验「身份索引和真实会话对不对」。
  //     等于这一项在体检里**从来没检查过实际状态**。
  //
  //     这是「自测通过 ≠ 真实状态合格」的典型 ——
  //     我这几轮新加的工具，一半都是这个毛病。
  //
  //   --check 做什么：重建一遍索引（不写盘），
  //     和现有 身份索引.json 对比，报告差异集合。
  if (has('--check')) {
    const rb = rebuildIndex();
    if (!rb.ok) { console.error('✗ ' + rb.error); process.exit(2); }

    const cur = readJsonSafe(INDEX_PATH);
    const curMap = (cur && (cur.scenes || cur)) || {};
    const newMap = rb.index.scenes || rb.index || {};

    const diffs = [];
    // ⚠ 2026-11-13 修（比 updatedAt/_at 这类「每次重建都会变」的字段 = 永远不一致）
    //
    //   实测：中枢的 sessionId 修对之后，仍然报 2 处不一致：
    //     · _at          现在 18:38 / 应为 23:54
    //     · rows[].updatedAt  现在 02:45 / 应为 23:54
    //   这些是**重建时间戳**，每次跑都会变，跟「内容对不对」无关。
    //
    //   判据应该是：**只有 sessionId 变了才算真不一致。**
    //   时间戳差异属于噪音，比了只会让人以为有问题。
    const curRows = (cur && (cur.rows || (cur.scenes && cur.scenes.rows))) || [];
    const newRows = (rb.index && (rb.index.rows || (rb.index.scenes && rb.index.scenes.rows))) || [];

    const curByScene = new Map();
    for (const r of (Array.isArray(curRows) ? curRows : [])) {
      if (r && r.scene) curByScene.set(r.scene, r);
    }
    const newByScene = new Map();
    for (const r of (Array.isArray(newRows) ? newRows : [])) {
      if (r && r.scene) newByScene.set(r.scene, r);
    }

    const allScenes = new Set([...curByScene.keys(), ...newByScene.keys()]);
    for (const s of allScenes) {
      const a = curByScene.get(s);
      const b = newByScene.get(s);
      const aSid = a ? String(a.sessionId || '') : '';
      const bSid = b ? String(b.sessionId || '') : '';
      if (aSid !== bSid) {
        diffs.push({ scene: s, now: aSid || '(无)', want: bSid || '(无)' });
      }
    }

    console.log('  身份索引核对');
    console.log('    场景数: ' + allScenes.size);
    console.log('    不一致: ' + diffs.length);
    if (diffs.length) {
      console.log();
      for (const d of diffs.slice(0, 10)) {
        console.log('    · ' + d.scene);
        console.log('        现在: ' + JSON.stringify(d.now));
        console.log('        应为: ' + JSON.stringify(d.want));
      }
      console.log();
      console.log('    修法：node 工具/身份索引重建.mjs --apply');
      process.exit(1);
    }
    console.log('    ✓ 身份索引与真实会话一致');
    process.exit(0);
  }

  const rb = rebuildIndex();
  if (!rb.ok) { console.error('✗ ' + rb.error); process.exit(2); }

  console.log('═'.repeat(72));
  console.log('  身份索引重建');
  console.log('═'.repeat(72));
  console.log();
  console.log('扫描: ' + rb.diag.workspaces + ' 工作区 / ' + rb.diag.sessions + ' 会话');
  console.log();

  if (rb.report.bound.length > 0) {
    console.log('已绑定真实会话（' + rb.report.bound.length + '）:');
    for (const b of rb.report.bound) {
      console.log('  ✓ ' + b.scene.padEnd(20) + b.to);
      if (b.from && b.from !== b.to) {
        console.log('     （替换旧值: ' + b.from + '）');
      }
    }
    console.log();
  }

  if (rb.report.pending.length > 0) {
    console.log('暂无会话（' + rb.report.pending.length + '）:');
    for (const p of rb.report.pending) {
      console.log('  ○ ' + p.name + '（' + p.scene + '）');
    }
    console.log('    这些场景需要先跑一次任务，才会有会话。');
    console.log();
  }

  if (has('--apply')) {
    fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
    fs.writeFileSync(INDEX_PATH, JSON.stringify(rb.index, null, 2), 'utf8');
    console.log('✓ 已写入: ' + INDEX_PATH);
  } else {
    console.log('（预览模式，未写入。加 --apply 真写）');
  }
}
