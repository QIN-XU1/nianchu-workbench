#!/usr/bin/env node
/**
 * 内容哨兵 —— 检查六件套的"内容质量"，不只是"文件存在"
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要它（本轮自审发现的根本问题）
 * ══════════════════════════════════════════════════════════════
 *
 *  我之前的"六件套覆盖率 93.3%"是**虚的**：
 *    · 文件全都在（存在性检查 100% 通过）
 *    · 但身份卡 9/9 全是模板
 *    · 定位卡 7/9 缺"不碰什么"
 *
 *  文件存在 ≠ 内容合格。
 *  存在性检查永远通过，所以它永远不会报警。
 *
 *  这个哨兵检查的是**内容**：
 *
 * ══════════════════════════════════════════════════════════════
 *  不变量
 * ══════════════════════════════════════════════════════════════
 *
 *  INV-1  identity-not-template   身份卡不能含"待明确"/"由工具生成"
 *  INV-2  identity-has-three      身份卡必须有"我是谁/能做什么/不做什么"
 *  INV-3  context-not-pending     定位卡不能含"（待补）"
 *  INV-4  context-has-boundary    定位卡必须有具体的"不碰/边界"说明
 *  INV-5  context-min-size        定位卡 ≥ 500 字节（太短说明是占位）
 *  INV-6  skill-has-process       技能必须有"流程/步骤"
 *  INV-7  skill-has-acceptance    技能必须有"验收"
 *  INV-8  memory-has-section5     场景记忆有 §五（坑与决策）或 §六（归因）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');

function readText(p) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s;
  } catch { return null; }
}

function readJson(p, fb) {
  const s = readText(p);
  if (s === null) return fb;
  try { return JSON.parse(s); } catch { return fb; }
}

/**
 * @param {object} opt
 *   opt.wbRoot  workbench 目录
 */
export function check(opt) {
  const wbRoot = opt.wbRoot || WB;
  const diffs = [];
  const ID = 'content-guard';
  const stats = { scenes: 0, identityOk: 0, contextOk: 0, skillOk: 0 };

  const memRoot = path.join(wbRoot, '数据', '.dsh', '场景记忆');
  const scenDir = path.join(wbRoot, '外壳', 'scenarios');
  const skillDir = path.join(wbRoot, '数据', '.dsh', 'skills');
  const idxFile = path.join(memRoot, '_共享记忆', '索引.json');

  const reg = readJson(idxFile, { areas: [] });
  const areas = reg.areas || [];
  stats.scenes = areas.length;

  for (const a of areas) {
    const sid = a.id;
    const name = a.name;

    // ═══ 身份卡 ═══
    const idFile = path.join(memRoot, name, '身份卡.md');
    const idText = readText(idFile);
    if (idText === null) {
      diffs.push('场景「' + name + '」缺身份卡');
    } else {
      let ok = true;

      // INV-1 不能是模板
      if (idText.includes('待明确') || idText.includes('由工具生成')) {
        diffs.push('场景「' + name + '」身份卡是模板（含"待明确"或"由工具生成"）');
        ok = false;
      }

      // INV-2 三个核心节
      const need = [
        ['我是谁', ['我是谁', '## 我']],
        ['能做什么', ['我能做什么', '我能做']],
        ['不做什么', ['我不做什么', '我不做', '不碰']],
      ];
      for (const [label, patterns] of need) {
        if (!patterns.some(p => idText.includes(p))) {
          diffs.push('场景「' + name + '」身份卡缺"' + label + '"');
          ok = false;
        }
      }

      if (ok) stats.identityOk++;
    }

    // ═══ 定位卡 ═══
    const ctxFile = path.join(scenDir, sid + '-context.md');
    const ctxText = readText(ctxFile);
    if (ctxText === null) {
      diffs.push('场景「' + name + '」缺定位卡');
    } else {
      let ok = true;

      // INV-3 不能有待补
      if (ctxText.includes('（待补）') || ctxText.includes('(待补)')) {
        diffs.push('场景「' + name + '」定位卡含"（待补）"');
        ok = false;
      }

      // INV-4 必须有具体边界
      const hasBoundary = ctxText.includes('不碰') || ctxText.includes('我不做');
      if (!hasBoundary) {
        diffs.push('场景「' + name + '」定位卡缺"不碰什么/我不做什么"');
        ok = false;
      }

      // INV-5 不小于 500 字节
      const size = Buffer.byteLength(ctxText, 'utf8');
      if (size < 500) {
        diffs.push('场景「' + name + '」定位卡过短（' + size + ' < 500 字节，可能是占位）');
        ok = false;
      }

      if (ok) stats.contextOk++;
    }

    // ═══ 技能（hub 是调度层，不强制） ═══
    if (sid !== 'hub') {
      const skFile = path.join(skillDir, sid, 'SKILL.md');
      const skText = readText(skFile);
      if (skText === null) {
        diffs.push('场景「' + name + '」缺技能');
      } else {
        let ok = true;

        // INV-6 必须有流程
        if (!skText.includes('流程') && !skText.includes('步骤')) {
          diffs.push('场景「' + name + '」技能缺"流程/步骤"');
          ok = false;
        }

        // INV-7 必须有验收
        if (!skText.includes('验收')) {
          diffs.push('场景「' + name + '」技能缺"验收"');
          ok = false;
        }

        if (ok) stats.skillOk++;
      }
    }

    // ═══ 场景记忆（§五 或 §六） ═══
    const memFile = path.join(memRoot, name, '场景私有记忆.md');
    const memText = readText(memFile);
    if (memText !== null) {
      const hasLearn = memText.includes('## 五、') || memText.includes('## §五') ||
                       memText.includes('## 六、') || memText.includes('## §六');
      if (!hasLearn) {
        // ⚠ 2026-11-11 修复（机制审计发现）：
        //   原来只记统计、不生成 diff ⇒ 这个检查永远不会失败 ⇒ 是「装饰」。
        //   按参考项目判据：「如果一个检查永远通过，它就不是检查，是装饰。」
        //   改成真检查：缺 §五/§六 说明这个场景从没积累过经验，要报。
        diffs.push('场景「' + name + '」场景记忆缺 §五（坑与决策）或 §六（归因）：还没有积累任何经验');
        stats['noLearn_' + name] = true;
      }
    }
  }

  // ═══ INV-8：统计有多少场景已开始积累经验 ═══
  let withLearn = 0;
  for (const a of areas) {
    const memFile = path.join(memRoot, a.name, '场景私有记忆.md');
    const t = readText(memFile);
    if (t && (t.includes('## 五、') || t.includes('## §五') ||
              t.includes('## 六、') || t.includes('## §六'))) {
      withLearn++;
    }
  }
  stats.withLearn = withLearn;

  return { id: ID, diffs, stats };
}

// ══════════════════════════════════════════════════════════════
//  自测（含应当失败的反例）
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  内容哨兵 · 自测');
  console.log('═'.repeat(72));
  console.log();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctguard-'));
  const memRoot = path.join(tmp, '数据', '.dsh', '场景记忆');
  const scenDir = path.join(tmp, '外壳', 'scenarios');
  const skillDir = path.join(tmp, '数据', '.dsh', 'skills');
  const shared = path.join(memRoot, '_共享记忆');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(scenDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });

  // 一个完整场景
  const SID = 'test-scene';
  const SNAME = '测试场景';
  fs.writeFileSync(path.join(scenDir, SID + '.json'),
    JSON.stringify({ id: SID, name: SNAME }), 'utf8');
  fs.writeFileSync(path.join(scenDir, SID + '-context.md'),
    '# 定位卡\n\n## 一、身份与职责\n\n- 负责：做某事\n- 不碰：别的事\n\n' + '补充说明。'.repeat(120) + '\n', 'utf8');
  const memDir = path.join(memRoot, SNAME);
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, '身份卡.md'), '# 身份卡\n\n## 我是谁\n\n我是测试场景的助手。\n\n## 我能做什么\n\n- 做某事\n\n## 我不做什么\n\n- 不碰别的事\n', 'utf8');
  fs.writeFileSync(path.join(memDir, '场景私有记忆.md'),
    '# 记忆\n\n## 核心职责\n\n- 负责：做某事\n- 不碰：别的事\n\n## §〇 当前交接\n\n- 上次：A\n\n## 五、坑与决策\n\n- 2026-11-11：**某经验**\n', 'utf8');
  fs.mkdirSync(path.join(skillDir, SID), { recursive: true });
  fs.writeFileSync(path.join(skillDir, SID, 'SKILL.md'), '# 技能\n\n## 流程\n\n- 步骤一\n\n## 验收\n\n- 跑 check.mjs 应全绿\n', 'utf8');
  fs.writeFileSync(path.join(shared, '索引.json'),
    JSON.stringify({ areas: [{ id: SID, name: SNAME }] }), 'utf8');

  // ① 合规
  const r1 = check({ wbRoot: tmp });
  chk('合规时通过', r1.diffs.length === 0, r1.ok ? '' : (r1.diffs || []).slice(0, 2).join(';'));

  // ② 反例 1：删掉定位卡 → 必须报
  const ctx = path.join(scenDir, SID + '-context.md');
  const ctxBackup = fs.readFileSync(ctx, 'utf8');
  fs.unlinkSync(ctx);
  const r2 = check({ wbRoot: tmp });
  chk('反例：缺定位卡必须报', r2.diffs.length > 0, r2.ok ? '没报' : ((r2.diffs || [])[0] || '').slice(0, 45));
  fs.writeFileSync(ctx, ctxBackup, 'utf8');

  // ③ 反例 2：记忆是空骨架 → 必须报
  const memFile = path.join(memDir, '场景私有记忆.md');
  const memBackup = fs.readFileSync(memFile, 'utf8');
  fs.writeFileSync(memFile, '# 记忆\n\n## 核心职责\n\n- 负责：做某事\n- 不碰：别的事\n', 'utf8');  // 故意不含 §五/§六
  const r3 = check({ wbRoot: tmp });
  chk('反例：记忆缺 §五 必须报', r3.diffs.length > 0, r3.ok ? '没报' : ((r3.diffs || [])[0] || '').slice(0, 45));
  fs.writeFileSync(memFile, memBackup, 'utf8');

  // ④ 反例 3：删掉技能 → 必须报
  const sk = path.join(skillDir, SID, 'SKILL.md');
  const skBackup = fs.readFileSync(sk, 'utf8');
  fs.unlinkSync(sk);
  const r4 = check({ wbRoot: tmp });
  chk('反例：缺技能必须报', r4.diffs.length > 0, r4.ok ? '没报' : ((r4.diffs || [])[0] || '').slice(0, 45));
  fs.writeFileSync(sk, skBackup, 'utf8');

  // ⑤ 恢复
  const r5 = check({ wbRoot: tmp });
  chk('恢复后重新通过', r5.diffs.length === 0, r5.ok ? '' : (r5.diffs || []).slice(0, 1).join(''));

  chk('关键：3 个反例全部被检出',
      r2.diffs.length > 0 && r3.diffs.length > 0 && r4.diffs.length > 0,
      '这是内容哨兵存在的唯一理由');

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
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

  const wbRoot = process.env.SEA_WB_ROOT ? path.resolve(process.env.SEA_WB_ROOT) : WB;
  const r = check({ wbRoot });

  console.log('  场景: ' + r.stats.scenes);
  console.log('  身份卡合格: ' + r.stats.identityOk + ' / ' + r.stats.scenes);
  console.log('  定位卡合格: ' + r.stats.contextOk + ' / ' + r.stats.scenes);
  console.log('  技能合格:   ' + r.stats.skillOk + ' / ' + (r.stats.scenes - 1) + '（hub 免检）');
  console.log('  已积累经验: ' + r.stats.withLearn + ' / ' + r.stats.scenes);
  console.log();

  if (r.diffs.length === 0) {
    console.log('PASS ' + r.id + ': 差异集合 = 0');




    process.exit(0);
  } else {
    console.log('FAIL ' + r.id + ': 差异集合 = ' + r.diffs.length + ' 项');
    for (const d of r.diffs) console.log('  - ' + d);
    process.exit(1);
  }
}
