/**
 * 用「文件探测」代替「内联代码探测」
 * （内联 -e 在 PTY 下容易被吞）
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const SHELL = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳`;
const pty = require(path.join(SHELL, 'node_modules', 'node-pty'));

const EXE = String.raw`D:\file\software\DeepSeek Harness\DeepSeek Harness.exe`;
const TMP = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\_probe.cjs`;

const PROBE_CODE = `
const fs = require('fs');
const OUT = String.raw\`D:\\file\\AI Temp\\DeepSeek\\Agent自研\\prototype\\_probe-result.txt\`;

const lines = [];
lines.push('execPath=' + process.execPath);
lines.push('argv=' + JSON.stringify(process.argv.slice(0, 3)));
lines.push('ELECTRON_RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE || '(unset)'));
lines.push('stdin.isTTY=' + process.stdin.isTTY);
lines.push('stdin.setRawMode=' + typeof process.stdin.setRawMode);
lines.push('stdin.fd=' + process.stdin.fd);
lines.push('stdout.isTTY=' + process.stdout.isTTY);
lines.push('stdout.columns=' + process.stdout.columns);
lines.push('stdout.rows=' + process.stdout.rows);
if (typeof process.stdin.setRawMode === 'function') {
  try {
    process.stdin.setRawMode(true);
    lines.push('setRawMode(true)=OK');
    process.stdin.setRawMode(false);
    lines.push('setRawMode(false)=OK');
  } catch (e) {
    lines.push('setRawMode=ERROR ' + e.message);
  }
} else {
  lines.push('setRawMode=MISSING');
}
fs.writeFileSync(OUT, lines.join('\\n'), 'utf8');
process.exit(0);
`;

fs.writeFileSync(TMP, PROBE_CODE, 'utf8');
console.log('探测脚本已写入: ' + TMP);
console.log();

const RESULT = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\prototype\_probe-result.txt`;

function run(label, file, args, env) {
  return new Promise((resolve) => {
    console.log('─── ' + label + ' ───');
    try { fs.unlinkSync(RESULT); } catch (e) { /* ignore */ }

    let p;
    try {
      p = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 100, rows: 30,
        cwd: String.raw`D:\file\AI Temp\DeepSeek\Agent自研`,
        env: Object.assign({}, process.env, env || {}),
        useConpty: true,
      });
    } catch (e) {
      console.log('  ✗ spawn 异常: ' + e.message);
      return resolve();
    }

    p.onExit(() => {
      setTimeout(() => {
        if (fs.existsSync(RESULT)) {
          const r = fs.readFileSync(RESULT, 'utf8');
          console.log(r.split('\n').map(l => '  ' + l).join('\n'));
        } else {
          console.log('  （没有结果文件 → 进程没能执行我们的代码）');
        }
        resolve();
      }, 500);
    });

    setTimeout(() => {
      try { p.kill(); } catch (e) { /* ignore */ }
    }, 5000);
  });
}

(async () => {
  console.log('═══ 对照实验：谁有 raw mode ═══');
  console.log();

  // ① 系统 node
  await run('系统 node + PTY', process.execPath, [TMP], {});
  console.log();

  // ② Electron as node
  await run('Electron as node + PTY', EXE, ['--expose-internals', TMP], { ELECTRON_RUN_AS_NODE: '1' });

  process.exit(0);
})();
