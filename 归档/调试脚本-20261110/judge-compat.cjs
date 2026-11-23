/**
 * 决定性判断：dsh-tui 0.19.0 与当前 DSH 0.2.2-rc.1 到底能不能跑
 *
 * 只测一件事：--dump-config 是否成功 + 有多少个 patch 错误
 * 如果 patch 错误是致命的 → TUI 起不来 → 需要修 patch 或换版本
 */

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

const EXE = String.raw`D:\file\software\DeepSeek Harness\DeepSeek Harness.exe`;
const CLI = String.raw`D:\file\software\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`;
const TUI_HOME = path.join(os.homedir(), '.dsh-tui-home');

const env = Object.assign({}, process.env, {
  DSH_HOME: TUI_HOME,
  ELECTRON_RUN_AS_NODE: '1',
});
delete env.DSH_PORT;
delete env.SEA_DEBUG_PORT;
delete env.DSH_ENGINE_TOKEN;

console.log('═══ 决定性测试：--dump-config ═══');
console.log();

const r = spawnSync(EXE, ['--expose-internals', CLI, '--profile', 'dsh-tui', '--dump-config'], {
  encoding: 'utf8',
  env,
  timeout: 30000,
  maxBuffer: 10 * 1024 * 1024,
});

console.log('退出码:', r.status);
console.log('stdout 长度:', (r.stdout || '').length);
console.log('stderr 长度:', (r.stderr || '').length);
console.log();

// 统计 patch 错误
const errLines = (r.stderr || '').split('\n').filter(l => l.includes('not found') || l.includes('patch:'));
console.log('patch 错误数:', errLines.length);
console.log('错误明细（前 20 条）:');
for (const l of errLines.slice(0, 20)) {
  console.log('  ' + l.trim().slice(0, 130));
}

console.log();
console.log('═══ 判断 ═══');
if (r.status === 0 && errLines.length === 0) {
  console.log('✅ 完全兼容');
} else if (r.status === 0) {
  console.log('⚠ 配置能生成，但有 ' + errLines.length + ' 个 patch 警告（可能不影响运行）');
} else {
  console.log('❌ 退出码 ' + r.status + ' → 不兼容，需要修 patch');
}
