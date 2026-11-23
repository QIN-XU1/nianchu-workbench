import fs from 'node:fs';

const P = 'D:/file/AI Temp/DeepSeek/Agent自研/workbench/工具/记忆注入效果体检.mjs';
const lines = fs.readFileSync(P, 'utf8').split('\n');

// 找 results.push 和遍历
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/results\.push|for\s*\(\s*const\s+\w+\s+of\s+(SCENES|scenes|targets)/.test(l)) {
    console.log('  L' + (i + 1) + ': ' + l.trim().slice(0, 100));
    // 打印上下文
    for (let k = Math.max(1, i - 2); k <= Math.min(lines.length, i + 14); k++) {
      console.log('      ' + k + ': ' + (lines[k - 1] || '').slice(0, 95));
    }
    console.log();
  }
}
