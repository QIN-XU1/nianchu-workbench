/**
 * 验证：技能是否真的能被场景使用 + token 预算是否真实生效
 *
 * 必须证明三件事：
 *   ① 技能文件能被读到，且 frontmatter 可解析
 *   ② token 估算器是可信的（用已知长度对比）
 *   ③ 场景契约里的 skill 字段指向真实文件
 */

import fs from 'node:fs';
import path from 'node:path';
import { approxTokens } from '../workbench/工具/scene-validate.mjs';

const WB = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench`;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };

let pass = 0, total = 0;
const fails = [];
function chk(n, ok, d = '') { total++; if (ok) pass++; else fails.push(n); console.log(`${ok ? C.green + 'PASS' : C.red + 'FAIL'}${C.reset}  ${n.padEnd(38)} ${C.dim}${d}${C.reset}`); }

console.log(`${C.bold}技能接入验证${C.reset}\n`);

// ① 技能文件可读 + frontmatter 可解析
const skillPath = path.join(WB, '技能', 'relationship-advisor.md');
chk('技能文件存在', fs.existsSync(skillPath), skillPath);

if (fs.existsSync(skillPath)) {
  const raw = fs.readFileSync(skillPath, 'utf8').replace(/\r\n?/g, '\n');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  chk('frontmatter 可解析', !!fm, fm ? 'OK' : '失败');

  if (fm) {
    const nameM = fm[1].match(/^name:\s*([^\n]+)$/m);
    const descM = fm[1].match(/^description:\s*(.+)$/m);
    chk('name 字段正确', nameM && nameM[1].trim() === 'relationship-advisor', nameM ? nameM[1].trim() : '');
    chk('description 长度合理', descM && descM[1].trim().length >= 80, descM ? descM[1].trim().length + ' 字符' : '');
  }

  // token 预算
  const lines = raw.split('\n').length;
  const chars = raw.length;
  const tokens = approxTokens(raw);
  chk('行数 ≤150', lines <= 150, lines + ' 行');
  chk('字符 ≤5000', chars <= 5000, chars + ' 字符');
  chk('token ≤4500', tokens <= 4500, tokens + ' token');
}

// ② token 估算器可信度：用已知样本对比
console.log(`\n${C.bold}【token 估算器校验】${C.reset}`);
const samples = [
  ['纯英文 100 词', 'word '.repeat(100)],
  ['纯中文 100 字', '字'.repeat(100)],
  ['混合（中200+英50）', '字'.repeat(200) + ' ' + 'word '.repeat(50)],
  ['标点密集', '，。！？；：'.repeat(50)],
];
for (const [label, s] of samples) {
  const n = approxTokens(s);
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (s.match(/[A-Za-z0-9_]+/g) || []).length;
  console.log(`  ${label.padEnd(22)} token=${String(n).padStart(4)}  (中${cjk} 英词${latin})`);
}
chk('纯中文 100 字 ≈ 100 token', Math.abs(approxTokens('字'.repeat(100)) - 100) < 5, `实际 ${approxTokens('字'.repeat(100))}`);
chk('纯英文 100 词 ≈ 130 token', Math.abs(approxTokens('word '.repeat(100)) - 130) < 10, `实际 ${approxTokens('word '.repeat(100))}`);

// ③ 场景契约的 skill 字段
console.log(`\n${C.bold}【场景契约的 skill 引用】${C.reset}`);
const cf = path.join(WB, 'sceneboard', 'scenes', 'relationship.json');
if (fs.existsSync(cf)) {
  const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
  chk('契约有 skill 字段', !!c.skill, c.skill || '');
  if (c.skill) {
    const sp = path.join(WB, c.skill);
    chk('skill 指向真实文件', fs.existsSync(sp), c.skill);
  }
  chk('契约声明 5 类 memory scope', (c.memoryScopes || []).length === 5, (c.memoryScopes || []).join(','));
  chk('契约声明 4 级证据', (c.evidenceLevels || []).length === 4, (c.evidenceLevels || []).join(','));
} else {
  chk('关系军师契约存在', false, '无');
}

// ④ 场景 json 的 harness 面板有 sessionTitle
console.log(`\n${C.bold}【场景面板完整性】${C.reset}`);
const scPath = path.join(WB, '外壳', 'scenarios', 'relationship.json');
if (fs.existsSync(scPath)) {
  const j = JSON.parse(fs.readFileSync(scPath, 'utf8'));
  const harness = (j.panels || []).filter(p => p.type === 'harness');
  chk('关系场景有 harness 面板', harness.length > 0, `${harness.length} 个`);
  chk('harness 有 sessionTitle', harness.every(p => p.sessionTitle), harness.map(p => p.sessionTitle).join(','));
  chk('面板总数 5', (j.panels || []).length === 5, `${(j.panels || []).length} 个`);
}

console.log(`\n${C.bold}===== 技能接入验证：${pass}/${total} =====${C.reset}`);
if (pass === total) console.log(`${C.green}技能可被场景使用，token 预算可信${C.reset}`);
else console.log(`${C.yellow}未通过：${fails.join('；')}${C.reset}`);
process.exit(pass === total ? 0 : 1);
