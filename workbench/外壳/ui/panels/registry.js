// ui/panels/registry.js —— 面板注册表（替代 1091 KB 的巨型 renderers 对象）
//
// 设计要点：
// 1) 按类型注册渲染器，每个渲染器是一个小模块，按需动态 import。
// 2) 渲染器契约：{ type, meta?, create(ctx) => { el, update?, destroy? } }
// 3) 未知类型 → 渲染降级卡片（不白屏、不抛错）。
// 4) 支持别名（旧的 type 名映射到新实现），便于渐进迁移。
// 5) 渲染失败被捕获并展示在面板内，便于定位。

const registry = new Map();
const aliases = new Map();
const loaders = new Map();   // type -> () => Promise<module>
const mounts = new Set();    // 活跃实例（用于统一销毁）

/**
 * 注册渲染器
 * @param {string} type
 * @param {Function|object} factory   create 函数，或 { create, meta }
 */
export function register(type, factory) {
  const t = String(type || '').trim();
  if (!t) throw new TypeError('[panels] type 不能为空');
  if (typeof factory === 'function') registry.set(t, { create: factory });
  else if (factory && typeof factory.create === 'function') registry.set(t, factory);
  else throw new TypeError('[panels] ' + t + ' 的 factory 无效');
  return api;
}

/** 注册懒加载渲染器 */
export function lazy(type, loader) {
  loaders.set(String(type), loader);
  return api;
}

/** 别名：old → new */
export function alias(oldType, newType) {
  aliases.set(String(oldType), String(newType));
  return api;
}

export function has(type) {
  const t = resolveType(type);
  return registry.has(t) || loaders.has(t);
}

export function types() {
  return [...new Set([...registry.keys(), ...loaders.keys()])];
}

function resolveType(type) {
  const t = String(type || '').trim();
  return aliases.get(t) || t;
}

async function getFactory(type) {
  const t = resolveType(type);
  if (registry.has(t)) return registry.get(t);
  if (loaders.has(t)) {
    const mod = await loaders.get(t)();
    const f = mod.default || mod.create || mod;
    const factory = typeof f === 'function' ? { create: f } : f;
    registry.set(t, factory);
    return factory;
  }
  return null;
}

/**
 * 渲染一个面板
 * @param {object} panel  场景 json 里的面板定义 { type, w, ... }
 * @param {object} ctx    渲染上下文 { state, bus, api, sceneId, index }
 * @returns {Promise<{ el, update?, destroy? }>}
 */
export async function render(panel, ctx) {
  const holder = document.createElement('div');
  holder.className = 'wb-panel';
  holder.dataset.panelType = String((panel && panel.type) || 'unknown');

  const factory = await getFactory(panel && panel.type);
  if (!factory) {
    holder.appendChild(degrade(panel && panel.type));
    return wrapInstance(holder, null);
  }

  try {
    const inst = factory.create(holder, panel, ctx || {});
    const out = (inst && typeof inst.then === 'function') ? await inst : inst;
    if (out && out instanceof Promise) await out;
    // 渲染器可能返回 { el, update, destroy } 或直接往 holder 里塞内容
    if (out && out.el && out.el !== holder) {
      holder.appendChild(out.el);
    }
    const handle = wrapInstance(holder, (out && typeof out === 'object') ? out : null);
    mounts.add(handle);
    return handle;
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[panels] ' + (panel && panel.type) + ' 渲染失败:', err);
    holder.appendChild(errorBox(panel && panel.type, err));
    return wrapInstance(holder, null);
  }
}

function wrapInstance(holder, inst) {
  return {
    el: holder,
    get inner() { return inst; },
    update(patch) {
      if (inst && typeof inst.update === 'function') {
        try { inst.update(patch); } catch (e) { if (typeof console !== 'undefined') console.warn('[panels] update 失败', e); }
      }
    },
    destroy() {
      try {
        if (inst && typeof inst.destroy === 'function') inst.destroy();
      } catch (e) { /* 忽略 */ }
      if (holder.parentNode) holder.parentNode.removeChild(holder);
      mounts.delete(this);
    },
  };
}

function degrade(type) {
  const d = document.createElement('div');
  d.className = 'wb-panel-degrade';
  d.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:6px;opacity:.55;font-size:11px;';
  d.innerHTML =
    '<div style="font-family:monospace;">未知面板类型</div>' +
    '<div style="font-family:monospace;color:var(--gu-huang-deep, #C49A3D);">' + escapeHtml(String(type || '(空)')) + '</div>';
  return d;
}

function errorBox(type, err) {
  const d = document.createElement('div');
  d.className = 'wb-panel-error';
  d.style.cssText = 'padding:10px;font:10px/1.6 monospace;color:var(--gu-chi-deep, #C04F42);overflow:auto;height:100%;white-space:pre-wrap;word-break:break-word;';
  d.textContent = '[面板 ' + String(type || '?') + ' 渲染失败]\n' + ((err && err.message) || String(err));
  return d;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
  });
}

/**
 * 渲染到一个已有的 frame（宿主容器已建好 标题/序号/▲）
 * 这是新的标准入口 —— 与 frame.js 配合使用
 * @param {object} frame   createPanelFrame 的返回值
 * @param {object} panel   面板定义
 * @param {object} ctx     渲染上下文
 * @returns {Promise<object>} { update, destroy }
 */
export async function renderInto(frame, panel, ctx) {
  if (!frame || !frame.body) return { update: function () {}, destroy: function () {} };

  const type = String((panel && panel.type) || '');
  const factory = await getFactory(type);

  if (!factory) {
    frame.body.appendChild(degrade(type));
    frame.setSub && frame.setSub('未注册');
    return { update: function () {}, destroy: function () {} };
  }

  try {
    // 渲染器签名（兼容两种）：
    //   A) (body, meta, head)   ← 原项目约定
    //   B) (host, panel, ctx)   ← 我的实现
    // 用函数长度 + 参数特征判断：优先尝试 A（3 参数且第一个是 DOM 元素期望），
    // 但现代实现多用 B。这里统一用 B，并额外提供 frame 上的原项目式接口。
    const inst = factory.create
      ? factory.create(frame.body, panel, Object.assign({ frame: frame }, ctx || {}))
      : factory(frame.body, panel, Object.assign({ frame: frame }, ctx || {}));

    const out = (inst && typeof inst.then === 'function') ? await inst : inst;

    // 兼容：如果渲染器返回 { el, update, destroy }
    if (out && out.el && out.el !== frame.body && out.el.nodeType === 1) {
      frame.body.appendChild(out.el);
    }

    const handle = {
      frame: frame,
      panel: panel,
      inner: out || null,
      update: function (patch) {
        if (out && typeof out.update === 'function') {
          try { out.update(patch); } catch (e) { console.warn('[registry] update 失败', e); }
        }
      },
      destroy: function () {
        try {
          if (out && typeof out.destroy === 'function') out.destroy();
        } catch (e) { /* 忽略 */ }
        try { if (frame.destroy) frame.destroy(); } catch (e) { /* 忽略 */ }
      },
    };
    return handle;
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.error('[registry] ' + type + ' 渲染失败:', err);
    }
    frame.body.appendChild(errorBox(type, err));
    frame.setSub && frame.setSub('渲染失败');
    return { update: function () {}, destroy: function () {} };
  }
}

/** 登记的 frame（供 destroyAll 统一清理） */
const frames = new Set();

export function trackFrame(frame) {
  if (frame) frames.add(frame);
  return frame;
}

/** 销毁所有 frame + 渲染器实例 */
export function destroyAllFrames() {
  for (const f of Array.from(frames)) {
    try { if (f._inst && f._inst.destroy) f._inst.destroy(); } catch (e) { /* 忽略 */ }
    try { if (f.destroy) f.destroy(); } catch (e) { /* 忽略 */ }
  }
  frames.clear();
  destroyAll();
}

/** 销毁所有活跃面板（场景切换用） */
export function destroyAll() {
  for (const m of Array.from(mounts)) {
    try { m.destroy(); } catch (e) { /* 忽略 */ }
  }
  mounts.clear();
}

export function activeCount() { return mounts.size; }

export const api = {
  register, lazy, alias, has, types, render, renderInto,
  destroyAll, destroyAllFrames, trackFrame, activeCount,
};

export default api;
