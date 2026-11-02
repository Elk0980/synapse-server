"""Pure read-only warning projection for exact reviewed Hugh modules.
No provider imports, factories, decryption, network, refresh, or financial output.
A decryption-dependent runtime-ready branch is represented as an interval; only
warning booleans identical for every possible branch may pass. Otherwise refuse.
"""
import json,math,re
from datetime import datetime,timezone
from urllib.parse import urlsplit
CATALOG=('zai','qwen','deepseek','gemini','mistral','openai','anthropic')
HOSTS={'zai':{'api.z.ai','open.bigmodel.cn'},'qwen':{'dashscope-intl.aliyuncs.com','dashscope.aliyuncs.com'},'deepseek':{'api.deepseek.com'},'gemini':{'generativelanguage.googleapis.com'},'mistral':{'api.mistral.ai'},'openai':{'api.openai.com'},'anthropic':{'api.anthropic.com'}}
MICRO=1000000;DAY=86400000;CACHE=600000;STALE=1800000;SAFE=9007199254740991
class ProjectionError(ValueError):pass
def need(value,reason):
 if not value:raise ProjectionError(reason)
def require_schema(c,required):
 for table,cols in required.items():
  actual={r[1]for r in c.execute('PRAGMA table_info("'+table+'")')};need(set(cols)<=actual,'ECONOMY_SCHEMA_UNKNOWN:'+table)
def number(text):
 text=str(text).strip()
 if not text:return 0.0
 try:
  if re.fullmatch(r'0[xX][0-9a-fA-F]+',text):return float(int(text,16))
  if re.fullmatch(r'0[bB][01]+',text):return float(int(text,2))
  if re.fullmatch(r'0[oO][0-7]+',text):return float(int(text,8))
  return float(text)if re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?',text)else float('nan')
 except(ValueError,OverflowError):return float('nan')
def read_budget(env):
 invalid=[]
 def read(key,kind,default=0,maxval=100000000):
  raw=env.get(key)
  if raw is None or not str(raw).strip():return default
  if kind=='money':
   value=number(raw);ok=math.isfinite(value)and 0<=value<=1000000
   if ok:return math.floor(value*MICRO+0.5)
  else:
   ok=bool(re.fullmatch(r'[0-9]+',str(raw).strip()));value=int(str(raw).strip())if ok else 0;ok=ok and 0<=value<=maxval
   if ok:return value
  invalid.append(key);return default
 cap=read('HUGH_FALLBACK_BUDGET_USD','money');requests=read('HUGH_FALLBACK_BUDGET_MAX_REQUESTS','whole')
 days=read('HUGH_FALLBACK_BUDGET_WINDOW_DAYS','whole',30,3650)or 30
 read('HUGH_FALLBACK_BUDGET_MAX_OUTPUT_TOKENS','whole',1200,200000)
 return{'cap':cap,'requests':requests,'days':days,'blocked':bool(invalid)}
def iso(ms):return datetime.fromtimestamp(ms/1000,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def integer(v,reason,nullable=False):
 if nullable and v is None:return None
 need(type(v)is int and 0<=v<=SAFE,reason);return v
def time_value(value):
 if value in(None,''):return None
 try:
  dt=datetime.fromisoformat(str(value).replace('Z','+00:00'));need(dt.tzinfo is not None and bool(re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})',str(value))),'ECONOMY_COOLDOWN_UNKNOWN');return int(dt.timestamp()*1000)
 except(ValueError,TypeError,OverflowError):raise ProjectionError('ECONOMY_COOLDOWN_UNKNOWN')
def settings(c):
 require_schema(c,{'hugh_provider_settings':['name','enabled','budget_usd_micro','config_revision','check_state','checked_revision','encrypted_key','base_url'],'ai_balance_snapshots':['provider','revision','checked_at','attempt_at','status','data'],'ai_economy_alert_state':['key','active','episode'],'project_chat_provider_state':['provider','cooldown_until'],'hugh_fallback_spend':['window_start','provider','requests','micro_usd'],'hugh_fallback_reservations':['window_start','provider','micro_usd','state']})
 result={}
 # Credential ciphertext is never selected. The DB computes only key presence.
 for name,enabled,cap,revision,check,checked,key_present,base in c.execute('SELECT name,enabled,budget_usd_micro,config_revision,check_state,checked_revision,CASE WHEN length(encrypted_key)>0 THEN 1 ELSE 0 END,base_url FROM hugh_provider_settings'):
  need(name in CATALOG and name not in result and enabled in(0,1)and key_present in(0,1),'ECONOMY_PROVIDER_METADATA_UNKNOWN')
  integer(cap,'ECONOMY_PROVIDER_CAP_UNKNOWN',True);integer(revision,'ECONOMY_REVISION_UNKNOWN');integer(checked,'ECONOMY_CHECK_REVISION_UNKNOWN',True)
  need(type(base)is str and len(base)<=300,'ECONOMY_BASE_METADATA_UNKNOWN')
  result[name]={'enabled':bool(enabled),'cap':cap,'revision':revision,'current':check=='ok'and checked is not None and checked==revision,'key':bool(key_present),'base':base}
 return result

def totals(c,start,provider=None):
 where='window_start=?'+(' AND provider=?'if provider is not None else'');args=(start,provider)if provider is not None else(start,)
 bad=c.execute('SELECT COUNT(*)FROM hugh_fallback_spend WHERE '+where+" AND(typeof(requests)<>'integer' OR requests<0 OR typeof(micro_usd)<>'integer' OR micro_usd<0)",args).fetchone()[0]
 bad+=c.execute('SELECT COUNT(*)FROM hugh_fallback_reservations WHERE '+where+" AND(typeof(micro_usd)<>'integer' OR micro_usd<0 OR state NOT IN('held','kept'))",args).fetchone()[0]
 need(bad==0,'ECONOMY_SPEND_METADATA_UNKNOWN')
 requests,cost=c.execute('SELECT COALESCE(SUM(requests),0),COALESCE(SUM(micro_usd),0)FROM hugh_fallback_spend WHERE '+where,args).fetchone()
 held,held_cost=c.execute('SELECT COUNT(*),COALESCE(SUM(micro_usd),0)FROM hugh_fallback_reservations WHERE '+where,args).fetchone()
 for value in(requests,cost,held,held_cost,requests+held,cost+held_cost):integer(value,'ECONOMY_TOTALS_OUT_OF_RANGE')
 return requests+held,cost+held_cost

def base_allowed(name,raw,env):
 clean=raw.strip().rstrip('/')
 need(clean.isascii()and '..'not in clean and bool(re.match(r'https://',clean,re.I))and not any(ord(ch)<32 for ch in clean)and '%'not in clean and '\\'not in clean,'ECONOMY_BASE_URL_NONCANONICAL')
 try:u=urlsplit(clean);port=u.port
 except ValueError:return False
 extra={s.strip().lower()for s in str(env.get('HUGH_PROVIDER_ALLOWED_HOSTS','')).split(',')if re.fullmatch('[a-z0-9.-]{3,253}',s.strip().lower())}
 return bool(u.scheme=='https'and not u.username and not u.password and port in(None,443)and not u.query and not u.fragment and u.hostname in(HOSTS.get(name,set())|extra)and not re.fullmatch(r'[0-9]+(?:\.[0-9]+){3}',u.hostname or'')and ':'not in(u.hostname or'')and '..'not in u.path and '//'not in u.path)

def environment_providers(env):
 result=[]
 for name in str(env.get('HUGH_FALLBACK_PROVIDERS','')).split(','):
  name=name.strip()
  if not re.fullmatch('[a-z][a-z0-9_-]{0,30}',name,re.I):continue
  key=name.upper().replace('-','_');url=str(env.get('HUGH_FALLBACK_'+key+'_URL','')).strip().removesuffix('/')
  # Secret/model values are neither retained in this projection nor returned.
  if url and str(env.get('HUGH_FALLBACK_'+key+'_KEY','')).strip()and str(env.get('HUGH_FALLBACK_'+key+'_MODEL','')).strip()and url.startswith('https://'):result.append(name.lower())
 return result

def wallet(c,wanted,at,end,potential_account):
 row=c.execute("SELECT revision,status,checked_at,attempt_at,CASE WHEN json_valid(data)THEN 1 ELSE 0 END,CASE WHEN json_valid(data)THEN json_type(data,'$.available')ELSE NULL END FROM ai_balance_snapshots WHERE provider='deepseek'").fetchone()
 if potential_account:
  need(row is not None and row[0]==wanted,'ECONOMY_REFRESH_WOULD_REQUEST')
  integer(row[3],'ECONOMY_CACHE_TIMESTAMP_UNKNOWN')
  need(row[3]<=at and end-row[3]<CACHE,'ECONOMY_CACHE_EXPIRES_IN_WINDOW')
 if row is None or row[0]!=wanted:return False
 revision,status,checked,attempt,valid,available_type=row
 need(valid==1 and status in('ok','error'),'ECONOMY_CACHE_METADATA_UNKNOWN')
 # Exact parseBalance cache shape prevents JSON spread overriding status/stale.
 shape=c.execute("SELECT json_type(CASE WHEN json_valid(data)THEN data ELSE '{}'END),json_type(CASE WHEN json_valid(data)THEN data ELSE '{}'END,'$.balances'),(SELECT count(*)FROM json_each(CASE WHEN json_valid(s.data)THEN s.data ELSE '{}'END)WHERE key NOT IN('available','balances')),(SELECT count(*)-count(DISTINCT key)FROM json_each(CASE WHEN json_valid(s.data)THEN s.data ELSE '{}'END))FROM ai_balance_snapshots s WHERE provider='deepseek'").fetchone()
 need(shape==('object','array',0,0),'ECONOMY_CACHE_SPREAD_SHAPE_UNKNOWN')
 integer(revision,'ECONOMY_CACHE_REVISION_UNKNOWN');integer(checked,'ECONOMY_CHECKED_TIMESTAMP_UNKNOWN');integer(attempt,'ECONOMY_CACHE_TIMESTAMP_UNKNOWN')
 need(available_type in('true','false',None),'ECONOMY_WALLET_BOOLEAN_UNKNOWN')
 return status=='ok'and at-checked<=STALE and available_type=='false'

def warning_flags(status,runtime):
 """Exact boolean image of pinned warnings(); used with synthetic conformance tests."""
 result={}
 for p in status['providers']:
  spend=p['spend'];b=p.get('wallet')
  result['limit:'+p['name']]=bool(p['enabled']and spend['limitUsd']is not None and spend['remainingUsd']<=spend['limitUsd']*0.1)
  result['wallet:'+p['name']]=bool(p['enabled']and b and b.get('status')=='ok'and not b.get('stale',False)and b.get('available')is False)
 enabled=sum(bool(p['enabled'])for p in status['providers'])
 ready=sum(not p['cooling']and not p['ownLimitReached']and not runtime['budget']['stopped']for p in runtime.get('providers',[]))
 result['reserve']=enabled>0 and ready<2
 b=status['budget'];result['global-limit']=b['remainingUsd']is not None and b['remainingUsd']<=b['limitUsd']*0.1
 result['request-limit']=isinstance(b['remainingRequests'],(int,float))and not isinstance(b['remainingRequests'],bool)and math.isfinite(b['remainingRequests'])and b['remainingRequests']<=b['maxRequests']*0.1
 return result

def project(c,env,at,end,opaque=None):
 """Return only warning flags/counts. Financial values stay local to calculations."""
 need(type(at)is int and type(end)is int and 0<=end-at<=3600000,'ECONOMY_WINDOW_BOUND')
 saved=settings(c);budget=read_budget(env);window=budget['days']*DAY
 if opaque is not None:
  need(type(opaque)is dict and set(opaque)=={'providers','canUseBalanceAccount'},'ECONOMY_OPAQUE_PROOF_SHAPE')
  need(type(opaque['providers'])is list and len(opaque['providers'])==len(CATALOG),'ECONOMY_OPAQUE_PROOF_SHAPE')
  need([r.get('provider')for r in opaque['providers']]==list(CATALOG)and all(set(r)=={'provider','canDecryptAndPassRuntimeSelection'}and type(r['canDecryptAndPassRuntimeSelection'])is bool for r in opaque['providers'])and type(opaque['canUseBalanceAccount'])is bool,'ECONOMY_OPAQUE_PROOF_SHAPE')
  runtime_selected={r['provider']:r['canDecryptAndPassRuntimeSelection']for r in opaque['providers']}
 # These are all time boundaries that can change the boolean inputs in the window.
 times={at,end};reset=(at//window+1)*window
 if at<reset<=end:times.update((reset-1,reset))
 cooldown={}
 for name,value in c.execute('SELECT provider,cooldown_until FROM project_chat_provider_state'):
  need(type(name)is str,'ECONOMY_PROVIDER_STATE_UNKNOWN');cooldown[name]=time_value(value)
  if cooldown[name]is not None and at<cooldown[name]<=end:times.update((int(cooldown[name])-1,int(cooldown[name])))
 deep=saved.get('deepseek',{});master=len(str(env.get('HUGH_PROVIDER_MASTER_KEY','')).encode('utf-16-le'))//2>=32
 potential_account=bool(master and deep.get('enabled')and deep.get('key')and re.fullmatch(r'https://api\.deepseek\.com(?:/v1)?',deep.get('base','')))
 if opaque is not None:potential_account=opaque['canUseBalanceAccount']
 cache=c.execute("SELECT checked_at FROM ai_balance_snapshots WHERE provider='deepseek'").fetchone()
 if cache and type(cache[0])is int and at<cache[0]+STALE+1<=end:times.update((cache[0]+STALE,cache[0]+STALE+1))
 env_names=environment_providers(env);observed=None;uncertain_runtime=False
 for now in sorted(times):
  start=iso((now//window)*window);requests,cost=totals(c,start)
  remaining=max(0,(budget['cap']-cost)/MICRO)if budget['cap']>0 else None
  rem_requests=max(0,budget['requests']-requests)if budget['requests']>0 else None
  stopped=budget['blocked']or(budget['cap']>0 and cost>=budget['cap'])or(budget['requests']>0 and requests>=budget['requests'])
  unavailable=wallet(c,deep.get('revision',0),now,end,potential_account)
  flags={};enabled=0
  for name in CATALOG:
   cfg=saved.get(name,{});on=cfg.get('enabled',False);enabled+=int(on);cap=cfg.get('cap')or 0
   _,owncost=totals(c,start,name)
   ownrem=max(0,(cap-owncost)/MICRO)if cap>0 else None
   flags['limit:'+name]=bool(on and cap>0 and ownrem<=cap/MICRO*0.1)
   flags['wallet:'+name]=bool(on and name=='deepseek'and unavailable)
  flags['global-limit']=remaining is not None and remaining<=budget['cap']/MICRO*0.1
  flags['request-limit']=rem_requests is not None and rem_requests<=budget['requests']*0.1
  low=high=0
  names=set(env_names)|set(saved)
  for name in names:
   cooling=cooldown.get(name)is not None and cooldown[name]>now
   env_count=env_names.count(name)if not cooling and not stopped else 0
   cfg=saved.get(name,{})
   may_stored=bool(master and cfg.get('enabled')and cfg.get('key')and cfg.get('current')and name!='anthropic'and base_allowed(name,cfg.get('base',''),env))
   if opaque is not None:
    selected=runtime_selected.get(name,False)
    if selected:
     need(bool(cfg),'ECONOMY_OPAQUE_SETTINGS_MISMATCH');_,owncost=totals(c,start,name);owncap=cfg.get('cap')or 0
     count=int(not cooling and not stopped and not(owncap>0 and owncost>=owncap))
    else:count=env_count
    low+=count;high+=count
   elif may_stored:
    _,owncost=totals(c,start,name);owncap=cfg.get('cap')or 0
    stored_ready=int(not cooling and not stopped and not(owncap>0 and owncost>=owncap))
    low+=min(env_count,stored_ready);high+=max(env_count,stored_ready)
   else:low+=env_count;high+=env_count
  if enabled and low<2<=high:raise ProjectionError('ECONOMY_READY_BRANCH_AMBIGUOUS_NO_DECRYPT')
  flags['reserve']=bool(enabled and high<2)
  uncertain_runtime=uncertain_runtime or low!=high
  if observed is None:observed=flags
  else:need(observed==flags,'ECONOMY_WARNING_TRANSITION_IN_WINDOW')
 # warn() is a no-op when bool(previous.active)==bool(desired), including missing/false.
 prior={}
 for key,active,episode in c.execute('SELECT key,active,episode FROM ai_economy_alert_state'):
  need(type(key)is str and active in(0,1)and type(episode)is int and episode>=0,'ECONOMY_ALERT_METADATA_UNKNOWN');prior[key]=bool(active)
 changed=[key for key,value in observed.items()if prior.get(key,False)!=value]
 new=sum(observed[key]for key in changed)
 need(c.total_changes==0,'ECONOMY_PROJECTION_NOT_READONLY')
 return{'flags':observed,'wouldStateWrites':len(changed),'wouldNewAlerts':new,'cacheHitGuaranteed':potential_account,'runtimeIntervalUsed':uncertain_runtime}

def verify(c,env,at,end,opaque=None):
 result=project(c,env,at,end,opaque)
 need(result['wouldStateWrites']==0,'ECONOMY_WOULD_CHANGE_ALERT_STATE:'+str(result['wouldStateWrites'])+':NEW:'+str(result['wouldNewAlerts']))
 return{k:result[k]for k in('wouldStateWrites','wouldNewAlerts','cacheHitGuaranteed','runtimeIntervalUsed')}
