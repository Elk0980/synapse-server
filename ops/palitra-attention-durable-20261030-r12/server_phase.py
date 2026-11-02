"""Pure exact phase proof: only attention route differs, startup/source oracles unchanged."""
import hashlib
BEFORE='23c9664d8209ecf4aa4ce822a1a05a8cf0c2ee3fcb11afa93e396b1d5282d4ac';AFTER='183a0edd7559a7fa029c3b17e8931592133961f73454fb59afbcc8c6761b7713'
START=b'    // PALITRA_MANAGER_ATTENTION_ROUTE: existing crm.view, no writes or side-effectful workflow reads.'
END=b'    // PALITRA_MANAGER_ATTENTION_ROUTE_END'
sha=lambda v:hashlib.sha256(v).hexdigest()
def validate(before,after):
 if sha(before)!=BEFORE or sha(after)!=AFTER:raise ValueError('SERVER_PHASE_PROOF_PINS')
 def split(raw):
  if raw.count(START)!=1 or raw.count(END)!=1:raise ValueError('SERVER_PHASE_ROUTE_MARKERS')
  a=raw.index(START);b=raw.index(END,a)+len(END);return raw[:a],raw[a:b],raw[b:]
 pre,old,post=split(before);newpre,new,newpost=split(after)
 if pre!=newpre or post!=newpost or before[before.index(b'let economyTimer;'):]!=after[after.index(b'let economyTimer;'):]:raise ValueError('SERVER_STARTUP_OR_OUTSIDE_ROUTE_CHANGED')
 return {'before':BEFORE,'after':AFTER,'prefix':sha(pre),'suffix':sha(post),'startup':sha(before[before.index(b'let economyTimer;'):])}
