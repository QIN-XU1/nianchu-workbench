import fs from 'node:fs';
import path from 'node:path';

// 找「怎么算出 ~/.dsh-tui 这个路径」的代码
const PKGS = [
  String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\引擎数据\.dsh-tui\profiles\dsh-tui\node_modules\@deepseek-harness-tui\dsh-tui`,
];

console.log('═══ 找 homeDir / stateDir 的解析逻辑 ═══');
console.log();

for (const PKG of PKGS) {
  const libDir = path.join(PKG, 'lib', 'types');
  if (!fs.existsSync(libDir)) { console.log('  lib/types 不存在'); continue; }

  // 找可能的 home 解析文件
  const candidates = [];
  function walk(dir, depth) {
    if (depth > 3) return;
    for (const it of fs.readdirSync(dir)) {
      const full = path.join(dir, it);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (!it.endsWith('.js')) continue;
      if (/home|state|paths|config|env/i.test(it)) candidates.push(full);
    }
  }
  walk(libDir, 0);

  console.log('候选文件:');
  for (const c of candidates) console.log('  ' + path.relative(PKG, c));

  // 在候选文件里找路径拼接
  console.log();
  console.log('路径拼接代码:');
  for (const c of candidates) {
    const t = fs.readFileSync(c, 'utf8');
    const lines = t.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.includes(".dsh-tui'") || l.includes('.dsh-tui"') || (l.includes('homedir') && l.includes('dsh-tui'))) {
        console.log('  ' + path.relative(PKG, c) + ':' + (i + 1));
        console.log('     ' + l.trim().slice(0, 130));
      }
    }
  }
}

// 直接全局搜 homedir('.dsh-tui')
console.log();
console.log('═══ 全局搜 .dsh-tui 路径构造 ═══');
for (const PKG of PKGS) {
  function scan(dir, depth) {
    if (depth > 24) return;
    let items;
    try { items = fs.readdirSync(dir); } catch (e) { return; }
    for (const it of items) {
      const full = path.join(dir, it);
      let st;
      try { st = fs.lstatSync(full); } catch (e) { continue; }
      if (st.isDirectory()) { scan(full, depth + 1); continue; }
      if (!it.endsWith('.js')) continue;
      if (st.size > 1024 * 1024) continue;
      try {
        const t = fs.readFileSync(full, 'utf8');
        const idx = t.indexOf("'.dsh-tui'");
        if (idx >= 0) {
          // 找上下文
          const around = t.slice(Math.max(0, idx - 200), idx + 100);
          if (around.includes('homedir') || around.includes('join')) {
            console.log('★ ' + path.relative(PKG, full));
            console.log('   ' + around.replace(/\n/g, ' ').slice(-180));
          }
        }
      } catch (e) { /* ignore */ }
    }
  }
  scan(PKG, 0);
}
