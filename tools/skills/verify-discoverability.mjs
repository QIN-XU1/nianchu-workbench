#!/usr/bin/env node
/**
 * 技能可发现性验收 —— 「模型会不会用上技能」的第一层证明
 *
 * ══ 为什么需要这个（第 123 轮）═════════════════════════════════════
 * 前几轮补齐了 35 个技能、目录也注入了 system prompt、load_skill 也注册了。
 * 但有一个从未验证的假设：**模型看到用户的话，能不能在目录里找到对的技能？**
 *
 * 如果目录里的 description 写得含糊，模型就算想用也找不到 ——
 * 那「35 个技能」和「0 个技能」在效果上没区别。
 *
 * ══ 这个脚本证明什么、不证明什么 ═══════════════════════════════════
 * 证明：给定一句**真实的用户话术**，按关键词匹配能在目录里找到预期的技能，
 *       且预期技能排在前面（不是埋在 35 条里第 30 位）。
 * 不证明：模型真的会去调 load_skill（那需要真模型，本环境无 API key）。
 *
 * ══ 四态 ══════════════════════════════════════════════════════════
 * 0 全通过 · 1 有失败 · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0, fail = 0;
const t = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

/**
 * 真实用户话术 → 期望命中的技能。
 * 每一条都取自 description 里写的「当用户说…时使用」，
 * 所以这是「description 自己承诺的可发现性」，不是我们另编的标准。
 */
const CASES = [
  { say: '这个 bug 修一下', want: 'debug-repro' },
  { say: '复现不了', want: 'debug-repro' },
  { say: '帮我拆一下这个任务', want: 'task-breakdown' },
  { say: '我要休假，工作交接给你', want: 'handoff' },
  { say: '复盘一下这次事故', want: 'postmortem' },
  { say: '用哪个方案好，A 还是 B', want: 'tech-selection' },
  { say: '拆解一下这个项目怎么实现的', want: 'source-dive' },
  { say: '补测试', want: 'test-writing' },
  { say: '审一下这段代码', want: 'code-review' },
  { say: '这个改动会不会 breaking', want: 'api-contract' },
  { say: '迁移数据', want: 'data-migration' },
  { say: '设计表结构', want: 'schema-design' },
  { say: '太慢了，优化一下', want: 'perf-profile' },
  { say: '升级依赖', want: 'dep-upgrade' },
  { say: '重构一下，这块太乱了', want: 'refactor-plan' },
  { say: '看看这个设计行不行', want: 'design-review' },
  { say: '看下有没有安全问题', want: 'security-review' },
  { say: '写更新说明给用户看', want: 'release-notes' },
  { say: '写更新日志', want: 'changelog' },
  { say: '记录这个技术决定', want: 'adr' },
  { say: '写个 README', want: 'readme-bootstrap' },
  { say: '配 CI，流水线挂了', want: 'ci-pipeline' },
  { say: '发版', want: 'release-pipeline' },
  { say: '现在能进入下一个项目了吗', want: 'project-verdict' },
  { say: '让别的工具也能用我们的技能', want: 'multi-host-project' },
];

/** 极简匹配：把用户话术与「name + description」做字符级重合度打分 */
function score(say, entry) {
  const hay = (entry.name + ' ' + entry.description).toLowerCase();
  const s = String(say).toLowerCase();
  // 1) 完整子串命中（最强）
  if (hay.includes(s)) return 100;
  // 2) 按 2-gram 重合比例
  let hit = 0, total = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    if (!/[\s，。？！、：；「」]/.test(g)) {
      total++;
      if (hay.includes(g)) hit++;
    }
  }
  return total ? Math.round((hit / total) * 90) : 0;
}

async function main() {
  console.log('\n  0. 前置：目录必须真的能读到 35 个技能');
  const { createSkillLoader } = await import('../skills/loader.mjs');
  const { catalogText } = await import('../skills/inject.mjs');
  const loader = createSkillLoader([path.join(ROOT, 'prototype/scenes')]).scanAll();
  const list = loader.list();
  t('技能数 ≥ 35', list.length >= 35, '实际 ' + list.length);
  const cat = catalogText(loader);
  t('目录非空且含全部技能', cat.count === list.length && cat.text.length > 1000, 'count=' + cat.count);
  t('目录里没有正文泄漏（两段式未退化）',
    !list.some((s) => {
      try { return cat.text.includes(loader.load(s.name).body.slice(0, 40)); } catch { return false; }
    }));

  console.log('\n  1. ★ 核心：每句真实话术都要能命中预期技能');
  const misses = [];
  const ranks = [];
  for (const c of CASES) {
    const scored = list.map((e) => ({ name: e.name, s: score(c.say, e) })).sort((a, b) => b.s - a.s);
    const rank = scored.findIndex((x) => x.name === c.want);
    const topScore = scored[0].s;
    const wantScore = scored[rank].s;
    ranks.push(rank + 1);
    if (rank !== 0) {
      misses.push({ say: c.say, want: c.want, got: scored[0].name, wantRank: rank + 1, wantScore, topScore });
    }
    t('「' + c.say + '」→ ' + c.want + (rank === 0 ? '（第 1）' : '（第 ' + (rank + 1) + '，被 ' + scored[0].name + ' 压过）'),
      rank === 0, '得分 ' + wantScore + ' vs 最高 ' + topScore);
  }

  console.log('\n  2. 命中质量统计');
  const firstHits = ranks.filter((r) => r === 1).length;
  const top3Hits = ranks.filter((r) => r <= 3).length;
  const rate1 = (firstHits / CASES.length * 100).toFixed(1);
  const rate3 = (top3Hits / CASES.length * 100).toFixed(1);
  console.log('    第 1 命中率: ' + firstHits + '/' + CASES.length + ' = ' + rate1 + '%');
  console.log('    前 3 命中率: ' + top3Hits + '/' + CASES.length + ' = ' + rate3 + '%');
  t('第 1 命中率 ≥ 80%', firstHits / CASES.length >= 0.8, rate1 + '%');
  t('前 3 命中率 = 100%', top3Hits === CASES.length, rate3 + '%');

  console.log('\n  3. 反例：含糊话术不应误命中（避免"什么都匹配"）');
  // 如果匹配逻辑太宽松，任何话都会命中——那上面的高命中率就没意义
  const vague = list.map((e) => ({ name: e.name, s: score('随便说点什么', e) })).sort((a, b) => b.s - a.s);
  t('无关话术最高分 < 60（说明不是什么都匹配）', vague[0].s < 60, '最高 ' + vague[0].s + ' 分（' + vague[0].name + '）');

  console.log('\n  4. 反例：每个技能的 description 必须含"触发词"（当用户…时使用）');
  const noTrigger = list.filter((e) => !/当用户|当你|when the user|使用$/i.test(e.description));
  t('全部 description 都写了触发场景', noTrigger.length === 0,
    noTrigger.length + ' 个缺: ' + noTrigger.map((x) => x.name).join(','));

  console.log('\n  5. 反例：description 不能过短（太短无法匹配）');
  const tooShort = list.filter((e) => String(e.description).length < 20);
  t('全部 description 长度 ≥ 20 字符', tooShort.length === 0,
    tooShort.length + ' 个过短: ' + tooShort.map((x) => x.name + '(' + x.description.length + ')').join(','));

  console.log('\n  6. 反例：技能名不能互相包含（否则匹配歧义）');
  const names = list.map((e) => e.name).sort();
  const ambiguous = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      if (i !== j && names[j].includes(names[i]) && names[i].length >= 3) {
        ambiguous.push(names[i] + ' ⊂ ' + names[j]);
      }
    }
  }
  t('没有技能名互相包含', ambiguous.length === 0, ambiguous.join('; '));

  console.log('\n  7. 目录体量在合理范围（不撑爆 system prompt）');
  const chars = cat.text.length;
  console.log('    目录 ' + chars + ' 字符（约 ' + Math.round(chars / 2) + ' tokens）');
  t('目录 < 12000 字符', chars < 12000, chars + ' 字符');
  t('每个技能平均 < 400 字符', chars / list.length < 400, Math.round(chars / list.length) + ' 字符/技能');

  // 收尾
  console.log('\n  ──────────────────────────────────────────');
  if (misses.length) {
    console.log('  未第 1 命中的用例：');
    for (const m of misses) {
      console.log('    「' + m.say + '」想要 ' + m.want + '（第 ' + m.wantRank + ' 名，' + m.wantScore + ' 分），被 ' + m.got + ' 压过（' + m.topScore + ' 分）');
    }
    console.log('');
  }
  console.log('  通过 ' + pass + ' · 失败 ' + fail);
  const state = fail > 0 ? 'FAIL' : (pass > 0 ? 'PASS' : 'UNKNOWN');
  console.log('  四态: ' + state);
  console.log('  ⚠ 本脚本只证明「按关键词能命中」；模型是否真会调 load_skill 需真模型，本环境无 API key（UNKNOWN）。');
  process.exit(state === 'FAIL' ? 1 : state === 'UNKNOWN' ? 2 : 0);
}

main().catch((e) => {
  console.error('  ✗ 工具自检失败：' + (e && e.stack || e));
  process.exit(2);
});
