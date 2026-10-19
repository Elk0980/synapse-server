"""Native, isolated NEBO site import. No source, permissions, or other site edits."""
from pathlib import Path, PurePosixPath
import getpass, hashlib, json, os, subprocess, sys, zipfile

BASE = Path('/opt/synapse/releases/nebo-project-20261020-r3')
ROOT = BASE/'site-import'
CONTAINER = 'synapse-content-1'
IMAGE = 'sha256:40c8fc48d96478d65d87e72954a29731cbad9d64e11c2a68df92a86c9aee4717'
URL = 'https://s3.twcstorage.ru/synapse-biznes/nebo-20261020/'
FILES = {
 'nebo-site-static-v9.zip':'29edaaf38be4896351dc0bc54b2d183f03a2f931e55adfe790623b7ce6bfbd30',
 'nebo-project-materials-v9.aes256gcm':'f3b1c2dd8f4f76723b011c3beabb7fbb473250b6f0595f1507a030798263c2f4',
}
PRIVATE_SHA = '1fbf51dce70fc2b940c9f142dbc737dcfd6761d7ef82ef6f99bd5c8f67ffa3ca'
MODULES=['server.js','site-store.js','site-workspaces.js','site-workspace-feature.js','auth-store.js']
def run(*args):return subprocess.check_output(args,text=True).strip()
def sha(data):return hashlib.sha256(data).hexdigest()
def save(name,data):
    f=ROOT/name
    with f.open('x') as s:json.dump(data,s,ensure_ascii=False,indent=2)
    f.chmod(0o600)
def guard():
    holders=[l.split()[0] for l in run('lslocks','-n','-o','pid,path').splitlines() if l.split()[-1:]==['/opt/synapse/.palitra-app-release.lock']]
    assert holders==['3153782'],'OWN_LEASE_REQUIRED'
    row=json.loads(run('docker','inspect',CONTAINER))[0]
    assert row['Image']==IMAGE,'EXACT_CURRENT_IMAGE_REQUIRED'
    audit=json.loads((BASE/'AUDIT_CURRENT_R5.json').read_text())
    assert audit['effectiveEnvironmentValuesExact'] and audit['otherContainersExact']
    return row
def code_hashes():
    return {p:sha(subprocess.check_output(['docker','exec',CONTAINER,'cat','/app/'+p])) for p in MODULES}
def unpack(archive,target):
    assert not target.exists(),'NEW_EXTRACTION_DIRECTORY_REQUIRED'
    with zipfile.ZipFile(archive) as z:
        rows=z.infolist();assert len(rows)<10000 and sum(r.file_size for r in rows)<600*1024*1024
        for r in rows:
            p=PurePosixPath(r.filename)
            assert not p.is_absolute() and '..' not in p.parts and '\\' not in r.filename
            assert ((r.external_attr>>16)&0o170000)!=0o120000,'NO_SYMLINKS'
        target.mkdir(mode=0o700)
        z.extractall(target)
    for p in target.rglob('*'):p.chmod(0o700 if p.is_dir() else 0o600)
    return len([p for p in target.rglob('*') if p.is_file()])
def stage():
    row=guard();assert not ROOT.exists(),'NEW_STAGE_REQUIRED';ROOT.mkdir(mode=0o700)
    mount=next(m['Source'] for m in row['Mounts'] if m['Destination']=='/data')
    data=Path(mount)/'nebo-project-20261020'
    assert not data.exists(),'NEW_DATA_NAMESPACE_REQUIRED';data.mkdir(mode=0o700)
    for name,digest in FILES.items():
        target=data/name
        subprocess.run(['curl','-fSsLo',str(target),URL+name],check=True)
        target.chmod(0o600);assert sha(target.read_bytes())==digest,'ARCHIVE_SHA_REQUIRED'
    count=unpack(data/'nebo-site-static-v9.zip',data/'static')
    assert (data/'static/index.html').is_file(),'STATIC_INDEX_REQUIRED'
    native={p:subprocess.check_output(['docker','exec',CONTAINER,'cat','/app/'+p]).decode() for p in MODULES}
    import re
    patterns=[r"const latestStmt = db\.prepare\([\s\S]*?\);",r"const insertStmt = db\.prepare\([\s\S]*?\);",r"function nextVersion\([\s\S]*?\n\}",r"function saveVersion\([\s\S]*?\n\}"]
    snippets=[]
    for pattern in patterns:
        matches=re.findall(pattern,native['server.js']);assert len(matches)==1,'NATIVE_SAVE_FUNCTION_REQUIRED';snippets.append(matches[0])
    assert 'path.dirname(databasePath)' in native['site-workspace-feature.js'] and "'projects'" in native['site-workspace-feature.js']
    bundle='\n'.join(snippets)+'\nsaveVersion;'
    (ROOT/'native-save-function.js').write_text(bundle)
    facts={'status':'STAGED_NO_DATABASE_WRITES','hostData':str(data),'containerData':'/data/nebo-project-20261020','staticFiles':count,'moduleHashes':code_hashes(),'nativeSaveSha':sha(bundle.encode())}
    save('STAGED.json',facts);print(json.dumps(facts));print(bundle)
def decrypt():
    guard();s=json.loads((ROOT/'STAGED.json').read_text());data=Path(s['hostData'])
    assert not (data/'nebo-project-materials-v9.zip').exists(),'PRIVATE_ARCHIVE_ALREADY_PRESENT'
    key=getpass.getpass('Private transfer key (hidden): ')
    assert len(key)==64 and all(c in '0123456789abcdef' for c in key),'KEY_FORMAT_REQUIRED'
    script=r"""const fs=require('node:fs'),c=require('node:crypto');let key='';process.stdin.on('data',v=>key+=v);process.stdin.on('end',()=>{const r='/data/nebo-project-20261020/',b=fs.readFileSync(r+'nebo-project-materials-v9.aes256gcm'),d=c.createDecipheriv('aes-256-gcm',Buffer.from(key.trim(),'hex'),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));const out=Buffer.concat([d.update(b.subarray(28)),d.final()]);if(c.createHash('sha256').update(out).digest('hex')!=='1fbf51dce70fc2b940c9f142dbc737dcfd6761d7ef82ef6f99bd5c8f67ffa3ca')throw Error('PRIVATE_SHA_REQUIRED');fs.writeFileSync(r+'nebo-project-materials-v9.zip',out,{mode:0o600,flag:'wx'});});"""
    subprocess.run(['docker','exec','-i',CONTAINER,'node','-e',script],input=key.encode(),check=True)
    key=None
    assert sha((data/'nebo-project-materials-v9.zip').read_bytes())==PRIVATE_SHA
    count=unpack(data/'nebo-project-materials-v9.zip',data/'materials')
    save('PRIVATE_MATERIALS.json',{'status':'PRIVATE_ARCHIVE_VERIFIED','files':count,'sha256':PRIVATE_SHA});print('PRIVATE_MATERIALS_VERIFIED',count)
def apply():
    guard();s=json.loads((ROOT/'STAGED.json').read_text())
    assert code_hashes()==s['moduleHashes'],'NATIVE_MODULES_CHANGED'
    assert not (ROOT/'APPLY_STARTED.json').exists(),'NO_REPEATED_APPLY'
    assert (ROOT/'PRIVATE_MATERIALS.json').exists(),'PRIVATE_MATERIALS_REQUIRED'
    bundle=(ROOT/'native-save-function.js').read_text();assert sha(bundle.encode())==s['nativeSaveSha']
    script=r"""
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {DatabaseSync,backup}=require('node:sqlite');
const db=new DatabaseSync('/data/content.sqlite');db.exec('PRAGMA busy_timeout=10000');
const prior=db.prepare("SELECT id,company_code,name,public_url FROM managed_sites WHERE company_code!='nebo' ORDER BY id").all();
assert.equal(db.prepare("SELECT count(*) n FROM managed_sites WHERE company_code='nebo'").get().n,0,'Nebo site already exists; inspect before continuing');
const crm=db.prepare("SELECT id FROM companies WHERE code='nebo'").get();assert(crm);
backup(db,'/data/nebo-project-20261020/content-before-site.sqlite').then(()=>{
fs.chmodSync('/data/nebo-project-20261020/content-before-site.sqlite',0o600);
const {createAuthStore,COMPANIES}=require('/app/auth-store');
const auth=createAuthStore(db,'');const user=auth.getByLogin('vladislav');
assert.equal(user.role,'owner');assert(user.companyCodes.includes('nebo'));
const native=fs.readFileSync('/data/nebo-project-20261020/native-save-function.js','utf8');
const saveVersion=vm.runInNewContext(native,{db,Date,JSON});
const {createSiteStore}=require('/app/site-store');const sites=createSiteStore(db,auth,saveVersion);
const created=sites.create(user,{name:'Небо — сайт-экскурсия',companyCode:'nebo'});
fs.writeFileSync('/data/nebo-project-20261020/CREATED_SITE.json',JSON.stringify(created),{mode:0o600,flag:'wx'});
const {createWorkspaceStore}=require('/app/site-workspaces');
const store=createWorkspaceStore({db,root:'/data/projects',companies:COMPANIES,audit:auth.audit,sources:{[created.id]:{root:'/data/nebo-project-20261020/static',companyCode:'nebo',runtime:'static'}}});
const result=store.adopt(user,created.id,{hostname:'nebo-draft-1.synapsebusiness.ru'});
assert.deepEqual(db.prepare("SELECT id,company_code,name,public_url FROM managed_sites WHERE company_code!='nebo' ORDER BY id").all(),prior);
const check=store.workspace(user,created.id);assert.equal(check.revision,result.revision);assert(check.files.length>100);
const outcome={status:'NATIVE_SITE_IMPORTED',siteId:created.id,publicUrl:result.publicUrl,revision:result.revision,files:result.files.length,otherSiteRowsExact:true};
fs.writeFileSync('/data/nebo-project-20261020/SITE_OUTCOME.json',JSON.stringify(outcome,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify(outcome));db.close();
}).catch(e=>{console.error(e.message);process.exitCode=1;});
"""
    data=Path(s['hostData']);(data/'native-save-function.js').write_text(bundle);(data/'native-save-function.js').chmod(0o600)
    save('APPLY_STARTED.json',{'phase':'native-create-and-adopt','image':IMAGE})
    result=run('docker','exec',CONTAINER,'node','-e',script)
    save('OUTCOME.json',json.loads(result));print(result)

if __name__=='__main__':
    assert len(sys.argv)==2 and sys.argv[1] in ['stage','decrypt','apply']
    {'stage':stage,'decrypt':decrypt,'apply':apply}[sys.argv[1]]()
