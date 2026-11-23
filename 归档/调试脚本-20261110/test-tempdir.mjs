import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

console.log('═══ TEMP 目录实测 ═══');
console.log('  os.tmpdir(): ' + os.tmpdir());
console.log('  存在: ' + fs.existsSync(os.tmpdir()));
console.log();

// ① 直接 mkdtemp
try {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spill-'));
  console.log('① mkdtemp 成功: ' + d);
  fs.rmdirSync(d);
} catch (e) {
  console.log('① mkdtemp 失败: ' + e.code + ' ' + e.message.slice(0, 120));
}

// ② 写文件测试
try {
  const f = path.join(os.tmpdir(), 'dsh-write-test-' + Date.now() + '.txt');
  fs.writeFileSync(f, 'test');
  console.log('② 写文件成功: ' + f);
  fs.unlinkSync(f);
} catch (e) {
  console.log('② 写文件失败: ' + e.code);
}

// ③ 权限检查
const temp = os.tmpdir();
try {
  fs.accessSync(temp, fs.constants.W_OK);
  console.log('③ 有写权限');
} catch (e) {
  console.log('③ 无写权限: ' + e.code);
}

// ④ 列目录
try {
  const items = fs.readdirSync(temp);
  console.log('④ 目录条目数: ' + items.length);
} catch (e) {
  console.log('④ 列目录失败: ' + e.code);
}

// ⑤ 关键：找一个之前创建的 dsh-spill 目录
console.log();
console.log('═══ 已存在的 dsh-spill 目录 ═══');
try {
  const items = fs.readdirSync(temp).filter(x => x.startsWith('dsh-spill'));
  console.log('  数量: ' + items.length);
  for (const it of items.slice(0, 5)) {
    const full = path.join(temp, it);
    try {
      const st = fs.statSync(full);
      console.log('  ' + it + '  是目录=' + st.isDirectory());
      // 测能否在里面写
      try {
        fs.accessSync(full, fs.constants.W_OK);
        console.log('    可写: ✓');
      } catch (e) {
        console.log('    可写: ✗ ' + e.code);
      }
    } catch (e) {
      console.log('  ' + it + '  stat 失败: ' + e.code + '（悬空链接？）');
    }
  }
} catch (e) {
  console.log('  失败: ' + e.code);
}
