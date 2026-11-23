/**
 * 引擎页面布局修复（永久化）
 *
 * 问题诊断（实测数据）：
 *   .mP3x-q_frame 是 grid 布局，gridTemplateColumns = "625.6px 96px"
 *   .mP3x-q_centerCol 落在第 2 列 ⇒ 只有 96px 宽 ⇒ 文字竖排
 *
 * 根因：
 *   引擎在窄窗口（< ~900px）下，把 grid 分成两列，
 *   第 1 列给主内容区，第 2 列只剩 96px 给 AI 输入区。
 *   窗口稍宽时（1536px）就正常（centerCol=1256px）。
 *   所以这是引擎的响应式断点问题。
 *
 * 解法（在 webview 内部执行）：
 *   把 frame 的 grid 改成单列，centerCol 占满全部宽度。
 *   副作用：引擎的右侧栏（rightbarCol）会被隐藏 —— 但我们本来就不用它。
 */

export const PATCH_ENGINE_LAYOUT = `(function(){
  // 只在窗口不够宽时才修（够宽时让引擎自己管）
  if (window.innerWidth >= 900) {
    return { skipped: true, reason: 'window wide enough', winW: window.innerWidth };
  }

  var frame = document.querySelector('[class*="frame"]');
  var center = document.querySelector('[class*="centerCol"]');
  if (!frame || !center) return { error: 'elements not found' };

  var out = { actions: [], before: {} };

  var fcs = getComputedStyle(frame);
  out.before = {
    template: fcs.gridTemplateColumns,
    centerW: Math.round(center.getBoundingClientRect().width),
  };

  // ① grid 改单列
  if (fcs.gridTemplateColumns && fcs.gridTemplateColumns.indexOf(' ') >= 0) {
    frame.style.gridTemplateColumns = '1fr';
    out.actions.push('gridTemplateColumns: 1fr');
  }

  // ② centerCol 不再固定列
  center.style.gridColumn = 'auto';
  out.actions.push('centerCol gridColumn: auto');

  // ③ 隐藏抽屉遮罩
  document.querySelectorAll('[class*="drawerMask"]').forEach(function(el){
    el.style.display = 'none';
  });

  // ④ 触发重排
  window.dispatchEvent(new Event('resize'));

  out.after = {
    template: getComputedStyle(frame).gridTemplateColumns,
    centerW: Math.round(center.getBoundingClientRect().width),
  };
  return out;
})()`;

/**
 * 检查是否需要修复
 */
export const NEEDS_FIX = `(function(){
  var center = document.querySelector('[class*="centerCol"]');
  if (!center) return { needsFix: false, reason: 'no centerCol' };
  var w = center.getBoundingClientRect().width;
  return {
    needsFix: w > 0 && w < 300,
    centerW: Math.round(w),
    winW: window.innerWidth,
  };
})()`;
