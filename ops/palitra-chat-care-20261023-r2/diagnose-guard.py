"""Read-only execution of the original guard with difference paths on refusal.

No execute, backup, writes, application changes or weakening of checks.
Requires a fresh own ancestor lease. Old action is used only for readback.
"""
from pathlib import Path
import hashlib
import json
import sys
sys.dont_write_bytecode = True
helper = Path('/tmp/pc-care-13e3b12.py')
raw = helper.read_bytes()
assert hashlib.sha256(raw).hexdigest() == 'e964640f33b6e87a61cc6babc4c415e1760f6ca8a225f7ab4cb15f0242e0a7fe'
s = {'__name__': 'readonly_original_guard', '__file__': str(helper)}
exec(compile(raw, str(helper), 'exec'), s)
staged, bundle, manifest = s['package']()
product, native, reader, contract = s['old']['primitive']()
lease = s['own_lease'](native)
obj = object.__new__(s['Apply'])
obj.staged, obj.bundle, obj.m = staged, bundle, manifest
obj.product, obj.native, obj.reader, obj.contract = product, native, reader, contract
obj.action, obj.base = s['load'](s['AREA']/'action.json'), s['load'](s['AREA']/'base.json')
obj.readLease = lease  # Supported readback ticket; never used by execute.
obj.children, obj.plan, obj.published = {}, None, set()
obj.seq = 0
obj.journal = s['ROOT']/(obj.action['namespace']+'-apply')

def differences(a, b, path='', rows=None):
    rows = [] if rows is None else rows
    if len(rows) >= 80:
        return rows
    if type(a) is not type(b):
        rows.append(path+':type')
    elif isinstance(a, dict):
        for key in sorted(set(a)|set(b)):
            if key not in a or key not in b:
                rows.append(path+'/'+str(key)+':presence')
            else:
                differences(a[key], b[key], path+'/'+str(key), rows)
    elif isinstance(a, list):
        if len(a) != len(b):
            rows.append(path+':length')
        for i, (x, y) in enumerate(zip(a, b)):
            differences(x, y, path+'/'+str(i), rows)
    elif a != b:
        rows.append(path)
    return rows

print(json.dumps({'status':'READ_ONLY_ORIGINAL_GUARD', 'lease':lease,
    'journalFiles':sorted(p.name for p in obj.journal.iterdir()),
    'installedReceiptExists':(s['AREA']/'installed.json').exists()}), flush=True)
for sample in range(3):
    try:
        digest = obj.guard(False)
        print(json.dumps({'sample':sample,'status':'FULL_GUARD_PASS','snapshotSha256':digest}), flush=True)
    except Exception as error:
        paths, tb = [], error.__traceback__
        while tb:
            values = tb.tb_frame.f_locals
            if tb.tb_frame.f_code.co_name == 'guard' and 'actual' in values and 'want' in values:
                paths = differences(values['want'], values['actual'])
            tb = tb.tb_next
        print(json.dumps({'sample':sample,'status':'GUARD_REFUSAL',
            'code':str(error) if isinstance(error, ValueError) else type(error).__name__,
            'differentPaths':paths,'productionWrites':0}), flush=True)
