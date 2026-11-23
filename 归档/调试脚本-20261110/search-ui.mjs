import urllib.request, json, ssl

PROXY = 'http://127.0.0.1:7897'
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def gh(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/vnd.github+json',
    })
    # 代理
    op = urllib.request.build_opener(
        urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY}),
        urllib.request.HTTPSHandler(context=ctx),
    )
    with op.open(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))

QUERIES = [
    ('终端风格 UI', 'terminal+ui+stars:>2000'),
    ('高密度仪表盘', 'dashboard+design+stars:>3000'),
    ('设计系统令牌', 'design+tokens+stars:>1500'),
    ('命令面板', 'command+palette+stars:>2000'),
    ('Electron 工作台', 'electron+dashboard+stars:>1000'),
    ('监控面板', 'monitoring+panel+stars:>2000'),
]

for label, q in QUERIES:
    print('=' * 70)
    print(label, ' | ', q)
    print('=' * 70)
    try:
        j = gh('https://api.github.com/search/repositories?q=%s&sort=stars&per_page=6' % q)
        for it in j.get('items', []):
            desc = (it.get('description') or '')[:80]
            print('  %6d★  %-42s  %s' % (it['stargazers_count'], it['full_name'], desc))
    except Exception as e:
        print('  FAIL:', str(e)[:100])
    print()
