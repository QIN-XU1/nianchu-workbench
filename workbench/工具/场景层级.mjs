#!/usr/bin/env node
/**
 * 场景层级 —— 主场景 / 子场景
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV19KW464Eov 原文）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [03:00] 「至于你想一个场景管理多台服务器，完全可以实现。
 *  > 你可以让某一个场景只管某一个业务，
 *  > 然后你单独设了一个新的场景，比如说这个场景就叫『服务器管理』。
 *  > 你把这些理清楚之后，你会发现可能就只需要一个**主场景**，
 *  > 这个主场景专门负责服务器；还有**子场景**，
 *  > 子场景的话就是负责这些服务器里面具体业务，就解决了。」
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要这个
 * ══════════════════════════════════════════════════════════════
 *
 *  用户早期的批评：「如果有几百几千个场景需要融入，你又该怎么编排呢？」
 *
 *  我们的现状：9 个场景**纯平级**。
 *  平级结构的致命问题：场景多了之后，
 *    · 中枢不知道该派给谁（候选太多）
 *    · 场景之间无法归组
 *    · 一个业务需要多个场景时没有「负责人」
 *
 *  他的解法：主场景 + 子场景
 *    · 主场景：管一类业务，是这一类的「入口和负责人」
 *    · 子场景：管具体实例，只对主场景负责
 *
 * ══════════════════════════════════════════════════════════════
 *  设计原则：不破坏现有结构
 * ══════════════════════════════════════════════════════════════
 *
 *  场景 JSON 保持原样，另建一份层级配置文件：
 *    数据/.dsh/场景层级.yaml
 *
 *  这样：
 *    · 现有 9 个场景不用改（都是 root 级）
 *    · 新增场景时可以声明 parent
 *    · 中枢派单时先找主场景，主场景再分给子场景
 *
 * ══════════════════════════════════════════════════════════════
 *  层级规则（写死，可校验）
 * ══════════════════════════════════════════════════════════════
 *
 *  ① 最多三层（root → main → sub），不许无限深
 *  ② 一个有子场景的场景 = 主场景（parent 为空且有 children）
 *  ③ 子场景必须有 parent，且 parent 必须存在
 *  ④ 不许循环（A→B→A）
 *  ⑤ 中枢只能派给「root 级」或「main 级」，不直接派给 sub
 *     （sub 只对 main 负责）
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/场景层级.mjs --init                            从现有场景生成初始层级
 *  node 工具/场景层级.mjs --list                            列出层级树
 *  node 工具/场景层级.mjs --validate                        校验
 *  node 工具/场景层级.mjs --resolve 架构梳理                 查它的派单归属
 *  node 工具/场景层级.mjs --selftest                        自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const LAYER_FILE = path.join(DATA_ROOT, '场景层级.yaml');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

export const RULES = {
  /** 最大层级深度 */
  MAX_DEPTH: 3,
  /** 允许的层级角色 */
  ROLES: ['root', 'main', 'sub'],
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  YAML 解析（我们的结构：scene: 下每个 id 一段）
// ══════════════════════════════════════════════════════════════
export function parseLayerYaml(text) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  const out = {};
  let cur = null;

  for (const line of s.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    // 顶层 key（场景 id）
    const top = line.match(/^  ([a-z][a-z0-9-]*):\s*$/);
    if (top) {
      cur = top[1];
      out[cur] = {};
      continue;
    }
    if (!cur) continue;

    const kv = line.match(/^    (\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[cur][kv[1]] = v;
  }
  return out;
}

export function stringifyLayerYaml(layers) {
  const lines = [
    '# 场景层级 —— 主场景 / 子场景',
    '#',
    '# 设计依据（视频 BV19KW464Eov）：',
    '#   「你会发现可能就只需要一个主场景，这个主场景专门负责服务器；',
    '#    还有子场景，子场景的话就是负责这些服务器里面具体业务。」',
    '#',
    '# 字段：',
    '#   parent  上级场景 id（root 为空）',
    '#   role    root / main / sub',
    '#   scope   这个场景管什么（一句话）',
    '',
    'scene:',
  ];
  for (const [id, cfg] of Object.entries(layers)) {
    lines.push('  ' + id + ':');
    lines.push('    parent: "' + (cfg.parent || '') + '"');
    lines.push('    role: ' + (cfg.role || 'root'));
    if (cfg.scope) lines.push('    scope: "' + String(cfg.scope).replace(/"/g, '\\"') + '"');
  }
  return lines.join('\n') + '\n';
}

export function loadLayers(file) {
  const t = readTextSafe(file || LAYER_FILE);
  if (t === null) return {};
  const raw = parseLayerYaml(t);
  // 规范化：parent 空字符串 → null
  const out = {};
  for (const [id, cfg] of Object.entries(raw)) {
    out[id] = {
      parent: cfg.parent && cfg.parent !== '' ? cfg.parent : null,
      role: cfg.role || 'root',
      scope: cfg.scope || '',
    };
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  校验
// ══════════════════════════════════════════════════════════════
export function validateLayers(layers, knownSceneIds) {
  const problems = [];
  const ids = Object.keys(layers);

  // ① 每个场景都在层级表里
  for (const id of (knownSceneIds || [])) {
    if (!layers[id]) problems.push('场景 ' + id + ' 不在层级表里');
  }

  // ② parent 必须存在
  for (const [id, cfg] of Object.entries(layers)) {
    if (cfg.parent && !layers[cfg.parent]) {
      problems.push(id + ' 的 parent「' + cfg.parent + '」不存在');
    }
    // ③ role 合法
    if (!RULES.ROLES.includes(cfg.role)) {
      problems.push(id + ' 的 role 非法：' + cfg.role);
    }
  }

  // ④ 无循环
  for (const id of ids) {
    const seen = new Set([id]);
    let cur = layers[id]?.parent;
    let depth = 1;
    while (cur) {
      if (seen.has(cur)) { problems.push('循环引用：' + [...seen].join(' → ') + ' → ' + cur); break; }
      seen.add(cur);
      depth++;
      if (depth > RULES.MAX_DEPTH + 2) { problems.push(id + ' 层级过深（>' + RULES.MAX_DEPTH + '）'); break; }
      cur = layers[cur]?.parent;
    }
    if (depth > RULES.MAX_DEPTH) {
      problems.push(id + ' 深度 ' + depth + ' 超过上限 ' + RULES.MAX_DEPTH);
    }
  }

  // ⑤ role 与 parent/children 一致
  const children = {};
  for (const [id, cfg] of Object.entries(layers)) {
    if (cfg.parent) {
      children[cfg.parent] = children[cfg.parent] || [];
      children[cfg.parent].push(id);
    }
  }
  for (const [id, cfg] of Object.entries(layers)) {
    const hasChildren = (children[id] || []).length > 0;
    const hasParent = !!cfg.parent;

    if (cfg.role === 'root' && hasParent) {
      problems.push(id + ' 标为 root 但有 parent');
    }
    if (cfg.role === 'main' && !hasChildren) {
      problems.push(id + ' 标为 main 但没有子场景');
    }
    if (cfg.role === 'sub' && !hasParent) {
      problems.push(id + ' 标为 sub 但没有 parent');
    }
    if (hasChildren && cfg.role === 'sub') {
      problems.push(id + ' 有子场景却标为 sub');
    }
  }

  return problems;
}

// ══════════════════════════════════════════════════════════════
//  查派单归属
//
//  规则：中枢只派给 root 或 main，不直接派给 sub
// ══════════════════════════════════════════════════════════════
export function resolveDispatch(sceneId, layers) {
  const cfg = layers[sceneId];
  if (!cfg) return { ok: false, reason: '场景不在层级表里: ' + sceneId };

  // 找根
  let root = sceneId;
  let depth = 0;
  while (layers[root]?.parent && depth < 10) {
    root = layers[root].parent;
    depth++;
  }

  // sub 不直接接收中枢派单
  if (cfg.role === 'sub') {
    return {
      ok: true,
      directDispatch: false,
      mustGoThrough: cfg.parent,
      root,
      reason: '这是子场景，中枢不直接派给它，要通过主场景 ' + cfg.parent + ' 转派',
      chain: [root, cfg.parent, sceneId].filter(Boolean),
    };
  }

  return {
    ok: true,
    directDispatch: true,
    target: sceneId,
    root,
    reason: '可直接派单',
    chain: [root].filter(Boolean),
  };
}

/** 构建层级树（用于展示） */
export function buildTree(layers) {
  const children = {};
  for (const [id, cfg] of Object.entries(layers)) {
    const p = cfg.parent || '_root';
    children[p] = children[p] || [];
    children[p].push(id);
  }
  function walk(node, depth) {
    const out = [];
    for (const id of (children[node] || []).sort()) {
      out.push({ id, depth, ...layers[id] });
      out.push(...walk(id, depth + 1));
    }
    return out;
  }
  return walk('_root', 0);
}

// ══════════════════════════════════════════════════════════════
//  从现有场景生成初始层级（全部 root）
// ══════════════════════════════════════════════════════════════
export function seedLayers() {
  const out = {};
  if (!fs.existsSync(SCEN_DIR)) return out;
  for (const f of fs.readdirSync(SCEN_DIR)) {
    if (!f.endsWith('.json')) continue;
    const j = readJsonSafe(path.join(SCEN_DIR, f));
    if (!j || !j.id) continue;
    out[j.id] = {
      parent: null,
      role: 'root',
      scope: String(j.description || '').slice(0, 60),
    };
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  场景层级 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 规则常量
  chk('最大深度 3', RULES.MAX_DEPTH === 3, String(RULES.MAX_DEPTH));
  chk('三种角色', RULES.ROLES.length === 3, RULES.ROLES.join(','));

  // ② YAML 往返
  const sample = {
    hub: { parent: null, role: 'root', scope: '总调度' },
    'srv-mgmt': { parent: 'hub', role: 'main', scope: '服务器管理' },
    'srv-a': { parent: 'srv-mgmt', role: 'sub', scope: '服务器A' },
  };
  const yaml = stringifyLayerYaml(sample);
  const parsed = parseLayerYaml(yaml);
  chk('YAML 往返场景数', Object.keys(parsed).length === 3, Object.keys(parsed).length + '');
  chk('YAML 往返 parent', parsed['srv-a']?.parent === 'srv-mgmt', parsed['srv-a']?.parent);
  chk('YAML 往返 role', parsed['srv-mgmt']?.role === 'main', parsed['srv-mgmt']?.role);

  // ③ 校验：合格的层级
  const good = validateLayers(sample, ['hub', 'srv-mgmt', 'srv-a']);
  chk('合格层级无问题', good.length === 0, good.join(';') || 'ok');

  // ④ 反例：parent 不存在
  const badParent = validateLayers(
    { a: { parent: 'nope', role: 'sub' } }, ['a']);
  chk('反例：parent 不存在被拒', badParent.some((p) => p.includes('不存在')), '');

  // ⑤ 反例：循环
  const circular = validateLayers({
    a: { parent: 'b', role: 'sub' },
    b: { parent: 'a', role: 'sub' },
  }, ['a', 'b']);
  chk('反例：循环被拒', circular.some((p) => p.includes('循环')), '');

  // ⑥ 反例：main 没有子场景
  const badMain = validateLayers({ a: { parent: null, role: 'main' } }, ['a']);
  chk('反例：main 无子被拒', badMain.some((p) => p.includes('没有子场景')), '');

  // ⑦ 反例：sub 没有 parent
  const badSub = validateLayers({ a: { parent: null, role: 'sub' } }, ['a']);
  chk('反例：sub 无 parent 被拒', badSub.some((p) => p.includes('没有 parent')), '');

  // ⑧ 派单归属
  const r1 = resolveDispatch('hub', sample);
  chk('root 可直接派', r1.directDispatch === true, '');

  const r2 = resolveDispatch('srv-mgmt', sample);
  chk('main 可直接派', r2.directDispatch === true, '');

  const r3 = resolveDispatch('srv-a', sample);
  chk('sub 不可直接派', r3.directDispatch === false, '');
  chk('sub 要经主场景', r3.mustGoThrough === 'srv-mgmt', r3.mustGoThrough);
  chk('sub 能追溯到根', r3.root === 'hub', r3.root);

  // ⑨ 树结构
  const tree = buildTree(sample);
  chk('树有 3 个节点', tree.length === 3, tree.length + '');
  chk('树深度递增', tree[0].depth === 0 && tree[2].depth === 2,
      tree.map((t) => t.id + ':' + t.depth).join(','));

  // ⑩ 关键：这个层级真的能组织场景
  chk('关键：主场景能管子场景', tree.some((t) => t.role === 'main' && t.depth === 1), '');

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

  // ── 初始化 ──
  if (has('--init')) {
    if (fs.existsSync(LAYER_FILE) && !has('--force')) {
      console.log('已存在: ' + path.relative(WB, LAYER_FILE).replace(/\\/g, '/'));
      console.log('（加 --force 覆盖）');
      process.exit(0);
    }
    const seed = seedLayers();
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.writeFileSync(LAYER_FILE, stringifyLayerYaml(seed), 'utf8');
    console.log('✓ 已初始化 ' + Object.keys(seed).length + ' 个场景的层级');
    console.log('  全部为 root（平级）—— 现有场景本来就没有层级');
    console.log('  要建主/子关系，编辑 ' + path.relative(WB, LAYER_FILE).replace(/\\/g, '/'));
    console.log('  并把 role 改为 main/sub、填上 parent');
    process.exit(0);
  }

  const layers = loadLayers();

  // ── 列出 ──
  if (has('--list') || (!has('--init') && !has('--validate') && !has('--resolve'))) {
    if (Object.keys(layers).length === 0) {
      console.log('还没有层级配置。先跑: node 工具/场景层级.mjs --init');
      process.exit(2);
    }
    const tree = buildTree(layers);
    console.log('═'.repeat(72));
    console.log('  场景层级（' + tree.length + ' 个）');
    console.log('═'.repeat(72));
    console.log();
    for (const n of tree) {
      const indent = '  '.repeat(n.depth);
      const mark = n.role === 'root' ? '●' : n.role === 'main' ? '◆' : '○';
      console.log('  ' + indent + mark + ' ' + n.id + (n.scope ? '  ' + n.scope : ''));
    }
    console.log();
    console.log('─'.repeat(72));
    console.log('  ● root 级   ◆ 主场景（有子）   ○ 子场景');
    console.log('─'.repeat(72));
    process.exit(0);
  }

  // ── 校验 ──
  if (has('--validate')) {
    const sceneIds = [];
    if (fs.existsSync(SCEN_DIR)) {
      for (const f of fs.readdirSync(SCEN_DIR)) {
        if (!f.endsWith('.json')) continue;
        const j = readJsonSafe(path.join(SCEN_DIR, f));
        if (j?.id) sceneIds.push(j.id);
      }
    }
    const problems = validateLayers(layers, sceneIds);
    console.log('═'.repeat(72));
    console.log('  场景层级校验');
    console.log('═'.repeat(72));
    console.log();
    console.log('  场景数: ' + Object.keys(layers).length);
    console.log('  配置里: ' + sceneIds.length);
    console.log();
    if (problems.length === 0) {
      console.log('  ✓ 无问题');
    } else {
      for (const p of problems) console.log('  ✗ ' + p);
    }
    process.exit(problems.length === 0 ? 0 : 1);
  }

  // ── 查派单归属 ──
  if (has('--resolve')) {
    const id = val('--resolve');
    const r = resolveDispatch(id, layers);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
}
