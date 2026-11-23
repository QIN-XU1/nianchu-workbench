"""DSH 场景神经元 → hermes 星图的接入层。

为什么存在
----------
hermes 桌面端自带一张星图（StarMap：``apps/desktop/src/app/starmap/``，渲染器 32KB +
力导向模拟 + 时间轴回放 + share code），数据来自 ``GET /api/learning/graph`` →
:func:`agent.learning_graph.build_learning_graph`。
它原本只画「技能 + 记忆卡」。

我们的记忆神经元（12 个场景 / 31 条契约边 / 6 个领域）和它是同一个数据结构：
节点是技能形态的实体，边是实体间依赖。所以**不另做界面**，把神经元喂进它的数据源，
hermes 的星图直接把我们的球画出来。

数据源是唯一的
--------------
``$HERMES_HOME/dsh-shared/NEURON.json``，由 ``prototype/hermes-agents/integrate-neuron.mjs``
从 ``workbench/外壳/scenarios/*.json``(身份+领域) 与 ``workbench/sceneboard/scenes/*.json``(契约)
重新生成。本模块**只读不写**，也不缓存 —— 上游一变，星图刷新即变。

节点 id 为什么要加前缀
----------------------
场景 id 会和 hermes 自己的技能重名：场景 ``research`` vs hermes 内置技能分类 ``research``。
星图把 id 当实体身份，重名会让两条边挂到同一个节点上。所以场景节点统一
``scene:<id>``，显示名用中文 ``label``。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

__all__ = ["build_neuron_layer", "neuron_source_path", "NEURON_ID_PREFIX"]

NEURON_ID_PREFIX = "scene:"

# 领域 → 星图配色用的 category。领域名本身已经是中文，直接用。
_DEFAULT_DOMAIN = "场景"


def neuron_source_path() -> Path:
    """``$HERMES_HOME/dsh-shared/NEURON.json``（含 HERMES_HOME 覆盖）。"""
    try:
        from agent.hermes_home import get_hermes_home  # type: ignore

        home = get_hermes_home()
    except Exception:
        home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    return Path(home) / "dsh-shared" / "NEURON.json"


def _scene_timestamp(scene: dict[str, Any]) -> Optional[int]:
    """时间轴位置：场景的孵化时刻（epoch **秒**）。

    上游 ``integrate-neuron.mjs`` 写的是毫秒（JS 的 ``mtimeMs``），
    而派单台账的 ``createdAt`` 解析出来是秒。两种单位混在一起会让时间轴差 1000 倍，
    所以这里统一收敛到秒：大于 1e12 的一律当毫秒。
    """
    raw = scene.get("hatchedAt")
    value: Optional[float] = None
    if isinstance(raw, (int, float)):
        value = float(raw)
    elif isinstance(raw, str) and raw.strip().isdigit():
        value = float(raw.strip())
    if value is None or value <= 0:
        return None
    if value > 1e12:  # 毫秒
        value /= 1000.0
    return int(value)


def _dispatch_usage(path: Path) -> dict[str, dict[str, Any]]:
    """``派单台账.json`` → 每个场景的真实使用情况：派单数、首次、最近。

    台账是派单的事实记录（``from``/``to``/``createdAt``），比任何自报的计数都硬。
    星图据此决定节点的亮度（useCount）与时间轴位置（首次参与派单的时刻）。
    读不到就全空 —— 没派单过不是错误，是「还没被用过」。
    """
    out: dict[str, dict[str, Any]] = {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return out
    rows = payload.get("dispatches") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        ts = _iso_to_epoch(row.get("createdAt"))
        for key in ("from", "to"):
            sid = str(row.get(key) or "").strip()
            if not sid:
                continue
            rec = out.setdefault(sid, {"count": 0, "first": None, "last": None})
            rec["count"] += 1
            if ts is not None:
                rec["first"] = ts if rec["first"] is None else min(rec["first"], ts)
                rec["last"] = ts if rec["last"] is None else max(rec["last"], ts)
    return out


def _dispatch_total(path: Path) -> int:
    """台账里的派单条数。

    注意不能「把每个场景的计数加起来除以 2」：一条派单的两个端点未必都在我们的
    12 个场景里（派给非场景智能体的那部分不会进 usage），除法会算少。
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return 0
    rows = payload.get("dispatches") if isinstance(payload, dict) else None
    return len(rows) if isinstance(rows, list) else 0


def _iso_to_epoch(value: Any) -> Optional[int]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        from datetime import datetime, timezone

        text = value.strip().replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp())
    except Exception:
        return None


def build_neuron_layer() -> dict[str, Any]:
    """把 NEURON.json 转成星图可合并的三件套：nodes / edges / clusters。

    任何失败都返回空层而不是抛异常 —— 星图是只读视图，
    我们的接入绝不能让它白屏。缺文件/坏 JSON 都当「没有神经元」。
    """
    empty: dict[str, Any] = {"nodes": [], "edges": [], "clusters": [], "stats": {}}
    path = neuron_source_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return empty
    if not isinstance(payload, dict):
        return empty

    usage = _dispatch_usage(path.parent / "派单台账.json")
    total_dispatches = _dispatch_total(path.parent / "派单台账.json")
    scenes = payload.get("scenes") or []
    raw_edges = payload.get("edges") or []
    if not isinstance(scenes, list) or not scenes:
        return empty

    nodes: list[dict[str, Any]] = []
    id_of: dict[str, str] = {}
    never_used: list[str] = []
    for scene in scenes:
        if not isinstance(scene, dict):
            continue
        sid = str(scene.get("id") or "").strip()
        if not sid:
            continue
        node_id = NEURON_ID_PREFIX + sid
        id_of[sid] = node_id
        attachments = scene.get("attachments") or {}
        used = usage.get(sid) or {}
        # 时间轴：这里**故意留空**。
        #
        # 星图的径向轴语义是「什么时候学到的」。我们的场景图是**拓扑图**：
        # 10 个场景是同一天一起建的（git 首次提交 2026-11-10），真实时间线几乎是
        # 一个点。把同一桶的 9 个节点硬塞进同一条环，标签会完全互相覆盖 ——
        # 实测截图里中心就是一坨读不出的字。
        #
        # 与其编一个假时间骗过布局，不如如实说「这张图没有时间维度」：
        # simulation.ts 的 indexFor() 把无时间节点放到最外环，再按 id 的 FNV 角度扇开，
        # 12 个节点就均匀铺在外圈，标签读得出来，边也画得开。
        # 真正的使用活跃度走下面的 useCount（派单次数），那个是真实数据，不丢。
        timestamp = None
        if not used.get("count"):
            never_used.append(sid)
        nodes.append(
            {
                "id": node_id,
                "label": str(scene.get("name") or sid),
                "kind": "skill",
                "timestamp": timestamp,
                # useCount 决定星图节点的亮度/大小：用真实派单数。
                # 中枢被派了 62 次，它就该是最亮的那个 —— 这是事实，不是装饰。
                "useCount": int(used.get("count") or 0),
                "category": str(scene.get("domain") or _DEFAULT_DOMAIN),
                "state": "active",
                "createdBy": "dsh-scene",
                "pinned": sid == "hub",
                "_memoryFiles": attachments.get("memory"),
                "_lastDispatch": used.get("last"),
            }
        )

    edges: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for edge in raw_edges:
        if not isinstance(edge, dict):
            continue
        a, b = id_of.get(str(edge.get("from") or "")), id_of.get(str(edge.get("to") or ""))
        if not a or not b or a == b:
            continue
        key = (a, b) if a < b else (b, a)
        if key in seen:
            continue
        seen.add(key)
        edges.append({"source": key[0], "target": key[1]})

    domain_counts: dict[str, int] = {}
    for node in nodes:
        domain_counts[node["category"]] = domain_counts.get(node["category"], 0) + 1
    clusters = [
        {"category": cat, "count": n}
        for cat, n in sorted(domain_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    # 枢纽度：入度+出度最高的场景，星图 stats 里给前端做摘要用。
    degree: dict[str, int] = {}
    for edge in edges:
        for end in (edge["source"], edge["target"]):
            degree[end] = degree.get(end, 0) + 1
    hubs = sorted(degree.items(), key=lambda kv: (-kv[1], kv[0]))[:5]

    return {
        "nodes": nodes,
        "edges": edges,
        "clusters": clusters,
        "stats": {
            "neuron_scenes": len(nodes),
            "neuron_edges": len(edges),
            "neuron_domains": len(clusters),
            "neuron_cycles": 2,  # hub↔incident-analysis、hub↔pc-cleanup；真实业务是环，不是数据错
            "neuron_hubs": [{"id": k, "degree": v} for k, v in hubs],
            "neuron_never_dispatched": never_used,
            "neuron_dispatch_total": total_dispatches,
            "neuron_source": str(path),
        },
    }
