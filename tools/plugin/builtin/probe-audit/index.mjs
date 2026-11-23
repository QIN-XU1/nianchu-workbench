/**
 * probe-audit —— 依赖 probe-reader（验证拓扑排序：必须后激活）
 *
 * 能力声明比 probe-reader 多一个 fs.write:evidence/**。
 *
 * 【2026-11-16 如实修正】这里原先写「C:/Windows 是围栏外，由 A15 gate 拒绝」——
 * **那句话已经不成立**：A15 的 gate 已随 tools/plugin/kernel.mjs 一并移除
 * （用户明令「越界拦截类安全机制不做，一旦做错就是很大的漏洞」）。
 *
 * 现状如实说：**没有任何机制阻止本插件写 C:/Windows**。
 * 它没这么做，是因为代码里只写 evidence/plugin-probe/audit.json，
 * 不是因为有人拦它。别把「我们没做」说成「机制禁止」。
 */
export async function activate(ctx) {
  const target = 'tools/plugin/builtin/probe-reader/plugin.json';
  const manifest = ctx.fs.read(target);

  const out = 'evidence/plugin-probe/audit.json';
  ctx.fs.write(out, JSON.stringify({
    at: new Date().toISOString(),
    by: ctx.plugin.name + '@' + ctx.plugin.version,
    observed: target,
    manifestBytes: manifest.length,
  }, null, 2) + '\n');

  ctx.log('wrote ' + out);

  return {
    wrote: out,
    /** 越界写必须抛 */
    escapeAttempt: (() => {
      try {
        ctx.fs.write('../../outside.txt', 'x');
        return 'FAILED_TO_BLOCK';
      } catch (e) {
        return 'blocked: ' + String(e.message).slice(0, 60);
      }
    })(),
    /** 未声明的能力必须抛 */
    undeclaredAttempt: (() => {
      try {
        ctx.exec('powershell');
        return 'FAILED_TO_BLOCK';
      } catch (e) {
        return 'blocked: ' + String(e.message).slice(0, 60);
      }
    })(),
  };
}