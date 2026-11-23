/**
 * 状态条插件（示范）
 *
 * 这是**运行时从磁盘加载**的浏览器 ESM，不参与 Vite 构建。
 * 改这里的任何一行，刷新页面即生效 —— 不需要 npm run build，不需要重启服务。
 *
 * 为什么值得单独做一条通道：
 *   应用外壳（React 组件、路由、样式基座）改动需要整体构建（实测 46.72s）。
 *   而「调一行文案、改一个数字展示」这类手感类改动占了产品迭代的大头，
 *   它们不该被 46 秒的构建挡住。
 *
 * 2026-11-22 调整：原来把「宿主 N 个方法 · 插件 v1 · 免构建加载」直接摆在界面上，
 * 这是**开发期调试信息**，不该常驻产品界面。现在收成右侧一个小胶囊（只说扩展已加载），
 * 具体数字进 title 悬浮提示 —— 能力没变，界面不再像 demo。
 *
 * 契约：
 *   export function mount(root: HTMLElement, ctx: { React, api }) → () => void（unmount）
 */
export const VERSION = 'v1';

export async function mount(root, ctx) {
  const { React } = ctx;

  const el = document.createElement('div');
  el.className = 'uip-status';
  el.setAttribute('data-ui-plugin', 'status-bar');
  root.appendChild(el);

  let hostMethods = null;
  try {
    const r = await fetch('/api/host-status', { cache: 'no-store' });
    const j = await r.json();
    hostMethods = Array.isArray(j.implemented) ? j.implemented.length : null;
  } catch {
    hostMethods = null;
  }

  // 样式跟着外壳的主题令牌走，暗色主题下也不突兀。
  // 挂到 <head> 而不是胶囊内部：否则 el.textContent 会把样式文本也算进可见内容。
  const style = document.createElement('style');
  style.setAttribute('data-ui-plugin-style', 'status-bar');
  style.textContent = `
    .uip-status { display: flex; justify-content: flex-end; padding: 2px 14px 4px; }
    .uip-status__chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 8px; border-radius: 999px; cursor: default;
      font-size: 10px; line-height: 1;
      color: var(--openbitfun-color-content-muted, #6a6a6a);
      background: var(--openbitfun-color-surface-subtle, rgba(16, 26, 39, .03));
    }
    .uip-status__dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--openbitfun-color-status-success-content, #12722a);
    }
  `;
  document.head.appendChild(style);

  const chip = document.createElement('span');
  chip.className = 'uip-status__chip';
  chip.title = '宿主 ' + (hostMethods ?? '?') + ' 个方法 · 插件 status-bar ' + VERSION
    + ' · 免构建加载（改 ui-plugins/ 刷新即生效）';

  const dot = document.createElement('span');
  dot.className = 'uip-status__dot';
  const text = document.createElement('span');
  text.textContent = '扩展已加载';
  chip.appendChild(dot);
  chip.appendChild(text);
  el.appendChild(chip);

  void React; // 需要时可切换成 React 渲染；目前保持零依赖

  return () => {
    el.remove();
    style.remove();
  };
}
