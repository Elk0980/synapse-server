"""One observer: cold mobile preview measurement, then two authorized warmups.

URLs remain private. No version, segment, claim, publication or credentials write.
"""
import hashlib,importlib.util,json,re,sys,time,urllib.request,urllib.parse
from pathlib import Path
ROOT=Path('/root/claude-rel');PRE=ROOT/'pre662'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
HTTP=urllib.request.build_opener(NoRedirect())
def load_base():
 p=ROOT/'r662.py'
 if hashlib.sha256(p.read_bytes()).hexdigest()!='977f3d39d57bd8409193f07003cf7b18a3a2d675ed3e2b05119e695632931ce2':raise RuntimeError('base_helper_changed')
 spec=importlib.util.spec_from_file_location('preflight662',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def metadata(b,n):
 program=r'''
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/crm.sqlite',{readOnly:true});
const row=db.prepare('SELECT v.version,v.media_url AS mediaUrl,v.sha256,v.duration_ms AS durationMs FROM reel_versions v JOIN reel_materials r ON r.id=v.reel_id JOIN companies c ON c.id=r.company_id WHERE r.id=? AND lower(c.code)=? AND v.version=2').get(REEL,'taisabai');
console.log(JSON.stringify(row||null));db.close();
'''.replace('REEL',str(n))
 row=json.loads(b.run(['docker','exec','-i',b.container('crm'),'node'],input=program.encode()))
 if not row or row['version']!=2:raise RuntimeError('version2_missing')
 u=urllib.parse.urlsplit(row['mediaUrl'])
 if u.scheme!='https' or u.netloc!='synapse.synapsebusiness.ru' or u.query or not re.fullmatch(r'/content/publishing-assets/taisabai/[a-f0-9]{32}\.mp4',u.path):raise RuntimeError('media_scope')
 if not re.fullmatch('[a-f0-9]{64}',row['sha256']):raise RuntimeError('source_sha')
 row['name']=u.path.rsplit('/',1)[1];return row
def filemeta(b,row):
 program=r'''
const fs=require('fs'),path=require('path'),crypto=require('crypto');const data=JSON.parse(fs.readFileSync(0,'utf8'));
const base=process.env.ASSETS_DIR||path.join(path.dirname(process.env.DATABASE_PATH||'/data/content.sqlite'),'assets');
const source=path.join(base,'publishing','taisabai',data.name),preview=path.join(base,'publishing-previews','mobile-v1','taisabai',data.name);
const cached=fs.statSync(preview,{throwIfNoEntry:false});
console.log(JSON.stringify({inputBytes:fs.statSync(source).size,originalSha:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),cached:!!(cached?.isFile()&&cached.size>0),previewBytes:cached?.isFile()?cached.size:0}));
'''
 return json.loads(b.run(['docker','exec','-i',b.container('content'),'node','-e',program],input=json.dumps({'name':row['name']}).encode()))
def state(url):
 with HTTP.open(urllib.request.Request(url,headers={'Cache-Control':'no-cache'}),timeout=15) as r:
  if r.status!=200 or not r.headers.get('Content-Type','').startswith('application/json'):raise RuntimeError('status_http_or_type')
  data=json.loads(r.read(4096));s=data.get('state')
 if s not in ('ready','queued','preparing','busy','failed'):raise RuntimeError('status_unknown')
 return s
def check_http(url,size):
 with HTTP.open(urllib.request.Request(url,method='HEAD'),timeout=15) as r:
  if r.status!=200 or int(r.headers.get('Content-Length','-1'))!=size:raise RuntimeError('original_head')
 with HTTP.open(urllib.request.Request(url,headers={'Range':'bytes=0-15'}),timeout=15) as r:
  if r.status!=206 or r.headers.get('Content-Range')!='bytes 0-15/'+str(size) or len(r.read(17))!=16:raise RuntimeError('original_range')
def measure(b,n):
 for s in b.SERVICES:
  if b.readjson(PRE/('verified-'+s+'.json'))['image']!=b.inspect_container(s)['Image']:raise RuntimeError('verified_image_changed')
 ff=b.readjson(PRE/'live-ffmpeg.json')
 if not ff['sample'] or ff['image']!=b.inspect_container('content')['Image']:raise RuntimeError('live_ffmpeg_required')
 if (PRE/('preview-'+str(n)+'.started')).exists() or (PRE/('preview-'+str(n)+'.json')).exists():raise RuntimeError('already_observed_do_not_repeat')
 row=metadata(b,n);before=filemeta(b,row)
 if before['originalSha']!=row['sha256']:raise RuntimeError('original_sha_mismatch')
 if n==22 and (before['inputBytes']!=43803232 or row['durationMs']!=83797):raise RuntimeError('cold_source_mismatch')
 check_http(row['mediaUrl'],before['inputBytes'])
 b.save(PRE/('preview-'+str(n)+'.started'),json.dumps({'reel':n,'version':2,'cachedBefore':before['cached'],'at':time.time()}).encode())
 print('PREVIEW_BEFORE',n,json.dumps({'cached':before['cached'],'inputBytes':before['inputBytes']}),flush=True)
 start=time.monotonic();first=None;last=None;ready=before['cached'];failure=None
 try:
  if not ready:
   url=row['mediaUrl']+'?preview=mobile-v1&status=1'
   last=first=state(url);print('FIRST_STATE',n,first,flush=True)
   while last!='ready':
    if last=='failed':raise RuntimeError('preview_failed')
    if time.monotonic()-start>=180:raise RuntimeError('preview_timeout')
    time.sleep(1.5);last=state(url)
   ready=True
  elapsed=round(time.monotonic()-start,3) if not before['cached'] else None
  after=filemeta(b,row)
  unchanged=after['originalSha']==before['originalSha']==row['sha256']
  if not unchanged or not after['cached'] or after['previewBytes']<=0:raise RuntimeError('preview_or_original_verification')
  with HTTP.open(urllib.request.Request(row['mediaUrl']+'?preview=mobile-v1&cached=1',headers={'Range':'bytes=0-15'}),timeout=15) as r:
   if r.status!=206 or r.headers.get('Content-Range')!='bytes 0-15/'+str(after['previewBytes']) or len(r.read(17))!=16:raise RuntimeError('preview_range')
  result={'reel':n,'version':2,'ready':True,'cachedBefore':before['cached'],'cold':n==22 and not before['cached'] and first in ('preparing','queued'),'firstState':first,'elapsedSec':elapsed,'includesQueue':first=='queued','inputBytes':before['inputBytes'],'previewBytes':after['previewBytes'],'originalSHAunchanged':unchanged,'original200':True,'originalRange206':True,'previewRange206':True}
 except Exception as e:
  result={'reel':n,'version':2,'ready':False,'cachedBefore':before['cached'],'firstState':first,'lastState':last,'elapsedSec':round(time.monotonic()-start,3),'inputBytes':before['inputBytes'],'error':str(e) if isinstance(e,RuntimeError) else type(e).__name__}
 b.save(PRE/('preview-'+str(n)+'.json'),json.dumps(result).encode());print('PREVIEW662_RESULT',json.dumps(result),flush=True)
 if not result['ready']:raise RuntimeError('preview_not_ready_stop')
 return 0
def main():
 if len(sys.argv)!=2 or sys.argv[1] not in ('22','23','24'):raise RuntimeError('scope')
 return measure(load_base(),int(sys.argv[1]))
if __name__=='__main__':
 try:sys.exit(main())
 except Exception as e:
  print('STOP662_PREVIEW',str(e) if isinstance(e,RuntimeError) else type(e).__name__,flush=True);sys.exit(1)
