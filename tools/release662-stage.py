"""Addressed staging/verification using the pinned preflight and existing prgo."""
import hashlib,importlib.util,json,os,re,shlex,subprocess,sys,time
from pathlib import Path
ROOT=Path('/root/claude-rel');PRE=ROOT/'pre662';WORK=ROOT/'w662'
BASE_SHA='977f3d39d57bd8409193f07003cf7b18a3a2d675ed3e2b05119e695632931ce2'
def load_base():
 p=ROOT/'r662.py'
 if hashlib.sha256(p.read_bytes()).hexdigest()!=BASE_SHA:raise RuntimeError('preflight_helper_changed')
 spec=importlib.util.spec_from_file_location('preflight662',p);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b);return b
def env_expected(image,config):
 env=dict(x.split('=',1) for x in image['Config'].get('Env',[]))
 env.update({k:'' if v is None else str(v).replace('$$','$') for k,v in config.get('environment',{}).items()})
 return env
def env_diff(expected,actual):return sorted(k for k in set(expected)|set(actual) if expected.get(k)!=actual.get(k))
def replace(b,p,data):
 tmp=p.with_name(p.name+'.checked662');b.save(tmp,data);os.replace(tmp,p)
def stage(b):
 receipt=b.readjson(PRE/'receipt.json');bk=b.readjson(PRE/'backup-before-build.json')
 if not receipt['ok'] or time.time()-bk['at']>1800:raise RuntimeError('fresh_backup_required')
 if WORK.exists():raise RuntimeError('work_already_exists_inspect_first')
 for name in ('prpatch.sh','prgo.sh','rel.sh'):
  if (ROOT/name).read_bytes()!=(PRE/name).read_bytes():raise RuntimeError('release_script_changed')
 for s in b.SERVICES:
  d=b.inspect_container(s);old=b.readjson(PRE/(s+'.private.json'))
  if d['Id']!=old['Id']:raise RuntimeError('live_container_changed:'+s)
  cfg=b.readjson(PRE/(s+'.compose.private.json'))['services'][s]
  expected=env_expected(b.readjson(PRE/(s+'.image.json')),cfg)
  diff=env_diff(expected,dict(x.split('=',1) for x in d['Config']['Env']))
  print('BASE_ENV_DIFF',s,json.dumps(diff),flush=True)
  if diff:raise RuntimeError('unclaimed_env_difference:'+s)
 for row in receipt['files']:
  n=row['path'].replace('/','__');p=PRE/'before'/n
  if b.live(row['path'])!=(p.read_bytes() if p.exists() else None):raise RuntimeError('live_file_changed:'+row['path'])
 m,_=b.packet()
 print(b.run([str(ROOT/'prpatch.sh'),'662',m['base'],m['head']],cwd=ROOT).decode().strip(),flush=True)
 prepared={};rollback=['#!/bin/bash','set -e']
 for s in b.SERVICES:
  old=b.readjson(PRE/(s+'.private.json'));args=b.readjson(PRE/('args-'+s+'.json'))
  build=WORK/('b-'+s);build.mkdir(mode=0o700)
  chosen=[r for r in receipt['files'] if r['path'].startswith('ops/'+s+'/') and not r['skip']]
  names=[]
  for row in chosen:
   name=row['path'].split('/')[-1];data=(PRE/'candidates'/row['path'].replace('/','__')).read_bytes()
   if b.sha(data)!=row['sha']:raise RuntimeError('candidate_changed')
   b.save(build/name,data);os.chmod(build/name,0o644);names.append(name)
  if not names:raise RuntimeError('empty_service_candidate:'+s)
  tag='synapse-'+s+':rollback-pr662'
  if b.run(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip()!=old['Image']:raise RuntimeError('base_tag_mismatch')
  if s=='content' and not b.run(['docker','exec',b.container(s),'cat','/etc/alpine-release']).strip():raise RuntimeError('content_not_alpine')
  recipe='FROM '+tag+'\n'+('RUN apk add --no-cache ffmpeg\n' if s=='content' else '')+''.join('COPY '+n+' /app/'+n+'\n' for n in names)
  b.save(build/'Dockerfile',recipe.encode());print('BUILD_START',s,flush=True)
  r=subprocess.run(['docker','build','--pull=false','-q','-t','synapse-'+s+':pr662-claude',str(build)],capture_output=True,timeout=600)
  b.save(PRE/('build-'+s+'.log'),r.stdout+r.stderr)
  if r.returncode:raise RuntimeError('build_failed:'+s)
  image=r.stdout.decode().strip().splitlines()[-1]
  if not re.fullmatch(r'sha256:[0-9a-f]{64}',image):raise RuntimeError('invalid_image')
  for n in names:b.run(['docker','run','--rm','--network','none','--entrypoint','node',image,'--check','/app/'+n])
  cand=WORK/('cand-'+s+'.json');rb=WORK/('rb-'+s+'.json')
  b.save(cand,json.dumps({'services':{s:{'image':image}}}).encode());b.save(rb,json.dumps({'services':{s:{'image':old['Image']}}}).encode())
  b.save(WORK/('args-'+s+'.cur'),shlex.join(args).encode());b.save(WORK/('args-'+s+'.new'),shlex.join(args+['-f',str(cand)]).encode())
  b.save(WORK/('img-'+s+'.new'),(image+'\n').encode());b.save(WORK/('files-'+s+'.txt'),('\n'.join(names)+'\n').encode())
  command=['docker','compose','-p','synapse','--project-directory','/opt/synapse']
  before=json.loads(b.run(command+args+['config','--format','json']));after=json.loads(b.run(command+args+['-f',str(cand),'config','--format','json']))
  if after['services'][s]['image']!=image:raise RuntimeError('candidate_not_effective')
  before['services'][s].pop('image',None);after['services'][s].pop('image',None)
  if before!=after:raise RuntimeError('compose_diff_beyond_image:'+s)
  prepared[s]={'image':image,'rollbackImage':old['Image'],'files':names};print('BUILT662',s,json.dumps(prepared[s]),flush=True)
  rollback.append(shlex.join(command+args+['-f',str(rb),'up','-d','--no-deps','--no-build',s]))
 replace(b,WORK/'svcs.txt',('\n'.join(b.SERVICES)+'\n').encode())
 rollback.append('[ ! -s '+str(WORK/'bkdir')+' ] || /root/claude-rel/rel.sh restore "$(cat '+str(WORK/'bkdir')+')"')
 replace(b,WORK/'rollback.sh',('\n'.join(rollback)+'\n').encode());os.chmod(WORK/'rollback.sh',0o700)
 b.save(WORK/'checked662.json',json.dumps(prepared,indent=2).encode());print('STAGE662_OK crm content tasks-mcp',flush=True);return 0
def health(b,s):
 if s=='crm':
  program="(async()=>{const r=await fetch('http://crm:8080/internal/reel-materials/queue?companyCode=taisabai',{headers:{'x-api-key':process.env.CRM_API_KEY},redirect:'error',signal:AbortSignal.timeout(8000)});console.log(r.status);if(!r.ok)process.exitCode=1})().catch(()=>process.exitCode=1)"
  return int(b.run(['docker','exec','-i',b.container('content'),'node'],input=program.encode()).strip())
 program="(async()=>{const r=await fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',{redirect:'error',signal:AbortSignal.timeout(8000)});console.log(r.status);if(!r.ok)process.exitCode=1})().catch(()=>process.exitCode=1)"
 return int(b.run(['docker','exec','-i',b.container(s),'node'],input=program.encode()).strip())
def ffmpeg_live(b):
 s='content';c=b.container(s)
 for binary in ('ffmpeg','ffprobe'):b.run(['docker','exec',c,binary,'-version'])
 enc=b.run(['docker','exec',c,'ffmpeg','-hide_banner','-encoders']).decode()
 if not re.search(r'\blibx264\b',enc) or not re.search(r'\baac\b',enc):raise RuntimeError('live_codecs_missing')
 sample='/tmp/release662-sample-'+str(time.time_ns())+'.mp4'
 b.run(['docker','exec',c,'ffmpeg','-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=64x64:r=10','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','0.5','-c:v','libx264','-threads','1','-c:a','aac','-pix_fmt','yuv420p','-movflags','+faststart',sample],timeout=40)
 result=json.loads(b.run(['docker','exec',c,'ffprobe','-v','error','-show_entries','stream=codec_type,codec_name:format=duration,size','-of','json',sample]))
 codecs={r['codec_type']:r['codec_name'] for r in result['streams']}
 if codecs!={'video':'h264','audio':'aac'} or not .4<=float(result['format']['duration'])<=.7:raise RuntimeError('live_sample_failed')
 proof={'image':b.inspect_container(s)['Image'],'ffmpeg':True,'ffprobe':True,'libx264':True,'aac':True,'sample':True,'sampleBytes':int(result['format']['size'])}
 b.save(PRE/'live-ffmpeg.json',json.dumps(proof).encode());print('LIVE_FFMPEG662_OK',json.dumps(proof),flush=True)
def verify(b,services):
 prepared=b.readjson(WORK/'checked662.json');receipt=b.readjson(PRE/'receipt.json')
 for s in services:
  if s not in b.SERVICES:raise RuntimeError('service')
  d=b.inspect_container(s);old=b.readjson(PRE/(s+'.private.json'))
  diff=env_diff(dict(x.split('=',1) for x in old['Config']['Env']),dict(x.split('=',1) for x in d['Config']['Env']))
  print('ENV_DIFF',s,json.dumps(diff),flush=True)
  if diff or d['Image']!=prepared[s]['image'] or d['State']['Status']!='running' or d['RestartCount']!=0:raise RuntimeError('live_state:'+s)
  for row in receipt['files']:
   if row['path'].startswith('ops/'+s+'/'):
    h=b.sha(b.live(row['path']));print('ACTUAL_SHA',row['path'],h,flush=True)
    if h!=row['sha']:raise RuntimeError('actual_sha:'+s)
  code=health(b,s)
  if code!=200:raise RuntimeError('health:'+s)
  b.save(PRE/('verified-'+s+'.json'),json.dumps({'image':d['Image'],'health':code,'envDiff':diff,'at':time.time()}).encode())
  print('RUNNING662',s,d['Image'],'health=200 envDiff=[]',flush=True)
 if 'content' in services:ffmpeg_live(b)
 return 0
def html(b):
 for s in b.SERVICES:
  p=b.readjson(PRE/('verified-'+s+'.json'))
  if p['image']!=b.inspect_container(s)['Image']:raise RuntimeError('verified_image_changed')
 proof=b.readjson(PRE/'live-ffmpeg.json')
 if proof['image']!=b.inspect_container('content')['Image'] or not proof['sample']:raise RuntimeError('live_ffmpeg_required')
 for n in (22,23,24):
  if not b.readjson(PRE/('preview-'+str(n)+'.json')).get('ready'):raise RuntimeError('previews_required')
 receipt=b.readjson(PRE/'receipt.json');m,_=b.packet();path='sites/synapse/cabinet.html';name=path.replace('/','__')
 if b.live(path)!=(PRE/'before'/name).read_bytes():raise RuntimeError('html_live_changed')
 for r in receipt['files']:
  if r['path'].startswith('sites/') and r['path']!=path and b.sha(b.live(r['path']))!=m['targetPublicSha256'][r['path']]:raise RuntimeError('asset_changed')
 candidate=(PRE/'candidates'/name).read_bytes()
 if b.sha(candidate)!='13a1de6600bc2dbcfaf3de573e0f9d9d51c4f37dc87517a03624343b6ea7f024':raise RuntimeError('private_html_candidate')
 b.save(WORK/'st/cabinet.html',candidate);replace(b,WORK/'static.txt',(path+'\n').encode());print('HTML662_STAGED',b.sha(candidate),'bytes='+str(len(candidate)),flush=True);return 0
def main():
 b=load_base()
 if sys.argv[1:]==['stage']:return stage(b)
 if sys.argv[1:]==['html']:return html(b)
 if len(sys.argv)>2 and sys.argv[1]=='verify':return verify(b,sys.argv[2:])
 raise RuntimeError('unknown_mode')
if __name__=='__main__':
 try:sys.exit(main())
 except Exception as e:
  print('STOP662',str(e) if isinstance(e,RuntimeError) else type(e).__name__,flush=True);sys.exit(1)
