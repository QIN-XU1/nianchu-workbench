"""直接验证 yolo 短路时守卫是否带上 guard_bypassed 标记。"""
import os
import sys

sys.path.insert(0, 'C:/hermes')
os.environ['HERMES_HOME'] = 'C:/Users/15282/AppData/Local/hermes'
os.environ['HERMES_YOLO_MODE'] = '1'      # 让 _yolo_active() 为真

from tools import approval  # noqa: E402

print('\n  _yolo_active() =', approval._yolo_active())

r = approval.check_all_command_guards('rm -rf X:/nope', 'local')
print('\n  check_all_command_guards(rm -rf X:/nope) =')
for k, v in sorted(r.items()):
    print(f'    {k:24s} = {v!r}')

r2 = approval.check_dangerous_command('rm -rf X:/nope', 'local')
print('\n  check_dangerous_command(rm -rf X:/nope) =')
for k, v in sorted(r2.items()):
    print(f'    {k:24s} = {v!r}')
