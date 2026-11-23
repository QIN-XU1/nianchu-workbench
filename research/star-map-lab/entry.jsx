import React from 'react';
import { createRoot } from 'react-dom/client';
import { SceneStarMap, SceneStarMapLegend, layoutForce2D, computeLayout } from './src/scene-star-map.js';

const data = window.__DATA__;

// 深浅色 / 尺寸 / 布局模式由 query 控制，方便无头截图与对照
const params = new URLSearchParams(location.search);
const theme = params.get('theme') || 'dark';
const w = Number(params.get('w') || 960);
const h = Number(params.get('h') || 340);
const mode = params.get('mode') || 'layered';

document.documentElement.dataset.theme = theme;

function App() {
  const [hover, setHover] = React.useState(params.get('hover') || null);
  const [sel, setSel] = React.useState(params.get('sel') || null);

  if (mode === 'force') {
    return React.createElement(ForceVariant, { hover, setHover, sel, setSel });
  }
  return React.createElement('div', { style: { width: w, padding: 16 } }, [
    React.createElement('div', { key: 'c', style: { width: w - 32, height: h } },
      React.createElement(SceneStarMap, {
        nodes: data.nodes,
        edges: data.edges,
        height: h,
        hoverId: hover,
        onHover: setHover,
        onSelect: setSel,
      })),
    React.createElement(SceneStarMapLegend, { key: 'l' }),
  ]);
}

/** 力导向对照：复用同一份数据，只换布局 */
function ForceVariant() {
  const nodes = data.nodes;
  const edges = data.edges;
  const lay = layoutForce2D(nodes, edges, w - 32, h);
  const layered = computeLayout(nodes, edges, w - 32, h);

  const arr = [...lay.pos.values()];
  let minD = Infinity;
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      minD = Math.min(minD, Math.hypot(arr[i].x - arr[j].x, arr[i].y - arr[j].y));
    }
  }
  window.__FORCE_LAYOUT__ = [...lay.pos.entries()].map(([id, p]) => ({
    id, x: +p.x.toFixed(1), y: +p.y.toFixed(1), r: +p.r.toFixed(1),
  }));
  window.__LAYERED_LAYOUT__ = [...layered.pos.entries()].map(([id, p]) => ({
    id, x: +p.x.toFixed(1), y: +p.y.toFixed(1), r: +p.r.toFixed(1),
  }));
  window.__FORCE_STATS__ = { minPairDistance: +minD.toFixed(1) };

  return React.createElement('div', {
    style: { width: w, padding: 16, color: '#ccc', font: '11px monospace', whiteSpace: 'pre' },
  }, JSON.stringify(window.__FORCE_STATS__));
}

createRoot(document.getElementById('root')).render(React.createElement(App));
