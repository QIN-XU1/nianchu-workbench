/**
 * BitFun 独立 app · 入口组件
 *
 * 复用 vouch-web 里的 BitFunScene 视觉与结构，数据走本地 store。
 */
import { useState } from 'react';
import { bitfunStore, useBitFun } from './store';
import './bitfun.css';

type SceneId =
  | 'home' | 'session' | 'agents' | 'skills' | 'settings' | 'git'
  | 'todos' | 'insights' | 'terminal' | 'browser' | 'pages' | 'miniapps' | 'shell';

const SCENES: { id: SceneId; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: '🏠' },
  { id: 'session', label: 'Session', icon: '🤖' },
  { id: 'agents', label: 'Agents', icon: '👥' },
  { id: 'skills', label: 'Skills', icon: '🧩' },
  { id: 'git', label: 'Git', icon: '🌿' },
  { id: 'todos', label: 'Task Board', icon: '📋' },
  { id: 'insights', label: 'Insights', icon: '📊' },
  { id: 'terminal', label: 'Terminal', icon: '💻' },
  { id: 'browser', label: 'Browser', icon: '🌐' },
  { id: 'pages', label: 'Pages', icon: '📄' },
  { id: 'miniapps', label: 'Mini App', icon: '🧱' },
  { id: 'shell', label: 'Shell', icon: '⌨️' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

export default function App() {
  const state = useBitFun();
  const [scene, setScene] = useState<SceneId>('session');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const active = state.sessions.find((s) => s.id === state.activeId);
  const messages = active?.messages ?? [];

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    try {
      await bitfunStore.send(text);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bitfun" data-bitfun-scene={scene}>
      <aside className="nav">
        <div className="nav__search">
          <div className="search">
            <span>🔍</span>
            <input placeholder="Search sessions" />
            <kbd>⌘K</kbd>
          </div>
        </div>
        <div className="nav__items">
          {SCENES.map((s) => (
            <button key={s.id} className="nav__item" aria-selected={scene === s.id} onClick={() => setScene(s.id)}>
              <span className="ico">{s.icon}</span>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <div className="nav__section">
          <span className="nav__section-title">Sessions</span>
          <span className="muted" style={{ fontSize: 11 }}>{state.sessions.length}</span>
        </div>
        <div className="nav__list">
          {state.sessions.map((s) => (
            <button
              key={s.id}
              className="session"
              aria-selected={state.activeId === s.id}
              onClick={() => { bitfunStore.setActive(s.id); setScene('session'); }}
              title={s.title}
            >
              <span className="av">{(s.title || '?').slice(0, 1).toUpperCase()}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</span>
            </button>
          ))}
        </div>
        <div className="nav__foot">
          <span>念初 · BitFun</span>
          <span className="sp" />
          <span className="muted">standalone</span>
        </div>
      </aside>

      <main className="main">
        <div className="scenebar">
          {SCENES.slice(0, 4).map((s) => (
            <button key={s.id} className="tab" aria-selected={scene === s.id} onClick={() => setScene(s.id)}>
              {s.icon} {s.label}
            </button>
          ))}
          <span className="sp" />
          <span className="muted" style={{ fontSize: 12 }}>{active?.title ?? '未选择会话'}</span>
        </div>

        <div className="view">
          {scene === 'home' && (
            <div className="scroll">
              <div className="page">
                <div className="hero">
                  <div className="mascot"><span className="ant" /><div className="body"><i /><i /></div></div>
                  <h1>让 AI 成为你的一部分</h1>
                </div>
                <div className="stats">
                  <div className="stat"><b>{state.sessions.length}</b><span>会话</span></div>
                  <div className="stat"><b>19</b><span>托管 agents</span></div>
                  <div className="stat"><b>0</b><span>定时任务</span></div>
                  <div className="stat"><b>—</b><span>运行中</span></div>
                  <div className="stat"><b>—</b><span>待确认</span></div>
                </div>
              </div>
            </div>
          )}

          {scene === 'session' && (
            <div className="chatpane">
              <div className="chat">
                <div className="chat-in">
                  {messages.length === 0 && (
                    <div className="empty"><div>开始与念初对话</div></div>
                  )}
                  {messages.map((m) => (
                    <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
                      <div className="who"><span className="nm">{m.role === 'user' ? '你' : '念初'}</span></div>
                      <div className="bubble"><div className="prose" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div></div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="composer">
                <div className="surface">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                    placeholder="给念初发消息…"
                    rows={2}
                  />
                  <div className="row">
                    <span className="sp" />
                    <button className="send" disabled={sending || !draft.trim()} onClick={submit}>
                      {sending ? '发送中…' : '发送'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {scene !== 'home' && scene !== 'session' && (
            <div className="scroll">
              <div className="page">
                <div className="ph"><h1>{SCENES.find((s) => s.id === scene)?.label}</h1></div>
                <div className="empty">
                  <div style={{ fontSize: 28 }}>{SCENES.find((s) => s.id === scene)?.icon}</div>
                  <div>BitFun 场景 · 独立 app 演示</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
