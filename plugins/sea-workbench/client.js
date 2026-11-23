window.__ModuleLoader__.load({
  id: '@local/sea-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    const TAB_ID = '@local/sea-workbench/workbench';

    // ---------- 主题 ----------
    // 面板是整块区域，沿用宿主主题变量，不硬编码配色
    const CSS = {
      root: {
        display: 'flex', flexDirection: 'column',
        height: '100%', width: '100%', minHeight: 0,
        fontSize: 13, lineHeight: 1.5,
        color: 'inherit', background: 'transparent',
      },
      toolbar: {
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', flex: '0 0 auto',
        borderBottom: '1px solid rgba(128,128,128,0.22)',
        flexWrap: 'wrap',
      },
      body: { display: 'flex', flex: '1 1 auto', minHeight: 0 },
      treePane: {
        width: 260, minWidth: 160, flex: '0 0 auto',
        borderRight: '1px solid rgba(128,128,128,0.22)',
        overflow: 'auto', padding: '4px 0',
      },
      mainPane: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' },
      statusStrip: {
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        padding: '4px 10px', flex: '0 0 auto',
        borderBottom: '1px solid rgba(128,128,128,0.15)',
      },
      content: { flex: '1 1 auto', overflow: 'auto', padding: '8px 12px', minHeight: 0 },
      row: {
        padding: '2px 8px', cursor: 'pointer', borderRadius: 3,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        fontSize: 12,
      },
    };

    const dot = color => ({ width: 7, height: 7, borderRadius: 99, background: color, display: 'inline-block', flex: '0 0 auto' });

    const STATE_COLOR = {
      idle: '#16a34a', action: '#f59e0b', untrusted: '#dc2626',
      broken: '#dc2626', empty: '#888', error: '#dc2626', unknown: '#888',
    };
    const STATE_LABEL = {
      idle: '现在没事', action: '有事待办', untrusted: '检查不可信',
      broken: '配置有误', empty: '无场景', error: '读取失败', unknown: '未知',
    };

    const api = {
      async get(path) {
        const res = await fetch('/sea-workbench' + path, {
          credentials: 'same-origin', headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
          throw new Error(msg);
        }
        return res.json();
      },
    };

    const fmtKB = b => (b >= 1024 ? (b / 1024).toFixed(1) + 'KB' : b + 'B');

    // ---------- 极简 Markdown 渲染 ----------
    function Markdown({ text }) {
      const blocks = useMemo(() => {
        const lines = String(text || '').split('\n');
        const out = [];
        let i = 0, key = 0;
        let tableBuf = [];

        const flushTable = () => {
          if (tableBuf.length === 0) return;
          const rows = tableBuf.filter(l => !/^\s*\|[\s:|-]+\|\s*$/.test(l));
          const tableRows = rows.map(function (r, ri) {
            const cells = r.split('|').slice(1, -1).map(function (c) { return c.trim(); });
            const cellEls = cells.map(function (c, ci) {
              return h(ri === 0 ? 'th' : 'td', {
                key: ci,
                style: {
                  border: '1px solid rgba(128,128,128,0.3)', padding: '2px 8px',
                  textAlign: 'left', fontWeight: ri === 0 ? 600 : 400,
                },
              }, c);
            });
            return h('tr', { key: ri }, cellEls);
          });
          const tableEl = h('table', { style: { borderCollapse: 'collapse', fontSize: 12 } }, tableRows);
          out.push(h('div', { key: 'TB' + (key++), style: { overflow: 'auto', margin: '4px 0' } }, tableEl));
          tableBuf = [];
        };

        for (const line of lines) {
          if (/^\s*\|/.test(line)) { tableBuf.push(line); continue; }
          flushTable();

          const hm = line.match(/^(#+)\s+(.*)$/);
          if (hm) {
            const lvl = hm[1].length;
            out.push(h('div', {
              key: 'H' + (i++),
              style: {
                fontWeight: 700, fontSize: Math.max(13, 22 - lvl * 2),
                margin: lvl <= 2 ? '12px 0 6px' : '8px 0 4px',
                borderBottom: lvl <= 2 ? '1px solid rgba(128,128,128,0.2)' : 'none',
                paddingBottom: lvl <= 2 ? 3 : 0,
              },
            }, hm[2]));
            continue;
          }
          if (/^\s*[-*]\s+/.test(line)) {
            out.push(h('div', { key: 'L' + (i++), style: { paddingLeft: 12, textIndent: -10 } },
              '• ' + line.replace(/^\s*[-*]\s+/, '')));
            continue;
          }
          if (/^\s*\d+[.)]\s+/.test(line)) {
            out.push(h('div', { key: 'N' + (i++), style: { paddingLeft: 12, textIndent: -12 } }, line.trim()));
            continue;
          }
          if (/^>/.test(line)) {
            out.push(h('div', {
              key: 'Q' + (i++),
              style: { paddingLeft: 10, borderLeft: '3px solid rgba(128,128,128,0.4)', opacity: 0.85, margin: '2px 0' },
            }, line.replace(/^>\s?/, '')));
            continue;
          }
          if (line.trim() === '') {
            out.push(h('div', { key: 'S' + (i++), style: { height: 6 } }));
            continue;
          }
          out.push(h('div', { key: 'P' + (i++), style: { margin: '2px 0' } }, line));
        }
        flushTable();
        return out;
      }, [text]);

      return h('div', null, blocks);
    }

    // ---------- 文件树 ----------
    function FileTree({ roots, activeRoot, files, activePath, onPickRoot, onPickFile, loading }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, [
        // 根选择
        h('div', { key: 'roots', style: { padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,0.15)' } },
          h('div', { key: 'lbl', style: { fontSize: 11, opacity: 0.6, marginBottom: 4 } }, '档案根'),
          h('div', { key: 'btns', style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            roots.map(r => h('div', {
              key: r.key,
              onClick: () => onPickRoot(r.key),
              style: {
                padding: '3px 8px', cursor: 'pointer', borderRadius: 4, fontSize: 12,
                background: r.key === activeRoot ? 'rgba(22,163,74,0.15)' : 'transparent',
                fontWeight: r.key === activeRoot ? 600 : 400,
              },
            }, r.label)))),
        // 文件列表
        h('div', { key: 'files', style: { flex: 1, overflow: 'auto', padding: '4px 0' } },
          loading ? h('div', { style: { padding: 8, opacity: 0.6, fontSize: 11 } }, '读取中…')
            : (files.length === 0 ? h('div', { style: { padding: 8, opacity: 0.5, fontSize: 11 } }, '（空）')
              : files.map(f => h('div', {
                key: f.rel,
                onClick: () => onPickFile(f.rel),
                title: f.rel,
                style: {
                  ...CSS.row,
                  background: f.rel === activePath ? 'rgba(22,163,74,0.16)' : 'transparent',
                },
              }, [
                h('div', { key: 'n', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, f.name),
                h('div', { key: 'm', style: { fontSize: 10, opacity: 0.45, paddingLeft: 2 } }, fmtKB(f.bytes)),
              ])))),
      ]);
    }

    // ---------- 主面板 ----------
    function SeaWorkbenchPanel() {
      const [tab, setTab] = useState('overview');   // overview | files | inject | caps
      const [state, setState] = useState({ loading: true });
      const [error, setError] = useState(null);

      const [scenes, setScenes] = useState([]);
      const [activeScene, setActiveScene] = useState(null);

      const [roots, setRoots] = useState([]);
      const [fileRoot, setFileRoot] = useState('plan');
      const [files, setFiles] = useState([]);
      const [filesLoading, setFilesLoading] = useState(false);
      const [file, setFile] = useState(null);
      const [fileLoading, setFileLoading] = useState(false);

      const [caps, setCaps] = useState(null);
      const [boards, setBoards] = useState(null);

      // ---- 数据加载 ----
      const loadPulse = useCallback(async (force) => {
        try {
          setError(null);
          const d = await api.get('/pulse' + (force ? '?force=1' : ''));
          setState({ loading: false, ...d });
        } catch (e) {
          setError(String(e.message || e));
          setState(s => ({ ...s, loading: false, kind: 'error' }));
        }
      }, []);

      useEffect(() => { loadPulse(false); }, [loadPulse]);

      useEffect(() => {
        (async () => {
          try {
            const [s, c, b] = await Promise.all([
              api.get('/scenes'), api.get('/caps'), api.get('/boards').catch(() => null),
            ]);
            setScenes(s.scenes || []);
            setCaps(c);
            setBoards(b);
            if (s.scenes && s.scenes.length) setActiveScene(prev => prev || s.scenes[0].id);
          } catch { /* 面板不因数据失败而崩 */ }
        })();
      }, []);

      useEffect(() => {
        (async () => {
          try { const d = await api.get('/roots'); setRoots(d.roots || []); } catch { /* ignore */ }
        })();
      }, []);

      useEffect(() => {
        let alive = true;
        setFilesLoading(true);
        (async () => {
          try {
            const d = await api.get(`/files?root=${encodeURIComponent(fileRoot)}`);
            if (alive) setFiles(d.files || []);
          } catch { if (alive) setFiles([]); }
          finally { if (alive) setFilesLoading(false); }
        })();
        return () => { alive = false; };
      }, [fileRoot]);

      const pickFile = useCallback(async (rel) => {
        setFileLoading(true);
        try { const d = await api.get(`/file?path=${encodeURIComponent(rel)}`); setFile(d); }
        catch (e) { setFile({ rel, error: String(e.message || e) }); }
        finally { setFileLoading(false); }
      }, []);

      const toggleCap = useCallback(async (target, on) => {
        try {
          await api.get(`/toggle?target=${encodeURIComponent(target)}&on=${on ? 1 : 0}`);
          setCaps(await api.get('/caps'));
          loadPulse(true);
        } catch { /* ignore */ }
      }, [loadPulse]);

      const palColor = STATE_COLOR[state.kind] || STATE_COLOR.unknown;

      // ---- 顶栏 ----
      const toolbar = h('div', { style: CSS.toolbar }, [
        h('span', { key: 'dot', style: dot(palColor) }),
        h('span', { key: 'lbl', style: { fontWeight: 600 } },
          state.loading ? '检查中…' : (STATE_LABEL[state.kind] || '')),
        state.gate ? h('span', { key: 'gate', style: { opacity: 0.7, fontSize: 12 } },
          `门禁 ${state.gate.passed}/${state.gate.total}`) : null,
        state.cert ? h('span', { key: 'cert', style: { opacity: 0.7, fontSize: 12 } },
          `认证 ${state.cert.passed}/${state.cert.total}`) : null,
        state.assetProblems > 0 ? h('span', { key: 'as', style: { color: '#b91c1c', fontSize: 12 } },
          `资产 ${state.assetProblems} 问题`) : null,
        h('span', { key: 'sp', style: { flex: 1 } }),
        h('button', {
          key: 'rf', onClick: () => loadPulse(true), title: '重新体检',
          style: { background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.6, fontSize: 13 },
        }, '⟳'),
      ]);

      // ---- 视图切换 ----
      const tabs = [
        { k: 'overview', label: '总览' },
        { k: 'files', label: '档案' },
        { k: 'inject', label: '注入' },
        { k: 'caps', label: '外挂' },
      ];
      const tabBar = h('div', { style: { display: 'flex', gap: 2, padding: '4px 8px', flex: '0 0 auto' } },
        tabs.map(t => h('button', {
          key: t.k,
          onClick: () => setTab(t.k),
          style: {
            padding: '3px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
            border: '1px solid ' + (t.k === tab ? 'rgba(22,163,74,0.6)' : 'rgba(128,128,128,0.25)'),
            background: t.k === tab ? 'rgba(22,163,74,0.13)' : 'transparent',
            color: 'inherit',
          },
        }, t.label)));

      // ---- 总览视图 ----
      const sceneCard = (s) => {
        const active = s.id === activeScene;
        return h('div', {
          key: s.id,
          onClick: () => setActiveScene(s.id),
          style: {
            padding: '8px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 6,
            border: '1px solid ' + (active ? 'rgba(22,163,74,0.5)' : 'rgba(128,128,128,0.2)'),
            background: active ? 'rgba(22,163,74,0.08)' : 'transparent',
          },
        }, [
          h('div', { key: 't', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('span', { key: 'n', style: { fontWeight: 600 } }, s.name),
            h('span', { key: 'c', style: { fontSize: 11, opacity: 0.6 } }, `${s.completeness}/${s.totalParts} 件套`),
            h('span', { key: 's', style: { fontSize: 11, opacity: 0.6 } }, s.sessionId ? '会话已绑' : '会话未绑'),
          ]),
          h('div', { key: 'd', style: { fontSize: 12, opacity: 0.75, marginTop: 3 } }, s.desc),
          s.protects && s.protects.length ? h('div', { key: 'p', style: { fontSize: 11, opacity: 0.55, marginTop: 3 } },
            '保护：' + s.protects.join(' · ')) : null,
        ]);
      };

      const overview = h('div', null, [
        boards ? h('div', { key: 'bd', style: { display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap', fontSize: 12 } }, [
          h('span', { key: '1' }, `通知 ${boards.notices}`),
          h('span', { key: '2' }, `待办 ${boards.todos}`),
          h('span', { key: '3' }, `索引 ${boards.index}`),
        ]) : null,
        h('div', { key: 'sc', style: { fontSize: 12, opacity: 0.6, marginBottom: 6 } }, `场景（${scenes.length}）`),
        ...scenes.map(sceneCard),
      ]);

      // ---- 档案视图：左树右预览 ----
      const filesView = h('div', { style: { display: 'flex', height: '100%', minHeight: 0 } }, [
        h('div', { key: 'tree', style: CSS.treePane },
          h(FileTree, {
            roots, activeRoot: fileRoot, files, activePath: file && file.rel,
            onPickRoot: (r) => { setFileRoot(r); setFile(null); },
            onPickFile: pickFile, loading: filesLoading,
          })),
        h('div', { key: 'main', style: CSS.mainPane }, [
          file ? h('div', { key: 'hdr', style: { padding: '6px 12px', fontSize: 11, opacity: 0.65, borderBottom: '1px solid rgba(128,128,128,0.15)' } },
            `${file.rel}  ·  ${fmtKB(file.bytes || 0)}`) : null,
          h('div', { key: 'body', style: CSS.content },
            fileLoading ? h('div', { style: { opacity: 0.6 } }, '读取中…')
              : (file ? (file.error ? h('div', { style: { color: '#b91c1c' } }, '✗ ' + file.error)
                : h(Markdown, { text: file.content }))
                : h('div', { style: { opacity: 0.5, paddingTop: 20, textAlign: 'center' } }, '点左边的文件看内容'))),
        ]),
      ]);

      // ---- 注入视图 ----
      const [inject, setInject] = useState(null);
      useEffect(() => {
        if (tab !== 'inject') return;
        let alive = true;
        (async () => {
          try {
            const d = await api.get(`/inject?id=${encodeURIComponent(activeScene || '')}`);
            if (alive) setInject(d);
          } catch { if (alive) setInject({ error: '读取失败' }); }
        })();
        return () => { alive = false; };
      }, [tab, activeScene]);

      const injectView = inject
        ? (inject.error ? h('div', { style: { color: '#b91c1c' } }, '✗ ' + inject.error)
          : h('div', null, [
            h('div', { key: 'b', style: { fontSize: 12, opacity: 0.7, marginBottom: 8 } },
              `预算 ${inject.budget} 字节 · 实际 ${inject.actual} 字节`),
            h('pre', {
              key: 't',
              style: {
                padding: 10, background: 'rgba(128,128,128,0.08)', borderRadius: 6,
                fontSize: 12, whiteSpace: 'pre-wrap', margin: '0 0 10px',
              },
            }, inject.text || '（空 —— 什么都不注入，这是正确行为）'),
            ...(inject.ledger || []).map((l, i) => h('div', {
              key: 'l' + i,
              style: { display: 'flex', gap: 8, fontSize: 12, padding: '2px 0', opacity: l.injected ? 1 : 0.5 },
            }, [
              h('span', { key: 'm', style: { width: 32, color: l.injected ? '#16a34a' : '#888' } }, l.injected ? '注入' : '跳过'),
              h('span', { key: 'c', style: { width: 90 } }, l.channel),
              h('span', { key: 'by', style: { width: 60, textAlign: 'right' } }, l.bytes + 'B'),
              h('span', { key: 'r', style: { opacity: 0.7, flex: 1 } }, l.reason),
            ]))]))
        : h('div', { style: { opacity: 0.6 } }, '计算中…');

      // ---- 外挂视图 ----
      const capRow = (g, it) => {
        const knob = h('button', {
          key: 't',
          onClick: () => toggleCap(g.group + '.' + it.key, !it.on),
          title: it.on ? '关闭' : '开启',
          style: {
            width: 34, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer',
            background: it.on ? '#16a34a' : 'rgba(128,128,128,0.35)',
            position: 'relative', padding: 0, flex: '0 0 auto',
          },
        }, h('span', {
          style: {
            position: 'absolute', top: 2, left: it.on ? 18 : 2,
            width: 14, height: 14, borderRadius: 99, background: '#fff',
          },
        }));

        return h('div', {
          key: it.key,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 },
        }, [
          knob,
          h('span', { key: 'n', style: { opacity: it.on ? 1 : 0.7 } }, it.label),
          it.cost ? h('span', { key: 'c', style: { fontSize: 11, opacity: 0.5 } }, it.cost) : null,
        ]);
      };

      const capGroup = (g) => {
        const rows = (g.items || []).map((it) => capRow(g, it));
        return h('div', { key: g.group, style: { marginBottom: 14 } }, [
          h('div', { key: 'l', style: { fontWeight: 600, marginBottom: 4 } }, g.label),
          g.note ? h('div', { key: 'n', style: { fontSize: 11, opacity: 0.6, marginBottom: 6 } }, g.note) : null,
          ...rows,
        ]);
      };

      const capView = (caps && caps.groups && caps.groups.length)
        ? h('div', null, caps.groups.map(capGroup))
        : h('div', { style: { opacity: 0.6 } }, '无外挂配置');

      // ---- 组装 ----
      let mainContent;
      if (tab === 'files') mainContent = filesView;
      else if (tab === 'inject') mainContent = h('div', { style: CSS.content }, injectView);
      else if (tab === 'caps') mainContent = h('div', { style: CSS.content }, capView);
      else mainContent = h('div', { style: CSS.content }, overview);

      return h('div', { style: CSS.root }, [
        toolbar,
        tabBar,
        h('div', { key: 'body', style: CSS.body }, mainContent),
        error ? h('div', { key: 'err', style: { padding: '4px 10px', color: '#b91c1c', fontSize: 11, flex: '0 0 auto' } },
          '✗ ' + error) : null,
      ]);
    }

    // ---------- 注册 ----------
    // 两阶段注册（照 ui-sidebar-right README 的 Extension seats）：
    //   ① ctx.sidebarRightTabs.register({ id, kind, title }) —— 声明 tab 类型
    //   ② ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }) —— 声明面板体
    //   两步都要包在 ctx.effect 里，注册寿命 = 插件寿命
    return {
      inject: ['slots'],
      apply(ctx) {
        const TAB_ID = '@local/sea-workbench/workbench';
        const TAB_KIND = 'sea-workbench';

        // ① 类型声明（静态，无运行时 hook）
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => 'sea 工作台',
          keepMounted: true,
        }), 'sea-workbench tab type');

        // ② 面板体（key = 类型 id，契约要求）
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TAB_ID },
          SeaWorkbenchPanel,
        ));

        // ③ 标题（tab chip 文字，可选）
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
          () => React.createElement('span', { style: { fontSize: 12 } }, 'sea 工作台'),
        ));

        // ④ 暴露一个打开入口（如果有 commands 服务）
        if (ctx.commands && typeof ctx.commands.register === 'function') {
          ctx.effect(() => ctx.commands.register({
            id: 'sea-workbench.open',
            title: '打开 sea 工作台',
            run: () => ctx.sidebarRight.openTab(TAB_KIND),
          }), 'sea-workbench open command');
        }
      },
    };
  },
});
