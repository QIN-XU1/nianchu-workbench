/**
 * 场景聚焦 —— 「首页·神经记忆元」双击节点 → 跳到「场景」页并选中那个场景。
 *
 * 为什么用模块级中转而不是 URL 参数：
 *   这两个是同一份前端里的两个场景标签，切场景走 sceneStore，不重新加载页面；
 *   用一个内存中转比改路由/写 localStorage 更直接，也不会在刷新后残留旧意图。
 *
 * 语义：
 *   · take() —— **一次性**读取（读取即清空），避免下次进「场景」页又跳回旧节点；
 *   · subscribe() —— 「场景」页已经开着时，双击仍然要能切过去，所以给一个订阅通道。
 */
type Listener = (sceneId: string) => void;

let pending: string | null = null;
const listeners = new Set<Listener>();

/** 首页双击节点时调用 */
export function setFocusScene(sceneId: string): void {
  pending = sceneId;
  // 「场景」页若已挂载，直接通知它切过去（不必等重新挂载）
  for (const fn of listeners) {
    try { fn(sceneId); } catch { /* 单个订阅者出错不影响其它 */ }
  }
}

/** 「场景」页挂载时调用；没有待跳转就返回 null */
export function takeFocusScene(): string | null {
  const v = pending;
  pending = null;
  return v;
}

/** 「场景」页订阅后续跳转请求；返回取消订阅函数 */
export function subscribeFocusScene(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 只看不取（调试/测试用） */
export function peekFocusScene(): string | null {
  return pending;
}
