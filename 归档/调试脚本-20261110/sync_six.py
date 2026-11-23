import pathlib, json

WB = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\workbench")
SC = WB / "外壳" / "scenarios"

scenes = []
for f in sorted(SC.glob("*.json")):
    if f.name.startswith("_"):
        continue
    try:
        scenes.append(json.loads(f.read_text(encoding="utf-8")))
    except Exception:
        continue

print("=== 第 2 步：生成定位卡 ===")
made = 0
for sc in scenes:
    sid = sc["id"]
    name = sc["name"]
    ctx = SC / (sid + "-context.md")
    if ctx.exists():
        continue

    panels = sc.get("panels", [])
    panelMap = "\n".join(
        "| `%s` | %s | %s |" % (p.get("id"), p.get("title", ""), p.get("type", ""))
        for p in panels
    ) or "（无）"

    harness = next((p for p in panels if p.get("type") == "harness"), None)
    sessionTitle = harness.get("sessionTitle") if harness else None

    body = "\n".join([
        "# %s · 定位卡" % name,
        "",
        "> 照 luanyujia 2.1「加场景」第 2 步：身份与职责 / 面板地图 / 触发词 / 流程 / 铁律 / 上次进度",
        "",
        "## 一、身份与职责",
        "",
        "- 场景 id：`%s`" % sid,
        "- 场景名：%s" % name,
        "- 一句话职责：%s" % (sc.get("description", "")[:120] or "（待补）"),
        "- 不碰什么：（待补）",
        "",
        "## 二、面板地图",
        "",
        "| 面板 id | 标题 | 类型 |",
        "|---|---|---|",
        panelMap,
        "",
        "## 三、触发词 → 定位",
        "",
        "- 说到「%s」或「%s」时进入本场景" % (name, sid),
        "- 需要本场景的 AI 会话：%s" % (sessionTitle or "（无 AI 面板）"),
        "- 记忆目录：`引擎数据\\.dsh\\场景记忆\\%s\\`" % name,
        "",
        "## 四、流程",
        "",
        "1. 开场读 `场景私有记忆.md` 的 §〇 当前交接（≤4KB）",
        "2. 干活",
        "3. 收工前跑 `node prototype\\mem.mjs handoff --scene \"%s\" --done \"...\" --next \"...\"`" % name,
        "",
        "## 五、铁律",
        "",
        "- 只写自己的记忆，不碰别人的",
        "- 换会话前必须先写 §〇",
        "- 主文件 ≤25KB / §〇 ≤4KB",
        "",
        "## 六、上次进度",
        "",
        "见 `场景私有记忆.md` 的 §〇",
        "",
    ])
    ctx.write_text(body, encoding="utf-8")
    made += 1
    print("  OK %s-context.md" % sid)

c = len(list(SC.glob("*-context.md")))
print("  定位卡 %d 个" % c)

print()
print("=== 第 3 步：生成身份索引 ===")
lines = [
    "# 场景身份索引",
    "",
    "> 照 luanyujia 2.1 第 3 步。场景 id ↔ 面板 id ↔ 会话名 ↔ sessionId ↔ 定位卡 ↔ 技能",
    "",
    "| 场景 id | 场景名 | AI 面板 | 面板标题 | 会话名 | sessionId | 定位卡 | 技能 |",
    "|---|---|---|---|---|---|---|---|",
]
for sc in scenes:
    sid = sc["id"]
    name = sc["name"]
    harness = next((p for p in sc.get("panels", []) if p.get("type") == "harness"), None)
    panelId = (harness or {}).get("id", "—")
    panelTitle = (harness or {}).get("title", "—")
    sessionTitle = (harness or {}).get("sessionTitle", "—")
    sessionId = (harness or {}).get("sessionId", "")
    sidCell = "`%s`" % sessionId if sessionId else "**__待填__**"
    skill = "relationship-advisor" if sid == "relationship" else "无专属技能"
    lines.append("| `%s` | %s | `%s` | %s | %s | %s | `%s-context.md` | %s |" % (
        sid, name, panelId, panelTitle, sessionTitle, sidCell, sid, skill))

lines += ["", "## 建会话（照 luanyujia 换会话协议）", "", "```powershell"]
for sc in scenes:
    h = next((p for p in sc.get("panels", []) if p.get("type") == "harness"), None)
    if h and h.get("sessionTitle"):
        lines.append('node 外壳\\scripts\\建会话.mjs --title "%s"' % h["sessionTitle"])
lines += ["node 外壳\\scripts\\sessions.mjs --check", "```", ""]

(SC / "_场景身份索引.md").write_text("\n".join(lines), encoding="utf-8")
print("  OK 身份索引（%d 个场景）" % len(scenes))

print()
print("=== 第 4 步：专属技能 ===")
SD = WB / "引擎数据" / ".dsh" / "skills"
if SD.exists():
    existing = sorted(d.name for d in SD.iterdir() if d.is_dir())
    print("  已有技能 %d 个: %s" % (len(existing), ", ".join(existing)))
else:
    print("  技能目录不存在")

print()
print("=== 汇总 ===")
print("  场景 %d 个" % len(scenes))
ctx_count = 0
for f in SC.glob("*-context.md"):
    ctx_count += 1
print("  定位卡 %d 个" % ctx_count)
print("  身份索引 1 份")
