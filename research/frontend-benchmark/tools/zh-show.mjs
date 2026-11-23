// 从 zh-by-area 结果里按区打印 top N（UTF-8 安全）
//
// 用法：node research/frontend-benchmark/tools/zh-show.mjs <outJson> [n] [area...]
//   不给 area 就打印所有区。
import fs from 'node:fs';

const [jsonPath, nArg, ...areas] = process.argv.slice(2);
const N = Number(nArg || 20);
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const want = areas.length ? areas : data.map((d) => d.area);
for (const a of want) {
  const hit = data.find((d) => d.area === a);
  if (!hit) {
    console.log(`### ${a} — MISSING`);
    continue;
  }
  console.log(`### ${a} (distinct=${hit.distinct})`);
  console.log(hit.top.slice(0, N).map(([t, c]) => `${t}(${c})`).join(' · '));
}
