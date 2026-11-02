"""Comparison-only: two literal diagnostic cells; never changes a database."""
import copy,datetime,hashlib,json,re,time
SAFE=9007199254740991;TTL=300000;WINDOW=1080000
BRIDGE='client_bot_bridge_state';ALERTS='hugh_owner_alerts';SEQ='sqlite_sequence'
FIELDS=['bot_key','ok','username','telegram_bot_id','error','checked_at']
pack=lambda x:(json.dumps(x,sort_keys=True,ensure_ascii=False,separators=(',',':'))+'\n').encode()
digest=lambda x:hashlib.sha256(pack(x)).hexdigest()
def need(ok,code):
 if not ok:raise ValueError(code)
def stamp(value):
 try:
  need(type(value)is str and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z',value),'DIAG_TIMESTAMP_CANONICAL')
  dt=datetime.datetime.fromisoformat(value.replace('Z','+00:00'));need(dt.isoformat(timespec='milliseconds').replace('+00:00','Z')==value,'DIAG_TIMESTAMP_CANONICAL');return int(dt.timestamp()*1000)
 except(ValueError,OverflowError):raise ValueError('DIAG_TIMESTAMP_CANONICAL')
def capture(c,env,full,utc_ms=None,mono_ns=None,anchor=None):
 need(env.get('CONTENT_PLAN_WORKER_ENABLED')!='1','DIAG_PLAN_WORKER_NOT_OFF')
 need(full['tables'][BRIDGE]['columns']==FIELDS and full['tables'][SEQ]['columns']==['name','seq'],'DIAG_SCHEMA_UNKNOWN')
 rows=c.execute('SELECT bot_key,ok,username,telegram_bot_id,error,checked_at FROM client_bot_bridge_state').fetchall();need(len(rows)==1,'DIAG_PINNED_SINGLE_BRIDGE_REQUIRED');row=rows[0];key,ok,user,bot,error,checked=row
 names={'palitra':'PALITRA_CLIENT_BOT_USERNAME','alvi':'ALVI_CLIENT_BOT_USERNAME'}
 need(key in names and type(ok)is int and ok==1 and type(user)is str and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{1,28}bot',user,re.I)and type(bot)is str and re.fullmatch(r'[0-9]{1,20}',bot)and error=='','DIAG_BRIDGE_NOT_STEADY_READY')
 expected=str(env.get(names[key],'')).strip().removeprefix('@');need(user.lower()==expected.lower(),'DIAG_BRIDGE_CONFIG_MISMATCH')
 key_hash=digest([key]);need(set(full['tables'][BRIDGE]['rows'])=={key_hash}and full['tables'][BRIDGE]['rows'][key_hash]==digest(list(row)),'DIAG_BRIDGE_SNAPSHOT_MISMATCH')
 sequences=c.execute("SELECT rowid,name,seq FROM sqlite_sequence WHERE name='hugh_owner_alerts'").fetchall();need(len(sequences)==1,'DIAG_EXISTING_SEQUENCE_REQUIRED');rid,name,value=sequences[0]
 need(type(rid)is int and type(value)is int and 0<=value<=SAFE,'DIAG_SEQUENCE_TYPE');seq_key=digest([rid]);need(full['tables'][SEQ]['rows'].get(seq_key)==digest([name,value]),'DIAG_SEQUENCE_SNAPSHOT_MISMATCH')
 maximum=c.execute('SELECT COALESCE(MAX(id),0)FROM hugh_owner_alerts').fetchone()[0];need(type(maximum)is int and 0<=maximum<=value,'DIAG_SEQUENCE_HIGHWATER_INVALID')
 candidates=c.execute("SELECT o.id,EXISTS(SELECT 1 FROM hugh_owner_alerts a WHERE a.event_key='delivery:'||o.id)FROM project_chat_outbox o JOIN project_chat_ai_jobs j ON j.reply_message_id=o.message_id JOIN project_chat_messages m ON m.id=o.message_id WHERE j.api_assistant=1 AND o.status<>'sent'").fetchall()
 need(len(candidates)<=500000 and all(type(i)is int and 0<i<=SAFE and exists==1 for i,exists in candidates),'DIAG_UNKNOWN_DUPLICATE_DELIVERY_KEY')
 delayed=c.execute("SELECT COUNT(*)FROM project_chat_ai_jobs j JOIN project_chat_rooms r ON r.company_code=j.company_code JOIN project_chat_messages m ON m.id=j.message_id WHERE j.api_assistant=1 AND r.api_assistant=1 AND j.status<>'done' AND j.reply_message_id IS NULL").fetchone()[0]
 stale=c.execute("SELECT COUNT(*)FROM project_chat_tasks t JOIN project_chat_rooms r ON r.company_code=t.company_code WHERE r.api_assistant=1 AND t.external_ref LIKE 'api-assistant:%' AND t.status NOT IN('done','cancelled')").fetchone()[0]
 need(delayed==stale==0,'DIAG_ADDITIONAL_RECURRING_CANDIDATE')
 transport=c.execute("SELECT EXISTS(SELECT 1 FROM hugh_owner_alerts WHERE event_key='dispatch-transport-error')").fetchone()[0]
 utc=int(time.time()*1000)if utc_ms is None else utc_ms;mono=time.monotonic_ns()if mono_ns is None else mono_ns;t=stamp(checked)
 need(type(utc)is int and type(mono)is int and 0<=utc-t<=TTL,'DIAG_BRIDGE_NOT_FRESH_OR_FUTURE');need(c.total_changes==0,'DIAG_NOT_READONLY')
 start=anchor or{'utcMs':utc,'monoNs':mono};need(start['utcMs']<=utc and start['monoNs']<=mono,'DIAG_SNAPSHOT_CLOCK')
 return {'utcMs':utc,'monoNs':mono,'anchorUtcMs':start['utcMs'],'anchorMonoNs':start['monoNs'],'bridge':{'key':key_hash,'payload':digest(list(row[:5])),'checkedAt':checked,'ready':True},'sequence':{'key':seq_key,'name':name,'value':value},'D':len(candidates),'keys':digest(sorted(i for i,_ in candidates)),'transport':int(bool(env.get('CRM_API_KEY'))and transport)}
def compare(before,baseline,current,observed,previous,generations):
 need(generations in(1,2),'DIAG_GENERATION_BOUND');need(observed['utcMs']>=previous['utcMs']>=baseline['utcMs']and observed['monoNs']>=previous['monoNs']>=baseline['monoNs'],'DIAG_CLOCK_REGRESSION')
 elapsed=(observed['monoNs']-baseline['anchorMonoNs']+999999)//1000000;wall=observed['utcMs']-baseline['anchorUtcMs'];need(0<=elapsed<=WINDOW and abs(wall-elapsed)<=1000,'DIAG_CLOCK_WINDOW')
 need(observed['D']==baseline['D']and observed['keys']==baseline['keys']and observed['transport']==baseline['transport'],'DIAG_DUPLICATE_KEYSET_CHANGED')
 need(observed['bridge']['key']==baseline['bridge']['key']and observed['bridge']['payload']==baseline['bridge']['payload']and observed['bridge']['ready']==baseline['bridge']['ready']==True,'DIAG_BRIDGE_PAYLOAD_CHANGED')
 need(stamp(observed['bridge']['checkedAt'])>=stamp(previous['bridge']['checkedAt'])>=stamp(baseline['bridge']['checkedAt']),'DIAG_BRIDGE_HIGHWATER_REGRESSION')
 seq=observed['sequence'];need(seq['key']==baseline['sequence']['key']and seq['name']==baseline['sequence']['name']=='hugh_owner_alerts'and type(seq['value'])is int and SAFE>=seq['value']>=previous['sequence']['value']>=baseline['sequence']['value'],'DIAG_SEQUENCE_HIGHWATER_REGRESSION')
 bound=baseline['D']*((elapsed+2999)//3000+2*generations)+baseline['transport']*((elapsed+9999)//10000+2*generations)
 need(seq['value']-baseline['sequence']['value']<=bound,'DIAG_SEQUENCE_BUDGET_EXCEEDED')
 need(pack(before['tables'][ALERTS])==pack(current['tables'][ALERTS]),'DIAG_ALERT_ROWS_CHANGED')
 normalized=copy.deepcopy(current)
 for table,key in((BRIDGE,baseline['bridge']['key']),(SEQ,baseline['sequence']['key'])):
  need(key in normalized['tables'][table]['rows']and key in before['tables'][table]['rows'],'DIAG_ROW_IDENTITY_CHANGED');normalized['tables'][table]['rows'][key]=before['tables'][table]['rows'][key]
 need(pack(normalized)==pack(before),'DATABASE_SCHEMA_OR_ROWS_CHANGED_INSPECT_ONLY')
 return observed
