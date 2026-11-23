// ui/panels/constellation.js —— 场景编排引擎（星官体系）
//
// ══════════════════════════════════════════════════════════════════════════
//  解决的问题（用户质疑）：
//    「如果有几百几千个场景需要融入，你又该怎么编排呢」
//
// ══════════════════════════════════════════════════════════════════════════
//  错误做法（我之前）：
//    每个场景固定角度 = 2π / N
//    → N 越大越挤，1000 个时全部糊成一圈
//
//  正解：三层 LOD + 面积正比扇区 + 径向树
//
//    LOD 0  (N ≤ 8)    直接均分环（小规模，简单即是好）
//    LOD 1  (9 ≤ N ≤ 200)   按二十八宿分扇区，扇区角度 ∝ 宿内场景数
//    LOD 2  (N > 200)   只画宿聚合节点，点击展开
//
//  关键性质：
//    ① 每个场景占据的「角面积」恒定 → N 再大也不挤
//    ② 宿内用径向树 → 单个宿内也不挤
//    ③ 按 role 关键词自动归宿 → 无需手工配置
//
//  ═══════════════════════════════════════════════════════════════════════
//  为什么用二十八宿：
//    中国古代把星空分「三垣二十八宿」，每宿含若干「星」。
//    这正是一个「两级分区 + 数量可变」的结构 —— 天然适配我们的问题。
//  ═══════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
//  二十八宿（四象分区） + 每宿的语义关键词
// ──────────────────────────────────────────────────────────────────────────
export const XIU = [
  // 东方苍龙（生发、开端）
  { id: 'jiao', name: '角', xiang: '苍龙', kw: ['架构', '设计', '规划', 'arch', 'design', 'plan'] },
  { id: 'kang', name: '亢', xiang: '苍龙', kw: ['接口', '契约', 'api', 'interface', 'contract'] },
  { id: 'di',   name: '氐', xiang: '苍龙', kw: ['基础', '平台', '地基', 'base', 'platform', 'foundation'] },
  { id: 'fang', name: '房', xiang: '苍龙', kw: ['数据', '存储', '库', 'data', 'store', 'db', 'database'] },
  { id: 'xin',  name: '心', xiang: '苍龙', kw: ['核心', '逻辑', '引擎', 'core', 'logic', 'engine'] },
  { id: 'wei',  name: '尾', xiang: '苍龙', kw: ['边界', '异常', '容错', 'edge', 'error', 'fault'] },
  { id: 'ji',   name: '箕', xiang: '苍龙', kw: ['部署', '发布', '构建', 'deploy', 'release', 'build'] },

  // 北方玄武（收藏、支撑）
  { id: 'dou',  name: '斗', xiang: '玄武', kw: ['记忆', '神经元', '知识', 'memory', 'knowledge', 'neuron'] },
  { id: 'niu',  name: '牛', xiang: '玄武', kw: ['索引', '检索', '搜索', 'index', 'search'] },
  { id: 'nv',   name: '女', xiang: '玄武', kw: ['整理', '归档', '清理', 'sort', 'archive', 'clean'] },
  { id: 'xu',   name: '虚', xiang: '玄武', kw: ['缓存', '性能', '优化', 'cache', 'perf', 'optimize'] },
  { id: 'wei2', name: '危', xiang: '玄武', kw: ['故障', '诊断', '自检', 'fault', 'debug', 'diagnose'] },
  { id: 'shi',  name: '室', xiang: '玄武', kw: ['配置', '环境', '设置', 'config', 'env', 'setting'] },
  { id: 'bi',   name: '壁', xiang: '玄武', kw: ['依赖', '库', '包', 'depend', 'package', 'lib'] },

  // 西方白虎（肃杀、审查）
  { id: 'kui',  name: '奎', xiang: '白虎', kw: ['审查', '复核', 'review', 'audit'] },
  { id: 'lou',  name: '娄', xiang: '白虎', kw: ['质量', '测试', '校验', 'quality', 'test', 'check'] },
  { id: 'wei3', name: '胃', xiang: '白虎', kw: ['分析', '度量', '指标', 'analyze', 'metric', 'benchmark'] },
  { id: 'mao',  name: '昴', xiang: '白虎', kw: ['安全', '漏洞', '防护', 'security', 'vuln', 'guard'] },
  { id: 'bi2',  name: '毕', xiang: '白虎', kw: ['逆向', '拆解', '反编译', 'reverse', 'decompile'] },
  { id: 'zi',   name: '觜', xiang: '白虎', kw: ['竞品', '对比', '分析', 'competitor', 'compare'] },
  { id: 'shen', name: '参', xiang: '白虎', kw: ['基准', '压力', '评估', 'stress', 'evaluate'] },

  // 南方朱雀（文明、输出）
  { id: 'jing', name: '井', xiang: '朱雀', kw: ['文档', '写作', '说明', 'doc', 'write', 'document'] },
  { id: 'gui',  name: '鬼', xiang: '朱雀', kw: ['调研', '搜集', '采集', 'research', 'collect', 'survey'] },
  { id: 'liu',  name: '柳', xiang: '朱雀', kw: ['方案', '提案', '规划', 'proposal', 'scheme'] },
  { id: 'xing', name: '星', xiang: '朱雀', kw: ['实施', '执行', '计划', 'implement', 'execute', 'todo'] },
  { id: 'zhang', name: '张', xiang: '朱雀', kw: ['内容', '创作', '生成', 'content', 'create', 'generate'] },
  { id: 'yi',   name: '翼', xiang: '朱雀', kw: ['视频', '图文', '媒体', 'video', 'media', 'image'] },
  { id: 'zhen', name: '轸', xiang: '朱雀', kw: ['关系', '沟通', '协作', 'relation', 'communication', 'collab'] },
  { id: 'default', name: '杂', xiang: '杂', kw: [] },  // 无法归类的
];

// ──────────────────────────────────────────────────────────────────────────
//  LOD 阈值
// ──────────────────────────────────────────────────────────────────────────
export const LOD = {
  // LOD 0 阈值：24 个场景均分 = 每 15°，标签完全不挤。
  // （之前设 8 太保守，10 个场景就进 LOD 1 反而造成混乱）
  DIRECT: 24,
  // LOD 1 上限：超过 200 就只画宿聚合
  XIU_MAX: 200,
  // LOD 2：>200
};

// ══════════════════════════════════════════════════════════════════════════
//  核心：编排
// ══════════════════════════════════════════════════════════════════════════
/**
 * @param {Array} scenes  [{ id, name, role, description, lit }]
 * @returns {object} {
 *   lod: 0|1|2,
 *   level: 层级说明,
 *   nodes: [{ kind:'scene'|'xiu', id, name, angle, radius, span?, count?, color }],
 *   xius: [{ id, name, xiang, angle, span, count, scenes: [...] }]
 * }
 */
export function computeConstellation(scenes) {
  const list = Array.isArray(scenes) ? scenes.slice() : [];
  const N = list.length;

  // ═══ LOD 0：小规模直接均分 ═══
  if (N <= LOD.DIRECT) {
    const nodes = list.map(function (s, i) {
      return {
        kind: 'scene',
        id: s.id,
        name: s.name || s.id,
        angle: (i / Math.max(1, N)) * Math.PI * 2,
        radius: 1.0,
        data: s,
      };
    });
    return { lod: 0, level: '直接编排（' + N + ' 个场景）', nodes: nodes, xius: [] };
  }

  // ═══ 分配宿 ═══
  const groups = {};
  for (const x of XIU) groups[x.id] = [];

  for (const s of list) {
    const xiuId = inferXiu(s);
    groups[xiuId].push(s);
  }

  // 只保留有场景的宿
  const activeXius = XIU
    .map(function (x) {
      const arr = groups[x.id] || [];
      return { def: x, scenes: arr, count: arr.length };
    })
    .filter(function (g) { return g.count > 0; });

  // ═══ LOD 2：超大规模，只画宿 ═══
  if (N > LOD.XIU_MAX) {
    const nodes = [];
    let cursor = 0;
    for (const g of activeXius) {
      const span = (g.count / N) * Math.PI * 2;      // ★ 面积正比
      nodes.push({
        kind: 'xiu',
        id: g.def.id,
        name: g.def.name,
        xiang: g.def.xiang,
        angleCenter: cursor + span / 2,
        span: span,
        count: g.count,
        radius: 1.0,
        scenes: g.scenes,
      });
      cursor += span;
    }
    return {
      lod: 2,
      level: '宿聚合（' + N + ' 个场景 / ' + activeXius.length + ' 宿）',
      nodes: nodes,
      xius: activeXius.map(function (g) { return { id: g.def.id, name: g.def.name, xiang: g.def.xiang, count: g.count }; }),
    };
  }

  // ═══ LOD 1：分宿 + 宿内径向树 ═══
  const nodes = [];
  const xius = [];
  let cursor = 0;

  for (const g of activeXius) {
    const span = (g.count / N) * Math.PI * 2;        // ★ 面积正比
    const startAngle = cursor;
    const xiuNode = {
      kind: 'xiu',
      id: g.def.id,
      name: g.def.name,
      xiang: g.def.xiang,
      angleCenter: startAngle + span / 2,
      span: span,
      count: g.count,
      radius: 1.0,
    };
    nodes.push(xiuNode);

    // ═══ 宿内场景：角度均铺 + 径向变化 ═══
    //
    // 关键：每个场景占据扇区内**唯一**的一个角度槽位
    //   角度 = startAngle + span * (i + 0.5) / count
    // 这样 count 再大，每个场景也有自己的角度，永不重叠。
    //
    // 半径也在变化（内薄外厚），让宿内呈"扇形展开"而非一条线。
    const inner = 0.62;      // 宿内起始半径
    const outer = 1.0;       // 宿内外缘
    const cnt = g.count;

    for (let i = 0; i < cnt; i++) {
      // 角度：扇区内均匀分配（★ 这是防重叠的核心）
      const angle = startAngle + span * (i + 0.5) / cnt;

      // 半径：螺旋式变化（i 奇偶交替内/外，形成锯齿状，视觉更有层次）
      //   避免所有场景排在同一条弧线上
      const t = cnt === 1 ? 0.5 : (i / (cnt - 1));
      // 基础径向位置
      let radius = inner + t * (outer - inner);
      // 交替微调，形成双螺旋（视觉上更像星宿的"星官"分布）
      radius += (i % 2 === 0 ? 1 : -1) * 0.035;
      radius = Math.max(inner - 0.02, Math.min(outer + 0.02, radius));

      nodes.push({
        kind: 'scene',
        id: g.scenes[i].id,
        name: g.scenes[i].name || g.scenes[i].id,
        angle: angle,
        radius: radius,
        xiu: g.def.id,
        data: g.scenes[i],
      });
    }

    xius.push({ id: g.def.id, name: g.def.name, xiang: g.def.xiang, count: g.count, span: span });
    cursor += span;
  }

  return {
    lod: 1,
    level: '分宿编排（' + N + ' 个场景 / ' + activeXius.length + ' 宿）',
    nodes: nodes,
    xius: xius,
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  自动归宿：按 role/name/description 关键词匹配
// ══════════════════════════════════════════════════════════════════════════
export function inferXiu(scene) {
  const text = [
    scene.role || '',
    scene.name || '',
    scene.description || '',
    scene.id || '',
  ].join(' ').toLowerCase();

  let best = null;
  let bestScore = 0;

  for (const x of XIU) {
    if (!x.kw.length) continue;
    let score = 0;
    for (const kw of x.kw) {
      if (text.indexOf(kw.toLowerCase()) >= 0) {
        score += kw.length;      // 关键词越长越精确，权重越高
      }
    }
    if (score > bestScore) { bestScore = score; best = x.id; }
  }

  return best || 'default';
}

// ══════════════════════════════════════════════════════════════════════════
//  工具：四象颜色（二十八宿按四象分色系）
// ══════════════════════════════════════════════════════════════════════════
export const XIANG_COLOR = {
  '苍龙': 'var(--gu-qing, #6FB0DC)',   // 石青
  '玄武': 'var(--gu-qing-mid, #7C9EB8)',   // 灰蓝
  '白虎': 'var(--gu-bai, #C4CAD4)',   // 素白
  '朱雀': 'var(--gu-cinn, #E68069)',   // 朱砂
  '杂':   'var(--color-txt-3, #8A9099)',
};

export default { computeConstellation, inferXiu, XIU, LOD, XIANG_COLOR };
