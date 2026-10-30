"""Local source/lineage verification only; no installer or native execution."""
from pathlib import Path
import ast,hashlib,json
HERE=Path(__file__).resolve().parent;BASE=HERE.parent/'ATTENTION_DURABLE_R11'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
pins=json.loads((BASE/'SHA256.json').read_bytes());assert len(pins)==40
changed={'install.py','scope-review.json','manifest.json','test_r9_lineage.py','README.md','FREEZE.json','VERIFICATION.json','SOURCE_LINEAGE.json','verify_source.py'}
for name,pin in pins.items():
    raw=(BASE/name).read_bytes();assert sha(raw)==pin,name
    if name not in changed:assert (HERE/name).read_bytes()==raw,name
lineage=json.loads((HERE/'SOURCE_LINEAGE.json').read_bytes())
before=(BASE/'install.py').read_bytes();after=(HERE/'install.py').read_bytes()
assert sha(after)==lineage['helperSha256']
oldname=b"NAME='palitra-attention-durable-20261030-r11'";newname=b"NAME='palitra-attention-durable-20261030-r12'"
oldscope=sha((BASE/'scope-review.json').read_bytes()).encode();newscope=lineage['scopeSha256'].encode()
assert after.count(newname)==after.count(newscope)==1
assert after.replace(newname,oldname,1).replace(newscope,oldscope,1)==before

def tree(path):
    value=ast.parse(path.read_text());value.body=[node for node in value.body if not(isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id in {'NAME','REVIEWED_DATA_PINS'} for t in node.targets))];return ast.dump(value,include_attributes=False)
assert tree(HERE/'install.py')==tree(BASE/'install.py')
module=(HERE/'managed_history.py').read_bytes();assert module==(BASE/'managed_history.py').read_bytes()==(HERE.parent/'PRIVATE_MANAGED_FAST_R2/managed_history.py').read_bytes()
assert sha(module)=='9d00a086c983a0a7435cf6a6a2f726b570bc787bf52f56fc294ae03684aa640b'
full=(HERE.parent/'ATTENTION_DURABLE_R10/managed_history.py').read_bytes();assert len(full)==6429 and module.startswith(full)
scope=json.loads((HERE/'scope-review.json').read_bytes());old=json.loads((BASE/'scope-review.json').read_bytes())
assert {k:v for k,v in scope.items() if k not in ('kind','packagingProvenance')}=={k:v for k,v in old.items() if k not in ('kind','packagingProvenance')}
manifest=json.loads((HERE/'manifest.json').read_bytes());old=json.loads((BASE/'manifest.json').read_bytes())
assert {k:v for k,v in manifest.items() if k not in ('packageId','helperSha256')}=={k:v for k,v in old.items() if k not in ('packageId','helperSha256')}
assert manifest['status']=='ROOT_REVIEWED_CODE_ONLY' and manifest['helperSha256']==sha(after)
assert sha((HERE/'manifest.json').read_bytes())==lineage['manifestSha256']
for name in ('install.py','managed_history.py','test_r9_lineage.py'):ast.parse((HERE/name).read_text())
for dirname,registry in [('ATTENTION_DURABLE_R11_DRAFT','DRAFT_SHA256.json'),('PRIVATE_MANAGED_FAST_R1','SHA256.json'),('PRIVATE_MANAGED_FAST_R2','SHA256.json')]:
    folder=HERE.parent/dirname
    for name,pin in json.loads((folder/registry).read_bytes()).items():assert sha((folder/name).read_bytes())==pin,dirname+':'+name
print(json.dumps({'status':'PRIVATE_R12_SOURCE_PASS_NOT_NATIVE_PERMIT','r11All40PinsExact':True,'r11ByteExactFiles':40-len(changed),'helperReverseTwoLiteralsByteExact':True,'helperAstExactOutsideTwoAssignments':True,'r2ExactAndUnchanged':True,'fullPrefix6429Exact':True,'allSixPayloadExact':True,'r1R2DraftRegistriesUnchanged':True,'nativeActions':0},indent=2))
