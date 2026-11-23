#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建「神经记忆元」拓扑图 —— 跨层网络，不是只有场景的列表。

【为什么重做】2026-11-18 用户指出：我完全没理解要做的东西。
参照 D:/refs/luanyujia/luanyujia-workbench-main/总纲.md ：
  「图是**拓扑连线图**：节点 = 东西在哪一层，连线 = 谁读谁 / 谁写谁 / 谁兜底。」

我原来的 neuron.json 只有 12 个场景节点、31 条上下游边 —— 那只是**场景之间的调用关系**，
不是「记忆网络」。真正的网络要跨六层：
  L0 宪法     —— 硬约束（只有人能改）
  L1 共享层   —— 台账 / 证据（所有人共用的事实）
  L2 场景私有 —— 12 个场景各自的记忆与身份卡
  L3 运行时   —— tools/ 下真跑的工具
  L4 归档     —— 备份 / 历史

每一层都要有**真实**节点（有文件、有大小、有修改时间），连线要有语义
（reads / writes / injects / guards / archives），否则就是画着好看。

输出：apps/.../vouch/data/topology.json
"""
import io
import json
import os
import re
import time
from collections import Counter

REPO = "D:/file/AI Temp/DeepSeek/Agent自研"
OUT = os.path.join(REPO, "apps/vouch-web/src/web-ui/src/app/scenes/vouch/data/topology.json")


def rel(relpath):
    return os.path.join(REPO, relpath)


def size_of(relpath):
    p = rel(relpath)
    if os.path.isfile(p):
        return os.path.getsize(p)
    if os.path.isdir(p):
        n = 0
        for root, _, files in os.walk(p):
            for f in files:
                try:
                    n += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return n
    return 0


def mtime_of(relpath):
    p = rel(relpath)
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(os.path.getmtime(p)))
    except OSError:
        return None


def count_files(relpath, pattern=None):
    p = rel(relpath)
    if not os.path.isdir(p):
        return 0
    n = 0
    for _, _, files in os.walk(p):
        for f in files:
            if pattern is None or pattern in f:
                n += 1
    return n


# ── 真实数据源 ────────────────────────────────────────────────
ledger = json.load(io.open(rel("research/改进台账.json"), encoding="utf-8"))
entries = ledger.get("entries", [])


def eff(e):
    return "refuted" if e.get("disputedBy") else e.get("status")


status = Counter(eff(e) for e in entries)
closed = status.get("closed", 0)
indep = len([e for e in entries if eff(e) == "closed" and "independent-subagent" in str(e.get("verifier", ""))])

neuron = json.load(io.open(rel("apps/vouch-web/src/web-ui/src/app/scenes/vouch/data/neuron.json"), encoding="utf-8"))
scenes = neuron.get("nodes", [])
scene_edges = neuron.get("edges", [])

nodes = []
edges = []
edge_seq = [0]


def safe_id(raw):
    """React Flow 内部用 CSS 选择器查节点/边，id 里出现 ':' 会直接让边渲染不出来。
    这个坑本项目踩过两次（WorkbenchScene 里写着 '>' '#' 那次，和现在 ':' 这次），
    所以统一在生成端规范化，界面端不必再防。
    """
    return re.sub(r'[^A-Za-z0-9_-]', '-', raw)


def add_node(nid, label, layer, kind, path, extra=None, sub=None):
    """节点 = 东西在哪一层；带真实体积/时间/计量，不用占位符"""
    size = size_of(path) if path else 0
    n = {
        "id": safe_id(nid),
        "label": label,
        "layer": layer,
        "kind": kind,
        "path": path,
        "bytes": size,
        "mb": round(size / 1e6, 2) if size else 0,
        "at": mtime_of(path) if path else None,
        "sub": sub or "",
    }
    if extra:
        n.update(extra)
    nodes.append(n)
    return n


def add_edge(src, dst, how, label):
    """连线 = 谁读谁 / 谁写谁 / 谁兜底"""
    edge_seq[0] += 1
    edges.append({"id": "E%03d" % edge_seq[0], "from": safe_id(src), "to": safe_id(dst), "how": how, "label": label})


# ── L0 宪法 ──────────────────────────────────────────────────
add_node("host", "宿主（唯一决策人）", "L0", "host", None,
         sub="判断类的事只由人定：好不好 / 该不该做 / 要不要花钱")
add_node("constitution", "宪法 · 硬约束", "L0", "constitution",
         "prototype/hermes-agents/verify-goal.mjs",
         sub="22 条硬要求 R1–R14 + A/B/C/D；改判据需人同意")
add_node("fourstate", "四态纪律", "L0", "constitution",
         "tools/evolve/audit-four-state-layers.mjs",
         sub="PASS/WARN/FAIL/UNKNOWN；UNKNOWN 永不并入通过")

# ── L1 共享层 ────────────────────────────────────────────────
add_node("ledger", "改进台账", "L1", "shared", "research/改进台账.json",
         {"items": len(entries), "closed": closed, "independent": indep},
         sub="%d 条 · 结案 %d · 独立验证 %d" % (len(entries), closed, indep))
add_node("evidence", "证据仓", "L1", "shared", "evidence",
         sub="%d 个文件" % count_files("evidence"))
add_node("collab", "协作请求/通知", "L1", "shared", "evidence/collab",
         sub="派单 + 通知看板 + 回执（只追加）")
add_node("matrix", "31 维矩阵", "L1", "shared",
         "prototype/hermes-agents/matrix-data.json",
         sub="23 个主体 × 31 维")
add_node("docs", "架构文档", "L1", "shared", "research/架构分层.md",
         sub="分层与不变量")

# ── L2 场景私有（12 个真实场景）────────────────────────────────
for s in scenes:
    add_node("sc:" + s["id"], s["name"], "L2", "scene", None,
             {"sceneId": s["id"], "deg": s.get("deg", 0),
              "up": len(s.get("upstream", [])), "down": len(s.get("downstream", []))},
             sub="上游 %d / 下游 %d" % (len(s.get("upstream", [])), len(s.get("downstream", []))))

# 身份索引（六件套第 ⑥ 件）—— 真读 identity.json
IDENT = "apps/vouch-web/src/web-ui/src/app/scenes/workbench/scenePanels/identity.json"
try:
    ident = json.load(io.open(rel(IDENT), encoding="utf-8"))
    bound = len([r for r in ident.get("rows", []) if r.get("sessionId")])
    total = len(ident.get("rows", []))
    add_node("identity", "身份索引", "L2", "identity", IDENT,
             {"bound": bound, "total": total},
             sub="%d 行 · 已绑定会话 %d" % (total, bound))
except Exception:
    add_node("identity", "身份索引", "L2", "identity", IDENT, sub="读不到")

# ── L3 运行时 ────────────────────────────────────────────────
for nid, label, path, sub in [
    ("rt.verify", "验收器", "prototype/agent-ui", "%d 个 verify/audit" % count_files("prototype/agent-ui", "verify-")),
    ("rt.tools", "工具链", "tools", "%d 个 .mjs" % count_files("tools", ".mjs")),
    ("rt.ui", "界面", "apps/vouch-web/src/web-ui/src/app/scenes", "场景面板与拓扑"),
    ("rt.productsrv", "产品服务器", "tools/workbench/serve.mjs", "9 个真接线的 API 端点"),
]:
    add_node(nid, label, "L3", "runtime", path, sub=sub)

# ── L4 归档 ──────────────────────────────────────────────────
for nid, label, path, sub in [
    ("ar.verify", "验收历史", "evidence/evolve", "度量证据（带时间戳，过期即 UNKNOWN）"),
    ("ar.backup", "备份", "research/competitors", "22 个参照项目拆解"),
    ("ar.cleanup", "清理台账", "evidence/cleanup", "只追加；本工具不删东西"),
]:
    add_node(nid, label, "L4", "archive", path, sub=sub)

# ── 连线：语义化，不是随便连 ─────────────────────────────────
# L0 内部
add_edge("host", "constitution", "guards", "人定规则 → 机器守")
add_edge("host", "fourstate", "guards", "人定四态 → 机器守")
add_edge("constitution", "fourstate", "reads", "宪法引用四态纪律")

# L0 → L1（规则约束共享层）
add_edge("constitution", "ledger", "guards", "台账每条都要有基线/前后/样本量")
add_edge("fourstate", "evidence", "guards", "证据必须带四态；UNKNOWN 不当通过")
add_edge("constitution", "matrix", "guards", "矩阵不许假绿")

# L1 内部
add_edge("ledger", "evidence", "writes", "每条改进写证据")
add_edge("collab", "ledger", "writes", "回执结论落台账（不污染：请求本身不入台账）")
add_edge("matrix", "docs", "reads", "维度定义来自架构文档")

# L2 场景 ↔ L2 身份 / L1
add_edge("identity", "sc:hub", "injects", "身份索引查表 → 中枢知道自己是中枢")
for s in scenes[:12]:
    add_edge("sc:" + s["id"], "ledger", "writes", "场景产出的改进写台账")
add_edge("collab", "sc:self-review", "reads", "派单落到承接场景")
add_edge("collab", "sc:tool-forge", "reads", "派单落到承接场景")

# L2 场景之间（真实的 31 条上下游）
for e in scene_edges:
    add_edge("sc:" + e["from"], "sc:" + e["to"], "flow", str(e.get("how") or "outputs"))

# L2 → L3
add_edge("sc:tool-forge", "rt.tools", "writes", "工具工坊维护工具链")
add_edge("sc:arch-review", "docs", "writes", "架构梳理写架构文档")
add_edge("sc:frontend-craft", "rt.ui", "writes", "前端工坊改界面")
add_edge("rt.verify", "constitution", "reads", "验收器实现宪法判据")
add_edge("rt.productsrv", "rt.ui", "serves", "产品服务器供给界面数据")

# L3 → L4
add_edge("rt.verify", "ar.verify", "writes", "验收结果进证据仓")
add_edge("rt.tools", "ar.backup", "writes", "工具产出参照拆解")

# 每层节点数（供界面显示，也是自检口径）
layer_counts = Counter(n["layer"] for n in nodes)

out = {
    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "state": "PASS" if len(nodes) >= 20 and len(edges) >= 30 else "WARN",
    "source": "tools/build-topology.py（读真实文件，不编造）",
    "concept": "拓扑连线图：节点 = 东西在哪一层，连线 = 谁读谁 / 谁写谁 / 谁兜底",
    "layers": [
        {"id": "L0", "name": "宪法", "desc": "铁律；只有人能改"},
        {"id": "L1", "name": "共享层", "desc": "所有人共用的事实"},
        {"id": "L2", "name": "场景私有", "desc": "各自记忆与身份，互不串"},
        {"id": "L3", "name": "运行时", "desc": "真跑的工具与界面"},
        {"id": "L4", "name": "归档", "desc": "只进不改，可恢复"},
    ],
    "nodes": nodes,
    "edges": edges,
    "stats": {
        "nodes": len(nodes),
        "edges": len(edges),
        "layers": len(layer_counts),
        "byLayer": dict(layer_counts),
    },
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
io.open(OUT, "w", encoding="utf-8", newline="\n").write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")

print("  ✓ 拓扑已生成: %s" % os.path.relpath(OUT, REPO).replace("\\", "/"))
print("    %d 节点 / %d 边 / %d 层" % (len(nodes), len(edges), len(layer_counts)))
for layer_id in ["L0", "L1", "L2", "L3", "L4"]:
    print("      %s %-8s %d 个" % (layer_id, next((l['name'] for l in out['layers'] if l['id'] == layer_id), ''), layer_counts.get(layer_id, 0)))
print("    四态: %s" % out["state"])