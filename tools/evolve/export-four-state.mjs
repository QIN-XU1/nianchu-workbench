#!/usr/bin/env node
/**
 * 把 T3 审计结果导出给界面用 —— 单一来源：evidence/evolve/four-state-layers.json
 *
 * 为什么要这一步：界面不能自己去跑 25 个验收器（太慢），但也不能手抄一份数据
 * （会跟真实结果脱节）。所以由这个脚本从**真实审计产物**复制到界面数据目录，
 * 界面只负责显示。数据来源、生成时间都写进 JSON，界面会显示出来。
 *
 * 四态：PASS 导出成功且源 state=PASS / WARN 导出成功但源非 PASS / FAIL 源缺失或损坏
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(REPO, 'evidence/evolve/four-state-layers.json');
const OUT = path.join(REPO, 'apps/vouch-web/src/web-ui/src/app/scenes/benchmark/data/four-state-layers.json');

function main() {
  if (!fs.existsSync(SRC)) {
    console.log('  ✗ 源不存在：' + SRC);
    console.log('\n  四态: FAIL');
    return 1;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  } catch (e) {
    console.log('  ✗ 源损坏：' + e.message);
    console.log('\n  四态: FAIL');
    return 1;
  }
  if (!Array.isArray(raw.results) || raw.results.length === 0) {
    console.log('  ✗ 源里没有 results（层/案例），不能导出空壳');
    console.log('\n  四态: FAIL');
    return 1;
  }
  const out = {
    ...raw,
    exportedAt: new Date().toISOString(),
    source: 'evidence/evolve/four-state-layers.json',
    exportedBy: 'tools/evolve/export-four-state.mjs',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');

  const layers = raw.results.length;
  const cases = raw.results.reduce((a, r) => a + (r.cases ? r.cases.length : 0), 0);
  console.log('  已导出：' + path.relative(REPO, OUT));
  console.log('  层 ' + layers + ' · 案例 ' + cases + ' · 源 state=' + (raw.state || '(无)'));
  const state = raw.state === 'PASS' ? 'PASS' : 'WARN';
  console.log('\n  四态: ' + state);
  return state === 'PASS' ? 0 : 3;
}

process.exit(main());
