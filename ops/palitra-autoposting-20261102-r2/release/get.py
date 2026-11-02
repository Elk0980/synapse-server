#!/usr/bin/env python3
"""Скачать файлы выпуска из GitHub в текущую папку: python3 get.py КОММИТ
Пишет только install.py, bundle.json, diag.py, src.py в текущий каталог. Ничего не устанавливает."""
import sys, urllib.request
ref = sys.argv[1] if len(sys.argv) > 1 else "claude/palitra-onlypult-options"
base = "https://raw.githubusercontent.com/Elk0980/synapse-server/" + ref + "/ops/palitra-autoposting-20261102-r2/release/"
for name in ("install.py", "bundle.json", "diag.py", "src.py", "companies.py"):
    data = urllib.request.urlopen(base + name, timeout=60).read()
    open(name, "wb").write(data)
    print(name, len(data))
