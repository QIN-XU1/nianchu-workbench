import sqlite3

DB = 'C:/Users/15282/AppData/Local/hermes/state.db'
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

print('\n=== 最近 3 条 terminal 工具结果（原样前 700 字）===')
rows = cur.execute(
    "select session_id, content from messages where tool_name='terminal' order by id desc limit 3"
).fetchall()
for r in rows:
    c = r['content'] or ''
    print(f'\n  ── {r["session_id"][:26]}… len={len(c)} ──')
    print('  ' + c[:700].replace('\n', '\n  '))

print('\n=== 全库搜 AUDIT / bypassed ===')
for kw in ('AUDIT', 'bypassed', 'unreviewed'):
    n = cur.execute(
        "select count(*) from messages where content like ?", (f'%{kw}%',)).fetchone()[0]
    print(f'  {kw:12s} {n} 条')
con.close()
