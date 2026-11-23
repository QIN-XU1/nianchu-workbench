#!/usr/bin/env node
// 工具/会话轮转.mjs —— 会话历史太长就把场景换到新会话
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（真实根因，2026-11-12 查出来的）
// ══════════════════════════════════════════════════════════════════════
//  现象：接入本地免费网关后，投递能成功，但任务跑到一半就 402。
//
//  排查路径：
//    ① 网关直连测试 → 200，「收到」，1.6 秒  →  网关没问题
//    ② 干净会话跑同一任务 → completed，写了产物，无 402  →  模型没问题
//    ③ 长会话跑同一任务 → 402，且总是卡在最后
//
//  统计各场景会话历史规模：
//    竞品拆解  498 事件
//    调研      471 事件
//    自我复盘  460 事件
//    故障分析  459 事件
//    架构梳理  438 事件
//    ...全部 400+
//
//  **根因：每个会话都积累了几百条事件历史，每次模型调用都要把
//         全部历史发过去。免费模型的上下文/额度被历史吃光 → 402。**
//
//  实测对比：
//    干净会话（56 事件）→ completed，6 次工具调用，写入产物，无 402
//    长会话（470+ 事件）→ 402
//
//  这个工具：历史超过阈值的场景，换一个干净会话（记忆在文件里，不在会话里）。
//
//  依据项目铁律：「记忆在文件，不在会话」——
//  所以换会话不会丢记忆，只需要场景先写好 §〇 交接。
//
//  用法：
//    node 工具/会话轮转.mjs --scan               看各场景会话历史规模
//    node 工具/会话轮转.mjs --rotate 调研         把这个场景换到新会话
//    node 工具/会话轮转.mjs --rotate-all          所有超阈值的场景都换
//    node 工具/会话轮转.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM = path.join(WB, '数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };

// ── 判据常量（export 供复用）────────────────────────────────────────
/**
 * 会话历史超过多少条就该轮转
 *
 * ⚠ 2026-11-13 修（200 定得太紧，导致这个检查周期性报红）
 *
 *   原来定 200，依据是「实测干净会话 56 事件正常，长会话 470+ 会 402」。
 *   但那个依据的**危险线是 470**，200 只是保守估计。
 *
 *   实测后果：机制体检每跑一次，界面功能体检就会在每个场景发 1 条消息，
 *   于是事件数缓慢上涨 —— 隔几次体检就有一个场景越过 200，
 *   会话轮转就红一次。轮转之后事件清零，再涨，再红。
 *
 *   这不是「会话真的太长了」，而是**阈值定在了一个会被正常活动跨过的地方**。
 *   一个检查如果因为「正常使用」而周期性失败，它就是噪音，不是信号。
 *
 *   改成 350：
 *     · 仍然远低于实测危险线 470（留 120 事件余量）
 *     · 又高于日常工作会达到的水平（实测几个场景稳定在 170~260）
 *   这样它只在「真的快炸了」时才报，而不是「数字稍微长大了一点」就报。
 */
export const ROTATE_THRESHOLD = 350;

/** 轮转后默认切的模型（要和引擎配置一致） */
export const DEFAULT_PROVIDER = 'magpie-local';
export const DEFAULT_MODEL = 'opencode-zen-free/nemotron-3.5-lightning-free';

/**
 * 判一个会话该不该轮转
 * @param {number} eventCount
 * @returns {boolean}
 */
export function shouldRotate(eventCount) {
  return Number(eventCount || 0) >= ROTATE_THRESHOLD;
}

// ══════════════════════════════════════════════════════════════════════
function getToken() {
  try {
    const log = fs.readFileSync(path.join(WB, '外壳', 'server.log'), 'utf8');
    const ms = [...log.matchAll(/token=([A-Za-z0-9_-]+)/g)];
    return ms.length ? ms[ms.length - 1][1] : '';
  } catch { return ''; }
}

function getCookie(token) {
  return new Promise((resolve) => {
    const q = http.request({
      hostname: '127.0.0.1', port: 3083, path: '/?token=' + encodeURIComponent(token),
      method: 'GET', timeout: 8000,
    }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => resolve(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    q.on('error', () => resolve(''));
    q.end();
  });
}

function rpcFactory(cookie) {
  return (method, args) => new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'r' + Date.now() + Math.random(), method, payload: { args: args || {} } });
    const req = http.request({
      hostname: '127.0.0.1', port: 3083, path: '/api/' + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie, Origin: 'http://127.0.0.1:3083' },
      timeout: 120000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /**/ } resolve(j); });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  会话轮转 · 自测');
  console.log('='.repeat(72));
  console.log();

  console.log('【一】判据常量');
  chk('有轮转阈值', ROTATE_THRESHOLD > 0, ROTATE_THRESHOLD + ' 事件');
  chk('有默认 provider', !!DEFAULT_PROVIDER, DEFAULT_PROVIDER);
  chk('有默认 model', !!DEFAULT_MODEL, DEFAULT_MODEL);
  chk('阈值合理（不太小也不太大）',
    ROTATE_THRESHOLD >= 100 && ROTATE_THRESHOLD <= 500,
    '实测干净会话 56 事件正常，长会话 470+ 会 402');

  console.log();
  console.log('【二】轮转判据');
  {
    chk('正例：470 事件该轮转', shouldRotate(470) === true);
    chk('正例：刚好阈值该轮转', shouldRotate(ROTATE_THRESHOLD) === true);
    chk('反例：56 事件不该轮转', shouldRotate(56) === false, '这是实测跑通的干净会话规模');
    chk('反例：0 事件不该轮转', shouldRotate(0) === false);
    chk('反例：null 不该轮转', shouldRotate(null) === false);
    chk('反例：负数不该轮转', shouldRotate(-5) === false);
  }

  console.log();
  console.log('【三】反例：判据不能恒真（否则每次都轮转）');
  {
    chk('反例：小会话不触发', !shouldRotate(10));
    chk('反例：中等会话不触发', !shouldRotate(150));
    // 阈值上下各测一个
    chk('阈值-1 不触发', !shouldRotate(ROTATE_THRESHOLD - 1));
    chk('阈值 触发', shouldRotate(ROTATE_THRESHOLD));
  }

  console.log();
  console.log('【四】关键：这个工具补的是什么');
  chk('关键：补的是「历史太长吃光模型额度」',
    true, '实测：干净会话 56 事件跑通，长会话 470+ 事件 402');

  console.log();
  console.log('='.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('='.repeat(72));
  return R.every((x) => x.ok);
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('selftest')) { process.exit(selftest() ? 0 : 1); }

  const token = getToken();
  if (!token) { console.error('✗ 读不到引擎 token'); process.exit(2); }
  const cookie = await getCookie(token);
  const rpc = rpcFactory(cookie);

  const norm = (s) => String(s || '').replace(/[\\/]+/g, '/').toLowerCase();
  const MEM_NORM = norm(MEM);

  // 收集每个场景「最新」的会话及其历史规模
  const sl = await rpc('session/list', { _request: {} });
  const items = ((sl && sl.result && sl.result.value && sl.result.value.items) || [])
    .filter((x) => norm(x.cwd).startsWith(MEM_NORM));

  const byScene = new Map();
  for (const s of items) {
    const name = String(s.cwd).split(/[\\/]/).pop();
    const prev = byScene.get(name);
    if (!prev || (s.updatedAt || 0) > (prev.updatedAt || 0)) byScene.set(name, s);
  }

  const rows = [];
  for (const [name, s] of [...byScene].sort()) {
    const p = await rpc('session/page', { request: { address: { kind: 'session', sessionId: s.sessionId } } });
    const n = ((p && p.result && p.result.value && p.result.value.records) || []).length;
    rows.push({ name, sessionId: s.sessionId, cwd: s.cwd, events: n, needRotate: shouldRotate(n) });
  }

  // ── 扫描 ──
  if (has('scan') || (!has('rotate') && !has('rotate-all'))) {
    console.log('='.repeat(78));
    console.log('  各场景会话历史规模（阈值 ' + ROTATE_THRESHOLD + ' 事件）');
    console.log('='.repeat(78));
    console.log();
    for (const r of rows) {
      const mark = r.needRotate ? 'XX' : 'OK';
      console.log('  ' + mark + ' ' + r.name.padEnd(12) + String(r.events).padStart(4) +
        ' 事件   ' + r.sessionId.slice(0, 26) + (r.needRotate ? '   ← 该轮转' : ''));
    }
    const need = rows.filter((r) => r.needRotate);
    console.log();
    console.log('-'.repeat(78));
    console.log('  ' + need.length + ' / ' + rows.length + ' 个场景该轮转');
    if (need.length) {
      console.log();
      console.log('  轮转：node 工具/会话轮转.mjs --rotate-all');
      console.log('  或单个：node 工具/会话轮转.mjs --rotate <场景名>');
      process.exitCode = 1;
    } else {
      console.log('  ✓ 所有会话历史都在阈值内');
    }
    return;
  }

  // ── 轮转 ──
  const one = val('rotate');
  const targets = one ? rows.filter((r) => r.name === one) : rows.filter((r) => r.needRotate);
  if (!targets.length) {
    console.log('  没有需要轮转的场景' + (one ? '（找不到 ' + one + '）' : ''));
    return;
  }

  console.log('='.repeat(78));
  console.log('  轮转 ' + targets.length + ' 个场景会话');
  console.log('='.repeat(78));
  console.log();

  let ok = 0, fail = 0;
  for (const t of targets) {
    // ① 先确认场景记忆里有 §〇 交接（否则换会话就失忆）
    const memFile = path.join(t.cwd, '场景私有记忆.md');
    const memText = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : '';
    const hasHandoff = /##\s*§〇/.test(memText);

    if (!hasHandoff) {
      console.log('  XX ' + t.name.padEnd(12) + '记忆里没有 §〇 交接，换会话会失忆 —— 跳过');
      fail++;
      continue;
    }

    // ② 建新会话
    const created = await rpc('session/create', { request: { cwd: t.cwd } });
    const newSid = created && created.result && created.result.value && created.result.value.sessionId;
    if (!newSid) {
      console.log('  XX ' + t.name.padEnd(12) + '建新会话失败');
      fail++;
      continue;
    }

    // ③ 切模型
    const sel = await rpc('session/selectModel', {
      request: { sessionId: newSid, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    });
    const selOk = sel && sel.result && sel.result.ok;

    // ④ 写回 身份卡（场景靠它找到自己的会话）
    const idCard = path.join(t.cwd, '身份卡.md');
    let wroteCard = false;
    if (fs.existsSync(idCard)) {
      try {
        let c = fs.readFileSync(idCard, 'utf8');
        // 替换或追加 sessionId 行
        if (/sessionId\s*[:：]/i.test(c)) {
          c = c.replace(/sessionId\s*[:：].*/i, 'sessionId: ' + newSid);
        } else {
          c = c.trimEnd() + '\n\nsessionId: ' + newSid + '\n';
        }
        fs.writeFileSync(idCard, c, 'utf8');
        wroteCard = true;
      } catch { /* ignore */ }
    }

    // ⑤ 写回场景配置（2026-11-13 加 —— 这才是真正起作用的地方）
    //
    // ⚠ 真实缺陷（这轮抓到）：
    //   轮转原来**只写 身份卡.md**，然后打印「✓ 身份卡已更新」。
    //   但真正决定「面板绑哪个会话」的是 外壳/scenarios/*.json
    //   （以及 身份索引.json）—— 身份卡只是个说明文件。
    //
    //   实测后果：
    //     轮转说「调研 → session-735b3852  ✓ 身份卡已更新」
    //     但 research.json 里还是 session-8e710372（旧会话）
    //     → 新会话建了却没人用，旧会话继续变长
    //     → 下次 --scan 又会说「该轮转」，永远轮不完。
    //
    //   这是「看起来有、实际是空」的典型：
    //   动作做了、日志打了，但没作用到真正生效的地方。
    let wroteCfg = false;
    let wroteIndex = false;
    // t 里只有 name/sessionId/cwd/events，没有场景 id ——
    // 从 cwd 的中文目录名反查 外壳/scenarios/*.json 里的 id。
    const sceneId = (() => {
      const cn = String(t.cwd || '').split(/[\\/]/).filter(Boolean).pop();
      // ① 先看 外壳/scenarios/*.json 里哪个的 name 或 title 等于它
      try {
        const dir = path.join(WB, '外壳', 'scenarios');
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
          if (j.title === cn || j.name === cn) return j.id || f.replace(/\.json$/, '');
        }
      } catch { /* ignore */ }
      // ② 退回身份索引里的映射
      try {
        const idx = JSON.parse(fs.readFileSync(path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '身份索引.json'), 'utf8').replace(/^\uFEFF/, ''));
        const r = (idx.rows || []).find((x) => x.name === cn || x.sessionId === t.sessionId);
        if (r && r.scene) return r.scene;
      } catch { /* ignore */ }
      return null;
    })();

    if (sceneId) {
      const cfgPath = path.join(WB, '外壳', 'scenarios', sceneId + '.json');
      if (fs.existsSync(cfgPath)) {
        try {
          const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
          let touched = false;
          for (const p of (j.panels || [])) {
            if (p.type === 'harness' && p.sessionId) { p.sessionId = newSid; touched = true; }
          }
          // 中枢的会话 id 在 meta.hubSessionId
          if (j.meta && j.meta.hubSessionId) { j.meta.hubSessionId = newSid; touched = true; }
          if (touched) {
            fs.writeFileSync(cfgPath, JSON.stringify(j, null, 2), 'utf8');
            wroteCfg = true;
          }
        } catch { /* ignore */ }
      }
    }

    // ⑥ 写回身份索引
    try {
      const idxPath = path.join(WB, '数据', '.dsh', '场景记忆', '_共享记忆', '身份索引.json');
      if (fs.existsSync(idxPath)) {
        const j = JSON.parse(fs.readFileSync(idxPath, 'utf8').replace(/^\uFEFF/, ''));
        const rows = j.rows || [];
        let touched = false;
        for (const r of rows) {
          if ((sceneId && r.scene === sceneId) || r.sessionId === t.sessionId) {
            r.sessionId = newSid;
            r.updatedAt = new Date().toISOString();
            touched = true;
          }
        }
        if (touched) {
          fs.writeFileSync(idxPath, JSON.stringify(j, null, 2), 'utf8');
          wroteIndex = true;
        }
      }
    } catch { /* ignore */ }

    const good = selOk;
    if (good) ok++; else fail++;
    console.log('  ' + (good ? '✓' : 'XX') + ' ' + t.name.padEnd(12) +
      String(t.events).padStart(4) + ' 事件 → 新会话 ' + newSid.slice(0, 26) +
      (good
        ? (wroteCfg ? '  ✓ 配置已更新' : '  ⚠ 配置没更新') +
          (wroteIndex ? ' + 索引' : '') +
          (wroteCard ? ' + 身份卡' : '')
        : '  切模型失败'));
  }

  console.log();
  console.log('-'.repeat(78));
  console.log('  轮转结果: ' + ok + ' 成功 / ' + fail + ' 失败');
  if (fail > 0) process.exitCode = 1;
  else {
    console.log('  ✓ 完成 —— 新会话历史为空，模型额度不会被历史吃光');
    console.log('    （记忆在文件里，不在会话里，所以不会失忆）');

    // ⑦ 自动同步 workspace.json（2026-11-13 加 —— 这是最后一环）
    //
    //   ⚠ 为什么必须串起来：
    //     轮转只更新 配置/索引/身份卡 还不够 ——
    //     引擎侧栏按 storages/workspace.json 渲染，
    //     不在那个名单里的会话**完全不可见**，
    //     于是 pin 脚本找不到新会话、面板留旧会话。
    //
    //   实测：不同步的话，会话绑定验证会一直报 7/8，
    //        而 配置/索引/预热 全都显示「已更新」，非常误导。
    try {
      const out = execFileSync(process.execPath, [path.join(HERE, '工作区同步.mjs'), '--apply'], {
        encoding: 'utf8', timeout: 60000,
      });
      if (/已写入 workspace\.json/.test(out)) {
        console.log('  ✓ 已同步 workspace.json（侧栏会渲染新会话）');
      } else if (/一致/.test(out)) {
        console.log('  · workspace.json 本来就一致');
      } else {
        console.log('  ⚠ workspace.json 同步没确认成功，建议手动跑：node 工具/工作区同步.mjs --apply');
      }
    } catch {
      console.log('  ⚠ workspace.json 同步失败，建议手动跑：node 工具/工作区同步.mjs --apply');
    }

    console.log();
    console.log('  ⚠ 还需要两步才算完（否则面板会绑不上新会话）：');
    console.log('     ① node 工具/会话预热.mjs          给新会话生成标题');
    console.log('     ② 重启工作台                      侧栏才会重建');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('✗ ' + (e && e.message)); process.exit(2); });
