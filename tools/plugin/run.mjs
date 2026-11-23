#!/usr/bin/env node
/**
 * 插件运行器：真的把插件跑起来，并产出运行时证据。
 *
 * 【为什么需要这个文件】
 * 之前 tools/plugin/kernel.mjs 有 activateAll()，但**全仓没有任何地方真的调用它**：
 * prototype/agent-ui/verify-plugin-kernel.mjs 只对真实插件做了 topoSort，
 * 插件的 activate() 从来没有在内核里被执行过。
 * 这正是独立审计判 A12「部分」的那句话：代码真实、自检通过，但没人用。
 *
 * 这个运行器做的事：
 *   1. discover 真实插件清单
 *   2. createKernel → load → activateAll（按 requires 拓扑排序）
 *   3. 按 manifest.caps 构造**能力受限**的 ctx（fs.read / fs.write 前缀匹配，exec 拒绝）
 *   4. 收集每个插件的返回值（含它们自己的越界尝试结果）
 *   5. 写 evidence/plugin-probe/live-run.json 作为运行时证据
 *
 * 能力边界如实说：这不是沙箱，是**能力声明检查**。
 * 越界拦截类安全机制按用户要求不做，这里只保证「插件只能拿到它声明的能力」，
 * 不做 OS 级隔离。别把它说成沙箱。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel, discover, pluginId } from './kernel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/**
 * cap 形如 'fs.read:**' / 'fs.write:evidence/**'，返回其路径前缀。
 *   '**'          → ''（全仓库）
 *   'evidence/**' → 'evidence'
 *   'a/b.json'    → 'a/b.json'（精确路径）
 * 上一版把裸 '**' 当成字面前缀，导致 fs.read:** 反而读不了任何文件 —— 被自己的反例抓到。
 */
function capPrefix(cap, kind) {
  const m = new RegExp('^' + kind + ':(.+)$').exec(cap);
  if (!m) return null;
  const p = m[1].trim();
  if (p === '**' || p === '*' || p === '') return '';
  if (p.endsWith('/**')) return p.slice(0, -3);
  if (p.endsWith('*')) return p.slice(0, -1);
  return p;
}

/** 把相对路径规整成 ROOT 内的相对 posix 路径；越界返回 null */
function norm(p) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
  const rel = relative(ROOT, abs).split('\\').join('/');
  if (rel.startsWith('..')) return null;
  return rel;
}

function makeCtx(plugin, log) {
  const caps = plugin.caps || [];
  const readPrefixes = caps.map((c) => capPrefix(c, 'fs.read')).filter((x) => x !== null);
  const writePrefixes = caps.map((c) => capPrefix(c, 'fs.write')).filter((x) => x !== null);

  const allow = (prefixes, rel) => prefixes.some((pre) => pre === '' || rel === pre || rel.startsWith(pre.replace(/\/$/, '') + '/'));

  const denied = (what) => {
    const e = new Error('能力未声明：' + what);
    e.code = 'CAP_DENIED';
    return e;
  };

  const ctx = {
    plugin: { name: plugin.name, version: plugin.version },
    log: (m) => log.push(plugin.name + ': ' + m),
    fs: {
      read(p) {
        const rel = norm(p);
        if (rel === null) throw denied('fs.read 越出仓库：' + p);
        if (!allow(readPrefixes, rel)) throw denied('fs.read ' + rel + '（声明：' + JSON.stringify(caps) + '）');
        return readFileSync(join(ROOT, rel), 'utf8');
      },
      write(p, data) {
        const rel = norm(p);
        if (rel === null) throw denied('fs.write 越出仓库：' + p);
        if (!allow(writePrefixes, rel)) throw denied('fs.write ' + rel + '（声明：' + JSON.stringify(caps) + '）');
        const abs = join(ROOT, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, data, 'utf8');
        return rel;
      },
    },
    exec() {
      // 没有插件声明 exec 能力，所以一律拒绝
      throw denied('exec');
    },
  };
  return Object.freeze(ctx);
}

/**
 * 真跑一遍。
 * @param {{root?: string, writeEvidence?: boolean}} [opts]
 */
export async function runPlugins(opts = {}) {
  const root = opts.root || join(ROOT, 'tools/plugin/builtin');
  const writeEvidence = opts.writeEvidence !== false;

  const found = discover(root);
  const kernel = createKernel();
  const loadIssues = [];
  for (const f of found) {
    if (!f.raw) { loadIssues.push({ plugin: f.path, issue: '清单解析失败' }); continue; }
    const r = kernel.load(f.raw);
    if (!r.ok) loadIssues.push({ plugin: f.raw.name || f.path, issues: r.issues });
  }

  const logs = [];
  const results = [];
  const act = await kernel.activateAll(root, (id, m) => {
    // 捕获 activate 的返回值：activateAll 内部不返回它，所以用包装
    const ctx = makeCtx(m, logs);
    return ctx;
  });

  // 激活失败时也要报出是哪个插件、什么原因 —— 否则调用方只看到 ok:false，无从排查
  if (!act.ok) {
    for (const iss of act.issues || []) {
      results.push({ plugin: iss.plugin || iss.message || '(未知)', ok: false, error: iss.code + ': ' + iss.message });
    }
  }

  // activateAll 现在直接返回 results（见 kernel.mjs），不再二次执行插件
  if (act.ok && Array.isArray(act.results)) {
    for (const r of act.results) results.push(r);
  }

  const payload = {
    at: new Date().toISOString(),
    kernelOk: act.ok === true,
    order: act.ok ? act.order.map(pluginId) : [],
    loadIssues,
    logs,
    results,
    note: '能力受限 ctx 是「声明检查」，不是 OS 沙箱（越界拦截类机制按用户要求不做）',
  };

  if (writeEvidence && act.ok) {
    const out = join(ROOT, 'evidence/plugin-probe/live-run.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    payload.evidencePath = 'evidence/plugin-probe/live-run.json';
  }

  return payload;
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('run.mjs')) {
  const r = await runPlugins();
  console.log('  内核激活: ' + (r.kernelOk ? 'ok' : '失败'));
  console.log('  拓扑序: ' + JSON.stringify(r.order));
  for (const x of r.results) {
    console.log('  ' + (x.ok ? '✓' : '✗') + ' ' + x.plugin);
    if (x.result) {
      for (const [k, v] of Object.entries(x.result)) {
        console.log('      ' + k + ' = ' + JSON.stringify(v).slice(0, 120));
      }
    }
    if (x.error) console.log('      error = ' + x.error);
  }
  if (r.evidencePath) console.log('  证据 → ' + r.evidencePath);
  process.exit(r.kernelOk && r.results.every((x) => x.ok) ? 0 : 1);
}
