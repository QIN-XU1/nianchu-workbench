window.__ModuleLoader__.load({
  id: '@local/dsh-my-panel',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // Baseline 模块：可直接 require，无需写进 dsh.client.external。
    // 失败时回落自绘 SVG，保证不白屏。
    let P = null;
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (_error) {
      P = null;
    }

    // ────────────────────────────────────────────────────────────────
    // 常量：主面板 key 与侧栏 list id 必须是同一个字符串
    // ────────────────────────────────────────────────────────────────
    const NS = 'myPanel';          // locale 命名空间
    const PANEL_ID = 'my-panel';   // sidebar.panellist.id === main.key

    // ────────────────────────────────────────────────────────────────
    // locale：zh 与 en 必须同时提供（client-locale 的硬性要求）
    // ────────────────────────────────────────────────────────────────
    const zh = {
      'panel': '我的面板',
      'title': '我的面板',
      'empty': '还没有内容。',
      'refresh': '刷新',
    };

    const en = {
      'panel': 'My panel',
      'title': 'My panel',
      'empty': 'Nothing here yet.',
      'refresh': 'Refresh',
    };

    // ────────────────────────────────────────────────────────────────
    // 样式：用组件内 <style> 元素渲染，卸载即移除。
    // 不要调用 styles.insert —— 那是 cordis-client-runner 动态包的
    // closure 符号，Module Loader 插件里不存在（见报告第 5 节）。
    // ────────────────────────────────────────────────────────────────
    const CSS = `
.mnp-root{position:absolute;inset:0;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.55;overflow:hidden;}
.mnp-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;
  padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);}
.mnp-title{font-weight:600;font-size:14px;}
.mnp-grow{flex:1 1 auto;}
.mnp-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;}
.mnp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.mnp-body{flex:1 1 auto;overflow:auto;padding:16px 18px;}
.mnp-empty{color:var(--dsw-alias-label-secondary);}
`;

    // ────────────────────────────────────────────────────────────────
    // 图标：primitives 的 Icon* 组件接收 { size, className }
    // 这里用 IconWorkspaceTreeOutlineRegular；取不到则自绘。
    // ────────────────────────────────────────────────────────────────
    function PanelIcon(props) {
      const size = (props && props.size) || 16;
      const Prim = P && P.IconWorkspaceTreeOutlineRegular;
      if (Prim) return h(Prim, { size: size });

      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        [
          h('rect', { key: 'a', x: 1.8, y: 1.8, width: 5, height: 4, rx: 1 }),
          h('rect', { key: 'b', x: 1.8, y: 10.2, width: 5, height: 4, rx: 1 }),
          h('rect', { key: 'c', x: 9.2, y: 6, width: 5, height: 4, rx: 1 }),
          h('path', { key: 'd', d: 'M6.8 3.8h1.2v10.4H6.8z' }),
        ],
      );
    }

    // ────────────────────────────────────────────────────────────────
    // 主面板组件：props 里带 t（因为注册项声明了 locale: NS）
    // ────────────────────────────────────────────────────────────────
    function MyPanel({ t }) {
      const [count, setCount] = React.useState(0);

      return h('div', { className: 'mnp-root' }, [
        h('style', { key: 'css', 'data-plugin-css': 'my-panel' }, CSS),
        h('div', { key: 'head', className: 'mnp-head' }, [
          h('span', { key: 't', className: 'mnp-title' }, t('title')),
          h('span', { key: 'g', className: 'mnp-grow' }),
          h(
            'button',
            {
              key: 'b',
              type: 'button',
              className: 'mnp-btn',
              onClick: () => setCount((n) => n + 1),
            },
            t('refresh') + ' (' + String(count) + ')',
          ),
        ]),
        h(
          'div',
          { key: 'body', className: 'mnp-body' },
          count === 0
            ? h('div', { className: 'mnp-empty' }, t('empty'))
            : h('div', null, 'clicks: ' + String(count)),
        ),
      ]);
    }

    // ────────────────────────────────────────────────────────────────
    // 插件体
    // ────────────────────────────────────────────────────────────────
    return {
      // inject 里的字符串是 Client Service 名（不是包名）。
      // 只要有 slots 就够；要 t 就再加 locale。
      inject: ['slots', 'locale'],

      apply(ctx) {
        // 1) 字典：register 返回 disposer，必须交给 ctx.effect 收集。
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'my-panel: dictionaries',
        );

        // 2) 绑定翻译函数（同一 ns 反复 bind 返回同一个引用，可安全闭包）。
        const t = ctx.locale.bind(NS);

        // 3) 侧栏入口（list 型）：id / order / label / locale
        //    label 用 thunk，语言切换时 owner 重新投影，不需要重新注册。
        //    回调必须 return 或 yield 注册产生的 disposer。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 100,
              label: () => t('panel'),
              locale: NS,
            },
            PanelIcon,
          ),
        );

        // 4) 主面板（keyed 型）：key 必须等于上面的 id，
        //    否则 layout.selectPanel(id) 会抛
        //    `layout.selectPanel: main panel "<id>" is not registered`。
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            MyPanel,
          ),
        );
      },
    };
  },
});
