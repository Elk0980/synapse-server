"""Closed historical-reference classification; never accepts the expired R7 window."""
import copy
from datetime import datetime, timezone

CRM_TABLES = {'social_collect_runs','social_analytics_evidence','social_snapshots','social_collect_queue','sqlite_sequence'}
WRITERS = {
 'crm': {'server.js':'b0146b3c3a9bc4a8cea15171d6edb46d178d83072dbf08945778d4be7a332248',
         'social-stats.js':'30a0959148e1f51c9cef9c873588c6f16c1db2f449c9babb21a27e3c33baf720',
         'social-analytics-evidence.js':'7c742e2c4eef15d9027341a3fb857b35c2509361c5adf6c316ee8a74c63667b4'},
 'content': {'hugh-economy.js':'65973debe10ca8cdae5ea463bc8e46da45dfd4d0a509b7064a72ee2435439d91',
             'server.js':'755e27e780f48ff1c44fac4e153b4a003f0addaa408e54c66a629b6784a37115'}}

def stamp(value):
 if not isinstance(value,str):raise ValueError('EXACT_METADATA_TIME_REQUIRED')
 return datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()

def records(m,conn,name):
 cols=conn.execute('PRAGMA table_info('+m.quote(name)+')').fetchall()
 keys=[r[1]for r in sorted(cols,key=lambda r:r[5])if r[5]];names=[r[1]for r in cols];n=len(keys)or 1;out={}
 for row in conn.execute('SELECT '+(','.join(map(m.quote,keys))if keys else'rowid')+','+','.join(map(m.quote,names))+' FROM '+m.quote(name)):
  k=m.sha(m.enc([m.cell(v)for v in row[:n]]));m.need(k not in out,'UNIQUE_CLASSIFIER_KEY_REQUIRED');out[k]=dict(zip(names,row[n:]))
 return out

def delta(m,a,b):
 return ([b[k]for k in b.keys()-a.keys()],[a[k]for k in a.keys()-b.keys()],[(a[k],b[k])for k in a.keys()&b.keys()if m.enc(a[k])!=m.enc(b[k])])

def bind_records(m,facts,name,rows):
 wanted=facts['tables'][name];columns=wanted['columns']
 actual={k:m.sha(m.enc([m.cell(row[c])for c in columns]))for k,row in rows.items()}
 m.need(actual==wanted['rows'],'CLASSIFIER_RECORDS_FACTS_BINDING_CHANGED')

def crm(m,before,after,old,new,begin,end):
 m.need(m.enc(before['schema'])==m.enc(after['schema'])and set(before['tables'])==set(after['tables']),'HISTORICAL_CRM_SCHEMA_CHANGED')
 m.need(all(m.enc(after['tables'][t])==m.enc(before['tables'][t])for t in before['tables']if t not in CRM_TABLES),'UNKNOWN_CRM_BUSINESS_DIFF')
 for t in CRM_TABLES:bind_records(m,before,t,old[t]);bind_records(m,after,t,new[t])
 ds={t:delta(m,old[t],new[t])for t in CRM_TABLES}
 m.need(all(before['tables'][t]['columns']==after['tables'][t]['columns']for t in CRM_TABLES),'HISTORICAL_CRM_COLUMNS_CHANGED')
 shape={t:tuple(map(len,v))for t,v in ds.items()}
 m.need(shape=={'social_collect_runs':(1,0,0),'social_analytics_evidence':(1,0,0),'social_snapshots':(0,0,1),'social_collect_queue':(0,1,0),'sqlite_sequence':(0,0,3)},'UNKNOWN_CRM_DELTA_SHAPE')
 r=ds['social_collect_runs'][0][0];e=ds['social_analytics_evidence'][0][0];q=ds['social_collect_queue'][1][0];b,a=ds['social_snapshots'][2][0]
 m.need(r['trigger']=='schedule'and r['status']=='partial'and r['closed']==0 and q['attempts']==6,'EXACT_BACKGROUND_ATTEMPT_LIMIT_REQUIRED')
 m.need(all(q[c]==r[c]for c in('company_code','platform','account_ref','date')),'EXACT_QUEUE_RUN_SCOPE_REQUIRED')
 m.need(e['run_id']=='run-'+str(r['id'])and e['company_code']==r['company_code']and e['platform']==r['platform'],'EXACT_EVIDENCE_RUN_REQUIRED')
 m.need(a['run_id']==r['id']and all(a[c]==r[c]for c in('company_code','platform','account_ref')),'EXACT_SNAPSHOT_RUN_REQUIRED')
 m.need({c for c in b if b[c]!=a[c]}=={'collected_at','run_id'},'UNKNOWN_SNAPSHOT_PAYLOAD_DIFF')
 m.need(e['collected_at']==a['collected_at']and e['created_at']>=e['collected_at'],'EXACT_OBSERVATION_LINK_REQUIRED')
 times=[stamp(r['started_at']),stamp(e['collected_at']),stamp(e['created_at']),stamp(r['finished_at'])]
 m.need(begin<=times[0]<=times[1]<=times[2]<=times[3]<=end,'BACKGROUND_TIME_OUTSIDE_OBSERVED_INTERVAL')
 oldseq={v['name']:v['seq']for v in old['sqlite_sequence'].values()};newseq={v['name']:v['seq']for v in new['sqlite_sequence'].values()}
 changed={y['name']for x,y in ds['sqlite_sequence'][2]}
 m.need(changed=={'social_collect_runs','social_analytics_evidence','social_snapshots'}and all(newseq[n]==oldseq[n]+1 for n in changed),'EXACT_THREE_AUTOINCREMENT_STEPS_REQUIRED')
 m.need(r['id']==newseq['social_collect_runs']and e['id']==newseq['social_analytics_evidence']and a['id']==b['id'],'EXACT_NEW_ROWID_HIGHWATER_REQUIRED')
 return {'kind':'ONE_LINKED_BACKGROUND_SCHEDULE_PARTIAL_LIMIT6','startedAt':r['started_at'],'finishedAt':r['finished_at'],'snapshotPayloadUnchanged':True,'sequenceThreeExactSteps':True}

def balance(m,old,new,begin,end):
 m.need(set(old)==set(new)and len(old)==1,'UNKNOWN_PROVIDER_KEY_DIFF');a=next(iter(old.values()));b=next(iter(new.values()))
 m.need(a['provider']==b['provider']=='deepseek'and a['revision']==b['revision'],'UNKNOWN_PROVIDER_REVISION_DIFF')
 changed={c for c in a if a[c]!=b[c]}
 m.need(changed<= {'checked_at','attempt_at'}and b['status']=='ok'and b['checked_at']==b['attempt_at'],'UNKNOWN_PROVIDER_PAYLOAD_DIFF')
 m.need(a['attempt_at']<=b['attempt_at']and a['checked_at']<=b['checked_at']and begin<=b['attempt_at']/1000<=end,'UNKNOWN_PROVIDER_TIME_DIFF')
 return {'kind':'CACHE_TIMESTAMPS_ONLY','beforeAttempt':a['attempt_at'],'afterAttempt':b['attempt_at'],'payloadRevisionStatusErrorPreserved':True}

def content(m,before,after,diag,obs,oldbalance,newbalance,begin,end):
 bind_records(m,before,'ai_balance_snapshots',oldbalance);bind_records(m,after,'ai_balance_snapshots',newbalance)
 m.need(obs['bridge']['key']==diag['bridge']['key']and obs['bridge']['payload']==diag['bridge']['payload'],'HISTORICAL_BRIDGE_PAYLOAD_CHANGED')
 p=m.diagnostic_policy();m.need(p.stamp(obs['bridge']['checkedAt'])>=p.stamp(diag['bridge']['checkedAt']),'HISTORICAL_BRIDGE_TIME_REGRESSION')
 m.need(obs['sequence']['key']==diag['sequence']['key']and obs['sequence']['name']==diag['sequence']['name']and obs['sequence']['value']>=diag['sequence']['value'],'HISTORICAL_DIAGNOSTIC_KEY_OR_HIGHWATER_CHANGED')
 cache=balance(m,oldbalance,newbalance,begin,end);value=copy.deepcopy(after)
 for t,k in (('client_bot_bridge_state',diag['bridge']['key']),('sqlite_sequence',diag['sequence']['key'])):
  m.need(k in value['tables'][t]['rows']and k in before['tables'][t]['rows'],'EXACT_EXISTING_DIAGNOSTIC_KEY_REQUIRED');value['tables'][t]['rows'][k]=before['tables'][t]['rows'][k]
 value['tables']['ai_balance_snapshots']=before['tables']['ai_balance_snapshots']
 m.need(m.enc(value)==m.enc(before),'UNKNOWN_CONTENT_BUSINESS_OR_SCHEMA_DIFF')
 return {'cache':cache,'historicalDiagnosticMonotonicOnly':True,'expiredWindowAccepted':False}


SESSION_ID = 24
SESSION_CREATED = '2026-10-31T16:03:10.018Z'
SESSION_EXPIRES = '2026-11-30T16:03:10.018Z'
REMINDER_CREATED = '2026-10-31T15:00:54.872Z'
REMINDER_COMPLETED = '2026-10-31T15:00:54.879Z'
COMPANY = 'palitra-love'


def observed_appends(m, d, before, after, old, live, begin, end):
    m.need(m.enc(before['schema']) == m.enc(after['schema']) and
           set(before['tables']) == set(after['tables']),
           'OBSERVED_APPEND_SCHEMA_CHANGED')
    targets = {
        'chat_web_sessions': [SESSION_ID],
        'content_review_reminder_runs': [COMPANY, '2026-10-31', 'evening'],
    }
    if all(m.enc(before['tables'][t]) == m.enc(after['tables'][t]) for t in targets):
        return after, {'kind': 'NO_OBSERVED_APPENDS'}
    added = {}
    for table, primary in targets.items():
        a, b = before['tables'][table], after['tables'][table]
        key = m.sha(m.enc([m.cell(v) for v in primary]))
        m.need(a['columns'] == b['columns'] and
               set(b['rows']) - set(a['rows']) == {key} and
               all(b['rows'].get(k) == v for k, v in a['rows'].items()),
               'ONLY_TWO_EXACT_APPEND_KEYS_ALLOWED')
        added[table] = key
    # Do not retrieve token_hash, csrf_hash, account id, or chat id values.
    session = live.execute('''SELECT
        site='palitra' AND company_code=? AND
        origin IN ('https://palitra-love.ru','https://palitra-love-draft-1.synapsebusiness.ru') AND
        scope='customer_chat' AND account_kind='guest' AND account_user_id IS NULL AND
        created_at=? AND expires_at=? AND revoked_at IS NULL AND
        length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*' AND
        length(csrf_hash)=64 AND csrf_hash NOT GLOB '*[^0-9a-f]*'
        FROM chat_web_sessions WHERE id=?''',
        (COMPANY, SESSION_CREATED, SESSION_EXPIRES, SESSION_ID)).fetchall()
    m.need(session == [(1,)], 'EXACT_OBSERVED_GUEST_SESSION_REQUIRED')
    reminder = live.execute('''SELECT
        target_date='2026-11-01' AND status='empty' AND attempts=1 AND last_error IS NULL AND
        created_at=? AND completed_at=? AND
        chat_id=CAST((SELECT telegram_chat_id FROM project_chat_rooms WHERE company_code=?) AS TEXT)
        FROM content_review_reminder_runs WHERE company_code=? AND run_date='2026-10-31' AND phase='evening' ''',
        (REMINDER_CREATED, REMINDER_COMPLETED, COMPANY, COMPANY)).fetchall()
    m.need(reminder == [(1,)], 'EXACT_OBSERVED_EMPTY_REMINDER_REQUIRED')
    m.need(begin <= d.stamp(REMINDER_CREATED) <= d.stamp(REMINDER_COMPLETED) <= end and
           begin <= d.stamp(SESSION_CREATED) <= end,
           'OBSERVED_APPEND_TIME_OUTSIDE_HISTORY')
    a = d.records(m, old, 'sqlite_sequence')
    b = d.records(m, live, 'sqlite_sequence')
    d.bind_records(m, before, 'sqlite_sequence', a)
    d.bind_records(m, after, 'sqlite_sequence', b)
    keys = [k for k, row in a.items() if row['name'] == 'chat_web_sessions']
    m.need(len(keys) == 1, 'ONE_ORIGINAL_SESSION_SEQUENCE_REQUIRED')
    key = keys[0]
    m.need(key in b and a[key] == {'name': 'chat_web_sessions', 'seq': 23} and
           b[key] == {'name': 'chat_web_sessions', 'seq': SESSION_ID},
           'EXACT_SESSION_SEQUENCE_23_TO_24_REQUIRED')
    value = copy.deepcopy(after)
    for table, primary in added.items():
        del value['tables'][table]['rows'][primary]
    value['tables']['sqlite_sequence']['rows'][key] = before['tables']['sqlite_sequence']['rows'][key]
    return value, {
        'kind': 'EXACT_GUEST24_AND_EMPTY_EVENING_REMINDER_20261031',
        'sessionCreatedAt': SESSION_CREATED,
        'reminderCreatedAt': REMINDER_CREATED,
        'oldRowsAndSchemaPreserved': True,
        'credentialValuesReadOrPrinted': False,
    }
