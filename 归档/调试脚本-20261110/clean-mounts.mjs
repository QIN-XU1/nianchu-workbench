import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = path.join(os.homedir(), '.dsh-tui');
const MOUNTS = path.join(DATA_DIR, 'session-mounts.json');
const LOCK = path.join(DATA_DIR, 'session-mounts.lock');

console.log('═══ 清理残留的 session-mounts ═══');
console.log();

// ① 读当前内容
if (fs.existsSync(MOUNTS)) {
  const c = fs.readFileSync(MOUNTS, 'utf8');
  console.log('  当前内容:');
  console.log('  ' + c.replace(/\n/g, ' ').slice(0, 400));
  console.log();

  try {
    const j = JSON.parse(c);
    const owners = j.owners || [];
    console.log('  owners: ' + owners.length + ' 个');
    for (const o of owners) {
      let alive = false;
      try {
        process.kill(o.pid, 0);   // 只探测，不杀
        alive = true;
      } catch (e) {
        alive = false;
      }
      console.log('    pid=' + o.pid + '  存活=' + alive + '  会话数=' + (o.sessionIds || []).length);
    }

    // ② 清理已死进程的记录
    const live = owners.filter(o => {
      try { process.kill(o.pid, 0); return true; } catch (e) { return false; }
    });

    if (live.length !== owners.length) {
      j.owners = live;
      fs.writeFileSync(MOUNTS, JSON.stringify(j, null, 2), 'utf8');
      console.log();
      console.log('  ✓ 已清理 ' + (owners.length - live.length) + ' 个死进程记录，剩 ' + live.length);
    } else {
      console.log('  （所有 owner 都还活着，无需清理）');
    }
  } catch (e) {
    console.log('  解析失败: ' + e.message);
    // 直接重置
    fs.writeFileSync(MOUNTS, JSON.stringify({ version: 1, owners: [] }, null, 2), 'utf8');
    console.log('  ✓ 已重置为空');
  }
} else {
  console.log('  session-mounts.json 不存在');
}

// ③ 删掉 lock（如果存在）
if (fs.existsSync(LOCK)) {
  try {
    fs.unlinkSync(LOCK);
    console.log('  ✓ 已删除残留 lock 文件');
  } catch (e) {
    console.log('  ✗ 删 lock 失败: ' + e.code);
  }
} else {
  console.log('  lock 文件不存在（正常）');
}

console.log();
console.log('═══ 清理后状态 ═══');
if (fs.existsSync(MOUNTS)) {
  console.log('  ' + fs.readFileSync(MOUNTS, 'utf8').replace(/\n/g, ' ').slice(0, 300));
}
console.log('  lock 存在: ' + fs.existsSync(LOCK));
