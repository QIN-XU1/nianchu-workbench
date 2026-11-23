// ui/api/index.js —— window.app.* 的统一封装
//
// 设计要点：
// 1) 统一 Promise 化 + 超时 + 错误归一（{ ok, value, error, code }）
// 2) 主进程 IPC 可能返回 undefined（handler 未设）→ 归一为明确错误，便于 UI 显示降级态
// 3) 分组暴露，与 preload 的 44 个 API 一对一映射，不丢功能
// 4) 每个调用都记录耗时（性能排查用）
//
// ⚠ 契约来源：workbench/外壳/preload.js（不要改签名）

const DEFAULT_TIMEOUT = 30000;

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** 归一错误：把各种异常转成 { code, message } */
function normError(e) {
  if (!e) return { code: 'unknown', message: '未知错误' };
  if (typeof e === 'string') return { code: 'error', message: e };
  const msg = e.message || String(e);
  // Electron IPC 抛错常带 "Error invoking remote method 'x': Error: ..."
  const m = msg.match(/invoking remote method '([^']+)':\s*(?:Error:\s*)?([\s\S]*)/);
  if (m) return { code: m[1], message: m[2].trim() };
  return { code: e.code || 'error', message: msg };
}

/**
 * 包装一个异步调用
 * @param {Function} fn      实际执行函数
 * @param {string}   label   API 名称（日志/错误定位用）
 * @param {number}   timeout
 */
function wrap(fn, label, timeout) {
  return async function (...args) {
    const t0 = nowMs();
    const ms = timeout || DEFAULT_TIMEOUT;
    try {
      const raw = await Promise.race([
        fn(...args),
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('timeout:' + label)); }, ms);
        }),
      ]);
      const dt = Math.round((nowMs() - t0) * 10) / 10;
      if (dt > 2000) {
        if (typeof console !== 'undefined') console.warn('[api] ' + label + ' 耗时 ' + dt + 'ms');
      }
      // 主进程 handler 缺失时 Electron 返回 undefined
      if (raw === undefined) {
        return { ok: false, value: undefined, error: { code: 'no-handler', message: label + ' 无响应（handler 可能未注册）' }, ms: dt };
      }
      return { ok: true, value: raw, error: null, ms: dt };
    } catch (e) {
      const dt = Math.round((nowMs() - t0) * 10) / 10;
      return { ok: false, value: undefined, error: normError(e), ms: dt };
    }
  };
}

/** 取组件：找不到时返回 undefined 而不是抛错（便于降级） */
function pick(name) {
  const app = (typeof window !== 'undefined' && window.app) || {};
  return app[name];
}

/** 深度包装一个对象的所有函数成员 */
function wrapNamespace(obj, prefix, timeout) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'function') {
      out[key] = wrap(v.bind(obj), prefix + '.' + key, timeout);
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const sub = wrapNamespace(v, prefix + '.' + key, timeout);
      if (sub) out[key] = sub;
    }
  }
  return out;
}

/** 创建 API 门面 */
export function createApi() {
  const app = (typeof window !== 'undefined' && window.app) || {};
  const out = {
    /** 是否运行在 Electron 里（false = 浏览器 demo） */
    isElectron: !!app.dataDir || !!app.listScenarios,
    raw: app,
  };

  // ═══ 同步常量（preload 里是值不是函数）═══
  // paths: { dataDir, reviewDir, bootCfg, memRoot, skillDir, projectRoots }
  if (app.paths && typeof app.paths === 'object') {
    out.paths = Object.assign({}, app.paths);
  } else {
    out.paths = {};
  }
  // 兼容旧 renderer 的散装字段（dataDir / reviewDir 直接挂在 window.app 上）
  out.dataDirRaw = app.dataDir || (out.paths.dataDir || '');
  out.reviewDirRaw = app.reviewDir || (out.paths.reviewDir || '');
  out.bootCfg = app.bootCfg || (out.paths.bootCfg || '');
  out.memRoot = app.memRoot || (out.paths.memRoot || '');
  out.skillDir = app.skillDir || (out.paths.skillDir || '');

  // ═══ 简单函数 API（直接包装）═══
  const FN = [
    'getHarnessUrl', 'isHarnessReady', 'getVersion',
    'caps', 'setSceneOrder', 'getSceneOrder', 'injectHarnessPanel',
    'listScenarios', 'getScenario', 'settings', 'setAlwaysOnTop',
    'pickFolder', 'pickFile', 'webaiWarmConfig',
    // 窗口控制（之前漏了）
    'minimize', 'toggleMaximize', 'isMaximized', 'close',
    // 工具清单（95 个工具）
    'toolsCatalog',
    // 【2026-11-17 加】任务分派面板（漏了会静默 undefined，同 pc 命名空间的教训）
    'dispatchRead',
  ];
  for (const name of FN) {
    const fn = app[name];
    if (typeof fn !== 'function') continue;
    // on* 是订阅（同步返回 unsub），不套超时
    if (name.startsWith('on')) {
      out[name] = fn.bind(app);
    } else {
      out[name] = wrap(fn.bind(app), name);
    }
  }

  // ═══ 订阅型 API（同步返回 unsubscribe）═══
  for (const name of ['onFault', 'onHarnessReady', 'onBootProgress']) {
    const fn = app[name];
    if (typeof fn === 'function') out[name] = fn.bind(app);
  }

  // ═══ 命名空间 API ═══
  //
  // ⚠ 2026-11-11 加 'pc'（事故 AC-018）：
  //   preload 暴露了 app.pc = { drives, toplarge, junk, ledger }，
  //   但这里没把它列进白名单 → api.pc 是 undefined →
  //   本地电脑场景的 4 个面板全部显示「接口未返回数据」。
  //
  //   教训：**新增 preload 命名空间时，必须同时加到这里**。
  //   漏了不会报错，只会静默变成 undefined。
  for (const ns of ['engine', 'tui', 'ma', 'workspace', 'balance', 'remoteAccess', 'theme', 'app', 'file',
    'filePath', 'net', 'sys', 'skills', 'blender', 'appwin', 'site', 'code', 'review',
    'stock', 'oa', 'plugins', 'models', 'sfBoard', 'sfPipelines', 'sfPipeStatus',
    'sfClaim', 'browserSidebar', 'topbar', 'webai', 'win', 'pc']) {
    const nsObj = app[ns];
    if (!nsObj) continue;
    if (typeof nsObj === 'function') {
      out[ns] = wrap(nsObj.bind(app), ns);
    } else if (typeof nsObj === 'object') {
      const wrapped = wrapNamespace(nsObj, ns);
      if (wrapped) out[ns] = wrapped;
      // 保留原始同步方法（如 onData 订阅）
      if (typeof nsObj.onData === 'function') out[ns]._onDataRaw = nsObj.onData.bind(nsObj);
      if (typeof nsObj.onExit === 'function') out[ns]._onExitRaw = nsObj.onExit.bind(nsObj);
    }
  }

  // ═══ 便捷封装（组合调用）═══
  out.util = {
    /** 取所有场景 + 校验形状（渲染层最常用） */
    async scenes() {
      const r = await out.listScenarios();
      if (!r.ok) return { ok: false, items: [], error: r.error };
      const items = Array.isArray(r.value) ? r.value : (r.value && r.value.items) || [];
      return { ok: true, items, error: null };
    },
    /** 取单个场景 + 面板列表 */
    async scene(id) {
      const r = await out.getScenario(id);
      if (!r.ok) return { ok: false, scene: null, error: r.error };
      return { ok: true, scene: r.value, error: null };
    },
    /** 派单给某场景的会话（走已验证的 engine.prompt） */
    async dispatch(sessionId, text) {
      // 兼容：如果传的是场景 id 而不是 sessionId，自动解析
      if (sessionId && !String(sessionId).startsWith('session-')) {
        const r = await out.util.scene(sessionId);
        if (r.ok && r.scene) {
          const panels = r.scene.panels || [];
          for (const p of panels) {
            if (p.type === 'harness' && (p.sessionId || p.session)) {
              sessionId = p.sessionId || p.session;
              break;
            }
          }
        }
      }
      if (!sessionId) return { ok: false, error: { code: 'no-session', message: '缺少 sessionId' } };
      if (!text || !String(text).trim()) return { ok: false, error: { code: 'empty-text', message: '任务不能为空' } };
      if (!out.engine || !out.engine.prompt) {
        return { ok: false, error: { code: 'no-engine', message: 'engine.prompt 不可用（需重启工作台）' } };
      }
      let r;
      try { r = await out.engine.prompt(sessionId, String(text)); }
      catch (e) { return { ok: false, error: { code: 'throw', message: e.message } }; }
      // 主进程返回 {ok, status, value:{accepted:true}, err}
      return {
        ok: !!(r && r.ok),
        value: r && r.value,
        error: r && r.err ? { code: 'engine', message: String(r.err) } : null,
      };
    },
    /** 查会话列表（判断 running / asOfSeq） */
    async sessions() {
      if (!out.engine || !out.engine.rpc) {
        return { ok: false, items: [], error: { code: 'no-engine', message: 'engine.rpc 不可用' } };
      }
      let r;
      try { r = await out.engine.rpc('session/list', { _request: {} }); }
      catch (e) { return { ok: false, items: [], error: { code: 'throw', message: e.message } }; }

      // 防御：兼容 {ok,value:{items}} 和 {ok,value:{ok,value:{items}}} 两种形态
      if (!r || r.ok === false) {
        return { ok: false, items: [], error: (r && (r.err || r.error)) || { code: 'fail', message: '未知' } };
      }
      let v = r.value;
      if (v && v.ok !== undefined && v.value !== undefined) v = v.value;   // 剥一层
      const items = (v && v.items) || [];
      return { ok: true, items, error: null };
    },
  };

  return out;
}

/** 全局单例懒加载 */
let _api = null;
export function api() {
  if (!_api) _api = createApi();
  return _api;
}

export { normError, wrap };
export default api;
