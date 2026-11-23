/**
 * 破解「会话占用」：为什么 dsh-TUI 无法 resume 我们正在进行的对话
 *
 * 现象：
 *   dsh-tui startup failed: cannot resume session "xxx":
 *     its occupancy ... / already owned by an active write handle
 *
 * 分析：
 *   用户正在 Web GUI（49856）跟 AI 对话 → 那个会话被主 DSH 引擎持有写句柄
 *   dsh-TUI 想同时 attach 同一个会话 → 拒绝
 *
 * 可选方案：
 *   A. dsh-TUI 只读 attach（如果引擎支持）
 *   B. dsh-TUI 开新会话，作为"主控"会话
 *   C. 工作台自己成为唯一入口（用户在工作台的 TUI 里对话）
 *
 * 先验证 A 是否可能：查引擎/会话协议里有没有只读 attach
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const TUI_PROFILE = String.raw`D:\file\AI Temp\DeepSeek\Agent自研\workbench\引擎数据\.dsh-tui\profiles\dsh-tui`;
const PKG = path.join(TUI_PROFILE, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');

console.log('═══ 查 dsh-TUI 的 resume 实现 ═══');
console.log('  包路径:', fs.existsSync(PKG) ? '存在' : '缺失');
console.log();

// 找 resume 相关代码
if (fs.existsSync(PKG)) {
  const libDirs = ['lib', 'cli', 'tui-profile'];
  for (const d of libDirs) {
    const p = path.join(PKG, d);
    if (!fs.existsSync(p)) continue;
    console.log('--- ' + d + ' ---');
    const walk = (dir, depth) => {
      if (depth > 2) return;
      for (const it of fs.readdirSync(dir)) {
        const full = path.join(dir, it);
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.isDirectory()) { walk(full, depth + 1); continue; }
        if (!it.endsWith('.js') && !it.endsWith('.mjs')) continue;

        try {
          const t = fs.readFileSync(full, 'utf8');
          if (t.includes('occupancy') || t.includes('write handle') || t.includes('RESUME_SESSION')) {
            console.log('  ★ ' + path.relative(PKG, full));
            // 找关键行
            const lines = t.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const l = lines[i];
              if (l.includes('occupancy') || l.includes('write handle') || l.includes('RESUME_SESSION')) {
                console.log('     ' + (i + 1) + ': ' + l.trim().slice(0, 110));
              }
            }
          }
        } catch (e) { /* ignore */ }
      }
    };
    walk(p, 0);
  }
}
