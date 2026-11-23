/**
 * 验证：.dsh-tui-home 的 profile 是否被 Copy-Item 破坏了
 *
 * pnpm 的 node_modules 全是符号链接到全局 store。
 * PowerShell 的 Copy-Item -Recurse 会把符号链接解引用成实体文件，
 * 或者干脆复制成失效的链接 —— 两种都会导致 profile 加载失败。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const TUI_HOME = path.join(os.homedir(), '.dsh-tui-home');
const MAIN_HOME = path.join(os.homedir(), '.dsh');

console.log('═══ 检查 TUI home 的 profile 健康度 ═══');
console.log();

function checkProfile(label, home) {
  const prof = path.join(home, 'profiles', 'dsh-tui');
  console.log('─── ' + label + ' ───');
  console.log('  路径: ' + prof);
  console.log('  存在: ' + fs.existsSync(prof));

  if (!fs.existsSync(prof)) return;

  // ① cordis.yml 能否打开
  const yml = path.join(prof, 'cordis.yml');
  console.log('  cordis.yml: ' + (fs.existsSync(yml) ? '存在' : '缺失'));
  if (fs.existsSync(yml)) {
    try {
      const fd = fs.openSync(yml, 'r');
      fs.closeSync(fd);
      console.log('    可打开: ✓');
    } catch (e) {
      console.log('    可打开: ✗ ' + e.code + ' ' + e.message.slice(0, 60));
    }
  }

  // ② node_modules 里有多少符号链接 / 失效链接
  const nm = path.join(prof, 'node_modules');
  if (!fs.existsSync(nm)) {
    console.log('  node_modules: 缺失');
    return;
  }

  let total = 0, symlinks = 0, broken = 0;
  const items = fs.readdirSync(nm);
  for (const it of items) {
    if (it.startsWith('.')) continue;
    total++;
    const full = path.join(nm, it);
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        symlinks++;
        try {
          // 检查链接目标是否存在
          fs.statSync(full);
        } catch (e) {
          broken++;
        }
      }
    } catch (e) { /* ignore */ }
  }
  console.log('  node_modules 顶层: ' + total + ' 项，符号链接 ' + symlinks + '，失效 ' + broken);

  // ③ 关键包是否真的可读
  const tuiPkg = path.join(nm, '@deepseek-harness-tui', 'dsh-tui', 'cordis.patch.yml');
  console.log('  dsh-tui 的 cordis.patch.yml:');
  if (fs.existsSync(tuiPkg)) {
    try {
      const fd = fs.openSync(tuiPkg, 'r');
      fs.closeSync(fd);
      console.log('    可打开: ✓');
    } catch (e) {
      console.log('    可打开: ✗ ' + e.code);
    }
  } else {
    console.log('    不存在（可能是失效链接）');
  }
}

checkProfile('TUI home（复制来的）', TUI_HOME);
console.log();
checkProfile('主 home（pnpm 原生安装）', MAIN_HOME);

console.log();
console.log('═══ 判断 ═══');
console.log('  如果 TUI home 的 node_modules 大量失效 → 必须重新用 pnpm 装，不能复制');
