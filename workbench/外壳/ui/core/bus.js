// ui/core/bus.js —— 事件总线（命名空间 + 自动解绑）
//
// 设计要点：
// 1) 所有 on() 都返回 unsubscribe；调用方要么自己调用，要么交给 scope 托管。
// 2) scope(name) 是一个「订阅组」：组内订阅在 dispose() 时一次性清空 —— 这是防内存
//    泄漏的唯一出口，面板卸载 / 场景切换必须先 dispose 自己的 scope。
// 3) 支持通配：'*' 匹配全部，'panel:*' 匹配前缀（调试/日志用）。
// 4) 单个 handler 抛错不影响其他 handler（错误交给 onError，缺省打 console）。
// 5) emit 前先快照监听表：handler 内部增删订阅不会打乱本次派发。

const STAR = 42; // '*'.charCodeAt(0)

export function createBus({ onError } = {}) {
  const table = new Map(); // pattern -> Set<{ fn, once }>
  let muted = false;

  function report(err, type) {
    if (typeof onError === 'function') {
      try { onError(err, type); return; } catch (_) { /* 落到 console */ }
    }
    if (typeof console !== 'undefined') console.error('[bus] 监听器执行失败：' + type, err);
  }

  function matches(pattern, type) {
    if (pattern === '*') return true;
    if (pattern.charCodeAt(pattern.length - 1) === STAR) return type.startsWith(pattern.slice(0, -1));
    return pattern === type;
  }

  function subscribe(pattern, fn, once) {
    if (typeof fn !== 'function') throw new TypeError('[bus] 监听器必须是函数');
    let set = table.get(pattern);
    if (!set) { set = new Set(); table.set(pattern, set); }
    const entry = { fn, once };
    set.add(entry);
    return function off() {
      const current = table.get(pattern);
      if (!current) return;
      current.delete(entry);
      if (!current.size) table.delete(pattern);
    };
  }

  function emit(type, payload) {
    if (muted) return 0;
    const hits = [];
    for (const [pattern, set] of table) {
      if (!matches(pattern, type)) continue;
      for (const entry of set) hits.push([pattern, entry]);
    }
    for (const [pattern, entry] of hits) {
      if (entry.once) {
        const set = table.get(pattern);
        if (set) { set.delete(entry); if (!set.size) table.delete(pattern); }
      }
      try { entry.fn(payload, type); } catch (err) { report(err, type); }
    }
    return hits.length;
  }

  const bus = {
    on: (pattern, fn) => subscribe(pattern, fn, false),
    once: (pattern, fn) => subscribe(pattern, fn, true),
    emit,
    /** 瞬时静音（用于测试 / 批量重排），返回恢复函数 */
    mute() { muted = true; return () => { muted = false; }; },
    /** 精确 pattern 的监听数；不传则返回全局监听数 */
    listenerCount(pattern) {
      if (pattern == null) {
        let total = 0;
        for (const set of table.values()) total += set.size;
        return total;
      }
      const set = table.get(pattern);
      return set ? set.size : 0;
    },
    patterns: () => [...table.keys()],
    clear() { table.clear(); },

    /**
     * 订阅组：面板 / 场景 / 单次交互都建议各持一个。
     * scope.on() 默认不加前缀（可订阅全局事件）；prefix:true 时自动加 'name:' 前缀。
     */
    scope(name) {
      const disposers = new Set();
      let closed = false;
      const prefix = name ? name + ':' : '';

      const track = (off) => {
        if (closed) { off(); return () => {}; }
        disposers.add(off);
        return () => { disposers.delete(off); off(); };
      };

      return {
        name,
        isClosed: () => closed,
        on(pattern, fn, { prefixed = false } = {}) {
          const target = prefixed ? prefix + pattern : pattern;
          return track(subscribe(target, fn, false));
        },
        once(pattern, fn, { prefixed = false } = {}) {
          const target = prefixed ? prefix + pattern : pattern;
          return track(subscribe(target, fn, true));
        },
        emit(type, payload) { return emit(prefix + type, payload); },
        /** 把外部返回的 unsubscribe（例如 api.on）也纳管，卸载时统一清理 */
        use(off) { return typeof off === 'function' ? track(off) : () => {}; },
        dispose() {
          closed = true;
          for (const off of disposers) { try { off(); } catch (_) { /* 忽略 */ } }
          disposers.clear();
        },
        get size() { return disposers.size; },
      };
    },
  };

  return bus;
}

/** 常用事件名（仅作文档/防拼写错误，总线本身不做校验） */
export const EVENTS = Object.freeze({
  APP_READY: 'app:ready',
  APP_ERROR: 'app:error',
  SHELL_READY: 'shell:ready',
  SCENE_CHANGE: 'scene:change',
  PANEL_MOUNT: 'panel:mount',
  PANEL_UPDATE: 'panel:update',
  PANEL_UNMOUNT: 'panel:unmount',
  COMMAND_RUN: 'command:run',
  COMMAND_UNDO: 'command:undo',
  API_WARN: 'api:warn',
});
