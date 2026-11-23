import fs from 'node:fs';
import path from 'node:path';

const ROOT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研`;
const WB = path.join(ROOT, 'workbench');
const REG = path.join(WB, '引擎数据', '.dsh', '场景记忆', '_共享记忆', '索引.json');
const SCEN = path.join(WB, '外壳', 'scenarios');
const CONT = path.join(WB, 'sceneboard', 'scenes');
const MEM = path.join(WB, '引擎数据', '.dsh', '场景记忆');

console.log('═══════════════════════════════════════════════════════════════');
console.log('  清理所有测试残留场景');
console.log('═══════════════════════════════════════════════════════════════');
console.log();

// 找出所有测试场景（e2e-, bulk-, verify-, probe-, test-）
const TEST_PREFIXES = ['e2e-', 'bulk-', 'verify-', 'probe-', 'test-'];

const j = JSON.parse(fs.readFileSync(REG, 'utf8'));
const before = j.areas.length;

const testAreas = j.areas.filter(a =>
  TEST_PREFIXES.some(p => a.id.startsWith(p)) || a.name.includes('测试') || a.name.includes('探针')
);

console.log('  发现测试场景 ' + testAreas.length + ' 个:');
for (const a of testAreas) console.log('    ' + a.id + '  (' + a.name + ')');
console.log();

// 从注册表移除
j.areas = j.areas.filter(a => !testAreas.includes(a));

// 清理场景文件
let cleaned = 0;
for (const a of testAreas) {
  // 场景定义
  const sf = path.join(SCEN, a.id + '.json');
  if (fs.existsSync(sf)) { fs.unlinkSync(sf); cleaned++; }

  // 契约
  const cf = path.join(CONT, a.id + '.json');
  if (fs.existsSync(cf)) { fs.unlinkSync(cf); cleaned++; }

  // 记忆目录
  const mf = path.join(MEM, a.name);
  if (fs.existsSync(mf)) {
    fs.rmSync(mf, { recursive: true, force: true });
    cleaned++;
  }

  // areas 明细
  const af = path.join(MEM, '_共享记忆', 'areas', a.id + '.md');
  if (fs.existsSync(af)) { fs.unlinkSync(af); cleaned++; }
}

fs.writeFileSync(REG, JSON.stringify(j, null, 2), 'utf8');

// 也扫一遍目录里所有测试前缀文件
for (const dir of [SCEN, CONT]) {
  for (const f of fs.readdirSync(dir)) {
    if (TEST_PREFIXES.some(p => f.startsWith(p))) {
      try { fs.unlinkSync(path.join(dir, f)); cleaned++; } catch (e) {}
    }
  }
}
for (const d of fs.readdirSync(MEM)) {
  if (TEST_PREFIXES.some(p => d.startsWith(p)) || d.includes('测试') || d.includes('探针')) {
    const full = path.join(MEM, d);
    if (fs.statSync(full).isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
      cleaned++;
    }
  }
}

console.log('  注册表: ' + before + ' → ' + j.areas.length + ' 个场景');
console.log('  清理文件: ' + cleaned + ' 个');
console.log();
console.log('═══════════════════════════════════════════════════════════════');
console.log('  最终场景清单');
console.log('═══════════════════════════════════════════════════════════════');
for (const a of j.areas) {
  console.log('  ' + a.id.padEnd(22) + a.name);
}
