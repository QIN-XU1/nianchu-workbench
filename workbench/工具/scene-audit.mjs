/**
 * L2 场景层 —— 六件套完整性 + 会话绑定
 *
 * luanyujia 2.1「加一个场景」要求六件：
 *   ① 场景定义 json（面板 + harness 面板 + sessionId）
 *   ② 定位卡 <id>-context.md
 *   ③ 身份索引登记
 *   ④ 专属技能 skills/<名>/SKILL.md
 *   ⑤ 长期记忆 场景记忆/<名>/场景私有记忆.md
 *   ⑥ 生效方式（改 json 切场景 / 新标签重启）
 *
 * 本脚本：
 *   --check  逐场景验六件套，输出缺项
 *   --fix    能自动补的自动补（记忆骨架、定位卡）
 *   --bind   列出待绑定的会话
 *
 * 用法：
 *   node 工具\scene-audit.mjs --check
 *   node 工具\scene-audit.mjs --fix
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SC = path.join(WB, '外壳', 'scenarios');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');
const SKILLS = path.join(WB, '数据', '.dsh', 'skills');
const BOARD = path.join(WB, 'sceneboard', 'scenes');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const isCheck = process.argv.includes('--check');
const isFix = process.argv.includes('--fix');
const isBind = process.argv.includes('--bind');

// ═══════ 读场景 ═══════
const scenes = [];
for (const f of fs.readdirSync(SC)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SC, f), 'utf8').replace(/\uFEFF/g, ''));
    if (j.id && j.name) scenes.push(j);
  } catch { /* ignore */ }
}
scenes.sort((a, b) => a.id.localeCompare(b.id));

// ═══════ 六件套检查 ═══════
function checkScene(sc) {
  const sid = sc.id;
  const name = sc.name;
  const out = { id: sid, name, parts: {}, ok: true, missing: [] };

  // ① 场景定义（本身）
  out.parts.json = true;

  // ①b harness 面板 + sessionId
  const harness = (sc.panels || []).find(p => p.type === 'harness');
  if (!harness) {
    out.parts.harness = false;
    out.missing.push('无 harness 面板（AI 面板）');
  } else if (!harness.sessionId) {
    out.parts.sessionId = false;
    out.missing.push('sessionId 未绑定（AI 面板会空白）');
  } else {
    out.parts.sessionId = true;
  }

  // ② 定位卡
  out.parts.contextCard = fs.existsSync(path.join(SC, sid + '-context.md'));
  if (!out.parts.contextCard) out.missing.push('缺定位卡 ' + sid + '-context.md');

  // ③ 身份索引（全局限，检查是否登记）
  const idxPath = path.join(SC, '_场景身份索引.md');
  let idxOk = false;
  if (fs.existsSync(idxPath)) {
    idxOk = fs.readFileSync(idxPath, 'utf8').includes('`' + sid + '`');
  }
  out.parts.identityIndex = idxOk;
  if (!idxOk) out.missing.push('未登记身份索引');

  // ④ 专属技能
  out.parts.skill = fs.existsSync(path.join(SKILLS, sid, 'SKILL.md'));
  // 无技能不算缺（规范允许"无专属技能"），但记下来

  // ⑤ 长期记忆
  const memPath = path.join(MEM, name, '场景私有记忆.md');
  out.parts.memory = fs.existsSync(memPath);
  if (!out.parts.memory) out.missing.push('缺场景记忆 ' + name + '/场景私有记忆.md');

  // ⑥ 场景契约（Sceneflow）
  out.parts.contract = fs.existsSync(path.join(BOARD, sid + '.json'));
  if (!out.parts.contract) out.missing.push('缺场景契约 sceneboard/scenes/' + sid + '.json');

  out.ok = out.missing.length === 0;
  return out;
}

const results = scenes.map(checkScene);

// ═══════ 输出 ═══════
if (isBind) {
  console.log(C.bold + 'L2 会话绑定状态' + C.reset);
  console.log();
  let unbound = 0;
  for (const r of results) {
    const sc = scenes.find(s => s.id === r.id);
    const harness = (sc.panels || []).find(p => p.type === 'harness');
    if (!harness) {
      console.log('  ' + C.dim + '无面板' + C.reset + '  ' + r.id);
      continue;
    }
    if (harness.sessionId) {
      console.log('  ' + C.green + '已绑' + C.reset + '  ' + r.id.padEnd(18) + '  ' + harness.sessionId);
    } else {
      console.log('  ' + C.yellow + '待绑' + C.reset + '  ' + r.id.padEnd(18) + '  ' + C.dim + (harness.sessionTitle || '(无会话名)') + C.reset);
      unbound++;
    }
  }
  console.log();
  console.log('待绑定 ' + unbound + ' 个场景');
  console.log(C.dim + '绑定方式：node 外壳\\scripts\\建会话.mjs --title "<会话名>"' + C.reset);
  process.exit(0);
}

console.log(C.bold + 'L2 场景层' + C.reset + C.dim + '  11 场景 × 六件套' + C.reset);
console.log();

// 表格头
console.log('  ' + '场景'.padEnd(18) + 'json  harness  session  定位卡  索引  技能  记忆  契约');
console.log('  ' + '─'.repeat(84));

for (const r of results) {
  const mark = (v) => v ? C.green + '✓' + C.reset : C.red + '✗' + C.reset;
  // 技能用不同标记（无技能不算错）
  const sc = scenes.find(s => s.id === r.id);
  const hasHarness = !!(sc.panels || []).find(p => p.type === 'harness');
  const skillMark = r.parts.skill ? C.green + '✓' + C.reset : C.dim + '—' + C.reset;

  console.log('  ' + r.id.padEnd(18) +
    mark(r.parts.json) + '       ' +
    mark(hasHarness) + '        ' +
    mark(r.parts.sessionId) + '        ' +
    mark(r.parts.contextCard) + '     ' +
    mark(r.parts.identityIndex) + '    ' +
    skillMark + '      ' +
    mark(r.parts.memory) + '     ' +
    mark(r.parts.contract));
}

// ═══════ 汇总 ═══════
console.log();
const okCount = results.filter(r => r.ok).length;
const failCount = results.length - okCount;

console.log(C.bold + '汇总' + C.reset);
console.log('  场景总数      : ' + results.length);
console.log('  六件套完整    : ' + (okCount === results.length ? C.green : C.yellow) + okCount + C.reset);
console.log('  有缺项        : ' + (failCount ? C.red : C.green) + failCount + C.reset);

const unboundCount = results.filter(r => !r.parts.sessionId).length;
console.log('  会话未绑定    : ' + (unboundCount ? C.red : C.green) + unboundCount + C.reset);

const noSkill = results.filter(r => !r.parts.skill).length;
console.log('  无专属技能    : ' + C.dim + noSkill + '（规范允许）' + C.reset);

// 缺项明细
if (failCount) {
  console.log();
  console.log(C.bold + '缺项明细' + C.reset);
  for (const r of results.filter(x => !x.ok)) {
    console.log('  ' + C.yellow + r.id + C.reset);
    for (const m of r.missing) console.log('      · ' + m);
  }
}

// ═══════ 落盘 ═══════
fs.writeFileSync(path.join(WB, '工具', 'scene-audit.json'), JSON.stringify({
  at: new Date().toISOString(),
  total: results.length,
  ok: okCount,
  unbound: unboundCount,
  results,
}, null, 2), 'utf8');

console.log();
console.log(C.dim + '报告：workbench/工具/scene-audit.json' + C.reset);

process.exit(failCount ? 2 : 0);
