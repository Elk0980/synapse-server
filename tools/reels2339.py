"""Eight one-shot version submissions explicitly authorized by board 283/2339.

No private media URLs or credential values here. Exact bodies arrive separately.
Uses the same pinned transport as the prior successful version submissions.
"""
import base64,hashlib,importlib.util,json,os,re,subprocess,sys,zlib
from pathlib import Path
ROOT=Path('/root/claude-rel')
IDS=(22,23,24,29,30,31,32,33)
BASE={n:2 if n<25 else 1 for n in IDS}
BODIES_SHA='233fab80ecbfd8370b5fe9d4283cf3e9467261cc6a96ed3153c5b43b16e6efdc'
TRANSPORT_SHA='3c5bd6bdd3cb408eb8fdc117878c93cb46b78ab7029c931cce97176b548d8aee'
INSPECT=r'''
const db=new(require('node:sqlite').DatabaseSync)('/data/crm.sqlite',{readOnly:true});
const rows=db.prepare('SELECT r.id,v.version FROM reel_materials r JOIN companies c ON c.id=r.company_id LEFT JOIN reel_versions v ON v.reel_id=r.id WHERE lower(c.code)=? AND r.id IN (22,23,24,29,30,31,32,33) ORDER BY r.id,v.version').all('taisabai');
console.log(JSON.stringify(rows));db.close();
'''
def load_transport():
 p=ROOT/'v32282.py'
 if hashlib.sha256(p.read_bytes()).hexdigest()!=TRANSPORT_SHA:raise RuntimeError('transport_changed')
 spec=importlib.util.spec_from_file_location('transport2339',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def bodies(data):
 if hashlib.sha256(data).hexdigest()!=BODIES_SHA:raise RuntimeError('bodies_sha')
 rows=json.loads(data)
 if tuple(map(int,rows))!=IDS:raise RuntimeError('bodies_scope')
 for text in rows.values():
  d=json.loads(text)
  if not text.isascii() or set(d)!={'mediaUrl','sha256','durationMs'}:raise RuntimeError('body_fields')
  if not re.fullmatch(r'https://synapse\.synapsebusiness\.ru/content/publishing-assets/taisabai/[a-f0-9]{32}\.mp4',d['mediaUrl']):raise RuntimeError('media_scope')
  if not re.fullmatch('[a-f0-9]{64}',d['sha256']) or type(d['durationMs']) is not int or not 0<d['durationMs']<600000:raise RuntimeError('metadata')
 return rows
def inspect():
 r=subprocess.run(['docker','exec','synapse-crm-1','node','-e',INSPECT],capture_output=True,timeout=15,check=True)
 rows=json.loads(r.stdout);out={n:[] for n in IDS}
 for x in rows:
  if x['version'] is not None:out[x['id']].append(x['version'])
 return out
def receipt(n):return ROOT/f'reel{n}-2339.result.json'
def marker(n):return ROOT/f'reel{n}-2339.started'
def submit(n):
 rows=bodies((ROOT/'bodies2339.private.json').read_bytes())
 for earlier in IDS[:IDS.index(n)]:
  r=json.loads(receipt(earlier).read_bytes())
  if not 200<=r['http']<300 or r['version']!=BASE[earlier]+1:raise RuntimeError('previous_not_successful')
 if receipt(n).exists() or marker(n).exists():raise RuntimeError('already_attempted_do_not_repeat')
 versions=inspect()[n]
 if versions!=list(range(1,BASE[n]+1)):raise RuntimeError('current_version_changed')
 m=load_transport();m.ROOT=ROOT;m.MARK=marker(n);m.RESULT=receipt(n)
 m.decode=lambda _:rows[str(n)].encode('ascii')
 if m.PROGRAM.count('/reels/21/')!=1:raise RuntimeError('transport_route')
 m.PROGRAM=m.PROGRAM.replace('/reels/21/','/reels/'+str(n)+'/')
 sys.argv=['transport','submit','fixed-private-body-2339'];rc=m.main()
 r=json.loads(receipt(n).read_bytes())
 if rc or not 200<=r['http']<300 or r['version']!=BASE[n]+1:raise RuntimeError('http_or_version_stop')
 return 0
def main():
 if sys.argv[1:]==['inspect']:
  out=inspect();print('VERSIONS2339',json.dumps(out),flush=True)
  if any(out[n]!=list(range(1,BASE[n]+1)) for n in IDS):raise RuntimeError('baseline_changed')
  return 0
 if len(sys.argv)==3 and sys.argv[1]=='prepare':
  data=zlib.decompress(base64.urlsafe_b64decode(sys.argv[2]));bodies(data)
  with os.fdopen(os.open(ROOT/'bodies2339.private.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:f.write(data)
  print('BODIES2339_EXACT eight ASCII/noeditId/nosegments',BODIES_SHA,flush=True);return 0
 if len(sys.argv)==3 and sys.argv[1]=='submit' and int(sys.argv[2]) in IDS:return submit(int(sys.argv[2]))
 if sys.argv[1:]==['receipt']:
  for n in IDS:
   r=json.loads(receipt(n).read_bytes());print('REEL',n,'HTTP',r['http'],'VERSION',r['version'],flush=True)
  return 0
 raise RuntimeError('scope')
if __name__=='__main__':
 try:sys.exit(main())
 except Exception as e:
  print('STOP2339',str(e) if isinstance(e,RuntimeError) else type(e).__name__,flush=True);sys.exit(1)
