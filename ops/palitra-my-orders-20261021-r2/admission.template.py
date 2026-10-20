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
NAME = 'palitra-my-orders-20261021-r2'
CODE = ROOT / (NAME + '-code')
MANIFEST_SHA = 'ef29147b219ae33e7209f7f2cb9c29af63b86e71a4e881ac180710e5644cd924'
ENTRY_SHA = '628764a8a9329b910ad0682f1981d3d5aafb93dbf3299df4aa2e32f6c6415ea0'
CODE_ACCEPTANCE_SHA = 'ebe829328d6e09ab2296f5ba7f49b303f6a568e53a12b7d5355aa48e5c75b799'
BASIS_SHA = 'bef2ba9c9f0e85f551e5bae2a28bc1ea66a0311994e71ce8e1c40dd2b6997f77'
PARENT = 'sha256:951db09e9e6c4781350bbced7e7a9e4ef099077a368e38a6b1fac40e0a4a6a22'
SCOPE_SHA = '07bd8b5d6e2bd79b48188934b7d42ec0598cb9c704aef0f6704d31335694a677'
UI_REVIEW_SHA = '6993cfd59f3d023ba95642e672cc2ab8f6fc97da7e5c145ba36518cf28a5e786'
HTML_REVIEW_SHA = '0f1860a73de4aefdd73928754ac0a6d964ef885d56428370de26ffe8fcb54c84'
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
    need(type(ACTUAL_PID) is int and ACTUAL_PID > 1 and ACTUAL_PID not in (3161783, 3196874, 3200094, 3202295, 3204327, 3205870, 3207300, 3208973, 3210573, 3213993, 3215428, 3221971, 3222059, 3231260, 3239627, 3242810, 3263438, 3284416, 3308227, 3336085, 3367042, 3401855), 'FRESH_ACTUAL_ADMISSION_PID_REQUIRED')
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
                'beforeSha256': '60502c40ecfb7a5f75972b7a841a197fb75b372fba76ade072cef9d3db5f9e4b',
                'afterSha256': '77014fc3ecda2be6c5bc786c40e852afa53f54652e6689be1c10ab3029c27ff5',
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
