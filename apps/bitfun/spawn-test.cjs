const { spawn } = require('node:child_process');
const DSH = 'D:\\file\\software\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
const child = spawn(DSH, ['--profile','headless','--json','1+1'], { shell: true, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
let out = '', err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));
child.on('close', (code) => {
  console.log('exit=' + code);
  console.log('stdout=' + out.substring(0, 300));
  console.log('stderr=' + err.substring(0, 300));
});
