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

# 1. edex-ui 的主题（科幻终端的配色系统）
print('=' * 74)
print('edex-ui 主题配色（45k★ 科幻终端）')
print('=' * 74)

try:
    # 它的主题在 src/themes/ 或 settings
    tree = fetch('https://api.github.com/repos/GitSquared/edex-ui/git/trees/master?recursive=1', True)
    files = [t['path'] for t in tree.get('tree', []) if t['type'] == 'blob']
    print('总文件:', len(files))
    print()
    print('主题/样式相关文件:')
    for f in files:
        if any(k in f.lower() for k in ['theme', '.scss', 'palette', 'color']):
            print('  ' + f)
except Exception as e:
    print('FAIL:', str(e)[:100])
