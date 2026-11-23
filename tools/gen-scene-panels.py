#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成场景面板配置 —— 用**仓库里的真实数据**填，不编造。

照搬 luanyujia-workbench 的面板族（01-场景模式/面板类型总览.md）：
  dash / chart / table / file / flow / harness / list / view / reserved

输出：apps/.../scenePanels/panels.generated.json
      { "<sceneId>": PanelConfig[] }

每个面板的数字都来自真实文件，来源写进面板的 src 字段：
  research/改进台账.json
  evidence/evolve/{verifier-efficacy,t2-coverage,fpr-sweep,claims-audit,four-state-layers}.json
  tools/ prototype/ 的真实文件清单
  apps/.../vouch/data/neuron.json 的真实依赖图
"""
import io
import json
import os
import re
from collections import Counter

REPO = "D:/file/AI Temp/DeepSeek/Agent自研"
OUT = os.path.join(REPO, "apps/vouch-web/src/web-ui/src/app/scenes/workbench/scenePanels/panels.generated.json")


def load(p, default=None):
    try:
        return json.load(io.open(os.path.join(REPO, p), encoding="utf-8"))
    except Exception:
        return default


ledger = load("research/改进台账.json", {"entries": []})
entries = ledger.get("entries", [])


def eff(e):
    return "refuted" if e.get("disputedBy") else e.get("status")


closed = [e for e in entries if eff(e) == "closed"]
indep = [e for e in closed if "independent-subagent" in str(e.get("verifier", ""))]
cnt = Counter(eff(e) for e in entries)

efficacy = load("evidence/evolve/verifier-efficacy.json", {})
t2cov = load("evidence/evolve/t2-coverage.json", {})
fpr = load("evidence/evolve/fpr-sweep.json", {})
claims = load("evidence/evolve/claims-audit.json", {})
fourstate = load("evidence/evolve/four-state-layers.json", {})

# chart：用最近 20 条的**样本量**（真数据，且有变化）。
# 原来用「按月累计」，但 191 条全在同一个月 ⇒ 只有 1 个点，画不出趋势（实测）。
recent_s = [e for e in entries[-20:] if isinstance(e.get("samples"), (int, float))]
series = [int(e["samples"]) for e in recent_s]
labels = [str(e.get("id", "")) for e in recent_s]

# 真实模块目录（→ file 面板）
tools_dirs = []
tdir = os.path.join(REPO, "tools")
if os.path.isdir(tdir):
    for name in sorted(os.listdir(tdir)):
        p = os.path.join(tdir, name)
        if os.path.isdir(p):
            n = sum(len(fs) for _, _, fs in os.walk(p))
            tools_dirs.append({"name": name + "/", "size": str(n) + " 文件", "kind": "dir"})

# 真实验收器清单（→ file 面板）
verifiers = []
for root in ("prototype/agent-ui", "prototype/hermes-agents", "tools/evolve", "tools/quality"):
    d = os.path.join(REPO, root)
    if not os.path.isdir(d):
        continue
    for f in sorted(os.listdir(d)):
        if f.startswith(("verify-", "audit-", "measure-", "scan-")) and f.endswith(".mjs"):
            size = os.path.getsize(os.path.join(d, f))
            verifiers.append({"name": f, "size": str(round(size / 1024, 1)) + "KB", "kind": "file"})

# 本机磁盘（→ pc-* 四件套）—— 由 tools/pc/scan.mjs 产出，只读
PC = load("evidence/pc/scan.json", {})

# 通知看板（→ notices 面板）—— 照搬 luanyujia §四 的「超级通道」
def _notices():
    try:
        return json.load(io.open(os.path.join(REPO, "evidence/collab/notice-board.json"), encoding="utf-8"))
    except Exception:
        return []


def _receipts():
    p = os.path.join(REPO, "evidence/collab/receipts.jsonl")
    out = []
    try:
        for line in io.open(p, encoding="utf-8"):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return out


NOTICES = _notices()
RECEIPTS = _receipts()

# 跨场景请求（→ requests 面板）—— 只读 evidence/collab/requests.jsonl
def _reqs():
    p = os.path.join(REPO, "evidence/collab/requests.jsonl")
    out = []
    try:
        for line in io.open(p, encoding="utf-8"):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return out


REQUESTS = _reqs()

# 真实场景依赖图（→ flow 面板）
neuron = load("apps/vouch-web/src/web-ui/src/app/scenes/vouch/data/neuron.json", {}) or \
         load("prototype/hermes-agents/neuron.json", {})
nodes_raw = neuron.get("nodes", [])
edges_raw = neuron.get("edges", [])
flow_nodes, keep = [], set()
for i, n in enumerate(nodes_raw[:15]):
    nid = str(n.get("id", i))
    keep.add(nid)
    flow_nodes.append({
        "id": nid,
        "label": str(n.get("name") or n.get("label") or nid)[:6],
        "x": 28 + (i % 5) * 66,
        "y": 30 + (i // 5) * 46,
        "tone": "hub" if n.get("hub") else "neutral",
    })
flow_edges = [{"from": str(e.get("from")), "to": str(e.get("to"))} for e in edges_raw
              if str(e.get("from")) in keep and str(e.get("to")) in keep][:40]

SCENE_IDS = [str(n.get("id")) for n in nodes_raw] or ["hub"]
# 【2026-11-18 用户要求】标杆进「场景」——作为独立场景，整块面板显示
SCENE_IDS = SCENE_IDS + ["benchmark"]
SCENE_NAME = {str(n.get("id")): str(n.get("name") or n.get("id")) for n in nodes_raw}
SCENE_NAME["benchmark"] = "标杆"


def recent_items(k=8):
    return [{"id": str(e.get("id")), "label": str(e.get("obs", ""))[:30], "right": str(eff(e))}
            for e in entries[-k:][::-1]]


def panels_for(sid):
    name = SCENE_NAME.get(sid, sid)
    if sid == "hub":
        return [
            {"id": "kpi", "title": "全局指标", "type": "dash", "col": 1, "row": 1, "w": 2, "h": 2,
             "src": "research/改进台账.json", "cards": [
                 {"label": "台账条目", "value": len(entries), "hint": "全部"},
                 {"label": "真正结案", "value": len(closed), "hint": "排除被驳回", "tone": "ok"},
                 {"label": "独立验证", "value": len(indep), "hint": "T1 要求 ≥3",
                  "tone": "ok" if len(indep) >= 3 else "warn"},
                 {"label": "被驳回", "value": cnt.get("refuted", 0), "hint": "独立方推翻", "tone": "warn"},
             ]},
            {"id": "trend", "title": "台账增长", "type": "chart", "col": 3, "row": 1, "w": 1, "h": 2,
             "src": "改进台账.json · 最近 20 条样本量", "series": series, "labels": labels},
            {"id": "flow", "title": "场景依赖", "type": "flow", "col": 1, "row": 3, "w": 2, "h": 3,
             "src": "neuron.json", "nodes": flow_nodes, "edges": flow_edges},
            {"id": "files", "title": "模块目录", "type": "file", "col": 3, "row": 3, "w": 1, "h": 3,
             "src": "tools/", "rows": tools_dirs},
            {"id": "reqs", "title": "跨场景请求", "type": "requests", "col": 1, "row": 6, "w": 2, "h": 2,
             "src": "evidence/collab/requests.jsonl", "rows": REQUESTS[-6:]},
            {"id": "notices", "title": "通知看板", "type": "notices", "col": 3, "row": 6, "w": 1, "h": 2,
             "src": "evidence/collab/notice-board.json（最新在最上）", "rows": NOTICES[:6]},
            {"id": "ai", "title": "AI·中枢", "type": "harness", "col": 1, "row": 8, "w": 2, "h": 2},
            {"id": "receipts", "title": "回执", "type": "receipts", "col": 3, "row": 8, "w": 1, "h": 2,
             "src": "evidence/collab/receipts.jsonl", "rows": RECEIPTS[-6:]},
        ]
    if sid in ("verify", "evolve"):
        return [
            {"id": "kpi", "title": "验收器状态", "type": "dash", "col": 1, "row": 1, "w": 2, "h": 2,
             "src": "evidence/evolve/*.json", "cards": [
                 {"label": "recall", "value": str(efficacy.get("recallSame") or "—"), "hint": "人造故障", "tone": "ok"},
                 {"label": "fpr", "value": str(fpr.get("fpr") if fpr.get("fpr") is not None else "—"),
                  "hint": "可判定 " + str(fpr.get("decidable", "—")) + " 个", "tone": "ok"},
                 {"label": "T2 覆盖率", "value": str(t2cov.get("covered", "—")) + "/" + str(t2cov.get("total", "—")),
                  "hint": "突变检验", "tone": "ok"},
                 {"label": "五层四态", "value": str(fourstate.get("state", "—")), "hint": "T3", "tone": "ok"},
             ]},
            {"id": "vs", "title": "验收器清单", "type": "file", "col": 3, "row": 1, "w": 1, "h": 4,
             "src": "prototype/ + tools/", "rows": verifiers[:20]},
            {"id": "claims", "title": "六主张", "type": "table", "col": 1, "row": 3, "w": 2, "h": 2,
             "src": "claims-audit.json", "columns": ["主张", "状态", "证据"],
             "rows": [[str(r.get("id", "")), str(r.get("verdict", "")), str(r.get("evidence", ""))[:16]]
                      for r in (claims.get("claims") or [])][:6]},
            {"id": "ai", "title": "AI·验证", "type": "harness", "col": 1, "row": 5, "w": 2, "h": 2},
        ]
    if sid == "memory":
        return [
            {"id": "kpi", "title": "记忆四态", "type": "dash", "col": 1, "row": 1, "w": 2, "h": 2,
             "src": "改进台账.json", "cards": [
                 {"label": "全部条目", "value": len(entries)},
                 {"label": "已结案", "value": len(closed), "tone": "ok"},
                 {"label": "部分", "value": cnt.get("partial", 0), "tone": "warn"},
                 {"label": "判不了", "value": cnt.get("unknown", 0), "tone": "warn"},
             ]},
            {"id": "recent", "title": "最近 12 条", "type": "list", "col": 3, "row": 1, "w": 1, "h": 4,
             "src": "改进台账.json", "items": recent_items(12)},
            {"id": "ai", "title": "AI·记忆", "type": "harness", "col": 1, "row": 3, "w": 2, "h": 2},
        ]
    if sid == "pc-cleanup":
        # 照搬 luanyujia 06-场景实例/pc-cleanup.json 的四件套版式
        return [
            {"id": "drives", "title": "磁盘分区", "type": "pc-drives", "col": 1, "row": 1, "w": 2, "h": 2,
             "src": "evidence/pc/scan.json · tools/pc/scan.mjs", "drives": PC.get("drives", [])},
            {"id": "toplarge", "title": "磁盘大户排行", "type": "pc-toplarge", "col": 3, "row": 1, "w": 1, "h": 2,
             "src": "真实目录体积", "rows": PC.get("topLarge", [])},
            {"id": "junk", "title": "可清理体检", "type": "pc-junk", "col": 1, "row": 3, "w": 2, "h": 2,
             "src": "只报大小，不删", "rows": PC.get("junk", [])},
            {"id": "ledger", "title": "清理台账", "type": "pc-ledger", "col": 3, "row": 3, "w": 1, "h": 2,
             "src": "evidence/cleanup/cleanup-log.jsonl", "rows": PC.get("ledger", [])},
            {"id": "ai", "title": "AI·本地电脑", "type": "harness", "col": 1, "row": 5, "w": 2, "h": 2},
        ]
    if sid == "benchmark":
        return [
            {"id": "bench", "title": "标杆 · 22 个参照项目", "type": "benchmark",
             "col": 1, "row": 1, "w": 4, "h": 10, "src": "tools/benchmark/survey.mjs + analysis.json"},
        ]
    return [
        {"id": "files", "title": "相关文件", "type": "file", "col": 1, "row": 1, "w": 2, "h": 3,
         "src": "真实文件清单", "rows": verifiers[:12]},
        {"id": "led", "title": "相关改进", "type": "list", "col": 3, "row": 1, "w": 1, "h": 3,
         "src": "改进台账.json", "items": recent_items(8)},
        {"id": "ai", "title": "AI·" + name, "type": "harness", "col": 1, "row": 4, "w": 2, "h": 2},
    ]


out = {sid: panels_for(sid) for sid in SCENE_IDS}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
io.open(OUT, "w", encoding="utf-8", newline="\n").write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")

total = sum(len(v) for v in out.values())
types = Counter(p["type"] for v in out.values() for p in v)
print("  ✓ 已写 %s" % os.path.relpath(OUT, REPO))
print("    %d 个场景 · %d 块面板 · 类型 %s" % (len(out), total, dict(types)))
print("    真实数据: 台账 %d 条 · 结案 %d · 独立验证 %d · 目录 %d · 验收器 %d · 依赖图 %d 节点/%d 边"
      % (len(entries), len(closed), len(indep), len(tools_dirs), len(verifiers), len(flow_nodes), len(flow_edges)))
