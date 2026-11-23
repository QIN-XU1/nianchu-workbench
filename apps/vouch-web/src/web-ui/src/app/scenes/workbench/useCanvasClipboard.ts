/**
 * 画布节点复制/粘贴 —— **架构搬自 Toonflow nodeClipboard.ts**
 *
 * 出处：D:/refs/Toonflow-app/apps/web/src/pages/workspace/panels/canvas/nodeClipboard.ts
 * 照搬的部分：
 *   :4   命令令牌正则（`<prefix>:paste-node:<uuid>`）
 *   :12-19 IndexedDB 存快照（只保留最近一次；旧命令失效，不累计历史）
 *   :20-38 读写封装（一次事务，写用 put('latest')，读用 get('latest')）
 *   :48-63 复制时**移除运行态字段**，只保留内部边（source/target 都在集合里）
 *   :65-99 粘贴时逐项校验：id 唯一、type 非空、position 有限、边两端都在集合内、无环
 *   :100-105 跨项目引用工作区文件时拒绝（我们没有工作区文件，此条简化为「目录不同则拒绝」）
 *
 * 为什么用「系统剪贴板写令牌」而不是直接写 JSON：
 * 系统剪贴板可能被别的应用占用/超长截断；写一个小令牌 + IndexedDB 存真数据更稳，
 * 而且能做到「旧命令自动失效」——粘两次不会粘出两份。
 */
import { useCallback } from 'react';

const DB_NAME = 'nianchu.nodeClipboard';
const STORE = 'nodes';
const KEY = 'latest';
const CMD_RE = /^nianchu:paste-node:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 搬自 :48-63 —— 这些字段属于运行态，不进快照 */
const NODE_RUNTIME = ['computedPosition', 'handleBounds', 'selected', 'dimensions', 'resizing', 'dragging', 'width', 'height', 'measured'];
const EDGE_RUNTIME = ['selected', 'sourceNode', 'targetNode', 'sourceX', 'sourceY', 'targetX', 'targetY'];

type AnyNode = { id: string; type?: string; position?: { x: number; y: number }; data?: Record<string, unknown>; [k: string]: unknown };
type AnyEdge = { id: string; source: string; target: string; [k: string]: unknown };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 搬自 :20-38 —— 一次事务读写，只保留 latest */
async function accessClipboard(entry?: unknown): Promise<unknown> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, entry ? 'readwrite' : 'readonly');
      const store = tx.objectStore(STORE);
      const req = entry ? store.put(entry, KEY) : store.get(KEY);
      tx.oncomplete = () => resolve(entry ?? req.result);
      tx.onabort = () => reject(tx.error ?? new Error('节点剪贴数据读写失败'));
    });
  } finally {
    db.close();
  }
}

const pick = (obj: Record<string, unknown>, drop: string[]) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !drop.includes(k)));

/**
 * 内存兜底令牌 —— Toonflow 完全依赖系统剪贴板；我们加这一层是因为：
 * 浏览器在「非真实用户手势」或未授权时 navigator.clipboard 会失败，
 * 那样同页粘贴也会失效。有了它，同页复制粘贴永远可用；
 * 跨标签页仍走系统剪贴板（令牌能传过去就传过去）。
 */
let memoryToken = '';

export function useCanvasClipboard(
  // 用宽松类型接收调用方的节点/边（它们的 TS 类型各不相同），内部再按需断言
  getState: () => { nodes: readonly unknown[]; edges: readonly unknown[] },
  applyPaste: (nodes: unknown[], edges: unknown[]) => void,
) {
  const asNodes = (v: readonly unknown[]) => v as AnyNode[];
  const asEdges = (v: readonly unknown[]) => v as AnyEdge[];
  /** 搬自 :48-63 */
  const copy = useCallback(async (selectedIds?: string[]) => {
    const { nodes: rawNodes, edges: rawEdges } = getState();
    const nodes = asNodes(rawNodes);
    const edges = asEdges(rawEdges);
    const picked = selectedIds && selectedIds.length ? nodes.filter((n) => selectedIds.includes(n.id)) : nodes;
    if (!picked.length) throw new Error('没有可复制的节点');
    if (picked.some((n) => !n.type)) throw new Error('节点类型无效');

    const ids = new Set(picked.map((n) => n.id));
    const command = 'nianchu:paste-node:' + crypto.randomUUID();
    const snapshot = JSON.parse(JSON.stringify({
      nodes: picked.map((n) => pick(n, NODE_RUNTIME)),
      // 只保留两端都在集合里的内部边
      edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => pick(e, EDGE_RUNTIME)),
    }));

    await accessClipboard({ command, ...snapshot });
    memoryToken = command;   // 内存兜底：同页粘贴不依赖系统剪贴板
    let clipboardOk = false;
    try {
      await navigator.clipboard.writeText(command);
      clipboardOk = true;
    } catch { /* 系统剪贴板不可用，靠 memoryToken */ }
    return { command, nodes: snapshot.nodes.length, edges: snapshot.edges.length, clipboardOk };
  }, [getState]);

  /** 搬自 :65-99 —— 逐项校验 + 重映射 id + 偏移位置 */
  const paste = useCallback(async (offset = 32) => {
    let token = '';
    try { token = (await navigator.clipboard.readText()).trim(); } catch { token = ''; }
    // 系统剪贴板不可用（或内容不是我们的令牌）时，退回内存令牌
    if (!CMD_RE.test(token)) token = memoryToken;
    if (!CMD_RE.test(token)) throw new Error('剪贴板里没有可粘贴的节点');

    const entry = await accessClipboard() as { command?: string; nodes?: AnyNode[]; edges?: AnyEdge[] } | undefined;
    if (!entry || entry.command !== token) throw new Error('节点剪贴数据已失效，请重新复制');

    const nodes = entry.nodes ?? [];
    const edges = entry.edges ?? [];
    if (!Array.isArray(nodes) || !nodes.length) throw new Error('节点剪贴数据格式错误，请重新复制');

    const ids = new Set(nodes.map((n) => n.id));
    if (ids.size !== nodes.length) throw new Error('节点剪贴数据格式错误：id 重复');
    for (const n of nodes) {
      if (typeof n.id !== 'string' || !n.id) throw new Error('节点剪贴数据格式错误：id 无效');
      if (typeof n.type !== 'string' || !n.type) throw new Error('节点剪贴数据格式错误：type 无效');
      if (!n.position || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y)) {
        throw new Error('节点剪贴数据格式错误：position 无效');
      }
      if (!n.data || typeof n.data !== 'object' || Array.isArray(n.data)) {
        throw new Error('节点剪贴数据格式错误：data 无效');
      }
    }
    for (const e of edges) {
      if (!e || typeof e.id !== 'string' || !e.id) throw new Error('节点剪贴数据格式错误：边 id 无效');
      if (!ids.has(e.source) || !ids.has(e.target)) throw new Error('节点剪贴数据格式错误：边指向集合外的节点');
    }
    if (new Set(edges.map((e) => e.id)).size !== edges.length) throw new Error('节点剪贴数据格式错误：边 id 重复');

    // 搬自 :90-99 —— 环检测（父子关系；我们暂无 parentNode，保留逻辑以防将来引入）
    const parents = new Map(nodes.map((n) => [n.id, (n as { parentNode?: string }).parentNode]));
    const checked = new Set<string>();
    for (const n of nodes) {
      const path = new Set<string>();
      let id: string | undefined = n.id;
      while (id && !checked.has(id)) {
        if (path.has(id)) throw new Error('节点剪贴数据格式错误：存在环');
        path.add(id);
        id = parents.get(id);
      }
      for (const x of path) checked.add(x);
    }

    // 重映射 id（避免与原节点冲突）+ 整体偏移
    const map = new Map<string, string>();
    const newNodes = nodes.map((n) => {
      const nid = n.id + '__paste__' + crypto.randomUUID().slice(0, 8);
      map.set(n.id, nid);
      return { ...n, id: nid, position: { x: n.position!.x + offset, y: n.position!.y + offset } };
    });
    const newEdges = edges.map((e) => ({
      ...e,
      id: e.id + '__paste__' + crypto.randomUUID().slice(0, 8),
      source: map.get(e.source)!,
      target: map.get(e.target)!,
    }));

    applyPaste(newNodes as AnyNode[], newEdges as AnyEdge[]);
    return { nodes: newNodes.length, edges: newEdges.length };
  }, [applyPaste]);

  return { copy, paste };
}
