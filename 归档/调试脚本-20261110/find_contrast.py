"""按对比度校验结果修正令牌映射"""
import subprocess, pathlib, sys, json, re

SKILL = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\research\repos\refactoring-ui-skill\skills\refactoring-ui")
TOK = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\workbench\外壳\renderer\tokens\palette.json")
pal = json.loads(TOK.read_text(encoding="utf-8"))
N = pal["neutral"]

def ratio(fg, bg):
    r = subprocess.run([sys.executable, str(SKILL / "scripts" / "check_contrast.py"),
                        "--pair", fg, bg], capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(SKILL))
    out = (r.stdout or "") + (r.stderr or "")
    m = re.search(r"(\d+\.\d+)\s*:\s*1", out)
    return float(m.group(1)) if m else None

print("=== 在 neutral ramp 上逐档实测，找达标值 ===")
print()
print("对 base (#222435, neutral-900) 的对比度：")
BASE = N["900"]
for k in sorted(N, key=int):
    r = ratio(N[k], BASE)
    print("  neutral-%s %s  对比 %5.2f:1" % (k, N[k], r if r else -1))

print()
print("对 raised (#35394c, neutral-800) 的对比度：")
RAISED = N["800"]
for k in sorted(N, key=int):
    r = ratio(N[k], RAISED)
    print("  neutral-%s %s  对比 %5.2f:1" % (k, N[k], r if r else -1))

print()
print("=== 结论：应该选哪档 ===")
# 三档文字色：正文 ≥ 直白；次要 ≥4.5；三级 ≥3（作为大字/辅助）
base_vs_100 = ratio(N["100"], BASE)
print("  正文  → neutral-100 (%.2f:1)" % base_vs_100)

# 找次要色：对 base 和 raised 都 ≥4.5
candidates = []
for k in sorted(N, key=int):
    rb = ratio(N[k], BASE)
    rr = ratio(N[k], RAISED)
    if rb and rr and rb >= 4.5 and rr >= 4.5:
        candidates.append((k, N[k], rb, rr))
print()
print("  次要色候选（对 base 和 raised 都 ≥4.5）：")
for k, hexv, rb, rr in candidates:
    print("      neutral-%s %s  base %.2f / raised %.2f" % (k, hexv, rb, rr))
