import fs from 'node:fs';
import path from 'node:path';

const BASE = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\_asar\dsh\node_modules\@deepseek-ai\dsh-spill-local\lib`;

console.log('═══ dsh-spill-local 的 mkdtemp 用法 ═══');
console.log('  路径:', BASE, '存在:', fs.existsSync(BASE));
console.log();

if (fs.existsSync(BASE)) {
  for (const f of fs.readdirSync(BASE)) {
    if (!f.endsWith('.js')) continue;
    const full = path.join(BASE, f);
    const t = fs.readFileSync(full, 'utf8');
    const lines = t.split('\n');
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.includes('mkdtemp') || l.includes('tmpdir') || l.includes('temp')) {
        if (!found) { console.log('--- ' + f + ' ---'); found = true; }
        console.log('  ' + (i + 1) + ': ' + l.trim().slice(0, 130));
      }
    }
    if (found) console.log();
  }
}

console.log();
console.log('═══ 系统 TEMP 环境变量 ═══');
console.log('  TEMP: ' + (process.env.TEMP || '(未设)'));
console.log('  TMP:  ' + (process.env.TMP || '(未设)'));
console.log('  os.tmpdir(): ' + require('node:os').tmpdir());

// 测试能否在这个目录 mkdtemp
console.log();
console.log('═══ 实测 mkdtemp ═══');
const os = require('node:os');
try {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dshtest-'));
  console.log('  ✓ 成功: ' + d);
  fs.rmSync(d, { recursive: true, force: true });
} catch (e) {
  console.log('  ✗ 失败: ' + e.code + ' ' + e.message.slice(0, 100));
}
