#!/usr/bin/env node
/**
 * 备份的变异测试 —— 证明它真的能工作
 *
 * 备份是最危险的工具：如果备份是坏的，回滚时才发现就晚了。
 * 所以必须证明：
 *   ① 备份能完整复制
 *   ② 备份后校验能通过
 *   ③ 改动后校验能发现差异（证明校验不是装饰）
 *   ④ 恢复能真的还原
 *   ⑤ 恢复前会自动备份当前状态
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createBackup, listBackups, verifyBackup, restoreBackup } from './备份.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ══════════════════════════════════════════════════════════════
//  结果收集
// ══════════════════════════════════════════════════════════════
const R = [];
function chk(name, ok, detail) {
  R.push({ name, ok: !!ok, detail: String(detail || '') });
  console.log((ok ? '  OK   ' : '  XX   ') + name + (detail ? '  ' + String(detail).slice(0, 60) : ''));
}

// ══════════════════════════════════════════════════════════════
//  造基线
// ══════════════════════════════════════════════════════════════
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
const WB = path.join(BASE, 'workbench');

function makeBaseline() {
  fs.rmSync(WB, { recursive: true, force: true });

  // AGENTS.md
  const dsh = path.join(WB, '数据', '.dsh');
  fs.mkdirSync(dsh, { recursive: true });
  fs.writeFileSync(path.join(dsh, 'AGENTS.md'), '# 全局须知\n版本 1\n', 'utf8');

  // 场景记忆
  const mem = path.join(dsh, '场景记忆', '演示');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, '场景私有记忆.md'), '# 演示记忆\n内容\n', 'utf8');
  fs.writeFileSync(path.join(mem, '身份卡.md'), '# 演示身份卡\n', 'utf8');

  // 场景配置
  const scen = path.join(WB, '外壳', 'scenarios');
  fs.mkdirSync(scen, { recursive: true });
  fs.writeFileSync(path.join(scen, 'demo.json'),
    JSON.stringify({ id: 'demo', name: '演示' }, null, 2), 'utf8');

  // 契约
  const sb = path.join(WB, 'sceneboard', 'scenes');
  fs.mkdirSync(sb, { recursive: true });
  fs.writeFileSync(path.join(sb, 'demo.json'),
    JSON.stringify({ id: 'demo', role: '测试' }, null, 2), 'utf8');

  // 技能
  const sk = path.join(dsh, 'skills');
  fs.mkdirSync(sk, { recursive: true });
  fs.writeFileSync(path.join(sk, 'demo.md'), '# 技能\n', 'utf8');
}

makeBaseline();

console.log('═'.repeat(66));
console.log('  备份 · 变异测试');
console.log('═'.repeat(66));
console.log();

// ══════════════════════════════════════════════════════════════
//  测试 1：备份能完整复制
// ══════════════════════════════════════════════════════════════
const b1 = createBackup({ wbRoot: WB, label: '测试1' });
chk('备份创建成功', b1.files > 0, b1.files + ' 文件');
// AGENTS.md + 场景私有记忆.md + 身份卡.md + demo.json(场景) + demo.json(契约) + demo.md(技能) = 6
chk('文件数符合预期（6 个核心文件）', b1.files === 6, b1.files + ' 文件');
chk('备份目录存在', fs.existsSync(b1.dir), b1.id);

// ══════════════════════════════════════════════════════════════
//  测试 2：备份后校验通过
// ══════════════════════════════════════════════════════════════
const v1 = verifyBackup(path.join(WB, '备份'), b1.id);
chk('备份校验通过', v1.ok, v1.ok ? '0 差异' : v1.diffs.join('; '));

// ══════════════════════════════════════════════════════════════
//  测试 3：改动备份文件 → 校验必须发现
// ══════════════════════════════════════════════════════════════
{
  const target = path.join(b1.dir, '数据', '.dsh', 'AGENTS.md');
  fs.writeFileSync(target, '# 被篡改\n', 'utf8');
  const v = verifyBackup(path.join(WB, '备份'), b1.id);
  chk('备份被篡改 → 校验必须发现', !v.ok && v.diffs.some(d => d.includes('哈希不匹配')),
    v.diffs[0] || '没有发现差异');
  // 还原，避免影响后续
  fs.writeFileSync(target, '# 全局须知\n版本 1\n', 'utf8');
}

// ══════════════════════════════════════════════════════════════
//  测试 4：删除备份文件 → 校验必须发现
// ══════════════════════════════════════════════════════════════
{
  const target = path.join(b1.dir, 'sceneboard', 'scenes', 'demo.json');
  const bak = target + '.bak';
  fs.renameSync(target, bak);
  const v = verifyBackup(path.join(WB, '备份'), b1.id);
  chk('备份文件缺失 → 校验必须发现', !v.ok && v.diffs.some(d => d.includes('文件缺失')),
    v.diffs[0] || '没有发现缺失');
  fs.renameSync(bak, target);
}

// ══════════════════════════════════════════════════════════════
//  测试 5：恢复能真的还原
// ══════════════════════════════════════════════════════════════
{
  // 改动源文件
  const agents = path.join(WB, '数据', '.dsh', 'AGENTS.md');
  fs.writeFileSync(agents, '# 被我改坏了\n', 'utf8');
  const before = fs.readFileSync(agents, 'utf8');

  const r = restoreBackup({ wbRoot: WB, id: b1.id });
  const after = fs.readFileSync(agents, 'utf8');

  chk('恢复成功', r.ok, r.ok ? r.restored + ' 文件' : r.error);
  chk('恢复后内容正确', after.includes('版本 1'), JSON.stringify(after.slice(0, 20)));
  chk('恢复前内容确实不同', before !== after, 'before=' + JSON.stringify(before.slice(0, 12)));
}

// ══════════════════════════════════════════════════════════════
//  测试 6：恢复前自动备份（防"恢复错了回不去"）
// ══════════════════════════════════════════════════════════════
{
  const list = listBackups(path.join(WB, '备份'));
  const hasSafety = list.some(m => String(m.label).includes('恢复前自动备份'));
  chk('恢复前自动创建了安全备份', hasSafety, list.length + ' 份备份');
}

// ══════════════════════════════════════════════════════════════
//  测试 7：损坏的备份拒绝恢复（安全阀）
// ══════════════════════════════════════════════════════════════
{
  const list = listBackups(path.join(WB, '备份'));
  const target = list[0];
  // 破坏一个文件
  const anyFile = target.entries[0];
  const p = path.join(WB, '备份', target.id, anyFile.path);
  fs.writeFileSync(p, 'CORRUPTED', 'utf8');

  const r = restoreBackup({ wbRoot: WB, id: target.id });
  chk('损坏的备份拒绝恢复', r.ok === false, r.error || '竟然恢复了');
}

// ══════════════════════════════════════════════════════════════
//  测试 8：备份后原始数据未被污染
// ══════════════════════════════════════════════════════════════
{
  const agents = path.join(WB, '数据', '.dsh', 'AGENTS.md');
  const content = fs.readFileSync(agents, 'utf8');
  chk('备份操作不修改原始数据', content.includes('版本 1') || content.includes('全局须知'),
    JSON.stringify(content.slice(0, 20)));
}

// ══════════════════════════════════════════════════════════════
//  反例验证
// ══════════════════════════════════════════════════════════════
console.log();
console.log('═'.repeat(66));
console.log('  反例验证（校验不是装饰）');
console.log('═'.repeat(66));
console.log();

{
  // 造一个"校验永远通过"的假象：如果 verifyBackup 不检查哈希，这里会失败
  const b2 = createBackup({ wbRoot: WB, label: '反例' });
  const target = path.join(b2.dir, '数据', '.dsh', 'AGENTS.md');
  fs.writeFileSync(target, '# 完全不同的内容，长度也不一样' + 'x'.repeat(100), 'utf8');

  const v = verifyBackup(path.join(WB, '备份'), b2.id);
  if (v.ok === false) {
    console.log('  OK   校验确实能发现内容篡改（不是永远通过）');
  } else {
    console.log('  XX   校验永远通过 —— 是装饰不是检查！');
    R.push({ name: '反例验证', ok: false });
  }
}

console.log();
console.log('─'.repeat(66));
const passed = R.filter(x => x.ok).length;
console.log('  结果: ' + passed + ' / ' + R.length + ' 通过');
console.log('─'.repeat(66));
console.log();

try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
process.exit(R.every(x => x.ok) ? 0 : 1);
