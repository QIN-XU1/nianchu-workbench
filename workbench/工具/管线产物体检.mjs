#!/usr/bin/env node
// 工具/管线产物体检.mjs —— 管线定义的产物是否真的存在且被下游消费
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（发现的核心问题）
// ══════════════════════════════════════════════════════════════════════
//  现象：
//    sceneboard/pipelines/*.json 定义了 2 条管线、9 条边、8 个产物：
//
//      research → competitor-analyze  产物 competitor-list
//      research → arch-review         产物 reference-index
//      competitor-analyze → arch-review  产物 feature-matrix
//      reverse-eng → arch-review      产物 impl-details / reusable-patterns
//      arch-review → build-plan       产物 architecture-plan / risk-list
//
//    但实测：**9 条边里，下游真的引用了上游产出的 0 条。**
//
//  根因：
//    管线里的 artifact 是**抽象契约名**（competitor-list），
//    而场景实际产出是**具体文件名**（项目功能矩阵.md / 机制体系索引.md）。
//    两者之间**没有任何映射**，所以：
//      · 下游不知道该找哪个文件
//      · 也没有机制检查「上游产物是否就绪」
//      · 管线变成了纸面约定
//
// ══════════════════════════════════════════════════════════════════════
//  这个工具做什么
// ══════════════════════════════════════════════════════════════════════
//  ① 读所有管线定义，收集全部 artifact 契约名
//  ② 检查有没有「产物契约表」把它映射到实际文件
//  ③ 对每条边：检查上游的产物文件是否真的存在
//  ④ 检查下游记忆里是否引用了上游产物
//
//  用法：
//    node 工具/管线产物体检.mjs
//    node 工具/管线产物体检.mjs --selftest
//    node 工具/管线产物体检.mjs --init-contract   # 生成契约表模板
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const PIPE_DIR = path.join(WB, 'sceneboard', 'pipelines');
const CONTRACT_FILE = path.join(DATA, '产物契约.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

// ⚠ 2026-11-14 改：不再硬编码场景名表，动态从 scenarios/*.json 读
//
//   原来是：
//     const SCENE_NAME = {
//       'arch-review': '架构梳理', 'build-plan': '实施计划', ...
//     };   // ← 只有 9 个
//
//   新增 3 个工坊后**两个工具都忘了更新**，导致：
//     sceneMem('backend-craft') 用 'backend-craft' 当目录名 → 读不到记忆
//     → 误判「下游未消费」
//
//   根因是**同一个事实存了两份**。唯一权威应该是 scenarios/*.json
//   里的 { id, name }。现在动态读，新增场景自动生效。
const SCENE_NAME = (() => {
  const map = {};
  try {
    const dir = path.join(WB, '外壳', 'scenarios');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j && j.id && j.name) map[j.id] = j.name;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return map;
})();

const SKIP_FILES = ['场景私有记忆.md', '身份卡.md', '场景画像.md', 'AGENTS.local.md', '_文件索引.md'];

// ══════════════════════════════════════════════════════════════════════
//  读契约表
// ══════════════════════════════════════════════════════════════════════
export function loadContract() {
  try {
    if (!fs.existsSync(CONTRACT_FILE)) return null;
    return JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}

function sceneFiles(sceneId) {
  const cn = SCENE_NAME[sceneId] || sceneId;
  const dir = path.join(MEM, cn);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !SKIP_FILES.includes(f) && !f.startsWith('_'));
  } catch { return []; }
}

function sceneMem(sceneId) {
  const cn = SCENE_NAME[sceneId] || sceneId;
  try { return fs.readFileSync(path.join(MEM, cn, '场景私有记忆.md'), 'utf8'); } catch { return ''; }
}

function loadPipelines() {
  if (!fs.existsSync(PIPE_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(PIPE_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PIPE_DIR, f), 'utf8'));
      out.push({ file: f, ...j });
    } catch { /* ignore */ }
  }
  return out;
}

/** 收集全部 artifact 契约名 → 期望的产出场景 */
export function collectArtifacts(pipelines) {
  const map = new Map(); // artifact -> [sceneId...]
  for (const p of pipelines) {
    for (const e of p.edges || []) {
      if (!e.artifact) continue;
      if (!map.has(e.artifact)) map.set(e.artifact, []);
      map.get(e.artifact).push(e.from);
    }
  }
  return map;
}

/**
 * 判一条边 —— **唯一判据出处**
 *
 * ⚠ 2026-11-12 新增（补反例时顺手把判据提出来）
 *
 *   原来这段判断写在 main() 的循环体里，自测够不着它：
 *   自测只能测「能不能算出契约表缺哪些 artifact」，
 *   测不到「产物不存在 / 下游不消费」这两个**真正决定 exit code** 的判据。
 *   于是「反例」只能写成 Array.isArray(missing) —— 恒真，等于装饰。
 *
 *   提成纯函数后，自测可以直接喂「造出来的坏数据」，验证判据真的会判 false。
 *
 * 两条判据：
 *   ① exists   契约表里登记的文件，是否真的在上游场景目录里
 *   ② consumed 这些存在的文件，是否被下游场景记忆引用
 *
 * @param {string[]} contractFiles 契约表为该 artifact 登记的文件名
 * @param {string[]} upstreamFiles 上游场景目录里实际存在的 .md
 * @param {string} downstreamText 下游场景的私有记忆全文
 */
export function judgeEdge(contractFiles, upstreamFiles, downstreamText) {
  const want = Array.isArray(contractFiles) ? contractFiles : [];
  const have = Array.isArray(upstreamFiles) ? upstreamFiles : [];
  const text = String(downstreamText || '');

  // 判据①：契约登记的文件必须真的存在（不是「表里写了就算」）
  const existing = want.filter((f) => have.includes(f));
  const exists = existing.length > 0;

  // 判据②：存在还不够，下游得真的引用它，否则管线还是纸面的
  const refs = existing.filter((f) => text.includes(f));
  const consumed = refs.length > 0;

  return { exists, consumed, existing, refs };
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  管线产物体检 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】管线定义可读');
  const ps = loadPipelines();
  chk('能读到管线', ps.length > 0, ps.length + ' 条');
  chk('每条管线有 nodes 和 edges',
    ps.every((p) => Array.isArray(p.nodes) && Array.isArray(p.edges)));

  console.log();
  console.log('【二】artifact 契约名可收集');
  const arts = collectArtifacts(ps);
  chk('能收集到 artifact', arts.size > 0, arts.size + ' 个');
  chk('每个 artifact 有来源场景',
    [...arts.values()].every((v) => v.length > 0 && v.every((x) => typeof x === 'string')));

  console.log();
  console.log('【三】契约表机制');
  const contract = loadContract();
  if (contract) {
    chk('契约表可解析', !!contract);
    const entries = contract.artifacts || contract;
    const keys = Object.keys(entries);
    chk('契约表非空', keys.length > 0, keys.length + ' 条');
    // 契约表里每项要指向真实文件
    let validN = 0;
    for (const [k, v] of Object.entries(entries)) {
      const scene = v.scene || (arts.get(k) && arts.get(k)[0]);
      const files = scene ? sceneFiles(scene) : [];
      const files2 = Array.isArray(v.files) ? v.files : (v.file ? [v.file] : []);
      if (files2.some((f) => files.includes(f))) validN++;
    }
    chk('契约表里至少一半指向真实存在的文件', validN >= keys.length / 2,
      validN + ' / ' + keys.length);
  } else {
    chk('契约表存在（不存在是当前已知问题）', false, '数据/.dsh/产物契约.json 不存在');
    chk('提示：用 --init-contract 生成模板', true);
  }

  console.log();
  console.log('【四】反例：造出该被抓的坏管线数据，判据必须判不合格');
  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 改（原来的「反例」是恒真的装饰）
  //
  //  原代码：
  //    chk('能算「契约表缺哪些 artifact」', Array.isArray(missing), ...)
  //  错在哪：`Array.isArray(...)` 永远为真 —— filter 出来的一定是数组，
  //    哪怕 missing 是空数组、哪怕契约表根本不存在。
  //    断言的内容是「程序没崩」，不是「判据会报错」。
  //    这正是机制审计第④步要抓的东西，审计器自己抓不到就被算成「有反例」。
  //
  //  改成：直接对 judgeEdge()（main 里用的同一份判据）喂三种真实坏形态，
  //    每种都配一份合格数据做对照 —— 判据恒 true 或恒 false 都会红。
  // ══════════════════════════════════════════════════════════════
  {
    const upstream = ['项目功能矩阵.md', '机制体系索引.md'];
    const downOk = '# 下游记忆\n\n上游输入：「项目功能矩阵.md」\n';

    // 反例①：契约登记了文件，但上游场景里根本没这个文件 → 产物不存在
    const noFile = judgeEdge(['不存在的产物.md'], upstream, downOk);
    chk('反例：契约登记的文件上游不存在，必须判「产物不在」',
      noFile.exists === false && noFile.consumed === false,
      'exists=' + noFile.exists);

    // 反例②：产物确实存在，但下游记忆一个字都没引用它 → 未消费
    //         （这正是本项目修复前的真实状态：9 条边 0 条被消费）
    const notConsumed = judgeEdge(['项目功能矩阵.md'], upstream, '# 下游记忆\n\n什么都没提\n');
    chk('反例：产物存在但下游不引用，必须判「未消费」',
      notConsumed.exists === true && notConsumed.consumed === false,
      'exists=' + notConsumed.exists + ' consumed=' + notConsumed.consumed);

    // 反例③：契约表为空（artifacts 没填 files）→ 不能因为「表存在」就判通过
    const emptyContract = judgeEdge([], upstream, downOk);
    chk('反例：契约没填 files 时必须判不合格（不能因表存在就放行）',
      emptyContract.exists === false && emptyContract.consumed === false,
      'exists=' + emptyContract.exists);

    // 正面对照：三条都成立时必须判通过（否则判据退化成「全拒」）
    const good = judgeEdge(['项目功能矩阵.md'], upstream, downOk);
    chk('合格边必须判通过（exists 且 consumed）',
      good.exists === true && good.consumed === true,
      'exists=' + good.exists + ' consumed=' + good.consumed);
  }

  console.log();
  console.log('【五】反例：契约表没覆盖的 artifact 必须能被点名');
  {
    // 造一份「契约表漏了两个 artifact」的假数据，验证点名逻辑真的会点出来
    const fakeArts = new Map([['a1', ['research']], ['a2', ['research']], ['a3', ['research']]]);
    const fakeEntries = { a1: { files: ['x.md'] } };   // 故意漏 a2 / a3
    const missing = [...fakeArts.keys()].filter((a) => !fakeEntries[a]);
    chk('反例：契约表缺 2 个 artifact 必须点名 2 个（不是恒真）',
      missing.length === 2 && missing.includes('a2') && missing.includes('a3'),
      '缺 ' + missing.join(','));
    // 对照：全覆盖时必须一个都不点
    const full = { a1: {}, a2: {}, a3: {} };
    const none = [...fakeArts.keys()].filter((a) => !full[a]);
    chk('契约全覆蓋时不得误报', none.length === 0, '误报 ' + none.length + ' 个');
  }

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
function initContract() {
  const ps = loadPipelines();
  const arts = collectArtifacts(ps);
  const out = { _note: '管线产物契约：把管线里的抽象 artifact 名映射到场景实际产出的文件名。由 工具/管线产物体检.mjs --init-contract 生成模板，人工确认后填写。', artifacts: {} };
  for (const [a, scenes] of arts) {
    const scene = scenes[0];
    const files = sceneFiles(scene);
    out.artifacts[a] = {
      scene,
      sceneCn: SCENE_NAME[scene] || scene,
      files: [],           // 人工填：该 artifact 对应哪几个实际文件
      candidates: files.slice(0, 8),  // 供参考
    };
  }
  fs.writeFileSync(CONTRACT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log('  ✓ 已生成契约表模板: ' + CONTRACT_FILE);
  console.log('    共 ' + arts.size + ' 个 artifact，请填 files 字段');
  console.log();
  for (const [a, v] of Object.entries(out.artifacts)) {
    console.log('    ' + a.padEnd(24) + '（' + v.sceneCn + '）候选: ' + v.candidates.slice(0, 3).join(', '));
  }
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }
  if (has('init-contract')) { initContract(); return; }

  const ps = loadPipelines();
  const arts = collectArtifacts(ps);
  const contract = loadContract();

  console.log('='.repeat(80));
  console.log('  管线产物体检 —— 管线定义的产物是否真的存在且被消费');
  console.log('='.repeat(80));
  console.log();
  console.log('  管线: ' + ps.length + ' 条   边: ' + ps.reduce((a, p) => a + (p.edges || []).length, 0) + ' 条   artifact: ' + arts.size + ' 个');
  console.log();

  // ① 契约表状态
  console.log('  【一】产物契约表');
  const entries = contract ? (contract.artifacts || contract) : null;
  if (!entries) {
    console.log('    ✗ 不存在（数据/.dsh/产物契约.json）');
    console.log('      → 这是管线的核心断层：抽象产物名没有映射到实际文件');
    console.log('      → 生成模板：node 工具/管线产物体检.mjs --init-contract');
  } else {
    const keys = Object.keys(entries);
    const withFiles = keys.filter((k) => {
      const v = entries[k];
      const fs2 = Array.isArray(v.files) ? v.files : (v.file ? [v.file] : []);
      return fs2.length > 0;
    });
    console.log('    契约数: ' + keys.length + '   已填 files: ' + withFiles.length);
    const missing = [...arts.keys()].filter((a) => !entries[a]);
    if (missing.length) console.log('    ⚠ 缺 ' + missing.length + ' 个 artifact: ' + missing.slice(0, 5).join(', '));
  }
  console.log();

  // ② 逐条边检查
  console.log('  【二】逐条边：上游产物是否存在 + 下游是否消费');
  let edgeN = 0;
  let existN = 0;
  let consumedN = 0;
  const problems = [];

  for (const p of ps) {
    console.log();
    console.log('    ── ' + p.name + ' ──');
    for (const e of p.edges || []) {
      edgeN++;
      const fromCn = SCENE_NAME[e.from] || e.from;
      const toCn = SCENE_NAME[e.to] || e.to;
      const art = e.artifact || '(未定义)';

      // 上游文件（经契约映射）
      let files = [];
      if (entries && entries[art] && Array.isArray(entries[art].files)) {
        files = entries[art].files;
      }
      const fromFiles = sceneFiles(e.from);
      const toText = sceneMem(e.to);

      // ⚠ 2026-11-12：改成调 judgeEdge()（唯一判据出处），不再在这里内联判断。
      //   自测对同一个函数下反例，才能证明「判据真的会判 false」。
      const j = judgeEdge(files, fromFiles, toText);
      const exists = j.exists;
      const consumed = j.consumed;
      const existing = j.existing;
      if (exists) existN++;
      if (consumed) consumedN++;

      if (!exists || !consumed) problems.push({ from: fromCn, to: toCn, art, exists, consumed, files, existing });

      console.log('      ' + (exists && consumed ? '✓' : '✗') + ' ' + fromCn.padEnd(10) + ' → ' + toCn.padEnd(10) +
        ' [' + art + ']  ' +
        (exists ? '产物在(' + existing.join(',') + ')' : '产物不在') +
        (consumed ? '  已消费' : '  未消费'));
    }
  }

  console.log();
  console.log('-'.repeat(80));
  console.log('  边: ' + edgeN + '   上游产物存在: ' + existN + '   下游已消费: ' + consumedN);
  console.log();
  if (!entries) {
    console.log('  🔴 核心问题：没有产物契约表，管线无法实际运转');
    console.log('     pipeline 里写的是 competitor-list，场景产出的是 项目功能矩阵.md，');
    console.log('     两者之间没有映射 → 下游不知道找哪个文件 → 管线是纸面的');
    process.exitCode = 1;
  } else if (consumedN < edgeN) {
    console.log('  ⚠ ' + (edgeN - consumedN) + ' 条边未被下游消费');
    process.exitCode = 1;
  } else {
    console.log('  ✓ 所有边都有产物且被消费');
  }
  console.log('='.repeat(80));
}

main();
