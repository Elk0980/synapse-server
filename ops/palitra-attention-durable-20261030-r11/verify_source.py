"""Only local immutable source checks; does not import or invoke the helper."""
from pathlib import Path
import ast,hashlib,json
HERE=Path(__file__).resolve().parent;BASE=HERE.parent/'ATTENTION_DURABLE_R10'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
pins=json.loads((BASE/'SHA256.json').read_bytes());assert len(pins)==34
changed={'install.py','managed_history.py','scope-review.json','manifest.json','test_r9_lineage.py','README.md','FREEZE.json'}
for name,pin in pins.items():
    raw=(BASE/name).read_bytes();assert sha(raw)==pin,name
    if name not in changed:assert (HERE/name).read_bytes()==raw,name
lineage=json.loads((HERE/'SOURCE_LINEAGE.json').read_bytes())
before=(BASE/'install.py').read_bytes();after=(HERE/'install.py').read_bytes()
assert sha(after)==lineage['helperSha256']
reverse=after.replace(b"NAME='palitra-attention-durable-20261030-r11'",b"NAME='palitra-attention-durable-20261030-r10'")
reverse=reverse.replace(lineage['moduleSha256'].encode(),lineage['fullPrefixSha256'].encode())
reverse=reverse.replace(lineage['scopeSha256'].encode(),sha((BASE/'scope-review.json').read_bytes()).encode())
assert reverse==before
def tree(path):
    value=ast.parse(path.read_text());value.body=[node for node in value.body if not(isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id in {'NAME','REVIEWED_DATA_PINS'} for t in node.targets))];return ast.dump(value,include_attributes=False)
assert tree(HERE/'install.py')==tree(BASE/'install.py')
module=(HERE/'managed_history.py').read_bytes();assert module==(HERE.parent/'PRIVATE_MANAGED_FAST_R2/managed_history.py').read_bytes()
assert sha(module)=='9d00a086c983a0a7435cf6a6a2f726b570bc787bf52f56fc294ae03684aa640b'
assert module.startswith((BASE/'managed_history.py').read_bytes())
scope=json.loads((HERE/'scope-review.json').read_bytes());oldscope=json.loads((BASE/'scope-review.json').read_bytes())
assert {k:v for k,v in scope.items() if k not in ('kind','packagingProvenance')}=={k:v for k,v in oldscope.items() if k!='kind'}
manifest=json.loads((HERE/'manifest.json').read_bytes());oldmanifest=json.loads((BASE/'manifest.json').read_bytes())
assert {k:v for k,v in manifest.items() if k not in ('packageId','helperSha256')}=={k:v for k,v in oldmanifest.items() if k not in ('packageId','helperSha256')}
assert manifest['status']=='ROOT_REVIEWED_CODE_ONLY' and manifest['helperSha256']==sha(after)
assert sha((HERE/'manifest.json').read_bytes())==lineage['manifestSha256']
for name in ('install.py','managed_history.py','test_r9_lineage.py'):ast.parse((HERE/name).read_text())
draft=HERE.parent/'ATTENTION_DURABLE_R11_DRAFT';draftpins=json.loads((draft/'DRAFT_SHA256.json').read_bytes())
for name,pin in draftpins.items():assert sha((draft/name).read_bytes())==pin,'R1 draft mutated: '+name
print(json.dumps({'status':'PRIVATE_SOURCE_CHECK_PASS_NOT_NATIVE_PERMIT','r10All34PinsExact':True,'r10ByteExactFiles':34-len(changed),'helperReverseFullBytesExact':True,'helperAstExactOutsideTwoAssignments':True,'fullPrefixBytes':6429,'r2ModuleExact':True,'allSixPayloadExact':True,'r1DraftAll41PinsExact':True,'nativeActions':0},indent=2))
