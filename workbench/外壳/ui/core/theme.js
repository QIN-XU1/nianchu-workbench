// ui/core/theme.js —— 设计令牌（颜色 / 圆角 / 间距 / 动效）
//
// ══════════════════════════════════════════════════════════════════════
//  为什么要有这个文件
// ══════════════════════════════════════════════════════════════════════
//  参考 dsh-claude-style（75KB 设计规范）的核心原则：
//
//    「Never pure black, never a cold gray.」
//    「Each canvas pair is read as one family: the canvas, its sidebar,
//      its borders and every ink step around them derive from that card's seed.」
//
//  也就是说：**所有颜色都从一个「种子色」按色阶派生**，不能散落硬编码。
//
//  这正是我之前的问题：
//    · #0E1114 / #151A1F / #232A31 全是冷灰偏黑
//    · 暗色下边框用深色实线（看起来"脏"）
//    · 20 多个颜色散落在 main-agent.js 里，没有任何体系
//
// ══════════════════════════════════════════════════════════════════════
//  色阶设计（借参考的 ladder，但换成我们的朱红种子）
// ══════════════════════════════════════════════════════════════════════
//  种子（seed）→ 一个极暗的暖色，作为画布
//
//  暗色模式（我们的主场景）：
//    canvas     = seed                    （画布底）
//    surface-1  = seed +Δl               （面板）
//    surface-2  = seed +2Δl              （面板内层）
//    surface-3  = seed +3Δl              （更高一层）
//    overlay    = seed +2Δl              （浮层）
//    code-block = seed +Δl               （代码块）
//    card       = seed +1.2Δl            （卡片）
//    bubble     = seed +2.5Δl·α          （消息气泡）
//
//    border-1   = rgba(255,255,255,.09)  （弱边框，是高光不是线条）
//    border-2   = rgba(255,255,255,.16)
//    border-3   = rgba(255,255,255,.26)
//    divider    = rgba(255,255,255,.055) （0.5px 分隔线）
//
//    ink        = seed +0.78Δl           （主文字，接近白但带暖调）
//    ink-2      = seed +0.57Δl           （次要文字）
//    ink-3      = seed +0.46Δl           （辅助文字）
//    ink-4      = seed +0.34Δl           （最弱，如时间戳）
//
//  强调色（accent）用朱红（国学主题），但**只占可见元素 < 10%**
//
// ══════════════════════════════════════════════════════════════════════
//  圆角 / 间距 / 动效
// ══════════════════════════════════════════════════════════════════════
//  圆角阶梯：4 / 8 / 12 / 16（pill 用 999）
//  间距节奏：4 的倍数（4 / 8 / 12 / 16 / 20 / 24）
//  动效按角色分（参考的六个角色）：
//    feedback  120ms  ease                              控件响应
//    reveal    120ms  ease                              内容进入
//    enter     320ms  cubic-bezier(.34,1.3,.64,1)       用户消息长到行里（微过冲）
//    surface   150ms  ease                              浮层出现
//    exit      120ms  ease                              浮层消失（比出现快）
//    open      250ms  cubic-bezier(.22,1,.36,1)         从锚点长出
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
//  色彩工具
// ══════════════════════════════════════════════════════════════════════

/** hex → {r,g,b}（0-255） */
function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** {r,g,b} → hex */
function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

/** rgb → hsl（h 0-360, s/l 0-1） */
function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
}

/** hsl → rgb */
function hslToRgb(h, s, l) {
  const hn = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, hn + 1 / 3) * 255,
    g: hue2rgb(p, q, hn) * 255,
    b: hue2rgb(p, q, hn - 1 / 3) * 255,
  };
}

/**
 * 从种子色派生一个「色阶」（参考的 tone ladder）
 *
 * @param {string} seedHex 种子色
 * @param {number} dl 亮度偏移（-1 ~ +1）
 * @param {number} dc 彩度偏移（-1 ~ +1，0=不变）
 * @param {number} dh 色相偏移（度）
 * @returns {string} hex
 */
export function tone(seedHex, dl, dc, dh) {
  const { r, g, b } = hexToRgb(seedHex);
  const hsl = rgbToHsl(r, g, b);
  const l = Math.max(0, Math.min(1, hsl.l + (dl || 0)));
  const s = Math.max(0, Math.min(1, hsl.s + (dc || 0)));
  const h = hsl.h + (dh || 0);
  const out = hslToRgb(h, s, l);
  return rgbToHex(out.r, out.g, out.b);
}

/** 生成半透明白（暗色下的边框） */
export function whiteAlpha(a) {
  return 'rgba(255,255,255,' + a + ')';
}

/** 生成半透明黑（亮色下的边框） */
export function blackAlpha(a) {
  return 'rgba(0,0,0,' + a + ')';
}

// ══════════════════════════════════════════════════════════════════════
//  配色卡（参考的做法：一个 card = 一套完整配色）
// ══════════════════════════════════════════════════════════════════════

/**
 * 造一张配色卡
 *
 * @param {object} cfg
 *   name      卡片名
 *   seed      种子色（画布底色，暗色模式下应该很暗）
 *   accent    强调色
 *   scheme    'dark' | 'light'
 */
export function makeCard(cfg) {
  const seed = cfg.seed;
  const accent = cfg.accent;
  const dark = (cfg.scheme || 'dark') === 'dark';

  // 文字/描边的方向：深色卡往亮走，浅色卡往暗走
  //
  // ⚠ 2026-11-14 加（修「浅色卡白字白底」）
  //   原来 ink 是无条件 tone(seed, +0.78)，浅色 seed（l≈0.96）
  //   加亮后被 clamp 到 1.0 = 纯白，在白底上完全看不见。
  //   所以符号要跟着 scheme 翻转。
  const inkSign = dark ? 1 : -1;
  // 浅色卡的文字步长要更大：浅色 seed 的 HSL 亮度接近 1，
  // 减 0.46 后落在 0.5 附近，而那个位置的黄色系天然低对比（实测 2.76:1）。
  const inkStep = dark ? 1 : 1.35;

  // 暗色的色阶步长（参考的 Δl 数值）
  const STEP = 0.036;

  const card = {
    name: cfg.name || 'card',
    scheme: dark ? 'dark' : 'light',

    // ── 表面（往上加亮）──
    canvas: seed,
    'surface-1': tone(seed, STEP * 1),
    'surface-2': tone(seed, STEP * 1.8),
    'surface-3': tone(seed, STEP * 2.9),
    overlay: tone(seed, STEP * 1.8),
    'code-block': tone(seed, STEP * 1),
    card: tone(seed, STEP * 1.2),
    inset: tone(seed, -STEP * 0.7),
    'table-head': tone(seed, STEP * 1.8),
    'hover-plate': tone(seed, STEP * 2.9),
    chip: tone(seed, STEP * 0.6),
    sidebar: tone(seed, STEP * 0.9, 0.004),

    // ── 文字（往上加亮，但带一点暖）──
    //
    //  ⚠ 2026-11-11 按 WCAG 实测校准（对比度 vs canvas）：
    //    ink    #dfd6d1  13.22  AAA   ← 正文/标题
    //    ink-2  #b49d91   7.36  AAA   ← 次要正文
    //    ink-3  #9d7f70   5.14  AA    ← 辅助文字
    //    ink-4  #7b6154   3.31  AA大字 ← 只能做「大字/图标」，不能做正文
    //    ink-5  #57453c   2.09  ✗     ← 只能做装饰（分隔、禁用态）
    //
    //  原始 §.34 和 §.22 的 Δl 会让 ink-4/ink-5 偏暗，
    //  这里把 ink-4 提到 .42（3.9 左右），ink-5 保持 .22 但标注「仅装饰」。
    // ── 文字 ──
    //
    //  ⚠ 2026-11-14 修（浅色卡的白字白底问题）
    //
    //   原来这里是无条件的 `tone(seed, 0.78)` —— 「往上加亮 0.78」。
    //   深色种子 #14100E（l≈0.05）加亮 0.78 → l≈0.83，是浅色文字 ✓
    //   但**浅色种子 #FAF7F2（l≈0.96）加亮 0.78 → 被 clamp 到 1.0 = 纯白** ✗
    //   ⇒ PAPER_CARD 的 ink 全是白色，在白底上完全看不见。
    //
    //   实测症状（截图）：切到浅色后右侧「中枢」栏变成白底白字，
    //   内容还在，但一个字也读不出来。
    //
    //   修法：**方向跟着 scheme 走**
    //     深色卡（seed 暗）：文字往亮走  → +Δl
    //     浅色卡（seed 亮）：文字往暗走  → -Δl
    //   数值保持原来的比例，只翻转符号。
    //
    //   ⚠ 2026-11-14 二次校准：浅色卡的 ink-2/3/4 算出来偏亮
    //      （ink-3 = #ba8f47 金色，在 #FAF7F2 上只有 2.76:1）
    //      原因：浅色 seed 的 HSL 亮度接近 1，减 0.46 后落在 0.5 附近，
    //            而那个位置的黄色系天然低对比。
    //      修法：浅色时加大步长（乘 1.35），让文字更早落到深色区。
    ink: tone(seed, inkSign * 0.78 * inkStep),
    'ink-2': tone(seed, inkSign * 0.57 * inkStep, 0.01),
    'ink-3': tone(seed, inkSign * 0.46 * inkStep, 0.012),
    'ink-4': tone(seed, inkSign * 0.42 * inkStep, 0.01),
    'ink-5': tone(seed, inkSign * 0.26 * inkStep, 0.008),

    // ── 边框（暗色下是高光，不是线条）──
    // ── 边框（深色下是高光，浅色下必须是阴影）──
    //
    //  ⚠ 2026-11-14 修：原来固定用 whiteAlpha（半透明白）。
    //    深色底上「半透明白」是对的（高光感）；
    //    浅色底上「半透明白」= 看不见（白压白）。
    //    所以按 scheme 切换：深色用白，浅色用黑。
    'border-1': dark ? whiteAlpha(0.09) : blackAlpha(0.10),
    'border-2': dark ? whiteAlpha(0.16) : blackAlpha(0.16),
    'border-3': dark ? whiteAlpha(0.26) : blackAlpha(0.24),
    divider: dark ? whiteAlpha(0.055) : blackAlpha(0.06),

    // ── 消息气泡 ──
    'bubble-user': tone(seed, 0.09, 0.0, -2),
    'bubble-ai': tone(seed, 0.035),

    // ── 强调色（< 10% 可见元素）──
    //
    //  ⚠ 2026-11-11 按对比度校准：
    //    #C8553D vs 白字 4.35 → 不够 4.5
    //    #D9614A vs 墨字 5.19 → 合格（按钮用深色字，不用白字）
    //  这也更符合朱红在宣纸上的观感：红底黑字，不是红底白字。
    accent: accent,
    'accent-hover': tone(accent, dark ? 0.06 : -0.06, 0, 2),
    'accent-tint': 'color-mix(in srgb, ' + accent + ' 14%, transparent)',
    'on-accent': dark ? tone(seed, 0.06) : '#ffffff',   // 深色字（墨）

    // ── 语义色 ──
    //
    //  ⚠ 2026-11-14 修：原来是无条件三个值（#4a9e6a / #c99a3a / #d05a4a），
    //    那是为**深色底**设计的亮色。
    //
    //    实测问题：切到浅色后，「就绪」文字用 #4a9e6a（rgb(74,158,106)）叠在
    //    #fffefe 上 → 对比度 3.26:1，不到 4.5。
    //    （设计一致性体检把它算进去了）
    //
    //    语义色必须按底色选：
    //      深色底 → 用亮一点（能跳出来）
    //      浅色底 → 用深一点（能压下去）
    //    色相保持不变，只调明度。
    ok: dark ? '#4a9e6a' : '#1a7a58',
    warn: dark ? '#c99a3a' : '#8a5a10',
    err: dark ? '#d05a4a' : '#a83225',

    // ── 滚动条 ──
    scrollbar: whiteAlpha(0.10),
    'scrollbar-hover': whiteAlpha(0.20),
  };

  return card;
}

// ══════════════════════════════════════════════════════════════════════
//  我们项目的配色卡
// ══════════════════════════════════════════════════════════════════════
//
//  项目主题是「国学 / 星盘」，所以：
//    · 种子用极暗的暖墨色（不是纯黑、不是冷灰）
//    · 强调色用朱红（中国红，论语/朱熹的朱）
//
//  这两个色是我从「朱红 + 墨」的传统配色里选的，不是随便调。
// ══════════════════════════════════════════════════════════════════════

/** 墨底（暗色）—— 种子是 #14100E，真正的暖墨色，不是冷灰 */
export const INK_CARD = makeCard({
  name: 'ink',
  seed: '#14100E',      // 暖墨（R>G>B，略微偏红）
  // ⚠ 2026-11-11 按 WCAG 实测定值：
  //   #D9614A vs 深字 #261E1B = 4.49（差 0.01 不合格）
  //   #DD6A52 vs 深字 = 4.87 ✓   vs 墨底 = 5.64 ✓
  accent: '#DD6A52',
  scheme: 'dark',
});

/** 宣纸底（亮色）—— 种子是 #FAF7F2，宣纸的暖白 */
export const PAPER_CARD = makeCard({
  name: 'paper',
  seed: '#FAF7F2',      // 宣纸（R>G>B，暖白不是纯白）
  accent: '#B34A32',    // 朱红（亮色下深一点，保证对比度）
  scheme: 'light',
});

// ══════════════════════════════════════════════════════════════════════
//  圆角 / 间距 / 动效
// ══════════════════════════════════════════════════════════════════════

/** 圆角阶梯（参考：4 / 8 / 16，popover 12/6） */
export const RADIUS = {
  none: '0',
  xs: '4px',      // 小控件、标签
  sm: '6px',      // popover 内行
  md: '8px',      // 卡片、代码块
  lg: '12px',     // popover 卡
  xl: '16px',     // 大面板
  pill: '999px',  // CTA、徽章
};

/** 间距（4px 节奏） */
export const SPACE = {
  xxs: '2px',
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  xxl: '24px',
};

/** 动效（按角色分，参考的六个角色 + 时长） */
export const MOTION = {
  // 控件响应 hover / press / focus
  feedback: { duration: '120ms', easing: 'ease' },
  // 内容进入聊天区
  reveal: { duration: '120ms', easing: 'ease' },
  // 用户消息长到行里（微过冲）
  enter: { duration: '320ms', easing: 'cubic-bezier(.34,1.3,.64,1)' },
  // 浮层出现
  surface: { duration: '150ms', easing: 'ease' },
  // 浮层消失（比出现快）
  exit: { duration: '120ms', easing: 'ease' },
  // 从锚点长出
  open: { duration: '250ms', easing: 'cubic-bezier(.22,1,.36,1)' },
  // 滑动高亮
  slide: { duration: '240ms', easing: 'cubic-bezier(.22,.61,.36,1)' },
  // 状态文字换（旧的往上走+模糊，新的从下进）
  swap: { duration: '150ms', easing: 'ease' },
};

/** 循环周期（等待动画等） */
export const LOOP = {
  dot: '2400ms',      // 三点动画一轮
  shimmer: '2000ms',  // 光泽扫过
  pulse: '1800ms',    // 呼吸
};

/** 字体三分 */
export const FONT = {
  display: '"Songti SC","Noto Serif SC",Georgia,serif',        // 标题 / 编辑式陈述
  ui: 'system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',  // 界面 / 正文
  code: '"JetBrains Mono","Cascadia Code",ui-monospace,monospace',            // 代码 / 技术标签
};

// ══════════════════════════════════════════════════════════════════════
//  生成 CSS 变量
// ══════════════════════════════════════════════════════════════════════

/**
 * 把一张配色卡展开成 CSS 变量对象
 * @param {object} card
 * @param {string} prefix 变量前缀（默认 'ma'）
 */
export function cardToVars(card, prefix) {
  const p = prefix || 'ma';
  const out = {};
  for (const [k, v] of Object.entries(card)) {
    if (k === 'name' || k === 'scheme') continue;
    out['--' + p + '-' + k] = v;
  }
  return out;
}

/**
 * 把变量对象写成 CSS 声明串
 * @param {object} vars
 */
export function varsToCss(vars) {
  return Object.entries(vars).map(([k, v]) => k + ':' + v).join(';');
}

/**
 * 把圆角/间距/动效也展开成变量
 */
export function tokensToVars(prefix) {
  const p = prefix || 'ma';
  const out = {};
  for (const [k, v] of Object.entries(RADIUS)) out['--' + p + '-r-' + k] = v;
  for (const [k, v] of Object.entries(SPACE)) out['--' + p + '-s-' + k] = v;
  for (const [k, v] of Object.entries(MOTION)) {
    out['--' + p + '-mo-' + k] = v.duration + ' ' + v.easing;
    out['--' + p + '-mo-' + k + '-dur'] = v.duration;
    out['--' + p + '-mo-' + k + '-ease'] = v.easing;
  }
  for (const [k, v] of Object.entries(LOOP)) out['--' + p + '-loop-' + k] = v;
  out['--' + p + '-font-display'] = FONT.display;
  out['--' + p + '-font-ui'] = FONT.ui;
  out['--' + p + '-font-code'] = FONT.code;
  return out;
}

/**
 * 当前应该用哪张卡（跟随系统亮暗）
 */
/**
 * 当前应该用哪张卡（跟随主题）
 *
 * ⚠ 2026-11-14 修：这段代码一直在算 `dark`，但**从来没用过它** ——
 *    不管系统什么主题都 `return INK_CARD`（深色）。
 *
 *    实测症状（截图）：外壳已按 hermes 规范改成浅色
 *    （chrome #f3f3f3 / card #fcfcfc），AI 面板也跟着 nativeTheme='light'
 *    变浅了，**但右侧「中枢」栏还是深色** —— 因为 main-agent.js 用
 *    `const T = INK_CARD` 硬编码深色卡。
 *
 *    这是一个典型的「看起来有实际是空」：
 *      代码里有 `const dark = matchMedia(...)`，
 *      读起来像是支持亮暗切换，实际下一行就强制返回深色了。
 *
 *    修法：
 *      ① 优先读外壳自己的主题标记（`<html class="dark">` 或 data-theme），
 *         这是权威源 —— 外壳主题由 tokens-hermes.css 控制；
 *      ② 没有标记时退回系统偏好；
 *      ③ 再退回深色（保守）。
 */
export function currentCard() {
  try {
    // ① 外壳自己的主题（权威）：tokens-hermes.css 用 :root / :root.dark
    const root = document.documentElement;
    if (root) {
      if (root.classList.contains('dark')) return INK_CARD;
      if (root.classList.contains('light')) return PAPER_CARD;
      const dt = root.getAttribute('data-theme');
      if (dt === 'dark') return INK_CARD;
      if (dt === 'light') return PAPER_CARD;
    }
    // ② 系统偏好
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return isDark ? INK_CARD : PAPER_CARD;
  } catch {
    return INK_CARD;
  }
}

/** 便捷：拿一个颜色值 */
export function c(tokenName, card) {
  const k = card || INK_CARD;
  return k[tokenName] || k.ink;
}
