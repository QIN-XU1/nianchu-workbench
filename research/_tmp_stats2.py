# -*- coding: utf-8 -*-
import json, glob, os, collections, urllib.request
p = r'D:\file\AI Temp\DeepSeek\Agent自研\research\raw\vcp-tree.json'
d = json.load(open(p, encoding='utf-8-sig'))
t = d['tree']
mani = [x['path'] for x in t if x['path'].startswith('Plugin/') and 'plugin-manifest' in x['path']]
print('manifests', len(mani))
# fetch a sample of manifests to compute type distribution? too many; instead use docs category counts
print('dirs', len(set(m.split('/')[1] for m in mani)))
# check root docs cross-ref existence
docs = set(x['path'] for x in t if x['path'].startswith('docs/'))
refs = ['docs/TagMemo_Wave_Algorithm_Deep_Dive.md', 'docs/TDB_COLD_KNOWLEDGE_BASE.md',
        'docs/FRONTEND_COMPONENTS.md', 'docs/FILE_INVENTORY.md', 'docs/SEMANTIC_MODEL_ROUTER.md',
        'docs/ARCHITECTURE.md', 'docs/RIVERMEMO_TOPOLOGY_V3.md', 'docs/AGENT_AND_TASK_SYSTEM_GUIDE.md']
for r in refs:
    print(r, r in docs)
# code files referenced by MEMORY_SYSTEM appendix
for f in ['EPAModule.js', 'ResidualPyramid.js', 'TextChunker.js', 'EmbeddingUtils.js', 'ResultDeduplicator.js', 'TagMemoEngine.js', 'RiverMemoEngine.js', 'TDBKnowledge.js']:
    print(f, f in set(x['path'] for x in t))
# which docs exist for plugin ecosystem referenced
print([x for x in docs if x.endswith('.md')][:5])
