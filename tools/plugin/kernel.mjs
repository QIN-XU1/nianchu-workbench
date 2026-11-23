#!/usr/bin/env node
/**
 * 插件化内核（无特权核心）—— B1 自研实现
 *
 * 【2026-11-17 修·兼容既有插件】上一版只认 {id, contributes, contribute()}，
 * 而仓库里已有的真实插件（tools/plugin/builtin/probe-reader、probe-audit）用的是
 * {name, version, entry, caps, requires} + `export async function activate(ctx)`。
 * 两者不兼容 = 内核"看起来有实际是空"。本版同时支持两套契约：
 *   · 声明式清单：name 或 id（二选一，至少一个）
 *   · 贡献点模式：contributes + contribute()（内核白名单校验）
 *   · 激活模式：entry + activate(ctx)（按 requires 拓扑排序，只注入只读 ctx）
 *
 * 无特权核心：内核只做「发现 / 校验 / 排序 / 派发」，不认识任何具体插件。
 * ⛔ 不做越界拦截（用户明令）：caps 只是**声明**，内核不据此阻止任何操作。
 *    谁真的执行读写，靠插件自己的代码 + 宿主环境，如实标注「靠宿主」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 内核认识的贡献点（白名单） */
export const CONTRIBUTION_POINTS = ['commands', 'panels', 'verifiers'];

/** 校验单个插件清单（纯函数） */
export function validateManifest(raw) {
  const issues = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, issues: [{ level: 'error', code: 'not_object', message: '清单不是对象' }] };
  }
  const m = raw;
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  const version = typeof m.version === 'string' ? m.version.trim() : '';
  if (!name && !id) issues.push({ level: 'error', code: 'missing_name', message: '缺 name（或 id）' });
  if (!version) issues.push({ level: 'error', code: 'missing_version', message: '缺 version' });

  const contributes = m.contributes;
  if (contributes !== undefined) {
    if (!contributes || typeof contributes !== 'object' || Array.isArray(contributes)) {
      issues.push({ level: 'error', code: 'bad_contributes', message: 'contributes 必须是对象' });
    } else {
      for (const key of Object.keys(contributes)) {
        if (!CONTRIBUTION_POINTS.includes(key)) {
          issues.push({ level: 'error', code: 'unknown_point', message: '未知贡献点：' + key + '（白名单：' + CONTRIBUTION_POINTS.join('/') + '）' });
        }
      }
    }
  }
  if (m.requires !== undefined && !Array.isArray(m.requires)) {
    issues.push({ level: 'error', code: 'bad_requires', message: 'requires 必须是数组' });
  }
  return { ok: issues.length === 0, issues, manifest: issues.length === 0 ? m : undefined };
}

/** 插件标识（name 优先，兼容 id） */
export function pluginId(m) {
  return (m && (m.name || m.id)) || '';
}

/** 拓扑排序：按 requires 排依赖，检测环与缺失依赖（纯函数） */
export function topoSort(manifests) {
  const byId = new Map();
  for (const m of manifests) byId.set(pluginId(m), m);
  const out = [];
  const state = new Map(); // 0=未访问 1=访问中 2=完成
  const issues = [];

  function visit(id, stack) {
    if (state.get(id) === 2) return true;
    if (state.get(id) === 1) {
      issues.push({ level: 'error', code: 'cycle', message: '依赖成环：' + [...stack, id].join(' → ') });
      return false;
    }
    const m = byId.get(id);
    if (!m) {
      issues.push({ level: 'error', code: 'missing_dep', message: '缺少依赖：' + id });
      return false;
    }
    state.set(id, 1);
    for (const dep of m.requires || []) {
      if (!visit(dep, [...stack, id])) return false;
    }
    state.set(id, 2);
    out.push(m);
    return true;
  }

  for (const m of manifests) {
    if (!visit(pluginId(m), [])) return { ok: false, issues, order: [] };
  }
  return { ok: issues.length === 0, issues, order: out };
}

/** 内核 */
export function createKernel() {
  const plugins = new Map();
  const contributions = new Map();
  const activated = [];
  for (const p of CONTRIBUTION_POINTS) contributions.set(p, new Map());

  return {
    load(raw) {
      const r = validateManifest(raw);
      if (!r.ok) return r;
      const m = r.manifest;
      const id = pluginId(m);
      if (plugins.has(id)) {
        return { ok: false, issues: [{ level: 'error', code: 'dup_id', message: '重复 id：' + id }] };
      }
      plugins.set(id, m);
      return { ok: true, issues: [] };
    },

    /** 按 requires 拓扑排序后逐个 activate(只读 ctx)。entry 缺省 = 无 activate（纯声明式）。 */
    async activateAll(root, ctxFactory) {
      const order = topoSort([...plugins.values()]);
      if (!order.ok) return order;
        // 【2026-11-17】收集每个插件 activate 的返回值 —— 原来不收集，
        // 调用方只能再 import 一次插件重跑一遍拿结果，导致每个插件被执行两次
        // （独立审计在 live-run.json 的 logs 里看到重复，复现了这个问题）。
        const results = [];
        for (const m of order.order) {
          const id = pluginId(m);
          if (!m.entry) {
            activated.push(id);
            results.push({ plugin: id, ok: true, result: { skipped: '无 entry（纯声明式）' } });
            continue;
          }
          const entryPath = path.join(root, id, m.entry);
          if (!fs.existsSync(entryPath)) {
            return { ok: false, issues: [{ level: 'error', code: 'missing_entry', plugin: id, message: '入口不存在：' + entryPath }], order: order.order, results };
          }
          const mod = await import(pathToFileURL(entryPath).href);
          if (typeof mod.activate === 'function') {
            // 只注入冻结的只读 ctx —— 插件拿不到内核对象
            try {
              const r = await mod.activate(Object.freeze(ctxFactory ? ctxFactory(id, m) : {}));
              results.push({ plugin: id, ok: true, result: r === undefined ? null : r });
            } catch (e) {
              // 插件自己抛错要报出来，不能当成「激活成功」
              activated.push(id);
              return { ok: false, issues: [{ level: 'error', code: 'activate_threw', plugin: id, message: String(e && e.message) }], order: order.order, results };
            }
          } else {
            results.push({ plugin: id, ok: true, result: { skipped: '无 activate 导出' } });
          }
          activated.push(id);
        }
        return { ok: true, issues: [], order: order.order, results };
    },

    contribute(pluginId_, point, name, fn) {
      if (!CONTRIBUTION_POINTS.includes(point)) {
        return { ok: false, issues: [{ level: 'error', code: 'unknown_point', message: '未知贡献点：' + point }] };
      }
      if (!plugins.has(pluginId_)) {
        return { ok: false, issues: [{ level: 'error', code: 'unknown_plugin', message: '未装载的插件：' + pluginId_ }] };
      }
      if (typeof fn !== 'function') {
        return { ok: false, issues: [{ level: 'error', code: 'not_function', message: '贡献点 ' + point + '/' + name + ' 不是函数' }] };
      }
      contributions.get(point).set(pluginId_ + ':' + name, fn);
      return { ok: true, issues: [] };
    },

    invoke(point, key, ctx = {}) {
      const fn = contributions.get(point) && contributions.get(point).get(key);
      if (!fn) throw new Error('贡献点不存在：' + point + '/' + key);
      return fn(Object.freeze({ ...ctx }));
    },

    stats() {
      const points = {};
      for (const [k, v] of contributions) points[k] = [...v.keys()].sort();
      return { plugins: [...plugins.keys()].sort(), points, activated: [...activated] };
    },
  };
}

/** 递归时跳过的目录：依赖、产物、版本库 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'target']);

/**
 * 从目录发现插件清单（plugin.json），**有界递归**。
 *
 * 【2026-11-17 改】原来是单层：只找 root/<name>/plugin.json。
 * 实测 discover('tools/plugin') = 0（builtin 在两层下），
 * 真实插件生态必然是嵌套的，单层发现等于只能发现「扁平摆放」的插件。
 *
 * @param {string} root 起始目录
 * @param {{maxDepth?: number}} [opts] maxDepth 默认 3，防无限递归与符号链接环
 * @returns {Array<{path: string, raw: object|null, depth: number}>}
 */
export function discover(root, opts = {}) {
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 3;
  if (!fs.existsSync(root)) return [];

  const out = [];
  const seen = new Set();

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 没权限 / 已删除：跳过，不让一个坏目录搞崩整个发现
    }

    // 当前目录自己是不是一个插件
    const manifest = path.join(dir, 'plugin.json');
    if (seen.size === 0 || !seen.has(dir)) {
      if (fs.existsSync(manifest) && fs.statSync(manifest).isFile()) {
        seen.add(dir);
        try {
          out.push({ path: manifest, raw: JSON.parse(fs.readFileSync(manifest, 'utf8')), depth });
        } catch {
          // 清单坏了也要报出来，不能静默当成「没有插件」
          out.push({ path: manifest, raw: null, depth });
        }
        // 插件目录内部不再往下找（避免把插件自带的样例/测试当成新插件）
        return;
      }
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      if (seen.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  walk(root, 0);
  return out;
}
