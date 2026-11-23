# -*- coding: utf-8 -*-
import json, collections, os
p = r'D:\file\AI Temp\DeepSeek\Agent自研\research\raw\vcp-tree.json'
d = json.load(open(p, encoding='utf-8-sig'))
t = d['tree']
paths = {x['path']: x for x in t}
for pre in ['modules', 'routes', 'tests', 'shared', 'rust-vexus-lite', 'Agent', 'TVStxt', 'config', 'scripts', 'knowledge']:
    print('=' * 12, pre)
    for q in sorted(paths):
        if q.startswith(pre + '/') and q.count('/') <= 1:
            x = paths[q]
            print('  %-58s %s' % (q, x.get('size', '-')))

print('=' * 12, 'root files')
for q in sorted(paths):
    if '/' not in q:
        print('  %-50s %s' % (q, paths[q].get('size', '-')))

for ext in ['.js', '.py', '.rs', '.md', '.vue', '.ts', '.json']:
    sel = [x for q, x in paths.items() if q.endswith(ext)]
    print(ext, 'count', len(sel), 'bytes', sum(x.get('size', 0) for x in sel),
          'median', sorted(x.get('size', 0) for x in sel)[len(sel)//2] if sel else 0)

plugins = sorted(set(q.split('/')[1] for q in paths if q.startswith('Plugin/') and q.count('/') >= 2))
print('plugin dirs', len(plugins))
print('manifests', sum(1 for q in paths if q.startswith('Plugin/') and q.endswith('plugin-manifest.json')))
print('tests', sum(1 for q in paths if q.startswith('tests/')))
for q in sorted(paths):
    if q.startswith('tests/'):
        print('  T', q, paths[q].get('size'))
print('=' * 12, 'docs')
for q in sorted(paths):
    if q.startswith('docs/') and q.endswith('.md'):
        print('  D %-60s %s' % (q, paths[q].get('size')))
print('=' * 12, 'top 30 largest js')
js = sorted(((x.get('size', 0), q) for q, x in paths.items() if q.endswith('.js')), reverse=True)[:30]
for s, q in js:
    print('  %8d %s' % (s, q))
print('=' * 12, 'dirs of modules recursive')
for q in sorted(paths):
    if q.startswith('modules/') and q.endswith('.js'):
        print('  M %-60s %s' % (q, paths[q].get('size')))
