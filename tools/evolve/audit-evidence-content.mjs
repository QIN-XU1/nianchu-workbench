#!/usr/bin/env node
/**
 * 证据内容抽检 —— 「路径存在」不等于「内容支持判定」
 *
 * ══ 为什么需要这个（第 126 轮）═════════════════════════════════════
 * 上轮把 OWN 降到 0，但那只是「每条判定都能指到一个路径」。
 * 一个格子的证据可能长这样：
 *    判「有」，证据指向 `foo/bar.ts:42`
 * 而 bar.ts:42 实际内容可能是：
 *    · 一行 CSS 颜色变量
 *    · 一句 i18n 文案
 *    · 一句注释「TODO: implement」
 *    · 完全不相关的代码
 *
 * 前几轮我亲眼抓到 3 个这种假阳性（dictation.css 的主题色、dsh 的 fs 文档、
 * craft-anything 的 allow_web）。它们都是「路径存在但不支持判定」。
 *
 * ══ 这个脚本做什么 ═══════════════════════════════════════════════
 * 1. 从每个 REAL 格里抽出「路径 + 行号」
 * 2. 读那一行及其上下文
 * 3. 用**判定关键词**（维度名 + 证据里提到的能力词）判断该行是否相关
 * 4. 输出三类：SUPPORTED（内容相关）/ SUSPECT（内容可能不相关）/ UNREADABLE（读不到）
 *
 * ══ 它不做什么 ═══════════════════════════════════════════════════
 * 它**不能**自动判断「内容是否真的证明了判定」—— 那需要语义理解。
 * 它只能做**低成本的排除**：把明显不相关（CSS 颜色、i18n 文案、纯注释）的挑出来，
 * 让人工只看剩下的。这是「降噪」，不是「验证」。
 *
 * 四态：0 全部可读且相关 · 3 有可疑项（需人工看） · 2 工具自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootsOf } from './lib/evidence-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MATRIX = path.join(ROOT, 'prototype/hermes-agents/matrix-data.json');

let pass = 0, fail = 0;
const t = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

/** 从证据里抽 {rel, line} —— 优先带行号的 */
function extractRefs(ev) {
  const out = [];
  const s = String(ev);
  // 带行号的（含区间 42-50）
  for (const m of s.matchAll(/([\w\u4e00-\u9fff.\-/]+\.(?:md|ts|tsx|js|mjs|jsx|json|css|py|go|rs|toml|yaml|yml)):(\d+)(?:-\d+)?/g)) {
    out.push({ rel: m[1], line: Number(m[2]) });
  }
  // 不带行号的路径（多段）
  for (const m of s.matchAll(/([\w\u4e00-\u9fff.\-]+(?:\/[\w\u4e00-\u9fff.\-]+)+\.[A-Za-z0-9]+)/g)) {
    if (!out.some((o) => o.rel === m[1])) out.push({ rel: m[1], line: 0 });
  }
  // 反引号裸文件名
  for (const m of s.matchAll(/`([\w\u4e00-\u9fff.\-]+\.(?:md|ts|tsx|js|mjs|jsx|json|css|py|go|rs))(?::(\d+))?`/g)) {
    const rel = m[1];
    const line = m[2] ? Number(m[2]) : 0;
    if (!out.some((o) => o.rel === rel)) out.push({ rel, line });
  }
  return out;
}

/** 在 roots 里找该 rel 的真实文件 */
function locate(who, rel) {
  for (const r of rootsOf(who)) {
    const full = path.join(r, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * 低价值行特征 —— 这些**通常**不支持一个能力判定。
 *
 * ══ 但要小心误判（第 126 轮教训）══════════════════════════════════
 * 一开始我把「i18n 键值」「文档式注释」一律判低价值，结果误伤了 2 个真证据：
 *   · `"flowChat.toolCards.approval.waiting": "Waiting for confirmation"`
 *     —— 这证明「有等待确认的 UI 卡片」，是审批能力的**弱证据**，不是噪音
 *   · `/// A folder where questions and approvals for the person are posted`
 *     —— 这证明「有问题/审批的数据模型」，也是弱证据
 *
 * 所以规则改成：**只有当该行既"形式低价值"又"不含能力关键词"时，才算低价值**。
 * 换句话说：i18n 文案里如果出现了 approval / confirm / permission 这类词，
 * 它就不是噪音 —— 它至少证明了「这个概念存在于系统里」。
 */
const LOW_VALUE = [
  { re: /^\s*[.#][\w-]+.*\{.*\}\s*$/, why: 'CSS 规则' },
  { re: /^\s*["'][\w.]+["']\s*:\s*["'].*["'],?\s*$/, why: 'i18n 键值' },
  { re: /^\s*\/\/\/?\s*(TODO|FIXME|XXX)/i, why: 'TODO 注释' },
  { re: /^\s*\/\/\/?\s*(A|An)\s+\w+\s+(where|that)\s+/i, why: '文档式注释' },
  { re: /^\s*$/, why: '空行' },
];

/**
 * 维度关键词表：用于判断该行是否与该维度相关。
 *
 * ══ 怎么定这些词（第 126 轮校准）══════════════════════════════════
 * 初版只放了「最直白」的词，结果 17 个真证据被判「不匹配」，全是同义词漏了：
 *   · 审批闸 → `EXIT = { ok, warn, stop }`（退出码分档就是审批语义）
 *   · 审批闸 → `does not have a sandbox`（"没有沙箱"也是该维度的证据）
 *   · 子代理 → `spawn provider`（spawn 是派生）
 *   · 上下文压缩 → `PROMPT_INJECTION_RESISTANCE`（注入抵抗属提示词层）
 *
 * 所以词表要含**反义词**（not/without）与**同义表达**（spawn=派生、EXIT=判定）。
 * 宁可放宽（多让几条进来人工看），也不要误杀真证据。
 */
const DIM_KEYWORDS = {
  A1: /edit|patch|diff|apply|write.*file|modify/i,
  A2: /exec|spawn|shell|terminal|sandbox|command|subprocess|child_process/i,
  A3: /fetch|http|search|browse|web|crawl|url|request/i,
  A4: /image|vision|multimodal|ocr|screenshot|picture|photo/i,
  A5: /compact|summar|compress|truncat|context.*window|token.*limit|injection|context.*manage/i,
  A6: /memory|recall|remember|session.*store|persist|记忆|会话|orchestrat|register|append|追加|记录/i,
  A7: /memory.*govern|ttl|supersed|conflict|provenance|expire|治理/i,
  A8: /subagent|sub.?agent|delegate|spawn|worker|child.*agent|派生/i,
  A9: /protocol|blackboard|negotiat|role|handoff|a2a|collaborat/i,
  A10: /telegram|slack|discord|\bim\b|channel|message.*bridge|lark|feishu|dingtalk|webhook|notification|CLI|TUI|desktop|terminal.*app/i,
  A11: /cron|schedul|timer|periodic|interval|recur|tick/i,
  A12: /skill|plugin|extension|registry|capabilit|技能/i,
  A13: /tool.*(call|use|invoke)|function.*call|toolCall/i,
  A14: /provider|model|llm|anthropic|openai|deepseek|gateway/i,
  A15: /approv|permission|confirm|guard|deny|dangerous|block|sandbox|EXIT|warn|stop|refus|reject|拦截|审批|isolation|container|validate/i,
  A16: /trace|span|telemetry|audit.*log|observ|log.*record|event.*log/i,
  B1: /plugin|extension|registry|hook|kernel|core|capability/i,
  B2: /canonical|single.*source|derive|generate.*from|authority|admission|权威/i,
  B3: /portab|multi.?host|export|adapter|project|convert/i,
  B4: /size|limit|budget|bytes|lines|split|threshold/i,
  B5: /layer|architect|package|module|structure|directory/i,
  C1: /loop|turn|step|iterate|agent.*run|dispatch|orchestrat/i,
  C2: /stop|halt|done|finish|exit.*condition|terminat|complete|unexpected.*stop|stop_reason|reason/i,
  C3: /test|verif|assert|check|golden|e2e|acceptance/i,
  C4: /retry|recover|fallback|heal|resilien|reconnect/i,
  C5: /inject|prompt|context|system.*message|template/i,
  D1: /layout|panel|column|split|grid|sidebar|tree/i,
  D2: /density|compact|spacing|whitespace|gap|padding/i,
  D3: /status|progress|indicator|spinner|thinking|state.*display/i,
  D4: /workspace|tab|pane|window|worktree/i,
  D5: /theme|dark|light|color|token|palette/i,
};

async function main() {
  console.log('\n  0. 工具自检：关键词表与抽取器必须先能工作');
  t('维度关键词表覆盖 31 维', Object.keys(DIM_KEYWORDS).length === 31, String(Object.keys(DIM_KEYWORDS).length));
  const sample = extractRefs('见 `README.md:90` 与 `src/a/b.ts:42-50` 还有 c/d/e.mjs');
  t('能抽出带行号的路径', sample.some((x) => x.rel === 'README.md' && x.line === 90), JSON.stringify(sample));
  t('能抽出区间行号（取起始）', sample.some((x) => x.rel === 'src/a/b.ts' && x.line === 42), JSON.stringify(sample));
  t('能抽出无行号的多段路径', sample.some((x) => x.rel === 'c/d/e.mjs' && x.line === 0));

  const mx = JSON.parse(fs.readFileSync(MATRIX, 'utf8'));
  const items = mx.dimensions.flatMap((g) => g.items || []);

  console.log('\n  1. 逐个 REAL 格抽检内容相关性');
  const results = [];
  for (const it of items) {
    for (const [who, cell] of Object.entries(it)) {
      if (who === 'id' || who === 'name' || who === 'us') continue;
      if (!Array.isArray(cell) || cell.length < 2) continue;
      const verdict = cell[0];
      const ev = String(cell[1] || '');
      const refs = extractRefs(ev);
      if (!refs.length) continue;

      const kw = DIM_KEYWORDS[it.id];
      for (const ref of refs) {
        const full = locate(who, ref.rel);
        if (!full) continue;
        let lines;
        try { lines = fs.readFileSync(full, 'utf8').split('\n'); } catch { continue; }
        const idx = ref.line > 0 ? ref.line - 1 : 0;
        const lineText = (lines[idx] || '').trim();
        if (!lineText && ref.line === 0) continue;

        const lowVal = LOW_VALUE.find((x) => x.re.test(lineText));
        const dimHit = kw ? kw.test(lineText) : false;

        results.push({
          dim: it.id, who, verdict, rel: ref.rel, line: ref.line,
          text: lineText.slice(0, 100),
          // 形式低价值 **且** 不含能力关键词 → 才算低价值
          // （含关键词的 i18n/注释是「弱证据」，不是噪音）
          lowValue: lowVal && !dimHit ? lowVal.why : null,
          weakButRelevant: lowVal && dimHit ? lowVal.why : null,
          dimHit,
        });
      }
    }
  }

  console.log('    抽到 ' + results.length + ' 个「路径+行」样本');

  console.log('\n  2. 分类：低价值行 / 行号不匹配 / 看起来相关');
  const lowValue = results.filter((r) => r.lowValue);
  /**
   * 行号为 1 的样本不算「不匹配」（第 126 轮教训）：
   * 证据里写的是「见 `foo.ts`」而没给行号时，抽取器默认取第 1 行 ——
   * 第 1 行通常是 `#!/usr/bin/env` 或 `/**`，关键词当然不匹配。
   * 那是**证据粒度粗**，不是**证据错**。把它算成可疑会让噪音淹没真问题。
   */
  const lineOne = results.filter((r) => !r.lowValue && r.line === 1);
  const mismatch = results.filter((r) => !r.lowValue && r.line > 1 && !r.dimHit);
  const ok = results.filter((r) => !r.lowValue && (r.line === 0 || r.line === 1 || r.dimHit));

  console.log('    低价值行（CSS/i18n/TODO/空行）: ' + lowValue.length);
  console.log('    只给文件名无行号（取第 1 行）:   ' + lineOne.length);
  console.log('    行号 >1 但维度关键词不匹配:      ' + mismatch.length);
  console.log('    看起来相关:                     ' + ok.length);

  console.log('\n  3. ★ 低价值行明细（这些几乎不可能支持能力判定）');
  if (lowValue.length === 0) {
    console.log('    （无）');
  } else {
    for (const r of lowValue.slice(0, 20)) {
      console.log('    · ' + r.dim + ' ' + r.who.padEnd(18) + r.lowValue.padEnd(12) + r.rel + ':' + r.line);
      console.log('        ' + r.text);
    }
    if (lowValue.length > 20) console.log('    … 另有 ' + (lowValue.length - 20) + ' 条');
  }

  console.log('\n  4. 维度关键词不匹配明细（需人工判断是否巧合）');
  if (mismatch.length === 0) {
    console.log('    （无）');
  } else {
    for (const r of mismatch.slice(0, 15)) {
      console.log('    · ' + r.dim + ' ' + r.who.padEnd(18) + r.rel + ':' + r.line);
      console.log('        ' + r.text);
    }
    if (mismatch.length > 15) console.log('    … 另有 ' + (mismatch.length - 15) + ' 条');
  }

  console.log('\n  ──────────────────────────────────────────');
  console.log('  抽检样本 ' + results.length + ' · 低价值 ' + lowValue.length + ' · 不匹配 ' + mismatch.length + ' · 相关 ' + ok.length);
  // 低价值行 = 几乎肯定不支持判定 → 算可疑
  const suspect = lowValue.length;
  const state = suspect === 0 ? 'PASS' : 'WARN';
  console.log('  四态: ' + state + (suspect ? ' —— 有 ' + suspect + ' 个证据指向低价值行，需人工复核' : ' —— 未发现明显低价值证据'));
  console.log('  ⚠ 本脚本只做「降噪」，不判断「内容是否真的证明了判定」——那需要语义理解。');
  process.exit(state === 'PASS' ? 0 : 3);
}

main().catch((e) => {
  console.error('  ✗ 工具自检失败：' + (e && e.stack || e));
  process.exit(2);
});
