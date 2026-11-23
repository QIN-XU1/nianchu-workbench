// ui/panels/ziwei.js —— 紫微斗数十二宫编排引擎
//
// ══════════════════════════════════════════════════════════════════════════
//  借鉴来源：紫微斗数
//
//  ⚠ 先说明：这不是算命。我们借的是它的「结构机制」，不是它的预测功能。
//
//  ═══════════════════════════════════════════════════════════════════════════
//  为什么借紫微的十二宫 —— 解决的核心问题
//  ═══════════════════════════════════════════════════════════════════════════
//
//  我之前的错误：用「二十八宿环形」编排场景
//    环形的本质问题：无限扩展是伪命题
//      10 个场景  → 间隔 36°，OK
//      100 个场景 → 间隔 3.6°，挤
//      1000 个     → 糊成一圈
//    再怎么优化（面积正比、LOD 降级）都是补救，不是根治。
//
//  紫微的答案：**槽位固定，内容可变**
//    · 十二宫是固定的十二个容器（命兄夫子财疾迁移友官田福父）
//    · 每宫可容纳 0~N 个星曜
//    · 星曜按「安星决」填入，有严格规则
//    → 无论多少星曜，容器永远是十二个，永不会挤。
//
//  这就是「有限容器 + 分层内容」—— 真正可扩展的结构。
//
//  ═══════════════════════════════════════════════════════════════════════════
//  十二宫语义 → 映射到我们的场景类别
//  ═══════════════════════════════════════════════════════════════════════════
//
//     ┌────────┬────────┬────────┬────────┐
//     │  巳    │  午    │  未    │  申    │   四隅为四生位
//     ├────────┼────────┴────────┼────────┤
//     │  辰    │                    │  酉    │
//     ├────────┤    ☯ 中枢（命宫）   ├────────┤
//     │  卯    │                    │  戌    │
//     ├────────┼────────┬────────┼────────┤
//     │  寅    │  丑    │  子    │  亥    │
//     └────────┴────────┴────────┴────────┘
//
//  宫位  本义          对应场景类别
//  ────────────────────────────────────────────────
//  命宫  核心/本性      中枢自身
//  兄弟  同辈协作      并行执行的场景
//  夫妻  紧密搭档      强依赖场景
//  子女  产出/衍生      产出型（文档/方案/报告）
//  财帛  资源/价值      资源型（性能/存储/成本）
//  疾厄  健康/隐患      故障诊断/健康检查
//  迁移  对外/移动      对外接口/集成
//  交友  人脉/外部      外部服务/第三方
//  官禄  事业/职责      执行型（计划/实施/运维）
//  田宅  基业/存储      数据/记忆存储
//  福德  精神/沉淀      复盘/总结/沉淀
//  父母  根源/约束      规则/配置/约束
//
//  ═══════════════════════════════════════════════════════════════════════════
//  六位状态编码（借易经「六爻 → 六十四卦」的完备状态思想）
//  ═══════════════════════════════════════════════════════════════════════════
//
//  易经的核心贡献之一：用 6 位二进制完整表达 64 种状态。
//  这不是占卜，是**完备状态编码**的典范。
//
//  我们的场景状态也是 6 个正交维度：
//    bit0  有场景定义        (defined)
//    bit1  有 AI 会话         (session)
//    bit2  正在执行           (running)
//    bit3  有产物             (artifact)
//    bit4  记忆完整           (memory)
//    bit5  有错误             (error)
//
//  → 64 种组合，用一张表管理，不再散落 if-else

// ──────────────────────────────────────────────────────────────────────────
//  十二宫定义（顺序对应地支：寅卯辰巳午未申酉戌亥子丑）
// ──────────────────────────────────────────────────────────────────────────
export const PALACES = [
  {
    id: 'ming', name: '命宫', zhi: '寅',
    meaning: '核心/本性',
    cat: '中枢自身',
    kw: ['中枢', '核心', '主控', 'hub', 'core', 'main'],
  },
  {
    id: 'xiongdi', name: '兄弟宫', zhi: '卯',
    meaning: '同辈协作',
    cat: '并行执行的场景',
    kw: ['并行', '协作', '同时', 'parallel', 'collab', 'concurrent', '并行', '协同', '同时', '多任务'],
  },
  {
    id: 'fuqi', name: '夫妻宫', zhi: '辰',
    meaning: '紧密搭档',
    cat: '强依赖场景',
    kw: ['依赖', '搭档', '耦合', 'depend', 'partner', 'couple', '依赖', '关联', '耦合', '配套'],
  },
  {
    id: 'zinv', name: '子女宫', zhi: '巳',
    meaning: '产出/衍生',
    cat: '产出型场景',
    kw: ['文档', '方案', '报告', '创作', 'doc', 'report', 'create', 'generate', '文档', '报告', '创作', '生成', '产出', '方案'],
  },
  {
    id: 'caibo', name: '财帛宫', zhi: '午',
    meaning: '资源/价值',
    cat: '资源占用型',
    kw: ['性能', '资源', '成本', '缓存', 'perf', 'resource', 'cost', 'cache', '性能', '资源', '成本', '缓存', '优化', '开销'],
  },
  {
    id: 'jib', name: '疾厄宫', zhi: '未',
    meaning: '健康/隐患',
    cat: '故障诊断类',
    kw: ['故障', '诊断', '健康', '体检', '异常', 'fault', 'debug', 'health', 'diagnose', '故障', '诊断', '健康', '体检', '异常', '排查'],
  },
  {
    id: 'qianyi', name: '迁移宫', zhi: '申',
    meaning: '对外/移动',
    cat: '对外接口类',
    kw: ['接口', '集成', '对接', 'api', 'integrate', 'export', '接口', '对接', '输出', '迁移'],
  },
  {
    id: 'jiaoyou', name: '交友宫', zhi: '酉',
    meaning: '人脉/外部',
    cat: '外部服务类',
    kw: ['外部', '第三方', '服务', 'external', 'third', 'service', '外部', '第三方', '社区', '伙伴'],
  },
  {
    id: 'guanlu', name: '官禄宫', zhi: '戌',
    meaning: '事业/职责',
    cat: '执行型场景',
    kw: ['实施', '计划', '执行', '运维', '部署', 'implement', 'execute', 'deploy', 'plan', '实施', '执行', '运维', '部署', '计划', '工期'],
  },
  {
    id: 'tianzhai', name: '田宅宫', zhi: '亥',
    meaning: '基业/存储',
    cat: '数据存储类',
    kw: ['数据', '存储', '记忆', '索引', 'data', 'store', 'memory', 'index', '数据', '存储', '记忆', '索引', '档案', '台账'],
  },
  {
    id: 'fude', name: '福德宫', zhi: '子',
    meaning: '精神/沉淀',
    cat: '复盘沉淀类',
    kw: ['复盘', '总结', '沉淀', '学习', 'review', 'reflect', 'learn', '复盘', '总结', '反思', '沉淀', '回顾'],
  },
  {
    id: 'fumu', name: '父母宫', zhi: '丑',
    meaning: '根源/约束',
    cat: '规则配置类',
    kw: ['规则', '配置', '约束', '基础', 'rule', 'config', 'base', 'constraint', '规则', '配置', '约束', '基础', '规范', '标准'],
  },
];

// 宫位在 4×4 网格中的位置（对应地支方位）
//   行列从 1 开始
export const PALACE_GRID = {
  ming:     { r: 2, c: 2 },   // 中枢居中（占 2×2）
  xiongdi:  { r: 1, c: 2 },   // 卯
  fuqi:     { r: 1, c: 3 },   // 辰
  zinv:     { r: 1, c: 4 },   // 巳
  caibo:    { r: 2, c: 4 },   // 午
  jib:      { r: 3, c: 4 },   // 未
  qianyi:   { r: 4, c: 4 },   // 申
  jiaoyou:  { r: 4, c: 3 },   // 酉
  guanlu:   { r: 4, c: 2 },   // 戌
  tianzhai: { r: 4, c: 1 },   // 亥
  fude:     { r: 3, c: 1 },   // 子
  fumu:     { r: 2, c: 1 },   // 丑
  // 寅位空出（左上角 r1c1 留给装饰/其他）
};

// ══════════════════════════════════════════════════════════════════════════
//  6 位状态编码（借易经「六爻」的完备状态思想）
// ══════════════════════════════════════════════════════════════════════════
export const STATE_BITS = {
  DEFINED:  0,   // bit0 有场景定义
  SESSION:  1,   // bit1 有 AI 会话
  RUNNING:  2,   // bit2 正在执行
  ARTIFACT: 3,   // bit3 有产物
  MEMORY:   4,   // bit4 记忆完整
  ERROR:    5,   // bit5 有错误
};

/**
 * 计算场景状态码（0~63）
 * @param {object} s { hasDef, hasSession, running, hasArtifact, memoryOk, error }
 */
export function computeStateCode(s) {
  let code = 0;
  if (s.hasDef !== false) code |= (1 << STATE_BITS.DEFINED);
  if (s.hasSession)       code |= (1 << STATE_BITS.SESSION);
  if (s.running)          code |= (1 << STATE_BITS.RUNNING);
  if (s.hasArtifact)      code |= (1 << STATE_BITS.ARTIFACT);
  if (s.memoryOk)         code |= (1 << STATE_BITS.MEMORY);
  if (s.error)            code |= (1 << STATE_BITS.ERROR);
  return code;
}

/**
 * 状态码 → 语义描述（这是"卦爻辞"的等价物）
 * 不是所有 64 种都列，只列关键状态 + 通用规则
 */
export const STATE_TABLE = {
  63: { name: '全备', desc: '定义/会话/产物/记忆全齐，可调度', tone: 'ok' },
  62: { name: '有错', desc: '全备但有错误，需排查后调度', tone: 'warn' },
  47: { name: '就绪', desc: '有定义+会话+产物+记忆，空闲', tone: 'ok' },
  31: { name: '半备', desc: '有定义+会话+产物，记忆缺失', tone: 'info' },
  23: { name: '有产物', desc: '有定义+会话+产物', tone: 'info' },
  7:  { name: '可跑', desc: '有定义+会话+执行中', tone: 'info' },
  3:  { name: '裸会', desc: '有定义+会话，无产物', tone: 'muted' },
  1:  { name: '空壳', desc: '仅定义，无会话', tone: 'muted' },
  0:  { name: '空', desc: '什么都没有', tone: 'muted' },
};

export function describeState(code) {
  if (STATE_TABLE[code]) return STATE_TABLE[code];
  // 通用推断
  const has = (bit) => (code & (1 << bit)) !== 0;
  const parts = [];
  if (has(STATE_BITS.DEFINED)) parts.push('定义');
  if (has(STATE_BITS.SESSION)) parts.push('会话');
  if (has(STATE_BITS.RUNNING)) parts.push('执行');
  if (has(STATE_BITS.ARTIFACT)) parts.push('产物');
  if (has(STATE_BITS.MEMORY)) parts.push('记忆');
  if (has(STATE_BITS.ERROR)) parts.push('错误');
  return {
    name: parts.join('+') || '空',
    desc: '状态码 ' + code,
    tone: has(STATE_BITS.ERROR) ? 'warn' : (parts.length >= 3 ? 'ok' : 'muted'),
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  把场景归入十二宫
// ══════════════════════════════════════════════════════════════════════════
/**
 * @param {Array} scenes [{ id, name, role, description, isHub }]
 * @returns {object} { palaces: [{ id, name, zhi, meaning, scenes: [...] }], total }
 */
export function arrangeIntoPalaces(scenes) {
  const list = Array.isArray(scenes) ? scenes.slice() : [];

  // 初始化十二宫
  const palaces = PALACES.map(function (p) {
    return {
      id: p.id,
      name: p.name,
      zhi: p.zhi,
      meaning: p.meaning,
      cat: p.cat,
      grid: PALACE_GRID[p.id] || { r: 1, c: 1 },
      scenes: [],
    };
  });

  const byId = {};
  for (const p of palaces) byId[p.id] = p;

  // 中枢 → 命宫
  const hub = list.find(function (s) { return s.isHub; });
  if (hub) byId['ming'].scenes.push(Object.assign({ isHub: true }, hub));
  byId['ming'].hub = hub || null;

  // 其余场景按关键词归宫
  for (const s of list) {
    if (s.isHub) continue;
    const pid = inferPalace(s);
    if (byId[pid]) byId[pid].scenes.push(s);
  }

  return {
    palaces: palaces,
    total: list.length,
    // 统计
    stats: {
      empty: palaces.filter(function (p) { return p.scenes.length === 0; }).length,
      max: Math.max.apply(null, palaces.map(function (p) { return p.scenes.length; })),
    },
  };
}

/**
 * 关键词匹配归宫
 * 计分：命中关键词的字符总长（越长越精确）
 */
export function inferPalace(scene) {
  const name = String(scene.name || '').toLowerCase();
  const role = String(scene.role || '').toLowerCase();
  const desc = String(scene.description || '').toLowerCase();
  const id = String(scene.id || '').toLowerCase();

  let best = null;
  let bestScore = 0;

  // 命宫留给中枢，其余宫参与匹配
  for (const p of PALACES) {
    if (p.id === 'ming') continue;
    let score = 0;

    for (const kw of p.kw) {
      const k = kw.toLowerCase();
      if (!k) continue;

      // ═══ 多级加权（这是关键改进）═══
      // ① 名称完全相等 → 最高权重
      if (name === k) score += 80;
      // ② 名称包含关键词 → 高权重（名称是最明确的信号）
      else if (name.indexOf(k) >= 0) score += 40;
      // ③ id 包含 → 高权重
      if (id.indexOf(k) >= 0) score += 20;
      // ④ role 包含 → 中权重
      if (role.indexOf(k) >= 0) score += 12;
      // ⑤ description 包含 → 低权重
      if (desc.indexOf(k) >= 0) score += 5;
    }

    // 关键词越长越精确，整体乘一个精度系数
    score = score * Math.min(2.0, 0.6 + p.kw.length * 0.08);

    if (score > bestScore) { bestScore = score; best = p.id; }
  }

  // ═══ 兜底策略：不再全塞官禄宫 ═══
  // 无匹配时，按场景 id 的哈希均匀分摊到"通用四宫"
  // （兄弟=协作 / 官禄=执行 / 田宅=存储 / 福德=沉淀）
  if (!best || bestScore < 5) {
    const GENERIC = ['guanlu', 'tianzhai', 'fude', 'xiongdi'];
    let h = 0;
    const seed = String(scene.id || scene.name || '');
    for (let i = 0; i < seed.length; i++) {
      h = (h << 5) - h + seed.charCodeAt(i);
      h |= 0;
    }
    return GENERIC[Math.abs(h) % GENERIC.length];
  }

  return best;
}

export default { PALACES, PALACE_GRID, arrangeIntoPalaces, inferPalace, computeStateCode, describeState, STATE_BITS };
