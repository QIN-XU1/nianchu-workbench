// ui/layout/split.js —— 可拖拽分栏
//
// 设计要点：
// 1) 纯 CSS Grid + 一个拖拽手柄，不依赖第三方库。
// 2) 宽度持久化（localStorage），重启保持。
// 3) 支持上下限约束 + 双击复位 + 键盘微调（可访问性）。
// 4) 窄窗口自动收起（<阈值时右栏折叠），避免溢出。
// 5) 拖拽用 pointer events（同时支持鼠标/触控/笔）。

const STORE_KEY = 'wb.split.v1';

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function savePrefs(obj) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
}

/**
 * createSplit({ container, main, side, opts })
 * @param {HTMLElement} container  外层（会被设为 grid）
 * @param {HTMLElement} main       主内容
 * @param {HTMLElement} side       右栏
 * @param {object} opts
 *   id: string          持久化键（多处分栏要区分）
 *   sideWidth: number   初始宽度（默认 320）
 *   minSide: number     最小宽度（默认 240）
 *   maxSide: number     最大宽度（默认 560）
 *   minMain: number     主内容最小宽度（默认 420）
 *   collapseAt: number  窗口宽度低于此值时自动收起（默认 1100）
 *   onResize: fn(width)
 */
export function createSplit({ container, main, side, opts }) {
  const o = Object.assign({
    id: 'default', sideWidth: 320, minSide: 240, maxSide: 560,
    minMain: 420, collapseAt: 1100,
  }, opts || {});

  const prefs = loadPrefs();
  let width = Number(prefs[o.id]) || o.sideWidth;
  let collapsed = false;
  let dragging = false;

  // ═══ 手柄 ═══
  const handle = document.createElement('div');
  handle.className = 'wb-split-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('tabindex', '0');
  handle.title = '拖拽调整宽度 · 双击复位';

  container.classList.add('wb-split');
  container.appendChild(main);
  container.appendChild(handle);
  container.appendChild(side);

  function clamp(v) {
    const cw = container.clientWidth || 1000;
    const maxByMain = cw - o.minMain;
    const hi = Math.max(o.minSide, Math.min(o.maxSide, maxByMain));
    return Math.max(o.minSide, Math.min(hi, v));
  }

  function apply() {
    const w = collapsed ? 0 : clamp(width);
    container.style.gridTemplateColumns = collapsed
      ? 'minmax(0, 1fr) 0px 0px'
      : 'minmax(0, 1fr) 5px ' + Math.round(w) + 'px';
    handle.style.display = collapsed ? 'none' : '';
    side.style.display = collapsed ? 'none' : '';
    if (typeof o.onResize === 'function') {
      try { o.onResize(collapsed ? 0 : Math.round(w)); } catch (e) { /* 忽略 */ }
    }
  }

  function setWidth(v, persist) {
    width = v;
    if (persist !== false) {
      const cur = loadPrefs();
      cur[o.id] = Math.round(width);
      savePrefs(cur);
    }
    apply();
  }

  // ═══ 拖拽 ═══
  let startX = 0;
  let startW = 0;

  function onDown(ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    dragging = true;
    startX = ev.clientX;
    startW = side.getBoundingClientRect().width;
    handle.setPointerCapture?.(ev.pointerId);
    handle.classList.add('wb-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    ev.preventDefault();
  }

  function onMove(ev) {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    // 向右拖 → 右栏变窄（因为右栏在右侧）
    width = startW - dx;
    apply();
  }

  function onUp(ev) {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture?.(ev.pointerId);
    handle.classList.remove('wb-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setWidth(clamp(width));
  }

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);

  // 双击复位
  handle.addEventListener('dblclick', function () { setWidth(o.sideWidth); });

  // 键盘微调（可访问性）
  handle.addEventListener('keydown', function (ev) {
    const step = ev.shiftKey ? 40 : 10;
    if (ev.key === 'ArrowLeft') { setWidth(clamp(width - step)); ev.preventDefault(); }
    else if (ev.key === 'ArrowRight') { setWidth(clamp(width + step)); ev.preventDefault(); }
    else if (ev.key === 'Home') { setWidth(o.sideWidth); ev.preventDefault(); }
  });

  // ═══ 窄窗口自动收起 ═══
  const ro = new ResizeObserver(function () {
    const cw = container.clientWidth || 0;
    const shouldCollapse = cw > 0 && cw < o.collapseAt;
    if (shouldCollapse !== collapsed) {
      collapsed = shouldCollapse;
      apply();
    } else if (!collapsed) {
      apply();   // 宽度变化后重新 clamp
    }
  });
  ro.observe(container);

  apply();

  return {
    setWidth: (v) => setWidth(v),
    getWidth: () => (collapsed ? 0 : clamp(width)),
    toggle() { collapsed = !collapsed; apply(); return collapsed; },
    isCollapsed: () => collapsed,
    destroy() {
      ro.disconnect();
      handle.remove();
      if (side.parentNode === container) container.removeChild(side);
      if (main.parentNode === container) container.removeChild(main);
    },
  };
}

export default createSplit;
