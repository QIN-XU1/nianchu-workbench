import glob, json, os, subprocess, sys

ZSTD = r"D:\file\env\miniconda3\Library\bin\zstd.exe"
ROOT = r"verification\sea-home\sessions"

files = sorted(glob.glob(os.path.join(ROOT, "**", "session.v4.jsonl.zstd"), recursive=True))
files += sorted(glob.glob(os.path.join(ROOT, "**", "session*.jsonl.zstd"), recursive=True))
uniq = sorted(set(files))

print("session files:", len(uniq))

for f in uniq:
    out = subprocess.run([ZSTD, "-d", "-c", f], capture_output=True)
    if out.returncode != 0:
        print("  decompress fail:", f, out.stderr[:200])
        continue
    text = out.stdout.decode("utf-8", errors="replace")
    lines = [l for l in text.split("\n") if l.strip()]
    print("\n===== %s : %d events =====" % (os.path.basename(os.path.dirname(f)), len(lines)))
    for l in lines:
        try:
            ev = json.loads(l)
        except Exception:
            continue
        t = ev.get("type", "")
        if t in ("agent-preset/selected", "session/start", "turn/start", "turn/end",
                 "request/header", "request/context", "system/message"):
            data = ev.get("data", {})
            preview = json.dumps(data, ensure_ascii=False)[:260]
            print("  %-24s %s" % (t, preview))
        elif t == "user/message":
            d = ev.get("data", {})
            blocks = d.get("blocks") or d.get("content") or []
            print("  %-24s %s" % (t, json.dumps(blocks, ensure_ascii=False)[:200]))
        elif t == "assistant/message":
            d = ev.get("data", {})
            msg = d.get("message", {})
            blocks = msg.get("blocks") or []
            texts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
            print("  %-24s %s" % (t, (texts[0] if texts else "")[:160]))
