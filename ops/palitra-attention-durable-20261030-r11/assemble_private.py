"""Exact private packaging. No helper import, network, native command or phase."""
from pathlib import Path
import hashlib,json,difflib
HERE=Path(__file__).resolve().parent
BASE=HERE.parent/'ATTENTION_DURABLE_R10'
DRAFT=HERE.parent/'ATTENTION_DURABLE_R11_DRAFT'
FAST=HERE.parent/'PRIVATE_MANAGED_FAST_R2/managed_history.py'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
pins=json.loads((BASE/'SHA256.json').read_bytes())
assert len(pins)==34
for name,pin in pins.items():
    rel=Path(name);assert not rel.is_absolute() and '..' not in rel.parts
    raw=(BASE/rel).read_bytes();assert sha(raw)==pin,name
    dst=HERE/rel;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(raw)
full=(BASE/'managed_history.py').read_bytes();fast=FAST.read_bytes()
assert sha(full)=='69690754e6efb394e3fede769257dc39df7fd1fe221d018c5cd7f77e346aa2cd'
assert sha(fast)=='9d00a086c983a0a7435cf6a6a2f726b570bc787bf52f56fc294ae03684aa640b'
assert fast.startswith(full)
(HERE/'managed_history.py').write_bytes(fast)
scope=json.loads((BASE/'scope-review.json').read_bytes())
scope['kind']='private-r11-attention-combined-fastR2-code-only-NOT_NATIVE_PERMIT'
scope['packagingProvenance']={'namespace':'palitra-attention-durable-20261030-r11','basisNamespace':'palitra-attention-durable-20261030-r10','basisRegistrySha256':sha((BASE/'SHA256.json').read_bytes()),'selectedManagedModule':'PRIVATE_MANAGED_FAST_R2/managed_history.py','selectedModuleSha256':sha(fast),'fullOriginalPrefixSha256':sha(full),'nativeActions':0,'rootFinalReviewRequired':True,'nativePermit':False}
scopeRaw=(json.dumps(scope,ensure_ascii=False,indent=2)+'\n').encode('utf-8');(HERE/'scope-review.json').write_bytes(scopeRaw)
before=(BASE/'install.py').read_bytes();assert sha(before)=='545f12e62f9cb2fed1a8cb3a9172d5720fc5781d4c2bd785c363a87c90997eda'
edits=[(b"NAME='palitra-attention-durable-20261030-r10'",b"NAME='palitra-attention-durable-20261030-r11'"),(sha(full).encode(),sha(fast).encode()),(sha((BASE/'scope-review.json').read_bytes()).encode(),sha(scopeRaw).encode())]
after=before
for old,new in edits:assert after.count(old)==1;after=after.replace(old,new,1)
reverse=after
for old,new in reversed(edits):assert reverse.count(new)==1;reverse=reverse.replace(new,old,1)
assert reverse==before
(HERE/'install.py').write_bytes(after)
(HERE/'R10_TO_R11.diff').write_bytes(''.join(difflib.unified_diff(before.decode().splitlines(True),after.decode().splitlines(True),fromfile='R10/install.py',tofile='R11/install.py')).encode())
manifest=json.loads((BASE/'manifest.json').read_bytes());manifest.update(packageId='palitra-attention-durable-20261030-r11',helperSha256=sha(after))
assert manifest['status']=='ROOT_REVIEWED_CODE_ONLY'
(HERE/'manifest.json').write_bytes((json.dumps(manifest,indent=2)+'\n').encode())
test=(DRAFT/'test_r9_lineage.py').read_text()
test=test.replace('PRIVATE_MANAGED_FAST_R1/managed_history.py','PRIVATE_MANAGED_FAST_R2/managed_history.py').replace('66d4c382288764181e5e86d89f3163dca6553c48b8808f92b0a9e3a1aff32bbf',sha(fast))
oldtest="""  self.assertFalse((HERE/'manifest.json').exists());self.assertFalse((HERE/'FREEZE.json').exists())
  draft=json.loads((HERE/'manifest.draft.NOTPERMIT.json').read_bytes())
  self.assertEqual(draft['status'],'DRAFT_NOTPERMIT')
  with self.assertRaisesRegex(ValueError,'ROOT_REVIEW_REQUIRED'):new.validate_manifest(draft)
"""
newtest="""  actual=json.loads((HERE/'manifest.json').read_bytes());self.assertEqual(actual['status'],'ROOT_REVIEWED_CODE_ONLY')
  self.assertEqual(new.validate_manifest(actual),actual)
  self.assertEqual(actual['helperSha256'],hashlib.sha256((HERE/'install.py').read_bytes()).hexdigest())
  unreviewed=dict(actual,status='DRAFT_NOTPERMIT')
  with self.assertRaisesRegex(ValueError,'ROOT_REVIEW_REQUIRED'):new.validate_manifest(unreviewed)
"""
assert test.count(oldtest)==1
(HERE/'test_r9_lineage.py').write_bytes(test.replace(oldtest,newtest).encode())
lineage={'status':'PRIVATE_R11_CODE_ONLY_PENDING_ROOT_REVIEW_NOT_NATIVE_PERMIT','nativeActions':0,'sourceR10RegistrySha256':sha((BASE/'SHA256.json').read_bytes()),'r10All34Verified':True,'basisR10HelperSha256':sha(before),'helperSha256':sha(after),'moduleSha256':sha(fast),'fullPrefixSha256':sha(full),'fullPrefixBytes':len(full),'fullPrefixByteExact':True,'helperReverseByteExactR10':True,'helperChangesOnly':['NAME','managed_history.py pin','scope-review.json provenance pin'],'scopeSha256':sha(scopeRaw),'manifestSha256':sha((HERE/'manifest.json').read_bytes()),'manifestTechnicalStatus':'ROOT_REVIEWED_CODE_ONLY','sameSixPayload':True,'rootFinalReviewRequired':True,'draftR1Untouched':True}
(HERE/'SOURCE_LINEAGE.json').write_bytes((json.dumps(lineage,indent=2)+'\n').encode())
print(json.dumps(lineage,indent=2))
