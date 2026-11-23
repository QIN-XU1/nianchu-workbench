#!/usr/bin/env node
// 工具/面板内容体检.mjs —— 面板不只是「画出来了」，而是「真的画出了内容」
//
// ══════════════════════════════════════════════════════════════════════
//  这个工具补的是哪块盲区
// ══════════════════════════════════════════════════════════════════════
//  ⚠ 先纠正一个口径：任务书写「10 种类型、34 个面板实例」，实测不是。
//    按 workbench/外壳/scenarios/*.json 逐个数（本工具 loadScenes 走的就是这些文件）：
//      9 个场景 · 29 个面板实例 · 10 种类型
//        harness 8 / review-doc 5 / sf-board 4 / embed 4 / review-files 3
//        neuron 1 / pc-drives 1 / pc-toplarge 1 / pc-junk 1 / pc-ledger 1
//    34 这个数字对不上的原因我查不出来（可能把某个旧版本/多个配置叠加数了）。
//    本工具一律以场景 json 为准，不写死数字 —— 配置变了，检查范围自动跟着变。
//
//  盲区本身是成立的：
//    · 界面功能体检.mjs  只验证 harness 类型（8 个 AI 面板）
//                        做法是切场景 → 连 webview → 输入 → 回车 → 验消息到达
//    · 面板体检.mjs      只验证「渲染器已注册 + 配置合法」，**不看画面**
//    · 其余 21 个非 AI 面板（9 种类型）从来没有被验证过
//
//  于是有一类故障可以一路通过所有检查：
//    面板在配置里存在、渲染器也注册了、网格也不越界，
//    但切过去一看 —— 一片空白 / 卡在「加载中…」/ 显示「渲染失败」/
//    或者显示的是占位符而不是真数据。
//
//  这个工具用真实 CDP 连渲染进程，逐个场景切换，对 **每一个配置里的面板**
//  检查「容器在 + 尺寸正常 + 有实质内容 + 内容对得上真实数据 + 不是错误占位」。
//
// ══════════════════════════════════════════════════════════════════════
//  和任务书给的「参考判据」不一样的地方（都是实测逼出来的）
// ══════════════════════════════════════════════════════════════════════
//  ① sf-board 不是 svg/canvas
//     任务书建议「容器内有 svg/canvas，节点数 > 0」。
//     实测读 workbench/外壳/ui/panels/_generic.js：createSfBoard 画的是
//     DOM 卡片（`.sf-node` + 三段 grid 布局），**没有 svg、没有 canvas**。
//     按 svg/canvas 判会 4/4 全部误判为不合格。
//     ⇒ 判据改成：`.sf-node` 数量 ≥ 1，且有「当前」段与上下游/无上下游的明确说明。
//
//  ② embed 不是 iframe，是 Electron <webview>
//     实测 `document.querySelectorAll('iframe')` 在 embed 面板里恒为 0。
//     ⇒ 判据改成：`webview` 或 `iframe` 至少一个，且 src 非空且像 URL。
//
//  ③ review-doc 的 Markdown 标题不是 <h1>/<h2>
//     实测 createReviewDoc 用的 rvMd() 把标题渲染成
//     `<div style="font:600 15px ...">`，**没有 h 标签**。
//     按 h1/h2 计数会恒为 0。
//     ⇒ 判据改成：数「样式里带 font:600 的块」＝标题块，另计 table/pre。
//
//  ④ review-doc 的判据不能只看左列表
//     面板一挂载，左边是文件列表、右边是空的。**必须先点一个文件**，
//     右侧才会出现 Markdown 正文。
//     所以 review-doc 的流程是：等列表 → 点第一个文件 → 等右侧渲染 → 再判。
//     任务书说「容器存在但里面是空的（文件不存在/解析失败），那要报出来」
//     —— 指的正是只判左列表会漏掉的那一半。
//
//  ⑤ 文本长度阈值不能照抄 200
//     实测 workbench/数据/.dsh/场景记忆/故障分析/文档/故障分析.md 只有 346 字节，
//     渲染出来约 118 个字符。用 200 会把「渲染完全正常」判成失败。
//     ⇒ 阈值改成 MIN_DOC_TEXT=80，**外加必须有结构**（标题/表格/代码块至少一种），
//       并且额外做「内容对得上磁盘上的真文件」的交叉校验（见 ⑥），
//       比单看字符数更强。
//
//  ⑥ 只看「有内容」还不够，要证明内容是**这个文件的**
//     一个面板完全可能渲染出「加载中…」之外的东西却是占位符。
//     所以 review-doc 会去磁盘读 docDir 下第一个文件，
//     取它的首个标题/首行文字，要求渲染结果里**真的出现**这段文字。
//     review-files 同样：要求表格里的每个文件名都真的在目录里。
//     —— 这是「内容是真的」而不是「有 DOM」的唯一可证伪判据。
//
// ══════════════════════════════════════════════════════════════════════
//  用法
// ══════════════════════════════════════════════════════════════════════
//    node 工具/面板内容体检.mjs                  # 全部 9 个场景
//    node 工具/面板内容体检.mjs --scene 调研      # 只测一个（中文名或 id 都行）
//    node 工具/面板内容体检.mjs --json           # 机器可读
//    node 工具/面板内容体检.mjs --selftest       # 自测（不需要工作台在跑）
//
//  退出码：0 = 所有面板都有实质内容；1 = 有面板不合格；2 = 环境不可用
// ══════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { withUiLock } from './_ui-lock.mjs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB = path.resolve(HERE, '..');
const SCEN_DIR = path.join(WB, '外壳', 'scenarios');
const CDP_PORT = 9333;

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const val = (k, d) => {
  const i = argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? d : v;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════
//  判据常量（唯一出处 —— 自测和实跑都走这里）
// ══════════════════════════════════════════════════════════════════════

/** 面板容器最小尺寸（px）。小于这个数说明容器没被真正布局（被隐藏/塌陷）。 */
export const MIN_W = 40;
export const MIN_H = 30;

/** 面板整体文本的底线（连标题都不够＝根本没渲染） */
export const MIN_PANEL_TEXT = 4;

/** review-doc 右侧正文的最小字符数。见文件头 ⑤：200 会误判真内容。 */
export const MIN_DOC_TEXT = 80;

/** review-doc / review-files 需要的「结构」证据：标题块或表格至少一种 */
export const MIN_DOC_STRUCTURE = 1;

/** neuron 的 canvas 最小边长 */
export const MIN_CANVAS = 32;

/** 明确的失败文案（面板里出现就是真故障，不是「还没加载完」） */
export const FAIL_TEXT = [
  '渲染失败',
  '没有注册渲染器',
  '未配置 URL',
  '未配置目录',
  '这个面板没有配置文档目录',
  '网页加载失败',
  '✗ 读取失败',
  '✗ 统计失败',
  '✗ 扫描失败',
  '✗ 列目录失败',
  '✗ 读不了这个文件',
  '✗ 这个文件读不了',
  '接口未返回数据',
  '场景加载失败',
  '待实现',
  '待接入',
];

/** 卡在加载态（轮询到超时还在＝面板永远画不出来） */
export const LOADING_TEXT = [
  '加载中',
  '加载管线',
  '读取中',
  '读取…',
  '统计中',
  '扫描中',
  '正在读取',
  '正在统计',
  '正在扫描',
];

/** 合法的「明确无数据」提示（任务书：有条目或「无数据」的明确提示） */
export const EMPTY_OK_TEXT = {
  'pc-toplarge': ['没有扫到文件'],
  'pc-junk': ['没有发现可清理项', '没有扫到可清理项'],
  'pc-ledger': ['暂无清理记录'],
};

/** 每种类型的等待预算（毫秒）。pc-toplarge 自己就说「最多 15 秒」，所以给 30s。 */
export const WAIT_MS = {
  harness: 10000,
  'review-doc': 15000,
  'review-files': 15000,
  embed: 10000,
  'sf-board': 12000,
  neuron: 15000,
  'pc-drives': 15000,
  'pc-toplarge': 30000,
  'pc-junk': 25000,
  'pc-ledger': 15000,
};

export const POLL_MS = 500;

/** 10 种面板类型（唯一清单）。场景里出现清单外的类型 = 覆盖失败。 */
export const PANEL_TYPES = [
  'harness', 'review-doc', 'sf-board', 'embed', 'review-files',
  'neuron', 'pc-drives', 'pc-toplarge', 'pc-junk', 'pc-ledger',
];

// ⚠ 2026-11-12 加（第一版把「面板几乎没有文字」当通用判据，误判了 embed）：
//
//   实测 调研 / rs-web (embed)：innerText 只有「网页」2 个字，
//   但它的 webview 其实**加载成功了** —— CDP targets 里明确有一个
//   `webview | https://cn.bing.com/?mkt=zh-CN`，尺寸 595x790。
//   因为 Electron 的 <webview> 是独立进程（OOPIF），它的内容
//   **不会出现在父页面的 innerText 里**。
//
//   所以「文字长度」这条判据只对**文字类面板**成立，
//   对 harness / embed / neuron 这类视觉面板是无效信号，会 100% 误伤。
//   —— 这也说明「不能只看元素存在」不等于「一律用文字长度兜底」。
export const TEXTUAL_TYPES = [
  'review-doc', 'sf-board', 'review-files',
  'pc-drives', 'pc-toplarge', 'pc-junk', 'pc-ledger',
];

// ⚠ 2026-11-12 加（embed 的第二层证明）：
//
//   只看 `<webview src="...">` 属性不够 —— 属性写对了但网页加载失败时，
//   DOM 里**仍然有那个 webview**，src 也照样是非空 URL。
//   实测 竞品拆解/逆向分析的 embed 都可能指向打不开的站。
//
//   所以 embed 的合格判据是：
//     ① webview/iframe 在，src 非空且是 URL          （必要）
//     ② 没有「网页加载失败」提示条                     （必要）
//     ③ CDP targets 里存在一个指向该 URL 的 webview 目标（充分 —— 证明它真的起来了）
//   第三条由 probePanel 通过 cdpTargets() 补进 evidence.webviewLoaded。
//   拿不到 targets（CDP 抖了）时退回「src + 无失败提示」，并标 ⚠ 说明未证明加载。

/** 场景中文名 ↔ id（任务书给定，实测一致） */
export const SCENE_ID = {
  '架构梳理': 'arch-review',
  '实施计划': 'build-plan',
  '竞品拆解': 'competitor-analyze',
  '故障分析': 'incident-analysis',
  '本地电脑': 'pc-cleanup',
  '调研': 'research',
  '逆向分析': 'reverse-eng',
  '自我复盘': 'self-review',
  '中枢': 'hub',
};

// ══════════════════════════════════════════════════════════════════════
//  判据（纯函数 · 唯一出处）
// ══════════════════════════════════════════════════════════════════════
//
//  evidence 字段（由页面侧 collectExpr 采集，或自测里手工造）：
//    exists / hasBody / w / h / text / textLen
//    nodes      .sf-node 数量（sf-board）
//    rvItems    .rv-item 数量（review-doc 左列表）
//    rfRows     .rf-row 数量（review-files）
//    rfNames    .rf-row 的 data-name（review-files）
//    driveCards .pc-drive-card 数量（pc-drives）
//    driveNames .pc-drive-card 的 data-drive
//    bigRows    .pc-file-row 数量（pc-toplarge）
//    junkRows   .pc-junk-row 数量（pc-junk）
//    ledgerRows 表格行数（pc-ledger）
//    tables / svg / canvas[] / webviews[] / iframes[]
//    renderErr  .wb-empty-hint 文本（渲染失败时 index.js 会写这里）
//    docPane    review-doc 右侧正文 { exists, text, textLen, headings, tables, pre }
//
//  ctx 字段（从磁盘算出来的「期望」，证明内容是真的）：
//    expectedLines  文档里的候选行文字（至少命中一条才算「内容是这个文件的」）
//    expectedNames  目录里真实存在的文件名
//
function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').replace(/[*`~]/g, '');
}

function findText(hay, needle) {
  return norm(hay).includes(norm(needle));
}

/**
 * 判一个面板是否「真的有内容」。
 * @returns {{ok:boolean, problems:string[], warns:string[], detail:string}}
 */
export function judgePanel(e, ctx) {
  const ev = e || {};
  const c = ctx || {};
  const problems = [];
  const warns = [];

  const type = String(ev.type || '');
  const w = Number(ev.w) || 0;
  const h = Number(ev.h) || 0;
  const text = String(ev.text || '');
  const textLen = Number(ev.textLen) || 0;
  const webviews = Array.isArray(ev.webviews) ? ev.webviews : [];
  const iframes = Array.isArray(ev.iframes) ? ev.iframes : [];
  const canvases = Array.isArray(ev.canvas) ? ev.canvas : [];

  // ── 通用 ①：容器在 ──
  if (ev.exists !== true) {
    problems.push('面板容器不存在（配置里有，页面里没有）');
    return { ok: false, problems, warns, detail: '容器缺失' };
  }
  // ── 通用 ②：有 body ──
  if (ev.hasBody !== true) {
    problems.push('面板没有 .wb-panel-body（宿主容器没装配出来）');
  }
  // ── 通用 ③：尺寸 ──
  if (w < MIN_W || h < MIN_H) {
    problems.push('容器尺寸过小 ' + w + 'x' + h + '（<' + MIN_W + 'x' + MIN_H + '，被隐藏或塌陷）');
  }
  // ── 通用 ④：index.js 的渲染失败占位 ──
  if (ev.renderErr) {
    problems.push('渲染失败占位：「' + String(ev.renderErr).slice(0, 60) + '」');
  }
  // ── 通用 ⑤：明确失败文案 ──
  const failHit = FAIL_TEXT.find((m) => text.includes(m));
  if (failHit) problems.push('面板里出现失败文案：「' + failHit + '」');

  // ── 类型判据 ──
  let detail = '';
  switch (type) {
    case 'harness': {
      // 界面功能体检已覆盖「能用」；这里只验「画出来了」：容器 + 内嵌 webview 有 src
      const wv = webviews.find((x) => String(x.src || '').trim());
      if (!wv) problems.push('harness 面板里没有带 src 的 webview');
      detail = wv ? 'webview ' + String(wv.src).slice(0, 48) : '无 webview';
      break;
    }

    case 'review-doc': {
      // ① 左列表要有文件（没文件就没内容可看）
      const items = Number(ev.rvItems) || 0;
      // ② 右侧正文（点过文件才有）
      const dp = ev.docPane || {};
      const docText = String(dp.text || '');
      const docLen = Number(dp.textLen) || 0;
      const struct = (Number(dp.headings) || 0) + (Number(dp.tables) || 0) + (Number(dp.pre) || 0);

      if (!dp.exists) {
        problems.push('右侧正文区不存在（[data-rv-main] 没装配出来）');
      } else if (docLen < MIN_DOC_TEXT) {
        problems.push('右侧正文过短 ' + docLen + ' 字符（<' + MIN_DOC_TEXT +
          '）—— 面板容器在，但 Markdown 没渲染出来');
      }
      if (dp.exists && struct < MIN_DOC_STRUCTURE) {
        problems.push('右侧正文没有结构（标题 0 / 表格 0 / 代码块 0）—— 不像真的 Markdown');
      }
      // ③ 内容必须是这个文件的（可证伪：占位符过不了这关）
      const lines = Array.isArray(c.expectedLines) ? c.expectedLines.filter(Boolean) : [];
      if (lines.length && dp.exists) {
        const hit = lines.find((ln) => findText(docText, ln));
        if (!hit) {
          problems.push('渲染内容对不上磁盘上的文件（期望出现「' +
            String(lines[0]).slice(0, 20) + '」，实际没找到）');
        }
      }
      detail = '正文 ' + docLen + ' 字符 · ' + (Number(dp.headings) || 0) + ' 个标题 · ' +
        (Number(dp.tables) || 0) + ' 个表格 · 左列表 ' + items + ' 项';
      break;
    }

    case 'sf-board': {
      // 实测实现是 DOM 卡片，不是 svg/canvas（见文件头 ①）
      const nodes = Number(ev.nodes) || 0;
      if (nodes < 1) problems.push('管线图 0 个节点（.sf-node 一个都没有）');
      if (!text.includes('当前')) problems.push('管线图缺「当前」段（结构没画全）');
      const hasSide = text.includes('上游') || text.includes('下游') ||
        text.includes('无上游') || text.includes('无下游');
      if (!hasSide) problems.push('管线图没有上游/下游说明（结构没画全）');
      detail = nodes + ' 个节点卡片';
      break;
    }

    case 'embed': {
      const all = webviews.concat(iframes);
      if (!all.length) {
        problems.push('没有 webview/iframe 元素 —— 嵌入页根本没嵌');
        detail = '0 个内嵌元素';
        break;
      }
      const withSrc = all.filter((x) => String(x.src || '').trim());
      if (!withSrc.length) problems.push('webview/iframe 的 src 为空 —— 嵌了个空壳');
      const anyUrl = withSrc.find((x) => /^(https?:\/\/|file:\/\/)/i.test(String(x.src).trim()));
      if (withSrc.length && !anyUrl) problems.push('src 不是合法 URL');

      // 第三层：CDP targets 里有没有真的起来这个网页
      const loaded = ev.webviewLoaded;
      if (loaded === false) {
        problems.push('webview 有 src，但 CDP 里找不到对应的已加载页面 —— 网页没真的起来');
      } else if (loaded === undefined || loaded === null) {
        warns.push('未能核对网页是否真的加载（CDP targets 读取失败）');
      }

      const src0 = String((withSrc[0] && withSrc[0].src) || '');
      detail = 'src=' + src0.slice(0, 56) + (loaded === true ? ' · 已加载' : '');
      break;
    }

    case 'review-files': {
      const rows = Number(ev.rfRows) || 0;
      const names = Array.isArray(ev.rfNames) ? ev.rfNames.filter(Boolean) : [];
      if (rows < 1) problems.push('文件清单 0 行（.rf-row 一条都没有）');
      // 不能只数行，行里的名字必须真的在磁盘目录里（可证伪）
      const real = Array.isArray(c.expectedNames) ? c.expectedNames : [];
      if (real.length && names.length) {
        const bogus = names.filter((n) => !real.includes(n));
        if (bogus.length) {
          problems.push('清单里出现磁盘上不存在的条目：' + bogus.slice(0, 3).join(', '));
        }
      }
      detail = rows + ' 个文件条目';
      break;
    }

    case 'neuron': {
      const okCv = canvases.filter((x) =>
        Number(x.w) >= MIN_CANVAS && Number(x.h) >= MIN_CANVAS &&
        Number(x.bw) > 0 && Number(x.bh) > 0);
      if (!canvases.length) problems.push('没有 canvas —— 3D 神经元没挂上');
      else if (!okCv.length) {
        const c0 = canvases[0] || {};
        problems.push('canvas 尺寸为 0 或过小（css ' + (c0.w || 0) + 'x' + (c0.h || 0) +
          '，像素 ' + (c0.bw || 0) + 'x' + (c0.bh || 0) + '）');
      }
      if (textLen < MIN_PANEL_TEXT) problems.push('神经元面板没有任何文字（图例/提示都没有）');

      // 画布必须真的画了东西：采样像素里至少 1% 不是纯黑
      // （只对能读像素的 2D canvas 生效；webgl 读不到就不判，不虚报）
      const c1 = canvases.find((x) => x.pixels) || null;
      let pixelNote = '';
      if (c1) {
        const px = c1.pixels;
        const ratio = px.total ? px.lit / px.total : 0;
        if (ratio < 0.01) {
          problems.push('canvas 是空白的（采样 ' + px.total + ' 像素里只有 ' + px.lit +
            ' 个非黑，' + (ratio * 100).toFixed(1) + '%）');
        }
        pixelNote = ' · 非黑 ' + (ratio * 100).toFixed(0) + '%';
      }
      const c2 = canvases[0] || {};
      detail = 'canvas css ' + (c2.w || 0) + 'x' + (c2.h || 0) +
        ' · 像素 ' + (c2.bw || 0) + 'x' + (c2.bh || 0) + pixelNote;
      break;
    }

    case 'pc-drives': {
      const cards = Number(ev.driveCards) || 0;
      const names = Array.isArray(ev.driveNames) ? ev.driveNames.filter(Boolean) : [];
      if (cards < 1) problems.push('0 个磁盘条目（.pc-drive-card 一个都没有）');
      const bad = names.filter((n) => !/^[A-Za-z]:$/.test(String(n)));
      if (names.length && bad.length) problems.push('磁盘条目名不合法：' + bad.slice(0, 3).join(', '));
      if (!text.includes('已用')) problems.push('磁盘条目没有容量信息');
      detail = cards + ' 个磁盘 · ' + names.join(' ');
      break;
    }

    case 'pc-toplarge': {
      const rows = Number(ev.bigRows) || 0;
      const okEmpty = (EMPTY_OK_TEXT['pc-toplarge'] || []).find((m) => text.includes(m));
      if (rows < 1 && !okEmpty) {
        problems.push('0 个文件条目，也没有「无数据」明确提示');
      }
      if (okEmpty) warns.push('扫描结果为空（面板给了明确提示：' + okEmpty + '）');
      detail = rows >= 1 ? rows + ' 个文件条目' : '明确无数据：' + okEmpty;
      break;
    }

    case 'pc-junk': {
      const rows = Number(ev.junkRows) || 0;
      const okEmpty = (EMPTY_OK_TEXT['pc-junk'] || []).find((m) => text.includes(m));
      if (rows < 1 && !okEmpty) {
        problems.push('0 类可清理项，也没有「无数据」明确提示');
      }
      if (text.includes('没扫成') || text.includes('没扫到可清理项')) {
        warns.push('有目录没扫成（权限/超时），面板已如实提示');
      }
      detail = rows >= 1 ? rows + ' 类可清理项' : '明确无数据：' + okEmpty;
      break;
    }

    case 'pc-ledger': {
      const rows = Number(ev.ledgerRows) || 0;
      const okEmpty = (EMPTY_OK_TEXT['pc-ledger'] || []).find((m) => text.includes(m));
      if (rows < 1 && !okEmpty) {
        problems.push('0 条台账记录，也没有「无数据」明确提示');
      }
      detail = rows >= 1 ? rows + ' 条台账记录' : '明确无数据：' + okEmpty;
      break;
    }

    default:
      problems.push('未知面板类型「' + type + '」—— 这个体检不认识它（判据会漏）');
      detail = '未知类型';
  }

  // ── 通用 ⑥：卡在加载态 ──
  //    放在类型判据之后：先让类型判据说「内容够不够」，再说「是不是永远在加载」。
  //    harness 除外：它内部是 webview，正文文字不代表加载状态（界面功能体检管这块）。
  if (type !== 'harness') {
    const loadHit = LOADING_TEXT.find((m) => text.includes(m));
    if (loadHit && problems.length === 0) {
      problems.push('卡在加载态（' + loadHit + '），等到超时还没出内容');
    }
  }

  // ── 通用 ⑦：连标题都没有（只对文字类面板成立，见文件头 TEXTUAL_TYPES 说明）──
  if (TEXTUAL_TYPES.includes(type) && textLen < MIN_PANEL_TEXT && problems.length === 0) {
    problems.push('面板几乎没有文字（' + textLen + ' 字符）');
  }

  return { ok: problems.length === 0, problems, warns, detail };
}

// ══════════════════════════════════════════════════════════════════════
//  场景配置（期望清单 —— 用来发现「配置里有、页面里没有」）
// ══════════════════════════════════════════════════════════════════════
export function loadScenes() {
  const out = [];
  if (!fs.existsSync(SCEN_DIR)) return out;
  for (const f of fs.readdirSync(SCEN_DIR).sort()) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8').replace(/^\uFEFF/, ''));
    } catch { continue; }
    if (!j || !j.id) continue;
    out.push({
      id: String(j.id),
      name: String(j.name || j.id),
      file: f,
      panels: (j.panels || []).map((p) => ({
        id: String(p.id || ''),
        type: String(p.type || ''),
        title: String(p.title || ''),
        docDir: p.docDir || p.dir || null,
      })),
    });
  }
  return out;
}

/** 从磁盘算出「期望」：文档首行文字 / 目录真实文件名。连不上磁盘就返回空，不阻塞判据。 */
export function buildExpectation(panel) {
  const d = panel && (panel.docDir || null);
  if (!d) return {};
  let dir = String(d);
  if (!path.isAbsolute(dir)) dir = path.join(WB, dir.replace(/^\.?[\\/]/, ''));
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir, dirMissing: true };
  }
  const files = entries.filter((e) => !e.name.startsWith('.') && !e.isDirectory());
  const expectedNames = entries.filter((e) => !e.name.startsWith('.')).map((e) => e.name);

  // 挑一个文本类文件（优先 .md）
  const pick = files.find((e) => /\.(md|markdown)$/i.test(e.name)) ||
    files.find((e) => /\.(txt|json|ya?ml|csv|log|js|mjs)$/i.test(e.name)) ||
    files[0];

  let expectedLines = [];
  if (pick) {
    try {
      const src = fs.readFileSync(path.join(dir, pick.name), 'utf8');
      const raw = src.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const cand = [];
      // 标题行优先（# 标题），其次普通行
      for (const ln of raw) {
        const m = ln.match(/^#{1,6}\s+(.*)$/);
        if (m && m[1].trim().length >= 3) cand.push(m[1].trim().slice(0, 20));
        if (cand.length >= 2) break;
      }
      if (!cand.length) {
        for (const ln of raw) {
          const t = ln.replace(/^[>|\-*+\d.\s]+/, '').trim();
          if (t.length >= 4) { cand.push(t.slice(0, 20)); break; }
        }
      }
      expectedLines = cand.slice(0, 3);
    } catch { /* 读不了就不做交叉校验，不虚报 */ }
  }

  return { dir, expectedNames, expectedLines, file: pick ? pick.name : null };
}

// ══════════════════════════════════════════════════════════════════════
//  CDP 客户端（WebSocket 手写帧，参考 界面功能体检.mjs，补了 ping/pong 与分片）
// ══════════════════════════════════════════════════════════════════════
export function cdpTargets() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: CDP_PORT, path: '/json', method: 'GET', timeout: 5000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

export function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(String(Math.random())).toString('base64'),
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);

      let buf = Buffer.alloc(0);
      let frags = [];
      let nextId = 0;
      const pending = new Map();
      let closed = false;

      function frame(opcode, payload) {
        const mask = Buffer.from([1, 2, 3, 4]);
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
        let head;
        if (payload.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
        else if (payload.length < 65536) {
          head = Buffer.alloc(4);
          head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2);
        } else {
          head = Buffer.alloc(10);
          head[0] = 0x80 | opcode; head[1] = 0x80 | 127;
          head.writeBigUInt64BE(BigInt(payload.length), 2);
        }
        try { socket.write(Buffer.concat([head, mask, masked])); } catch { /* 连接已断 */ }
      }

      function deliver(text) {
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (msg.id === undefined || !pending.has(msg.id)) return;
        const { resolve: r } = pending.get(msg.id);
        pending.delete(msg.id);
        r(msg);
      }

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const b0 = buf[0];
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2); off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2)); off = 10;
          }
          if (masked) {
            if (buf.length < off + 4) return;
            off += 4; // 服务端不回掩码，防御性跳过
          }
          if (buf.length < off + len) return;
          const payload = Buffer.from(buf.subarray(off, off + len));
          buf = buf.subarray(off + len);

          if (opcode === 0x8) { // close
            closed = true;
            try { socket.end(); } catch { /* ignore */ }
            for (const [, p] of pending) p.resolve({ error: 'closed' });
            pending.clear();
            return;
          }
          if (opcode === 0x9) { frame(0xa, payload); continue; }  // ping → pong
          if (opcode === 0xa) continue;                            // pong
          frags.push(payload);
          if (!fin) continue;
          const text = Buffer.concat(frags).toString('utf8');
          frags = [];
          deliver(text);
        }
      });

      socket.on('error', () => { closed = true; });
      socket.on('close', () => {
        closed = true;
        for (const [, p] of pending) p.resolve({ error: 'closed' });
        pending.clear();
      });

      function send(method, params, timeoutMs) {
        return new Promise((r) => {
          if (closed) { r({ error: 'closed' }); return; }
          const myId = ++nextId;
          pending.set(myId, { resolve: r });
          frame(0x1, Buffer.from(JSON.stringify({ id: myId, method, params: params || {} })));
          setTimeout(() => {
            if (pending.has(myId)) { pending.delete(myId); r({ error: 'timeout' }); }
          }, timeoutMs || 20000);
        });
      }

      resolve({ send, close: () => { try { socket.destroy(); } catch { /* ignore */ } } });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 在页面里执行一段表达式，返回 { value } 或 { err } */
export async function evaluate(conn, expr, timeoutMs) {
  const r = await conn.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, timeoutMs);
  if (!r || r.error) return { err: (r && r.error) || 'no-response' };
  const res = r.result;
  if (!res) return { err: 'no-result' };
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    return { err: '页面异常: ' + String((d.exception && d.exception.description) || d.text || '').slice(0, 300) };
  }
  return { value: res.result ? res.result.value : undefined };
}

// ══════════════════════════════════════════════════════════════════════
//  页面侧采集器（把面板的真实 DOM 证据抓出来）
// ══════════════════════════════════════════════════════════════════════
const COLLECT_FN = `
function __wbCollect(PID, TYPE) {
  function q(root, sel) {
    try { return Array.prototype.slice.call(root.querySelectorAll(sel)); } catch (e) { return []; }
  }
  function tx(el) { return el ? String(el.innerText || '') : ''; }
  function ws(s) { return String(s || '').replace(/\\s+/g, ' ').trim(); }

  var panel = document.querySelector('.wb-panel[data-panel-id="' + PID + '"]');
  var body = panel ? panel.querySelector('.wb-panel-body') : null;
  var rect = panel ? panel.getBoundingClientRect() : { width: 0, height: 0 };
  var text = tx(body);

  var out = {
    id: PID, type: TYPE, scene: panel ? panel.getAttribute('data-scenario') : null,
    exists: !!panel, hasBody: !!body,
    w: Math.round(rect.width), h: Math.round(rect.height),
    textLen: String(text).trim().length,
    text: ws(text).slice(0, 400),
    nodes: q(body || document, '.sf-node').length,
    rvItems: q(body || document, '.rv-item').length,
    rfRows: q(body || document, '.rf-row').length,
    rfNames: q(body || document, '.rf-row').map(function (e) { return e.getAttribute('data-name'); }).slice(0, 30),
    driveCards: q(body || document, '.pc-drive-card').length,
    driveNames: q(body || document, '.pc-drive-card').map(function (e) { return e.getAttribute('data-drive'); }),
    bigRows: q(body || document, '.pc-file-row').length,
    junkRows: q(body || document, '.pc-junk-row').length,
    ledgerRows: q(body || document, 'table tbody tr').length,
    tables: q(body || document, 'table').length,
    svg: q(body || document, 'svg').length,
    canvas: q(body || document, 'canvas').map(function (c) {
      var r = c.getBoundingClientRect();
      var info = { w: Math.round(r.width), h: Math.round(r.height), bw: c.width || 0, bh: c.height || 0 };
      // 判「画布是不是真的画了东西」：采样一小块像素。
      // 只有 2D canvas 能可靠读像素（getContext('2d') 返回 null 说明已是 webgl，不做判断）。
      try {
        var c2 = c.getContext('2d');
        if (c2 && info.w > 0 && info.h > 0) {
          var tmp = document.createElement('canvas');
          tmp.width = 64; tmp.height = 48;
          var tc = tmp.getContext('2d');
          tc.drawImage(c, 0, 0, 64, 48);
          var d = tc.getImageData(0, 0, 64, 48).data;
          var lit = 0, n = d.length / 4;
          for (var i = 0; i < d.length; i += 4) {
            if (d[i] + d[i + 1] + d[i + 2] > 12) lit++;
          }
          info.pixels = { lit: lit, total: n };
        }
      } catch (e2) { /* 读不到像素就不判，不虚报 */ }
      return info;
    }),
    webviews: q(body || document, 'webview').map(function (w) {
      return { src: w.getAttribute('src') || '', partition: w.getAttribute('partition') || '' };
    }),
    iframes: q(body || document, 'iframe').map(function (f) {
      return { src: f.getAttribute('src') || '' };
    }),
    renderErr: body && body.querySelector('.wb-empty-hint')
      ? String(body.querySelector('.wb-empty-hint').textContent || '') : null,
    emptyTitle: body && body.querySelector('.wb-empty-title')
      ? String(body.querySelector('.wb-empty-title').textContent || '') : null
  };

  if (TYPE === 'review-doc' && body) {
    var main = body.querySelector('[data-rv-main]');
    if (main && main.children.length > 1) {
      var right = main.children[1];
      var rt = tx(right);
      // 标题：渲染器用的是 style 里带 font:600 的 div，不是 <h1>（见文件头 ③）
      var all = q(right, 'div[style]');
      var heads = 0;
      var marked = [];
      for (var i = 0; i < all.length; i++) {
        var st = all[i].getAttribute('style') || '';
        if (!/font:\\s*600/.test(st)) continue;
        if (!String(all[i].innerText || '').trim()) continue;
        marked.push(all[i]);
      }
      // 去掉「父块也是标题块」的重复计数
      heads = marked.filter(function (el) {
        for (var p = el.parentElement; p && p !== right; p = p.parentElement) {
          if (marked.indexOf(p) >= 0) return false;
        }
        return true;
      }).length;
      out.docPane = {
        exists: true,
        textLen: String(rt).trim().length,
        text: ws(rt).slice(0, 500),
        headings: heads,
        tables: q(right, 'table').length,
        pre: q(right, 'pre').length
      };
    } else {
      out.docPane = { exists: false, textLen: 0, text: '', headings: 0, tables: 0, pre: 0 };
    }
  }
  return out;
}
`;

// ⚠ 2026-11-12 修（第一版这句写错，29 个面板全报「CDP 采集失败」）：
//
//   错在哪：写成了
//       '(' + COLLECT_FN + '\n__wbCollect(...))'
//   COLLECT_FN 是**函数声明**（`function __wbCollect(...){}`），
//   拼出来是 `(function __wbCollect(){...}
//              __wbCollect('x','y'))`
//   —— 括号里既有一个函数表达式、后面又跟一个标识符，
//   Chrome 直接报 SyntaxError: Unexpected identifier '__wbCollect'。
//
//   后果比语法错更糟：工具能跑、场景能切、29 个面板全部输出「不合格」，
//   看起来像「所有面板都坏了」，其实**是体检自己坏了**。
//   这就是典型的「检查器故障被当成被测对象故障」。
//
//   修法：包成 IIFE，函数声明放里面，最后 return。
//   并补了一条自测（【七】）用 new Function 编译一遍 —— 这类错误自测必须能抓到，
//   否则下次改采集器还会静默把全部面板判红。
export function collectExpr(panelId, type) {
  return '(function(){' + COLLECT_FN +
    '\nreturn __wbCollect(' +
    JSON.stringify(String(panelId)) + ',' + JSON.stringify(String(type)) + ');})()';
}

/** 点开 review-doc 左列表里的第一个文件（只点一次） */
export function clickFirstDocExpr(panelId) {
  return `(function(){
    var panel = document.querySelector('.wb-panel[data-panel-id="' + ${JSON.stringify(String(panelId))} + '"]');
    if (!panel) return { ok: false, why: 'no-panel' };
    var main = panel.querySelector('[data-rv-main]');
    if (!main || main.children.length < 2) return { ok: false, why: 'no-main' };
    var left = main.children[0];
    var items = left ? Array.prototype.slice.call(left.querySelectorAll('.rv-item')) : [];
    if (!items.length) return { ok: false, why: 'no-item' };
    var pick = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-dir') !== '0') continue;
      pick = items[i];
      if (/\\.md$/i.test(pick.getAttribute('data-name') || '')) break;
    }
    if (!pick) return { ok: false, why: 'no-file-item' };
    pick.click();
    return { ok: true, name: pick.getAttribute('data-name') || '' };
  })()`;
}

/**
 * 判断 embed 的网页是否真的起来了。
 *
 * 拿 src 的 host（忽略 query/尾斜杠）去 CDP targets 里找同 host 的 webview/iframe。
 * 找到 = true；targets 为空或读不到 = null（不知道，不虚报）；
 * targets 读到了但没有这个 host = false（真的没起来）。
 */
export function webviewLoadedFromTargets(src, targets) {
  if (!Array.isArray(targets) || !targets.length) return null;
  const s = String(src || '').trim();
  if (!s) return false;
  let host = '';
  try { host = new URL(s).host.toLowerCase(); } catch { return false; }
  if (!host) return null;
  const hit = targets.find((t) =>
    t && (t.type === 'webview' || t.type === 'iframe' || t.type === 'page') &&
    String(t.url || '').toLowerCase().includes(host));
  return !!hit;
}

// ══════════════════════════════════════════════════════════════════════
//  单个面板：采集 → 判 → 不行就继续轮询（唯一的等待策略）
// ══════════════════════════════════════════════════════════════════════
async function probePanel(conn, panel, sceneName, budgetMs) {
  const t0 = Date.now();
  const ctx = buildExpectation(panel);
  let last = null;
  let lastJudge = null;
  let clicked = null;

  // review-doc：先等左列表出来，再点第一个文件（否则右边永远是空的）
  if (panel.type === 'review-doc') {
    for (let t = 0; t < 8000; t += POLL_MS) {
      const r = await evaluate(conn, collectExpr(panel.id, panel.type));
      const ev = r.value;
      if (ev && Number(ev.rvItems) > 0) break;
      await sleep(POLL_MS);
    }
    const r = await evaluate(conn, clickFirstDocExpr(panel.id));
    clicked = r.value || { ok: false, why: r.err || 'unknown' };
  }

  while (Date.now() - t0 < budgetMs) {
    const r = await evaluate(conn, collectExpr(panel.id, panel.type));
    if (r.err) {
      last = { id: panel.id, type: panel.type, exists: false, err: r.err };
      lastJudge = { ok: false, problems: ['CDP 采集失败: ' + r.err], warns: [], detail: '采集失败' };
      break;
    }
    last = r.value;
    lastJudge = judgePanel(last, ctx);
    if (lastJudge.ok) break;
    await sleep(POLL_MS);
  }

  if (!last) {
    last = { id: panel.id, type: panel.type, exists: false };
    lastJudge = lastJudge || { ok: false, problems: ['没有采集到任何证据'], warns: [], detail: '无证据' };
  }

  // embed：补一层「网页真的起来了」的证据（见文件头 embed 第二层证明）
  if (panel.type === 'embed' && lastJudge.ok) {
    const src0 = ((last.webviews || [])[0] || (last.iframes || [])[0] || {}).src;
    const targets = await cdpTargets();
    last.webviewLoaded = webviewLoadedFromTargets(src0, targets);
    const j2 = judgePanel(last, ctx);
    if (j2.ok || j2.problems.every((p) => p.includes('CDP'))) lastJudge = j2;
  }

  return {
    panel,
    scene: sceneName,
    evidence: last,
    judge: lastJudge,
    ctx,
    clicked,
    ms: Date.now() - t0,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  一行输出（任务书要求的格式）
// ══════════════════════════════════════════════════════════════════════
function fmtLine(r) {
  const mark = r.judge.ok ? 'OK' : 'XX';
  const where = (r.scene + ' / ' + r.panel.id).padEnd(26);
  const tp = ('(' + r.panel.type + ')').padEnd(15);
  let detail = r.judge.detail;
  if (!r.judge.ok) detail = '✗ ' + r.judge.problems[0];
  else if (r.judge.warns.length) detail = '⚠ ' + r.judge.warns[0];
  return '  ' + mark + '  ' + where + tp + detail;
}

// ══════════════════════════════════════════════════════════════════════
//  自测（不需要工作台在跑；反例必须真的被判失败）
// ══════════════════════════════════════════════════════════════════════
/** 造一份「什么内容都没有」的证据（所有字段都是空/0） */
function emptyEvidence(type) {
  return {
    id: 'fake', type: String(type), scene: 'fake',
    exists: true, hasBody: true, w: 300, h: 400,
    text: '', textLen: 0,
    nodes: 0, rvItems: 0, rfRows: 0, rfNames: [],
    driveCards: 0, driveNames: [], bigRows: 0, junkRows: 0, ledgerRows: 0,
    tables: 0, svg: 0, canvas: [], webviews: [], iframes: [],
    renderErr: null, emptyTitle: null,
    docPane: { exists: false, textLen: 0, text: '', headings: 0, tables: 0, pre: 0 },
  };
}

/** 造一份「最小但合格」的证据 */
function goodEvidence(type) {
  const base = emptyEvidence(type);
  switch (type) {
    case 'harness':
      return Object.assign(base, {
        text: 'AI·架构梳理 已绑定会话', textLen: 14,
        webviews: [{ src: 'http://127.0.0.1:3083/' }],
      });
    case 'review-doc':
      return Object.assign(base, {
        text: '架构文档 D:/.../文档 架构决策记录.md 772 B', textLen: 40, rvItems: 3,
        docPane: {
          exists: true, textLen: 340, headings: 4, tables: 1, pre: 0,
          text: '架构决策记录 为什么要分场景 以前所有场景的「审查文档」面板都指向 workbench/自我复盘',
        },
      });
    case 'sf-board':
      return Object.assign(base, {
        text: '管线位置 造一个软件 5 节点 / 8 条依赖 上游 3 调研 可执行 ▶▶ 当前 架构梳理 阻塞 还缺 3 份输入 ▶ 下游 1 实施计划 阻塞',
        textLen: 90, nodes: 5,
      });
    case 'embed':
      return Object.assign(base, {
        text: '参考网页', textLen: 4,
        webviews: [{ src: 'https://developer.mozilla.org/' }],
      });
    case 'review-files':
      return Object.assign(base, {
        text: '库 1 项（0 目录 / 1 文件） 名称 大小 修改 架构决策记录.md 772 B 1 天前', textLen: 48,
        rfRows: 1, rfNames: ['架构决策记录.md'], tables: 1,
      });
    case 'neuron':
      return Object.assign(base, {
        text: '其他 1 工程 7 工具 1 整理 更新 拖动旋转 · 拖节点移动 · 滚轮缩放', textLen: 30,
        canvas: [{ w: 1196, h: 787, bw: 1495, bh: 984 }],
      });
    case 'pc-drives':
      return Object.assign(base, {
        text: '磁盘分区 2 个分区 · 合计 933.66 GB，已用 576.01 GB C: 48.0% 已用 D: 65.4% 已用',
        textLen: 60, driveCards: 2, driveNames: ['C:', 'D:'],
      });
    case 'pc-toplarge':
      return Object.assign(base, {
        text: '磁盘大户排行 扫了 32272 个文件 installer.exe 483.5 MB', textLen: 40,
        bigRows: 20, tables: 1,
      });
    case 'pc-junk':
      return Object.assign(base, {
        text: '可清理体检 3 类 · 共 27.7 MB / 281 项 用户临时文件 10.2 MB', textLen: 40, junkRows: 3,
      });
    case 'pc-ledger':
      return Object.assign(base, {
        text: '清理台账 0 条记录 ▦ 暂无清理记录 台账文件：(不存在)', textLen: 30, ledgerRows: 0,
      });
    default:
      return base;
  }
}

export function selftest() {
  const R = [];
  const chk = (n, ok, d) => {
    R.push({ n, ok, d });
    console.log('  ' + (ok ? 'OK  ' : 'XX  ') + n + (d ? '  ' + d : ''));
  };

  console.log('═'.repeat(74));
  console.log('  面板内容体检 · 自测（不需要工作台在跑）');
  console.log('═'.repeat(74));
  console.log();

  // ── 一、覆盖性 ──
  console.log('【一】覆盖性：判据必须认识所有面板类型');
  {
    chk('面板类型清单是 10 种', PANEL_TYPES.length === 10, PANEL_TYPES.length + ' 种');
    const noWait = PANEL_TYPES.filter((t) => !(WAIT_MS[t] > 0));
    chk('每种类型都有等待预算', noWait.length === 0, noWait.join(',') || '齐全');

    const scenes = loadScenes();
    chk('能读到 9 个场景配置', scenes.length === 9, scenes.length + ' 个');
    const used = new Set();
    let panelN = 0;
    for (const s of scenes) for (const p of s.panels) { used.add(p.type); panelN++; }
    const unknown = [...used].filter((t) => !PANEL_TYPES.includes(t));
    chk('配置里没有判据不认识的类型', unknown.length === 0,
      unknown.join(',') || '全部认识（' + used.size + ' 种 / ' + panelN + ' 个实例）');
    const uncovered = PANEL_TYPES.filter((t) => !used.has(t));
    chk('10 种类型都在场景里真的用到', uncovered.length === 0,
      uncovered.join(',') || '全部有实例');
  }

  console.log();
  console.log('【二】正例：每种类型的最小合格样本必须通过（判据不能过严）');
  {
    for (const t of PANEL_TYPES) {
      const ev = goodEvidence(t);
      const j = judgePanel(ev, {
        expectedLines: t === 'review-doc' ? ['架构决策记录'] : null,
        expectedNames: t === 'review-files' ? ['架构决策记录.md'] : null,
      });
      chk('正例 ' + t.padEnd(13) + ' 合格样本通过', j.ok === true,
        j.ok ? j.detail : '✗ ' + j.problems.join('；'));
    }
  }

  console.log();
  console.log('【三】反例 A（关键）：每种类型的「空样本」必须判不合格 —— 证明判据不是恒真');
  {
    let allCaught = 0;
    for (const t of PANEL_TYPES) {
      const j = judgePanel(emptyEvidence(t), {});
      if (!j.ok) allCaught++;
      chk('反例 ' + t.padEnd(13) + ' 空面板必须不合格', j.ok === false,
        j.ok ? '★ 竟然通过了（判据失效）' : j.problems[0]);
    }
    chk('反例 A 汇总：10/10 类型的空样本都被抓出', allCaught === PANEL_TYPES.length,
      allCaught + '/' + PANEL_TYPES.length);
  }

  console.log();
  console.log('【四】反例 B：具体故障形态（只看元素存在会漏掉的那些）');
  {
    // B1 review-doc：容器在、文件列表在，但右侧正文 0 字符
    //    —— 这正是任务书点名的「容器存在但里面是空的」
    {
      const ev = goodEvidence('review-doc');
      ev.docPane = { exists: true, textLen: 0, text: '', headings: 0, tables: 0, pre: 0 };
      const j = judgePanel(ev, { expectedLines: ['架构决策记录'] });
      chk('反例 B1 review-doc 右侧渲染 0 字符 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B2 review-doc：右侧有字，但不是这个文件的内容（占位符）
    {
      const ev = goodEvidence('review-doc');
      ev.docPane = {
        exists: true, textLen: 300, headings: 2, tables: 0, pre: 0,
        text: '这个目录里还没有文档 目录：D:/x/y',
      };
      const j = judgePanel(ev, { expectedLines: ['架构决策记录'] });
      chk('反例 B2 review-doc 渲染的是占位符不是真文件 → 不合格', j.ok === false,
        j.ok ? '★ 通过了（内容没做交叉校验）' : j.problems[0]);
    }
    // B3 embed：webview 在，但 src 为空
    {
      const ev = goodEvidence('embed');
      ev.webviews = [{ src: '' }];
      const j = judgePanel(ev, {});
      chk('反例 B3 embed 的 src 为空 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B4 embed：根本没有 webview/iframe
    {
      const ev = goodEvidence('embed');
      ev.webviews = []; ev.iframes = [];
      const j = judgePanel(ev, {});
      chk('反例 B4 embed 完全没有内嵌元素 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B5 sf-board：节点 0（只剩「加载管线…」）
    {
      const ev = emptyEvidence('sf-board');
      ev.text = '管线位置 加载管线…'; ev.textLen = 12; ev.nodes = 0;
      const j = judgePanel(ev, {});
      chk('反例 B5 sf-board 节点数 0（卡在加载） → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B6 review-files：0 条目
    {
      const ev = emptyEvidence('review-files');
      ev.text = '库 0 项（0 目录 / 0 文件） 目录是空的'; ev.textLen = 20;
      const j = judgePanel(ev, {});
      chk('反例 B6 review-files 0 行 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B7 review-files：行里的名字磁盘上不存在
    {
      const ev = goodEvidence('review-files');
      ev.rfNames = ['幽灵文件.md'];
      const j = judgePanel(ev, { expectedNames: ['架构决策记录.md'] });
      chk('反例 B7 review-files 显示了不存在的文件 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B8 neuron：canvas 在但尺寸 0
    {
      const ev = goodEvidence('neuron');
      ev.canvas = [{ w: 0, h: 0, bw: 0, bh: 0 }];
      const j = judgePanel(ev, {});
      chk('反例 B8 neuron canvas 尺寸 0 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B8b neuron：canvas 尺寸完全正常，但一个像素都没画（纯黑）
    //   这是「元素存在但内容为空」最阴险的形态 —— 只看尺寸完全看不出来
    {
      const ev = goodEvidence('neuron');
      ev.canvas = [{ w: 1196, h: 787, bw: 1495, bh: 984, pixels: { lit: 0, total: 3072 } }];
      const j = judgePanel(ev, {});
      chk('反例 B8b neuron canvas 全黑（尺寸正常但没画东西） → 不合格', j.ok === false,
        j.ok ? '★ 通过了（只看尺寸会漏）' : j.problems[0]);
    }
    // 正例 B8c：真的画了东西（实测中枢是 19200/19200 像素非黑）
    {
      const ev = goodEvidence('neuron');
      ev.canvas = [{ w: 1196, h: 787, bw: 1495, bh: 984, pixels: { lit: 3072, total: 3072 } }];
      const j = judgePanel(ev, {});
      chk('正例 B8c neuron 画布有像素 → 合格', j.ok === true,
        j.ok ? j.detail : '✗ ' + j.problems.join('；'));
    }
    // B9 pc-toplarge：卡在「扫描中…」到超时
    {
      const ev = emptyEvidence('pc-toplarge');
      ev.text = '磁盘大户排行 扫描中… 正在扫描 C 盘（最多 15 秒）…'; ev.textLen = 30;
      const j = judgePanel(ev, {});
      chk('反例 B9 pc-toplarge 卡在扫描中 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B10 pc-drives：0 磁盘
    {
      const ev = emptyEvidence('pc-drives');
      ev.text = '磁盘分区 正在读取分区…'; ev.textLen = 14;
      const j = judgePanel(ev, {});
      chk('反例 B10 pc-drives 0 个磁盘 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B11 渲染失败占位
    {
      const ev = goodEvidence('sf-board');
      ev.renderErr = 'Cannot read properties of undefined';
      const j = judgePanel(ev, {});
      chk('反例 B11 渲染失败占位 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B12 0 尺寸容器
    {
      const ev = goodEvidence('pc-junk');
      ev.w = 0; ev.h = 0;
      const j = judgePanel(ev, {});
      chk('反例 B12 容器 0 尺寸（被隐藏） → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B13 容器压根不存在（配置里有、页面没有）
    {
      const ev = goodEvidence('embed');
      ev.exists = false;
      const j = judgePanel(ev, {});
      chk('反例 B13 面板容器不存在 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B14 网页加载失败提示（embed 的 did-fail-load 条）
    {
      const ev = goodEvidence('embed');
      ev.text = '参考网页 网页加载失败 ERR_NAME_NOT_RESOLVED（错误码 -105）';
      ev.textLen = 30;
      const j = judgePanel(ev, {});
      chk('反例 B14 embed 显示「网页加载失败」 → 不合格', j.ok === false,
        j.ok ? '★ 通过了' : j.problems[0]);
    }
    // B15 「明确的空数据提示」不能算失败（防止判据过严）
    {
      const ev = emptyEvidence('pc-ledger');
      ev.text = '清理台账 0 条记录 ▦ 暂无清理记录 台账文件：(不存在)'; ev.textLen = 30;
      const j = judgePanel(ev, {});
      chk('正例 B15 pc-ledger「暂无清理记录」是合法的明确提示 → 合格', j.ok === true,
        j.ok ? j.detail : '✗ ' + j.problems.join('；'));
    }
  }

  console.log();
  console.log('【五】判据不能靠单一信号（去掉任意一个证据都必须判失败）');
  {
    // 对每种类型的合格样本，逐一破坏关键字段，确认判据会变红
    const breaks = [
      { type: 'review-doc', mut: (e) => { e.docPane.headings = 0; e.docPane.tables = 0; e.docPane.pre = 0; }, why: '没有结构' },
      { type: 'sf-board', mut: (e) => { e.nodes = 0; }, why: '节点 0' },
      { type: 'embed', mut: (e) => { e.webviews = [{ src: '   ' }]; }, why: 'src 只有空格' },
      { type: 'review-files', mut: (e) => { e.rfRows = 0; e.rfNames = []; }, why: '0 行' },
      { type: 'harness', mut: (e) => { e.webviews = []; }, why: '没有 webview' },
      { type: 'neuron', mut: (e) => { e.canvas = []; }, why: '没有 canvas' },
      { type: 'pc-drives', mut: (e) => { e.driveCards = 0; e.driveNames = []; }, why: '0 磁盘' },
      { type: 'pc-toplarge', mut: (e) => { e.bigRows = 0; }, why: '0 条目且无提示' },
      { type: 'pc-junk', mut: (e) => { e.junkRows = 0; }, why: '0 条目且无提示' },
    ];
    let n = 0;
    for (const b of breaks) {
      const ev = goodEvidence(b.type);
      b.mut(ev);
      const j = judgePanel(ev, {});
      if (!j.ok) n++;
      chk('破坏 ' + b.type.padEnd(13) + '（' + b.why + '）→ 不合格', j.ok === false,
        j.ok ? '★ 仍然通过（判据太松）' : j.problems[0]);
    }
    chk('单一信号破坏共 ' + breaks.length + ' 项全部被抓出', n === breaks.length, n + '/' + breaks.length);
  }

  console.log();
  console.log('【六】期望值来自磁盘（交叉校验真的接上了）');
  {
    const panel = { id: 'x', type: 'review-doc', docDir: '数据/.dsh/场景记忆/架构梳理/文档' };
    const exp = buildExpectation(panel);
    chk('能算出台账期望（目录存在）', !exp.dirMissing, exp.dir || '');
    chk('期望里有真实文件名', Array.isArray(exp.expectedNames) && exp.expectedNames.length > 0,
      (exp.expectedNames || []).join(', '));
    chk('期望里有正文候选行（用于证明内容是真文件的）',
      Array.isArray(exp.expectedLines) && exp.expectedLines.length > 0,
      (exp.expectedLines || []).join(' / '));

    // 反例：目录写错 → 不虚报期望（但也不能因此放行空面板）
    const bad = buildExpectation({ id: 'y', type: 'review-doc', docDir: '数据/不存在的目录' });
    chk('反例：目录不存在时不编造期望', bad.dirMissing === true && !bad.expectedLines,
      'dirMissing=' + bad.dirMissing);
  }

  console.log();
  console.log('【七】采集器本身必须能被页面解析（检查器坏了不能被当成面板坏了）');
  {
    // ⚠ 这一节是被真实事故逼出来的：
    //   第一版 collectExpr 拼出来的字符串有语法错，Chrome 抛
    //   SyntaxError: Unexpected identifier '__wbCollect'，
    //   结果 29 个面板全部判「不合格」—— 报的是被测对象，实际是检查器自己坏了。
    //   所以这里用 new Function 把生成的表达式真的编译一遍。
    let compileErr = null;
    let exprText = '';
    try {
      exprText = collectExpr('demo-panel', 'review-doc');
      // new Function 用的是和浏览器一致的脚本语法（不是 ESM），足够抓 SyntaxError
      // eslint-disable-next-line no-new-func
      new Function('return ' + exprText);
    } catch (e) {
      compileErr = String((e && e.message) || e);
    }
    chk('反例 C1 collectExpr 必须是合法 JS（编译得过）', !compileErr,
      compileErr || '编译通过，' + exprText.length + ' 字符');

    let clickErr = null;
    try {
      // eslint-disable-next-line no-new-func
      new Function('return ' + clickFirstDocExpr('demo-panel'));
    } catch (e) {
      clickErr = String((e && e.message) || e);
    }
    chk('反例 C2 clickFirstDocExpr 必须是合法 JS', !clickErr, clickErr || '编译通过');

    // 参数真的被拼进去了（不能有空壳：表达式里必须出现面板 id 和类型）
    chk('表达式里带上了面板 id', exprText.includes('"demo-panel"'));
    chk('表达式里带上了面板类型', exprText.includes('"review-doc"'));
    // 必须是 IIFE（以 (function 开头、以 () 结尾），否则又回到那个语法坑
    chk('表达式是 IIFE 形态', exprText.startsWith('(function') && exprText.endsWith(')()'),
      exprText.slice(0, 12) + ' ... ' + exprText.slice(-4));
  }

  console.log();
  console.log('【八】文字长度不能当通用判据（会误伤视觉面板）');
  {
    // 真实误判：调研/rs-web 的 webview 加载成功（CDP 里有 cn.bing.com），
    // 但父页面 innerText 只有「网页」2 个字 —— webview 是独立进程，内容不进 innerText。
    const ev = goodEvidence('embed');
    ev.text = '网页'; ev.textLen = 2;
    const j = judgePanel(ev, {});
    chk('正例 D1 embed 只有 2 字但 webview 正常 → 合格（不按字数判）', j.ok === true,
      j.ok ? j.detail : '✗ ' + j.problems.join('；'));

    chk('TEXTUAL_TYPES 不包含视觉面板',
      !TEXTUAL_TYPES.includes('embed') && !TEXTUAL_TYPES.includes('neuron') &&
      !TEXTUAL_TYPES.includes('harness'),
      'TEXTUAL: ' + TEXTUAL_TYPES.join(','));
    chk('TEXTUAL_TYPES 覆盖全部文字面板',
      ['review-doc', 'sf-board', 'review-files', 'pc-drives', 'pc-toplarge', 'pc-junk', 'pc-ledger']
        .every((t) => TEXTUAL_TYPES.includes(t)),
      TEXTUAL_TYPES.length + ' 种');

    // 但文字类面板仍然必须按字数兜底
    const ev2 = goodEvidence('pc-ledger');
    ev2.text = ''; ev2.textLen = 0; ev2.ledgerRows = 0;
    const j2 = judgePanel(ev2, {});
    chk('反例 D2 文字类面板没字仍判不合格', j2.ok === false,
      j2.ok ? '★ 通过了' : j2.problems[0]);
  }

  console.log();
  console.log('【九】embed 的「网页真的起来了」这层证明（src 属性不算证据）');
  {
    const T = [
      { type: 'webview', url: 'https://cn.bing.com/?mkt=zh-CN' },
      { type: 'webview', url: 'http://127.0.0.1:3083/' },
      { type: 'page', url: 'file:///D:/x/workbench/ui/index.html' },
    ];
    chk('已加载：targets 里有同 host 的 webview', webviewLoadedFromTargets('https://cn.bing.com/?mkt=zh-CN', T) === true);
    chk('未加载：targets 里没有该 host',
      webviewLoadedFromTargets('https://www.bilibili.com/', T) === false);
    chk('拿不到 targets → 返回 null（不虚报成功也不虚报失败）',
      webviewLoadedFromTargets('https://cn.bing.com/', []) === null);
    chk('src 非法 → 判未加载', webviewLoadedFromTargets('not-a-url', T) === false);

    // 端到端：src 有、但 CDP 里没有对应页面 → 必须不合格
    const ev = goodEvidence('embed');
    ev.webviews = [{ src: 'https://example.com/' }];
    ev.webviewLoaded = false;
    const j = judgePanel(ev, {});
    chk('反例 E1 src 非空但网页没起来 → 不合格', j.ok === false,
      j.ok ? '★ 通过了（只信 src 属性）' : j.problems[0]);

    // targets 读不到时不能把面板判死，只能给 warn
    const ev2 = goodEvidence('embed');
    ev2.webviewLoaded = null;
    const j2 = judgePanel(ev2, {});
    chk('targets 读不到时不误判失败，只给 ⚠', j2.ok === true && j2.warns.length > 0,
      j2.warns[0] || '（没有 warn）');

    // 真的起来了 → 合格且 detail 标「已加载」
    const ev3 = goodEvidence('embed');
    ev3.webviewLoaded = true;
    const j3 = judgePanel(ev3, {});
    chk('已加载 → 合格且标「已加载」', j3.ok === true && j3.detail.includes('已加载'), j3.detail);
  }

  console.log();
  console.log('═'.repeat(74));
  const passed = R.filter((x) => x.ok).length;
  console.log('  自测结果: ' + passed + ' / ' + R.length);
  if (passed < R.length) {
    console.log('  失败项：');
    R.filter((x) => !x.ok).forEach((x) => console.log('    XX ' + x.n + '  ' + (x.d || '')));
    console.log('═'.repeat(74));
    return false;
  }
  console.log('═'.repeat(74));
  return true;
}

// ══════════════════════════════════════════════════════════════════════
//  主流程
// ══════════════════════════════════════════════════════════════════════
async function main() {
  const jsonOut = has('json');

  const only = val('scene', null);
  let scenes = loadScenes();
  if (only) {
    scenes = scenes.filter((s) => s.id === only || s.name === only);
    if (!scenes.length) {
      console.error('找不到场景「' + only + '」。可用：' +
        loadScenes().map((s) => s.name + '(' + s.id + ')').join(', '));
      process.exit(2);
    }
  }
  if (!scenes.length) {
    console.error('读不到任何场景配置：' + SCEN_DIR);
    process.exit(2);
  }

  const ts = await cdpTargets();
  const page = ts.find((t) => t.type === 'page' && t.url && t.url.includes('ui/index.html')) ||
    ts.find((t) => t.type === 'page' && t.url && t.url.includes('workbench'));
  if (!page) {
    console.error('✗ 找不到渲染进程（CDP ' + CDP_PORT + ' 上没有 ui/index.html 页面）');
    console.error('  已看到 ' + ts.length + ' 个 target：' +
      ts.map((t) => t.type + ':' + String(t.url || '').slice(0, 40)).join(' | '));
    console.error('  工作台可能没启动，或没开 --remote-debugging-port=' + CDP_PORT);
    process.exit(2);
  }

  const conn = await cdpConnect(page.webSocketDebuggerUrl);
  await conn.send('Runtime.enable');

  // 页面里必须先有 __WB（否则切场景无从谈起）
  const gate = await evaluate(conn, `(function(){
    return { hasWB: !!(window.__WB && typeof window.__WB.switchScene === 'function'),
             cur: (window.__WB && window.__WB.getCurrentScene) ? window.__WB.getCurrentScene() : null };
  })()`);
  if (!gate.value || !gate.value.hasWB) {
    console.error('✗ 页面里没有 window.__WB.switchScene（工作台没启动完，或不是新前端）');
    conn.close();
    process.exit(2);
  }

  const T0 = Date.now();
  const results = [];
  const sceneReport = [];

  if (!jsonOut) {
    console.log('═'.repeat(78));
    console.log('  面板内容体检 —— 面板不只是「画出来了」，而是「真的画出了内容」');
    console.log('═'.repeat(78));
    console.log();
    console.log('  渲染进程: ' + String(page.url).slice(0, 66));
    console.log('  判据    : 容器在 · 尺寸 ≥ ' + MIN_W + 'x' + MIN_H +
      ' · 内容对得上真实数据 · 不是错误占位 · 不卡在加载态');
    console.log('  场景数  : ' + scenes.length +
      '，面板数: ' + scenes.reduce((a, s) => a + s.panels.length, 0));
    console.log();
  }

  for (const sc of scenes) {
    // ── 切场景（唯一可用方法） ──
    const sw = await evaluate(conn, `(async function(){
      try {
        var r = await window.__WB.switchScene(${JSON.stringify(sc.id)});
        return { ok: !!r, cur: window.__WB.getCurrentScene() };
      } catch (e) { return { ok: false, why: String(e) }; }
    })()`);

    if (!sw.value || !sw.value.ok || sw.value.cur !== sc.id) {
      const why = sw.err || (sw.value && sw.value.why) || ('当前是 ' + (sw.value && sw.value.cur));
      if (!jsonOut) console.log('  XX  ' + sc.name + '  ✗ 切场景失败：' + why);
      for (const p of sc.panels) {
        results.push({
          scene: sc.name, panel: p,
          evidence: { id: p.id, type: p.type, exists: false },
          judge: { ok: false, problems: ['切场景失败：' + why], warns: [], detail: '切场景失败' },
          ms: 0,
        });
      }
      sceneReport.push({ id: sc.id, name: sc.name, ok: false, why });
      continue;
    }

    // ── 等面板容器挂出来（renderScene 是异步的） ──
    let domPanels = [];
    for (let t = 0; t < 8000; t += 250) {
      const r = await evaluate(conn, `(function(){
        return Array.prototype.slice.call(document.querySelectorAll('.wb-panel'))
          .map(function (e) { return { id: e.getAttribute('data-panel-id'), type: e.getAttribute('data-panel-type') }; });
      })()`);
      domPanels = (r.value || []);
      if (domPanels.length >= sc.panels.length) break;
      await sleep(250);
    }

    if (!jsonOut) {
      console.log('  ── ' + sc.name + ' (' + sc.id + ') · ' +
        sc.panels.length + ' 个面板 ──');
    }

    const sceneOkList = [];
    for (const p of sc.panels) {
      // 配置里有、页面里没有 → 直接判失败，不静默跳过
      const inDom = domPanels.some((d) => d.id === p.id);
      if (!inDom) {
        const r = {
          scene: sc.name, panel: p,
          evidence: { id: p.id, type: p.type, exists: false },
          judge: {
            ok: false,
            problems: ['面板容器不存在（配置里有，页面里没渲染出来）'],
            warns: [], detail: '容器缺失',
          },
          ms: 0,
        };
        results.push(r);
        if (!jsonOut) console.log(fmtLine(r));
        continue;
      }

      const budget = Number(val('timeout-ms', 0)) || WAIT_MS[p.type] || 15000;
      const r = await probePanel(conn, p, sc.name, budget);
      results.push(r);
      sceneOkList.push(r.judge.ok);
      if (!jsonOut) {
        console.log(fmtLine(r));
        if (!r.judge.ok) {
          for (const pr of r.judge.problems.slice(1)) console.log('         ✗ ' + pr);
        }
        for (const wn of r.judge.warns) console.log('         ⚠ ' + wn);
      }
    }
    sceneReport.push({ id: sc.id, name: sc.name, ok: sceneOkList.every(Boolean) });
    if (!jsonOut) console.log();
  }

  conn.close();

  // ── 汇总 ──
  const total = results.length;
  const okN = results.filter((r) => r.judge.ok).length;
  const bad = results.filter((r) => !r.judge.ok);

  // 按类型统计（完成任务时那张表）
  const byType = {};
  for (const t of PANEL_TYPES) byType[t] = { total: 0, ok: 0 };
  for (const r of results) {
    const t = r.panel.type;
    if (!byType[t]) byType[t] = { total: 0, ok: 0 };
    byType[t].total++;
    if (r.judge.ok) byType[t].ok++;
  }
  const ms = Date.now() - T0;

  if (jsonOut) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      ms,
      total, ok: okN, failed: bad.length,
      byType,
      panels: results.map((r) => ({
        scene: r.scene, id: r.panel.id, type: r.panel.type,
        ok: r.judge.ok, detail: r.judge.detail,
        problems: r.judge.problems, warns: r.judge.warns,
        evidence: {
          w: r.evidence.w, h: r.evidence.h, textLen: r.evidence.textLen,
          nodes: r.evidence.nodes, rvItems: r.evidence.rvItems,
          rfRows: r.evidence.rfRows, driveCards: r.evidence.driveCards,
          bigRows: r.evidence.bigRows, junkRows: r.evidence.junkRows,
          ledgerRows: r.evidence.ledgerRows,
          canvas: r.evidence.canvas, webviews: r.evidence.webviews,
          docPane: r.evidence.docPane,
        },
        ms: r.ms,
      })),
    }, null, 2));
    process.exit(bad.length ? 1 : 0);
  }

  console.log('─'.repeat(78));
  console.log('  按类型汇总');
  console.log('─'.repeat(78));
  console.log('  ' + '类型'.padEnd(16) + '通过 / 总数');
  for (const t of PANEL_TYPES) {
    const b = byType[t] || { total: 0, ok: 0 };
    console.log('  ' + (b.ok === b.total && b.total > 0 ? '✓' : (b.total === 0 ? '·' : '✗')) + ' ' +
      t.padEnd(14) + b.ok + ' / ' + b.total);
  }

  console.log();
  console.log('─'.repeat(78));
  console.log('  结果: ' + okN + ' / ' + total + ' 个面板真的有内容（' + Math.round(ms / 1000) + ' 秒）');

  if (bad.length) {
    console.log();
    console.log('  🔴 不合格面板：');
    for (const r of bad) {
      console.log('    ' + r.scene + ' / ' + r.panel.id + '  (' + r.panel.type + ')');
      for (const pr of r.judge.problems) console.log('      · ' + pr);
    }
    process.exitCode = 1;
  } else {
    console.log('  ✓ 所有面板都有实质内容，且内容对得上真实数据');
  }
  console.log('═'.repeat(78));

  // 明确退出，避免 CDP socket 残留导致进程挂住
  process.exit(process.exitCode ? 1 : 0);
}

// ══════════════════════════════════════════════════════════════════════
//  ⚠ 只有直接运行本文件才跑主流程。
//    否则别的工具 import 这里的判据时，会连带把 9 个场景跑一遍。
// ══════════════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (has('selftest')) {
    process.exit(selftest() ? 0 : 1);
  } else {
    // ⚠ 2026-11-12 加 UI 互斥锁：这个工具会切场景 + 连 webview。
    //   与 界面功能体检 / 会话绑定验证 并发跑时会互相干扰。
    withUiLock('面板内容体检', main).catch((e) => {
      console.error('  ✗ ' + ((e && e.stack) || e));
      process.exitCode = 1;
      process.exit(1);
    });
  }
}
