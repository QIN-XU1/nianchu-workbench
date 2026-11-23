// 按「功能区（目录）」分区抽取中文 UI 文案，产出可复算的功能地图
//
// 用法：node research/frontend-benchmark/tools/zh-by-area.mjs <root> <outJson> [topPerArea] [areaDepth]
//
// 环境变量：
//   ZH_MAX_BYTES  单文件体积上限（默认 12MB）。VS Code 分支的 AI 主体常是 60MB 单 bundle，
//                 Cherry 的 renderer 有 1.8MB 分包 —— 要放开到 90MB 才扫得全。
//   ZH_DECODE=1   先把 \uXXXX 还原成真中文再匹配。CodeBuddy CN 全程转义，
//                 不还原的话整个包只剩 26 条（实测）。
//
// 输出：按区（目录）分组的去重文案 + 出现次数，供档案里「某功能确实存在」的举证。
// 注意：去重条数 ≠ 功能密度 —— 组件库 demo 页、Emoji 分类名会污染，档案里要显式剔除。
import fs from 'node:fs';
import path from 'node:path';

const [root, outJson, topArg, depthArg] = process.argv.slice(2);
const TOP = Number(topArg || 40);
const DEPTH = Number(depthArg || 3);
const ROOT = path.resolve(root);
const TEXT_EXT = /\.(js|mjs|cjs|css|html|json|md)$/i;

const areas = new Map(); // area -> Map(zh->count)
const reZh = /["'`]([\u4e00-\u9fa5][^"'`\n]{0,23})["'`]/g;

function areaOf(full) {
  const rel = path.relative(ROOT, full).split(path.sep);
  return rel.slice(0, Math.min(DEPTH, rel.length - 1)).join('/') || '.';
}

function walk(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full);
      continue;
    }
    if (!e.isFile() || !TEXT_EXT.test(e.name)) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const cap = Number(process.env.ZH_MAX_BYTES || 12 * 1024 * 1024);
    if (st.size > cap || st.size < 20) continue;
    let s;
    try {
      s = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    // 有些构建产物把中文转义成 \uXXXX（CodeBuddy CN 就是），先还原再匹配
    if (process.env.ZH_DECODE === '1' && s.includes('\\u')) {
      s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    const a = areaOf(full);
    let m;
    reZh.lastIndex = 0;
    while ((m = reZh.exec(s))) {
      const t = m[1].trim();
      if (t.length < 2) continue;
      let bucket = areas.get(a);
      if (!bucket) areas.set(a, (bucket = new Map()));
      bucket.set(t, (bucket.get(t) || 0) + 1);
    }
  }
}

walk(ROOT);
const out = [...areas.entries()]
  .map(([area, m]) => {
    const arr = [...m.entries()].sort((x, y) => y[1] - x[1]);
    return { area, distinct: arr.length, top: arr.slice(0, TOP) };
  })
  .sort((x, y) => y.distinct - x.distinct);
fs.writeFileSync(outJson, JSON.stringify(out, null, 1), 'utf8');
console.log(
  JSON.stringify({
    out: path.resolve(outJson),
    areas: out.length,
    top: out.slice(0, 40).map((o) => [o.area, o.distinct]),
  }),
);
