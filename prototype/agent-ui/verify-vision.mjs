#!/usr/bin/env node
/**
 * A4 视觉输入处理层 · 验收器（含反例）
 * 证明自研的确定性像素比对真能工作，且坏输入/不可比情况必须被拒。
 *
 * 测试样本用**纯 JS 现场生成 PNG**（不依赖外部图片、不联网）。
 */
import zlib from 'node:zlib';
import { decodePng, diffImages, regionStats } from '../../tools/vision/diff.mjs';

let pass = 0, total = 0;
const lines = [];
function T(name, ok, why) { total++; if (ok) pass++; lines.push('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok ? '' : '  ← ' + why)); }

/** 生成一张纯色/带方块 PNG（8-bit RGB，非隔行） */
function makePng(width, height, paint) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunks = [];
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([t, data]);
    let crc = 0xffffffff;
    for (const byte of crcBuf) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    chunks.push(len, t, data, c);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunk('IHDR', ihdr);
  chunk('IDAT', idat);
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat(chunks);
}

const white = () => [255, 255, 255];
const W = 32, H = 24;
const pngA = makePng(W, H, white);
const pngB = makePng(W, H, white);
// C：中间挖一个 8x8 黑块
const pngC = makePng(W, H, (x, y) => (x >= 10 && x < 18 && y >= 8 && y < 16 ? [0, 0, 0] : [255, 255, 255]));
// D：尺寸不同
const pngD = makePng(16, 12, white);

const A = decodePng(pngA), B = decodePng(pngB), C = decodePng(pngC), D = decodePng(pngD);

// ── 正例 1：PNG 解码正确 ──
T('正例 · PNG 解码尺寸正确', A.width === W && A.height === H, A.width + 'x' + A.height);
T('正例 · PNG 像素值正确（白）', A.rgba[0] === 255 && A.rgba[1] === 255 && A.rgba[2] === 255 && A.rgba[3] === 255,
  Array.from(A.rgba.slice(0, 4)).join(','));

// ── 正例 2：同图零差异 ──
const same = diffImages(A, B);
T('正例 · 相同图片 ⇒ 差异 0', same.comparable && same.diffPixels === 0, JSON.stringify(same.diffPixels));
T('正例 · 相同图片 ⇒ 无包围盒', same.bbox === null, JSON.stringify(same.bbox));

// ── 正例 3：不同图差异精确（8x8 = 64 像素）──
const diff = diffImages(A, C);
T('正例 · 差异像素数精确 = 64', diff.comparable && diff.diffPixels === 64, 'got ' + diff.diffPixels);
T('正例 · 差异率正确 = 64/(32*24)', Math.abs(diff.diffRate - 64 / (W * H)) < 1e-9, diff.diffRate);
T('正例 · 差异包围盒 = x10 y8 w8 h8',
  diff.bbox && diff.bbox.x === 10 && diff.bbox.y === 8 && diff.bbox.w === 8 && diff.bbox.h === 8, JSON.stringify(diff.bbox));

// ── 反例 1：尺寸不同 ⇒ 判不可比（不硬比）──
const un = diffImages(A, D);
T('反例 · 尺寸不同 ⇒ comparable:false（不硬比）', un.comparable === false, JSON.stringify(un));

// ── 反例 2：非 PNG 输入 ⇒ 抛错（不静默）──
let threw = false;
try { decodePng(Buffer.from('not a png at all')); } catch { threw = true; }
T('反例 · 非 PNG ⇒ 抛错', threw, '不该静默');

// ── 反例 3：截断 PNG ⇒ 抛错 ──
let threw2 = false;
try { decodePng(pngA.subarray(0, 30)); } catch { threw2 = true; }
T('反例 · 截断 PNG ⇒ 抛错', threw2, '不该静默');

// ── 正例 4：区域统计 ──
const st = regionStats(C, { x: 10, y: 8, w: 8, h: 8 });
T('正例 · 黑块区域亮度均值 = 0', Math.abs(st.meanLuma) < 1e-9, 'mean=' + st.meanLuma);
T('正例 · 黑块区域像素数 = 64', st.pixels === 64, 'px=' + st.pixels);
const stW = regionStats(A, { x: 0, y: 0, w: 4, h: 4 });
T('正例 · 白区亮度均值 ≈ 255', Math.abs(stW.meanLuma - 255) < 1e-6, 'mean=' + stW.meanLuma);

// ── 正例 5：阈值生效（大阈值把微小差异滤掉）──
const pngE = makePng(W, H, () => [250, 250, 250]); // 差 5
T('正例 · 阈值 8 滤掉差 5 的图 ⇒ 0 差异', diffImages(A, decodePng(pngE), 8).diffPixels === 0, 'threshold 未生效');
T('正例 · 阈值 2 保留差 5 的图 ⇒ 有差异', diffImages(A, decodePng(pngE), 2).diffPixels > 0, 'threshold 未生效');

// ── 正例 6：区域统计越界安全裁切 ──
const clipped = regionStats(C, { x: 28, y: 20, w: 100, h: 100 });
T('正例 · 区域越界 ⇒ 安全裁切不崩', clipped.pixels > 0 && clipped.pixels <= 4 * 4, 'px=' + clipped.pixels);

const ok = pass === total;
console.log('  A4 视觉输入处理层验收 —— 自研（确定性像素比对）');
console.log(lines.join('\n'));
console.log('\n  验收 ' + pass + '/' + total + ' · 四态: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
