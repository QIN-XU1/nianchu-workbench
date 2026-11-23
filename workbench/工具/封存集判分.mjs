#!/usr/bin/env node
// 工具/封存集判分.mjs —— 用封存集考场景，产出机器可读的得分
//
// ══════════════════════════════════════════════════════════════════════
//  为什么需要这个工具（进化机制缺的一环）
// ══════════════════════════════════════════════════════════════════════
//  现状（2026-11-12 审计）：
//    · 封存集.mjs 能从真实记忆生成题目（--build）
//    · 进化.mjs 的 --observe 要求「--sealed-delta <数值> --samples <样本数>」
//      —— 即「封存集得分变化」
//    · **但没有任何工具负责「用封存集考场景、算出得分」**
//
//  结果：进化永远回填不了（一直是 pending），
//        因为 delta 无从计算。
//
//  这个工具补上那一环。
//
//  ══════════════════════════════════════════════════════════════════════
//  怎么判分（关键：不接受人工打分）
//  ══════════════════════════════════════════════════════════════════════
//  封存集每道题自带两道判据：
//    · 「必须包含」 —— 回答里必须出现的事实片段
//    · 「不应出现」 —— 回答里不能有的兜底话术（如「不知道」「没有记录」）
//
//  判分规则（纯机械，可复核）：
//    · 命中所有「必须包含」且不出现任何「不应出现」 → 该题得分 1
//    · 否则 0
//  得分 = 通过题数 / 总题数
//
//  为什么必须机械：2607.24300（6 模型 3 种子）证明 ——
//  Agent 同时控制「被优化对象」和「验证器」时，自评必然与真实性能脱钩。
//  所以这里**不接受任何人工指定的分数**，只认「字符串命中」这种可复核的事实。
//
//  ══════════════════════════════════════════════════════════════════════
//  两种考法
//  ══════════════════════════════════════════════════════════════════════
//    --mode memory   直接从场景记忆里找答案（考「记忆里有没有这件事」）
//                    快、免费、可离线。用来验证「记忆是否还在」。
//    --mode ai       真的让场景 agent 回答（考「它现在还能不能答对」）
//                    慢、要调模型。用来验证「进化是否真的变好」。
//
//  用法：
//    node 工具/封存集判分.mjs --scene 架构梳理              # memory 模式
//    node 工具/封存集判分.mjs --scene 架构梳理 --mode ai    # ai 模式（慢）
//    node 工具/封存集判分.mjs --all                        # 全部场景
//    node 工具/封存集判分.mjs --scene 架构梳理 --json        # 输出 JSON
//    node 工具/封存集判分.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { sceneNames } from './_场景清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');
const SEALED_DIR = path.join(DATA, '封存集');
const PORT = 3083;

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

// ⚠ 2026-11-14 改：不再硬编码，从 scenarios/*.json 动态读
const SCENES = sceneNames();

// ══════════════════════════════════════════════════════════════════════
//  读封存集
// ══════════════════════════════════════════════════════════════════════
function loadSealed(scene) {
  // ⚠ 2026-11-12：实际结构是 封存集/<场景>/cases.json
  //   （不是 封存集/<场景>.json；我第一版写错，导致全部报「无封存集」）
  const candidates = [
    path.join(SEALED_DIR, scene, 'cases.json'),   // ← 实际用的这个
    path.join(SEALED_DIR, scene + '.json'),       // 兼容单文件
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      const arr = Array.isArray(j) ? j : (j.cases || j.items || []);
      if (Array.isArray(arr)) return arr;
    } catch { /* 继续试下一个 */ }
  }
  return null;
}

function listSealedFiles() {
  if (!fs.existsSync(SEALED_DIR)) return [];
  return fs.readdirSync(SEALED_DIR).filter((f) => f.endsWith('.json'));
}

// ══════════════════════════════════════════════════════════════════════
//  判分核心（纯机械，可复核）
// ══════════════════════════════════════════════════════════════════════

/**
 * 判一道题
 * @param {object} c 用例 { must_include, must_not_include, ... }
 * @param {string} answer 回答文本
 * @returns {{ pass: boolean, hit: string[], miss: string[], bad: string[] }}
 */
export function judgeCase(c, answer) {
  const txt = String(answer || '');
  const must = c.must_include || c.mustInclude || [];
  const mustNot = c.must_not_include || c.mustNotInclude || c.distractor || [];

  const hit = [];
  const miss = [];
  for (const frag of must) {
    if (!frag) continue;
    if (txt.includes(frag)) hit.push(frag);
    else miss.push(frag);
  }

  const bad = [];
  for (const frag of mustNot) {
    if (!frag) continue;
    // distractor 可能是数组套数组
    const arr = Array.isArray(frag) ? frag : [frag];
    for (const f of arr) {
      if (f && txt.includes(f)) bad.push(f);
    }
  }

  return { pass: miss.length === 0 && bad.length === 0, hit, miss, bad };
}

/**
 * 给一个场景的封存集判分
 * @param {string} scene
 * @param {(q: string) => Promise<string>} answerFn 给一个问题，返回回答
 */
async function scoreScene(scene, answerFn) {
  const cases = loadSealed(scene);
  if (!cases || !cases.length) return { scene, total: 0, passed: 0, details: [], err: '无封存集' };

  const details = [];
  let passed = 0;
  for (const c of cases) {
    const q = c.question || c.q || c.prompt || '';
    let answer = '';
    try {
      answer = await answerFn(q, c);
    } catch (e) {
      answer = '';
    }
    const r = judgeCase(c, answer);
    if (r.pass) passed++;
    details.push({
      id: c.id || c.caseId || '?',
      question: q.slice(0, 60),
      pass: r.pass,
      miss: r.miss.map((x) => String(x).slice(0, 40)),
      bad: r.bad,
    });
  }
  return { scene, total: cases.length, passed, details };
}

// ══════════════════════════════════════════════════════════════════════
//  memory 模式：直接从记忆里找答案
//
//  这不是「作弊」——它考的是「记忆里还在不在」。
//  验证的是：进化之后，原本记住的事实有没有被弄丢。
//  如果 AI 进化把记忆改坏了，score 会掉。
// ══════════════════════════════════════════════════════════════════════
function memoryAnswerFn(scene) {
  const p = path.join(MEM, scene, '场景私有记忆.md');
  let memory = '';
  try { memory = fs.readFileSync(p, 'utf8'); } catch { memory = ''; }
  // 把整个记忆当答案（判分只看「必须包含」的片段在不在）
  return async () => memory;
}

// ══════════════════════════════════════════════════════════════════════
//  ai 模式：真的让场景 agent 回答
// ══════════════════════════════════════════════════════════════════════
function getToken() {
  const p = path.join(WB, '外壳', 'server.log');
  if (!fs.existsSync(p)) return null;
  const s = fs.readFileSync(p, 'utf8');
  const m = [...s.matchAll(/token=([A-Za-z0-9_-]{20,})/g)];
  return m.length ? m[m.length - 1][1] : null;
}

async function getCookie() {
  const token = getToken();
  if (!token) throw new Error('无 token');
  return await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT,
      path: '/?token=' + encodeURIComponent(token), method: 'GET', timeout: 8000,
    }, (res) => {
      const sc = res.headers['set-cookie'] || [];
      res.on('data', () => {});
      res.on('end', () => resolve(sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ')));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

function rpc(cookie, method, args, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'sc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      method, payload: { args: args || {} },
    });
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/api/' + method, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': cookie,
        'Origin': 'http://127.0.0.1:' + PORT,
      },
      timeout: timeoutMs || 60000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch { /* */ } resolve(j); });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function findSession(cookie, scene) {
  const r = await rpc(cookie, 'session/list', { _request: {} });
  const items = (r && r.result && r.result.value && r.result.value.items) || [];
  const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
  const target = norm(path.join(MEM, scene));
  const cands = items.filter((s) => norm(s.cwd) === target);
  const hit = cands.find((s) => !s.blank) || cands[0];
  return hit ? hit.sessionId : null;
}

async function aiAnswerFn(cookie, sessionId) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return async (question) => {
    // 记录基线
    let baseSeq = 0;
    {
      const pre = await rpc(cookie, 'session/page', { request: { address: { kind: 'session', sessionId } } });
      const pv = pre && pre.result && pre.result.value;
      if (pv && typeof pv.cursor === 'number') baseSeq = pv.cursor;
    }

    await rpc(cookie, 'session/prompt', {
      request: {
        requestId: 'sc-' + Date.now(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '【封存集测验，请直接回答，不要用工具，不要解释】\n' + question }],
      },
    });

    const deadline = Date.now() + 90000;
    let lastText = '';
    while (Date.now() < deadline) {
      await sleep(2000);
      const r = await rpc(cookie, 'session/page', { request: { address: { kind: 'session', sessionId } } });
      const v = r && r.result && r.result.value;
      if (!v) continue;
      const recs = (v.records || []).map((x) => x && x.event ? x.event : x).filter(Boolean);
      const aiMsgs = recs.filter((e) => e.type === 'assistant/message' && e.seq > baseSeq);
      if (aiMsgs.length) {
        const msg = aiMsgs[aiMsgs.length - 1].data.message || {};
        const t = (msg.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
        if (t.trim()) lastText = t;
      }
      const last = recs[recs.length - 1];
      if (last && last.type === 'turn/end' && last.seq > baseSeq) break;
    }
    return lastText;
  };
}

// ══════════════════════════════════════════════════════════════════════
//  自测（含反例）
// ══════════════════════════════════════════════════════════════════════
async function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  封存集判分 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】判分核心');
  const c1 = { must_include: ['A', 'B'], must_not_include: ['不知道'] };
  chk('正例：全命中且无兜底话术 → 通过', judgeCase(c1, '这里 A 和 B 都有').pass);
  chk('反例：缺一个必须包含 → 不通过', !judgeCase(c1, '这里只有 A').pass);
  chk('反例：出现兜底话术 → 不通过', !judgeCase(c1, 'A B 但是不知道').pass);
  chk('反例：空回答 → 不通过', !judgeCase(c1, '').pass);

  console.log();
  console.log('【二】distractor 数组套数组（封存集实际格式）');
  const c2 = { must_include: ['职责'], distractor: [['不知道', '不清楚'], ['没有记录']] };
  chk('正例：只说职责 → 通过', judgeCase(c2, '我的职责是分析').pass);
  chk('反例：说了「不清楚」→ 不通过', !judgeCase(c2, '职责不清楚').pass);
  chk('反例：说了「没有记录」→ 不通过', !judgeCase(c2, '职责 没有记录').pass);

  console.log();
  console.log('【三】不能人工指定分数');
  // 判分函数只接受 (用例, 回答)，没有任何「分数」入参
  chk('judgeCase 参数只有 2 个（用例+回答）', judgeCase.length === 2,
    'length=' + judgeCase.length);

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) process.exitCode = 1;
  console.log('═'.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════════
async function main() {
  if (has('selftest')) { await selftest(); return; }

  const mode = String(val('mode', 'memory'));
  const scene = val('scene', null);
  const all = has('all');
  const asJson = has('json');

  if (!scene && !all) {
    console.log('封存集判分 —— 用封存集考场景，产出机器可读的得分');
    console.log();
    console.log('为什么：进化.mjs 的 --observe 需要 --sealed-delta（封存集得分变化），');
    console.log('        但之前没有工具算这个分数 → 进化永远回填不了。');
    console.log();
    console.log('用法:');
    console.log('  node 工具/封存集判分.mjs --scene 架构梳理              # memory 模式（快，免费）');
    console.log('  node 工具/封存集判分.mjs --scene 架构梳理 --mode ai    # ai 模式（慢，要调模型）');
    console.log('  node 工具/封存集判分.mjs --all                        # 全部场景');
    console.log('  node 工具/封存集判分.mjs --all --json                 # JSON 输出');
    console.log('  node 工具/封存集判分.mjs --selftest');
    return;
  }

  const targets = all ? SCENES : [scene];
  const results = [];

  let aiCookie = null;
  let aiSession = null;
  if (mode === 'ai') {
    aiCookie = await getCookie();
    if (!aiCookie) { console.error('拿不到 cookie（引擎没起？）'); process.exit(1); }
  }

  for (const s of targets) {
    let answerFn;
    if (mode === 'ai') {
      aiSession = await findSession(aiCookie, s);
      if (!aiSession) { results.push({ scene: s, total: 0, passed: 0, err: '无会话' }); continue; }
      answerFn = await aiAnswerFn(aiCookie, aiSession);
    } else {
      answerFn = memoryAnswerFn(s);
    }

    const r = await scoreScene(s, answerFn);
    results.push(r);

    if (!asJson) {
      const pct = r.total ? Math.round(r.passed / r.total * 100) : 0;
      console.log('  ' + (r.total && r.passed === r.total ? 'OK' : 'XX') + ' ' +
        s.padEnd(10) + ' ' + r.passed + '/' + r.total + '  (' + pct + '%)' +
        (r.err ? '  ' + r.err : ''));
      if (r.details) {
        for (const d of r.details.filter((x) => !x.pass)) {
          console.log('       ✗ [' + d.id + '] ' + d.question);
          if (d.miss.length) console.log('          缺: ' + d.miss.join(', '));
          if (d.bad.length) console.log('          多: ' + d.bad.join(', '));
        }
      }
    }
  }

  if (asJson) {
    const totalQ = results.reduce((a, b) => a + (b.total || 0), 0);
    const totalP = results.reduce((a, b) => a + (b.passed || 0), 0);
    const delta = totalQ ? Math.round(totalP / totalQ * 1000) / 10 : 0;
    console.log(JSON.stringify({
      mode,
      scenes: results.map((r) => ({ scene: r.scene, passed: r.passed, total: r.total })),
      total: { passed: totalP, questions: totalQ, score: delta },
    }, null, 2));
  } else {
    const totalQ = results.reduce((a, b) => a + (b.total || 0), 0);
    const totalP = results.reduce((a, b) => a + (b.passed || 0), 0);
    console.log();
    console.log('─'.repeat(72));
    console.log('  合计: ' + totalP + ' / ' + totalQ +
      '  (' + (totalQ ? Math.round(totalP / totalQ * 100) : 0) + '%)   模式: ' + mode);

    // ══════════════════════════════════════════════════════════
    //  落盘基线：给 进化.mjs --observe 提供 sealed-delta 的计算依据
    //
    //  为什么必须落盘：
    //    进化回填要求 --sealed-delta（得分变化），
    //    而 delta 需要「本次得分」减「上次得分」。
    //    没有基线就永远算不出 delta，进化永远回填不了。
    // ══════════════════════════════════════════════════════════
    const histFile = path.join(DATA, '封存集历史.json');
    let hist = { runs: [] };
    try {
      if (fs.existsSync(histFile)) hist = JSON.parse(fs.readFileSync(histFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch { hist = { runs: [] }; }
    if (!Array.isArray(hist.runs)) hist.runs = [];

    const score = totalQ ? Math.round(totalP / totalQ * 1000) / 10 : 0;
    const prev = hist.runs.length ? hist.runs[hist.runs.length - 1] : null;
    const delta = prev ? Math.round((score - prev.score) * 10) / 10 : null;

    hist.runs.push({
      at: new Date().toISOString(),
      mode,
      score,
      passed: totalP,
      questions: totalQ,
      perScene: results.map((r) => ({ scene: r.scene, passed: r.passed, total: r.total })),
    });
    // 只留最近 100 次
    if (hist.runs.length > 100) hist.runs = hist.runs.slice(-100);
    try {
      fs.writeFileSync(histFile, JSON.stringify(hist, null, 2), 'utf8');
      console.log('  已记入历史: ' + path.relative(WB, histFile));
      if (delta !== null) console.log('  sealed-delta（相比上次）: ' + (delta >= 0 ? '+' : '') + delta + ' 分');
      else console.log('  （首次记录，无基线可比）');
    } catch (e) {
      console.log('  ⚠ 历史落盘失败: ' + ((e && e.message) || e));
    }
  }
}

main().catch((e) => {
  console.error('  ✗ ' + ((e && e.stack) || e));
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 150);
});
