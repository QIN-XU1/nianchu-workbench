// ui/panels/dispatch-board.js —— 任务分派看板（主控台核心面板）
//
// ══════════════════════════════════════════════════════════════════════
// 它显示什么
// ──────────────────────────────────────────────────────────────────────
//   把 tools/dispatch/dispatch.mjs 的 data/dispatch.json 摆成三块：
//     ① 目标（Run）—— 当前在为什么而分工
//     ② 任务 DAG  —— 每个 Task 的状态（pending/ready/dispatched/running/done/failed/blocked）
//                    被派给哪个场景、哪个 AI
//     ③ 信箱     —— worker_done / worker_failed 回执
//
// 设计原则（沿用项目）
//   · 只读：面板不写数据。写入口唯一 = tools/dispatch/dispatch.mjs CLI。
//     （避免 UI 和 CLI 两个写者互相覆盖）
//   · 四态颜色：ready=蓝、running=青、done=绿、failed=红、pending=灰、blocked=橙
//   · 加载失败/无数据都不白屏，显示可读空态
// ══════════════════════════════════════════════════════════════════════

const STATE_STYLE = {
  pending:    { text: '待办',   color: 'var(--t3,#8A94A3)' },
  ready:      { text: '可派发', color: 'var(--color-ok,#5A9ED0)' },
  dispatched: { text: '已派发', color: 'var(--color-ok,#5A9ED0)' },
  running:    { text: '进行中', color: '#3FB6A8' },
  done:       { text: '已完成', color: 'var(--ok,#4A9E6A)' },
  failed:     { text: '失败',   color: 'var(--err,#D05A4A)' },
  blocked:    { text: '阻塞',   color: '#D08A2A' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function makeShell(host, panel, label) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';
  const head = document.createElement('div');
  head.style.cssText = 'flex:0 0 26px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--line,#22272D);';
  head.innerHTML = '<span style="font-weight:600;font-size:12px;color:var(--t1,#E9EDF2)">' + esc(label) + '</span>'
    + '<span id="db-sum" style="font-size:11px;color:var(--t3,#8A94A3)"></span>'
    + '<span style="flex:1 1 auto"></span>'
    + '<button id="db-refresh" style="font-size:11px;background:transparent;border:1px solid var(--line,#333);color:var(--t2,#B8C2CE);border-radius:4px;padding:1px 8px;cursor:pointer">刷新</button>';
  wrap.appendChild(head);
  const body = document.createElement('div');
  body.style.cssText = 'flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px;';
  wrap.appendChild(body);
  host.appendChild(wrap);
  return { wrap, head, body };
}

function stateChip(state) {
  const s = STATE_STYLE[state] || { text: state || '?', color: '#888' };
  return '<span style="display:inline-block;min-width:44px;text-align:center;font-size:10px;padding:1px 6px;border-radius:3px;'
    + 'color:' + s.color + ';border:1px solid ' + s.color + '33;background:' + s.color + '14">' + esc(s.text) + '</span>';
}

function render(body, sumEl, data) {
  const runs = data.runs || [];
  const tasks = data.tasks || [];
  const dispatches = data.dispatches || [];
  const inbox = data.inbox || [];

  if (data.error) {
    body.innerHTML = '<div style="color:var(--err,#D05A4A);font-size:12px">读取失败：' + esc(data.error) + '</div>';
    return;
  }
  if (!tasks.length) {
    body.innerHTML = '<div style="color:var(--t3,#8A94A3);font-size:12px;line-height:1.7">'
      + '<div style="font-size:13px;color:var(--t2,#B8C2CE);margin-bottom:6px">还没有分派任务</div>'
      + '<div>用 CLI 建第一个目标与任务：</div>'
      + '<pre style="margin:6px 0;padding:8px;background:var(--s2,#14181C);border-radius:4px;font-size:11px;overflow:auto">'
      + 'node tools/dispatch/dispatch.mjs run-create --objective "把 X 做好"\n'
      + 'node tools/dispatch/dispatch.mjs task-create --run &lt;id&gt; --title "调研" --deps \'[]\'\n'
      + 'node tools/dispatch/dispatch.mjs task-list --ready\n'
      + 'node tools/dispatch/dispatch.mjs dispatch --task &lt;id&gt; --scene research --agent "AI-1"'
      + '</pre></div>';
    if (sumEl) sumEl.textContent = '空';
    return;
  }

  // 派发索引：taskId -> 最近一次 dispatch
  const lastDisp = {};
  for (const d of dispatches) lastDisp[d.taskId] = d;

  const counts = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] || 0) + 1;
  if (sumEl) {
    sumEl.textContent = tasks.length + ' 任务 · 完成 ' + (counts.done || 0)
      + ' · 进行 ' + ((counts.dispatched || 0) + (counts.running || 0))
      + ' · 可派 ' + (counts.ready || 0) + (counts.failed ? ' · 失败 ' + counts.failed : '');
  }

  const run = runs[runs.length - 1];
  let html = '';
  if (run) {
    html += '<div style="margin-bottom:10px;padding:8px 10px;background:var(--s2,#14181C);border-radius:6px;border-left:3px solid var(--color-ok,#5A9ED0)">'
      + '<div style="font-size:10px;color:var(--t3,#8A94A3);letter-spacing:.5px">当前目标</div>'
      + '<div style="font-size:13px;color:var(--t1,#E9EDF2);margin-top:2px">' + esc(run.objective) + '</div></div>';
  }

  html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
  html += '<thead><tr style="color:var(--t3,#8A94A3);font-size:10px;text-align:left">'
    + '<th style="padding:4px 6px;font-weight:500">状态</th>'
    + '<th style="padding:4px 6px;font-weight:500">任务</th>'
    + '<th style="padding:4px 6px;font-weight:500">场景</th>'
    + '<th style="padding:4px 6px;font-weight:500">执行</th>'
    + '<th style="padding:4px 6px;font-weight:500">依赖</th>'
    + '</tr></thead><tbody>';
  for (const t of tasks) {
    const d = lastDisp[t.id];
    const scene = (d && d.scene) || t.scene || '—';
    const agent = (d && d.agent) || '—';
    const deps = (t.deps || []).length ? t.deps.length + ' 个' : '—';
    html += '<tr style="border-top:1px solid var(--line,#22272D22)">'
      + '<td style="padding:5px 6px">' + stateChip(t.state) + '</td>'
      + '<td style="padding:5px 6px;color:var(--t1,#E9EDF2)">' + esc(t.title) + '</td>'
      + '<td style="padding:5px 6px;color:var(--t2,#B8C2CE)">' + esc(scene) + '</td>'
      + '<td style="padding:5px 6px;color:var(--t2,#B8C2CE)">' + esc(agent) + '</td>'
      + '<td style="padding:5px 6px;color:var(--t3,#8A94A3)">' + esc(deps) + '</td>'
      + '</tr>';
  }
  html += '</tbody></table>';

  if (inbox.length) {
    html += '<div style="margin-top:12px;font-size:10px;color:var(--t3,#8A94A3);letter-spacing:.5px">信箱</div>';
    for (const m of inbox.slice(-6).reverse()) {
      const bad = m.kind === 'worker_failed';
      html += '<div style="margin-top:4px;font-size:11px;color:' + (bad ? 'var(--err,#D05A4A)' : 'var(--t2,#B8C2CE)') + '">'
        + (m.read ? '· ' : '● ') + '[' + esc(m.kind) + '] ' + esc(String(m.body || '').slice(0, 70)) + '</div>';
    }
  }

  body.innerHTML = html;
}

export function createDispatchBoard(host, panel, ctx) {
  const api = (ctx && ctx.api) || {};
  const { body, head } = makeShell(host, panel, '任务分派');
  const sumEl = head.querySelector('#db-sum');

  let timer = null;
  let alive = true;

  async function load() {
    try {
      let data;
      if (typeof api.dispatchRead === 'function') {
        data = await api.dispatchRead();
      } else if (api.raw && typeof api.raw.dispatchRead === 'function') {
        data = await api.raw.dispatchRead();
      } else {
        // 浏览器 demo / 未就绪：显示可读提示，不白屏
        body.innerHTML = '<div style="color:var(--t3,#8A94A3);font-size:12px">'
          + '分派面板需要 Electron 环境（api.dispatchRead 未就绪）。<br>'
          + '在 CLI 里用 tools/dispatch/dispatch.mjs 管理任务。</div>';
        return;
      }
      if (alive) render(body, sumEl, data || {});
    } catch (e) {
      if (alive) body.innerHTML = '<div style="color:var(--err,#D05A4A);font-size:12px">加载失败：' + esc(e && e.message) + '</div>';
    }
  }

  const btn = head.querySelector('#db-refresh');
  if (btn) btn.addEventListener('click', load);

  load();
  // 轻量轮询（5s）——分派状态变化不频繁，不必更快
  timer = setInterval(load, 5000);

  return {
    el: host,
    update: load,
    destroy() {
      alive = false;
      if (timer) clearInterval(timer);
    },
  };
}

export default createDispatchBoard;
