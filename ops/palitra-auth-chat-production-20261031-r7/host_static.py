"""Closed two-file host delivery. Per-file CAS+intent, unknown inspect-only; never rollback."""
from pathlib import Path
import os,stat,time

def file_state(m,target):
 path=m.host_static_path(target);raw=m.safe_read(path);s=path.lstat();m.need(stat.S_ISREG(s.st_mode)and s.st_nlink==1,'HOST_STATIC_REGULAR_ONE_LINK')
 if os.name=='posix':m.need(s.st_uid==s.st_gid==0 and stat.S_IMODE(s.st_mode)==0o600,'HOST_STATIC_ROOT_MODE')
 return {'sha256':m.sha(raw),'bytes':len(raw),'stat':[s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,str(s.st_mtime_ns),str(s.st_ctime_ns)]}

def current(m):return {t:file_state(m,t)for t in m.STATIC_TARGETS}

def protect_before(m):
 folder=m.AREA/'host-static-before';m.need(not folder.exists(),'HOST_STATIC_BACKUP_EXISTS_INSPECT_ONLY');folder.mkdir(mode=0o700);result={}
 for target in m.STATIC_TARGETS:
  state=file_state(m,target);m.need(state['sha256']==m.STATIC_PINS[target][0],'HOST_STATIC_FRESH_BEFORE_REQUIRED');name=m.STATIC_NAMES[target]+'.before';backup=folder/name;raw=m.safe_read(m.host_static_path(target));m.need(m.sha(raw)==state['sha256']and file_state(m,target)==state,'HOST_STATIC_BACKUP_SOURCE_CHANGED');m.write_new(backup,raw);m.need(m.sha(m.safe_read(backup))==state['sha256'],'HOST_STATIC_BACKUP_MISMATCH');result[target]={'state':state,'backup':str(backup)}
 m.sync_dir(folder);m.sync_dir(m.AREA);return result

def backup_guard(m,base):
 for target,row in base['hostStatic'].items():m.need(target in m.STATIC_PINS and m.sha(m.safe_read(row['backup']))==row['state']['sha256']==m.STATIC_PINS[target][0],'HOST_STATIC_PROTECTED_BEFORE_CHANGED')

def classify(m,base):
 facts=current(m);pins=[facts[t]['sha256']for t in m.STATIC_TARGETS];old=[m.STATIC_PINS[t][0]for t in m.STATIC_TARGETS];new=[m.STATIC_PINS[t][1]for t in m.STATIC_TARGETS]
 prefixes=[new[:i]+old[i:]for i in range(3)];m.need(pins in prefixes,'HOST_STATIC_NONPREFIX_OR_UNKNOWN');phase=prefixes.index(pins)
 for index,target in enumerate(m.STATIC_TARGETS):
  s=facts[target];before=base['hostStatic'][target]['state']
  if index>=phase:m.need(s==before,'HOST_STATIC_BEFORE_IDENTITY_CHANGED')
  else:
   m.need(s['stat'][2:6]==before['stat'][2:6],'HOST_STATIC_AFTER_MODE_OWNER_LINK_CHANGED')
   name=('host','shell')[index];receipts=[m.AREA/('host-static-'+name+'-'+suffix+'.json')for suffix in('returned','observed')]
   for receipt in receipts:
    if receipt.exists():
     note=m.load(receipt);intent=m.AREA/('host-static-'+name+'-intent.json');m.need(note['target']==target and note['anchorSha256']==m.sha(m.safe_read(m.AREA/'static-base.json'))and note['intentSha256']==m.sha(m.safe_read(intent))and note['after']==s,'HOST_STATIC_ACCEPTED_IDENTITY_CHANGED')
 return phase,facts

def expect(m,base,phase):
 actual,facts=classify(m,base);m.need(actual==phase,'HOST_STATIC_PHASE_MISMATCH');wanted=dict(base['static'])
 for index,target in enumerate(m.STATIC_TARGETS):
  relative=target.removeprefix('/opt/synapse/');m.need(relative in wanted,'HOST_STATIC_EXPECTED_PATH_REQUIRED')
  wanted[relative]=m.STATIC_PINS[target][1 if index<phase else 0]
 m.need(m.full_static()==wanted,'HOST_STATIC_OTHER_RESOURCES_CHANGED');backup_guard(m,base);return facts

def write_one(m,index):
 m.need(index in(0,1),'HOST_STATIC_CLOSED_INDEX');name=('host','shell')[index];intent=m.AREA/('host-static-'+name+'-intent.json')
 m.need(not intent.exists(),'HOST_STATIC_ONE_ATTEMPT_INSPECT_ONLY')
 if index==1:m.need((m.AREA/'host-static-host-returned.json').exists()or(m.AREA/'host-static-host-observed.json').exists(),'HOST_STATIC_HOST_ACCEPTANCE_REQUIRED')
 base=m.static_guard(index);target=m.STATIC_TARGETS[index];before=file_state(m,target);m.need(before==base['hostStatic'][target]['state'],'HOST_STATIC_CAS_BEFORE_CHANGED');payload=m.AREA/'static-payload'/m.STATIC_NAMES[target];raw=m.safe_read(payload);m.need(m.sha(raw)==m.STATIC_PINS[target][1],'HOST_STATIC_PAYLOAD_CHANGED')
 path=m.host_static_path(target);temp=path.parent/('.'+path.name+'.'+m.NAME+'.tmp');m.need(not os.path.lexists(temp),'HOST_STATIC_TEMP_EXISTS_INSPECT_ONLY')
 m.write_new(intent,m.enc({'target':target,'before':m.sha(m.enc(before)),'after':m.sha(raw),'at':time.time(),'lease':m.own_lease(),'anchorSha256':m.sha(m.safe_read(m.AREA/'static-base.json'))}));m.sync_dir(m.AREA)
 fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600)
 with os.fdopen(fd,'wb')as stream:
  stream.write(raw);stream.flush();os.fchmod(stream.fileno(),stat.S_IMODE(before['stat'][2]))
  if os.name=='posix':os.fchown(stream.fileno(),before['stat'][3],before['stat'][4])
  os.fsync(stream.fileno())
 m.static_guard(index);m.need(file_state(m,target)==before,'HOST_STATIC_LATE_CAS_CHANGED');os.replace(temp,path);m.sync_dir(path.parent)
 m.static_guard(index+1);m.write_new(m.AREA/('host-static-'+name+'-returned.json'),m.enc({'target':target,'after':file_state(m,target),'at':time.time(),'anchorSha256':m.sha(m.safe_read(m.AREA/'static-base.json')),'intentSha256':m.sha(m.safe_read(intent))}));m.sync_dir(m.AREA)
 return {'phase':index+1,'status':'HOST_STATIC_APPLIED_REQUIRES_INSPECT'}

def inspect(m,complete=False):
 base=m.load(m.AREA/'static-base.json');phase,facts=classify(m,base)
 for i in range(phase):m.need((m.AREA/('host-static-'+('host','shell')[i]+'-intent.json')).exists(),'HOST_STATIC_AFTER_WITHOUT_INTENT')
 m.static_guard(phase,readback=True,history_full=complete)
 if complete:m.need(phase==2,'HOST_STATIC_COMPLETE_PAIR_REQUIRED')
 checked,facts=classify(m,base);m.need(checked==phase,'HOST_STATIC_CHANGED_DURING_READBACK')
 for i in range(phase):
  name=('host','shell')[i];target=m.STATIC_TARGETS[i];intent=m.AREA/('host-static-'+name+'-intent.json');data=m.load(intent);anchor=m.sha(m.safe_read(m.AREA/'static-base.json'))
  m.need(data['target']==target and data['anchorSha256']==anchor and data['after']==m.STATIC_PINS[target][1]and data['before']==m.sha(m.enc(base['hostStatic'][target]['state'])),'HOST_STATIC_INTENT_BINDING_CHANGED')
  if not any((m.AREA/('host-static-'+name+'-'+suffix+'.json')).exists()for suffix in('returned','observed')):m.write_new(m.AREA/('host-static-'+name+'-observed.json'),m.enc({'target':target,'after':facts[target],'at':time.time(),'reconciledReadonly':True,'anchorSha256':anchor,'intentSha256':m.sha(m.safe_read(intent))}));m.sync_dir(m.AREA)

 pending=phase<2 and(m.AREA/('host-static-'+('host','shell')[phase]+'-intent.json')).exists()
 result={'phase':phase,'status':'ATTENTION_ALL_AFTER_PASS'if complete else'HOST_STATIC_PARTIAL_BEFORE_NO_REPLAY'if pending else'HOST_STATIC_READBACK_PREFIX_PASS','automaticReplay':False,'databaseRestored':False,'targets':{t:row['sha256']for t,row in facts.items()},'at':time.time()}
 m.write_new(m.AREA/('host-static-inspect-'+str(time.time_ns())+'.json'),m.enc(result));return result
