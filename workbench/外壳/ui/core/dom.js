// ui/core/dom.js —— 极简 DOM 助手
//
// 不引入虚拟 DOM，只做三件事：
// 1) h()    声明式创建元素（比 innerHTML 安全，不用拼字符串）
// 2) frag() 批量插入（减少 reflow）
// 3) mount() 替换挂载（幂等，多次调用不重复插）

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'path', 'circle', 'ellipse', 'line', 'rect', 'polygon', 'polyline',
  'g', 'defs', 'linearGradient', 'radialGradient', 'stop', 'text', 'tspan',
  'clipPath', 'mask', 'use', 'image', 'marker', 'pattern', 'filter',
]);

/** 事件名归一：onclick -> click，oninput -> input */
function normEvent(name) {
  return name.slice(2).toLowerCase();
}

/**
 * h(tag, props?, ...children)
 *   tag: 'div' / 'span' / 'svg:circle' / 组件函数
 *   props: { class, id, style, onXxx, dataset, text, html, ...attrs }
 *   children: string | number | Node | array（null/undefined/false 忽略）
 */
export function h(tag, props, ...children) {
  // 组件函数：直接调用，返回值是 Node 或 Node 数组
  if (typeof tag === 'function') {
    return tag(Object.assign({}, props || {}, { children }));
  }

  const isSvg = SVG_TAGS.has(tag) || tag.startsWith('svg:');
  const realTag = tag.startsWith('svg:') ? tag.slice(4) : tag;
  const el = isSvg
    ? document.createElementNS(SVG_NS, realTag)
    : document.createElement(realTag);

  const p = props || {};
  for (const key of Object.keys(p)) {
    const val = p[key];
    if (val === undefined || val === null || val === false) continue;

    if (key === 'class' || key === 'className') {
      if (isSvg) el.setAttribute('class', String(val));
      else el.className = String(val);
    } else if (key === 'style') {
      if (typeof val === 'string') {
        el.style.cssText = val;
      } else {
        for (const sk of Object.keys(val)) {
          if (val[sk] === undefined || val[sk] === null) continue;
          el.style.setProperty(sk.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }), String(val[sk]));
        }
      }
    } else if (key === 'text') {
      el.textContent = String(val);
    } else if (key === 'html') {
      el.innerHTML = String(val);   // 仅用于可控的静态片段
    } else if (key === 'dataset') {
      for (const dk of Object.keys(val)) el.dataset[dk] = String(val[dk]);
    } else if (key.startsWith('on') && typeof val === 'function') {
      el.addEventListener(normEvent(key), val, false);
    } else if (key === 'ref' && typeof val === 'function') {
      val(el);
    } else if (val === true) {
      el.setAttribute(key, '');
    } else if (!isSvg && key in el && key !== 'list' && key !== 'type') {
      // 直接赋值（value / checked / disabled 等）
      try { el[key] = val; } catch (e) { el.setAttribute(key, String(val)); }
    } else {
      el.setAttribute(key, String(val));
    }
  }

  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === '') continue;
    if (Array.isArray(c)) { appendChildren(el, c); continue; }
    if (c instanceof Node) { el.appendChild(c); continue; }
    el.appendChild(document.createTextNode(String(c)));
  }
}

/** 文档片段：批量挂载，减少 reflow */
export function frag(...children) {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

/** 清空子节点（不销毁元素本身） */
export function clear(el) {
  if (!el) return el;
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * 挂载：替换 el 的全部子节点为内容。
 * 幂等 —— 同内容重复调用不重复插（用 signature 比对）。
 */
export function mount(el, content, signature) {
  if (!el) return el;
  if (signature !== undefined) {
    if (el.dataset.mountSig === String(signature)) return el;
    el.dataset.mountSig = String(signature);
  }
  clear(el);
  if (content == null) return el;
  if (Array.isArray(content)) appendChildren(el, content);
  else if (content instanceof Node) el.appendChild(content);
  else el.textContent = String(content);
  return el;
}

/** 一次性事件（触发后自动移除） */
export function once(el, type, fn, opts) {
  const handler = function (ev) {
    el.removeEventListener(type, handler, opts);
    fn(ev);
  };
  el.addEventListener(type, handler, opts);
  return () => el.removeEventListener(type, handler, opts);
}

/** 等待元素的下一帧（布局完成后再测量） */
export function nextFrame() {
  return new Promise(function (res) {
    requestAnimationFrame(function () { requestAnimationFrame(res); });
  });
}

/** 数字节流（滚动/resize 用） */
export function rafThrottle(fn) {
  let pending = false;
  let lastArgs = null;
  return function (...args) {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      fn.apply(null, lastArgs);
    });
  };
}

/** 元素查询快捷方式（scope 限定） */
export function qs(sel, scope) { return (scope || document).querySelector(sel); }
export function qsa(sel, scope) { return Array.from((scope || document).querySelectorAll(sel)); }

/** 设置属性批量 */
export function attrs(el, map) {
  for (const k of Object.keys(map)) {
    const v = map[k];
    if (v === undefined || v === null || v === false) el.removeAttribute(k);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  return el;
}

export const SVG = {
  /** SVG 常用构造：s(tag, attrs) */
  s(tag, attrMap, ...kids) {
    return h('svg:' + tag, attrMap, ...kids);
  },
};

export default { h, frag, clear, mount, once, nextFrame, rafThrottle, qs, qsa, attrs };
