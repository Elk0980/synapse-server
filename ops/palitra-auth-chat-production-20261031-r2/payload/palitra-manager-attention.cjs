'use strict';
const searchDigest=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');

// Read-only Palitra CRM projection. The host owns authentication and supplies its existing
// company permission check; this module deliberately has no schema or workflow initialiser.
const SITE = 'palitra';
const COMPANY = 'palitra-love';
const SCHEMA = 'palitra-manager-attention/v1';
const WORKFLOW_PREFIX = `${COMPANY}/order-workflow/orders/`;
const FOLLOWUP_PREFIX = `${COMPANY}/order-contact-followup/v1/`;
const STAGES = Object.freeze({ new: 'Новый заказ', agreement: 'Согласование', payment: 'Оплата', paid: 'Оплачен',
  preparing: 'Готовим заказ', waiting: 'Ожидает доставки/самовывоза', issued: 'Выдан', cancelled: 'Отказ' });
const LEGACY_STAGE = Object.freeze({ handover: 'waiting', feedback: 'waiting', done: 'issued' });
const FILTERS = Object.freeze(['all', 'attention', 'in_work', 'refused', 'completed']);

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}
function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(503, 'ATTENTION_SOURCE_DATE', 'Некорректная дата источника');
  return new Date(Date.parse(value)).toISOString();
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function positiveId(value) { return Number.isSafeInteger(value) && value > 0; }
function documentValue(row) {
  if (!row) return null;
  try { const value = JSON.parse(row.body); if (object(value) && value.schema === 1) return value; }
  catch (_) { /* Refuse to call corrupt saved state complete. */ }
  fail(503, 'ATTENTION_SOURCE_DOCUMENT', 'Некорректный сохранённый документ');
}
function parseQuery(query, current) {
  const input = query === undefined ? {} : query;
  if (!object(input) || Object.keys(input).some(key => !['filter', 'limit', 'cursor', 'search', 'view'].includes(key)))
    fail(400, 'ATTENTION_QUERY', 'Некорректный запрос');
  if(input.view!==undefined&&input.view!=='display-v3')fail(400,'ATTENTION_VIEW','Некорректное представление');
  const filter = input.filter === undefined ? 'attention' : input.filter;
  if (!FILTERS.includes(filter)) fail(400, 'ATTENTION_FILTER', 'Некорректный фильтр');
  if(input.search!==undefined&&(typeof input.search!=='string'||input.search.length>120||/[\x00-\x1f\x7f]/.test(input.search)))
    fail(400,'ATTENTION_SEARCH','Некорректный поиск');
  const search=(input.search||'').trim().normalize('NFKC').toLocaleLowerCase('ru-RU');
  const limit = input.limit === undefined ? 30 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (typeof input.limit === 'string' && !/^[1-9]\d{0,2}$/.test(input.limit)))
    fail(400, 'ATTENTION_LIMIT', 'Некорректный размер страницы');
  let after = null, asOf = new Date(current).toISOString();
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
      fail(400, 'ATTENTION_CURSOR', 'Некорректный курсор');
    try {
      const data = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if(input.view==='display-v3') {
        const shape=search?'asOf,basisAt,filter,key,priority,revision,scope,search,v,view':'asOf,basisAt,filter,key,priority,revision,scope,v,view';
        if(!object(data)||Object.keys(data).sort().join(',')!==shape||data.v!==4||data.view!=='display-v3'||data.scope!==COMPANY||data.filter!==filter||
          (search&&data.search!==searchDigest(search))||typeof data.revision!=='string'||!(/^[a-f0-9]{64}$/).test(data.revision)||
          typeof data.key!=='string'||!(/^(?:order|thread|legacy):[1-9]\d*$/).test(data.key)||(data.priority!==0&&data.priority!==1)||
          iso(data.asOf)!==data.asOf||iso(data.basisAt)!==data.basisAt||Date.parse(data.asOf)>current)throw new Error('cursor');
        asOf=data.asOf;after={priority:data.priority,basisAt:data.basisAt,key:data.key,revision:data.revision};
      } else {
      const shape=search?'asOf,basisAt,filter,key,priority,scope,search,v':'asOf,basisAt,filter,key,priority,scope,v';
      if (!object(data) || Object.keys(data).sort().join(',') !== shape ||
          data.v !== (search?2:1) || (search&&data.search!==searchDigest(search)) || data.scope !== COMPANY || data.filter !== filter ||
          typeof data.key !== 'string' || !/^(?:order|thread|legacy):[1-9]\d*$/.test(data.key) ||
          (data.priority !== 0 && data.priority !== 1) ||
          iso(data.asOf) !== data.asOf || iso(data.basisAt) !== data.basisAt ||
          Date.parse(data.asOf) > current) throw new Error('cursor');
      asOf = data.asOf; after = { priority: data.priority, basisAt: data.basisAt, key: data.key };
      }
    } catch (_) { fail(400, 'ATTENTION_CURSOR', 'Некорректный курсор'); }
  }
  return { filter, limit, after, asOf, search, display: input.view === 'display-v3' };
}
function cursorFor(filter, asOf, item,search='') {
  return Buffer.from(JSON.stringify({ v: search?2:1, scope: COMPANY, filter, asOf,...(search?{search:searchDigest(search)}:{}),
    priority: priority(item), basisAt: item.basisAt, key: item.key })).toString('base64url');
}
function priority(item) { return item.reason ? 0 : 1; }
function compare(a, b) { return priority(a) - priority(b) || a.basisAt.localeCompare(b.basisAt) || a.key.localeCompare(b.key); }
function canonicalStage(id) { return Object.hasOwn(LEGACY_STAGE, id) ? LEGACY_STAGE[id] : Object.hasOwn(STAGES, id) ? id : 'new'; }
function confirmationProofs(work, asOf) {
  const proved = { payment: false, handover: false };
  if (!work) return proved;
  const evidence = value => object(value) && object(value.actor) && positiveId(value.actor.id)
    && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) && Date.parse(value.at) <= Date.parse(asOf);
  for (const confirmation of work.confirmations) {
    if (!evidence(confirmation)) continue;
    const confirmedChannel = ['app', 'phone', 'telegram', 'whatsapp'].includes(confirmation.channel);
    if (confirmedChannel && confirmation.stageId === 'payment' && confirmation.requirement === 'payment_confirmed') proved.payment = true;
    if (confirmation.stageId === 'paid' && confirmation.entry?.paymentReceived === true) proved.payment = true;
    if (confirmedChannel && ['waiting', 'handover'].includes(confirmation.stageId) && confirmation.requirement === 'handover_confirmed') proved.handover = true;
    if (confirmation.stageId === 'issued' && confirmation.entry?.handedOver === true) proved.handover = true;
  }
  // Stage labels/status and a bare transition are not proof of payment or delivery.
  for (const event of Array.isArray(work.history) ? work.history : []) {
    if (!evidence(event) || !['advance', 'set-stage'].includes(event.action) || event.success === false) continue;
    if (event.nextStageId === 'paid' && event.confirmation?.paymentReceived === true) proved.payment = true;
    if (event.nextStageId === 'issued' && event.confirmation?.handedOver === true) proved.handover = true;
  }
  return proved;
}
function latestStage(work, nativeStatus, asOf) {
  const override = nativeStatus === 'cancelled' || work?.currentStageId === 'cancelled' ? 'cancelled' : nativeStatus === 'done' ? 'issued' : null;
  if (!work) return { workflowState: 'uninitialized', stage: null,
    terminal: Boolean(override), contactConfirmed: false, proofs: { payment: false, handover: false } };
  if (!Array.isArray(work.stages) || typeof work.currentStageId !== 'string' || !Array.isArray(work.confirmations))
    fail(503, 'ATTENTION_SOURCE_WORKFLOW', 'Некорректные этапы заявки');
  const current = work.stages.find(stage => stage && stage.id === work.currentStageId);
  // The current workflow keeps cancelled outside its seven normal stages.
  if (work.currentStageId !== 'cancelled' && (!current || typeof current.label !== 'string'))
    fail(503, 'ATTENTION_SOURCE_WORKFLOW', 'Текущий этап не найден');
  const id = override || canonicalStage(work.currentStageId);
  const transitions = Array.isArray(work.history) ? work.history.filter(h => h && typeof h.nextStageId === 'string'
    && canonicalStage(h.nextStageId) === id && ['advance','set-stage', 'human-dialogue'].includes(h.action)) : [];
  const at = transitions.length ? iso(transitions[transitions.length - 1].at) : null;
  return {
    workflowState: 'stored', stage: { id, label: STAGES[id], since: at },
    terminal: Boolean(override) || work.currentStageId === 'cancelled' || work.stages.at(-1)?.id === work.currentStageId,
    contactConfirmed: work.confirmations.some(c => c && c.requirement === 'contact_confirmed'),
    proofs: confirmationProofs(work, asOf),
  };
}
// PALITRA_ATTENTION_DISPLAY_V3_BEGIN: read-only display projection, never a canonical merge.
const DISPLAY_SCHEMA = 'palitra-manager-attention/display-v3';
function displayParts(item) { return item.display ? item.display.members : [item]; }
function displaySort(item) { return item.display ? item.display.sort : { priority: priority(item), basisAt: item.basisAt }; }
function displayCompare(a,b) { const x=displaySort(a),y=displaySort(b);return x.priority-y.priority||x.basisAt.localeCompare(y.basisAt)||a.key.localeCompare(b.key); }
function attentionCounts(items,display=false) {
  const c={total:items.length,attention:0,unanswered:0,firstContact:0,inWork:0,refused:0,completed:0};
  for(const item of items){const parts=display&&item.display?.attention?[item.display.attention]:display?displayParts(item):[item];
    if(parts.some(x=>x.reason))c.attention++;if(parts.some(x=>x.reason==='unanswered'))c.unanswered++;if(parts.some(x=>x.reason==='first-contact'))c.firstContact++;
    if(item.group==='in_work')c.inWork++;if(item.group==='refused')c.refused++;if(item.group==='completed')c.completed++;
  }return c;
}
function displayCards(db,entries,asOf,accountOrigins) {
  const byKey=new Map(entries.map(x=>[x.key,x]));
  // Each snapshot has three SQL executions, independent of the number of scoped threads.
  // Future members are part of the direct-set witness even when canonical rows use cursor.asOf.
  const currentThreads=db.prepare('SELECT id,order_id,created_at FROM chat_threads WHERE site=? AND company_code=? ORDER BY id');
  // CROSS JOIN fixes the grant table as the outer scan; no per-thread lookup on PK(session_id,thread_id).
  const currentGrants=db.prepare(`SELECT g.thread_id,g.session_id,s.site AS session_site,s.company_code AS session_company,s.scope AS session_scope,
      s.origin AS session_origin,s.account_kind,s.account_user_id,b.account_user_id AS verified_account FROM chat_web_grants g CROSS JOIN chat_threads t
    LEFT JOIN chat_web_sessions s ON s.id=g.session_id LEFT JOIN chat_web_account_bindings b ON b.session_id=s.id WHERE t.id=g.thread_id AND t.site=? AND t.company_code=? ORDER BY g.thread_id,g.session_id`);
  // Existing documents(key,version DESC) index supplies the latest witness; this code creates no index/schema.
  const currentWorkflow=db.prepare(`SELECT t.id AS thread_id,d.version,d.created_at,d.body FROM chat_threads t
    JOIN documents d ON d.rowid=(SELECT w.rowid FROM documents w WHERE w.key=?||t.id ORDER BY w.version DESC LIMIT 1)
    WHERE t.site=? AND t.company_code=? AND t.order_id IS NULL AND t.created_at<=? ORDER BY t.id`);
  const readWitness=()=>{
    const allThreads=currentThreads.all(SITE,COMPANY),allGrants=currentGrants.all(SITE,COMPANY);
    const workflows=currentWorkflow.all(`${COMPANY}/order-workflow/threads/`,SITE,COMPANY,asOf)
      .map(row=>[row.thread_id,[row.version,row.created_at,searchDigest(row.body)]]);
    return {allThreads,allGrants,workflows};
  };
  const witness=readWitness(),threads=witness.allThreads.filter(x=>x.created_at<=asOf);
  const rows=new Map(threads.map(x=>[x.id,x])),allRows=new Map(witness.allThreads.map(x=>[x.id,x]));
  const principal = grant => {
    const bound = grant.session_site === SITE && grant.session_company === COMPANY && grant.session_scope === 'customer_chat';
    if (bound && grant.verified_account === grant.account_user_id && grant.account_kind === 'user' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(grant.account_user_id || '')
      && accountOrigins.includes(grant.session_origin)) return 'account:' + grant.account_user_id;
    // Unconfirmed/unknown identity never joins another session, even with matching contacts.
    return 'session:' + grant.session_id;
  };
  const grantMap=new Map(threads.map(x=>[x.id,new Set()])),directMap=new Map(),sessionRepresentatives=new Map();
  for(const grant of witness.allGrants){
    if(!allRows.has(grant.thread_id))fail(409,'ATTENTION_DISPLAY_CHANGED','Состав списка изменился. Обновите его с начала.');
    const owner=principal(grant);
    if(grantMap.has(grant.thread_id))grantMap.get(grant.thread_id).add(owner);
    if(!directMap.has(owner))directMap.set(owner,new Map());
    directMap.get(owner).set(grant.thread_id,allRows.get(grant.thread_id));
    sessionRepresentatives.set(owner,Math.min(sessionRepresentatives.get(owner) ?? Infinity,grant.session_id));
  }
  for (const [id,owners] of grantMap) grantMap.set(id,[...owners]);
  const groups=new Map();
  // A case is a display of an already shared, closed direct grant set. No phone/name joins.
  // Ambiguous, overlapping, future, orphan or >100-thread sets remain separate canonical rows.
  for(const row of threads){const own=grantMap.get(row.id);if(own.length!==1)continue;
    const members=[...(directMap.get(own[0])?.values()||[])].sort((a,b)=>a.id-b.id);
    if(members.length<2||members.length>100||members.some(x=>!rows.has(x.id)||grantMap.get(x.id).length!==1||grantMap.get(x.id)[0]!==own[0]))continue;
    const keys=members.map(x=>x.order_id===null?'thread:'+x.id:'order:'+x.order_id);
    if(new Set(keys).size!==members.length)continue;
    const parts=keys.map(key=>byKey.get(key));
    if(parts.some((item,i)=>!item||item.threadRefs.length!==1||item.threadRef!=='thread:'+members[i].id||
      (members[i].order_id===null?(item.kind!=='web-thread'||item.orderRef!==null):
        (!positiveId(members[i].order_id)||item.kind!=='order'||item.orderRef!=='native-order:'+members[i].order_id))))continue;
    // Case filter: active if any member is active; otherwise completed if any completed, else refused.
    // Every canonical stage/status/completion proof remains on its original member.
    const rank={in_work:0,completed:1,refused:2};
    const representatives=[...parts].sort((a,b)=>rank[a.group]-rank[b.group]||Number(!a.orderRef)-Number(!b.orderRef)||a.key.localeCompare(b.key));
    const parent=representatives[0];
    const signature=JSON.stringify([SITE,COMPANY,own[0],members.map(x=>x.id)]),key='conversation-display:'+searchDigest(signature);
    groups.set(key,{key,sessionId:sessionRepresentatives.get(own[0]),threadIds:members.map(x=>x.id),parent:parent.key,keys:[parent.key,...keys.filter(k=>k!==parent.key).sort()]});
  }
  const readLegacyCaseNotifications=()=>{
    const requested=[];
    for(const group of [...groups.values()].sort((a,b)=>a.key.localeCompare(b.key)))for(const key of group.keys){
      for(const ref of byKey.get(key).dialogRefs)requested.push([group.sessionId,Number(ref.slice('legacy:'.length))]);
    }
    if(!requested.length)return [];
    const values=requested.map(()=>'(?,?)').join(',');
    return db.prepare(`WITH requested(session_id,dialog_id) AS (VALUES ${values}),
      human AS (SELECT q.dialog_id,MAX(m.id) AS message_id FROM requested q
        JOIN client_dialogs d ON d.id=q.dialog_id JOIN client_dialog_messages m ON m.dialog_id=d.id
        WHERE d.company_code=? AND m.company_code=d.company_code AND m.bot_key=d.bot_key AND m.created_at<=?
        AND m.direction='out' AND m.author_type='operator' AND m.delivery_status='sent' GROUP BY q.dialog_id),
      pending AS (SELECT q.dialog_id,MIN(m.id) AS message_id FROM requested q
        JOIN client_dialogs d ON d.id=q.dialog_id JOIN client_dialog_messages m ON m.dialog_id=d.id
        LEFT JOIN human h ON h.dialog_id=q.dialog_id
        WHERE d.company_code=? AND m.company_code=d.company_code AND m.bot_key=d.bot_key AND m.created_at<=?
        AND m.direction='in' AND m.author_type='client' AND m.id>COALESCE(h.message_id,0) GROUP BY q.dialog_id)
      SELECT q.session_id,q.dialog_id,h.message_id AS human_id,hm.created_at AS human_at,
        p.message_id AS pending_id,pm.created_at AS pending_at FROM requested q
      LEFT JOIN human h ON h.dialog_id=q.dialog_id LEFT JOIN client_dialog_messages hm ON hm.id=h.message_id AND hm.dialog_id=q.dialog_id
      LEFT JOIN pending p ON p.dialog_id=q.dialog_id LEFT JOIN client_dialog_messages pm ON pm.id=p.message_id AND pm.dialog_id=q.dialog_id
      ORDER BY q.session_id,q.dialog_id`).all(...requested.flat(),COMPANY,asOf,COMPANY,asOf);
  };

  const readCaseNotifications=()=>{
    const ordered=[...groups.values()].sort((a,b)=>a.key.localeCompare(b.key));
    if(!ordered.length)return [];
    // Only closed, unambiguous direct sets approved above enter this batched read.
    // One SQL statement per witness, independent of the number of customer cases.
    const approved=ordered.flatMap(group=>group.threadIds.map(id=>[group.sessionId,id]));
    const values=approved.map(()=>'(?,?)').join(',');
    const rows=db.prepare(`WITH approved_members(session_id,thread_id) AS (VALUES ${values}),
      approved_sessions AS (SELECT DISTINCT session_id FROM approved_members),
      human AS (SELECT a.session_id,MAX(m.id) AS message_id FROM approved_members a
        JOIN chat_threads t ON t.id=a.thread_id
        JOIN chat_thread_messages m ON m.thread_id=t.id
        LEFT JOIN chat_message_deliveries d ON d.message_id=m.id AND d.channel='customer_telegram'
        WHERE t.site=? AND t.company_code=? AND m.created_at<=?
        AND m.direction='out' AND (m.author_kind='owner' OR (m.author_kind='manager' AND m.source_channel='manager_telegram'))
        AND (d.id IS NULL OR (d.status='sent' AND d.updated_at<=?)) GROUP BY a.session_id),
      pending AS (SELECT a.session_id,MIN(m.id) AS message_id FROM approved_members a
        JOIN chat_threads t ON t.id=a.thread_id
        JOIN chat_thread_messages m ON m.thread_id=t.id
        LEFT JOIN human h ON h.session_id=a.session_id
        WHERE t.site=? AND t.company_code=? AND m.created_at<=? AND m.id>COALESCE(h.message_id,0)
        AND m.direction='in' AND m.author_kind='customer'
        AND NOT EXISTS (SELECT 1 FROM chat_thread_requests r WHERE r.message_id=m.id AND r.thread_id=m.thread_id
          AND r.actor_kind='web' AND r.actor_ref='session:' || m.web_session_id
          AND r.request_id='checkout-order:' || t.order_id) GROUP BY a.session_id)
      SELECT a.session_id,h.message_id AS human_id,hm.thread_id AS human_thread,hm.created_at AS human_at,
        p.message_id AS pending_id,pm.thread_id AS pending_thread,pm.created_at AS pending_at
      FROM approved_sessions a LEFT JOIN human h ON h.session_id=a.session_id
      LEFT JOIN chat_thread_messages hm ON hm.id=h.message_id
      LEFT JOIN pending p ON p.session_id=a.session_id
      LEFT JOIN chat_thread_messages pm ON pm.id=p.message_id ORDER BY a.session_id`)
      .all(...approved.flat(),SITE,COMPANY,asOf,asOf,SITE,COMPANY,asOf);
    const bySession=new Map(rows.map(row=>[row.session_id,row])),legacyRows=readLegacyCaseNotifications();
    return ordered.map(group=>{const row=bySession.get(group.sessionId);
      if(!row)fail(409,'ATTENTION_DISPLAY_CHANGED','Состав списка изменился. Обновите его с начала.');
      const webHuman=row.human_id===null?null:{id:row.human_id,thread_id:row.human_thread,created_at:row.human_at};
      const webPending=row.pending_id===null?null:{id:row.pending_id,ref:'thread:'+row.pending_thread,created_at:row.pending_at};
      const legacy=legacyRows.filter(value=>value.session_id===group.sessionId).map(value=>({dialogId:value.dialog_id,
        human:value.human_id===null?null:{id:value.human_id,ref:'legacy:'+value.dialog_id,created_at:value.human_at},
        pending:value.pending_id===null?null:{id:value.pending_id,ref:'legacy:'+value.dialog_id,created_at:value.pending_at}}));
      // A website reply cannot clear a separate legacy channel's unanswered customer message.
      const pending=[webPending,...legacy.map(value=>value.pending)].filter(Boolean).sort((a,b)=>iso(a.created_at).localeCompare(iso(b.created_at))||a.ref.localeCompare(b.ref)||a.id-b.id)[0]||null;
      const human=webHuman||legacy.find(value=>value.human)?.human||null;
      return [group.key,{human,pending,web:{human:webHuman,pending:webPending},legacy}];
    });
  };
  const notificationWitness=readCaseNotifications(),caseNotifications=new Map(notificationWitness);
  const attentionFor=(group,members,parent)=>{
    if(!group)return {reason:parent.reason,basisAt:parent.basisAt,attentionRef:parent.attentionRef,ageSeconds:parent.ageSeconds};
    const proof=caseNotifications.get(group.key),first=[...members].filter(x=>x.reason==='first-contact').sort(compare)[0];
    const reason=proof.pending?'unanswered':!proof.human&&first?'first-contact':null;
    const basisAt=proof.pending?iso(proof.pending.created_at):reason?first.basisAt:parent.basisAt;
    return {reason,basisAt,attentionRef:proof.pending?proof.pending.ref:reason?first.attentionRef:null,
      ageSeconds:Math.max(0,Math.floor((Date.parse(asOf)-Date.parse(basisAt))/1000))};
  };

  const membership=new Map();for(const group of groups.values())for(const key of group.keys){if(membership.has(key)&&membership.get(key).key!==group.key)fail(503,'ATTENTION_DISPLAY_AMBIGUOUS','Не удалось проверить связь переписок');membership.set(key,group);}
  const emitted=new Set(),cards=[];
  for(const entry of entries){const group=membership.get(entry.key);if(group&&emitted.has(group.key))continue;if(group)emitted.add(group.key);
    const parent=group?byKey.get(group.parent):entry,members=(group?group.keys.map(key=>byKey.get(key)):[entry]).map(x=>({...x}));
    const attention=attentionFor(group,members,parent);
    cards.push({...parent,display:{schema:'palitra-attention-display/v3',groupKey:group?group.key:parent.key,representativeKey:parent.key,
      basis:group?'direct-grant-set':'canonical',sort:{priority:attention.reason?0:1,basisAt:attention.basisAt},attention,members}});
  }
  // Compare full current direct-set membership, including rows newer than cursor.asOf.
  if(JSON.stringify(witness)!==JSON.stringify(readWitness())||JSON.stringify(notificationWitness)!==JSON.stringify(readCaseNotifications()))fail(409,'ATTENTION_DISPLAY_CHANGED','Состав списка изменился. Обновите его с начала.');
  const revision=searchDigest(JSON.stringify([DISPLAY_SCHEMA,asOf,entries,witness,notificationWitness]));
  return{cards,revision};
}

function cursorForDisplay(query,item,revision){const sort=displaySort(item);return Buffer.from(JSON.stringify({v:4,view:'display-v3',scope:COMPANY,filter:query.filter,asOf:query.asOf,
  ...(query.search?{search:searchDigest(query.search)}:{}),revision,priority:sort.priority,basisAt:sort.basisAt,key:item.key})).toString('base64url');}
function readDisplay(db,entries,query,sessionUser,canAccess,accountOrigins){
  const {cards,revision}=displayCards(db,entries,query.asOf,accountOrigins);
  if(query.after&&query.after.revision!==revision)fail(409,'ATTENTION_DISPLAY_CHANGED','Состав списка изменился. Обновите его с начала.');
  const counts=attentionCounts(cards,true),canonicalCounts=attentionCounts(entries);
  const grouped=query.filter==='attention'?cards.filter(x=>x.display.attention.reason):query.filter==='all'?cards:cards.filter(x=>x.group===query.filter);
  const numeric=/^(?:№|#|no)?\s*([1-9]\d{0,14})$/.exec(query.search);
  const filtered=query.search?grouped.filter(item=>displayParts(item).some(x=>String(x.customerLabel).normalize('NFKC').toLocaleLowerCase('ru-RU').includes(query.search)||(numeric&&x.orderRef===`native-order:${numeric[1]}`))):grouped;
  filtered.sort(displayCompare);const remaining=query.after?filtered.filter(item=>displayCompare(item,{...query.after,reason:query.after.priority===0?'cursor':null})>0):filtered;
  const items=remaining.slice(0,query.limit);if(canAccess(sessionUser,'crm.view')!==true)fail(403,'ATTENTION_ACCESS','Доступ изменился');
  return{schema:DISPLAY_SCHEMA,companyCode:COMPANY,scopeKey:SITE,filter:query.filter,asOf:query.asOf,partial:false,sourceRevision:revision,
    canonicalCounts,counts,items,nextCursor:remaining.length>items.length?cursorForDisplay(query,items.at(-1),revision):null};
}
// PALITRA_ATTENTION_DISPLAY_V3_END

function createManagerAttention({ db, orders, workflow, canAccess, now = Date.now, accountOrigins = [] } = {}) {
  if (!Array.isArray(accountOrigins) || accountOrigins.some(origin => {
    try { const url = new URL(origin); return url.protocol !== 'https:' || url.origin !== origin; } catch (_) { return true; }
  })) throw new TypeError('createManagerAttention: неверные адреса аккаунтов');
  accountOrigins = Object.freeze([...new Set(accountOrigins)]);
  if (!db || typeof db.prepare !== 'function' || typeof canAccess !== 'function' || typeof now !== 'function')
    throw new TypeError('Existing read-only CRM host required');
  // `orders` and `workflow` are intentionally not called: some workflow reads initialise old documents.
  void orders; void workflow;
  const listOrders = db.prepare(`SELECT o.id,o.name,o.created_at,w.status AS work_status
    FROM site_orders o LEFT JOIN site_order_work w ON w.order_id=o.id
    WHERE o.site=? AND o.company_code=? AND o.created_at<=? ORDER BY o.id`);
  const listWeb = db.prepare(`SELECT id,order_id,created_at,last_message_at FROM chat_threads
    WHERE site=? AND company_code=? AND created_at<=? ORDER BY id`);
  const listLegacy = db.prepare(`SELECT id,order_id,display_name,created_at,last_message_at FROM client_dialogs
    WHERE company_code=? AND created_at<=? ORDER BY id`);
  const webCustomer = db.prepare(`SELECT m.id,m.created_at FROM chat_thread_messages m
    JOIN chat_threads t ON t.id=m.thread_id
    WHERE m.thread_id=? AND t.site=? AND t.company_code=? AND m.created_at<=? AND m.id>?
      AND m.direction='in' AND m.author_kind='customer'
      AND NOT EXISTS (SELECT 1 FROM chat_thread_requests r WHERE r.message_id=m.id AND r.thread_id=m.thread_id
        AND r.actor_kind='web' AND r.actor_ref='session:' || m.web_session_id
        AND r.request_id='checkout-order:' || t.order_id)
    ORDER BY m.id ASC LIMIT 1`);
  const lastWebHuman = db.prepare(`SELECT m.id,m.created_at FROM chat_thread_messages m
    JOIN chat_threads t ON t.id=m.thread_id
    LEFT JOIN chat_message_deliveries d ON d.message_id=m.id AND d.channel='customer_telegram'
    WHERE m.thread_id=? AND t.site=? AND t.company_code=? AND m.created_at<=?
      AND m.direction='out' AND (m.author_kind='owner' OR (m.author_kind='manager' AND m.source_channel='manager_telegram'))
      AND (d.id IS NULL OR (d.status='sent' AND d.updated_at<=?))
    ORDER BY m.id DESC LIMIT 1`);
  const legacyCustomer = db.prepare(`SELECT m.id,m.created_at FROM client_dialog_messages m
    JOIN client_dialogs d ON d.id=m.dialog_id
    WHERE m.dialog_id=? AND d.company_code=? AND m.company_code=d.company_code AND m.bot_key=d.bot_key
      AND m.created_at<=? AND m.id>? AND m.direction='in' AND m.author_type='client'
    ORDER BY m.id ASC LIMIT 1`);
  const lastLegacyHuman = db.prepare(`SELECT m.id,m.created_at FROM client_dialog_messages m
    JOIN client_dialogs d ON d.id=m.dialog_id
    WHERE m.dialog_id=? AND d.company_code=? AND m.company_code=d.company_code AND m.bot_key=d.bot_key
      AND m.created_at<=? AND m.direction='out' AND m.author_type='operator' AND m.delivery_status='sent'
    ORDER BY m.id DESC LIMIT 1`);
  const latestDocument = db.prepare('SELECT body FROM documents WHERE key=? AND created_at<=? ORDER BY version DESC LIMIT 1');

  function read(sessionUser, rawQuery = {}) {
    if (canAccess(sessionUser, 'crm.view') !== true) fail(403, 'ATTENTION_ACCESS', 'Нет доступа к заявкам Palitra Love');
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0) fail(503, 'ATTENTION_CLOCK', 'Некорректное время сервера');
    const query = parseQuery(rawQuery, current);
    const orderMap = new Map();
    for (const row of listOrders.all(SITE, COMPANY, query.asOf)) {
      const createdAt = iso(row.created_at);
      const linked=db.prepare('SELECT id FROM chat_threads WHERE order_id=? AND site=? AND company_code=? LIMIT 2').all(row.id,SITE,COMPANY);
      const work = documentValue(latestDocument.get(WORKFLOW_PREFIX + row.id, query.asOf)) || (linked.length===1 ? documentValue(latestDocument.get(`${COMPANY}/order-workflow/threads/${linked[0].id}`,query.asOf)) : null);
      const wf = latestStage(work, row.work_status, query.asOf);
      const closed = row.work_status === 'done' || row.work_status === 'cancelled' || wf.terminal;
      const refused = row.work_status === 'cancelled' || wf.stage?.id === 'cancelled';
      const claimedCompletion = row.work_status === 'done' || wf.stage?.id === 'issued';
      const completed = !refused && claimedCompletion && wf.proofs.payment && wf.proofs.handover;
      const group = refused ? 'refused' : completed ? 'completed' : 'in_work';
      orderMap.set(row.id, {
        key: `order:${row.id}`, kind: 'order', orderRef: `native-order:${row.id}`, threadRef: null, dialogRef: null,
        threadRefs: [], dialogRefs: [], attentionRef: null,
        customerLabel: String(row.name || '').slice(0, 100), reason: null, basisAt: wf.stage?.since || createdAt,
        dueAt: null, deadlineKind: null, workflowState: wf.workflowState, stage: wf.stage,
        nativeStage: wf.workflowState !== 'uninitialized' ? null : row.work_status === 'done' ? { id: 'issued', label: STAGES.issued, since: null }
          : row.work_status === 'cancelled' ? { id: 'cancelled', label: STAGES.cancelled, since: null } : null,
        group, completionPending: !refused && claimedCompletion && !completed,
        _closed: closed, _createdAt: createdAt, _contactConfirmed: wf.contactConfirmed, _customerSeen: false, _humanSeen: false,
        _pendingInbound: [], _lastActivity: createdAt,
      });
    }
    const loose = [];
    function addConversation({ id, orderId, kind, createdAt, lastActivity, label, firstCustomer, pendingCustomer, human }) {
      // A legacy conversation can outlive an old/missing order. Retain it without an
      // order reference; never dereference or expose an inconsistent foreign order.
      const linked = orderMap.has(orderId);
      const entry = linked ? orderMap.get(orderId) : {
        key: `${kind}:${id}`, kind: kind === 'thread' ? 'web-thread' : 'legacy-dialog',
        orderRef: null, threadRef: null, dialogRef: null, customerLabel: label,
        threadRefs: [], dialogRefs: [], attentionRef: null,
        reason: null, basisAt: createdAt, dueAt: null, deadlineKind: null,
        workflowState: 'uninitialized', stage: null, _createdAt: createdAt,
        nativeStage: null,
        group: 'in_work', completionPending: false,
        _contactConfirmed: false, _customerSeen: false, _humanSeen: false,
        _pendingInbound: [], _lastActivity: createdAt,
      };
      if (!linked && kind==='thread') {
        const saved = documentValue(latestDocument.get(`${COMPANY}/order-workflow/threads/${id}`,query.asOf));
        const work = saved || {currentStageId:firstCustomer && human ? 'agreement' : 'new',stages:Object.keys(STAGES).filter(id=>id!=='cancelled').map(id=>({id,label:STAGES[id]})),confirmations:[],history:[]};
        const wf = latestStage(work,null,query.asOf), refused=wf.stage?.id==='cancelled', issued=wf.stage?.id==='issued';
        Object.assign(entry,{workflowState:wf.workflowState,stage:wf.stage,_closed:wf.terminal,_contactConfirmed:wf.contactConfirmed,
          group:refused?'refused':issued && wf.proofs.payment && wf.proofs.handover?'completed':'in_work',completionPending:!refused && issued && !(wf.proofs.payment && wf.proofs.handover)});
      }
      const ref = `${kind}:${id}`;
      if (kind === 'thread') {
        entry.threadRefs.push(ref); if (!entry.threadRef) entry.threadRef = ref;
      } else {
        entry.dialogRefs.push(ref); if (!entry.dialogRef) entry.dialogRef = ref;
      }
      if (!entry.customerLabel && label) entry.customerLabel = label;
      if (firstCustomer) entry._customerSeen = true;
      if (pendingCustomer) entry._pendingInbound.push({ at: iso(pendingCustomer.created_at), ref });
      if (human) entry._humanSeen = true;
      const savedActivity = lastActivity ? iso(lastActivity) : createdAt;
      const activity = savedActivity <= query.asOf ? savedActivity : createdAt;
      if (activity > entry._lastActivity) entry._lastActivity = activity;
      if (!linked) loose.push(entry);
    }
    for (const row of listWeb.all(SITE, COMPANY, query.asOf)) {
      const createdAt = iso(row.created_at);
      const human = lastWebHuman.get(row.id, SITE, COMPANY, query.asOf, query.asOf);
      addConversation({ id: row.id, orderId: row.order_id, kind: 'thread', createdAt,
        lastActivity: row.last_message_at, label: '',
        firstCustomer: webCustomer.get(row.id, SITE, COMPANY, query.asOf, 0),
        pendingCustomer: webCustomer.get(row.id, SITE, COMPANY, query.asOf, human?.id || 0), human });
    }
    for (const row of listLegacy.all(COMPANY, query.asOf)) {
      const createdAt = iso(row.created_at);
      const human = lastLegacyHuman.get(row.id, COMPANY, query.asOf);
      addConversation({ id: row.id, orderId: row.order_id, kind: 'legacy', createdAt,
        lastActivity: row.last_message_at, label: String(row.display_name || '').slice(0, 100),
        firstCustomer: legacyCustomer.get(row.id, COMPANY, query.asOf, 0),
        pendingCustomer: legacyCustomer.get(row.id, COMPANY, query.asOf, human?.id || 0), human });
    }
    // All/group views retain closed orders. The old attention filter still receives
    // the same actionable reasons, including a new inbound on a closed conversation.
    const entries = [...orderMap.values(), ...loose];
    for (const entry of entries) {
      if (entry._pendingInbound.length) {
        const first = entry._pendingInbound.sort((a, b) => a.at.localeCompare(b.at) || a.ref.localeCompare(b.ref))[0];
        entry.reason = 'unanswered'; entry.basisAt = first.at; entry.attentionRef = first.ref;
      } else if (!entry._closed && entry.orderRef && !entry._customerSeen && !entry._humanSeen && !entry._contactConfirmed) {
        entry.reason = 'first-contact'; entry.basisAt = entry._createdAt;
        const event = documentValue(latestDocument.get(FOLLOWUP_PREFIX + entry.orderRef.slice('native-order:'.length), query.asOf));
        if (event && event.site === SITE && event.companyCode === COMPANY &&
            event.orderId === Number(entry.orderRef.slice('native-order:'.length)) &&
            entry.threadRefs.includes(`thread:${event.threadId}`) && ['waiting', 'emitted'].includes(event.state) &&
            typeof event.dueAt === 'string') {
          entry.dueAt = iso(event.dueAt); entry.deadlineKind = 'customer-first-reply';
        }
      } else if (!entry.orderRef) entry.basisAt = entry._lastActivity;
      entry.ageSeconds = Math.max(0, Math.floor((Date.parse(query.asOf) - Date.parse(entry.basisAt)) / 1000));
      delete entry._closed; delete entry._createdAt; delete entry._contactConfirmed; delete entry._customerSeen;
      delete entry._humanSeen; delete entry._pendingInbound; delete entry._lastActivity;
    }
    if(query.display)return readDisplay(db,entries,query,sessionUser,canAccess,accountOrigins);
    const counts = { total: entries.length, attention: 0, unanswered: 0, firstContact: 0, inWork: 0, refused: 0, completed: 0 };
    for (const item of entries) {
      if (item.reason) counts.attention++;
      if (item.reason === 'unanswered') counts.unanswered++;
      if (item.reason === 'first-contact') counts.firstContact++;
      if (item.group === 'in_work') counts.inWork++;
      if (item.group === 'refused') counts.refused++;
      if (item.group === 'completed') counts.completed++;
    }
    const grouped = query.filter === 'attention' ? entries.filter(item => item.reason)
      : query.filter === 'all' ? entries : entries.filter(item => item.group === query.filter);
    // Search the whole authorized projection before pagination, never just the currently loaded cards.
    const numeric=/^(?:№|#|no)?\s*([1-9]\d{0,14})$/.exec(query.search);
    const filtered=query.search?grouped.filter(item=>String(item.customerLabel).normalize('NFKC').toLocaleLowerCase('ru-RU').includes(query.search)||
      (numeric&&item.orderRef===`native-order:${numeric[1]}`)):grouped;
    filtered.sort(compare);
    const remaining = query.after ? filtered.filter(item => compare(item, { ...query.after, reason: query.after.priority === 0 ? 'cursor' : null }) > 0) : filtered;
    const items = remaining.slice(0, query.limit);
    if (canAccess(sessionUser, 'crm.view') !== true) fail(403, 'ATTENTION_ACCESS', 'Доступ изменился');
    return { schema: SCHEMA, companyCode: COMPANY, scopeKey: SITE, filter: query.filter,
      asOf: query.asOf, partial: false, counts, items,
      nextCursor: remaining.length > items.length ? cursorFor(query.filter, query.asOf, items.at(-1),query.search) : null };
  }
  return Object.freeze({ read });
}

module.exports = { createManagerAttention };
