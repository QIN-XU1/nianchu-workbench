#!/usr/bin/env node
/**
 * 证据语义相关性检查器 —— 修复独立验证方指出的核心缺陷
 *
 * 问题（H-0140 驳回理由③）：`evidence-grade.mjs` 只判 `kind==='path' && resolved===true`
 * —— **文件存在就算可核验**，导致：
 *   · A1 指向 `extensions/active-memory/types.ts`（记忆插件类型文件），diff 出现 0 次
 *   · A3 指向 `model-providers/data.test.ts`，fetch/http 出现 0 次
 *   · 6 个锚在 `knip.config.ts`（依赖卫生 lint 配置），被引行是字符串/注释
 *
 * 修法：对锚点文件**实际读内容**，用该维度的一组关键词统计命中，
 * 命中不足 ⇒ 判 `irrelevant`（不计入可核验），并给出命中的词。
 *
 * 设计原则：
 *  - **可复算**：纯函数 + 只读文件内容，同输入同输出。
 *  - **不放过也不冤枉**：阈值可调，命中 ≥ minHits 才算相关；词表来自维度名。
 *  - **反例必须能红**：空文件 / 无关文件 / 不存在的文件 ⇒ 都必须判不相关。
 */
import fs from 'node:fs';

/** 从维度名提取关键词（中英混合；按连接词切分，去掉停用词） */
export function keywordsOf(dimName) {
  const s = String(dimName || '');
  // 先按连接词/标点切成片段，避免把「代码编辑与」整段当词
  const segs = s.split(/[与和或及的、，,。;；:：\/\\|（）()【】\[\]·\s]+/).filter(Boolean);
  const words = [];
  for (const seg of segs) {
    const cjk = seg.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    const latin = seg.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [];
    words.push(...cjk, ...latin);
    // 长中文片段再切成 2 字滑窗，提高命中率（如「代码编辑」→ 代码/码编/编辑）
    for (const c of cjk) {
      if (c.length > 3) {
        for (let i = 0; i + 2 <= c.length; i++) words.push(c.slice(i, i + 2));
      }
    }
  }
  const stop = new Set(['应用', '支持', '能力', '系统', '功能']);
  const base = [...new Set(words.filter((w) => w && !stop.has(w)).map((w) => w.toLowerCase()))];

  // 中→英同义词映射：中文维度名要能在英文源码里命中
  const SYN = {
    搜索: ['search'], 抓取: ['fetch', 'crawl', 'http'], 联网: ['net', 'http', 'fetch'],
    编辑: ['edit'], 代码: ['code'], 记忆: ['memory'], 压缩: ['compress', 'compact'],
    插件: ['plugin'], 内核: ['kernel'], 技能: ['skill'], 定时: ['schedule', 'cron'],
    任务: ['task', 'job'], 主题: ['theme'], 工作区: ['workspace'], 场景: ['scene'],
    布局: ['layout'], 状态: ['state', 'status'], 密度: ['density'], 验证: ['verify'],
    独立: ['independent'], 成本: ['cost', 'price'], 多模态: ['multimodal', 'image', 'vision'],
    可移植: ['portable', 'export'], 分层: ['layer', 'arch'], 上下文: ['context'],
    注入: ['inject', 'prompt'], 协作: ['collab', 'agent'], 多代理: ['agent', 'orchestrat'],
    记忆治理: ['memory'], 溯源: ['source', 'provenance'], 冲突: ['conflict'], 审批: ['approval', 'permission'],
    拦截: ['block', 'guard', 'deny'], 体量: ['size'], 单文件: ['file'],
    终端: ['terminal', 'bash', 'shell', 'pty'], 沙箱: ['sandbox', 'jail', 'isolat'],
    子代理: ['subagent', 'sub-agent', 'agent'], 并行: ['parallel', 'concurren', 'async'],
    审计: ['audit', 'trace', 'log'], 决策: ['decision'], 权威: ['authority', 'source'],
    派生: ['derive', 'generate'], 停止: ['stop', 'halt', 'abort', 'cancel'],
    条件: ['condition', 'criteria'], 自愈: ['heal', 'recover', 'retry', 'resilien'],
    失败: ['fail', 'error'], 恢复: ['recover', 'restore'], 布局: ['layout', 'split', 'pane'],
    拖拽: ['drag', 'drop'], 分栏: ['split', 'column', 'pane'],
  };
  const extra = [];
  for (const w of base) {
    for (const [cn, ens] of Object.entries(SYN)) {
      if (w.includes(cn) || cn.includes(w)) extra.push(...ens);
    }
  }
  return [...new Set([...base, ...extra.map((e) => e.toLowerCase())])];
}

/**
 * 判定一个锚点文件是否与该维度语义相关。
 * @param file 绝对路径或 asar 内的读取器返回的文本
 * @param dimName 维度名
 * @param text 可选：直接给文本（便于单测/asar）
 * @param minHits 命中阈值，默认 1
 */
export function checkRelevance({ dimName, text, file, minHits = 1, readFile }) {
  // 【2026-11-17 修·假红】文件名本身常直接说明用途：
  //   dsh-bash-sandbox（终端沙箱）、dsh-subagent（子代理）、dsh-client-ui-trajectory（trace）
  // 只读文件内容会把它们误判不相关（假红）。这里把**路径 token** 也算作命中来源。
  const pathTokens = file
    ? String(file).split(/[\\/]+/).join(' ').split(/[^A-Za-z0-9\u4e00-\u9fa5]+/).filter((w) => w && w.length >= 3).map((w) => w.toLowerCase())
    : [];
  let content = text;
  if (content === undefined) {
    try {
      content = (readFile || ((p) => fs.readFileSync(p, 'utf8')))(file);
    } catch (e) {
      return { relevant: false, reason: 'unreadable', hits: [], error: e.message };
    }
  }
  if (typeof content !== 'string' || content.trim() === '') {
    return { relevant: false, reason: 'empty', hits: [] };
  }
  const kws = keywordsOf(dimName);
  if (kws.length === 0) return { relevant: false, reason: 'no_keywords', hits: [] };

  const lower = content.toLowerCase();
  const pathBlob = pathTokens.join(' ');
  const hits = kws.filter((k) => lower.includes(k) || (pathBlob && pathBlob.includes(k)));
  // 额外：命中次数（同词多现更有说服力）
  const counts = hits.map((k) => ({ k, n: lower.split(k).length - 1 + (pathBlob.split(k).length - 1) }));
  const totalHits = counts.reduce((a, b) => a + b.n, 0);

  if (hits.length < minHits) {
    return { relevant: false, reason: 'no_keyword_hit', hits, counts, keywords: kws };
  }
  return { relevant: true, reason: 'hit', hits, counts, totalHits, keywords: kws };
}

/** 批量评估一个维度的全部参照锚点，返回相关/不相关分类 */
export function evaluateDim(dimName, anchors, opts = {}) {
  const results = anchors.map((a) => ({
    ...a,
    ...checkRelevance({ dimName, file: a.file, text: a.text, minHits: opts.minHits, readFile: opts.readFile }),
  }));
  const relevant = results.filter((r) => r.relevant);
  return {
    dimName,
    total: results.length,
    relevant: relevant.length,
    irrelevant: results.length - relevant.length,
    results,
  };
}
