import io, os, subprocess, sys, shutil

base = r"verification\f1-pure-preset\cordis.patch.yml"
src = open(base, 'rb').read().decode('utf-8')

cases = {
    # 反例 1：preset 里引用一个不存在的包
    "bogus-package": src.replace("@deepseek-ai/dsh-tool-todo",
                                 "@deepseek-ai/dsh-tool-THIS-DOES-NOT-EXIST"),
    # 反例 2：preset 里引用一个存在但我们没装的包（experimental）
    "bogus-experimental": src.replace("@deepseek-ai/dsh-tool-todo",
                                      "@deepseek-ai/dsh-experimental-webhook"),
}

for name, text in cases.items():
    assert text != src, f"{name}: replacement did not apply"
    p = f"verification\\f1-{name}.yml"
    with open(p, 'wb') as f:
        f.write(text.encode('utf-8'))
    print(f"wrote {p}  ({len(text.encode('utf-8'))} bytes)")
