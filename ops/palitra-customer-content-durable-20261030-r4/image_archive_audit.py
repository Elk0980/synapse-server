"""PRIVATE R4 candidate: Docker legacy + OCI image save, no extraction or app imports.
Only the selected pinned config and complete final layer are accepted. Unknown formats fail.
"""
from pathlib import Path
import hashlib,io,json,os,re,stat,tarfile,zlib
MAX_ARCHIVE=2*1024*1024*1024;MAX_META=1024*1024;MAX_LAYER=8*1024*1024;MAX_COMPRESSED=16*1024*1024
DIGEST=re.compile(r'sha256:[a-f0-9]{64}')
OCI_INDEX='application/vnd.oci.image.index.v1+json';DOCKER_INDEX='application/vnd.docker.distribution.manifest.list.v2+json'
OCI_MANIFEST='application/vnd.oci.image.manifest.v1+json';DOCKER_MANIFEST='application/vnd.docker.distribution.manifest.v2+json'
CONFIG_TYPES={'application/vnd.oci.image.config.v1+json','application/vnd.docker.container.image.v1+json'}
PLAIN={'application/vnd.oci.image.layer.v1.tar','application/vnd.docker.image.rootfs.diff.tar'}
GZIP={'application/vnd.oci.image.layer.v1.tar+gzip','application/vnd.docker.image.rootfs.diff.tar.gzip'}
sha=lambda value:hashlib.sha256(value).hexdigest()
def need(ok,code):
 if not ok:raise ValueError(code)
def json_object(pairs):
 result={}
 for key,value in pairs:
  need(key not in result,'IMAGE_JSON_DUPLICATE_KEY');result[key]=value
 return result
def parse_json(raw):
 try:return json.loads(raw,object_pairs_hook=json_object,parse_constant=lambda _:(_ for _ in()).throw(ValueError('IMAGE_JSON_NONFINITE')))
 except(UnicodeError,json.JSONDecodeError):raise ValueError('IMAGE_JSON_INVALID')
def canonical_name(name):
 need(type(name)is str and name and not name.startswith('/')and '\\'not in name and not any(ord(c)<32 for c in name),'IMAGE_ENTRY_PATH')
 need(all(p not in('','..','.')for p in name.split('/')),'IMAGE_ENTRY_PATH');return name
def descriptor(value):
 need(type(value)is dict and type(value.get('digest'))is str and DIGEST.fullmatch(value['digest'])and type(value.get('size'))is int and 0<=value['size']<=MAX_ARCHIVE and type(value.get('mediaType'))is str,'IMAGE_DESCRIPTOR_INVALID');return value
class Reader:
 def __init__(self,archive):
  self.archive=archive;self.entries={};count=0
  for entry in archive:
   count+=1;need(count<=200000,'IMAGE_ENTRY_BOUND');need(entry.isfile()or entry.isdir(),'IMAGE_NONREGULAR_ENTRY')
   name=canonical_name(entry.name.rstrip('/')if entry.isdir()else entry.name);need(name not in self.entries,'IMAGE_DUPLICATE_ENTRY');self.entries[name]=entry
 def raw(self,name,limit):
  canonical_name(name);entry=self.entries.get(name);need(entry is not None and entry.isfile()and entry.size<=limit,'IMAGE_REFERENCED_FILE_MISSING_OR_BOUND')
  stream=self.archive.extractfile(entry);need(stream is not None,'IMAGE_REFERENCED_STREAM');raw=stream.read(limit+1);need(len(raw)==entry.size<=limit,'IMAGE_REFERENCED_READ_BOUND');return raw
 def blob(self,value,limit):
  value=descriptor(value);need(value['size']<=limit,'IMAGE_METADATA_BOUND');name='blobs/sha256/'+value['digest'][7:];raw=self.raw(name,limit)
  need(len(raw)==value['size']and 'sha256:'+sha(raw)==value['digest'],'IMAGE_BLOB_DIGEST_OR_SIZE');return raw
 def verify_blob(self,value,limit=MAX_ARCHIVE):
  value=descriptor(value);name='blobs/sha256/'+value['digest'][7:];entry=self.entries.get(name)
  need(entry is not None and entry.isfile()and entry.size==value['size']and entry.size<=limit,'IMAGE_REFERENCE_SIZE_OR_MISSING')
  stream=self.archive.extractfile(entry);need(stream is not None,'IMAGE_REFERENCE_STREAM');h=hashlib.sha256()
  while True:
   data=stream.read(1024*1024)
   if not data:break
   h.update(data)
  need('sha256:'+h.hexdigest()==value['digest'],'IMAGE_REFERENCE_DIGEST')
 def layer(self,value):
  value=descriptor(value);media=value['mediaType'];need(media in PLAIN|GZIP,'IMAGE_LAYER_MEDIA_UNSUPPORTED');limit=MAX_LAYER if media in PLAIN else MAX_COMPRESSED
  name='blobs/sha256/'+value['digest'][7:];entry=self.entries.get(name);need(entry is not None and entry.isfile()and entry.size==value['size']and entry.size<=limit,'IMAGE_LAYER_COMPRESSED_BOUND_OR_SIZE')
  stream=self.archive.extractfile(entry);need(stream is not None,'IMAGE_LAYER_STREAM');h=hashlib.sha256();out=bytearray();decoder=zlib.decompressobj(31)if media in GZIP else None
  try:
   while True:
    chunk=stream.read(1024*1024)
    if not chunk:break
    h.update(chunk)
    if decoder:
     data=decoder.decompress(chunk,MAX_LAYER-len(out)+1);out.extend(data);need(not decoder.unconsumed_tail and len(out)<=MAX_LAYER,'IMAGE_LAYER_DECOMPRESSED_BOUND')
     need(not decoder.unused_data,'IMAGE_GZIP_TRAILING_OR_MULTIMEMBER')
    else:out.extend(chunk);need(len(out)<=MAX_LAYER,'IMAGE_LAYER_DECOMPRESSED_BOUND')
   if decoder:
    out.extend(decoder.flush(MAX_LAYER-len(out)+1));need(decoder.eof and not decoder.unused_data and len(out)<=MAX_LAYER,'IMAGE_GZIP_TRUNCATED_OR_BOUND')
  except zlib.error:raise ValueError('IMAGE_GZIP_INVALID')
  need('sha256:'+h.hexdigest()==value['digest'],'IMAGE_LAYER_COMPRESSED_DIGEST');return bytes(out),name

def platform_check(value,expected):
 if value is None:return
 need(type(value)is dict and set(value)<={'os','architecture','variant'}and(value.get('os'),value.get('architecture'),value.get('variant')or'')==expected,'IMAGE_PLATFORM_UNKNOWN_OR_MISMATCH')
def config_check(raw,child,pinned_config=None):
 need('sha256:'+sha(raw)==(pinned_config or child['Id']),'IMAGE_CONFIG_DIGEST_MISMATCH');doc=parse_json(raw)
 need(type(doc)is dict and type(doc.get('rootfs'))is dict and doc['rootfs'].get('type')=='layers'and doc['rootfs'].get('diff_ids')==child['RootFS']['Layers'],'IMAGE_CONFIG_ROOTFS_MISMATCH')
 need(doc.get('config')==child['Config'],'IMAGE_CONFIG_VALUE_MISMATCH')
 expected=(child.get('Os'),child.get('Architecture'),child.get('Variant')or'')
 need(expected==('linux','amd64','')and(doc.get('os'),doc.get('architecture'),doc.get('variant')or'')==expected,'IMAGE_PLATFORM_UNKNOWN_OR_MISMATCH');return doc,expected

def complete_layer(raw,base,manifest,tar_members,want):
 need(len(raw)<=MAX_LAYER and 'sha256:'+sha(raw)==want,'IMAGE_LAST_DIFFID_MISMATCH')
 # Reject hidden nonzero archives/data after the end marker; same scope callback follows.
 end=0
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:')as layer:
  for entry in layer:end=max(end,entry.offset_data+((entry.size+511)//512)*512)
 need(len(raw)>=end+1024 and not any(raw[end:]),'IMAGE_LAYER_TRAILING_DATA_OR_END_MARKER')
 tar_members(raw,base,manifest)

def compatibility(reader,child,pinned_config=None):
 data=parse_json(reader.raw('manifest.json',MAX_META));need(type(data)is list and 0<len(data)<=32,'IMAGE_LEGACY_MANIFEST_SHAPE');matches={}
 for item in data:
  need(type(item)is dict and type(item.get('Config'))is str and type(item.get('Layers'))is list and 0<len(item['Layers'])<=256,'IMAGE_LEGACY_MANIFEST_SHAPE')
  raw=reader.raw(item['Config'],MAX_META)
  if 'sha256:'+sha(raw)!=(pinned_config or child['Id']):continue
  need(len(item['Layers'])==len(child['RootFS']['Layers'])and len(set(item['Layers']))==len(item['Layers']),'IMAGE_LEGACY_LAYER_LIST')
  for name in item['Layers']:canonical_name(name);need(name in reader.entries and reader.entries[name].isfile(),'IMAGE_LEGACY_LAYER_MISSING')
  config_check(raw,child,pinned_config);matches[(item['Config'],tuple(item['Layers']))]=item
 need(len(matches)==1,'IMAGE_LEGACY_SELECTION_AMBIGUOUS_OR_MISSING');return next(iter(matches.values()))

def audit(path,base,manifest,child,tar_members):
 path=Path(path);before=path.lstat();need(not path.is_symlink()and stat.S_ISREG(before.st_mode)and before.st_nlink==1 and before.st_size<=MAX_ARCHIVE,'BOUNDED_SAVED_IMAGE_REQUIRED')
 need(type(child.get('Id'))is str and DIGEST.fullmatch(child['Id'])and 1<=len(child['RootFS']['Layers'])<=256 and all(DIGEST.fullmatch(v)for v in child['RootFS']['Layers']),'IMAGE_CHILD_PINS_INVALID')
 want=child['RootFS']['Layers'][-1]
 with tarfile.open(path,mode='r:')as archive:
  reader=Reader(archive)
  if 'index.json'in reader.entries or'oci-layout'in reader.entries:
   need({'index.json','oci-layout'}<=reader.entries.keys(),'IMAGE_OCI_LAYOUT_INCOMPLETE')
   need(parse_json(reader.raw('oci-layout',MAX_META))=={'imageLayoutVersion':'1.0.0'},'IMAGE_OCI_LAYOUT_UNKNOWN')
   root_raw=reader.raw('index.json',MAX_META);root=parse_json(root_raw);need(type(root)is dict,'IMAGE_OCI_ROOT_SHAPE')
   pinned=descriptor(child.get('Descriptor'));need(pinned['mediaType']in(OCI_INDEX,DOCKER_INDEX,OCI_MANIFEST,DOCKER_MANIFEST),'IMAGE_ROOT_DESCRIPTOR_MEDIA')
   roots={};visited=0
   def seek(doc,media,chain,depth):
    nonlocal visited
    visited+=1;need(visited<=128 and depth<=4 and type(doc)is dict and doc.get('schemaVersion')==2 and doc.get('mediaType',media)==media,'IMAGE_OCI_GRAPH_BOUND_OR_SCHEMA')
    need(media in(OCI_INDEX,DOCKER_INDEX),'IMAGE_EXPORT_INDEX_REQUIRED')
    rows=doc.get('manifests');need(type(rows)is list and 0<len(rows)<=32,'IMAGE_OCI_INDEX_SHAPE')
    for value in rows:
     value=descriptor(value);need(value['digest']not in chain,'IMAGE_OCI_CYCLE');kind=value['mediaType'];need(kind in(OCI_INDEX,DOCKER_INDEX,OCI_MANIFEST,DOCKER_MANIFEST),'IMAGE_OCI_MEDIA_UNKNOWN')
     raw=reader.blob(value,MAX_META);node=parse_json(raw)
     if value['digest']==pinned['digest']:
      need((value['mediaType'],value['size'])==(pinned['mediaType'],pinned['size']),'IMAGE_ROOT_DESCRIPTOR_MISMATCH');roots[value['digest']]=(node,kind,[value.get('platform')])
     elif kind in(OCI_INDEX,DOCKER_INDEX):seek(node,kind,chain|{value['digest']},depth+1)
   if 'sha256:'+sha(root_raw)==pinned['digest']:
    need(len(root_raw)==pinned['size'],'IMAGE_ROOT_DESCRIPTOR_SIZE');roots[pinned['digest']]=(root,pinned['mediaType'],[])
   else:seek(root,root.get('mediaType',OCI_INDEX),set(),0)
   need(len(roots)==1,'IMAGE_PINNED_ROOT_UNREACHABLE');candidates={};visited=0
   expected=(child.get('Os'),child.get('Architecture'),child.get('Variant')or'');need(expected==('linux','amd64',''),'IMAGE_PLATFORM_UNKNOWN_OR_MISMATCH')
   def walk(doc,media,platforms,chain,depth):
    nonlocal visited
    visited+=1;need(visited<=128 and depth<=4 and type(doc)is dict and doc.get('schemaVersion')==2 and doc.get('mediaType',media)==media,'IMAGE_OCI_GRAPH_BOUND_OR_SCHEMA')
    if media in(OCI_INDEX,DOCKER_INDEX):
     rows=doc.get('manifests');need(type(rows)is list and 0<len(rows)<=32,'IMAGE_OCI_INDEX_SHAPE')
     for value in rows:
      value=descriptor(value);need(value['digest']not in chain,'IMAGE_OCI_CYCLE');kind=value['mediaType'];need(kind in(OCI_INDEX,DOCKER_INDEX,OCI_MANIFEST,DOCKER_MANIFEST),'IMAGE_OCI_MEDIA_UNKNOWN')
      walk(parse_json(reader.blob(value,MAX_META)),kind,platforms+[value.get('platform')],chain|{value['digest']},depth+1)
    else:
     need(media in(OCI_MANIFEST,DOCKER_MANIFEST),'IMAGE_OCI_MEDIA_UNKNOWN');config=descriptor(doc.get('config'));config_raw=reader.blob(config,MAX_META)
     layers=doc.get('layers');need(type(layers)is list and 0<len(layers)<=256,'IMAGE_OCI_LAYER_COUNT')
     # Attestation and other unselected branches are opaque, referenced and hashed.
     for value in layers:reader.verify_blob(value)
     if any(p is not None and(type(p)is not dict or(p.get('os'),p.get('architecture'),p.get('variant')or'')!=expected)for p in platforms):return
     if config['mediaType']not in CONFIG_TYPES:return
     cfg=parse_json(config_raw)
     if type(cfg)is not dict or cfg.get('config')!=child['Config']or cfg.get('rootfs')!={'type':'layers','diff_ids':child['RootFS']['Layers']}:return
     config_check(config_raw,child,config['digest'])
     for value in platforms:platform_check(value,expected)
     need(len(layers)==len(child['RootFS']['Layers']),'IMAGE_OCI_LAYER_COUNT')
     for value in layers:need(descriptor(value)['mediaType']in PLAIN|GZIP,'IMAGE_LAYER_MEDIA_UNSUPPORTED')
     key=sha(json.dumps(doc,sort_keys=True,separators=(',',':')).encode());candidates[key]=(doc,config['digest'])
   node,media,platforms=next(iter(roots.values()));walk(node,media,platforms,{pinned['digest']},0)
   need(len(candidates)==1,'IMAGE_OCI_SELECTION_AMBIGUOUS_OR_MISSING');selected,config_digest=next(iter(candidates.values()));need(child['Id']in(pinned['digest'],config_digest),'IMAGE_ID_DESCRIPTOR_OR_CONFIG_BINDING');raw,name=reader.layer(selected['layers'][-1])
   if 'manifest.json'in reader.entries:
    legacy=compatibility(reader,child,config_digest);need(legacy['Layers']==['blobs/sha256/'+v['digest'][7:]for v in selected['layers']],'IMAGE_COMPATIBILITY_LAYER_MISMATCH')
   complete_layer(raw,base,manifest,tar_members,want);kind='oci'
  else:
   selected=compatibility(reader,child);raw=reader.raw(selected['Layers'][-1],MAX_LAYER);complete_layer(raw,base,manifest,tar_members,want);kind='legacy';config_digest=child['Id']
 after=path.lstat();keys=('st_dev','st_ino','st_size','st_mode','st_uid','st_gid','st_nlink','st_mtime_ns','st_ctime_ns');need(all(getattr(before,k)==getattr(after,k)for k in keys),'SAVED_IMAGE_CHANGED')
 return {'format':kind,'imageId':child['Id'],'configDigest':config_digest,'lastDiffId':want,'rootDescriptorDigest':pinned['digest']if kind=='oci'else None}
