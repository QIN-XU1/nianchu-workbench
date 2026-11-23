import subprocess, pathlib, sys, re, json

SKILL = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\research\repos\refactoring-ui-skill\skills\refactoring-ui")
OUT = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\renderer\tokens")
OUT.mkdir(parents=True, exist_ok=True)

def gen(args):
    """跑生成器，解析表格输出 → {stop: hex}"""
    r = subprocess.run([sys.executable, str(SKILL / "scripts" / "generate_palette.py")] + args,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(SKILL))
    out = (r.stdout or "") + (r.stderr or "")
    stops = {}
    # 匹配形如 "  100  #ebf9ff   hsl(...)"
    for m in re.finditer(r"^\s*(\d{3})\s+(\#[0-9a-fA-F]{6})", out, re.M):
        stops[m.group(1)] = m.group(2).lower()
    return stops, r.returncode

RAMPS = {
    "primary": ["--base", "#7DA1DE"],
    "neutral": ["--grey", "--temperature", "cool"],
    "danger":  ["--base", "#E5787E"],
    "warning": ["--base", "#DEB56B"],
    "success": ["--base", "#7CCB8F"],
}

result = {}
for name, args in RAMPS.items():
    stops, rc = gen(args)
    if not stops:
        print("FAIL %-10s rc=%s" % (name, rc))
        continue
    result[name] = stops
    print("OK %-10s %d stops: %s" % (name, len(stops),
          " ".join("%s=%s" % (k, stops[k]) for k in ["100", "500", "900"] if k in stops)))

if not result:
    sys.exit(1)

(OUT / "palette.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

# tokens.css
L = [
    "/**",
    " * 设计令牌 —— refactoring-ui generate_palette.py 生成",
    " *",
    " * 算法（Refactoring UI ch.5）：",
    " *   base(500) → edges(900/100) → bisect(700/300) → bisect(800/600/400/200)",
    " *   饱和度随亮度偏离 50% 升高（§5.4）",
    " *   色相向更亮/更暗方向旋转，上限 20-30°（§5.4.2）",
    " *   灰阶带温度并在两端补偿（§5.5.1）",
    " *",
    " * 不手调 hex —— 手调必漂移。",
    " */",
    ":root {",
]
for name, stops in result.items():
    L.append("  /* %s */" % name)
    for k in sorted(stops, key=int):
        L.append("  --%s-%s: %s;" % (name, k, stops[k]))
    L.append("")

L += [
    "  /* ── 语义别名 ── */",
    "",
    "  /* 三档文字色（02-hierarchy §2.2.a：最多 3 个文字色）*/",
    "  --text-primary: var(--neutral-100);",
    "  --text-secondary: var(--neutral-400);",
    "  --text-tertiary: var(--neutral-600);",
    "",
    "  /* 表面层级（06-depth §6.1：光从上方来，抬高=上边缘更亮）*/",
    "  --surface-base: var(--neutral-900);",
    "  --surface-raised: var(--neutral-800);",
    "  --surface-overlay: var(--neutral-700);",
    "",
    "  /* 边框（§2.7.2：宁可加粗，不要加深）*/",
    "  --border-subtle: var(--neutral-800);",
    "  --border-default: var(--neutral-700);",
    "  --border-strong: var(--neutral-600);",
    "",
    "  /* 强调色（§2.8：一页只有一个主行动）*/",
    "  --accent: var(--primary-500);",
    "  --accent-hover: var(--primary-400);",
    "  --accent-subtle: var(--primary-800);",
    "",
    "  /* 状态 */",
    "  --state-success: var(--success-500);",
    "  --state-warning: var(--warning-500);",
    "  --state-danger: var(--danger-500);",
    "  --state-info: var(--primary-500);",
    "}",
]
(OUT / "tokens.css").write_text("\n".join(L), encoding="utf-8")

print()
print("=== 完整 ramp ===")
for name, stops in result.items():
    print("  %-8s" % name)
    for k in sorted(stops, key=int):
        print("      %s  %s" % (k, stops[k]))
print()
print("输出:", OUT / "tokens.css")
