// ui/panels/base.js —— 面板基类
//
// 统一生命周期：create → mount → update → destroy
// 所有面板继承这个基类，避免每个渲染器重复实现清理逻辑。

import { h, clear } from '../core/dom.js';

/**
 * @typedef {object} PanelCtx
 * @property {object} state   状态容器
 * @property {object} bus     事件总线
 * @property {object} api     API 门面
 * @property {string} sceneId 所属场景
 * @property {number} index   面板序号
 */

export class PanelBase {
  /**
   * @param {HTMLElement} host  面板容器（registry 提供）
   * @param {object} panel      面板定义（来自场景 json）
   * @param {PanelCtx} ctx
   */
  constructor(host, panel, ctx) {
    this.host = host;
    this.panel = panel || {};
    this.ctx = ctx || {};
    this.destroyed = false;
    this._disposers = [];

    // 默认：建一个 head + body 的骨架，子类往 body 里塞内容
    this.head = h('div', { class: 'wb-panel-head' });
    this.body = h('div', { class: 'wb-panel-body' });
    this.el = h('div', { class: 'wb-panel' }, this.head, this.body);

    this.setTitle(String(this.panel.title || this.panel.type || '面板'));
  }

  // ═══ 生命周期钩子（子类覆写）═══
  /** 初始化 DOM（在 mount 之前）*/
  onCreate() {}
  /** 挂载后（此时已在文档里，可测量）*/
  onMount() {}
  /** 数据更新 */
  onUpdate(_patch) {}
  /** 销毁前清理 */
  onDestroy() {}

  // ═══ 由 registry 调用的统一入口 ═══
  mount() {
    if (this.destroyed) return;
    this.host.appendChild(this.el);
    this.onCreate();
    try { this.onMount(); } catch (e) { this.fail(e); }
  }

  update(patch) {
    if (this.destroyed) return;
    try { this.onUpdate(patch); } catch (e) { this.fail(e); }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.onDestroy(); } catch (e) { /* 忽略 */ }
    for (const off of this._disposers) {
      try { if (typeof off === 'function') off(); } catch (e) { /* 忽略 */ }
    }
    this._disposers.length = 0;
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  // ═══ 工具方法 ═══
  /** 注册一个需要随面板销毁的清理函数 */
  track(off) {
    if (typeof off === 'function') this._disposers.push(off);
    return off;
  }

  /** 订阅总线（自动解绑）*/
  on(pattern, fn) {
    const bus = this.ctx.bus;
    if (!bus) return () => {};
    const off = bus.on(pattern, fn);
    return this.track(off);
  }

  /** 订阅状态（自动解绑）*/
  watch(path, fn) {
    const st = this.ctx.state;
    if (!st) return () => {};
    const off = st.subscribe(path, fn);
    return this.track(off);
  }

  /** 设置面板标题 */
  setTitle(text) {
    clear(this.head);
    this.head.appendChild(h('span', { class: 'title', text: String(text || '') }));
    this.head.appendChild(h('div', { class: 'spacer' }));
    this.headSlot = h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--sp1)', flex: '0 0 auto' } });
    this.head.appendChild(this.headSlot);
  }

  /** 往面板头右侧加控件 */
  addHeadAction(node) {
    if (this.headSlot) this.headSlot.appendChild(node);
    return node;
  }

  /** 往面板头加徽标 */
  setBadge(text, tone) {
    if (!this.headSlot) return;
    let b = this.headSlot.querySelector('.wb-badge.__main');
    if (!b) {
      b = h('span', { class: 'wb-badge __main' });
      this.headSlot.appendChild(b);
    }
    b.dataset.tone = tone || '';
    b.textContent = String(text || '');
    b.style.display = text ? '' : 'none';
  }

  /** 显示空状态 */
  showEmpty(icon, title, hint) {
    clear(this.body);
    this.body.appendChild(
      h('div', { class: 'wb-empty' },
        h('div', { class: 'wb-empty-icon', text: icon || '∅' }),
        title ? h('div', { class: 'wb-empty-title', text: String(title) }) : null,
        hint ? h('div', { class: 'wb-empty-hint', text: String(hint) }) : null
      )
    );
  }

  /** 显示错误（不抛到控制台，直接展示在面板里）*/
  fail(err) {
    if (typeof console !== 'undefined') console.error('[' + (this.panel.type || '?') + ']', err);
    clear(this.body);
    this.body.appendChild(
      h('div', { class: 'wb-empty' },
        h('div', { class: 'wb-empty-icon', text: '!' , style: { color: 'var(--err)' } }),
        h('div', { class: 'wb-empty-title', text: '面板出错' }),
        h('div', { class: 'wb-empty-hint', text: (err && err.message) || String(err) })
      )
    );
    this.setBadge('错误', 'err');
  }

  /** 面板尺寸 */
  get size() {
    const r = this.el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }
}

/** 用 class 写渲染器的工厂约定（供 registry 使用） */
export function definePanel(Cls, opts) {
  return Object.assign(
    {
      create(host, panel, ctx) {
        const inst = new Cls(host, panel, ctx);
        inst.mount();
        return inst;
      },
    },
    opts || {}
  );
}

export default PanelBase;
