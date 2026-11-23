/**
 * 外观状态（明暗 / 密度）
 *
 * 为什么不放在 App 的 useState 里：
 *   「设置」场景也要改这两个值，跨组件共享。用一个极小的模块 + 订阅，
 *   比引状态库轻，也比 context 好测。
 */
export type Scheme = 'light' | 'dark';
export type Density = 'compact' | 'cozy';

const LS_SCHEME = 'vouch.appearance.scheme';
const LS_DENSITY = 'vouch.appearance.density';

function fromUrl(key: string): string | null {
  try {
    return new URLSearchParams(location.search).get(key);
  } catch {
    return null;
  }
}

export function getScheme(): Scheme {
  const u = fromUrl('scheme');
  if (u === 'light' || u === 'dark') return u;
  const saved = localStorage.getItem(LS_SCHEME);
  return saved === 'dark' ? 'dark' : 'light';
}

export function getDensity(): Density {
  const u = fromUrl('density');
  if (u === 'compact' || u === 'cozy') return u;
  const saved = localStorage.getItem(LS_DENSITY);
  return saved === 'cozy' ? 'cozy' : 'compact';
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeAppearance(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn();
}

function apply() {
  const root = document.documentElement;
  root.setAttribute('data-color-scheme', getScheme());
  root.setAttribute('data-density', getDensity());
}

export function setScheme(v: Scheme): void {
  localStorage.setItem(LS_SCHEME, v);
  apply();
  emit();
}

export function setDensity(v: Density): void {
  localStorage.setItem(LS_DENSITY, v);
  apply();
  emit();
}

/** 首次调用时把属性刷到 html 上 */
export function initAppearance(): void {
  apply();
}
