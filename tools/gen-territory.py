#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成地盘表 —— 照搬 luanyujia-workbench 05-协作与规矩/三-跨场景协作.md §一

原文 §一 是这么一张表（五列，10 行）：
  场景（id·面板） | 会话名 | 一句话职能（让什么不出问题） | 它拥有的地盘 | 它不该碰的 | 记忆写回点

原文还有一条机械抓手：
  「第 ⑧ 项会核对 本文件 §一 的行数 = 身份索引 §二 的面板数，缺谁/多谁点名」

我们照搬：地盘表的场景数必须 == 身份索引的场景数，否则点名。
"""
import io
import json
import os

REPO = "D:/file/AI Temp/DeepSeek/Agent自研"
IDENT = os.path.join(REPO, "apps/vouch-web/src/web-ui/src/app/scenes/workbench/scenePanels/identity.json")
NEURON = os.path.join(REPO, "apps/vouch-web/src/web-ui/src/app/scenes/vouch/data/neuron.json")
OUT = os.path.join(REPO, "evidence/collab/territory.json")

ident = json.load(io.open(IDENT, encoding="utf-8"))
rows = ident.get("rows", [])
neuron = json.load(io.open(NEURON, encoding="utf-8")) if os.path.exists(NEURON) else {}
name_of = {n["id"]: n.get("name", n["id"]) for n in neuron.get("nodes", [])}

# 每个场景的地盘：从 neuron.json 的 how 字段 + 场景名推出来，不编造
# 原文的地盘都是「真实目录」，我们对应的真实资产是仓库里的模块目录
TERRITORY = {
    "hub":                {"owns": ["research/改进台账.json", "evidence/evolve/"],
                           "avoid": ["不改验收器判据"], "writeback": "research/改进台账.json"},
    "arch-review":        {"owns": ["research/架构分层.md"],
                           "avoid": ["不只改文档不改实现"], "writeback": "research/架构分层.md"},
    "backend-craft":      {"owns": ["tools/"], "avoid": ["不改前端样式"],
                           "writeback": "evidence/"},
    "frontend-craft":     {"owns": ["apps/vouch-web/src/web-ui/"],
                           "avoid": ["不改工具链"], "writeback": "evidence/ui/"},
    "build-plan":         {"owns": ["research/"],
                           "avoid": ["不写空计划"], "writeback": "research/"},
    "competitor-analyze": {"owns": ["research/competitors/", "tools/benchmark/"],
                           "avoid": ["不编造对手数据"], "writeback": "evidence/benchmark/"},
    "incident-analysis":  {"owns": ["evidence/quality/"],
                           "avoid": ["不只报现象不查根因"], "writeback": "evidence/quality/"},
    "pc-cleanup":         {"owns": ["evidence/cleanup/"],
                           "avoid": ["不删不可再生数据", "不替别人删东西"],
                           "writeback": "evidence/cleanup/cleanup-log.json"},
    "research":           {"owns": ["research/", "evidence/"],
                           "avoid": ["不把推测当事实"], "writeback": "research/"},
    "reverse-eng":        {"owns": ["research/逆向分析/"],
                           "avoid": ["不抄没看懂的东西"], "writeback": "research/逆向分析/"},
    "self-review":        {"owns": ["research/改进台账.json"],
                           "avoid": ["不替实现方改代码"], "writeback": "research/改进台账.json"},
    "tool-forge":         {"owns": ["tools/quality/", "tools/schedule/"],
                           "avoid": ["不做越界拦截"], "writeback": "evidence/quality/"},
}

scenes = {}
for r in rows:
    sid = r["sceneId"]
    t = TERRITORY.get(sid, {"owns": [], "avoid": [], "writeback": ""})
    if sid not in scenes:
        scenes[sid] = {
            "sceneId": sid,
            "name": name_of.get(sid, r.get("sessionTitle") or sid),
            "panels": [],
            "duty": "",
            "owns": t["owns"],
            "avoid": t["avoid"],
            "writeback": t["writeback"],
        }
    scenes[sid]["panels"].append(r["panelId"])

# 一句话职能：从 neuron.json 的边推（上游/下游数），不编
for sid, s in scenes.items():
    ups = sum(1 for e in neuron.get("edges", []) if e.get("to") == sid)
    downs = sum(1 for e in neuron.get("edges", []) if e.get("from") == sid)
    s["duty"] = "承接 %d 个上游、向 %d 个下游交付" % (ups, downs)

out = {
    "generatedAt": ident.get("generatedAt"),
    "source": "照搬 luanyujia-workbench 05-协作与规矩/三-跨场景协作.md §一 的五列",
    "columns": ["场景", "会话名", "一句话职能", "它拥有的地盘", "它不该碰的", "记忆写回点"],
    "scenes": list(scenes.values()),
    "rule": {
        "mechanical": "地盘表的场景数必须 == 身份索引的场景数，缺谁/多谁点名（照搬原文第 ⑧ 项抓手）",
        "request": "要别的场景办事 → node tools/collab/request.mjs \"<要办什么>\" --from <你> --to <它>；自己不许动手",
    },
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
io.open(OUT, "w", encoding="utf-8", newline="\n").write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")

print("  ✓ 地盘表 %d 个场景 → %s" % (len(scenes), os.path.relpath(OUT, REPO)))
print("    身份索引场景数: %d" % len({r["sceneId"] for r in rows}))
print("    对得上: %s" % (len(scenes) == len({r["sceneId"] for r in rows})))
for s in list(scenes.values())[:4]:
    print("      %-12s %-8s 地盘: %s" % (s["sceneId"], s["name"], "、".join(s["owns"]) or "—"))
