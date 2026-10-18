"""Bounded Root-only read-only receipt31 predicate diagnostics. No actions/snapshots/writes.

Output is only named booleans and validated public SHA IDs. No receipts/maps/PII/secrets.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types

sys.dont_write_bytecode = True
ROOT = Path('/opt/synapse/releases/palitra-app-20261015')
PRIOR_CODE = ROOT / 'palitra-chat-avatar-hugh-code-r1'
STAGED_CODE = ROOT / 'palitra-chat-composer-bottom-code-r1'
HELPER32_R1_SHA = '2cf44c5f7306b5f6055eae64ac1576942f7c808fc3975bd415a631687a6e1fc5'
WRAPPER32_R1_SHA = '11e126112294d7e3d5917775027d19d4e97b2211a350a5c03b5f33dd3e9b68e8'
MANIFEST32_R1_SHA = '59de6ed1c6a2aad829d778975adbab36e40483a031ec3cf30c651d907abcf5b6'
HELPER31_SHA = '32993cd941a3d3e08369161f61dc7871b3252442f4fa0a9bc58631b87e113111'
WRAPPER31_SHA = 'e18c93196e052ed3d656416b8ec2dc5c4be16f904dd31a1b66439662245015ca'
MANIFEST31_SHA = 'c6b5d39cf1025f48d6169c070d3d3899dee14faa3c7eca899040a0dc6ae057bc'
RECEIPT31_SHA = '2e1ec22a65607378c499795e6024fa2694d4d14d771c6f319dd3f579408b9bbc'
# Exact values rejected by staged composer32-r1, not repaired or replaced here.
EXPECTED_CHILD31 = 'sha256:b17b7d88042b98bd0af4eeec8f7e30a854e88d6f17dc049fff33806cf859c852'
EXPECTED_DECISION31 = 'a6fa36941483078e8c542885edf25f58d0d952f1e944bf48dbc406491842c60e'
MAX_BYTES = 2 * 1024 * 1024
sha = lambda raw: hashlib.sha256(raw).hexdigest()
digest = lambda value: type(value) is str and re.fullmatch('[0-9a-f]{64}', value) is not None


def need(value):
    if not value: raise ValueError('BOUNDED_READ_ONLY_DIAGNOSTIC_REFUSED')


def read(path):
    path = Path(path); need(path.is_absolute() and '..' not in path.parts)
    for item in [*reversed(path.parents), path]:
        row = item.lstat(); need(not stat.S_ISLNK(row.st_mode))
        if item != path: need(stat.S_ISDIR(row.st_mode))
    row = path.stat(); need(stat.S_ISREG(row.st_mode) and 0 < row.st_size <= MAX_BYTES)
    value = path.read_bytes(); need(len(value) == row.st_size); return value


def predicate_checks(receipt, accepted, prior):
    """Exact staged-r1 receipt gate, split to booleans; values stay in memory."""
    need(type(receipt) is dict)
    rows = receipt.get('static')
    checks = {
        'schemaEquals1': receipt.get('schema') == 1,
        'nameEqualsFrozen31': receipt.get('name') == prior.NAME,
        'phaseEqualsFrozen31': receipt.get('phase') == prior.PHASE,
        'inputsEqualConstructorBinding': receipt.get('inputs') == accepted.binding(),
        'beforeEqualsConstructorBase': receipt.get('before') == accepted.base,
        'childImageEqualsStagedR1Expected': receipt.get('childImage') == EXPECTED_CHILD31,
        'workerRecreatedIsFalse': receipt.get('workerRecreated') is False,
        'uploadsEnabledIsTrue': receipt.get('uploadsEnabled') is True,
        'directDbWritesEquals0': receipt.get('directDbWrites') == 0,
        'queueEditsEquals0': receipt.get('queueEdits') == 0,
        'oldJournalWritesEquals0': receipt.get('oldJournalWrites') == 0,
        'automaticRetryIsFalse': receipt.get('automaticRetry') is False,
        'automaticCodeRollbackIsFalse': receipt.get('automaticCodeRollback') is False,
        'decisionShaEqualsStagedR1Expected': receipt.get('decisionSha256') == EXPECTED_DECISION31,
        'staticIsList': type(rows) is list,
        'staticLengthEquals3': type(rows) is list and len(rows) == 3,
        'everyStaticRowDictAndWrittenTrue': type(rows) is list and all(type(row) is dict and row.get('written') is True for row in rows),
    }
    checks['exactCompleted31ReceiptGateAllTrue'] = all(checks.values())
    return checks


def binding_detail_checks(receipt, accepted):
    """Fixed keys only. Neither input values nor map keys/rows reach stdout."""
    actual, expected = receipt.get('inputs'), accepted.binding()
    keys = ('priorReceiptSha256', 'parentImage', 'workerImage', 'manifestSha256', 'helperSha256', 'wrapperSha256', 'freshLeasePid',
            'managedRoot', 'parents', 'sourceLayout', 'staticLayout', 'beforeSource', 'afterSource', 'beforeStatic', 'afterStatic')
    rows = {'inputsExactKeySet': type(actual) is dict and set(actual) == set(expected)}
    rows.update({'input_' + key + '_Equals': type(actual) is dict and actual.get(key) == expected.get(key) for key in keys})
    actual_before, expected_before = receipt.get('before'), accepted.base
    before_keys = ('containers', 'selected', 'worker', 'contentCid', 'l12')
    rows['beforeExactKeySet'] = type(actual_before) is dict and set(actual_before) == set(expected_before)
    rows.update({'before_' + key + '_Equals': type(actual_before) is dict and actual_before.get(key) == expected_before.get(key) for key in before_keys})
    return rows


def diagnostic(lease_pid):
    checks = {}; ids = {'expectedReceipt31': RECEIPT31_SHA, 'expectedChild31': EXPECTED_CHILD31, 'expectedDecision31': EXPECTED_DECISION31}
    try:
        checks['rootPosixInvocation'] = os.name == 'posix' and hasattr(os, 'geteuid') and os.geteuid() == 0
        need(checks['rootPosixInvocation'])
        checks['leaseArgumentValid'] = type(lease_pid) is int and lease_pid > 1; need(checks['leaseArgumentValid'])
        for tag, leaf, expected_sha in (('Helper32R1', 'chat_composer_bottom_release_native.py', HELPER32_R1_SHA),
                                        ('Wrapper32R1', 'chat_composer_bottom.py', WRAPPER32_R1_SHA), ('Manifest32R1', 'payload/MANIFEST.json', MANIFEST32_R1_SHA)):
            ids['actual' + tag] = sha(read(STAGED_CODE / leaf)); checks['frozen' + tag + 'ShaEquals'] = ids['actual' + tag] == expected_sha
            need(checks['frozen' + tag + 'ShaEquals'])
        helper, wrapper, manifest = PRIOR_CODE / 'chat_avatar_hugh_release_native.py', PRIOR_CODE / 'chat_avatar_hugh.py', PRIOR_CODE / 'payload/MANIFEST.json'
        raw = read(helper); ids['actualHelper31'] = sha(raw); checks['frozenHelper31ShaEquals'] = ids['actualHelper31'] == HELPER31_SHA; need(checks['frozenHelper31ShaEquals'])
        ids['actualWrapper31'] = sha(read(wrapper)); checks['frozenWrapper31ShaEquals'] = ids['actualWrapper31'] == WRAPPER31_SHA; need(checks['frozenWrapper31ShaEquals'])
        ids['actualManifest31'] = sha(read(manifest)); checks['frozenManifest31ShaEquals'] = ids['actualManifest31'] == MANIFEST31_SHA; need(checks['frozenManifest31ShaEquals'])
        prior = types.ModuleType('read_only_receipt31_frozen'); prior.__file__ = str(helper)
        exec(compile(raw, str(helper), 'exec'), prior.__dict__)
        a, b, current30 = prior.load_current30(lease_pid); checks['immutableCurrent30LoaderSucceeded'] = True
        journal = ROOT / 'palitra-chat-avatar-hugh-r1-journal.json'
        receipt_raw = read(journal); ids['actualReceipt31'] = sha(receipt_raw)
        checks['receipt31ShaEquals'] = ids['actualReceipt31'] == RECEIPT31_SHA; need(checks['receipt31ShaEquals'])
        receipt = a.pinned(journal, RECEIPT31_SHA, True)
        checks['receiptIsDict'] = type(receipt) is dict; need(checks['receiptIsDict'])
        inputs = receipt.get('inputs'); checks['inputsIsDict'] = type(inputs) is dict; need(checks['inputsIsDict'])
        historical_pid = inputs.get('freshLeasePid'); checks['historicalLeaseBindingValid'] = type(historical_pid) is int and historical_pid > 1; need(checks['historicalLeaseBindingValid'])
        accepted = prior.ChatAvatarHughRelease(a, b, current30, PRIOR_CODE / 'payload', prior.MANIFEST_SHA, historical_pid)
        checks['frozen31ConstructorSucceeded'] = True
        checks.update(predicate_checks(receipt, accepted, prior))
        checks.update(binding_detail_checks(receipt, accepted))
        decision_ref = receipt.get('decisionSha256'); checks['decisionReferenceIsSha'] = digest(decision_ref)
        if checks['decisionReferenceIsSha']: ids['receiptDecision31'] = decision_ref
        child = receipt.get('childImage'); checks['childReferenceIsImageSha'] = type(child) is str and re.fullmatch('sha256:[0-9a-f]{64}', child) is not None
        if checks['childReferenceIsImageSha']: ids['receiptChild31'] = child
        # Additional hash only, no JSON contents or historical decision action/TTL check.
        decision_path = ROOT / 'palitra-chat-avatar-hugh-r1-decision.json'
        ids['actualDecision31File'] = sha(read(decision_path))
        checks['decisionFileShaEqualsReceiptReference'] = checks['decisionReferenceIsSha'] and ids['actualDecision31File'] == decision_ref
        checks['diagnosticCompletedReadOnly'] = True
    except Exception:
        checks['diagnosticCompletedReadOnly'] = False
    return {'checks': checks, 'publicShaIds': ids}


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--lease-pid', required=True, type=int); args = parser.parse_args()
    result = diagnostic(args.lease_pid); print(json.dumps(result, separators=(',', ':')))
    return 0 if result['checks'].get('diagnosticCompletedReadOnly') else 2


if __name__ == '__main__': raise SystemExit(main())
