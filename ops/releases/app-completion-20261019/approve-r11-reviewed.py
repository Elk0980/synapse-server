"""Create one exact R11 Root acceptance and approval decision. Never installs."""
from pathlib import Path
import hashlib, json, os, re, stat, subprocess, sys

ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
NAME = 'multi-company-app-20261019-r11'
CODE = ROOT / (NAME + '-code')
PINS = {
    'release-native.py': '003a25c904537b48444c2f73ad814e83ab1aa36522ae2bcea55c891c19a2bc46',
    'company-app.py': '80511bb3f45d2a15d3e6eda0ad0caf20e0d323633e864eb7559123be604c0cf1',
    'ROLLBACK.md': '6d81ef45f0739ca7ad3d81f6be9ff8686ea484251f213abe1993f3255a4bb446',
    'traffic-db.py': '2b44578d7b7fee9d779fe647c6d3b56eb5aa9d377f89b68f5aaed7230ca1127f',
}
PREFLIGHT_PIN = '91c905e26ed5f3fbabe5dd5e00a0294318d0b2e20f3668aaffd71e459ec2f1ad'
PRODUCT_PIN = 'd85c58f92607b7d65bf51a5c86d81390d1a2679f81f58ac137631a54a590058b'
MANAGED_PIN = '40ef3d261c68fcdca488a31da328e245f70066066bbc92cfebba28a4f19c453d'
SHA = lambda raw: hashlib.sha256(raw).hexdigest()


def need(ok, code):
    if not ok:
        raise ValueError(code)


def read(path, pin):
    need(not any(p.is_symlink() for p in [path, *path.parents]), 'PATH_ALIAS_REFUSED')
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == s.st_gid == 0
         and stat.S_IMODE(s.st_mode) == 0o600, 'PRIVATE_ROOT_SINGLE_LINK_REQUIRED')
    raw = path.read_bytes()
    need(len(raw) <= 2 * 1024 * 1024 and SHA(raw) == pin, 'EXACT_PIN_REQUIRED')
    return raw


def write(path, raw):
    need(not os.path.lexists(path) and not any(p.is_symlink() for p in path.parents), 'NEW_NAMESPACE_REQUIRED_NO_REPLAY')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    need(os.name == 'posix' and os.geteuid() == 0 and len(sys.argv) == 3, 'ROOT_EXACT_PREFLIGHT_REQUIRED')
    pid = int(sys.argv[1])
    pin = sys.argv[2]
    need(pid == 3126443 and pin == PREFLIGHT_PIN, 'REVIEWED_ACTUAL_PID_AND_PREFLIGHT_REQUIRED')
    lock = '/opt/synapse/.palitra-app-release.lock'
    rows = [r.strip().split(maxsplit=1) for r in subprocess.check_output(['lslocks', '--noheadings', '--output', 'PID,PATH']).decode().splitlines()]
    need([r for r in rows if len(r) == 2 and r[1] == lock] == [[str(pid), lock]], 'OWN_EXACT_LEASE_REQUIRED')
    for name, wanted in PINS.items():
        read(CODE / name, wanted)
    pre = json.loads(read(Path('/tmp/r11-readonly-' + str(pid) + '.json'), pin))
    need(pre.get('status') == 'CURRENT_R7C_READONLY_NOT_APPROVED'
         and pre.get('runtimeWrites') == pre.get('contentSchemaObjectsCreated') == 0
         and pre.get('productReviewSha256') == PRODUCT_PIN
         and (pre.get('sourceFiles'), pre.get('staticFiles'), pre.get('chainFiles'), pre.get('candidateSourceFiles'), pre.get('candidateStaticFiles')) == (235, 41, 39, 238, 41), 'EXACT_PASSED_PREFLIGHT_REQUIRED')
    need(re.fullmatch('[a-f0-9]{64}', pre.get('parentPostSchemaSha256', ''))
         and pre.get('trafficDatabaseBefore', {}).get('status') == 'ABSENT', 'REVIEWED_SCHEMA_AND_THIRD_STORE_REQUIRED')
    managed = json.loads(read(ROOT / 'multi-company-app-20261019-r7c-managed-proof.json', MANAGED_PIN))
    need(managed['current']['version'] == 259 and managed['historical']['version'] == 257
         and managed['current']['mismatches'] == [], 'EXACT_MANAGED_SOURCE_REQUIRED')
    for suffix in ('decision.json', 'journal.json', 'overlay.json', 'context', 'backup'):
        path = ROOT / (NAME + '-' + suffix)
        need(not os.path.lexists(path) and not os.path.lexists(str(path) + '.pending'), 'OWN_ATTEMPT_EXISTS_NO_REPLAY')
    acceptance = {
        'schema': 1, 'status': 'ACCEPTED_R11_PRODUCT_AND_INSTALLER',
        'installerStatus': 'ACCEPTED_NATIVE_R11_INSTALLER_AND_ROLLBACK',
        'runtimeApplyAuthorized': True, 'workerActivationAuthorized': False,
        'writerThreadId': '01a0a408-4f98-7713-a652-e6a741da834c',
        'reviewerThreadId': '01a0a408-4f98-7713-a652-e6a741da834c',
        'parentReceiptSha256': '58a537f7adf44f36fe47c594a9856271cfb58ac6e8bc784ba6317b572b7e259d',
        'productReviewSha256': PRODUCT_PIN,
        'manifestSha256': '480e2a71c7d12d1e9aa8687b82e6e875a766cc41b05f98015d327e6dde938bb7',
        'dbGuardSha256': '08456dc9fcfae875b22c631a461e0cedea5a702b5f8d43ae770de7cff6e78a63',
        'contentDbGuardSha256': 'd6363b217d69a49751d875b00cf50776593d01160b386190edaac8bf537ab4be',
        'trafficDbGuardSha256': PINS['traffic-db.py'],
        'helperSha256': PINS['release-native.py'], 'rollbackSha256': PINS['ROLLBACK.md'],
        'managedProofSha256': MANAGED_PIN,
        'managedProbeSha256': '6adf008d2a6016031b6ad6812c3550a557694293a9a855a92cfb64e6c964ca6f',
        'mapOutcomeSha256': '7c206110ddb478f1be1221e689ea346e125b9e438096b59af39a7eb84ebc2c42',
        'managedSourceProof': managed, 'sourceCounts': {'before': 235, 'after': 238},
        'contentSchemaObjectsCreated': 0, 'parentPostSchemaSha256': pre['parentPostSchemaSha256'],
        'rootPreflightSha256': pin, 'rootLocalTests': {'product': 243, 'installer': 31, 'independentFrontend': 21},
        'fullCustomerAcceptance': False,
    }
    raw = (json.dumps(acceptance, sort_keys=True, separators=(',', ':')) + '\n').encode()
    acceptance_pin = SHA(raw)
    write(CODE / 'ROOT_ACCEPTANCE.json', raw)
    print(json.dumps({'status': 'EXACT_NEW_ROOT_ACCEPTANCE_SAVED_NOT_APPLIED', 'acceptanceSha256': acceptance_pin}), flush=True)
    result = subprocess.run(['python3', '-B', str(CODE / 'company-app.py'), 'approve-current', '--lease-pid', str(pid), '--acceptance-sha', acceptance_pin, '--apply'], capture_output=True, timeout=180)
    need(len(result.stdout) <= 2 * 1024 * 1024, 'BOUNDED_APPROVAL_RESULT_REQUIRED')
    write(Path('/tmp/r11-approval-' + str(pid) + '.json'), result.stdout)
    value = json.loads(result.stdout)
    value['approvalOutputSha256'] = SHA(result.stdout)
    value['exitCode'] = result.returncode
    print(json.dumps(value, separators=(',', ':')))
    return result.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'APPROVAL_REFUSED_OR_UNKNOWN_NO_REPLAY', 'code': str(error) if type(error) is ValueError else type(error).__name__}))
        sys.exit(2)
