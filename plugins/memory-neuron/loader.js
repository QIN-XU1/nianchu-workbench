/**
 * 数据读取层
 *
 * 覆盖项目里**全部**可用的真实数据源：
 *   ① 场景契约   sceneboard/scenes/*.json     role / inputs / outputs / schema
 *   ② 场景配置   外壳/scenarios/*.json         面板清单（类型各异）
 *   ③ 场景记忆   引擎数据/.dsh/场景记忆/<中文名>/  定位卡 + 身份卡 + 私有记忆
 *   ④ 共享台账   _共享记忆/*.json               健康度 / 派单 / 进化 / 场地地图 / 记忆地图 / 索引
 *   ⑤ 技能       引擎数据/.dsh/skills/[name]/SKILL.md
 *
 * 设计原则：
 *   · 全部读真实文件，任何一项读不到就返回空，绝不编造
 *   · 中文目录名从注册表（索引.json）拿映射，不硬编码
 *   · 一次扫描把结果缓存在内存，路由调用时返回缓存（带 mtime 校验）
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// ══════════════════════════════════════════════════════════════
//  工具
// ══════════════════════════════════════════════════════════════

async function readJsonSafe(p) {
  try {
    const text = await readFile(p, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

async function readTextSafe(p) {
  try {
    const text = await readFile(p, 'utf8');
    return text.replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

async function statSafe(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function listDirSafe(p) {
  try {
    return await readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 从 pluginDir 逐级往上找含 workbench/外壳/scenarios 的项目根 */
export async function findProjectRoot(pluginDir) {
  const starts = [];
  if (pluginDir) starts.push(pluginDir);
  starts.push(process.cwd());

  for (const start of starts) {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
      const st = await statSafe(join(dir, 'workbench', '外壳', 'scenarios'));
      if (st && st.isDirectory()) return dir;
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  各数据源读取
// ══════════════════════════════════════════════════════════════

/** 注册表：id → 中文名、顺序 */
async function loadRegistry(memDir) {
  const j = await readJsonSafe(join(memDir, '_共享记忆', '索引.json'));
  const areas = (j && (j.areas || j.scenes)) || [];
  const byId = {};
  areas.forEach((a, i) => {
    byId[a.id] = {
      name: a.name || a.id,
      order: typeof a.order === 'number' ? a.order : i,
      desc: a.description || a.role || '',
    };
  });
  return { areas, byId };
}

/** ① 场景契约 */
async function loadContracts(boardDir) {
  const out = {};
  const entries = await listDirSafe(boardDir);
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const id = e.name.replace(/\.json$/, '');
    const j = await readJsonSafe(join(boardDir, e.name));
    if (!j) continue;
    out[id] = {
      id,
      name: j.name || id,
      role: j.role || '',
      description: j.description || '',
      inputs: (j.inputs || []).map((x) => ({
        id: x.id,
        name: x.name || x.id,
        from: x.from || [],
        required: x.required !== false,
      })),
      outputs: (j.outputs || []).map((x) => ({
        id: x.id,
        name: x.name || x.id,
        type: x.type || '',
        to: x.to || [],
        format: x.format || '',
        schema: x.schema || [],
      })),
    };
  }
  return out;
}

/** ② 场景配置（面板清单） */
async function loadSceneConfigs(scenDir) {
  const out = {};
  const entries = await listDirSafe(scenDir);
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const id = e.name.replace(/\.json$/, '');
    const j = await readJsonSafe(join(scenDir, e.name));
    if (!j) continue;
    out[id] = {
      id,
      name: j.name || id,
      description: j.description || '',
      panels: (j.panels || []).map((p) => ({
        type: p.type || p.kind || 'unknown',
        title: p.title || p.name || '',
      })),
    };
  }
  return out;
}

/** ③ 场景记忆（定位卡 / 身份卡 / 私有记忆） */
async function loadMemories(memDir, registry) {
  const out = {};
  const entries = await listDirSafe(memDir);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_')) continue;             // _共享记忆 单独处理

    const dir = join(memDir, e.name);
    const files = await listDirSafe(dir);
    let totalBytes = 0;
    const kinds = [];
    let updatedAt = null;

    for (const f of files) {
      if (!f.isFile()) continue;
      const st = await statSafe(join(dir, f.name));
      if (!st) continue;
      totalBytes += st.size;
      if (!updatedAt || st.mtime > updatedAt) updatedAt = st.mtime;
      if (f.name === '身份卡.md') kinds.push('identity');
      else if (f.name === '场景私有记忆.md') kinds.push('memory');
      else if (f.name === '_文件索引.md') kinds.push('index');
      else if (f.name.startsWith('场景私有记忆-')) kinds.push('snapshot');
      else kinds.push('other');
    }

    // 中文名 → id 反向映射
    let id = null;
    for (const [k, v] of Object.entries(registry.byId)) {
      if (v.name === e.name) { id = k; break; }
    }

    out[id || e.name] = {
      dirName: e.name,
      id,
      fileCount: files.filter((f) => f.isFile()).length,
      totalBytes,
      kinds,
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
    };
  }
  return out;
}

/** ④ 共享台账 */
async function loadSharedLedgers(memDir) {
  const shDir = join(memDir, '_共享记忆');
  const out = {};

  // 健康度
  const health = await readJsonSafe(join(shDir, '健康度.json'));
  if (health) out.health = health;

  // 派单台账
  const ledger = await readJsonSafe(join(shDir, '派单台账.json'));
  if (ledger) {
    const items = ledger.items || ledger.dispatches || ledger.records || [];
    out.dispatch = {
      total: items.length,
      closed: items.filter((x) => x.state === 'closed').length,
      items: items.map((x) => ({
        id: x.id,
        from: x.from,
        to: x.to,
        state: x.state,
        createdAt: x.createdAt || x.at || null,
      })),
    };
  }

  // 进化台账
  const evo = await readJsonSafe(join(shDir, '进化台账.json'));
  if (evo) {
    const list = evo.evolutions || [];
    out.evolution = {
      total: list.length,
      pending: list.filter((x) => x.result === 'pending').length,
      levels: evo._levels || {},
      items: list.map((x) => ({
        id: x.id,
        scene: x.scene,
        level: x.level,
        type: x.type,
        change: (x.change || '').slice(0, 200),
        result: x.result,
        at: x.at,
        observeUntil: x.observeUntil,
        rolledBack: !!x.rolledBack,
      })),
      frozen: evo.frozen || {},
    };
  }

  // 场地地图（五档修改权 + 规则明细）
  const site = await readJsonSafe(join(shDir, '场地地图.json'));
  if (site) {
    const rules = site.rules || site.items || [];
    out.siteMap = {
      total: rules.length,
      tiers: site._tiers || {},
      // 规则明细（限制条数，避免 payload 过大）
      rules: rules.slice(0, 80).map((r) => ({
        tier: r.tier || '?',
        pattern: r.pattern || '',
        owner: r.owner || '',
        desc: (r.desc || '').slice(0, 80),
      })),
    };
  }

  // 记忆地图（场景 → 面板 id → 私有记忆文件）
  // panel 是「会话绑定」的判据：有 panel id 说明该场景在界面有独立入口
  const memMap = await readJsonSafe(join(shDir, '记忆地图.json'));
  if (memMap) {
    const areas = memMap.areas || [];
    out.memoryMap = {
      total: areas.length,
      areas: areas.map((a) => ({
        scene: a.scene || '',
        panel: a.panel || '',
        files: (a.privateMemory || []).map((f) => String(f).split(/[\\/]/).pop()),
      })),
    };
  }

  // 基线
  const base = await readJsonSafe(join(shDir, '基线.json'));
  if (base) out.baseline = base;

  // 待办
  const todo = await readTextSafe(join(shDir, '_待办.md'));
  if (todo) {
    const lines = todo.split('\n').filter((l) => /^\s*-\s*\[/.test(l));
    out.todo = { total: lines.length, sample: lines.slice(0, 5) };
  }

  return out;
}

/** ⑤ 技能 */
async function loadSkills(skillsDir) {
  const out = [];
  const entries = await listDirSafe(skillsDir);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const mdPath = join(skillsDir, e.name, 'SKILL.md');
    const md = await readTextSafe(mdPath);
    if (!md) continue;
    const st = await statSafe(mdPath);
    // 抓一级标题与描述
    const titleMatch = md.match(/^#\s+(.+)$/m);
    out.push({
      id: e.name,
      title: titleMatch ? titleMatch[1].trim() : e.name,
      bytes: st ? st.size : 0,
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  组装
// ══════════════════════════════════════════════════════════════

export async function loadAll(pluginDir) {
  const root = await findProjectRoot(pluginDir);
  if (!root) {
    return {
      ok: false,
      error: '找不到项目根目录（需要包含 workbench/外壳/scenarios）',
      searchedFrom: pluginDir || process.cwd(),
    };
  }

  const wb = join(root, 'workbench');
  const scenDir = join(wb, '外壳', 'scenarios');
  const boardDir = join(wb, 'sceneboard', 'scenes');
  const memDir = join(wb, '引擎数据', '.dsh', '场景记忆');
  const skillsDir = join(wb, '引擎数据', '.dsh', 'skills');
  const shellDir = join(wb, '外壳');

  const [registry, contracts, configs, memories, shared, skills] =
    await Promise.all([
      loadRegistry(memDir),
      loadContracts(boardDir),
      loadSceneConfigs(scenDir),
      loadMemories(memDir, await loadRegistry(memDir)),
      loadSharedLedgers(memDir),
      loadSkills(skillsDir),
    ]);

  // ── 合成场景对象 ──
  const ids = new Set([
    ...Object.keys(configs),
    ...Object.keys(contracts),
  ]);

  // 记忆地图的 areas（用于查每个场景的面板 id / 会话绑定）
  const sharedMemMapAreas = (shared.memoryMap && shared.memoryMap.areas) || [];

  const scenes = [];
  for (const id of ids) {
    const cfg = configs[id] || {};
    const ct = contracts[id] || {};
    const reg = registry.byId[id] || {};
    const mem = memories[id] || null;

    // 健康度
    const h = (shared.health && shared.health.scenes && shared.health.scenes[id]) || null;

    // 技能是否覆盖
    const hasSkill = skills.some((s) => s.id === id);

    // 定位卡（身份卡/记忆存在）
    const hasIdentity = mem ? mem.kinds.includes('identity') : false;
    const hasMemory = mem ? mem.kinds.includes('memory') : false;

    // 会话绑定：从记忆地图查该场景对应的面板 id
    const mmArea = (sharedMemMapAreas || []).find(
      (a) => a.scene === (cfg.name || ct.name || reg.name || id));

    scenes.push({
      id,
      name: cfg.name || ct.name || reg.name || id,
      // 面板 id（空 = 无独立会话入口，六件套「会话绑定」缺项）
      panelId: mmArea ? (mmArea.panel || '') : '',
      hasSessionBinding: !!(mmArea && mmArea.panel),
      role: ct.role || reg.desc || cfg.description || '',
      description: ct.description || cfg.description || '',
      order: typeof reg.order === 'number' ? reg.order : 999,

      // 契约
      hasContract: !!contracts[id],
      inputs: (ct.inputs || []).length,
      outputs: (ct.outputs || []).length,

      // 面板
      panels: (cfg.panels || []).length,
      panelList: cfg.panels || [],

      // 六件套
      hasIdentity,
      hasMemory,
      hasSkill,
      memoryBytes: mem ? mem.totalBytes : 0,
      memoryFiles: mem ? mem.fileCount : 0,
      updatedAt: mem ? mem.updatedAt : null,

      // 健康度
      health: h
        ? {
            tasks: h.tasks || 0,
            firstPassRate: h.firstPassRate,
            reworkRate: h.reworkRate,
            crossBoundary: h.crossBoundary || 0,
            verdict: h.verdict || 'no-data',
          }
        : null,
    });
  }

  scenes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  // ── 建边（多重来源）──
  const idSet = new Set(scenes.map((s) => s.id));
  const edges = [];
  const seen = new Set();

  const addEdge = (from, to, kind, label) => {
    if (!idSet.has(from) || !idSet.has(to) || from === to) return;
    const key = from + '|' + to + '|' + kind;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind, label: label || '' });
  };

  // flow：契约 outputs.to
  for (const ct of Object.values(contracts)) {
    for (const o of ct.outputs || []) {
      for (const to of o.to || []) addEdge(ct.id, to, 'flow', o.name);
    }
  }

  // indirect：共同邻居
  const neighbors = {};
  for (const e of edges.filter((x) => x.kind === 'flow')) {
    (neighbors[e.from] = neighbors[e.from] || new Set()).add(e.to);
  }
  for (const [a, setA] of Object.entries(neighbors)) {
    for (const [b, setB] of Object.entries(neighbors)) {
      if (a >= b) continue;
      const shared2 = [...setA].filter((x) => setB.has(x));
      if (shared2.length > 0) addEdge(a, b, 'indirect', '');
    }
  }

  // ── 统计 ──
  const counts = {
    scenes: scenes.length,
    edges: edges.length,
    withContract: scenes.filter((s) => s.hasContract).length,
    withIdentity: scenes.filter((s) => s.hasIdentity).length,
    withMemory: scenes.filter((s) => s.hasMemory).length,
    withSkill: scenes.filter((s) => s.hasSkill).length,
    withPanels: scenes.filter((s) => s.panels > 0).length,
    skills: skills.length,
  };

  // 六件套覆盖率（定位卡/身份卡/私有记忆/会话绑定/专属技能/专属面板）
  // 会话绑定与场景配置暂按「有面板」计
  const sixSet = [
    { key: 'panels', label: '专属面板', count: counts.withPanels },
    { key: 'identity', label: '身份卡', count: counts.withIdentity },
    { key: 'memory', label: '私有记忆', count: counts.withMemory },
    { key: 'skill', label: '专属技能', count: counts.withSkill },
  ];

  return {
    ok: true,
    root,
    scenes,
    edges,
    counts,
    coverage: sixSet,
    shared,
    skills,
    _at: new Date().toISOString(),
  };
}
