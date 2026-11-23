# -*- coding: utf-8 -*-
import json, urllib.request, collections, re, sys

base = 'https://raw.githubusercontent.com/lioensky/VCPToolBox/main/'
tree = json.load(open(r'D:\file\AI Temp\DeepSeek\Agent自研\research\raw\vcp-tree.json', encoding='utf-8-sig'))['tree']
paths = [x['path'] for x in tree]
mani = [p for p in paths if p.startswith('Plugin/') and p.endswith('plugin-manifest.json')]
types = collections.Counter()
admins = 0
bridges = 0
cron = 0
fails = []
for p in mani:
    try:
        req = urllib.request.Request(base + urllib.parse.quote(p), headers={'User-Agent': 'x'})
        raw = urllib.request.urlopen(req, timeout=30).read().decode('utf-8')
        j = json.loads(raw)
        types[j.get('pluginType')] += 1
        admins += 1 if j.get('requiresAdmin') else 0
        bridges += 1 if j.get('requiresContextBridge') else 0
        cron += 1 if j.get('refreshIntervalCron') else 0
    except Exception as e:
        fails.append((p, str(e)[:60]))
print('manifest count', len(mani))
print('types', types)
print('requiresAdmin', admins, 'requiresContextBridge', bridges, 'cron', cron)
print('fails', len(fails), fails[:5])
