import { useEffect, useRef, useState } from 'react';
import React from 'react';
import './RemotePanels.scss';

/**
 * UI 插件宿主（运行时加载，**不参与构建**）
 *
 * ══ 为什么要有这个 ═══════════════════════════════════════════
 * 参照 D:/refs/luanyujia-fresh/07-顶栏与菜单栏/README.md:13-15：
 * 「外壳侧改一次要重启…所以把手感类的东西全放到热更新侧 —— 调手感不用重启。
 *   这是这套壳里最值得抄的一个架构决定」。
 *
 * 我们的问题更重：生产态 UI 是整体构建产物（实测 46.72s），改一行文案也要重建 + 重启。
 * 这里开一条旁路：从 `/ui-plugins/**` 直接读磁盘上的浏览器 ESM，
 * 用带 mtime 的动态 import 加载 —— 改文件刷新即生效。
 *
 * ══ 契约 ═════════════════════════════════════════════════════
 *   export function mount(root: HTMLElement, ctx: { React }) → unmount?: () => void
 *   也支持 default export 是 mount 函数。
 *
 * ══ 健壮性 ═══════════════════════════════════════════════════
 * 插件加载失败**不能**拖垮面板：单个插件失败只记在状态里，其它继续；
 * 全部失败就渲染空（不显示错误框，避免噪音）。但失败原因保留，便于排障。
 */
type PluginMeta = {
  id: string;
  name: string;
  slot?: string;
  order?: number;
  entryUrl: string;
  entryMtime?: number;
};

type PluginState = { id: string; ok: boolean; error?: string };

export default function RemotePanels({ slot = 'agent-bar' }: { slot?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [plugins, setPlugins] = useState<PluginMeta[]>([]);
  const [states, setStates] = useState<PluginState[]>([]);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      let list: PluginMeta[] = [];
      try {
        const r = await fetch('/ui-plugins/index.json', { cache: 'no-store' });
        const j = await r.json();
        list = Array.isArray(j.plugins) ? j.plugins : [];
      } catch {
        list = []; // 没有通道就静默降级
      }
      if (disposed) return;
      const mine = list.filter((p) => (p.slot || 'agent-bar') === slot);
      setPlugins(mine);

      const st: PluginState[] = [];
      for (const p of mine) {
        // 关键：把 mtime 拼进 URL。改文件 → mtime 变 → URL 变 → 不会命中旧缓存。
        const url = p.entryUrl + (p.entryMtime ? '?v=' + p.entryMtime : '?v=' + Date.now());
        try {
          const mod = await import(/* @vite-ignore */ url);
          const mountFn = mod.mount || mod.default;
          if (typeof mountFn !== 'function') {
            st.push({ id: p.id, ok: false, error: '插件没有导出 mount 函数' });
            continue;
          }
          const holder = document.createElement('div');
          holder.setAttribute('data-ui-plugin-holder', p.id);
          hostRef.current?.appendChild(holder);
          const unmount = await mountFn(holder, { React });
          if (typeof unmount === 'function') {
            cleanups.push(() => {
              try { unmount(); } catch { /* ignore */ }
              holder.remove();
            });
          } else {
            cleanups.push(() => holder.remove());
          }
          st.push({ id: p.id, ok: true });
        } catch (e) {
          st.push({ id: p.id, ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 160) });
        }
      }
      if (!disposed) setStates(st);
    })();

    return () => {
      disposed = true;
      for (const c of cleanups) c();
    };
  }, [slot]);

  // 没有插件就什么都不渲染（不占位、不显示空框）
  if (plugins.length === 0) return null;

  const failed = states.filter((s) => !s.ok);
  return (
    <div className="rp" data-ui-plugin-slot={slot}>
      <div className="rp__host" ref={hostRef} />
      {failed.length > 0 && (
        <div className="rp__err" title={failed.map((f) => f.id + ': ' + f.error).join('\n')}>
          {failed.length} 个插件加载失败
        </div>
      )}
    </div>
  );
}