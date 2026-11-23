#!/usr/bin/env node
/**
 * 视觉输入处理层 —— A4 多模态输入 的**自研侧**
 *
 * 现状如实说：图像"理解"（读出图里有什么）靠 hermes vision —— 那是借力。
 * 但**视觉输入的确定性处理**可以自研，而且这是可验收的部分：
 *   · 解码 PNG（纯 JS，不依赖第三方库）
 *   · 像素级差异比对（两张图 → 差异像素数 / 差异率 / 差异包围盒）
 *   · 区域裁切与统计（亮度均值/方差）
 *
 * 为什么这算真能力：截图回归测试、界面改动前后对比、品牌资源一致性检查，
 * 都只需要"确定性像素比对"，不需要模型理解。这正是我们自研的那一半。
 *
 * ⛔ 不做越界拦截；只处理显式给定的文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 最小 PNG 解码器：支持 8-bit RGB/RGBA、非隔行（覆盖截图场景） */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8-bit，实际 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行扫描');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('只支持 RGB(2)/RGBA(6)，实际 colorType=' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    // 反滤波
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      }
      cur[x] = v;
    }
    cur.copy(prev);
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      out[di] = cur[si];
      out[di + 1] = cur[si + 1];
      out[di + 2] = cur[si + 2];
      out[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
  }
  return { width, height, rgba: out };
}

/** 两图比对：返回差异像素/差异率/包围盒。尺寸不同直接判不可比（不硬比）。 */
export function diffImages(a, b, threshold = 8) {
  if (a.width !== b.width || a.height !== b.height) {
    return { comparable: false, reason: `尺寸不同 ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  const { width, height } = a;
  let diff = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const d = Math.max(
        Math.abs(a.rgba[i] - b.rgba[i]),
        Math.abs(a.rgba[i + 1] - b.rgba[i + 1]),
        Math.abs(a.rgba[i + 2] - b.rgba[i + 2]),
      );
      if (d > threshold) {
        diff++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const totalPx = width * height;
  return {
    comparable: true,
    width, height, totalPx, diffPixels: diff,
    diffRate: totalPx ? diff / totalPx : 0,
    bbox: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
  };
}

/** 区域统计：亮度均值/方差 */
export function regionStats(img, rect) {
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const x1 = Math.min(img.width, rect.x + rect.w), y1 = Math.min(img.height, rect.y + rect.h);
  let n = 0, sum = 0, sumSq = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const lum = 0.2126 * img.rgba[i] + 0.7152 * img.rgba[i + 1] + 0.0722 * img.rgba[i + 2];
      sum += lum; sumSq += lum * lum; n++;
    }
  }
  const mean = n ? sum / n : 0;
  const variance = n ? sumSq / n - mean * mean : 0;
  return { pixels: n, meanLuma: mean, variance: Math.max(0, variance) };
}

/** 读文件并解码 */
export function loadPng(file) {
  return decodePng(fs.readFileSync(file));
}

// ── CLI ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('  用法: node tools/vision/diff.mjs <a.png> <b.png> [--threshold N]');
    process.exit(2);
  }
  const ti = args.indexOf('--threshold');
  const threshold = ti >= 0 ? Number(args[ti + 1]) : 8;
  const [fa, fb] = args;
  if (!fs.existsSync(fa) || !fs.existsSync(fb)) { console.log('  ✗ 文件不存在'); process.exit(2); }
  const a = loadPng(fa), b = loadPng(fb);
  const d = diffImages(a, b, threshold);
  console.log('  视觉差异比对 · ' + path.basename(fa) + ' vs ' + path.basename(fb));
  if (!d.comparable) { console.log('  ❔ ' + d.reason + '（不可比，不硬比）'); process.exit(2); }
  console.log('  尺寸 ' + d.width + 'x' + d.height + ' · 阈值 ' + threshold);
  console.log('  差异像素 ' + d.diffPixels + '/' + d.totalPx + ' = ' + (d.diffRate * 100).toFixed(2) + '%');
  if (d.bbox) console.log('  差异区域 x=' + d.bbox.x + ' y=' + d.bbox.y + ' w=' + d.bbox.w + ' h=' + d.bbox.h);
  const state = d.diffPixels === 0 ? 'PASS' : 'WARN';
  console.log('\n  四态: ' + state);
  process.exit(state === 'PASS' ? 0 : 3);
}
