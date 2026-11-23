// ui/panels/neuron.js —— 场景关系球（v7）
//
// ══════════════════════════════════════════════════════════════════════════
//  用户的完整设计意图（逐条）：
// ══════════════════════════════════════════════════════════════════════════
//
//  ① 「非必要画个球形，我希望将这些节点排列成球，就是围绕一个或多个球体散开，
//      更有一种行星之间的美感」
//     → 不画球体轮廓线，节点本身排成球面，有行星环绕的观感
//
//  ② 「按重要性分层想法很好，但是大多都是场景之间的，
//      这些并没有谁更重要这一说法」
//     → 场景是平等的，没有中心-边缘的层级
//
//  ③ 「不要将技能、记忆这些做入节点，
//      整个分支应该是由不同的场景互相做关联的」
//     → 图中只有场景节点，边是场景↔场景
//
//  ④ 「具体的场景其实可以做细分处理，比如说八字排盘和紫微斗数都算做一个场景，
//      但他们其实都是算做命理的节点」
//     → 双层结构：领域层 + 场景层
//
//  ⑤ 「每个场景所对应的记忆、角色卡、技能、mcp之类的，
//      可以做成与对应场景节点交互的显示」
//     → 附属物在点击时展开，不常驻图上
//
//  ⑥ 「这些场景节点我希望都可以支持拖拽」
//     → 节点可拖动
//
//  ⑦ 「整个视图支持360°旋转上角加个整理即可直接将之前的拖拽的节点返还成球形」
//     → 360 旋转 + 「整理」按钮复位
//
// ══════════════════════════════════════════════════════════════════════════
//  我补充的三点判断（与用户协同）
// ══════════════════════════════════════════════════════════════════════════
//
//  【补充 1】场景之间的边从哪来？—— 用现成的契约数据，不编造
//    sceneboard/scenes/<id>.json 里有：
//      inputs:  ["feature-matrix", ...]      ← 依赖的产物
//      outputs: [{ id:"architecture-plan", to:["build-plan"] }]  ← 产物流向
//    → 用 outputs.to 建边，这是**真实的依赖关系**，不是我瞎连的。
//
//  【补充 2】「多个球体」怎么理解 —— 我理解为"领域球"
//    当一个领域下有 3+ 个场景时，它们聚成一个小球；
//    多个领域就是多个小球，彼此之间有连线（跨领域流转）。
//    这正好回应"围绕一个或多个球体散开"。
//
//  【补充 3】拖拽后怎么"整理" —— 不是简单复位，而是保留分类
//    整理 = 按领域重新计算球面位置 + 平滑动画回位。
//    这样整理后仍能看出"命理球在哪、工程球在哪"。

import { Wuxing, inferPhase, Sancai, Siwen } from '../core/guoxue.js';
import {
  rotate3d, inverseRotate3d, project3d, normalize3,
} from './neuron-math.js';
import { hexA, esc } from './neuron-color.js';


const TAU = Math.PI * 2;

// ═══════════════════════════════════════════════════════════════
//  规模阈值（新场景涌入时的降级策略）
//    ≤100  全细节（光晕/标签/边/拖拽）
//    ≤500  降细节（关光晕、只显示主要标签、边淡化）
//    >500  聚合模式（按领域聚合，只显示领域球 + 数字）
//     实测：100 个最小间距 16.1px 无重叠；200 个开始重叠
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  节点数量的四档编排策略
//
//  用户需求："考虑节点数量变化时该如何编排、如何处理"
//
//  实测数据（来自压力测试）：
//    10 个   → 最小间距 79px   → 舒适
//    100 个  → 最小间距 16px   → 可辨
//    200 个  → 最小间距 13px   → 开始重叠
//    500 个  → 最小间距  6px   → 严重重叠
//
//  档位设计：
//    S  (≤24)    全部显示，全细节，体积分布
//    M  (25~120) 显示全部，标签只在悬停/选中时显示，光晕降低
//    L  (121~600) 按领域聚成"星团"，只画星点不画芒，标签稀疏
//    XL (>600)   分区聚合（每个领域变成一个"星团光斑"+数量）
// ═══════════════════════════════════════════════════════════════
const TIER_S_MAX = 24;      // S 档上限
const TIER_M_MAX = 120;     // M 档上限
const TIER_L_MAX = 600;     // L 档上限（超过则 XL）

/** 根据节点数判断当前档位 */
function getTier(n) {
  if (n <= TIER_S_MAX) return 'S';
  if (n <= TIER_M_MAX) return 'M';
  if (n <= TIER_L_MAX) return 'L';
  return 'XL';
}

const MAX_DETAIL_NODES = 100;
const MAX_MID_NODES = 500;

// ═══════════════════════════════════════════════════════════════
//  配色
// ═══════════════════════════════════════════════════════════════
//
//  ⚠ 2026-11-14 修（这是「三套色板并存」的最后一个残留）
//
//  原来 text 用的是 'var(--gu-bai, #E9E4DC)' —— 国学色板的**浅米白**。
//  那是给深色底设计的（深底 + 浅字）。
//  外壳切到浅色后（card #fcfcfc），这颗浅米白文字变成
//    对比度 1.14:1  → 完全看不见（体检报出来的最严重一处）
//
//  修法：所有文字色统一到 hermes 的 4 档（--ui-text-*）。
//       注意：这个对象里的值有的会进 Canvas（Canvas 不认 var()），
//       所以**只有纯 DOM 用的项才能用 token**。
//       下面标注了哪些是 DOM 专用。
const C = {
  // ── Canvas / 画布内浮层专用（必须实色，不能 var()）──
  //
  //  ⚠ 2026-11-14 关键区分：
  //    神经元面板的**画布本身是深色**（#05070A，天球背景，不跟随主题），
  //    画在上面的图例/HUD 文字因此必须是**浅色**。
  //
  //    实测问题：我把 C.text 改成 var(--ui-text-primary)（深色）后，
  //    深色文字贴在深色画布上 → 对比度 1.09:1，图例完全看不见。
  //
  //  ⇒ 判据：**文字颜色要看它实际的背景，不是看全局主题。**
  //    这个面板有两层：外层 chrome（跟主题，浅色）+ 内层画布（永远深色）。
  //    画布内的文字必须用浅色实值。
  bg: '#05070A',
  bgMid: '#0A0F15',
  bgEdge: '#020305',
  star: 'rgba(180,210,240,',
  core: '#E5C24A',
  edge: 'rgba(111,176,220,',

  // 画布内文字（深色底 → 浅色字）
  text: '#E9EDF2',      // 主：浅灰白
  text2: '#A8AEB8',     // 次
  text3: '#8A94A3',     // 辅
  text4: '#6E7580',     // 装饰
};

// 画布外的 DOM 文字（跟随主题）
const C_DOM = {
  text: 'var(--ui-text-primary, #17171a)',
  text2: 'var(--ui-text-secondary, #4b4b52)',
  text3: 'var(--ui-text-secondary, #5a5a62)',
};

// 领域配色（每个领域一色系）
// ═══════════════════════════════════════════════════════════════
//  配色：单色系（石青）+ 明度区分领域
//    用户说"球的配色太丑" —— 之前 5 个领域 5 色 + 高亮 3 色 = 8 色杂乱
//    现在：同一色系，靠**明度**区分（更高级）
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  配色：单色系冷白蓝（用户明确要求）
//    "单色系更极致：全部冷白蓝，不同领域只用大小/亮度区分"
//
//  色相统一在 210~215°（冷蓝），只在明度/饱和度上做极小差异
//  这样画面是"一片冷光"，靠大小和亮度区分领域，而不是靠颜色
// ═══════════════════════════════════════════════════════════════
// ⚠ 2026-11-14：这张表的颜色**必须写死十六进制**，不能用 CSS 变量。
//
//  为什么：这些值直接进 Canvas 的 hexA()/addColorStop()，
//  而 Canvas API 只接受真实颜色，`var(--x, #hex)` 会让 hexToRgb 解析出 NaN
//  → rgba(NaN,NaN,NaN,α) → addColorStop 抛 SyntaxError → 整个星图渲染中断。
//
//  实测代价：我一度把这整张表换成 var() 想「统一 token」，
//  结果神经元画布直接挂掉（[neuron] 加载失败）。
//  ⇒ Canvas 是 token 规则的**唯一例外**：面板 chrome 用 token，画布用实色。
//    如果将来要支持亮/暗主题切换这个画布，必须在这里按主题选不同的实色表，
//    而不是塞 var()。
const DOMAIN_COLOR = {
  mingli:  '#C8E4F5',   // 最亮（近白）
  tool:    '#A8D2EE',
  eng:     '#8FC4E8',
  content: '#7CB2DA',
  social:  '#6A9EC8',
  other:   '#5A8AB2',
};

// 领域 → 大小权重（面积差异比色差更自然）
const DOMAIN_SIZE = {
  mingli:  1.15,
  tool:    1.08,
  eng:     1.00,
  content: 0.95,
  social:  0.90,
  other:   0.85,
};

const DOMAIN_LABEL = {
  mingli: '命理',
  eng: '工程',
  content: '内容',
  tool: '工具',
  social: '关系',
  other: '其他',
};

// ═══════════════════════════════════════════════════════════════
//  领域推断（按场景 role/name 关键词）
// ═══════════════════════════════════════════════════════════════
const DOMAIN_RULES = [
  { id: 'mingli', kw: ['命理', '八字', '紫微', '斗数', '奇门', '六爻', '梅花', '易经', '占卜', '风水', '择日', '星相'] },
  { id: 'eng', kw: ['架构', '实施', '逆向', '管线', '工程', '代码', '部署', '测试', '性能', '安全'] },
  { id: 'content', kw: ['文档', '内容', '创作', '视频', 'B站', '图文', '调研', '竞品'] },
  { id: 'tool', kw: ['电脑', '磁盘', '清理', '配置', '环境', '工具', '维护'] },
  { id: 'social', kw: ['关系', '情感', '沟通', '军师', '复盘', '自我'] },
];

function inferDomain(scene) {
  const text = [
    scene.role || '', scene.name || '',
    scene.description || '', scene.id || '',
  ].join(' ').toLowerCase();

  for (const r of DOMAIN_RULES) {
    for (const k of r.kw) {
      if (text.indexOf(k.toLowerCase()) >= 0) return r.id;
    }
  }
  return 'other';
}


// ═══════════════════════════════════════════════════════════════
//  3D 数学
// ═══════════════════════════════════════════════════════════════

/**
 * rotate3d 的**正确逆运算**
 *
 * 正变换顺序：先绕 Y 轴转 yaw，再绕 X 轴转 pitch
 *   → 逆变换必须按相反顺序：先绕 X 轴转 -pitch，再绕 Y 轴转 -yaw
 *
 * 自检：之前直接调 rotate3d(v, -yaw, -pitch) 顺序是错的
 *       导致拖拽偏差随距离累积（实测 2px → 21px）
 */


/** 归一化到单位球 */

/**
 * 单球面摆放：给定 n 个节点，用球面螺旋排布（黄金角）
 * 这是最均匀的球面分布，无极点聚集
 */
function spherePositions(n, radius) {
  const out = [];
  const offset = 2 / n;
  const inc = Math.PI * (3 - Math.sqrt(5));   // 黄金角

  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) * offset;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * inc;
    out.push({
      x: Math.cos(phi) * r * radius,
      y: y * radius,
      z: Math.sin(phi) * r * radius,
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
//  渲染器
// ═══════════════════════════════════════════════════════════════
export function createNeuron3D(host, panel, ctx) {
  const api = ctx && ctx.api;

  // ── DOM ──
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:relative;display:flex;flex-direction:column;height:100%;overflow:hidden;background:' + C.bg;

  // 顶栏
  const bar = document.createElement('div');
  bar.style.cssText =
    'flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:4px 8px;' +
    'border-bottom:1px solid rgba(111,176,220,.08);' +
    'font:10px/1.2 "JetBrains Mono",monospace;';

  const stats = document.createElement('div');
  stats.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;flex:1 1 auto;min-width:0;';
  bar.appendChild(stats);

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜场景…';
  search.style.cssText =
    'flex:0 0 auto;width:88px;height:18px;background:var(--color-void, #0A0F15);border:1px solid var(--color-hover, var(--color-hover, #1A2028));' +
    'color:' + C.text + ';font:10px/1 "JetBrains Mono",monospace;padding:0 6px;' +
    'border-radius:2px;outline:none;';
  bar.appendChild(search);

  // ★ 「整理」按钮（用户要求）
  const btnTidy = document.createElement('button');
  btnTidy.textContent = '整理';
  btnTidy.title = '把拖动的节点复位成球形';
  btnTidy.style.cssText =
    'flex:0 0 auto;height:18px;padding:0 8px;background:rgba(111,176,220,.10);' +
    'border:1px solid rgba(111,176,220,.30);color:var(--gu-qing, #6FB0DC);' +
    'font:10px "JetBrains Mono",monospace;border-radius:2px;cursor:pointer;';
  bar.appendChild(btnTidy);

  // ★ 更新按钮（检测新场景）
  const btnRefresh = document.createElement('button');
  btnRefresh.textContent = '更新';
  btnRefresh.title = '检测新增/删除的场景';
  btnRefresh.style.cssText =
    'flex:0 0 auto;height:18px;padding:0 8px;background:rgba(111,176,220,.08);' +
    'border:1px solid rgba(111,176,220,.24);color:var(--gu-qing, #6FB0DC);' +
    'font:10px "JetBrains Mono",monospace;border-radius:2px;cursor:pointer;';
  bar.appendChild(btnRefresh);

  const btnReset = document.createElement('button');
  btnReset.textContent = '⟳';
  btnReset.title = '复位视角';
  btnReset.style.cssText =
    'flex:0 0 auto;height:18px;padding:0 6px;background:transparent;border:1px solid var(--color-hover, var(--color-hover, #1A2028));' +
    'color:' + C.text2 + ';font:10px "JetBrains Mono",monospace;border-radius:2px;cursor:pointer;';
  bar.appendChild(btnReset);

  wrap.appendChild(bar);

  const cv = document.createElement('canvas');
  cv.style.cssText = 'flex:1 1 auto;min-height:0;width:100%;display:block;cursor:grab;touch-action:none;';
  wrap.appendChild(cv);

  // ══════════════════════════════════════════════════════════════
  //  ★ 2026-11-11 加（真实用户发现 P0）：
  //    搜索无结果时必须明确告知。
  //
  //    用户实测：输入「zzzz不存在zzzz」，星盘 9 个节点一个不少，
  //    也没有任何提示 —— 用户不知道是「搜索坏了」还是「真没有」。
  //
  //    现在：搜不到就中心显示「没找到匹配的场景」+ 提示怎么清空。
  // ══════════════════════════════════════════════════════════════
  const emptyEl = document.createElement('div');
  emptyEl.style.cssText =
    'position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);' +
    'display:none;pointer-events:none;text-align:center;z-index:6;' +
    'font:11px/1.9 "JetBrains Mono",monospace;color:' + C.text3 + ';white-space:pre-line;';
  wrap.appendChild(emptyEl);

  const hintEl = document.createElement('div');
  hintEl.style.cssText =
    'position:absolute;left:10px;bottom:7px;font:9px "JetBrains Mono",monospace;' +
    'color:' + C.text4 + ';pointer-events:none;letter-spacing:.03em;';
  hintEl.textContent = '拖动旋转 · 拖节点移动 · 滚轮缩放 · 单击详情 · 双击进入场景';
  wrap.appendChild(hintEl);

  // ★ 详情面板（点击场景展开附属信息）
  const detail = document.createElement('div');
  detail.style.cssText =
    'position:absolute;right:10px;top:30px;width:260px;max-height:72%;overflow:auto;' +
    'background:rgba(10,14,20,.96);border:1px solid var(--color-raised, #1E2630);border-radius:5px;padding:10px;' +
    'font:10.5px/1.72 "JetBrains Mono",monospace;color:' + C.text + ';' +
    'display:none;z-index:5;box-shadow:0 12px 44px rgba(0,0,0,.8);backdrop-filter:blur(8px);';
  wrap.appendChild(detail);

  host.appendChild(wrap);

  const c2d = cv.getContext('2d');
  const DPR = window.devicePixelRatio || 1;

  // ═══════════════════════════════════════════════════════════
  //  状态
  // ═══════════════════════════════════════════════════════════
  const S = {
    scenes: [],         // 场景节点
    edges: [],          // 场景↔场景 边
    byId: {},
    yaw: 0.4,
    pitch: -0.25,
    zoom: 1,
    hover: null,
    sel: null,
    filter: '',
    ready: false,
    t: 0,
    // 拖拽
    draggingNode: null,
    rotating: false,
    lastX: 0,
    lastY: 0,
    animId: 0,
    destroyed: false,
    stars: [],
    // 整理动画
    tidying: false,
    tidyProgress: 1,
    radius: 0,
    layoutVersion: 0,
    // ★ 新场景支持
    lastSceneIds: [],       // 上次的场景 id 列表（判断新增/删除）
    newSceneIds: new Set(), // 新加入的场景（高亮提示）
    autoRefreshTimer: 0,    // 自动刷新定时器
    // ★ 鼠标状态（供背景互动）
    mouse: { x: 0, y: 0, nx: 0, ny: 0, inside: false },
    // ══════════════════════════════════════════════════════
    //  ★ 画布级 2D 变换（借鉴 Photoshop/ComfyUI）
    //    viewScale  —— 缩放倍数（1.0 = 原始）
    //    panX/panY  —— 平移偏移（画布像素）
    //  与 S.zoom 的区别：
    //    S.zoom     = 3D fov（透视缩放，会变形）
    //    S.viewScale = 2D 仿射（等比缩放，不变形）← 滚轮用这个
    // ══════════════════════════════════════════════════════
    viewScale: 1.0,
    panX: 0,
    panY: 0,
    // ★ 拖拽距离（用于区分 click vs drag）
    downX: null,
    downY: null,
    movedDist: 0,
    // ★ 拖拽快照（只在拖拽/旋转期间有效）
    //   自检修复：之前用 stickyFocus 记录"最后悬停节点"
    //             → 拖拽划过节点也记录 → 拖后仍高亮 = BUG
    //   现在：只在 pointerdown 时快照"已有焦点"，松手即清除
    dragSnapshot: null,
    // 背景星云团（前景节点会推开/吸引它们）
    bgParticles: null,
  };

  // ═══════════════════════════════════════════════════════════
  //  数据：只有场景 + 场景之间的关系
  // ═══════════════════════════════════════════════════════════
  async function loadData() {
    // ── 场景列表 ──
    let list = [];
    try {
      if (api && api.util && api.util.scenes) {
        const r = await api.util.scenes();
        if (r.ok) list = (r.items || []).filter(function (s) { return !s.isHub; });
      }
    } catch (e) { /* 降级 */ }

    // ── 场景契约（取 inputs/outputs 建边）──
    //
    //  ★ 自检修复：原来直接把场景配置当契约用
    //    但两者是不同文件：
    //      外壳/scenarios/<id>.json      = 场景配置（面板布局）
    //      sceneboard/scenes/<id>.json   = 场景契约（inputs/outputs）
    //    场景配置里没有 outputs → flow 边一条都建不出来
    //    → 神经元退化成全是 domain/similar 兜底连线
    //
    //  现在 main.js 把契约挂在 scene.contract 上，这里优先用它。
    const contracts = {};
    try {
      if (api && api.util && api.util.scene) {
        for (const s of list) {
          const r = await api.util.scene(s.id);
          if (r.ok && r.scene) {
            const sceneObj = r.scene;
            // 优先用契约；没有就退回场景配置（至少 role/description 还能用）
            contracts[s.id] = sceneObj.contract || sceneObj;
          }
        }
      }
    } catch (e) { /* 降级 */ }

    // ── 节点 ──
    const scenes = list.map(function (s, i) {
      const domain = inferDomain(s);
      return {
        id: s.id,
        name: s.name || s.id,
        domain: domain,
        role: (contracts[s.id] && contracts[s.id].role) || s.role
              || (contracts[s.id] && contracts[s.id].description) || s.description || '',
        desc: (contracts[s.id] && contracts[s.id].description) || s.description || '',
        color: DOMAIN_COLOR[domain] || DOMAIN_COLOR.other,
        r: 14,
        lit: false,
        // 球面坐标（layout 时算）
        sx: 0, sy: 0, sz: 0,
        // 拖拽后的位置（非球面）
        dx: 0, dy: 0, dz: 0,
        dragged: false,
        degree: 0,
      };
    });

    // ── 边（从契约的 outputs.to 建）──
    const edges = [];
    const byId = {};
    for (const n of scenes) byId[n.id] = n;

    for (const sid of Object.keys(contracts)) {
      const c = contracts[sid];
      if (!c || !Array.isArray(c.outputs)) continue;

      for (const out of c.outputs) {
        const targets = Array.isArray(out && out.to) ? out.to : [];
        for (const t of targets) {
          // 目标可能是场景 id 或产物 id
          if (byId[t] && t !== sid) {
            edges.push({ a: sid, b: t, kind: 'flow', label: out.name || out.id || '' });
          }
        }
      }
    }

    // ══════════════════════════════════════════════════════════
    //  ★ 连接层次构建（用户："隐隐连线形式很好，但具体怎么连得深究"）
    //
    //  四级强度模型，每条边都有明确依据：
    //    L1 flow      —— 契约 outputs.to（真实依赖）
    //    L2 indirect  —— 共同邻居（图论依据）
    //    L3 domain    —— 同领域（语义依据）
    //    L4 similar   —— role 关键词重叠（文本依据）
    //
    //  原则：L1 明确，L2/L3/L4 逐级淡化（"隐隐的"）
    // ══════════════════════════════════════════════════════════

    // ── L2：间接相关（共同邻居）──
    //    A 和 B 都连到同一个 C → A-B 有间接关联
    //    这比"同领域"更有依据：说明它们在同一个工作流里
    const neighborSets = {};
    for (const n of scenes) neighborSets[n.id] = new Set();

    // 用已有的 flow 边构建邻居关系
    for (const e of edges) {
      if (neighborSets[e.a]) neighborSets[e.a].add(e.b);
      if (neighborSets[e.b]) neighborSets[e.b].add(e.a);
    }

    // 找出所有"有共同邻居"的节点对
    const hasEdge = {};
    for (const e of edges) {
      const key = e.a < e.b ? (e.a + '|' + e.b) : (e.b + '|' + e.a);
      hasEdge[key] = true;
    }

    const indirectPairs = [];
    const sceneIds = scenes.map(function (s) { return s.id; });

    for (let i = 0; i < sceneIds.length; i++) {
      const idA = sceneIds[i];
      for (let j = i + 1; j < sceneIds.length; j++) {
        const idB = sceneIds[j];

        // 已有直接连接 → 跳过（不重复）
        const key = idA < idB ? (idA + '|' + idB) : (idB + '|' + idA);
        if (hasEdge[key]) continue;

        const setA = neighborSets[idA];
        const setB = neighborSets[idB];
        if (!setA || !setB || setA.size === 0 || setB.size === 0) continue;

        // 计算共同邻居
        let common = 0;
        for (const nb of setA) if (setB.has(nb)) common++;

        if (common > 0) {
          indirectPairs.push({
            a: idA, b: idB,
            weight: common,           // 共同邻居数作为强度
          });
        }
      }
    }

    // L2 上限：只保留最强的 30 条（避免"全连线"变成蜘蛛网）
    indirectPairs.sort(function (x, y) { return y.weight - x.weight; });
    const MAX_INDIRECT = 30;

    for (let i = 0; i < Math.min(indirectPairs.length, MAX_INDIRECT); i++) {
      const p = indirectPairs[i];
      edges.push({
        a: p.a, b: p.b,
        kind: 'indirect',
        label: '',
        weight: p.weight,
      });
    }

    // ── L3：同领域（只在节点数少时加，避免爆炸）──
    //    依据：domain 相同
    //    限制：同领域节点 > 8 个时不加（否则 O(n²) 爆炸）
    if (scenes.length <= 60) {
      const byDomain = {};
      for (const n of scenes) {
        if (!byDomain[n.domain]) byDomain[n.domain] = [];
        byDomain[n.domain].push(n.id);
      }
      for (const d of Object.keys(byDomain)) {
        const ids = byDomain[d];
        if (ids.length > 8) continue;      // 太多就不加
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const key = ids[i] < ids[j] ? (ids[i] + '|' + ids[j]) : (ids[j] + '|' + ids[i]);
            if (hasEdge[key]) continue;
            // 检查是否已作为 indirect 加入
            let alreadyIndirect = false;
            for (let k = 0; k < Math.min(indirectPairs.length, MAX_INDIRECT); k++) {
              const ip = indirectPairs[k];
              const k2 = ip.a < ip.b ? (ip.a + '|' + ip.b) : (ip.b + '|' + ip.a);
              if (k2 === key) { alreadyIndirect = true; break; }
            }
            if (alreadyIndirect) continue;

            edges.push({ a: ids[i], b: ids[j], kind: 'domain', label: '' });
            hasEdge[key] = true;
          }
        }
      }
    }

    // ── L4：职能相似（role 关键词重叠）──
    //    依据：role + description 分词后的关键词交集
    //    限制：只在节点数 ≤ 40 时启用，且交集 ≥ 2 个关键词
    if (scenes.length <= 40) {
      // 简单地用 2-gram 做"分词"（中文短文本够用）
      function keywords(str) {
        const s = String(str || '').toLowerCase();
        const out = new Set();
        for (let i = 0; i < s.length - 1; i++) {
          const bg = s.substr(i, 2);
          if (bg.trim().length < 2) continue;
          if (/[，。：、；,.:;\s]/.test(bg)) continue;
          out.add(bg);
        }
        return out;
      }

      const kwSets = {};
      for (const n of scenes) {
        kwSets[n.id] = keywords((n.role || '') + ' ' + (n.desc || ''));
      }

      for (let i = 0; i < sceneIds.length; i++) {
        for (let j = i + 1; j < sceneIds.length; j++) {
          const idA = sceneIds[i], idB = sceneIds[j];
          const key = idA < idB ? (idA + '|' + idB) : (idB + '|' + idA);
          if (hasEdge[key]) continue;

          // 不同领域才考虑（同领域已被 L3 覆盖）
          const nA = byId[idA], nB = byId[idB];
          if (!nA || !nB || nA.domain === nB.domain) continue;

          const setA = kwSets[idA], setB = kwSets[idB];
          if (!setA || !setB || setA.size === 0 || setB.size === 0) continue;

          let common = 0;
          for (const kw of setA) if (setB.has(kw)) common++;
          if (common >= 2) {
            edges.push({
              a: idA, b: idB, kind: 'similar', label: '',
              weight: common,
            });
            hasEdge[key] = true;
          }
        }
      }
    }

    // ── 度数 + 邻接表（官方 highlight 模式需要）──
    for (const e of edges) {
      if (byId[e.a]) byId[e.a].degree++;
      if (byId[e.b]) byId[e.b].degree++;
    }
    // 邻接表：每个节点记录它的邻居 id 和相关边索引
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const na = byId[e.a], nb = byId[e.b];
      if (!na || !nb) continue;
      if (!na.neighbors) na.neighbors = [];
      if (!nb.neighbors) nb.neighbors = [];
      if (!na.links) na.links = [];
      if (!nb.links) nb.links = [];
      na.neighbors.push(nb.id);
      nb.neighbors.push(na.id);
      // ★ 自检修复：存边对象引用而非索引
      //   之前存 ei（S.edges 索引），但渲染时用 sortedE 索引查 → 错位
      //   导致"点击节点后不相连的边也被高亮"
      na.links.push(edges[ei]);
      nb.links.push(edges[ei]);
    }

    // ── 场景的附属信息（点击时展开，不常驻图）──
    for (const n of scenes) {
      const c = contracts[n.id];
      n.attachments = {
        memory: true,   // 每个场景都有私有记忆
        identity: true, // 每个场景都有身份卡
        skills: (c && Array.isArray(c.capabilities)) ? c.capabilities : [],
        mcp: [],
        panels: (c && Array.isArray(c.panels)) ? c.panels.length : 0,
      };
    }

    return { scenes: scenes, edges: edges };
  }

  // ═══════════════════════════════════════════════════════════
  //  布局：球面（无轮廓线，但节点真的排在球上）
  // ═══════════════════════════════════════════════════════════
  function layout() {
    const W = cv.clientWidth, H = cv.clientHeight;
    if (W < 4 || H < 4 || !S.scenes.length) return;

    // ══════════════════════════════════════════════════════════
    //  ★ 关键修正：zoom 不进世界坐标，只影响投影
    //    之前 RX = W*0.44*S.zoom 把缩放烘焙进布局
    //    → 点「整理」后缩放，节点被重新排布 = "强制更改页面"
    //    现在：世界坐标固定，zoom 只在 project3d 的 fov 里生效
    // ══════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════
    //  ★ 档位感知 + 密度自适应（用户要求"考虑节点数量变化时的编排"）
    //
    //    节点越多 → 空间范围越大（把节点撑开，避免挤压）
    //    用 log10 而非线性：10→100 是 10 倍，但空间不需要 10 倍
    // ══════════════════════════════════════════════════════════
    const nodeN = S.scenes.length;
    const tier = getTier(nodeN);
    S.tier = tier;

    // 密度因子：n=10 → 1.0，n=100 → 1.55，n=600 → 1.78
    const densityFactor = Math.max(
      1.0,
      Math.min(1.85, 1 + Math.log10(Math.max(1, nodeN) / 10) * 0.62)
    );
    S.densityFactor = densityFactor;

    // 基础半径（不再乘 zoom，缩放只影响投影）
    const baseRX = W * 0.44;
    const baseRY = H * 0.40;

    // 自适应半径：留 6% 边距（0.48 / 0.44 = 1.09 上限）
    const RX = Math.min(W * 0.475, baseRX * densityFactor);
    const RY = Math.min(H * 0.435, baseRY * densityFactor);
    const R = Math.min(RX, RY);

    S.radius = R;
    S.radiusX = RX;
    S.radiusY = RY;

    // ══════════════════════════════════════════════════════════
    //  星云式体积分布（不是球面）
    //
    //  真实宇宙的星星在三维体积里散布，没有"球面"。
    //  但要保持结构感：
    //    ① 半径用幂律分布（中心密、外围疏）
    //    ② 同领域节点在空间上聚集（星团）
    //    ③ 方向随机但有扇区偏好（避免完全随机）
    // ══════════════════════════════════════════════════════════

    const groups = {};
    for (const n of S.scenes) {
      if (!groups[n.domain]) groups[n.domain] = [];
      groups[n.domain].push(n);
    }
    const domains = Object.keys(groups);
    const domainCount = domains.length || 1;

    // 每个领域一个主方向（经度）
    const domainDir = {};
    for (let i = 0; i < domains.length; i++) {
      // 领域方向均匀分布在一圈，但有黄金角偏移
      domainDir[domains[i]] = (i / domainCount) * TAU + (i * 0.618);
    }

    // ══════════════════════════════════════════════════════════
    //  ★ 领域聚类中心（自检修复：之前 baseDir 算了没用，导致无结构）
    //
    //  用户："考虑节点数量变化时如何编排、如何处理"
    //
    //  分档策略：
    //    S 档（≤24）：  不聚类 —— 节点少，均匀散布更舒展
    //    M/L/XL 档：    按领域聚成星团，团心球面均匀分布
    //                   团半径 ∝ sqrt(团内节点数)，避免团间重叠
    // ══════════════════════════════════════════════════════════

    const nodeTotal = S.scenes.length;
    const doCluster = (getTier(nodeTotal) !== 'S');
    const clusterCenters = {};

    if (doCluster) {
      const dc = domains.length;
      for (let di = 0; di < dc; di++) {
        const d = domains[di];
        const cnt = groups[d].length;
        const avgPerDomain = Math.max(1, nodeTotal / Math.max(1, dc));

        // 球面均匀分布：纬度均匀 + 经度黄金角
        const lat = (dc <= 1) ? 0 : (-0.85 + (1.7 * (di + 0.5)) / dc);
        const lon = (di * 2.39996) % TAU;
        const cosLat = Math.cos(lat);

        // 团心半径：节点多的团稍靠外（避免全堆中心）
        const rrBase = 0.34 + 0.44 * Math.min(1, cnt / avgPerDomain);

        // 团半径：∝ sqrt(节点数)，上限 0.26（防团间重叠）
        const rad = Math.min(0.26, 0.085 * Math.sqrt(cnt));

        clusterCenters[d] = {
          x: Math.cos(lon) * cosLat * rrBase,
          y: Math.sin(lat) * rrBase,
          z: Math.sin(lon) * cosLat * rrBase,
          rad: rad,
          count: cnt,
        };
      }
    }

    // 用确定性伪随机（同一个 id 每次都得到同样位置）
    function seededRandom(seedStr) {
      let h = 0;
      for (let i = 0; i < seedStr.length; i++) {
        h = (h << 5) - h + seedStr.charCodeAt(i);
        h |= 0;
      }
      return function () {
        h = (h * 1103515245 + 12345) & 0x7fffffff;
        return h / 0x7fffffff;
      };
    }

    // ══════════════════════════════════════════════════════════
    //  ★ 2026-11-11：本次已放置的节点坐标（用于最小间距约束）
    //
    //  为什么不能用 other.sx：
    //    other.sx 是**上一次 layout 的旧值**，
    //    第一次布局时它们全是 undefined → `!= null` 直接跳过
    //    → 间距约束完全没生效 → 节点重叠（事故 AC-014 的根因）
    //
    //  正确做法：记录「本次 layout 已放好的节点」，只和它们比。
    // ══════════════════════════════════════════════════════════
    const placed = [];

    for (const n of S.scenes) {
      if (n.dragged) continue;

      const rnd = seededRandom(n.id || n.name);
      const baseDir = domainDir[n.domain] || 0;
      // ══════════════════════════════════════════════════════
      //  ★ 领域聚类（自检修复：之前 baseDir 算了没用，导致无结构）
      //
      //  用户："考虑节点数量变化时如何编排、如何处理"
      //
      //  分档策略：
      //    S 档（≤24）：  不聚类 —— 节点少，均匀散布更舒展
      //    M/L/XL 档：    按领域聚成星团，团心在球面均匀分布
      //                   团半径 ∝ sqrt(团内节点数)
      // ══════════════════════════════════════════════════════

      // ① 立方体内随机点
      let vx = rnd() * 2 - 1;
      let vy = rnd() * 2 - 1;
      let vz = rnd() * 2 - 1;

      // ② 拒绝采样：确保在单位球内
      let len2 = vx * vx + vy * vy + vz * vz;
      let guard = 0;
      while (len2 > 1 && guard++ < 12) {
        vx = rnd() * 2 - 1;
        vy = rnd() * 2 - 1;
        vz = rnd() * 2 - 1;
        len2 = vx * vx + vy * vy + vz * vz;
      }

      const rr2 = Math.sqrt(Math.max(1e-6, len2));
      const invLen = 1 / (rr2 || 1);
      const nx = vx * invLen;
      const ny = vy * invLen;
      const nz = vz * invLen;

      const RX = S.radiusX || R;
      const RY = S.radiusY || R;

      let px, py, pz;

      if (clusterCenters[n.domain]) {
        // ═══ 聚类模式：团心 + 团内偏移 ═══
        const cc = clusterCenters[n.domain];
        const inBall = 0.28 + Math.pow(rr2, 0.5) * 0.72;
        px = (cc.x + nx * cc.rad * inBall) * RX;
        py = (cc.y + ny * cc.rad * inBall) * RY;
        pz = (cc.z + nz * cc.rad * inBall) * RX;
      } else {
        // ═══ 均匀模式（S 档）：体积均匀散布 ═══
        //
        // ⚠ 2026-11-11 修复（事故 AC-014：9 个场景只画出 7 个）：
        //
        //   原来的纯随机散布有两个问题：
        //     ① 9 个点撒在球体积内，靠中心的部分容易两两重合
        //        （实测「架构梳理」和「逆向分析」投影到几乎同一点，
        //          视觉上叠成一个亮点，看起来就像少了两个）
        //     ② 种子随机只保证「同一个 id 每次同位置」，
        //        不保证「不同 id 之间不靠近」
        //
        //   修法：加最小间距约束 ——
        //     按已有节点的世界坐标算距离，太近就重新采样（最多 20 次）。
        //     采样都失败（节点太密）就接受最后一次，避免死循环。
        const MIN_SEP = 0.30;   // 世界坐标下的最小间距（相对半径 1.0）

        // ⚠ 注意：上面 nx/ny/nz 是 const，不能直接改 ——
        //   用可变副本 dx/cy2/dz2 表示当前候选方向。
        let dirX = nx, dirY = ny, dirZ = nz;
        let px2 = 0, py2 = 0, pz2 = 0;
        for (let tryN = 0; tryN < 20; tryN++) {
          const rScale = 0.30 + Math.pow(rr2, 0.45) * 0.70;
          px2 = dirX * rScale * RX;
          py2 = dirY * rScale * RY;
          pz2 = dirZ * rScale * RX;

          // 与已放置的节点比较（单位化后比较，避免受 RX/RY 缩放影响）
          const ux = px2 / (RX || 1);
          const uy = py2 / (RY || 1);
          const uz = pz2 / (RX || 1);

          let tooClose = false;
          for (const other of placed) {
            const ddx = ux - other.ux, ddy = uy - other.uy, ddz = uz - other.uz;
            if (Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) < MIN_SEP) {
              tooClose = true;
              break;
            }
          }
          if (!tooClose) break;

          // 重采样方向
          let vx2 = rnd() * 2 - 1, vy2 = rnd() * 2 - 1, vz2 = rnd() * 2 - 1;
          let l2 = vx2 * vx2 + vy2 * vy2 + vz2 * vz2;
          let g2 = 0;
          while (l2 > 1 && g2++ < 12) {
            vx2 = rnd() * 2 - 1; vy2 = rnd() * 2 - 1; vz2 = rnd() * 2 - 1;
            l2 = vx2 * vx2 + vy2 * vy2 + vz2 * vz2;
          }
          const rl = 1 / (Math.sqrt(Math.max(1e-6, l2)) || 1);
          dirX = vx2 * rl; dirY = vy2 * rl; dirZ = vz2 * rl;
        }

        px = px2; py = py2; pz = pz2;
      }


      n.sx = px;
      n.sy = py;
      n.sz = pz;

      // 记入「已放置」，供后续节点的最小间距约束使用
      placed.push({
        id: n.id,
        ux: px / (RX || 1),
        uy: py / (RY || 1),
        uz: pz / (RX || 1),
      });

      n.dist = Math.sqrt(px * px + py * py + pz * pz);
    }

    // ══════════════════════════════════════════════════════
    //  星空系统（参考 particles.js 28k★）
    //     · 星点**会移动**（不是静止闪烁）
    //     · 移出边界的**重生**（随机新位置 = 随机出现）
    //     · 每个星点有自己的闪烁频率/相位
    // ══════════════════════════════════════════════════════
    if (!S.stars.length) {
      const density = Math.max(140, Math.min(320, Math.round((W * H) / 5200)));
      for (let i = 0; i < density; i++) {
        S.stars.push(makeStar(W, H));
      }
    }

    S.byId = {};
    for (const n of S.scenes) S.byId[n.id] = n;

    S.layoutVersion++;
  }

  // ═══════════════════════════════════════════════════════════
  //  整理（复位拖拽的节点 —— 用户要求）
  // ═══════════════════════════════════════════════════════════
  /**
   * 整理：把拖动的节点复位
   *
   * 自检修复（关键）：
   *   之前 tidy 用 spherePositions 算位置，而 layout 用立方体采样
   *   → 两套算法 → 整理后位置与 layout 重排结果不一致
   *   → 缩放触发 layout → 坐标跳变 909px
   *
   *   现在：直接调用 layout() 作为"目标位置"的唯一来源
   *        保证 tidy 结果与 layout 完全一致
   */
  function tidy() {
    if (!S.scenes.length) return;

    const W = cv.clientWidth, H = cv.clientHeight;
    if (W < 4 || H < 4) return;

    // ① 记录当前实际位置（动画起点）
    const start = {};
    for (const n of S.scenes) {
      start[n.id] = { x: n.sx, y: n.sy, z: n.sz };
    }

    // ② 清拖拽标记
    for (const n of S.scenes) n.dragged = false;

    // ③ 调用 layout() → 得到与渲染完全一致的目标位置
    layout();

    // ④ 记下目标，并把节点临时放回起点（准备动画）
    const target = {};
    for (const n of S.scenes) {
      target[n.id] = { x: n.sx, y: n.sy, z: n.sz };
      const st = start[n.id];
      if (st) {
        n.sx = st.x;
        n.sy = st.y;
        n.sz = st.z;
      }
    }

    // ⑤ 420ms easeOutCubic 动画
    const t0 = performance.now();
    const DUR = 420;
    S.tidying = true;

    const step = function () {
      if (S.destroyed) { S.tidying = false; return; }
      const f = Math.min(1, (performance.now() - t0) / DUR);
      const e = 1 - Math.pow(1 - f, 3);

      for (const n of S.scenes) {
        const st = start[n.id];
        const tg = target[n.id];
        if (!st || !tg) continue;
        n.sx = st.x + (tg.x - st.x) * e;
        n.sy = st.y + (tg.y - st.y) * e;
        n.sz = st.z + (tg.z - st.z) * e;
      }

      render();

      if (f < 1) requestAnimationFrame(step);
      else S.tidying = false;
    };
    requestAnimationFrame(step);
  }

  /** 当前实际位置（拖拽时用 sx/sy/sz，它就是真位置）*/
  function currentPos(n) {
    return { x: n.sx, y: n.sy, z: n.sz };
  }

  // ═══════════════════════════════════════════════════════════
  //  渲染
  // ═══════════════════════════════════════════════════════════
  function render() {
    const W = cv.clientWidth, H = cv.clientHeight;
    if (W < 2 || H < 2) return;

    // ══════════════════════════════════════════════════════
    //  ★ 画布级 2D 变换（借鉴 Photoshop/ComfyUI）
    //    背景不缩放（始终铺满画布）
    //    内容（星点/节点/边/标签）按 viewScale + panX/panY 变换
    // ══════════════════════════════════════════════════════

    // 背景：恒等变换（物理像素）
    c2d.setTransform(DPR, 0, 0, DPR, 0, 0);

    // 深空背景
    // ★ 背景提亮（实测 79.8% 纯黑 → 需要更多中间调）
    const g = c2d.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.85);
    // ★ 官方 3d-force-graph bloom 示例用的是近乎纯黑的三段渐变
    //
    // ⚠ 2026-11-14 修：这三行一度被我一次正则替换误伤成空串 '',
    //    导致 Canvas 抛「The value provided ('') could not be parsed as a color」，
    //    整个神经元渲染中断。
    //
    //    ⚠ Canvas API **只接受真实颜色值**，不接受 CSS 变量（var(--x)）。
    //      所以这里必须写死十六进制，不能用 token。
    //      （这是一个例外：面板 chrome 用 token，canvas 画布用实色。）
    g.addColorStop(0, '#01030A');
    g.addColorStop(0.4, '#000208');
    g.addColorStop(0.75, '#000106');
    g.addColorStop(1, '#000003');
    c2d.fillStyle = g;
    c2d.fillRect(0, 0, W, H);

    // ══════════════════════════════════════════════════════
    //  ★ 应用画布视图变换（2D 仿射，内容从这里开始缩放+平移）
    //    借鉴 Photoshop / ComfyUI：缩放是整体等比，不是透视变形
    //    变换矩阵：[viewScale, panX; viewScale, panY]
    // ══════════════════════════════════════════════════════
    const vs = S.viewScale || 1;
    const panXv = S.panX || 0;
    const panYv = S.panY || 0;
    c2d.setTransform(DPR * vs, 0, 0, DPR * vs, DPR * panXv, DPR * panYv);


    if (!S.scenes.length) {
      c2d.fillStyle = C.text4;
      c2d.font = '11px "JetBrains Mono",monospace';
      c2d.textAlign = 'center';
      c2d.fillText(S.ready ? '（无场景）' : '载入场景中…', W / 2, H / 2);
      return;
    }

    S.t += 0.016;

    // ★ 自检：yaw 会随拖拽累积（可达 15+ 弧度），周期归一化避免浮点损失
    if (S.yaw > TAU) S.yaw -= TAU * Math.floor(S.yaw / TAU);
    else if (S.yaw < -TAU) S.yaw += TAU * Math.ceil(-S.yaw / TAU);

    // ★ 每帧重置标签占位（用于防重叠）
    S.labelRects = [];

    const R = S.radius || Math.min(W, H) * 0.46 * S.zoom;
    // ══════════════════════════════════════════════════════
    //  缩放锚点补偿（让缩放"以鼠标为中心"，像地图软件）
    //    投影中心偏离画布中心 δ → 内容整体平移
    //    offset = (鼠标 - 中心) × (1 - 1/zoomRatio)
    // ══════════════════════════════════════════════════════
    let cx = W / 2, cy = H / 2;

    if (S.zoomAnchor && S.zoomAnchor.active) {
      const za = S.zoomAnchor;
      const ratio = S.zoom / (za.baseZoom || 1);
      const kk = ratio > 0.001 ? ratio : 1;
      const compX = (za.nx * W) * (1 - 1 / kk);
      const compY = (za.ny * H) * (1 - 1 / kk);
      cx = W / 2 - Math.max(-W / 2, Math.min(W / 2, compX));
      cy = H / 2 - Math.max(-H / 2, Math.min(H / 2, compY));
    }
    // ★ zoom 通过 fov 生效：zoom 大 → fov 小 → 物体更大
    const fov = (S.radiusX || R) * 2.6 / S.zoom;
    const yaw = S.yaw, pitch = S.pitch;

    // 规模降级
    // ══════════════════════════════════════════════════════
    //  档位（用户要求"考虑节点数量变化时如何处理"）
    //    由 layout() 计算 S.tier，这里读取
    // ══════════════════════════════════════════════════════
    const tier = S.tier || getTier(S.scenes.length);
    // 兼容旧字段名（避免其他地方引用报错）
    S.scaleMode = (tier === 'S') ? 'full' : (tier === 'M' ? 'mid' : 'agg');

    // 档位参数（供渲染时使用）
    const tierCfg = {
      S:  { spikes: true,  labels: 'all',     glowMul: 1.00, nodeScale: 1.00 },
      M:  { spikes: true,  labels: 'hover',   glowMul: 0.82, nodeScale: 0.92 },
      L:  { spikes: false, labels: 'sparse',  glowMul: 0.65, nodeScale: 0.80 },
      XL: { spikes: false, labels: 'none',    glowMul: 0.50, nodeScale: 0.68 },
    }[tier];
    S.tierCfg = tierCfg;

    // 投影
    const proj = {};
    for (const n of S.scenes) {
      const p3 = rotate3d(n.sx, n.sy, n.sz, yaw, pitch);
      const pr = project3d(p3, cx, cy, fov);
      pr.world = p3;
      proj[n.id] = pr;
    }

    // ★ 预计算节点屏幕归一化位置（供星空互动用）
    S.nodeScreenPos = [];
    S.nodeScreenLit = [];
    for (const n of S.scenes) {
      const pr = proj[n.id];
      if (!pr) continue;
      const deg = Math.max(0, Math.min(10, n.degree || 0));
      const rr = n.r * (0.78 + deg * 0.048) * pr.scale;
      const np = {
        nx: pr.sx / W,
        ny: pr.sy / H,
        r: rr / Math.min(W, H),
        z: pr.world.z / (S.radius || 1),
        lit: !!n.lit,
      };
      S.nodeScreenPos.push(np);
      if (n.lit) {
        S.nodeScreenLit.push({
          nx: np.nx, ny: np.ny,
          wave: (S.t * 0.55) % 1,   // 冲击波相位
        });
      }
    }

    // ★ 星空（需要在节点投影之后，才能与节点互动）
    drawStars(W, H);

    // ══════════════════════════════════════════════════════
    //  焦点优先级（正确的语义分层）
    //
    //    ① hover         —— 鼠标当前悬停（临时，最强）
    //    ② sel           —— 点击选中（持久，用户明确意图）
    //    ③ dragSnapshot  —— 拖拽开始时的快照（只用于"拖拽期间不熄灭"）
    //
    //  自检修复：之前用 stickyFocus 记录"最后悬停的节点"，
    //            导致拖拽时划过节点也被记录 → 拖后仍高亮 = BUG
    //            现在只有 sel 是持久的，快照仅在拖拽期间有效
    // ══════════════════════════════════════════════════════
    let focusId = (S.hover && S.hover.id) || (S.sel && S.sel.id) || null;

    // 拖拽/旋转期间：用按下瞬间的快照（保证原高亮不熄灭）
    if (!focusId && (S.rotating || S.draggingNode) && S.dragSnapshot) {
      focusId = S.dragSnapshot;
    }

    // 标记是否为"拖拽快照"（视觉稍弱）
    const isStickyFocus = (!S.hover && !S.sel && focusId && focusId === S.dragSnapshot);

    // ★ 官方 highlight 模式：高亮当前节点 + 邻居 + 相关边
    let highlightNodes = null;
    let highlightLinks = null;
    let focusNode = null;
    if (focusId && S.byId[focusId]) {
      focusNode = S.byId[focusId];
      highlightNodes = new Set();
      highlightLinks = new Set();
      highlightNodes.add(focusNode.id);
      for (const nid of (focusNode.neighbors || [])) highlightNodes.add(nid);
      // ★ 自检修复：存边对象引用（不用索引，避免 sortedE 错位）
      for (const linkObj of (focusNode.links || [])) highlightLinks.add(linkObj);
    }

    // ⚠ 用户明确要求：完全不要显示大球面
    //    所以不画球形光晕、不画轨道带、不画任何边界
    //    只有：深空背景 + 星尘 + 散布的节点

    // ── 边（场景↔场景）──
    const sortedE = S.edges.slice().sort(function (a, b) {
      const za = (proj[a.a] ? proj[a.a].world.z : 0) + (proj[a.b] ? proj[a.b].world.z : 0);
      const zb = (proj[b.a] ? proj[b.a].world.z : 0) + (proj[b.b] ? proj[b.b].world.z : 0);
      return za - zb;
    });

    const byId = S.byId;

    for (let ei = 0; ei < sortedE.length; ei++) {
      const e = sortedE[ei];
      const na = byId[e.a], nb = byId[e.b];
      const pa = proj[e.a], pb = proj[e.b];
      if (!na || !nb || !pa || !pb) continue;

      // ══════════════════════════════════════════════════════
      //  ★ 自检修复：选中节点的连线在旋转时消失
      //
      //  用户："我点击了一个节点，这个节点与其它节点之间的连线
      //        在旋转到特定位置线会消失"
      //
      //  根因：if (frontness < -0.72) continue;  ← 直接跳过不画
      //        选中的节点转到背面时，它的所有连线被跳过 → 完全消失
      //
      //  修法：
      //    ① 与焦点/邻居/点亮相关的边**永不裁剪**
      //    ② 普通边改为软淡出（最低 alpha 0.02，不突然消失）
      // ══════════════════════════════════════════════════════

      const isHot = focusId && (e.a === focusId || e.b === focusId);
      // ★ 自检修复：用边对象引用判定（之前用 sortedE 索引 → 错位）
      const isNeighborLink = highlightLinks && highlightLinks.has(e);
      const lit = na.lit || nb.lit;

      const frontness = Math.max(pa.world.z, pb.world.z) / R;

      // 重要边（焦点/邻居/点亮）永不裁剪
      const isImportant = isHot || isNeighborLink || lit;

      // 普通边：只有当两端都极深（< -0.95）时才跳过
      //   （-0.95 几乎只裁真正在正背面的，视觉上本来也看不见）
      if (!isImportant && frontness < -0.95) continue;

      // 深度透明度：软过渡（不硬切换）
      //   正面 (1.0) → 1.0
      //   背面 (-1.0) → 0.15（仍然可见一点点，不突然消失）
      const depthAlpha = Math.max(0.15, Math.min(1, (frontness + 1) / 2));

      // ══════════════════════════════════════════════════════
      //  单次描边（不叠加），极细，低亮度
      // ══════════════════════════════════════════════════════
      // ══════════════════════════════════════════════════════
      //  边亮度（自检调整）
      //    ① 之前像"白色光柱" → alpha/线宽降低
      //    ② 自检发现超长边（709px）横跨全屏很突兀
      //       → 长边按长度衰减亮度（长线更淡，不抢视觉）
      // ══════════════════════════════════════════════════════
      // ══════════════════════════════════════════════════════
      //  边的视觉层次（四级强度模型）
      //
      //  L1 flow      0.42 / 0.9px   "明确关系"
      //  L2 indirect  0.20 / 0.65px  "间接关联"
      //  L3 domain    0.11 / 0.52px  "隐隐同类"
      //  L4 similar   0.06 / 0.48px  "隐约相似"
      //
      //  自检修复"断断续续"：
      //    线宽下限设为 0.5px（避免亚像素渲染抖动产生点状断线）
      //    并设置 lineCap = 'round'（端点圆润）
      // ══════════════════════════════════════════════════════
      let alpha, lineW;

      // 深度因子：重要边最少保留 55%
      const depthKeep = isImportant ? Math.max(0.55, depthAlpha) : depthAlpha;

      // 按 kind 分级（每条边都记录了依据）
      const edgeKind = e.kind || 'flow';

      if (isHot) {
        // 焦点直连边：最强
        alpha = 0.42 * Math.max(0.72, depthKeep);
        lineW = 0.9;
      } else if (isNeighborLink) {
        // 邻接边（交集：焦点邻居或同 kind）
        alpha = 0.26 * Math.max(0.62, depthKeep);
        lineW = 0.7;
      } else if (lit) {
        alpha = 0.34 * Math.max(0.66, depthKeep);
        lineW = 0.75;
      } else if (edgeKind === 'flow') {
        // L1 直接依赖
        alpha = depthAlpha * 0.42;
        lineW = 0.9;
      } else if (edgeKind === 'indirect') {
        // L2 间接相关
        alpha = depthAlpha * 0.20;
        lineW = 0.65;
      } else if (edgeKind === 'domain') {
        // L3 同领域（隐隐的）
        alpha = depthAlpha * 0.11;
        lineW = 0.52;
      } else {
        // L4 职能相似（几乎不可见）
        alpha = depthAlpha * 0.06;
        lineW = 0.48;
      }

      // 线宽下限（避免亚像素抖动）
      lineW = Math.max(0.5, lineW);

      // ★ 长边衰减：屏幕长度 > 画布对角线 40% 的边，按比例降亮度
      {
        const dxs = pb.sx - pa.sx, dys = pb.sy - pa.sy;
        const screenLen = Math.sqrt(dxs * dxs + dys * dys);
        const diagLen = Math.sqrt(W * W + H * H);
        const lenRatio = screenLen / diagLen;
        if (lenRatio > 0.40) {
          // 0.40 → 1.0 之间线性衰减到 45%
          const decay = 1 - Math.min(0.55, (lenRatio - 0.40) / 0.60 * 0.55);
          alpha *= decay;
        }
      }

      // 弧线控制点
      const mx = (pa.sx + pb.sx) / 2;
      const my = (pa.sy + pb.sy) / 2;
      const ddx = pb.sx - pa.sx, ddy = pb.sy - pa.sy;
      const len2 = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      const bulge = R * 0.05;
      const qx = mx + (-ddy / len2) * bulge;
      const qy = my + (ddx / len2) * bulge;

      // ══════════════════════════════════════════════════════
      //  连线：**纯色均匀亮度**（不用渐变）
      //
      //  用户："连线是因为做了渐变吗，给人一种断断续续的感觉"
      //
      //  自检根因：
      //    之前用 5 段渐变（0.78 → 1.0 → 0.78）
      //    两端较暗处在 Bloom 下与背景融合 → 视觉"断"
      //    且中间亮两头暗违反物理直觉（光沿导线应均匀）
      //
      //  修法：纯色，整条线亮度一致
      //        Bloom 会自然让端点在节点处衰减（物理正确，无需手动渐变）
      // ══════════════════════════════════════════════════════
      if (isHot || isNeighborLink || lit) {
        c2d.strokeStyle = 'rgba(214,234,252,' + alpha.toFixed(3) + ')';
      } else {
        c2d.strokeStyle = 'rgba(110,155,200,' + alpha.toFixed(3) + ')';
      }

      // ★ 自检修复"断断续续"：lineCap 圆润 + 线宽下限
      c2d.lineCap = 'round';
      c2d.lineJoin = 'round';
      c2d.lineWidth = lineW;
      c2d.beginPath();
      c2d.moveTo(pa.sx, pa.sy);
      c2d.quadraticCurveTo(qx, qy, pb.sx, pb.sy);
      c2d.stroke();
    }

    // ── 节点（场景）──
    const sorted = S.scenes.slice().sort(function (a, b) {
      return (proj[a.id] ? proj[a.id].world.z : 0) - (proj[b.id] ? proj[b.id].world.z : 0);
    });

    for (const n of sorted) {
      const pr = proj[n.id];
      if (!pr) continue;

      // ══════════════════════════════════════════════════════
      //  ★ 官方 highlight 三色分层（先算状态，再算透明度）
      //     hover 自己 → 红  邻居 → 橙  无关 → 暗青 + 大幅淡化
      // ══════════════════════════════════════════════════════
      const isNeighbor = highlightNodes && highlightNodes.has(n.id);
      const isFocus = focusId === n.id;
      // ★ 粘滞焦点：视觉稍弱（用户能区分"鼠标在哪"vs"上次看的是哪个"）
      const isSticky = isFocus && isStickyFocus;

      // ══════════════════════════════════════════════════════════
      //  ★ 2026-11-11 修复（真实用户发现 P0）：
      //    搜索框写了 S.filter 但**全文件没有一处读取它** —— 纯装饰。
      //
      //    用户实测：输入「zzzz不存在zzzz」，星盘 9 个节点一个不少，
      //    也没有任何「没找到」的提示。
      //
      //    修法：不删节点（会破布局/连线），而是**把不命中的并入 isDimmed**,
      //    复用已有的淡化机制（alpha ×0.40、brightMul 0.45、标签不显示）。
      //    这样：
      //      · 命中的场景正常亮
      //      · 不命中的淡成背景，但仍保留空间结构（用户能看出"它还在那儿"）
      //      · 零风险（不改任何遍历/布局代码）
      //
      //    匹配范围：场景中文名 + id + 领域 + 阶段描述
      //    （用户可能搜"架构"、也可能搜"arch"、还可能搜"木生"）
      // ══════════════════════════════════════════════════════════
      const q = String(S.filter || '').trim().toLowerCase();
      const searchMiss = !!q && !(
        String(n.name || '').toLowerCase().indexOf(q) >= 0 ||
        String(n.id || '').toLowerCase().indexOf(q) >= 0 ||
        String(n.domain || '').toLowerCase().indexOf(q) >= 0 ||
        String(n.stage || n.phase || '').toLowerCase().indexOf(q) >= 0 ||
        String(n.desc || n.role || '').toLowerCase().indexOf(q) >= 0
      );

      const isDimmed = (highlightNodes && !isNeighbor) || searchMiss;
      // 搜索命中的给一个额外高亮（让用户一眼看到"搜到的就是它"）
      const isSearchHit = !!q && !searchMiss;

      const isSel = S.sel && S.sel.id === n.id;
      const isHover = S.hover && S.hover.id === n.id;
      const lit = n.lit;
      const isNew = S.newSceneIds && S.newSceneIds.has(n.id);
      // ★ 自检修复：不再用旧 scaleMode，改用 tierCfg（档位体系）
      //    XL 档不画外柔光（性能+视觉清爽）
      const showGlow = tier !== 'XL';

      const zw = pr.world.z / R;
      // 深度参数：zw ∈ [-1.5, 1.5] 左右（radius 归一化后可能超界）
      const depth01 = Math.max(0, Math.min(1, (zw + 1) / 2));

      // ══════════════════════════════════════════════════════
      //  自检修复："有标签无星形"
      //    旧式：zw<0 → 0.26 + 0.30*depth01
      //          最深时 alpha ≈ 0.26，再 × isDimmed 0.32 → 0.083
      //          → 星形几乎透明，只剩标签可见
      //    现在：下限 0.38（背半球）/ 0.70（前半球）
      // ══════════════════════════════════════════════════════
      let alpha;
      if (zw < 0) {
        alpha = 0.38 + 0.32 * depth01;      // 0.38 ~ 0.70
      } else {
        alpha = 0.70 + 0.30 * depth01;      // 0.70 ~ 1.00
      }

      // 悬停时无关节点淡化（但不低于 0.26，保证还看得见）
      //
      // ★ 2026-11-11：搜索不命中要淡得更狠
      //   hover 淡化下限 0.26（用户只是"暂时看别的"，还要看得见）
      //   搜索不命中下限 0.10（用户明确在筛选，不命中的应该几乎消失）
      //   两者语义不同，不能共用一个下限。
      if (searchMiss) {
        alpha *= 0.22;
        alpha = Math.max(0.10, alpha);
      } else if (isDimmed) {
        alpha *= 0.40;
        alpha = Math.max(0.26, alpha);
      }

      // ★ 自检修复：深度透明度（删旧代码时误删了）
      //   前半球 → 亮，背半球 → 淡，形成真实的深度层次
      c2d.globalAlpha = alpha;

      // 节点大小：按连接度数
      const deg = Math.max(0, Math.min(10, n.degree || 0));
      const baseRp = n.r * (0.78 + deg * 0.048);
      const rr = baseRp * pr.scale * (0.78 + 0.22 * depth01);

      // ★ 暗态：微光星点（不是实心球）
      //   亮态：耀眼（强光晕 + 白核 + 光芒）

      // ══════════════════════════════════════════════════════
      //  配色（自检修复：color 之前未定义，导致 "color is not defined"）
      //    克制原则：色相永远不变，只调亮度
      // ══════════════════════════════════════════════════════
      const baseColor = DOMAIN_COLOR[n.domain] || DOMAIN_COLOR.other;
      let color = baseColor;

      // 亮度调制（替代变色）
      let brightMul = 1;
      if (isSearchHit) brightMul = 1.45;      // 搜索命中：提亮，一眼看到
      else if (isFocus) brightMul = 1.9;
      else if (isNeighbor) brightMul = 1.25;
      else if (searchMiss) brightMul = 0.22;  // 搜索不命中：压到很暗
      else if (isDimmed) brightMul = 0.45;

      // 应用亮度（输出仍为 #RRGGBB，因为 hexA() 只认十六进制）
      if (brightMul !== 1) {
        const rgbv = baseColor.replace('#', '');
        let rr0 = parseInt(rgbv.slice(0, 2), 16);
        let gg0 = parseInt(rgbv.slice(2, 4), 16);
        let bb0 = parseInt(rgbv.slice(4, 6), 16);
        rr0 = Math.max(0, Math.min(255, Math.round(rr0 * brightMul)));
        gg0 = Math.max(0, Math.min(255, Math.round(gg0 * brightMul)));
        bb0 = Math.max(0, Math.min(255, Math.round(bb0 * brightMul)));
        const hex2 = function (n) {
          const s = n.toString(16);
          return s.length === 1 ? '0' + s : s;
        };
        color = '#' + hex2(rr0) + hex2(gg0) + hex2(bb0);
      }


      // ══════════════════════════════════════════════════════
      //  节点绘制（真实星光，不是实心形状）
      //
      //  用户："太丑了，节点的设计仍需仔细斟酌"
      //
      //  自检对比 Three.js 官方星点示例后确认：
      //    之前我画的是**实心白色四角星 + 硬描边** = 风车图标
      //    真实星光的本质是「光」——Airy disk + 衍射芒，都是渐隐的
      //
      //  drawStarlight 内部实现三层：
      //    ① Airy disk  圆形柔和光晕（主体，不是四角）
      //    ② 核心光点   极小纯白，过曝感
      //    ③ 衍射芒     4 条渐隐光线（不是实心三角）
      // ══════════════════════════════════════════════════════

      // 小巧版（用户确认）
      // ★ 档位感知的节点半径（节点越多，单个越小）
      const starR = Math.max(2.2, rr * 0.92 * tierCfg.nodeScale);

      drawStarlight(pr.sx, pr.sy, starR, {
        lit: lit,
        isFocus: isFocus,
        isSticky: isSticky,
        isNeighbor: isNeighbor,
        color: color,
        t: S.t,
        noSpikes: !tierCfg.spikes,
        glowMul: tierCfg.glowMul,
      });

      // ══════════════════════════════════════════════════════
      //  选中态：**不额外绘制任何光圈**
      //
      //  用户："当鼠标移动到节点上展现的效果就足够了，
      //        点击后的光圈处理太丑了"
      //
      //  自检：drawStarlight 已经根据 isFocus 提升强度
      //        （focusId 同时覆盖 hover 和 sel）
      //        → 选中时星光自动更亮，无需额外光圈
      //        → 之前又叠加 5.2 倍呼吸光晕 = 双重 → 丑
      //
      //  故此处留空（保留注释说明设计意图）
      // ══════════════════════════════════════════════════════

      // ══════════════════════════════════════════════════════
      //  新场景提示（用光晕脉动，无环）
      // ══════════════════════════════════════════════════════
      if (isNew) {
        const pulse = 0.5 + 0.5 * Math.sin(S.t * 2.0);
        const nr = starR * (4.0 + pulse * 1.6);

        const ng = c2d.createRadialGradient(pr.sx, pr.sy, starR * 1.2, pr.sx, pr.sy, nr);
        ng.addColorStop(0, 'rgba(120,180,230,' + (0.16 - pulse * 0.10).toFixed(3) + ')');
        ng.addColorStop(1, 'rgba(120,180,230,0)');
        c2d.fillStyle = ng;
        c2d.beginPath();
        c2d.arc(pr.sx, pr.sy, nr, 0, TAU);
        c2d.fill();
      }


      // ══════════════════════════════════════════════════════
      //  标签：所有节点都显示（用户明确要求）
      //
      //  原话："所有的节点都显示相应的文字，至少节点被启用，
      //        或是点击互相关联后，不要还是用原来的淡化以及文字不显示的效果"
      //
      //  深度层次用「字号 + 透明度」表达，而不是"显示/不显示"
      //    前景（zw > 0.3）：字号 11，透明度 1.0
      //    中景（-0.3~0.3）：字号 10.5，透明度 0.78
      //    远景（zw < -0.3）：字号 10，透明度 0.55（仍然可见）
      // ══════════════════════════════════════════════════════
      // ══════════════════════════════════════════════════════
      //  标签显示规则（档位感知）
      //    S 档：全部显示（当前 10 个节点，全部可读）
      //    M 档：只在悬停/选中/点亮时显示
      //    L 档：稀疏显示（每 3 个取 1）
      //    XL 档：不显示（靠领域色区分）
      // ══════════════════════════════════════════════════════
      let showLabel;
      if (tierCfg.labels === 'all') {
        showLabel = true;
      } else if (tierCfg.labels === 'hover') {
        showLabel = isHover || isSel || lit || isFocus || isNeighbor;
      } else if (tierCfg.labels === 'sparse') {
        // 用 id 哈希决定是否显示（确定性，不会闪）
        let h = 0;
        for (let ci = 0; ci < n.id.length; ci++) h = (h << 5) - h + n.id.charCodeAt(ci);
        showLabel = (Math.abs(h) % 3 === 0) || isHover || isSel || lit;
      } else {
        showLabel = isHover || isSel || lit;
      }

      // ★ 2026-11-11：搜索态覆盖标签规则
      //   命中 → 一定显示名字（用户要知道搜到的是哪个）
      //   不命中 → 一定不显示（否则满屏名字，看不出筛选效果）
      if (isSearchHit) showLabel = true;
      else if (searchMiss) showLabel = false;
      if (showLabel) {
        // 深度 → 字号/透明度（不控制是否显示）
        const depthT = Math.max(0, Math.min(1, (zw + 1) / 2));   // 0=最远 1=最近
        const labelAlpha = 0.58 + depthT * 0.42;                  // 0.58 ~ 1.0
        const labelSize = 9.5 + depthT * 2;                        // 9.5 ~ 11.5
        // ══════════════════════════════════════════════════
        //  标签防重叠（自检修正版）
        //    ① 先用 measureText 算真实宽度
        //    ② 用「两标签半宽之和 + 间隙」判定
        //    ③ 冲突时先左右交替，再下移，最多 6 次
        // ══════════════════════════════════════════════════

        // 先设字体（用深度决定字号，才能正确测量）
        const fs0 = labelSize;
        c2d.font = (lit || isSel ? '600 ' : '400 ') + fs0.toFixed(1) + 'px "Inter","HarmonyOS Sans SC","Microsoft YaHei",sans-serif';

        let label = String(n.name);
        const maxW = 88;
        if (c2d.measureText(label).width > maxW) {
          while (label.length > 1 && c2d.measureText(label + '…').width > maxW) {
            label = label.slice(0, -1);
          }
          label += '…';
        }
        const measuredW = c2d.measureText(label).width;
        const halfW = measuredW / 2;

        // 初始位置：节点正下方（自检：星形有 3 倍外柔光，需加大间距）
        let lx = pr.sx;
        // 星形半径 = rr*1.12，柔光 = starR*2.2~3.6
        // 标签放在柔光边缘外，避免"白字压白光"
        const labelGap = Math.max(starR * 1.6, rr + 10);
        let ly = pr.sy + labelGap;

        // 尝试 6 次：左右交替偏移 + 下移
        const DX = [0, -18, 18, -30, 30, 0, 0];
        const DY = [0, 0, 0, 0, 0, 14, 28];

        for (let attempt = 0; attempt < 6; attempt++) {
          let conflict = false;
          for (let k = 0; k < S.labelRects.length; k++) {
            const lr = S.labelRects[k];
            // 用真实宽度判定：两标签半宽之和 + 6px 间隙
            if (Math.abs(lr.x - lx) < (lr.hw + halfW + 6) &&
                Math.abs(lr.y - ly) < 13) {
              conflict = true;
              break;
            }
          }
          if (!conflict) break;
          // 冲突 → 下一个候选位置
          lx = pr.sx + DX[Math.min(attempt + 1, DX.length - 1)];
          ly = pr.sy + Math.max(3, rr) + 4 + DY[Math.min(attempt + 1, DY.length - 1)];
        }

        S.labelRects.push({ x: lx, y: ly, hw: halfW });

        // 绘制（用深度透明度，但始终可见）
        c2d.font = (lit || isSel ? '600 ' : '400 ') + fs0.toFixed(1) + 'px "Inter","HarmonyOS Sans SC","Microsoft YaHei",sans-serif';
        c2d.textAlign = 'center';
        c2d.textBaseline = 'top';

        // 标签底衬（自检：之前只在高亮时加，普通状态白字压背景看不清）
        //   改为始终加一层极淡暗底，保证任何状态下都可读
        {
          const padX = 3.5, padY = 1.5;
          const backA = (isSel || isHover || lit) ? 0.62 : 0.42;
          c2d.fillStyle = 'rgba(2,6,12,' + backA + ')';
          c2d.fillRect(lx - halfW - padX, ly - padY, measuredW + padX * 2, fs0 + padY * 2);
        }

        // 文字颜色：永远是冷白，靠 alpha 表现深度
        const txtA = lit ? 1 : (isSel || isHover ? 1 : labelAlpha);
        c2d.fillStyle = lit ? '#FFFFFF' : 'rgba(214,232,248,' + txtA.toFixed(2) + ')';
        c2d.fillText(label, lx, ly);
        }

      c2d.globalAlpha = 1;
    }

    // ★ Bloom 前恢复恒等变换（Bloom 在物理像素坐标下操作）
    c2d.setTransform(DPR, 0, 0, DPR, 0, 0);

    // ★ Bloom 泛光后处理（3d-force-graph 的核心技术）
    applyBloom(W, H);

    // 图例
    renderStats();
  }

  /**
   * 颜色 + 透明度 → rgba()
   * 自检修复：兼容 "#RRGGBB" 和 "rgb(r,g,b)" 两种格式
   *   （之前只支持十六进制，传 rgb() 会得到 NaN）
   */
  /**
   * 绘制"真实星光"（替代实心星形）
   *
   * 用户反馈"太丑"，自检对比 Three.js 官方星点示例后确认根因：
   *   我把星星做成了**实心白色四角星 + 硬描边** = 风车图标
   *   而真实星光的本质是「光」，不是「形状」
   *
   * 参照天文摄影的三层结构：
   *   ① 核心光点 —— 极小、纯白、径向渐变
   *   ② Airy disk —— 圆形柔和光晕（**不是四角形**）
   *   ③ 衍射芒   —— 4 条从中心向外渐隐的光线
   *
   * @param x, y     中心
   * @param R        视觉半径
   * @param opts     { lit, isFocus, isNeighbor, color, t }
   */
  function drawStarlight(x, y, R, opts) {
    const o = opts || {};
    // ⚠ 2026-11-14：默认值必须是**真实颜色**，不能是 var(--x)。
    //    hexA() 会解析这个字符串算 rgba，遇到 `var(--gu-qing-light, #8FC4E8)`
    //    会解析失败得到 NaN → addColorStop 抛 SyntaxError → 整个星图渲染中断。
    //
    //    Canvas 是这条规则唯一的例外：面板 chrome 用 token，画布用实色。
    const color = o.color || '#8FC4E8';
    const lit = !!o.lit;
    const isFocus = !!o.isFocus;
    const isNeighbor = !!o.isNeighbor;
    const isSticky = !!o.isSticky;
    const tt = o.t || 0;
    const noSpikes = !!o.noSpikes;      // 档位降级：不画衍射芒
    const glowMul = o.glowMul == null ? 1.0 : o.glowMul;

    // 强度系数（0.5~1.0）
    let power = 0.62;
    if (lit) power = 1.0;
    else if (isFocus) power = isSticky ? 0.76 : 0.88;   // 粘滞稍弱
    else if (isNeighbor) power = 0.74;

    // ═══ ① Airy disk：圆形柔和光晕（**这是主体，不是四角**）═══
    //   半径 = R × 3.2（足够大，形成"发光体"的感觉）
    // 小巧版：Airy disk 半径克制（用户确认这个尺寸最好）
    const diskR = R * (2.6 + power * 1.0);
    const dg = c2d.createRadialGradient(x, y, 0, x, y, diskR);
    // 中心极亮 → 快速衰减 → 边缘完全透明（这是 Airy disk 的特征）
    dg.addColorStop(0, hexA(color, 0.42 * power * glowMul));
    dg.addColorStop(0.18, hexA(color, 0.26 * power * glowMul));
    dg.addColorStop(0.40, hexA(color, 0.10 * power * glowMul));
    dg.addColorStop(0.70, hexA(color, 0.025 * power * glowMul));
    dg.addColorStop(1, hexA(color, 0));
    c2d.fillStyle = dg;
    c2d.beginPath();
    c2d.arc(x, y, diskR, 0, TAU);
    c2d.fill();

    // ═══ ② 核心光点：极小、纯白、径向渐变 ═══
    //   真实星点的核心是"过曝"的，占整个星的极小比例
    const coreR = Math.max(1.0, R * 0.30);
    const cg = c2d.createRadialGradient(x, y, 0, x, y, coreR);
    cg.addColorStop(0, 'rgba(255,255,255,' + (0.95 * power + 0.05) + ')');
    cg.addColorStop(0.45, 'rgba(255,255,255,' + (0.62 * power) + ')');
    cg.addColorStop(1, hexA(color, 0.08 * power));
    c2d.fillStyle = cg;
    c2d.beginPath();
    c2d.arc(x, y, coreR, 0, TAU);
    c2d.fill();

    // ═══ ③ 衍射芒：4 条从中心**向外渐隐**的光线 ═══
    //   关键：不是实心三角，而是渐隐的"光"
    //   长度 = R × 4.5（点亮时更长）
    //   宽度极细（R × 0.10），越远越透明
    const spikeLen = R * (lit ? 5.5 : (isFocus ? 4.6 : 3.4));
    const spikeW = Math.max(0.9, R * 0.11);
    const spikeA = (lit ? 0.42 : (isFocus ? 0.32 : 0.18)) * power;

    if (!noSpikes) for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI / 2);

      // 双向（左+右一条线，所以每个角度画一次，长度双向）
      c2d.save();
      c2d.translate(x, y);
      c2d.rotate(ang);

      // 沿 +X 方向的渐隐
      const g1 = c2d.createLinearGradient(0, 0, spikeLen, 0);
      g1.addColorStop(0, 'rgba(240,248,255,' + (spikeA * 1.1).toFixed(3) + ')');
      g1.addColorStop(0.12, 'rgba(228,242,255,' + (spikeA * 0.72).toFixed(3) + ')');
      g1.addColorStop(0.45, 'rgba(214,234,252,' + (spikeA * 0.22).toFixed(3) + ')');
      g1.addColorStop(1, 'rgba(200,225,250,0)');

      c2d.fillStyle = g1;
      c2d.beginPath();
      c2d.moveTo(0, -spikeW / 2);
      c2d.lineTo(spikeLen, 0);
      c2d.lineTo(0, spikeW / 2);
      c2d.closePath();
      c2d.fill();

      // 沿 -X 方向的渐隐（对称的另一半）
      const g2 = c2d.createLinearGradient(0, 0, -spikeLen, 0);
      g2.addColorStop(0, 'rgba(240,248,255,' + (spikeA * 1.1).toFixed(3) + ')');
      g2.addColorStop(0.12, 'rgba(228,242,255,' + (spikeA * 0.72).toFixed(3) + ')');
      g2.addColorStop(0.45, 'rgba(214,234,252,' + (spikeA * 0.22).toFixed(3) + ')');
      g2.addColorStop(1, 'rgba(200,225,250,0)');

      c2d.fillStyle = g2;
      c2d.beginPath();
      c2d.moveTo(0, -spikeW / 2);
      c2d.lineTo(-spikeLen, 0);
      c2d.lineTo(0, spikeW / 2);
      c2d.closePath();
      c2d.fill();

      c2d.restore();
    }

    // ═══ ④ 点亮时的柔和脉动（不用环，用光晕呼吸）═══
    if (lit || isFocus) {
      const breathe = 0.5 + 0.5 * Math.sin(tt * 1.4);
      const pulseR = diskR * (1.0 + breathe * 0.28);
      const pg = c2d.createRadialGradient(x, y, diskR * 0.5, x, y, pulseR);
      pg.addColorStop(0, hexA(color, 0.10 * breathe * power));
      pg.addColorStop(0.6, hexA(color, 0.04 * breathe * power));
      pg.addColorStop(1, hexA(color, 0));
      c2d.fillStyle = pg;
      c2d.beginPath();
      c2d.arc(x, y, pulseR, 0, TAU);
      c2d.fill();
    }
  }






  /**
   * 星云层 —— 给画面"内容"
   *
   * 实测：79.8% 纯黑 + 19.7% 极暗 = 99.5% 看不见。
   * 真实宇宙不只有星星，还有大面积星云辉光。
   * 画 4 团位置固定、极淡的椭圆柔光，给画面中间调。
   */
  // ═══════════════════════════════════════════════════════════
  //  Bloom 泛光（Canvas 2D 实现）
  // ═══════════════════════════════════════════════════════════


  /**
   * Bloom 泛光（Canvas 2D 降采样叠加）
   *
   * 参考官方 3d-force-graph bloom 示例：
   *   bloomPass.strength = 4, radius = 1, threshold = 0
   *   backgroundColor = 'var(--color-void, var(--color-void, #000003))'
   *
   * Canvas 2D 没有真正的后处理通道，用「降采样 + lighter 叠加」模拟。
   * 强度不能照搬 4（会过曝成白屏），实测 1.2 左右效果最佳。
   */
  function applyBloom(W, H) {
    const PW = cv.width;
    const PH = cv.height;

    if (!S.bloomCanvas) {
      S.bloomCanvas = document.createElement('canvas');
      S.bloomCtx = S.bloomCanvas.getContext('2d');
      S.bloomCanvas2 = document.createElement('canvas');
      S.bloomCtx2 = S.bloomCanvas2.getContext('2d');
    }

    const w4 = Math.max(1, Math.round(PW / 4));
    const h4 = Math.max(1, Math.round(PH / 4));
    const w8 = Math.max(1, Math.round(PW / 8));
    const h8 = Math.max(1, Math.round(PH / 8));

    if (S.bloomCanvas.width !== w4 || S.bloomCanvas.height !== h4) {
      S.bloomCanvas.width = w4;
      S.bloomCanvas.height = h4;
    }
    if (S.bloomCanvas2.width !== w8 || S.bloomCanvas2.height !== h8) {
      S.bloomCanvas2.width = w8;
      S.bloomCanvas2.height = h8;
    }

    // ① 降采样到 1/4（天然模糊）
    S.bloomCtx.clearRect(0, 0, w4, h4);
    S.bloomCtx.drawImage(cv, 0, 0, PW, PH, 0, 0, w4, h4);

    // ② 再降到 1/8（更宽的光晕）
    S.bloomCtx2.clearRect(0, 0, w8, h8);
    S.bloomCtx2.drawImage(S.bloomCanvas, 0, 0, w4, h4, 0, 0, w8, h8);

    // ③ lighter 叠加回主画布
    c2d.save();
    c2d.setTransform(1, 0, 0, 1, 0, 0);

    // ⚠ 强度必须克制：星点多时 0.95 会全白
    c2d.globalCompositeOperation = 'lighter';

    // 窄光晕
    c2d.globalAlpha = 0.34;
    c2d.drawImage(S.bloomCanvas, 0, 0, w4, h4, 0, 0, PW, PH);

    // 宽光晕
    c2d.globalAlpha = 0.16;
    c2d.drawImage(S.bloomCanvas2, 0, 0, w8, h8, 0, 0, PW, PH);

    c2d.restore();
  }

  // ═══════════════════════════════════════════════════════════
  //  星空系统（参考 particles.js 的粒子生命周期）
  // ═══════════════════════════════════════════════════════════

  /** 创建一个星点（随机位置/大小/速度/闪烁相位） */
  function makeStar(W, H) {
    // 分层：远处星（多、暗、慢） / 近处星（少、亮、快）
    const layer = Math.random();
    const isNear = layer > 0.82;

    return {
      // 归一化坐标（0~1），便于 resize 后保持相对位置
      x: Math.random(),
      y: Math.random(),
      // 速度（归一化/帧）：近星快
      vx: (Math.random() - 0.5) * (isNear ? 0.00028 : 0.00011),
      vy: (Math.random() - 0.5) * (isNear ? 0.00028 : 0.00011),
      // 基础亮度
      // 自检：远星 0.22*r+0.06 平均 0.17，乘闪烁(0.55)×生命(0.25)=0.023，被阈值吃掉
      //     提高到 0.45*r+0.22，实际可见亮度约 0.06~0.30
      baseA: isNear ? (Math.random() * 0.40 + 0.42) : (Math.random() * 0.30 + 0.16),
      // 当前亮度（会动）
      a: 0,
      // 半径
      r0: isNear ? (Math.random() * 0.9 + 0.62) : (Math.random() * 0.65 + 0.20),
      r: 0,   // 每帧重算（= r0 × 互动增益）
      // 闪烁（每个星不同频率 + 不同相位）
      twSpeed: Math.random() * 2.2 + 0.6,
      twPhase: Math.random() * TAU,
      // 颜色：绝大多数冷白，少数暖黄（像真实星空）
      warm: Math.random() > 0.88,
      // 生命周期（用于"随机出现/消失"）
      life: Math.random(),
      // 周期 3~12 秒（之前 0.00018 太慢，约 90 秒）
      lifeSpeed: Math.random() * 0.0032 + 0.0014,
      isNear: isNear,
    };
  }

  /**
   * 更新星点位置 + 亮度 + 生命周期 + 与节点团的互动
   *
   * 互动分三层（参考 particles.js attract/repulse）：
   *   ① 鼠标附近：星点被吸引 + 变亮 + 连线（grab 模式）
   *   ② 节点附近：星点被引力场捕获，绕节点微微聚集
   *   ③ 节点点亮：发出冲击波，推开周围星点
   */
  function updateStars(W, H, dt) {
    const mouseX = S.mouse && S.mouse.inside ? S.mouse.nx : -999;
    const mouseY = S.mouse && S.mouse.inside ? S.mouse.ny : -999;

    // ═══ 预计算：节点的屏幕归一化位置（供星点互动）═══
    //   只在有节点时算，避免每帧重复投影
    const nodePos = S.nodeScreenPos || [];
    const litNodes = S.nodeScreenLit || [];

    for (let i = 0; i < S.stars.length; i++) {
      const s = S.stars[i];

      // ── 移动 ──
      s.x += s.vx * dt * 60;
      s.y += s.vy * dt * 60;

      // ── 移出边界 → 重生在另一侧（实现"随机出现"）──
      if (s.x < -0.02) s.x = 1.02;
      else if (s.x > 1.02) s.x = -0.02;
      if (s.y < -0.02) s.y = 1.02;
      else if (s.y > 1.02) s.y = -0.02;

      // ── 生命周期（随机变亮/变暗，像真实的星星闪烁）──
      s.life += s.lifeSpeed * dt * 60;
      if (s.life > 1) {
        s.life = 0;
        // 重生：换随机位置（这就是"随机出现"）
        s.x = Math.random();
        s.y = Math.random();
      }

      // ══════════════════════════════════════════════════════
      //  每帧从基准值重算 a 和 r（关键：不能持久累加）
      //    之前 s.r = Math.max(s.r, s.r*1.85) 导致指数增长 → 全白
      // ══════════════════════════════════════════════════════
      const tw = 0.55 + 0.45 * Math.sin(S.t * s.twSpeed + s.twPhase);
      const lifeCurve = Math.sin(s.life * Math.PI);

      // 自检：0.25 下限让星星大半时间很暗 → 提到 0.55，保持呼吸但不消失
      let a = s.baseA * tw * (0.55 + 0.45 * lifeCurve);
      let rMul = 1;                                        // 半径增益（每帧重置）

      // ══════════════════════════════════════════════════════
      //  背景互动（收敛为 1 层）
      //
      //  用户："与背景之间的互动完全没什么观赏性，反而显得花哨刻意"
      //
      //  之前 3 层同时发生：鼠标引力 + 节点引力 + 冲击波
      //    → 星点被拉扯、推开、聚集，看起来"忙"且刻意
      //
      //  现在只保留：**鼠标附近极微弱的亮度提升**
      //    · 不加引力（不改位置）
      //    · 不加冲击波
      //    · 只在光标周围 45px 内让星点亮一点点（最多 +22%）
      //  星点保持安静流动，鼠标靠近时"呼吸一下"
      // ══════════════════════════════════════════════════════
      if (mouseX > -900) {
        const dx = s.x - mouseX;
        const dy = s.y - mouseY;
        const d2 = dx * dx + dy * dy;
        const R2 = 0.042 * 0.042;
        if (d2 < R2) {
          const k = 1 - d2 / R2;
          a = a + k * 0.20;        // 只微亮
          rMul = 1 + k * 0.12;     // 只微大
        }
      }

      // ═══ 最终赋值（钳制到安全范围）═══
      s.a = a > 1 ? 1 : (a < 0 ? 0 : a);
      s.r = s.r0 * rMul;
    }
  }

  /** 画星点 */
  function drawStars(W, H) {
    if (!S.stars.length) return;

    // 先更新（移动+闪烁+互动）
    updateStars(W, H, 1 / 60);

    // ── 画附近的星点之间的连线（particles.js 的 line_linked）──
    //   只在鼠标附近画，避免全画布 O(n²)
    if (S.mouse && S.mouse.inside) {
      const mx = S.mouse.nx, my = S.mouse.ny;
      const linked = [];
      for (const s of S.stars) {
        const dx = s.x - mx, dy = s.y - my;
        if (dx * dx + dy * dy < 0.075 * 0.075) linked.push(s);
      }
      c2d.strokeStyle = 'rgba(120,180,225,0.16)';
      c2d.lineWidth = 0.7;
      for (let i = 0; i < linked.length; i++) {
        for (let j = i + 1; j < linked.length; j++) {
          const a = linked[i], b = linked[j];
          const dx = (a.x - b.x) * W, dy = (a.y - b.y) * H;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > W * 0.085) continue;
          c2d.beginPath();
          c2d.moveTo(a.x * W, a.y * H);
          c2d.lineTo(b.x * W, b.y * H);
          c2d.stroke();
        }
      }
      // 鼠标到附近星点的连线（grab 模式）
      c2d.strokeStyle = 'rgba(140,200,240,0.22)';
      c2d.lineWidth = 0.9;
      for (const s of linked) {
        c2d.beginPath();
        c2d.moveTo(mx * W, my * H);
        c2d.lineTo(s.x * W, s.y * H);
        c2d.stroke();
      }
    }

    // ── 画星点 ──
    for (const s of S.stars) {
      if (s.a <= 0.012) continue;
      const px = s.x * W, py = s.y * H;

      const col = s.warm ? '255,235,200' : '185,215,245';
      c2d.fillStyle = 'rgba(' + col + ',' + s.a + ')';
      c2d.beginPath();
      c2d.arc(px, py, s.r, 0, TAU);
      c2d.fill();

      // 近星光晕：只给最亮且被激活的星（Bloom 会放大）
      //   ⚠ 之前 a>0.35 就画，星点太多时叠加过曝
      if (s.isNear && s.a > 0.72) {
        const gg = c2d.createRadialGradient(px, py, 0, px, py, s.r * 3.2);
        gg.addColorStop(0, 'rgba(' + col + ',' + (s.a * 0.16) + ')');
        gg.addColorStop(1, 'rgba(' + col + ',0)');
        c2d.fillStyle = gg;
        c2d.beginPath();
        c2d.arc(px, py, s.r * 3.2, 0, TAU);
        c2d.fill();
      }
    }
  }

  function renderStats() {
    const counts = {};
    for (const n of S.scenes) counts[n.domain] = (counts[n.domain] || 0) + 1;

    stats.innerHTML = '';
    for (const d of Object.keys(counts)) {
      const el = document.createElement('span');
      el.style.cssText =
        'display:inline-flex;align-items:center;gap:4px;height:15px;padding:0 5px;' +
        'background:rgba(10,15,21,.85);border:1px solid var(--color-hover, var(--color-hover, #1A2028));border-radius:2px;' +
        'color:' + C.text2 + ';white-space:nowrap;font-size:9.5px;';
      el.innerHTML =
        '<span style="width:5px;height:5px;border-radius:50%;background:' +
        (DOMAIN_COLOR[d] || DOMAIN_COLOR.other) + ';flex:0 0 5px"></span>' +
        (DOMAIN_LABEL[d] || d) + ' <b style="color:' + C.text + '">' + counts[d] + '</b>';
      stats.appendChild(el);
    }

    const lit = S.scenes.filter(function (n) { return n.lit; }).length;
    if (lit) {
      const el = document.createElement('span');
      el.style.cssText =
        'display:inline-flex;align-items:center;height:15px;padding:0 5px;' +
        'background:rgba(229,194,74,.13);border:1px solid rgba(229,194,74,.32);' +
        'border-radius:2px;color:var(--gu-huang, #E5C24A);white-space:nowrap;font-size:9.5px;';
      el.textContent = '调度中 ' + lit;
      stats.appendChild(el);
    }

    // 拖拽提示
    const dragged = S.scenes.filter(function (n) { return n.dragged; }).length;
    if (dragged) {
      const el = document.createElement('span');
      el.style.cssText =
        'display:inline-flex;align-items:center;height:15px;padding:0 5px;' +
        'background:rgba(111,176,220,.10);border:1px solid rgba(111,176,220,.28);' +
        'border-radius:2px;color:var(--gu-qing, #6FB0DC);white-space:nowrap;font-size:9.5px;cursor:pointer;';
      el.textContent = '已移动 ' + dragged + ' · 点整理复位';
      el.addEventListener('click', tidy);
      stats.appendChild(el);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  命中检测（含拖拽优先级：朝前的优先）
  // ═══════════════════════════════════════════════════════════
  function hitTest(mx, my) {
    const W = cv.clientWidth, H = cv.clientHeight;

    // ══════════════════════════════════════════════════════
    //  ★ 撤销视图变换（viewScale/pan）后，再与投影结果比对
    //    render 里：屏幕 = viewScale × 投影 + pan
    //    所以投影坐标对应的屏幕位置也要按这个公式算
    // ══════════════════════════════════════════════════════
    const vs = S.viewScale || 1;
    const px = S.panX || 0;
    const py = S.panY || 0;

    const cx = W / 2, cy = H / 2;
    const R = S.radius || Math.min(W, H) * 0.46 * S.zoom;
    const fov = (S.radiusX || R) * 2.6 / S.zoom;

    let best = null, bestZ = -1e9;
    for (const n of S.scenes) {
      const p3 = rotate3d(n.sx, n.sy, n.sz, S.yaw, S.pitch);
      const pr = project3d(p3, cx, cy, fov);
      const deg = Math.max(0, Math.min(10, n.degree || 0));
      const baseRp = n.r * (0.78 + deg * 0.048);

      // ★ 投影坐标 → 屏幕坐标（应用视图变换）
      const screenSx = pr.sx * vs + px;
      const screenSy = pr.sy * vs + py;
      // 命中半径也随缩放
      const rr = Math.max(6, (baseRp * pr.scale + 6) * vs);

      const dx = mx - screenSx, dy = my - screenSy;
      if (dx * dx + dy * dy <= rr * rr && p3.z > bestZ) {
        bestZ = p3.z;
        best = n;
      }
    }
    return best;
  }

  // ═══════════════════════════════════════════════════════════
  //  点击展开附属信息（用户要求：记忆/角色卡/技能/MCP 与节点交互显示）
  // ═══════════════════════════════════════════════════════════
  function showDetail(n) {
    if (!n) { detail.style.display = 'none'; return; }
    // ★ 自检修复：清理死代码时误删了这行，导致面板不显示
    detail.style.display = 'block';
    const rows = [];

    rows.push('<div>领域：<span style="color:' + C.text2 + '">' +
      (DOMAIN_LABEL[n.domain] || n.domain) + '</span></div>');
    // ══════════════════════════════════════════════════════
    //  ★ 国学：五行阶段（guoxue.js 的实际使用）
    //
    //  自检发现：guoxue.js 定义了但从未被调用
    //  这里显示该场景当前处于五行的哪个阶段
    //  依据见 inferPhase() 的注释（不是随意贴标签）
    // ══════════════════════════════════════════════════════
    {
      const phase = inferPhase({
        hasSession: !!n.sessionId,
        running: n.lit,
        hasArtifact: !!n.hasArtifact,
        memoryOk: !!(n.attachments && n.attachments.memory),
        archived: false,
      });

      rows.push(
        '<div style="display:flex;align-items:center;gap:5px;margin:5px 0">' +
        '<span style="color:' + C.text3 + '">阶段：</span>' +
        '<span style="display:inline-flex;align-items:center;gap:4px;' +
        'padding:1px 6px;background:' + phase.color + '1F;' +
        'border:1px solid ' + phase.color + '66;border-radius:2px;' +
        'color:' + phase.color + ';font-size:9.5px">' +
        '<b>' + phase.name + '</b>' + phase.action + ' · ' + phase.phase +
        '</span></div>'
      );
      // 五行小提示（可读性）
      rows.push(
        '<div style="color:' + C.text4 + ';font-size:9px;line-height:1.5">' +
        phase.desc + '</div>'
      );
    }

    // 职责（没有时给明确提示，而不是留空）
    if (n.role) {
      rows.push('<div style="margin:3px 0;line-height:1.6;color:' + C.text2 + '">' +
        esc(String(n.role).slice(0, 90)) + '</div>');
    } else {
      rows.push('<div style="margin:3px 0;color:' + C.text4 + ';font-size:9.5px">' +
        '（该场景未填写职责描述，可在 sceneboard/scenes/' + esc(n.id) + '.json 补充）</div>');
    }
    // 关联场景（列出具体名字，而不是只有数字）
    const linkedNames = [];
    for (const e of S.edges) {
      if (e.a === n.id) {
        const o = S.byId[e.b];
        if (o) linkedNames.push(o.name);
      } else if (e.b === n.id) {
        const o = S.byId[e.a];
        if (o) linkedNames.push(o.name);
      }
    }
    if (linkedNames.length) {
      rows.push('<div>关联：<span style="color:' + C.text2 + '">' +
        esc(linkedNames.slice(0, 4).join('、')) +
        (linkedNames.length > 4 ? ' 等 ' + linkedNames.length + ' 个' : '') +
        '</span></div>');
    } else {
      rows.push('<div>关联：<span style="color:' + C.text4 + '">暂无</span></div>');
    }
    rows.push('<div>状态：<span style="color:' + (n.lit ? 'var(--gu-huang, #E5C24A)' : C.text3) + '">' +
      (n.lit ? '● 正在调度' : '○ 待命') + '</span></div>');

    // 附属物（用户要求：交互时显示）
    const att = n.attachments || {};
    const attachItems = [];
    if (att.identity) attachItems.push('身份卡');
    if (att.memory) attachItems.push('私有记忆');
    if (att.panels) attachItems.push('面板 ' + att.panels + ' 块');
    if (att.skills && att.skills.length) attachItems.push('能力 ' + att.skills.length + ' 项');
    if (att.mcp && att.mcp.length) attachItems.push('MCP ' + att.mcp.length + ' 个');

    if (attachItems.length) {
      rows.push('<div style="margin-top:7px;padding-top:7px;border-top:1px solid var(--color-panel, #1A1F26)">' +
        '<div style="color:' + C.text3 + ';font-size:9.5px;margin-bottom:3px">附属资源</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:3px">' +
        attachItems.map(function (x) {
          return '<span style="display:inline-block;padding:1px 5px;background:rgba(111,176,220,.12);' +
            'border:1px solid rgba(111,176,220,.24);border-radius:2px;color:var(--gu-qing-light, #9FC5E0);font-size:9px">' +
            esc(x) + '</span>';
        }).join('') +
        '</div></div>');
    }

    detail.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' +
      '<span style="width:8px;height:8px;border-radius:50%;background:' + (n.color || 'var(--gu-qing-light, #8FC4E8)') + '"></span>' +
      '<span style="font-weight:600;font-size:11.5px">' + esc(n.name) + '</span></div>' +
      '<div style="color:' + C.text3 + ';line-height:1.8">' + rows.join('') + '</div>';
  }

  // ═══════════════════════════════════════════════════════════
  //  点亮
  // ═══════════════════════════════════════════════════════════
  function lightScene(sceneId, on) {
    const bare = String(sceneId || '').replace(/^scene-/, '');
    let hit = 0;
    for (const n of S.scenes) {
      if (n.id === bare || n.id === sceneId) {
        n.lit = !!on;
        hit++;
      }
    }
    if (on && hit) startAnim();
    render();
    return hit > 0;
  }

  // ═══════════════════════════════════════════════════════════
  //  动画
  // ═══════════════════════════════════════════════════════════
  function startAnim() {
    if (S.animId || S.destroyed) return;
    const loop = function () {
      if (S.destroyed) { S.animId = 0; return; }
      render();
      S.animId = requestAnimationFrame(loop);
    };
    S.animId = requestAnimationFrame(loop);
  }

  // ═══════════════════════════════════════════════════════════
  //  交互
  // ═══════════════════════════════════════════════════════════
  cv.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;

    const n = hitTest(ev.offsetX, ev.offsetY);

    // ★ 拖拽/旋转开始时清空缩放锚点（避免视角混乱）
    S.zoomAnchor = null;

    // ══════════════════════════════════════════════════════
    //  ★ 拖拽快照：只在按下瞬间记录当前焦点
    //    目的：拖拽背景时不熄灭**原先已有**的高亮
    //    但：拖拽期间划过的新节点**不**记录（避免误高亮）
    // ══════════════════════════════════════════════════════
    S.dragSnapshot = (S.sel && S.sel.id) || (S.hover && S.hover.id) || null;

    if (n) {
      // 拖节点
      S.draggingNode = n;
      S.lastX = ev.offsetX;
      S.lastY = ev.offsetY;
      cv.style.cursor = 'grabbing';

      // ★ 记录抓取偏移：鼠标位置与节点投影中心的差值
      //   避免按下瞬间节点"跳到鼠标中心"
      try {
        const cvW = cv.clientWidth, cvH = cv.clientHeight;
        const cfov = (S.radiusX || S.radius || 1) * 2.6 / S.zoom;
        const curR = rotate3d(n.sx, n.sy, n.sz, S.yaw, S.pitch);
        const denom = cfov / (cfov + curR.z);
        const nodeScreenX = cvW / 2 + curR.x * denom;
        const nodeScreenY = cvH / 2 + curR.y * denom;
        // ★ 撤销视图变换（与拖拽时保持一致）
        const vsG = S.viewScale || 1;
        const pxG = S.panX || 0;
        const pyG = S.panY || 0;
        S.dragGrab = {
          x: (ev.offsetX - pxG) / vsG - nodeScreenX,
          y: (ev.offsetY - pyG) / vsG - nodeScreenY,
        };
      } catch (e) {
        S.dragGrab = { x: 0, y: 0 };
      }
    } else {
      // 旋转视图
      S.rotating = true;
      S.lastX = ev.offsetX;
      S.lastY = ev.offsetY;
      cv.style.cursor = 'grabbing';
    }
    // ★ 记录按下起点，用于区分 click vs drag
    S.downX = ev.offsetX;
    S.downY = ev.offsetY;
    S.movedDist = 0;

    cv.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  cv.addEventListener('pointermove', function (ev) {
    // ★ 更新归一化鼠标坐标（供背景互动）
    const W0 = cv.clientWidth, H0 = cv.clientHeight;
    S.mouse.x = ev.offsetX;
    S.mouse.y = ev.offsetY;
    S.mouse.nx = ev.offsetX / W0;
    S.mouse.ny = ev.offsetY / H0;
    S.mouse.inside = true;

    // ★ 累计移动距离（用于区分 click vs drag）
    if (S.downX != null) {
      const ddx = ev.offsetX - S.downX;
      const ddy = ev.offsetY - S.downY;
      S.movedDist = Math.sqrt(ddx * ddx + ddy * ddy);
    }

    // ── 拖节点 ──
    if (S.draggingNode) {
      // ══════════════════════════════════════════════════════
      //  拖拽：精确 1:1 跟随（用户要求 0 延迟）
      //
      //  实测旧实现：偏差从 2px 累积到 21px
      //    原因：增量换算 + 错误的逆旋转顺序
      //
      //  新实现：直接指定"节点应投影到哪个屏幕坐标"
      //    ① 保持节点深度（rotate 空间 z）不变
      //    ② 反解出要让节点投影到目标屏幕位置所需的 rotate 坐标
      //    ③ 逆旋转回世界坐标
      //    → 数学上精确，零累积误差
      // ══════════════════════════════════════════════════════
      const n = S.draggingNode;
      const cvW = cv.clientWidth, cvH = cv.clientHeight;
      const ccx = cvW / 2, ccy = cvH / 2;
      const cfov = (S.radiusX || S.radius || 1) * 2.6 / S.zoom;

      // 当前 rotate 空间位置（含深度 z）
      const curR = rotate3d(n.sx, n.sy, n.sz, S.yaw, S.pitch);
      const denom = cfov / (cfov + curR.z);
      if (denom <= 0.01) { render(); return; }

      // 抓取偏移（按下时记录，避免节点"跳到鼠标中心"）
      const grab = S.dragGrab || { x: 0, y: 0 };

      // ★ 撤销视图变换：鼠标位置 → 投影空间坐标
      const vsTarget = S.viewScale || 1;
      const pxTarget = S.panX || 0;
      const pyTarget = S.panY || 0;

      // 目标：让 "节点投影位置 = (鼠标 - pan) / viewScale - grab"
      const targetScreenX = (ev.offsetX - pxTarget) / vsTarget - grab.x;
      const targetScreenY = (ev.offsetY - pyTarget) / vsTarget - grab.y;

      // 反解 rotate 坐标（保持 z 不变）
      const targetRx = (targetScreenX - ccx) / denom;
      const targetRy = (targetScreenY - ccy) / denom;

      // 逆旋转回世界坐标
      const world = inverseRotate3d(targetRx, targetRy, curR.z, S.yaw, S.pitch);

      n.sx = world.x;
      n.sy = world.y;
      n.sz = world.z;
      n.dragged = true;

      S.lastX = ev.offsetX;
      S.lastY = ev.offsetY;
      render();
      return;
    }

    // ── 旋转视图 ──
    if (S.rotating) {
      const dx = ev.offsetX - S.lastX;
      const dy = ev.offsetY - S.lastY;
      const W0 = cv.clientWidth, H0 = cv.clientHeight;

      // ══════════════════════════════════════════════════════
      //  ★ 旋转：按 Three.js OrbitControls 标准实现
      //
      //  用户："稍微转一下就不知道转到哪了"
      //
      //  自检：我的实现 547px/圈，OrbitControls 是 1572px/圈
      //        → 我快了 2.9 倍，难怪转不明白
      //
      //  OrbitControls 公式：
      //    rotateAngle = 2π × deltaX / clientHeight × rotateSpeed
      //    → 拖过画布高度 = 180°（半圈）
      //    → 拖过 2 倍高度 = 一圈
      //
      //  修正：
      //    yaw:   2π × dx / H / 2 = π × dx / H
      //    pitch: 2π × dy / H / 2（同样按高度，保证 x/y 手感一致）
      // ══════════════════════════════════════════════════════
      const ROTATE_SPEED = 1.0;   // 与 OrbitControls 默认值一致
      const yawDelta = (Math.PI * dx / H0) * ROTATE_SPEED;
      const pitchDelta = (Math.PI * dy / H0) * ROTATE_SPEED;

      S.yaw += yawDelta;

      // 极角限制（OrbitControls: minPolarAngle ~ maxPolarAngle）
      //   polar ∈ [0.22, 2.92] rad  →  等价 pitch ∈ [-1.35, 1.35]
      const PITCH_MIN = -1.35;
      const PITCH_MAX = 1.35;
      let nextPitch = S.pitch + pitchDelta;

      // 软钳制：接近边界时渐进减速（OrbitControls 是硬停，我们用稍柔和的）
      if (nextPitch > PITCH_MAX) {
        nextPitch = PITCH_MAX + (nextPitch - PITCH_MAX) * 0.06;
      } else if (nextPitch < PITCH_MIN) {
        nextPitch = PITCH_MIN + (nextPitch - PITCH_MIN) * 0.06;
      }
      S.pitch = Math.max(-1.42, Math.min(1.42, nextPitch));

      S.lastX = ev.offsetX;
      S.lastY = ev.offsetY;
      render();
      return;
    }

    // ── 悬停 ──
    //  ★ 修复：拖拽期间不检测悬停（避免"划过节点就被高亮"）
    if (S.rotating || S.draggingNode) return;

    const n = hitTest(ev.offsetX, ev.offsetY);
    if (n !== S.hover) {
      S.hover = n;
      // 不再记录 stickyFocus —— 只有点击(sel)才是持久高亮

      cv.style.cursor = n ? 'pointer' : 'grab';
      render();
    }
  });

  function endDrag() {
    S.draggingNode = null;
    S.rotating = false;
    cv.style.cursor = 'grab';

    // ★ 自检修复：松手后清除拖拽快照
    //   否则"拖拽前的高亮"会永久保留
    S.dragSnapshot = null;
  }

  cv.addEventListener('pointerleave', function () {
    S.mouse.inside = false;
  });
  cv.addEventListener('pointerenter', function () {
    S.mouse.inside = true;
  });
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);

  cv.addEventListener('click', function (ev) {
    // ══════════════════════════════════════════════════════
    //  自检修复：拖拽后误触发 click，把 sel 清空
    //
    //  场景：点击选中节点 → 拖拽背景（鼠标经过节点）→ 松手
    //        → 浏览器派发 click → sel 被切成 null
    //
    //  修法：移动距离 > 5px 视为拖拽，不处理 click
    //        （这是所有专业画布应用的标配）
    // ══════════════════════════════════════════════════════
    if (S.movedDist > 5) {
      S.movedDist = 0;
      S.downX = null;
      S.downY = null;
      return;   // 拖拽结束，不触发选中
    }
    S.movedDist = 0;
    S.downX = null;
    S.downY = null;

    const n = hitTest(ev.offsetX, ev.offsetY);
    if (n && n.dragged && S.dragJustEnded) {
      S.dragJustEnded = false;
      return;
    }
    S.sel = (n && S.sel && S.sel.id === n.id) ? null : n;
    showDetail(S.sel);
    render();
  });

  // ═══════════════════════════════════════════════════════════
  //  ★ 双击节点 → 切换场景（用户要求）
  // ═══════════════════════════════════════════════════════════
  cv.addEventListener('dblclick', function (ev) {
    const n = hitTest(ev.offsetX, ev.offsetY);
    if (!n) return;

    // 双击后清除单击产生的选中态（避免残留）
    const sceneId = n.id;

    // 提示：正在切换
    showToast('切换到场景：' + n.name, 'info');

    // 调用场景切换（index.js 暴露的 util.switchScene 或 dispatch）
    (async function () {
      try {
        // 优先用 window.__WB 暴露的切换方法
        if (window.__WB && typeof window.__WB.switchScene === 'function') {
          await window.__WB.switchScene(sceneId);
          return;
        }
        // 退而求其次：用 api.util.dispatch
        if (api && api.util && typeof api.util.dispatch === 'function') {
          await api.util.dispatch(sceneId);
          return;
        }
        // 最后：通过 bus 发事件（index.js 应监听）
        if (window.__WB && window.__WB.bus && typeof window.__WB.bus.emit === 'function') {
          window.__WB.bus.emit('scene:switch', { sceneId: sceneId });
        }
      } catch (e) {
        console.warn('[neuron] 切换场景失败', e);
        showToast('切换失败: ' + e.message, 'bad');
      }
    })();
  });

  cv.addEventListener('wheel', function (ev) {
    ev.preventDefault();

    // ══════════════════════════════════════════════════════════
    //  ★ 滚轮 = 画布级 2D 缩放（借鉴 Photoshop / ComfyUI）
    //
    //  用户："滚轮应该是应用于画面缩放上，
    //        可以借鉴 photoshop、comfyui 之类的做法"
    //
    //  自检：之前用 fov 变化 = 3D 透视缩放
    //        → 近处物体放大很多、远处几乎不变 → 变形
    //  现在：viewScale = 2D 仿射变换，整个画面等比缩放
    //
    //  锚点：缩放时光标下的**世界点**保持不动
    //    ① 记录光标相对画布的归一化位置
    //    ② 缩放后调整 panX/panY，让该点仍在光标下
    // ══════════════════════════════════════════════════════════

    const W = cv.clientWidth, H = cv.clientHeight;

    const mx = ev.offsetX;
    const my = ev.offsetY;

    const oldScale = S.viewScale || 1;
    const oldPanX = S.panX || 0;
    const oldPanY = S.panY || 0;

    // 指数缩放（deltaY 感知）
    const delta = -ev.deltaY;
    const factor = Math.exp(delta * 0.0016);
    const newScale = Math.max(0.25, Math.min(5.0, oldScale * factor));

    if (Math.abs(newScale - oldScale) < 0.0001) return;

    // ══════════════════════════════════════════════════════
    //  ★ 锚点补偿（自检修复：之前多减了 W/2，偏差 610px）
    //
    //  屏幕 = proj × vs + pan  →  proj = (screen - pan) / vs
    //  锚点要求：光标下的投影点保持不动
    //    mx = projP × vs1 + pan1
    //  → pan1 = mx - (mx - pan0)/vs0 × vs1
    // ══════════════════════════════════════════════════════
    S.panX = mx - (mx - oldPanX) / oldScale * newScale;
    S.panY = my - (my - oldPanY) / oldScale * newScale;

    S.viewScale = newScale;

    // 平移范围限制（避免画面完全移出视野）
    const maxPanX = W * 0.95;
    const maxPanY = H * 0.95;
    S.panX = Math.max(-maxPanX, Math.min(maxPanX, S.panX));
    S.panY = Math.max(-maxPanY, Math.min(maxPanY, S.panY));

    render();
  }, { passive: false });

  search.addEventListener('input', function () {
    S.filter = search.value.trim();
    updateSearchHint();
    render();
  });

  // ══════════════════════════════════════════════════════════════
  //  ★ 2026-11-11：搜索提示文案
  //
  //  三种状态：
  //    · 没输入        → 隐藏提示
  //    · 有输入且有命中 → 显示「找到 N 个」（放在状态栏，不挡画面）
  //    · 有输入但零命中 → 画面中心显示「没找到」，并说明怎么清空
  //
  //  为什么零命中要放画面中心：用户那时只关心「为什么没反应」，
  //  必须一眼看到，不能藏在小字里。
  // ══════════════════════════════════════════════════════════════
  function matchScene(n, q) {
    if (!q) return true;
    const ql = q.toLowerCase();
    return (
      String(n.name || '').toLowerCase().indexOf(ql) >= 0 ||
      String(n.id || '').toLowerCase().indexOf(ql) >= 0 ||
      String(n.domain || '').toLowerCase().indexOf(ql) >= 0 ||
      String(n.role || '').toLowerCase().indexOf(ql) >= 0 ||
      String(n.desc || '').toLowerCase().indexOf(ql) >= 0
    );
  }

  function updateSearchHint() {
    const q = String(S.filter || '').trim();
    if (!q) {
      emptyEl.style.display = 'none';
      return;
    }
    const hits = S.scenes.filter(function (n) { return matchScene(n, q); });
    if (hits.length === 0) {
      emptyEl.textContent =
        '没找到匹配「' + q + '」的场景\n' +
        '试试搜：架构 / 实施 / 调研 / 逆向 / 复盘\n' +
        '或按 Esc / 点输入框的 × 清空';
      emptyEl.style.display = 'block';
    } else {
      emptyEl.style.display = 'none';
      // 命中 1 个时直接告诉用户是哪个
      if (hits.length === 1) {
        emptyEl.textContent = '找到：' + hits[0].name;
        emptyEl.style.color = C.text2 || C.text;
        emptyEl.style.display = 'block';
        // 1 秒后自动淡出（不长期挡画面）
        setTimeout(function () {
          if (String(S.filter || '').trim() === q && hits.length === 1) {
            emptyEl.style.display = 'none';
          }
        }, 1200);
      }
    }
  }

  // Esc 清空搜索（用户习惯）
  search.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      search.value = '';
      S.filter = '';
      updateSearchHint();
      render();
      ev.preventDefault();
    }
  });

  // ★ 整理按钮
  btnTidy.addEventListener('click', tidy);

  // ★ 更新按钮
  btnRefresh.addEventListener('click', function () {
    btnRefresh.textContent = '…';
    refresh().then(function () { btnRefresh.textContent = '更新'; })
      .catch(function () { btnRefresh.textContent = '更新'; });
  });

  btnReset.addEventListener('click', function () {
    S.yaw = 0.4; S.pitch = -0.25; S.zoom = 1;
    layout();
    render();
  });

  // ═══════════════════════════════════════════════════════════
  //  ★ 新场景支持：热更新 + 变化检测 + 自动刷新
  // ═══════════════════════════════════════════════════════════

  /**
   * 检测场景变化（新增 / 删除 / 改名）
   * @param {Array} nextScenes 新拉取的场景列表
   * @returns {object} { added: [], removed: [], renamed: [] }
   */
  function detectChanges(nextScenes) {
    const prevIds = new Set(S.lastSceneIds);
    const nextIds = new Set(nextScenes.map(function (s) { return s.id; }));

    const added = nextScenes.filter(function (s) { return !prevIds.has(s.id); });
    const removed = S.lastSceneIds.filter(function (id) { return !nextIds.has(id); });

    // 改名检测
    const renamed = [];
    const prevByName = {};
    for (const n of S.scenes) prevByName[n.id] = n.name;
    for (const s of nextScenes) {
      if (prevByName[s.id] && prevByName[s.id] !== (s.name || s.id)) {
        renamed.push({ id: s.id, from: prevByName[s.id], to: s.name || s.id });
      }
    }

    return { added: added, removed: removed, renamed: renamed };
  }

  /**
   * 热更新：重新拉取场景并重建图谱（无需重启工作台）
   *
   * 触发方式：
   *   ① 自动：每 8 秒轮询注册表变化（只检查 mtime，很轻）
   *   ② 手动：「⟳」按钮或场景变化事件
   */
  async function refresh(opts) {
    const o = opts || {};
    try {
      const d = await loadData();
      const changes = detectChanges(d.scenes);

      // 保留已被拖拽的节点位置（不因刷新而复位）
      for (const n of d.scenes) {
        const old = S.byId[n.id];
        if (old && old.dragged) {
          n.sx = old.sx; n.sy = old.sy; n.sz = old.sz;
          n.dragged = true;
        }
      }

      S.scenes = d.scenes;
      S.edges = d.edges;
      S.lastSceneIds = d.scenes.map(function (s) { return s.id; });

      // 记录新场景（用于高亮提示）
      S.newSceneIds = new Set(changes.added.map(function (s) { return s.id; }));

      // 新增场景的提示气泡
      if (changes.added.length) {
        showToast('新增 ' + changes.added.length + ' 个场景：' +
          changes.added.slice(0, 3).map(function (s) { return s.name || s.id; }).join('、') +
          (changes.added.length > 3 ? ' 等' : ''), 'info');
      }
      if (changes.removed.length) {
        showToast('移除 ' + changes.removed.length + ' 个场景', 'warn');
      }
      if (changes.renamed.length) {
        showToast('重命名 ' + changes.renamed.length + ' 个场景', 'info');
      }

      layout();
      render();

      // 新场景高亮 3 秒后自动消退
      if (S.newSceneIds.size) {
        setTimeout(function () {
          S.newSceneIds.clear();
          render();
        }, 3000);
      }

      return changes;
    } catch (e) {
      console.error('[neuron] refresh 失败', e);
      showToast('刷新失败: ' + e.message, 'bad');
      return null;
    }
  }

  /** 轻量提示气泡 */
  function showToast(msg, tone) {
    // 移除旧的
    const old = wrap.querySelector('.neuron-toast');
    if (old) old.remove();

    const el = document.createElement('div');
    el.className = 'neuron-toast';
    const color = tone === 'warn' ? 'var(--gu-cinn, #E68069)' : (tone === 'bad' ? 'var(--gu-chi, #EC6B58)' : 'var(--gu-qing, #6FB0DC)');
    el.style.cssText =
      'position:absolute;left:50%;top:44px;transform:translateX(-50%);' +
      'padding:5px 12px;background:rgba(10,14,20,.94);' +
      'border:1px solid ' + color + '44;border-radius:3px;' +
      'color:' + color + ';font:10px "JetBrains Mono",monospace;' +
      'white-space:nowrap;z-index:8;pointer-events:none;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.6);';
    el.textContent = msg;
    wrap.appendChild(el);

    setTimeout(function () {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 320);
    }, 2400);
  }

  /**
   * 自动刷新：每 8 秒检查一次场景列表是否变化
   * 只比 id 集合，不重建（无变化时不做事）
   */
  function startAutoRefresh() {
    if (S.autoRefreshTimer) return;
    S.autoRefreshTimer = setInterval(async function () {
      if (S.destroyed) {
        clearInterval(S.autoRefreshTimer);
        S.autoRefreshTimer = 0;
        return;
      }
      try {
        if (!api || !api.util || !api.util.scenes) return;
        const r = await api.util.scenes();
        if (!r.ok) return;
        const ids = (r.items || [])
          .filter(function (s) { return !s.isHub; })
          .map(function (s) { return s.id; })
          .sort()
          .join(',');

        const curIds = S.scenes.map(function (s) { return s.id; }).sort().join(',');
        if (ids !== curIds) {
          // 有变化 → 触发刷新
          refresh();
        }
      } catch (e) { /* 静默 */ }
    }, 8000);
  }

  // ═══════════════════════════════════════════════════════════
  //  初始化
  // ═══════════════════════════════════════════════════════════
  let ro = null;

  function resize() {
    const W = cv.clientWidth, H = cv.clientHeight;
    if (W < 2 || H < 2) return;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    c2d.setTransform(DPR, 0, 0, DPR, 0, 0);
    layout();
    render();
  }

  async function init() {
    render();
    try {
      const d = await loadData();
      S.scenes = d.scenes;
      S.edges = d.edges;
      S.lastSceneIds = d.scenes.map(function (s) { return s.id; });
      S.ready = true;
      layout();
      render();
      startAnim();
      startAutoRefresh();
      console.log('[neuron 星域] ' + d.scenes.length + ' 场景 / ' +
        d.edges.length + ' 关联，R=' + Math.round(S.radius || 0));
    } catch (e) {
      console.error('[neuron] 加载失败', e);
      stats.textContent = '加载失败: ' + e.message;
    }
  }

  ro = new ResizeObserver(function () { resize(); });
  ro.observe(cv);
  setTimeout(init, 60);

  const inst = {
    el: wrap,
    lightScene: lightScene,
    tidy: tidy,
    refresh: refresh,
    // ★ 自检：暴露 resetView（测试/用户都可调用，避免脏状态）
    resetView: function () {
      S.yaw = 0.4;
      S.pitch = -0.25;
      S.zoom = 1;
      for (const n of S.scenes) n.dragged = false;
      layout();
      render();
    },
    state: S,
    nodes: function () { return S.scenes; },
    update: function () { layout(); render(); },
    destroy: function () {
      S.destroyed = true;
      if (ro) ro.disconnect();
      if (S.animId) cancelAnimationFrame(S.animId);
      if (S.autoRefreshTimer) clearInterval(S.autoRefreshTimer);

      // ★ 自检修复：从全局数组移除自己，避免实例累积
      try {
        if (window.__NEURON3D) {
          const i1 = window.__NEURON3D.indexOf(inst);
          if (i1 >= 0) window.__NEURON3D.splice(i1, 1);
        }
        if (window.__WB && window.__WB.neuron3d) {
          const i2 = window.__WB.neuron3d.indexOf(inst);
          if (i2 >= 0) window.__WB.neuron3d.splice(i2, 1);
        }
        if (host && host.__neuronInst === inst) host.__neuronInst = null;
      } catch (e) { /* 忽略 */ }
    },
  };

  // ★ 自检修复：注册前先清理已销毁的旧实例（防御性）
  const G = window.__NEURON3D || (window.__NEURON3D = []);
  for (let i = G.length - 1; i >= 0; i--) {
    if (G[i] && G[i].state && G[i].state.destroyed) G.splice(i, 1);
  }
  G.push(inst);

  if (window.__WB) {
    const W3 = window.__WB.neuron3d || (window.__WB.neuron3d = []);
    for (let i = W3.length - 1; i >= 0; i--) {
      if (W3[i] && W3[i].state && W3[i].state.destroyed) W3.splice(i, 1);
    }
    W3.push(inst);
  }

  try { host.__neuronInst = inst; } catch (e) { /* 忽略 */ }

  return inst;
}

export default createNeuron3D;
