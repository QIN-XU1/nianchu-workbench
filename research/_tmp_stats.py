# -*- coding: utf-8 -*-
import json
p = r'D:\file\AI Temp\DeepSeek\Agent自研\research\raw\vcp-tree.json'
d = json.load(open(p, encoding='utf-8-sig'))
t = d['tree']

def total(sel):
    return len(sel), sum(x.get('size') or 0 for x in sel)

allf = t
print('entries', len(allf), 'bytes', sum(x.get('size') or 0 for x in allf))
sel = [x for x in allf if x['path'].startswith('tests/')]
print('tests', total(sel), 'median', sorted((x.get('size') or 0) for x in sel)[len(sel)//2])
sel = [x for x in allf if x['path'].endswith('.js') and not x['path'].startswith('AdminPanel-Vue/') and '/vendor/' not in x['path'] and x['path'].startswith('Plugin/')]
print('plugin js', total(sel))
sel = [x for x in allf if x['path'].endswith(('.js', '.rs', '.py')) and not x['path'].startswith('AdminPanel-Vue/') and '/vendor/' not in x['path'] and not x['path'].startswith('tests/')]
print('first-party code', total(sel))
sel = [x for x in allf if x['path'].startswith('docs/') and x['path'].endswith('.md')]
print('docs md', total(sel))
sel = [x for x in allf if x['path'].startswith('Plugin/') and x['path'].endswith('plugin-manifest.json')]
print('active manifests', len(sel))
sel = [x for x in allf if x['path'].startswith('Plugin/') and x['path'].endswith('plugin-manifest.json.block')]
print('blocked manifests', len(sel), [x['path'] for x in sel])
# top-level code file line estimate
for q in ['server.js', 'Plugin.js', 'KnowledgeBaseManager.js', 'adminServer.js', 'WebSocketServer.js', 'RiverMemoEngine.js', 'TagMemoEngine.js', 'TDBKnowledge.js']:
    x = [y for y in allf if y['path'] == q]
    print(q, x[0].get('size') if x else None)
# images/docs weight
img = [x for x in allf if x['path'].endswith(('.png', '.jpg', '.jpeg', '.gif'))]
print('images', total(img))
bin = [x for x in allf if x['path'].endswith(('.exe', '.node'))]
print('binaries', total(bin))
