"""Exact reviewed Palitra auth/context/attention delta; background worker suffix unchanged."""
import hashlib
BEFORE='23c9664d8209ecf4aa4ce822a1a05a8cf0c2ee3fcb11afa93e396b1d5282d4ac'
AFTER='755e27e780f48ff1c44fac4e153b4a003f0addaa408e54c66a629b6784a37115'
sha=lambda b:hashlib.sha256(b).hexdigest()
def validate(before,after):
 if sha(before)!=BEFORE or sha(after)!=AFTER:raise ValueError('SERVER_PHASE_PROOF_PINS')
 marker=b'let economyTimer;'
 if before.count(marker)!=1 or after.count(marker)!=1 or before[before.index(marker):]!=after[after.index(marker):]:raise ValueError('SERVER_WORKER_STARTUP_CHANGED')
 return {'before':BEFORE,'after':AFTER,'unchangedWorkerSuffix':sha(before[before.index(marker):])}
