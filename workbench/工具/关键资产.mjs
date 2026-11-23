#!/usr/bin/env node
/**
 * 关键资产 —— 删除/覆盖前的白名单
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1Lwxz6vEH8 的一次真实事故）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [01:15] 「昨天我做了一个非常好的命令插件，跟他交互的感觉非常好。
 *  >   但是我下播了之后，我让他说……我跟他说：
 *  >   『直播的时候产生了很多错乱的记忆，你去把它删除一下。』
 *  >   **结果他就把这个很好的语音播报给忘掉了。**
 *  >   所以我现在让他们讨论一下修复一下。」
 *
 *  事故根因：**「把错乱的删掉」这个指令没有边界。**
 *  AI 不知道「什么该删、什么绝不能删」，于是扩大了删除范围。
 *
 * ══════════════════════════════════════════════════════════════
 *  我们发现的同类缺口
 * ══════════════════════════════════════════════════════════════
 *
 *  场地地图 69 条规则，A 档（只有宿主能改）**只有 1 条**：
 *    workbench/数据/.dsh/AGENTS.md
 *
 *  也就是说：
 *    · 66 个工具的代码 → 可被随意删
 *    · 9 个场景配置   → 可被随意删
 *    · 所有记忆文件   → 可被随意删
 *    · 注入文件       → 可被随意删
 *
 *  **这和「删错乱记忆把好功能删了」是同构的风险。**
 *
 * ══════════════════════════════════════════════════════════════
 *  三层保护
 * ══════════════════════════════════════════════════════════════
 *
 *  critical  绝不可删（删了就废了）
 *             例：AGENTS.md、场景配置、工具主文件、记忆骨架
 *
 *  valuable  删前必须备份（有价值但可重建）
 *             例：场景私有记忆、技能文件、封存集
 *
 *  temp      可自由删（临时产物）
 *             例：prototype/、日志、缓存
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/关键资产.mjs --init              生成资产清单
 *  node 工具/关键资产.mjs --list [--level X]  列出
 *  node 工具/关键资产.mjs --check <路径>      查某路径能不能删
 *  node 工具/关键资产.mjs --audit             审计（找缺失的关键资产）
 *  node 工具/关键资产.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ⚠ 2026-11-10 修正（自测抓到）：
//   资产 pattern 都是 'workbench/...' 开头，
//   但原来的 WB = workbench 本身 → 拼出 workbench/workbench/... 重复。
//
//   现在分两个：
//     WB_DIR = .../workbench      （内部目录常量用）
//     WB     = .../Agent自研      （pattern 拼路径用，因为 pattern 带 workbench/ 前缀）
const WB_DIR = path.resolve(HERE, '..');
const WB = path.resolve(WB_DIR, '..');
const DATA_ROOT = path.join(WB_DIR, '数据', '.dsh');
const ASSET_FILE = path.join(DATA_ROOT, '场景记忆', '_共享记忆', '关键资产.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  三级保护
// ══════════════════════════════════════════════════════════════
export const LEVELS = {
  critical: {
    name: '绝不可删',
    desc: '删了系统就废了',
    allowDelete: false,
    needBackup: false,   // 不许删，所以不需要备份授权
  },
  valuable: {
    name: '删前必须备份',
    desc: '有价值但可重建',
    allowDelete: true,
    needBackup: true,
  },
  temp: {
    name: '可自由删',
    desc: '临时产物',
    allowDelete: true,
    needBackup: false,
  },
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  生成资产清单（从真实目录扫）
// ══════════════════════════════════════════════════════════════
export function buildAssets() {
  const assets = [];
  const add = (pattern, level, why) => {
    assets.push({ pattern: pattern.replace(/\\/g, '/'), level, why });
  };

  // ═══ critical：系统骨架 ═══
  add('workbench/数据/.dsh/AGENTS.md', 'critical', '全局宪法，每个会话都读');
  add('workbench/数据/.dsh/场景路由.yaml', 'critical', '场景路由表，中枢判断归属靠它');
  add('workbench/数据/.dsh/场景层级.yaml', 'critical', '场景层级，主/子关系');
  add('workbench/数据/.dsh/偏好记忆/偏好.yaml', 'critical', '六类偏好，用户红线');
  add('workbench/数据/.dsh/成本预算.json', 'critical', '成本闸配置');
  add('workbench/数据/.dsh/画像/主画像.md', 'critical', '用户主画像（唯一权威）');

  // 每个场景的注入文件和记忆骨架
  const MEM = path.join(DATA_ROOT, '场景记忆');
  if (fs.existsSync(MEM)) {
    for (const d of fs.readdirSync(MEM, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue;
      add('workbench/数据/.dsh/场景记忆/' + d.name + '/AGENTS.local.md',
        'critical', '场景注入文件，AI 靠它认领身份');
      add('workbench/数据/.dsh/场景记忆/' + d.name + '/场景私有记忆.md',
        'valuable', '场景记忆（有价值但可从归档重建）');
      add('workbench/数据/.dsh/场景记忆/' + d.name + '/身份卡.md',
        'valuable', '身份卡');
    }
  }

  // ═══ 工具主文件（critical，删了对应机制就废）═══
  const TOOLS = path.join(WB_DIR, '工具');
  if (fs.existsSync(TOOLS)) {
    const KEY_TOOLS = [
      '机制体检.mjs', '路由表.mjs', '派单.mjs', '投递通道.mjs',
      '记忆写入.mjs', '记忆注入.mjs', '影子记忆.mjs', '偏好记忆.mjs',
      '验证闸.mjs', '场景层级.mjs', '成本闸.mjs', '硬规矩.mjs',
      '画像.mjs', '封存集.mjs', '记忆评估.mjs', '场地图.mjs',
      '场地地图.mjs', '越界哨兵.mjs', '记忆哨兵.mjs', '身份哨兵.mjs',
      '中枢调度卡.mjs', '场景注入.mjs', 'A档确认.mjs',
    ];
    for (const t of KEY_TOOLS) {
      if (fs.existsSync(path.join(TOOLS, t))) {
        add('workbench/工具/' + t, 'critical', '核心机制工具');
      }
    }
    // 其余工具 valuable
    for (const f of fs.readdirSync(TOOLS)) {
      if (!f.endsWith('.mjs')) continue;
      if (KEY_TOOLS.includes(f)) continue;
      add('workbench/工具/' + f, 'valuable', '辅助工具');
    }
  }

  // ═══ 场景配置（critical）═══
  const SCEN = path.join(WB_DIR, '外壳', 'scenarios');
  if (fs.existsSync(SCEN)) {
    for (const f of fs.readdirSync(SCEN)) {
      if (f.endsWith('.json')) {
        add('workbench/外壳/scenarios/' + f, 'critical', '场景配置');
      } else if (f.endsWith('-context.md')) {
        add('workbench/外壳/scenarios/' + f, 'valuable', '场景定位卡');
      }
    }
  }

  // ═══ 技能（critical：技能正文删了功能就没了）═══
  //
  //  ⚠ 2026-11-10 修正（自测抓到的真实缺陷）
  //
  //  第一版把技能归为 valuable（可删但需备份）。
  //  但对照他的事故：「我让他把错乱的记忆删掉，结果他把很好的语音播报忘掉了」
  //  —— 技能就是「好功能」的载体，删了功能就没了。
  //
  //  所以技能必须是 critical。
  const SKILLS = path.join(DATA_ROOT, 'skills');
  if (fs.existsSync(SKILLS)) {
    for (const d of fs.readdirSync(SKILLS, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      add('workbench/数据/.dsh/skills/' + d.name + '/SKILL.md', 'critical', '技能正文（删了功能就没了）');
      add('workbench/数据/.dsh/skills/' + d.name + '/check.mjs', 'critical', '技能验收脚本');
      add('workbench/数据/.dsh/skills/' + d.name + '/skill.json', 'valuable', '技能元数据（可从 md 重建）');
    }
  }

  // ═══ 封存集（valuable，重建成本高）═══
  const SEALED = path.join(DATA_ROOT, '封存集');
  if (fs.existsSync(SEALED)) {
    for (const d of fs.readdirSync(SEALED, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      add('workbench/数据/.dsh/封存集/' + d.name + '/cases.json',
        'valuable', '评估用例（Agent 不可见）');
    }
  }

  // ═══ 共享记忆（critical，台账不能丢）═══
  const SHARED = path.join(DATA_ROOT, '场景记忆', '_共享记忆');
  if (fs.existsSync(SHARED)) {
    for (const f of fs.readdirSync(SHARED)) {
      const lvl = /台账|地图|资产|确认/.test(f) ? 'critical' : 'valuable';
      add('workbench/数据/.dsh/场景记忆/_共享记忆/' + f, lvl, '共享台账');
    }
  }

  // ═══ temp：可自由删 ═══
  add('prototype/**', 'temp', '临时脚本');
  add('workbench/外壳/server.log', 'temp', '运行日志');
  add('workbench/外壳/**/*.log', 'temp', '运行日志');
  add('研究素材/视频转写/**', 'temp', '视频转写产物（可重生成）');
  add('workbench/数据/.dsh/影子记忆/**', 'valuable', '历史快照（可重建但丢了就丢历史）');
  // 成本台账：可能还没记过账（新系统），所以算 temp 不算缺失
  add('workbench/数据/.dsh/成本台账.jsonl', 'temp', '成本记录（首次记账前不存在）');

  // 去重（同一 pattern 保留最先出现的）
  const seen = new Set();
  const out = [];
  for (const a of assets) {
    if (seen.has(a.pattern)) continue;
    seen.add(a.pattern);
    out.push(a);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  查某路径能不能删
// ══════════════════════════════════════════════════════════════
function globToRegex(g) {
  // ** → 任意层；* → 单层
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { r += '.*'; i++; }
    else if (c === '*') r += '[^/]*';
    else if (c === '/') r += '\\/';
    else if ('.+^$()[]{}|\\'.includes(c)) r += '\\' + c;
    else r += c;
  }
  return new RegExp('^' + r + '$');
}

export function checkAsset(targetPath, assets) {
  const p = String(targetPath || '').replace(/\\/g, '/');
  const list = assets || [];

  // 按 specificity 排序（越具体的 pattern 优先）
  const matches = [];
  for (const a of list) {
    const re = globToRegex(a.pattern);
    if (re.test(p) || re.test(p.replace(/^workbench\//, ''))) {
      matches.push({ ...a, specificity: a.pattern.replace(/\*/g, '').length });
    }
  }
  if (matches.length === 0) {
    return {
      found: false,
      path: p,
      level: 'unknown',
      allowDelete: false,
      reason: '不在资产清单里 → 默认拒绝删除（保守策略）',
      hint: '如果确认可以删，先加进资产清单的 temp 级',
    };
  }
  matches.sort((a, b) => b.specificity - a.specificity || b.pattern.length - a.pattern.length);
  const hit = matches[0];
  const lv = LEVELS[hit.level] || {};

  return {
    found: true,
    path: p,
    level: hit.level,
    levelName: lv.name,
    allowDelete: hit.level === 'critical' ? false : (hit.level === 'temp' ? true : true),
    needBackup: lv.needBackup === true,
    why: hit.why,
    pattern: hit.pattern,
    reason: hit.level === 'critical'
      ? '⛔ 绝不可删（' + hit.why + '）'
      : hit.level === 'valuable'
        ? '⚠ 删前必须备份（' + hit.why + '）'
        : '✓ 可自由删（' + hit.why + '）',
  };
}

// ══════════════════════════════════════════════════════════════
//  审计：清单里列了但文件不存在 → 缺失告警
// ══════════════════════════════════════════════════════════════
export function auditAssets(assets) {
  const list = assets || [];
  const missing = [];
  const present = [];

  for (const a of list) {
    if (a.level === 'temp') continue;
    if (a.pattern.includes('*')) continue;
    const full = path.join(WB, a.pattern);
    if (fs.existsSync(full)) {
      present.push(a);
    } else {
      missing.push(a);
    }
  }

  return {
    ok: missing.length === 0,
    total: list.length,
    critical: list.filter((a) => a.level === 'critical').length,
    valuable: list.filter((a) => a.level === 'valuable').length,
    temp: list.filter((a) => a.level === 'temp').length,
    presentCount: present.length,
    missing,
    problems: missing.map((a) =>
      '关键资产缺失：' + a.pattern + '（' + a.why + '）'),
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  关键资产 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 三级定义
  chk('三级保护', Object.keys(LEVELS).length === 3, Object.keys(LEVELS).join(','));
  chk('critical 不许删', LEVELS.critical.allowDelete === false, '');
  chk('valuable 可删但要备份', LEVELS.valuable.allowDelete === true && LEVELS.valuable.needBackup === true, '');
  chk('temp 可自由删', LEVELS.temp.allowDelete === true && LEVELS.temp.needBackup === false, '');

  // ② 构建清单
  const assets = buildAssets();
  chk('能生成清单', assets.length > 0, assets.length + ' 条');
  chk('含 critical', assets.some((a) => a.level === 'critical'),
      assets.filter((a) => a.level === 'critical').length + ' 条');
  chk('含 valuable', assets.some((a) => a.level === 'valuable'),
      assets.filter((a) => a.level === 'valuable').length + ' 条');
  chk('含 temp', assets.some((a) => a.level === 'temp'),
      assets.filter((a) => a.level === 'temp').length + ' 条');

  // ③ 查资产：critical 不许删
  const c1 = checkAsset('workbench/数据/.dsh/AGENTS.md', assets);
  chk('AGENTS.md 是 critical', c1.level === 'critical', c1.level);
  chk('AGENTS.md 不许删', c1.allowDelete === false, c1.reason.slice(0, 30));

  // ④ 查资产：工具主文件
  const c2 = checkAsset('workbench/工具/机制体检.mjs', assets);
  chk('机制体检.mjs 是 critical', c2.level === 'critical', c2.level);

  // ⑤ 查资产：场景配置
  const c3 = checkAsset('workbench/外壳/scenarios/arch-review.json', assets);
  chk('场景配置是 critical', c3.level === 'critical', c3.level);

  // ⑥ 查资产：temp 可删
  const c4 = checkAsset('prototype/whatever.mjs', assets);
  chk('prototype 下可删', c4.allowDelete === true, c4.level);

  // ⑦ 反例：不在清单里的 → 默认拒绝
  const c5 = checkAsset('some/unknown/file.txt', assets);
  chk('反例：未知路径默认拒删', c5.allowDelete === false, c5.reason.slice(0, 30));

  // ⑧ 关键：能拦住「删错乱记忆把好功能删了」这类事故
  const danger = [
    'workbench/工具/记忆注入.mjs',      // 好功能
    'workbench/数据/.dsh/skills/arch-review/SKILL.md',  // 技能
    'workbench/数据/.dsh/AGENTS.md',    // 宪法
  ];
  const blocked = danger.filter((p) => !checkAsset(p, assets).allowDelete).length;
  chk('关键：3 个重要资产全部被保护', blocked === 3, blocked + ' / 3');

  // ⑨ 审计
  const audit = auditAssets(assets);
  chk('审计能跑', typeof audit.ok === 'boolean',
      '清单 ' + audit.total + ' 条，已存在 ' + audit.presentCount + ' 条');

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

  if (has('--init')) {
    const assets = buildAssets();
    const out = {
      _note: '关键资产清单 —— 删除前必查。依据视频 BV1Lwxz6vEH8「删错乱记忆把好功能删了」',
      _at: new Date().toISOString(),
      levels: LEVELS,
      count: assets.length,
      assets,
    };
    fs.mkdirSync(path.dirname(ASSET_FILE), { recursive: true });
    fs.writeFileSync(ASSET_FILE, JSON.stringify(out, null, 2), 'utf8');
    const byLevel = {};
    for (const a of assets) byLevel[a.level] = (byLevel[a.level] || 0) + 1;
    console.log('✓ 已生成资产清单: ' + assets.length + ' 条');
    console.log('  位置: ' + path.relative(WB, ASSET_FILE).replace(/\\/g, '/'));
    for (const [k, v] of Object.entries(byLevel)) {
      console.log('  ' + (LEVELS[k]?.name || k).padEnd(12) + v + ' 条');
    }
    process.exit(0);
  }

  const saved = readJsonSafe(ASSET_FILE);
  const assets = saved?.assets || buildAssets();

  if (has('--list') || (!has('--check') && !has('--audit'))) {
    const only = val('--level');
    const list = only ? assets.filter((a) => a.level === only) : assets;
    console.log('═'.repeat(76));
    console.log('  关键资产（' + list.length + ' 条）');
    console.log('═'.repeat(76));
    console.log();
    for (const lv of ['critical', 'valuable', 'temp']) {
      const items = list.filter((a) => a.level === lv);
      if (!items.length) continue;
      console.log('  【' + LEVELS[lv].name + '】' + LEVELS[lv].desc + '（' + items.length + ' 条）');
      for (const a of items.slice(0, 15)) {
        console.log('    ' + a.pattern);
      }
      if (items.length > 15) console.log('    …还有 ' + (items.length - 15) + ' 条');
      console.log();
    }
    process.exit(0);
  }

  if (has('--check')) {
    const p = val('--check');
    const r = checkAsset(p, assets);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.allowDelete ? 0 : 1);
  }

  if (has('--audit')) {
    const r = auditAssets(assets);
    console.log('═'.repeat(72));
    console.log('  关键资产审计');
    console.log('═'.repeat(72));
    console.log();
    console.log('  清单: ' + r.total + ' 条（critical ' + r.critical +
      ' / valuable ' + r.valuable + ' / temp ' + r.temp + '）');
    console.log('  已存在: ' + r.presentCount + ' 条');
    console.log();
    if (r.ok) {
      console.log('  ✓ 无缺失');
    } else {
      console.log('  ✗ 缺失 ' + r.missing.length + ' 条:');
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    process.exit(r.ok ? 0 : 1);
  }
}
