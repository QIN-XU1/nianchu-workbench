#!/usr/bin/env node
// 工具/闭环断点体检.mjs —— 验证「中枢」诊断报告里的 9 个断点是否都已修
//
// ══════════════════════════════════════════════════════════════════════
//  这个工具的来源很特别：它检查的 9 个缺陷，全是「中枢」场景
//  在历练任务「诊断派单闭环到底有几个断点」里，逐行读源码找出来的。
//
//  报告位置：数据/.dsh/场景记忆/中枢/闭环断点诊断.md
//
//  这 9 个断点的共性：
//    · 都不是崩溃，而是「静默失败 / 假成功 / 卡死」
//    · 都不会报错，所以常规测试发现不了
//    · 单看每个文件的代码都「看起来对」
//
//  把它们做成机械检查，是因为：
//    「如果一个检查永远通过，它就不是检查，是装饰」
//    —— 这里的每一条都能真的失败（改成旧写法就会红）。
//
//  用法：
//    node 工具/闭环断点体检.mjs
//    node 工具/闭环断点体检.mjs --selftest
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const TOOLS = path.join(WB, '工具');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);

function read(f) {
  try { return fs.readFileSync(path.join(TOOLS, f), 'utf8'); } catch { return ''; }
}

// ══════════════════════════════════════════════════════════════════════
//  9 个断点的检查（每个都能真的失败）
// ══════════════════════════════════════════════════════════════════════
export const CHECKS = [
  {
    id: 'd1',
    name: '断点1：派单命令参数写错不会静默失败',
    desc: '派单.mjs 必须校验四件套；skill 文档必须用正确参数',
    run() {
      const send = read('派单.mjs');
      if (!send.includes("has('send')")) return { ok: false, why: '派单.mjs 没有 --send 分支' };
      if (!send.includes('四件套')) return { ok: false, why: '派单.mjs 没有四件套校验' };
      // skill 里不能有「可执行的」--prompt / --needs（旧错误参数）
      //
      // ⚠ 2026-11-12 修（自测抓出来的误报）：
      //   第一版只排除「行首 #」的注释，结果把这句话当成错误了：
      //     「实测后果：`派单.mjs` 不认识 `--prompt` / `--needs` / `--note`」
      //   这是**在解释旧参数为什么错**，不是可执行命令。
      //
      //   正确判据：只检查「代码块内、以 node 工具/ 开头的、未注释的行」
      const hubSkill = path.join(WB, '数据', '.dsh', 'skills', 'hub', 'SKILL.md');
      if (fs.existsSync(hubSkill)) {
        const sk = fs.readFileSync(hubSkill, 'utf8');
        const bad = [];
        let inFence = false;
        for (const line of sk.split('\n')) {
          const t = line.trim();
          if (t.startsWith('```')) { inFence = !inFence; continue; }
          if (!inFence) continue;                       // 只看代码块内
          if (t.startsWith('#')) continue;              // 跳过 shell 注释
          if (!/^node\s+工具/.test(t)) continue;        // 只认 node 工具/xxx 命令
          if (/--prompt|--needs|--note/.test(t)) bad.push(t);
        }
        if (bad.length) return { ok: false, why: 'hub skill 代码块里仍有旧参数: ' + bad[0].slice(0, 50) };
      }
      return { ok: true, why: '四件套校验存在，skill 无旧参数' };
    },
  },
  {
    id: 'd2',
    name: '断点2：各工具 token 正则长度下限一致',
    desc: '{30,} 与 {20,} 混用会导致部分工具抓不到 token（静默失败）',
    run() {
      const res = [];
      let files = [];
      try { files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('.mjs')); } catch { return { ok: false, why: '读不到工具目录' }; }
      for (const f of files) {
        const c = read(f);
        const m = c.match(/token=\(\[[^\]]*\]\{(\d+),\}\)/);
        if (m) res.push({ f, min: Number(m[1]) });
      }
      if (res.length < 2) return { ok: true, why: '只有 ' + res.length + ' 个工具抓 token，无需比较' };
      const mins = [...new Set(res.map((x) => x.min))];
      if (mins.length > 1) {
        return { ok: false, why: '不一致: ' + res.map((x) => x.f + '={' + x.min + ',}').join(', ') };
      }
      return { ok: true, why: res.length + ' 个工具全部 {' + mins[0] + ',}' };
    },
  },
  {
    id: 'd3',
    name: '断点3：取会话要取最新而不是第一个',
    desc: 'find() 取第一个会投到旧会话、读到旧回复',
    run() {
      const p = read('中枢代写.mjs');
      if (!p) return { ok: false, why: '中枢代写.mjs 不存在' };
      if (!p.includes('updatedAt')) return { ok: false, why: '没有按 updatedAt 排序' };
      if (!/sort\(\s*\(a,\s*b\)\s*=>/.test(p)) return { ok: false, why: '没有 sort 调用' };
      return { ok: true, why: '按 updatedAt 倒序取最新' };
    },
  },
  {
    id: 'd4',
    name: '断点4：投递后要检查余额/限流',
    desc: 'mode:queue + HTTP 200 不代表任务真执行（余额不足也返回成功）',
    run() {
      const d = read('投递通道.mjs');
      if (!d) return { ok: false, why: '投递通道.mjs 不存在' };
      if (!/QUOTA|余额不足|insufficient/i.test(d)) return { ok: false, why: '没有检查余额/限流关键词' };
      return { ok: true, why: '投递后有 QUOTA 检查' };
    },
  },
  {
    id: 'd5',
    name: '断点5：等任务完成要轮询而非固定 sleep',
    desc: '固定等 8 秒判状态，任务通常要 1-5 分钟',
    run() {
      const d = read('投递通道.mjs');
      if (!d) return { ok: false, why: '投递通道.mjs 不存在' };
      // 不能有裸的 setTimeout(r, o.waitMs || 8000)
      if (/setTimeout\(r,\s*o\.waitMs\s*\|\|\s*8000\)/.test(d)) {
        return { ok: false, why: '仍有固定 8 秒等待' };
      }
      if (!d.includes('maxWait')) return { ok: false, why: '没有 maxWait 轮询上限' };
      return { ok: true, why: '用轮询 + maxWait' };
    },
  },
  {
    id: 'd6',
    name: '断点6：判断 turn 结束要读 reason.kind',
    desc: '只看 turn/end 会把 interrupted/error 误判为完成 → 假闭环',
    run() {
      const p = read('中枢代写.mjs');
      if (!p) return { ok: false, why: '中枢代写.mjs 不存在' };
      if (!p.includes('lastTurnKind')) return { ok: false, why: '没有记录 lastTurnKind' };
      if (!/reason\.kind|reason\s*&&/.test(p)) return { ok: false, why: '没有读 reason.kind' };
      return { ok: true, why: '读 reason.kind 并记录为 lastTurnKind' };
    },
  },
  {
    id: 'd7',
    name: '断点7：回执证据要校验实质内容',
    desc: '把回复前 200 字当证据 → 任意文本（自我介绍/报错）都能过闸',
    run() {
      const p = read('中枢代写.mjs');
      if (!p) return { ok: false, why: '中枢代写.mjs 不存在' };
      if (!p.includes('REPLY_FALLBACK')) return { ok: false, why: '没有兜底话术黑名单' };
      if (!p.includes('verifyText')) return { ok: false, why: '没有与 verify 比对' };
      return { ok: true, why: '有兜底话术检查 + verify 比对' };
    },
  },
  {
    id: 'd8',
    name: '断点8：销账要校验执行真完成',
    desc: '只看 state===ACKED → lastTurnDone=false 的单照样 closed',
    run() {
      const s = read('派单.mjs');
      if (!s) return { ok: false, why: '派单.mjs 不存在' };
      if (!s.includes('lastTurnDone')) return { ok: false, why: '没有校验 lastTurnDone' };
      if (!s.includes('lastTurnKind')) return { ok: false, why: '没有校验 turnKind' };
      return { ok: true, why: '销账前查 lastTurnDone 与 turnKind' };
    },
  },
  {
    id: 'd9',
    name: '断点9：闭环验证要包含进化环节',
    desc: '五步只到销账 → 进化链路从未被端到端验证',
    run() {
      const c = read('闭环验证.mjs');
      if (!c) return { ok: false, why: '闭环验证.mjs 不存在' };
      if (!c.includes('⑥ 触发进化')) return { ok: false, why: '没有第 ⑥ 步' };
      if (!c.includes('封存集判分')) return { ok: false, why: '第 ⑥ 步没有跑封存集判分' };
      if (!c.includes('进化.mjs')) return { ok: false, why: '第 ⑥ 步没有调进化工具' };
      return { ok: true, why: '六步包含 封存集判分 → 登记 → 回填' };
    },
  },
];

// ══════════════════════════════════════════════════════════════════════
//  自测：验证每条检查都能真的失败（关键！）
// ══════════════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push({ n, ok, d }); console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  闭环断点体检 · 自测');
  console.log('═'.repeat(72));
  console.log();

  console.log('【一】检查项结构');
  chk('有 9 条检查', CHECKS.length === 9, CHECKS.length + ' 条');
  chk('每条都有 id/name/desc/run',
    CHECKS.every((c) => c.id && c.name && c.desc && typeof c.run === 'function'));
  chk('id 不重复', new Set(CHECKS.map((c) => c.id)).size === 9);

  console.log();
  console.log('【二】真实运行（当前代码应该全部通过）');
  for (const c of CHECKS) {
    let r;
    try { r = c.run(); } catch (e) { r = { ok: false, why: '异常: ' + (e.message || e) }; }
    chk(c.name, r.ok, r.why);
  }

  console.log();
  console.log('【三】反例：如果代码改回旧写法，检查必须失败');
  // 造一个假环境：临时改一个文件，验证检查能红
  // ⚠ 2026-11-12 修（自测抓出来的无效反例）：
  //
  //   第一版只把 lastTurnDone 换成 lastTurnDone_REMOVED，
  //   但断点8 的检查是「lastTurnDone AND lastTurnKind」，
  //   只破坏前者，后者还在 → 检查依然通过 → 反例什么都没证明。
  //
  //   正确做法：**逐个破坏每个必要条件**，验证每个都能让检查失败。
  //   这才叫「证明这个检查能证伪」。
  const bakFile = path.join(TOOLS, '派单.mjs');
  const bak = fs.readFileSync(bakFile, 'utf8');
  const d8 = CHECKS.find((c) => c.id === 'd8');

  const probes = [
    { key: 'lastTurnDone', label: 'lastTurnDone' },
    { key: 'lastTurnKind', label: 'lastTurnKind' },
  ];

  try {
    for (const pr of probes) {
      // ⚠ 不能用 pr.key + '_REMOVED' —— 那样替换结果里仍然包含原字段名，
      //   includes() 依然会命中，反例就失效了（自测第二次抓出来的 bug）。
      //   必须换成完全不含原字段名的标记。
      const broken = bak.replace(new RegExp(pr.key, 'g'), 'XXX_DELETED_FIELD');
      fs.writeFileSync(bakFile, broken, 'utf8');
      const r = d8.run();
      chk('反例：去掉 ' + pr.label + ' 校验 → 断点8 检查必须失败', !r.ok, r.why || '（检查竟然通过了）');
    }
  } finally {
    fs.writeFileSync(bakFile, bak, 'utf8');
  }

  // 恢复后再验一次
  const d8b = CHECKS.find((c) => c.id === 'd8');
  const r8b = d8b.run();
  chk('恢复后断点8 检查重新通过', r8b.ok, r8b.why);

  console.log();
  console.log('═'.repeat(72));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    process.exitCode = 1;
  }
  console.log('═'.repeat(72));
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  if (has('selftest')) { selftest(); return; }

  console.log('═'.repeat(78));
  console.log('  闭环断点体检 —— 检查「中枢」诊断出的 9 个静默失败点是否都已修');
  console.log('═'.repeat(78));
  console.log();
  console.log('  来源：数据/.dsh/场景记忆/中枢/闭环断点诊断.md');
  console.log('  共性：都不是崩溃，是「静默失败/假成功/卡死」，常规测试发现不了');
  console.log();

  let bad = 0;
  for (const c of CHECKS) {
    let r;
    try { r = c.run(); } catch (e) { r = { ok: false, why: '异常: ' + ((e && e.message) || e) }; }
    console.log('  ' + (r.ok ? 'OK  ' : 'XX  ') + c.name);
    console.log('       ' + (r.why || ''));
    if (!r.ok) bad++;
  }

  console.log();
  console.log('─'.repeat(78));
  console.log('  结果: ' + (CHECKS.length - bad) + ' / ' + CHECKS.length + ' 个断点已修');
  if (bad) {
    console.log('  还有 ' + bad + ' 个断点未修');
    process.exitCode = 1;
  }
  console.log('═'.repeat(78));
}

main();
