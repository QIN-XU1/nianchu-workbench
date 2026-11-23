/**
 * 桥（Bridge）：把活外包给免费网页版 AI
 *
 * 架构照搬 luanyujia 的四层：
 *   脚本 → 本地桥（本文件）→ 站点薄壳（sites.json）→ 已登录网页
 *
 * 三个必须照抄的设计（来自 luanyujia 真实源码 webai-bridge.js）：
 *   ① 薄壳很薄：站点差异只在一个对象里（inputSel/send/answerSel/wait）
 *   ② 两步等待：先等"出现"，再等 stableMs"不再变"
 *   ③ 持久 profile：手动登录一次，之后复用；⛔ 不做自动登录
 *
 * 五个真实坑（luanyujia 源码注释里的实测）：
 *   - 豆包纯文字 45~60s，统一 20s 会在思考期误收
 *   - DeepSeek 最新消息在最上面（文档顺序是反的）
 *   - 会渲染"已思考（用时 N 秒）"草稿，必须切掉
 *   - 发送键是纯 SVG，需按几何位置点
 *   - 必须真实用户聚焦
 *
 * 安全：机密闸必须在调用之前（密码/token/身份证/银行卡/手机号 → 拒发）
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { probe, listTargets, CDP, DEFAULT_PORT } from './cdp.mjs';
import { isOn } from '../capabilities.mjs';

const HERE = import.meta.dirname;
const SITES_FILE = join(HERE, 'sites.json');

export function loadSites() {
  return JSON.parse(readFileSync(SITES_FILE, 'utf8'));
}

// ---------- 机密闸（必须在调用之前）----------
const SECRET_PATTERNS = [
  { name: '密码/口令', re: /(密码|口令|password|passwd|pwd)\s*[:：=]\s*\S+/i },
  { name: 'token/密钥', re: /(token|api[_-]?key|secret|密钥|私钥)\s*[:：=]\s*[\w\-]{8,}/i },
  { name: '身份证', re: /\b\d{17}[\dXx]\b/ },
  { name: '银行卡', re: /\b\d{16,19}\b/ },
  { name: '手机号', re: /\b1[3-9]\d{9}\b/ },
  { name: '服务器口令', re: /(ssh|root@|sudo)\s.*(密码|password)/i },
];

/**
 * 机密闸：正文命中就拒发。
 * 返回 { ok: true } 或 { ok: false, hit: '命中类型', sample: '命中片段' }
 */
export function secretGate(text) {
  const s = String(text || '');
  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(s);
    if (m) {
      return {
        ok: false,
        hit: p.name,
        sample: m[0].slice(0, 20).replace(/\S+/g, '***'),
        reason: `正文含「${p.name}」—— 站外服务一律不发`,
      };
    }
  }
  return { ok: true };
}

// ---------- 页面内提取正文（照抄 luanyujia 的思路，简化）----------
const READ_PAGE = `
(function () {
  function vis(e) {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 5 && r.height > 5;
  }
  // 找输入框：按"像聊天输入框"打分
  function findInput() {
    const cands = [
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]'),
    ].filter(vis);
    let best = null, bestScore = -1;
    const H = window.innerHeight;
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      let s = 0;
      if ((el.getAttribute('placeholder') || '').trim()) s += 10;
      if (r.top > H * 0.45) s += 6;
      if (r.width >= 400) s += 3;
      if (r.height >= 30 && r.height <= 220) s += 2;
      const val = el.isContentEditable ? (el.innerText || '') : (el.value || '');
      if (val.trim().length > 0) s -= 4;
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return best;
  }

  // ★关键★ 按结构读消息（虚拟滚动下 innerText 不可靠）
  //   DeepSeek: 用户消息 class 含 _9663006；AI 回答 class 含 _4f9bf79
  //   "取消 | 发送" 是生成中的按钮行，不能当消息
  function readMessages() {
    const vl = document.querySelector('.ds-virtual-list-visible-items')
            || document.querySelector('.ds-virtual-list');
    if (!vl) return [];
    const msgs = [];
    for (const ch of vl.children) {
      const txt = (ch.innerText || '').trim();
      if (!txt) continue;
      const cls = String(ch.className || '');
      if (txt.replace(/\s/g, '').length < 8 && /取消发送/.test(txt.replace(/\s/g, ''))) continue;   // 生成中的按钮行（无换行转义，避开正则坑）
      let role = 'unknown';
      if (cls.includes('_9663006')) role = 'user';
      else if (cls.includes('_4f9bf79')) role = 'assistant';
      msgs.push({ role, text: txt, cls: cls.slice(0, 60) });
    }
    return msgs;
  }

  const msgs = readMessages();
  const lastAssist = [...msgs].reverse().find(m => m.role === 'assistant');
  const inp = findInput();
  const busy = /停止生成|停止回答|正在生成|思考中|Stop generating/i.test(document.body.innerText || '');

  return {
    text: (document.body.innerText || '').slice(-40000),
    len: msgs.length,                                    // ★消息条数（虚拟滚动下比字数可靠）
    msgCount: msgs.length,
    lastAssistText: lastAssist ? lastAssist.text : '',
    lastAssistLen: lastAssist ? lastAssist.text.length : 0,
    lastRole: msgs.length ? msgs[msgs.length - 1].role : 'none',
    busy,
    hasInput: !!inp,
    inputValue: inp ? String(inp.isContentEditable ? inp.innerText : inp.value || '') : '',
    url: location.href,
    title: document.title,
    msgs,
  };
})()
`;

const FIND_INPUT_AND_SET = (text) => `
(function () {
  function vis(e) {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 5 && r.height > 5;
  }
  function findInput() {
    const cands = [
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]'),
    ].filter(vis);
    let best = null, bestScore = -1;
    const H = window.innerHeight;
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      let s = 0;
      if ((el.getAttribute('placeholder') || '').trim()) s += 10;
      if (r.top > H * 0.45) s += 6;
      if (r.width >= 400) s += 3;
      if (r.height >= 30 && r.height <= 220) s += 2;
      const val = el.isContentEditable ? (el.innerText || '') : (el.value || '');
      if (val.trim().length > 0) s -= 4;
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return best;
  }
  const el = findInput();
  if (!el) return { ok: false, where: 'no-input' };

  el.focus();
  try { el.click(); } catch (e) {}

  const text = ${JSON.stringify(text)};
  if (el.isContentEditable) {
    el.innerText = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  } else {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { ok: true, where: el.tagName.toLowerCase(), len: text.length };
})()
`;

const SEND = `
(function () {
  function vis(e) {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 5 && r.height > 5;
  }
  function findInput() {
    const cands = [
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]'),
    ].filter(vis);
    let best = null, bestScore = -1;
    const H = window.innerHeight;
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      let s = 0;
      if ((el.getAttribute('placeholder') || '').trim()) s += 10;
      if (r.top > H * 0.45) s += 6;
      if (r.width >= 400) s += 3;
      if (r.height >= 30 && r.height <= 220) s += 2;
      const val = el.isContentEditable ? (el.innerText || '') : (el.value || '');
      if (val.trim().length > 0) s -= 4;
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return best;
  }
  const el = findInput();
  if (!el) return { ok: false, why: 'no-input' };

  const before = el.isContentEditable ? el.innerText : el.value;

  // ① 先试真回车
  const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));

  return { ok: true, beforeLen: (before || '').length };
})()
`;

const CLICK_SEND_BY_GEOMETRY = `
(function () {
  function vis(e) {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 5 && r.height > 5;
  }
  function findInput() {
    const cands = [
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]'),
    ].filter(vis);
    return cands.length ? cands[cands.length - 1] : null;
  }
  const el = findInput();
  if (!el) return { ok: false, why: 'no-input' };

  // ① 首选：按文本找"发送"按钮（Diagnosed: DeepSeek 有 <button>发送</button>）
  const btns = [...document.querySelectorAll('button, [role="button"], div[class*="send"], span[class*="send"]')].filter(vis);
  for (const b of btns) {
    const label = (b.getAttribute('aria-label') || b.title || b.innerText || '').trim();
    const labelClean = label.replace(/\s/g, '');
    if (labelClean === '发送' || labelClean === 'Send' || labelClean === 'send') {
      b.click();
      return { ok: true, clicked: 'text:' + label.slice(0, 12) };
    }
  }
  // ② 次选：包含"发送"的按钮（排除"取消"）
  for (const b of btns) {
    const label = (b.getAttribute('aria-label') || b.title || b.innerText || '').trim();
    if (/发送|Send/i.test(label) && !/取消|Cancel/i.test(label)) {
      b.click();
      return { ok: true, clicked: 'contains:' + label.slice(0, 12) };
    }
  }
  // ③ 兜底：几何位置（输入框右下角附近的可点击元素）
  const r = el.getBoundingClientRect();
  for (const [dx, dy] of [[-20, -20], [-30, -25], [-15, -15], [-40, -30]]) {
    const hits = document.elementsFromPoint(r.right + dx, r.bottom + dy) || [];
    for (const h of hits) {
      let n = h;
      for (let d = 0; d < 6 && n; d++) {
        if (n.tagName === 'BUTTON' || (n.getAttribute && n.getAttribute('role') === 'button')) {
          n.click();
          return { ok: true, clicked: 'geo:' + n.tagName };
        }
        n = n.parentElement;
      }
    }
  }
  return { ok: false, why: 'no-send-button' };
})()
`;

/**
 * 一步问答（核心）
 *
 * 状态机：probe → find tab → set input → send → 两步等待 → 提取
 */
export async function ask(siteId, question, opts = {}) {
  const sites = loadSites();
  const site = sites[siteId];
  if (!site) throw new Error(`不认识的站：${siteId}（可用：${Object.keys(sites).join(', ')}）`);

  // ⓪ 能力开关：默认关闭 —— 必须显式开启才能调用
  if (!isOn(`bridge.${siteId}`)) {
    const err = new Error(
      `桥「${site.name}」是关闭状态。\n` +
      `开启：node prototype/capabilities.mjs on bridge.${siteId}\n` +
      `（默认全关是为了不白花钱/不白占额度）`
    );
    err.code = 'CAPABILITY_OFF';
    throw err;
  }

  // ① 机密闸（必须在任何调用之前）
  const gate = secretGate(question);
  if (!gate.ok) {
    const err = new Error(gate.reason);
    err.code = 'SECRET_BLOCKED';
    err.hit = gate.hit;
    throw err;
  }

  // ② 探测 CDP
  const port = opts.port || DEFAULT_PORT;
  const p = await probe(port);
  if (!p.ok) {
    const err = new Error(
      `连不上 Chrome 的调试端口（${port}）。请先用带 --remote-debugging-port=${port} 的方式启动 Chrome，` +
      `并在那个窗口里手动登录 ${site.name}。原因：${p.reason}`
    );
    err.code = 'NO_CDP';
    throw err;
  }

  // ③ 找目标标签页
  const targets = await listTargets(port);
  const wanted = targets.filter(t => t.url.includes(new URL(site.url).hostname));
  if (wanted.length === 0) {
    const err = new Error(
      `没找到 ${site.name} 的标签页。请在已登录的 Chrome 里打开 ${site.url}（当前 ${targets.length} 个标签页：` +
      targets.map(t => t.url.slice(0, 50)).join(' | ').slice(0, 300) + `）`
    );
    err.code = 'NO_TAB';
    err.targets = targets.map(t => ({ url: t.url, title: t.title }));
    throw err;
  }

  const tab = wanted[0];
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();

  try {
    await cdp.send('Runtime.enable', {});

    // ④ 检查是否已登录（能拿到输入框）
    const before = await cdp.evaluate(READ_PAGE);
    if (!before.hasInput) {
      const err = new Error(`${site.name} 页面没有输入框 —— 多半是没登录。请在那个窗口手动登录一次。`);
      err.code = 'NOT_LOGGED_IN';
      throw err;
    }

    const baseLen = before.len;
    const baseText = before.text;

    // ⑤ 写入问题
    const set = await cdp.evaluate(FIND_INPUT_AND_SET(question));
    if (!set.ok) throw new Error('找不到输入框（可能改版了）：' + set.where);

    // ⑥ 发送：先试回车，确认没发出去再按几何位置点发送键
    await cdp.evaluate(SEND);
    await sleep(600);

    const afterSend = await cdp.evaluate(READ_PAGE);

    // 判"发出去了吗"：输入框应已清空 or 页面在涨
    // 判"发出去了吗"：消息条数涨了，或输入框清空了
    let sent = afterSend.msgCount > before.msgCount
            || (afterSend.inputValue || '').trim().length === 0;

    if (!sent) {
      const clicked = await cdp.evaluate(CLICK_SEND_BY_GEOMETRY);
      await sleep(1200);
      const after2 = await cdp.evaluate(READ_PAGE);
      sent = after2.msgCount > before.msgCount
          || (after2.inputValue || '').trim().length === 0;
      if (!sent && !clicked.ok) {
        const err = new Error(
          `${site.name} 问话没发出去（回车与发送键都无效）。` +
          `多半是改版或需要过验证码 —— 请在那个窗口手动发一条试试。`
        );
        err.code = 'SEND_FAILED';
        throw err;
      }
    }

    // ⑦ 两步等待：先等"出现"，再等"不再变"
    const quietMs = opts.quietMs || site.quietMs || 20000;
    const hardMs = opts.timeoutMs || 120000;

    let started = false;
    let lastSig = '';
    let stable = 0;
    let lastChange = Date.now();
    const t0 = Date.now();
    const baseMsgCount = before.msgCount;

    while (Date.now() - t0 < hardMs) {
      await sleep(1200);
      const r = await cdp.evaluate(READ_PAGE).catch(() => null);
      if (!r) continue;

      if (r.busy) started = true;

      // ★虚拟滚动下不能用"页面字数"★
      //   判"开始答了"：消息条数涨了，或最后一条 AI 消息出现了且在变长
      const sig = r.msgCount + '|' + r.lastRole + '|' + r.lastAssistLen;
      if (r.msgCount > baseMsgCount) started = true;
      if (r.lastRole === 'assistant' && r.lastAssistLen > 0) started = true;

      if (sig === lastSig) stable++;
      else { stable = 0; lastSig = sig; lastChange = Date.now(); }

      if (!started) continue;

      const quiet = Date.now() - lastChange;
      // ★门槛必须是 >=1★：DeepSeek 常回极短答案（"Stack" 只有 5 字符，
      //   原来要求 >=8 会导致永远判不出"说完了" ⇒ 白等 120s 硬超时）
      const hasAssist = r.lastRole === 'assistant' && r.lastAssistLen >= 1;
      const doneHint = /已思考|思考结束|用时\s*\d+\s*秒|重新生成|Regenerate/i.test(r.text.slice(-800));

      // 判"说完了"：
      //   ① 不忙 + 有 AI 回答 + 静默 ≥3s
      //   ② 不忙 + 有完事标记 + 有回答 + 静默 ≥2.5s
      //   ③ 消息条数已稳定（连续 3 轮不变）+ 有回答 + 不忙  ← 应对超短答案
      if ((!r.busy && hasAssist && quiet >= 3000) ||
          (!r.busy && doneHint && hasAssist && quiet >= 2500) ||
          (!r.busy && hasAssist && stable >= 3 && quiet >= 1500)) {
        break;
      }
      // 兜底：静默够久且有回答（静默按站配）
      if (quiet >= quietMs && hasAssist) break;
    }

    const final = await cdp.evaluate(READ_PAGE);
    const elapsed = Date.now() - t0;

    // ⑧ 取"这次的回答"：直接用结构化的最后一条 AI 消息
    let answer = String(final.lastAssistText || '').trim();

    // 清洗：去掉尾部 UI 词与思考草稿标记
    answer = cleanAnswer(answer);

    // 兜底：结构法没取到，才退回文本切分
    if (!answer) {
      answer = extractAnswer(baseText, final.text, question);
    }

    return {
      site: siteId,
      siteName: site.name,
      question,
      answer,
      meta: {
        elapsedMs: elapsed,
        pageLen: final.len,
        grew: final.len - baseLen,
        started,
        url: final.url,
        title: final.title,
      },
    };
  } finally {
    await cdp.close();
  }
}

/**
 * 从整页文本里切出"这次的回答"。
 *
 * 照抄 luanyujia 的关键洞察：
 *   起点 = 我这句问话的最后一次回声
 *   终点 = 底部工具条第一次出现的位置
 *   切掉"已思考（用时 N 秒）"这类草稿
 */
/**
 * 清洗一条 AI 回答：去思考草稿、去尾部 UI 按钮文字
 */
function cleanAnswer(raw) {
  let s = String(raw || '');

  // 思考草稿
  s = s.replace(/已思考[（(]用时\s*\d+\s*秒[）)]/g, '');
  s = s.replace(/已深度思考[（(].*?[）)]/g, '');
  s = s.replace(/思考过程[\s\S]{0,400}?直接回复/gi, '');

  // 尾部 UI 词（只在最后 100 字内出现才切）
  const ui = ['深度思考', '智能搜索', '内容由 AI 生成', '联网搜索', '重新生成', '重新回答', '复制', 'Regenerate', 'Copy'];
  for (const m of ui) {
    const idx = s.lastIndexOf(m);
    if (idx > 0 && s.length - idx < 100) s = s.slice(0, idx);
  }

  // 收拾空白
  s = s.split('\n').map(l => l.trimEnd()).join('\n').trim();
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

function extractAnswer(beforeText, afterText, question) {
  let ans = String(afterText || '');

  // ① 找公共前缀（发问前就存在的部分）
  const n = Math.min(beforeText.length, ans.length);
  let cp = 0;
  while (cp < n && beforeText[cp] === ans[cp]) cp++;

  // ② 从公共前缀之后开始
  let tail = ans.slice(cp);

  // ③ 找问话回声（用户消息会被回显）
  const q = question.trim();
  const qHead = q.slice(0, 24);
  const echoIdx = tail.lastIndexOf(qHead);
  if (echoIdx >= 0) {
    tail = tail.slice(echoIdx + qHead.length);
  }

  // ④ 切掉思考草稿
  tail = tail.replace(/已思考[（(]用时\s*\d+\s*秒[）)]/g, '');
  tail = tail.replace(/思考过程[\s\S]{0,400}?直接回复/gi, '');
  tail = tail.replace(/正在思考[\s\S]{0,200}?/gi, '');
  tail = tail.replace(/已深度思考[（(].*?[）)]/g, '');

  // ⑤ 切掉底部固定工具条 / 页面按钮文字
  //    DeepSeek 页面底部有「深度思考」「智能搜索」等按钮，会被 innerText 带进来。
  //    策略：从末尾往前找这些已知的界面词，把它们及之后全部切掉。
  const uiWords = [
    '内容由 AI 生成', '联网搜索', '复制', '重新生成', '重新回答',
    '深度思考', '智能搜索', '深度搜索', 'Regenerate', 'Copy',
  ];
  for (const m of uiWords) {
    // 只在靠近尾部（最后 200 字）出现时才切，避免误伤正文里出现这些词
    const idx = tail.lastIndexOf(m);
    if (idx > 0 && tail.length - idx < 200) {
      tail = tail.slice(0, idx);
    }
  }

  // ⑥ 收尾清洗：去掉空行堆叠与前导/尾随噪声
  tail = tail
    .split('\n')
    .map(l => l.trimEnd())
    .filter((l, i, arr) => !(l === '' && (i === 0 || arr[i - 1] === '')))
    .join('\n')
    .trim();

  return tail;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 自检三条（luanyujia 要求的）*/
export async function selfTest(siteId = 'deepseek', opts = {}) {
  const sites = loadSites();
  const site = sites[siteId];
  const results = [];

  // ① 未登录时必须报错，不能返回空串
  try {
    const r = await ask(siteId, '自检一句话：请回复"收到"', { ...opts, timeoutMs: 1000 });
    results.push({ name: '返回结构完整', ok: !!(r && r.answer !== undefined), detail: r ? `answer 长度 ${r.answer.length}` : 'null' });
  } catch (e) {
    const expectCodes = ['NO_CDP', 'NO_TAB', 'NOT_LOGGED_IN', 'SEND_FAILED'];
    results.push({
      name: '未就绪时明确报错（不返回空串）',
      ok: expectCodes.includes(e.code),
      detail: `code=${e.code || '(none)'} msg=${e.message.slice(0, 60)}`,
    });
  }

  // ② 机密闸必须拦截
  const g = secretGate('我的密码: abc123456 请帮我记住');
  results.push({
    name: '机密闸拦截密码',
    ok: g.ok === false && g.hit === '密码/口令',
    detail: g.ok ? '未拦截（严重）' : `拦截类型=${g.hit}`,
  });

  // ③ 普通文本不该被拦
  const g2 = secretGate('请帮我总结这段技术文档的要点');
  results.push({
    name: '普通文本不被误拦',
    ok: g2.ok === true,
    detail: g2.ok ? '放行' : `误拦=${g2.hit}`,
  });

  return results;
}

// ---------- CLI ----------
const isDirect = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/bridge.mjs');
if (isDirect) {
  const [, , cmd, siteArg, ...rest] = process.argv;

  if (cmd === 'probe') {
    const p = await probe();
    if (!p.ok) {
      console.log(`✗ Chrome 调试端口不可用：${p.reason}`);
      console.log('');
      console.log('启动方式（复制到 PowerShell）：');
      console.log(`  & "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$PWD\\prototype\\bridge\\.profiles\\deepseek"`);
      console.log('');
      console.log('然后在那窗口里手动登录 https://chat.deepseek.com/');
      process.exit(1);
    }
    console.log(`✓ Chrome 可连：${p.browser}`);
    const tabs = await listTargets();
    console.log(`  标签页 ${tabs.length} 个：`);
    for (const t of tabs) console.log(`    ${t.title.slice(0, 40)} — ${t.url.slice(0, 60)}`);
    await new Promise(r2 => setTimeout(r2, 100));
    process.exit(0);
  }

  if (cmd === 'selftest') {
    const r = await selfTest(siteArg || 'deepseek');
    console.log('桥自检');
    for (const x of r) console.log(`  ${x.ok ? '✓' : '✗'} ${x.name}  ${x.detail}`);
    const ok = r.every(x => x.ok);
    await new Promise(r2 => setTimeout(r2, 300));   // drain，避免 libuv 断言
    process.exit(ok ? 0 : 1);
  }

  if (cmd === 'ask') {
    const q = rest.join(' ');
    if (!q) { console.log('用法：node bridge.mjs ask deepseek "你的问题"'); process.exit(2); }
    try {
      const r = await ask(siteArg || 'deepseek', q);
      console.log(`【${r.siteName}】${r.meta.elapsedMs}ms / 页面涨 ${r.meta.grew} 字`);
      console.log('');
      console.log(r.answer);
    } catch (e) {
      console.log('✗ ' + e.message);
      if (e.code) console.log('  code=' + e.code);
      // 等一圈事件循环，让 CDP 的 WebSocket 真正关掉（否则 Node 退出时 libuv 断言崩溃）
      await new Promise(r => setTimeout(r, 300));
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 100));
    process.exit(0);
  }

  console.log('用法：');
  console.log('  node bridge.mjs probe                    探测 Chrome 调试端口');
  console.log('  node bridge.mjs selftest [site]          三条自检');
  console.log('  node bridge.mjs ask deepseek "问题"      问一次');
  process.exit(2);
}
