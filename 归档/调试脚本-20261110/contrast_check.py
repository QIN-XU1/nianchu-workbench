"""对比度校验 —— 用 refactoring-ui 的 check_contrast.py 验证我们的深色主题配色"""
import subprocess, pathlib, sys, json

SKILL = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\research\repos\refactoring-ui-skill\skills\refactoring-ui")
TOK = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\renderer\tokens\palette.json")
pal = json.loads(TOK.read_text(encoding="utf-8"))

N = pal["neutral"]

PAIRS = [
    ("正文：primary text",      N["100"], N["900"], "normal"),
    ("次要：secondary text",     N["400"], N["900"], "normal"),
    ("三级：tertiary text",      N["600"], N["900"], "normal"),
    ("正文 on raised",          N["100"], N["800"], "normal"),
    ("次要 on raised",          N["400"], N["800"], "normal"),
    ("强调色：accent",           pal["primary"]["500"], N["900"], "normal"),
    ("强调 hover",              pal["primary"]["400"], N["900"], "normal"),
    ("成功",                    pal["success"]["500"], N["900"], "normal"),
    ("警告",                    pal["warning"]["500"], N["900"], "normal"),
    ("危险",                    pal["danger"]["500"],  N["900"], "normal"),
    ("边框：border-default",     N["700"], N["900"], "large"),
    ("边框：border-strong",      N["600"], N["900"], "large"),
]

def contrast(fg, bg, size="normal"):
    r = subprocess.run([sys.executable, str(SKILL / "scripts" / "check_contrast.py"),
                        "--pair", fg, bg, "--size", size],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(SKILL))
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    # 提取比值，形如 "4.82:1" 或 "ratio 4.82"
    import re
    m = re.search(r"(\d+\.\d+)\s*:\s*1", out)
    if m:
        return float(m.group(1)), out, r.returncode
    return None, out, r.returncode

print("=" * 72)
print("对比度校验（WCAG 正文 4.5:1 · 大字 3:1）")
print("=" * 72)
print()
print("%-22s %-10s %-10s %-8s %s" % ("配对", "前景", "背景", "比值", "判定"))
print("-" * 72)

fails = []
for label, fg, bg, size in PAIRS:
    ratio, raw, rc = contrast(fg, bg, size)
    need = 4.5 if size == "normal" else 3.0
    if ratio is None:
        # 脚本可能只输出 PASS/FAIL 文字
        ok = "PASS" in raw.upper() and "FAIL" not in raw.upper()
        verdict = "?" + ("OK" if ok else "FAIL")
        print("%-22s %-10s %-10s %-8s %s" % (label, fg, bg, "?", verdict))
        print("    原始输出:", raw[:100].replace("\n", " "))
    else:
        ok = ratio >= need
        verdict = "OK" if ok else "FAIL"
        if not ok:
            fails.append((label, ratio, need))
        color = "\033[32m" if ok else "\033[31m"
        print("%-22s %-10s %-10s %-8.2f %s%s\033[0m" % (label, fg, bg, ratio, color, verdict))

print()
if fails:
    print("不达标的 %d 项：" % len(fails))
    for label, ratio, need in fails:
        print("  - %s：%.2f:1（需要 %.1f:1）" % (label, ratio, need))
else:
    print("全部达标")
