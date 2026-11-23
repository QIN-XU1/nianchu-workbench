import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_OPEN, DEFAULT_SCENE, isSceneId, type SceneId } from '../scenes/registry';

const LS_OPEN = 'vouch.scenes.open';
const LS_ACTIVE = 'vouch.scenes.active';

function readOpen(): SceneId[] {
  try {
    const raw = localStorage.getItem(LS_OPEN);
    if (!raw) return [...DEFAULT_OPEN];
    const arr = JSON.parse(raw);
    const ok = Array.isArray(arr) ? arr.filter((v) => typeof v === 'string' && isSceneId(v)) : [];
    // 常驻场景必须一直在
    for (const id of DEFAULT_OPEN) if (!ok.includes(id)) ok.push(id);
    return ok.length ? ok : [...DEFAULT_OPEN];
  } catch {
    return [...DEFAULT_OPEN];
  }
}

function readHash(): SceneId | null {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return h && isSceneId(h) ? h : null;
}

/**
 * 场景路由。
 * 不变量（验收会断言）：
 *   · 常驻场景（DEFAULT_OPEN）永远在 open 列表里，关不掉
 *   · active 一定在 open 列表里
 *   · 注册表里的每个 id 都能被打开
 *   · 刷新后 active 与 open 都保持
 */
export function useSceneRoute() {
  const [open, setOpen] = useState<SceneId[]>(() => readOpen());
  const [active, setActive] = useState<SceneId>(() => {
    const fromHash = readHash();
    if (fromHash) return fromHash;
    const saved = localStorage.getItem(LS_ACTIVE);
    return saved && isSceneId(saved) ? saved : DEFAULT_SCENE;
  });

  useEffect(() => {
    localStorage.setItem(LS_OPEN, JSON.stringify(open));
    localStorage.setItem(LS_ACTIVE, active);
    if (readHash() !== active) location.hash = '/' + active;
  }, [open, active]);

  useEffect(() => {
    const onHash = () => {
      const id = readHash();
      if (id) {
        setActive(id);
        setOpen((prev) => (prev.includes(id) ? prev : [...prev, id]));
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openScene = useCallback((id: SceneId) => {
    setOpen((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActive(id);
  }, []);

  const closeScene = useCallback((id: SceneId) => {
    if (DEFAULT_OPEN.includes(id)) return; // 常驻场景不可关闭
    setOpen((prev) => {
      const next = prev.filter((x) => x !== id);
      setActive((cur) => (cur === id ? (next[next.length - 1] ?? DEFAULT_SCENE) : cur));
      return next.length ? next : [...DEFAULT_OPEN];
    });
  }, []);

  return { open, active, openScene, closeScene };
}
