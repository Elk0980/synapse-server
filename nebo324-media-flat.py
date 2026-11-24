#!/usr/bin/env python3
"""Copy the approved Nebo media set to the existing flat public media root."""
from pathlib import Path
import os
import shutil
import stat
import sys

source = Path('/tmp/nebo324/release-nebo324')
target = Path('/var/lib/docker/volumes/synapse_content_data/_data/nebo-project-20261020/static/tour-media')
reference = target / 'clouds-desktop.mp4'

if not source.is_dir() or not target.is_dir() or not reference.is_file():
    raise SystemExit('REQUIRED_SOURCE_OR_TARGET_MISSING')

mode = stat.S_IMODE(reference.stat().st_mode)
items = []
for directory, prefix, suffix in ((source / 'img', 'n24-img-', '.jpg'), (source / 'v', 'n24-v-', '.mp4')):
    files = sorted(directory.glob(f'*{suffix}'))
    if not files:
        raise SystemExit(f'NO_SOURCE_FILES:{directory}')
    items.extend((item, target / f'{prefix}{item.name}') for item in files)

existing = [str(destination) for _, destination in items if destination.exists()]
if existing:
    raise SystemExit('REFUSE_OVERWRITE:' + ','.join(existing))

for item, destination in items:
    shutil.copy2(item, destination)
    os.chmod(destination, mode)

wrong = [str(destination) for _, destination in items if stat.S_IMODE(destination.stat().st_mode) != mode]
if wrong:
    raise SystemExit('MODE_MISMATCH:' + ','.join(wrong))
print(f'COPIED={len(items)} MODE={mode:04o} TARGET={target}')
