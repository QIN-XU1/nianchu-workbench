/**
 * 产出物推断 —— 从用户一句话里**保守地**猜「他期望产出哪些文件」。
 *
 * 背景（第 66 轮）：expectArtifacts 已能兜底，但调用方得先知道「该期望什么」。
 * 本模块把「创建 out.txt 内容 team-ok-777」这类明确语句转成 [{path, contains?}]。
 *
 * ⛔ 核心原则：**宁可少猜，不可乱猜**。
 *   推断错了会误报 FAIL（比如「帮我看看 X.txt」并不产出 X.txt）。
 *   所以只有「写动词 + 明确文件名」同时出现才判 high；
 *   只出现文件名、没有写动词 → 只给 candidates，不强推。
 *   调用方应把 high 的结果**拿给用户确认**再启用，而不是自动强加。
 */

const WRITE_VERBS = /(创建|新建|写入|写到|写一个|写个|生成|保存|输出|保存到|存到|建一个|make|create|write|generate|save|output|produce)/i;
const FILENAME = /(?:^|[\s`'"“”（(])([\w./\\-]+\.(?:txt|md|markdown|json|js|mjs|cjs|ts|csv|yaml|yml|html|htm|css|scss|sh|ps1|py|log|xml|ini|toml|conf|cfg))(?=$|[\s`'"，。、；）)])/gi;
// 内容提示（优先带引号）：「内容(是|为|写) 「xxx」/ "xxx"」
const CONTENT_QUOTED = /(?:内容|值)?\s*(?:是|为|写(?:成|入|上)?|等于)?\s*[「“"']([^「」“”"']{1,200})[」”"']/;
// 退而求其次：明确「内容」后紧跟的**单个 token**（不含空格/标点），避免乱抓整句
const CONTENT_TOKEN = /内容\s*(?:是|为|写(?:成|入|上)?|等于)?\s*[:：]?\s*([A-Za-z0-9_./\-]{1,200})/;

/**
 * @param {string} text 用户输入
 * @returns {{artifacts:Array<{path:string,contains?:string}>, confidence:'high'|'none', candidates:string[], reason:string}}
 */
export function inferArtifacts(text) {
  const s = String(text || '');
  const names = [];
  let m;
  FILENAME.lastIndex = 0;
  while ((m = FILENAME.exec(s)) !== null) {
    const p = m[1].trim();
    if (p && !names.includes(p)) names.push(p);
  }
  if (names.length === 0) {
    return { artifacts: [], confidence: 'none', candidates: [], reason: '没有识别到明确文件名（xxx.ext）' };
  }
  if (!WRITE_VERBS.test(s)) {
    // 只有文件名、没有写动词 → 不推（可能只是「看看/分析」）
    return { artifacts: [], confidence: 'none', candidates: names, reason: '有文件名但没有写动词，不推断为产出' };
  }
  const cm = CONTENT_QUOTED.exec(s) || CONTENT_TOKEN.exec(s);
  const contains = cm ? cm[1].trim() : undefined;
  const artifacts = names.map((p) => (contains ? { path: p, contains } : { path: p }));
  return {
    artifacts,
    confidence: 'high',
    candidates: names,
    reason: '检测到写动词 + 文件名' + (contains ? ' + 内容提示' : ''),
  };
}