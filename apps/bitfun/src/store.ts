/**
 * BitFun 独立 app · 会话 store（真实念初/DSH agent）
 *
 * send() 走 POST /api/chat（SSE 流式），服务端 spawn dsh headless。
 * - 发送消息 → 真实回复（流式增量）
 * - sessionId → 会话持久化（--session-id 恢复）
 */
import { useSyncExternalStore } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
}

export interface BitFunState {
  sessions: ChatSession[];
  activeId: string | null;
}

let nextId = 1;
const uid = (p: string) => `${p}-${nextId++}`;

let state: BitFunState = {
  sessions: [
    {
      id: 'demo-1',
      title: '欢迎使用 BitFun',
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          content: '你好，我是念初。这是独立运行的 BitFun 界面——左侧是会话，中间是对话。发一条消息，会通过 `dsh headless` 真实 agent 回复。',
        },
      ],
    },
  ],
  activeId: 'demo-1',
};

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

function patchMessage(sessionId: string, msg: ChatMessage) {
  state = {
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === sessionId
        ? { ...s, messages: s.messages.map((m) => (m.id === msg.id ? msg : m)) }
        : s,
    ),
  };
  emit();
}

export const bitfunStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  getSnapshot(): BitFunState {
    return state;
  },
  setActive(id: string) {
    state = { ...state, activeId: id };
    emit();
  },
  createSession(title = '新会话'): string {
    const id = uid('s');
    state = {
      ...state,
      sessions: [{ id, title, messages: [] }, ...state.sessions],
      activeId: id,
    };
    emit();
    return id;
  },
  async send(text: string) {
    const session = state.sessions.find((s) => s.id === state.activeId);
    if (!session) return;
    const sessionId = session.id;

    // 1. 追加用户消息
    const userMsg: ChatMessage = { id: uid('m'), role: 'user', content: text };
    state = {
      ...state,
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [...s.messages, userMsg] } : s,
      ),
    };
    emit();

    // 2. 创建流式 assistant 占位
    const replyId = uid('m');
    const reply: ChatMessage = { id: replyId, role: 'assistant', content: '' };
    state = {
      ...state,
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [...s.messages, reply] } : s,
      ),
    };
    emit();

    // 3. 真实 agent（SSE 流式）
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let textAcc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const line = block.replace(/^data:\s*/, '').trim();
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'session' && typeof ev.sessionId === 'string') {
              // 首次对话：把本地会话 id 换成真实 DSH 会话 id（持久化）
              const realId = ev.sessionId;
              if (realId !== sessionId) {
                state = {
                  ...state,
                  sessions: state.sessions.map((s) =>
                    s.id === sessionId ? { ...s, id: realId } : s,
                  ),
                  activeId: realId,
                };
                sessionId = realId;
                emit();
              }
            } else if (ev.type === 'text' && typeof ev.text === 'string') {
              textAcc += ev.text;
              patchMessage(sessionId, { ...reply, content: textAcc });
            } else if (ev.type === 'error') {
              throw new Error(ev.message || 'agent error');
            }
          } catch {
            /* skip non-json */
          }
        }
      }
      if (!textAcc) patchMessage(sessionId, { ...reply, content: '（无回复）' });
    } catch (e) {
      patchMessage(sessionId, {
        ...reply,
        content: `⚠️ 请求失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
};

export function useBitFun() {
  return useSyncExternalStore(
    bitfunStore.subscribe,
    bitfunStore.getSnapshot,
    bitfunStore.getSnapshot,
  );
}
