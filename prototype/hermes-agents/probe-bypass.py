import json
import sqlite3

DB = 'C:/Users/15282/AppData/Local/hermes/state.db'
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

# 找最近包含 a15-q 的会话
rows = cur.execute(
    "select session_id from messages where content like '%a15-q%' order by id desc limit 1"
).fetchall()
if not rows:
    print('没有找到 a15-q 会话')
    raise SystemExit
sid = rows[0]['session_id']
print(f'\n=== 会话 {sid[:28]}… 的完整工具序列 ===')

msgs = cur.execute(
    "select role, tool_name, content, tool_calls from messages where session_id=? order by id", (sid,)
).fetchall()
for m in msgs:
    tc = m['tool_calls']
    if tc:
        try:
            calls = json.loads(tc)
        except Exception:
            calls = []
        for c in (calls if isinstance(calls, list) else []):
            fn = (c or {}).get('function') or {}
            name = fn.get('name')
            args = str(fn.get('arguments'))
            print(f'  → {name}: {args[:240]}')
    tn = m['tool_name']
    if tn:
        body = (m['content'] or '').replace('\n', ' ')
        print(f'    [{tn}] {body[:200]}')
con.close()
