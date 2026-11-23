import json
import sqlite3
import sys

DB = 'C:/Users/15282/AppData/Local/hermes/state.db'
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

print('\n=== 最近 4 个会话里用到的工具 ===')
sid_rows = cur.execute(
    "select session_id, max(timestamp) as t from messages group by session_id order by t desc limit 4"
).fetchall()
for sr in sid_rows:
    sid = sr['session_id']
    print(f'\n  ── {sid[:34]}… ({sr["t"]}) ──')
    rows = cur.execute(
        "select role, tool_name, content, tool_calls from messages "
        "where session_id=? order by id", (sid,)
    ).fetchall()
    for r in rows:
        tn = r['tool_name']
        tc = r['tool_calls']
        if tn:
            body = (r['content'] or '')[:160].replace('\n', ' ')
            print(f'    tool_result[{tn}] {body}')
        elif tc:
            try:
                calls = json.loads(tc)
            except Exception:
                calls = []
            for c in calls if isinstance(calls, list) else []:
                fn = (c or {}).get('function') or {}
                print(f'    tool_call → {fn.get("name")}  args={str(fn.get("arguments"))[:170]}')
        elif r['role'] == 'user':
            print(f'    user: {(r["content"] or "")[:120]}')

print('\n=== tool_name 频次（全库）===')
for r in cur.execute("select tool_name, count(*) c from messages where tool_name is not null group by tool_name order by c desc limit 12"):
    print(f'  {str(r["tool_name"]):22s} {r["c"]}')
con.close()
