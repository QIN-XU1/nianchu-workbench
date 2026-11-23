import subprocess, json, pathlib, sys

SKILL = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\research\repos\refactoring-ui-skill\skills\refactoring-ui")
OUT = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\renderer\tokens")
OUT.mkdir(parents=True, exist_ok=True)

def gen(args):
    r = subprocess.run([sys.executable, str(SKILL / "scripts" / "generate_palette.py")] + args,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(SKILL))
    out = (r.stdout or "").strip()
    # JSON 可能前后有杂字符 —— 从第一个 { 开始截
    i = out.find("{")
    if i < 0:
        return None, (r.stderr or out)[:200]
    try:
        return json.loads(out[i:]), None
    except Exception as e:
        return None, str(e) + " | 片段: " + out[i:i + 80]

RAMPS = {
    "primary": ["--base", "#7DA1DE"],
    "neutral": ["--grey", "--temperature", "cool"],
    "danger":  ["--base", "#E5787E"],
    "warning": ["--base", "#DEB56B"],
    "success": ["--base", "#7CCB8F"],
}

result = {}
for name, args in RAMPS.items():
    j, err = gen(args)
    if not j:
        print("FAIL %-10s %s" % (name, err))
        continue
    color = j.get("color", {})
    result[name] = {k: v["hex"] for k, v in color.items() if isinstance(v, dict) and "hex" in v}
    print("OK %-10s %d stops" % (name, len(result[name])))

if not result:
    print("没有任何 ramp 生成成功")
    sys.exit(1)

(OUT / "palette.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

# tokens.css
lines = [
    "/**",
    " * 设计令牌 —— refactoring-ui generate_palette.py 生成",
    " * 算法：base(500) → edges(900/100) → bisect(700/300) → bisect(800/600/400/200)",
    " *      饱和度随亮度偏离 50% 升高；色相旋转上限 20-30°；灰阶带温度",
    " * 不手调 hex。",
    " */",
    ":root {",
]
for name, stops in result.items():
    lines.append("  /* %s */" % name)
    for k in sorted(stops.keys(), key=lambda x: int(x)):
        lines.append("  --%s-%s: %s;" % (name, k, stops[k]))
    lines.append("")

lines += [
    "  /* 语义别名（02-hierarchy §2.2.a 三档文字色）*/",
    "  --text-primary: var(--neutral-100);",
    "  --text-secondary: var(--neutral-400);",
    "  --text-tertiary: var(--neutral-600);",
    "",
    "  /* 表面（06-depth 光照来自上方）*/",
    "  --surface-base: var(--neutral-900);",
    "  --surface-raised: var(--neutral-800);",
    "  --surface-overlay: var(--neutral-700);",
    "",
    "  /* 边框（§2.7.2 宁可加粗不要加深）*/",
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

print()
print("=== 摘要 ===")
for name, stops in result.items():
    print("  %-8s" % name, end="")
    for k in ["100", "300", "500", "700", "900"]:
        if k in stops:
            print(" %s=%-8s" % (k, stops[k]), end="")
    print()
print()
print("输出:", OUT / "palette.json", "和 tokens.css")
