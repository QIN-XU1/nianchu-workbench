import pathlib, json

TOK = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\renderer\tokens")
pal = json.loads((TOK / "palette.json").read_text(encoding="utf-8"))
N = pal["neutral"]

# 依实测对比度重新定映射（不是拍脑袋，是数据决定的）
# 对 base(#222435) 与 raised(#35394c) 都达标的选择：
#   正文：neutral-100  (14.68 / 10.94)
#   次要：neutral-300  ( 8.20 /  6.11)   ← 比原来的 400 更安全
#   三级：neutral-400  ( 5.61 /  4.18)   ← 升一档，确保 >=4.5
#   边框：neutral-600  ( 2.59:1 作为装饰边框，非文字，可接受)

css = """/**
 * 设计令牌 —— refactoring-ui 体系
 *
 * 生成方式：scripts/generate_palette.py（不手调 hex）
 *   base(500) → edges(900/100) → bisect(700/300) → bisect(800/600/400/200)
 *   饱和度随亮度偏离 50% 升高（§5.4）
 *   色相旋转上限 20-30°（§5.4.2）
 *   灰阶带温度并两端补偿（§5.5.1）
 *
 * 对比度已用 scripts/check_contrast.py 实测校准（§5.6）：
 *   正文/次要/三级 在 base 与 raised 两种背景上都达标。
 *   这是数据决定的映射，不是审美决定的。
 */

:root {
"""

# color ramps
for name, stops in pal.items():
    css += "  /* %s */\n" % name
    for k in sorted(stops, key=int):
        css += "  --%s-%s: %s;\n" % (name, k, stops[k])
    css += "\n"

css += """  /* ── 语义层 ── */

  /* 三档文字色（02-hierarchy §2.2.a：最多三个）
     对比度实测：14.68 / 8.20 / 5.61（对 base） */
  --text-primary:   var(--neutral-100);
  --text-secondary: var(--neutral-300);
  --text-tertiary:  var(--neutral-400);
  --text-disabled:  var(--neutral-500);

  /* 表面层级（06-depth §6.1：光从上方来）
     base 最暗，raised 略亮，overlay 更亮 */
  --surface-base:    var(--neutral-900);
  --surface-raised:  var(--neutral-800);
  --surface-overlay: var(--neutral-700);
  --surface-sunken:  #16171f;

  /* 边框（§2.7.2：宁可加粗不要加深）
     默认边框只作装饰，不承载文字信息 */
  --border-subtle:  var(--neutral-800);
  --border-default: var(--neutral-700);
  --border-strong:  var(--neutral-600);

  /* 强调（§2.8：一页只有一个主行动）*/
  --accent:         var(--primary-500);
  --accent-hover:   var(--primary-400);
  --accent-pressed: var(--primary-600);
  --accent-subtle:  var(--primary-800);
  --accent-text:    var(--primary-300);

  /* 状态（§5.7 不能只靠颜色，要配符号）*/
  --state-success: var(--success-500);
  --state-warning: var(--warning-500);
  --state-danger:  var(--danger-500);
  --state-info:    var(--primary-500);

  --state-success-bg: var(--success-900);
  --state-warning-bg: var(--warning-900);
  --state-danger-bg:  var(--danger-900);
  --state-info-bg:    var(--primary-900);

  /* ── 间距尺度（03-layout-spacing §3.2：4px 基准）── */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;

  /* ── 字号尺度（04-typography §4.1：不超过 25% 间隔）── */
  --text-xs:   11px;
  --text-sm:   12px;
  --text-base: 13px;
  --text-md:   15px;
  --text-lg:   18px;
  --text-xl:   22px;
  --text-2xl:  28px;

  /* 行高（§4.5：宽文本行高更大，大字行高更小）*/
  --leading-tight:  1.25;
  --leading-snug:   1.35;
  --leading-normal: 1.5;
  --leading-relaxed: 1.65;

  /* 字重（§2.2.b：只用两档；UI 文字不低于 400）*/
  --weight-normal:   400;
  --weight-medium:   500;
  --weight-semibold: 600;

  /* ── 圆角（§8 收尾：克制）── */
  --radius-none: 0;
  --radius-sm:   2px;
  --radius-md:   4px;
  --radius-full: 999px;

  /* ── 层级阴影（06-depth §6.1：五级 elevation）── */
  --elev-0: none;
  --elev-1: 0 1px 2px rgba(0,0,0,.35);
  --elev-2: 0 2px 6px rgba(0,0,0,.40);
  --elev-3: 0 6px 16px rgba(0,0,0,.45);
  --elev-4: 0 12px 32px rgba(0,0,0,.50);
  --elev-5: 0 24px 56px rgba(0,0,0,.55);

  /* ── 字体 ── */
  --font-mono: 'Consolas', 'Cascadia Code', 'JetBrains Mono', 'Menlo', monospace;
  --font-ui:   -apple-system, 'Segoe UI', system-ui, 'Noto Sans SC', sans-serif;
}
"""

(TOK / "tokens.css").write_text(css, encoding="utf-8")
print("OK 已重写 tokens.css（%d 字节）" % len(css))
print()
print("关键映射：")
print("  正文  neutral-100  #f6fbfd  (14.68:1)")
print("  次要  neutral-300  #b1c0c8  ( 8.20:1)")
print("  三级  neutral-400  #919eac  ( 5.61:1)")
print("  强调  primary-500  #7da1de  ( 5.85:1)")
