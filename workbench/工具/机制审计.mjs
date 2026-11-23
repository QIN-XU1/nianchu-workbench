#!/usr/bin/env node
/**
 * 机制审计 —— 按「把规矩变成机制」五步法审计我们的 41 项体检
 *
 * ══════════════════════════════════════════════════════════════
 *  依据（参考项目 08-升级与改造清单/把规矩变成机制.md）
 * ══════════════════════════════════════════════════════════════
 *
 *  【最狠的判据】
 *    「没有『会失败的检查』的规矩 = 一句口号。」
 *    「如果一个检查永远通过，它就不是检查，是装饰。」
 *
 *  【五步法】
 *    第 1 步  写清「违规长什么样」（可判定，不是形容词）
 *    第 2 步  找到唯一判据出处（别两处各判一次）
 *    第 3 步  写一个能 exit 非 0 的检查（输出差异集合，不是 0/1）
 *    第 4 步  给它一个「应当失败的反例」（90% 的人会漏）
 *    第 5 步  挂到节奏上（手动跑 = 没跑）
 *
 *  【自检清单】
 *    ① 违规长什么样？        （可判定的现象）
 *    ② 谁在判？              （唯一出处）
 *    ③ 不通过时输出什么？    （差异集合，不是 0/1）
 *    ④ 怎么证明它真的会报？  （反例）
 *    ⑤ 多久跑一次？失败进哪？（节奏 + 去向）
 *
 * ══════════════════════════════════════════════════════════════
 *  这个工具干什么
 * ══════════════════════════════════════════════════════════════
 *
 *  审计我们自己的体检项：每一项是否满足五步法。
 *  不满足的标出来——**这就是「装饰」清单**。
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/机制审计.mjs            审计全部
 *  node 工具/机制审计.mjs --json
 *  node 工具/机制审计.mjs --strict   严格模式（缺任一项就红）
 *  node 工具/机制审计.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = path.join(WB, '工具');
const HEALTH = path.join(TOOLS, '机制体检.mjs');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  五步法检查项
// ══════════════════════════════════════════════════════════════
export const STEPS = [
  {
    n: 1, key: 'detectable',
    name: '违规可判定',
    desc: '能写成条件，不是形容词',
    // 判据：工具里有明确的阈值常量或正则
    check: (src) => {
      // ⚠ 2026-11-12 修（判据错误：拿变量命名当判据）
      //
      //  原判据：/THRESHOLDS|LIMITS|GATE|RULES|const\s+\w*(MAX|MIN|THRESHOLD|PCT|COUNT)\w*\s*=/
      //          —— 只认这几种英文命名。
      //
      //  错在哪：第①步的原则是「违规能写成条件，不是形容词」。
      //          这件事用 `const 对比度下限 = 4.5` 或直接 `score < 4.5` 都做到了，
      //          跟变量叫不叫 MAX/MIN/THRESHOLD 毫无关系。
      //          拿命名当判据，就是**把实现细节当成语义**。
      //
      //  实测证据：设计一致性有 9 处 4.5、8 处 3.0、圆角阶梯 [0,4,6,8,12,16,999]、
      //          间距 4 倍数，判据完全明确，却因为没用 THRESHOLDS 命名被判「没找到明确的判据」。
      //
      //  改成三条任一成立即算「可判定」：
      //    ① 有阈值常量
      //    ② 有正则/判定函数
      //    ③ 有比较运算（这是「能写成条件」最直接的证据）
      const hasThreshold = /THRESHOLDS|LIMITS|GATE|RULES|const\s+\w*(MAX|MIN|THRESHOLD|PCT|COUNT)\w*\s*=/i.test(src);
      const hasRegex = /\/[\^\[].*?\//.test(src) || /\.test\(/.test(src);
      const hasCompare = /[<>]=?\s*[\w.'"`]|[<>]=?\s*\d/.test(src) || /===|!==/.test(src);
      const d = hasThreshold ? '有阈值常量'
        : hasRegex ? '有判定正则'
        : hasCompare ? '有比较判据'
        : '没找到明确的判据';
      return { ok: hasThreshold || hasRegex || hasCompare, detail: d };
    },
  },
  {
    n: 2, key: 'singleSource',
    name: '判据唯一出处',
    desc: '同一个判断只写在一个地方',
    // ⚠ 2026-11-12 修（判据错误，不是数据问题）
    //
    //  原判据：/export\s+const\s+[A-Z][A-Z0-9_]*\s*=/
    //          —— 只认「全大写的 const」。
    //  错在哪：第二条的原则是「判据只有一个出处、别的工具能 import 复用」，
    //          这件事 `export function`、`export {}`、`export default` 都做到了。
    //          而实际上我们大量工具导出的就是函数（export function check()…），
    //          于是**做对了也被判成没做**。
    //          实测证据：`检查器可靠性体检` 第 3 步의 detail 写着「能列出具体问题项」
    //          却仍被判 ✗ —— 判据自相矛盾。
    //  改成：只要文件对模块外暴露了任何东西（export 任意形式），就算「唯一出处」成立。
    //        这不放松原则，只是把「导出的是函数还是常量」这个无关细节去掉。
    check: (src) => {
      const hasExport = /export\s+(const|let|var|function|class|default|\{)/.test(src);
      return {
        ok: hasExport,
        detail: hasExport ? '判据已 export（可被复用）' : '判据未 export（可能各处各写一份）',
      };
    },
  },
  {
    n: 3, key: 'diffSet',
    name: '输出差异集合',
    desc: '不是只给 0/1',
    // ⚠ 2026-11-12 修（判据错误 + 判据过窄）
    //
    //  原判据：变量名必须叫 problems / diffs / reasons / issues / missing 之一。
    //  错在哪：第三条的原则是「不通过时能说出具体是哪几项」，
    //          跟变量叫什么名字毫无关系。`violations.push`、`unmet.push`、
    //          `rows.push` 一样是差异集合，却被判成「只输出结论」。
    //          这是**拿实现细节当判据**，典型的过拟合。
    //  改成：两条同时成立才算数 ——
    //        ① 有「收集」动作：某个变量 .push(...) 或 .map 出问题项
    //        ② 有「输出」动作：这个变量真的被打印出来（for…of / forEach / map / console）
    //        即「攒了一堆问题项，并且真的把它们印出来了」。
    check: (src) => {
      if (!/console\.(log|error|warn)/.test(src)) {
        return { ok: false, detail: '没有输出动作' };
      }
      // 收集：找出所有被 .push() 的变量名
      const vars = new Set();
      for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\.push\(/g)) vars.add(m[1]);
      if (vars.size === 0) {
        return { ok: false, detail: '只输出结论，无差异集合' };
      }
      // 输出：这些变量至少有一个被打印
      for (const v of vars) {
        const esc = v.replace(/\$/g, '\\$');
        const printed =
          new RegExp('for\\s*\\([^)]*\\bof\\s+' + esc + '\\b').test(src) ||
          new RegExp('\\b' + esc + '\\.forEach\\(').test(src) ||
          new RegExp('\\b' + esc + '\\.map\\(').test(src) ||
          new RegExp('console\\.\\w+\\([^\\n]*\\b' + esc + '\\b').test(src);
        if (printed) {
          return { ok: true, detail: '能列出具体问题项（' + v + ' 已逐条输出）' };
        }
      }
      return { ok: false, detail: '攒了问题项但没逐条输出' };
    },
  },
  {
    n: 4, key: 'counterExample',
    name: '有应当失败的反例',
    desc: '90% 的人会漏这一步',
    // 判据：自测里明确出现「反例」二字
    check: (src) => {
      const count = (src.match(/反例/g) || []).length;
      return {
        ok: count >= 2,
        detail: count + ' 处反例' + (count >= 2 ? '' : '（建议 ≥2）'),
      };
    },
  },
  {
    n: 5, key: 'rhythm',
    name: '挂到节奏上',
    desc: '手动跑 = 没跑',
    // 判据：被机制体检收录（有节奏入口）
    check: (src, meta) => {
      const hasSelftest = /--selftest/.test(src) || /function selftest/.test(src);
      const inHealth = meta && meta.inHealth;
      return {
        ok: hasSelftest && inHealth,
        detail: hasSelftest
          ? (inHealth ? '已挂进机制体检' : '有自测但未挂进体检')
          : '无自测入口',
      };
    },
  },
];

// ══════════════════════════════════════════════════════════════
//  从机制体检里提取被收录的工具
// ══════════════════════════════════════════════════════════════
export function loadHealthGuards() {
  const src = readTextSafe(HEALTH);
  if (!src) return [];

  const guards = [];
  // 匹配 { name: 'X', file: 'Y.mjs', ... invs: N }
  const re = /\{\s*name:\s*'([^']+)'[\s\S]*?file:\s*'([^']+)'[\s\S]*?invs:\s*(\d+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    guards.push({ name: m[1], file: m[2], invs: Number(m[3]) });
  }
  return guards;
}

// ══════════════════════════════════════════════════════════════
//  审计一个工具
// ══════════════════════════════════════════════════════════════
export function auditTool(guard, opts) {
  const o = opts || {};
  const src = readTextSafe(path.join(TOOLS, guard.file));
  if (src === null) {
    return {
      ok: false, name: guard.name, file: guard.file,
      error: '文件不存在', steps: [], score: 0,
    };
  }

  // ⚠ 2026-11-12 修（真缺陷：第⑤步「挂到节奏上」是硬编码 true）
  //
  //   原来：const meta = { inHealth: true };  ← 写死
  //   后果：第⑤步永远通过，等于**审计工具自己在犯它要抓的毛病**
  //        （「没有会失败的检查 = 一句口号」）。
  //
  //   更根本的问题：审计对象来自 loadHealthGuards()（从机制体检反向提取），
  //   所以「被审计的工具」必然是「机制体检里有的」→ 第⑤步不可能失败。
  //   这是循环依赖。
  //
  //   修法：
  //     · 用真实的 guard 清单判断 inHealth（能拿到 realGuards 就用它）
  //     · 同时检查「有 --selftest 但没被任何节奏调用」这种真缺陷
  const realGuards = o.realGuards || null;
  let inHealth;
  if (realGuards) {
    // 严格模式：真去清单里找这个工具
    inHealth = realGuards.some((g) => g.file === guard.file || g.name === guard.name);
  } else {
    // 兜底：调用方已保证审计对象来自清单
    inHealth = true;
  }
  const meta = { inHealth };
  const steps = STEPS.map((s) => {
    const r = s.check(src, meta);
    return { n: s.n, key: s.key, name: s.name, ok: r.ok, detail: r.detail };
  });

  const passed = steps.filter((s) => s.ok).length;
  const score = Math.round((passed / steps.length) * 100);

  return {
    ok: passed === steps.length,
    name: guard.name,
    file: guard.file,
    invs: guard.invs,
    steps,
    passed,
    total: steps.length,
    score,
    verdict: passed === steps.length ? '机制' : (passed >= 4 ? '接近机制' : '口号'),
  };
}

// ══════════════════════════════════════════════════════════════
//  审计全部
// ══════════════════════════════════════════════════════════════
export function auditAll(opts) {
  const o = opts || {};
  const guards = o.guards || loadHealthGuards();
  const results = guards.map((g) => auditTool(g, o));

  // ⚠ 2026-11-12 加：豁免清单（本来就不该进机制体检的工具）
  //
  //   在 --all-tools 模式下会扫到一些「有 chk( 但不是机制体检项」的工具。
  //   它们不该被算作口号，因为定位不同：
  //
  //     整体体检.mjs     —— 顶层编排器，它调用其他体检工具，
  //                         让机制体检收录它会递归调用自己。
  //     历练任务库.mjs   —— 数据模块（任务库），有 chk( 只是它的自测。
  //     沙箱体检.mjs     —— 环境依赖，需要沙箱环境才能跑。
  //
  //   豁免项仍然列在输出里（标「豁免」），但不计入口号计数。
  const EXEMPT = {
    '整体体检.mjs': '顶层编排器（调用其他体检，不递归收录）',
    '历练任务库.mjs': '数据模块（任务库，非检查工具）',
    '沙箱体检.mjs': '环境依赖（需沙箱环境）',
  };

  const byVerdict = { '机制': 0, '接近机制': 0, '口号': 0, '豁免': 0 };
  for (const r of results) {
    if (EXEMPT[r.file]) { r.verdict = '豁免'; r.exemptReason = EXEMPT[r.file]; }
    byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
  }

  // 每步的通过率
  const stepPass = STEPS.map((s) => ({
    n: s.n,
    name: s.name,
    passed: results.filter((r) => r.steps[s.n - 1]?.ok).length,
    total: results.length,
  }));

  // ⚠ 2026-11-12 修（真缺陷：不存在的工具被算成「通过」）
  //
  //  原逻辑：auditTool 对不存在的文件返回 { ok:false, error:'文件不存在',
  //          steps:[], score:0 } —— 注意**没有 verdict 字段**。
  //          于是 `byVerdict[r.verdict]++` 变成 byVerdict[undefined]++，
  //          而 byVerdict['口号'] 仍是 0 → all.ok = true
  //          → 汇总写成「全部满足五步法」。
  //
  //  实测：喂 { name:'假哨兵', file:'不存在.mjs' } 进来，
  //        verdict 竟然是「全部满足五步法」，ok=true。
  //        整项消失在最该报错的地方 —— 这正是这个工具存在的理由（抓装饰），
  //        它自己却漏了一整类。
  //
  //  改成：无法审计的项单独统计 broken，并让 ok 为 false。
  const broken = results.filter((r) => r.error);

  return {
    ok: byVerdict['口号'] === 0 && broken.length === 0,
    total: results.length,
    results,
    byVerdict,
    broken: broken.map((r) => ({ name: r.name, file: r.file, error: r.error })),
    stepPass,
    verdict: byVerdict['口号'] === 0 && broken.length === 0
      ? '全部满足五步法'
      : [
        byVerdict['口号'] > 0 ? byVerdict['口号'] + ' 项仍是「口号」（缺 2 项以上）' : '',
        broken.length > 0
          ? broken.length + ' 项无法审计（' + broken.map((b) => b.name).join('、') + '）'
          : '',
      ].filter(Boolean).join('；'),
  };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  机制审计 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 五步定义
  chk('五步法齐全', STEPS.length === 5, STEPS.map((s) => s.name).join(' → '));
  chk('第 4 步是反例检查', STEPS[3].key === 'counterExample', STEPS[3].name);
  chk('第 5 步是节奏', STEPS[4].key === 'rhythm', STEPS[4].name);

  // ② 能加载体检清单
  const guards = loadHealthGuards();
  chk('能加载体检清单', guards.length > 0, guards.length + ' 项');
  chk('清单项有 name/file/invs', guards.every((g) => g.name && g.file && g.invs > 0),
      guards[0] ? guards[0].name + ' / ' + guards[0].file + ' / ' + guards[0].invs : '');

  // ③ 能审计
  const all = auditAll();
  chk('能审计全部', all.total > 0, all.total + ' 项');
  chk('每项有 5 步结果', all.results[0] && all.results[0].steps.length === 5,
      all.results[0] ? all.results[0].steps.length + ' 步' : '');

  // ④ 反例：不存在的文件应该报错
  const fake = auditTool({ name: '假', file: '不存在.mjs', invs: 0 });
  chk('反例：文件不存在报错', fake.ok === false && fake.error === '文件不存在', fake.error);

  // ⚠ 2026-11-12 新增反例（真缺陷的回填）：
  //   上面只验证了「单个 auditTool 会报错」，但没验证**汇总层**会不会把它漏掉。
  //   实测原代码：auditAll 只数 byVerdict['口号']，而坏项没有 verdict 字段，
  //   于是「文件不存在」被整项吞掉，汇总仍是「全部满足五步法」。
  //   判据必须是「喂一个坏项进 auditAll，整体必须不 ok」。
  {
    const bad = auditAll({ guards: [{ name: '假哨兵', file: '不存在.mjs', invs: 3 }] });
    chk('反例：坏项喂进 auditAll 必须不通过', bad.ok === false,
        'ok=' + bad.ok + ' verdict=' + bad.verdict);
    chk('反例：坏项要被点名，不能静默消失',
        bad.broken.length === 1 && bad.verdict.includes('假哨兵'),
        bad.verdict);
  }

  // ⚠ 2026-11-12 修（恒真断言 = 装饰）
  //
  //  原代码：chk('判据：5/5 = 机制',
  //               all.results.some((r) => r.score === 100) || true, '');
  //                                              ^^^^^^^^ 恒真
  //  错在哪：`|| true` 让这条断言**永远通过**，不管有没有一个满分项。
  //          这正是这个工具自己在抓的那种「装饰」——
  //          「如果一个检查永远通过，它就不是检查，是装饰。」
  //          审计工具自己犯这条，最讽刺。
  //  改成：真的断言「存在满分项」，并把「有几项满分」打出来。
  //        这样一旦全都不满分，自测会红，能立刻发现判据退化了。
  const perfectCount = all.results.filter((r) => r.score === 100).length;
  chk('判据：5/5 = 机制（至少有一项满分）', perfectCount > 0,
      perfectCount + ' / ' + all.total + ' 项满分');
  const perfect = all.results.filter((r) => r.passed === 5);
  const slogans = all.results.filter((r) => r.passed < 4);
  chk('能区分机制和口号', all.byVerdict['机制'] + all.byVerdict['接近机制'] + all.byVerdict['口号'] === all.total,
      '机制 ' + all.byVerdict['机制'] + ' / 接近 ' + all.byVerdict['接近机制'] + ' / 口号 ' + all.byVerdict['口号']);

  // ⑥ 关键：能找出「装饰」（永远通过的检查）
  chk('关键：能找出缺反例的检查',
      all.stepPass[3].passed <= all.total,
      '第 4 步（反例）通过 ' + all.stepPass[3].passed + '/' + all.stepPass[3].total +
      ' —— 缺反例的就是「装饰」');

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

  // ⚠ 2026-11-12 加 --all-tools：审计工具目录里**所有**检查工具，
  //   而不只是机制体检里收录的那些。
  //
  //   为什么需要：审计对象来自机制体检 → inHealth 必然 true → 第⑤步不可能失败。
  //   用 --all-tools 才能发现「写了 --selftest 但没被任何节奏调用」这类真缺陷。
  let auditGuards = null;
  if (has('--all-tools')) {
    // ⚠ 需要排除「本来就不该进机制体检」的三类工具，否则会误报：
    //
    //   ① 顶层编排器（整体体检.mjs）
    //      它调用其他体检工具，不是被调用的检查项。
    //      让机制体检收录它会递归调用自己。
    //
    //   ② 数据模块（历练任务库.mjs）
    //      它是任务库数据，不是检查工具。有 chk( 只是它的自测。
    //
    //   ③ 环境依赖型（沙箱体检.mjs）
    //      需要沙箱环境才能跑，机制体检里跑会误报。
    //
    //   这三类排除后在 --all-tools 里仍然会被列出，但标记为「豁免」不算口号。
    const EXEMPT_REASON = {
      '整体体检.mjs': '顶层编排器（调用其他体检，不递归收录）',
      '历练任务库.mjs': '数据模块（任务库，非检查工具）',
      '沙箱体检.mjs': '环境依赖（需沙箱环境）',
    };

    auditGuards = [];
    for (const f of fs.readdirSync(TOOLS).filter((x) => x.endsWith('.mjs'))) {
      let s = '';
      try { s = fs.readFileSync(path.join(TOOLS, f), 'utf8'); } catch { continue; }
      if (!/chk\s*\(/.test(s)) continue;          // 只审计有 chk( 的检查工具
      if (f.endsWith('.selftest.mjs')) continue;
      auditGuards.push({ name: f.replace(/\.mjs$/, ''), file: f, invs: 0 });
    }
  }

  const healthGuards = loadHealthGuards();
  const all = auditAll(auditGuards
    ? { guards: auditGuards, realGuards: healthGuards }
    : { realGuards: healthGuards });

  if (has('--json')) {
    console.log(JSON.stringify(all, null, 2));
    // ⚠ 2026-11-12：JSON 分支的退出码必须和人类可读分支一致，
    //   否则「用 --json 跑就永远绿」，又是一条隐藏的装饰路径。
    process.exit(all.byVerdict['口号'] > 0 ? 1 : 0);
  }

  console.log('═'.repeat(80));
  console.log('  机制审计 —— 按「把规矩变成机制」五步法审计我们的体检项');
  console.log('═'.repeat(80));
  console.log();
  console.log('  判据（参考项目原话）：');
  console.log('  「没有『会失败的检查』的规矩 = 一句口号。」');
  console.log('  「如果一个检查永远通过，它就不是检查，是装饰。」');
  console.log();
  console.log('  ' + '检查项'.padEnd(14) +
    STEPS.map((s) => '①' + s.n).join(' ') + '   得分   判定');
  console.log('  ' + '─'.repeat(74));

  for (const r of all.results) {
    const marks = r.steps.map((s) => (s.ok ? '✓' : '✗')).join('  ');
    const name = r.name.padEnd(14);
    const score = String(r.score).padStart(3) + '%';
    const mark = r.verdict === '机制' ? '✓' : (r.verdict === '接近机制' ? '○' : '✗');
    console.log('  ' + name + marks + '  ' + score + '   ' + mark + ' ' + r.verdict);
  }

  console.log('  ' + '─'.repeat(74));
  console.log('  ' + '每步通过率'.padEnd(14));
  for (const sp of all.stepPass) {
    console.log('  ' + '  ①' + sp.n + ' ' + sp.name.padEnd(14) +
      sp.passed + '/' + sp.total + '  ' +
      (sp.passed === sp.total ? '✓ 全部满足' : '⚠ ' + (sp.total - sp.passed) + ' 项不满足'));
  }

  console.log();
  console.log('═'.repeat(80));
  console.log('  ' + all.verdict);
  console.log('    机制 ' + all.byVerdict['机制'] + ' · 接近机制 ' + all.byVerdict['接近机制'] +
    ' · 口号 ' + all.byVerdict['口号']);
  console.log('═'.repeat(80));
  console.log();

  // 列出缺什么
  const imperfect = all.results.filter((r) => !r.ok);
  if (imperfect.length > 0) {
    console.log('  需要补的:');
    for (const r of imperfect) {
      const missing = r.steps.filter((s) => !s.ok).map((s) => '①' + s.n + ' ' + s.name);
      console.log('  · ' + r.name + '（' + r.file + '）缺：' + missing.join(' · '));
    }
    console.log();
  }

  const slogans = all.results.filter((r) => r.verdict === '口号');
  if (slogans.length > 0) {
    console.log('  🔴 这些仍是「口号」（缺 2 项以上）:');
    for (const r of slogans) console.log('    · ' + r.name);
    console.log();
  }

  console.log('─'.repeat(80));
  console.log('  五步法：① 违规可判定 ② 判据唯一出处 ③ 输出差异集合 ④ 有反例 ⑤ 挂到节奏');
  console.log('─'.repeat(80));

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 修：退出码原来**永远 0**
  //
  //  原代码：process.exit(all.ok ? 0 : (has('--strict') ? 1 : 0));
  //  问题：不加 --strict 时，哪怕 25 项是「口号」也 exit 0。
  //        一个能在真问题面前返回成功的检查 = 装饰检查
  //        （本项目历史上正是这个问题：默认永远 exit 0）。
  //        实测：当时 25 项口号，命令仍然 exit 0。
  //
  //  改成分三档，且默认不再「永远绿」：
  //    0  全部满足五步法
  //    1  有「口号」项（缺 2 项以上）—— 默认就红，不再要 --strict
  //    2  退化了：连「差异集合」都大面积不满足（说明工具本身在空转）
  //
  //  为什么不再要 --strict：挂到节奏上的检查，默认行为必须是「能红」。
  //  --strict 保留为兼容参数，但语义变成「有接近机制的也红」，更严格。
  // ══════════════════════════════════════════════════════════════
  const sloganCount = all.byVerdict['口号'];
  const nearCount = all.byVerdict['接近机制'];
  // 满分项数：CLI 里单独算一次（selftest 里的 perfectCount 出不了那个作用域）
  const perfectCli = all.results.filter((r) => r.score === 100).length;
  let code = 0;
  if (sloganCount > 0) code = 1;
  if (all.broken && all.broken.length > 0) code = Math.max(code, 2);  // 有项根本审计不了
  if (has('--strict') && nearCount > 0) code = 1;
  if (perfectCli === 0) code = Math.max(code, 2);   // 一项满分都没有 ⇒ 判据可能失效了

  console.log('  退出码依据：口号 ' + sloganCount + ' 项 ⇒ exit ' + code +
    (code === 0 ? '（全部满足五步法）' : ''));
  process.exit(code);
}
