#!/usr/bin/env node
/**
 * 六件套检查 —— 场景是否完整成立
 *
 * ══════════════════════════════════════════════════════════════
 *  依据（参考项目 00-核心机制/三-场景体系.md §3）
 * ══════════════════════════════════════════════════════════════
 *
 *  > 「这是整套体系里最值得抄的一张表。
 *  >  **缺任何一件，那个场景都会以某种方式失效。**」
 *
 *  | # | 组件 | 缺了会怎样（他的原话） |
 *  |---|---|---|
 *  | 1 | 场景配置 `<id>.json` | 标签栏里根本不出现这个场景 |
 *  | 2 | 定位卡 `<id>-context.md` | AI 不知道自己该干什么、能碰什么 |
 *  | 3 | 场景记忆 `项目信息.md` | 换会话就断片 |
 *  | 4 | 专属技能 `SKILL.md` | AI 用通用办法硬干专业活 |
 *  | 5 | 专属面板（可选） | 只能靠聊天，效率低 |
 *  | 6 | **常驻会话 + 身份索引一行** | **引擎不注入身份 ⇒ AI 会猜，一猜就串台** |
 *
 *  > 「前六件里，**2、3、6 是不可省的三件**（1、4、5 可以退化成"共用"）。
 *  >  判断一个场景"成不成立"，就看这三件有没有：**卡（职责）、记忆（进度）、索引（身份）**。」
 *
 *  ══════════════════════════════════════════════════════════════
 *  我们的现状（第七件是我们多出来的）
 *  ══════════════════════════════════════════════════════════════
 *
 *  ① 场景配置      ✅ 外壳/scenarios/<id>.json
 *  ② 定位卡        ✅ 外壳/scenarios/<id>-context.md
 *  ③ 场景记忆      ✅ 数据/.dsh/场景记忆/<场景名>/场景私有记忆.md
 *  ④ 专属技能      ✅ 数据/.dsh/skills/<id>/SKILL.md
 *  ⑤ 专属面板      ✅ 场景配置里的 panels
 *  ⑥ 常驻会话+索引 ⚠️ 有索引，但 7 个场景没有会话
 *  ⑦ 场景画像      ✅ 数据/.dsh/场景记忆/<场景名>/场景画像.md（我们多做的）
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/六件套.mjs            检查所有场景
 *  node 工具/六件套.mjs --scene 架构梳理
 *  node 工具/六件套.mjs --json
 *  node 工具/六件套.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const MEM_ROOT = path.join(DATA_ROOT, '场景记忆');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const SKILL_DIR = path.join(DATA_ROOT, 'skills');
const SHARED = path.join(MEM_ROOT, '_共享记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  六件套定义
// ══════════════════════════════════════════════════════════════
export const PIECES = [
  { n: 1, key: 'config', name: '场景配置', essential: false, missing: '标签栏里根本不出现这个场景' },
  { n: 2, key: 'context', name: '定位卡', essential: true, missing: 'AI 不知道自己该干什么、能碰什么' },
  { n: 3, key: 'memory', name: '场景记忆', essential: true, missing: '换会话就断片' },
  { n: 4, key: 'skill', name: '专属技能', essential: false, missing: 'AI 用通用办法硬干专业活' },
  { n: 5, key: 'panel', name: '专属面板', essential: false, missing: '只能靠聊天，效率低' },
  { n: 6, key: 'index', name: '常驻会话+身份索引', essential: true, missing: '引擎不注入身份 ⇒ AI 会猜，一猜就串台' },
  { n: 7, key: 'portrait', name: '场景画像', essential: false, missing: 'AI 不知道自己界面长什么样（我们额外做的）' },
];

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  加载场景列表
// ══════════════════════════════════════════════════════════════
export function loadScenes() {
  const scenes = [];
  if (!fs.existsSync(SCEN_DIR)) return scenes;
  for (const f of fs.readdirSync(SCEN_DIR)) {
    if (!f.endsWith('.json')) continue;
    const j = readJsonSafe(path.join(SCEN_DIR, f));
    if (j && j.id) scenes.push(j);
  }
  return scenes;
}

/** 加载身份索引 */
export function loadIdentityIndex() {
  const j = readJsonSafe(path.join(SHARED, '身份索引.json'));
  if (!j) return {};
  const rows = j.rows || [];
  const map = {};
  for (const r of rows) map[r.scene] = r;
  return map;
}

// ══════════════════════════════════════════════════════════════
//  加载引擎里真实存在的会话 id
//
//  第六件的判据需要「这条会话真的存在」，光看索引里的字符串不够。
//  只读目录名（session-*），不读会话内容。
// ══════════════════════════════════════════════════════════════
export function loadLiveSessions() {
  const root = path.join(DATA_ROOT, 'sessions');
  const live = new Set();
  if (!fs.existsSync(root)) return live;
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    let items;
    try { items = fs.readdirSync(path.join(root, ws.name), { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (it.isDirectory() && /^session-/.test(it.name)) live.add(it.name);
    }
  }
  return live;
}

// ══════════════════════════════════════════════════════════════
//  检查一个场景
// ══════════════════════════════════════════════════════════════
export function checkScene(scene, opts) {
  const o = opts || {};
  const idx = o.index || loadIdentityIndex();
  const id = scene.id;
  const name = scene.name || id;

  const result = { id, name, pieces: {} };

  // ① 场景配置
  const cfgFile = path.join(SCEN_DIR, id + '.json');
  result.pieces.config = {
    ok: fs.existsSync(cfgFile),
    path: '外壳/scenarios/' + id + '.json',
  };

  // ② 定位卡
  const ctxFile = path.join(SCEN_DIR, id + '-context.md');
  const ctxContent = readTextSafe(ctxFile);
  result.pieces.context = {
    ok: ctxContent !== null && ctxContent.trim().length > 200,
    path: '外壳/scenarios/' + id + '-context.md',
    bytes: ctxContent ? Buffer.byteLength(ctxContent, 'utf8') : 0,
  };

  // ③ 场景记忆
  const memFile = path.join(MEM_ROOT, name, '场景私有记忆.md');
  const memContent = readTextSafe(memFile);
  // 判断是否有实质内容（不是空骨架）
  const hasSubstance = memContent !== null &&
    memContent.trim().length > 300 &&
    !/负责[：:]\s*[（(]?待补/.test(memContent);
  result.pieces.memory = {
    ok: hasSubstance,
    path: '数据/.dsh/场景记忆/' + name + '/场景私有记忆.md',
    bytes: memContent ? Buffer.byteLength(memContent, 'utf8') : 0,
    skeleton: memContent !== null && !hasSubstance,
  };

  // ④ 专属技能
  const skillFile = path.join(SKILL_DIR, id, 'SKILL.md');
  const skillContent = readTextSafe(skillFile);
  const hasCheck = fs.existsSync(path.join(SKILL_DIR, id, 'check.mjs'));
  result.pieces.skill = {
    ok: skillContent !== null && skillContent.trim().length > 200,
    path: '数据/.dsh/skills/' + id + '/SKILL.md',
    bytes: skillContent ? Buffer.byteLength(skillContent, 'utf8') : 0,
    executable: hasCheck,
  };

  // ⑤ 专属面板
  const panels = Array.isArray(scene.panels) ? scene.panels : [];
  result.pieces.panel = {
    ok: panels.length > 0,
    count: panels.length,
    ids: panels.map((p) => p.id).slice(0, 6),
  };

  // ⑥ 常驻会话 + 身份索引
  //
  // ⚠ 2026-11-12 修（判据错误：把「写了一个 id」当成「这个场景有常驻会话」）
  //
  //  原判据：身份索引里有行、sessionId 非空、不像 placeholder ⇒ ok。
  //  错在哪：第六件的原话是「引擎不注入身份 ⇒ AI 会猜，一猜就串台」，
  //          要的是**真的有一条能用的会话**。
  //          光看索引里写了个字符串，证明不了那条会话存在 ——
  //          本项目历史上索引里整整 7 个 sessionId 全是占位符，
  //          检查照样全绿（因为占位符也是非空字符串）。
  //  改成：除了索引有行，还要确认这个 id 在 数据/.dsh/sessions 里**真实存在**。
  //        会话目录不存在（比如初次部署）时降级为「只查格式」，并在 detail 里说明，
  //        避免把「还没跑过引擎」当成「场景失效」。
  const row = idx[id] || idx[name];
  const sid = row && row.sessionId ? String(row.sessionId) : '';
  const looksReal = !!sid && !/placeholder|TODO/i.test(sid);
  const liveSet = o.live || null;
  const liveChecked = !!(liveSet && liveSet.size > 0);
  const sessionExists = liveChecked && looksReal ? liveSet.has(sid) : null;

  // 判定：有会话 id；如果拿到了引擎真实会话清单，还要求它真的在里面
  const indexOk = looksReal && (sessionExists === null ? true : sessionExists);

  result.pieces.index = {
    ok: indexOk,
    hasRow: !!row,
    sessionId: sid || null,
    // 没会话不算「失效」，只是「还没启动过」
    started: indexOk,
    liveChecked,
    sessionExists,
    // 给报告用的说明：到底是「没写」还是「写了但引擎里没有」
    detail: !row ? '身份索引没有这个场景'
      : !looksReal ? '身份索引的 sessionId 是空/占位符'
      : sessionExists === false ? '身份索引写的会话在引擎里不存在（ID ' + sid.slice(0, 20) + '…）'
      : liveChecked ? '会话真实存在'
      : '未拿到引擎会话清单，只校验了格式',
  };

  // ⑦ 场景画像
  const portraitFile = path.join(MEM_ROOT, name, '场景画像.md');
  const portraitContent = readTextSafe(portraitFile);
  result.pieces.portrait = {
    ok: portraitContent !== null && portraitContent.trim().length > 300,
    path: '数据/.dsh/场景记忆/' + name + '/场景画像.md',
    bytes: portraitContent ? Buffer.byteLength(portraitContent, 'utf8') : 0,
  };

  // 汇总
  const essentialOk = PIECES.filter((p) => p.essential).every((p) => result.pieces[p.key].ok);
  const allOk = PIECES.every((p) => result.pieces[p.key].ok);
  const missingEssential = PIECES.filter((p) => p.essential && !result.pieces[p.key].ok);
  const missingOptional = PIECES.filter((p) => !p.essential && !result.pieces[p.key].ok);

  result.essentialOk = essentialOk;
  result.allOk = allOk;
  result.missingEssential = missingEssential.map((p) => ({ n: p.n, name: p.name, why: p.missing }));
  result.missingOptional = missingOptional.map((p) => ({ n: p.n, name: p.name, why: p.missing }));
  result.verdict = essentialOk
    ? (allOk ? '完整' : '成立（缺可选件）')
    : '不成立（缺必需件）';

  return result;
}

// ══════════════════════════════════════════════════════════════
//  检查全部
// ══════════════════════════════════════════════════════════════
export function checkAll(opts) {
  const scenes = (opts && opts.scenes) || loadScenes();
  const index = loadIdentityIndex();
  // ⚠ 2026-11-12：把引擎真实会话清单传下去，第六件才能查「会话真的存在」
  const live = (opts && opts.live) || loadLiveSessions();
  const results = scenes.map((s) => checkScene(s, { index, live }));

  const byVerdict = { '完整': 0, '成立（缺可选件）': 0, '不成立（缺必需件）': 0 };
  for (const r of results) byVerdict[r.verdict]++;

  return {
    ok: byVerdict['不成立（缺必需件）'] === 0,
    total: results.length,
    results,
    byVerdict,
    verdict: byVerdict['不成立（缺必需件）'] === 0
      ? '全部场景成立（' + results.length + ' 个）'
      : byVerdict['不成立（缺必需件）'] + ' 个场景不成立',
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  六件套检查 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 定义
  chk('七件（六件套 + 我们的画像）', PIECES.length === 7, String(PIECES.length));
  const essential = PIECES.filter((p) => p.essential);
  chk('三件必需（卡/记忆/索引）', essential.length === 3,
      essential.map((p) => p.name).join(','));
  chk('定位卡是必需', PIECES.find((p) => p.key === 'context').essential === true, '');
  chk('场景记忆是必需', PIECES.find((p) => p.key === 'memory').essential === true, '');
  chk('身份索引是必需', PIECES.find((p) => p.key === 'index').essential === true, '');
  chk('场景配置是可退化的', PIECES.find((p) => p.key === 'config').essential === false, '');
  chk('技能是可退化的', PIECES.find((p) => p.key === 'skill').essential === false, '');
  chk('每个都有「缺了会怎样」', PIECES.every((p) => p.missing && p.missing.length > 3), '');

  // ② 真实场景检查
  const all = checkAll();
  chk('能检查所有场景', all.total > 0, all.total + ' 个');
  chk('有 verdict', typeof all.verdict === 'string', all.verdict);

  // ③ 每个场景有七件状态
  const first = all.results[0];
  chk('每个场景有七件状态', first && Object.keys(first.pieces).length === 7,
      first ? Object.keys(first.pieces).length + ' 件' : '');

  // ④ 判定逻辑：缺必需件 ⇒ 不成立
  const fakeMissing = {
    id: 'x', name: 'X',
    pieces: {
      config: { ok: true }, context: { ok: false }, memory: { ok: true },
      skill: { ok: true }, panel: { ok: true }, index: { ok: true }, portrait: { ok: true },
    },
  };
  // 手工套用判定逻辑
  const missEssential = PIECES.filter((p) => p.essential && !fakeMissing.pieces[p.key].ok);
  chk('反例：缺定位卡 ⇒ 不成立', missEssential.length === 1, missEssential.map((p) => p.name).join(','));

  // ⑤ 判定逻辑：缺可选件 ⇒ 仍成立
  const fakeOptionalMissing = {
    id: 'y', name: 'Y',
    pieces: {
      config: { ok: true }, context: { ok: true }, memory: { ok: true },
      skill: { ok: false }, panel: { ok: false }, index: { ok: true }, portrait: { ok: false },
    },
  };
  const missOptional = PIECES.filter((p) => !p.essential && !fakeOptionalMissing.pieces[p.key].ok);
  const missEssential2 = PIECES.filter((p) => p.essential && !fakeOptionalMissing.pieces[p.key].ok);
  chk('反例：缺可选件仍成立', missEssential2.length === 0 && missOptional.length === 3,
      '缺可选 ' + missOptional.length + ' 件，但不影响成立');

  // ⑥ 关键：三件必需件缺任何一件都不成立
  for (const key of ['context', 'memory', 'index']) {
    const fake = { id: 'z', name: 'Z', pieces: {} };
    for (const p of PIECES) fake.pieces[p.key] = { ok: p.key !== key };
    const miss = PIECES.filter((p) => p.essential && !fake.pieces[p.key].ok);
    chk('关键：缺「' + PIECES.find((p) => p.key === key).name + '」⇒ 不成立',
        miss.length >= 1, '');
  }

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 新增反例：第六件的「会话真的存在」判据
  //
  //  这一段是本轮修改的核心验证。原来的判据只看「索引里 sessionId 非空」，
  //  于是占位符也能过 —— 而本项目历史上正是 7 个 sessionId 全是占位符、
  //  检查却全绿。下面造的就是那种情况。
  // ══════════════════════════════════════════════════════════════
  {
    const realScene = all.results[0];
    // 造一个「索引里写了 id，但引擎里根本没有这条会话」的场景
    const ghostLive = new Set(['session-real-0001']);
    const r = checkScene(
      { id: 'ghost', name: '幽灵', panels: [{ id: 'p' }] },
      { index: { ghost: { scene: 'ghost', sessionId: 'session-fake-9999' } }, live: ghostLive },
    );
    chk('反例：索引有 id 但引擎里没有 ⇒ 第六件不通过',
        r.pieces.index.ok === false && r.pieces.index.sessionExists === false,
        r.pieces.index.detail);
    chk('反例：能说清是「写了但不存在」而不是「没写」',
        r.pieces.index.hasRow === true && /不存在/.test(r.pieces.index.detail || ''),
        r.pieces.index.detail);

    // 正例：id 真实存在 ⇒ 通过
    const r2 = checkScene(
      { id: 'ghost', name: '幽灵', panels: [{ id: 'p' }] },
      { index: { ghost: { scene: 'ghost', sessionId: 'session-real-0001' } }, live: ghostLive },
    );
    chk('正例：会话真实存在 ⇒ 第六件通过', r2.pieces.index.ok === true,
        r2.pieces.index.detail);

    // 反例：占位符仍然要被拒（这条原来就有，现在再加一道，防止回退）
    const r3 = checkScene(
      { id: 'ph', name: '占位', panels: [{ id: 'p' }] },
      { index: { ph: { scene: 'ph', sessionId: 'placeholder-TODO' } }, live: ghostLive },
    );
    chk('反例：占位符 sessionId 被拒', r3.pieces.index.ok === false, r3.pieces.index.detail);

    // 真实数据：拿到引擎会话清单时，检查应该真的做了存在性核对
    chk('真实数据：会话存在性确实被核对过',
        realScene.pieces.index.liveChecked === true,
        realScene.pieces.index.detail);
  }

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

  // 单场景
  if (has('--scene')) {
    const want = val('--scene');
    const scenes = loadScenes();
    const s = scenes.find((x) => x.id === want || x.name === want);
    if (!s) { console.error('找不到场景: ' + want); process.exit(2); }
    const r = checkScene(s, { index: loadIdentityIndex(), live: loadLiveSessions() });
    console.log('═'.repeat(74));
    console.log('  ' + r.name + '（' + r.id + '）· 六件套');
    console.log('═'.repeat(74));
    console.log();
    for (const p of PIECES) {
      const st = r.pieces[p.key];
      const mark = st.ok ? '✓' : (p.essential ? '✗' : '○');
      const extra = st.bytes ? '  ' + st.bytes + ' B'
        : st.count !== undefined ? '  ' + st.count + ' 个'
        : st.sessionId ? '  ' + String(st.sessionId).slice(0, 20)
        : '';
      const tag = p.essential ? ' [必需]' : '';
      console.log('  ' + mark + ' ' + p.n + '. ' + p.name.padEnd(16) + tag + extra);
      if (!st.ok && st.skeleton) console.log('      ⚠ 是空骨架（负责/不碰是「待补」）');
      // ⚠ 2026-11-12：第六件要看得出「写了但引擎里没有」和「压根没写」的区别
      if (p.key === 'index' && st.detail) console.log('      ' + (st.ok ? '· ' : '✗ ') + st.detail);
    }
    console.log();
    console.log('─'.repeat(74));
    console.log('  判定: ' + r.verdict);
    if (r.missingEssential.length) {
      console.log('  缺必需件:');
      for (const m of r.missingEssential) console.log('    ✗ ' + m.name + ' → ' + m.why);
    }
    if (r.missingOptional.length) {
      console.log('  缺可选件:');
      for (const m of r.missingOptional) console.log('    ○ ' + m.name + ' → ' + m.why);
    }
    console.log('─'.repeat(74));
    process.exit(r.essentialOk ? 0 : 1);
  }

  // 全部
  const all = checkAll();

  if (has('--json')) {
    console.log(JSON.stringify(all, null, 2));
    process.exit(all.ok ? 0 : 1);
  }

  console.log('═'.repeat(78));
  console.log('  六件套检查（' + all.total + ' 个场景）');
  console.log('═'.repeat(78));
  console.log();
  console.log('  ' + '场景'.padEnd(12) + PIECES.map((p) => (p.essential ? '★' : '·') + p.n).join(' ') + '   判定');
  console.log('  ' + '─'.repeat(70));

  for (const r of all.results) {
    const marks = PIECES.map((p) => {
      const ok = r.pieces[p.key].ok;
      return (ok ? '✓' : (p.essential ? '✗' : '○')) + p.n;
    }).join(' ');
    console.log('  ' + r.name.padEnd(12) + marks + '   ' + r.verdict);
  }

  console.log();
  console.log('  ★ = 必需件（缺则不成立）  · = 可选件');
  console.log();
  console.log('─'.repeat(78));
  console.log('  ' + all.verdict);
  console.log('   完整 ' + all.byVerdict['完整'] +
    ' · 成立但缺可选件 ' + all.byVerdict['成立（缺可选件）'] +
    ' · 不成立 ' + all.byVerdict['不成立（缺必需件）']);
  console.log('─'.repeat(78));
  console.log();
  console.log('  依据：参考项目 00-核心机制/三-场景体系.md §3');
  console.log('  「缺任何一件，那个场景都会以某种方式失效。');
  console.log('   2、3、6 是不可省的三件：卡（职责）、记忆（进度）、索引（身份）。」');
  console.log();

  process.exit(all.ok ? 0 : 1);
}
