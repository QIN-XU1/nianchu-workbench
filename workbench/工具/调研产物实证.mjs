/**
 * 用真实产物验证新判据：过去的 7 个「调研」产出应该全部被拒
 *
 * 这是整套改动的**实证**：
 *   旧 check 对 7/7 自查产物一律放行
 *   新 check 必须把它们全部挡在门外（外部性硬闸门）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WB = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench';
const MEM = path.join(WB, '数据', '.dsh', '场景记忆', '调研');
const CHECK = path.join(WB, '数据', '.dsh', 'skills', 'research', 'check.mjs');

console.log('='.repeat(74));
console.log('  实证：新判据能否识别过去的自查产物');
console.log('='.repeat(74));
console.log();

if (!fs.existsSync(MEM)) { console.log('  ✗ 调研记忆目录不存在'); process.exit(1); }

const SKIP = ['AGENTS.local.md', '场景画像.md', '场景私有记忆.md', '身份卡.md', '_文件索引.md'];
const files = fs.readdirSync(MEM).filter((f) => f.endsWith('.md') && !f.startsWith('_') && !SKIP.includes(f));
console.log('  调研场景的 ' + files.length + ' 个产物：');
console.log();

let rejected = 0, accepted = 0;
for (const f of files) {
  const p = path.join(MEM, f);
  const txt = fs.readFileSync(p, 'utf8');
  let r;
  try {
    const out = execFileSync(process.execPath, [CHECK, '--json', p], { encoding: 'utf8', timeout: 30000 });
    r = JSON.parse(out);
  } catch (e) {
    // exit 1 时 stdout 仍有 JSON
    try { r = JSON.parse(String(e.stdout || '')); } catch { r = { ok: false, problems: ['无法解析输出'] }; }
  }

  const ok = r.ok === true;
  if (ok) accepted++; else rejected++;

  console.log('  ' + (ok ? '✓ 通过' : '✗ 拒绝') + '  ' + f.padEnd(28) + (r.problems || []).length + ' 个问题');
  // 打印前 2 个问题（只打 R2 相关，最能说明问题）
  const r2 = (r.problems || []).filter((x) => x.startsWith('R2'));
  if (r2.length) {
    for (const x of r2.slice(0, 2)) console.log('        ' + x.slice(0, 100));
    if (r2.length > 2) console.log('        …还有 ' + (r2.length - 2) + ' 条 R2');
  } else if (!ok) {
    console.log('        ' + (r.problems || [])[0]?.slice(0, 100));
  }
}

console.log();
console.log('─'.repeat(74));
console.log('  拒绝 ' + rejected + ' / 通过 ' + accepted + '（共 ' + files.length + '）');
console.log('─'.repeat(74));

if (rejected === files.length && files.length > 0) {
  console.log('  ✓ 全部被拒 —— 外部性闸门生效了');
  console.log('    这 7 个产物都是「对本项目的自查」，而调研要求外部情报。');
  process.exit(0);
} else if (files.length === 0) {
  console.log('  ⚠ 没有产物可测');
  process.exit(0);
} else {
  console.log('  ⚠ 有 ' + accepted + ' 个通过了 —— 需要检查是否真的是外部调研');
  process.exit(1);
}
