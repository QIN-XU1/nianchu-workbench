/**
 * BitFun 全量复刻 · vouch-web 场景
 *
 * 这是「真正的软件」：BitFun 的视觉与交互，接的是念初的真实会话数据
 * （useApp → appManager）。左侧会话列表、会话内消息、发送都走真实 agent。
 *
 * 场景清单来自 SCENE_TAB_REGISTRY（vouch-web 的实际场景表）。
 */
import { useMemo, useState } from 'react';
import { useApp } from '../../hooks/useApp';
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

function initials(s: string): string {
  return (s || '?').slice(0, 1).toUpperCase();
}

export default function BitFunScene() {
  const { state, sendMessage } = useApp();
  const [scene, setScene] = useState<SceneId>('home');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const sessions = state.chatSessions ?? [];
  const active = state.activeChatSession;

  const messages = useMemo(() => active?.messages ?? [], [active]);

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    try {
      await sendMessage(text);
    } catch {
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="bitfun" data-bitfun-scene={scene}>
      {/* ── 侧栏 ── */}
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
            <button
              key={s.id}
              className="nav__item"
              aria-selected={scene === s.id}
              onClick={() => setScene(s.id)}
            >
              <span className="ico">{s.icon}</span>
              <span>{s.label}</span>
            </button>
          ))}
        </div>

        <div className="nav__section">
          <span className="nav__section-title">Sessions</span>
          <span className="muted" style={{ fontSize: 11 }}>{sessions.length}</span>
        </div>
        <div className="nav__list">
          {sessions.length === 0 && (
            <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>暂无会话</div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              className="session"
              aria-selected={active?.id === s.id}
              onClick={() => { setScene('session'); }}
              title={s.title || s.id}
            >
              <span className="av">{initials(s.title || s.id)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title || s.id}</span>
            </button>
          ))}
        </div>

        <div className="nav__foot">
          <span>念初 · BitFun</span>
          <span className="sp" />
          <span className="muted">{state.currentAgent?.name ?? 'agent'}</span>
        </div>
      </aside>

      {/* ── 主区 ── */}
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
          {scene === 'home' && <HomeView sessions={sessions.length} />}
          {scene === 'session' && (
            <SessionView
              messages={messages}
              draft={draft}
              setDraft={setDraft}
              onSubmit={submit}
              sending={sending}
              hasActive={!!active}
            />
          )}
          {scene !== 'home' && scene !== 'session' && (
            <div className="scroll">
              <div className="page">
                <div className="ph"><h1>{SCENES.find((s) => s.id === scene)?.label}</h1></div>
                <div className="empty">
                  <div style={{ fontSize: 28 }}>{SCENES.find((s) => s.id === scene)?.icon}</div>
                  <div>该场景为 BitFun 设计稿，真实数据待接入</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function HomeView({ sessions }: { sessions: number }) {
  return (
    <div className="scroll">
      <div className="page">
        <div className="hero">
          <div className="mascot">
            <span className="ant" />
            <div className="body"><i /><i /></div>
          </div>
          <h1>让 AI 成为你的一部分</h1>
        </div>
        <div className="stats">
          <div className="stat"><b>{sessions}</b><span>会话</span></div>
          <div className="stat"><b>19</b><span>托管 agents</span></div>
          <div className="stat"><b>0</b><span>定时任务</span></div>
          <div className="stat"><b>—</b><span>运行中</span></div>
          <div className="stat"><b>—</b><span>待确认</span></div>
        </div>
      </div>
    </div>
  );
}

function SessionView(props: {
  messages: { id?: string; role?: string; content?: string }[];
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  sending: boolean;
  hasActive: boolean;
}) {
  const { messages, draft, setDraft, onSubmit, sending, hasActive } = props;
  return (
    <div className="chatpane">
      <div className="chat">
        <div className="chat-in">
          {messages.length === 0 && (
            <div className="empty">
              <div>开始与念初对话</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {hasActive ? '在下方输入框发送消息' : '先在左侧选择或新建会话'}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={m.id ?? i} className={`msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
              <div className="who">
                <span className="nm">{m.role === 'user' ? '你' : '念初'}</span>
              </div>
              <div className="bubble">
                <div className="prose" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="composer">
        <div className="surface">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
            }}
            placeholder={hasActive ? '给念初发消息…' : '先选择会话'}
            rows={2}
          />
          <div className="row">
            <span className="sp" />
            <button className="send" disabled={sending || !draft.trim()} onClick={onSubmit}>
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
