/**
 * 技能/场景质量验证器 —— 转译自 goutoujunshi 的 validate_skill.py
 *
 * 它验证什么（原项目的一手做法）：
 *   ① frontmatter 的 key 必须恰好是 name + description
 *   ② name 必须是 [a-z0-9-]{1,64}
 *   ③ description ≤1024 字符且不含 <>
 *   ④ 上下文预算：行数 ≤150 · 字符 ≤5000 · token ≤4500
 *   ⑤ 必需文件清单
 *   ⑥ 相对链接必须能通
 *   ⑦ 场景覆盖（哪些问题必须有路由）
 *
 * 它的 token 估算器（零依赖，我直接照搬思路）：
 *   CJK 一字 ≈ 1 token
 *   拉丁词 ≈ 1.3 token
 *   其他符号 ≈ 0.25 token
 *
 * 本工具把这些用到我们的「技能 + 场景」上。
 *
 * 用法：
 *   node 工具\scene-validate.mjs                    验证全部
 *   node 工具\scene-validate.mjs --skill <名>        只验证某技能
 *   node 工具\scene-validate.mjs --json             输出 JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');

const SKILLS = path.join(WB, '技能');
const SCENES = path.join(WB, '外壳', 'scenarios');
const CONTRACTS = path.join(WB, 'sceneboard', 'scenes');

// ---- 预算红线（照 goutoujunshi 的数字，按我们的场景放宽一点）----
const BUDGET = {
  skillLines: 150,        // SKILL.md ≤150 行
  skillChars: 5000,       // ≤5000 字符
  skillTokens: 4500,      // ≤4500 token
  descChars: 1024,        // 场景 description ≤1024
  injectChars: 3000,      // 注入文案 ≤3000（我们的注入层）
};

/** 零依赖 token 估算（保守，混合中文） */
export function approxTokens(content) {
  const cjk = (content.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latinWords = (content.match(/[A-Za-z0-9_]+/g) || []).length;
  const other = (content.match(/[^\sA-Za-z0-9_\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk + Math.ceil(latinWords * 1.3) + Math.ceil(other / 4);
}

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

const problems = [];
const warnings = [];
const stats = [];

function fail(where, msg) { problems.push({ where, msg }); }
function warn(where, msg) { warnings.push({ where, msg }); }

// ---------------- 1. 技能验证 ----------------
function validateSkill(file) {
  const name = path.basename(file, '.md');
  // Windows 上文件常是 CRLF，必须先归一化，否则 frontmatter 正则 ^---\n 匹配不上
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const where = '技能/' + name;

  // frontmatter
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);   // raw 已归一化换行
  if (!fm) {
    fail(where, '缺少 YAML frontmatter');
  } else {
    const keys = fm[1].split('\n').filter(l => /^[A-Za-z0-9_-]+:/.test(l)).map(l => l.split(':')[0]);
    const want = ['name', 'description'];
    if (keys.length !== 2 || !want.every(k => keys.includes(k))) {
      fail(where, `frontmatter 的 key 必须恰好是 name, description；实际 ${JSON.stringify(keys)}`);
    }
    const nameM = fm[1].match(/^name:\s*([^\n]+)$/m);
    const descM = fm[1].match(/^description:\s*(.+)$/m);
    const skillName = nameM ? nameM[1].trim() : '';
    const desc = descM ? descM[1].trim() : '';

    if (!/^[a-z0-9-]{1,64}$/.test(skillName)) {
      fail(where, `name 不合法（须 [a-z0-9-]{1,64}）：${JSON.stringify(skillName)}`);
    }
    if (!desc) fail(where, 'description 为空');
    if (desc.length > BUDGET.descChars) fail(where, `description 超 ${BUDGET.descChars} 字符：${desc.length}`);
    if (desc.includes('<') || desc.includes('>')) fail(where, 'description 含尖括号');
    if (desc.length < 80) warn(where, `description 偏短（${desc.length}），可能触发不准`);
  }

  // 预算
  const lines = raw.split('\n').length;
  const chars = raw.length;
  const tokens = approxTokens(raw);

  if (lines > BUDGET.skillLines) fail(where, `超行数红线 ${BUDGET.skillLines}：${lines}`);
  if (chars > BUDGET.skillChars) fail(where, `超字符红线 ${BUDGET.skillChars}：${chars}`);
  if (tokens > BUDGET.skillTokens) fail(where, `超 token 红线 ${BUDGET.skillTokens}：${tokens}`);

  // 必需小节（我们的技能约定）
  for (const sec of ['核心原则', '安全边界', '输出契约']) {
    if (!raw.includes('## ' + sec)) warn(where, `缺少推荐小节「${sec}」`);
  }

  stats.push({ kind: 'skill', name, lines, chars, tokens, budget: BUDGET.skillTokens });
  return { name, lines, chars, tokens };
}

// ---------------- 2. 场景验证 ----------------
function validateScene(file) {
  const base = path.basename(file, '.json');
  const raw = fs.readFileSync(file, 'utf8').replace(/\uFEFF/g, '');   // 去 BOM
  const where = '场景/' + base;

  let j;
  try { j = JSON.parse(raw); } catch (e) { fail(where, 'JSON 解析失败：' + e.message); return; }

  // 必需字段
  for (const k of ['id', 'name', 'description', 'panels']) {
    if (j[k] === undefined) fail(where, `缺少必需字段 ${k}`);
  }
  if (!Array.isArray(j.panels) || j.panels.length === 0) fail(where, 'panels 为空');

  // description 预算
  const desc = j.description || '';
  if (desc.length > BUDGET.descChars) fail(where, `description 超 ${BUDGET.descChars} 字符：${desc.length}`);

  // 每个面板必需 id + type
  const ids = new Set();
  for (const p of j.panels || []) {
    if (!p.id) fail(where, '有面板缺 id');
    if (!p.type) fail(where, `面板 ${p.id} 缺 type`);
    if (p.id && ids.has(p.id)) fail(where, `面板 id 重复：${p.id}`);
    if (p.id) ids.add(p.id);
    // harness 面板必须有 sessionTitle（否则会话绑不上）
    if (p.type === 'harness' && !p.sessionTitle) {
      warn(where, `面板 ${p.id} 是 harness 但没有 sessionTitle`);
    }
    // embed 面板必须有 url
    if (p.type === 'embed' && !p.url) fail(where, `面板 ${p.id} 是 embed 但没有 url`);
  }

  // 场景契约（可选但推荐）
  const cf = path.join(CONTRACTS, base + '.json');
  if (!fs.existsSync(cf)) {
    warn(where, '没有场景契约（sceneboard/scenes/' + base + '.json）');
  }

  stats.push({ kind: 'scene', name: base, panels: j.panels.length, descChars: desc.length });
  return j;
}

// ---------------- 3. 契约验证 ----------------
function validateContract(file) {
  const base = path.basename(file, '.json');
  const where = '契约/' + base;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(where, 'JSON 解析失败：' + e.message); return; }

  // outputs 的 to 必须指向已注册场景
  const known = fs.existsSync(SCENES)
    ? fs.readdirSync(SCENES).filter(f => f.endsWith('.json') && !f.startsWith('_')).map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(SCENES, f), 'utf8')).id; } catch { return null; }
      }).filter(Boolean)
    : [];
  for (const o of j.outputs || []) {
    for (const t of o.to || []) {
      if (!known.includes(t)) fail(where, `产物 ${o.id} 指向未知场景 ${t}`);
    }
  }
  // inputs 必须能被某个上游产出
  if ((j.inputs || []).length) {
    // 收集全部 outputs
    const allOutputs = new Set();
    if (fs.existsSync(CONTRACTS)) {
      for (const f of fs.readdirSync(CONTRACTS).filter(x => x.endsWith('.json'))) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(CONTRACTS, f), 'utf8'));
          for (const o of c.outputs || []) allOutputs.add(o.id);
        } catch { /* ignore */ }
      }
    }
    for (const i of j.inputs) {
      if (!allOutputs.has(i)) warn(where, `输入 ${i} 没有上游声明产出`);
    }
  }
  // skill 路径必须存在
  if (j.skill) {
    const sp = path.join(WB, j.skill);
    if (!fs.existsSync(sp)) fail(where, '技能文件不存在：' + j.skill);
  }
}

// ---------------- 主流程 ----------------
// 只有直接运行时才执行（被 import 时只导出函数，不跑 CLI）
const __isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch (e) { return false; }
})();

if (__isMain) {
  // ---------------- 主流程 ----------------
  const onlySkill = (() => { const i = process.argv.indexOf('--skill'); return i >= 0 ? process.argv[i + 1] : ''; })();
  const asJson = process.argv.includes('--json');

  if (fs.existsSync(SKILLS)) {
    for (const f of fs.readdirSync(SKILLS).filter(x => x.endsWith('.md') && !x.startsWith('_'))) {
      if (onlySkill && !f.startsWith(onlySkill)) continue;
      validateSkill(path.join(SKILLS, f));
    }
  }
  if (fs.existsSync(SCENES)) {
    for (const f of fs.existsSync(SCENES) ? fs.readdirSync(SCENES).filter(x => x.endsWith('.json') && !x.startsWith('_')) : []) {
      validateScene(path.join(SCENES, f));
    }
  }
  if (fs.existsSync(CONTRACTS)) {
    for (const f of fs.readdirSync(CONTRACTS).filter(x => x.endsWith('.json') && !x.startsWith('_'))) {
      validateContract(path.join(CONTRACTS, f));
    }
  }

  const result = {
    at: new Date().toISOString(),
    budget: BUDGET,
    stats,
    problems,
    warnings,
    ok: problems.length === 0,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 2);
  }

  // 人类可读输出
  console.log(C.bold + '技能 / 场景质量验证' + C.reset);
  console.log(C.dim + '（预算红线照 goutoujunshi：150 行 / 5000 字符 / 4500 token）' + C.reset);
  console.log();

  const skills = stats.filter(s => s.kind === 'skill');
  const scenes = stats.filter(s => s.kind === 'scene');

  if (skills.length) {
    console.log(C.bold + '技能预算' + C.reset);
    console.log('  ' + '名称'.padEnd(26) + '行'.padStart(5) + '字符'.padStart(7) + 'token'.padStart(7) + '   状态');
    for (const s of skills) {
      const over = s.tokens > s.budget;
      console.log('  ' + s.name.padEnd(26) +
        String(s.lines).padStart(5) +
        String(s.chars).padStart(7) +
        String(s.tokens).padStart(7) +
        '   ' + (over ? C.red + '超预算' + C.reset : C.green + '✓' + C.reset));
    }
    console.log();
  }

  if (scenes.length) {
    console.log(C.bold + '场景' + C.reset + '（' + scenes.length + ' 个）');
    for (const s of scenes) {
      console.log('  ' + s.name.padEnd(24) + '面板 ' + String(s.panels).padStart(2) + '  desc ' + String(s.descChars).padStart(3) + ' 字符');
    }
    console.log();
  }

  if (warnings.length) {
    console.log(C.yellow + '警告 ' + warnings.length + ' 项' + C.reset);
    for (const w of warnings) console.log('  ' + C.yellow + '!' + C.reset + ' ' + w.where + '  ' + w.msg);
    console.log();
  }

  if (problems.length) {
    console.log(C.red + '问题 ' + problems.length + ' 项' + C.reset);
    for (const p of problems) console.log('  ' + C.red + 'X' + C.reset + ' ' + p.where + '  ' + p.msg);
    process.exit(2);
  } else {
    console.log(C.green + 'OK 全部通过' + C.reset + '（技能 ' + skills.length + ' · 场景 ' + scenes.length + ' · 警告 ' + warnings.length + '）');
    process.exit(0);
  }

}
