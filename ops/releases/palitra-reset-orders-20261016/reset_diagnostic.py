"""Bounded readonly predicate diagnosis only. No database query, backup or runtime action."""
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
CODE = ROOT / 'reset-orders11-17-code-r1'
CONTROLLER_SHA = '2ae19531a582a97c0a20643edb9a5591b899ab70d0a2afbea15030d00b29fbeb'
sha = lambda raw: hashlib.sha256(raw).hexdigest()


def need(value, code):
    if not value: raise ValueError(code)


def read_code(path, pin):
    need(path.is_absolute() and '..' not in path.parts, 'EXACT_DIAGNOSTIC_CODE_PATH_REQUIRED')
    for item in [*reversed(path.parents), path]:
        row = item.lstat()
        need(not stat.S_ISLNK(row.st_mode) and not (getattr(row, 'st_file_attributes', 0) & 0x400), 'DIAGNOSTIC_CODE_SYMLINK_REFUSED')
    info = path.stat(); need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and 0 < info.st_size <= 1024*1024, 'BOUNDED_ROOT_DIAGNOSTIC_CODE_REQUIRED')
    raw = path.read_bytes(); need(sha(raw) == pin, 'EXACT_FROZEN_RESET_CONTROLLER_REQUIRED'); return raw


def differences(actual, expected, known):
    if type(actual) is not dict or type(expected) is not dict:
        return {'objects': False, 'equal': actual == expected, 'differentKnownKeys': [], 'unexpectedActualKeyCount': None}
    return {'objects': True, 'equal': actual == expected,
            'differentKnownKeys': [key for key in known if (key in actual) != (key in expected) or actual.get(key) != expected.get(key)],
            'unexpectedActualKeyCount': len(set(actual) - set(known)), 'unexpectedExpectedKeyCount': len(set(expected) - set(known))}


def diagnose(lease_pid):
    raw = read_code(CODE / 'reset_collect_native.py', CONTROLLER_SHA)
    controller = types.ModuleType('pinned_reset_readonly_diagnostic'); controller.__file__ = str(CODE / 'reset_collect_native.py')
    exec(compile(raw, controller.__file__, 'exec'), controller.__dict__)
    module = controller.load_release()
    a, b, current = module.load_current(lease_pid)
    receipt_path = ROOT / 'palitra-forms-consistency-r1-journal.json'
    receipt = a.pinned(receipt_path, controller.RECEIPT_SHA, True)
    historical_pid = receipt.get('inputs', {}).get('freshLeasePid')
    need(type(historical_pid) is int and historical_pid > 1, 'EXACT_HISTORICAL23_LEASE_BINDING_REQUIRED')
    release = module.JourneyRelease(a, b, current, controller.RELEASE / 'payload', controller.MANIFEST_SHA, historical_pid)
    expected_inputs = release.binding()
    rows = receipt.get('static'); list_ok = type(rows) is list
    predicates = {
        'schemaEquals1': receipt.get('schema') == 1,
        'nameMatches': receipt.get('name') == module.NAME,
        'phaseMatches': receipt.get('phase') == module.PHASE,
        'inputsBindingMatches': receipt.get('inputs') == expected_inputs,
        'beforeMatches': receipt.get('before') == release.base,
        'childImageMatches': receipt.get('childImage') == controller.CONTENT,
        'workerRecreatedFalse': receipt.get('workerRecreated') is False,
        'uploadsEnabledTrue': receipt.get('uploadsEnabled') is True,
        'directDbWritesZero': receipt.get('directDbWrites') == 0,
        'queueEditsZero': receipt.get('queueEdits') == 0,
        'oldJournalWritesZero': receipt.get('oldJournalWrites') == 0,
        'automaticRetryFalse': receipt.get('automaticRetry') is False,
        'automaticCodeRollbackFalse': receipt.get('automaticCodeRollback') is False,
        'staticIsList': list_ok,
        'staticExactly5': list_ok and len(rows) == 5,
        'staticAllWrittenTrue': list_ok and all(type(row) is dict and row.get('written') is True for row in rows),
    }
    before = receipt.get('before') if type(receipt.get('before')) is dict else {}
    expected_before = release.base
    result = {'schema': 1, 'status': 'READONLY_RESET_RECEIPT_PREDICATE_DIAGNOSTIC_NOT_APPROVAL',
              'predicates': predicates, 'allReceiptPredicatesPass': all(predicates.values()),
              'inputs': differences(receipt.get('inputs'), expected_inputs, ['priorReceiptSha256','parentImage','workerImage','manifestSha256','helperSha256','wrapperSha256','freshLeasePid','parents']),
              'before': differences(before, expected_before, ['containers','selected','worker','contentCid','l12']),
              'dbQueries': 0, 'dbWrites': 0, 'backupsCreated': 0, 'runtimeMutations': 0, 'oldJournalWrites': 0, 'deletionApproved': False}
    for side in ('content','chat'):
        actual = before.get('containers', {}).get(side) if type(before.get('containers')) is dict else None
        expected = expected_before.get('containers', {}).get(side)
        result['before' + side.title()] = differences(actual, expected, ['image','project','service','workingDir','configFiles','configHash','running','health','files','filePins'])
    actual_inputs = receipt.get('inputs') if type(receipt.get('inputs')) is dict else {}
    actual_parents = actual_inputs.get('parents'); expected_parents = expected_inputs.get('parents')
    # Only fixed labels and index differences; never output paths, hash values, PIDs or file contents.
    parent_labels = [('releaseRoot', release.root), ('cabinetStatic', release.cabinet), ('editorStatic', release.editor)]
    result['parents'] = {}
    for label, path in parent_labels:
        actual = actual_parents.get(str(path)) if type(actual_parents) is dict else None
        expected = expected_parents.get(str(path)) if type(expected_parents) is dict else None
        fields = ['device','inode','uid','mode']
        result['parents'][label] = {'equal': actual == expected, 'shapeMatches': type(actual) is list and type(expected) is list and len(actual) == len(expected) == 4,
                                   'differentFields': [field for i, field in enumerate(fields) if not (type(actual) is list and type(expected) is list and len(actual) == len(expected) == 4 and actual[i] == expected[i])]}
    # Genuine fresh lease check only, after historical binding construction; no old runtime reader is called.
    release.lease_pid = lease_pid; release.lease()
    need(sha(a.read(receipt_path)) == controller.RECEIPT_SHA, 'IMMUTABLE_RECEIPT_CHANGED_DURING_DIAGNOSTIC')
    output = json.dumps(result, separators=(',', ':')); need(len(output.encode()) <= 16384, 'BOUNDED_DIAGNOSTIC_REQUIRED')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--lease-pid', type=int, required=True); parser.add_argument('--diagnose-readonly', action='store_true')
    args = parser.parse_args(argv)
    try:
        need(args.diagnose_readonly and os.name == 'posix' and os.geteuid() == 0 and Path(__file__).resolve().parent == CODE, 'EXACT_ROOT_READONLY_DIAGNOSTIC_REQUIRED')
        print(json.dumps(diagnose(args.lease_pid), separators=(',', ':'))); return 0
    except Exception as error:
        code = str(error) if type(error) is ValueError and re.fullmatch('[A-Z][A-Z0-9_]{0,100}', str(error)) else 'READONLY_DIAGNOSTIC_REFUSED'
        print(json.dumps({'status':'READONLY_DIAGNOSTIC_REFUSED_NO_DELETE','code':code,'messageSha256':sha(str(error).encode()),'dbQueries':0,'dbWrites':0,'automaticRetry':False})); return 2


if __name__ == '__main__': sys.exit(main())
