/**
 * 修复引擎页面的 centerCol 极窄（96px）导致文字竖排
 *
 * 实测：
 *   webview win 722x734
 *   .mP3x-q_centerCol = 96px     ← 只有 96px，文字竖排
 *   另一实例 1536x822 时 centerCol = 1256px 正常
 *
 * 原因：引擎有个 drawerMask / sidebarCol 遮住了空间，
 *       或者首次渲染时算错了列宽。
 *
 * 解法（在引擎页面内部执行）：
 *   ① 关掉侧边栏抽屉（drawerMask / sidebarCol）
 *   ② 强制 centerCol 撑满
 */

export function fixEngineLayout() {
  return `(function(){
    var out = { actions: [] };

    // ① 关掉抽屉遮罩
    document.querySelectorAll('[class*="drawerMask"]').forEach(function(el){
      el.style.display = 'none';
      out.actions.push('hide drawerMask');
    });

    // ② 收起侧边栏列（如果有 sidebarCol 占位）
    document.querySelectorAll('[class*="sidebarCol"]').forEach(function(el){
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.x < 0) {
        el.style.width = '0px';
        el.style.minWidth = '0px';
        el.style.overflow = 'hidden';
        out.actions.push('collapse sidebarCol');
      }
    });

    // ③ 强制主内容列撑满
    var center = document.querySelector('[class*="centerCol"]');
    if (center) {
      var r = center.getBoundingClientRect();
      if (r.width < 300) {
        center.style.width = '100%';
        center.style.minWidth = '0';
        center.style.flex = '1 1 auto';
        out.actions.push('widen centerCol from ' + Math.round(r.width));
      }
    }

    // ④ 触发 resize 让引擎重排
    window.dispatchEvent(new Event('resize'));
    out.actions.push('dispatch resize');

    out.after = {
      centerColW: center ? Math.round(center.getBoundingClientRect().width) : 0,
      winW: window.innerWidth,
    };
    return out;
  })()`;
}

export const DIAG_SCRIPT = `(function(){
  var center = document.querySelector('[class*="centerCol"]');
  var frame = document.querySelector('[class*="frame"]');
  var sidebar = document.querySelector('[class*="sidebarCol"]');
  var mask = document.querySelector('[class*="drawerMask"]');
  return {
    winW: window.innerWidth,
    centerW: center ? Math.round(center.getBoundingClientRect().width) : 0,
    frameW: frame ? Math.round(frame.getBoundingClientRect().width) : 0,
    sidebarW: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
    sidebarX: sidebar ? Math.round(sidebar.getBoundingClientRect().x) : 0,
    maskVisible: mask ? getComputedStyle(mask).display !== 'none' : false,
  };
})()`;
