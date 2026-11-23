"""A15 追因：为什么 -z 路径还是放行了？逐个打印提前放行条件。"""

import os
import sys

sys.path.insert(0, 'C:/hermes')
os.environ.setdefault('HERMES_HOME', 'C:/Users/15282/AppData/Local/hermes')

from tools import approval, approval_context  # noqa: E402


def probe(tag):
    print(f'  ── {tag} ──')
    checks = [
        ('_yolo_active()', lambda: approval._yolo_active()),
        ('_get_approval_mode()', lambda: approval_context._get_approval_mode()),
        ('_is_single_query_approval_context()', approval_context._is_single_query_approval_context),
        ('_is_cron_approval_context()', approval_context._is_cron_approval_context),
        ('_is_gateway_approval_context()', approval_context._is_gateway_approval_context),
        ('_is_interactive_cli()', approval_context._is_interactive_cli),
        ('_is_unattended_platform_approval_context()', approval_context._is_unattended_platform_approval_context),
        ('_unattended_contexts() names', lambda: [c.name for c in approval._unattended_contexts()]),
        ('single_query_mode', approval_context._get_single_query_approval_mode),
        ('cron_mode', approval_context._get_cron_approval_mode),
        ('unattended_mode', approval_context._get_unattended_approval_mode),
        ('no_context_mode', approval_context._get_no_context_approval_mode),
        ('_command_matches_permanent_allowlist("rm -rf D:/a15scratch")',
         lambda: approval._command_matches_permanent_allowlist('rm -rf D:/a15scratch')),
        ('_command_findings', lambda: approval._command_findings('rm -rf D:/a15scratch')),
    ]
    for name, fn in checks:
        try:
            print(f'    {name:52s} = {fn()!r}')
        except Exception as e:  # noqa: BLE001
            print(f'    {name:52s} ! {type(e).__name__}: {e}')


print('\n=== A15 追因 ===')
print(f'  ENV HERMES_INTERACTIVE={os.environ.get("HERMES_INTERACTIVE")!r} '
      f'HERMES_EXEC_ASK={os.environ.get("HERMES_EXEC_ASK")!r} '
      f'HERMES_GATEWAY_SESSION={os.environ.get("HERMES_GATEWAY_SESSION")!r}')

probe('干净环境')
