import subprocess, json, pathlib, sys

SKILL = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\research\repos\refactoring-ui-skill\skills\refactoring-ui")
OUT = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\renderer\tokens")
OUT.mkdir(parents=True, exist_ok=True)

def gen(args):
    r = subprocess.run([sys.executable, str(SKILL / "scripts" / "generate_palette.py")] + args,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(SKILL))
    if r.returncode != 0:
        print("  失败:", (r.stderr or "")[:150])
        return None
    return json.loads(r.stdout)

# ═══════ 生成四条 ramp ═══════
RAMPS = {
    "primary": ["--base", "#7DA1DE"],          # 雾蓝（dsh-TUI dark accent）
    "neutral": ["--grey", "--temperature", "cool"],  # 中性灰，冷调
    "danger":  ["--base", "#E5787E"],          # 危险红
    "warning": ["--base", "#DEB56B"],          # 警告黄
    "success": ["--base", "#7CCB8F"],          # 成功绿
}

result = {}
for name, args in RAMPS.items():
    j = gen(args)
    if j:
        # 提取 stops
        color = j.get("color", {})
        result[name] = {k: v["hex"] for k, v in color.items() if isinstance(v, dict) and "hex" in v}
        print("OK %-10s %d stops: %s" % (name, len(result[name]),
              " ".join("%s=%s" % (k, v) for k, v in sorted(result[name].items())[:4])))

# ═══════ 保存 ═══════
(OUT / "palette.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print()
print("已保存 tokens/palette.json")

# ═══════ 生成 tokens.css ═══════
lines = [
    "/**",
    " * 设计令牌 —— 由 refactoring-ui 的 generate_palette.py 生成",
    " *",
    " * 生成算法（来自 Refactoring UI ch.5）：",
    " *   §5.3.3 base(500) → edges(900/100) → bisect(700/300) → bisect(800/600/400/200)",
    " *   §5.4   饱和度随亮度偏离 50% 而升高",
    " *   §5.4.2 色相向更亮/更暗方向旋转，上限 20-30°",
    " *   §5.5.1 灰阶带温度，两端补偿",
    " *",
    " * 不手调 hex —— 手调会漂移，这正是算法存在的理由。",
    " */",
    "",
    ":root {",
]
for name, stops in result.items():
    lines.append("  /* %s */" % name)
    for k in sorted(stops.keys(), key=lambda x: int(x)):
        lines.append("  --%s-%s: %s;" % (name, k, stops[k]))
    lines.append("")

# 语义别名（照 §2.2.a：三档文字色）
lines += [
    "  /* 语义别名（照 02-hierarchy §2.2.a：三档文字色）*/",
    "  --text-primary: var(--neutral-100);",
    "  --text-secondary: var(--neutral-400);",
    "  --text-tertiary: var(--neutral-600);",
    "",
    "  /* 表面（照 06-depth：光照来自上方）*/",
    "  --surface-base: var(--neutral-900);",
    "  --surface-raised: var(--neutral-800);",
    "  --surface-overlay: var(--neutral-700);",
    "",
    "  /* 边框（照 §2.7.2：宁可加粗不要加深）*/",
    "  --border-subtle: var(--neutral-800);",
    "  --border-default: var(--neutral-700);",
    "  --border-strong: var(--neutral-600);",
    "",
    "  /* 状态 */",
    "  --state-success: var(--success-500);",
    "  --state-warning: var(--warning-500);",
    "  --state-danger: var(--danger-500);",
    "  --state-info: var(--primary-500);",
    "}",
]
(OUT / "tokens.css").write_text("\n".join(lines), encoding="utf-8")
print("已保存 tokens/tokens.css")

# ═══════ 输出 ═══════
print()
print("=== 生成的 ramp 摘要 ===")
for name, stops in result.items():
    print("  %-8s" % name, end="")
    for k in ["100", "300", "500", "700", "900"]:
        if k in stops:
            print(" %s=%s" % (k, stops[k]), end="")
    print()
