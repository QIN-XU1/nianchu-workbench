// ui/layout/shell.js —— 三段式应用骨架
//
// ┌──────────────────────────────────────────────────────┐
// │  titlebar  (40px)  brand · 状态 · 窗口控制            │
// ├──────────────────────────────────────────────────────┤
// │  scenebar  (34px)  场景标签                           │
// ├────────────────────────────────┬─────────────────────┤
// │  main (minmax(0,1fr))          │  side (300px)       │
// │  场景面板网格                   │  主 Agent            │
// └────────────────────────────────┴─────────────────────┘
//
// 类名约定见 ui/styles/layout.css（wb- 前缀）。

import { h, clear } from '../core/dom.js';
import { createSplit } from './split.js';

// 【2026-11-17 加】场景图标表 —— UI 从 renderer/ 迁到 ui/ 时原 ICONS 表丢失，
// 导致所有场景标签退化成通用圆点 ◦。这里按场景语义恢复。
const SCENE_ICONS = {
  hub: '◈', research: '🔍', 'competitor-analyze': '⚔', 'reverse-eng': '⟲',
  'arch-review': '⌂', 'build-plan': '☰', 'frontend-craft': '◧', 'backend-craft': '◨',
  'self-review': '↻', 'incident-analysis': '⚠', 'pc-cleanup': '⌫', 'tool-forge': '⚒',
};
function sceneIcon(id) { return SCENE_ICONS[String(id || '')] || '◦'; }


/**
 * 创建应用骨架
 * @param {object} opts { onSceneSelect, onWinAction, onSideResize }
 * @returns {object} shell API
 */
export function createShell(opts) {
  const o = opts || {};

  // ═══ 标题栏 ═══
  const brandDot = h('span', { class: 'wb-brand-dot' });
  const brandText = h('span', { text: 'DSH 工作台' });
  const brand = h('div', { class: 'wb-brand' }, brandDot, brandText);

  const statusSlot = h('div', { class: 'wb-statuses', style: { display: 'flex', gap: 'var(--sp1)' } });
  const spacer = h('div', { class: 'wb-titlebar-spacer' });

  const winBtns = h('div', { class: 'wb-winbtns' },
    winBtn('min', 'minimize', 'M4 8h12'),
    winBtn('max', 'toggleMaximize', 'M3 3h10v10H3z'),
    winBtn('close', 'close', 'M4 4l8 8M12 4l-8 8')
  );

  const titlebar = h('div', { class: 'wb-titlebar' }, brand, statusSlot, spacer, winBtns);

  function winBtn(label, act, pathD) {
    const svg = h('svg', { class: 'icon', viewBox: '0 0 16 16' },
      h('path', { d: pathD })
    );
    const b = h('button', {
      class: 'wb-winbtn',
      title: label,
      'data-act': act,
      onclick: function () {
        if (typeof o.onWinAction === 'function') o.onWinAction(act);
      },
    }, svg);
    return b;
  }

  /**
   * 设置状态徽标
   * @param {Array} list [{ text, state:'ok'|'warn'|'err'|'', title }]
   */
  function setStatus(list) {
    clear(statusSlot);
    for (const s of list || []) {
      const dot = h('span', { class: 'wb-status-dot' });
      statusSlot.appendChild(
        h('span', {
          class: 'wb-status',
          'data-state': s.state || '',
          title: s.title || s.text || '',
        }, dot, h('span', { text: String(s.text || '') }))
      );
    }
  }

  // ═══ 场景栏 ═══
  const scenebar = h('div', { class: 'wb-scenebar' });

  let scenes = [];
  let activeId = '';

  function setScenes(list, active) {
    scenes = Array.isArray(list) ? list : [];
    if (active !== undefined) activeId = String(active || '');
    clear(scenebar);
    for (const s of scenes) {
      const id = String(s.id || '');
      const busy = s.busy ? '1' : '0';
      const tab = h('button', {
        class: 'wb-scenetab',
        'data-active': (id === activeId ? '1' : '0'),
        'data-busy': busy,
        title: s.name || id,
        onclick: function () {
          if (typeof o.onSceneSelect === 'function') o.onSceneSelect(id);
        },
      },
        h('span', { class: 'wb-scenetab-icon', text: sceneIcon(id) }),
        h('span', { text: String(s.name || id) })
      );
      scenebar.appendChild(tab);
    }
    scenebar.appendChild(h('div', { class: 'wb-scenebar-spacer' }));
  }

  function setActiveScene(id) {
    activeId = String(id || '');
    const tabs = scenebar.querySelectorAll('.wb-scenetab');
    tabs.forEach(function (t) {
      t.dataset.active = (t.title && t.title === findName(activeId)) ? '1' : '0';
    });
    // 更稳妥：按下标同步
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].dataset.active = (scenes[i] && String(scenes[i].id) === activeId) ? '1' : '0';
    }
  }
  function findName(id) {
    const s = scenes.find(function (x) { return String(x.id) === id; });
    return s ? String(s.name || s.id) : '';
  }

  // ═══ 主体 ═══
  const mainEl = h('div', { class: 'wb-main' });
  const gridEl = h('div', { class: 'wb-grid' });
  mainEl.appendChild(gridEl);

  const sideEl = h('div', { class: 'wb-side' });
  const splitHost = h('div', { class: 'wb-split' });

  const split = createSplit({
    container: splitHost,
    main: mainEl,
    side: sideEl,
    opts: {
      id: 'main-agent',
      // ★ 2026-11-11：300 → 400
      //   300px 下对话气泡太窄（AI 回复两行就折行），阅读体验差。
      //   400px 能放下一句完整中文长句，星盘仍有 1100px+。
      //   用户可拖 split 手柄自己调，偏好记在 localStorage。
      sideWidth: 400,
      minSide: 240,
      maxSide: 620,
      minMain: 420,
      collapseAt: 1180,
      onResize: function (w) {
        if (typeof o.onSideResize === 'function') o.onSideResize(w);
      },
    },
  });

  const body = h('div', { class: 'wb-body' }, splitHost);

  // ═══ 底部状态条 ═══
  const footLeft = h('div', { class: 'grow truncate' });
  const footRight = h('div', { class: 'nowrap' });
  const footbar = h('div', { class: 'wb-footbar' }, footLeft, h('div', { class: 'spacer' }), footRight);

  function setFoot(left, right) {
    if (left !== undefined) footLeft.textContent = String(left || '');
    if (right !== undefined) footRight.textContent = String(right || '');
  }

  // ═══ 组装 ═══
  const app = h('div', { class: 'wb-app' }, titlebar, scenebar, body, footbar);

  return {
    el: app,
    titlebar,
    scenebar,
    mainEl,
    gridEl,
    sideEl,
    split,
    footbar,
    setScenes,
    setActiveScene,
    setStatus,
    setFoot,
    /** 主内容网格列数（按面板 w 自动算）*/
    setColumns(n) {
      gridEl.style.gridTemplateColumns = 'repeat(' + Math.max(1, Number(n) || 1) + ', minmax(0, 1fr))';
    },
    mount(container) {
      clear(container);
      container.appendChild(app);
      return app;
    },
    destroy() {
      try { split.destroy(); } catch (e) { /* 忽略 */ }
      if (app.parentNode) app.parentNode.removeChild(app);
    },
  };
}

export default createShell;
