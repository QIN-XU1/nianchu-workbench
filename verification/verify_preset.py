import glob, json, os, subprocess

Z = r"D:\file\env\miniconda3\Library\bin\zstd.exe"
ROOT = r"verification\sea-home\sessions"

for f in sorted(glob.glob(os.path.join(ROOT, "**", "session*.jsonl.zstd"), recursive=True)):
    out = subprocess.run([Z, "-d", "-c", f], capture_output=True)
    txt = out.stdout.decode("utf-8", "replace")
    evs = []
    for line in txt.split("\n"):
        if line.strip():
            try:
                evs.append(json.loads(line))
            except Exception:
                pass

    has_sel = any((e.get("type") or "") == "agent-preset/selected" for e in evs)
    sys_txt = ""
    for e in evs:
        if e.get("type") == "system/message":
            try:
                sys_txt = e["data"]["message"]["content"][0]["text"]
            except Exception:
                pass
            break

    persona_hit = "数据核对" in sys_txt
    sid = os.path.basename(os.path.dirname(f))[:28]
    print("%-30s preset_selected=%-5s persona_in_prompt=%-5s" % (sid, has_sel, persona_hit))
    if sys_txt:
        print("      prompt head:", sys_txt[:110].replace("\n", " / "))
