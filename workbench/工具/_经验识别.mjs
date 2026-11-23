/**
 * 经验识别：从场景记忆的 §五 坑与决策里抽出「真实经验条目」
 *
 * ══════════════════════════════════════════════════════════════
 *  为什么需要独立的识别模块
 * ══════════════════════════════════════════════════════════════
 *  原来 封存集.mjs 和 场景历练.mjs 各自有一份识别逻辑，
 *  都用同一个严格正则：
 *
 *      pitBody.split(/\n(?=-\s+\d{4}-\d{2}-\d{2})/)
 *      再要求粗体标题且长度 >= 6
 *
 *  实测问题（2026-11-12 审计）：
 *    9 个场景的实际格式并不统一，严格规则漏判了 3 条真实经验：
 *
 *      故障分析  「- 2026-11-12：25 起事故共同根因不是...」      ← 无粗体标题
 *      本地电脑  「- 2026-11-12 盘点：本项目三大户 = ...」        ← 日期后是空格不是冒号
 *      调研      「- [2026-11-12] 症状：...」                    ← 日期用方括号
 *
 *    这些都是场景 agent 真正干完活写下的经验，内容有价值，
 *    只是格式没卡死成模板。**按格式判真伪是错的** ——
 *    应该按「有没有实质内容」判。
 *
 * ══════════════════════════════════════════════════════════════
 *  识别规则（宽松但有底线）
 * ══════════════════════════════════════════════════════════════
 *  一条经验 = 一个以 `- ` 开头的顶层列表项，且满足：
 *    ① 含日期标记：YYYY-MM-DD 或 [YYYY-MM-DD]
 *    ② 去掉日期后正文长度 >= 20 字（过滤掉「（只追加）」这类占位符）
 *    ③ 不是纯占位符（不含「（待补）」「（只填）」等）
 *
 *  为什么要求含日期：
 *    · 没有日期就没法追溯「什么时候学到的」
 *    · 也过滤掉「- （只追加：症状 → 根因 → 修法）」这种模板占位符
 *
 *  为什么要求正文 >= 20 字：
 *    · 过滤「- 2026-11-07：初始化场景记忆骨架」这种创建注记
 *      （它是事实，但不是「经验」）
 */

/** 占位符/注记特征：命中则不算经验 */
const PLACEHOLDER_PATTERNS = [
  /只追加[：:]?\s*症状/,
  /（待补）/,
  /（待填）/,
  /（只填）/,
  /初始化场景记忆骨架/,
  /场景由.*孵化器创建/,
];

/**
 * 取 §五 坑与决策章节的正文
 * @param {string} md 记忆全文
 * @returns {string}
 */
export function getPitSection(md) {
  const norm = String(md || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = norm.split('\n');
  let start = -1;
  let startLevel = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0) {
      // 找「坑与决策」标题，记下它的级别（## 还是 ###）
      const m = lines[i].match(/^(#{2,4})\s*.*坑与决策/);
      if (m) { start = i; startLevel = m[1].length; }
      continue;
    }
    // ⚠ 边界只能看「同级或更高级」的标题（级别数字 <= startLevel）
    //   原来用 /^#{2,3}\s/ 会把章节内部的 ### 子标题当成结束，
    //   导致中枢这种「§五 下面有 ### 子标题」的记忆被截断成空。
    const h = lines[i].match(/^(#{1,6})\s/);
    if (h && h[1].length <= startLevel) { end = i; break; }
  }
  return start < 0 ? '' : lines.slice(start + 1, end).join('\n').trim();
}

/**
 * 把 §五 正文切成「条目」
 *
 * 切分依据：以 `- ` 开头的顶层行开始新条目，后续缩进行属于当前条目。
 * 不用「按日期切」是因为日期格式不统一（有 2026-11-12、[2026-11-12]、
 * 2026-11-12 盘点 等多种写法）。
 *
 * @param {string} body §五 正文
 * @returns {Array<{ raw: string, date: string|null, text: string }>}
 */
export function splitEntries(body) {
  const lines = String(body || '').split('\n');
  const entries = [];
  let cur = null;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // 顶层列表项（- 开头且不在缩进里）开始新条目
    if (/^-\s/.test(line) && !/^\s{2,}/.test(line)) {
      if (cur) entries.push(cur);
      cur = { lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      // 章节开头的散行（可能是「（只追加）」），忽略
    }
  }
  if (cur) entries.push(cur);

  return entries.map((e) => {
    const raw = e.lines.join('\n');
    const first = e.lines[0].trim();
    // 日期：支持 2026-11-12 / [2026-11-12] / 2026-11-12 盘点
    const dm = first.match(/\[?(\d{4}-\d{2}-\d{2})\]?/);
    return {
      raw,
      date: dm ? dm[1] : null,
      text: first.replace(/^-\s*/, '').replace(/\[?\d{4}-\d{2}-\d{2}\]?/, '').trim(),
    };
  });
}

/**
 * 判断一个条目是不是「真实经验」
 * @param {{ raw: string, date: string|null, text: string }} entry
 * @returns {boolean}
 */
export function isRealExperience(entry) {
  if (!entry || !entry.date) return false;

  const raw = entry.raw || '';
  // 占位符/注记
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(raw)) return false;
  }

  // 正文（去掉日期、去掉标记符号）长度 >= 20
  let body = raw.replace(/^-\s*/, '');
  body = body.replace(/\[?\d{4}-\d{2}-\d{2}\]?/, '');
  body = body.replace(/\*\*/g, '');            // 去粗体标记
  body = body.replace(/[—\-:：→>\s]+/g, '');   // 去标点空白
  return body.length >= 20;
}

/**
 * 从一个记忆文件内容里抽出所有真实经验
 * @param {string} md 记忆全文
 * @returns {Array<{ raw: string, date: string|null, text: string }>}
 */
export function extractExperiences(md) {
  const body = getPitSection(md);
  if (!body) return [];
  return splitEntries(body).filter(isRealExperience);
}

/** 便捷：数经验条数 */
export function countExperiences(md) {
  return extractExperiences(md).length;
}
