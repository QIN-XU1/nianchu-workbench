/**
 * probe-reader —— 最小可用插件
 *
 * 它只拿到 ctx，拿不到 fs / require / process。
 * 想要读文件只能走 ctx.fs.read，而 ctx 会过 A15 能力边界。
 */
export async function activate(ctx) {
  // 读自己的 manifest，统计行数与字节
  const target = 'tools/plugin/builtin/probe-reader/plugin.json';
  const text = ctx.fs.read(target);
  const lines = text.split('\n').length;

  ctx.log('读到 ' + target + '：' + text.length + ' 字节 / ' + lines + ' 行');

  return {
    read: target,
    bytes: text.length,
    lines,
    /** 证明自己拿不到越界能力：试一次，必须抛 */
    escapeAttempt: (() => {
      try {
        ctx.fs.write('C:/Windows/evil.dll', 'x');
        return 'FAILED_TO_BLOCK';
      } catch (e) {
        return 'blocked: ' + String(e.message).slice(0, 60);
      }
    })(),
  };
}