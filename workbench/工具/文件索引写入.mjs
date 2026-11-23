#!/usr/bin/env node
// 工具/文件索引写入.mjs —— 给每个场景生成 _文件索引.md
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（发现的缺陷）
// ══════════════════════════════════════════════════════════════════════
//  实测：9 个场景里只有 4 个有 _文件索引.md：
//    有: 故障分析 / 本地电脑 / 自我复盘 / 中枢
//    无: 架构梳理 / 实施计划 / 竞品拆解 / 调研 / 逆向分析
//
//  而且搜遍工具目录，**没有任何工具生成或维护它**（grep _文件索引 = 0）。
//
//  它是个手写的静态文件，写了以后没人更新，漏了一半场景。
//
//  但它是会被读的：记忆注入.mjs 会读场景目录下所有 .md
//  （只排除 AGENTS.local.md），所以 _文件索引.md 会进 AI 上下文。
//
//  也就是说：
//    · 4 个场景的 AI 能看到「我的东西在哪」
//    · 5 个场景的 AI 看不到
//  这造成能力不一致，而且无人察觉。
//
// ══════════════════════════════════════════════════════════════════════
//  做什么
// ══════════════════════════════════════════════════════════════════════
//  从真实数据生成索引：
//    · 场景定义      外壳/scenarios/<id>.json
//    · 场景契约      sceneboard/scenes/<id>.json
//    · 身份卡        场景记忆/<名>/身份卡.md
//    · 私有记忆      场景记忆/<名>/场景私有记忆.md
//    · 场景画像      场景记忆/<名>/场景画像.md
//    · 技能          数据/.dsh/skills/<id>/SKILL.md
//    · 本场景的产出  场景记忆/<名>/*.md（除上述固定文件）
//
//  用法：
//    node 工具/文件索引写入.mjs            # 全部场景
//    node 工具/文件索引写入.mjs --check    # 只检查不写
//    node 工具/文件索引写入.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const SCEN = path.join(WB, '外壳', 'scenarios');
const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');
const SKILLS = path.join(DATA, 'skills');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

const FIXED = ['场景私有记忆.md', '身份卡.md', '场景画像.md', 'AGENTS.local.md', '_文件索引.md'];

function readJS(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function rel(p) {
  return path.relative(WB, p).replace(/\\/g, '\\');
}

/** 生成一个场景的索引内容 */
export function buildIndex(scene) {
  const { id, name } = scene;
  const L = [];
  L.push('# ' + name + ' · 文件索引');
  L.push('');
  L.push('> 本场景的东西在哪。由 `工具/文件索引写入.mjs` 自动生成，勿手改。');
  L.push('');

  L.push('## 核心三件');
  L.push('');
  L.push('| 类型 | 路径 | 说明 |');
  L.push('|---|---|---|');
  L.push('| 私有记忆 | `' + rel(path.join(MEM, name, '场景私有记忆.md')) + '` | §〇交接 / §五坑与决策 |');
  L.push('| 身份卡 | `' + rel(path.join(MEM, name, '身份卡.md')) + '` | 我是谁、sessionId |');
  L.push('| 场景画像 | `' + rel(path.join(MEM, name, '场景画像.md')) + '` | 这个场景长什么样 |');
  L.push('');

  L.push('## 配置与契约');
  L.push('');
  L.push('| 类型 | 路径 | 说明 |');
  L.push('|---|---|---|');
  const scenFile = path.join(SCEN, id + '.json');
  L.push('| 场景定义 | `' + rel(scenFile) + '` | 面板布局 |' + (fs.existsSync(scenFile) ? '' : ' ⚠ 不存在'));
  const cFile = path.join(CONTRACTS, id + '.json');
  L.push('| 场景契约 | `' + rel(cFile) + '` | 定位/输入/输出 |' + (fs.existsSync(cFile) ? '' : ' ⚠ 不存在'));
  const skFile = path.join(SKILLS, id, 'SKILL.md');
  L.push('| 技能 | `' + rel(skFile) + '` | 怎么干这个活 |' + (fs.existsSync(skFile) ? '' : ' ⚠ 不存在'));
  L.push('');

  // 本场景的产出
  const dir = path.join(MEM, name);
  let outs = [];
  try {
    outs = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !FIXED.includes(f) && !f.startsWith('_'))
      .sort();
  } catch { /* ignore */ }

  if (outs.length) {
    L.push('## 本场景的产出（' + outs.length + ' 个）');
    L.push('');
    L.push('| 文件 | 大小 |');
    L.push('|---|---|');
    for (const f of outs) {
      let size = 0;
      try { size = fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
      L.push('| `' + f + '` | ' + size + ' B |');
    }
    L.push('');
  } else {
    L.push('## 本场景的产出');
    L.push('');
    L.push('（还没有产出文件）');
    L.push('');
  }

  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
function loadScenes() {
  if (!fs.existsSync(SCEN)) return [];
  return fs.readdirSync(SCEN)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => {
      const j = readJS(path.join(SCEN, f));
      if (!j) return null;
      return { id: j.id || f.replace('.json', ''), name: j.name || j.id };
    })
    .filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  文件索引写入 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】场景列表');
  const scenes = loadScenes();
  chk('能读到场景', scenes.length >= 9, scenes.length + ' 个');
  chk('每个有 id 和 name', scenes.every((s) => s.id && s.name));

  console.log();
  console.log('【二】索引内容生成');
  {
    const md = buildIndex({ id: 'research', name: '调研' });
    chk('含标题', md.includes('# 调研 · 文件索引'));
    chk('含核心三件表', md.includes('私有记忆') && md.includes('身份卡') && md.includes('场景画像'));
    chk('含配置与契约表', md.includes('场景定义') && md.includes('场景契约') && md.includes('技能'));
    chk('含产出统计', /本场景的产出/.test(md));
    chk('长度合理', md.length > 400, md.length + ' 字');
  }

  console.log();
  console.log('【三】反例：不存在的场景也要能生成（不能抛错）');
  {
    let ok = false;
    let md = '';
    try { md = buildIndex({ id: '__nonexistent__', name: '__不存在的场景__' }); ok = true; } catch { ok = false; }
    chk('反例：不存在的场景不抛错', ok);
    chk('反例：会标注文件不存在', ok && md.includes('⚠ 不存在'));
  }

  console.log();
  console.log('【四】当前实际状态（这是本工具存在的理由）');
  const missing = scenes.filter((s) => !fs.existsSync(path.join(MEM, s.name, '_文件索引.md')));
  chk('所有场景都有 _文件索引.md', missing.length === 0,
    missing.length ? '缺 ' + missing.length + ' 个: ' + missing.map((s) => s.name).join(',') : '全有');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  const checkOnly = has('check');
  const scenes = loadScenes();

  console.log('='.repeat(78));
  console.log('  文件索引写入 —— 给每个场景生成「我的东西在哪」');
  console.log('='.repeat(78));
  console.log();

  let wrote = 0;
  let same = 0;
  const missing = [];

  for (const s of scenes) {
    const dir = path.join(MEM, s.name);
    if (!fs.existsSync(dir)) { console.log('  ✗ ' + s.name + ' 无记忆目录'); continue; }

    const p = path.join(dir, '_文件索引.md');
    const next = buildIndex(s);

    if (!fs.existsSync(p)) {
      missing.push(s.name);
      if (!checkOnly) {
        fs.writeFileSync(p, next, 'utf8');
        console.log('  + ' + s.name.padEnd(10) + '新建（' + next.length + ' 字）');
        wrote++;
      } else {
        console.log('  ✗ ' + s.name.padEnd(10) + '缺失');
      }
      continue;
    }

    const cur = fs.readFileSync(p, 'utf8');
    if (cur.trim() === next.trim()) {
      same++;
      continue;
    }
    if (!checkOnly) {
      fs.writeFileSync(p, next, 'utf8');
      console.log('  ~ ' + s.name.padEnd(10) + '更新（' + cur.length + ' → ' + next.length + ' 字）');
      wrote++;
    } else {
      console.log('  ~ ' + s.name.padEnd(10) + '内容过期');
    }
  }

  console.log();
  console.log('-'.repeat(78));
  if (checkOnly) {
    console.log('  检查模式：缺失 ' + missing.length + ' 个，一致 ' + same + ' 个');
    if (missing.length) {
      console.log('  缺失: ' + missing.join(', '));
      console.log('  → 运行 node 工具/文件索引写入.mjs 修复');
      process.exitCode = 1;
    }
  } else {
    console.log('  新建/更新 ' + wrote + ' 个，无需改动 ' + same + ' 个，共 ' + scenes.length + ' 个场景');
  }
  console.log('='.repeat(78));
}

main();
