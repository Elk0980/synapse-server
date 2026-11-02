"""Private packaging only. No native/helper import, network or release phases."""
from pathlib import Path
import hashlib,json,difflib
HERE=Path(__file__).resolve().parent;BASE=HERE.parent/'ATTENTION_DURABLE_R11'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
registryRaw=(BASE/'SHA256.json').read_bytes()
assert sha(registryRaw)=='30ba49ed653aa22eb3e792e02cae65e596ec8c5c2f47cf4934ea2dbc8139229d'
pins=json.loads(registryRaw);assert len(pins)==40
for name,pin in pins.items():
 rel=Path(name);assert not rel.is_absolute() and '..' not in rel.parts
 raw=(BASE/rel).read_bytes();assert sha(raw)==pin,name
 dst=HERE/rel;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(raw)
module=(HERE/'managed_history.py').read_bytes()
assert sha(module)=='9d00a086c983a0a7435cf6a6a2f726b570bc787bf52f56fc294ae03684aa640b'
assert module==(HERE.parent/'PRIVATE_MANAGED_FAST_R2/managed_history.py').read_bytes()
full=(HERE.parent/'ATTENTION_DURABLE_R10/managed_history.py').read_bytes();assert module.startswith(full)
scope=json.loads((BASE/'scope-review.json').read_bytes())
scope['kind']='private-r12-attention-combined-fastR2-fresh-base-code-only-NOT_NATIVE_PERMIT'
scope['packagingProvenance']={'namespace':'palitra-attention-durable-20261030-r12','basisNamespace':'palitra-attention-durable-20261030-r11','basisRegistrySha256':sha(registryRaw),'selectedManagedModule':'PRIVATE_MANAGED_FAST_R2/managed_history.py','selectedModuleSha256':sha(module),'fullOriginalPrefixSha256':sha(full),'freshBaseRequired':True,'sealedPredecessorNotReplayed':True,'nativeActions':0,'rootFinalReviewRequired':True,'nativePermit':False}
scopeRaw=(json.dumps(scope,ensure_ascii=False,indent=2)+'\n').encode('utf-8');(HERE/'scope-review.json').write_bytes(scopeRaw)
before=(BASE/'install.py').read_bytes();assert sha(before)=='d40b876beb04c42e350a2ab9847facd2edb525d90c7b296c37485a78f60cb9b6'
edits=[(b"NAME='palitra-attention-durable-20261030-r11'",b"NAME='palitra-attention-durable-20261030-r12'"),(sha((BASE/'scope-review.json').read_bytes()).encode(),sha(scopeRaw).encode())]
after=before
for old,new in edits:assert after.count(old)==1;after=after.replace(old,new,1)
reverse=after
for old,new in reversed(edits):assert reverse.count(new)==1;reverse=reverse.replace(new,old,1)
assert reverse==before
(HERE/'install.py').write_bytes(after)
(HERE/'R11_TO_R12.diff').write_bytes(''.join(difflib.unified_diff(before.decode().splitlines(True),after.decode().splitlines(True),fromfile='R11/install.py',tofile='R12/install.py')).encode())
manifest=json.loads((BASE/'manifest.json').read_bytes());manifest.update(packageId='palitra-attention-durable-20261030-r12',helperSha256=sha(after));assert manifest['status']=='ROOT_REVIEWED_CODE_ONLY'
(HERE/'manifest.json').write_bytes((json.dumps(manifest,indent=2)+'\n').encode())
test=(BASE/'test_r9_lineage.py').read_text().replace("BASE=HERE.parent/'ATTENTION_DURABLE_R10'","BASE=HERE.parent/'ATTENTION_DURABLE_R11'").replace("new.NAME,'palitra-attention-durable-20261030-r11'","new.NAME,'palitra-attention-durable-20261030-r12'").replace("changed={'managed_history.py','scope-review.json'}","changed={'scope-review.json'}").replace("full=(BASE/'managed_history.py').read_bytes()","full=(HERE.parent/'ATTENTION_DURABLE_R10/managed_history.py').read_bytes()")
assert test!=(BASE/'test_r9_lineage.py').read_text()
(HERE/'test_r9_lineage.py').write_bytes(test.encode())
lineage={'status':'PRIVATE_R12_CODE_ONLY_PENDING_ROOT_REVIEW_NOT_NATIVE_PERMIT','nativeActions':0,'sourceR11RegistrySha256':sha(registryRaw),'r11All40Verified':True,'basisR11HelperSha256':sha(before),'helperSha256':sha(after),'moduleSha256':sha(module),'moduleByteExactR11':True,'fullPrefixSha256':sha(full),'fullPrefixBytes':len(full),'fullPrefixByteExact':True,'helperReverseByteExactR11':True,'helperChangesOnly':['NAME','scope-review.json provenance pin'],'scopeSha256':sha(scopeRaw),'manifestSha256':sha((HERE/'manifest.json').read_bytes()),'manifestTechnicalStatus':'ROOT_REVIEWED_CODE_ONLY','sameSixPayload':True,'freshBaseRequired':True,'sealedR11NotReplayed':True,'rootFinalReviewRequired':True}
(HERE/'SOURCE_LINEAGE.json').write_bytes((json.dumps(lineage,indent=2)+'\n').encode())
print(json.dumps(lineage,indent=2))
