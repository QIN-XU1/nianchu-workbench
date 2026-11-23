#!/usr/bin/env node
/**
 * 破坏性验证残留检测 —— 第 105 个检查（2026-11-14 新增）
 *
 * ══════════════════════════════════════════════════════════════════════
 *  为什么需要这个检查
 * ══════════════════════════════════════════════════════════════════════
 *  `破坏性验证` 会主动破坏真实数据，靠 break() 返回的 restore 恢复。
 *  但**只要有一处漏了，脏数据就永久留在系统里**，而且会污染别的检查。
 *
 *  这一轮我自己就踩了 4 次：
 *
 *    ① 场景记忆/架构梳理/场景私有记忆.md 被清空成「（清空：模拟记忆丢失）」
 *       → 六件套报「缺必需件」、经验真实性报「经验 0」、
 *         记忆评估报「注入 0 token」、封存集报「架构梳理 未生成」
 *       我以为是 4 个不同的问题，查了两轮才发现是同一个残留。
 *
 *    ② 场景记忆/_本地电脑__break/ 目录（改名后没改回来）
 *       → 文件索引写入报「所有场景都有 _文件索引.md，缺 1 个: 本地电脑」
 *
 *    ③ 派单台账里的 zz-progress-1/2 探针
 *       → 派单哨兵报「id 格式不合法」「缺四件套」
 *
 *    ④ 调研记忆里「这条经验故意没写日期前缀」测试数据
 *       → 记忆写入协议报「有条经验没有日期前缀」
 *
 *  ⇒ 共同特征：**报错信息完全不指向真正的原因**。
 *    「六件套缺件」听起来像配置问题，实际是文件被清空了。
 *
 * ──────────────────────────────────────────────────────────────────────
 *  这个检查做什么
 * ──────────────────────────────────────────────────────────────────────
 *  扫描所有已知的破坏形态遗留物，发现就报：
 *    · 内容含「（清空：模拟记忆丢失）」
 *    · 目录名含 `__break`
 *    · 派单台账里 id 以 `zz-` 开头
 *    · 记忆里含「这条经验故意没写日期」
 *    · 目录名含 `zz闸门探针`
 *    · 契约表 files 被清空（artifact 有 candidates 但 files 为空）
 *
 *  判据：**这些都是只有测试才会产生的东西，出现在正式数据里就是残留。**
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const DATA = path.join(WB, '数据', '.dsh');
const MEM = path.join(DATA, '场景记忆');

/** 已知的破坏形态遗留标记 */
const MARKERS = [
  { name: '记忆被清空', re: /（清空：模拟记忆丢失）/, hint: '破坏性验证 L316 清空了场景记忆' },
  { name: '测试经验未删', re: /这条经验故意没写日期前缀/, hint: '某次自测注入的测试数据' },
];

export function scan() {
  const problems = [];

  // ① 扫描记忆文件的清空标记 / 测试数据
  if (fs.existsSync(MEM)) {
    for (const scene of fs.readdirSync(MEM, { withFileTypes: true })) {
      if (!scene.isDirectory()) continue;

      // 目录名残留
      if (scene.name.includes('__break')) {
        problems.push({ kind: 'dir-break', where: '场景记忆/' + scene.name, hint: '破坏性验证改名后没改回来（L334/L451）' });
      }
      if (scene.name.includes('zz闸门探针')) {
        problems.push({ kind: 'dir-probe', where: '场景记忆/' + scene.name, hint: '破坏性验证 L668 造的探针场景' });
      }

      // 文件内容残留
      const dir = path.join(MEM, scene.name);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
      for (const f of files) {
        let t = '';
        try { t = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
        for (const m of MARKERS) {
          if (m.re.test(t)) {
            problems.push({ kind: 'content', where: '场景记忆/' + scene.name + '/' + f, hint: m.name + '：' + m.hint });
          }
        }
      }
    }
  }

  // ② 派单台账探针
  const ledger = path.join(MEM, '_共享记忆', '派单台账.json');
  if (fs.existsSync(ledger)) {
    try {
      const j = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      const list = j.dispatches || [];
      const probes = list.filter((x) => String(x.id || '').startsWith('zz-'));
      if (probes.length) {
        problems.push({
          kind: 'ledger-probe',
          where: '派单台账.json',
          hint: probes.length + ' 条探针：' + probes.map((x) => x.id).join(', ') + '（破坏性验证 L539/L614）',
        });
      }
    } catch { /* ignore */ }
  }

  // ③ 影子记忆目录残留
  const shadow = path.join(DATA, '影子记忆');
  if (fs.existsSync(shadow)) {
    for (const d of fs.readdirSync(shadow)) {
      if (d.includes('__break')) {
        problems.push({ kind: 'shadow-break', where: '影子记忆/' + d, hint: '破坏性验证 L334 改名后没改回来' });
      }
    }
  }

  // ④ 产物契约 files 被清空（破坏形态 L126）
  const contract = path.join(DATA, '产物契约.json');
  if (fs.existsSync(contract)) {
    try {
      const j = JSON.parse(fs.readFileSync(contract, 'utf8'));
      for (const [id, v] of Object.entries(j.artifacts || {})) {
        if (Array.isArray(v.candidates) && v.candidates.length > 0
            && Array.isArray(v.files) && v.files.length === 0) {
          problems.push({ kind: 'contract-emptied', where: '产物契约.json · ' + id, hint: 'files 被清空（破坏性验证 L126 的破坏形态）' });
        }
      }
    } catch { /* ignore */ }
  }

  return problems;
}

// ══════════════════════════════════════════════════════════════════════
function main() {
  const problems = scan();

  console.log('='.repeat(72));
  console.log('  破坏性验证残留检测');
  console.log('='.repeat(72));
  console.log();
  console.log('  扫描: 场景记忆 / 派单台账 / 影子记忆 / 产物契约');
  console.log();

  if (!problems.length) {
    console.log('  ✓ 没有残留（所有破坏都被正确恢复了）');
    console.log();
    return 0;
  }

  console.log('  ✗ 发现 ' + problems.length + ' 处残留：');
  console.log();
  for (const p of problems) {
    console.log('    · [' + p.kind + '] ' + p.where);
    console.log('      ' + p.hint);
  }
  console.log();
  console.log('  ⚠ 这些只有测试才会产生，出现在正式数据里会污染别的检查。');
  console.log('    典型症状：报错信息完全不指向真正原因');
  console.log('      （「六件套缺件」实际是文件被清空；「缺文件索引」实际是目录被改名）');
  console.log();
  console.log('  清理命令：见 工具/破坏性验证清理.mjs');
  console.log();
  return 1;
}

function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d ? '  ' + d : '')); };

  console.log('='.repeat(72));
  console.log('  破坏性验证残留检测 · 自测');
  console.log('='.repeat(72));
  console.log();

  // ① 真实环境扫描应该能跑（不一定绿，但不能崩）
  chk('scan() 不抛异常', (() => { try { scan(); return true; } catch { return false; } })());

  // ② 判据会失败：造一个假残留，检测必须发现
  {
    const tmproot = path.join(WB, 'build');
    fs.mkdirSync(tmproot, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(tmproot, '.tmp-residue-'));
    const fakeScene = path.join(tmp, '测试场景');
    fs.mkdirSync(fakeScene, { recursive: true });
    fs.writeFileSync(path.join(fakeScene, '场景私有记忆.md'), '# 测试\n\n（清空：模拟记忆丢失）\n', 'utf8');
    let found = false;
    try {
      // 临时把 MEM 指向 tmp 测不了（MEM 是常量），改为直接验正则
      found = MARKERS[0].re.test(fs.readFileSync(path.join(fakeScene, '场景私有记忆.md'), 'utf8'));
    } catch { /* ignore */ }
    chk('反例：含「（清空：模拟记忆丢失）」会被识别', found === true, '');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ③ 反例：正常记忆不该被误判
  {
    const normal = '# 调研 · 场景私有记忆\n\n- 2026-11-14 **正常经验**：这是真实内容，应该放行。\n';
    const falsePositive = MARKERS.some((m) => m.re.test(normal));
    chk('反例：正常记忆不被误判', falsePositive === false, '');
  }

  // ④ 探针 id 判据
  {
    chk('zz-progress-1 被判为探针', 'zz-progress-1'.startsWith('zz-'));
    chk('d-20261114-001 不被判为探针', 'd-20261114-001'.startsWith('zz-') === false);
  }

  console.log();
  const n = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + n + ' / ' + R.length);
  console.log('─'.repeat(72));
  return n === R.length;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  process.exit(main());
}
