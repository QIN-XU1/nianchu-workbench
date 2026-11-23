#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
搬 luanyujia-workbench 的六件套 ②③⑥ 进仓库。

出处：
  00-核心机制/三-场景体系.md §3 六件套、§4 目录、§5 身份
  05-协作与规矩/四-身份索引-怎么建.md §2 七列

生成三样东西（都是真实数据，来自 neuron.json 与台账）：
  ① scenes/_身份索引.md            —— 七列表（人看）
  ② scenes/<id>-context.md         —— 定位卡：职责 / 资产 / 触发词 / 铁律 / 上次进度
  ③ scenePanels/identity.json      —— 同一张表的机器可读版（UI 用）

诚实边界：我们没有真实会话 id，所以「会话 id」列一律写 `—`（未绑定），
不编造 UUID。面板会如实显示「未绑定」，而不是假装接了会话。
"""
import io
import json
import pathlib
import datetime

ROOT = pathlib.Path("D:/file/AI Temp/DeepSeek/Agent自研")
NEURON = ROOT / "apps/vouch-web/src/web-ui/src/app/scenes/vouch/data/neuron.json"
LEDGER = ROOT / "research/改进台账.json"
OUT_MD = ROOT / "scenes"
OUT_JSON = ROOT / "apps/vouch-web/src/web-ui/src/app/scenes/workbench/scenePanels/identity.json"

neuron = json.load(io.open(NEURON, encoding="utf-8"))
ledger = json.load(io.open(LEDGER, encoding="utf-8"))
OUT_MD.mkdir(parents=True, exist_ok=True)

deg = {}
for e in neuron["edges"]:
    deg[e["from"]] = deg.get(e["from"], 0) + 1
    deg[e["to"]] = deg.get(e["to"], 0) + 1

name_of = {n["id"]: n.get("name", n["id"]) for n in neuron["nodes"]}
ups = {}
downs = {}
for e in neuron["edges"]:
    downs[e["from"]] = downs.get(e["from"], 0) + 1
    ups[e["to"]] = ups.get(e["to"], 0) + 1

# 每个场景的真实「职责」：从它在图上的位置推导（上游/下游邻居）
def neighbors(sid):
    out = []
    for e in neuron["edges"]:
        if e["from"] == sid:
            out.append((name_of[e["to"]], "下游", e.get("how", "")))
        elif e["to"] == sid:
            out.append((name_of[e["from"]], "上游", e.get("how", "")))
    return out

rows = []
for n in neuron["nodes"]:
    sid = n["id"]
    nm = name_of[sid]
    rows.append({
        "sceneId": sid,
        "panelId": f"{sid}-ai",
        "panelTitle": f"AI·{nm}",
        "sessionTitle": nm,
        "sessionId": None,          # 诚实：未绑定
        "contextCard": f"scenes/{sid}-context.md",
        "skill": "—",               # 诚实：暂无专属技能
        "deg": deg.get(sid, 0),
    })

# ① 身份索引 md
lines = []
lines.append("# 场景身份索引 —— 「我是谁」的唯一对照表\n")
lines.append("> 搬自 `luanyujia-workbench/05-协作与规矩/四-身份索引-怎么建.md` §2（七列，一列都不省）。\n")
lines.append("> **引擎不会按场景注入任何东西**，所以每个 AI 会话开场必须查这张表认领自己。\n")
lines.append("> 数据源以场景配置为准：表与配置不一致 = 表过期。\n")
lines.append(f"> 生成时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}（由 tools/gen-scene-identity.py 生成，勿手改）\n")
lines.append("")
lines.append("| 场景 id | 面板 id | 面板标题 | 会话名 | 会话 id | 定位卡 | 主技能 |")
lines.append("|---|---|---|---|---|---|---|")
for r in rows:
    lines.append("| `{sid}` | `{pid}` | {pt} | {st} | {se} | `{cc}` | {sk} |".format(
        sid=r["sceneId"], pid=r["panelId"], pt=r["panelTitle"], st=r["sessionTitle"],
        se="—（未绑定）" if not r["sessionId"] else f"`{r['sessionId']}`",
        cc=r["contextCard"], sk=r["skill"]))
lines.append("")
lines.append("## 开场四步（每次新会话必做）\n")
lines.append("```")
lines.append("① 拿自己的会话 id")
lines.append("② 在本表里查这个 id  →  得到：场景 / 定位卡 / 主技能 / 场景记忆")
lines.append("③ 读定位卡（职责 / 资产 / 触发词 / 铁律 / 上次进度）")
lines.append("④ 读场景记忆的 §〇（进度 / 下一步 / 卡点）")
lines.append("        ↓")
lines.append("     四步做完再动手")
lines.append("```")
lines.append("")
lines.append("> 为什么不能靠「在开场消息里写你是 XX 场景」：能用，但换会话/分叉时容易漏，")
lines.append("> 而且面板那边改了它不知道。**表是数据、卡是职责，两者都不在会话里。**")
lines.append("")
lines.append(f"## 现状\n")
lines.append(f"· 场景数：{len(rows)}")
lines.append(f"· 已绑定会话：{sum(1 for r in rows if r['sessionId'])} / {len(rows)}  ← 如实标注，不编造 UUID")
lines.append(f"· 有专属技能的：{sum(1 for r in rows if r['skill'] != '—')} / {len(rows)}")
lines.append(f"· 台账条数：{len(ledger['entries'])}")
io.open(OUT_MD / "_身份索引.md", "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
print("  ① scenes/_身份索引.md")

# ② 定位卡
for r in rows:
    sid = r["sceneId"]
    nm = name_of[sid]
    nb = neighbors(sid)
    up_list = [x for x in nb if x[1] == "上游"]
    down_list = [x for x in nb if x[1] == "下游"]
    card = []
    card.append(f"# 定位卡 · {nm}\n")
    card.append("> 搬自 `luanyujia-workbench` 六件套第 ② 件（`00-核心机制/三-场景体系.md` §4）。")
    card.append("> 最小版本只要四节：职责 / 资产 / 触发词 / 铁律；进度后续再补。\n")
    card.append(f"- 场景 id：`{sid}`")
    card.append(f"- 面板 id：`{r['panelId']}`")
    card.append(f"- 连接度：{r['deg']}（上游 {len(up_list)} / 下游 {len(down_list)}）")
    card.append(f"- 生成时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
    card.append("---\n")
    card.append("## §一 职责\n")
    card.append(f"「{nm}」这一类活。在记忆元图上：")
    if up_list:
        card.append(f"- 它接收来自：{'、'.join(x[0] for x in up_list)}")
    if down_list:
        card.append(f"- 它产出给：{'、'.join(x[0] for x in down_list)}")
    if not nb:
        card.append("- 孤立节点（图上没有连线）")
    card.append("")
    card.append("## §二 资产地图\n")
    card.append("| 资产 | 在哪 |")
    card.append("|---|---|")
    card.append(f"| 场景配置 | `apps/vouch-web/src/web-ui/src/app/scenes/workbench/scenePanels/configs.ts` |")
    card.append(f"| 身份索引 | `scenes/_身份索引.md` |")
    card.append(f"| 本定位卡 | `scenes/{sid}-context.md` |")
    card.append(f"| 台账 | `research/改进台账.json` |")
    card.append("")
    card.append("## §三 触发词\n")
    card.append("（待补：这类活用户会怎么说。补之前先空着，别硬造。）")
    card.append("")
    card.append("## §四 铁律\n")
    card.append("- 先立标准再干活；每个结论附 `路径:行号` 证据")
    card.append("- 不许「看起来有实际是空」；不许只改文档不改实现")
    card.append("- 拿不到的证据标 UNKNOWN，绝不用推测填空")
    card.append("")
    card.append("## §五 上次进度\n")
    card.append("（待补：由该场景的会话在收工时写。§〇 五条：身份 / 进度 / 下一步 / 卡点 / 细节在哪。）")
    io.open(OUT_MD / f"{sid}-context.md", "w", encoding="utf-8", newline="\n").write("\n".join(card) + "\n")
print(f"  ② scenes/<id>-context.md × {len(rows)}")

# ③ 机器可读
io.open(OUT_JSON, "w", encoding="utf-8", newline="\n").write(
    json.dumps({"generatedAt": datetime.datetime.now().isoformat(timespec="seconds"), "rows": rows},
               ensure_ascii=False, indent=2) + "\n")
print(f"  ③ {OUT_JSON.relative_to(ROOT)}")
print(f"\n  台账 {len(ledger['entries'])} 条 · 场景 {len(rows)} 个 · 已绑定会话 0 个（如实）")
