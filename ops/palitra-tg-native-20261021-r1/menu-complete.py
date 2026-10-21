"""Complete only missing staff menu; never replay the confirmed default write."""
import hashlib,json,stat,sys,time
from pathlib import Path
H=Path('/tmp/tg-m2.py');raw=H.read_bytes();s=H.lstat()
assert not H.is_symlink() and s.st_uid==0 and s.st_nlink==1 and stat.S_ISREG(s.st_mode)
assert hashlib.sha256(raw).hexdigest()=='8a96fb19a1af1b618d8d589ba38a87078efefd1b793ae0689c5988e00e5ff7e1'
text=raw.decode();assert text.count('mode=sys.argv[1]')==1
n={'__name__':'root_menu_completion','__file__':str(H)};exec(compile(text.split('mode=sys.argv[1]')[0],str(H),'exec'),n)
d=n['d'];api=n['api'];want=n['want'];folder=n['A']/'menu-completion-r3';rows=n['read_all']();d['need'](rows[0]['menu']==want,'DEFAULT_NOT_CONFIRMED_NO_WRITE')
if sys.argv[1]=='apply-staff':
 d['need'](not folder.exists(),'COMPLETION_STARTED_INSPECT_ONLY');d['need'](all(r['menu'] in n['known'] for r in rows),'UNAPPROVED_STAFF_MENU');folder.mkdir(mode=0o700);d['write'](folder/'before.json',d['encoded'](rows));writes=0
 for index,row in enumerate(rows[1:],1):
  if row['menu']==want:continue
  n['native'].Ticket.native_lease(n['auth']['lease']);body={'chat_id':int(row['chatId'])};d['need'](api('getChatMenuButton',body)==row['menu'],'STAFF_MENU_CHANGED');d['write'](folder/('started-'+str(index)+'.json'),d['encoded']({'chatId':row['chatId'],'before':row['menu'],'desired':want,'automaticRetry':False}));d['need'](api('setChatMenuButton',{**body,'menu_button':want}) is True,'STAFF_WRITE_UNKNOWN_READ_FIRST');d['write'](folder/('accepted-'+str(index)+'.json'),d['encoded']({'apiReturnedTrue':True,'requiresLaterReadback':True}));writes+=1
 print(json.dumps({'status':'STAFF_MENU_WRITE_ACCEPTED_PENDING_LATER_READBACK','writes':writes,'defaultReplayed':False}))
elif sys.argv[1]=='verify':
 d['need'](folder.exists(),'COMPLETION_REQUIRED');d['need'](all(r['menu']==want for r in rows),'MENU_PROPAGATION_PENDING_READ_ONLY');report={'status':'FRESH_DEFAULT_AND_STAFF_MENU_READBACK_PASS','bot':n['me']['username'],'default':rows[0]['menu'],'staffMenus':len(rows)-1,'staffAllDesired':True,'defaultReplayed':False};d['write'](folder/('verified-'+str(time.time_ns())+'.json'),d['encoded'](report));print(json.dumps(report,ensure_ascii=False))
else:raise ValueError('UNKNOWN_MODE')
