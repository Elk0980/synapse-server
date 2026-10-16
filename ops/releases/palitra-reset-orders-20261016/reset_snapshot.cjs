'use strict';
// NEW fixed11-17 read-only inventory only. No approval/apply, application factories or schema DDL.
const crypto = require('node:crypto');
const IDS = Object.freeze([11, 12, 13, 14, 15, 16, 17]);
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const unique = values => [...new Set(values.filter(v => Number.isSafeInteger(v) && v > 0))].sort((a,b)=>a-b);
const qi = value => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw Error('UNREVIEWED_IDENTIFIER'); return '"'+value+'"'; };
const list = values => values.map(()=>'?').join(',');
const fail = code => { throw Object.assign(new Error(code), { safeCode:code }); };
const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])) : value;

function collect(db) {
  const blockers = new Set(), rows = {}, projection = {}; let total = 0;
  db.exec('PRAGMA query_only=ON'); if (db.prepare('PRAGMA query_only').get().query_only !== 1) fail('QUERY_ONLY_REQUIRED');
  db.exec('BEGIN');
  try {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    if (schema.length > 3000) fail('BOUNDED_SCHEMA_REQUIRED');
    const tables = new Set(schema.filter(r=>r.type==='table').map(r=>r.name)), columns = {}, foreignKeys = [];
    for (const table of tables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) { blockers.add('UNKNOWN_TABLE_IDENTIFIER:'+hash(table).slice(0,16)); continue; }
      columns[table] = db.prepare('PRAGMA table_info('+qi(table)+')').all();
      for (const fk of db.prepare('PRAGMA foreign_key_list('+qi(table)+')').all()) foreignKeys.push({ sourceTable:table, ...fk });
    }
    const has = (t, fields=[]) => {
      if (!tables.has(t) || !columns[t] || fields.some(f=>!columns[t].some(c=>c.name===f))) { blockers.add('MISSING_TABLE_OR_COLUMNS:'+t); return false; } return true;
    };
    const read = (t, where, args=[], fields='*', required=[]) => {
      if (!has(t, required)) return [];
      const out = db.prepare('SELECT '+fields+' FROM '+qi(t)+' WHERE '+where+' LIMIT 10001').all(...args);
      if (out.length>10000 || (total+=out.length)>50000) fail('TARGET_ROWS_BOUNDED');
      return out;
    };
    const by = (t, field, values, suffix='', args=[]) => values.length ? read(t, qi(field)+' IN ('+list(values)+')'+suffix, [...values,...args], '*', [field]) : (has(t,[field]), []);
    const either=(t,pairs,suffix='',args=[])=>{const active=pairs.filter(([field,values])=>values.length);return active.length?read(t,'('+active.map(([f,v])=>qi(f)+' IN ('+list(v)+')').join(' OR ')+')'+suffix,[...active.flatMap(([f,v])=>v),...args],'*',pairs.map(([f])=>f)):(has(t,pairs.map(([f])=>f)),[]);};
    const put = (t,out) => { rows[t]=out; return out; };
    const orders = put('site_orders', read('site_orders','site=? AND company_code=? AND id IN ('+list(IDS)+')',['palitra','palitra-love',...IDS],'*',['id','site','company_code']));
    if (JSON.stringify(unique(orders.map(r=>r.id)))!==JSON.stringify(IDS)) fail('EXACT_SEVEN_ORDER_SCOPE_REQUIRED');
    projection.otherNativeOrders = read('site_orders','site=? AND company_code=? AND id NOT IN ('+list(IDS)+')',['palitra','palitra-love',...IDS],'id',['id']);
    if (projection.otherNativeOrders.length) blockers.add('OTHER_NATIVE_ORDERS_EXIST');
    for (const t of ['site_order_work','site_order_work_events','site_order_checklist','site_order_checklist_events','site_order_outbox']) put(t,by(t,'order_id',IDS));
    for (const r of rows.site_order_outbox) if (r.site!=='palitra'||r.company_code!=='palitra-love'||r.kind!=='order') blockers.add('ORDER_OUTBOX_SCOPE_MISMATCH');
    const links = put('client_order_links',by('client_order_links','order_id',IDS,' AND site=? AND bot_key=?',['palitra','palitra']));
    const threads = put('chat_threads',by('chat_threads','order_id',IDS,' AND site=? AND company_code=?',['palitra','palitra-love'])), tids=unique(threads.map(r=>r.id));
    const linkedDialogIds=unique(links.map(r=>r.dialog_id));
    const dialogWhere='bot_key=? AND company_code=? AND (order_id IN ('+list(IDS)+')'+(linkedDialogIds.length?' OR id IN ('+list(linkedDialogIds)+')':'')+')';
    const dialogs=put('client_dialogs',read('client_dialogs',dialogWhere,['palitra','palitra-love',...IDS,...linkedDialogIds],'*',['id','order_id','bot_key','company_code'])), dids=unique(dialogs.map(r=>r.id));
    if (linkedDialogIds.some(id=>!dids.includes(id))) blockers.add('LINKED_DIALOG_SCOPE_UNRESOLVED');
    if (dialogs.some(r=>r.order_id!==null && !IDS.includes(r.order_id))) blockers.add('LEGACY_DIALOG_SHARED_WITH_OTHER_ORDER');
    for (const t of ['chat_web_grants','chat_thread_channels','chat_thread_links']) put(t,by(t,'thread_id',tids));
    const messages=put('chat_thread_messages',by('chat_thread_messages','thread_id',tids)), mids=unique(messages.map(r=>r.id));
    const channelIds=unique(rows.chat_thread_channels.map(r=>r.id));put('chat_message_deliveries',either('chat_message_deliveries',[['message_id',mids],['channel_id',channelIds]]));
    for (const t of ['chat_thread_requests','chat_manager_map','chat_thread_attachments']) put(t,either(t,[[t==='chat_manager_map'?'chat_message_id':'message_id',mids],['thread_id',tids]]));
    for(const t of ['chat_thread_requests','chat_manager_map','chat_thread_attachments'])for(const r of rows[t]){if(!tids.includes(r.thread_id))blockers.add('NATIVE_CHILD_SHARED_THREAD');if(!mids.includes(r[t==='chat_manager_map'?'chat_message_id':'message_id']))blockers.add('NATIVE_CHILD_SHARED_MESSAGE');}
    for(const r of rows.chat_message_deliveries)if(!mids.includes(r.message_id)||(r.channel_id!==null&&!channelIds.includes(r.channel_id)))blockers.add('DELIVERY_SHARED_MESSAGE_OR_CHANNEL');
    for(const r of rows.chat_thread_attachments)if(r.site!=='palitra'||r.company_code!=='palitra-love')blockers.add('NATIVE_ATTACHMENT_SCOPE_MISMATCH');
    put('chat_thread_media_events', mids.length ? read('chat_thread_media_events','message_id IN ('+list(mids)+') OR replaces_message_id IN ('+list(mids)+')',[...mids,...mids],'*',['message_id','replaces_message_id']) : (has('chat_thread_media_events'),[]));
    for (const r of rows.chat_thread_media_events) if (!mids.includes(r.message_id)||!mids.includes(r.replaces_message_id)) blockers.add('MEDIA_EVENT_SHARED_MESSAGE');
    const nativeJobs=put('chat_native_jobs',either('chat_native_jobs',[['thread_id',tids],['message_id',mids]])), nativeJobIds=unique(nativeJobs.map(r=>r.job_id));
    for (const r of nativeJobs) if (!tids.includes(r.thread_id)||!mids.includes(r.message_id)||r.bot_key!=='palitra'||r.company_code!=='palitra-love') blockers.add('NATIVE_JOB_SHARED_OR_SCOPE_MISMATCH');
    const legacyMessages=put('client_dialog_messages',by('client_dialog_messages','dialog_id',dids,' AND bot_key=? AND company_code=?',['palitra','palitra-love'])), lmids=unique(legacyMessages.map(r=>r.id));
    put('client_dialog_versions',by('client_dialog_versions','message_id',lmids));
    for (const t of ['client_dialog_attachments','client_dialog_owner_requests']) put(t,either(t,[['message_id',lmids],['dialog_id',dids]]));
    for(const t of ['client_dialog_attachments','client_dialog_owner_requests'])for(const r of rows[t])if(!dids.includes(r.dialog_id)||!lmids.includes(r.message_id))blockers.add('LEGACY_CHILD_SHARED_DIALOG_OR_MESSAGE');
    const ownerJobIds=unique(rows.client_dialog_owner_requests.map(r=>r.job_id));
    const jobTerms=[], jobArgs=[];
    for (const [field, values] of [['id',unique([...nativeJobIds,...ownerJobIds])],['dialog_id',dids],['message_id',lmids]]) if(values.length){jobTerms.push(qi(field)+' IN ('+list(values)+')');jobArgs.push(...values);}
    const jobs=put('client_bot_outbox',jobTerms.length?read('client_bot_outbox','bot_key=? AND company_code=? AND ('+jobTerms.join(' OR ')+')',['palitra','palitra-love',...jobArgs],'*',['id','bot_key','company_code','dialog_id','message_id']):(has('client_bot_outbox'),[]));
    const jobIds=unique(jobs.map(r=>r.id));
    if ([...nativeJobIds,...ownerJobIds].some(id=>!jobIds.includes(id))) blockers.add('OUTBOX_LINK_SCOPE_UNRESOLVED');
    for (const r of jobs) if ((r.dialog_id!==null&&!dids.includes(r.dialog_id))||(r.message_id!==null&&!lmids.includes(r.message_id))) blockers.add('OUTBOX_SHARED_WITH_OTHER_DIALOG');
    const mapTerms=['order_id IN ('+list(IDS)+')'], mapArgs=[...IDS];
    if(dids.length){mapTerms.push('dialog_id IN ('+list(dids)+')');mapArgs.push(...dids);} if(lmids.length){mapTerms.push('client_message_id IN ('+list(lmids)+')');mapArgs.push(...lmids);}
    const maps=put('client_bot_map',read('client_bot_map','bot_key=? AND ('+mapTerms.join(' OR ')+')',['palitra',...mapArgs],'*',['bot_key','order_id','dialog_id','client_message_id']));
    for(const r of maps)if((r.order_id!==null&&!IDS.includes(r.order_id))||(r.dialog_id!==null&&!dids.includes(r.dialog_id))||(r.client_message_id!==null&&!lmids.includes(r.client_message_id)))blockers.add('BOT_MAP_SHARED_REFERENCE');
    const receiptPairs=new Map();for(const r of [...maps,...legacyMessages,...rows.chat_manager_map,...messages.map(r=>({chat_id:r.tg_chat_id,message_id:r.tg_message_id}))])if(r.chat_id&&r.message_id)receiptPairs.set(r.chat_id+'\0'+r.message_id,[r.chat_id,r.message_id]);
    put('client_bot_receipts',receiptPairs.size?read('client_bot_receipts','bot_key=? AND ('+[...receiptPairs].map(()=>'(chat_id=? AND message_id=?)').join(' OR ')+')',['palitra',...[...receiptPairs.values()].flat()],'*',['bot_key','chat_id','message_id']):(has('client_bot_receipts'),[]));
    const upTerms=[], upArgs=[];for(const [field,values]of [['thread_id',tids],['dialog_id',dids],['thread_message_id',mids],['legacy_message_id',lmids]])if(values.length){upTerms.push(qi(field)+' IN ('+list(values)+')');upArgs.push(...values);}
    const uploads=put('chat_web_uploads',upTerms.length?read('chat_web_uploads','site=? AND company_code=? AND ('+upTerms.join(' OR ')+')',['palitra','palitra-love',...upArgs],'*',['thread_id','dialog_id','site','company_code']):(has('chat_web_uploads'),[]));
    if(upTerms.length&&has('chat_web_uploads')){const n=db.prepare('SELECT COUNT(*) n FROM chat_web_uploads WHERE '+upTerms.join(' OR ')).get(...upArgs).n;if(n!==uploads.length)blockers.add('UPLOAD_SCOPE_FILTER_HIDES_REFERENCE');}
    for(const r of uploads)if((r.thread_id!==null&&!tids.includes(r.thread_id))||(r.dialog_id!==null&&!dids.includes(r.dialog_id))||(r.thread_message_id!==null&&!mids.includes(r.thread_message_id))||(r.legacy_message_id!==null&&!lmids.includes(r.legacy_message_id)))blockers.add('UPLOAD_SHARED_REFERENCE');
    if(uploads.some(r=>['prepared','receiving','ready'].includes(r.state)))blockers.add('ACTIVE_WEB_UPLOADS');
    if(uploads.some(r=>r.claim||r.claim_until))blockers.add('UPLOAD_CLAIM_NOT_PROVEN_RELEASED');
    if(uploads.some(r=>!['prepared','receiving','ready','committed','rejected','expired'].includes(r.state)))blockers.add('UPLOAD_STATE_UNREVIEWED');
    if(rows.chat_thread_attachments.some(r=>r.status==='pending')||rows.client_dialog_attachments.some(r=>r.status==='pending'))blockers.add('PENDING_MEDIA_DOWNLOADS');
    if(rows.site_order_outbox.some(r=>['pending','sending','uncertain'].includes(r.status)))blockers.add('ACTIVE_ORDER_OUTBOX');
    if(jobs.some(r=>['pending','sending','uncertain'].includes(r.status)))blockers.add('ACTIVE_CLIENT_BOT_OUTBOX');
    if(rows.site_order_outbox.some(r=>!['pending','sending','sent','uncertain','error'].includes(r.status))||jobs.some(r=>!['pending','sending','sent','uncertain','failed'].includes(r.status)))blockers.add('OUTBOX_STATE_UNREVIEWED');
    if(rows.chat_message_deliveries.some(r=>['queued','uncertain'].includes(r.status)))blockers.add('QUEUED_OR_UNCERTAIN_NATIVE_CHAT_DELIVERIES');
    if(rows.chat_message_deliveries.some(r=>!['queued','not_queued','sent','failed','uncertain'].includes(r.status)))blockers.add('DELIVERY_STATE_UNREVIEWED');
    const keys=[...IDS.map(id=>'palitra-love/order-workflow/orders/'+id),...tids.map(id=>'palitra-love/order-workflow/chat-autoreply/'+id),...IDS.map(id=>'palitra-love/order-contact-followup/v1/'+id)];
    const pushKeys=has('documents',['key','version','body'])?db.prepare("SELECT DISTINCT key FROM documents WHERE key LIKE 'palitra-push-private/v1/job/%' LIMIT 10001").all():[];
    if(pushKeys.length>10000)fail('PUSH_KEYS_BOUNDED');
    const pfx='palitra-push-private/v1/job/';
    for(const {key} of pushKeys){const rest=key.slice(pfx.length),m=/^([1-9]\d*)\/([0-9a-f]{64})$/.exec(rest),f=/^followup\/([1-9]\d*)\/([0-9]+)\/([0-9a-f]{64})$/.exec(rest);if(m&&mids.includes(Number(m[1]))||f&&IDS.includes(Number(f[1])))keys.push(key);else if(!m&&!f)blockers.add('UNREVIEWED_PUSH_JOB_KEY');}
    const documents=put('documents',by('documents','key',[...new Set(keys)]));
    const latest=new Map();for(const r of documents)if(!latest.has(r.key)||latest.get(r.key).version<r.version)latest.set(r.key,r);
    let activePush=0;for(const [key,r]of latest)if(key.startsWith(pfx)){let env;try{env=JSON.parse(r.body);}catch{blockers.add('PUSH_ENVELOPE_UNREADABLE');continue;}if(env.schema!==1||env.cipher!=='aes-256-gcm'||typeof env.active!=='boolean'||['iv','tag','data'].some(k=>typeof env[k]!=='string')||Object.keys(env).sort().join(',')!=='active,cipher,data,iv,schema,tag')blockers.add('PUSH_ENVELOPE_UNKNOWN');else if(env.active)activePush++;}if(activePush)blockers.add('ACTIVE_ENCRYPTED_PUSH_JOBS');
    projection.push={targetKeys:[...latest.keys()].filter(k=>k.startsWith(pfx)).length,activeEncrypted:activePush,decrypted:false,subscriptionsRead:false};
    projection.crm={};for(const t of ['palitra_crm_inquiries','palitra_crm_orders']){projection.crm[t]=read(t,'site_order_id IN ('+list(IDS)+')',IDS,'id,company_code,site_order_id',['id','company_code','site_order_id']);if(projection.crm[t].length)blockers.add('CRM_REFERENCE_OUTSIDE_DELETE_SCOPE');}
    // Full target-linked CRM rows stay in the private backup only, for later field-preservation review.
    projection.crmTargetRows={};for(const t of ['palitra_crm_inquiries','palitra_crm_orders'])projection.crmTargetRows[t]=read(t,'site_order_id IN ('+list(IDS)+')',IDS,'*',['id','company_code','site_order_id']);
    projection.auditHistory={scopeResolved:false,detailRead:false,kinds:has('client_bot_audit',['bot_key','kind'])?db.prepare("SELECT kind,COUNT(*) count FROM client_bot_audit WHERE bot_key=? AND kind IN ('order_linked','order_unlinked','order_link_refused','order_status') GROUP BY kind ORDER BY kind").all('palitra'):[]};
    if(projection.auditHistory.kinds.some(r=>r.count>0))blockers.add('AUDIT_HISTORY_SCOPE_UNRESOLVED');
    const audit=has('client_bot_audit',['id','bot_key','kind','detail'])?read('client_bot_audit',"bot_key=? AND kind IN ('order_linked','order_unlinked','order_link_refused','order_status')",['palitra']):[];
    const targetAudit=[];let unresolvedAudit=0;for(const row of audit){const m=row.kind==='order_status'&&/^заявка №([1-9][0-9]*): (Новая|В работе|Выполнена|Отменена)$/.exec(row.detail);if(m){if(IDS.includes(Number(m[1])))targetAudit.push(row);}else unresolvedAudit++;}
    projection.auditTargetRows=targetAudit;projection.auditHistory.targetRows=targetAudit.length;projection.auditHistory.unresolvedRows=unresolvedAudit;projection.auditHistory.detailRead=true;
    if(unresolvedAudit)blockers.add('AUDIT_TARGET_GRAMMAR_UNRESOLVED');
    const relatedTables=new Set(Object.keys(rows));
    for(const s of schema)if(s.type==='trigger'&&relatedTables.has(s.tbl_name))blockers.add('TARGET_TRIGGER:'+hash(s.name).slice(0,16));
    const sets={site_orders:IDS,chat_threads:tids,chat_thread_messages:mids,chat_thread_channels:channelIds,client_dialogs:dids,client_dialog_messages:lmids,client_bot_outbox:jobIds};
    projection.unreviewedReferences=[];
    const typed={order_id:IDS,site_order_id:IDS,thread_id:tids,dialog_id:dids,thread_message_id:mids,chat_message_id:mids,legacy_message_id:lmids,client_message_id:lmids,message_id:unique([...mids,...lmids]),job_id:jobIds};
    for(const [t,cols]of Object.entries(columns))if(!t.startsWith('palitra_crm_'))for(const c of cols)if(typed[c.name]?.length&&(!relatedTables.has(t)||['order_id','site_order_id'].includes(c.name))){
      const values=typed[c.name],n=db.prepare('SELECT COUNT(*) n FROM '+qi(t)+' WHERE '+qi(c.name)+' IN ('+list(values)+')').get(...values).n,local=(rows[t]||[]).filter(r=>values.includes(r[c.name])).length;if(n&&(!relatedTables.has(t)||n!==local)){projection.unreviewedReferences.push({table:t,column:c.name,count:n,collected:local});blockers.add((relatedTables.has(t)?'KNOWN_SCOPE_FILTER_HIDES_REFERENCE:':'UNREVIEWED_TYPED_REFERENCE:')+hash(t).slice(0,16));}}
    for(const fk of foreignKeys)if(sets[fk.table]?.length&&fk.to==='id'){
      const values=sets[fk.table],n=db.prepare('SELECT COUNT(*) n FROM '+qi(fk.sourceTable)+' WHERE '+qi(fk.from)+' IN ('+list(values)+')').get(...values).n,local=(rows[fk.sourceTable]||[]).filter(r=>values.includes(r[fk.from])).length;if(n&&(!relatedTables.has(fk.sourceTable)||n!==local))blockers.add((relatedTables.has(fk.sourceTable)?'KNOWN_FK_CLOSURE_INCOMPLETE:':'EXTERNAL_FOREIGN_KEY_REFERENCE:')+hash(fk.sourceTable).slice(0,16));}
    projection.unread={legacyDialogs:dialogs.reduce((n,r)=>n+Number(r.unread||0),0),nativeReadCursor:false};
    projection.jobs={siteOrder:unique(rows.site_order_outbox.map(r=>r.id)).map(id=>'order:'+id),clientBot:jobIds.map(id=>'cb:'+id)};
    projection.media={targetAttachmentRows:rows.chat_thread_attachments.length+rows.client_dialog_attachments.length+uploads.length,bytesInspected:false,physicalFilesDeleted:false};
    if(projection.media.targetAttachmentRows)blockers.add('MEDIA_FILES_NOT_YET_INVENTORIED');
    const fkViolations=db.prepare('PRAGMA foreign_key_check').all();if(fkViolations.length>1000)fail('FOREIGN_KEY_CHECK_BOUNDED');projection.foreignKeyCheck={count:fkViolations.length,rows:fkViolations};if(fkViolations.length)blockers.add('EXISTING_FOREIGN_KEY_VIOLATIONS');
    const sequence=db.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all();
    const out={schema:1,status:'RESET_FIXED7_CONTENT_SNAPSHOT_NOT_DELETE_APPROVAL',observedAtUtc:new Date().toISOString(),fixedOrderIds:IDS,scope:{site:'palitra',companyCode:'palitra-love'},runtime:{node:process.versions.node,engine:'node:sqlite',queryOnly:true},schemaInventory:{schema,columns,foreignKeys,sha256:hash(stable({schema,columns,foreignKeys}))},rows,projection,sequence,blockers:[...blockers].sort(),counts:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.length]))};
    db.exec('COMMIT');return out;
  } catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
}

function collectWorker(db, refs){
  if(!Array.isArray(refs)||refs.length>10000||refs.some(v=>! /^(?:cb|order):[1-9]\d*$/.test(v)))fail('EXACT_WORKER_JOB_REFS_REQUIRED');
  db.exec('PRAGMA query_only=ON');if(db.prepare('PRAGMA query_only').get().query_only!==1)fail('QUERY_ONLY_REQUIRED');db.exec('BEGIN');
  try{
    const names=['client_bot_inbox','client_bot_delivery','client_bot_ack','client_bot_checkpoint'],schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),tables=new Set(schema.filter(r=>r.type==='table').map(r=>r.name));if(schema.length>3000)fail('BOUNDED_SCHEMA_REQUIRED');for(const t of names)if(!tables.has(t))fail('WORKER_SCHEMA_UNREVIEWED');
    const columns={},foreignKeys=[];for(const t of tables){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t))fail('WORKER_SCHEMA_UNREVIEWED');columns[t]=db.prepare('PRAGMA table_info('+qi(t)+')').all();for(const fk of db.prepare('PRAGMA foreign_key_list('+qi(t)+')').all())foreignKeys.push({sourceTable:t,...fk});}
    const rows={};for(const t of ['client_bot_delivery','client_bot_ack'])rows[t]=refs.length?db.prepare('SELECT * FROM '+qi(t)+' WHERE bot_key=? AND job_id IN ('+list(refs)+') LIMIT 10001').all('palitra',...refs):[];
    for(const out of Object.values(rows))if(out.length>10000)fail('WORKER_ROWS_BOUNDED');
    const inbox=db.prepare('SELECT state,COUNT(*) count FROM client_bot_inbox WHERE bot_key=? GROUP BY state').all('palitra');
    const checkpoint=db.prepare('SELECT bot_key,offset FROM client_bot_checkpoint WHERE bot_key=?').all('palitra');
    const blockers=[];if(rows.client_bot_ack.length)blockers.push('WORKER_ACKS_EXIST');if(rows.client_bot_delivery.some(r=>['sending','uncertain'].includes(r.state)))blockers.push('WORKER_DELIVERY_INFLIGHT_OR_UNCERTAIN');if(rows.client_bot_delivery.some(r=>!['sent','sending','uncertain','failed'].includes(r.state)))blockers.push('WORKER_DELIVERY_STATE_UNREVIEWED');if(inbox.some(r=>r.state!=='done'&&r.count>0))blockers.push('WORKER_INBOX_NOT_PROVEN_IDLE');
    if(refs.length)for(const [t,cols]of Object.entries(columns))if(cols.some(c=>c.name==='job_id')){const n=db.prepare('SELECT COUNT(*) n FROM '+qi(t)+' WHERE job_id IN ('+list(refs)+')').get(...refs).n;if(n!==(rows[t]||[]).length)blockers.push('WORKER_JOB_SCOPE_UNRESOLVED:'+hash(t).slice(0,16));}
    for(const s of schema)if(s.type==='trigger'&&names.includes(s.tbl_name))blockers.push('WORKER_TARGET_TRIGGER:'+hash(s.name).slice(0,16));
    const project={delivery:[],ack:[]};for(const [name,t]of [['delivery','project_telegram_delivery'],['ack','project_telegram_ack']]){if(!tables.has(t)||!columns[t].some(c=>c.name==='job_id')){blockers.push('PROJECT_WORKER_SCHEMA_UNREVIEWED');continue;}project[name]=refs.length?db.prepare('SELECT * FROM '+qi(t)+' WHERE job_id IN ('+list(refs)+') LIMIT 10001').all(...refs):[];if(project[name].length>10000)fail('WORKER_PROJECT_ROWS_BOUNDED');}
    if(project.ack.length)blockers.push('PROJECT_WORKER_ACKS_EXIST');if(project.delivery.some(r=>!['sent','failed','uncertain'].includes(r.state)))blockers.push('PROJECT_WORKER_DELIVERY_NOT_SETTLED');
    const sequence=tables.has('sqlite_sequence')?db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all():db.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").get()?db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all():[];
    db.exec('COMMIT');return {schema:1,status:'RESET_FIXED7_WORKER_TARGET_JOB_PROJECTION',observedAtUtc:new Date().toISOString(),schemaInventory:{schema,columns,foreignKeys,sha256:hash(stable({schema,columns,foreignKeys}))},rows,project,sequence,inboxAggregate:inbox,checkpoint,blockers,checkpointChanged:false,workerLedgerWrites:0,atomicWithContent:false,inMemoryNetworkFlightProvenAbsent:false};
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
}

if(process.env.PALITRA_RESET_READONLY_NATIVE==='1'){
  try{
    if(!/^24\./.test(process.versions.node))fail('ACCEPTED_NODE24_REQUIRED');
    const {DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),kind=process.argv[1];
    if(!['content','worker'].includes(kind))fail('EXACT_COLLECTION_KIND_REQUIRED');
    const expected=kind==='content'?'/data/content.sqlite':'/data/chat.sqlite',path=process.env.DATABASE_PATH||expected;
    if(path!==expected||fs.realpathSync(path)!==expected||!fs.statSync(path).isFile())fail('EXACT_EXISTING_DATABASE_PATH_REQUIRED');
    const before=fs.statSync(path),db=new DatabaseSync(path,{readOnly:true});let out;
    try{out=kind==='content'?collect(db):collectWorker(db,JSON.parse(process.argv[2]||'[]'));}finally{db.close();}
    const after=fs.statSync(path);if(before.dev!==after.dev||before.ino!==after.ino)fail('DB_IDENTITY_CHANGED');out.database={path,device:after.dev,inode:after.ino,readOnly:true};const text=JSON.stringify(out);if(Buffer.byteLength(text)>32*1024*1024)fail('BOUNDED_SNAPSHOT_REQUIRED');process.stdout.write(text);
  }catch(e){process.stdout.write(JSON.stringify({status:'READONLY_COLLECTION_REFUSED',code:e.safeCode||'READONLY_QUERY_FAILED',messageSha256:hash(String(e.message))}));process.exitCode=2;}
}
module.exports={collect,collectWorker,IDS};
