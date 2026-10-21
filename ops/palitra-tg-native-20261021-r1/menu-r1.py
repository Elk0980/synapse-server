"""Existing verified bot menu only; no messages, tokens, roles or new links."""
import hashlib,json,os,re,stat,subprocess,sys,time
from pathlib import Path
sys.dont_write_bytecode=True
H=Path('/tmp/tg-r3.py');raw=H.read_bytes();s=H.lstat()
if H.is_symlink() or s.st_uid!=0 or s.st_nlink!=1 or not stat.S_ISREG(s.st_mode) or hashlib.sha256(raw).hexdigest()!='ba26b351071719ac21a89ec9e393d532910196d9b6acbc8a6034b6a45d869106':raise ValueError('HELPER_PIN')
ns={'__name__':'reviewed_archive_helper','__file__':str(H)};exec(compile(raw,str(H),'exec'),ns);d=ns['d']
entry,package,native,reader,contract=d['load']();A=d['AREA'];auth=json.loads(d['private_read'](A/'action.json'));native.Ticket.native_lease(auth['lease'])
receipt=d['ROOT']/(auth['namespace']+'-apply')/'result.json';installed=json.loads(d['private_read'](receipt));d['need'](installed['status']=='INSTALLED_PENDING_ROOT_LIVE_ACCEPTANCE' and installed['packageSha256']==d['INSTALLER_SHA'],'INSTALLED_RECEIPT_REQUIRED')
checks=list(A.glob('readback-*.json'));d['need'](checks and any(json.loads(d['private_read'](x)).get('status')=='ROOT_INDEPENDENT_NATIVE_READBACK_PASS' for x in checks),'INDEPENDENT_READBACK_REQUIRED')
DB=json.loads(d['private_read'](A/'native-base.json'))['database']['path']
with reader.readonly_db(DB,True) as db:
 ids=[str(r[0]) for r in db.execute("SELECT DISTINCT l.telegram_user_id FROM project_chat_telegram_links l JOIN auth_users u ON u.id=l.user_id WHERE u.role='owner' OR (u.role='editor' AND EXISTS(SELECT 1 FROM auth_user_companies c WHERE c.user_id=u.id AND c.company_code='palitra-love') AND EXISTS(SELECT 1 FROM auth_user_permissions p WHERE p.user_id=u.id AND p.permission='crm.view')) ORDER BY l.telegram_user_id")]
d['need'](len(ids)<=30 and all(re.fullmatch('[1-9][0-9]{0,15}',i) for i in ids),'CURRENT_STAFF_SCOPE')
JS=r"""'use strict';const q=JSON.parse(process.argv[1]);const t=String(process.env.PALITRA_CLIENT_BOT_TOKEN||'').trim();
(async()=>{if(!t||!['getMe','getChatMenuButton','setChatMenuButton'].includes(q.method))throw 0;let r;try{r=await fetch('https://api.telegram.org/bot'+t+'/'+q.method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(q.body),signal:AbortSignal.timeout(15000)});const v=await r.json();if(!r.ok||v.ok!==true)throw 0;console.log(JSON.stringify({ok:true,result:v.result}));}catch{console.log(JSON.stringify({ok:false,code:q.method==='setChatMenuButton'?'WRITE_UNKNOWN_READ_FIRST':'READ_FAILED'}));process.exitCode=2;}})().catch(()=>{console.log(JSON.stringify({ok:false,code:'TOKEN_OR_METHOD'}));process.exitCode=2;});"""
def api(method,body=None):
 r=subprocess.run(['docker','exec','synapse-chat-1','node','-e',JS,json.dumps({'method':method,'body':body or {}},separators=(',',':'))],stdin=subprocess.DEVNULL,capture_output=True,timeout=25)
 try:v=json.loads(r.stdout)
 except:raise ValueError('API_RESULT_UNREADABLE_READ_FIRST')
 if r.returncode!=0 or v.get('ok') is not True:raise ValueError(v.get('code','API_REFUSED_READ_FIRST'))
 return v['result']
want={'type':'web_app','text':'Заказы','web_app':{'url':'https://palitra-love.ru/love-app/telegram.html'}}
known=[{'type':'default'},{'type':'commands'},want]+[{'type':'web_app','text':t,'web_app':{'url':u}} for t,u in [('Тестовое приложение','https://palitra-bot-preview.synapsebusiness.ru/'),('Каталог Palitra','https://palitra-love.ru/catalog'),('Рабочее место','https://synapse.synapsebusiness.ru/cabinet/palitra-work.html')]]
me=api('getMe');d['need'](me.get('id')==8940578179 and me.get('username')=='palitra_love_orders_bot' and me.get('is_bot') is True,'WRONG_BOT')
folder=A/'menu-r1'
def read_all():return [{'chatId':i,'menu':api('getChatMenuButton',{} if i is None else {'chat_id':int(i)})} for i in [None]+ids]
def summary(rows):return {'default':rows[0]['menu'],'staffMenus':len(rows)-1,'staffAllDesired':all(r['menu']==want for r in rows[1:])}
mode=sys.argv[1]
if mode=='inspect':
 d['need'](not folder.exists(),'MENU_INSPECTION_EXISTS_READ_FIRST');rows=read_all();d['need'](all(r['menu'] in known for r in rows),'UNRECOGNIZED_MENU_NO_WRITE');folder.mkdir(mode=0o700);d['write'](folder/'before.json',d['encoded']({'created':time.time(),'rows':rows}));print(json.dumps({'status':'MENU_READ_ONLY','bot':me['username'],**summary(rows)},ensure_ascii=False))
elif mode=='apply':
 before=json.loads(d['private_read'](folder/'before.json'));d['need'](0<=time.time()-before['created']<=900,'FRESH_MENU_INSPECTION_REQUIRED');rows=before['rows'];d['need']([r['chatId'] for r in rows]==[None]+ids,'STAFF_CHANGED');d['need'](not list(folder.glob('started-*')) and not (folder/'result.json').exists(),'MENU_ATTEMPT_ALREADY_STARTED_READ_FIRST');d['need'](read_all()==rows,'MENU_CHANGED_NO_WRITE')
 changed=0
 for index,row in enumerate(rows):
  if row['menu']==want:continue
  native.Ticket.native_lease(auth['lease']);body={} if row['chatId'] is None else {'chat_id':int(row['chatId'])};d['need'](api('getChatMenuButton',body)==row['menu'],'MENU_CAS_CHANGED');d['write'](folder/('started-'+str(index)+'.json'),d['encoded']({'scope':row['chatId'],'before':row['menu'],'desired':want,'automaticRetry':False}))
  d['need'](api('setChatMenuButton',{**body,'menu_button':want}) is True,'WRITE_NOT_CONFIRMED_READ_FIRST');d['need'](api('getChatMenuButton',body)==want,'MENU_READBACK_FAILED_READ_FIRST');d['write'](folder/('done-'+str(index)+'.json'),d['encoded']({'confirmed':True}));changed+=1
 after=read_all();d['need'](all(r['menu']==want for r in after),'FINAL_MENU_READBACK_FAILED');report={'status':'BOT_MENU_INSTALLED_READBACK_PASS','bot':me['username'],'changed':changed,**summary(after)};d['write'](folder/'result.json',d['encoded'](report));print(json.dumps(report,ensure_ascii=False))
elif mode=='verify':
 after=read_all();d['need'](all(r['menu']==want for r in after),'MENU_NOT_DESIRED');print(json.dumps({'status':'FRESH_BOT_MENU_READBACK_PASS',**summary(after)},ensure_ascii=False))
else:raise ValueError('UNKNOWN_MODE')
