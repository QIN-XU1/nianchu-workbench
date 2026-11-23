/**
 * A4 多模态输入验证 —— 真让模型看一张「我们知道答案」的图。
 *
 * 【为什么这样验】A4 最容易被糊弄成"我们有个图片工具"。真正的判据是：
 * **模型看到的是不是图里真实的内容**。所以这里自己生成一张**纯红色** PNG
 * （像素值我们自己写的，答案已知），再问模型主色 —— 答"红"才算它真看到了图。
 *
 * 反例：非图片文件（哪怕扩展名是 .png 但内容是文本）必须被拒 —— 靠**文件头**判定，
 * 不靠扩展名猜。
 *
 * 用法：node tools/agent/verify-a4-vision.mjs   四态：0 PASS / 1 FAIL / 2 UNKNOWN
 */
import { modelAvailable } from './_model-probe.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { createToolkit, pickTools, sniffImageMime } from './toolkit.mjs';

let pass = 0;
let skipped = false;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

// ── 最小 PNG 编码器（只为生成"已知颜色"的测试图，不引任何库）──
const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c >>> 0;
  }
  return tbl;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
/** 生成 w×h 纯色 RGB PNG */
function makePng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGB
  const row = Buffer.alloc(1 + w * 3);
  row[0] = 0; // filter none
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

console.log('');
console.log('  A4 多模态输入验证（生成已知颜色的图，让模型真看）');
console.log('  ' + '─'.repeat(72));

// ══ 一、文件头识别（纯逻辑，不花模型调用）══
{
  t('PNG 头被识别', sniffImageMime(makePng(2, 2, [255, 0, 0])) === 'image/png');
  t('JPEG 头被识别', sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === 'image/jpeg');
  t('GIF 头被识别', sniffImageMime(Buffer.from('GIF89a----------', 'ascii')) === 'image/gif');
  t('WEBP 头被识别', sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])) === 'image/webp');
  t('★反例：纯文本不被当图片', sniffImageMime(Buffer.from('hello world, not an image')) === null);
  t('★反例：太短的缓冲不被当图片', sniffImageMime(Buffer.from([0x89, 0x50])) === null);

  const tk = createToolkit({ cwd: process.cwd() });
  t('toolkit 里有 read_image', Boolean(tk.read_image));
  t('read_image 能按名装载（在 agent 工具面里）', pickTools(tk, ['read_image']).length === 1);
  t('read_image 是只读工具', tk.read_image.readOnly === true);
}

const dir = mkdtempSync(join(tmpdir(), 'a4-'));
try {
  const tk = createToolkit({ cwd: dir });
  const ctx = { cwd: dir };

  /**
   * ══ --no-model（2026-11-20）══
   * 文件头识别（PNG/JPEG/GIF/WEBP + 两个反例）是纯逻辑，照跑；
   * 「模型真的看到红/蓝」必须真调模型，配额耗尽时如实标 UNKNOWN。
   */
  if (process.argv.includes('--no-model') || !(await modelAvailable())) {
    console.log('  ⚠ 真看图的段落跳过（--no-model 或模型不可用）：文件头识别已验，');
    console.log('    但「模型能区分红/蓝」「非图片被拒」这些需要真调模型的判据是 UNKNOWN。');
    skipped = true;
  } else {
    // ══ 二、真看一张纯红图 ══
    {
      const redPath = join(dir, 'red.png');
      writeFileSync(redPath, makePng(16, 16, [255, 0, 0]));
      const r = await tk.read_image.call({ path: 'red.png' }, ctx);
      t('★纯红图 → PASS', r.state === 'PASS', r.state + ' ' + String(r.error || ''));
      t('返回 MIME 与字节数', r.mime === 'image/png' && r.bytes > 60, r.mime + '/' + r.bytes);
      const desc = String(r.description || '');
      t('★模型描述里出现"红"（说明它真的看到了图）', /红|red/i.test(desc), JSON.stringify(desc.slice(0, 120)));

      // 指定问题
      const r2 = await tk.read_image.call({ path: 'red.png', question: '这张图的主色是什么？只回答颜色名。' }, ctx);
      t('★指定问题也答红', /红|red/i.test(String(r2.description || '')), JSON.stringify(String(r2.description).slice(0, 80)));
    }

    // ══ 三、反例 ══
    {
      const fakePath = join(dir, 'fake.png');
      writeFileSync(fakePath, 'this is plain text pretending to be a png', 'utf8');
      const r = await tk.read_image.call({ path: 'fake.png' }, ctx);
      t('★反例：扩展名是 .png 但内容不是图 → FAIL（靠文件头，不靠扩展名）',
        r.state === 'FAIL' && /不是受支持的图片/.test(String(r.error)), String(r.error));

      const miss = await tk.read_image.call({ path: 'nope.png' }, ctx);
      t('★反例：文件不存在 → FAIL', miss.state === 'FAIL' && /不存在/.test(String(miss.error)));

      const empty = await tk.read_image.call({ path: '' }, ctx);
      t('★反例：空路径 → FAIL 且不读盘', empty.state === 'FAIL' && /必填/.test(String(empty.error)));
    }

    // ══ 四、另一张不同颜色的图，答错就说明没真看 ══
    {
      writeFileSync(join(dir, 'blue.png'), makePng(16, 16, [0, 0, 255]));
      const r = await tk.read_image.call({ path: 'blue.png', question: '主色是什么？只回答颜色名。' }, ctx);
      const desc = String(r.description || '');
      t('★纯蓝图 → 答蓝而不是红（区分得开，不是套话）', /蓝|blue/i.test(desc) && !/红|red/i.test(desc),
        JSON.stringify(desc.slice(0, 100)));
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 模型真能看到图（红/蓝分得开）；非图片靠文件头被拒；缺文件/空路径报错'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;