import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.dsh-tui');
const HOME_DIR = path.join(HOME, '.dsh');

console.log('═══ dsh-tui 的三个数据根 ═══');
console.log('  DATA_DIR（配置）: ' + DATA_DIR);
console.log('  HOME/.dsh（会话）: ' + HOME_DIR);
console.log();

// ① DATA_DIR 里的 session-mounts
for (const f of ['session-mounts.json', 'session-mounts.lock', 'session-index.json']) {
  const p = path.join(DATA_DIR, f);
  console.log('  ' + f + ': ' + (fs.existsSync(p) ? fs.statSync(p).size + 'B' : '缺失'));
  if (fs.existsSync(p) && f.endsWith('.json')) {
    try {
      const c = fs.readFileSync(p, 'utf8');
      console.log('    内容: ' + c.slice(0, 300).replace(/\n/g, ' '));
    } catch (e) { /* ignore */ }
  }
}

// ② DATA_DIR/sessions（如果存在）
const dataSessions = path.join(DATA_DIR, 'sessions');
console.log();
console.log('  DATA_DIR/sessions: ' + (fs.existsSync(dataSessions) ? '存在' : '缺失'));
if (fs.existsSync(dataSessions)) {
  const items = fs.readdirSync(dataSessions);
  console.log('    内容: ' + items.slice(0, 5).join(', '));
}

// ③ 实测：在 Electron 子进程里能不能创建 lock
console.log();
console.log('═══ 关键测试：模拟 Electron 子进程的环境 ═══');
console.log('  已知：纯 node 能创建 lock，Electron 子进程不能（EPERM）');
console.log();

// 检查 Electron 是否改变了 TEMP
console.log('  当前 TEMP: ' + process.env.TEMP);
console.log('  当前 TMP : ' + process.env.TMP);

// ④ 尝试直接创建 lock（模拟）
const lockPath = path.join(DATA_DIR, 'session-mounts.lock');
try {
  const fd = fs.openSync(lockPath, 'wx');
  fs.writeSync(fd, JSON.stringify({ test: true, at: Date.now() }));
  fs.closeSync(fd);
  console.log('  ✓ 能创建 lock 文件');
  fs.unlinkSync(lockPath);
  console.log('  ✓ 已清理');
} catch (e) {
  console.log('  ✗ 创建失败: ' + e.code);
  if (fs.existsSync(lockPath)) {
    console.log('  （lock 已存在，可能残留）');
  }
}
