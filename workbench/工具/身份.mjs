#!/usr/bin/env node
/**
 * 身份签名 —— 把身份卡从「文档」变成「工具」
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV1o4xg6RE9m「神经中枢控制电脑」）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [06:25] 「定位卡和身份卡它是一个东西——
 *  >   定位卡是你手动写的一个东西，它算是一个**文档**；
 *  >   身份卡它是**工具**，它是由工具生成定下来的。」
 *  >
 *  > [06:32] 「有了这个东西之后，它就会变成一个**核心机制**在里面。
 *  >   就是它不需要说我要读很多文章知道自己是谁，
 *  >   是它**出厂就知道自己是个什么东西**。」
 *  >
 *  > [06:50] 「比如它出厂就带一个功能：读文件的功能、写文件的功能、
 *  >   精确替换的功能。然后我这边升级的一些，
 *  >   比如说像翻长期记忆的功能、记忆条的功能、记忆库本体、
 *  >   回执哨兵、任务看板——
 *  >   **它的已经变成核心机制在里面去了。它不是说开场就需要很多 token。**」
 *
 * ══════════════════════════════════════════════════════════════
 *  我们的问题
 * ══════════════════════════════════════════════════════════════
 *
 *  现在：身份卡.md 是 1016 B，**全文注入**每次会话。
 *  按他的说法，这是「文档」不是「工具」——每次都要付 token。
 *
 * ══════════════════════════════════════════════════════════════
 *  怎么变成「工具」（在不能改引擎的前提下）
 * ══════════════════════════════════════════════════════════════
 *
 *  拆成两层：
 *
 *    ① 身份签名（~150 B，常驻）
 *       极简：我是谁 + 一句话职责 + 一条红线
 *       这部分当作「出厂设置」，每轮都在但不占多少
 *
 *    ② 完整身份卡（1016 B，按需）
 *       通过工具调用查询：`node 工具/身份.mjs --whoami <场景>`
 *       只在需要时读
 *
 *  效果：每次会话从 1016 B 降到 ~150 B，省 850+ B
 *        需要细节时一条命令就能拿到全文
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/身份.mjs --signature <场景>     查身份签名（简版）
 *  node 工具/身份.mjs --whoami <场景>        查完整身份卡
 *  node 工具/身份.mjs --build                生成所有签名
 *  node 工具/身份.mjs --selftest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM_ROOT = path.join(WB, '数据', '.dsh', '场景记忆');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

export const LIMITS = {
  /** 签名最大字节（这是「出厂设置」的成本） */
  SIGNATURE_MAX: 220,
  /** 红线最多几条 */
  MAX_REDLINES: 2,
};

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}
function readJsonSafe(p) {
  try { return JSON.parse(readTextSafe(p)); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  从完整身份卡提取「签名」
//
//  签名 = 我是谁 + 一句话职责 + 最多 2 条红线
//  目标：≤220 B
// ══════════════════════════════════════════════════════════════
export function buildSignature(sceneName, idCardMd, sceneJson) {
  const j = sceneJson || {};
  /**
   * ⚠ 2026-11-12 修正（真实检查暴露的致命缺陷）
   *
   *  原判据：直接拿 String(idCardMd) 去 match /##\s*我是谁[\s\S]*?\n+([^\n]+)/
   *          —— 正则里的 \n 不匹配 \r\n 后的换行序列位置。
   *
   *  错在哪：9 个真实身份卡全部是 CRLF（Windows 保存），
   *          `\n+` 匹配不到「\r\n\r\n」这一串 → m1 为 null，
   *          whoami 静默回退到 j.description（场景描述）。
   *
   *  实测后果（9/9 场景全中）：
   *    · 签名里的「我是谁」不是身份卡里的自我认知，而是场景配置的一句话
   *    · 红线 0 条（「## 我不做什么」的表格同样解析不到）
   *    · 自测用 LF 字符串构造，所以自测 12/12 全绿 —— 从来没在真实数据上跑过
   *
   *  修法：先归一化换行（CRLF/CR → LF），再做所有正则匹配。
   */
  const md = String(idCardMd || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // ① 我是谁：从「## 我是谁」段取第一句
  //
  //  ⚠ 2026-11-12 修正（破坏性验证暴露的判据漏洞）
  //
  //  原判据：md.match(/##\s*我是谁[\s\S]*?\n+([^\n]+)/)
  //          —— [\s\S]*? 会越过小节边界。
  //
  //  错在哪：身份卡的「## 我是谁」段被清空时（卡被改坏/正在重建），
  //          正则跳过空小节去抓下一个小节的第一行，
  //          生成一个看起来正常、实际是「## 我能做什么」内容的签名，
  //          而 --check 也不报错。造了破坏却不失败 = 检查是装饰。
  //
  //  修法：先把小节切出来（到下一个 ## 或文末），再取小节内第一个非空行。
  let whoami = '';
  const secM = md.match(/##\s*我是谁[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
  if (secM) {
    for (const line of secM[1].split('\n')) {
      const t = line.trim();
      if (!t) continue;
      whoami = t.replace(/\*\*/g, '').trim();
      break;
    }
  }
  // 兜底：用场景 description
  if (!whoami) whoami = j.description || sceneName;

  // 砍到一句话（第一个句号/换行）
  whoami = whoami.split(/[。\n]/)[0].trim();
  if (whoami.length > 40) whoami = whoami.slice(0, 40) + '…';

  // ② 红线：从「## 我不做什么」段取前 2 条
  //
  //  ⚠ 2026-11-12 修正（真实检查暴露的第二个缺陷）
  //
  //  原判据：只认「以 | 开头」的行 —— .filter(l => /^\|/.test(l))
  //
  //  错在哪：真实身份卡里的表格是**半张表**：
  //      | 不做 | 谁做 | 为什么 |      ← 表头有前导 |
  //      |---|---|---|                  ← 分隔行有前导 |
  //      写代码 | 对应场景 | ...        ← 数据行**没有**前导 |
  //
  //    9 个场景里 8 个的「我不做什么」数据行都缺前导 |，
  //    只有 本地电脑/自我复盘 两个是全的。
  //    → 7/9 场景的红线恒为 0 条。
  //
  //  修法：先去掉前导 |（如果有），再按 | 切格；
  //       用「至少分成 2 格」作为表格数据行的判据。
  //       两种写法都能解析 —— 这不是放宽判据，是因为
  //       缺前导的表格在 Markdown 渲染器里同样显示为表格。
  const redlines = [];
  const m2 = md.match(/##\s*我不做什么[\s\S]*?(?=\n##\s|$)/);
  if (m2) {
    for (const raw of m2[0].split('\n')) {
      const line = raw.trim().replace(/^\|/, '').replace(/\|$/, '');
      if (!line) continue;
      // 跳过纯分隔行（|---|---|）
      if (/^[\s:|-]+$/.test(line)) continue;
      const cells = line.split('|').map((x) => x.trim());
      if (cells.length < 2) continue;          // 不是表格行
      const first = cells[0];
      if (!first) continue;
      if (/^(不做|不能|禁止)$/.test(first)) continue;   // 表头
      redlines.push(first);
      if (redlines.length >= LIMITS.MAX_REDLINES) break;
    }
  }
  // 兜底：从定位卡「不碰什么」取
  if (redlines.length === 0) {
    const ctx = readTextSafe(path.join(SCEN_DIR, (j.id || sceneName) + '-context.md'));
    if (ctx) {
      const m3 = ctx.match(/不碰什么[：:]([\s\S]*?)(?=\n\n|\n\*\*|\n---)/);
      if (m3) {
        const lines = m3[1].split('\n')
          .map((l) => l.replace(/^[\s·•\-*]+/, '').trim())
          .filter(Boolean);
        for (const l of lines) {
          if (l.length < 3) continue;
          redlines.push(l.split(/[（(]/)[0].trim());
          if (redlines.length >= LIMITS.MAX_REDLINES) break;
        }
      }
    }
  }

  // ③ 组装
  const L = [];
  L.push('我是**' + sceneName + '**：' + whoami);
  if (redlines.length > 0) {
    L.push('红线：' + redlines.join('；'));
  }
  L.push('详见 `node 工具/身份.mjs --whoami ' + sceneName + '`');

  let sig = L.join('\n');
  // ⚠ 2026-11-14 修（严重缺陷：硬截断把关键命令切掉了）
  //
  //   原实现：while (byteLength(sig) > LIMITS.SIGNATURE_MAX) sig = sig.slice(0, -10);
  //
  //   后果：签名超长时从**尾部**硬切，而尾部正是
  //     「详见 `node 工具/身份.mjs --whoami <场景>`」这一行。
  //   切完变成 「详见 `node 工具/身份.mjs --wh」——
  //   于是 `sig.signature.includes('--whoami')` 为 false，
  //   身份签名体检报「签名里没有 --whoami 取详情命令」。
  //
  //   实测：3 个新场景（前端/后端/工具工坊）全部中招，
  //        因为它们的 whoami 描述较长，正好触发截断。
  //
  //   修法：**截断必须保护最后一行**（那行是工具入口，不能省）。
  //        超长时先截 whoami 那句（L[0]），保留红线与命令。
  if (Buffer.byteLength(sig, 'utf8') > LIMITS.SIGNATURE_MAX) {
    const tail = L.slice(1);          // 红线 + 命令行，必须保留
    let head = L[0];
    while (Buffer.byteLength([head, ...tail].join('\n'), 'utf8') > LIMITS.SIGNATURE_MAX && head.length > 20) {
      head = head.slice(0, -6);
    }
    sig = [head, ...tail].join('\n');
    // 极端情况：连命令行都放不下，至少保证 --whoami 在
    if (Buffer.byteLength(sig, 'utf8') > LIMITS.SIGNATURE_MAX) {
      sig = '我是**' + sceneName + '**\n详见 `node 工具/身份.mjs --whoami ' + sceneName + '`';
    }
  }

  return {
    sceneName,
    signature: sig,
    bytes: Buffer.byteLength(sig, 'utf8'),
    whoami,
    redlines,
    fullCardBytes: Buffer.byteLength(md, 'utf8'),
    savedBytes: Buffer.byteLength(md, 'utf8') - Buffer.byteLength(sig, 'utf8'),
  };
}

// ══════════════════════════════════════════════════════════════
//  查完整身份卡（工具调用）
// ══════════════════════════════════════════════════════════════
export function whoami(sceneName) {
  const md = readTextSafe(path.join(MEM_ROOT, sceneName, '身份卡.md'));
  if (md === null) return { ok: false, error: '找不到身份卡: ' + sceneName };
  return { ok: true, sceneName, content: md, bytes: Buffer.byteLength(md, 'utf8') };
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  身份签名 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ① 限制
  chk('签名有上限', LIMITS.SIGNATURE_MAX > 0, String(LIMITS.SIGNATURE_MAX) + ' B');
  chk('红线最多 2 条', LIMITS.MAX_REDLINES === 2, String(LIMITS.MAX_REDLINES));

  // ② 从完整身份卡提取
  const fullCard = [
    '# 本地电脑 · 身份卡',
    '',
    '## 我是谁',
    '',
    '我是**全机清理专属助手**：关于清理的活全归我。',
    '',
    '别的场景不许自己删东西，只能给我发清理请求。',
    '',
    '## 我能做什么',
    '',
    '| 能力 | 具体做什么 |',
    '|---|---|',
    '| 列清单 | 先只读盘点 |',
    '',
    '## 我不做什么',
    '',
    '| 不做 | 谁做 |',
    '|---|---|',
    '| 删系统目录 | 谁都不做（只报不动） |',
    '| 替别的场景删东西 | 收到请求后列清单，等点头 |',
    '| 碰私人数据/备份 | 谁都不碰 |',
    '',
    '## 我的判据',
    '',
    '删除分档：可再生类可直接删；其它进回收站',
  ].join('\n');

  const sig = buildSignature('本地电脑', fullCard, {
    id: 'pc-cleanup',
    description: '全机清理专属助手',
  });

  chk('生成签名', sig.signature.length > 0, sig.signature.split('\n')[0]);
  chk('签名不超上限', sig.bytes <= LIMITS.SIGNATURE_MAX, sig.bytes + ' B');
  chk('提取了我是谁', sig.whoami.includes('全机清理'), sig.whoami);
  chk('提取了红线', sig.redlines.length > 0 && sig.redlines.length <= 2,
      sig.redlines.join('；'));
  chk('红线最多 2 条', sig.redlines.length <= 2, sig.redlines.length + ' 条');
  chk('有省下字节数', sig.savedBytes > 0,
      sig.fullCardBytes + ' B → ' + sig.bytes + ' B（省 ' + sig.savedBytes + ' B）');
  chk('签名里有查详情的命令', sig.signature.includes('--whoami'), '');

  // ③ 反例：空身份卡不崩
  const empty = buildSignature('空场景', '', { id: 'x', description: '' });
  chk('反例：空身份卡不崩', empty.signature.length > 0, empty.signature.split('\n')[0]);
  chk('反例：空身份卡也不超上限', empty.bytes <= LIMITS.SIGNATURE_MAX, empty.bytes + ' B');

  // ④ 关键：签名必须显著小于完整卡
  chk('关键：签名比完整卡小得多',
      sig.savedBytes > sig.bytes,
      '完整 ' + sig.fullCardBytes + ' → 签名 ' + sig.bytes + '，省 ' +
      Math.round(sig.savedBytes / sig.fullCardBytes * 100) + '%');

  console.log();
  const passed = R.filter(Boolean).length;
  console.log('─'.repeat(72));
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  console.log('─'.repeat(72));
  return R.every(Boolean);
}

// ══════════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// ══════════════════════════════════════════════════════════════
//  真实检查（--check）
//
//  ⚠ 2026-11-12 新增。在此之前这个工具只有 --selftest，
//    而自测全程用 LF 构造的身份卡，所以「CRLF 解析失败」这个
//    缺陷在自测里永远看不见（自测 12/12 全绿，真实数据 0/9 正确）。
//
//  判据（对每个有身份卡的场景）：
//    ① 签名里的「我是谁」必须真的来自身份卡「## 我是谁」段，
//       而不是回退到场景描述（回退 = 签名没起到「出厂就知道自己是谁」的作用）
//    ② 身份卡里有「## 我不做什么」表格 → 签名必须有红线
//    ③ 签名 ≤ SIGNATURE_MAX
//    ④ 签名必须带 --whoami 取详情命令（否则签名是文档不是工具）
// ══════════════════════════════════════════════════════════════
export function checkReal() {
  const problems = [];
  const rows = [];
  if (!fs.existsSync(MEM_ROOT)) {
    return { ok: false, checked: 0, rows, problems: ['记忆根目录不存在: ' + MEM_ROOT] };
  }

  const sceneJsons = [];
  if (fs.existsSync(SCEN_DIR)) {
    for (const f of fs.readdirSync(SCEN_DIR)) {
      if (!f.endsWith('.json')) continue;
      const j = readJsonSafe(path.join(SCEN_DIR, f));
      if (j) sceneJsons.push(j);
    }
  }

  for (const d of fs.readdirSync(MEM_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const cardPath = path.join(MEM_ROOT, d.name, '身份卡.md');
    const raw = readTextSafe(cardPath);
    if (raw === null) {
      // 没有身份卡的场景不算缺陷（可能是新建场景），但要记下来
      rows.push({ scene: d.name, skipped: true, why: '没有身份卡' });
      continue;
    }

    const sj = sceneJsons.find((j) => j.name === d.name) || {};
    const sig = buildSignature(d.name, raw, sj);
    const md = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 身份卡里「我是谁」段的第一句（人工可核对的真值）
    //
    //  ⚠ 2026-11-12 修正（破坏性验证暴露的判据漏洞）
    //
    //  原判据：md.match(/##\s*我是谁[\s\S]*?\n+([^\n]+)/)
    //          —— [\s\S]*? 会**越过小节边界**往后找第一个非空行。
    //
    //  错在哪：把「## 我是谁」的内容清空后（模拟身份卡被改坏），
    //          正则会跳过这个空小节，去抓下一个小节的第一行，
    //          于是检查仍然显示 ✓ —— 造了破坏却不报错。
    //          这正是一个「永远不会失败的检查等于装饰」的例子。
    //
    //  修法：先把小节切出来（到下一个 ## 为止），再取小节内第一个非空行。
    //        小节内没有内容 = 空 = 报错，不允许跨界兜底。
    const secM = md.match(/##\s*我是谁[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
    let cardWhoami = '';
    if (secM) {
      for (const line of secM[1].split('\n')) {
        const t = line.trim();
        if (!t) continue;
        cardWhoami = t.replace(/\*\*/g, '').trim().split(/[。\n]/)[0].trim();
        break;
      }
    }

    // 身份卡里有没有「我不做什么」表格（与 buildSignature 用同一套容错判据：
    // 数据行缺前导 | 也算表格 —— 真实身份卡 9 个里 7 个是这种写法）
    const m2 = md.match(/##\s*我不做什么[\s\S]*?(?=\n##\s|$)/);
    let hasRedlineTable = false;
    if (m2) {
      for (const raw of m2[0].split('\n')) {
        const line = raw.trim().replace(/^\|/, '').replace(/\|$/, '');
        if (!line || /^[\s:|-]+$/.test(line)) continue;
        const cells = line.split('|').map((x) => x.trim());
        if (cells.length >= 2 && cells[0] && !/^(不做|不能|禁止)$/.test(cells[0])) {
          hasRedlineTable = true;
          break;
        }
      }
    }

    const row = {
      scene: d.name,
      bytes: sig.bytes,
      redlines: sig.redlines.length,
      cardWhoami: cardWhoami.slice(0, 30),
      sigWhoami: String(sig.whoami).slice(0, 30),
      fromCard: false,
    };

    // ① 签名里的 whoami 必须来自身份卡
    //
    //  判法：取身份卡 whoami 的前 6 个字做锚，签名里必须包含它。
    //  为什么不用全等：签名会做 40 字截断 + 去 ** 记号，全等过严。
    if (!cardWhoami) {
      problems.push(d.name + '：身份卡没有「## 我是谁」段（签名无处可取）');
    } else {
      const anchor = cardWhoami.slice(0, 6);
      const fromCard = sig.whoami.includes(anchor) || cardWhoami.includes(String(sig.whoami).slice(0, 6));
      row.fromCard = fromCard;
      if (!fromCard) {
        problems.push(d.name + '：签名里的「我是谁」不是身份卡内容 —— 卡里是「' +
          cardWhoami.slice(0, 24) + '」，签名里是「' + String(sig.whoami).slice(0, 24) +
          '」（说明解析失败，回退到了场景描述）');
      }
    }

    // ② 卡里有红线表格 → 签名必须有红线
    if (hasRedlineTable && sig.redlines.length === 0) {
      problems.push(d.name + '：身份卡「我不做什么」有表格，但签名红线 0 条（表格没解析出来）');
    }

    // ③ 字节上限
    if (sig.bytes > LIMITS.SIGNATURE_MAX) {
      problems.push(d.name + '：签名 ' + sig.bytes + ' B 超上限 ' + LIMITS.SIGNATURE_MAX + ' B');
    }

    // ④ 必须带取详情命令
    if (!sig.signature.includes('--whoami')) {
      problems.push(d.name + '：签名里没有 --whoami 取详情命令（签名成了文档而不是工具）');
    }

    rows.push(row);
  }

  return { ok: problems.length === 0, checked: rows.filter((r) => !r.skipped).length, rows, problems };
}

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  // ── 真实检查 ──
  if (has('--check')) {
    const r = checkReal();
    console.log('═'.repeat(78));
    console.log('  身份签名 · 真实检查（从真实身份卡生成签名并核对来源）');
    console.log('═'.repeat(78));
    console.log();
    console.log('  ' + '场景'.padEnd(12) + '签名B'.padEnd(8) + '红线'.padEnd(6) +
      '来源'.padEnd(8) + '签名里的「我是谁」');
    console.log('  ' + '─'.repeat(72));
    for (const row of r.rows) {
      if (row.skipped) {
        console.log('  ' + row.scene.padEnd(12) + '—  ' + row.why);
        continue;
      }
      console.log('  ' + row.scene.padEnd(12) +
        String(row.bytes).padEnd(8) +
        String(row.redlines).padEnd(6) +
        (row.fromCard ? '身份卡' : '描述!').padEnd(8) +
        row.sigWhoami);
    }
    console.log('  ' + '─'.repeat(72));
    console.log('  检查了 ' + r.checked + ' 个场景');
    console.log();
    if (r.ok) {
      console.log('  ✓ 全部签名都来自真实身份卡');
    } else {
      console.log('  ✗ ' + r.problems.length + ' 个问题:');
      for (const p of r.problems) console.log('    · ' + p);
    }
    console.log('═'.repeat(78));
    process.exit(r.ok ? 0 : 1);
  }

  // ── 完整身份卡（工具调用）──
  if (has('--whoami')) {
    const scene = val('--whoami');
    const r = whoami(scene);
    if (!r.ok) { console.error('✗ ' + r.error); process.exit(2); }
    console.log(r.content);
    process.exit(0);
  }

  // ── 签名 ──
  if (has('--signature')) {
    const scene = val('--signature');
    const md = readTextSafe(path.join(MEM_ROOT, scene, '身份卡.md'));
    if (md === null) { console.error('✗ 找不到: ' + scene); process.exit(2); }
    // 找场景 json
    let sj = {};
    if (fs.existsSync(SCEN_DIR)) {
      for (const f of fs.readdirSync(SCEN_DIR)) {
        if (!f.endsWith('.json')) continue;
        const j = readJsonSafe(path.join(SCEN_DIR, f));
        if (j && j.name === scene) { sj = j; break; }
      }
    }
    const sig = buildSignature(scene, md, sj);
    console.log(sig.signature);
    process.exit(0);
  }

  // ── 生成所有签名 ──
  if (has('--build') || (!has('--whoami') && !has('--signature') && !has('--build'))) {
    console.log('═'.repeat(76));
    console.log('  身份签名（文档 → 工具）');
    console.log('═'.repeat(76));
    console.log();
    console.log('  ' + '场景'.padEnd(12) + '完整卡'.padEnd(10) + '签名'.padEnd(10) + '省'.padEnd(10) + '签名内容');
    console.log('  ' + '─'.repeat(72));

    let totalFull = 0;
    let totalSig = 0;

    for (const d of fs.readdirSync(MEM_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_')) continue;
      const md = readTextSafe(path.join(MEM_ROOT, d.name, '身份卡.md'));
      if (md === null) continue;

      let sj = {};
      if (fs.existsSync(SCEN_DIR)) {
        for (const f of fs.readdirSync(SCEN_DIR)) {
          if (!f.endsWith('.json')) continue;
          const j = readJsonSafe(path.join(SCEN_DIR, f));
          if (j && j.name === d.name) { sj = j; break; }
        }
      }

      const sig = buildSignature(d.name, md, sj);
      totalFull += sig.fullCardBytes;
      totalSig += sig.bytes;

      console.log('  ' + d.name.padEnd(12) +
        String(sig.fullCardBytes).padEnd(10) +
        String(sig.bytes).padEnd(10) +
        (sig.savedBytes + ' B').padEnd(10) +
        sig.whoami.slice(0, 24));
    }

    console.log('  ' + '─'.repeat(72));
    console.log('  ' + '合计'.padEnd(12) + String(totalFull).padEnd(10) + String(totalSig).padEnd(10) +
      (totalFull - totalSig) + ' B');
    console.log();
    console.log('  依据：视频 BV1o4xg6RE9m');
    console.log('  「身份卡它是工具，它是由工具生成定下来的。');
    console.log('   它不需要说我要读很多文章知道自己是谁，是它出厂就知道自己是个什么东西。」');
    console.log();
    console.log('  用法：需要完整身份卡时 → node 工具/身份.mjs --whoami <场景>');
    process.exit(0);
  }
}
