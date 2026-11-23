import { useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Page, Empty } from '../components/ui';

interface Msg { id: number; role: 'user' | 'system'; text: string; at: string }

/**
 * 会话 —— 目前是**本地草稿**：能输入、能发、能看见消息流，
 * 但没有后端，所以助手不会回复。页头明确标注这一点，不假装能用。
 */
export default function Session() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const seq = useRef(0);

  const send = () => {
    const v = text.trim();
    if (!v) return;
    seq.current += 1;
    setMsgs((m) => [...m, { id: seq.current, role: 'user', text: v, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }]);
    setText('');
  };

  return (
    <div className="vp-chat">
      <div className="vp-chat__banner">
        本地草稿 · 未接后端
        <span>消息不会离开这台机器，助手也不会回复 —— 后端接入在 S3。</span>
      </div>

      <div className="vp-chat__scroll">
        {msgs.length === 0 ? (
          <Empty
            title="还没有消息"
            detail="在下面输入点什么试试：输入框、发送、消息流都是真的；只是没有后端来回复。"
          />
        ) : (
          msgs.map((m) => (
            <div className={'vp-msg vp-msg--' + m.role} key={m.id}>
              <div className="vp-msg__head">
                <span>{m.role === 'user' ? '你' : '系统'}</span>
                <code>{m.at}</code>
              </div>
              <div className="vp-msg__body">{m.text}</div>
            </div>
          ))
        )}
      </div>

      <div className="vp-composer">
        <textarea
          className="vp-composer__input"
          placeholder="说点什么（Enter 发送，Shift+Enter 换行）"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="vp-composer__bar">
          <span className="vp-composer__hint">未接后端 · 不会真的回复</span>
          <button type="button" className="vp-send" onClick={send} disabled={!text.trim()}>
            <Send size={13} strokeWidth={2} /> 发送
          </button>
        </div>
      </div>
    </div>
  );
}
