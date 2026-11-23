// ui/panels/_generic.js —— 通用面板渲染器（一次生成多个面板类型）
//
// 目的：不追求每个面板都完美，先让 11 个场景都不白屏，再逐个精修。
// 原则：缺什么就显示明确的"待实现"，而不是空白或报错。

function makeShell(host, panel, ctx, opts) {
  const o = opts || {};
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--s2,var(--color-panel, var(--color-panel, var(--color-panel, #121518))));';

  const head = document.createElement('div');
  head.style.cssText = 'flex:0 0 24px;display:flex;align-items:center;gap:6px;padding:0 8px;background:var(--s3,var(--color-raised, var(--color-raised, #181C20)));border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));font:11px "JetBrains Mono",monospace;color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)));white-space:nowrap;overflow:hidden;';
  head.innerHTML =
    '<span style="font-weight:600;color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)))">' + esc(panel.title || o.label || panel.type) + '</span>' +
    '<span style="flex:1 1 auto"></span>';
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1 1 auto;min-height:0;overflow:auto;position:relative;';
  wrap.appendChild(body);

  host.appendChild(wrap);

  return { wrap, head, body };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
  });
}

function emptyState(body, icon, title, hint) {
  body.innerHTML =
    '<div class="wb-empty">' +
    '<div class="wb-empty-icon">' + esc(icon || '◌') + '</div>' +
    '<div class="wb-empty-title">' + esc(title || '待实现') + '</div>' +
    (hint ? '<div class="wb-empty-hint">' + esc(hint) + '</div>' : '') +
    '</div>';
}

// ══════════════════════════════════════════════════════════════════════════
//  embed —— 内嵌网页
// ══════════════════════════════════════════════════════════════════════════
export function createEmbed(host, panel, ctx) {
  const { body } = makeShell(host, panel, ctx, { label: '嵌入页' });
  const url = String(panel.url || panel.src || '');
  if (!url) {
    emptyState(body, '▣', '未配置 URL', '场景 json 里给 panel.url 即可内嵌');
    return { el: host.lastChild };
  }

  const wv = document.createElement('webview');
  wv.setAttribute('src', url);
  wv.setAttribute('partition', 'persist:embed-' + String(panel.id || 'x').replace(/[^a-zA-Z0-9_-]/g, ''));
  wv.style.cssText = 'width:100%;height:100%;border:0;';

  // ⚠ 2026-11-11 加失败提示（事故 AC-021）：
  //   调研场景的「网页」面板指向 https://www.google.com（国内访问不了），
  //   加载失败后 <webview> 就是一片纯黑 —— 没有任何提示。
  //   用户会以为「面板坏了」，实际是「网站访问不了」。
  try {
    wv.addEventListener('did-fail-load', function (ev) {
      // -3 = ERR_ABORTED，通常是正常中断（比如重定向），忽略
      if (ev && Number(ev.errorCode) === -3) return;
      const desc = (ev && ev.errorDescription) || '未知原因';
      const code = (ev && ev.errorCode) || '?';
      const bar = document.createElement('div');
      bar.style.cssText =
        'position:absolute;left:8px;right:8px;top:8px;padding:8px 10px;border-radius:5px;' +
        'background:rgba(40,28,26,.96);border:1px solid rgba(208,90,74,.5);' +
        'color:var(--color-err-soft-text, #D9A49B);font:10px/1.6 ui-monospace,monospace;white-space:normal;z-index:5;';
      bar.innerHTML =
        '<div style="color:var(--color-err-strong, #E0796B);font-weight:600;margin-bottom:3px">网页加载失败</div>' +
        '<div>' + esc(desc) + '（错误码 ' + esc(String(code)) + '）</div>' +
        '<div style="margin-top:3px;color:var(--color-err-soft-meta, #8A7F7C)">地址：' + esc(url) + '</div>' +
        '<div style="margin-top:3px;color:var(--color-err-soft-dim, #6E6462)">' +
        '可能是这个站点在当前网络访问不了。可在场景 json 里换一个能打开的地址。</div>';
      try {
        const cs = getComputedStyle(body);
        if (cs.position === 'static') body.style.position = 'relative';
        body.appendChild(bar);
      } catch (e2) { /* ignore */ }
    });
  } catch (e3) { /* ignore：旧版不支持该事件 */ }

  body.appendChild(wv);

  return {
    el: host.lastChild,
    update: function () { try { wv.reload(); } catch (e) { /* 忽略 */ } },
    destroy: function () { try { wv.remove(); } catch (e) { /* 忽略 */ } },
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  sf-board —— 管线位置（上游 → 自己 → 下游）
//
//  ⚠ 2026-11-11 重写（事故 AC-018）：
//    原来是「晶体管待接入」占位，或者只显示「管线 2 条 / 状态 ok」这种没有信息量的数字。
//    4 个场景（架构梳理/实施计划/竞品拆解/逆向分析）都有这个面板。
//
//  数据来源（按优先级）：
//    ① api.sfPipelines()     → workbench/sceneboard/pipelines/*.json
//    ② api.sfPipeStatus(id)  → 会算出每个节点的输入是否满足（有就用，没有自己算）
//    ③ api.sfBoard()         → workbench/产物/index.json 的 artifacts
//
//  ⚠ api 包装层返回 { ok, value, error, ms }，数据在 .value 里！见 AC-022。
// ══════════════════════════════════════════════════════════════════════════

/** 从包装层解包（api/index.js 的 wrap 会包一层 {ok,value,...}） */
function sfUnwrap(wrapped) {
  if (wrapped && typeof wrapped === 'object' && 'value' in wrapped) {
    return wrapped.value;
  }
  return wrapped;
}

export function createSfBoard(host, panel, ctx) {
  const api = ctx && ctx.api;
  const { body } = makeShell(host, panel, ctx, { label: '管线位置' });

  // 当前场景 id（panel.sceneId 由渲染层注入，没有就用 ctx.sceneId）
  const selfScene = String(
    (panel && (panel.sceneId || panel.scene)) || (ctx && ctx.sceneId) || ''
  );

  const C = {
    wait: 'var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))',      // 等待：灰
    run: 'var(--color-ok, var(--color-ok, #5A9ED0))',                 // 进行中：蓝
    done: 'var(--ok,var(--color-ok, #4A9E6A))',      // 已完成：绿
    block: 'var(--err,var(--color-err, var(--color-err, #D05A4A)))',    // 阻塞：红
    line: 'var(--line,var(--color-line, var(--color-line, #22272D)))',
    bg: 'var(--s3,var(--color-raised, var(--color-raised, #181C20)))',
  };

  /** 状态 → 颜色 + 中文 */
  function stateOf(node) {
    if (!node) return { key: 'wait', text: '未知', color: C.wait };
    if (node.blocked) return { key: 'block', text: '阻塞', color: C.block };
    if (node.done) return { key: 'done', text: '已完成', color: C.done };
    if (node.ready) return { key: 'run', text: '可执行', color: C.run };
    return { key: 'wait', text: '等待', color: C.wait };
  }

  /** 场景 id → 中文名（用 api.getScenario 或退化到 id） */
  const nameCache = Object.create(null);
  async function sceneName(id) {
    if (nameCache[id]) return nameCache[id];
    let name = id;
    try {
      if (api && api.getScenario) {
        const r = sfUnwrap(await api.getScenario(id));
        if (r && (r.name || r.title)) name = r.name || r.title;
      }
    } catch (e) { /* 忽略，用 id */ }
    nameCache[id] = name;
    return name;
  }

  async function load() {
    body.innerHTML =
      '<div style="padding:10px;font:11px monospace;color:' + C.wait + '">加载管线…</div>';

    // ── ① 取管线列表 ──
    let pipelines = [];
    try {
      if (api && api.sfPipelines) {
        const raw = sfUnwrap(await api.sfPipelines());
        pipelines = Array.isArray(raw) ? raw : (raw && (raw.items || raw.pipelines)) || [];
      }
    } catch (e) { /* 忽略 */ }

    if (!pipelines.length) {
      body.innerHTML =
        '<div style="padding:12px;font:11px/1.8 monospace;color:' + C.wait + '">' +
        '没有读到任何管线<br>' +
        '<span style="font-size:10px">预期位置：workbench/sceneboard/pipelines/*.json</span></div>';
      return;
    }

    // ── ② 找包含当前场景的管线 ──
    let pipe = null;
    if (selfScene) {
      pipe = pipelines.find(function (p) {
        return (p.nodes || []).some(function (n) { return String(n.scene) === selfScene; });
      }) || null;
    }
    // 找不到就退回第一条（并标注）
    const fallback = !pipe;
    if (!pipe) pipe = pipelines[0];

    const nodes = pipe.nodes || [];
    const edges = pipe.edges || [];

    // ── ③ 尝试拿 pipe-status（已算好 ready/done）──
    let statusMap = null;
    try {
      if (api && api.sfPipeStatus && pipe.id) {
        const st = sfUnwrap(await api.sfPipeStatus(pipe.id));
        if (st && st.nodes) statusMap = st.nodes;
      }
    } catch (e) { /* 忽略，自己算 */ }

    // ── ④ 自己算状态（没有 pipe-status 时）──
    // 已完成 = 该场景产出的 artifact 存在且 status=ready
    let artifacts = [];
    try {
      if (api && api.sfBoard) {
        const b = sfUnwrap(await api.sfBoard());
        artifacts = (b && b.artifacts) || [];
      }
    } catch (e) { /* 忽略 */ }

    function hasArtifact(fromScene, logicalId) {
      return artifacts.some(function (a) {
        return String(a.fromScene) === String(fromScene) &&
          String(a.logicalId) === String(logicalId) &&
          a.status === 'ready';
      });
    }

    function computeNode(sceneId) {
      if (statusMap && statusMap[sceneId]) {
        const n = statusMap[sceneId];
        return {
          ready: !!n.ready,
          done: !!n.done,
          blocked: (n.inputs || []).some(function (i) { return !i.satisfied; }) && !n.ready,
          inputs: n.inputs || [],
        };
      }
      // 自算：这个节点的所有输入 artifact 都齐了吗
      const incoming = edges.filter(function (e) { return String(e.to) === String(sceneId); });
      const inputs = incoming.map(function (e) {
        return {
          from: e.from,
          artifact: e.artifact,
          satisfied: hasArtifact(e.from, e.artifact),
        };
      });
      const allIn = inputs.every(function (i) { return i.satisfied; });
      // 自己产出的 artifact 都有了 ⇒ done
      const outgoing = edges.filter(function (e) { return String(e.from) === String(sceneId); });
      const done = outgoing.length > 0 && outgoing.every(function (e) {
        return hasArtifact(e.from, e.artifact);
      });
      return { ready: allIn, done: done, blocked: !allIn, inputs: inputs };
    }

    // ── ⑤ 组装上游 / 自己 / 下游 ──
    const upIds = [...new Set(edges.filter(function (e) { return String(e.to) === selfScene; })
      .map(function (e) { return String(e.from); }))];
    const downIds = [...new Set(edges.filter(function (e) { return String(e.from) === selfScene; })
      .map(function (e) { return String(e.to); }))];

    // ── ⑥ 渲染 ──
    const upInfo = [];
    for (const id of upIds) {
      upInfo.push({ id: id, name: await sceneName(id), st: stateOf(computeNode(id)),
        arts: edges.filter(function (e) { return String(e.from) === id && String(e.to) === selfScene; })
          .map(function (e) { return e.artifact; }) });
    }
    const downInfo = [];
    for (const id of downIds) {
      downInfo.push({ id: id, name: await sceneName(id), st: stateOf(computeNode(id)),
        arts: edges.filter(function (e) { return String(e.from) === selfScene && String(e.to) === id; })
          .map(function (e) { return e.artifact; }) });
    }
    const selfInfo = { id: selfScene, name: await sceneName(selfScene), st: stateOf(computeNode(selfScene)) };

    function nodeCard(info, align) {
      const s = info.st;
      return '<div class="sf-node" data-scene="' + esc(info.id) + '" ' +
        'style="padding:6px 9px;border-radius:4px;background:' + C.bg + ';' +
        'border:1px solid ' + C.line + ';border-left:2px solid ' + s.color + ';' +
        'cursor:pointer;min-width:0;' + (align === 'right' ? 'text-align:right;' : '') + '">' +
        '<div style="font:600 11px monospace;color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)));overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap">' + esc(info.name) + '</div>' +
        '<div style="font:9.5px monospace;color:' + s.color + ';margin-top:2px">' +
        '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;' +
        'background:' + s.color + ';margin-right:4px;vertical-align:middle"></span>' +
        esc(s.text) + '</div></div>';
    }

    const arrow = function (dir, n) {
      const ch = dir === 'right' ? '▶' : '◀';
      const txt = n > 1 ? (dir === 'right' ? ch + ch : ch + ch) : ch;
      return '<div style="flex:0 0 auto;color:' + C.wait + ';font-size:9px;opacity:.6">' + txt + '</div>';
    };

    let html = '<div style="padding:8px;display:flex;flex-direction:column;height:100%;min-height:0">';

    // 管线名 + 回退提示
    html += '<div style="flex:0 0 auto;font:10px monospace;color:' + C.wait + ';margin-bottom:6px;' +
      'display:flex;gap:8px;align-items:baseline;overflow:hidden">' +
      '<span style="color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)));font-weight:600">' + esc(pipe.name || pipe.id || '管线') + '</span>' +
      (fallback ? '<span style="color:var(--color-warn, var(--color-warn, #D0A34A))">⚠ 当前场景不在任何管线里，显示第一条</span>' : '') +
      '<span style="flex:1"></span>' +
      '<span>' + nodes.length + ' 节点 / ' + edges.length + ' 条依赖</span></div>';

    // 三段布局
    html += '<div style="flex:1;display:grid;grid-template-columns:1fr auto 1.1fr auto 1fr;' +
      'gap:6px;align-items:center;min-height:0">';

    // 上游
    html += '<div style="display:flex;flex-direction:column;gap:5px;min-width:0">';
    if (upInfo.length === 0) {
      html += '<div style="font:9.5px monospace;color:' + C.wait + ';text-align:right;opacity:.6">（无上游）</div>';
    } else {
      html += '<div style="font:9px monospace;color:' + C.wait + ';text-align:right;' +
        'margin-bottom:1px;opacity:.7">上游 ' + upInfo.length + '</div>';
      for (const u of upInfo) html += nodeCard(u, 'right');
    }
    html += '</div>';

    html += arrow('right', upInfo.length || 1);

    // 自己
    html += '<div style="display:flex;flex-direction:column;gap:5px;min-width:0">' +
      '<div style="font:9px monospace;color:' + C.wait + ';opacity:.7">当前</div>';
    html += '<div style="padding:8px 10px;border-radius:4px;background:rgba(90,158,208,.10);' +
      'border:1px solid rgba(90,158,208,.45)">' +
      '<div style="font:600 12px monospace;color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)));overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap">' + esc(selfInfo.name) + '</div>' +
      '<div style="font:9.5px monospace;color:' + selfInfo.st.color + ';margin-top:3px">' +
      '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;' +
      'background:' + selfInfo.st.color + ';margin-right:4px;vertical-align:middle"></span>' +
      esc(selfInfo.st.text) + '</div></div>';

    // 自己的输入明细
    const selfNode = computeNode(selfScene);
    if (selfNode.inputs && selfNode.inputs.length) {
      html += '<div style="font:9px/1.7 monospace;color:' + C.wait + ';margin-top:2px;' +
        'overflow:hidden">';
      const need = selfNode.inputs.filter(function (i) { return !i.satisfied; });
      html += need.length
        ? '<span style="color:var(--color-warn, var(--color-warn, #D0A34A))">还缺 ' + need.length + ' 份输入</span>'
        : '<span style="color:' + C.done + '">输入已齐</span>';
      html += '</div>';
    }
    html += '</div>';

    html += arrow('right', downInfo.length || 1);

    // 下游
    html += '<div style="display:flex;flex-direction:column;gap:5px;min-width:0">';
    if (downInfo.length === 0) {
      html += '<div style="font:9.5px monospace;color:' + C.wait + ';opacity:.6">（无下游）</div>';
    } else {
      html += '<div style="font:9px monospace;color:' + C.wait + ';margin-bottom:1px;opacity:.7">下游 ' +
        downInfo.length + '</div>';
      for (const d of downInfo) html += nodeCard(d, 'left');
    }
    html += '</div>';

    html += '</div>';   // grid

    // 底部：点击后显示「它给了我什么 / 我要给它什么」
    html += '<div id="sf-detail" style="flex:0 0 auto;min-height:0;max-height:90px;overflow:auto;' +
      'margin-top:6px;padding:6px 8px;border-radius:4px;background:rgba(255,255,255,.02);' +
      'border:1px solid ' + C.line + ';font:9.5px/1.7 monospace;color:' + C.wait + '">' +
      '点上游/下游节点，看它和当前场景之间传什么</div>';

    html += '</div>';
    body.innerHTML = html;
    body.style.cssText = 'height:100%;overflow:hidden;';

    // ── ⑦ 点击交互 ──
    const detail = body.querySelector('#sf-detail');
    const artsOf = function (from, to) {
      return edges.filter(function (e) {
        return String(e.from) === from && String(e.to) === to;
      }).map(function (e) { return e.artifact; });
    };

    body.querySelectorAll('.sf-node').forEach(function (el) {
      el.addEventListener('click', function () {
        const sid = el.getAttribute('data-scene');
        body.querySelectorAll('.sf-node').forEach(function (x) {
          x.style.boxShadow = '';
          x.style.borderColor = C.line;
        });
        el.style.boxShadow = '0 0 0 1px rgba(90,158,208,.6)';

        const isUp = upIds.indexOf(sid) >= 0;
        const give = isUp ? artsOf(sid, selfScene) : artsOf(selfScene, sid);
        const get = isUp ? [] : artsOf(sid, selfScene);   // 下游反过来也给不了
        let d = '<span style="color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)))">' +
          esc(nameCache[sid] || sid) + '</span> · ';

        if (isUp) {
          d += '它给当前场景：';
          d += give.length
            ? give.map(function (a) {
                const ok = hasArtifact(sid, a);
                return '<span style="color:' + (ok ? C.done : 'var(--color-warn, var(--color-warn, #D0A34A))') + '">' +
                  esc(a) + (ok ? ' ✓' : ' 缺') + '</span>';
              }).join('、')
            : '<span style="opacity:.6">（没有声明产物）</span>';
        } else {
          const need = get;
          d += '当前场景给它：';
          d += need.length
            ? need.map(function (a) {
                const ok = hasArtifact(selfScene, a);
                return '<span style="color:' + (ok ? C.done : 'var(--color-warn, var(--color-warn, #D0A34A))') + '">' +
                  esc(a) + (ok ? ' ✓' : ' 缺') + '</span>';
              }).join('、')
            : '<span style="opacity:.6">（没有声明产物）</span>';
        }
        if (detail) detail.innerHTML = d;
      });
    });
  }

  setTimeout(load, 80);
  return { el: host.lastChild, update: load, destroy: function () {} };
}

// ══════════════════════════════════════════════════════════════════════════
//  review-doc / review-files —— 审查（2026-11-11 重写）
//
//  ⚠ 事故 AC-020：
//    原来这两个面板只调 api.reviewDir() 拿**全局固定目录**（workbench/自我复盘），
//    然后显示一行「目录: xxx」就完了 —— 没有任何浏览功能。
//
//    后果：5 个场景的文档面板都显示「自我复盘」的路径，
//    只有「自我复盘」那个场景恰好是对的。
//
//  修法两条：
//    ① 场景级目录：panel.docDir 优先，没有才回退全局 reviewDir
//    ② 真的能浏览：左列表 + 右 Markdown 正文
//
//  ⚠ api 包装层返回 { ok, value }，数据在 .value 里！
// ══════════════════════════════════════════════════════════════════════════

/** 解包 api 返回值 */
function rvUnwrap(wrapped) {
  if (wrapped && typeof wrapped === 'object' && 'value' in wrapped) return wrapped.value;
  return wrapped;
}

/** 判断是否文本类文件 */
function rvIsText(name) {
  return /\.(md|markdown|txt|json|ya?ml|csv|log|ini|conf|mjs|js|ts|css|html)$/i.test(String(name));
}

/** 极简 Markdown 渲染（不引第三方库） */
function rvMd(src) {
  const lines = String(src || '').split(/\r?\n/);
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let inTable = false;

  const inline = function (t) {
    let s = esc(t);
    // 行内代码
    s = s.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,.08);padding:1px 4px;border-radius:3px;font-size:.92em">$1</code>');
    // 粗体
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)))">$1</strong>');
    // 斜体
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    // 链接
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--color-ok, var(--color-ok, #5A9ED0));text-decoration:none">$1</a>');
    // 删除线
    s = s.replace(/~~([^~]+)~~/g, '<del style="opacity:.6">$1</del>');
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    // 代码块
    if (/^```/.test(t)) {
      if (inCode) {
        out.push('<pre style="margin:6px 0;padding:7px 9px;border-radius:4px;' +
          'background:rgba(0,0,0,.32);border:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));overflow-x:auto;' +
          'font:10px/1.6 ui-monospace,monospace;color:var(--color-txt-2, var(--color-txt-2, #B8C4D0))">' +
          esc(codeBuf.join('\n')) + '</pre>');
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    // 空行
    if (!t) {
      if (inTable) { out.push('</tbody></table>'); inTable = false; }
      continue;
    }

    // 表格
    if (/^\|/.test(t)) {
      const cells = t.replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
      // 分隔行 |---|---|
      if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) continue;
      if (!inTable) {
        out.push('<table style="width:100%;border-collapse:collapse;margin:6px 0;' +
          'font:10px monospace"><tbody>');
        inTable = true;
        out.push('<tr>' + cells.map(function (c) {
          return '<th style="text-align:left;padding:3px 7px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));' +
            'border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)))">' + inline(c) + '</th>';
        }).join('') + '</tr>');
      } else {
        out.push('<tr>' + cells.map(function (c) {
          return '<td style="padding:3px 7px;border-bottom:1px solid rgba(255,255,255,.04)">' +
            inline(c) + '</td>';
        }).join('') + '</tr>');
      }
      continue;
    }
    if (inTable) { out.push('</tbody></table>'); inTable = false; }

    // 标题
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      const size = [15, 13.5, 12.5, 11.5, 11, 11][lv - 1];
      out.push('<div style="font:600 ' + size + 'px/1.5 system-ui,sans-serif;' +
        'color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)));margin:' + (lv <= 2 ? '10px' : '7px') + ' 0 4px' +
        (lv <= 2 ? ';padding-bottom:3px;border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)))' : '') + '">' +
        inline(h[2]) + '</div>');
      continue;
    }

    // 引用
    if (/^>\s?/.test(t)) {
      out.push('<div style="margin:5px 0;padding:4px 9px;border-left:2px solid var(--color-ok, var(--color-ok, #5A9ED0));' +
        'background:rgba(90,158,208,.07);color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)))">' +
        inline(t.replace(/^>\s?/, '')) + '</div>');
      continue;
    }

    // 列表
    const li = t.match(/^([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d+\./.test(li[1]);
      out.push('<div style="display:flex;gap:6px;margin:2px 0;padding-left:' +
        (ordered ? '4' : '8') + 'px">' +
        '<span style="color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));flex:0 0 auto">' +
        (ordered ? li[1] : '·') + '</span>' +
        '<span style="flex:1;min-width:0">' + inline(li[2]) + '</span></div>');
      continue;
    }

    // 水平线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      out.push('<div style="height:1px;background:var(--line,var(--color-line, var(--color-line, #22272D)));margin:8px 0"></div>');
      continue;
    }

    // 普通段落
    out.push('<div style="margin:3px 0">' + inline(t) + '</div>');
  }

  if (inCode && codeBuf.length) {
    out.push('<pre style="margin:6px 0;padding:7px 9px;border-radius:4px;' +
      'background:rgba(0,0,0,.32);border:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));overflow-x:auto;' +
      'font:10px/1.6 ui-monospace,monospace;color:var(--color-txt-2, var(--color-txt-2, #B8C4D0))">' + esc(codeBuf.join('\n')) + '</pre>');
  }
  if (inTable) out.push('</tbody></table>');

  return out.join('\n');
}

/**
 * 解析面板的文档目录（场景级优先）
 * @returns {Promise<{dir:string, isSceneLevel:boolean}>}
 */
async function rvResolveDir(api, panel) {
  // ══════════════════════════════════════════════════════════════
  //  ⚠ 2026-11-11 教训：不能用 api.paths.dataDir 当基准！
  //
  //  preload 里：
  //    dataDir: process.env.DSH_SHELL_DIR + '\\data'
  //  DSH_SHELL_DIR = __dirname = workbench/外壳
  //  ⇒ dataDir = workbench/外壳\data   ← 英文且多了一层
  //
  //  但项目实际数据目录是 workbench/数据（中文）！
  //  用它当基准拼出来的是 workbench/外壳/数据/.dsh/... ← 错的
  //
  //  正确做法：用 reviewDirRaw（= workbench/自我复盘）反推 workbench 根，
  //  去掉最后一段就是 workbench。这个是准的。
  // ══════════════════════════════════════════════════════════════
  const workbenchRoot = (function () {
    const base = String((api && api.reviewDirRaw) || (api && api.paths && api.paths.reviewDir) || '');
    if (!base) return '';
    // 去掉最后一段（自我复盘）→ workbench
    const root = base.replace(/[\\/][^\\/]+[\\/]?$/, '');
    return root.replace(/\\/g, '/');
  })();

  // ① 场景 json 里声明的 docDir
  const declared = panel && (panel.docDir || panel.dir);
  if (declared) {
    let d = String(declared).replace(/\\/g, '/');
    const isAbs = /^[A-Za-z]:\//.test(d) || d.startsWith('/');
    if (!isAbs && workbenchRoot) {
      d = workbenchRoot.replace(/\/$/, '') + '/' + d.replace(/^\.?\//, '');
    }
    return { dir: d, isSceneLevel: true };
  }

  // ② 回退全局 reviewDir
  let dir = (api && api.reviewDirRaw) || (api && api.paths && api.paths.reviewDir) || '';
  try {
    if (api && api.review && api.review.root) {
      const r = rvUnwrap(await api.review.root());
      if (r && r.root) dir = r.root;
    }
  } catch (e) { /* 忽略 */ }
  return { dir: String(dir || '').replace(/\\/g, '/'), isSceneLevel: false };
}

/**
 * 列目录（优先走 review.files；场景级目录用它自己的 root）
 */
async function rvList(api, dir) {
  // review:files 只认 REVIEW_DIR，所以场景级目录要用 file API 逐个探
  // 先试 review.files 的 root 参数（如果 main.js 已支持）
  try {
    if (api && api.review && api.review.files) {
      const r = rvUnwrap(await api.review.files('', dir));
      if (r && r.ok && Array.isArray(r.rows)) {
        return { ok: true, rows: r.rows, root: r.root || dir };
      }
      // 越界或失败 → 落到下面
    }
  } catch (e) { /* 忽略 */ }

  return { ok: false, rows: [], root: dir, err: '无法列目录（review API 不支持自定义根）' };
}

// ══════════════════════════════════════════════════════════════════════════
//  review-doc —— 左列表 + 右 Markdown 正文
// ══════════════════════════════════════════════════════════════════════════
export function createReviewDoc(host, panel, ctx) {
  const api = ctx && ctx.api;
  const { body } = makeShell(host, panel, ctx, { label: '审查文档' });

  // ⚠ 用 += 而不是 =：makeShell 给 body 设了 flex:1 1 auto，
  //   直接覆盖会让它不再是 flex 子项 → 高度塌陷 → 点击区域错位。
  body.style.cssText += 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

  // 顶栏
  const bar = document.createElement('div');
  bar.style.cssText =
    'flex:0 0 24px;display:flex;align-items:center;gap:6px;padding:0 8px;' +
    'background:var(--s3,var(--color-raised, var(--color-raised, #181C20)));border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));' +
    'font:9.5px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));overflow:hidden';
  const pathEl = document.createElement('span');
  pathEl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  pathEl.textContent = '加载中…';
  const refresh = document.createElement('button');
  refresh.textContent = '⟳';
  refresh.title = '刷新';
  refresh.style.cssText =
    'flex:0 0 auto;padding:1px 6px;border-radius:3px;border:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));' +
    'background:var(--s2,var(--color-panel, var(--color-panel, var(--color-panel, #121518))));color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)));font:10px monospace;cursor:pointer';
  bar.appendChild(pathEl);
  bar.appendChild(refresh);
  body.appendChild(bar);

  // 主体：左列表 + 右正文
  // ⚠ 列表宽度按容器自适应（面板可能只有 380px，150px 太挤）：
  //    窄面板 → 118px，宽面板 → 最多 190px
  const main = document.createElement('div');
  main.style.cssText = 'flex:1;display:grid;grid-template-columns:118px minmax(0,1fr);' +
    'overflow:hidden;min-height:0';
  main.setAttribute('data-rv-main', '1');
  const left = document.createElement('div');
  left.style.cssText = 'overflow:auto;min-height:0;border-right:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));' +
    'background:rgba(0,0,0,.12)';
  const right = document.createElement('div');
  right.style.cssText = 'overflow:auto;min-height:0;padding:8px 10px;' +
    'font:11px/1.75 system-ui,-apple-system,sans-serif;color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)))';
  main.appendChild(left);
  main.appendChild(right);
  body.appendChild(main);

  let curDir = '';
  let curRel = '';

  async function loadDir(rel) {
    left.innerHTML = '<div style="padding:8px;font:9.5px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">读取…</div>';

    const resolved = await rvResolveDir(api, panel);
    curDir = resolved.dir;

    if (!curDir) {
      pathEl.textContent = '未配置目录';
      left.innerHTML = '';
      right.innerHTML = '<div style="padding:12px;font:10.5px/1.8 monospace;color:var(--color-warn, var(--color-warn, #D0A34A))">' +
        '这个面板没有配置文档目录。<br><br>' +
        '<span style="color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">在场景 json 里给面板加 docDir 字段：<br>' +
        '{ "type": "review-doc", "docDir": "数据/.dsh/场景记忆/&lt;场景名&gt;/文档" }</span></div>';
      return;
    }

    pathEl.textContent = (resolved.isSceneLevel ? '' : '全局 · ') + curDir;

    const r = await rvList(api, curDir);
    if (!r.ok) {
      left.innerHTML = '';
      right.innerHTML = '<div style="padding:12px;font:10.5px/1.8 monospace;color:var(--color-err, var(--color-err, #D05A4A))">' +
        '✗ 列目录失败：' + esc(r.err || '未知原因') + '<br><br>' +
        '<span style="color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">目录：' + esc(curDir) + '</span></div>';
      return;
    }

    const rows = (r.rows || []).filter(function (x) {
      return x && !String(x.name || '').startsWith('.');
    });

    if (!rows.length) {
      left.innerHTML = '<div style="padding:8px;font:9.5px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">（空目录）</div>';
      right.innerHTML = '<div style="padding:16px 8px;text-align:center;font:10.5px/1.9 monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' +
        '这个目录里还没有文档<br><br>' +
        '<span style="font-size:10px">目录：' + esc(curDir) + '</span></div>';
      return;
    }

    // 面包屑（支持返回上层）
    let html = '';
    if (rel) {
      html += '<div class="rv-up" style="padding:4px 7px;cursor:pointer;font:9.5px monospace;' +
        'color:var(--color-ok, var(--color-ok, #5A9ED0));border-bottom:1px solid rgba(255,255,255,.04)">↑ 返回上层</div>';
    }
    for (const x of rows) {
      const isDir = !!x.isDir;
      const isText = isDir || rvIsText(x.name) || x.text === true;
      const size = isDir ? '目录' : pcHuman(x.size || 0);
      html += '<div class="rv-item" data-name="' + esc(x.name) + '" data-dir="' + (isDir ? '1' : '0') + '" ' +
        'style="padding:4px 7px;cursor:pointer;font:9.5px/1.5 monospace;' +
        'border-bottom:1px solid rgba(255,255,255,.03);' +
        (isText ? '' : 'opacity:.45;') + '">' +
        '<div style="color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)));overflow:hidden;text-overflow:ellipsis;' +
        'white-space:nowrap" title="' + esc(x.name) + '">' +
        (isDir ? '▸ ' : '') + esc(x.name) + '</div>' +
        '<div style="color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font-size:8.5px;margin-top:1px">' + size + '</div></div>';
    }
    left.innerHTML = html;

    // 点击条目
    // ⚠ 2026-11-11：改用**事件委托**（挂在 left 上），
    //   原来逐个 addEventListener 在热重载/重复渲染时容易丢。
    //   委托只挂一次，永远不会失效。
    if (!left._rvBound) {
      left._rvBound = true;
      left.addEventListener('click', async function (ev) {
        const el0 = (ev.target && ev.target.nodeType === 3) ? ev.target.parentElement : ev.target;
        const target = el0 && el0.closest ? el0.closest('.rv-item') : null;
        // 返回上层
        const upEl = el0 && el0.closest ? el0.closest('.rv-up') : null;
        if (upEl) {
          const segs = curRel.split('/').filter(Boolean);
          segs.pop();
          await loadDir(segs.join('/'));
          return;
        }
        if (!target) return;

        const name = target.getAttribute('data-name');
        const isDir = target.getAttribute('data-dir') === '1';
        left.querySelectorAll('.rv-item').forEach(function (x) { x.style.background = ''; });
        target.style.background = 'rgba(90,158,208,.14)';

        if (isDir) {
          curRel = (curRel ? curRel + '/' : '') + name;
          await loadDir(curRel);
          return;
        }

        // ── 读文件 ──
        const fullRel = (curRel ? curRel + '/' : '') + name;
        const abs = curDir.replace(/\/$/, '') + '/' + fullRel;

        right.innerHTML = '<div style="padding:8px;font:10px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' +
          '读取 ' + esc(name) + '…</div>';

        let content = null;
        let meta = '';
        let errMsg = '';
        // 路径 ①：review.read(rel, root)
        try {
          if (api && api.review && api.review.read) {
            const raw = await api.review.read(fullRel, curDir);
            const rr = rvUnwrap(raw);
            if (rr && rr.ok) {
              content = (typeof rr.content === 'string') ? rr.content : '';
              meta = pcHuman(rr.size || content.length) + (rr.cut ? ' · 已截断' : '');
            } else {
              errMsg = (rr && (rr.err || rr.error)) || 'review.read 返回失败';
            }
          } else {
          }
        } catch (e) {
          errMsg = 'review.read 异常：' + String((e && e.message) || e);
        }

        // 路径 ②：兜底用 file.read 读绝对路径
        if (content === null) {
          try {
            if (api && api.file && api.file.read) {
              const fr = rvUnwrap(await api.file.read(abs));
              if (fr && fr.ok !== false && typeof fr.text === 'string') {
                content = fr.text;
                meta = pcHuman(fr.size || content.length);
                errMsg = '';
              } else if (!errMsg) {
                errMsg = (fr && (fr.err || fr.error)) || 'file.read 返回失败';
              }
            }
          } catch (e2) {
            if (!errMsg) errMsg = 'file.read 异常：' + String((e2 && e2.message) || e2);
          }
        }

        // ── 两条路都失败：显示可读错误（带上路径，方便排查）──
        if (content === null) {
          right.innerHTML =
            '<div style="padding:10px;font:10px/1.8 monospace;color:var(--color-err, var(--color-err, #D05A4A))">' +
            '<div style="font-weight:600;margin-bottom:4px">✗ 读不了这个文件</div>' +
            '<div>' + esc(errMsg || '未知原因') + '</div>' +
            '<div style="margin-top:6px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font-size:9.5px;word-break:break-all">' +
            '绝对路径：' + esc(abs) + '</div></div>';
          return;
        }

        // ── 渲染 ──
        const MAX = 256 * 1024;
        if (content.length > MAX) {
          content = content.slice(0, MAX);
          meta += ' · 只显示前 256KB';
        }

        const isMd = /\.(md|markdown)$/i.test(name);
        const bodyHtml = isMd
          ? rvMd(content)
          : '<pre style="margin:0;font:10px/1.65 ui-monospace,monospace;color:var(--color-txt-2, var(--color-txt-2, #B8C4D0));' +
            'white-space:pre-wrap;word-break:break-word">' + esc(content) + '</pre>';

        right.innerHTML =
          '<div style="display:flex;gap:6px;align-items:baseline;margin-bottom:6px;' +
          'padding-bottom:5px;border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)))">' +
          '<span style="font:600 10px monospace;color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)));overflow:hidden;' +
          'text-overflow:ellipsis;white-space:nowrap;flex:1">' + esc(name) + '</span>' +
          '<span style="font:9px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));flex:0 0 auto">' + esc(meta) + '</span>' +
          '</div>' + '<div>' + bodyHtml + '</div>';
        right.scrollTop = 0;
      });
    }
  }

  curRel = '';
  setTimeout(function () { loadDir(''); }, 80);
  refresh.addEventListener('click', function () { curRel = ''; loadDir(''); });

  return { el: host.lastChild, update: function () { loadDir(curRel); }, destroy: function () {} };
}

// ══════════════════════════════════════════════════════════════════════════
//  review-files —— 文件清单表格
// ══════════════════════════════════════════════════════════════════════════
export function createReviewFiles(host, panel, ctx) {
  const api = ctx && ctx.api;
  const { body } = makeShell(host, panel, ctx, { label: '审查文件' });

  // ⚠ 用 += 而不是 =：makeShell 给 body 设了 flex:1 1 auto，
  //   直接覆盖会让它不再是 flex 子项 → 高度塌陷 → 点击区域错位。
  body.style.cssText += 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

  const bar = document.createElement('div');
  bar.style.cssText =
    'flex:0 0 24px;display:flex;align-items:center;gap:6px;padding:0 8px;' +
    'background:var(--s3,var(--color-raised, var(--color-raised, #181C20)));border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));' +
    'font:9.5px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));overflow:hidden';
  const statusEl = document.createElement('span');
  statusEl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  statusEl.textContent = '加载中…';
  const refresh = document.createElement('button');
  refresh.textContent = '⟳';
  refresh.title = '刷新';
  refresh.style.cssText =
    'flex:0 0 auto;padding:1px 6px;border-radius:3px;border:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));' +
    'background:var(--s2,var(--color-panel, var(--color-panel, var(--color-panel, #121518))));color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)));font:10px monospace;cursor:pointer';
  bar.appendChild(statusEl);
  bar.appendChild(refresh);
  body.appendChild(bar);

  const content = document.createElement('div');
  content.style.cssText = 'flex:1;overflow:auto;min-height:0';
  body.appendChild(content);

  let curRel = '';

  async function load(rel) {
    content.innerHTML = '<div style="padding:10px;font:10px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">读取…</div>';

    const resolved = await rvResolveDir(api, panel);
    const dir = resolved.dir;
    if (!dir) {
      statusEl.textContent = '未配置目录';
      content.innerHTML = '<div style="padding:12px;font:10.5px/1.8 monospace;color:var(--color-warn, var(--color-warn, #D0A34A))">' +
        '没有配置目录。在场景 json 里给面板加 docDir。</div>';
      return;
    }
    statusEl.textContent = (resolved.isSceneLevel ? '' : '全局 · ') + dir;

    const r = await rvList(api, dir);
    if (!r.ok) {
      content.innerHTML = '<div style="padding:12px;font:10.5px/1.8 monospace;color:var(--color-err, var(--color-err, #D05A4A))">' +
        '✗ 列目录失败：' + esc(r.err || '未知') + '</div>';
      return;
    }

    const rows = (r.rows || []).filter(function (x) {
      return x && !String(x.name || '').startsWith('.');
    });

    const dirCount = rows.filter(function (x) { return x.isDir; }).length;
    const fileCount = rows.length - dirCount;
    statusEl.textContent =
      (resolved.isSceneLevel ? '' : '全局 · ') + rows.length + ' 项（' + dirCount + ' 目录 / ' + fileCount + ' 文件）';

    if (!rows.length) {
      content.innerHTML = '<div style="padding:16px 8px;text-align:center;font:10.5px/1.9 monospace;' +
        'color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">目录是空的<br><br>' +
        '<span style="font-size:10px">' + esc(dir) + '</span></div>';
      return;
    }

    let html = '<table style="width:100%;border-collapse:collapse;font:9.5px monospace">' +
      '<thead><tr>' +
      '<th style="text-align:left;padding:4px 8px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font-weight:500;' +
      'border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));position:sticky;top:0;background:var(--s3,var(--color-raised, var(--color-raised, #181C20)))">名称</th>' +
      '<th style="text-align:right;padding:4px 8px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font-weight:500;' +
      'border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));position:sticky;top:0;background:var(--s3,var(--color-raised, var(--color-raised, #181C20)))">大小</th>' +
      '<th style="text-align:right;padding:4px 8px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font-weight:500;' +
      'border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));position:sticky;top:0;background:var(--s3,var(--color-raised, var(--color-raised, #181C20)))">修改</th>' +
      '</tr></thead><tbody>';

    if (rel) {
      html += '<tr class="rf-up" style="cursor:pointer">' +
        '<td colspan="3" style="padding:4px 8px;color:var(--color-ok, var(--color-ok, #5A9ED0));border-bottom:1px solid rgba(255,255,255,.04)">' +
        '↑ 返回上层</td></tr>';
    }

    for (const x of rows) {
      const isDir = !!x.isDir;
      html += '<tr class="rf-row" data-name="' + esc(x.name) + '" data-dir="' + (isDir ? '1' : '0') + '" ' +
        'style="cursor:pointer">' +
        '<td style="padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.04);' +
        'color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)))">' + (isDir ? '▸ ' : '') + esc(x.name) + '</td>' +
        '<td style="padding:4px 8px;text-align:right;border-bottom:1px solid rgba(255,255,255,.04);' +
        'color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' + (isDir ? '—' : pcHuman(x.size || 0)) + '</td>' +
        '<td style="padding:4px 8px;text-align:right;border-bottom:1px solid rgba(255,255,255,.04);' +
        'color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font-size:9px">' + (x.mtime ? pcAgo(x.mtime) : '—') + '</td></tr>';
    }
    html += '</tbody></table>';
    content.innerHTML = html;

    const up = content.querySelector('.rf-up');
    if (up) {
      up.addEventListener('click', function () {
        const segs = curRel.split('/').filter(Boolean);
        segs.pop();
        curRel = segs.join('/');
        load(curRel);
      });
    }

    content.querySelectorAll('.rf-row').forEach(function (tr) {
      tr.addEventListener('click', function () {
        const name = tr.getAttribute('data-name');
        const isDir = tr.getAttribute('data-dir') === '1';
        if (isDir) {
          curRel = (curRel ? curRel + '/' : '') + name;
          load(curRel);
          return;
        }
        // 单击文件 → 用系统程序打开
        const abs = dir.replace(/\/$/, '') + '/' + (curRel ? curRel + '/' : '') + name;
        try {
          const fn = api && (api['app:open-path'] || (api.app && api.app.openPath));
          if (typeof fn === 'function') fn(abs);
        } catch (e) { /* 忽略 */ }
      });
    });
  }

  setTimeout(function () { load(''); }, 80);
  refresh.addEventListener('click', function () { curRel = ''; load(''); });

  return { el: host.lastChild, update: function () { load(curRel); }, destroy: function () {} };
}

// ══════════════════════════════════════════════════════════════════════════
//  pc-* —— 本地电脑（4 个面板 · 2026-11-11 换成真实现）
//
//  设计依据（事故 AC-018）：
//    原来这 4 个面板全是 emptyState 占位，写着「待接入 pc:xxx API」。
//    界面上看起来像正常面板（有标题、有图标），点进去才发现什么都没有。
//    这比「报错」更糟 —— 报错至少知道坏了。
//
//  三条硬规矩（改之前先读）：
//    ① 只读：这里不删任何文件，只盘点 + 报大小
//    ② 说明白：每个面板都要写清「这是只读的」
//    ③ 失败要说话：加载失败显示可读原因，不留白屏
// ══════════════════════════════════════════════════════════════════════════

/** 字节数 → 人类可读（1.2 GB / 340 MB / 12 KB） */
function pcHuman(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

/** 时间戳（秒）→ 相对时间 */
function pcAgo(sec) {
  const n = Number(sec) || 0;
  if (!n) return '—';
  const d = Math.floor(Date.now() / 1000) - n;
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 2592000) return Math.floor(d / 86400) + ' 天前';
  return new Date(n * 1000).toLocaleDateString('zh-CN');
}

/** 通用：面板内部的表格样式 */
function pcTableStyle() {
  return 'width:100%;border-collapse:collapse;font:11px "JetBrains Mono",monospace;';
}
function pcThStyle() {
  return 'text-align:left;padding:4px 8px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font-weight:500;' +
    'border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));position:sticky;top:0;background:var(--s3,var(--color-raised, var(--color-raised, #181C20)));';
}
function pcTdStyle() {
  return 'padding:4px 8px;color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)));border-bottom:1px solid rgba(255,255,255,.04);';
}

/** 通用：带刷新按钮的容器 */
function pcMakeBody(body, title) {
  // ⚠ 用 += 而不是 =：makeShell 给 body 设了 flex:1 1 auto，
  //   直接覆盖会让它不再是 flex 子项 → 高度塌陷 → 点击区域错位。
  body.style.cssText += 'display:flex;flex-direction:column;height:100%;overflow:hidden;';
  const bar = document.createElement('div');
  bar.style.cssText =
    'flex:0 0 26px;display:flex;align-items:center;gap:8px;padding:0 8px;' +
    'background:var(--s3,var(--color-raised, var(--color-raised, #181C20)));border-bottom:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));font:10px monospace;';
  const statusEl = document.createElement('span');
  statusEl.style.cssText = 'flex:1;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  statusEl.textContent = title || '';
  const btn = document.createElement('button');
  btn.textContent = '⟳ 重新扫描';
  btn.style.cssText =
    'padding:2px 8px;border-radius:3px;border:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));' +
    'background:var(--s2,var(--color-panel, var(--color-panel, var(--color-panel, #121518))));color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)));font:10px monospace;cursor:pointer;';
  bar.appendChild(statusEl);
  bar.appendChild(btn);
  body.appendChild(bar);

  const content = document.createElement('div');
  content.style.cssText = 'flex:1;overflow:auto;min-height:0;';
  body.appendChild(content);

  return { statusEl, btn, content };
}

// ══════════════════════════════════════════════════════════════════════════
//  pc-drives —— 磁盘分区
// ══════════════════════════════════════════════════════════════════════════
export function createPcDrives(host, panel, ctx) {
  const api = ctx && ctx.api;
  const { body } = makeShell(host, panel, ctx, { label: '磁盘分区' });
  const ui = pcMakeBody(body, '只读盘点 · 分区容量');

  function bar(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const color = p >= 90 ? 'var(--err,var(--color-err, var(--color-err, #D05A4A)))' : p >= 75 ? 'var(--color-warn, var(--color-warn, #D0A34A))' : 'var(--ok,var(--color-ok, #4A9E6A))';
    return '<div style="height:4px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden">' +
      '<div style="height:100%;width:' + p + '%;background:' + color + '"></div></div>';
  }

  async function load() {
    ui.content.innerHTML =
      '<div style="padding:12px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font:11px monospace">正在读取分区…</div>';
    ui.statusEl.textContent = '正在读取…';

    let r = null;
    try {
      const wrapped = api && api.pc && api.pc.drives ? await api.pc.drives() : null;
      // ⚠ api 包装层返回 { ok, value, error }，真正的数据在 .value 里
      r = (wrapped && wrapped.value !== undefined) ? wrapped.value : wrapped;
    } catch (e) {
      r = { ok: false, err: String((e && e.message) || e) };
    }

    if (!r || r.ok === false) {
      const msg = (r && (r.err || r.error)) || '接口未返回数据';
      ui.content.innerHTML =
        '<div style="padding:12px;color:var(--color-err, var(--color-err, #D05A4A));font:11px/1.7 monospace">' +
        '✗ 读取失败：' + esc(msg) + '<br><br>' +
        '<span style="color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' +
        '如果提示「接口未返回」，说明主进程还是旧的 —— 重启一次工作台即可。</span></div>';
      ui.statusEl.textContent = '读取失败';
      return;
    }

    // ⚠ 字段名对齐：pc:drives 返回的是 `drives`，不是 `rows`
    const rows = r.drives || r.rows || r.disks || [];
    // 只保留真实可用的分区（ok:true 且 total>0）
    const usable = rows.filter(function (x) { return x && x.ok !== false && Number(x.total) > 0; });
    if (!usable.length) {
      ui.content.innerHTML =
        '<div style="padding:12px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font:11px/1.7 monospace">' +
        '没有读到可用分区<br><span style="font-size:10px">' +
        '探测了 C~H，全部返回不可用。可能是权限问题。</span></div>';
      ui.statusEl.textContent = '0 个可用分区';
      return;
    }

    const totalAll = usable.reduce((a, x) => a + (Number(x.total) || 0), 0);
    const usedAll = usable.reduce((a, x) => a + (Number(x.used) || 0), 0);
    ui.statusEl.textContent =
      usable.length + ' 个分区 · 合计 ' + pcHuman(totalAll) + '，已用 ' + pcHuman(usedAll);

    let html = '<div style="padding:8px;display:flex;flex-direction:column;gap:8px">';
    for (const d of usable) {
      const total = Number(d.total) || 0;
      const used = Number(d.used) || 0;
      const free = Number(d.free) || (total - used);
      const pct = total > 0 ? (used / total) * 100 : 0;
      const drive = String(d.drive || d.name || d.letter || '?');
      const label = String(d.label || d.volume || '');

      html +=
        '<div class="pc-drive-card" data-drive="' + esc(drive) + '" ' +
        'style="padding:8px 10px;border-radius:5px;background:var(--s3,var(--color-raised, var(--color-raised, #181C20)));' +
        'border:1px solid var(--line,var(--color-line, var(--color-line, #22272D)));cursor:pointer">' +
        '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px">' +
        '<span style="font:600 13px monospace;color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)))">' + esc(drive) + '</span>' +
        (label ? '<span style="font:10px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' + esc(label) + '</span>' : '') +
        '<span style="flex:1"></span>' +
        '<span style="font:10px monospace;color:' +
        (pct >= 90 ? 'var(--err,var(--color-err, var(--color-err, #D05A4A)))' : pct >= 75 ? 'var(--color-warn, var(--color-warn, #D0A34A))' : 'var(--ok,var(--color-ok, #4A9E6A))') + '">' +
        pct.toFixed(1) + '%</span></div>' +
        bar(pct) +
        '<div style="display:flex;justify-content:space-between;margin-top:5px;' +
        'font:10px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' +
        '<span>已用 ' + pcHuman(used) + '</span>' +
        '<span>可用 ' + pcHuman(free) + '</span>' +
        '<span>共 ' + pcHuman(total) + '</span></div></div>';
    }
    html += '</div>';
    ui.content.innerHTML = html;

    // 点击卡片 → 在资源管理器打开该盘
    ui.content.querySelectorAll('.pc-drive-card').forEach(function (card) {
      card.addEventListener('click', function () {
        const drive = card.getAttribute('data-drive');
        const p = drive.replace(/:.*$/, '') + ':\\';
        try {
          const fn = api && (api['app:reveal-path'] || (api.app && api.app.revealPath));
          if (typeof fn === 'function') fn(p);
        } catch (e) { /* ignore */ }
      });
    });
  }

  setTimeout(load, 60);
  ui.btn.addEventListener('click', load);
  return { el: host.lastChild, update: load, destroy: function () {} };
}

// ══════════════════════════════════════════════════════════════════════════
//  pc-toplarge —— 磁盘大户排行
// ══════════════════════════════════════════════════════════════════════════
export function createPcTopLarge(host, panel, ctx) {
  const api = ctx && ctx.api;
  const { body } = makeShell(host, panel, ctx, { label: '大文件排行' });
  const ui = pcMakeBody(body, '只读盘点 · 最大的文件');

  async function load() {
    ui.content.innerHTML =
      '<div style="padding:12px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font:11px monospace">' +
      '正在扫描 C 盘（最多 15 秒）…<br>' +
      '<span style="font-size:10px">跳过 Windows / Program Files / node_modules</span></div>';
    ui.statusEl.textContent = '扫描中…';

    const t0 = Date.now();
    let r = null;
    try {
      const wrapped = api && api.pc && api.pc.toplarge
        ? await api.pc.toplarge({ drive: panel.drive || 'C', limit: 20, maxDepth: 6, timeoutMs: 15000 })
        : null;
      r = (wrapped && wrapped.value !== undefined) ? wrapped.value : wrapped;
    } catch (e) {
      r = { ok: false, err: String((e && e.message) || e) };
    }
    const ms = Date.now() - t0;

    if (!r || r.ok === false) {
      const msg = (r && (r.err || r.error)) || '接口未返回数据';
      ui.content.innerHTML =
        '<div style="padding:12px;color:var(--color-err, var(--color-err, #D05A4A));font:11px/1.7 monospace">✗ 扫描失败：' +
        esc(msg) + '<br><br><span style="color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' +
        '主进程可能还是旧的 —— 重启一次工作台。</span></div>';
      ui.statusEl.textContent = '扫描失败';
      return;
    }

    const rows = r.rows || [];
    ui.statusEl.textContent =
      '扫了 ' + (r.scanned || 0) + ' 个文件 / ' + (r.dirs || 0) + ' 个目录 · ' +
      ms + ' ms' + (r.truncated ? ' · ⚠ 超时截断' : '');

    if (!rows.length) {
      ui.content.innerHTML =
        '<div style="padding:12px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font:11px monospace">' +
        '没有扫到文件' + (r.truncated ? '（扫描超时，可能没扫到）' : '') + '</div>';
      return;
    }

    let html = '<table style="' + pcTableStyle() + '"><thead><tr>' +
      '<th style="' + pcThStyle() + '">文件</th>' +
      '<th style="' + pcThStyle() + ';text-align:right">大小</th>' +
      '<th style="' + pcThStyle() + ';text-align:right">修改</th>' +
      '</tr></thead><tbody>';
    for (const f of rows) {
      const full = String(f.path || '');
      const name = full.split(/[\\/]/).pop() || full;
      const dir = full.slice(0, full.length - name.length).replace(/[\\/]$/, '');
      html += '<tr class="pc-file-row" data-path="' + esc(full) + '" style="cursor:pointer">' +
        '<td style="' + pcTdStyle() + '">' +
        '<div style="color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)))">' + esc(name) + '</div>' +
        '<div style="font-size:9.5px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap;max-width:340px" title="' + esc(full) + '">' +
        esc(dir) + '</div></td>' +
        '<td style="' + pcTdStyle() + ';text-align:right;color:var(--color-warn, var(--color-warn, #D0A34A))">' + pcHuman(f.size) + '</td>' +
        '<td style="' + pcTdStyle() + ';text-align:right;font-size:10px">' + pcAgo(f.mtime) + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    ui.content.innerHTML = html;

    ui.content.querySelectorAll('.pc-file-row').forEach(function (tr) {
      tr.addEventListener('click', function () {
        const p = tr.getAttribute('data-path');
        try {
          const fn = api && (api['app:reveal-path'] || (api.app && api.app.revealPath));
          if (typeof fn === 'function') fn(p);
        } catch (e) { /* ignore */ }
      });
    });
  }

  setTimeout(load, 60);
  ui.btn.addEventListener('click', load);
  return { el: host.lastChild, update: load, destroy: function () {} };
}

// ══════════════════════════════════════════════════════════════════════════
//  pc-junk —— 可清理项（只统计，不删）
// ══════════════════════════════════════════════════════════════════════════
export function createPcJunk(host, panel, ctx) {
  const api = ctx && ctx.api;
  const { body } = makeShell(host, panel, ctx, { label: '可清理项' });
  const ui = pcMakeBody(body, '只读盘点 · 不删除任何文件');

  async function load() {
    ui.content.innerHTML =
      '<div style="padding:12px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font:11px monospace">正在统计可清理项…</div>';
    ui.statusEl.textContent = '统计中…';

    let r = null;
    try {
      const wrapped = api && api.pc && api.pc.junk ? await api.pc.junk() : null;
      r = (wrapped && wrapped.value !== undefined) ? wrapped.value : wrapped;
    } catch (e) {
      r = { ok: false, err: String((e && e.message) || e) };
    }

    if (!r || r.ok === false) {
      const msg = (r && (r.err || r.error)) || '接口未返回数据';
      ui.content.innerHTML =
        '<div style="padding:12px;color:var(--color-err, var(--color-err, #D05A4A));font:11px/1.7 monospace">✗ 统计失败：' +
        esc(msg) + '<br><br><span style="color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' +
        '主进程可能还是旧的 —— 重启一次工作台。</span></div>';
      ui.statusEl.textContent = '统计失败';
      return;
    }

    // ⚠ pc:junk 返回的每项有 ok 字段：ok:false 表示「目录不存在 / 没权限 / 超时跳过」
    //   要把它们和「真的没有垃圾」区分开，否则会误导成「系统很干净」
    const all = r.rows || [];
    const rows = all.filter(function (x) { return x && x.ok !== false && (Number(x.bytes) > 0 || Number(x.count) > 0); });
    const skipped = all.filter(function (x) { return x && x.ok === false; });
    const totalBytes = rows.reduce((a, x) => a + (Number(x.bytes) || 0), 0);
    const totalCount = rows.reduce((a, x) => a + (Number(x.count) || 0), 0);
    ui.statusEl.textContent =
      rows.length + ' 类 · 共 ' + pcHuman(totalBytes) + ' / ' + totalCount + ' 项（只读，不删）';

    if (!rows.length) {
      if (skipped.length) {
        // 全部被跳过 ⇒ 不能说「很干净」，要说「没扫到」
        let h = '<div style="padding:12px;font:11px/1.7 monospace">' +
          '<div style="color:var(--color-warn, var(--color-warn, #D0A34A))">⚠ 没有扫到可清理项，但有 ' + skipped.length + ' 处没扫成：</div>';
        for (const sk of skipped) {
          h += '<div style="margin-top:4px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font-size:10px">· ' +
            esc(String(sk.label || sk.id || '')) + ' — ' + esc(String(sk.err || '未知原因')) + '</div>';
        }
        h += '</div>';
        ui.content.innerHTML = h;
      } else {
        ui.content.innerHTML =
          '<div style="padding:12px;color:var(--ok,var(--color-ok, #4A9E6A));font:11px monospace">' +
          '✓ 没有发现可清理项</div>';
      }
      return;
    }

    let html = '<div style="padding:8px;display:flex;flex-direction:column;gap:6px">';
    for (const j of rows) {
      html +=
        '<div class="pc-junk-row" data-path="' + esc(j.path || '') + '" ' +
        'style="padding:8px 10px;border-radius:5px;background:var(--s3,var(--color-raised, var(--color-raised, #181C20)));' +
        'border:1px solid var(--line,var(--color-line, var(--color-line, #22272D)))">' +
        '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:3px">' +
        '<span style="font:600 11px monospace;color:var(--t1,var(--color-txt-1, var(--color-txt-1, #E9EDF2)))">' +
        esc(j.label || j.kind || '可清理') + '</span>' +
        '<span style="flex:1"></span>' +
        '<span style="font:11px monospace;color:var(--color-warn, var(--color-warn, #D0A34A))">' + pcHuman(j.bytes) + '</span></div>' +
        '<div style="font:10px monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' +
        (Number(j.count) || 0) + ' 项 · ' + esc(j.path || '') + '</div></div>';
    }
    html += '</div>';
    html += '<div style="padding:8px 12px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font:10px/1.6 monospace;' +
      'border-top:1px solid var(--line,var(--color-line, var(--color-line, #22272D)))">' +
      '⚠ 这里只统计，不会删除任何文件。<br>' +
      '要清理请点对应项，在资源管理器里自己决定。</div>';
    ui.content.innerHTML = html;

    ui.content.querySelectorAll('.pc-junk-row').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function () {
        const p = el.getAttribute('data-path');
        if (!p) return;
        try {
          const fn = api && (api['app:reveal-path'] || (api.app && api.app.revealPath));
          if (typeof fn === 'function') fn(p);
        } catch (e) { /* ignore */ }
      });
    });
  }

  setTimeout(load, 60);
  ui.btn.addEventListener('click', load);
  return { el: host.lastChild, update: load, destroy: function () {} };
}

// ══════════════════════════════════════════════════════════════════════════
//  pc-ledger —— 清理台账
// ══════════════════════════════════════════════════════════════════════════
export function createPcLedger(host, panel, ctx) {
  const api = ctx && ctx.api;
  const { body } = makeShell(host, panel, ctx, { label: '清理台账' });
  const ui = pcMakeBody(body, '历史清理记录');

  async function load() {
    ui.content.innerHTML =
      '<div style="padding:12px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));font:11px monospace">正在读取台账…</div>';
    ui.statusEl.textContent = '读取中…';

    let r = null;
    try {
      const wrapped = api && api.pc && api.pc.ledger ? await api.pc.ledger() : null;
      r = (wrapped && wrapped.value !== undefined) ? wrapped.value : wrapped;
    } catch (e) {
      r = { ok: false, err: String((e && e.message) || e) };
    }

    if (!r || r.ok === false) {
      const msg = (r && (r.err || r.error)) || '接口未返回数据';
      ui.content.innerHTML =
        '<div style="padding:12px;color:var(--color-err, var(--color-err, #D05A4A));font:11px/1.7 monospace">✗ 读取失败：' +
        esc(msg) + '<br><br><span style="color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)))">' +
        '主进程可能还是旧的 —— 重启一次工作台。</span></div>';
      ui.statusEl.textContent = '读取失败';
      return;
    }

    const rows = r.rows || r.items || [];
    ui.statusEl.textContent = rows.length + ' 条记录';

    if (!rows.length) {
      ui.content.innerHTML =
        '<div style="padding:20px 12px;text-align:center">' +
        '<div style="font-size:22px;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));margin-bottom:8px">▦</div>' +
        '<div style="font:11px monospace;color:var(--t2,var(--color-txt-2, var(--color-txt-2, #A2ABBA)))">暂无清理记录</div>' +
        '<div style="font:10px/1.7 monospace;color:var(--t3,var(--color-txt-3, var(--color-txt-3, #8A94A3)));margin-top:6px">' +
        '台账文件：(不存在)<br>' +
        '以后每次清理会记在这里</div></div>';
      return;
    }

    let html = '<table style="' + pcTableStyle() + '"><thead><tr>' +
      '<th style="' + pcThStyle() + '">时间</th>' +
      '<th style="' + pcThStyle() + '">操作</th>' +
      '<th style="' + pcThStyle() + ';text-align:right">清理量</th>' +
      '<th style="' + pcThStyle() + '">备注</th>' +
      '</tr></thead><tbody>';
    for (const it of rows) {
      html += '<tr>' +
        '<td style="' + pcTdStyle() + ';font-size:10px">' + esc(String(it.at || it.time || '—')) + '</td>' +
        '<td style="' + pcTdStyle() + '">' + esc(String(it.action || it.op || '—')) + '</td>' +
        '<td style="' + pcTdStyle() + ';text-align:right;color:var(--color-warn, var(--color-warn, #D0A34A))">' +
        pcHuman(it.bytes || it.size || 0) + '</td>' +
        '<td style="' + pcTdStyle() + ';font-size:10px">' + esc(String(it.note || it.desc || '')) + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    ui.content.innerHTML = html;
  }

  setTimeout(load, 60);
  ui.btn.addEventListener('click', load);
  return { el: host.lastChild, update: load, destroy: function () {} };
}

export default {
  createEmbed, createSfBoard, createReviewDoc, createReviewFiles,
  createPcDrives, createPcTopLarge, createPcJunk, createPcLedger,
};
