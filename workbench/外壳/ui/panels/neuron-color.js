/**
 * neuron-color.js —— 颜色与转义（从 neuron.js 拆出）
 *
 * 纯函数，零依赖。可单独测试。
 *
 * hexA 支持 #RGB / #RRGGBB / rgb()（此前只认 #RRGGBB，是个 bug）
 */

  export function hexA(hex, a) {
    if (typeof hex !== 'string') return 'rgba(111,176,220,' + a + ')';

    // 已是 rgb()/rgba() 格式
    if (hex.indexOf('rgb') === 0) {
      const nums = hex.match(/\d+/g) || ['111', '176', '220'];
      return 'rgba(' + nums[0] + ',' + nums[1] + ',' + nums[2] + ',' + a + ')';
    }

    // #RGB 或 #RRGGBB
    const m = hex.replace('#', '');
    if (m.length === 3) {
      return 'rgba(' +
        parseInt(m[0] + m[0], 16) + ',' +
        parseInt(m[1] + m[1], 16) + ',' +
        parseInt(m[2] + m[2], 16) + ',' + a + ')';
    }
    return 'rgba(' + parseInt(m.slice(0, 2), 16) + ',' +
           parseInt(m.slice(2, 4), 16) + ',' +
           parseInt(m.slice(4, 6), 16) + ',' + a + ')';
  }

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
  });
}
