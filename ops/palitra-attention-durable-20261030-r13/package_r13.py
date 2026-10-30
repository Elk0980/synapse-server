"""Private code packaging only; never imports an installer or invokes a phase."""
from pathlib import Path
import hashlib,json,difflib
HERE=Path(__file__).resolve().parent;BASE=HERE.parent/'ATTENTION_DURABLE_R12'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
registryRaw=(BASE/'SHA256.json').read_bytes();assert sha(registryRaw)=='465c5bc6f2a9e33eaf104a4d4e0c9dfac751046c695d85bea3179fcd5c566c4c'
pins=json.loads(registryRaw);assert len(pins)==42
for name,pin in pins.items():
 rel=Path(name);assert not rel.is_absolute() and '..' not in rel.parts
 raw=(BASE/rel).read_bytes();assert sha(raw)==pin,name
 dst=HERE/rel;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(raw)
module=(HERE/'managed_history.py').read_bytes();assert sha(module)=='9d00a086c983a0a7435cf6a6a2f726b570bc787bf52f56fc294ae03684aa640b'
assert module==(HERE.parent/'PRIVATE_MANAGED_FAST_R2/managed_history.py').read_bytes()
full=(HERE.parent/'ATTENTION_DURABLE_R10/managed_history.py').read_bytes();assert len(full)==6429 and module.startswith(full)
scope=json.loads((BASE/'scope-review.json').read_bytes())
scope['kind']='private-r13-attention-combined-fastR2-fresh-base-code-only-NOT_NATIVE_PERMIT'
scope['packagingProvenance']={'namespace':'palitra-attention-durable-20261030-r13','basisNamespace':'palitra-attention-durable-20261030-r12','basisRegistrySha256':sha(registryRaw),'selectedManagedModule':'PRIVATE_MANAGED_FAST_R2/managed_history.py','selectedModuleSha256':sha(module),'fullOriginalPrefixSha256':sha(full),'freshBaseRequired':True,'sealedPredecessorNotReplayed':True,'nativeActions':0,'rootFinalReviewRequired':True,'nativePermit':False}
scopeRaw=(json.dumps(scope,ensure_ascii=False,indent=2)+'\n').encode();(HERE/'scope-review.json').write_bytes(scopeRaw)
before=(BASE/'install.py').read_bytes();assert sha(before)=='280d7e97d6ceb38ade4e0a9eb37185bc5a8174fd149d6bf3e36840d833cc5e0e'
edits=[(b"NAME='palitra-attention-durable-20261030-r12'",b"NAME='palitra-attention-durable-20261030-r13'"),(sha((BASE/'scope-review.json').read_bytes()).encode(),sha(scopeRaw).encode())]
after=before
for old,new in edits:assert after.count(old)==1;after=after.replace(old,new,1)
reverse=after
for old,new in reversed(edits):assert reverse.count(new)==1;reverse=reverse.replace(new,old,1)
assert reverse==before
(HERE/'install.py').write_bytes(after)
(HERE/'R12_TO_R13.diff').write_bytes(''.join(difflib.unified_diff(before.decode().splitlines(True),after.decode().splitlines(True),fromfile='R12/install.py',tofile='R13/install.py')).encode())
manifest=json.loads((BASE/'manifest.json').read_bytes());manifest.update(packageId='palitra-attention-durable-20261030-r13',helperSha256=sha(after));assert manifest['status']=='ROOT_REVIEWED_CODE_ONLY'
(HERE/'manifest.json').write_bytes((json.dumps(manifest,indent=2)+'\n').encode())
test=(BASE/'test_r9_lineage.py').read_text().replace("BASE=HERE.parent/'ATTENTION_DURABLE_R11'","BASE=HERE.parent/'ATTENTION_DURABLE_R12'").replace("new.NAME,'palitra-attention-durable-20261030-r12'","new.NAME,'palitra-attention-durable-20261030-r13'")
assert test!=(BASE/'test_r9_lineage.py').read_text();(HERE/'test_r9_lineage.py').write_bytes(test.encode())
lineage={'status':'PRIVATE_R13_CODE_ONLY_PENDING_ROOT_REVIEW_NOT_NATIVE_PERMIT','nativeActions':0,'sourceR12RegistrySha256':sha(registryRaw),'r12All42Verified':True,'basisR12HelperSha256':sha(before),'helperSha256':sha(after),'moduleSha256':sha(module),'moduleByteExactR12':True,'fullPrefixSha256':sha(full),'fullPrefixBytes':len(full),'fullPrefixByteExact':True,'helperReverseByteExactR12':True,'helperChangesOnly':['NAME','scope-review.json provenance pin'],'scopeSha256':sha(scopeRaw),'manifestSha256':sha((HERE/'manifest.json').read_bytes()),'manifestTechnicalStatus':'ROOT_REVIEWED_CODE_ONLY','sameSixPayload':True,'freshBaseRequired':True,'sealedR12NotReplayed':True,'rootFinalReviewRequired':True}
(HERE/'SOURCE_LINEAGE.json').write_bytes((json.dumps(lineage,indent=2)+'\n').encode())
verifier=(BASE/'verify_source.py').read_text().replace("BASE=HERE.parent/'ATTENTION_DURABLE_R11'","BASE=HERE.parent/'ATTENTION_DURABLE_R12'").replace('len(pins)==40','len(pins)==42').replace("oldname=b\"NAME='palitra-attention-durable-20261030-r11'\";newname=b\"NAME='palitra-attention-durable-20261030-r12'\"","oldname=b\"NAME='palitra-attention-durable-20261030-r12'\";newname=b\"NAME='palitra-attention-durable-20261030-r13'\"").replace("'PRIVATE_R12_SOURCE_PASS_NOT_NATIVE_PERMIT'","'PRIVATE_R13_SOURCE_PASS_NOT_NATIVE_PERMIT'").replace("'r11All40PinsExact'","'r12All42PinsExact'").replace("'r11ByteExactFiles':40-len(changed)","'r12ByteExactFiles':42-len(changed)")
verifier=verifier.replace("[('ATTENTION_DURABLE_R11_DRAFT'","[('ATTENTION_DURABLE_R11','SHA256.json'),('ATTENTION_DURABLE_R11_DRAFT'")
assert verifier!=(BASE/'verify_source.py').read_text();(HERE/'verify_source.py').write_bytes(verifier.encode())
print(json.dumps(lineage,indent=2))
