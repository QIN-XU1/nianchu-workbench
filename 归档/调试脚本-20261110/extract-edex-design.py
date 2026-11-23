import urllib.request, json, ssl, pathlib

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

OUT = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研\research\ui-refs")
OUT.mkdir(parents=True, exist_ok=True)

THEMES = ['navy', 'apollo', 'blade', 'interstellar', 'nord', 'matrix',
          'cyborg', 'tron', 'chalkboard', 'red', 'navy-disrupted']

all_themes = {}
for t in THEMES:
    try:
        j = fetch('https://raw.githubusercontent.com/GitSquared/edex-ui/master/src/assets/themes/%s.json' % t, True)
        all_themes[t] = j
        c = j.get('colors', {})
        print('%-22s r=%3d g=%3d b=%3d  black=%-8s grey=%-8s blue=%-8s cyan=%-8s' % (
            t, c.get('r', 0), c.get('g', 0), c.get('b', 0),
            c.get('black', '?'), c.get('grey', '?'),
            c.get('blue', '?'), c.get('cyan', '?')))
    except Exception as e:
        print('%-22s FAIL %s' % (t, str(e)[:40]))

(OUT / 'edex-ui-themes.json').write_text(
    json.dumps(all_themes, ensure_ascii=False, indent=2), encoding='utf-8')
print()
print('已保存 research/ui-refs/edex-ui-themes.json  (%d 个主题)' % len(all_themes))

# ═══════ 提取设计规律 ═══════
print()
print('=' * 72)
print('edex-ui 配色的设计规律（这是"终端美学"的真相）')
print('=' * 72)

# 统计所有主题共有的键
keysets = [set(v.get('colors', {}).keys()) for v in all_themes.values()]
common = set.intersection(*keysets) if keysets else set()
print()
print('所有主题都有的颜色键（%d 个）:' % len(common))
print('  ' + ', '.join(sorted(common)))

# 看 terminal 配置
print()
print('终端配置（第一个主题）:')
first = list(all_themes.values())[0]
print(json.dumps(first.get('terminal', {}), ensure_ascii=False, indent=2)[:400])

# cssvars
print()
print('CSS 变量（第一个主题）:')
print(json.dumps(first.get('cssvars', {}), ensure_ascii=False, indent=2)[:400])
