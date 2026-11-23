#!/usr/bin/env node
/**
 * 场景记忆填充 —— 用真实 AI 把空骨架填成有内容的记忆
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要（封存集检查暴露的真实问题）
 * ══════════════════════════════════════════════════════════════
 *
 *  从真实记忆生成封存集，发现：
 *    本地电脑  事实 0 条 → 用例 0 题
 *    自我复盘  事实 0 条 → 用例 0 题
 *
 *  打开一看，记忆是空骨架：
 *    - 负责：（待补）
 *    - 不碰：（待补）
 *
 *  这两个场景从来没被真正使用过。
 *
 *  但它们的职责信息其实存在（scenarios/*.json、*-context.md），
 *  只是没写进记忆。可以用真实 AI 把上下文提炼成记忆。
 *
 * ══════════════════════════════════════════════════════════════
 *  设计要点
 * ══════════════════════════════════════════════════════════════
 *
 *  1. 只填「事实性内容」，不编造经验
 *     经验（§五）必须来自真实踩坑，不能让 AI 虚构。
 *     所以这一步只填：核心职责、职责边界、现状/接口。
 *
 *  2. 给 AI 的输入是真实文件内容（context.md + scenario.json）
 *     不让它自由发挥。
 *
 *  3. 用记忆写入协议写入（ADD/UPDATE/NOOP）
 *     避免重复灌水。
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
const PORT = 3083;

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
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
      timeout: 180000,
    }, (re) => { let b = ''; re.on('data', (c) => { b += c; }); re.on('end', () => res({ h: re.headers, b })); });
    r.on('error', () => res({ h: {}, b: '' }));
    r.on('timeout', () => { r.destroy(); res({ h: {}, b: '' }); });
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
//  判断某场景记忆是不是空骨架
// ══════════════════════════════════════════════════════════════
export function isSkeleton(md) {
  const s = String(md || '');
  const hasDutyPlaceholder = /负责[：:]\s*[（(]?待补/.test(s);
  const hasBoundaryPlaceholder = /不碰[：:]\s*[（(]?待补/.test(s);
  const noPits = !/^-\s+\d{4}-\d{2}-\d{2}/m.test(s);
  return hasDutyPlaceholder && hasBoundaryPlaceholder && noPits;
}

// ══════════════════════════════════════════════════════════════
//  收集某场景的真实上下文（喂给 AI 当输入）
// ══════════════════════════════════════════════════════════════
export function collectContext(sceneId, sceneName) {
  const parts = [];

  const ctxFile = path.join(SCEN_DIR, sceneId + '-context.md');
  const ctx = readTextSafe(ctxFile);
  if (ctx) {
    parts.push('【定位卡 ' + sceneId + '-context.md】');
    parts.push(ctx.slice(0, 2000));
    parts.push('');
  }

  const scenFile = path.join(SCEN_DIR, sceneId + '.json');
  const sj = readTextSafe(scenFile);
  if (sj) {
    try {
      const j = JSON.parse(sj);
      parts.push('【场景配置】');
      parts.push('名称: ' + (j.name || ''));
      parts.push('描述: ' + (j.description || ''));
      if (j.panels) {
        parts.push('面板: ' + j.panels.map((p) => p.id + '(' + p.type + ')').join(' · '));
      }
      parts.push('');
    } catch { /* ignore */ }
  }

  return parts.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  构造填充任务
// ══════════════════════════════════════════════════════════════
export function buildFillPrompt(sceneName, context) {
  return [
    '【场景记忆填充任务】',
    '',
    '你的场景记忆目前是空骨架（负责/不碰都是"待补"）。',
    '现在把它填成有实质内容的样子。',
    '',
    '## 下面是你这个场景的真实资料（不是我编的）',
    '',
    context,
    '',
    '## 你的任务',
    '',
    '根据上面的真实资料，用 write 或 edit 工具修改你的场景私有记忆文件：',
    '`数据/.dsh/场景记忆/' + sceneName + '/场景私有记忆.md`',
    '',
    '需要填的三处：',
    '',
    '1. **## 核心职责** 里的两行：',
    '   - 负责：<根据资料，一句话说清你负责什么>',
    '   - 不碰：<根据资料里的"不碰什么"，列出边界>',
    '',
    '2. **## 一、职责边界**：',
    '   把"（待填）"换成具体的边界说明（3-5 条，每条一行）',
    '',
    '3. **## 二、现状 / 接口**：',
    '   如果有上游输入和产出，补上；没有就写"（无）"',
    '',
    '## 硬要求',
    '',
    '- 只用资料里有的信息，**不许编造**',
    '- 不要碰 §五 坑与决策（那里只能记真实踩过的坑，不能虚构）',
    '- 不要碰 §〇 当前交接',
    '- 改完用一两句话告诉我你写了什么',
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  场景记忆填充 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 空骨架识别
  const skeleton = '# 测试\n\n## 核心职责\n\n- 负责：（待补）\n- 不碰：（待补）\n\n## 五、坑与决策\n\n- （只追加）\n';
  chk('能识别空骨架', isSkeleton(skeleton) === true, 'true');

  const filled = '# 测试\n\n## 核心职责\n\n- 负责：把三路输入合成架构方案\n- 不碰：不写代码\n\n## 五、坑与决策\n\n- 2026-11-09：**真实经验**\n';
  chk('有内容的不算空骨架', isSkeleton(filled) === false, 'false');

  const halfFilled = '# 测试\n\n## 核心职责\n\n- 负责：把三路输入合成架构方案\n- 不碰：（待补）\n';
  chk('半填充不算空骨架（只补缺的）', isSkeleton(halfFilled) === false, 'false');

  // ② 反例：有经验但职责待补 → 不算空骨架（因为已经有真实内容）
  const hasPitOnly = '## 核心职责\n\n- 负责：（待补）\n- 不碰：（待补）\n\n## 五、坑与决策\n\n- 2026-11-09：**真的有经验**\n';
  chk('反例：有经验就不算空骨架', isSkeleton(hasPitOnly) === false, 'false');

  // ③ 上下文收集
  const ctx = collectContext('pc-cleanup', '本地电脑');
  chk('能收集到定位卡', ctx.includes('定位卡') || ctx.includes('本地电脑'), ctx.length + ' 字符');
  chk('上下文非空', ctx.length > 100, ctx.length + ' 字符');

  // ④ prompt 构造
  const prompt = buildFillPrompt('测试场景', '这是资料');
  chk('prompt 含场景名', prompt.includes('测试场景'), '');
  chk('prompt 含硬要求', prompt.includes('不许编造'), '');
  chk('prompt 明确不动 §五', prompt.includes('不要碰 §五'), '');

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

  // 找出空骨架场景
  const scenes = [];
  if (fs.existsSync(MEM_ROOT)) {
    for (const d of fs.readdirSync(MEM_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue;
      const f = path.join(MEM_ROOT, d.name, '场景私有记忆.md');
      const md = readTextSafe(f);
      if (md && isSkeleton(md)) scenes.push(d.name);
    }
  }

  console.log('═'.repeat(72));
  console.log('  场景记忆填充');
  console.log('═'.repeat(72));
  console.log();

  if (scenes.length === 0) {
    console.log('  没有空骨架场景，无需填充。');
    process.exit(0);
  }

  console.log('  空骨架场景: ' + scenes.join(', '));
  console.log();

  if (!has('--apply')) {
    // 场景名 → id
    const nameToIdPreview = {};
    for (const f of fs.readdirSync(SCEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(readTextSafe(path.join(SCEN_DIR, f)));
        if (j.name) nameToIdPreview[j.name] = j.id;
      } catch { /* ignore */ }
    }

    for (const name of scenes) {
      const sceneId = nameToIdPreview[name] || '';
      const ctx = sceneId ? collectContext(sceneId, name) : '';
      console.log('  ' + name + '（' + sceneId + '）: 可收集上下文 ' + ctx.length + ' 字符');
    }
    console.log();
    console.log('  （预览。加 --apply 真的用 AI 填充）');
    process.exit(0);
  }

  // 真的填充
  const ok = await connect();
  if (!ok) { console.error('✗ 连不上引擎'); process.exit(2); }

  // 场景名 → id
  const nameToId = {};
  for (const f of fs.readdirSync(SCEN_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readTextSafe(path.join(SCEN_DIR, f)));
      if (j.name) nameToId[j.name] = j.id;
    } catch { /* ignore */ }
  }

  let done = 0;
  let fail = 0;

  for (const name of scenes) {
    const sceneId = nameToId[name];
    if (!sceneId) { console.log('  ✗ ' + name + ': 找不到场景 id'); fail++; continue; }

    const ctx = collectContext(sceneId, name);
    console.log('  ' + name + '（' + sceneId + '）上下文 ' + ctx.length + ' 字符');

    // 找/建该场景的会话
    const list = await rpc('session', 'list', { _request: {} });
    const items = list?.result?.value?.items || [];
    const norm = (p) => String(p || '').split('\\').join('/').toLowerCase();
    const wantDir = norm(path.join(MEM_ROOT, name));
    let sess = items.filter((s) => norm(s.cwd) === wantDir)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];

    let sid = sess?.sessionId;
    if (!sid) {
      const created = await rpc('session', 'create', { request: { cwd: path.join(MEM_ROOT, name) } });
      sid = created?.result?.value?.sessionId;
      if (!sid) { console.log('    ✗ 建会话失败'); fail++; continue; }
    }

    // 切到 pursueray
    await rpc('session', 'selectModel', {
      request: { sessionId: sid, provider: 'pursueray', model: 'deepseek-v4-pro' },
    });

    // 发任务
    const prompt = buildFillPrompt(name, ctx);
    await rpc('session', 'prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: sid,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      },
    });

    console.log('    已投递，等 AI 执行…');

    // 等记忆文件变化
    const memFile = path.join(MEM_ROOT, name, '场景私有记忆.md');
    const before = fs.readFileSync(memFile, 'utf8');
    let changed = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (fs.readFileSync(memFile, 'utf8') !== before) { changed = true; break; }
      if (i % 6 === 0) process.stdout.write('      … ' + ((i + 1) * 5) + 's\n');
    }

    if (changed) {
      const after = fs.readFileSync(memFile, 'utf8');
      console.log('    ✓ 已填充（' + Buffer.byteLength(before, 'utf8') + ' B → ' +
        Buffer.byteLength(after, 'utf8') + ' B）');
      done++;
    } else {
      console.log('    ✗ 记忆未变');
      fail++;
    }
  }

  console.log();
  console.log('═'.repeat(72));
  console.log('  成功 ' + done + ' / 失败 ' + fail);
  console.log('═'.repeat(72));
  process.exit(fail > 0 ? 1 : 0);
}
