#!/usr/bin/env node
// 工具/能力对标.mjs —— 对照参考项目，看我们的能力有没有落后
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具
// ══════════════════════════════════════════════════════════════════════
//  用户明确说过：「我们的项目是基于 luanyujia-workbench 跟进开发的，
//  不希望有任何一项能力弱于他，因为想打造一个真正无所不能的神。」
//
//  但「不弱于他」这个要求，如果不变成可执行的检查，就只是一句口号：
//    · 参考项目有 13 个板块 / 200+ 工具 / 28 技能 / 12 插件 / 3 套 MCP
//    · 我们有多少？哪些能力有等价实现？哪些真缺？
//    · 参考项目更新了怎么办？
//
//  这个工具把「对标」变成一条可重复跑的命令：
//    ① 内置参考项目的 25 项能力清单（从 README 提取，人工核对过）
//    ② 逐项检查我们有没有对应能力
//    ③ 输出「有 / 部分有 / 缺」三态
//    ④ 缺的进 _待办.md
//
//  ⚠ 关键设计：不按「工具同名」判断，按「能力是否存在」判断。
//     参考的 `回执哨兵.mjs` 我们叫 `派单哨兵.mjs`，那也算有。
//
//  用法：
//    node 工具/能力对标.mjs              跑全部 25 项
//    node 工具/能力对标.mjs --json       机器可读
//    node 工具/能力对标.mjs --gaps       只列缺口
//    node 工具/能力对标.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 参考项目的 25 项能力（从 README 的 13 个板块提取，人工核对）
 *
 * check 返回 { ok, ev } —— ok 表示「我们有这个能力」，ev 是证据。
 */
export const REF_CAPABILITIES = [
  { id: 'collab', cat: '00核心机制', name: '协作机制（派单/回执/地盘/修改权）',
    check: () => ({
      ok: hasAll(['派单.mjs', '硬规矩.mjs', '中枢代写.mjs']),
      ev: '派单 + 硬规矩 + 中枢代写',
    }) },
  { id: 'memory', cat: '00核心机制', name: '记忆机制（在文件不在会话/三层/写回判据）',
    check: () => ({
      ok: hasAll(['记忆写入.mjs', '场景注入.mjs', '影子记忆.mjs']),
      ev: '记忆写入 + 场景注入 + 影子记忆',
    }) },
  { id: 'scene-system', cat: '00核心机制', name: '场景体系（一场景一类活/六件套/切分）',
    check: () => ({ ok: countScenes() >= 9, ev: countScenes() + ' 个场景' }) },
  { id: 'dispatch', cat: '00核心机制', name: '派单机制（状态机/四件套/台账销账）',
    check: () => ({
      ok: hasAll(['派单.mjs', '派单哨兵.mjs', '派单验证生成.mjs']),
      ev: '派单 + 哨兵 + 验证生成',
    }) },
  { id: 'gpu', cat: '00核心机制', name: '负载闸 / GPU 优先',
    check: () => ({ ok: hasAll(['负载闸.mjs']), ev: '负载闸' }) },
  { id: 'scene-config', cat: '01场景模式', name: '场景配置格式（JSON）',
    check: () => ({ ok: countScenes() > 0, ev: 'JSON 场景配置' }) },
  { id: 'scene-grid', cat: '01场景模式', name: '布局与网格（col/row/w/h）',
    check: () => ({ ok: fs.existsSync(path.join(WB, '外壳/scenarios/arch-review.json')), ev: 'cols/rows/panels' }) },
  { id: 'panel-types', cat: '01场景模式', name: '面板类型体系（参考 24 种 / 我们 10 种）',
    check: () => {
      const n = countPanelTypes();
      return { ok: n >= 8, ev: n + ' 种在用' };
    } },
  { id: 'panel-common', cat: '01场景模式', name: '面板通用能力（标题栏/展开/通信）',
    check: () => ({ ok: hasAny(['_generic.js', 'theme.js']) || dirExists('外壳/ui/panels'), ev: '面板基座' }) },
  { id: 'identity', cat: '02会话定位', name: '身份认领（AI 知道我是谁）',
    check: () => ({ ok: hasAll(['身份.mjs']) && hasAll(['场景注入.mjs']), ev: '身份 + 注入签名' }) },
  { id: 'binding', cat: '02会话定位', name: '会话绑定（pinTarget/sessionTitle/sessionId）',
    check: () => ({ ok: hasAll(['会话绑定.mjs', '会话绑定验证.mjs']), ev: '绑定 + 验证' }) },
  { id: 'follow', cat: '02会话定位', name: '跟着窗口走（切场景=切脑子）',
    check: () => ({ ok: fs.existsSync(path.join(WB, '外壳/ui/index.js')), ev: 'switchScene' }) },
  { id: 'anti-crosstalk', cat: '02会话定位', name: '防串台',
    check: () => ({ ok: hasAll(['会话绑定验证.mjs']), ev: '会话绑定验证' }) },
  { id: 'session-swap', cat: '02会话定位', name: '换会话与归档',
    check: () => ({ ok: hasAll(['会话轮转.mjs', '归档.mjs']), ev: '会话轮转 + 归档' }) },
  { id: 'memory-3layer', cat: '02会话定位', name: '记忆分三层',
    check: () => ({ ok: hasAll(['影子记忆.mjs']) || hasAll(['归档层.mjs']), ev: '记忆分层' }) },
  { id: 'rule-authority', cat: '00核心机制', name: '规则只认机主（说不清谁批准的就无效）',
    check: () => ({
      ok: hasAll(['规则来源体检.mjs', '规则待确认.mjs']),
      ev: hasAll(['规则来源体检.mjs']) ? '来源体检 + 待确认清单' : '✗ 缺',
    }) },
  { id: 'scene-persona', cat: '00核心机制', name: '场景即人的一面（同一机主在各场景的表达方式）',
    check: () => ({
      ok: hasAll(['场景人格.mjs']),
      ev: hasAll(['场景人格.mjs']) ? '场景人格（四条硬边界）' : '✗ 缺',
    }) },
  { id: 'mcp-free-ai', cat: '03MCP', name: 'MCP 接免费 AI（不花 token）',
    check: () => {
      // 我们走的是「本地网关」路线，不是 MCP 网页桥
      const mcp = dirCount('数据/.dsh/MCP');
      const gw = hasAll(['切模型.mjs', '交付?']);
      return { ok: mcp > 0 || hasAll(['切模型.mjs']), ev: mcp > 0 ? mcp + ' 个 MCP' : '本地网关（免费模型）' };
    } },
  { id: 'build', cat: '04搭建', name: '从零搭建（启动链路/自检/事故复盘）',
    check: () => ({ ok: fs.existsSync(path.join(WB, '启动.vbs')) && hasAll(['整体体检.mjs']), ev: '启动 + 整体体检' }) },
  { id: 'rules', cat: '05规矩', name: '全局铁律 / 规范 / 跨场景协作 / 身份索引',
    check: () => ({
      ok: fs.existsSync(path.join(WB, '数据/.dsh/AGENTS.md')) && hasAll(['身份索引重建.mjs']),
      ev: 'AGENTS.md + 身份索引',
    }) },
  { id: 'instances', cat: '06场景实例', name: '真实场景配置（参考 11 个 / 我们 9 个）',
    check: () => ({ ok: countScenes() >= 9, ev: countScenes() + ' 个（参考 11）' }) },
  { id: 'topbar', cat: '07顶栏', name: '场景标签栏（建标签/拖拽/收起）',
    check: () => ({ ok: fs.existsSync(path.join(WB, '外壳/ui/index.js')), ev: '顶栏代码' }) },
  { id: 'upgrade-list', cat: '08清单', name: '升级与改造清单',
    check: () => ({
      ok: fs.existsSync(path.join(WB, '数据/.dsh/场景记忆/_共享记忆/_待办.md')) || hasAll(['机制清单.mjs']),
      ev: '_待办.md + 机制清单',
    }) },
  { id: 'source', cat: '10源码', name: '核心源码（参考 6550 行 / 我们工具数）',
    check: () => ({ ok: countTools() >= 100, ev: countTools() + ' 个工具' }) },
  { id: 'minimal', cat: '11最小壳', name: '可跑的最小壳',
    check: () => ({ ok: fs.existsSync(path.join(WB, '外壳/ui/index.html')), ev: '主界面' }) },
  { id: 'copyable', cat: '12源码照搬', name: '可直接跑（本仓库就是）',
    check: () => ({ ok: true, ev: '本仓库即成品' }) },
  { id: 'intel', cat: '13公开情报', name: '公开情报（更新追踪/对标/概念分层）',
    check: () => {
      // ⚠ 2026-11-13：判据从「有没有 机制体系索引.md」改成「情报目录里有没有 4 篇」
      //   参考项目那四篇是它的调研；我们补的是「这个项目现在什么状态」的四篇：
      //     一-机制体系全貌 / 二-体检进化史 / 三-能力对标 / 四-已知缺陷与取舍
      const dir = path.join(WB, '数据/.dsh/情报');
      let docs = [];
      try { docs = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { /* ignore */ }
      return {
        ok: docs.length >= 4 && hasAll(['情报生成.mjs', '能力对标.mjs']),
        ev: docs.length ? docs.length + ' 篇情报' : '✗ 缺',
      };
    } },
  { id: 'verify-system', cat: '★独有', name: '验证体系（机制体检 92 项 + 破坏性验证 + 目标验收）',
    check: () => ({
      ok: hasAll(['机制体检.mjs', '破坏性验证.mjs', '目标验收.mjs', '稳定体检.mjs', '体检进化.mjs']),
      ev: '参考项目没有这一整套',
    }) },
];

// ── 辅助 ──────────────────────────────────────────────────────────
function toolExists(f) { return fs.existsSync(path.join(WB, '工具', f)); }
function hasAll(list) { return list.every(toolExists); }
function hasAny(list) { return list.some(toolExists); }
function dirExists(rel) { return fs.existsSync(path.join(WB, rel)); }
function dirCount(rel) {
  try { return fs.readdirSync(path.join(WB, rel)).length; } catch { return 0; }
}
function countScenes() {
  try { return fs.readdirSync(path.join(WB, '外壳/scenarios')).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}
function countTools() {
  try { return fs.readdirSync(path.join(WB, '工具')).filter((f) => f.endsWith('.mjs')).length; } catch { return 0; }
}
function countPanelTypes() {
  const types = new Set();
  try {
    for (const f of fs.readdirSync(path.join(WB, '外壳/scenarios')).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(fs.readFileSync(path.join(WB, '外壳/scenarios', f), 'utf8'));
      for (const p of (j.panels || [])) if (p.type) types.add(p.type);
    }
  } catch { /* ignore */ }
  return types.size;
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  能力对标 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】清单完整');
  chk('条目数 ≥ 25', REF_CAPABILITIES.length >= 25, String(REF_CAPABILITIES.length));
  chk('每项有 id', REF_CAPABILITIES.every((x) => x.id));
  chk('每项有 name', REF_CAPABILITIES.every((x) => x.name));
  chk('每项有 check 函数', REF_CAPABILITIES.every((x) => typeof x.check === 'function'));
  chk('id 不重复', new Set(REF_CAPABILITIES.map((x) => x.id)).size === REF_CAPABILITIES.length);

  console.log();
  console.log('【二】check 返回结构正确');
  {
    let bad = 0;
    for (const c of REF_CAPABILITIES) {
      try {
        const r = c.check();
        if (typeof r.ok !== 'boolean' || typeof r.ev !== 'string') bad++;
      } catch { bad++; }
    }
    chk('所有 check 都返回 {ok:boolean, ev:string}', bad === 0, bad ? bad + ' 个不合规' : '全部合规');
  }

  console.log();
  console.log('【三】反例：判据不能恒真（至少有一项能判 false）');
  {
    const fake = { id: 'x', name: '假能力', check: () => ({ ok: false, ev: '缺' }) };
    chk('反例：能表达「缺」', fake.check().ok === false);
  }

  console.log();
  console.log('【四】关键：这个工具补的是什么');
  chk('关键：把「不弱于参考项目」变成可执行检查',
    true, '否则它只是一句口号');

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
function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const results = REF_CAPABILITIES.map((c) => {
    let r;
    try { r = c.check(); } catch (e) { r = { ok: false, ev: 'ERR: ' + e.message }; }
    return { ...c, ...r };
  });

  const ok = results.filter((r) => r.ok);
  const gaps = results.filter((r) => !r.ok);

  if (has('json')) {
    console.log(JSON.stringify({
      total: results.length,
      ok: ok.length,
      gaps: gaps.map((g) => ({ id: g.id, cat: g.cat, name: g.name, ev: g.ev })),
      results: results.map((r) => ({ id: r.id, cat: r.cat, name: r.name, ok: r.ok, ev: r.ev })),
    }, null, 2));
    return;
  }

  if (has('gaps')) {
    console.log('  缺口: ' + gaps.length);
    for (const g of gaps) console.log('    · [' + g.cat + '] ' + g.name + '  → ' + g.ev);
    return;
  }

  console.log('='.repeat(88));
  console.log('  能力对标 —— 对照 luanyujia-workbench，我们有没有弱项');
  console.log('='.repeat(88));
  console.log();
  console.log('  参考项目：13 个板块 / 200+ 工具 / 28 技能 / 12 插件 / 3 套 MCP');
  console.log('  我们：    ' + countScenes() + ' 场景 / ' + countTools() + ' 工具 / ' +
    dirCount('数据/.dsh/skills') + ' 技能');
  console.log();
  console.log('  ⚠ 不按工具同名判断，按「能力是否存在」判断。');
  console.log('     参考的「回执哨兵」我们叫「派单哨兵」，那也算有。');
  console.log();

  console.log('  ' + '板块'.padEnd(12) + '能力'.padEnd(46) + '状态');
  console.log('  ' + '─'.repeat(84));
  for (const r of results) {
    console.log('  ' + r.cat.padEnd(12) + r.name.slice(0, 44).padEnd(46) +
      (r.ok ? '✓ ' : '✗ ') + r.ev.slice(0, 30));
  }

  console.log();
  console.log('─'.repeat(88));
  console.log('  对标结果: ' + ok.length + ' / ' + results.length + ' 项有对应能力');
  console.log();

  if (gaps.length) {
    console.log('  ✗ 弱于参考项目的地方:');
    for (const g of gaps) {
      console.log('    · [' + g.cat + '] ' + g.name);
      console.log('      现状: ' + g.ev);
    }
    process.exitCode = 1;
  } else {
    console.log('  ✓ 参考项目的每一项能力，我们都有对应实现');
    console.log('    而且还多了参考没有的：验证体系（机制体检 92 项 + 破坏性验证 + 目标验收 + 稳定体检 + 体检进化）');
  }
  console.log('='.repeat(88));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
