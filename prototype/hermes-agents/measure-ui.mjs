#!/usr/bin/env node
/**
 * 界面可判定对比：同一套像素算法跑「我们 vs 参照系统」的截图。
 *
 * 为什么不用肉眼：目标第 5 条要求「用可判定的判据而不是『看起来更好』」。
 * 肉眼结论无法复算，换个人就推翻。所以这里只出数字：
 *
 *   M1 栏数     —— 纵向分隔带的数量（布局结构的主要量度）
 *   M2 文字块数 —— 横向投影峰的个数（单屏可见的文本行/项）
 *   M3 信息密度 —— 非背景像素占比（屏上承载了多少东西）
 *   M4 留白率   —— 与 M3 互补，衡量是否空旷
 *   M5 色阶数   —— 不同亮度层次的数量（视觉层次丰富度）
 *
 * 已知局限（写清楚，不假装客观）：
 *   - 像素法测不出「状态可见性」的语义（比如「正在做什么/花了多少」），
 *     这一项只能靠人工在截图里指认具体元素位置，见 research/界面对比.md 的人工判据表。
 *   - 截图分辨率不同会轻微影响 M2/M3，所以所有图先归一到同一宽度再算。
 *
 * 用法：node measure-ui.mjs <图片路径> [宽度]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PY = 'C:/hermes/.venv/Scripts/python.exe';

const PY_CODE = String.raw`
import sys, json
from collections import Counter
from PIL import Image

def measure(path, norm_w=1400):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    if w != norm_w:
        nh = int(h * norm_w / w)
        im = im.resize((norm_w, nh), Image.LANCZOS)
    w, h = im.size
    px = im.load()

    # 背景色 = 全图出现最多的颜色（量子化到 8 级抗噪）。
    # 之前用四角采样，浅色弹窗+暗色遮罩的图会取错，密度直接飙到 87%。
    q = Counter()
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            c = px[x, y]
            q[(c[0]//8*8, c[1]//8*8, c[2]//8*8)] += 1
    bgq = q.most_common(1)[0][0]
    def is_fg(c):
        return (abs(c[0]-bgq[0]) + abs(c[1]-bgq[1]) + abs(c[2]-bgq[2])) > 40

    col_fg = [0]*w
    row_fg = [0]*h
    fg = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if is_fg(px[x, y]):
                fg += 1
                col_fg[x] += 1
                row_fg[y] += 1
    sampled = ((w+1)//2) * ((h+1)//2)
    density = fg / sampled

    # M1 面板边界：用「列平均亮度的阶跃」找分栏线。
    #
    # 之前用「整列都是空白」判定，在 hermes 上失效 —— 它的侧栏每行都有图标/文字，
    # 没有一列是空的。改用亮度阶跃：面板之间的底色通常不同（或有一条边框），
    # 相邻列的平均亮度会跳一下。对亮/暗主题都成立。
    col_lum = [0.0]*w
    for x in range(w):
        s = 0
        n = 0
        for y in range(0, h, 4):
            c = px[x, y]
            s += (c[0]*299 + c[1]*587 + c[2]*114)//1000
            n += 1
        col_lum[x] = s / max(1, n)

    K = 8
    edges = []
    for x in range(K, w - K):
        step = abs(col_lum[x] - col_lum[x - K])
        if step >= 5.0:
            # 同一处阶跃只记一次
            if not edges or x - edges[-1] > int(w * 0.02):
                edges.append(x)
    panels = len(edges) + 1
    sidebar_ratio = round(edges[0] / w * 100, 1) if edges else 0.0

    # M2 文字块：横向投影峰（连续有内容的行段）
    blocks, prev = 0, False
    for y in range(h):
        cur_on = row_fg[y] > (w * 0.006)
        if cur_on and not prev:
            blocks += 1
        prev = cur_on
    text_rows = sum(1 for y in range(h) if row_fg[y] > (w * 0.004))

    # M4 水平分区：几乎整行都是背景的横向空白带 → 分节符
    hz = 0
    run = 0
    for y in range(h):
        if row_fg[y] < (w * 0.02):
            run += 1
        else:
            if run >= int(h * 0.012):
                hz += 1
            run = 0
    if run >= int(h * 0.012):
        hz += 1
    sections = hz + 1

    # M5 色阶数：亮度量化 16 级，数非背景出现过的级数
    levels = set()
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            c = px[x, y]
            if is_fg(c):
                levels.add(((c[0]*299 + c[1]*587 + c[2]*114)//1000) // 16)

    return {
        'w': w, 'h': h,
        'bg': '#%02x%02x%02x' % bgq,
        'sidebar': sidebar_ratio,
        'panels': panels,
        'textBlocks': blocks,
        'textRows': text_rows,
        'density': round(density * 100, 2),
        'whitespace': round(100 - density * 100, 2),
        'sections': sections,
        'levels': len(levels),
    }

out = []
for p in sys.argv[1:]:
    try:
        out.append({'file': p, **measure(p)})
    except Exception as e:
        out.append({'file': p, 'error': str(e)[:120]})
print(json.dumps(out, ensure_ascii=True))
`;

const files = process.argv.slice(2);
if (!files.length) { console.log('用法: node measure-ui.mjs <图1> <图2> ...'); process.exit(1); }

const raw = execFileSync(PY, ['-c', PY_CODE, ...files], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const rows = JSON.parse(raw.trim().split('\n').pop());

console.log('');
console.log('  ' + '图'.padEnd(38) + '左栏% 面板 文字块 文字行  密度%   留白% 分区 色阶');
console.log('  ' + '─'.repeat(80));
for (const r of rows) {
  const name = path.basename(r.file).slice(0, 36);
  if (r.error) { console.log('  ' + name.padEnd(38) + '错误: ' + r.error); continue; }
  console.log('  ' + name.padEnd(38) +
    String(r.sidebar).padStart(5) + String(r.panels).padStart(5) + String(r.textBlocks).padStart(7) +
    String(r.textRows).padStart(7) + String(r.density).padStart(7) +
    String(r.whitespace).padStart(8) + String(r.sections).padStart(5) +
    String(r.levels).padStart(5));
}
console.log('');
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
