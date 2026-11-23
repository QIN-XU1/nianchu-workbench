window.__ModuleLoader__.load({
  id: '@local/dsh-workbench-launcher',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function Icon(props) {
      const size = (props && props.size) || 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', 'aria-hidden': 'true',
      }, [
        h('rect', { key: 'a', x: 3, y: 5, width: 18, height: 14, rx: 2,
          stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
        h('path', { key: 'b', d: 'M3 9 L21 9', stroke: 'currentColor',
          strokeWidth: 1.2, opacity: 0.6 }),
        h('circle', { key: 'c', cx: 6.5, cy: 7, r: 1, fill: 'currentColor' }),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'workbench-launcher',
            order: 30,
            label: '工作台',
          }, Icon));
      },
    };
  },
});
