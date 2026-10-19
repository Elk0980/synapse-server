"""Read-only completed-R3 inspection with its historical supplement from PARENT.

The installed R3 helper and its Release.inspect remain byte-for-byte unchanged.
Its loader incorrectly checked the old bot config against the current child.
This separate, reviewable loader reads that historical byte from the immutable
parent; Release.inspect still checks the full current child map and receipt.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import types

CODE = Path('/opt/synapse/releases/palitra-app-20261015/multi-company-app-20261019-r3-code')
HELPER_SHA = '13d967286f9858b282a36b52c65e2ef4cf5fcb725de928915fc2c1eecf184616'
sha = lambda raw: hashlib.sha256(raw).hexdigest()


def completed_loader_source(raw):
    if sha(raw) != HELPER_SHA:
        raise ValueError('EXACT_UNMODIFIED_R3_HELPER_REQUIRED')
    source = raw.decode('utf-8')
    node, = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'load36']
    loader = ast.get_source_segment(source, node)
    before = 'b.photo.hashes(supplemental) == supplemental'
    if loader.count(before) != 1:
        raise ValueError('EXACT_SINGLE_HISTORICAL_READ_REQUIRED')
    return loader.replace(before, 'b.photo.hashes(supplemental, PARENT) == supplemental')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lease-pid', type=int, required=True)
    parser.add_argument('--receipt-sha', required=True)
    args = parser.parse_args()
    try:
        if os.name != 'posix' or os.geteuid() != 0:
            raise ValueError('POSIX_ROOT_RECEIVER_REQUIRED')
        if args.lease_pid <= 1 or args.lease_pid in (3031696, 3015977) or not re.fullmatch('[0-9a-f]{64}', args.receipt_sha):
            raise ValueError('EXPLICIT_FRESH_LEASE_AND_OWN_RECEIPT_REQUIRED')
        helper = CODE / 'release-native.py'
        if any(p.is_symlink() for p in [*helper.parents, helper]):
            raise ValueError('HELPER_SYMLINK_REFUSED')
        raw = helper.read_bytes()
        loader = completed_loader_source(raw)
        module = types.ModuleType('exact_unmodified_r3_readonly')
        module.__file__ = str(helper)
        exec(compile(raw, str(helper), 'exec'), module.__dict__)
        namespace = dict(module.__dict__)
        exec(compile(loader, str(Path(__file__).resolve()), 'exec'), namespace)
        a, b, prior, current = namespace['load36'](args.lease_pid)
        result = module.Release(a, b, prior, current, args.lease_pid).inspect(args.receipt_sha)
        result['inspector'] = 'READONLY_R3_HISTORICAL_SUPPLEMENT_FROM_IMMUTABLE_PARENT'
        result['originalHelperUnchanged'] = sha(helper.read_bytes()) == HELPER_SHA
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except Exception as error:
        print(json.dumps({'status': 'READONLY_INSPECTOR_REFUSED', 'messageSha256': sha(str(error).encode()), 'runtimeWrites': 0}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
