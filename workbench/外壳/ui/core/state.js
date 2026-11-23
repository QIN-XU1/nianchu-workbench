// ui/core/state.js —— 全局状态容器
//
// 设计要点：
// 1) 不可变更新：set() 接受路径 + 值，内部用浅拷贝构造新树，旧引用不变（便于 diff / 快照）。
// 2) 订阅粒度：subscribe(path, fn) 只在「该路径及其子树」变化时触发；
//    subscribe('*', fn) 收全部。避免一处变更唤醒所有订阅者。
// 3) 批量更新：batch(fn) 期间只算脏路径，结束后一次性派发 —— 面板重排必备。
// 4) 防止递归：handler 内再 set() 不会死循环，但会排队到下一轮。

const SEG_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function splitPath(path) {
  if (Array.isArray(path)) return path.map(String);
  const s = String(path || '').trim();
  if (!s) return [];
  return s.split('.').map(function (p) { return p.trim(); }).filter(Boolean);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 沿路径浅拷贝，返回新根（不改动原对象） */
function setIn(root, segs, value) {
  if (!segs.length) return value;
  const key = segs[0];
  const rest = segs.slice(1);
  const base = isPlainObject(root) ? root : (Array.isArray(root) ? root : {});
  let child;
  if (Array.isArray(base)) {
    const idx = Number(key);
    child = base[idx] === undefined ? undefined : base[idx];
    const next = base.slice();
    next[idx] = rest.length ? setIn(child, rest, value) : value;
    return next;
  }
  child = base[key];
  const next = Object.assign({}, base);
  next[key] = rest.length ? setIn(child, rest, value) : value;
  return next;
}

function getIn(root, segs) {
  let cur = root;
  for (const k of segs) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** a 是否是 b 的前缀（'a' 是 'a.b' 的前缀）；相同也算 */
function isPrefix(a, b) {
  if (!a.length) return true;
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createState(initial) {
  let root = initial === undefined ? {} : initial;
  const subs = new Map(); // pathKey -> Set<fn>；pathKey '' 表示根
  let depth = 0;          // 批量嵌套深度
  const dirty = new Set(); // 批量期间累积的脏路径 key

  function keyOf(segs) { return segs.join('.'); }

  /** 通知一个订阅者：路径匹配才触发 */
  function notifyOne(subSegs, fn, changedSegs) {
    // 订阅 'a.b' 时：changed 'a.b.c'（子树变化）或 'a'（祖先换新）都应触发
    if (isPrefix(subSegs, changedSegs) || isPrefix(changedSegs, subSegs)) {
      try { fn(root, keyOf(changedSegs)); } catch (e) {
        if (typeof console !== 'undefined') console.error('[state] 订阅者失败:', e);
      }
      return true;
    }
    return false;
  }

  function dispatch(segs) {
    const k = keyOf(segs);
    let fired = 0;
    for (const [subKey, set] of subs) {
      for (const fn of set) {
        const subSegs = subKey ? subKey.split('.') : [];
        if (notifyOne(subSegs, fn, segs)) fired++;
      }
    }
    return fired;
  }

  const api = {
    get(path) {
      const segs = splitPath(path);
      return segs.length ? getIn(root, segs) : root;
    },

    /** 取快照（根引用，不可变语义下可直接持有） */
    snapshot() { return root; },

    set(path, value) {
      const segs = splitPath(path);
      if (!segs.length) {
        if (value === root) return 0;
        root = value;
        if (depth === 0) return dispatch([]);
        dirty.add('');
        return 0;
      }
      const prev = getIn(root, segs);
      if (prev === value) return 0;   // 引用相同 → 无变化
      root = setIn(root, segs, value);
      if (depth === 0) return dispatch(segs);
      dirty.add(keyOf(segs));
      return 0;
    },

    /** 函数式更新：updater(旧值) => 新值 */
    update(path, updater) {
      const prev = api.get(path);
      return api.set(path, updater(prev));
    },

    /** 合并对象到指定路径 */
    merge(path, patch) {
      const prev = api.get(path);
      const base = isPlainObject(prev) ? prev : {};
      return api.set(path, Object.assign({}, base, patch));
    },

    /** 数组 push（不可变） */
    push(path, ...items) {
      const prev = api.get(path);
      const arr = Array.isArray(prev) ? prev : [];
      return api.set(path, arr.concat(items));
    },

    /**
     * 订阅。path 支持：
     *   '*' 或 ''      → 任何变化
     *   'a.b'          → a.b 及其子树变化，或祖先换新
     * 返回 unsubscribe。
     */
    subscribe(path, fn) {
      if (typeof fn !== 'function') throw new TypeError('[state] 订阅者必须是函数');
      const segs = (path === '*' || path === '') ? [] : splitPath(path);
      const k = keyOf(segs);
      let set = subs.get(k);
      if (!set) { set = new Set(); subs.set(k, set); }
      set.add(fn);
      return function off() {
        const cur = subs.get(k);
        if (!cur) return;
        cur.delete(fn);
        if (!cur.size) subs.delete(k);
      };
    },

    /**
     * 批量更新：期间不派发，结束后对每个脏路径派发一次。
     * 嵌套调用只有最外层生效。
     */
    batch(fn) {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
        if (depth === 0 && dirty.size) {
          const pending = Array.from(dirty);
          dirty.clear();
          for (const k of pending) dispatch(k ? k.split('.') : []);
        }
      }
    },

    /** 用新快照整体替换（服务端同步 / 回滚用），派发根变化 */
    replace(next) {
      if (next === root) return 0;
      root = next;
      if (depth === 0) return dispatch([]);
      dirty.add('');
      return 0;
    },

    subscriberCount() {
      let n = 0;
      for (const set of subs.values()) n += set.size;
      return n;
    },
    paths() { return [...subs.keys()].filter(Boolean); },
    clearSubscribers() { subs.clear(); },
  };

  return api;
}

/** 常用状态片段（作文档 / 防拼写错误） */
export const STATE_PATHS = Object.freeze({
  BOOT: 'boot',
  SCENES: 'scenes',
  SCENE_ACTIVE: 'scene.active',
  SCENE_LAYOUT: 'scene.layout',
  MAIN_AGENT: 'mainAgent',
  NEURON: 'neuron',
  ENGINE: 'engine',
  UI: 'ui',
  FAULT: 'fault',
});

export { splitPath, getIn, setIn, isPlainObject };
