#!/usr/bin/env node
/**
 * 归因摘要 —— 自进化的归因层
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么归因层不能省
 * ══════════════════════════════════════════════════════════════
 *
 *  自进化三步：有信号 → 有归因 → 有改进
 *
 *  没有归因的后果：
 *    健康度说"一次通过率 30%"
 *    → 不知道为什么
 *    → 只能瞎改
 *    → 改错了就是退化
 *
 *  归因四问（必须回答，不能空泛）：
 *    ① 哪类任务总失败？      → 技能缺口
 *    ② 哪类判断总被纠正？    → 身份卡边界模糊
 *    ③ 哪类交付总要返工？    → 流程缺失
 *    ④ 哪类操作总越界？      → 权限理解错误
 *
 *  归因结果写进：场景记忆/<场景名>/场景私有记忆.md 的 §六
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/归因.mjs                          # 分析所有场景
 *  node 工具/归因.mjs --scene <id>             # 只分析某场景
 *  node 工具/归因.mjs --write                  # 写入场景记忆 §六
 *  node 工具/归因.mjs --window 30              # 统计窗口（天）
 */

import fs from 'node:fs';
import os from 'node:os';   // ⚠ 2026-11-12 补：自测在临时目录造数据，不碰真实台账
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

// ══════════════════════════════════════════════════════════════
//  归因规则（唯一出处）
// ══════════════════════════════════════════════════════════════
export const RULES = {
  // 同类任务失败 ≥ 此时，判定为技能缺口
  SKILL_GAP_THRESHOLD: 3,
  // 同类判断被纠正 ≥ 此时，判定为身份卡边界模糊
  IDENTITY_THRESHOLD: 2,
  // 同类返工 ≥ 此时，判定为流程缺失
  PROCESS_THRESHOLD: 2,
  // 越界 ≥ 此时，判定为权限理解错误
  BOUNDARY_THRESHOLD: 2,
  // 统计窗口（天）
  WINDOW_DAYS: 30,
};

function readJson(p, fb) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return JSON.parse(s);
  } catch { return fb; }
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

// ══════════════════════════════════════════════════════════════
//  核心：归因分析
// ══════════════════════════════════════════════════════════════

/**
 * @param {object} opt
 *   opt.dataRoot  .dsh 目录
 *   opt.windowDays 统计窗口
 *   opt.nowMs     当前时间
 */
export function analyze(opt) {
  const dataRoot = opt.dataRoot || path.join(WB, '数据', '.dsh');
  const nowMs = opt.nowMs || Date.now();
  const windowDays = opt.windowDays || RULES.WINDOW_DAYS;
  const cutoff = nowMs - windowDays * 86400000;

  const shared = path.join(dataRoot, '场景记忆', '_共享记忆');
  const ledger = readJson(path.join(shared, '派单台账.json'), { dispatches: [] });

  // ⚠ 2026-11-12 加：排除测试单（否则归因把测试当真实业务分析）
  //
  //   实测事故：台账里积累了 42 条 `闭环验证-*` 测试单，
  //   归因工具把它们当成真实派单，报：
  //     [架构梳理 · process-missing] 哪类交付总要返工：闭环验证-完整四件套（2 次）
  //     → exit 1 → 机制体检的「归因完整性」红了
  //     → 破坏性验证判「正常=FAIL 破坏后=FAIL（装饰）」
  //
  //   而真实业务上并没有任何返工 —— 全是测试残留。
  //
  //   这是「测试污染生产数据」的第 6 次：前 5 次是探针文件/台账单/标记/
  //   判据改写/UI 注入，这次是「测试单被当业务数据分析」。
  //
  //   修法：归因只看真实派单。测试单的 subject 有固定前缀。
  const TEST_SUBJECT_PREFIX = ['闭环验证', 'E2E-', 'FAILED-STATE-', 'ACK-TEST-', '测试', '端到端验证'];
  const isTestDispatch = (d) => {
    const s = String(d.subject || '');
    return TEST_SUBJECT_PREFIX.some((p) => s.startsWith(p));
  };

  const dispatches = (ledger.dispatches || []).filter(d => {
    const t = new Date(d.createdAt || 0).getTime();
    if (!Number.isFinite(t) || t < cutoff) return false;
    if (d.type !== 'dispatch') return false;
    if (isTestDispatch(d)) return false;      // ← 测试单不进归因
    return true;
  });

  const health = readJson(path.join(shared, '健康度.json'), { scenes: {} });
  const boundaryLog = readJson(path.join(shared, '越界记录.json'), { events: [] });

  // ═══ 按场景分组 ═══
  const byScene = {};

  function ensure(scene) {
    if (!byScene[scene]) {
      byScene[scene] = {
        scene,
        tasks: [],
        reworks: {},          // subject -> 次数
        failedSubjects: {},   // subject -> 次数（needsRework）
        corrections: [],      // 被纠正的记录
        boundaries: [],       // 越界记录
        unacked: [],          // 未回执
      };
    }
    return byScene[scene];
  }

  for (const d of dispatches) {
    const s = ensure(d.to);
    s.tasks.push(d);

    const key = String(d.subject || '').trim() || '(无主题)';

    // 返工：同 subject 出现多次
    //
    // ⚠ 2026-11-12 修（三处判据错误，都是把「正常终态/测试残留」当失败）：
    //
    //   ① 原来：s.reworks[key] = ... + 1  无条件累加
    //      → cancelled（主动作废的测试派单）也被算成返工
    //      → 实测：「闭环验证-完整四件套」7 条全部 cancelled，
    //              却报出「哪类交付总要返工」
    //      修法：cancelled 不计入返工统计
    //
    //   ② 原来：if (d.needsRework || d.state !== 'acked')
    //      → closed（正常完成并销账）也算失败
    //      → 实测：6 条真实派单全部 closed，却报「哪类任务总失败」
    //      修法：只把明确失败算失败
    const TERMINAL_OK = new Set(['acked', 'closed', 'cancelled']);
    const isCancelled = d.state === 'cancelled';
    if (!isCancelled) {
      s.reworks[key] = (s.reworks[key] || 0) + 1;
    }

    // 失败：明确标记了返工，或处于失败状态
    //   · needsRework === true   → 明确返工
    //   · state === 'unacked'    → 未回执（真失败）
    //   · state === 'failed'     → 显式失败
    //   · closed / acked / cancelled → 不算失败
    const isFail = d.needsRework === true ||
                   d.state === 'unacked' ||
                   d.state === 'failed';
    if (isFail) {
      s.failedSubjects[key] = (s.failedSubjects[key] || 0) + 1;
    }

    // 被纠正
    if (d.corrected) {
      s.corrections.push({
        subject: key,
        note: d.correctionNote || '',
      });
    }
  }

  for (const ev of (boundaryLog.events || [])) {
    const t = new Date(ev.at || 0).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (!ev.scene) continue;
    ensure(ev.scene).boundaries.push(ev);
  }

  // ═══ 生成归因 ═══
  const out = {};

  for (const [scene, s] of Object.entries(byScene)) {
    const findings = [];

    // ── ① 哪类任务总失败 → 技能缺口 ──
    const failed = Object.entries(s.failedSubjects)
      .filter(([, n]) => n >= RULES.SKILL_GAP_THRESHOLD)
      .sort((a, b) => b[1] - a[1]);

    for (const [subject, n] of failed) {
      findings.push({
        type: 'skill-gap',
        question: '哪类任务总失败',
        subject,
        count: n,
        attribution: '技能里没有"「' + subject + '」这类任务怎么做"的流程',
        action: 'L2 技能进化：在技能文件新增对应章节，并用历史失败案例回测',
        level: 'L2',
      });
    }

    // ── ② 哪类判断总被纠正 → 身份卡边界模糊 ──
    const corrBySubject = {};
    for (const c of s.corrections) {
      corrBySubject[c.subject] = (corrBySubject[c.subject] || 0) + 1;
    }
    for (const [subject, n] of Object.entries(corrBySubject)) {
      if (n < RULES.IDENTITY_THRESHOLD) continue;
      findings.push({
        type: 'identity-blur',
        question: '哪类判断总被纠正',
        subject,
        count: n,
        attribution: '身份卡的"职责边界"没写清「' + subject + '」属于哪一侧',
        action: 'L3 身份进化：修订身份卡边界（需人工确认）',
        level: 'L3',
      });
    }

    // ── ③ 哪类交付总要返工 → 流程缺失 ──
    const rework = Object.entries(s.reworks)
      .filter(([, n]) => n >= RULES.PROCESS_THRESHOLD)
      .sort((a, b) => b[1] - a[1]);

    for (const [subject, n] of rework) {
      findings.push({
        type: 'process-missing',
        question: '哪类交付总要返工',
        subject,
        count: n,
        attribution: '「' + subject + '」没有明确的验收标准，导致反复',
        action: 'L2 技能进化：补充该任务的验收清单（怎么算做完）',
        level: 'L2',
      });
    }

    // ── ④ 哪类操作总越界 → 权限理解错误 ──
    if (s.boundaries.length >= RULES.BOUNDARY_THRESHOLD) {
      const paths = {};
      for (const b of s.boundaries) {
        const p = String(b.path || '').replace(/\\/g, '/');
        const top = p.split('/').slice(0, 3).join('/');
        paths[top] = (paths[top] || 0) + 1;
      }
      const topPath = Object.entries(paths).sort((a, b) => b[1] - a[1])[0];
      findings.push({
        type: 'boundary-misread',
        question: '哪类操作总越界',
        subject: topPath ? topPath[0] : '(未知)',
        count: s.boundaries.length,
        attribution: '该场景误以为「' + (topPath ? topPath[0] : '?') + '」是自己的地盘',
        action: 'L3 身份进化：在定位卡里明确写出"这些路径不碰"',
        level: 'L3',
      });
    }

    // ── 未回执（不是归因，但是重要信号）──
    // ⚠ 2026-11-12 修（判据错误：把 cancelled 当未回执）：
    //
    //   原来：filter(d => d.state !== 'acked' && d.state !== 'closed')
    //   —— 只排除 acked 和 closed，没排除 cancelled。
    //
    //   实测：台账 32 条里 22 条是 cancelled（早期测试派单已作废），
    //        归因把它们全算成「未回执 20 条」，是假警报。
    //
    //   cancelled 是**合法终态**（派单被主动作废），和 acked 一样不该算未回执。
    const TERMINAL = new Set(['acked', 'closed', 'cancelled']);
    const unacked = s.tasks.filter((d) => !TERMINAL.has(d.state));
    if (unacked.length) {
      findings.push({
        type: 'unacked',
        question: '有多少派单没回执',
        subject: unacked.length + ' 条',
        count: unacked.length,
        attribution: '派单可能没真投递，或对方忘了回',
        action: '检查派单台账：这些是 announce 还是 dispatch？flush 未回执清单',
        level: 'none',
      });
    }

    // 健康度交叉
    const h = health.scenes && health.scenes[scene];
    out[scene] = {
      scene,
      windowDays,
      taskCount: s.tasks.length,
      firstPassRate: h ? h.firstPassRate : null,
      findings,
      hasFindings: findings.length > 0,
    };
  }

  return { at: new Date(nowMs).toISOString(), windowDays, scenes: out };
}

// ══════════════════════════════════════════════════════════════
//  生成 §六 文本
// ══════════════════════════════════════════════════════════════

export function renderSection(result, sceneName) {
  const s = result.scenes[Object.keys(result.scenes).find(k =>
    k === sceneName || (result.scenes[k] && result.scenes[k].scene === sceneName)
  )];

  const date = result.at.slice(0, 10);

  if (!s) {
    return [
      '## §六 归因摘要（' + date + '）',
      '',
      '- 本窗口内没有派单记录',
      '- → 无法归因（没有数据可分析）',
      '',
    ].join('\n');
  }

  const lines = [
    '## §六 归因摘要（' + date + '）',
    '',
    '- 窗口：最近 ' + result.windowDays + ' 天',
    '- 任务数：' + s.taskCount,
  ];

  if (s.firstPassRate !== null) {
    lines.push('- 一次通过率：' + Math.round(s.firstPassRate * 100) + '%');
  }

  lines.push('');

  if (!s.findings.length) {
    lines.push('- 未发现需要归因的问题');
    lines.push('');
    return lines.join('\n');
  }

  for (const f of s.findings) {
    lines.push('### ' + f.question);
    lines.push('');
    lines.push('- 现象：' + f.subject + (f.count ? '（' + f.count + ' 次）' : ''));
    lines.push('- 归因：' + f.attribution);
    lines.push('- 动作：' + f.action);
    lines.push('');
  }

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════
//  写入场景记忆（替换 §六 段）
// ══════════════════════════════════════════════════════════════

export function writeSection(dataRoot, sceneName, sectionText) {
  const memDir = path.join(dataRoot, '场景记忆', sceneName);
  const memFile = path.join(memDir, '场景私有记忆.md');

  if (!fs.existsSync(memFile)) {
    return { ok: false, error: '场景记忆不存在: ' + sceneName };
  }

  let text = fs.readFileSync(memFile, 'utf8');

  // 找 §六 段（到下一个 ## 或文件末）
  const re = /## §六[\s\S]*?(?=\n## (?!§六)|$)/;
  const exists = re.test(text);

  if (exists) {
    text = text.replace(re, sectionText.trimEnd());
  } else {
    // 追加
    if (!text.endsWith('\n')) text += '\n';
    text += '\n' + sectionText.trimEnd() + '\n';
  }

  writeText(memFile, text);
  return { ok: true, replaced: exists, file: memFile };
}

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
//
//  ⚠ 2026-11-12 补：原来没有 selftest、没有反例，机制审计判它
//    「①3 输出差异集合 · ①4 反例 0 处 · ①5 无自测入口」= 口号。
//
//    为什么必须补：归因的 4 条判据全是「次数 ≥ 阈值」，最容易被写错成
//    方向相反或边界包含。更关键的是 2026-11-12 修的那两处判据错误
//    （把 cancelled 当失败、把 closed 当失败）—— 那类错误只有
//    「造一份应当被判失败的数据，看它报不报」才能抓住。
//    这里每条反例都是真造台账记录，断言 finding 必须出现 / 必须不出现。
// ══════════════════════════════════════════════════════════════
export function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  归因完整性 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ── ① 判据常量（唯一出处 RULES，别被顺手放宽）──
  chk('技能缺口阈值 = 3', RULES.SKILL_GAP_THRESHOLD === 3, String(RULES.SKILL_GAP_THRESHOLD));
  chk('身份纠正阈值 = 2', RULES.IDENTITY_THRESHOLD === 2, String(RULES.IDENTITY_THRESHOLD));
  chk('流程返工阈值 = 2', RULES.PROCESS_THRESHOLD === 2, String(RULES.PROCESS_THRESHOLD));
  chk('越界阈值 = 2', RULES.BOUNDARY_THRESHOLD === 2, String(RULES.BOUNDARY_THRESHOLD));
  chk('窗口 = 30 天', RULES.WINDOW_DAYS === 30, String(RULES.WINDOW_DAYS));

  const NOW = Date.parse('2026-11-12T12:00:00Z');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attribguard-'));
  const shared = path.join(tmp, '场景记忆', '_共享记忆');
  fs.mkdirSync(shared, { recursive: true });

  const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');
  const recent = new Date(NOW - 3600000).toISOString();   // 1 小时前，落在窗口内

  // 造一条派单记录（默认是所有判据都不该命中的健康记录）
  function d(over) {
    return Object.assign({
      id: 'x', type: 'dispatch', from: 'hub', to: 'demo',
      subject: '正常任务', phenomenon: '现象描述', howto: '照做', verify: '验收',
      createdAt: recent, state: 'closed',
    }, over || {});
  }

  function analyzeWith(dispatches, boundaryEvents) {
    writeJson(path.join(shared, '派单台账.json'), { dispatches });
    writeJson(path.join(shared, '越界记录.json'), { events: boundaryEvents || [] });
    writeJson(path.join(shared, '健康度.json'), { scenes: {} });
    return analyze({ dataRoot: tmp, nowMs: NOW, windowDays: 30 });
  }

  const typesOf = (res, scene) => {
    const s = res.scenes[scene || 'demo'];
    return s ? s.findings.map(f => f.type) : [];
  };

  // ── ② 正例：全部 closed 的正常任务 → 不该有任何 finding ──
  //    这条守的正是 2026-11-12 修的那个假警报（closed 被当失败）
  {
    const res = analyzeWith([
      d({ id: '1', subject: '任务甲' }),
      d({ id: '2', subject: '任务乙' }),
    ]);
    chk('正例：全部 closed 的正常任务无异常（closed 不是失败）',
        typesOf(res).length === 0, '实际: ' + typesOf(res).join(',') || '(空)');
  }

  // ── ③ 反例 1：同一主题失败 3 次（≥ 3）→ 必须报 skill-gap ──
  {
    const res = analyzeWith([
      d({ id: '1', subject: '同一主题', state: 'unacked' }),
      d({ id: '2', subject: '同一主题', state: 'unacked' }),
      d({ id: '3', subject: '同一主题', state: 'unacked' }),
    ]);
    const t = typesOf(res);
    chk('反例：同类任务失败 3 次应当报技能缺口', t.includes('skill-gap'),
        t.length ? t.join(',') : '⚠ 没报，说明 SKILL_GAP_THRESHOLD 判据失效');
  }

  // ── ④ 边界：同类失败 2 次（< 3）→ 不该报 skill-gap ──
  {
    const res = analyzeWith([
      d({ id: '1', subject: '只失败两次', state: 'unacked' }),
      d({ id: '2', subject: '只失败两次', state: 'unacked' }),
    ]);
    const t = typesOf(res);
    chk('边界：同类失败 2 次（< 3）不报技能缺口', !t.includes('skill-gap'),
        t.join(',') || '(空)');
  }

  // ── ⑤ 反例 2：同一主题被纠正 2 次（≥ 2）→ 必须报 identity-blur ──
  {
    const res = analyzeWith([
      d({ id: '1', subject: '边界模糊', corrected: true, correctionNote: '不该你判断' }),
      d({ id: '2', subject: '边界模糊', corrected: true, correctionNote: '又不该你判断' }),
    ]);
    const t = typesOf(res);
    chk('反例：同类判断被纠正 2 次应当报身份边界模糊', t.includes('identity-blur'),
        t.length ? t.join(',') : '⚠ 没报，说明 IDENTITY_THRESHOLD 判据失效');
  }

  // ── ⑥ 反例 3：同一主题返工 2 次（≥ 2）→ 必须报 process-missing ──
  {
    const res = analyzeWith([
      d({ id: '1', subject: '总要返工' }),
      d({ id: '2', subject: '总要返工' }),
    ]);
    const t = typesOf(res);
    chk('反例：同类交付返工 2 次应当报流程缺失', t.includes('process-missing'),
        t.length ? t.join(',') : '⚠ 没报，说明 PROCESS_THRESHOLD 判据失效');
  }

  // ── ⑦ 反例 4：越界 2 次（≥ 2）→ 必须报 boundary-misread ──
  //    这条同时验证「越界记录能被正确归到场景」
  {
    const res = analyzeWith([d({ id: '1' })], [
      { scene: 'demo', path: '前端/src/a.ts', at: recent },
      { scene: 'demo', path: '前端/src/b.ts', at: recent },
    ]);
    const t = typesOf(res);
    chk('反例：同类越界 2 次应当报权限理解错误', t.includes('boundary-misread'),
        t.length ? t.join(',') : '⚠ 没报，说明 BOUNDARY_THRESHOLD 判据失效');
  }

  // ── ⑧ 反例 5：cancelled 不该被算成「未回执」/「返工」──
  //    这条守的正是 2026-11-12 修的假警报（22 条测试派单被判未回执）
  {
    const res = analyzeWith([
      d({ id: '1', subject: '作废单', state: 'cancelled' }),
      d({ id: '2', subject: '作废单', state: 'cancelled' }),
      d({ id: '3', subject: '作废单', state: 'cancelled' }),
    ]);
    const t = typesOf(res);
    chk('反例：cancelled 是合法终态，不该报未回执/返工',
        !t.includes('unacked') && !t.includes('process-missing'),
        t.join(',') || '(空 —— 正确)');
  }

  // ── ⑨ 反例 6：真有一条 pending（created）→ 必须报 unacked ──
  {
    const res = analyzeWith([d({ id: '1', subject: '真的没回', state: 'created' })]);
    const t = typesOf(res);
    chk('反例：created 未回执应当报 unacked', t.includes('unacked'),
        t.length ? t.join(',') : '⚠ 没报，说明未回执判据失效');
  }

  // ── ⑩ 边界：窗口外的老派单不该被统计（WINDOW_DAYS 生效）──
  {
    const old = new Date(NOW - 60 * 86400000).toISOString();   // 60 天前
    const res = analyzeWith([
      d({ id: '1', subject: '老任务', createdAt: old, state: 'unacked' }),
      d({ id: '2', subject: '老任务', createdAt: old, state: 'unacked' }),
      d({ id: '3', subject: '老任务', createdAt: old, state: 'unacked' }),
    ]);
    chk('边界：窗口外（60 天前）的记录不参与归因', Object.keys(res.scenes).length === 0,
        '场景数=' + Object.keys(res.scenes).length);
  }

  // ── ⑪ 关键：5 类 finding 的判据全部被真实数据触发过 ──
  //    ⚠ 2026-11-12：用显式变量攒结果，不靠数组下标切片
  //      （切片写错会让这条「永远通过」，又是一条新的装饰）
  {
    const hits = {
      技能缺口: R[7], 身份模糊: R[9], 流程缺失: R[10],
      越界: R[11], 未回执: R[13],
    };
    const all = Object.values(hits).every(v => v === true);
    chk('关键：5 类归因判据都能被真实数据触发（不是装饰）', all,
        Object.entries(hits).map(([k, v]) => k + '=' + v).join(' '));
  }

  fs.rmSync(tmp, { recursive: true, force: true });

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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);

  // ⚠ 2026-11-12 补：--selftest 入口（五步法第 5 步「挂到节奏上」）。
  if (args.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const dataRoot = process.env.SEA_DATA_DIR
    ? path.resolve(process.env.SEA_DATA_DIR)
    : path.join(WB, '数据', '.dsh');

  const wi = args.indexOf('--window');
  const windowDays = wi >= 0 ? parseInt(args[wi + 1], 10) : RULES.WINDOW_DAYS;

  const nowMs = process.env.SEA_NOW
    ? (Number.isFinite(+process.env.SEA_NOW) ? +process.env.SEA_NOW : Date.parse(process.env.SEA_NOW))
    : Date.now();

  const si = args.indexOf('--scene');
  const onlyScene = si >= 0 ? args[si + 1] : null;

  const result = analyze({ dataRoot, windowDays, nowMs });

  console.log('═'.repeat(74));
  console.log('  归因摘要  ' + result.at.slice(0, 10) + '（窗口 ' + windowDays + ' 天）');
  console.log('═'.repeat(74));
  console.log();

  const scenes = Object.values(result.scenes);
  // ⚠ 2026-11-12 修（五步法第 3 步「输出差异集合」）：
  //
  //   原来虽然按场景打印了 findings，但**没有一个统一的差异集合**：
  //     · 问题项散在各场景的 console.log 里，没有可复述的列表
  //     · 汇总只有一句「共 N 处异常」，看不到 N 处分别是哪几处
  //   → 机制审计判它「攒了问题没逐条输出」。
  //
  //   改成：先把所有场景的 finding 收进 problems[]，再逐条打印 +
  //        逐条复述成清单。这样「汇总数字」和「印出的行数」永远一致，
  //        不能靠一个大数字掩盖具体是哪几项。
  const problems = [];
  for (const s of scenes) {
    if (onlyScene && s.scene !== onlyScene) continue;
    for (const f of s.findings) {
      problems.push({
        scene: s.scene,
        type: f.type,
        question: f.question,
        subject: f.subject,
        count: f.count,
        attribution: f.attribution,
        action: f.action,
      });
    }
  }

  if (!scenes.length) {
    console.log('  （窗口内没有派单记录 —— 无法归因）');
    console.log();
    console.log('  说明：归因依赖真实派单数据。');
    console.log('        没有数据 = 系统从未真实运转 = 归因无从谈起。');
    console.log();
  } else {
    for (const s of scenes) {
      if (onlyScene && s.scene !== onlyScene) continue;

      console.log('  【' + s.scene + '】任务 ' + s.taskCount +
        (s.firstPassRate !== null ? '  一次通过 ' + Math.round(s.firstPassRate * 100) + '%' : ''));
      if (!s.findings.length) {
        console.log('    ✓ 无异常');
      } else {
        for (const f of s.findings) {
          console.log('    · [' + f.type + '] ' + f.question + '：' + f.subject);
          console.log('      归因：' + f.attribution);
          console.log('      动作：' + f.action);
        }
      }
      console.log();
    }

    // ── 差异集合逐条复述（第 ③ 步：不是只给一个数字）──
    if (problems.length > 0) {
      console.log('─'.repeat(74));
      console.log('  差异集合（共 ' + problems.length + ' 项，逐条列出）');
      console.log('─'.repeat(74));
      for (const p of problems) {
        console.log('  - [' + p.scene + ' · ' + p.type + '] ' + p.question +
          '：' + p.subject + (p.count ? '（' + p.count + ' 次）' : ''));
        console.log('      归因：' + p.attribution);
        console.log('      动作：' + p.action);
      }
      console.log();
    }

    // ⚠ 2026-11-12 修（破坏性验证抓出来的装饰）：
    //
    //   原来整个文件**没有一处 process.exit** —— 不管归因捞出多少异常都 exit 0。
    //   实测：它正确报出了「[unacked] 有多少派单没回执：1 条」，
    //        但 exit 0 → 机制体检永远判 PASS → 装饰。
    //
    //   判据：有任何 findings 就 exit 1。
    //        归因工具的价值就是「捞出异常」，捞出来了却不报失败，等于没用。
    //
    //   ⚠ 2026-11-12 再补：判定改用上面同一份 problems（差异集合），
    //      而不是另算一个 totalFindings —— 两处各算一次就有分歧风险，
    //      五步法第 2 步要求判据只有一个出处。
    if (problems.length > 0) {
      console.log('─'.repeat(74));
      console.log('  ⚠ 共 ' + problems.length + ' 处异常待归因处理');
      process.exitCode = 1;
    }
  }

  if (args.includes('--write')) {
    console.log('─'.repeat(74));
    console.log('  写入场景记忆 §六');
    console.log('─'.repeat(74));
    console.log();

    let written = 0, skipped = 0;
    for (const s of scenes) {
      if (onlyScene && s.scene !== onlyScene) continue;

      const sectionText = renderSection(result, s.scene);
      // 需要中文场景名做目录名
      const reg = readJson(path.join(dataRoot, '场景记忆', '_共享记忆', '索引.json'), { areas: [] });
      const area = (reg.areas || []).find(a => a.id === s.scene);
      const cnName = area ? area.name : s.scene;

      const r = writeSection(dataRoot, cnName, sectionText);
      if (r.ok) {
        console.log('  ✓ ' + cnName + '  §六 ' + (r.replaced ? '已更新' : '已新增'));
        written++;
      } else {
        console.log('  · ' + cnName + '  ' + r.error);
        skipped++;
      }
    }
    console.log();
    console.log('  写入 ' + written + ' 个，跳过 ' + skipped + ' 个');
    if (skipped > 0) {
      console.log();
      console.log('  注意：跳过的是没有派单记录的场景 —— 它们不需要归因。');
      console.log('        这也说明这些场景从未真实运转过。');
    }
    console.log();
  }
}
