import glob, json, os, subprocess

Z = r"D:\file\env\miniconda3\Library\bin\zstd.exe"
ROOT = r"verification\sea-home\sessions"

for f in sorted(glob.glob(os.path.join(ROOT, "**", "session*.jsonl.zstd"), recursive=True)):
    out = subprocess.run([Z, "-d", "-c", f], capture_output=True)
    txt = out.stdout.decode("utf-8", "replace")
    types = []
    preset_ev = []
    sys_first = None
    for l in txt.split("\n"):
        if not l.strip():
            continue
        try:
            ev = json.loads(l)
        except Exception:
            continue
        t = ev.get("type")
        types.append(t)
        if t and ("preset" in t or "agent-preset" in t):
            preset_ev.append(json.dumps(ev, ensure_ascii=False)[:300])
        if t == "system/message" and sys_first is None:
            try:
                sys_first = ev["data"]["message"]["content"][0]["text"][:150]
            except Exception:
                pass
    sid = os.path.basename(os.path.dirname(f))[:26]
    print("\n=== %s ===" % sid)
    print("  types:", sorted(set(types)))
    print("  system head:", (sys_first or "")[:150].replace("\n", " / "))
    if preset_ev:
        for p in preset_ev[:3]:
            print("  PRESET EVENT:", p)
    else:
        print("  PRESET EVENT: (none)")
