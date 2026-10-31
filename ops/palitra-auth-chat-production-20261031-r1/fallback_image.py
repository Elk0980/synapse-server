"""Build and validate a security-preserving fallback image; never runs an application."""
import copy,io,json,os,tarfile,time
NAMES=('server.js','palitra-manager-attention.cjs','site-orders.js')
def manifest(m):
 rows=[]
 for name in NAMES:
  target='/app/'+name;raw=m.safe_read(m.AREA/'source-proof'/('fallback-'+name))
  rows.append({'target':target,'beforeSha256':m.FILE_PINS[target][1],'afterSha256':m.REVIEWED_DATA_PINS['source-proof/fallback-'+name],'bytes':len(raw)})
 return {'files':rows}
def parent(m):
 base=m.load(m.AREA/'base.json');forward=m.load(m.AREA/'child.json');m.built_image_guard(base,m.package()[1],forward)
 result=copy.deepcopy(base);result['tree']=m.expected_tree(base,m.package()[1]);return result,forward
def validate(m):
 base,forward=parent(m);doc=manifest(m);receipt=m.load(m.AREA/'fallback-child.json')
 m.need(set(receipt)=={'image','parent','imageConfigSha256','lastDiffId','manifestSha256'}and receipt['parent']==forward['image']and m.IMAGE.fullmatch(receipt['image'])and receipt['image']!=forward['image'],'EXACT_COMPATIBLE_FALLBACK_RECEIPT')
 m.need(receipt['manifestSha256']==m.sha(m.enc(doc)),'FALLBACK_SOURCE_MANIFEST_CHANGED')
 before=m.image_info(forward['image']);after=m.image_info(receipt['image'])
 m.need(after['Config']==before['Config']and m.sha(m.enc(after['Config']))==receipt['imageConfigSha256'],'FALLBACK_CONFIG_CHANGED')
 m.need(after['RootFS']['Layers'][:-1]==before['RootFS']['Layers']and len(after['RootFS']['Layers'])==len(before['RootFS']['Layers'])+1 and after['RootFS']['Layers'][-1]==receipt['lastDiffId'],'FALLBACK_ONE_LAYER_ANCESTRY')
 m.need(m.image_tree(receipt['image'])==m.expected_tree(base,doc),'FALLBACK_FULL_TREE_CHANGED')
 m.audit_saved_layer(m.AREA/'fallback-build/child-image.tar',base,doc,after)
 return receipt
def build(m):
 m.need(not(m.AREA/'fallback-build-intent.json').exists(),'ONE_FALLBACK_BUILD_INSPECT_ONLY')
 _,_,original,_=m.base_guard();m.backup_guard();base,forward=parent(m);doc=manifest(m)
 m.write_new(m.AREA/'fallback-build-intent.json',m.enc({'at':time.time(),'lease':original['lease'],'forward':forward['image'],'manifestSha256':m.sha(m.enc(doc))}))
 folder=m.AREA/'fallback-build';folder.mkdir(mode=0o700);stream=io.BytesIO()
 with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT)as archive:
  for row in doc['files']:
   key=row['target'].removeprefix('/app/');raw=m.safe_read(m.AREA/'source-proof'/('fallback-'+key));prior=base['tree'][key]
   item=tarfile.TarInfo(key);item.size=len(raw);item.mode=prior['mode'];item.uid=prior['uid'];item.gid=prior['gid'];item.mtime=0;archive.addfile(item,io.BytesIO(raw))
 payload=stream.getvalue();m.write_new(folder/'payload.tar',payload)
 token=os.urandom(8).hex();alias=m.NAME+'-'+token+'-base:local';tag=m.NAME+'-'+token+':local'
 m.need(not m.run(['docker','image','ls','--quiet',alias]).strip()and not m.run(['docker','image','ls','--quiet',tag]).strip(),'UNIQUE_FALLBACK_IMAGE_TAGS')
 dockerfile=('FROM '+alias+'\nADD payload.tar /app/\n').encode();m.write_new(folder/'Dockerfile',dockerfile)
 m.need({p.name for p in folder.iterdir()}=={'payload.tar','Dockerfile'},'CLOSED_FALLBACK_BUILD_CONTEXT');m.base_guard()
 m.run(['docker','image','tag',forward['image'],alias]);m.need(m.run(['docker','image','inspect','--format','{{.Id}}',alias]).decode().strip()==forward['image'],'FALLBACK_PARENT_ALIAS_PIN')
 m.need(m.safe_read(folder/'payload.tar')==payload and m.safe_read(folder/'Dockerfile')==dockerfile,'FALLBACK_CONTEXT_CHANGED')
 m.run(['docker','build','--network=none','--pull=false','--tag',tag,'--iidfile',str(folder/'image.id'),str(folder)],180)
 image=m.safe_read(folder/'image.id').decode().strip();m.need(m.IMAGE.fullmatch(image),'FALLBACK_IID_REQUIRED');before=m.image_info(forward['image']);after=m.image_info(image)
 m.need(after['Config']==before['Config']and after['RootFS']['Layers'][:-1]==before['RootFS']['Layers']and len(after['RootFS']['Layers'])==len(before['RootFS']['Layers'])+1,'FALLBACK_ONE_LAYER_CONFIG')
 m.need(m.image_tree(image)==m.expected_tree(base,doc),'FALLBACK_FULL_TREE_CHANGED')
 m.run(['docker','image','save','--output',str(folder/'child-image.tar'),image],180);m.audit_saved_layer(folder/'child-image.tar',base,doc,after);m.base_guard()
 m.write_new(m.AREA/'fallback-child.json',m.enc({'image':image,'parent':forward['image'],'imageConfigSha256':m.sha(m.enc(after['Config'])),'lastDiffId':after['RootFS']['Layers'][-1],'manifestSha256':m.sha(m.enc(doc))}));validate(m)
 print('COMPATIBLE_FALLBACK_IMAGE_BUILT_NOT_INSTALLED')
