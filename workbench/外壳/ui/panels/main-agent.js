// ui/panels/main-agent.js —— 主 Agent（中枢）面板
//
// ══════════════════════════════════════════════════════════════════════
//  2026-11-11 第四次迭代：接入设计令牌（参考 dsh-claude-style）
//
//  ══════════════════════════════════════════════════════════════════
//  前三次的演进
//  ──────────────────────────────────────────────────────────────────
//  ① xterm 终端跑 dsh --profile dsh-tui
//     失败：TUI 必须 ConPTY，ConPTY 子进程 mkdtemp() 一律 EPERM
//  ② 300px 侧栏内嵌 <webview> 引擎 Web UI
//     技术上通了，但 300px 下输入框 292px、必须先选工作区、失去特殊性
//  ③ 自研界面 + 引擎 RPC（跑通了，但颜色硬编码、几何混乱）
//  ④ 本轮：接入 theme.js 的设计令牌
//
//  ══════════════════════════════════════════════════════════════════
//  从 dsh-claude-style（75KB 设计规范）学到的 5 条
//  ──────────────────────────────────────────────────────────────────
//  1. 「Never pure black, never a cold gray」
//       所有颜色从暖墨种子 var(--color-void, #14100E) 派生，不用纯黑/冷灰
//
//  2. 色彩阶梯：canvas → surface-1/2/3 → border-1/2/3 → ink/ink-2/3/4
//       暗色下 surface 是「往上加亮」，border 是「半透明白」（高光不是线条）
//
//  3. 强调色 < 10% 可见元素
//       朱红只用在：发送按钮、当前状态点
//
//  4. 圆角阶梯 4/8/12/16，间距 4px 节奏
//
//  5. 动效按角色分（feedback/reveal/enter/surface/exit/open）
//
//  ══════════════════════════════════════════════════════════════════
//  引擎协议（详见 研究素材/引擎RPC实测文档.md）
//  ──────────────────────────────────────────────────────────────────
//    · 没有 SSE/WebSocket → 只能轮询 session/page
//    · turn/end 是「回复完成」的可靠判据
//    · assistant/message.stream 里有逐段文本（可按 dt 回放）
//    · tool/call + tool/result 能实时展示「AI 在干什么」
// ══════════════════════════════════════════════════════════════════════

import { INK_CARD, PAPER_CARD, currentCard, RADIUS, SPACE, MOTION, LOOP, FONT } from '../core/theme.js';

export function createMainAgent(host, panel, ctx) {
  const api = ctx && ctx.api;
  const bus = ctx && ctx.bus;
  const state = ctx && ctx.state;
  const p = panel || {};

  // ══════════════════════════════════════════════════════════════
  //  设计令牌
  // ══════════════════════════════════════════════════════════════
  const T = currentCard();   // 跟随外壳主题（浅色用 PAPER_CARD，深色用 INK_CARD）
  const R = RADIUS;
  const S = SPACE;
  const M = MOTION;

  /** 动效简写：transition: <role> */
  const tr = (role) => M[role].duration + ' ' + M[role].easing;

  // ══════════════════════════════════════════════════════════════
  //  运行时状态
  // ══════════════════════════════════════════════════════════════
  const ST = {
    sessionId: '',
    lastSeq: -1,
    polling: false,
    pollTimer: 0,
    sending: false,
    litScenes: new Set(),
    recentLocalUser: [],
    cwd: p.cwd || '',
    turnStartedAt: 0,      // 本轮开始时间（算耗时）
    toolGroup: null,       // 当前工具调用组（DOM）
    toolCount: 0,
    lastToolVerb: '',      // 最近一次工具调用的动词（用于等待行描述）
  };

  // ══════════════════════════════════════════════════════════════
  //  外层
  // ══════════════════════════════════════════════════════════════
  const wrap = document.createElement('div');
  wrap.id = 'ma-panel';
  wrap.style.cssText = [
    'display:flex', 'flex-direction:column', 'height:100%', 'overflow:hidden',
    'background:' + T.canvas,
    'position:relative',
    'font-family:' + FONT.ui,
  ].join(';');

  // ══════════════════════════════════════════════════════════════
  //  头部（26px 高，不用大字号）
  // ══════════════════════════════════════════════════════════════
  const head = document.createElement('div');
  head.style.cssText = [
    'flex:0 0 32px', 'display:flex', 'align-items:center',
    'gap:' + S.sm, 'padding:0 ' + S.md,
    'background:' + T.sidebar,
    'border-bottom:1px solid ' + T['border-1'],
    'white-space:nowrap', 'overflow:hidden',
  ].join(';');

  const dot = document.createElement('span');
  dot.style.cssText = [
    'width:6px', 'height:6px', 'border-radius:' + R.pill,
    'background:' + T['ink-4'], 'flex:0 0 6px',
    'transition:background ' + tr('feedback'),
  ].join(';');

  const titleEl = document.createElement('span');
  titleEl.style.cssText = [
    'font:600 11px/1 ' + FONT.ui,
    'color:' + T.ink, 'flex:0 0 auto',
  ].join(';');
  titleEl.textContent = '中枢';

  const spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1 1 auto';

  const stateEl = document.createElement('span');
  stateEl.style.cssText = [
    'font:10px/1 ' + FONT.code,
    'color:' + T['ink-3'], 'flex:0 0 auto',
    'transition:color ' + tr('feedback'),
  ].join(';');
  stateEl.textContent = '连接中';

  const btnNew = document.createElement('button');
  btnNew.textContent = '＋';
  btnNew.title = '新建对话';
  btnNew.style.cssText = [
    'flex:0 0 auto', 'width:20px', 'height:20px',
    'padding:0', 'border-radius:' + R.xs,
    'background:transparent',
    'border:1px solid ' + T['border-1'],
    'color:' + T['ink-3'],
    'font:11px/1 ' + FONT.code,
    'cursor:pointer',
    'transition:border-color ' + tr('feedback') + ',color ' + tr('feedback'),
  ].join(';');

  head.appendChild(dot);
  head.appendChild(titleEl);
  head.appendChild(spacer);
  head.appendChild(stateEl);
  head.appendChild(btnNew);
  wrap.appendChild(head);

  // ══════════════════════════════════════════════════════════════
  //  消息区
  // ══════════════════════════════════════════════════════════════
  const msgWrap = document.createElement('div');
  msgWrap.id = 'ma-msgs';
  msgWrap.style.cssText = [
    'flex:1 1 auto', 'min-height:0',
    'overflow-y:auto', 'overflow-x:hidden',
    'padding:' + S.md,
    'display:flex', 'flex-direction:column',
    'gap:' + S.sm,        // ★ 12 → 8（原来太松散）
    'align-items:stretch', // ★ 关键：让子项默认占满宽度
  ].join(';');
  wrap.appendChild(msgWrap);

  // ══════════════════════════════════════════════════════════════
  //  等待行（模型正在做什么）—— 参考的核心设计
  // ══════════════════════════════════════════════════════════════
  //
  //  dsh-claude-style 的做法：输入框上方一行，左边三个点做动画，
  //  中间是「模型在干什么」的文字，右边是本轮耗时。
  //
  //  这里简化成：状态点 + 文字（文字在头部已经有，这里只做输入框上方的活动提示）
  // ══════════════════════════════════════════════════════════════
  const waitRow = document.createElement('div');
  waitRow.id = 'ma-wait';
  waitRow.style.cssText = [
    'flex:0 0 auto',
    'display:none', 'align-items:center',
    'gap:' + S.sm,
    'padding:0 ' + S.md + ' ' + S.xs,
    'font:10px/1.6 ' + FONT.ui,
    'color:' + T['ink-3'],
  ].join(';');

  const dotsEl = document.createElement('span');
  dotsEl.style.cssText = 'flex:0 0 auto;display:inline-flex;gap:' + S.xxs + ';align-items:center;';
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('span');
    d.style.cssText = [
      'width:4px', 'height:4px', 'border-radius:' + R.pill,
      'background:' + T.accent,
      'opacity:.35',
      'animation:ma-dot ' + LOOP.dot + ' ease-in-out infinite',
      'animation-delay:' + (i * 0.18) + 's',
    ].join(';');
    dotsEl.appendChild(d);
  }

  const waitText = document.createElement('span');
  waitText.style.cssText = 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

  const waitTime = document.createElement('span');
  waitTime.style.cssText = 'flex:0 0 auto;font:9.5px/1 ' + FONT.code + ';color:' + T['ink-3'] + ';';

  waitRow.appendChild(dotsEl);
  waitRow.appendChild(waitText);
  waitRow.appendChild(waitTime);
  wrap.appendChild(waitRow);

  // ══════════════════════════════════════════════════════════════
  //  输入区
  // ══════════════════════════════════════════════════════════════
  const inputWrap = document.createElement('div');
  inputWrap.style.cssText = [
    'flex:0 0 auto',
    'padding:' + S.sm + ' ' + S.md + ' ' + S.md,
    'background:' + T.sidebar,
    'border-top:1px solid ' + T['border-1'],
    'display:flex', 'gap:' + S.sm, 'align-items:flex-end',
  ].join(';');

  const ta = document.createElement('textarea');
  ta.placeholder = '说点什么…';
  ta.rows = 1;
  ta.style.cssText = [
    'flex:1 1 auto',
    'min-height:32px', 'max-height:140px',
    'resize:none',
    'background:' + T.canvas,
    'border:1px solid ' + T['border-2'],
    'border-radius:' + R.md,
    'color:' + T.ink,
    'font:11.5px/1.55 ' + FONT.ui,
    'padding:' + S.sm + ' ' + S.md,
    'outline:none',
    'overflow-y:auto',
    'transition:border-color ' + tr('feedback'),
  ].join(';');

  const btnSend = document.createElement('button');
  btnSend.textContent = '发送';
  btnSend.style.cssText = [
    'flex:0 0 auto',
    'height:32px', 'padding:0 ' + S.sm,
    'border-radius:' + R.md,
    'background:' + T.accent,
    'border:none',
    'color:' + T['on-accent'],
    'font:10.5px/1 ' + FONT.ui,
    'cursor:pointer',
    'transition:background ' + tr('feedback') + ',opacity ' + tr('feedback'),
  ].join(';');

  inputWrap.appendChild(ta);
  inputWrap.appendChild(btnSend);
  wrap.appendChild(inputWrap);

  host.appendChild(wrap);

  // ══════════════════════════════════════════════════════════════
  //  注入动画 keyframes（三点等待动画）
  // ══════════════════════════════════════════════════════════════
  (function ensureKeyframes() {
    const id = 'ma-keyframes';
    if (document.getElementById(id)) return;
    const st = document.createElement('style');
    st.id = id;
    st.textContent = [
      '@keyframes ma-dot {',
      '  0%, 60%, 100% { opacity: .30; transform: translateY(0) scale(1); }',
      '  30% { opacity: 1; transform: translateY(-2px) scale(1.12); }',
      '}',
      '@keyframes ma-in {',
      '  from { opacity: 0; transform: translateY(4px); }',
      '  to   { opacity: 1; transform: translateY(0); }',
      '}',
      '@keyframes ma-swap-in {',
      '  from { opacity: 0; transform: translateY(3px); filter: blur(1.5px); }',
      '  to   { opacity: 1; transform: translateY(0); filter: blur(0); }',
      '}',
    ].join('\n');
    document.head.appendChild(st);
  })();

  // ══════════════════════════════════════════════════════════════
  //  工具函数
  // ══════════════════════════════════════════════════════════════
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  function setState(text, tone) {
    // ⚠ 文字切换用「换」动效（参考的 swap：旧的往上走，新的从下进）
    stateEl.style.animation = 'none';
    void stateEl.offsetWidth;   // 强制 reflow 以便重播动画
    stateEl.style.animation = 'ma-swap-in ' + tr('swap');
    stateEl.textContent = text;

    const color = tone === 'ok' ? T.ok :
      tone === 'bad' ? T.err :
      tone === 'warn' ? T.warn : T['ink-3'];
    stateEl.style.color = color;
    dot.style.background = color;
  }

  function scrollBottom() {
    msgWrap.scrollTop = msgWrap.scrollHeight;
  }

  /** 显示/更新等待行 */
  function showWait(text) {
    if (!text) {
      waitRow.style.display = 'none';
      // ⚠ 2026-11-11：隐藏时要把残留文字和耗时清掉。
      //   实测：turn/end 之后 display 变 none，但 textContent 还是「第 2 步9s」，
      //   下次显示前会闪一下旧内容。
      waitText.textContent = '';
      waitTime.textContent = '';
      return;
    }
    waitRow.style.display = 'flex';
    waitText.textContent = text;
    if (ST.turnStartedAt) {
      const sec = Math.round((Date.now() - ST.turnStartedAt) / 1000);
      waitTime.textContent = sec > 0 ? sec + 's' : '';
    }
  }

  /**
   * 把工具名翻译成人话（参考的「a thought reads as the thought itself」）
   *
   * ⚠ 2026-11-11：原来只显示「第 2 步」，用户不知道在干什么。
   *   参考 dsh-claude-style 的做法：「a named call keeps its verb」
   *   —— 工具调用要说动词（查找文件 / 编辑 / 运行命令），不是只有名字。
   */
  function toolVerb(name) {
    const MAP = {
      read: '读取文件',
      write: '写入文件',
      edit: '编辑文件',
      glob: '查找文件',
      grep: '搜索内容',
      bash: '运行命令',
      shell: '运行命令',
      pwsh: '运行命令',      // ★ 实测这台机器上用的是 pwsh（Windows PowerShell）
      powershell: '运行命令',
      cmd: '运行命令',
      ls: '列目录',
      web_search: '联网搜索',
      web_fetch: '抓取网页',
      task: '派子任务',
      todo_write: '更新清单',
      notebook_edit: '编辑笔记本',
    };
    return MAP[name] || name;
  }

  // ══════════════════════════════════════════════════════════════
  //  渲染：消息气泡（用 token 的 bubble 色）
  // ══════════════════════════════════════════════════════════════
  function bubble(role, text, opts) {
    const o = opts || {};
    const isUser = role === 'user';
    const el = document.createElement('div');
    // ⚠ 气泡要撑开：外层不用 align-items 控制对齐，改由内部 auto margin 控制
    el.style.cssText = [
      'display:flex', 'flex-direction:column',
      'gap:' + S.xs,
      'width:100%',                                 // ★ 占满
      'align-items:' + (isUser ? 'flex-end' : 'flex-start'),
      'animation:ma-in ' + tr('enter'),
    ].join(';');

    const meta = document.createElement('div');
    meta.style.cssText = [
      'font:9px/1 ' + FONT.code,
      'color:' + T['ink-3'],
      'padding:0 ' + S.xxs,
    ].join(';');
    meta.textContent = (isUser ? '你' : '中枢') + (o.time ? ' · ' + o.time : '');

    const body = document.createElement('div');
    // ⚠ 关键：min-width:0 + max-width:100% 让长内容能换行而不是撑破
    body.style.cssText = [
      'max-width:88%',
      'min-width:0',
      'padding:' + S.sm + ' ' + S.md,
      'border-radius:' + R.md,
      'font:11.5px/1.7 ' + FONT.ui,
      'white-space:pre-wrap', 'word-break:break-word',
      isUser
        ? 'background:' + T['bubble-user'] + ';color:' + T.ink + ';border:1px solid ' + T['border-1']
        : 'background:' + T['bubble-ai'] + ';color:' + T['ink-2'] + ';border:1px solid ' + T['border-1'],
    ].join(';');

    body.innerHTML = renderMarkdownLite(text || '');

    el.appendChild(meta);
    el.appendChild(body);
    msgWrap.appendChild(el);
    scrollBottom();
    return { el, body };
  }

  /**
   * 极简 Markdown 渲染
   * 代码块用 T['code-block']，行内代码用 T['accent'] 的极淡色
   */
  function renderMarkdownLite(src) {
    const text = String(src || '');
    const blocks = [];
    let s = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      const i = blocks.length;
      blocks.push({ lang, code });
      return '\u0000BLOCK' + i + '\u0000';
    });

    s = esc(s);
    s = s.replace(/`([^`\n]+)`/g,
      '<code style="background:' + T.inset + ';padding:' + S.xxs + ' ' + S.xs + ';' +
      'border-radius:' + R.xs + ';font:10px ' + FONT.code + ';color:' + T['ink-2'] + '">$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g,
      '<strong style="color:' + T.ink + ';font-weight:600">$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em style="color:' + T['ink-2'] + '">$2</em>');

    s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (m, idx) => {
      const b = blocks[Number(idx)];
      if (!b) return '';
      return '<pre style="margin:' + S.sm + ' 0;padding:' + S.sm + ' ' + S.md + ';' +
        'border-radius:' + R.md + ';background:' + T['code-block'] + ';' +
        'border:1px solid ' + T['border-1'] + ';overflow-x:auto;' +
        'font:10px/1.6 ' + FONT.code + ';color:' + T['ink-2'] + ';white-space:pre">' +
        esc(b.code) + '</pre>';
    });

    return s;
  }

  // ══════════════════════════════════════════════════════════════
  //  工具调用组（参考的 Process rows 做法）
  //
  //  dsh-claude-style: 「the group's body becomes one card — the 1px card
  //  border and the ladder's 8px radius — and each row is one line of it,
  //  36px tall, inset 12px, with the 0.5px divider between rows and none
  //  above the first.」
  //
  //  所以：连续的工具调用包成一张卡，每行一条，行间 0.5px 分隔线。
  // ══════════════════════════════════════════════════════════════
  function toolGroup() {
    if (ST.toolGroup) return ST.toolGroup;
    const card = document.createElement('div');
    card.style.cssText = [
      'align-self:flex-start',
      'max-width:94%',
      'border-radius:' + R.md,
      'background:' + T.card,
      'border:1px solid ' + T['border-2'],
      'overflow:hidden',
      'animation:ma-in ' + tr('reveal'),
    ].join(';');
    msgWrap.appendChild(card);
    ST.toolGroup = card;
    ST.toolCount = 0;
    scrollBottom();
    return card;
  }

  function addToolRow(name, argsRaw, resultText) {
    const card = toolGroup();

    // 行间分隔线（第一行上面没有）
    if (ST.toolCount > 0) {
      const sep = document.createElement('div');
      sep.style.cssText = [
        'height:0',
        'border-top:0.5px solid ' + T.divider,
      ].join(';');
      card.appendChild(sep);
    }
    ST.toolCount++;

    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex', 'align-items:center',
      'gap:' + S.sm,
      'height:32px',
      'padding:0 ' + S.md,
      'font:10px/1 ' + FONT.code,
    ].join(';');

    // 提取关键参数
    let hint = '';
    try {
      const a = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
      if (a && typeof a === 'object') {
        for (const k of ['file_path', 'path', 'command', 'pattern', 'query', 'url']) {
          if (a[k]) { hint = String(a[k]); break; }
        }
      }
    } catch (e) { hint = String(argsRaw || '').slice(0, 40); }

    row.innerHTML =
      '<span style="color:' + T['ink-3'] + ';flex:0 0 auto">' + esc(toolVerb(name)) + '</span>' +
      (hint
        ? '<span style="color:' + T['ink-3'] + ';flex:1 1 auto;overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap" title="' + esc(hint) + '">' +
          esc(hint) + '</span>'
        : '<span style="flex:1 1 auto"></span>') +
      '<span style="color:' + T.ok + ';flex:0 0 auto;font-size:9px">✓</span>';

    card.appendChild(row);
    scrollBottom();
    return row;
  }

  // ══════════════════════════════════════════════════════════════
  //  系统提示
  //
  //  ⚠ 2026-11-11 两处修正（WCAG 审计查出来的）：
  //    ① 原来做成 pill 胶囊 + 灰底，3 个胶囊比真正的对话还显眼
  //       → 改成极轻的一行小字，无背景
  //    ② 原来用 ink-5（对比度 2.44），但 ink-5 在设计令牌里标注是
  //       「仅装饰，不承载信息」—— 这里承载了「注入 2.6k 字」这个信息
  //       → 必须用 ink-3（5.14，AA）
  // ══════════════════════════════════════════════════════════════
  function sysNote(text, tone) {
    const el = document.createElement('div');
    el.style.cssText = [
      'align-self:center',
      'font:9px/1.5 ' + FONT.code,
      'padding:0 ' + S.xs,
      'color:' + (tone === 'bad' ? T.err : tone === 'warn' ? T.warn : T['ink-3']),
    ].join(';');
    el.textContent = text;
    msgWrap.appendChild(el);
    scrollBottom();
    return el;
  }

  // ══════════════════════════════════════════════════════════════
  //  神经元点亮（调度反馈，不能丢）
  // ══════════════════════════════════════════════════════════════
  function lightScene(sceneId, on, sceneName) {
    if (!sceneId) return;
    const list = window.__NEURON3D;
    const arr = Array.isArray(list) ? list : (list ? [list] : []);
    for (const inst of arr) {
      if (inst && typeof inst.lightScene === 'function') {
        try { inst.lightScene(sceneId, !!on); } catch (e) { /* ignore */ }
      }
    }
    const name = sceneName || sceneId;
    if (on) ST.litScenes.add(name); else ST.litScenes.delete(name);
    if (ST.litScenes.size > 0) {
      setState('调度 ' + ST.litScenes.size, 'warn');
      showWait('正在调度：' + [...ST.litScenes].join(' · '));
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  事件处理
  // ══════════════════════════════════════════════════════════════
  function handleEvent(ev) {
    if (!ev || ev.seq == null) return;
    if (ev.seq <= ST.lastSeq) return;
    ST.lastSeq = ev.seq;

    const d = ev.data || {};

    switch (ev.type) {
      case 'user/message': {
        const content = d.content || [];
        const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (!text) break;
        const trimmed = text.trim();

        // 系统注入的大段上下文 → 折叠
        const isInjected = /^<(system-reminder|available_skills)|【场景记忆填充任务】|^Current runtime context|^Instructions from:/.test(trimmed);
        if (isInjected) {
          sysNote('系统注入 ' + (Math.round(trimmed.length / 100) / 10) + 'k 字');
          break;
        }
        // 引擎的时间戳/环境消息 → 跳过
        if (/^Time sampled |^Browser time zone |^Elapsed since /.test(trimmed)) break;
        // 引擎回显我们刚发的 → 跳过（发送时已本地显示）
        if (ST.recentLocalUser.some((t) => t === trimmed)) break;

        bubble('user', text, { time: timeStr(ev.time) });
        break;
      }

      case 'assistant/message': {
        const msg = d.message || {};
        const content = msg.content || [];
        const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (text.trim()) {
          bubble('assistant', text, { time: timeStr(ev.time) });
          ST.toolGroup = null;   // 正文出现后，下一个工具组要新开
        }
        break;
      }

      case 'tool/call': {
        const verb = toolVerb(d.name || 'tool');
        ST.lastToolVerb = verb;
        addToolRow(d.name || 'tool', d.arguments);
        showWait('正在' + verb);
        break;
      }

      case 'tool/result': {
        // 结果暂时不展示详情（后续可加折叠）
        break;
      }

      case 'turn/start':
        ST.turnStartedAt = Date.now();   // ⚠ 用本机时间，不用 ev.time（引擎时间戳可能不同源，实测差 2979s）
        ST.toolGroup = null;
        ST.toolCount = 0;
        ST.lastToolVerb = '';
        setState('思考中', 'warn');
        showWait('模型正在思考…');
        break;

      case 'step/start':
        setState('第 ' + d.step + ' 步', 'warn');
        // ⚠ 2026-11-11：只显示「第 N 步」用户不知道在干什么。
        //   参考 dsh-claude-style：「the wording in the secondary label」
        //   —— 要说清楚现在在做什么，步数只是辅助。
        //   已经有工具在跑就保留工具描述，否则说明在思考。
        if (ST.lastToolVerb) {
          showWait(ST.lastToolVerb + '（第 ' + d.step + ' 步）');
        } else {
          showWait('模型正在思考…（第 ' + d.step + ' 步）');
        }
        break;

      case 'turn/end': {
        const reason = (d.reason && d.reason.kind) || 'completed';
        ST.sending = false;
        ST.toolGroup = null;
        ST.turnStartedAt = 0;
        showWait('');
        if (reason === 'completed') setState('就绪', 'ok');
        else setState('结束', 'warn');
        updateSendBtn();
        break;
      }

      default:
        break;
    }
  }

  function timeStr(t) {
    if (!t) return '';
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ══════════════════════════════════════════════════════════════
  //  轮询
  // ══════════════════════════════════════════════════════════════
  function startPolling(intervalMs) {
    if (ST.pollTimer) return;
    ST.pollTimer = setInterval(pollOnce, intervalMs || 700);
  }

  function stopPolling() {
    if (ST.pollTimer) {
      clearInterval(ST.pollTimer);
      ST.pollTimer = 0;
    }
  }

  async function pollOnce() {
    if (ST.polling || !ST.sessionId) return;
    ST.polling = true;
    try {
      const r = await api.ma.page(ST.sessionId);
      const v = unwrap(r);
      if (!v || v.ok === false) return;
      for (const rec of v.records || []) {
        handleEvent(rec && rec.event ? rec.event : rec);
      }
    } catch (e) { /* 下一轮继续 */ } finally {
      ST.polling = false;
    }
  }

  function unwrap(wrapped) {
    if (wrapped && typeof wrapped === 'object' && 'value' in wrapped) return wrapped.value;
    return wrapped;
  }

  // ══════════════════════════════════════════════════════════════
  //  发送
  // ══════════════════════════════════════════════════════════════
  function updateSendBtn() {
    const canSend = !ST.sending && !!ST.sessionId && ta.value.trim().length > 0;
    btnSend.disabled = !canSend;
    btnSend.style.opacity = canSend ? '1' : '.38';
    btnSend.style.cursor = canSend ? 'pointer' : 'not-allowed';
    btnSend.textContent = ST.sending ? '…' : '发送';
  }

  async function send() {
    const text = ta.value.trim();
    if (!text || ST.sending) return;
    if (!ST.sessionId) {
      sysNote('会话还没准备好，稍等…', 'warn');
      return;
    }

    ST.sending = true;
    updateSendBtn();
    ta.value = '';
    ta.style.height = 'auto';

    bubble('user', text, { time: nowTime() });
    ST.recentLocalUser.push(text);
    if (ST.recentLocalUser.length > 5) ST.recentLocalUser.shift();

    ST.turnStartedAt = Date.now();
    setState('发送中', 'warn');
    showWait('已发送，等待模型…');

    try {
      const r = await api.ma.send(ST.sessionId, text);
      const v = unwrap(r);
      if (!v || v.ok === false) {
        sysNote('发送失败：' + ((v && v.err) || '未知'), 'bad');
        setState('发送失败', 'bad');
        showWait('');
        ST.sending = false;
        updateSendBtn();
      }
    } catch (e) {
      sysNote('发送异常：' + String((e && e.message) || e), 'bad');
      showWait('');
      ST.sending = false;
      updateSendBtn();
    }
  }

  function nowTime() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ══════════════════════════════════════════════════════════════
  //  初始化
  // ══════════════════════════════════════════════════════════════
  async function init() {
    if (!api || !api.isElectron) {
      sysNote('非 Electron 环境，无法连接引擎', 'bad');
      setState('不可用', 'bad');
      return;
    }
    if (!api.ma) {
      sysNote('主进程缺少 ma 接口 —— 重启工作台', 'bad');
      setState('接口缺失', 'bad');
      return;
    }

    const cwd = ST.cwd ||
      (api.paths && api.paths.memRoot ? api.paths.memRoot + '/中枢' : '') || '';

    setState('等引擎', 'warn');

    const DEADLINE = Date.now() + 25000;
    let lastErr = '';
    let v = null;

    while (Date.now() < DEADLINE) {
      try {
        const r = await api.ma.ensureSession(cwd);
        const val = unwrap(r);
        if (val && val.ok && val.sessionId) { v = val; break; }
        lastErr = (val && val.err) || '未知';
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
      await new Promise((res) => setTimeout(res, 600));
    }

    if (!v) {
      sysNote('创建会话失败：' + lastErr, 'bad');
      setState('会话失败', 'bad');
      return;
    }

    ST.sessionId = v.sessionId;
    ST.lastSeq = -1;
    setState('就绪', 'ok');
    if (v.reused) sysNote('已接入中枢会话');

    await loadHistory();
    startPolling(700);
    updateSendBtn();
  }

  async function loadHistory() {
    try {
      const r = await api.ma.page(ST.sessionId);
      const v = unwrap(r);
      if (!v || v.ok === false) return;
      const records = v.records || [];
      const hasReal = records.some((x) => {
        const ev = x && x.event ? x.event : x;
        return ev && (ev.type === 'user/message' || ev.type === 'assistant/message');
      });
      if (!hasReal) {
        sysNote('新对话');
        return;
      }
      for (const x of records) {
        handleEvent(x && x.event ? x.event : x);
      }
      if (ST.lastSeq < 0) ST.lastSeq = v.cursor || 0;
    } catch (e) { /* ignore */ }
  }

  // ══════════════════════════════════════════════════════════════
  //  事件绑定
  // ══════════════════════════════════════════════════════════════
  ta.addEventListener('focus', function () {
    ta.style.borderColor = T['border-3'];
  });
  ta.addEventListener('blur', function () {
    ta.style.borderColor = T['border-2'];
  });

  ta.addEventListener('input', function () {
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
    updateSendBtn();
  });

  ta.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });

  btnSend.addEventListener('mouseenter', function () {
    if (!btnSend.disabled) btnSend.style.background = T['accent-hover'];
  });
  btnSend.addEventListener('mouseleave', function () {
    btnSend.style.background = T.accent;
  });
  btnSend.addEventListener('click', send);

  btnNew.addEventListener('click', async function () {
    btnNew.disabled = true;
    btnNew.textContent = '…';
    try {
      stopPolling();
      ST.sessionId = '';
      ST.lastSeq = -1;
      msgWrap.innerHTML = '';
      await init();
    } finally {
      btnNew.disabled = false;
      btnNew.textContent = '＋';
    }
  });

  // 启动
  setTimeout(init, 80);
  updateSendBtn();

  // 耗时刷新（每秒更新等待行的时间）
  const tick = setInterval(function () {
    if (ST.turnStartedAt && waitRow.style.display !== 'none') {
      showWait(waitText.textContent);
    }
  }, 1000);

  // ══════════════════════════════════════════════════════════════
  //  对外接口
  // ══════════════════════════════════════════════════════════════
  return {
    el: wrap,
    lightScene: lightScene,
    send: send,
    reload: function () {
      stopPolling();
      ST.sessionId = '';
      ST.lastSeq = -1;
      msgWrap.innerHTML = '';
      init();
    },
    isReady: function () { return !!ST.sessionId; },
    destroy: function () {
      stopPolling();
      clearInterval(tick);
    },
  };
}

export default createMainAgent;
