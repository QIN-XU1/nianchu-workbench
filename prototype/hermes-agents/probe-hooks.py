import ast
import sys

path = r'C:/hermes/hermes_cli/plugins.py'
src = open(path, encoding='utf-8').read()
tree = ast.parse(src)

hooks = None
for node in ast.walk(tree):
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == 'VALID_HOOKS':
        if isinstance(node.value, ast.Set):
            hooks = [e.value for e in node.value.elts if isinstance(e, ast.Constant)]
        break

if hooks is None:
    print('  未找到 VALID_HOOKS 集合字面量')
    sys.exit(1)

hooks = sorted(set(hooks))
print(f'  hermes VALID_HOOKS 精确数: {len(hooks)}')
print('')

groups = {
    '会话': lambda n: 'session' in n or n == 'on_session_open',
    '流式': lambda n: 'stream' in n or 'interim' in n,
    '工具': lambda n: 'tool' in n,
    'LLM/API': lambda n: 'llm' in n or 'api_' in n or 'auxiliary' in n,
    '子Agent': lambda n: 'subagent' in n,
    '验证': lambda n: 'verify' in n,
    '网关/入站': lambda n: 'gateway' in n,
    '审批': lambda n: 'approval' in n,
    'Kanban/调度': lambda n: 'kanban' in n or 'curator' in n or 'compaction' in n,
    '人机交互': lambda n: 'human_input' in n or n in ('pre_command', 'pre_transcription'),
    '技能/消息/线程': lambda n: 'skill' in n or 'message' in n or 'thread' in n or 'room_member' in n,
}
seen = set()
for g, pred in groups.items():
    hit = sorted(n for n in hooks if pred(n) and n not in seen)
    seen |= set(hit)
    if hit:
        print(f'  {g:<16} {len(hit):>2} 个: ' + ', '.join(hit))
rest = sorted(set(hooks) - seen)
if rest:
    print(f'  其它            {len(rest):>2} 个: ' + ', '.join(rest))

orca = ['on_session_start', 'pre_llm_call', 'post_llm_call', 'pre_tool_call', 'post_tool_call',
        'pre_approval_request', 'post_approval_response', 'on_session_end', 'on_session_finalize',
        'on_session_reset']
missing = [h for h in orca if h not in hooks]
print('')
print('  Orca 用到的 10 个是否都有效: ' + ('是' if not missing else '否 → ' + ', '.join(missing)))
unused = sorted(set(hooks) - set(orca))
print(f'  Orca 未使用的 hook: {len(unused)} 个（含流式 {sum(1 for n in unused if "stream" in n)} 个、子Agent {sum(1 for n in unused if "subagent" in n)} 个）')
