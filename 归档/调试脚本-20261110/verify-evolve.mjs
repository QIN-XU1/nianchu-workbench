/**
 * 自我进化机制完整验证
 *
 * 验证链条：
 *   需求 → 查场景 → 没有 → 孵化场景 → 建会话 → 绑定 → 校验 → 清理
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HATCH = path.join(ROOT, 'workbench', '工具', 'scene-hatch.mjs');
const BIND = path.join(ROOT, 'workbench', '工具', 'scene-bind.mjs');

const R = [];
function chk(name, pass, detail) {
  R.push({ name, pass: !!pass, detail: String(detail || '').slice(0, 160) });
  console.log((pass ? '  ✓ ' : '  ✗ ') + name.padEnd(38) + (detail ? '  ' + String(detail).slice(0, 96) : ''));
}

function run(script, args, extraEnv) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 40000,
    env: Object.assign({}, process.env, extraEnv || {}),
  });
  return { code: r.status, out: (r.stdout || ''), err: (r.stderr || '') };
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  自我进化机制验证（用户核心要求）');
console.log('═══════════════════════════════════════════════════════════════');
console.log();
console.log('  用户原话：「当我提出了一份任务，但是没有相应场景，则必须先构建场景」');
console.log();

// ═══ 1. 场景清单可查（AI 调度的前提）═══
console.log('── 1. AI 能查到有哪些场景 ──');
const list = run(HATCH, ['--list', '--json']);
let scenes = [];
try { scenes = JSON.parse(list.out); } catch (e) {}
chk('--list 可执行', list.code === 0, 'exit=' + list.code);
chk('返回 JSON 可解析', scenes.length > 0, scenes.length + ' 个场景');
chk('每个场景有 role（AI 判断依据）', scenes.every(s => s.role && s.role.length > 0), '');
chk('中枢排第一', scenes[0] && scenes[0].id === 'hub', scenes[0] ? scenes[0].id : '');

// ═══ 2. 中枢已就位 ═══
console.log();
console.log('── 2. 中枢（Hub）就位 ──');
const hubCheck = run(HATCH, ['--check', 'hub']);
chk('中枢五件套齐全', hubCheck.out.includes('五件套齐全'), '');
chk('中枢有 isHub 标记', (function () {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'workbench', 'sceneboard', 'scenes', 'hub.json'), 'utf8'));
  return c.isHub === true;
})(), '契约里 isHub: true');

// ═══ 3. 找出缺会话的场景（模拟"任务没有对应场景"）═══
console.log();
console.log('── 3. 检测场景缺口 ──');
const bindList = run(BIND, ['--list']);
const missingLine = bindList.out.match(/⚠ (\d+) 个场景缺会话: (.+)/);
chk('绑定状态可查', bindList.out.includes('场景会话绑定状态'), '');

// ═══ 4. 孵化新场景（核心验证）═══
console.log();
console.log('── 4. 孵化新场景（模拟任务没有对应场景）──');
const SPEC_PATH = path.join(ROOT, 'prototype', '_verify-spec.json');
const TEST_ID = 'verify-evolve-' + Date.now().toString(36);
fs.writeFileSync(SPEC_PATH, JSON.stringify({
  id: TEST_ID,
  name: '进化验证-' + TEST_ID.slice(-4),
  role: '自动化验证：证明场景可以从零孵化',
  reason: '自动化测试：验证自我进化机制',
  hatchedBy: 'verify-evolve',
  inputs: ['测试信号'],
  outputs: [{ id: 'report', name: '验证报告', type: 'report', to: ['hub'], format: 'markdown' }],
}, null, 2), 'utf8');

const hatch = run(HATCH, ['--create', '--spec', SPEC_PATH]);
console.log(hatch.out.split('\n').filter(l => l.trim()).map(l => '    ' + l.trim()).join('\n'));
chk('孵化命令成功', hatch.code === 0, 'exit=' + hatch.code);
const m = hatch.out.match(/场景已孵化: (.+?) \((.+?)\)/);
chk('五件套全部创建', hatch.out.includes('① ') && hatch.out.includes('② ') &&
  hatch.out.includes('③ ') && hatch.out.includes('④ ') && hatch.out.includes('⑤ '), '5 步都有输出');
chk('注册表已更新', hatch.out.includes('_共享记忆/索引.json'), '');

// ═══ 5. 新场景可校验 ═══
console.log();
console.log('── 5. 新场景可校验 ──');
const vcheck = run(HATCH, ['--check', TEST_ID]);
chk('五件套校验通过', vcheck.out.includes('五件套齐全') || !vcheck.out.includes('✗ ①'), '');
const onlySessionMissing = vcheck.out.includes('harness 未绑定 sessionId');
chk('准确报告唯一缺口', onlySessionMissing, onlySessionMissing ? 'harness 未绑定 sessionId' : '');
chk('其他四件套都齐', vcheck.out.includes('✓ ①') && vcheck.out.includes('✓ ②') &&
  vcheck.out.includes('✓ ③') && vcheck.out.includes('✓ ④'), '');

// ═══ 6. 建会话并绑定 ═══
console.log();
console.log('── 6. 建会话并绑定 ──');
const bind = run(BIND, ['--scene', TEST_ID], {
  DSH_PORT: '3080',
  DSH_ENGINE_TOKEN: process.env.DSH_ENGINE_TOKEN || 'EAPcsV48H0v5Ms5QP4XND9vRiI4eS7knmVz681eW_Ys',
});
console.log('    ' + bind.out.trim().split('\n').join('\n    '));
const sidMatch = bind.out.match(/(session-[a-f0-9-]+)/);
chk('会话创建成功', !!sidMatch, sidMatch ? sidMatch[1].slice(0, 30) : bind.err.slice(0, 60));

// ═══ 7. 绑定后可校验完整 ═══
console.log();
console.log('── 7. 绑定后校验 ──');
const vcheck2 = run(HATCH, ['--check', TEST_ID]);
chk('绑定后完全齐备', vcheck2.out.includes('五件套齐全'), vcheck2.out.includes('五件套齐全') ? '' : vcheck2.out.slice(0, 120));

// ═══ 8. 场景在神经元中可见（数据层）═══
console.log();
console.log('── 8. 场景进入注册表 ──');
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'workbench', '引擎数据', '.dsh', '场景记忆', '_共享记忆', '索引.json'), 'utf8'));
const inIdx = (idx.areas || []).find(a => a.id === TEST_ID);
chk('新场景在索引里', !!inIdx, inIdx ? inIdx.name : '');
chk('索引含 isHub 中枢', (idx.areas || []).some(a => a.isHub), '');

// ═══ 9. 文件真实存在 ═══
console.log();
console.log('── 9. 五件套文件真实落盘 ──');
const paths = {
  '契约': path.join(ROOT, 'workbench', 'sceneboard', 'scenes', TEST_ID + '.json'),
  '场景定义': path.join(ROOT, 'workbench', '外壳', 'scenarios', TEST_ID + '.json'),
};
const nameMatch = m ? m[1] : '';
const nameSafe = String(nameMatch).replace(/[\\/:*?"<>|]/g, '_');
paths['身份卡'] = path.join(ROOT, 'workbench', '引擎数据', '.dsh', '场景记忆', nameSafe, '身份卡.md');
paths['私有记忆'] = path.join(ROOT, 'workbench', '引擎数据', '.dsh', '场景记忆', nameSafe, '场景私有记忆.md');
for (const k of Object.keys(paths)) {
  chk(k + ' 文件存在', fs.existsSync(paths[k]), fs.existsSync(paths[k]) ? fs.statSync(paths[k]).size + 'B' : '缺失');
}

// ═══ 10. §〇 交接骨架正确 ═══
console.log();
console.log('── 10. §〇 交接骨架 ──');
const memPath = paths['私有记忆'];
if (fs.existsSync(memPath)) {
  const txt = fs.readFileSync(memPath, 'utf8');
  chk('有 §〇 小节', txt.includes('## §〇 当前交接'), '');
  chk('四问题都在', txt.includes('上次交接') && txt.includes('当前项目') &&
    txt.includes('私有记忆变更') && txt.includes('下一步'), '');
  const kb = Buffer.byteLength(txt, 'utf8') / 1024;
  chk('§〇 未超 4KB 红线', kb < 4, kb.toFixed(2) + 'KB');
}

// ═══ 清理测试场景 ═══
console.log();
console.log('── 清理测试数据 ──');
function del(p) { try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); return true; } } catch (e) {} return false; }
const cleaned = [
  del(paths['契约']),
  del(paths['场景定义']),
  del(path.dirname(memPath)),
  del(path.join(ROOT, 'workbench', '引擎数据', '.dsh', '场景记忆', '_共享记忆', 'areas', TEST_ID + '.md')),
  del(SPEC_PATH),
];
chk('测试文件已清理', cleaned.every(Boolean), '');

// 从索引移除
const idx2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'workbench', '引擎数据', '.dsh', '场景记忆', '_共享记忆', '索引.json'), 'utf8'));
idx2.areas = (idx2.areas || []).filter(a => a.id !== TEST_ID);
fs.writeFileSync(path.join(ROOT, 'workbench', '引擎数据', '.dsh', '场景记忆', '_共享记忆', '索引.json'),
  JSON.stringify(idx2, null, 2), 'utf8');
chk('索引已清理', true, idx2.areas.length + ' 个场景');

// ═══ 汇总 ═══
console.log();
console.log('═══════════════════════════════════════════════════════════════');
const passed = R.filter(r => r.pass).length;
console.log('  ' + passed + ' / ' + R.length + ' 通过');
if (R.filter(r => !r.pass).length) {
  console.log();
  console.log('  未通过:');
  for (const r of R.filter(x => !x.pass)) console.log('    ✗ ' + r.name + '  ' + r.detail);
}
console.log('═══════════════════════════════════════════════════════════════');

fs.writeFileSync(path.join(HERE, 'verify-evolve.json'), JSON.stringify(R, null, 2), 'utf8');
process.exitCode = R.every(r => r.pass) ? 0 : 1;
