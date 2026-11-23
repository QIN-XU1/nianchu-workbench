// ui/index.js —— 应用启动入口
//
// 组装顺序：
//   1. core (bus / state / commands / dom)
//   2. api  (window.app.* 门面)
//   3. layout (shell / split)
//   4. panels (registry / base)
//   5. features (main-agent / neuron3d)  ← 可选，缺失则降级
//
// 对旧 renderer 的关系：完全独立，不加载 renderers.js。
// 通过环境变量 DSH_FRONTEND=v2 切换到本前端。

import { createBus, EVENTS } from './core/bus.js';
import { createState, STATE_PATHS } from './core/state.js';
import { createCommands } from './core/commands.js';
import { h, clear } from './core/dom.js';
import { createApi } from './api/index.js';
import { createShell } from './layout/shell.js';
import * as registry from './panels/registry.js';
import * as grid from './panels/grid.js';
import * as frameMod from './panels/frame.js';

const LOG = function () {
  const args = Array.prototype.slice.call(arguments);
  if (typeof console !== 'undefined') console.log.apply(console, ['[ui]'].concat(args));
};

export async function boot(container) {
  const host = container || document.getElementById('app') || document.body;

  // ═══ 1. 核心层 ═══
  const bus = createBus({
    onError(err, type) { LOG('总线错误', type, err); },
  });
  const state = createState({
    boot: { phase: 'starting', startedAt: Date.now() },
    scenes: [],
    scene: { active: '', layout: [] },
    mainAgent: { collapsed: false, busy: false, log: [] },
    neuron: { nodes: [], edges: [], lit: [] },
    engine: { ok: false, url: '' },
    // ═══ 4. 状态（UI 偏好）═══
  //   sideWidth: 主 Agent 侧栏宽度
  //
  //   ⚠ 2026-11-11：300 → 400
  //     300px 下对话气泡太窄（AI 回复两行就折行），阅读体验差。
  //     400px 能放下一句完整的中文长句，同时星盘仍有 1100px+。
  //     用户可以拖 split 手柄自己调（记住偏好）。
  ui: { sideWidth: 400, footLeft: '', footRight: '' },
    fault: [],
  });
  const commands = createCommands({ state, bus });

  // ═══ 2. API 层 ═══
  const api = createApi();
  api.commands = commands;   // 让 api 能触达命令系统（面板用）
  LOG('API 就绪', api.isElectron ? '(Electron)' : '(浏览器 demo 模式)');

  // ═══ 3. 骨架 ═══
  const shell = createShell({
    onSceneSelect(id) {
      commands.run('scene.switch', { id }).catch(function (e) { LOG('切场景失败', e); });
    },
    onWinAction(act) {
      if (!api.isElectron) return;
      const fn = api[act];
      if (typeof fn === 'function') fn();
      // win 命名空间兜底
      else if (api.win && typeof api.win[act] === 'function') api.win[act]();
    },
    onSideResize(w) {
      state.set(STATE_PATHS.UI + '.sideWidth', w);
    },
  });
  shell.mount(host);

  // 窗口最大化状态同步
  if (api.isElectron && api.isMaximized) {
    api.isMaximized().then(function (r) {
      if (r.ok && r.value) document.body.dataset.maximized = '1';
    });
  }

  // ═══ 4. 命令注册 ═══
  commands.register({
    id: 'scene.switch',
    label: '切换场景',
    async run(ctx, payload) {
      const id = String((payload && payload.id) || '');
      if (!id) throw new Error('场景 id 为空');
      state.set(STATE_PATHS.SCENE_ACTIVE, id);
      shell.setActiveScene(id);
      bus.emit(EVENTS.SCENE_CHANGE, { id });
      try { await renderScene(id); } catch (e) { LOG('渲染场景失败', id, e); }
      return id;
    },
  });

  commands.register({
    id: 'scene.reload',
    label: '重载当前场景',
    async run(ctx, payload) {
      const id = (payload && payload.id) || state.get(STATE_PATHS.SCENE_ACTIVE);
      await renderScene(id);
      return id;
    },
  });

  // ═══ 5. 场景渲染（网格引擎 + 面板容器）═══
  //
  // 对齐原项目设计（01-场景模式/布局与网格.md）：
  //   · scene.cols 决定列数（默认 4）
  //   · 面板按 col/row/w/h 精确摆放
  //   · 无坐标 → 自动补洞
  //   · 越界 → 告警并按实际列数渲染
  //   · 面板序号 01/02 + ▲展开 + scenario 注入（见 frame.js）
  async function renderScene(sceneId) {
    if (!sceneId) return;
    registry.destroyAll();
    clear(shell.gridEl);

    const r = await api.util.scene(sceneId);
    if (!r.ok || !r.scene) {
      shell.gridEl.appendChild(
        h('div', { class: 'wb-empty' },
          h('div', { class: 'wb-empty-icon', text: '∅' }),
          h('div', { class: 'wb-empty-title', text: '场景加载失败' }),
          h('div', { class: 'wb-empty-hint', text: (r.error && r.error.message) || '未知错误' })
        )
      );
      return;
    }

    const scene = r.scene;
    state.set(STATE_PATHS.SCENE_LAYOUT, scene.panels || []);

    // ★ 网格布局计算
    const layout = grid.computeLayout(scene);
    if (layout.warnings && layout.warnings.length) {
      for (const w of layout.warnings) LOG('布局告警: ' + w);
    }

    grid.applyGrid(shell.gridEl, layout);
    LOG('场景 ' + sceneId + ' 布局: ' + layout.cols + ' 列 × ' + layout.rows + ' 行，' +
      layout.cells.length + ' 个面板' + (layout.warnings.length ? '（' + layout.warnings.length + ' 条告警）' : ''));

    const ctxBase = { state, bus, api, commands, sceneId };

    // ★ 逐面板渲染（用 frame 容器）
    for (let i = 0; i < layout.cells.length; i++) {
      const cell = layout.cells[i];
      const p = cell.panel;

      // 创建宿主容器（序号/标题/小字/▲/scenario 注入）
      const frame = frameMod.createPanelFrame(p, sceneId, i);
      grid.applyCell(frame.el, cell);

      // 交给 registry 渲染器（渲染到 frame.body）
      try {
        const inst = await registry.renderInto(frame, p, Object.assign({ index: i }, ctxBase));
        frame._inst = inst;
      } catch (e) {
        LOG('面板 ' + (p.type || '?') + ' 渲染失败: ' + (e && e.message));
        frame.body.appendChild(
          h('div', { class: 'wb-empty' },
            h('div', { class: 'wb-empty-icon', text: '!' , style: { color: 'var(--err,#d05a4a)' } }),
            h('div', { class: 'wb-empty-title', text: '渲染失败' }),
            h('div', { class: 'wb-empty-hint', text: (e && e.message) || String(e) })
          )
        );
      }

      shell.gridEl.appendChild(frame.el);
      registry.trackFrame(frame);
    }

    bus.emit(EVENTS.PANEL_MOUNT, { sceneId, count: layout.cells.length, cols: layout.cols, rows: layout.rows });
  }


  // ═══ 6. 注册面板渲染器（必须先于场景渲染）═══
  //  这是新架构的核心：渲染器注册进 registry，按 panel.type 分派。
  //  插件式：每个渲染器一个小模块，失败不影响其他面板。
  const RENDERERS = [
    { type: 'neuron', path: './panels/neuron.js', name: '3D 神经元' },
    { type: 'harness', path: './panels/harness.js', name: 'AI 对话' },
    { type: 'embed', path: './panels/embed.js', name: '嵌入页' },
    { type: 'sf-board', path: './panels/sf-board.js', name: '晶体管' },
    { type: 'review-doc', path: './panels/review-doc.js', name: '审查文档' },
    { type: 'review-files', path: './panels/review-files.js', name: '审查文件' },
    { type: 'pc-drives', path: './panels/pc-drives.js', name: '磁盘' },
    { type: 'pc-toplarge', path: './panels/pc-toplarge.js', name: '大文件' },
    { type: 'pc-junk', path: './panels/pc-junk.js', name: '垃圾' },
    { type: 'pc-ledger', path: './panels/pc-ledger.js', name: '台账' },
    // 【2026-11-17 加】任务分派看板（主控台核心）
    { type: 'dispatch-board', path: './panels/dispatch-board.js', name: '任务分派' },
  ];

  const loaded = [];
  for (const r of RENDERERS) {
    try {
      const mod = await import(r.path);
      const factory = mod.default || mod.create;
      if (typeof factory === 'function') {
        registry.register(r.type, factory);
        loaded.push(r.type);
      }
    } catch (e) {
      // 渲染器缺失不算错误：registry 会渲染降级卡片
      LOG('渲染器 ' + r.type + ' 未就绪: ' + ((e && e.message) || e));
    }
  }
  LOG('已注册渲染器 ' + loaded.length + '/' + RENDERERS.length + ': ' + loaded.join(', '));

  // ══════════════════════════════════════════════════════════
  //  ★ 2026-11-11：读 URL 参数（分离窗口 / 验证模式）
  //
  //  main.js 打开窗口时传的 query：
  //    分离窗口：?scene=<id>&solo=1
  //    验证模式：?scene=<id>（DSH_BOOT_SCENE）
  //
  //  ⚠ 必须在外层作用域读 —— isSolo 后面要用于隐藏右栏，
  //    放在 try 块里会出 ReferenceError（启动超时就是这么来的）。
  // ══════════════════════════════════════════════════════════
  const urlParams = (function () {
    try {
      return new URLSearchParams(window.location.search || '');
    } catch {
      return null;
    }
  })();
  const wantScene = urlParams ? String(urlParams.get('scene') || '').trim() : '';
  const isSolo = urlParams ? String(urlParams.get('solo') || '') === '1' : false;

  // ═══ 7. 加载场景（中枢模式：不做场景标签栏）═══
  //
  // 用户要求：「场景不可预估，全权交给 AI 调度」
  //  → 场景不是 UI 标签，是 AI 的产物。
  //  → 场景数量不可预估，标签栏列不完。
  //  → 场景的可视化在左边的 3D 神经元里（亮起 = 正在调度）。
  //  → UI 只保留「中枢」一个入口。
  //
  // 但仍然加载场景列表进 state（AI 调度 / 神经元 / 面板渲染都要用）。
  try {
    const r = await api.util.scenes();
    if (r.ok) {
      state.set(STATE_PATHS.SCENES, r.items);

      // 中枢模式：场景不是 UI 标签，清空标签栏并把高度归零
      // ⚠ 不能设 display:none —— layout.css 的 .wb-app 是 4 行 grid，
      //    少一个子元素会让 body 被挤到第 2 行（实测塌陷成 34px）
      if (shell.scenebar) {
        shell.scenebar.style.height = '0';
        shell.scenebar.style.minHeight = '0';
        shell.scenebar.style.borderBottom = 'none';
        shell.scenebar.style.padding = '0';
        shell.scenebar.textContent = '';
      }
      // 同时把 grid 的第 2 行压到 0
      const appEl = document.querySelector('.wb-app');
      if (appEl) {
        appEl.style.gridTemplateRows =
          'var(--h-title) 0px minmax(0, 1fr) var(--h-foot)';
      }

      // ══════════════════════════════════════════════════════
      // 只进入中枢
      const hub = r.items.find(function (s) { return s.isHub; }) || r.items[0];

      // 优先用 URL 指定的场景（分离窗口）；没有就进中枢
      let bootScene = hub;
      if (wantScene) {
        const found = r.items.find(function (s) { return String(s.id) === wantScene; });
        if (found) {
          bootScene = found;
          LOG('URL 指定场景: ' + found.name + '（solo=' + isSolo + '）');
        } else {
          LOG('URL 指定的场景不存在: ' + wantScene + '，回退中枢');
        }
      }

      if (bootScene) {
        await commands.run('scene.switch', { id: bootScene.id });
        LOG(bootScene.id === (hub && hub.id) ? '已进入中枢: ' + bootScene.name
          : '已进入指定场景: ' + bootScene.name);
      }
    } else {
      LOG('场景列表加载失败', r.error);
      shell.setStatus([{ text: '场景加载失败', state: 'err' }]);
    }
  } catch (e) {
    LOG('场景列表异常', e);
  }

  // ══════════════════════════════════════════════════════════
  //  ★ 2026-11-11：solo 模式（分离窗口）
  //
  //  main.js 用 `?scene=<id>&solo=1` 打开单场景窗口，
  //  渲染层应该只画这一个场景 —— 隐藏右栏（主 Agent）和场景标签栏。
  //
  //  原来完全没处理 solo 参数 → 分离窗口和主窗口长得一样。
  // ══════════════════════════════════════════════════════════
  if (isSolo) {
    try {
      // 隐藏右栏：把 split 的第 3 列压到 0
      if (shell.sideEl) {
        shell.sideEl.style.display = 'none';
      }
      const splitEl = document.querySelector('.wb-split');
      if (splitEl) {
        splitEl.style.gridTemplateColumns = 'minmax(0, 1fr) 0px 0px';
      }
      // 隐藏分隔条
      const handle = document.querySelector('.wb-split-handle');
      if (handle) handle.style.display = 'none';
      LOG('solo 模式：已隐藏右栏');
    } catch (soloErr) {
      LOG('solo 模式处理失败（不影响主流程）', soloErr && soloErr.message);
    }
  }

  // ═══ 8. 主 Agent 面板（右栏）═══
  try {
    const maMod = await import('./panels/main-agent.js');
    const maFactory = maMod.default || maMod.create;
    if (typeof maFactory === 'function') {
      const inst = maFactory(shell.sideEl, { id: 'main-agent', type: 'main-agent' }, { state, bus, api, commands });
      window.__MAIN_AGENT = inst;
      LOG('主 Agent 已挂载');
    }
  } catch (e) {
    LOG('主 Agent 未就绪', e && e.message);
    shell.sideEl.appendChild(
      h('div', { class: 'wb-empty' },
        h('div', { class: 'wb-empty-icon', text: '◌' }),
        h('div', { class: 'wb-empty-title', text: '主 Agent 未就绪' }),
        h('div', { class: 'wb-empty-hint', text: 'panels/main-agent.js 待接入' })
      )
    );
  }

  // ══════════════════════════════════════════════════════════════
  //  ★ 2026-11-12 修（真实用户发现：9 个场景在界面上切不过去）
  //
  //  症状：
  //    · 9 个场景配置都在，但界面上看不到任何场景切换按钮
  //    · CDP 实测：.wb-scenebar 存在，但 tabCount=0、height=0px、childCount=0
  //    · 也就是说：scenebar 元素挂载了，但**从来没有往里塞过场景标签**
  //
  //  根因：
  //    shell.js 里 setScenes(list, active) 定义得好好的，
  //    连 onClick 都接到 o.onSceneSelect 了（→ commands.run('scene.switch')），
  //    但 **index.js 里从来没调用过 setScenes** ——
  //    `grep setScenes workbench/外壳/ui/index.js` 返回 0 次。
  //
  //  这是「看起来有实际是空」的教科书案例：
  //    代码全写好了、接口全接好了，就差最后一根线没连。
  //    结果就是 9 个场景全废，用户永远只能在中枢。
  //
  //  修法：启动完成后，拉一次场景列表，喂给 setScenes。
  // ══════════════════════════════════════════════════════════════
  (async function mountSceneTabs() {
    try {
      const r = await api.util.scenes();
      if (!r.ok || !r.items.length) {
        LOG('场景标签：取场景列表失败', r.error);
        return;
      }
      const list = r.items.map(function (it) {
        return { id: it.id, name: it.name || it.id, busy: false };
      });
      const cur = getSceneId() || (list[0] && list[0].id) || '';
      shell.setScenes(list, cur);
      LOG('场景标签已挂载：' + list.length + ' 个（当前 ' + cur + '）');
    } catch (e) {
      LOG('场景标签挂载失败', e);
    }
  })();

  // ═══ 9. 状态栏 ═══
  shell.setStatus([
    { text: api.isElectron ? 'Electron' : 'Demo', state: 'ok' },
  ]);
  shell.setFoot('就绪', '');

  state.batch(function () {
    state.set('boot.phase', 'ready');
    state.set('boot.readyAt', Date.now());
  });

  // 全局暴露（方便调试与测试）

  // ══════════════════════════════════════════════════════════
  //  switchScene —— 供神经元双击跳转使用
  //  自检：之前 __WB 没暴露场景切换，双击接不上
  //
  //  ★ 2026-11-11 修（真实用户发现 P2）：
  //    原来这里有 `let currentSceneId = null` 作为独立变量，
  //    但启动路径走的是 `commands.run('scene.switch')`（第 274 行），
  //    它只设 state、不碰这个变量 ⇒ 启动后 currentSceneId 永远是 null。
  //
  //    实测：启动完成在中枢，但 __WB.getCurrentScene() 返回 null。
  //
  //    修法：**删掉独立变量，一律从 state 派生**。
  //      state 是唯一真源（commands.run 和 switchScene 都会设它），
  //      派生出来的值不可能不同步。
  //
  //    这是「同一事实存两处 = 早晚打架」的又一例（参考项目全局铁律 §1）。
  // ══════════════════════════════════════════════════════════
  function getSceneId() {
    try { return state.get(STATE_PATHS.SCENE_ACTIVE) || null; } catch (e) { return null; }
  }

  async function switchScene(sceneId) {
    if (!sceneId) return false;
    if (sceneId === getSceneId()) return true;
    try {
      await renderScene(sceneId);
      if (state && state.set) state.set(STATE_PATHS.SCENE_ACTIVE, sceneId);

      // ══════════════════════════════════════════════════════
      //  ★ 写"当前场景"标记 —— 越界哨兵的 E 档检查依赖它
      //
      //  为什么需要：越界哨兵要判断"当前场景是否写了别人的地盘"，
      //  但前端/脚本/编辑器都没有"我是谁"的上下文。
      //  唯一的办法：切换场景时落一个标记文件。
      //
      //  失败不影响切场景（标记只是辅助，不是关键路径）。
      // ══════════════════════════════════════════════════════
      try {
        const dataDir = (api.paths && api.paths.dataDir) || api.dataDirRaw || '';
        if (dataDir && api.file && api.file.write) {
          const markerPath = dataDir.replace(/[\\/]+$/, '') + '\\当前场景';
          await api.file.write(markerPath, sceneId);
        }
      } catch (markErr) {
        LOG('写当前场景标记失败（不影响切场景）', markErr && markErr.message);
      }

      LOG('切换场景: ' + sceneId);
      return true;
    } catch (e) {
      LOG('切换场景失败', sceneId, e);
      return false;
    }
  }

  window.__WB = { state, bus, api, commands, shell, registry, boot: LOG };
  window.__WB.switchScene = switchScene;
  window.__WB.getCurrentScene = getSceneId;

  LOG('启动完成');
  return { state, bus, api, commands, shell, registry };
}

// 自动启动（除非显式声明 manual）
if (!window.__WB_MANUAL_BOOT) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      boot().catch(function (e) { LOG('启动失败', e); });
    });
  } else {
    boot().catch(function (e) { LOG('启动失败', e); });
  }
}

export default boot;
