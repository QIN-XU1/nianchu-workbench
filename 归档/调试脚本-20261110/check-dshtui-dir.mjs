import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.dsh-tui');
const LOCK = path.join(DIR, 'session-mounts.lock');

console.log('═══ dsh-tui 的硬编码状态目录 ═══');
console.log('  目录: ' + DIR);
console.log('  存在: ' + fs.existsSync(DIR));
if (fs.existsSync(DIR)) {
  try {
    const items = fs.readdirSync(DIR);
    console.log('  内容(' + items.length + '):');
    for (const it of items.slice(0, 15)) {
      const full = path.join(DIR, it);
      let st;
      try { st = fs.statSync(full); } catch (e) { console.log('    ' + it + '  (stat失败)'); continue; }
      console.log('    ' + it + (st.isDirectory() ? '/' : '') + '  ' + st.size + 'B');
    }
  } catch (e) {
    console.log('  列目录失败: ' + e.code);
  }
} else {
  console.log('  → 不存在（这就是 EPERM 的原因之一）');
}

console.log();
console.log('═══ 锁文件状态 ═══');
console.log('  路径: ' + LOCK);
console.log('  存在: ' + fs.existsSync(LOCK));
if (fs.existsSync(LOCK)) {
  try {
    const st = fs.statSync(LOCK);
    console.log('  大小: ' + st.size);
    console.log('  内容: ' + JSON.stringify(fs.readFileSync(LOCK, 'utf8').slice(0, 200)));
  } catch (e) {
    console.log('  读取失败: ' + e.code);
  }
}

console.log();
console.log('═══ 实测能否在这个目录创建文件 ═══');
try {
  if (!fs.existsSync(DIR)) {
    fs.mkdirSync(DIR, { recursive: true });
    console.log('  ✓ 已创建目录');
  }
  const testFile = path.join(DIR, 'write-test-' + Date.now() + '.txt');
  fs.writeFileSync(testFile, 'x');
  console.log('  ✓ 写文件成功');
  fs.unlinkSync(testFile);

  // 测 open with 'wx'（创建模式，模拟 lock）
  const lockTest = path.join(DIR, 'lock-test.lock');
  const fd = fs.openSync(lockTest, 'wx');
  fs.closeSync(fd);
  console.log('  ✓ open(wx) 成功（创建模式）');
  fs.unlinkSync(lockTest);
} catch (e) {
  console.log('  ✗ 失败: ' + e.code + ' ' + e.message.slice(0, 100));
}
