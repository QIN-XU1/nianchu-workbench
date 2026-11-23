// ui/panels/harness.js —— AI 对话面板（webview 内嵌引擎）
//
// 这是 11 个场景都有的面板，是真正的"工作"界面。
// 实现要点：
// 1) 用 Electron <webview> 内嵌 http://127.0.0.1:3080/?token=xxx
// 2) 每个面板独立 partition（避免 cookie 串台）
// 3) 绑定场景 json 里的 sessionId（钉住对应会话）
// 4) 加载失败/引擎不可用时给明确的降级提示

export function createHarness(host, panel, ctx) {
  const api = ctx && ctx.api;
  const p = panel || {};

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--color-void, var(--color-void, var(--color-txt-3, #0F1113)));';

  // ═══ 面板头 ═══
  const head = document.createElement('div');
  head.style.cssText = 'flex:0 0 24px;display:flex;align-items:center;gap:6px;padding:0 8px;background:var(--s3,var(--color-raised, var(--color-raised, var(--color-txt-3, #181C20))));border-bottom:1px solid var(--line,var(--color-line, var(--color-line, var(--color-txt-3, #22272D))));font:11px "JetBrains Mono",monospace;color:var(--t2,var(--color-txt-2, var(--color-txt-2, var(--color-txt-3, #A2ABBA))));white-space:nowrap;overflow:hidden;';

  const title = document.createElement('span');
  title.style.cssText = 'font-weight:600;color:var(--t1,var(--color-txt-1, var(--color-txt-1, var(--color-txt-3, #E9EDF2))));overflow:hidden;text-overflow:ellipsis;';
  title.textContent = p.title || 'AI';

  const dot = document.createElement('span');
  dot.style.cssText = 'width:5px;height:5px;border-radius:50%;background:var(--color-txt-disabled, var(--color-txt-3, #5b6470));flex:0 0 5px;';

  const spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1 1 auto';

  const btnReload = document.createElement('button');
  btnReload.textContent = '⟳';
  btnReload.title = '重新加载';
  btnReload.style.cssText = 'flex:0 0 auto;height:18px;padding:0 5px;background:transparent;border:1px solid var(--color-line, var(--color-txt-3, #232830));color:var(--color-txt-2, var(--color-txt-2, var(--color-txt-3, #A2ABBA)));border-radius:3px;cursor:pointer;font-size:11px;';

  const stateText = document.createElement('span');
  stateText.style.cssText = 'font-size:10px;color:var(--color-txt-3, var(--color-txt-3, var(--color-txt-3, #8A94A3)));flex:0 0 auto;';
  stateText.textContent = '…';

  head.appendChild(title);
  head.appendChild(dot);
  head.appendChild(spacer);
  head.appendChild(stateText);
  head.appendChild(btnReload);
  wrap.appendChild(head);

  // ═══ 内容区 ═══
  const body = document.createElement('div');
  body.style.cssText = 'flex:1 1 auto;min-height:0;position:relative;overflow:hidden;';
  wrap.appendChild(body);

  host.appendChild(wrap);

  let wv = null;
  let ready = false;

  function setState(text, tone) {
    stateText.textContent = text;
    const color = tone === 'ok' ? 'var(--color-ok, var(--color-txt-3, #4A9E6A))' : tone === 'bad' ? 'var(--color-err, var(--color-txt-3, #D05A4A))' : tone === 'warn' ? 'var(--color-txt-3, #c99a3d)' : 'var(--color-txt-3, var(--color-txt-3, var(--color-txt-3, #8A94A3)))';
    stateText.style.color = color;
    dot.style.background = color;
  }

  function showFallback(msg, hint) {
    body.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;padding:16px;text-align:center;">' +
      '<div style="font:10px monospace;color:var(--color-err, var(--color-txt-3, #D05A4A))">' + esc(msg) + '</div>' +
      (hint ? '<div style="font:10px/1.5 monospace;color:var(--color-txt-disabled, var(--color-txt-3, #5b6470));max-width:240px">' + esc(hint) + '</div>' : '') +
      '</div>';
  }

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  async function mount() {
    if (!api || !api.isElectron) {
      showFallback('非 Electron 环境', 'webview 需要 Electron 才能内嵌 AI 引擎');
      setState('不可用', 'bad');
      return;
    }

    setState('获取引擎地址…', 'warn');

    // ══════════════════════════════════════════════════════════
    //  ★ 2026-11-11 修复（事故 AC-017）：
    //
    //  原来只请求一次 getHarnessUrl()，拿不到 token 就直接失败。
    //
    //  实测问题：场景在 boot 早期就渲染了，那时引擎还在启动
    //  → harnessToken 还没被捕获 → 返回不带 token 的 URL
    //  → 面板显示「token 缺失」，而且**再也不会自动恢复**。
    //
    //  修法：轮询等待，最多 20 秒（引擎冷启动约 5-10 秒）。
    //    每次间隔 600ms，拿到带 token 的 URL 就继续。
    //    超时才报错 —— 而且提示「稍后点刷新」。
    // ══════════════════════════════════════════════════════════
    let url = '';
    let lastUrl = '';
    const DEADLINE = Date.now() + 20000;
    let attempt = 0;

    while (Date.now() < DEADLINE) {
      attempt++;
      try {
        const r = await api.getHarnessUrl();
        if (r && r.ok && typeof r.value === 'string' && r.value) {
          lastUrl = r.value;
          if (/[?&]token=/.test(r.value)) {
            url = r.value;
            break;
          }
        }
      } catch (e) { /* 忽略，继续等 */ }

      // 引擎没起来时，顺便更新状态提示
      if (attempt === 1) setState('等待引擎…', 'warn');
      await new Promise(function (res) { setTimeout(res, 600); });
    }

    if (!url) {
      if (lastUrl) {
        // 拿到地址但没有 token —— 说明引擎在跑但 token 没传到
        showFallback('引擎 URL 缺少 token',
          'url=' + lastUrl + '\n\n等待 20 秒仍未拿到 token。\n' +
          '可能是引擎先于工作台启动（复用外部实例）。\n' +
          '试试：重启工作台，或点右上角 ⟳ 重试。');
        setState('token 缺失', 'bad');
      } else {
        showFallback('引擎地址为空',
          '等待 20 秒仍未拿到引擎地址。\n工作台引擎可能未启动，请检查 外壳/server.log。');
        setState('引擎未就绪', 'bad');
      }
      return;
    }

    // 取 sessionId 绑定（场景 json 里定的那条会话）
    const sessionId = String(p.sessionId || p.session || '');

    // ⚠ 2026-11-12 新增：读配置里的 sessionTitle 作为「找哪一行会话」的线索
    //
    //   为什么需要它：
    //     引擎的侧栏 sessionRow 只显示会话**标题**，不显示 sessionId。
    //     所以不能按 id 找，只能按标题找。
    //     各场景配置里的 sessionTitle（"调研"/"架构梳理"...）正是这个标题。
    //
    //   注意：配置里还有 pinTarget 字段（数组），旧代码完全没用。
    //        这里优先用 sessionTitle，没有则用 pinTarget[0]。
    const titleHint = String(
      p.sessionTitle ||
      (Array.isArray(p.pinTarget) && p.pinTarget.length ? p.pinTarget[0] : '') ||
      ''
    );
    const sceneLabel = titleHint || String(sessionId).slice(0, 14) || 'unknown';

    setState(sessionId ? '绑定会话' : '加载中', 'warn');

    // ═══ 创建 webview ═══
    // ⚠ 顺序很关键：先插入 DOM，再设 src。Electron 的 webview
    //    在未 attach 时设置 src 可能导致加载被忽略。
    wv = document.createElement('webview');
    // 统一 partition：与旧前端共享登录态（避免每个面板重新认证）
    wv.setAttribute('partition', 'persist:harness');
    wv.setAttribute('allowpopups', '');
    // ⚠ 2026-11-13 修（原来写死 background:#fff，这是「白一块」的直接来源）
    //
    //   原来：wv.style.cssText = '...;background:#fff;...'
    //   问题：webview 加载完成前会露出这个白底；加载后如果引擎是浅色，
    //        整个面板就是纯白，和周围的深色壳形成「深→白→深」割裂。
    //
    //   真正的修法在主进程（main.js 里 nativeTheme.themeSource='dark'），
    //   让引擎 UI 自己切深色。这里把 fallback 底色改成和面板一致的深色，
    //   这样即使 webview 还没加载完，也不会闪白。
    wv.style.cssText = 'width:100%;height:100%;border:0;background:var(--color-panel, var(--color-txt-3, #232324));display:flex;';

    wv.addEventListener('dom-ready', function () {
      ready = true;
      setState('已连接', 'ok');
      // ══════════════════════════════════════════════════════
      //  ★ 2026-11-11：确保面板处于「可输入」状态
      //
      //  实测背景：
      //    引擎 UI 有几种首页形态：
      //      ① 「选择一个工作区开始」  → **没有输入框**，不能用
      //      ② 「描述你想要构建的内容」→ 有输入框，能用
      //      ③ 已打开某会话           → 有输入框，能用
      //
      //    形态 ① 出现在：刚注册工作区后第一次打开、
      //    或者 localStorage 的 current 指向的会话不存在时。
      //
      //  修法（实测有效）：
      //    如果检测到形态 ①，点一次「新会话」按钮 → 变成形态 ②。
      //    实测：usable=0 → usable=1，页面变成「描述你想要构建的内容」。
      //
      //  ⚠ 试过但失败的「绑定到指定会话」方案（记录下来，别重复踩）：
      //    ① DOM 里找含 session-id 的元素点击 → 引擎显示的是标题，永远找不到
      //    ② 写 localStorage + reload → current 写对了但页面不进会话，
      //       而且会把形态 ② 弄坏成形态 ①
      //    ③ URL 参数 / hash → 引擎前端没有这个实现
      //    ④ 点侧栏 sessionRow → 方向对但侧栏收起、行不可见，坐标点击很脆弱
      //
      //  结论：引擎没有可靠的会话深链，所以**只保证「能用」**，
      //        不假装「已绑定到场景会话」。
      // ══════════════════════════════════════════════════════
      setTimeout(function () {
        try {
          wv.executeJavaScript(HARNESS_ENSURE_USABLE_JS).then(function (res) {
            var r = null;
            try { r = (typeof res === 'string') ? JSON.parse(res) : res; } catch (e) { r = null; }
            if (r && r.state === 'need-new') {
              setState('初始化…', 'warn');
            } else if (r && r.state === 'usable') {
              setState('已连接', 'ok');
            }

            // ══════════════════════════════════════════════════════
            //  ★ 2026-11-12 接上：钉到场景自己的会话
            //
            //  之前这里只有「保证能用」，注释明确写着
            //  「不假装已绑定到场景会话」——因为 4 种方案都失败了。
            //
            //  2026-11-12 找到第 5 种可行方案（DOM el.click()），
            //  所以现在真的把面板钉到配置里指定的会话上了。
            //
            //  注意：这里不能在 then 里 await（不是 async 函数），
            //        所以用独立的 async IIFE。
            // ══════════════════════════════════════════════════════
            if (sessionId) {
              ;(async function () {
                try {
                  var pin = await ensureSceneSession(sessionId, titleHint);
                  if (pin.ok) {
                    setState('已绑定会话', 'ok');
                    console.log('[harness] 场景会话已绑定: ' + sceneLabel + ' → ' + String(sessionId).slice(0, 14) + ' (' + pin.detail + ')');
                  } else {
                    setState('会话未绑定', 'warn');
                    console.log('[harness] 场景会话绑定失败: ' + sceneLabel + ' → ' + pin.detail);
                  }
                } catch (e) {
                  console.log('[harness] 场景会话绑定异常: ' + String((e && e.message) || e));
                }
              })();
            }
          }).catch(function () {});
        } catch (e) { /* ignore */ }
      }, 1200);
    });

    wv.addEventListener('did-fail-load', function (e) {
      if (e.isMainFrame) {
        setState('加载失败', 'bad');
        showFallback('引擎加载失败', '错误码 ' + e.errorCode + ' ' + (e.errorDescription || ''));
      }
    });

    wv.addEventListener('crashed', function () {
      setState('已崩溃', 'bad');
      showFallback('webview 崩溃', '可点击 ⟳ 重新加载，或重启工作台');
    });

    // 先插入，再设属性，最后设 src（保证 attach 后加载）
    body.appendChild(wv);
    wv.setAttribute('src', url);
    // 双保险：用属性赋值（Electron 对 wv.src 更可靠）
    try { wv.src = url; } catch (e) { /* 忽略 */ }


    wv.addEventListener('did-fail-load', function (e) {
      if (e.isMainFrame) {
        setState('加载失败', 'bad');
        showFallback('引擎加载失败', '错误码 ' + e.errorCode + ' ' + (e.errorDescription || ''));
      }
    });

    wv.addEventListener('crashed', function () {
      setState('已崩溃', 'bad');
      showFallback('webview 崩溃', '可点击 ⟳ 重新加载，或重启工作台');
    });

    body.appendChild(wv);

    btnReload.addEventListener('click', reload);
  }

  // ══════════════════════════════════════════════════════════════
  //  pinScript：把面板钉到指定会话
  //
  //  ★ 2026-11-11 彻底重写（旧版从来没成功过）
  //
  //  旧版为什么失败：
  //    var nodes = document.querySelectorAll('[class*="Session"] [role="listitem"], ...');
  //    if (txt.indexOf(needle) >= 0) nodes[i].click();
  //  —— 它在找包含 "session-223fba45-..." 这种字符串的 DOM 文本。
  //     但引擎 UI 上显示的是会话**标题**（如「这是一次真实的自检任务…」），
  //     永远不会显示那个 id。所以永远匹配不到，
  //     而且失败被 catch(function(){}) 吞掉 —— 界面看起来「加载成功」，
  //     实际所有面板都停在「新建对话」状态。
  //
  //  正确做法（2026-11-11 实测出来的）：
  //    引擎用 localStorage['dsh.sessions.current'] 记录当前会话：
  //      {"sessionId":"session-xxx"}
  //    写入它 + 重建 webview（切走再切回），引擎就会打开那个会话。
  //
  //  实测证据：
  //    写入前 text = "工作区 探索未至之境 预览版 选择工作区..."
  //    写入后 text = "工作区 这是一次真实的自检任务，请... 你的场景记忆文件在：
  //                  `数据/.dsh/场景记忆/架构梳理/场景私有记忆.md`..."
  //    —— 正是架构梳理场景的历史对话。
  //
  //  ⚠ 为什么要「切走再切回」而不是 wv.reload()：
  //    实测 reload 会让 webview 被销毁，CDP target 消失。
  //    必须由工作台侧重建 webview 元素（场景切换会触发）。
  // ══════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════
  //  pinScript —— 生成注入到引擎页里的脚本，把面板钉到指定会话
  //
  //  ★ 2026-11-11 第三版
  //
  //  第一版（旧）：在 DOM 里找含 session-id 的元素去点。
  //    失败：引擎显示的是会话标题，永远不含 id；而且失败被吞掉。
  //
  //  第二版：dom-ready 写 localStorage 再 reload，用 window 变量防循环。
  //    失败：reload 会清掉 window 变量 → 无限重载 → 7 个场景全坏。
  //
  //  第三版（本版）：
  //    · 防循环标记放 localStorage（reload 后仍然保留）
  //    · 标记 key 带 sessionId，不同会话互不干扰
  //    · 返回 { stable } 或 { needReload } 让调用方决定要不要 reload
  // ══════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════
  //  HARNESS_ENSURE_USABLE_JS —— 确保引擎 UI 处于「可输入」状态
  //
  //  检测「选择一个工作区开始」形态，如果是就点一次「新会话」。
  //  返回 { state: 'usable' | 'need-new' | 'unknown' }
  // ══════════════════════════════════════════════════════════════
  const HARNESS_ENSURE_USABLE_JS = [
    '(function(){',
    '  function usable() {',
    '    var c = [...document.querySelectorAll("textarea, input, [contenteditable]")];',
    '    for (var i = 0; i < c.length; i++) {',
    '      var e = c[i];',
    '      var rc = e.getBoundingClientRect();',
    '      if (rc.width < 100 || rc.height < 10) continue;',
    '      if (e.tagName === "INPUT" && e.type === "file") continue;',
    '      if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") return true;',
    '      var ce = e.getAttribute("contenteditable");',
    '      if (ce === "true" || ce === "" || ce === "plaintext-only") return true;',
    '    }',
    '    return false;',
    '  }',
    '  if (usable()) return JSON.stringify({ state: "usable" });',
    '  var txt = (document.body && document.body.innerText) || "";',
    '  if (txt.indexOf("选择一个工作区") < 0 && txt.indexOf("选择工作区") < 0) {',
    '    return JSON.stringify({ state: "unknown" });',
    '  }',
    '  var btn = document.querySelector("[class*=newSession]") || document.querySelector("[aria-label=\\"新建会话\\"]");',
    '  if (!btn) return JSON.stringify({ state: "unknown", reason: "noNewBtn" });',
    '  try { btn.click(); } catch (e) { return JSON.stringify({ state: "unknown", reason: "clickFail" }); }',
    '  return JSON.stringify({ state: "need-new" });',
    '})()',
  ].join('\n');

  function pinScript(sessionId) {
    const sid = JSON.stringify(String(sessionId));
    return [
      '(function(sid){',
      '  var KEY = "dsh.sessions.current";',
      '  var MARK = "dsh.pin.tried." + sid;',
      '  try {',
      '    var cur = null;',
      '    try { cur = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { cur = null; }',
      '    if (cur && cur.sessionId === sid) {',
      '      try { localStorage.removeItem(MARK); } catch (e) {}',
      '      return JSON.stringify({ ok: true, stable: true });',
      '    }',
      '    var tried = false;',
      '    try { tried = localStorage.getItem(MARK) === "1"; } catch (e) {}',
      '    if (tried) {',
      '      return JSON.stringify({ ok: false, err: "reloaded-but-still-not-target" });',
      '    }',
      '    localStorage.setItem(MARK, "1");',
      '    localStorage.setItem(KEY, JSON.stringify({ sessionId: sid }));',
      '    return JSON.stringify({ ok: true, needReload: true });',
      '  } catch (e) {',
      '    return JSON.stringify({ ok: false, err: String((e && e.message) || e) });',
      '  }',
      '})(' + sid + ')',
    ].join('\n');
  }

  // ══════════════════════════════════════════════════════════════
  //  ★ 2026-11-12 新增：pinSessionToScene —— 把面板钉到场景自己的会话
  //
  //  修复的缺陷（实测确认）：
  //    在「调研」场景的 AI 面板里发消息，**消息进了「中枢」的会话**。
  //    webview 的 dsh.sessions.current 一直是 session-dde1feee（中枢），
  //    切到任何场景都不变。
  //
  //  三层根因：
  //    ① 所有场景 webview 都用 partition: 'persist:harness'
  //       → localStorage 共享 → dsh.sessions.current 串台
  //    ② 各场景配置里明明有正确的 sessionId / sessionTitle，
  //       但本文件里 pinTarget / sessionTitle 各出现 0 次 —— 代码根本不读
  //    ③ pinScript() 写好了但从未被调用（死代码）
  //
  //  之前 4 种失败的尝试（本文件旧注释记录过）：
  //    ① 按 session-id 文本找 DOM → 引擎显示标题不显示 id，找不到
  //    ② 写 localStorage + reload → current 变了但页面不进会话，还会弄坏状态
  //    ③ URL 参数 / hash → 引擎前端没有这个实现
  //    ④ 坐标点击侧栏 sessionRow → 侧栏在 x=-140（可视区外），点不到
  //
  //  ★ 突破（2026-11-12 实验验证）：
  //    坐标点击不行，但 **DOM 的 el.click() 有效**。
  //    实测：点「逆向分析项目模块实现并沉淀笔记」这一行
  //      → current 从 session-dde1feee 变成 session-db87c69e
  //      → document.title 也跟着变
  //    原理：el.click() 直接触发 React 的 onClick，
  //          不需要元素在可视区，也不需要真实鼠标坐标。
  // ══════════════════════════════════════════════════════════════

  /**
   * 生成「切到指定会话」的注入脚本
   * @param {string} sessionId 目标会话 id
   * @param {string} titleHint 会话标题（配置里的 sessionTitle）
   * @returns {string} 注入到 webview 的 JS
   */
  function pinSessionToScene(sessionId, titleHint) {
    const payload = JSON.stringify({
      sid: String(sessionId || ''),
      hint: String(titleHint || ''),
    });
    return '(function(p){' +
      '  var KEY = "dsh.sessions.current";' +
      '  function readCur(){ try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } }' +
      '  try {' +
      '    var cur = readCur();' +
      '    if (cur && cur.sessionId === p.sid) return JSON.stringify({ ok: true, already: true });' +
      // ★ 2026-11-12：优先用 data-row-key 精确匹配
      //   实测引擎的会话行带这个属性：
      //     data-row-key="session:session-db87c69e-37a1-466b-841e-3a65288f8af8"
      //   比按标题猜可靠得多（引擎显示的是 AI 生成的话题名，不是场景名）
      '    var exact = null;' +
      '    document.querySelectorAll("[class*=sessionRow]").forEach(function(el){' +
      '      var k = String(el.getAttribute("data-row-key") || "");' +
      '      if (k === ("session:" + p.sid)) exact = el;' +
      '    });' +
      '    if (exact) {' +
      '      try { exact.click(); } catch (e) { return JSON.stringify({ ok: false, err: "click-fail-exact: " + String((e && e.message) || e) }); }' +
      '      return JSON.stringify({ ok: true, via: "data-row-key" });' +
      '    }' +
      // 退路：按标题匹配（配置里的 sessionTitle）
      '    if (p.hint) {' +
      '      var rows = [];' +
      '      document.querySelectorAll("[class*=sessionRow]").forEach(function(el){ var t = String(el.textContent || "").trim(); if (t) rows.push({ el: el, text: t }); });' +
      '      var hit = null;' +
      '      for (var i = 0; i < rows.length; i++) { if (rows[i].text.indexOf(p.hint) >= 0) { hit = rows[i]; break; } }' +
      '      if (hit) {' +
      '        try { hit.el.click(); } catch (e) { return JSON.stringify({ ok: false, err: "click-fail-title" }); }' +
      '        return JSON.stringify({ ok: true, via: "title", clicked: hit.text.slice(0, 40) });' +
      '      }' +
      '    }' +
      // 都找不到 → 试展开「其余 N 个会话」
      '    var more = null;' +
      '    document.querySelectorAll("button, [class*=sessionOverflowButton]").forEach(function(b){ var t = String(b.textContent || ""); if (!more && /\u5c55\u5f00\u5176\u4f59|\u67e5\u770b\u66f4\u591a|\u66f4\u591a\u4f1a\u8bdd/.test(t)) more = b; });' +
      '    if (more && !p.tried) { try { more.click(); } catch (e) {} return JSON.stringify({ ok: false, err: "expanded-retry", needRetry: true }); }' +
      '    return JSON.stringify({ ok: false, err: "session-not-found", want: p.sid.slice(0, 22), rows: document.querySelectorAll("[class*=sessionRow]").length });' +
      '  } catch (e) { return JSON.stringify({ ok: false, err: String((e && e.message) || e) }); }' +
      '})(' + payload + ')';
  }

  /**
   * 尝试把面板钉到场景会话（带重试，因为要等 DOM 渲染）
   * @returns {Promise<{ok:boolean, detail:string}>}
   */
  async function ensureSceneSession(sessionId, titleHint) {
    if (!sessionId || !wv) return { ok: false, detail: 'no-sessionId-or-webview' };
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const src = pinSessionToScene(sessionId, titleHint);
        const raw = await wv.executeJavaScript(src);
        let r = null;
        try { r = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { r = null; }
        if (r && r.ok) {
          return { ok: true, detail: r.already ? 'already-correct' : ('clicked: ' + (r.clicked || '')) };
        }
        lastErr = (r && r.err) || 'unknown';
        if (r && r.needRetry) { await new Promise(function (res) { setTimeout(res, 800); }); continue; }
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
      await new Promise(function (res) { setTimeout(res, 800); });
    }
    return { ok: false, detail: lastErr };
  }


  function reload() {
    if (!wv) { body.innerHTML = ''; mount(); return; }
    setState('重新加载…', 'warn');
    try { wv.reload(); } catch (e) {
      // webview 不可 reload 时重建
      body.innerHTML = '';
      wv = null;
      mount();
    }
  }

  setTimeout(mount, 40);

  return {
    el: wrap,
    reload: reload,
    isReady: function () { return ready; },
    update: function () { if (wv) reload(); },
    destroy: function () {
      try { if (wv && wv.parentNode) wv.parentNode.removeChild(wv); } catch (e) { /* 忽略 */ }
      wv = null;
    },
  };
}

export default createHarness;
