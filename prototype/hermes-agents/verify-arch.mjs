#!/usr/bin/env node
/**
 * 架构分层验证器。
 *
 * 目标第 7 条要求：「必须能画出我们自己的分层图，且每层有对应的代码位置和边界判据」。
 * 光画图不算 —— 图会漂移（ECC 的 45% 漂移就是这么来的）。所以每一层都要能被机器验证：
 *
 *   ① 存在性：这层的关键代码确实在（不是文档里写的假设路径）
 *   ② 边界：这层不许越界（用可判定的规则，不是「看起来合理」）
 *
 * 用法：node verify-arch.mjs [-v]
 *       node verify-arch.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/file/AI Temp/DeepSeek/Agent自研';
const WB = path.join(REPO, 'workbench');
const HERMES = 'C:/hermes';
const VERBOSE = process.argv.includes('-v');

const has = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * 位置探针 —— 把「文件在不在」升级成「在，且不是空壳」
 *
 * 【为什么必须这样】判据本来是 `fs.existsSync()`。它只能回答「这个名字在磁盘上」，
 * 回答不了「这一层真的实现了」。一个 0 字节的占位文件、一个空目录，
 * 跟「这层没写」在 exists() 眼里一模一样 —— 都是 true。
 * 于是「文件存在 = 这层在」成了本验收器最大的假绿来源。
 *
 * 这里把可判定的部分抽出来：存在 + 非空壳（文件 0 字节 / 目录 0 条目）。
 * 「内容是不是真实现」机器判不了全部，但「是不是连一个字节都没有」是硬事实。
 */
export function probePath(p) {
  let st;
  try { st = fs.statSync(p); } catch { return { exists: false }; }
  if (st.isDirectory()) {
    let entries = 0;
    try { entries = fs.readdirSync(p).length; } catch { entries = 0; }
    return { exists: true, kind: 'dir', entries };
  }
  return { exists: true, kind: 'file', bytes: st.size };
}

/** 空壳判定：存在但没有任何内容 —— 不算「这层在」 */
export function isHollow(info) {
  if (!info || !info.exists) return false;
  if (info.kind === 'dir') return info.entries === 0;
  return !(info.bytes > 0);
}

/**
 * 纯函数：一层「存在性」判定
 *
 * @param layer 形如 { id, name, where: [[路径, 标签], ...] }
 * @param deps  { probe?, repo? } —— 自检时注入假探针，正式运行时用 probePath
 * @returns 判定数组 [{ ok, msg, detail }]
 */
export function judgeExistence(layer, deps = {}) {
  const probe = deps.probe || probePath;
  const repo = deps.repo || REPO;
  const out = [];
  for (const [p, label] of layer.where) {
    const abs = p.startsWith('C:') ? p : path.join(repo, p);
    const info = probe(abs);
    if (!info.exists) {
      out.push({ ok: false, msg: label, detail: '缺失 ' + p });
    } else if (isHollow(info)) {
      out.push({
        ok: false, msg: label,
        detail: '存在但是空壳（' + (info.kind === 'dir' ? '目录无条目' : '0 字节') + '）: ' + p,
      });
    } else {
      out.push({ ok: true, msg: label, detail: '' });
    }
  }
  return out;
}

/**
 * 纯函数：一层「边界」判定
 *
 * 边界判据里的 check() 会读文件、解析 JSON —— 它也可能是坏的（抛异常）。
 * 抛异常时不许「看起来通过」，必须判成边界不成立。
 */
export function judgeBoundary(layer) {
  try {
    const [good, detail] = layer.boundary.check();
    return { ok: !!good, detail: detail || '' };
  } catch (e) {
    return { ok: false, detail: '边界判据抛错: ' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * 纯函数：整层 = 位置存在性 + 边界
 *
 * 关键：位置全在 **不等于** 这层成立。边界破了，整层照样不通过。
 */
export function judgeLayer(layer, deps = {}) {
  const existence = judgeExistence(layer, deps);
  const boundary = judgeBoundary(layer);
  const verdicts = existence.concat([{ ok: boundary.ok, msg: '（边界）', detail: boundary.detail, isBoundary: true }]);
  const pass = verdicts.filter((v) => v.ok).length;
  return { existence, boundary, verdicts, pass, fail: verdicts.length - pass };
}

/** 一层：名字 + 代码位置 + 边界判据 */
const LAYERS = [
  {
    id: 'L0',
    name: '平台层',
    what: 'Electron 外壳 + gateway + Python agent 循环。我们不自研，直接衍生。',
    where: [
      ['C:/hermes/apps/desktop/electron/main.ts', 'Electron 主进程'],
      ['C:/hermes/agent/conversation_loop.py', 'agent 循环'],
      ['C:/hermes/gateway', 'gateway'],
    ],
    boundary: {
      rule: '平台层不认识任何业务场景：conversation_loop.py 里不许出现我们的场景 id',
      check() {
        const p = HERMES + '/agent/conversation_loop.py';
        if (!has(p)) return [false, '文件不存在'];
        const t = read(p);
        const leaked = ['arch-review', 'backend-craft', 'tool-forge', 'pc-cleanup'].filter((s) => t.includes(s));
        return leaked.length === 0
          ? [true, '场景 id 零泄漏']
          : [false, '泄漏: ' + leaked.join(',')];
      },
    },
  },
  {
    id: 'L1',
    name: '执行层',
    what: 'agent loop + 工具执行 + 沙箱。干活的地方，不含业务判断。',
    where: [
      ['C:/hermes/agent', 'hermes agent 实现'],
      ['C:/hermes/tools', '工具注册表'],
    ],
    boundary: {
      rule: '执行层不含业务规矩：tools/ 里不许出现我们的场景名',
      check() {
        const dir = HERMES + '/tools';
        if (!has(dir)) return [false, '目录不存在'];
        const hits = [];
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (!/__pycache__|\.venv/.test(p)) walk(p); continue; }
            if (!e.name.endsWith('.py')) continue;
            const t = read(p);
            for (const s of ['架构梳理', '工具工坊', '故障分析']) if (t.includes(s)) hits.push(e.name + ':' + s);
          }
        };
        walk(dir);
        return hits.length === 0 ? [true, '业务名零泄漏'] : [false, hits.slice(0, 3).join(', ')];
      },
    },
  },
  {
    id: 'L2',
    name: '场景层',
    what: '12 个场景的身份（名字/领域/界面布局）+ 契约（输入输出/越界/验收）。',
    where: [
      ['workbench/外壳/scenarios', '场景身份 + 布局 + 领域'],
      ['workbench/sceneboard/scenes', '场景契约（inputs/outputs/to）'],
    ],
    boundary: {
      rule: '场景层只声明不存储：scenarios/*.json 不许内嵌记忆正文（只许引用）',
      check() {
        const dir = WB + '/外壳/scenarios';
        if (!has(dir)) return [false, '目录不存在'];
        const bad = [];
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
          const j = JSON.parse(read(path.join(dir, f)));
          // 场景身份字段白名单；出现大段正文（>200 字）即为越界
          for (const [k, v] of Object.entries(j)) {
            if (typeof v === 'string' && v.length > 200 && !['description'].includes(k)) {
              bad.push(f + ':' + k + '(' + v.length + '字)');
            }
          }
        }
        return bad.length === 0 ? [true, '无内嵌长正文'] : [false, bad.slice(0, 3).join(', ')];
      },
    },
  },
  {
    id: 'L3',
    name: '记忆层',
    what: '三层记忆（注入/私有/共享）+ 神经元（关系图）。存东西的地方，不含调度逻辑。',
    where: [
      ['workbench/数据/.dsh/场景记忆', '场景私有 + 共享记忆'],
      ['workbench/数据/.dsh/AGENTS.md', '注入层'],
    ],
    boundary: {
      rule: '记忆层只存不管：记忆目录里不许有可执行脚本（.mjs/.js/.py）',
      check() {
        const dir = WB + '/数据/.dsh/场景记忆';
        if (!has(dir)) return [false, '目录不存在'];
        const scripts = [];
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (/\.(mjs|js|py|sh|ps1)$/.test(e.name)) scripts.push(path.relative(dir, p));
          }
        };
        walk(dir);
        return scripts.length === 0 ? [true, '纯数据'] : [false, '混入脚本: ' + scripts.slice(0, 3).join(', ')];
      },
    },
  },
  {
    id: 'L4',
    name: '协作层',
    what: '派单台账 + 合同任务板。谁派给谁、做到什么算完，都记在这。',
    where: [
      ['C:/Users/15282/AppData/Local/hermes/dsh-shared/派单台账.json', '派单事实记录'],
    ],
    boundary: {
      rule: '协作层只记账不执行：台账是只读事实，不许有 state=unknown 的悬空单',
      check() {
        const p = 'C:/Users/15282/AppData/Local/hermes/dsh-shared/派单台账.json';
        if (!has(p)) return [false, '台账不存在'];
        const j = JSON.parse(read(p));
        const rows = j.dispatches || [];
        const bad = rows.filter((r) => !r.state || r.state === 'unknown');
        return bad.length === 0
          ? [true, rows.length + ' 条均有明确状态']
          : [false, bad.length + ' 条状态不明'];
      },
    },
  },
  {
    id: 'L5',
    name: '管线层',
    what: '场景怎么串起来（build-software 管线）。只描述顺序，不执行。',
    where: [
      ['workbench/sceneboard/pipelines/build-software.json', '构建软件管线'],
    ],
    boundary: {
      rule: '管线层的每一步必须指向真实存在的场景（否则是死链）',
      check() {
        const pipe = WB + '/sceneboard/pipelines/build-software.json';
        const scen = WB + '/外壳/scenarios';
        if (!has(pipe) || !has(scen)) return [false, '文件不存在'];
        const p = JSON.parse(read(pipe));
        const ids = new Set(fs.readdirSync(scen).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
        const steps = JSON.stringify(p).match(/"(?-i:)(arch-review|build-plan|backend-craft|frontend-craft|tool-forge|hub|research|competitor-analyze|reverse-eng|self-review|incident-analysis|pc-cleanup)"/g) || [];
        const refs = [...new Set(steps.map((s) => s.replace(/"/g, '')))];
        const dead = refs.filter((r) => !ids.has(r));
        return dead.length === 0
          ? [true, refs.length + ' 个场景引用全部有效']
          : [false, '死链: ' + dead.join(',')];
      },
    },
  },
  {
    id: 'L6',
    name: '验证层',
    what: '机制体检 106 项 + 神经元审计 13 项 + 全量验收 106 项 + 星图验收 13 项。只判不改。四态裁决见 four-state.mjs。',
    where: [
      ['workbench/工具/机制体检.mjs', '106 个机制守卫'],
      ['prototype/hermes-agents/audit-neuron.mjs', '神经元图语义审计'],
      ['prototype/hermes-agents/verify-all.mjs', '全量写入验收'],
      ['prototype/hermes-agents/verify-starmap.mjs', '星图端到端验收'],
    ],
    boundary: {
      rule: '验证层只读不写业务数据：审计脚本不许写 场景/记忆/台账',
      check() {
        const files = [
          REPO + '/prototype/hermes-agents/audit-neuron.mjs',
          REPO + '/prototype/hermes-agents/verify-all.mjs',
        ];
        const bad = [];
        for (const f of files) {
          if (!has(f)) { bad.push(path.basename(f) + ' 不存在'); continue; }
          const t = read(f);
          // 允许写自己的报告产物，不许写记忆/台账
          if (/writeFileSync\([^)]*派单台账|writeFileSync\([^)]*NEURON\.json|writeFileSync\([^)]*场景记忆/.test(t)) {
            bad.push(path.basename(f) + ' 写业务数据');
          }
        }
        return bad.length === 0 ? [true, '只判定不改数据'] : [false, bad.join(', ')];
      },
    },
  },
  {
    id: 'L7',
    name: '界面层',
    what: '不自己设计，衍生 hermes 的界面：星图/贡献点/布局。我们的东西以补丁形式叠加。',
    where: [
      ['C:/hermes/apps/desktop/src/app/starmap', 'hermes 星图（我们复用的可视化）'],
      ['C:/hermes/apps/desktop/src/app/contrib', '贡献点注册表'],
      ['hermes-patches', '我们的叠加补丁集'],
    ],
    boundary: {
      rule: '界面层不持有业务数据：补丁集里不许有记忆/场景 JSON 副本',
      check() {
        const dir = REPO + '/hermes-patches';
        if (!has(dir)) return [false, '补丁集不存在'];
        const bad = [];
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (/NEURON|派单台账|场景记忆/.test(e.name)) bad.push(e.name);
          }
        };
        walk(dir);
        return bad.length === 0 ? [true, '无数据副本（只加代码）'] : [false, bad.join(', ')];
      },
    },
  },
];

/**
 * 自检 —— 用假层级验证「该报的报、不该报的不报」
 *
 * 【为什么反例全打在「文件在 ≠ 层实现了」上】
 * 这个验收器的正式判据原来只有 `exists()`。给 8 层各写一个 0 字节文件和
 * 建一个空目录，一个都没实现的架构也能全绿 —— 这就是「拿文件存在冒充实现」。
 * 下面每条反例都是「位置在、但内容不成立」，断言它必须变红。
 */
export function selfTest() {
  const cases = [];
  const T = (n, ok, why) => cases.push([n, !!ok, why]);

  const L = (where, checkFn) => ({
    id: 'LX', name: '假层', where,
    boundary: { rule: '假判据', check: checkFn },
  });
  const probeMap = (map) => (p) => map[p] || { exists: false };

  // ── 反例 1（核心）：文件存在但 0 字节 → 空壳，不算这层在 ──
  //   这正是「文件存在 ≠ 实现」的最小形态：exists() 会判 true，本判据必须判 false。
  const r1 = judgeExistence(L([['C:/x/a.mjs', 'A']], () => [true, '']),
    { probe: probeMap({ 'C:/x/a.mjs': { exists: true, kind: 'file', bytes: 0 } }) });
  T('反例 · 文件存在但 0 字节 → 判空壳，不许当「这层在」',
    r1.length === 1 && r1[0].ok === false && /空壳/.test(r1[0].detail), JSON.stringify(r1));

  // ── 反例 2：目录存在但没有任何条目 → 同样是空壳 ──
  //   目录型位置（workbench/外壳/scenarios 等）用「有没有东西」判，不是「目录名在不在」。
  const r2 = judgeExistence(L([['C:/x/dir', 'D']], () => [true, '']),
    { probe: probeMap({ 'C:/x/dir': { exists: true, kind: 'dir', entries: 0 } }) });
  T('反例 · 目录存在但 0 条目 → 判空壳',
    r2.length === 1 && r2[0].ok === false && /空壳/.test(r2[0].detail), JSON.stringify(r2));

  // ── 反例 3：位置全在，但边界不成立 → 整层不通过 ──
  //   「每层 3 个文件都在」不能抵消「这层越界了」。边界是独立判据，破了就不算数。
  const probeOk = () => ({ exists: true, kind: 'file', bytes: 900 });
  const r3 = judgeLayer(L([['C:/x/a.mjs', 'A'], ['C:/x/b', 'B']], () => [false, '场景 id 泄漏: arch-review']),
    { probe: probeOk });
  T('反例 · 位置全在但边界破坏 → 整层不通过',
    r3.pass === 2 && r3.fail === 1 && r3.boundary.ok === false, 'pass=' + r3.pass + ' fail=' + r3.fail);

  // ── 反例 4：边界判据自身抛错 → 判不成立，不许「看起来通过」 ──
  //   边界 check() 要读文件/解析 JSON。它崩溃时若被当成通过，等于「坏掉的守卫保护一切」。
  const r4 = judgeBoundary(L([], () => { throw new Error('读不到台账'); }));
  T('反例 · 边界判据抛错 → 判不成立（不是静默通过）',
    r4.ok === false && /抛错/.test(r4.detail), JSON.stringify(r4));

  // ── 反例 5：位置缺失 → 报缺失（防止自检把「全都在」写死）──
  const r5 = judgeExistence(L([['C:/x/missing.mjs', 'M']], () => [true, '']), { probe: () => ({ exists: false }) });
  T('反例 · 位置缺失 → 报缺失',
    r5.length === 1 && r5[0].ok === false && /缺失/.test(r5[0].detail), JSON.stringify(r5));

  // ── 正例：位置都在且有内容 + 边界成立 → 全通过 ──
  const r6 = judgeLayer(L([['C:/x/a.mjs', 'A'], ['C:/x/dir', 'D']], () => [true, '零泄漏']),
    { probe: (p) => (p.endsWith('dir') ? { exists: true, kind: 'dir', entries: 5 } : { exists: true, kind: 'file', bytes: 8000 }) });
  T('正例 · 位置在且有内容 + 边界成立 → 全通过',
    r6.pass === 3 && r6.fail === 0, JSON.stringify({ pass: r6.pass, fail: r6.fail }));

  const bad = cases.filter(([, ok]) => !ok);
  return {
    pass: cases.length - bad.length, total: cases.length, ok: bad.length === 0,
    lines: cases.map(([n, ok, w]) => '  ' + (ok ? '✓' : '✗') + ' ' + n + (ok ? '' : '  ← ' + w)).join('\n'),
  };
}

if (process.argv.includes('--selftest')) {
  const r = selfTest();
  console.log('');
  console.log('  架构分层验证 · 自检（1 正例 + 5 反例，反例全打「文件在 ≠ 层实现了」）');
  console.log('  ' + '─'.repeat(72));
  console.log(r.lines);
  console.log('');
  console.log('  结论: ' + (r.ok ? '✓ ' + r.pass + '/' + r.total : '✗ ' + (r.total - r.pass) + ' 项不成立'));
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

// ── 正式验证（只在直接运行时执行）──
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('    ✓ ' + n + (d ? '  ' + d : '')); };
const no = (n, d) => { fail++; console.log('    ✗ ' + n + (d ? '  ' + d : '')); };

console.log('  架构分层验证：' + LAYERS.length + ' 层，每层验「存在性 + 边界」');
console.log('');
for (const L of LAYERS) {
  console.log('  ── ' + L.id + ' ' + L.name + '：' + L.what);
  const r = judgeLayer(L);
  for (const v of r.existence) (v.ok ? ok(v.msg, v.detail) : no(v.msg, v.detail));
  console.log('     边界判据：' + L.boundary.rule);
  r.boundary.ok ? ok('边界成立', r.boundary.detail) : no('边界被破坏', r.boundary.detail);
  if (VERBOSE) console.log('     （以上 ' + L.where.length + ' 个位置 + 1 条边界）');
}
console.log('');
console.log('  ──────────────────────────────────────────────');
console.log('    断言：通过 ' + pass + '  失败 ' + fail);
console.log('  ──────────────────────────────────────────────');
process.exit(fail ? 1 : 0);
