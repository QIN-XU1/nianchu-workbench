#!/usr/bin/env node
/**
 * 记忆精简 —— 把「项目信息」从场景私有记忆剥离出去
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1mz4v62ECW 直播问答，他第二次点出这个问题）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [02:24] 「你犯了很多人的问题——
 *  >   就是你把**项目信息也当成他的私有记忆**了。
 *  >   **项目信息很多都是垃圾**，没必要说全量记忆。
 *  >   所以说你要做一个写回记忆，**他只要记住他的职责就行了**。
 *  >   他知道他的职责，他就读索引、读指针，
 *  >   那不是随便这一些文件——像在哪、在哪、在哪，
 *  >   他怎么会消耗 token 很多呢？」
 *
 *  以及笔记 01 里他说的：
 *  > [01:24] 「他做这个东西，他产生的项目信息，他是独立的。
 *  >   每个项目都有自己的项目信息，**这其实我没有归纳到他的记忆里**。」
 *
 * ══════════════════════════════════════════════════════════════
 *  问题现状（实测）
 * ══════════════════════════════════════════════════════════════
 *
 *  各场景私有记忆里，「§二 现状/接口」段（项目信息）占比：
 *    调研      26%
 *    竞品拆解   24%
 *    逆向分析   26%
 *    本地电脑   23%
 *    实施计划   25%
 *    ...
 *
 *  这些都是「项目信息」，按他的原则不该在场景记忆里。
 *
 * ══════════════════════════════════════════════════════════════
 *  怎么处理
 * ══════════════════════════════════════════════════════════════
 *
 *  不是直接删（信息有价值），而是**搬迁**：
 *
 *    §二 现状/接口（项目信息）
 *          ↓ 搬出去
 *    项目记忆/<场景>/项目信息.md    （独立文件）
 *          ↓ 场景记忆留一个指针
 *    §二 现状/接口 → 「详见 `项目记忆/<场景>/项目信息.md`」
 *
 *  这样：
 *    · 场景私有记忆只留「职责」（符合他的原则）
 *    · 项目信息仍然可查（通过指针）
 *    · token 成本从「读全部」变成「读指针」
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/记忆精简.mjs --analyze           分析各场景可剥离量
 *  node 工具/记忆精简.mjs --extract --apply   执行剥离
 *  node 工具/记忆精简.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM_ROOT = path.join(WB, '数据', '.dsh', '场景记忆');
const PROJ_ROOT = path.join(WB, '数据', '.dsh', '项目记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

// ══════════════════════════════════════════════════════════════
//  哪些节属于「项目信息」（该剥离）
//
//  依据他的分法：
//    场景记忆 = 职责 + 必要凭证
//    项目信息 = 每个项目独立的
// ══════════════════════════════════════════════════════════════
export const PROJECT_SECTIONS = [
  '二、现状 / 接口',
  '二、现状/接口',
  '二、现状',
  '现状 / 接口',
  '现状/接口',
];

// 不该剥离的（这些是职责）
export const KEEP_SECTIONS = [
  '核心职责',
  '职责边界',
  '坑与决策',
  '当前交接',
  '项目索引',
  '归因摘要',
];

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  分析：找出每个场景的可剥离内容
// ══════════════════════════════════════════════════════════════
export function analyzeScene(md) {
  const s = String(md || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = s.split('\n');

  // 按 ## 切节
  const sections = [];
  let cur = { title: '', body: [], startLine: 0 };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m) {
      if (cur.title || cur.body.length) sections.push(cur);
      cur = { title: m[1].trim(), body: [], startLine: i };
    } else {
      cur.body.push(lines[i]);
    }
  }
  if (cur.title || cur.body.length) sections.push(cur);

  const extractable = [];
  let extractableBytes = 0;
  let totalBytes = Buffer.byteLength(s, 'utf8');

  for (const sec of sections) {
    const isProject = PROJECT_SECTIONS.some((p) => sec.title.includes(p.replace(/^[一二三四五六七八九十]、/, '')));
    if (!isProject) continue;
    const body = sec.body.join('\n').trim();
    if (!body) continue;
    // 跳过只有占位的内容
    if (/^[（(]?[^\n]{0,10}(待补|待填|无)[)）]?$/.test(body)) continue;
    const bytes = Buffer.byteLength(body, 'utf8');
    extractable.push({ title: sec.title, body, bytes, startLine: sec.startLine });
    extractableBytes += bytes;
  }

  return {
    totalBytes,
    extractable,
    extractableBytes,
    savePct: totalBytes > 0 ? Math.round(extractableBytes / totalBytes * 100) : 0,
    sections: sections.map((x) => x.title).filter(Boolean),
  };
}

// ══════════════════════════════════════════════════════════════
//  提取：把项目信息搬到独立文件，场景记忆留指针
// ══════════════════════════════════════════════════════════════
export function extractScene(sceneName, md, opts) {
  const o = opts || {};
  const s = String(md || '');
  const analysis = analyzeScene(s);

  if (analysis.extractable.length === 0) {
    return { ok: true, changed: false, reason: '没有可剥离的项目信息' };
  }

  // 组装项目信息文件内容
  const stamp = new Date(o.now || Date.now()).toISOString().slice(0, 10);
  const projParts = [
    '# ' + sceneName + ' · 项目信息',
    '',
    '> 这份文件由 `工具/记忆精简.mjs` 从场景私有记忆剥离而来。',
    '> 依据：视频 BV1mz4v62ECW「项目信息很多都是垃圾，没必要说全量记忆。',
    '> 他只要记住他的职责就行了，读索引、读指针。」',
    '>',
    '> 场景记忆只留职责；项目信息在这里，需要时按指针来查。',
    '',
    '剥离时间：' + stamp,
    '',
  ];
  for (const e of analysis.extractable) {
    projParts.push('## ' + e.title);
    projParts.push('');
    projParts.push(e.body);
    projParts.push('');
  }
  const projContent = projParts.join('\n');

  // 改写场景记忆：把项目信息段替换成指针
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  const outLines = [];
  let i = 0;
  let replaced = 0;

  while (i < lines.length) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m) {
      const title = m[1].trim();
      const isProject = PROJECT_SECTIONS.some((p) => title.includes(p.replace(/^[一二三四五六七八九十]、/, '')));
      if (isProject) {
        // 找到这一节的结束
        let j = i + 1;
        while (j < lines.length && !/^##\s/.test(lines[j])) j++;
        const body = lines.slice(i + 1, j).join('\n').trim();
        const hasContent = body && !/^[（(]?[^\n]{0,10}(待补|待填|无)[)）]?$/.test(body);

        if (hasContent) {
          outLines.push('## ' + title);
          outLines.push('');
          outLines.push('> 项目信息已剥离 → `数据/.dsh/项目记忆/' + sceneName + '/项目信息.md`');
          outLines.push('> 需要时按指针查阅，不要全量读。');
          outLines.push('');
          replaced++;
          i = j;
          continue;
        }
      }
    }
    outLines.push(lines[i]);
    i++;
  }

  const newMd = outLines.join('\n');
  const newBytes = Buffer.byteLength(newMd, 'utf8');

  return {
    ok: true,
    changed: replaced > 0,
    projContent,
    newMd,
    beforeBytes: analysis.totalBytes,
    afterBytes: newBytes,
    savedBytes: analysis.totalBytes - newBytes,
    replacedSections: analysis.extractable.map((e) => e.title),
    reason: replaced > 0
      ? '剥离 ' + replaced + ' 段，' + analysis.totalBytes + ' B → ' + newBytes + ' B（省 ' +
        (analysis.totalBytes - newBytes) + ' B）'
      : '无改动',
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  记忆精简 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 常量
  chk('有项目信息节定义', PROJECT_SECTIONS.length > 0, PROJECT_SECTIONS.length + ' 个');
  chk('有保留节定义', KEEP_SECTIONS.length > 0, KEEP_SECTIONS.length + ' 个');
  chk('坑与决策要保留', KEEP_SECTIONS.includes('坑与决策'), '');

  // ② 分析：有项目信息
  const md = [
    '# 测试场景 · 场景私有记忆',
    '',
    '## 核心职责',
    '',
    '- 负责：把三路输入合成架构方案',
    '- 不碰：不写代码',
    '',
    '## 二、现状 / 接口',
    '',
    '- 面板文件：外壳\\scenarios\\arch-review.json',
    '- 上游输入：「feature-matrix」/「impl-details」',
    '- 我的产出：「architecture-plan」→ build-plan',
    '',
    '## 五、坑与决策',
    '',
    '- 2026-11-09：**状态机末端状态要显式处理。**',
    '',
  ].join('\n');

  const a1 = analyzeScene(md);
  chk('分析出可剥离段', a1.extractable.length === 1, a1.extractable.length + ' 段');
  chk('可剥离段是现状接口', a1.extractable[0]?.title.includes('现状'), a1.extractable[0]?.title);
  chk('算出节省比例', a1.savePct > 0, a1.savePct + '%');
  chk('识别出所有节', a1.sections.length === 3, a1.sections.join(','));

  // ③ 提取
  const e1 = extractScene('测试场景', md, { now: Date.parse('2026-11-11') });
  chk('提取成功', e1.ok === true && e1.changed === true, e1.reason);
  chk('项目信息文件有内容', e1.projContent.length > 100, e1.projContent.length + ' 字符');
  chk('项目信息含上游输入', e1.projContent.includes('feature-matrix'), '');
  chk('场景记忆变短', e1.afterBytes < e1.beforeBytes, e1.beforeBytes + ' → ' + e1.afterBytes);
  chk('场景记忆留了指针', e1.newMd.includes('项目信息已剥离'), '');
  chk('场景记忆保留了职责', e1.newMd.includes('合成架构方案'), '');
  chk('场景记忆保留了坑', e1.newMd.includes('状态机末端状态'), '');

  // ④ 反例：没有项目信息 → 不改
  const noProj = [
    '# 场景',
    '',
    '## 核心职责',
    '',
    '- 负责：做某事',
    '',
    '## 五、坑与决策',
    '',
    '- 2026-11-09：**某条经验。**',
  ].join('\n');
  const e2 = extractScene('无项目', noProj);
  chk('反例：无项目信息不改动', e2.changed === false, e2.reason);

  // ⑤ 反例：项目段是占位 → 不改
  const placeholder = [
    '# 场景',
    '',
    '## 二、现状 / 接口',
    '',
    '- （待补）',
    '',
    '## 核心职责',
    '',
    '- 负责：做某事',
  ].join('\n');
  const e3 = extractScene('占位', placeholder);
  chk('反例：占位内容不剥离', e3.changed === false, e3.reason);

  // ⑥ 关键：剥离后职责和坑必须还在
  const stillHasDuty = e1.newMd.includes('合成架构方案');
  const stillHasPit = e1.newMd.includes('状态机末端状态');
  chk('关键：剥离后职责和坑都在', stillHasDuty && stillHasPit,
      '这是剥离的前提——不能把有用的也剥了');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  真实检查（--check）
//
//  ⚠ 2026-11-12 新增。此前只有 --selftest，用构造的小 Markdown 跑，
//    从来没在 9 个真实场景上验证过「剥离后指针是否真的指向存在的文件」。
//
//  判据（对每个场景）：
//    ① 场景记忆里的「> 项目信息已剥离 → `路径`」指针，指向的文件必须真实存在
//       —— 指针指向不存在的文件 = 记忆里留了个死链接，AI 按指针去查会查空
//    ② 指针指向的文件不能是空的（剥离出来的内容必须有实质）
//    ③ 剥离后「职责/坑与决策」必须还在（剥离不能把有用的也剥了）
//       —— 这是工具的核心承诺：只剥项目信息，不剥职责
//    ④ 没有死指针 + 项目信息文件存在 → 两侧一致
// ══════════════════════════════════════════════════════════════
export function checkReal() {
  const problems = [];
  const rows = [];
  if (!fs.existsSync(MEM_ROOT)) {
    return { ok: false, checked: 0, rows, problems: ['记忆根目录不存在: ' + MEM_ROOT] };
  }

  for (const d of fs.readdirSync(MEM_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const memFile = path.join(MEM_ROOT, d.name, '场景私有记忆.md');
    const md = readTextSafe(memFile);
    if (md === null) {
      rows.push({ scene: d.name, skipped: true, why: '没有场景私有记忆.md' });
      continue;
    }

    const norm = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // ① 找出所有剥离指针
    const ptrs = [...norm.matchAll(/>\s*项目信息已剥离\s*→\s*`([^`]+)`/g)].map((m) => m[1].trim());

    let deadLinks = 0;
    let emptyTargets = 0;
    for (const p of ptrs) {
      // 指针里写的是相对 workbench 的路径（数据/.dsh/项目记忆/<场景>/项目信息.md）
      const abs = path.join(WB, p.replace(/^workbench\//, ''));
      if (!fs.existsSync(abs)) {
        deadLinks++;
        problems.push(d.name + '：剥离指针指向不存在的文件 —— ' + p);
        continue;
      }
      const size = fs.statSync(abs).size;
      if (size < 50) {
        emptyTargets++;
        problems.push(d.name + '：剥离出来的项目信息是空的（' + size + ' B）—— ' + p);
      }
    }

    // ③ 剥离后职责与坑必须还在
    const hasDuty = /##\s*核心职责/.test(norm);
    const hasPit = /##\s*.*坑与决策/.test(norm);
    if (!hasDuty) problems.push(d.name + '：剥离后「核心职责」节不见了（剥多了）');
    if (!hasPit) problems.push(d.name + '：剥离后「坑与决策」节不见了（剥多了）');

    // ④ 有指针但项目信息文件整体缺失
    const projFile = path.join(PROJ_ROOT, d.name, '项目信息.md');
    if (ptrs.length > 0 && !fs.existsSync(projFile)) {
      problems.push(d.name + '：记忆里有剥离指针，但 项目记忆/' + d.name + '/项目信息.md 不存在');
    }

    rows.push({
      scene: d.name,
      pointers: ptrs.length,
      deadLinks,
      emptyTargets,
      hasDuty,
      hasPit,
      bytes: Buffer.byteLength(md, 'utf8'),
    });
  }

  return { ok: problems.length === 0, checked: rows.filter((r) => !r.skipped).length, rows, problems };
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 真实检查 ──
  if (has('--check')) {
    const r = checkReal();
    console.log('═'.repeat(78));
    console.log('  记忆精简 · 真实检查（剥离指针是否有效、职责是否还在）');
    console.log('═'.repeat(78));
    console.log();
    console.log('  ' + '场景'.padEnd(12) + '剥指针'.padEnd(8) + '死链'.padEnd(6) +
      '空目标'.padEnd(8) + '职责'.padEnd(6) + '坑'.padEnd(6) + '大小B');
    console.log('  ' + '─'.repeat(70));
    for (const row of r.rows) {
      if (row.skipped) {
        console.log('  ' + row.scene.padEnd(12) + '—  ' + row.why);
        continue;
      }
      console.log('  ' + row.scene.padEnd(12) +
        String(row.pointers).padEnd(8) +
        String(row.deadLinks).padEnd(6) +
        String(row.emptyTargets).padEnd(8) +
        (row.hasDuty ? '有' : '无!').padEnd(6) +
        (row.hasPit ? '有' : '无!').padEnd(6) +
        String(row.bytes));
    }
    console.log('  ' + '─'.repeat(70));
    const totalPtr = r.rows.reduce((s, x) => s + (x.pointers || 0), 0);
    console.log('  检查了 ' + r.checked + ' 个场景，共 ' + totalPtr + ' 个剥离指针');
    console.log();
    if (r.ok) {
      console.log('  ✓ 所有剥离指针都指向真实文件，职责与坑都还在');
    } else {
      console.log('  ✗ ' + r.problems.length + ' 个问题:');
      for (const p of r.problems.slice(0, 15)) console.log('    · ' + p);
    }
    console.log('═'.repeat(78));
    process.exit(r.ok ? 0 : 1);
  }

  const scenes = [];
  if (fs.existsSync(MEM_ROOT)) {
    for (const d of fs.readdirSync(MEM_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue;
      const f = path.join(MEM_ROOT, d.name, '场景私有记忆.md');
      if (fs.existsSync(f)) scenes.push({ name: d.name, file: f });
    }
  }

  // ── 分析 ──
  if (has('--analyze') || (!has('--extract') && !has('--analyze'))) {
    console.log('═'.repeat(76));
    console.log('  记忆精简分析（找出可剥离的项目信息）');
    console.log('═'.repeat(76));
    console.log();
    console.log('  ' + '场景'.padEnd(12) + '总大小'.padEnd(10) + '可剥离'.padEnd(12) + '占比'.padEnd(8) + '节名');
    console.log('  ' + '─'.repeat(72));

    let totalAll = 0;
    let totalExt = 0;

    for (const sc of scenes) {
      const md = readTextSafe(sc.file);
      if (!md) continue;
      const a = analyzeScene(md);
      totalAll += a.totalBytes;
      totalExt += a.extractableBytes;
      const titles = a.extractable.map((e) => e.title).join(', ') || '—';
      console.log('  ' + sc.name.padEnd(12) +
        String(a.totalBytes).padEnd(10) +
        String(a.extractableBytes).padEnd(12) +
        (a.savePct + '%').padEnd(8) +
        titles.slice(0, 30));
    }

    console.log('  ' + '─'.repeat(72));
    console.log('  ' + '合计'.padEnd(12) + String(totalAll).padEnd(10) + String(totalExt).padEnd(12) +
      (totalAll > 0 ? Math.round(totalExt / totalAll * 100) : 0) + '%');
    console.log();
    console.log('  依据：视频 BV1mz4v62ECW');
    console.log('  「你把项目信息也当成他的私有记忆了。项目信息很多都是垃圾。」');
    console.log();
    if (!has('--extract')) {
      console.log('  执行剥离: node 工具/记忆精简.mjs --extract --apply');
    }
    process.exit(0);
  }

  // ── 提取 ──
  if (has('--extract')) {
    console.log('═'.repeat(76));
    console.log('  剥离项目信息' + (has('--apply') ? '' : '（预览）'));
    console.log('═'.repeat(76));
    console.log();

    let changed = 0;
    let savedTotal = 0;

    for (const sc of scenes) {
      const md = readTextSafe(sc.file);
      if (!md) continue;
      const r = extractScene(sc.name, md);
      if (!r.changed) continue;

      console.log('  ' + sc.name.padEnd(12) + r.reason);
      savedTotal += r.savedBytes;
      changed++;

      if (has('--apply')) {
        // 写项目信息
        const projDir = path.join(PROJ_ROOT, sc.name);
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, '项目信息.md'), r.projContent, 'utf8');
        // 改写场景记忆
        fs.writeFileSync(sc.file, r.newMd, 'utf8');
      }
    }

    console.log();
    console.log('─'.repeat(76));
    console.log('  ' + changed + ' 个场景可剥离，共省 ' + savedTotal + ' B');
    if (!has('--apply')) {
      console.log('  （预览。加 --apply 真改）');
    } else {
      console.log('  ✓ 已剥离到 数据/.dsh/项目记忆/<场景>/项目信息.md');
    }
    console.log('─'.repeat(76));
    process.exit(0);
  }
}
