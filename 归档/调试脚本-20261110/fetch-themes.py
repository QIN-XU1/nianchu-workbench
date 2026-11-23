import urllib.request, json, ssl

PROXY = 'http://127.0.0.1:7897'
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def fetch(url, is_json=False):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    op = urllib.request.build_opener(
        urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY}),
        urllib.request.HTTPSHandler(context=ctx),
    )
    with op.open(req, timeout=30) as r:
        data = r.read().decode('utf-8', errors='replace')
        return json.loads(data) if is_json else data

THEMES = ['navy', 'apollo', 'blade', 'interstellar', 'nord', 'matrix', 'cyborg']

print('=' * 76)
print('edex-ui 主题的真实配色结构')
print('=' * 76)

for t in THEMES[:4]:
    try:
        j = fetch('https://raw.githubusercontent.com/GitSquared/edex-ui/master/src/assets/themes/%s.json' % t, True)
        print()
        print('--- %s ---' % t)
        print(json.dumps(j, ensure_ascii=False, indent=2)[:700])
    except Exception as e:
        print()
        print('%s FAIL: %s' % (t, str(e)[:70]))
