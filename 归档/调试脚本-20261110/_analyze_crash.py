import json
import pathlib
import collections
from datetime import datetime

ROOT = pathlib.Path(r"D:\file\AI Temp\DeepSeek\Agent自研")
LOG = ROOT / 'workbench' / '外壳' / 'data' / 'crash-log.jsonl'

print("=" * 74)
print("  崩溃日志真实分析")
print("=" * 74)
print()

if not LOG.exists():
    raise SystemExit("崩溃日志不存在")

lines = [l for l in LOG.read_text(encoding='utf-8', errors='replace').split('\n') if l.strip()]
print("总条数: %d" % len(lines))
print()

records = []
bad = 0
for l in lines:
    try:
        records.append(json.loads(l))
    except Exception:
        bad += 1

print("成功解析: %d   解析失败: %d" % (len(records), bad))
print()

# ═══ 1. kind 分布 ═══
print("【1】kind 分布")
kinds = collections.Counter(r.get('kind', 'unknown') for r in records)
for k, v in kinds.most_common():
    print("  %-28s %4d  (%.1f%%)" % (k, v, v / len(records) * 100))
print()

# ═══ 2. 时间分布 ═══
print("【2】按日期分布")
dates = collections.Counter(r.get('at', '')[:10] for r in records if r.get('at'))
for d, v in sorted(dates.items()):
    print("  %s  %4d" % (d, v))
print()

# ═══ 3. 按小时分布（看是否集中在某时段）═══
print("【2b】按小时分布")
hours = collections.Counter(r.get('at', '')[11:13] for r in records if r.get('at') and len(r.get('at', '')) > 13)
for h, v in sorted(hours.items()):
    bar = '#' * min(50, v)
    print("  %s时  %3d  %s" % (h, v, bar))
print()

# ═══ 4. URL 分布 ═══
print("【3】URL 分布")
urls = collections.Counter(r.get('url', '(无)') for r in records)
for u, v in urls.most_common(10):
    print("  %-50s %4d" % (u[:50], v))
print()

# ═══ 5. reason 分布 ═══
print("【4】reason 分布")
reasons = collections.Counter(r.get('reason', '(无)') for r in records)
for k, v in reasons.most_common():
    print("  %-28s %4d" % (k, v))
print()

# ═══ 6. exitCode 分布 ═══
print("【5】exitCode 分布")
codes = collections.Counter(str(r.get('exitCode', '(无)')) for r in records)
for k, v in codes.most_common():
    print("  %-12s %4d" % (k, v))
print()

# ═══ 7. uncaughtException 的具体消息 ═══
print("【6】uncaughtException 消息")
exc = [r for r in records if r.get('kind') == 'uncaughtException']
msgs = collections.Counter(str(r.get('message', r.get('error', '')))[:70] for r in exc)
for k, v in msgs.most_common():
    print("  %-72s %4d" % (k, v))
print()

# ═══ 8. child-process-gone 的详情 ═══
print("【7】child-process-gone 的进程类型")
child = [r for r in records if r.get('kind') == 'child-process-gone']
types = collections.Counter()
for r in child:
    d = r.get('details') or {}
    types[(d.get('type', '?'), d.get('serviceName', '?'))] += 1
for k, v in types.most_common():
    print("  type=%-12s service=%-32s %4d" % (k[0], k[1], v))
print()

# ═══ 9. 时间跨度 ═══
if records:
    ats = sorted(r.get('at', '') for r in records if r.get('at'))
    print("【8】时间跨度")
    print("  最早: %s" % ats[0])
    print("  最晚: %s" % ats[-1])
    t0 = datetime.fromisoformat(ats[0].replace('Z', '+00:00'))
    t1 = datetime.fromisoformat(ats[-1].replace('Z', '+00:00'))
    span_h = (t1 - t0).total_seconds() / 3600
    print("  跨度: %.1f 小时（%.1f 天）" % (span_h, span_h / 24))
    print("  平均: %.1f 次/小时" % (len(records) / span_h) if span_h > 0 else "")
print()

# ═══ 10. 是否有崩溃前的时序模式 ═══
print("【9】相邻崩溃的 kind 组合（看是否有 A 后必 B）")
pairs = collections.Counter()
for i in range(len(records) - 1):
    a = records[i].get('kind', '?')
    b = records[i + 1].get('kind', '?')
    pairs[(a, b)] += 1
for (a, b), v in pairs.most_common(8):
    print("  %-24s → %-24s %4d" % (a, b, v))
