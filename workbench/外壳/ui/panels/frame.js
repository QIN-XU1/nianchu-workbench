// ui/panels/frame.js —— 面板容器（宿主自动装配部分）
//
// ══════════════════════════════════════════════════════════════════════════
//  原项目设计（research/repos/luanyujia-full/01-场景模式/面板通用能力.md）
// ══════════════════════════════════════════════════════════════════════════
//
//  宿主替面板准备好的东西：
//  ┌───────────────────────────────────────────────────────────────┐
//  │ [01] 标题  小字                    [自定义按钮…]  [▲]        │
//  │ ───────────────────────────────────────────────────────────── │
//  │                                                               │
//  │  面板正文（渲染器自己画）                                       │
//  │                                                               │
//  └───────────────────────────────────────────────────────────────┘
//
//  部件说明：
//   序号徽标 01   ← 面板在场景 json 里的顺序（补零两位）
//                 方便口头指认"第 3 个窗口"
//   标题          ← 面板的 title
//   小字          ← 面板的 sub（状态/路径），渲染器可随时更新
//   ▲ 展开到最高  ← AI 面板默认；其它写 "expand": true
//                 临时占满网格高度，再点收起，ESC 也能收
//   自定义按钮    ← 渲染器通过 head.appendChild(...) 追加（靠右）
//
//  数据分区（关键）：
//    宿主组装面板时往 meta 里注入 scenario 字段，
//    面板用它给存储键加前缀：'my-panel:' + meta.scenario + ':' + meta.id
//    why：同一面板类型会被多个场景复用，不带前缀会互相覆盖。

/**
 * 创建面板容器
 * @param {object} panel    面板定义（场景 json 里的一个对象）
 * @param {string} sceneId  所属场景 id
 * @param {number} index    面板序号（0-based）
 * @returns {object} { el, head, body, meta, setSub, setExpanded, ... }
 */
export function createPanelFrame(panel, sceneId, index) {
  const p = panel || {};

  // ═══ 容器 ═══
  const el = document.createElement('div');
  el.className = 'wb-panel';
  el.dataset.panelType = String(p.type || 'unknown');
  el.dataset.panelId = String(p.id || '');
  el.dataset.scenario = String(sceneId || '');
  el.style.cssText =
    'min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column;' +
    'background:var(--s2,var(--color-panel, var(--color-panel, var(--color-panel, #121518))));border-radius:var(--r1,4px);position:relative;';

  // ═══ 标题栏（宿主自动装配）═══
  const head = document.createElement('div');
  head.className = 'wb-panel-head';
  head.style.cssText =
    'flex:0 0 24px;display:flex;align-items:center;gap:6px;padding:0 6px;' +
    'background:var(--s3,var(--color-raised, var(--color-raised, #181C20)));border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));' +
    'font:11px "JetBrains Mono",monospace;color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)));' +
    'white-space:nowrap;overflow:hidden;user-select:none;';

  // 序号徽标 01/02（补零两位）
  const numEl = document.createElement('span');
  numEl.className = 'wb-panel-num';
  // ⚠ 2026-11-14 修：这里内联写了 color:var(--t4,#5b6470)
  //
  //   内联样式优先级**高于**任何 CSS 规则，
  //   所以 refined.css 里 .wb-panel-num { color: var(--rf-text3) } 永远被它压住。
  //   这就是为什么我改了半天 CSS 都没效果 —— 元素上是内联的 --t4（旧变量）。
  //   实测：--rf-text3 = rgba(23,23,26,.74) 但 computed color = rgba(23,23,26,.48)
  //        （--t4 指向 quaternary）
  //
  //   修法：颜色交给 CSS（.wb-panel-num 已经在 refined.css 里定义），
  //        内联只留布局属性。**颜色/字号这类主题相关的值不该内联。**
  numEl.style.cssText =
    'flex:0 0 auto;font-variant-numeric:tabular-nums;letter-spacing:0;';
  numEl.textContent = String((index || 0) + 1).padStart(2, '0');
  numEl.title = '第 ' + ((index || 0) + 1) + ' 个面板';

  // 标题
  const titleEl = document.createElement('span');
  titleEl.className = 'wb-panel-title';
  titleEl.style.cssText =
    'flex:0 1 auto;font-weight:600;color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)));' +
    'overflow:hidden;text-overflow:ellipsis;min-width:0;';
  titleEl.textContent = String(p.title || p.type || '面板');

  // 小字（状态/路径）
  const subEl = document.createElement('span');
  subEl.className = 'wb-panel-sub';
  subEl.style.cssText =
    'flex:0 1 auto;font-size:9.5px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));' +
    'overflow:hidden;text-overflow:ellipsis;min-width:0;';
  subEl.textContent = String(p.sub || '');

  const spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1 1 auto;min-width:2px;';

  // 自定义按钮区（渲染器追加到这里）
  const actions = document.createElement('span');
  actions.className = 'wb-panel-actions';
  actions.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:3px;';

  // ▲ 展开到最高（AI 面板默认开启）
  const expandable = (p.type === 'harness') || (p.expand === true);
  const btnExpand = document.createElement('button');
  btnExpand.className = 'wb-panel-expand';
  btnExpand.textContent = '▲';
  btnExpand.title = '展开到最高（ESC 收起）';
  btnExpand.style.cssText =
    'flex:0 0 auto;width:16px;height:16px;display:grid;place-items:center;' +
    'background:transparent;border:none;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));' +
    'font-size:9px;cursor:pointer;border-radius:2px;padding:0;';
  if (!expandable) btnExpand.style.display = 'none';

  head.appendChild(numEl);
  head.appendChild(titleEl);
  head.appendChild(subEl);
  head.appendChild(spacer);
  head.appendChild(actions);
  head.appendChild(btnExpand);

  // ═══ 正文 ═══
  const body = document.createElement('div');
  body.className = 'wb-panel-body';
  body.dataset.kind = String(p.type || '');
  body.style.cssText = 'flex:1 1 auto;min-height:0;overflow:auto;position:relative;';

  el.appendChild(head);
  el.appendChild(body);

  // ═══ meta：面板 json 原样 + 宿主注入 scenario ═══
  //  ⚠ 关键：面板用 meta.scenario 给存储键加前缀，避免跨场景覆盖
  const meta = Object.assign({}, p, {
    scenario: String(sceneId || ''),
    index: index || 0,
  });

  // ═══ 展开/收起 ═══
  let expanded = false;
  let placeholder = null;

  function setExpanded(on) {
    if (on === expanded) return;
    expanded = !!on;

    if (expanded) {
      // 原格插一个占位格把版面钉住
      placeholder = document.createElement('div');
      placeholder.style.cssText = el.style.cssText.replace(/position:relative/, 'position:relative');
      placeholder.style.gridColumn = el.style.gridColumn;
      placeholder.style.gridRow = el.style.gridRow;
      placeholder.style.visibility = 'hidden';
      placeholder.style.pointerEvents = 'none';
      el.parentNode.insertBefore(placeholder, el);

      // 面板改成覆盖层
      el.style.position = 'absolute';
      el.style.left = 'var(--sp1,4px)';
      el.style.right = 'var(--sp1,4px)';
      el.style.top = 'var(--sp1,4px)';
      el.style.bottom = 'var(--sp1,4px)';
      el.style.gridColumn = 'auto';
      el.style.gridRow = 'auto';
      el.style.zIndex = 'var(--zFloat,100)';
      el.style.boxShadow = 'var(--sh3,0 6px 18px rgba(0,0,0,.42))';
      btnExpand.textContent = '▼';
      btnExpand.title = '收起（ESC）';
    } else {
      el.style.position = '';
      el.style.left = '';
      el.style.right = '';
      el.style.top = '';
      el.style.bottom = '';
      el.style.zIndex = '';
      el.style.boxShadow = '';
      if (placeholder) {
        el.style.gridColumn = placeholder.style.gridColumn;
        el.style.gridRow = placeholder.style.gridRow;
        placeholder.remove();
        placeholder = null;
      }
      btnExpand.textContent = '▲';
      btnExpand.title = '展开到最高（ESC 收起）';
    }
  }

  btnExpand.addEventListener('click', function (ev) {
    ev.stopPropagation();
    setExpanded(!expanded);
  });

  function onKey(ev) {
    if (ev.key === 'Escape' && expanded) {
      ev.stopPropagation();
      setExpanded(false);
    }
  }
  document.addEventListener('keydown', onKey);

  // ═══ API ═══
  const api = {
    el,
    head,
    body,
    meta,
    actions,
    panel: p,
    sceneId,
    index,

    /** 更新标题栏小字（渲染器可随时更新状态）*/
    setSub(text) {
      subEl.textContent = String(text || '');
    },

    /** 往标题栏右侧加控件（渲染器用）*/
    addAction(node) {
      if (node) actions.appendChild(node);
      return node;
    },

    setExpanded,
    isExpanded: () => expanded,

    /** 面板数据分区键（存储用）*/
    storageKey(name) {
      return String(name || 'panel') + ':' + sceneId + ':' + (p.id || '');
    },

    destroy() {
      document.removeEventListener('keydown', onKey);
      if (placeholder) { try { placeholder.remove(); } catch (e) {} }
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };

  return api;
}

/**
 * 创建标准的标题栏小按钮（渲染器常用）
 */
export function makeHeadButton(label, title, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (title) b.title = title;
  b.style.cssText =
    'height:16px;padding:0 4px;background:transparent;border:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));' +
    'color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font:9.5px "JetBrains Mono",monospace;' +
    'border-radius:2px;cursor:pointer;white-space:nowrap;';
  b.addEventListener('click', function (ev) {
    ev.stopPropagation();
    if (onClick) onClick(ev);
  });
  return b;
}

export default createPanelFrame;
