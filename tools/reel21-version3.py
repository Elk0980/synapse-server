"""One authorized ASCII POST: board 283/2282, owner decision 307/2279.

No credential leaves content. An exclusive marker prevents retries, including
after timeout. Inspect mode is read-only and never submits anything.
"""
import base64,json,os,re,subprocess,sys,zlib
from pathlib import Path

ROOT=Path('/root/claude-rel')
MARK=ROOT/'reel21-v3-2282.started'
RESULT=ROOT/'reel21-v3-2282.result.json'
PROGRAM=r'''
(async()=>{
 const key=process.env.CRM_API_KEY;if(!key)throw Error();
 const data=require('fs').readFileSync(0,'utf8');
 const r=await fetch('http://crm:8080/internal/reel-materials/reels/21/versions?companyCode=taisabai',{
 method:'POST',headers:{'x-api-key':key,'x-agent-name':'Claude','content-type':'application/json'},
 body:data,redirect:'error',signal:AbortSignal.timeout(15000)});
 let body={};try{body=await r.json()}catch{}
 const error=typeof body.error==='string'&&/^[a-z0-9_:-]{1,120}$/i.test(body.error)?body.error:null;
 console.log(JSON.stringify({http:r.status,version:Number.isSafeInteger(body.version?.version)?body.version.version:null,error}));
})().catch(()=>{console.log(JSON.stringify({http:0,version:null,error:'transport_unknown'}));process.exitCode=1});
'''
INSPECT=r'''
const db=new(require('node:sqlite').DatabaseSync)('/data/crm.sqlite',{readOnly:true});
const rows=db.prepare('SELECT v.version FROM reel_versions v JOIN reel_materials r ON r.id=v.reel_id JOIN companies c ON c.id=r.company_id WHERE r.id=21 AND lower(c.code)=? ORDER BY v.version').all('taisabai');
console.log(JSON.stringify({versions:rows.map(r=>r.version)}));db.close();
'''

def decode(arg):
    data=zlib.decompress(base64.urlsafe_b64decode(arg))
    body=json.loads(data)
    if len(data)>4096 or not data.isascii() or set(body)!={'mediaUrl','sha256','durationMs'} or body['durationMs']!=59900:
        raise ValueError('body')
    if not re.fullmatch(r'https://synapse\.synapsebusiness\.ru/content/publishing-assets/taisabai/[a-f0-9]{32}\.mp4',body['mediaUrl']) or not re.fullmatch('[a-f0-9]{64}',body['sha256']):
        raise ValueError('body')
    return data

def main():
    if sys.argv[1:]==['inspect']:
        r=subprocess.run(['docker','exec','synapse-crm-1','node','-e',INSPECT],capture_output=True,timeout=15)
        print(json.dumps(json.loads(r.stdout),separators=(',',':')) if r.returncode==0 else 'READONLY_UNAVAILABLE')
        return r.returncode
    try:
        if len(sys.argv)!=3 or sys.argv[1]!='submit':raise ValueError('mode')
        data=decode(sys.argv[2])
        try:
            fd=os.open(MARK,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        except FileExistsError:
            print('{"http":0,"version":null}')
            return 1
        with os.fdopen(fd,'w') as f:f.write('283/2282: one attempt; never repeat.\n')
        r=subprocess.run(['docker','exec','-i','synapse-content-1','node','-e',PROGRAM],input=data,capture_output=True,timeout=25)
        answer=json.loads(r.stdout)
    except Exception:
        answer={'http':0,'version':None,'error':'local_or_transport_unknown'}
    with os.fdopen(os.open(RESULT,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f:json.dump(answer,f)
    print(json.dumps({'http':answer['http'],'version':answer['version']},separators=(',',':')))
    return 0 if 200<=answer['http']<300 else 1

if __name__=='__main__':sys.exit(main())
