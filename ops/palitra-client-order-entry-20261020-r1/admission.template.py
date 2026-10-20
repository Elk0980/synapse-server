"""Disabled template. Separate Root review enables one pinned admission, never up."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from datetime import datetime

ACTUAL_PID = None
PREFLIGHT_SHA = None
EXPIRES_AT_UTC = None
NONCE = None
ROOT_RUNTIME_REVIEW_SHA = None
ROOT_ACCEPTANCE_SHA = None

ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
NAME = 'palitra-client-order-entry-20261020-r1'
CODE = ROOT / (NAME + '-code')
MANIFEST_SHA = '2b4469cd2444ec5a6a276efad592ac4fa2e892b2f977756132bf8db1bd4bd553'
ENTRY_SHA = 'c122a3952eefa2e305eb49b0eb20a5ef18b1181185d15f06cd51a3f1980c3c8b'
CODE_ACCEPTANCE_SHA = '3c1442523892785a141564089b54903b4ff20291408becddf26aff9aabf372ff'
BASIS_SHA = 'a846136b3a12060b11450050dc39cf1e73a715761511de7b63957fa9464a3530'
PARENT = 'sha256:0d8a86b8ace8ea919c389aa07cef2ce71e527fd618f2e7acf290c6b2ede9032c'
SCOPE_SHA = '8727be13a09e9b5b01df84443e5a677f06409630767dbeaf5fcdba75c078e526'
UI_REVIEW_SHA = '2a1a411341b54855f588df26ad932c94dbbd3cc2cd2cacfed371375c6983d427'
HTML_REVIEW_SHA = '46d69e15fa0237f875afefd810b773b51fb542e8caf7ecb516faaf7810de1869'
LOCK = '/opt/synapse/.palitra-app-release.lock'


def need(ok, code):
    if not ok:
        raise ValueError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    return type(value) is str and re.fullmatch('[a-f0-9]{64}', value) is not None


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def private_read(path):
    for p in [path, *path.parents]:
        need(not p.is_symlink(), 'ADMISSION_ALIAS_REFUSED')
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid == s.st_gid == 0 and s.st_nlink == 1
         and stat.S_IMODE(s.st_mode) == 0o600 and s.st_size <= 32 * 1024 * 1024, 'PRIVATE_BOUNDED_ADMISSION_FILE_REQUIRED')
    raw = path.read_bytes()
    z = path.lstat()
    need(all(getattr(s, k) == getattr(z, k) for k in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')), 'ADMISSION_FILE_CHANGED_DURING_READ')
    return raw


def lease():
    need(type(ACTUAL_PID) is int and ACTUAL_PID > 1 and ACTUAL_PID not in (3161783, 3196874, 3200094, 3202295, 3204327, 3205870, 3207300, 3208973, 3210573, 3213993, 3215428, 3221971, 3222059, 3231260, 3239627), 'FRESH_ACTUAL_ADMISSION_PID_REQUIRED')
    output = subprocess.check_output(['lslocks', '--noheadings', '--output', 'PID,PATH'], timeout=30)
    rows = [line.strip().split(maxsplit=1) for line in output.decode().splitlines()]
    need([r for r in rows if len(r) == 2 and r[1] == LOCK] == [[str(ACTUAL_PID), LOCK]], 'EXACT_NEW_OWN_LEASE_REQUIRED')


def candidate():
    need(digest(PREFLIGHT_SHA) and type(NONCE) is str and re.fullmatch('[a-f0-9]{32}', NONCE), 'DISABLED_ADMISSION_TEMPLATE')
    need(type(EXPIRES_AT_UTC) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', EXPIRES_AT_UTC), 'EXACT_ADMISSION_EXPIRY_REQUIRED')
    expires = datetime.fromisoformat(EXPIRES_AT_UTC.replace('Z', '+00:00')).timestamp()
    need(time.time() < expires <= time.time() + 900, 'FRESH_ADMISSION_EXPIRY_REQUIRED')
    return {'schema': 1, 'namespace': NAME, 'manifestSha256': MANIFEST_SHA, 'entrySha256': ENTRY_SHA,
            'codeAcceptanceSha256': CODE_ACCEPTANCE_SHA, 'nativeBasisSha256': BASIS_SHA,
            'preflightSha256': PREFLIGHT_SHA, 'leasePid': ACTUAL_PID, 'parentImage': PARENT,
            'expiresAtUtc': EXPIRES_AT_UTC, 'nonce': NONCE, 'oneApply': True,
            'payloadScopeSha256': SCOPE_SHA, 'uiReviewSha256': UI_REVIEW_SHA, 'htmlReviewSha256': HTML_REVIEW_SHA}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('preview', 'approve'))
    args = parser.parse_args()
    need(os.name == 'posix' and os.geteuid() == 0, 'EXACT_POSIX_ROOT_REQUIRED')
    lease()
    need(sha(private_read(CODE / 'manifest.json')) == MANIFEST_SHA
         and sha(private_read(CODE / 'company-app.py')) == ENTRY_SHA, 'EXACT_STAGED_ENTRY_MANIFEST_REQUIRED')
    raw = private_read(ROOT / (NAME + '-preflight.json'))
    need(sha(raw) == PREFLIGHT_SHA, 'EXACT_NEW_PREFLIGHT_REQUIRED')
    before = json.loads(raw)
    expected = {'schema': 1, 'namespace': NAME, 'manifestSha256': MANIFEST_SHA,
                'entrySha256': ENTRY_SHA, 'codeAcceptanceSha256': CODE_ACCEPTANCE_SHA,
                'nativeBasisSha256': BASIS_SHA, 'parentImage': PARENT,
                'target': 'palitra-orders-public/shell.js',
                'beforeSha256': '9e36a2380cfe1c2282e41e79af2b1d04f91f7cf4577d8b7cd505b3a62f5d2f71',
                'afterSha256': '94fafe89342b9f74777b9fcac544b1533e9941e7e099f19ff249cb9e9d8c09ee',
                'leasePid': ACTUAL_PID, 'payloadScopeSha256': SCOPE_SHA,
                'uiReviewSha256': UI_REVIEW_SHA, 'htmlReviewSha256': HTML_REVIEW_SHA}
    need(before.get('binding') == expected and before.get('runtimeAuthorization') is False
         and before.get('runtimeWrites') == 0 and 0 <= time.time() - before['createdAt'] <= 900, 'EXACT_FRESH_BOUND_PREFLIGHT_REQUIRED')
    for key in ('decision', 'journal', 'context', 'backup', 'overlay', 'root-acceptance'):
        suffix = '.json' if key in ('decision', 'journal', 'overlay', 'root-acceptance') else ''
        need(not os.path.lexists(ROOT / (NAME + '-' + key + suffix)), 'NEW_ADMISSION_NAMESPACE_REQUIRED_NO_RETRY')
    value = candidate()
    acceptance = encoded(value)
    if args.mode == 'preview':
        print(json.dumps({'status': 'READONLY_ACCEPTANCE_PREVIEW_NOT_AUTHORIZATION', 'acceptanceSha256': sha(acceptance),
                          'leasePid': ACTUAL_PID, 'preflightSha256': PREFLIGHT_SHA, 'runtimeWrites': 0}))
        return
    need(digest(ROOT_RUNTIME_REVIEW_SHA) and digest(ROOT_ACCEPTANCE_SHA)
         and sha(acceptance) == ROOT_ACCEPTANCE_SHA, 'SEPARATE_EXACT_ROOT_RUNTIME_ADMISSION_REQUIRED')
    lease()
    path = ROOT / (NAME + '-root-acceptance.json')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as file:
        file.write(acceptance)
        file.flush()
        os.fsync(file.fileno())
    need(sha(private_read(path)) == ROOT_ACCEPTANCE_SHA, 'EXACT_ROOT_ACCEPTANCE_READBACK_REQUIRED')
    # Explicit approve only. This wrapper never calls apply/build/up.
    result = subprocess.run(['python3', '-B', str(CODE / 'company-app.py'), 'approve', '--lease-pid', str(ACTUAL_PID),
                             '--root-acceptance-sha', ROOT_ACCEPTANCE_SHA], capture_output=True, timeout=300)
    need(result.returncode == 0, 'APPROVE_REFUSED_OR_UNKNOWN_NO_RETRY')
    reply = json.loads(result.stdout)
    need(reply.get('status') == 'NEW_DECISION_NOT_APPLIED' and digest(reply.get('sha256')), 'EXACT_NEW_DECISION_REPLY_REQUIRED')
    print(json.dumps({'status': 'EXACT_ROOT_ADMISSION_AND_DECISION_NOT_APPLIED', 'acceptanceSha256': ROOT_ACCEPTANCE_SHA,
                      'rootRuntimeReviewSha256': ROOT_RUNTIME_REVIEW_SHA, 'decisionSha256': reply['sha256'], 'runtimeWrites': 0}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'ADMISSION_REFUSED_OR_UNKNOWN_NO_RETRY'}), file=sys.stderr)
        sys.exit(1)
