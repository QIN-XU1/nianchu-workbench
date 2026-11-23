"""对比度校验 —— 跑 refactoring-ui 的 check_contrast.py，验证我们的配色是否合规"""
import subprocess, pathlib, sys, json, re

SKILL = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\research\repos\refactoring-ui-skill\skills\refactoring-ui")
PROJ = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研")
TOK = PROJ / "workbench" / "外壳" / "renderer" / "tokens" / "palette.json"

pal = json.loads(TOK.read_text(encoding="utf-8"))

# 我们要验证的关键配对（深色主题下的实际组合）
PAIRS = [
    ("primary text on base",     pal["neutral"]["100"], pal["neutral"]["900"]),
    ("secondary text on base",   pal["neutral"]["400"], pal["neutral"]["900"]),
    ("tertiary text on base",    pal["neutral"]["600"], pal["neutral"]["900"]),
    ("primary text on raised",   pal["neutral"]["100"], pal["neutral"]["800"]),
    ("secondary on raised",      pal["neutral"]["400"], pal["neutral"]["800"]),
    ("accent on base",           pal["primary"]["500"], pal["neutral"]["900"]),
    ("accent on raised",         pal["primary"]["500"], pal["neutral"]["800"]),
    ("success on base",          pal["success"]["500"], pal["neutral"]["900"]),
    ("warning on base",          pal["warning"]["500"], pal["neutral"]["900"]),
    ("danger on base",           pal["danger"]["500"],  pal["neutral"]["900"]),
]

print("=" * 68)
print("对比度校验（WCAG：正文 4.5:1 / 大字 3:1）")
print("=" * 68)

def run_contrast(fg, bg):
    """调用 skill 的 check_contrast.py"""
    r = subprocess.run([sys.executable, str(SKILL / "scripts" / "check_contrast.py"),
                        "--fg", fg, "--bg", bg],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(SKILL))
    return (r.stdout or "") + (r.stderr or ""), r.returncode

# 先看这个脚本的用法
r = subprocess.run([sys.executable, str(SKILL / "scripts" / "check_contrast.py"), "--help"],
                   capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(SKILL))
print("用法:")
print((r.stdout or r.stderr or "")[:600])
