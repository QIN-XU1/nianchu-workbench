#!/usr/bin/env node
/**
 * 场地地图 —— 定义"谁的地盘是哪些路径"
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要它
 * ══════════════════════════════════════════════════════════════
 *
 *  E 档规矩："别人的专属，一个字都不许写"
 *  但"别人的"是哪些路径？没有表，这条规矩无法执行。
 *
 *  这是修改权分档的**判据唯一出处**。
 *
 * ══════════════════════════════════════════════════════════════
 *  五档定义（照原项目，不简化）
 * ══════════════════════════════════════════════════════════════
 *
 *  A 共享·宪法    AGENTS.md 等全局铁律         → 只有宿主改
 *  C 共享·工具    工具/插件/技能目录           → 管理员场景改，别人提请求
 *  B 共享·台账    索引/派单/通知/待办          → 各场景写自己那些行
 *  D 自己专属     自己场景的配置/记忆/技能     → 自己改
 *  E 别人专属     别人的场景/记忆              → ⛔ 一个字都不许写
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/场地地图.mjs                    # 打印地图
 *  node 工具/场地地图.mjs --save             # 写入 _共享记忆/场地地图.json
 *  node 工具/场地地图.mjs --who <路径>       # 查某路径归谁
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const ROOT = path.resolve(WB, '..');

export const TIER = {
  A: 'A',   // 共享·宪法
  C: 'C',   // 共享·工具
  B: 'B',   // 共享·台账
  D: 'D',   // 自己专属
  E: 'E',   // 别人专属
};

/**
 * 从真实目录结构生成场地地图
 */
export function collect() {
  const rules = [];
  const memRoot = path.join(WB, '数据', '.dsh', '场景记忆');
  const scenDir = path.join(WB, '外壳', 'scenarios');

  // ═══ A 档：宪法 ═══
  rules.push({
    tier: TIER.A,
    pattern: 'workbench/数据/.dsh/AGENTS.md',
    owner: '宿主',
    desc: '全局铁律（每轮注入，只有宿主能改）',
  });

  // ═══ C 档：共享工具与运行时 ═══
  const cPaths = [
    ['workbench/工具/**', '工具脚本'],
    ['workbench/数据/.dsh/skills/**', '技能'],
    ['workbench/数据/.dsh/MCP/**', 'MCP'],
    ['workbench/数据/.dsh/plugins/**', '插件'],
    ['workbench/外壳/main.js', '主进程'],
    ['workbench/外壳/preload.js', '预加载'],
    ['workbench/外壳/ui/**', '前端界面'],
  ];
  for (const [p, d] of cPaths) {
    rules.push({ tier: TIER.C, pattern: p, owner: '管理员场景', desc: d });
  }

  // ═══ C 档：场景注入文件（2026-11-10 新增）
  //
  //  场景注入/<sceneId>/AGENTS.local.md 是引擎自动读取的场景上下文。
  //  由 工具/场景注入.mjs 和 工具/中枢调度卡.mjs 生成，
  //  归属：管理员场景（生成器统一维护，场景自己不手改）。
  rules.push({
    tier: TIER.C,
    // ⚠ 2026-11-12 修：目录已迁移（第 14 轮 方案 A）
    //   旧的 数据/.dsh/场景注入/** 不再是被读取的位置，
    //   会话 cwd 里生成的 AGENTS.local.md 才是。
    pattern: 'workbench/数据/.dsh/场景记忆/*/AGENTS.local.md',
    owner: '管理员场景',
    desc: '场景上下文注入文件（由工具生成，引擎自动读取）',
  });

  // ═══ B 档：场景路由表（2026-11-10 新增）
  //
  //  中枢判断归属的唯一依据，各场景写自己那一行（dispatch_when/does_not）。
  rules.push({
    tier: TIER.B,
    pattern: 'workbench/数据/.dsh/场景路由.yaml',
    owner: '各场景写自己那些行',
    desc: '场景路由表（中枢判断归属的权威依据）',
  });

  // ═══ B 档：共享台账 ═══
  const shared = path.join(memRoot, '_共享记忆');
  if (fs.existsSync(shared)) {
    for (const f of fs.readdirSync(shared)) {
      const full = path.join(shared, f);
      if (fs.statSync(full).isDirectory()) continue;
      rules.push({
        tier: TIER.B,
        pattern: 'workbench/数据/.dsh/场景记忆/_共享记忆/' + f,
        owner: '各场景写自己那些行',
        desc: '共享台账',
      });
    }
    // 共享台账的子目录（areas / 基线历史）
    // ★ 自检补齐：用通配规则覆盖整个 _共享记忆（包括未来新建的台账）
    //   否则每新建一个台账（健康度/派单/进化…）都要手工加规则
    rules.push({
      tier: TIER.B,
      pattern: 'workbench/数据/.dsh/场景记忆/_共享记忆/**',
      owner: '各场景写自己那些行',
      desc: '共享台账（通配，覆盖所有当前和未来的台账文件）',
    });
    for (const sub of ['areas', '基线历史']) {
      if (fs.existsSync(path.join(shared, sub))) {
        rules.push({
          tier: TIER.B,
          pattern: 'workbench/数据/.dsh/场景记忆/_共享记忆/' + sub + '/**',
          owner: '各场景写自己那些行',
          desc: '共享台账子目录（' + sub + '）',
        });
      }
    }
  }

  // scenarios 目录下的共享文档（_ 前缀）→ B 档
  // 这些是跨场景共享的规则/索引，不是某个场景专属
  if (fs.existsSync(scenDir)) {
    for (const f of fs.readdirSync(scenDir)) {
      if (!f.startsWith('_')) continue;   // 只看 _ 前缀
      rules.push({
        tier: TIER.B,
        pattern: 'workbench/外壳/scenarios/' + f,
        owner: '各场景写自己那些行',
        desc: '场景共享文档（' + f + '）',
      });
    }
  }

  // ★ 自检补齐：场景记忆根目录下的共享文件
  //   （历史遗留：原项目放在 _共享记忆/ 下，这里散落在根）
  if (fs.existsSync(memRoot)) {
    for (const f of fs.readdirSync(memRoot)) {
      const full = path.join(memRoot, f);
      if (!fs.statSync(full).isFile()) continue;
      rules.push({
        tier: TIER.B,
        pattern: 'workbench/数据/.dsh/场景记忆/' + f,
        owner: '各场景写自己那些行',
        desc: '记忆根目录共享文件（' + f + '）',
      });
    }
  }

  // ★ 自检补齐：sceneboard 下的管线定义
  const pipelinesDir = path.join(WB, 'sceneboard', 'pipelines');
  if (fs.existsSync(pipelinesDir)) {
    rules.push({
      tier: TIER.C,   // 管线定义属于"工具与运行时"
      pattern: 'workbench/sceneboard/pipelines/**',
      owner: '管理员场景',
      desc: '管线定义（跨场景流程编排）',
    });
  }

  // ═══ D/E 档：各场景的地盘 ═══
  const regFile = path.join(shared, '索引.json');
  let areas = [];
  try {
    let s = fs.readFileSync(regFile, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    areas = (JSON.parse(s).areas || []);
  } catch { /* 忽略 */ }

  for (const a of areas) {
    const sid = a.id, name = a.name;
    // D 档：自己的场景配置
    rules.push({
      tier: TIER.D,
      scene: sid,
      pattern: 'workbench/外壳/scenarios/' + sid + '.json',
      owner: sid,
      desc: name + ' 的场景配置',
    });
    const ctx = path.join(scenDir, sid + '-context.md');
    if (fs.existsSync(ctx)) {
      rules.push({
        tier: TIER.D,
        scene: sid,
        pattern: 'workbench/外壳/scenarios/' + sid + '-context.md',
        owner: sid,
        desc: name + ' 的定位卡',
      });
    }
    // D 档：自己的场景记忆
    const memDir = path.join(memRoot, name);
    if (fs.existsSync(memDir)) {
      rules.push({
        tier: TIER.D,
        scene: sid,
        pattern: 'workbench/数据/.dsh/场景记忆/' + name + '/**',
        owner: sid,
        desc: name + ' 的私有记忆',
      });
    }
    // D 档：自己的契约
    rules.push({
      tier: TIER.D,
      scene: sid,
      pattern: 'workbench/sceneboard/scenes/' + sid + '.json',
      owner: sid,
      desc: name + ' 的场景契约',
    });
  }

  // ═══ 兜底：scenarios 下未被上面覆盖的文件 ═══
  //   这些是历史遗留（command-context.md 等），归"未分配"
  if (fs.existsSync(scenDir)) {
    const covered = new Set();
    for (const r of rules) {
      if (r.pattern && r.pattern.startsWith('workbench/外壳/scenarios/')) {
        covered.add(r.pattern.replace('workbench/外壳/scenarios/', ''));
      }
    }
    for (const f of fs.readdirSync(scenDir)) {
      if (covered.has(f)) continue;
      const full = path.join(scenDir, f);
      if (!fs.statSync(full).isFile()) continue;
      rules.push({
        tier: TIER.B,       // 历史遗留归共享台账，谁都可以整理
        pattern: 'workbench/外壳/scenarios/' + f,
        owner: '未分配（历史遗留）',
        desc: 'scenarios 下的孤儿文件，需归档或删除',
      });
    }
  }

  return { rules, sceneCount: areas.length };
}

/**
 * 查某路径归谁
 * @returns {{tier, owner, desc, scene}|null}
 */
export function whoOwns(rules, relPath) {
  const p = relPath.replace(/\\/g, '/');
  let best = null;
  let bestLen = -1;

  for (const r of rules) {
    // 把 glob 转成正则
    const pat = r.pattern.replace(/\\/g, '/');
    const re = new RegExp(
      '^' + pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '.*') + '$'
    );
    if (re.test(p) || pat === p) {
      // 更具体的规则优先（长度更长）
      if (pat.length > bestLen) {
        bestLen = pat.length;
        best = r;
      }
    }
  }
  return best;
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const { rules, sceneCount } = collect();

  if (args.includes('--who')) {
    const i = args.indexOf('--who');
    const target = args[i + 1];
    if (!target) { console.error('用法: --who <路径>'); process.exit(2); }
    const owner = whoOwns(rules, target);
    if (!owner) {
      console.log('归属: (未定义)');
      console.log('  路径: ' + target);
      console.log('  → 未在场地地图里，需要先定义归属');
      process.exit(1);
    }
    console.log('归属: ' + owner.tier + ' 档');
    console.log('  owner: ' + owner.owner);
    console.log('  说明: ' + owner.desc);
    console.log('  规则: ' + owner.pattern);
    process.exit(0);
  }

  console.log('═'.repeat(78));
  console.log('  场地地图（' + rules.length + ' 条规则 / ' + sceneCount + ' 个场景）');
  console.log('═'.repeat(78));
  console.log();

  const byTier = {};
  for (const r of rules) {
    (byTier[r.tier] = byTier[r.tier] || []).push(r);
  }

  const TIER_DESC = {
    A: 'A 共享·宪法 —— 只有宿主能改',
    C: 'C 共享·工具与运行时 —— 管理员场景改，别人只能提请求',
    B: 'B 共享·板与台账 —— 各场景写自己那些行',
    D: 'D 自己的专属 —— 自己改',
    E: 'E 别人的专属 —— ⛔ 一个字都不许写',
  };

  for (const t of ['A', 'C', 'B', 'D']) {
    const list = byTier[t] || [];
    console.log('【' + TIER_DESC[t] + '】' + (list.length ? '  ' + list.length + ' 条' : ''));
    if (!list.length) {
      console.log('  （无）');
    } else {
      for (const r of list.slice(0, 12)) {
        console.log('  ' + r.pattern);
        console.log('      → ' + r.owner + '  ' + r.desc);
      }
      if (list.length > 12) console.log('  ... 还有 ' + (list.length - 12) + ' 条');
    }
    console.log();
  }

  console.log('【E 档说明】');
  console.log('  别人的地盘 = 上面 D 档里 scene 不等于自己的那些。');
  console.log('  造越界时由越界哨兵按 D 档归属判断。');
  console.log();

  if (args.includes('--save')) {
    const shared = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆');
    fs.mkdirSync(shared, { recursive: true });
    const out = {
      _at: new Date().toISOString(),
      _note: '场地地图 —— "这东西归谁"的唯一判据出处。生成自真实目录结构。',
      _tiers: {
        A: '共享·宪法（只有宿主改）',
        C: '共享·工具与运行时（管理员场景改，别人提请求）',
        B: '共享·板与台账（各场景写自己那些行）',
        D: '自己的专属（自己改）',
        E: '别人的专属（⛔ 一个字都不许写）',
      },
      sceneCount,
      rules,
    };
    const p = path.join(shared, '场地地图.json');
    fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
    console.log('已保存: ' + path.relative(ROOT, p));
  }
}
