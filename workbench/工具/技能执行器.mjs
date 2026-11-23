#!/usr/bin/env node
/**
 * 技能执行器 —— 让 SKILL.md 变成可执行资产
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要（Voyager 的明确判据）
 * ══════════════════════════════════════════════════════════════
 *
 *  Voyager（arXiv 2305.16291）的技能库判据：
 *    **可执行代码 + 描述嵌入作为检索键**
 *
 *  严格说，只有 SKILL.md 的东西只算提示词，不算技能。
 *  因为它不能被执行、不能被检索、不能验证是否成功。
 *
 *  当前项目 9 个技能全是纯 SKILL.md，0 个含可执行代码。
 *
 * ══════════════════════════════════════════════════════════════
 *  改造方案
 * ══════════════════════════════════════════════════════════════
 *
 *  给每个技能补两样东西：
 *
 *    ① check.mjs    —— 该技能的验收脚本
 *        输入：产物（文件路径或文本）
 *        输出：{ ok, problems[], evidence{} }
 *        这是技能的「可执行」部分
 *
 *    ② skill.json   —— 技能的机器可读元数据（检索键）
 *        id / name / description / triggers[] / inputs / outputs
 *        verify（怎么算成功）/ examples[]
 *
 *  skill.json 的 triggers 就是**检索键**：
 *  中枢可以用它判断「这个任务该用哪个技能」，而不是靠读 4.7KB 的 md。
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么 check.mjs 重要
 * ══════════════════════════════════════════════════════════════
 *
 *  调研反复强调：「没有会失败的检查 = 一句口号」。
 *
 *  技能如果不带 check，就无法判断「这次做得对不对」，
 *  那么「进化」就没有信号 —— 这正是 L2/L3 一直无法启用的原因。
 *
 *  有了 check.mjs：
 *    · 每次任务完成可以机器验收
 *    · 进化有了客观信号（check 通过率）
 *    · 封存集可以复用 check 的判据
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/技能执行器.mjs --list               列出所有技能（含可执行性）
 *  node 工具/技能执行器.mjs --scaffold --apply   为所有技能生成 check.mjs + skill.json
 *  node 工具/技能执行器.mjs --run <技能> <产物>   执行某技能的 check
 *  node 工具/技能执行器.mjs --search "拆竞品"     用检索键搜索技能
 *  node 工具/技能执行器.mjs --selftest           自测
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SKILLS_DIR = path.join(WB, '数据', '.dsh', 'skills');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  从 SKILL.md 提取元数据
// ══════════════════════════════════════════════════════════════
export function parseSkillMd(md) {
  const s = String(md || '').replace(/\r\n/g, '\n');
  const lines = s.split('\n');

  const title = (lines[0] || '').replace(/^#\s*/, '').trim();

  // 提取 blockquote 里的定位
  let positioning = '';
  for (const l of lines) {
    const m = l.match(/^>\s*定位[：:]\s*(.+)/);
    if (m) { positioning = m[1].trim(); break; }
  }

  // 提取「我做」表格里的动作
  const does = [];
  let inDoes = false;
  for (const l of lines) {
    if (/^###\s+我做/.test(l)) { inDoes = true; continue; }
    if (/^###\s+我不做/.test(l)) { inDoes = false; continue; }
    if (inDoes) {
      const m = l.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|/);
      if (m) does.push({ action: m[1].trim(), output: m[2].trim() });
    }
  }

  // 提取「我不做」的条目
  const doesNot = [];
  let inNot = false;
  for (const l of lines) {
    if (/^###\s+我不做/.test(l)) { inNot = true; continue; }
    if (inNot && /^#{2,3}\s/.test(l)) { inNot = false; continue; }
    if (inNot) {
      const m = l.match(/^[-*]\s*(.+)/);
      if (m) doesNot.push(m[1].trim().slice(0, 60));
    }
  }

  // 提取验收标准（如果有）
  const verify = [];
  let inVerify = false;
  for (const l of lines) {
    if (/^##.*验收|^##.*怎么算完成|^###.*验收/.test(l)) { inVerify = true; continue; }
    if (inVerify && /^##\s/.test(l)) { inVerify = false; continue; }
    if (inVerify) {
      const m = l.match(/^[-*]\s*(.+)/);
      if (m) verify.push(m[1].trim().slice(0, 80));
    }
  }

  return { title, positioning, does, doesNot, verify };
}

// ══════════════════════════════════════════════════════════════
//  生成检索键（triggers）
//
//  从 SKILL.md 的「我做」动作 + 场景 dispatch_when 提取关键词。
//  这些词就是中枢判断「该不该用这个技能」的依据。
// ══════════════════════════════════════════════════════════════
/**
 * 生成检索键（triggers）
 *
 * ══════════════════════════════════════════════════════════════
 *  ⚠ 2026-11-10 重写（生成后实测发现大量噪声）
 * ══════════════════════════════════════════════════════════════
 *
 *  第一版从 description 的「2-6 字正则片段」提取，生成结果：
 *    hub:      "超级智能体的", "左侧", "记忆神经元显", "示全部场景地"
 *    research: "左边搜网页", "右边", "帮你收拢成竞", "品清单"
 *
 *  三类问题：
 *    ① 界面描述（左边/右边/左侧/右上角）不是检索键
 *    ② 跨词截断（"帮你收拢成竞" + "品清单" 被拆开）
 *    ③ 虚词（超级智能体的）
 *
 *  修法：
 *    ① 只从结构化字段取词：场景名 / dispatch_when / 我的产出 / 我做
 *    ② 先按标点切短语，再在短语内提取，避免跨词截断
 *    ③ 过滤界面词表 + 虚词表
 */
export function buildTriggers(parsed, sceneId) {
  const words = new Set();

  // 界面/噪声词（肯定不是检索键）
  const NOISE = /左边|右边|左侧|右侧|右上角|左上角|上方|下方|大窗口|小窗口|面板|按钮|点击|显示|颜色|样式|拖拽|滚轮|渲染|亮起|文件树|浏览|助手$/;

  // 虚词/连接词
  const STOP = new Set([
    '这个', '那个', '什么', '怎么', '可以', '需要', '已经', '进行',
    '我们', '你们', '他们', '一个', '一下', '通过', '根据', '按照',
    '然后', '所以', '因为', '如果', '但是', '而且', '或者', '还有',
    '自动', '接收', '提供', '支持', '包括', '主要', '负责',
  ]);

  function addFrom(text) {
    if (!text) return;
    const str = String(text);
    // ① 先按标点切短语（避免跨词截断）
    const chunks = str.split(/[，。、；：/（）()【】「」,;:！？!?]/);
    for (const ch of chunks) {
      const t = ch.trim();
      if (!t) continue;
      // ⚠ 只加整段短语，**不再在短语内部拆词**
      //
      //  第二版还在短语内用 /[\u4e00-\u9fff]{2,6}/g 拆词，
      //  结果仍然产生跨词碎片：
      //    "帮你收拢成竞" + "品清单"   （原文是「帮你收拢成竞品清单」）
      //    "记忆神经元显" + "示全部场景地"
      //
      //  这类碎片对检索毫无价值，还会污染匹配。
      //  所以只保留完整短语。
      if (t.length >= 2 && t.length <= 12 && !NOISE.test(t) && !STOP.has(t)) {
        words.add(t);
      }
    }
  }

  // ① 场景名（最强检索键）
  const sj = readJsonSafe(path.join(SCEN_DIR, sceneId + '.json'));
  if (sj) {
    if (sj.name) words.add(sj.name);
    addFrom(sj.description);
  }

  // ② 定位卡的一句话职责
  const ctx = readTextSafe(path.join(SCEN_DIR, sceneId + '-context.md'));
  if (ctx) {
    const m = ctx.match(/一句话职责[：:]\s*(.+)/);
    if (m) addFrom(m[1]);
  }

  // ③ 「我做」的动作（真正的能力描述）
  for (const d of (parsed.does || [])) {
    addFrom(d.action);
    addFrom(d.output);
  }

  // ④ 场景 id（英文，能直接匹配用户说 id 的情况）
  if (sceneId) words.add(sceneId);

  // 去重 + 过滤 + 限制
  const list = [...words]
    .filter((w) => w && w.length >= 2 && w.length <= 12)
    .filter((w) => !NOISE.test(w))
    .filter((w) => !STOP.has(w));

  return [...new Set(list)].slice(0, 15);
}

/**
 * 手工维护的检索词（人工补充，覆盖自动提取抓不到的同义词）
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么必须有这一层（实测暴露的硬限制）
 * ══════════════════════════════════════════════════════════════
 *
 *  自动提取只能拿到文档里出现过的词。
 *  但真实用户会说文档里没有的说法：
 *
 *    「清磁盘」   vs  文档里的「电脑清理」  → 2-gram 交集 0
 *    「崩溃日志归因」vs 文档里的「故障分析」 → 交集 0
 *    「调研资料」  vs  文档里的「调研」      → 交集只有 1 个
 *
 *  这是 2-gram 的固有局限：字面不同、语义相同的词无法匹配。
 *
 *  所以这一层是必要的：人工列出「用户会怎么说」。
 *  它模拟的是「描述嵌入作为检索键」——只是用人工同义词代替向量，
 *  在这个规模下（9 个技能）比向量更可控、更可解释。
 */
export const MANUAL_TRIGGERS = {
  'pc-cleanup': ['清磁盘', '清理垃圾', '磁盘满', '空间不够', 'C盘满了', '删大文件', '释放空间', '电脑卡'],
  'incident-analysis': ['崩溃日志', '报错栈', '异常分析', '日志归因', '为什么崩了', '查崩溃', 'crash'],
  'research': ['调研资料', '搜集资料', '找资料', '查资料', '搜索信息', '上网找'],
  'competitor-analyze': ['竞品分析', '拆竞品', '功能对比', '竞品拆解'],
  'arch-review': ['出架构方案', '架构设计', '技术方案', '定架构', '架构梳理'],
  'build-plan': ['排期', '实施计划', '里程碑', '分阶段', '制定计划'],
  'reverse-eng': ['逆向分析', '拆解实现', '源码分析', '看别人怎么做的'],
  'self-review': ['自我复盘', '复盘', '总结经验', '回顾'],
  'hub': ['调度', '分派任务', '派单', '统筹'],
};

/**
 * 合并自动提取 + 手工维护
 */
export function mergeTriggers(autoTriggers, sceneId) {
  const manual = MANUAL_TRIGGERS[sceneId] || [];
  return [...new Set([...(autoTriggers || []), ...manual])];
}

// ══════════════════════════════════════════════════════════════
//  生成 check.mjs 模板
//
//  ⚠ 关键设计：check 必须能真的失败。
//    所以模板里明确写「这些是通用检查，请按你的技能补充专有检查」。
//    并且给出一个必然失败的反例自测。
// ══════════════════════════════════════════════════════════════
export function buildCheckScript(sceneId, sceneName, parsed) {
  const doesList = (parsed.does || []).map((d) => '  //   - ' + d.action + ' → ' + d.output).join('\n');
  const doesNotList = (parsed.doesNot || []).map((d) => '  //   - ' + d).join('\n');

  return `#!/usr/bin/env node
/**
 * ${sceneName} · 技能验收脚本
 *
 * ══════════════════════════════════════════════════════════════
 *  这是技能的「可执行」部分（Voyager 判据）
 * ══════════════════════════════════════════════════════════════
 *
 *  Voyager（arXiv 2305.16291）的技能库判据是：
 *    **可执行代码 + 描述嵌入作为检索键**
 *
 *  只有 SKILL.md 的东西只算提示词。加上这个 check.mjs 才算技能。
 *
 * ══════════════════════════════════════════════════════════════
 *  这个技能负责的事（从 SKILL.md 提取）
 * ══════════════════════════════════════════════════════════════
 *
${doesList || '  //   （未提取到）'}
 *
 *  不碰的：
${doesNotList || '  //   （未提取到）'}
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node check.mjs <产物文件路径>
 *  node check.mjs --text "产物文本"
 *  node check.mjs --selftest      自测（含必然失败的反例）
 *
 *  返回：
 *    exit 0 = 通过
 *    exit 1 = 不通过（会打印具体问题）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCENE = '${sceneId}';
const SCENE_NAME = '${sceneName}';

function readText(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\\uFEFF/, ''); } catch { return null; }
}

/**
 * 通用检查（所有技能都适用）
 *
 * 这些检查不依赖具体业务，先保证底线。
 * 具体业务的检查需要按技能补充（见下方 TODO）。
 */
export function check(productText, opts) {
  const o = opts || {};
  const problems = [];
  const passed = [];
  const evidence = {};

  const t = String(productText || '');
  evidence.length = t.length;

  // ── 检查 1：产物非空 ──
  if (t.trim().length < 50) {
    problems.push('产物过短（' + t.trim().length + ' 字符 < 50），可能是空壳');
  } else {
    passed.push('产物非空（' + t.length + ' 字符）');
  }

  // ── 检查 2：不是纯模板残留 ──
  if (/（待补）|（待填）|\\(TODO\\)|TODO:/i.test(t)) {
    problems.push('产物里有未填的占位（待补/待填/TODO）');
  } else {
    passed.push('无占位残留');
  }

  // ── 检查 3：有结构（至少两个标题）──
  const headings = (t.match(/^#{1,4}\\s+\\S/gm) || []).length;
  evidence.headings = headings;
  if (headings < 2) {
    problems.push('产物结构太简单（只有 ' + headings + ' 个标题），应有分节');
  } else {
    passed.push('有 ' + headings + ' 个标题分节');
  }

  // ── 检查 4：不是纯复述任务 ──
  if (/^(用户要求|需要我|根据用户|按照要求)/.test(t.trim())) {
    problems.push('产物像是在复述需求，不像在交付结果');
  } else {
    passed.push('不是复述需求');
  }

  // ── 检查 5：有可验证的证据（路径/数字/引用）──
  const hasPath = /[\\w\\-]+\\/[\\w\\-./]+\\.\\w{2,4}|[A-Z]:\\\\/.test(t);
  const hasNumber = /\\d+[.\\d]*\\s*(%|个|条|次|B|KB|MB|行|秒|ms)?/.test(t);
  const hasQuote = /「[^」]+」|\\[[^\\]]+\\]/.test(t);
  evidence.hasPath = hasPath;
  evidence.hasNumber = hasNumber;
  evidence.hasQuote = hasQuote;
  if (!hasPath && !hasNumber && !hasQuote) {
    problems.push('产物里没有任何可验证的证据（无路径/无数字/无引用）');
  } else {
    passed.push('有可验证证据');
  }

  // ══════════════════════════════════════════════════════════
  //  TODO: 这里是通用底线检查。
  //        请按「\${SCENE_NAME}」的具体职责补充专有检查。
  //
  //  参考该技能应产出什么：
${doesList || '  //   （未提取到）'}
  // ══════════════════════════════════════════════════════════

  return {
    ok: problems.length === 0,
    scene: SCENE,
    sceneName: SCENE_NAME,
    problems,
    passed,
    evidence,
  };
}

// ══════════════════════════════════════════════════════════════
//  自测（关键：必须有必然失败的反例）
// ══════════════════════════════════════════════════════════════
export function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(60));
  console.log('  ' + SCENE_NAME + ' · check 自测');
  console.log('═'.repeat(60));
  console.log();

  // ① 合格产物应该通过
  const good = \`# 架构方案

## 一、总体分层
分为四层：接入层 / 业务层 / 数据层 / 基础层。

## 二、风险清单
- 风险1：并发量大时接入层可能成为瓶颈，实测压测 1200 QPS。
- 风险2：数据层缺少降级，参考 ../docs/risk.md

## 三、结论
推荐方案A，因为改动面最小（3 个文件，约 200 行）。
\`;
  const r1 = check(good);
  chk('合格产物通过', r1.ok === true, r1.problems.join(';') || 'ok');
  chk('合格产物有分节', r1.evidence.headings >= 2, String(r1.evidence.headings));

  // ② 反例：空产物必须失败
  const r2 = check('');
  chk('反例：空产物必须失败', r2.ok === false, r2.problems[0] || '');

  // ③ 反例：过短必须失败
  const r3 = check('完成了');
  chk('反例：过短必须失败', r3.ok === false, r3.problems[0] || '');

  // ④ 反例：占位残留必须失败
  const r4 = check('# 标题\\n\\n## 一\\n内容（待补）\\n\\n## 二\\n还有 TODO: xxx 这里要补');
  chk('反例：占位残留必须失败', r4.ok === false,
      r4.problems.find((p) => p.includes('占位')) || r4.problems[0] || '');

  // ⑤ 反例：无结构必须失败
  const r5 = check('这是一段很长的文字'.repeat(20));
  chk('反例：无结构必须失败', r5.ok === false,
      r5.problems.find((p) => p.includes('结构')) || r5.problems[0] || '');

  // ⑥ 反例：无证据必须失败
  const noEvidence = '# 标题\\n\\n## 一\\n就是很好非常不错\\n\\n## 二\\n确实做得很棒';
  const r6 = check(noEvidence);
  chk('反例：无证据必须失败', r6.ok === false,
      r6.problems.find((p) => p.includes('证据')) || r6.problems[0] || '');

  // ⑦ 关键：这个 check 必须能失败
  const allFail = [r2, r3, r4, r5, r6].filter((r) => !r.ok).length;
  chk('5 个反例全部被判失败', allFail === 5, allFail + ' / 5');

  // ══════════════════════════════════════════════════════════════════
  //  2026-11-14 新增两条「验收不是抄的」断言
  // ══════════════════════════════════════════════════════════════════
  //
  //  背景：实测 research 和 competitor-analyze 的 check.mjs
  //        **只差 6 行** —— 两个职责完全不同的场景，验收文件几乎一样。
  //        这说明专有检查从来没写过（旧文件里还留着未替换的 SCENE_NAME 模板占位符）。
  //
  //  这两条断言把这个病锁定，以后谁再复制粘贴就会被抓出来。

  console.log();
  console.log('  【专有验收不是抄的】');
  {
    const SKILLS = SKILLS_DIR;
    const pa = path.join(SKILLS, 'research', 'check.mjs');
    const pb = path.join(SKILLS, 'competitor-analyze', 'check.mjs');

    if (fs.existsSync(pa) && fs.existsSync(pb)) {
      const A = fs.readFileSync(pa, 'utf8').split(/\r?\n/);
      const B = fs.readFileSync(pb, 'utf8').split(/\r?\n/);

      // ① 行级差异 ≥ 60 行
      //    用简单的 LCS 长度估算：差异 = lenA + lenB - 2*LCS
      const setA = new Set(A.map((x) => x.trim()).filter(Boolean));
      const setB = new Set(B.map((x) => x.trim()).filter(Boolean));
      let shared = 0;
      for (const x of setA) if (setB.has(x)) shared++;
      const diff = setA.size + setB.size - 2 * shared;

      chk('两份专有 check.mjs 差异 ≥ 60 行（防「验收是抄的」）',
        diff >= 60, diff + ' 行差异（旧版只差 6 行）');

      // ② 两份都必须有各自的场景标识（不能都是 '调研' 或空）
      const sceneA = (fs.readFileSync(pa, 'utf8').match(/export const SCENE_NAME = '([^']+)'/) || [])[1] || '';
      const sceneB = (fs.readFileSync(pb, 'utf8').match(/export const SCENE_NAME = '([^']+)'/) || [])[1] || '';
      chk('两个 check.mjs 的 SCENE_NAME 不同',
        !!sceneA && !!sceneB && sceneA !== sceneB, sceneA + ' vs ' + sceneB);

      // ③ 两份都不能还留着未替换的模板变量
      const tplA = /\$\{SCENE_NAME\}|\$\{sceneName\}/.test(fs.readFileSync(pa, 'utf8'));
      const tplB = /\$\{SCENE_NAME\}|\$\{sceneName\}/.test(fs.readFileSync(pb, 'utf8'));
      chk('两份都没有未替换的模板变量', !tplA && !tplB,
        (tplA ? 'research 有 ' : '') + (tplB ? 'competitor 有' : '') || '干净');
    } else {
      chk('两份专有 check.mjs 都存在', false, '找不到文件');
    }

    // ④ parseSkillMd 能取到 does/doesNot（≥3 条、无 "--"）
    for (const name of ['research', 'competitor-analyze']) {
      const jp = path.join(SKILLS, name, 'skill.json');
      if (!fs.existsSync(jp)) { chk(name + ' 的 skill.json 存在', false); continue; }
      let j = null;
      try { j = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch { /* ignore */ }
      const ok = !!j && Array.isArray(j.does) && j.does.length >= 3
        && Array.isArray(j.doesNot) && j.doesNot.length >= 3
        && !j.doesNot.includes('--');
      chk(name + ' 的 does/doesNot ≥3 且无 "--"', ok,
        j ? ('does=' + (j.does || []).length + ' doesNot=' + (j.doesNot || []).length) : '读不到');
    }
  }

  console.log();
  const n = R.filter(Boolean).length;
  console.log('─'.repeat(60));
  console.log('  自测结果: ' + n + ' / ' + R.length);
  console.log('─'.repeat(60));
  return R.every(Boolean);
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }

  let text = '';
  const ri = args.indexOf('--text');
  if (ri >= 0) {
    text = args[ri + 1] || '';
  } else if (args[0] && !args[0].startsWith('--')) {
    text = readText(args[0]) || '';
    if (!text) { console.error('✗ 读不到文件: ' + args[0]); process.exit(2); }
  } else {
    console.log('用法: node check.mjs <产物文件>  或  --text "..."  或  --selftest');
    process.exit(2);
  }

  const r = check(text);
  console.log('═'.repeat(60));
  console.log('  ' + SCENE_NAME + ' · 产物验收');
  console.log('═'.repeat(60));
  console.log();
  if (r.passed.length) {
    console.log('  通过项:');
    for (const p of r.passed) console.log('    ✓ ' + p);
    console.log();
  }
  if (r.problems.length) {
    console.log('  问题:');
    for (const p of r.problems) console.log('    ✗ ' + p);
    console.log();
  }
  console.log('  结论: ' + (r.ok ? '✅ 通过' : '❌ 不通过'));
  process.exit(r.ok ? 0 : 1);
}
`;
}

// ══════════════════════════════════════════════════════════════
//  技能检索（用 triggers）
// ══════════════════════════════════════════════════════════════
/**
 * 技能检索（分词双向匹配）
 *
 * ══════════════════════════════════════════════════════════════
 *  ⚠ 2026-11-10 重写（实测「出架构方案」查不到 arch-review）
 * ══════════════════════════════════════════════════════════════
 *
 *  第一版用「query.includes(trigger)」单向子串匹配：
 *    query = "出架构方案"
 *    trigger = "产出架构方案"
 *    q.includes(t) = false   ← 因为 query 更短，不含 trigger 全串
 *    结果：查不到，尽管语义完全一致。
 *
 *  修法：双向 + 分词
 *    ① query 切成 2-gram
 *    ② trigger 切成 2-gram
 *    ③ 算交集大小 → 命中度
 *    ④ 交集 >= 2 个 2-gram 才算命中
 *
 *  这样：
 *    "出架构方案" vs "产出架构方案"
 *    q-grams:   出架,架构,构方,方案
 *    t-grams:   产出,出架,架构,构方,方案
 *    交集:      出架,架构,构方,方案 = 4个 → 命中
 */
export function searchSkills(query, skills) {
  const q = String(query || '').toLowerCase();

  function grams(str) {
    const out = new Set();
    const t = String(str).toLowerCase();
    // 中文 2-gram
    for (const seg of (t.match(/[\u4e00-\u9fff]+/g) || [])) {
      for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
    }
    // 英文整词
    for (const w of (t.match(/[a-z][a-z0-9_-]{2,}/g) || [])) out.add(w);
    return out;
  }

  const qG = grams(q);
  const scored = [];

  for (const s of skills) {
    let score = 0;
    const hits = [];

    // ① 场景名精确命中（最強）
    const name = String(s.meta.name || '');
    if (name && q.includes(name.toLowerCase())) { score += 10; hits.push(name); }

    // ② triggers 分词交集
    for (const t of (s.meta.triggers || [])) {
      const tg = grams(t);
      let inter = 0;
      for (const g of qG) if (tg.has(g)) inter++;
      // 短查询（<=3 字）只能切出 1 个 2-gram，阈值放宽到 1
      const needInter = q.length <= 3 ? 1 : 2;
      if (inter >= needInter) {
        score += inter;
        hits.push(String(t));
      }
    }

    // ③ 场景 id 命中
    if (q.includes(String(s.id).toLowerCase())) { score += 8; hits.push(s.id); }

    // ④ 描述分词交集（弱信号）
    const dg = grams(s.meta.description || '');
    let dInter = 0;
    for (const g of qG) if (dg.has(g)) dInter++;
    if (dInter >= 3) { score += Math.floor(dInter / 2); }

    if (score > 0) scored.push({ ...s, score, hits: [...new Set(hits)].slice(0, 5) });
  }

  return scored.sort((a, b) => b.score - a.score);
}

// ══════════════════════════════════════════════════════════════
//  读所有技能
// ══════════════════════════════════════════════════════════════
export function loadSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out = [];

  for (const d of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, d.name);
    const md = readTextSafe(path.join(dir, 'SKILL.md'));
    const meta = readJsonSafe(path.join(dir, 'skill.json'));
    const hasCheck = fs.existsSync(path.join(dir, 'check.mjs'));
    const parsed = md ? parseSkillMd(md) : null;

    out.push({
      id: d.name,
      dir,
      hasMd: !!md,
      hasMeta: !!meta,
      hasCheck,
      parsed,
      meta: meta || {
        id: d.name,
        name: parsed?.title || d.name,
        description: parsed?.positioning || '',
        triggers: [],
      },
      // ⚠ 2026-11-12 修（破坏性验证抓出来的装饰）：
      //
      //   原来：executable: hasCheck
      //   ——只要求有 check.mjs，完全不看 SKILL.md 在不在。
      //
      //   实测：删掉 research/SKILL.md 后，输出
      //     ✓ research   -- JSON CHECK     ← MD 列确实变成 --
      //     可执行: 9 / 9                   ← 但仍算「可执行」
      //     exit: 0                        ← 且不设失败
      //
      //   也就是说「技能文档都没了」它也不报错 = 装饰。
      //
      //   正确判据：可执行 = 有 SKILL.md（会做这件事）+ 有 check.mjs（能验）
      //     · 没有 SKILL.md → 场景 AI 看不到「怎么干这个活」→ 不可执行
      //     · 没有 check.mjs → 做完没法验 → 也不算完整可执行
      executable: hasCheck && !!md,
    });
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
  console.log('  技能执行器 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 解析 SKILL.md
  const md = [
    '# 架构梳理 · 技能',
    '',
    '> 场景 id：`arch-review`',
    '> 定位：把多路输入合成一套可执行的架构方案',
    '',
    '---',
    '',
    '## 一、我的职责边界',
    '',
    '### 我做',
    '',
    '| 动作 | 产出 |',
    '|---|---|',
    '| **汇总多路输入** | 把调研/竞品/逆向的结论合并 |',
    '| **判断取舍** | 在多个方案中选一个 |',
    '',
    '### 我不做',
    '',
    '- 不搜集资料',
    '- 不写代码',
  ].join('\n');

  const parsed = parseSkillMd(md);
  chk('解析出标题', parsed.title.includes('架构梳理'), parsed.title);
  chk('解析出定位', parsed.positioning.includes('架构方案'), parsed.positioning.slice(0, 20));
  chk('解析出「我做」', parsed.does.length === 2, parsed.does.length + ' 条');
  chk('解析出「我不做」', parsed.doesNot.length >= 1, parsed.doesNot.length + ' 条');

  // ② 生成 triggers
  const triggers = buildTriggers(parsed, 'arch-review');
  chk('生成检索键', triggers.length > 0, triggers.length + ' 个');
  
  // 合并手工维护后必须包含同义词
  const merged = mergeTriggers(triggers, 'pc-cleanup');
  chk('合并手工检索词', merged.length > triggers.length, triggers.length + ' → ' + merged.length);
  chk('含同义词「清磁盘」', merged.includes('清磁盘'), '');
  chk('检索键含关键词', triggers.some((t) => /架构|汇总|取舍/.test(t)), triggers.slice(0, 5).join(','));

  // ③ 生成的 check 脚本语法必须正确
  const script = buildCheckScript('arch-review', '架构梳理', parsed);
  chk('check 脚本非空', script.length > 1000, script.length + ' 字符');
  chk('check 含 selftest', script.includes('export function selftest'), '');
  chk('check 含反例', script.includes('反例：空产物必须失败'), '');
  chk('check 含"必须能失败"的自检', script.includes('这个 check 必须能失败'), '');

  // ④ 反例：生成的脚本里如果漏了反例，说明模板退化了
  chk('反例：模板必须包含失败断言', !script.includes('// 反例') === false || script.includes('反例'), '');

  // ══════════════════════════════════════════════════════════════════
  //  ⑤ 专有验收不是抄的（2026-11-14 新增）
  // ══════════════════════════════════════════════════════════════════
  //
  //  实测背景：research 与 competitor-analyze 的 check.mjs **只差 6 行**。
  //  两个职责完全不同的场景，验收文件几乎逐字相同 —— 说明专有检查从没写过。
  //  （旧文件里还留着未替换的 SCENE_NAME 模板占位符和「请补充专有检查」的注释）
  //
  //  这几条断言把这个病锁定，以后谁再复制粘贴就会被抓出来。
  console.log();
  console.log('  【专有验收不是抄的】');
  {
    const pa = path.join(SKILLS_DIR, 'research', 'check.mjs');
    const pb = path.join(SKILLS_DIR, 'competitor-analyze', 'check.mjs');

    if (fs.existsSync(pa) && fs.existsSync(pb)) {
      const sa = fs.readFileSync(pa, 'utf8');
      const sb = fs.readFileSync(pb, 'utf8');
      const setA = new Set(sa.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
      const setB = new Set(sb.split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
      let shared = 0;
      for (const x of setA) if (setB.has(x)) shared++;
      const diff = setA.size + setB.size - 2 * shared;

      chk('两份专有 check.mjs 差异 ≥ 60 行', diff >= 60,
        diff + ' 行差异（旧版只差 6 行）');

      const sceneA = (sa.match(/export const SCENE_NAME = '([^']+)'/) || [])[1] || '';
      const sceneB = (sb.match(/export const SCENE_NAME = '([^']+)'/) || [])[1] || '';
      chk('两份的 SCENE_NAME 不同', !!sceneA && !!sceneB && sceneA !== sceneB,
        sceneA + ' vs ' + sceneB);

      const tplRe = /\$\{SCENE_NAME\}|\$\{sceneName\}/;
      chk('两份都没有未替换的模板占位符',
        !tplRe.test(sa) && !tplRe.test(sb),
        (tplRe.test(sa) ? 'research 有 ' : '') + (tplRe.test(sb) ? 'competitor 有' : '') || '干净');

      // 各自的专有判据必须存在（外部性 / 不拿）
      chk('research 有外部性判据（R2）', /judgeExternality|R2 外部性/.test(sa), '');
      chk('competitor 有不拿判据（C3）', /C3|不拿/.test(sb), '');
    } else {
      chk('两份专有 check.mjs 都存在', false, '找不到文件');
    }

    // skill.json 的 does/doesNot 必须真的能取到
    for (const name of ['research', 'competitor-analyze']) {
      const jp = path.join(SKILLS_DIR, name, 'skill.json');
      let j = null;
      try { j = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch { /* ignore */ }
      const ok = !!j && Array.isArray(j.does) && j.does.length >= 3
        && Array.isArray(j.doesNot) && j.doesNot.length >= 3
        && !j.doesNot.includes('--');
      chk(name + ' 的 does/doesNot ≥3 且无 "--"', ok,
        j ? ('does=' + (j.does || []).length + ' doesNot=' + (j.doesNot || []).length) : '读不到');
    }
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

  const skills = loadSkills();

  // ── 列出 ──
  if (has('--list') || (!has('--scaffold') && !has('--search') && !has('--run'))) {
    console.log('═'.repeat(72));
    console.log('  技能清单（可执行性检查）');
    console.log('═'.repeat(72));
    console.log();

    let exec = 0;
    for (const s of skills) {
      const marks = [
        s.hasMd ? 'MD' : '--',
        s.hasMeta ? 'JSON' : '----',
        s.hasCheck ? 'CHECK' : '-----',
      ].join(' ');
      if (s.executable) exec++;
      console.log('  ' + (s.executable ? '✓' : '✗') + ' ' + s.id.padEnd(22) + marks +
        '  ' + (s.parsed?.positioning || '').slice(0, 30));
    }

    console.log();
    console.log('─'.repeat(72));
    // ⚠ 2026-11-12 修（破坏性验证抓出来的第二个装饰）：
    //   原来不管有几个不可执行都 process.exit(0)，
    //   所以「可执行: 7 / 9」也报成功 → 机制体检判 PASS。
    //   现在：有不可执行就 exit 1。
    if (exec < skills.length) {
      console.log('  ' + (skills.length - exec) + ' 个技能不可执行（缺 SKILL.md 或 check.mjs）');
      console.log('  跑 --scaffold --apply 生成 check.mjs + skill.json');
      console.log('─'.repeat(72));
      process.exit(1);
    }
    console.log('─'.repeat(72));
    process.exit(0);
  }

  // ── 脚手架 ──
  if (has('--scaffold')) {
    console.log('═'.repeat(72));
    console.log('  为技能生成 check.mjs + skill.json');
    console.log('═'.repeat(72));
    console.log();

    let made = 0;
    for (const s of skills) {
      if (!s.hasMd) { console.log('  ✗ ' + s.id + ': 没有 SKILL.md'); continue; }

      const autoTriggers = buildTriggers(s.parsed, s.id);
      const triggers = mergeTriggers(autoTriggers, s.id);
      const meta = {
        _note: '技能元数据 —— triggers 是检索键（中枢判断该不该用这个技能的依据）',
        id: s.id,
        name: s.parsed?.title || s.id,
        description: s.parsed?.positioning || '',
        triggers,
        does: (s.parsed?.does || []).map((d) => d.action),
        doesNot: s.parsed?.doesNot || [],
        verify: s.parsed?.verify || [],
        executable: true,
        checkPath: 'check.mjs',
      };

      const checkScript = buildCheckScript(s.id, s.parsed?.title || s.id, s.parsed);

      console.log('  ' + s.id.padEnd(22) + 'triggers ' + String(triggers.length).padStart(2) +
        ' 个  check ' + checkScript.length + ' 字符');

      if (has('--apply')) {
        fs.writeFileSync(path.join(s.dir, 'skill.json'), JSON.stringify(meta, null, 2), 'utf8');
        fs.writeFileSync(path.join(s.dir, 'check.mjs'), checkScript, 'utf8');
        made++;
      }
    }

    console.log();
    if (has('--apply')) {
      console.log('  ✓ 已生成 ' + made + ' 个技能的 check.mjs + skill.json');
      console.log();
      console.log('  下一步：跑每个 check 的 --selftest 确认它真的会失败');
    } else {
      console.log('  （预览。加 --apply 真写）');
    }
    process.exit(0);
  }

  // ── 搜索 ──
  if (has('--search')) {
    const q = val('--search');
    const hits = searchSkills(q, skills);
    console.log('═'.repeat(72));
    console.log('  技能检索: ' + q);
    console.log('═'.repeat(72));
    console.log();
    if (hits.length === 0) {
      console.log('  没有匹配的技能');
      process.exit(1);
    }
    for (const h of hits) {
      console.log('  ' + h.score.toString().padStart(2) + ' 分  ' + h.id.padEnd(22) + h.meta.name);
      console.log('         命中: ' + h.hits.join(', '));
      console.log('         定位: ' + String(h.meta.description || '').slice(0, 60));
      console.log();
    }
    process.exit(0);
  }

  // ── 运行某技能的 check ──
  if (has('--run')) {
    const id = val('--run');
    const product = val('--product');
    const s = skills.find((x) => x.id === id);
    if (!s) { console.error('✗ 找不到技能: ' + id); process.exit(2); }
    if (!s.hasCheck) { console.error('✗ ' + id + ' 还没有 check.mjs'); process.exit(2); }

    const mod = await import(pathToFileURL(path.join(s.dir, 'check.mjs')).href);
    const text = product ? (readTextSafe(product) || '') : '';
    const r = mod.check(text);
    console.log('═'.repeat(72));
    console.log('  ' + id + ' · 验收');
    console.log('═'.repeat(72));
    console.log();
    console.log('  结论: ' + (r.ok ? '✅ 通过' : '❌ 不通过'));
    if (r.problems.length) {
      console.log('  问题:');
      for (const p of r.problems) console.log('    ✗ ' + p);
    }
    process.exit(r.ok ? 0 : 1);
  }
}
