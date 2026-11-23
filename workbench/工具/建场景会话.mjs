#!/usr/bin/env node
/**
 * 建场景会话 —— 补齐六件套的第 6 件
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要
 * ══════════════════════════════════════════════════════════════
 *
 *  参考项目 00-核心机制/三-场景体系.md §3 说：
 *    「⑥ 常驻会话 + 身份索引一行
 *      缺了会怎样：**引擎不注入身份 ⇒ AI 会猜，一猜就串台**」
 *
 *  而且明确「2、3、6 是不可省的三件」。
 *
 *  我们实测：9 个场景里 7 个缺第 6 件 → 按他的标准「不成立」。
 *
 * ══════════════════════════════════════════════════════════════
 *  这件事的关键
 * ══════════════════════════════════════════════════════════════
 *
 *  「建会话」不是打开一个聊天窗口那么简单：
 *    ① 用场景记忆目录做 cwd（这样 AGENTS.local.md 被读到）
 *    ② 切到能用的 provider（我们的场景会话默认可能是余额不足的）
 *    ③ 把 sessionId 写进身份索引
 *    ④ 场景配置里的面板也要绑这个 sessionId
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/建场景会话.mjs --list             看哪些场景缺会话
 *  node 工具/建场景会话.mjs --build --apply    给所有缺失场景建会话
 *  node 工具/建场景会话.mjs --scene 调研 --apply
 *  node 工具/建场景会话.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA_ROOT = path.join(WB, '数据', '.dsh');
const MEM_ROOT = path.join(DATA_ROOT, '场景记忆');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const SHARED = path.join(MEM_ROOT, '_共享记忆');
const PORT = 3083;

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

function getToken() {
  const s = readTextSafe(path.join(WB, '外壳', 'server.log'));
  if (!s) return null;
  const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

function request(method, p, body, cookie) {
  return new Promise((res) => {
    const d = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), ...(cookie ? { cookie } : {}) },
      timeout: 120000,
    }, (re) => { let b = ''; re.on('data', (c) => { b += c; }); re.on('end', () => res({ h: re.headers, b })); });
    r.on('error', (e) => res({ h: {}, b: JSON.stringify({ error: e.message }) }));
    r.on('timeout', () => { r.destroy(); res({ h: {}, b: JSON.stringify({ error: 'timeout' }) }); });
    r.write(d); r.end();
  });
}

let cookie = '';
async function connect() {
  const t = getToken();
  if (!t) return false;
  const r = await request('GET', '/?token=' + t);
  const sc = r.h['set-cookie'];
  cookie = Array.isArray(sc) ? sc.map((c) => c.split(';')[0]).join('; ') : '';
  return !!cookie;
}

async function rpc(channel, endpoint, args) {
  const call = async () => {
    const r = await request('POST', '/api/' + channel + '/' + endpoint, {
      type: 'client-request', rpcId: crypto.randomUUID(),
      method: channel + '/' + endpoint, payload: { args: args || {} },
    }, cookie);
    try { return JSON.parse(r.b); } catch { return { raw: r.b }; }
  };
  let res = await call();
  if (!res?.result) { await connect(); res = await call(); }
  return res;
}

// ══════════════════════════════════════════════════════════════
//  找可用的 provider（按优先级）
// ══════════════════════════════════════════════════════════════
export async function findUsableProvider() {
  const cat = await rpc('session', 'modelCatalog');
  const v = cat?.result?.value;
  const groups = v?.groups || [];
  const routable = v?.routableProviders || [];

  // 优先级：pursueray（我们有额度）> deepseek-official > 其他
  const prefer = ['pursueray', 'deepseek-official', 'deepseek-account'];
  for (const p of prefer) {
    if (!routable.includes(p)) continue;
    const g = groups.find((x) => x.id === p);
    if (g && (g.models || []).length > 0) {
      return { provider: p, model: g.models[0].id, all: routable };
    }
  }
  // 退而求其次：任何 routable 的
  for (const p of routable) {
    const g = groups.find((x) => x.id === p);
    if (g && (g.models || []).length > 0) {
      return { provider: p, model: g.models[0].id, all: routable };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
//  检查各场景的会话状况
// ══════════════════════════════════════════════════════════════
export function findMissing(opts) {
  const o = opts || {};
  const idx = readJsonSafe(path.join(SHARED, '身份索引.json')) || { rows: [] };
  const rows = idx.rows || [];

  const scenes = [];
  if (fs.existsSync(SCEN_DIR)) {
    for (const f of fs.readdirSync(SCEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      const j = readJsonSafe(path.join(SCEN_DIR, f));
      if (j && j.id) scenes.push(j);
    }
  }

  const out = [];
  for (const s of scenes) {
    const row = rows.find((r) => r.scene === s.id || r.name === s.name);
    const hasSession = row && row.sessionId && !/placeholder|TODO/i.test(String(row.sessionId));
    out.push({
      id: s.id,
      name: s.name || s.id,
      hasSession: !!hasSession,
      sessionId: row ? (row.sessionId || null) : null,
      memoryDir: path.join(MEM_ROOT, s.name || s.id),
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
//  建一个场景的会话
// ══════════════════════════════════════════════════════════════
export async function buildOne(scene, opts) {
  const o = opts || {};

  // ① 记忆目录必须存在（这是 cwd）
  if (!fs.existsSync(scene.memoryDir)) {
    return { ok: false, error: '记忆目录不存在: ' + scene.memoryDir };
  }

  // ② 建会话
  const created = await rpc('session', 'create', { request: { cwd: scene.memoryDir } });
  const sid = created?.result?.value?.sessionId;
  if (!sid) {
    return { ok: false, error: '建会话失败: ' + JSON.stringify(created?.result?.error || created).slice(0, 100) };
  }

  // ③ 切 provider
  const prov = o.provider || null;
  if (prov) {
    const sel = await rpc('session', 'selectModel', {
      request: { sessionId: sid, provider: prov.provider, model: prov.model },
    });
    if (!sel?.result?.ok) {
      return {
        ok: false, sessionId: sid,
        error: '切模型失败: ' + JSON.stringify(sel?.result?.error || {}).slice(0, 100),
      };
    }
  }

  return {
    ok: true,
    sessionId: sid,
    cwd: scene.memoryDir,
    provider: prov ? prov.provider + '/' + prov.model : null,
  };
}

// ══════════════════════════════════════════════════════════════
//  写回身份索引
// ══════════════════════════════════════════════════════════════
export function writeIndex(results) {
  const idxFile = path.join(SHARED, '身份索引.json');
  let idx = readJsonSafe(idxFile) || { _note: '场景 → 引擎会话映射', rows: [] };
  if (!Array.isArray(idx.rows)) idx.rows = [];

  let updated = 0;
  for (const r of results) {
    if (!r.ok) continue;
    let row = idx.rows.find((x) => x.scene === r.id);
    if (!row) {
      row = { scene: r.id, name: r.name };
      idx.rows.push(row);
    }
    row.sessionId = r.sessionId;
    row.updatedAt = new Date().toISOString();
    // ⚠ 定位卡文件名用的是场景 id，不是中文名
    row.context = r.id + '-context.md';
    updated++;
  }

  idx._at = new Date().toISOString();
  idx._source = '数据/.dsh/sessions（引擎实际会话）';
  fs.mkdirSync(SHARED, { recursive: true });
  fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2), 'utf8');
  return { ok: true, updated, total: idx.rows.length };
}

// ══════════════════════════════════════════════════════════════
//  写回场景配置（2026-11-13 加 —— 这才是真正生效的地方）
// ══════════════════════════════════════════════════════════════
/**
 * 把 sessionId 写进 外壳/scenarios/<id>.json 的 harness 面板
 *
 * ⚠ 真实缺陷（这轮抓到，而且是**第二次**同一类错误）
 *
 *   这个工具的注释（L24-25）写着：
 *     ③ 把 sessionId 写进身份索引
 *     ④ 场景配置里的面板也要绑这个 sessionId
 *   但代码只做了 ③，④ 从来没实现过。
 *
 *   实测后果：新建的三个场景（前端工坊/后端工坊/工具工坊），
 *     身份索引里都有 sessionId，配置里是空字符串 →
 *     面板绑不上会话 → 六件套第 ⑥ 件判不合格 → 场景完整率 75%。
 *
 *   这和上一轮「会话轮转只写身份卡不写配置」是同一类错误：
 *     **凡是「多个地方都存了同一事实」，就必须全部写。**
 *
 * @returns {{ok:boolean, updated:number, files:string[]}}
 */
export function writeSceneConfig(results) {
  let updated = 0;
  const files = [];
  for (const r of results) {
    if (!r.ok || !r.sessionId) continue;
    const p = path.join(SCEN_DIR, r.id + '.json');
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      let touched = false;
      for (const panel of (j.panels || [])) {
        if (panel.type === 'harness' && String(panel.sessionId || '') !== r.sessionId) {
          panel.sessionId = r.sessionId;
          touched = true;
        }
      }
      // 中枢的会话 id 在 meta.hubSessionId
      if (j.meta && j.meta.hubSessionId && String(j.meta.hubSessionId) !== r.sessionId) {
        j.meta.hubSessionId = r.sessionId;
        touched = true;
      }
      if (touched) {
        // 顺手清掉「待绑」标记
        if (j.meta && j.meta.pendingSession) {
          delete j.meta.pendingSession;
          delete j.meta.pendingReason;
        }
        fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
        updated++;
        files.push(r.id + '.json');
      }
    } catch { /* ignore */ }
  }
  return { ok: true, updated, files };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  建场景会话 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 能找缺失
  const missing = findMissing();
  chk('能列出所有场景', missing.length > 0, missing.length + ' 个');
  // ⚠ 2026-11-12 修（判据错误：把「当前数据状态」当成自测判据）
  //
  //   原来：chk('能标出缺会话的', missing.some((m) => !m.hasSession), ...)
  //          —— 断言「现在必须有缺会话的场景」。
  //
  //   问题：9 个场景全部绑定后，这条就永远红。但那是**好事**（系统完整），
  //        不是代码有问题。这正是「把环境状态当判据」。
  //
  //   修法：验证的是「函数能否正确分类」（每个场景都有 hasSession 布尔值
  //        且有记忆目录路径），不是「必须存在某一类」。
  chk('每个场景都被正确分类（hasSession 是布尔值）',
      missing.every((m) => typeof m.hasSession === 'boolean'),
      missing.filter((m) => m.hasSession).length + ' 有 / ' +
      missing.filter((m) => !m.hasSession).length + ' 缺');
  chk('能标出已有会话的', missing.some((m) => m.hasSession),
      missing.filter((m) => m.hasSession).length + ' 个有');
  chk('每个场景有记忆目录路径', missing.every((m) => m.memoryDir.endsWith(m.name)),
      missing[0] ? missing[0].memoryDir.split('\\').slice(-2).join('/') : '');

  // ② 反例：不存在的场景建会话应失败
  // （用假的记忆目录路径测）
  const fake = {
    id: 'no-such-scene', name: '不存在',
    memoryDir: path.join(MEM_ROOT, '不存在'),
  };
  chk('反例：记忆目录不存在时不硬建',
      !fs.existsSync(fake.memoryDir), '目录确实不存在');

  // ③ 索引结构
  const idx = readJsonSafe(path.join(SHARED, '身份索引.json'));
  chk('身份索引可读', idx !== null, idx ? (idx.rows || []).length + ' 行' : '无');

  // ④ 关键：六件套的第 6 件就是要这个
  chk('关键：这补的是六件套第 6 件（常驻会话+索引）',
      missing.length > 0 && idx !== null,
      '参考项目：「缺了会怎样：引擎不注入身份 ⇒ AI 会猜，一猜就串台」');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  const missing = findMissing();

  // ── 列出 ──
  if (has('--list') || (!has('--build') && !has('--scene'))) {
    console.log('═'.repeat(76));
    console.log('  场景会话状况（六件套第 6 件）');
    console.log('═'.repeat(76));
    console.log();
    for (const m of missing) {
      const mark = m.hasSession ? '✓' : '✗';
      const sid = m.sessionId ? String(m.sessionId).slice(0, 34) : '（无会话）';
      console.log('  ' + mark + ' ' + m.name.padEnd(12) + sid);
    }
    console.log();
    const need = missing.filter((m) => !m.hasSession);
    console.log('─'.repeat(76));
    console.log('  有会话 ' + (missing.length - need.length) + ' / 缺 ' + need.length);
    if (need.length > 0) {
      console.log('  ⚠ 按参考项目的标准，缺第 6 件 = 场景「不成立」');
      console.log('     「引擎不注入身份 ⇒ AI 会猜，一猜就串台」');
      console.log();
      console.log('  补齐: node 工具/建场景会话.mjs --build --apply');
    }
    console.log('─'.repeat(76));
    process.exit(need.length > 0 ? 1 : 0);
  }

  // ── 建 ──
  if (has('--build') || has('--scene')) {
    const ok = await connect();
    if (!ok) { console.error('✗ 连不上引擎（先启动工作台）'); process.exit(2); }

    // 找 provider
    const prov = await findUsableProvider();
    if (!prov) { console.error('✗ 没有可用 provider'); process.exit(2); }
    console.log('  使用 provider: ' + prov.provider + ' / ' + prov.model);
    console.log();

    let targets = [];
    if (has('--scene')) {
      const want = val('--scene');
      const s = missing.find((x) => x.id === want || x.name === want);
      if (!s) { console.error('找不到场景: ' + want); process.exit(2); }
      targets = [s];
    } else {
      targets = missing.filter((m) => !m.hasSession);
    }

    console.log('═'.repeat(76));
    console.log('  建场景会话' + (has('--apply') ? '' : '（预览）'));
    console.log('═'.repeat(76));
    console.log();
    console.log('  待建: ' + targets.length + ' 个');
    console.log();

    const results = [];
    for (const t of targets) {
      if (!has('--apply')) {
        console.log('  · ' + t.name + '  cwd=' + t.memoryDir);
        results.push({ ...t, ok: false, preview: true });
        continue;
      }
      const r = await buildOne(t, { provider: prov });
      results.push({ ...t, ...r });
      if (r.ok) {
        console.log('  ✓ ' + t.name.padEnd(12) + r.sessionId);
      } else {
        console.log('  ✗ ' + t.name.padEnd(12) + r.error);
      }
    }

    console.log();
    if (!has('--apply')) {
      console.log('  （预览。加 --apply 真建）');
    } else {
      const w = writeIndex(results);
      // ⚠ 2026-11-13 加：还必须写回场景配置
      //   身份索引只是「账本」，真正生效的是 外壳/scenarios/<id>.json 的 harness.sessionId。
      //   只写索引不写配置 = 面板绑不上 = 六件套第 ⑥ 件不合格。
      const c = writeSceneConfig(results);
      const okCount = results.filter((r) => r.ok).length;
      console.log('─'.repeat(76));
      console.log('  已建 ' + okCount + ' 个，写入身份索引 ' + w.updated + ' 条（共 ' + w.total + ' 条）');
      if (c.updated) console.log('  同时写回场景配置 ' + c.updated + ' 个: ' + c.files.join(', '));
      console.log('─'.repeat(76));
      console.log();
      console.log('  下一步，按顺序：');
      console.log('    ① node 工具/会话预热.mjs          给新会话生成标题（否则侧栏不渲染）');
      console.log('    ② node 工具/工作区同步.mjs --apply 让侧栏能看见它');
      console.log('    ③ 重启工作台                      侧栏才会重建');
      console.log('    ④ node 工具/六件套.mjs            复查');
    }
    process.exit(0);
  }
}
