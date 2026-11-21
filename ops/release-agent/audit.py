"""Offline inventory of a PRIVATE full filesystem snapshot, never a live checkout.

No content is printed. Classification is a proposal, not permission to delete,
publish or reset. Snapshot and report must remain outside the public repository.
"""
import argparse
import hashlib
from pathlib import Path
import subprocess
from agent import atomic, need


def inventory(snapshot):
    root = Path(snapshot).resolve()
    need((root / '.git').exists(), 'FULL_SNAPSHOT_REQUIRED')
    result = subprocess.run(['git', '-C', str(root), 'status', '--porcelain=v1', '-z',
                             '--untracked-files=all'], capture_output=True, check=True)
    parts = result.stdout.split(b'\0')
    rows = []
    while parts:
        entry = parts.pop(0)
        if not entry:
            continue
        status, name = entry[:2].decode(), entry[3:].decode('utf-8')
        old = None
        if 'R' in status or 'C' in status:
            old = parts.pop(0).decode('utf-8')
        path = root / name
        need(path.resolve().is_relative_to(root), 'PATH_ESCAPE')
        private = (name.startswith(('.env', 'releases/', 'data/', 'output/')) or
                   any(word in name.lower() for word in ('secret', 'token', 'backup', '.sqlite', '.pem')))
        row = {'path': name, 'status': status, 'previousPath': old,
               'proposal': 'private-layer-review' if private else 'source-review',
               'decision': 'pending', 'symlink': path.is_symlink()}
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                row['sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
        rows.append(row)
    return {'snapshot': str(root), 'entries': rows, 'total': len(rows), 'approved': False,
            'policy': 'No reset/stash/deletion; preserve snapshot and reconcile every entry.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--snapshot', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    need(not Path(args.report).resolve().is_relative_to(Path(args.snapshot).resolve()), 'REPORT_OUTSIDE_SNAPSHOT')
    atomic(args.report, inventory(args.snapshot))
    print('PRIVATE_INVENTORY_SAVED')
