/**
 * 配置中心方法（从 ws-host.mjs 拆出，遵守单文件 <32KB 红线）
 *
 * 前端把 get_config/set_config 映射成 config/getConfig / config/setConfig
 * （websocket-adapter.ts:192/204）。此前宿主只留了恒 null 的 getConfig、且从未实现
 * setConfig ⇒ 设置页几乎全部读空、写不进去。这里落到一个真实持久化的 JSON，
 * 按点路径读写：主题 / 外观 / 开关等设置即真正可用。
 *
 * 数据文件：<REPO>/.host-config.json（单机本地，不加密，不做多用户隔离）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function configMethods(REPO) {
  const CONFIG_FILE = join(REPO, '.host-config.json');
  let HOST_CONFIG = (() => {
    try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { return {}; }
  })();
  const save = () => {
    try { writeFileSync(CONFIG_FILE, JSON.stringify(HOST_CONFIG, null, 2) + '\n', 'utf8'); return true; }
    catch (e) { process.stderr.write('[config] 持久化失败（仅内存生效）：' + (e && e.message) + '\n'); return false; }
  };
  const get = (obj, p) => (!p ? obj : String(p).split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj));
  const set = (obj, p, value) => {
    const ks = String(p).split('.'); let c = obj;
    for (let i = 0; i < ks.length - 1; i++) { if (typeof c[ks[i]] !== 'object' || c[ks[i]] === null) c[ks[i]] = {}; c = c[ks[i]]; }
    c[ks[ks.length - 1]] = value;
  };
  const req = (params) => (params && params.request) || params || {};

  return {
    'config/getConfig': (params) => {
      const r = req(params);
      if (!r.path) return HOST_CONFIG;
      const v = get(HOST_CONFIG, r.path);
      return v === undefined ? null : v;
    },
    'config/getConfigs': (params) => {
      const r = req(params);
      const paths = Array.isArray(r.paths) ? r.paths : [];
      const out = {};
      for (const p of paths) { const v = get(HOST_CONFIG, p); out[p] = v === undefined ? null : v; }
      return out;
    },
    'config/setConfig': (params) => {
      const r = req(params);
      if (typeof r.path !== 'string' || !r.path) throw new Error('config path is required');
      set(HOST_CONFIG, r.path, r.value);
      save();
      return null;
    },
    'config/validateConfig': () => ({ valid: true, errors: [] }),
    'config/resetConfig': () => { HOST_CONFIG = {}; save(); return null; },
    'config/getModelConfigs': () => [],
    'config/getAgentProfileConfigs': () => [],
    'config/getAgentProfileConfig': () => null,
    'config/setAgentProfileConfig': () => null,
    'config/resetAgentProfileConfig': () => null,
    'i18n/getConfig': () => ({ language: get(HOST_CONFIG, 'i18n.language') || 'zh-CN' }),
    'i18n/setConfig': (params) => {
      const r = req(params);
      const v = r.config || r.value || r;
      if (v && typeof v === 'object') { HOST_CONFIG.i18n = { ...(HOST_CONFIG.i18n || {}), ...v }; save(); }
      return null;
    },
    'i18n/setLanguage': (params) => {
      const r = req(params);
      const lang = r.language || r.lang || (r.config && r.config.language) || r.value;
      if (lang && typeof lang === 'string') { HOST_CONFIG.i18n = { ...(HOST_CONFIG.i18n || {}), language: lang }; save(); }
      return null;
    },
    'config/getDecisionModelCredentialStatus': () => ({ configured: false }),
    // 安全空集合（确实没有：本机单用户、无订阅、无后台 shell、无多项目 worktree）
    'list_subscription_accounts': () => [],
    'terminal_get_shells': () => [],
    'worktree_list_projects': () => [],
  };
}
