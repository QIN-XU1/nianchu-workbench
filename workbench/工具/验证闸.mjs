#!/usr/bin/env node
/**
 * 验证闸 —— 决定「这条经验值不值得进记忆」
 *
 * ══════════════════════════════════════════════════════════════
 *  设计依据（视频 BV19KW464Eov 原文）
 * ══════════════════════════════════════════════════════════════
 *
 *  > [05:42] 「它做项目一，产生项目信息。
 *  > 比如它就连接服务器——有没有连接成功？
 *  > 连接成功了，它学会一个技能，**直接通过验证闸写回到它的私有记忆**。
 *  > 那它是不是以后永远会连接这个服务器？它就不会忘了。」
 *
 * ══════════════════════════════════════════════════════════════
 *  这个闸解决什么问题
 * ══════════════════════════════════════════════════════════════
 *
 *  我们现在的做法：**任务结束就写 §五**。
 *  结果是：记了一堆过程，真正有用的没几条。
 *
 *  他的做法：**先过验证闸**，判断「这条值不值得记」。
 *
 *  AI 自己在闭环里也说过：
 *    「记忆的价值在密度、不在条数；没有真新结论就宁可合并，
 *      别为满足闭环而造数。」
 *
 * ══════════════════════════════════════════════════════════════
 *  ⚠ 2026-11-13：闸 1 从「自由文本」改成「必须引用可验证凭证」
 * ══════════════════════════════════════════════════════════════
 *
 *  【为什么要改】这个工具自己承认过一个盲区：
 *    「只查五道闸的判定逻辑，不查 AI 是否真的如实填写了闸门输入」
 *
 *  这就是 **verifier 握在被验证者手里** 的经典问题：
 *    AI 自己填「闸 1：有真结果 ✓」，闸就放行了 ——
 *    而那个「真结果」可能根本不存在。
 *    判据本身没错，错的是**判据的输入由被验证者自由书写**。
 *
 *  Hermes 的原则（hermes 逆向 §8 借鉴 3 引的原话）：
 *    > the rule has to stand without the story
 *      （规则必须能脱离故事独立成立）
 *  同一份逆向笔记里还有一条更锋利的：
 *    > "a sentence like 'I've added that to my memory' is just text"
 *      （「我已经写进记忆了」这句话只是文字）
 *  把「故事」换成「凭证」，闸才不依赖 AI 的自述。
 *
 *  【改成什么样】
 *  不再接受 --evidence "我跑了测试，都通过了"，
 *  要求 --evidence 引用**工具自己能去核的东西**（三种，前缀必填）：
 *
 *    path:<文件路径>              → Test-Path 该文件存在，且非 0 字节
 *    hash:<文件路径>:<sha256>     → 文件存在 + 实算 sha256 与给出的 64 位十六进制一致
 *    output:<文件路径>            → 文件存在 + 能解析为 JSON，或至少是非空文本
 *
 *  工具**自己去验证**（statSync / createHash / JSON.parse），
 *  **指不出凭证就拒**（exit 非 0）。
 *
 *  【向后兼容：代价必须写在这里，否则就是偷偷放宽】
 *  老的自由文本 --evidence 不能直接崩（否则现有调用全废），所以：
 *    · 不带 path:/hash:/output: 前缀 → 只报警告，**降级为「未验证」**，仍放行；
 *    · 这条降级路径意味着「不写前缀的 AI 仍能绕过」—— 它被**明确标注**在
 *      输出的结论行和 --check 里，不是静默放行；
 *    · 要收紧的调用方加 --strict-evidence：未识别凭证一律拒（exit 1）。
 *  这是「不破坏现有调用」与「不能假装验过」之间的显式取舍，不是遗漏。
 *
 *  【改完之后还剩什么盲区】（详见 数据/.dsh/机制盲区.json）
 *    ① 老自由文本仍按兼容模式放行（需 --strict-evidence 才收死）；
 *    ② 闸 2/4/5 的复用说明、结论形态、时效性仍是自由文本，没有凭证；
 *    ③ 凭证只证明「文件存在且非空」，**不证明它与这条经验相关** ——
 *       拿一份无关的测试报告也能过（内容相关性无法静态判，只能人查）；
 *    ④ 闸 3 的 containment 只比字面 2-gram，语义相同也可能漏判。
 *
 * ══════════════════════════════════════════════════════════════
 *  不变量（机制清单会从这些 INV- 行里提）
 * ══════════════════════════════════════════════════════════════
 *
 *  INV-1  gate1-min-len             结果描述至少 4 字
 *  INV-2  gate1-not-empty-word      只有「完成/好了」这类空话不算结果
 *  INV-3  gate1-signal              结果必须带文件/路径/数字/动作/命令任一信号
 *  INV-4  evidence-format           凭证必须带 path:/hash:/output: 前缀才被识别
 *  INV-5  evidence-path-exists      path 凭证必须 Test-Path 成功
 *  INV-6  evidence-path-is-file     path 凭证必须是文件，不是目录
 *  INV-7  evidence-nonempty         凭证文件不能是 0 字节（空文件不能当证据）
 *  INV-8  evidence-hash-format      hash 凭证必须形如 hash:<路径>:<64 位十六进制>
 *  INV-9  evidence-hash-match       hash 凭证的 sha256 必须与文件实算一致
 *  INV-10 evidence-output-parse     output 凭证必须可解析为 JSON 或非空文本
 *  INV-11 evidence-no-empty-path    前缀后路径为空 → 拒
 *  INV-12 evidence-compat           未识别前缀的自由文本 → 降级「未验证」（默认放行）
 *  INV-13 evidence-strict           --strict-evidence 下未识别凭证 → 拒
 *  INV-14 evidence-mode-cli         只给 --evidence → 凭证模式，通过 exit 0 / 不通过 exit 1
 *  INV-15 gate2-min-len             复用说明至少 10 字
 *  INV-16 gate2-trigger             必须说出「下次/以后/遇到…时」这类触发条件
 *  INV-17 gate3-known-ratio         containment ≥85% 判「已知道」→ NOOP
 *  INV-18 gate4-min-len             结论至少 12 字
 *  INV-19 gate4-process-ratio       过程词多于结论词 2 倍且超阈值 → 判过程流水
 *  INV-20 gate4-need-conclusion     零结论词 → 拒
 *  INV-21 gate5-temp-state          依赖临时状态且无失效条件 → 拒
 *  INV-22 gates-order               五道按序判，任一不过即停
 *  INV-23 gates-stop-at             必须报出停在第几道
 *  INV-24 selftest-counter          自测必须含「应当失败的反例」
 *  INV-25 check-rate                真实语料放行率必须在 0 与 100% 之间
 *  INV-26 check-golden              已知答案样本必须判对（防判据退化成抛硬币）
 *
 * ══════════════════════════════════════════════════════════════
 *  闸的五道判断（按顺序，任何一道不过就不写）
 * ══════════════════════════════════════════════════════════════
 *
 *  闸 1  有没有真结果？
 *        必须有可验证的结果（文件改了 / 命令成功 / 数字变了）
 *        只有「我做了」不算
 *
 *  闸 2  这个结果下次会用吗？
 *        必须能指出「下次什么情况下会用到它」
 *        指不出来 = 过程记录，不写
 *
 *  闸 3  是不是已知的？
 *        与已有记忆做 containment 比对
 *        ≥85% 已知 → NOOP（不写）
 *
 *  闸 4  是「结论」还是「过程」？
 *        过程（我做了 A 然后 B 然后 C）→ 不写
 *        结论（A 情况下应该 B）→ 写
 *
 *  闸 5  会不会误导？
 *        如果结论依赖当时的临时状态，要标注时效
 *        否则 → 降级为「软性记录」或拒写
 *
 * ══════════════════════════════════════════════════════════════
 *  用法
 * ══════════════════════════════════════════════════════════════
 *
 *  node 工具/验证闸.mjs --scene 架构梳理 \
 *       --result "改了 3 个文件，测试通过" \
 *       --reuse "下次改架构时知道要先跑章节唯一性检查" \
 *       --text "改动前先跑合并重复章节.mjs，否则锚点会失效"
 *
 *  ⚠ 上面这种 --result 是**老的自由文本**，现在会报警告并降级为「未验证」。
 *    要真验闸 1，改用 --evidence 指凭证（三选一，前缀必填）：
 *
 *       --evidence "path:数据/.dsh/报告/测试结果.json"
 *             文件存在且非空即通过
 *       --evidence "hash:工具/验证闸.mjs:<sha256 共 64 位>"
 *             文件存在且实算 hash 与给出值一致才通过
 *       --evidence "output:数据/.dsh/缓存/运行输出.json"
 *             文件存在、可解析为 JSON（或至少是乱码之外的非空文本）
 *
 *  node 工具/验证闸.mjs --evidence "path:工具/验证闸.mjs"            # 凭证模式
 *  node 工具/验证闸.mjs --evidence "path:不存在的文件.json"           # 非 0
 *  node 工具/验证闸.mjs --evidence "path:工具/验证闸.mjs" --strict-evidence
 *       严格模式：未识别的凭证格式一律拒（不降级）
 *
 *  node 工具/验证闸.mjs --check
 *       体检：用真实记忆语料验判据（不需要你给一条经验，机制体检用这个）
 *
 *  node 工具/验证闸.mjs --selftest
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const MEM_ROOT = path.join(WB, '数据', '.dsh', '场景记忆');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

export const THRESHOLDS = {
  /** 闸 2：reuse 说明最少多少字才算「说清了」 */
  MIN_REUSE_LEN: 10,
  /** 闸 3：containment 超过这个算「已知道」 */
  KNOWN_RATIO: 0.85,
  /** 闸 4：过程性描述的判定阈值 */
  PROCESS_RATIO: 0.5,
  /** 结论最短长度 */
  MIN_CONCLUSION_LEN: 12,
  /** 凭证文件最少字节数（0 字节不能当证据） */
  MIN_EVIDENCE_BYTES: 1,
  /** output: 凭证允许的乱码比例上限（超过视为二进制） */
  MAX_GARBLE_RATIO: 0.05,
};

/** 被识别的凭证前缀（大小写不敏感） */
export const EVIDENCE_KINDS = ['path', 'hash', 'output'];

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  凭证验证（闸 1 的新判据）
//
//  设计原则（Hermes：「the rule has to stand without the story」）：
//    闸 1 不再问「你说有没有真结果」，而是问「凭证在哪，我自己去看」。
//    AI 说什么都不算，文件在不在、hash 对不对、能不能解析 —— 由本工具实算。
//
//  三种格式（前缀必填，中英文冒号都收）：
//    path:<文件路径>                    存在 + 是文件 + 非 0 字节
//    hash:<文件路径>:<sha256 64 位hex>   存在 + 实算 sha256 一致
//    output:<文件路径>                  存在 + 可解析 JSON，或至少是可读非空文本
//
//  路径解析：绝对路径直接用；相对路径先按**项目根**解析（工具约定），
//            再按 cwd 兜底。两条都找不到 → 报「不存在」（安全方向：拒）。
// ══════════════════════════════════════════════════════════════

function stripBom(s) {
  return String(s || '').replace(/^\uFEFF/, '');
}

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

/** 相对路径先按项目根、再按 cwd 解析；都不存在时返回首选候选（供报错用） */
export function resolveEvidencePath(p) {
  const raw = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;
  const cands = path.isAbsolute(raw)
    ? [raw]
    : [path.resolve(WB, raw), path.resolve(process.cwd(), raw)];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0];
}

/**
 * 验证一条 --evidence 凭证。
 * @returns {{
 *   ok: boolean,          闸 1 是否放行
 *   verified: boolean,    true=凭证真的被核过；false=兼容模式「未验证」
 *   compat: boolean,      是否是老自由文本降级
 *   kind: string|null,    path / hash / output
 *   path: string|null,    实际解析到的绝对路径
 *   bytes: number|null,   凭证文件字节数
 *   reason: string        人读的理由（差异集合，不是 0/1）
 * }}
 */
export function verifyEvidence(evidence, opts) {
  const o = opts || {};
  const raw = stripBom(evidence == null ? '' : evidence).trim();

  const miss = (reason, extra) => ({
    ok: false, verified: false, compat: false, kind: null,
    path: null, bytes: null, reason, ...(extra || {}),
  });

  if (!raw) {
    return miss('没给 --evidence —— 闸 1 现在要求引用可验证凭证（path:/hash:/output:）');
  }

  const m = raw.match(/^(path|hash|output)\s*[:：]\s*([\s\S]*)$/i);

  // ── 老自由文本：降级「未验证」 ──
  if (!m) {
    const sample = raw.slice(0, 40) + (raw.length > 40 ? '…' : '');
    if (o.strict) {
      return miss('未识别凭证格式（「' + sample + '」）—— 需要 path:/hash:/output: 前缀，' +
        '--strict-evidence 下拒', { compat: true });
    }
    return {
      ok: true,
      verified: false,
      compat: true,
      kind: null,
      path: null,
      bytes: null,
      reason: '⚠ 未验证：「' + sample + '」是自由文本，不是凭证 —— ' +
        '兼容模式放行，但闸 1 实际上没被证明（要真验请用 path:/hash:/output:）',
    };
  }

  const kind = m[1].toLowerCase();
  const rest = m[2].trim();

  // ── path: / output: ──
  if (kind === 'path' || kind === 'output') {
    if (!rest) {
      return miss('凭证 ' + kind + ': 后面没给路径');
    }
    const abs = resolveEvidencePath(rest);
    const st = statOrNull(abs);
    if (!st) {
      return miss('凭证文件不存在：' + rest + '（闸 1 要的是真实存在的产物，不是描述）',
        { kind, path: abs });
    }
    if (st.isDirectory()) {
      return miss('凭证必须是文件，给的是目录：' + rest, { kind, path: abs });
    }
    if (st.size < THRESHOLDS.MIN_EVIDENCE_BYTES) {
      return miss('凭证文件是空文件（0 字节），空文件不能当证据：' + rest,
        { kind, path: abs, bytes: st.size });
    }

    if (kind === 'path') {
      return {
        ok: true, verified: true, compat: false, kind,
        path: abs, bytes: st.size,
        reason: '凭证存在且非空：' + rest + '（' + st.size + ' 字节）',
      };
    }

    // output: 要求能解析为 JSON，或至少是非空的可读文本
    const rawUtf8 = (() => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } })();
    if (rawUtf8 === null) {
      return miss('凭证文件读不出来：' + rest, { kind, path: abs, bytes: st.size });
    }
    const txt = stripBom(rawUtf8).trim();
    if (!txt) {
      return miss('凭证文件只有空白（无有效内容）：' + rest,
        { kind, path: abs, bytes: st.size });
    }
    let isJson = false;
    try { JSON.parse(txt); isJson = true; } catch { isJson = false; }
    if (isJson) {
      return {
        ok: true, verified: true, compat: false, kind,
        path: abs, bytes: st.size, parsed: 'json',
        reason: '凭证存在且是合法 JSON：' + rest + '（' + st.size + ' 字节）',
      };
    }
    // 非 JSON：至少要是可读文本，不能是二进制乱码
    const garble = (txt.match(/\uFFFD/g) || []).length;
    if (garble / txt.length > THRESHOLDS.MAX_GARBLE_RATIO) {
      return miss('凭证文件不是 JSON，且像二进制/乱码（' + garble + ' 个替换字符）：' + rest,
        { kind, path: abs, bytes: st.size });
    }
    return {
      ok: true, verified: true, compat: false, kind,
      path: abs, bytes: st.size, parsed: 'text',
      reason: '凭证存在且是可读文本（非 JSON）：' + rest + '（' + st.size + ' 字节）',
    };
  }

  // ── hash:<路径>:<sha256> ──
  //   注意：Windows 路径本身带冒号（C:\…），所以从**右往左**认最后那 64 位十六进制。
  const hm = rest.match(/^(.*)[:：]([0-9a-fA-F]{64})$/);
  if (!hm) {
    return miss('凭证 hash: 格式应为 hash:<文件路径>:<64 位十六进制 sha256>，' +
      '收到的「' + (rest.slice(0, 48) || '(空)') + '」', { kind });
  }
  const target = hm[1].trim();
  const want = hm[2].toLowerCase();
  if (!target) {
    return miss('凭证 hash: 里没给文件路径', { kind });
  }
  const abs = resolveEvidencePath(target);
  const st = statOrNull(abs);
  if (!st) {
    return miss('凭证文件不存在：' + target, { kind, path: abs });
  }
  if (st.isDirectory()) {
    return miss('凭证必须是文件，给的是目录：' + target, { kind, path: abs });
  }
  if (st.size < THRESHOLDS.MIN_EVIDENCE_BYTES) {
    return miss('凭证文件是空文件（0 字节），空文件不能当证据：' + target,
      { kind, path: abs, bytes: st.size });
  }
  const actual = sha256File(abs);
  if (actual !== want) {
    return miss('hash 不匹配：给出 ' + want.slice(0, 12) + '…，实算 ' + actual.slice(0, 12) +
      '…（文件被改过，或 hash 抄错了）',
      { kind, path: abs, bytes: st.size, actual, expected: want });
  }
  return {
    ok: true, verified: true, compat: false, kind,
    path: abs, bytes: st.size, actual,
    reason: 'hash 匹配：' + target + '（sha256 ' + actual.slice(0, 12) + '…）',
  };
}

// ══════════════════════════════════════════════════════════════
//  闸 1：有没有真结果
// ══════════════════════════════════════════════════════════════
export function gate1RealResult(result, opts) {
  const o = opts || {};

  // ⚠ 2026-11-13：有凭证就**只认凭证**，不再看自由文本。
  //   理由：若两者都看，AI 只要写一句像样的 --result 就能盖过凭证缺失，
  //        盲区会原地复活（「有凭证检查」变成真正的装饰）。
  //   注意 verifyEvidence 用 ok，闸的统一契约是 pass —— 这里对齐，别让
  //   undefined 被当 false 之外的东西（另一边也会让「有凭证」永远不过）。
  if (o.evidence !== undefined && o.evidence !== null) {
    const ev = verifyEvidence(o.evidence, { strict: o.strict });
    return { ...ev, pass: ev.ok };
  }

  if (o.strict) {
    return {
      pass: false, ok: false, verified: false, compat: false, kind: null, path: null, bytes: null,
      reason: '--strict-evidence 下必须给 --evidence 凭证（path:/hash:/output:）',
    };
  }

  const r = String(result || '').trim();

  if (r.length < 4) {
    return { pass: false, reason: '没有结果描述（或太短）' };
  }

  // 空话检测：只有「做了/完成/好了」这类
  const EMPTY = /^(完成|好了|做了|搞定|ok|okay|done|成功)$/i;
  if (EMPTY.test(r)) {
    return { pass: false, reason: '结果只有「' + r + '」，没有可验证的内容' };
  }

  // 必须有可验证的证据：文件/命令/数字/路径/测试
  const hasFile = /[\w-]+\.\w{1,5}\b/.test(r);          // 文件名
  const hasPath = /[\\/][\w.-]+[\\/]/.test(r);            // 路径
  const hasNumber = /\d/.test(r);                          // 数字
  const hasAction = /(通过|失败|改了|新增|删除|修复|验证|测试|生成了|创建)/.test(r);
  const hasCmd = /(node|npm|git|run|执行)\s/.test(r);

  const signals = [hasFile, hasPath, hasNumber, hasAction, hasCmd].filter(Boolean).length;
  if (signals === 0) {
    return {
      pass: false,
      reason: '结果里没有可验证的证据（无文件/无路径/无数字/无动作/无命令）',
    };
  }

  // ⚠ 兼容路径：这里判的是「文字像不像有结果」，判不了「结果是否真存在」。
  //   所以放行同时**显式标未验证**，让 --check / 调用方能看见这条豁免。
  return {
    pass: true,
    verified: false,
    compat: true,
    reason: '文字上有可验证结果（' + signals + ' 个信号）但**未经凭证核实**',
    signals,
  };
}

function grams(s) {
  const out = new Set();
  const t = String(s || '').toLowerCase();
  for (const seg of (t.match(/[\u4e00-\u9fff]+/g) || [])) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  for (const w of (t.match(/[a-z][a-z0-9_-]{2,}/g) || [])) out.add(w);
  return out;
}

// ══════════════════════════════════════════════════════════════
//  闸 2：这个结果下次会用吗
// ══════════════════════════════════════════════════════════════
export function gate2Reusable(reuse) {
  const r = String(reuse || '').trim();

  if (r.length < THRESHOLDS.MIN_REUSE_LEN) {
    return {
      pass: false,
      reason: '没说清「下次什么情况会用到它」（只有 ' + r.length + ' 字，至少 ' +
        THRESHOLDS.MIN_REUSE_LEN + ' 字）',
    };
  }

  // 空话检测
  if (/^(以后会用到|下次会用到|有用|重要|有价值)$/.test(r)) {
    return { pass: false, reason: '「' + r + '」是空话，指不出具体场景' };
  }

  // 应该包含「下次/以后/再/遇到...时」这类触发条件
  const hasTrigger = /(下次|以后|再遇到|遇到.*时|如果.*就|当.*时|每次)/.test(r);
  if (!hasTrigger) {
    return {
      pass: false,
      reason: '没给出触发条件（应该说明「下次什么情况时」会用到）',
    };
  }

  return { pass: true, reason: '指出了复用场景' };
}

// ══════════════════════════════════════════════════════════════
//  闸 3：是不是已知的（containment）
// ══════════════════════════════════════════════════════════════
export function gate3NotKnown(text, existingItems) {
  const t = String(text || '');
  const tg = grams(t);
  if (tg.size === 0) return { pass: false, reason: '内容为空' };

  let best = null;
  for (const it of (existingItems || [])) {
    const ig = grams(it.text || it);
    if (ig.size === 0) continue;
    let hit = 0;
    for (const g of tg) if (ig.has(g)) hit++;
    const ratio = hit / tg.size;
    if (!best || ratio > best.ratio) {
      best = { ratio, item: it.text || it };
    }
  }

  if (best && best.ratio >= THRESHOLDS.KNOWN_RATIO) {
    return {
      pass: false,
      reason: '已知道 ' + (best.ratio * 100).toFixed(0) + '%（与「' +
        String(best.item).slice(0, 30) + '」高度重合）→ NOOP',
      ratio: +best.ratio.toFixed(3),
    };
  }

  return { pass: true, reason: '新内容（最高重合 ' + ((best?.ratio || 0) * 100).toFixed(0) + '%）' };
}

// ══════════════════════════════════════════════════════════════
//  闸 4：是「结论」还是「过程」
//
//  过程：我做了 A，然后 B，然后 C（按时间顺序的动作流水）
//  结论：A 情况下应该 B（可复用的判断）
// ══════════════════════════════════════════════════════════════
export function gate4IsConclusion(text) {
  const t = String(text || '').trim();

  if (t.length < THRESHOLDS.MIN_CONCLUSION_LEN) {
    return { pass: false, reason: '太短（' + t.length + ' < ' + THRESHOLDS.MIN_CONCLUSION_LEN + '），说不清' };
  }

  // 过程性标志：按顺序的连接词
  const PROCESS_MARKERS = /(先|然后|接着|之后|最后|第一步|第二步|首先|随后|再然后)/g;
  const processHits = (t.match(PROCESS_MARKERS) || []).length;
  const processRatio = processHits / Math.max(t.length / 20, 1);

  // 结论性标志：条件/判断/应该/必须/不要
  const CONCLUSION_MARKERS = /(应该|必须|不要|不能|要|如果.*就|否则|导致|因为.*所以|教训|结论|原则|做法)/g;
  const conclusionHits = (t.match(CONCLUSION_MARKERS) || []).length;

  // ⚠ 2026-11-12 修（死代码：PROCESS_RATIO 调不动任何判定）
  //
  //   原来两个分支都要求 `conclusionHits === 0`：
  //     if (processRatio > PROCESS_RATIO && conclusionHits === 0) return false;  // 分支A
  //     if (conclusionHits === 0) return false;                                   // 分支B
  //   分支A 的条件是分支B 的子集 → 分支A 永远不改变判定结果，
  //   只改变理由文案。于是 THRESHOLDS.PROCESS_RATIO 这个「过程性描述判定阈值」
  //   是个假阈值：调它调不动任何通过/不通过。
  //
  //   实测：「先打开文件，然后读取…最后关闭」这类纯过程流水，
  //        即使把 ratio 压到 0.09 仍被拒，但拒的理由来自分支B。
  //
  //   修法：让 PROCESS_RATIO 有独立语义 ——
  //     过程词明显多于结论词时（比值超阈值），即使有少量结论词也算过程流水。
  //     这才是「过程性描述的判定阈值」该有的行为。
  const CONCL_DOMINANT = 2;   // 结论词必须至少是过程词的这么多倍才算结论

  if (processHits > 0 && conclusionHits > 0 &&
      processHits / conclusionHits > CONCL_DOMINANT &&
      processRatio > THRESHOLDS.PROCESS_RATIO) {
    return {
      pass: false,
      reason: '过程词多于结论词（' + processHits + ' 顺序 vs ' + conclusionHits +
        ' 结论，比值 ' + (processHits / conclusionHits).toFixed(1) + ' > ' + CONCL_DOMINANT +
        '）→ 是过程流水不是结论',
    };
  }

  if (processRatio > THRESHOLDS.PROCESS_RATIO && conclusionHits === 0) {
    return {
      pass: false,
      reason: '像是过程流水（有 ' + processHits + ' 个顺序词，0 个结论词）→ 不写',
    };
  }

  if (conclusionHits === 0) {
    return {
      pass: false,
      reason: '没有结论性表述（缺少「应该/必须/不要/教训」这类判断）',
    };
  }

  return {
    pass: true,
    reason: '是结论（' + conclusionHits + ' 个结论词，' + processHits + ' 个顺序词）',
    conclusionHits,
    processHits,
  };
}

// ══════════════════════════════════════════════════════════════
//  闸 5：会不会误导（时效性）
// ══════════════════════════════════════════════════════════════
export function gate5NotMisleading(text) {
  const t = String(text || '');

  // 检测依赖临时状态的表述
  const TEMP_STATE = /(现在|目前|暂时|临时|这个版本|当前配置|刚才)/g;
  const tempHits = (t.match(TEMP_STATE) || []).length;

  // 如果引用了临时状态，但没说失效条件 → 有误导风险
  const hasExpiry = /(如果.*变|当.*改|失效|不再|版本升级后|需要重新)/.test(t);

  if (tempHits > 0 && !hasExpiry) {
    return {
      pass: false,
      reason: '结论依赖临时状态（' + tempHits + ' 处「现在/目前/暂时」），但没说什么时候失效 → 有误导风险',
      needExpiry: true,
    };
  }

  return { pass: true, reason: '无时效性风险' };
}

// ══════════════════════════════════════════════════════════════
//  总闸：五道全过才写
// ══════════════════════════════════════════════════════════════
export function runGates(input) {
  const i = input || {};
  const gates = [];

  // ⚠ 2026-11-13：把 evidence / strict 透传给闸 1。
  //   有 evidence → 闸 1 只认凭证（见 gate1RealResult 的注释）；
  //   没有 → 走老的文字判据，并把结果标成「未验证」。
  const g1 = gate1RealResult(i.result, { evidence: i.evidence, strict: i.strict });
  gates.push({ id: 1, name: '有真结果', ...g1 });
  if (!g1.pass) return { pass: false, gates, verdict: '拒写', stopAt: 1 };

  const g2 = gate2Reusable(i.reuse);
  gates.push({ id: 2, name: '下次会用', ...g2 });
  if (!g2.pass) return { pass: false, gates, verdict: '拒写', stopAt: 2 };

  const g3 = gate3NotKnown(i.text, i.existing || []);
  gates.push({ id: 3, name: '不是已知', ...g3 });
  if (!g3.pass) return { pass: false, gates, verdict: 'NOOP', stopAt: 3 };

  const g4 = gate4IsConclusion(i.text);
  gates.push({ id: 4, name: '是结论', ...g4 });
  if (!g4.pass) return { pass: false, gates, verdict: '拒写', stopAt: 4 };

  const g5 = gate5NotMisleading(i.text);
  gates.push({ id: 5, name: '不会误导', ...g5 });
  if (!g5.pass) return { pass: false, gates, verdict: '需加失效条件', stopAt: 5 };

  // ⚠ 闸 1 是兼容模式（自由文本，无凭证）时，结论行必须显式带出这个事实，
  //   否则「可写入记忆」会被读成「已核实」—— 那正是要修的盲区。
  const evidenceVerified = g1.verified === true;
  const verdict = evidenceVerified ? '可写入记忆（凭证已核）' : '可写入记忆（⚠ 闸1 未验证凭证）';

  return {
    pass: true,
    gates,
    verdict,
    evidenceVerified,
    evidenceCompat: g1.compat === true,
  };
}

/** 从记忆文件提取已有条目（供闸 3 用） */
export function loadExistingItems(sceneName) {
  const dir = path.join(MEM_ROOT, sceneName);
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'AGENTS.local.md') continue;
    const md = readTextSafe(path.join(dir, f));
    if (!md) continue;
    for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^#{1,6}\s/.test(t)) continue;
      if (/^>\s/.test(t)) continue;
      if (/^[（(]?(无|待补|待填|空|只追加)[)）]?$/.test(t)) continue;
      if (t.length < 10) continue;
      items.push({ text: t.replace(/^[-*+]\s*/, '') });
    }
  }
  return items;
}

// ══════════════════════════════════════════════════════════════
//  自测
// ══════════════════════════════════════════════════════════════
function selftest() {
  const R = [];
  const chk = (n, ok, d) => { R.push(ok); console.log((ok ? '  OK   ' : '  XX   ') + n + (d !== undefined ? '  ' + d : '')); };

  console.log('═'.repeat(72));
  console.log('  验证闸 · 自测');
  console.log('═'.repeat(72));
  console.log();

  // ── 闸 1 ──
  chk('闸1：空结果拒绝', gate1RealResult('').pass === false, '');
  chk('闸1：只有「完成」拒绝', gate1RealResult('完成').pass === false, '');
  chk('闸1：只有「好了」拒绝', gate1RealResult('好了').pass === false, '');
  chk('闸1：有文件+数字通过', gate1RealResult('改了 3 个文件，测试通过').pass === true, '');
  chk('闸1：有路径通过', gate1RealResult('写入了 数据/.dsh/AGENTS.md').pass === true, '');

  // ── 闸 2 ──
  chk('闸2：没说复用场景拒绝', gate2Reusable('').pass === false, '');
  chk('闸2：空话拒绝', gate2Reusable('以后会用到').pass === false, '');
  chk('闸2：太短拒绝', gate2Reusable('有用').pass === false, '');
  chk('闸2：说清触发条件通过',
      gate2Reusable('下次改架构时，知道要先跑章节唯一性检查').pass === true, '');

  // ── 闸 3 ──
  const existing = [{ text: '架构梳理要注意结构标识的唯一性，节标题必须唯一' }];
  chk('闸3：完全重复判已知',
      gate3NotKnown('架构梳理要注意结构标识的唯一性，节标题必须唯一', existing).pass === false, '');
  chk('闸3：全新内容通过',
      gate3NotKnown('清理磁盘前必须先备份用户文档目录', existing).pass === true, '');

  // ── 闸 4 ──
  chk('闸4：纯过程拒绝',
      gate4IsConclusion('先打开文件，然后读取内容，接着修改，之后保存，最后关闭').pass === false,
      '');
  chk('闸4：纯结论通过',
      gate4IsConclusion('改动前必须先跑章节唯一性检查，否则锚点会失效').pass === true, '');
  chk('闸4：太短拒绝', gate4IsConclusion('改了').pass === false, '');

  // ── 闸 5 ──
  chk('闸5：依赖临时状态且无失效条件 → 拒绝',
      gate5NotMisleading('目前这个配置是可以的').pass === false, '');
  chk('闸5：有失效条件 → 通过',
      gate5NotMisleading('目前用这个配置，但版本升级后需要重新验证').pass === true, '');
  chk('闸5：无临时状态 → 通过',
      gate5NotMisleading('改动前先跑检查').pass === true, '');

  // ── 总闸 ──
  const good = runGates({
    result: '改了 3 个文件，测试通过',
    reuse: '下次改架构时，知道要先跑章节唯一性检查',
    text: '改动前必须先跑合并重复章节脚本，否则锚点会失效导致索引错乱',
    existing: [{ text: '无关的一条记忆内容放在这里作为干扰' }],
  });
  chk('总闸：合格输入通过', good.pass === true, good.verdict);
  chk('总闸：五道全跑', good.gates.length === 5, good.gates.length + ' 道');

  const bad = runGates({ result: '完成', reuse: '', text: '', existing: [] });
  chk('总闸：垃圾输入拒写', bad.pass === false, bad.verdict);
  chk('总闸：第一道就停', bad.stopAt === 1, 'stopAt=' + bad.stopAt);

  // ── 关键：这个闸必须能拒绝东西 ──
  const rejectCount = [
    runGates({ result: '完成', reuse: 'x', text: 'y', existing: [] }),
    runGates({ result: '改了 3 个文件', reuse: '有用', text: 'y', existing: [] }),
    runGates({ result: '改了 3 个文件', reuse: '下次遇到这种情况时要用', text: '先做A然后做B', existing: [] }),
  ].filter((r) => !r.pass).length;
  chk('关键：3 个不合格输入全部被拒', rejectCount === 3, rejectCount + ' / 3');

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 新增（机制审计 ①4「有应当失败的反例」= 0 处）
  //
  //  上面那批 chk 已经断言了 pass===false，但**没有一条是造数据去撞判据**：
  //  它们用的都是「短字符串」这种显而易见的垃圾，撞不出真正的边界。
  //
  //  下面每一条都做两件事：
  //    ① 造一份**该被拒**的真实形态数据（不是空串、不是 'y'）
  //    ② 同一个函数喂一份合格数据，确认它会放行
  //  两边都成立才叫「判据真的在区分」。
  //  如果判据退化成恒 true，反例会红；退化恒 false，正例会红。
  // ══════════════════════════════════════════════════════════════
  console.log();
  console.log('【反例】造出该被拒的数据，判据必须拒；同款合格数据必须放行');

  // 反例①：过程流水 —— 有顺序词、零结论词，形态上是「像样的句子」但没复用价值
  {
    const processText = '先打开配置文件，然后逐行读取旧值，接着改掉端口号，之后重启服务，最后看了一眼日志';
    const verdictText = '改端口前必须先确认没有别的服务占用，否则重启后连接会被拒';
    const bad = gate4IsConclusion(processText);
    const good = gate4IsConclusion(verdictText);
    chk('反例：过程流水（5 个顺序词、0 个结论词）应当被闸4 拒',
      bad.pass === false && good.pass === true,
      '过程=' + bad.pass + ' 结论=' + good.pass + ' 理由=' + bad.reason.slice(0, 24));
  }

  // 反例②：内容几乎照抄已有记忆 —— 闸3 必须判 NOOP（不是「新内容」）
  {
    const old = { text: '架构梳理必须先跑合并重复章节脚本，否则锚点会失效导致索引错乱' };
    const copy = '架构梳理必须先跑合并重复章节脚本，否则锚点会失效导致索引错乱';
    const fresh = '清理磁盘前必须先备份用户文档目录，否则删错无法恢复';
    const bad = gate3NotKnown(copy, [old]);
    const good = gate3NotKnown(fresh, [old]);
    chk('反例：照抄已有记忆应当判「已知道」',
      bad.pass === false && good.pass === true,
      '重复=' + bad.pass + ' 新内容=' + good.pass + ' 重合=' + (bad.ratio ?? '?'));
  }

  // 反例③：结论依赖临时状态却说不出失效条件 —— 闸5 必须拒，且总闸停在闸 5
  {
    // 两份都要能过闸 4（都有「不能」这类结论词），好让失败真的落在闸 5 上，
    // 否则测到的只是闸 4，闸 5 的判据根本没被撞到。
    const tempText = '目前用 3083 端口就够了，不能写死';
    const safeText = '目前用 3083 端口就够了，但如果端口变了就要重新验证，不能写死';
    const bad = runGates({
      result: '改了 2 个文件',
      reuse: '下次启动服务时，知道用哪个端口',
      text: tempText,
      existing: [{ text: '完全无关的一条旧记忆，只用来当干扰项' }],
    });
    const good = runGates({
      result: '改了 2 个文件',
      reuse: '下次启动服务时，知道用哪个端口',
      text: safeText,
      existing: [{ text: '完全无关的一条旧记忆，只用来当干扰项' }],
    });
    chk('反例：依赖临时状态又没说失效条件应当被闸5 拒',
      bad.pass === false && bad.stopAt === 5 && good.pass === true,
      '临时=' + bad.verdict + '(stopAt=' + bad.stopAt + ') 安全=' + good.verdict);
  }

  // ⚠ 2026-11-12 加：反例守护「PROCESS_RATIO 不是死阈值」
  //
  //   原来两个分支都要求 conclusionHits === 0，导致 PROCESS_RATIO
  //   只改理由文案、不改变判定 —— 调它调不动任何通过/不通过。
  //   这条反例专门盯着它：过程词明显多于结论词时必须拒。
  {
    const processHeavy = '先打开文件，然后读取内容，接着分析，之后修改，最后保存。应该这样做。';
    const r = gate4IsConclusion(processHeavy);
    chk('反例：过程词多于结论词时必须拒（PROCESS_RATIO 生效）',
        r.pass === false && /过程词多于结论词/.test(r.reason),
        r.reason);

    // 对照：结论为主的应该通过
    const conclHeavy = '教训：改判据前必须先用反例验证它真的会失败，否则就是在装饰。';
    const r2 = gate4IsConclusion(conclHeavy);
    chk('正例：结论为主时通过', r2.pass === true, r2.reason);
  }

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-13 新增：闸 1 的「凭证验证」自测
  //
  //  修的是这个工具自己承认的盲区：
  //    「只查五道闸的判定逻辑，不查 AI 是否真的如实填写了闸门输入」
  //
  //  规矩：**判据必须有反例。没有反例的自测 = 装饰。**
  //  所以下面每条都是「造一份真数据去撞判据」，不是拿空串凑数：
  //    · 不存在的路径       → 必须拒
  //    · 空文件             → 必须拒
  //    · hash 不匹配        → 必须拒
  //    · 目录当凭证         → 必须拒
  //    · 合法凭证           → 必须放行（否则判据退化成恒拒，一样是坏的）
  //  最后再验一遍 **CLI 退出码**：库函数对了但 exit code 没接，等于没修。
  // ══════════════════════════════════════════════════════════════
  console.log();
  console.log('【反例】凭证验证：造真数据撞判据，指不出凭证就拒');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-evidence-'));
  const evOk = path.join(tmpRoot, '测试结果.json');
  const evEmpty = path.join(tmpRoot, '空文件.txt');
  const evText = path.join(tmpRoot, '运行输出.txt');
  const evDir = path.join(tmpRoot, '一个目录');
  const evMissing = path.join(tmpRoot, '不存在的结果.json');

  fs.writeFileSync(evOk, JSON.stringify({ 自测: '12/12', 通过: true }, null, 2), 'utf8');
  fs.writeFileSync(evEmpty, '', 'utf8');            // 真 0 字节
  fs.writeFileSync(evText, '构建完成：产物 3 个，耗时 4.2s\n', 'utf8');
  fs.mkdirSync(evDir, { recursive: true });

  const hashOk = crypto.createHash('sha256').update(fs.readFileSync(evOk)).digest('hex');
  const hashWrong = hashOk.replace(/^./, hashOk[0] === '0' ? '1' : '0'); // 改一位，仍是 64 位 hex

  try {
    // ── path: ──
    {
      const good = verifyEvidence('path:' + evOk);
      const badMissing = verifyEvidence('path:' + evMissing);
      chk('正例：path: 指向真实非空文件 → 放行（且 verified=true）',
        good.ok === true && good.verified === true,
        'ok=' + good.ok + ' verified=' + good.verified + ' ' + good.reason);
      chk('反例：path: 指向不存在的文件 → 必须拒',
        badMissing.ok === false && /不存在/.test(badMissing.reason),
        badMissing.reason);
    }

    // ── 空文件 ──
    {
      const r = verifyEvidence('path:' + evEmpty);
      chk('反例：path: 指向 0 字节空文件 → 必须拒',
        r.ok === false && /空文件/.test(r.reason), r.reason);
    }

    // ── 目录 ──
    {
      const r = verifyEvidence('path:' + evDir);
      chk('反例：path: 指向目录 → 必须拒（目录不是产物）',
        r.ok === false && /目录/.test(r.reason), r.reason);
    }

    // ── hash: ──
    {
      const good = verifyEvidence('hash:' + evOk + ':' + hashOk);
      const bad = verifyEvidence('hash:' + evOk + ':' + hashWrong);
      const badFmt = verifyEvidence('hash:' + evOk + ':abc');
      chk('正例：hash: 与文件实算一致 → 放行',
        good.ok === true && good.verified === true && good.actual === hashOk,
        'ok=' + good.ok + ' ' + good.reason);
      chk('反例：hash: 不匹配 → 必须拒（文件被改过或 hash 抄错）',
        bad.ok === false && /hash 不匹配/.test(bad.reason), bad.reason);
      chk('反例：hash: 格式不是 64 位十六进制 → 必须拒',
        badFmt.ok === false && /格式/.test(badFmt.reason), badFmt.reason);
    }

    // ── output: ──
    {
      const json = verifyEvidence('output:' + evOk);
      const text = verifyEvidence('output:' + evText);
      const empty = verifyEvidence('output:' + evEmpty);
      chk('正例：output: 指向合法 JSON → 放行（parsed=json）',
        json.ok === true && json.parsed === 'json', json.reason);
      chk('正例：output: 指向非 JSON 但可读文本 → 放行（parsed=text）',
        text.ok === true && text.parsed === 'text', text.reason);
      chk('反例：output: 指向空文件 → 必须拒',
        empty.ok === false, empty.reason);
    }

    // ── 向后兼容：老自由文本 ──
    {
      const compat = verifyEvidence('我跑了测试，都通过了');
      const strict = verifyEvidence('我跑了测试，都通过了', { strict: true });
      chk('兼容：老自由文本 → 放行但 verified=false（降级「未验证」）',
        compat.ok === true && compat.verified === false && compat.compat === true,
        compat.reason.slice(0, 40));
      chk('反例：--strict-evidence 下老自由文本 → 必须拒',
        strict.ok === false && strict.compat === true, strict.reason.slice(0, 40));
      chk('反例：空凭证 → 必须拒（连文字都没有）',
        verifyEvidence('').ok === false, verifyEvidence('').reason);
    }

    // ── 总闸：凭证不合格必须停在闸 1 ──
    {
      const base = {
        reuse: '下次跑自测时，知道凭证要指到真实产物',
        text: '教训：闸的输入必须由工具自己核，否则闸只是被验证者自己写的作文。',
        existing: [{ text: '完全无关的一条旧记忆，只用来当干扰项' }],
      };
      const bad = runGates({ ...base, evidence: 'path:' + evMissing });
      const good = runGates({ ...base, evidence: 'path:' + evOk });
      chk('反例：凭证不存在 → 总闸拒写且 stopAt=1',
        bad.pass === false && bad.stopAt === 1, bad.verdict + ' stopAt=' + bad.stopAt);
      chk('正例：凭证合格 → 总闸放行且 evidenceVerified=true',
        good.pass === true && good.evidenceVerified === true, good.verdict);
    }

    // ── 最关键：CLI 退出码（库函数对了但 exit 没接 = 等于没修）──
    {
      const self = fileURLToPath(import.meta.url);
      const run = (args) => spawnSync(process.execPath, [self, ...args], {
        cwd: WB, encoding: 'utf8', timeout: 60000, windowsHide: true,
      });
      const rBad = run(['--evidence', 'path:' + evMissing]);
      const rGood = run(['--evidence', 'path:' + evOk]);
      chk('反例：CLI --evidence "path:<不存在>" → 退出码非 0',
        rBad.status !== 0, 'exit=' + rBad.status);
      chk('正例：CLI --evidence "path:<真实凭证>" → 退出码 0',
        rGood.status === 0, 'exit=' + rGood.status);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

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

if (isMain) {
  if (has('--selftest')) process.exit(selftest() ? 0 : 1);

  const scene = val('--scene');
  const result = val('--result');
  const reuse = val('--reuse');
  const text = val('--text');

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-12 加 --check（这个工具在体检里只能靠 selftest，从不碰真实数据）
  //
  //    为什么要分两种模式：
  //      「这条经验值不值得进记忆」**必须带一条具体经验**才能判 ——
  //      它是运行时闸门，不是可静态检查的对象。
  //      给它塞一条假经验去体检 = 假检查（本任务明令禁止）。
  //
  //    但**判据本身**可以拿真实语料校准，这是静态的、有意义的：
  //      用真实场景记忆里的条目当输入，验证五道闸的「拒绝能力」：
  //        ① 真实记忆里确实有大量「不合格」的条目（过程流水/空话）
  //           —— 如果五道闸对真实语料 100% 放行，说明闸太松，等于没闸。
  //        ② 真实的、够格的结论必须能过 —— 如果全拒，说明闸太紧。
  //      判据（可静态算）：
  //        · 放行率必须 < 100%（闸必须至少拒掉真实语料里一些东西）
  //        · 放行率必须 > 0（闸不能把真实语料全拒）
  //      这两个边界任一破了 → exit 1。
  //      没有语料 → 明确说「无数据」，不算通过也不算失败。
  // ══════════════════════════════════════════════════════════════
  if (has('--check')) {
    const scenes = fs.existsSync(MEM_ROOT)
      ? fs.readdirSync(MEM_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name)
      : [];

    let total = 0;
    let g4Pass = 0;
    const samples = [];

    for (const sc of scenes) {
      const items = loadExistingItems(sc);
      for (const it of items) {
        total++;
        // ⚠ 只量闸 4（结论/过程）的放行率，**不要**把闸 3 混进来。
        //
        //   第一版写成 `g3.pass && g4.pass`，结果 93.2% —— 那个数字主要反映
        //   「条目够不够长 / 有没有 2-gram」，闸 4 被稀释掉了：
        //   把 gate4IsConclusion 改成恒 true，放行率从 13.6% 只涨到 93.2%，
        //   检查居然还是绿的。这正是「检查测不到自己想测的东西」。
        //
        //   现在只量闸 4：它被改坏 → 放行率立刻 100% 或 0% → 必红。
        //   闸 3 需要「已有记忆库」做对照，静态跑没有意义（空库里必然全判新），
        //   所以不在这里假装能测它。
        const g4 = gate4IsConclusion(it.text);
        if (g4.pass) {
          g4Pass++;
          if (samples.length < 3) samples.push(it.text.slice(0, 50));
        }
      }
    }

    console.log('═'.repeat(72));
    console.log('  验证闸 · 检查（用真实记忆语料校准闸 4 判据）');
    console.log('═'.repeat(72));
    console.log();
    console.log('  场景数: ' + scenes.length + '   记忆条目: ' + total);
    console.log();

    if (total === 0) {
      console.log('  ○ 读不到真实记忆条目（无数据，不算通过也不算失败）');
      process.exit(0);
    }

    const rate = g4Pass / total;
    const pct = (rate * 100).toFixed(1);
    console.log('  闸4（结论/过程）放行率: ' + g4Pass + '/' + total + ' = ' + pct + '%');
    for (const s of samples) console.log('    · ' + s);
    console.log();

    const problems = [];
    // 边界 1：不能 100% 放行（否则闸形同虚设）
    if (g4Pass === total) {
      problems.push('闸4 对真实语料 100% 放行 —— 判据太松，等于没闸');
    }
    // 边界 2：不能 0% 放行（否则会把真结论也拒掉）
    if (g4Pass === 0) {
      problems.push('闸4 对真实语料 0% 放行 —— 判据太紧，真结论也进不去');
    }

    // ⚠ 2026-11-12 加：判据稳定性验证（边界1/2 挡不住「抛硬币」）
    //
    //   工人实测：把 gate4IsConclusion 改成 Math.random() < 0.5，
    //   放行率 49.6% —— 上面两条边界都通过，仍报「判据有区分度」。
    //
    //   也就是说 `--check` 只守「0 < 放行率 < 100%」这条边界，
    //   判据被换成随机函数它抓不到。这是「检查的检查」失效。
    //
    //   修法：加一组**已知答案**的样本，验证判据必须给出预期结果。
    //     · 纯过程流水 → 必须拒
    //     · 明确结论 → 必须放行
    //   随机判据会有一半概率答错，稳定性验证必然红。
    const GOLDEN = [
      { text: '先打开文件，然后读取内容，接着分析，之后修改，最后保存。', expect: false, why: '纯过程流水，无结论' },
      { text: '教训：改判据前必须先用反例验证它真的会失败，否则就是在装饰。', expect: true, why: '明确结论' },
      { text: '接着执行第二步，然后观察输出，之后记录日志，最后关闭连接。', expect: false, why: '纯过程流水' },
      { text: '原则：同一事实不要存两处，否则两份结论早晚打架。', expect: true, why: '明确结论' },
      { text: '打开终端，输入命令，等待返回，复制结果。', expect: false, why: '纯过程流水' },
      { text: '不要用整体覆盖的方式恢复数据，会冲掉并发写入。', expect: true, why: '明确结论' },
    ];
    const goldenWrong = [];
    for (const g of GOLDEN) {
      const r = gate4IsConclusion(g.text);
      if (r.pass !== g.expect) {
        goldenWrong.push({ ...g, got: r.pass, reason: r.reason });
      }
    }
    if (goldenWrong.length) {
      problems.push('闸4 在 ' + goldenWrong.length + '/' + GOLDEN.length +
        ' 个已知答案样本上判错 —— 判据退化（被改成随机/失效）');
      for (const w of goldenWrong.slice(0, 3)) {
        console.log('    ✗ 期望 ' + (w.expect ? '放行' : '拒') + '，实际 ' + (w.got ? '放行' : '拒') +
          '：' + w.text.slice(0, 30));
      }
    } else {
      console.log('  ✓ 判据在 ' + GOLDEN.length + ' 个已知答案样本上全部判对（不是抛硬币）');
    }

    // ⚠ 2026-11-13 加：凭证验证也必须接受「检查的检查」
    //
    //   新加的凭证验证本身也可能退化成恒 true（比如误写成 `if (true)`，
    //   或者把 existsSync 换成恒真）。上面那批 GOLDEN 只覆盖闸 4，
    //   挡不住闸 1 的新判据被改坏 —— 那样「已修」就只是文件里多了一堆注释。
    //
    //   这里用**临时文件**造已知答案（不碰仓库真实数据）：
    //     · 不存在的路径 → 必须拒         · 0 字节空文件 → 必须拒
    //     · hash 全 0   → 必须拒            · 真实文件     → 必须放行
    const evProblems = [];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-chk-'));
    try {
      const liveFile = path.join(tmp, 'live.json');
      const emptyFile = path.join(tmp, 'empty.txt');
      fs.writeFileSync(liveFile, JSON.stringify({ ok: true }), 'utf8');
      fs.writeFileSync(emptyFile, '', 'utf8');

      const EV_GOLDEN = [
        { ev: 'path:' + liveFile, expect: true, why: '真实非空文件' },
        { ev: 'path:' + path.join(tmp, '不存在.json'), expect: false, why: '路径不存在' },
        { ev: 'path:' + emptyFile, expect: false, why: '0 字节空文件' },
        { ev: 'hash:' + liveFile + ':' + '0'.repeat(64), expect: false, why: 'hash 不匹配' },
        { ev: 'output:' + liveFile, expect: true, why: '可解析 JSON' },
        { ev: 'output:' + emptyFile, expect: false, why: '空文件' },
      ];
      const wrong = EV_GOLDEN.filter((g) => verifyEvidence(g.ev).ok !== g.expect);
      if (wrong.length) {
        evProblems.push('凭证验证在 ' + wrong.length + '/' + EV_GOLDEN.length +
          ' 个已知答案样本上判错 —— 闸 1 的凭证判据退化');
        for (const w of wrong.slice(0, 3)) {
          console.log('    ✗ [' + w.why + '] 期望 ' + (w.expect ? '放行' : '拒') + '，实际相反');
        }
      } else {
        console.log('  ✓ 凭证判据在 ' + EV_GOLDEN.length + ' 个已知答案样本上全部判对');
      }
      // 兼容模式不能悄悄变成「验证通过」——它必须 verified=false
      const compatR = verifyEvidence('我跑了测试，都通过了');
      if (!(compatR.ok === true && compatR.verified === false)) {
        evProblems.push('老自由文本的兼容降级失效（应 ok=true 且 verified=false）');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    problems.push(...evProblems);

    if (problems.length === 0) {
      console.log('  ✓ 判据有区分度：既不是全放行，也不是全拒');
      process.exit(0);
    }
    console.log('  ✗ ' + problems.join('；'));
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-13 新增 --evidence 独立模式
  //
  //  为什么单独给一条入口：
  //    闸 1 的判据（凭证在不在、hash 对不对）是**可以单独验的**，
  //    不需要先凑齐 --scene/--reuse/--text。
  //    这也让「反例能不能真的 exit 非 0」可以直接用命令行验 ——
  //    库函数返回 false 但 CLI 没收下 exit code，等于没修。
  //
  //  判据：能验就给 0，验不了就给非 0（绝不出现「验不了但 0」）。
  // ══════════════════════════════════════════════════════════════
  const evidence = val('--evidence');
  const strictEvidence = has('--strict-evidence');

  if (evidence !== undefined && !scene) {
    const r = verifyEvidence(evidence, { strict: strictEvidence });
    console.log('═'.repeat(72));
    console.log('  验证闸 · 闸 1 凭证验证');
    console.log('═'.repeat(72));
    console.log();
    console.log('  凭证: ' + evidence);
    if (r.kind) console.log('  类型: ' + r.kind);
    if (r.path) console.log('  解析到: ' + r.path);
    if (r.bytes !== null && r.bytes !== undefined) console.log('  字节数: ' + r.bytes);
    console.log();
    console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.reason);
    console.log();
    console.log('─'.repeat(72));
    console.log('  结论: ' + (r.ok
      ? (r.verified ? '凭证已核实，闸 1 通过' : '⚠ 未验证（兼容模式放行）')
      : '拒 —— 指不出可验证凭证就不放行'));
    console.log('─'.repeat(72));
    process.exit(r.ok ? 0 : 1);
  }

  if (!scene || !result || !reuse || !text) {
    console.error('用法: node 工具/验证闸.mjs --scene <场景> --result "..." --reuse "..." --text "..."');
    console.error('      node 工具/验证闸.mjs --evidence "path:<文件路径>"        # 只验闸 1 的凭证');
    console.error('      node 工具/验证闸.mjs --evidence "hash:<路径>:<sha256>"');
    console.error('      node 工具/验证闸.mjs --evidence "output:<文件路径>"');
    console.error('      （加 --strict-evidence：未识别凭证一律拒，不降级）');
    console.error('      node 工具/验证闸.mjs --check    体检：用真实记忆语料验判据');
    console.error('      node 工具/验证闸.mjs --selftest');
    process.exit(2);
  }

  const existing = loadExistingItems(scene);
  const r = runGates({ result, reuse, text, existing, evidence, strict: strictEvidence });

  console.log('═'.repeat(72));
  console.log('  验证闸');
  console.log('═'.repeat(72));
  console.log();
  console.log('  场景: ' + scene);
  console.log('  已有记忆条目: ' + existing.length);
  console.log('  凭证模式: ' + (evidence !== undefined
    ? (/^(path|hash|output)\s*[:：]/i.test(String(evidence).trim()) ? '已给（' +
        String(evidence).match(/^(path|hash|output)/i)[1].toLowerCase() + '）' : '兼容（自由文本，未验证）')
    : '未给（⚠ 闸1 只能按文字判，未验证）'));
  if (strictEvidence) console.log('  严格模式: 开');
  console.log();

  for (const g of r.gates) {
    console.log('  ' + (g.pass ? '✓' : '✗') + ' 闸' + g.id + ' ' + g.name + '  ' + g.reason);
  }

  console.log();
  console.log('─'.repeat(72));
  console.log('  结论: ' + r.verdict);
  if (!r.pass) console.log('  停在第 ' + r.stopAt + ' 道');
  console.log('─'.repeat(72));

  process.exit(r.pass ? 0 : 1);
}
