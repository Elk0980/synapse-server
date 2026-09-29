'use strict';
const {createHash}=require('node:crypto');
const {company,fail,object,text,revision,utcDate}=require('./company-information');

// Записи о состоявшихся платежах, не платёжный исполнитель. Старые sale_amount
// и покупки из истории визитов не прибавляются к этому журналу повторно.
function createStudioCommerce(db,{now=Date.now}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_commerce_events (
    id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL REFERENCES companies(id),lead_id INTEGER NOT NULL REFERENCES leads(id),
    kind TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,data TEXT NOT NULL,actor_id INTEGER,created_at TEXT NOT NULL,
    UNIQUE(company_id,request_id));
    CREATE INDEX IF NOT EXISTS studio_commerce_lead ON studio_commerce_events(company_id,lead_id,id);
    CREATE TABLE IF NOT EXISTS studio_payment_references (
      company_id INTEGER NOT NULL REFERENCES companies(id),reference TEXT NOT NULL,event_id INTEGER NOT NULL REFERENCES studio_commerce_events(id),
      PRIMARY KEY(company_id,reference));`);
  function scope(code,id){
    const owner=company(db,code);
    if(!Number.isSafeInteger(Number(id))||Number(id)<1)fail(404,'Заявка не найдена');
    const lead=db.prepare('SELECT id,created_at FROM leads WHERE id=? AND company_code=? COLLATE NOCASE').get(Number(id),owner.code);
    if(!lead)fail(404,'Заявка не найдена');return {owner,lead};
  }
  const events=(owner,lead)=>db.prepare('SELECT id,kind,data,actor_id actorId,created_at createdAt FROM studio_commerce_events WHERE company_id=? AND lead_id=? ORDER BY id')
    .all(owner.id,lead.id).map(row=>({...row,data:JSON.parse(row.data)}));
  function publications(owner){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autoposting_posts'").get())return [];
    return db.prepare(`SELECT p.id,p.title FROM autoposting_posts p WHERE p.company_id=? AND
      (p.status='published' OR EXISTS(SELECT 1 FROM autoposting_publication_receipts r WHERE r.post_id=p.id)) ORDER BY p.id DESC LIMIT 200`).all(owner.id);
  }
  function get(code,id){
    const {owner,lead}=scope(code,id),history=events(owner,lead),voided=new Set(history.filter(row=>row.kind==='void').map(row=>row.data.paymentId)),payments=history.filter(row=>row.kind==='payment'&&!voided.has(row.id)),totals=new Map();
    for(const row of payments){const p=row.data;if(!totals.has(p.currency))totals.set(p.currency,{currency:p.currency,receivedCents:0,refundedCents:0,netCents:0});
      const total=totals.get(p.currency);total[p.type==='received'?'receivedCents':'refundedCents']+=p.amountCents;total.netCents=total.receivedCents-total.refundedCents;}
    return {companyCode:owner.code.toLowerCase(),leadId:lead.id,revision:history.length,
      publication:history.filter(row=>row.kind==='publication').at(-1)?.data||null,payments,totals:[...totals.values()],history,publications:publications(owner),
      basis:'Только записи этого журнала с основанием. Старые суммы сделки и абонементов не прибавлены. Это ручной учёт, не банковская сверка.'};
  }
  function write(code,id,kind,body,actorId,normalize){
    object(body,kind==='void'?['revision','requestId','paymentId','evidence']:kind==='publication'?['revision','requestId','postId','evidence']:['revision','requestId','type','amount','currency','reference','evidence','occurredAt','refundOf']);
    revision(body.revision);const requestId=text(body.requestId,100,true);
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))fail(400,'Нужен уникальный номер изменения');
    const {revision:unused,...request}=body;
    const hash=createHash('sha256').update(JSON.stringify({leadId:Number(id),kind,request:Object.fromEntries(Object.entries(request).sort(([a],[b])=>a.localeCompare(b)))})).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try{
      const {owner,lead}=scope(code,id);
      const old=db.prepare('SELECT request_hash FROM studio_commerce_events WHERE company_id=? AND request_id=?').get(owner.id,requestId);
      if(old){if(old.request_hash!==hash)fail(409,'Номер изменения уже использован с другими данными');const result=get(code,id);db.exec('COMMIT');return result;}
      const current=get(code,id);if(current.revision!==body.revision)fail(409,'История изменилась. Обновите карточку.');
      const data=normalize({owner,lead,current});
      const eventId=Number(db.prepare('INSERT INTO studio_commerce_events(company_id,lead_id,kind,request_id,request_hash,data,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(owner.id,lead.id,kind,requestId,hash,JSON.stringify(data),actorId??null,new Date(now()).toISOString()).lastInsertRowid);
      if(kind==='payment')db.prepare('INSERT INTO studio_payment_references(company_id,reference,event_id) VALUES(?,?,?)').run(owner.id,data.reference,eventId);
      if(kind==='void')db.prepare('DELETE FROM studio_payment_references WHERE company_id=? AND event_id=?').run(owner.id,data.paymentId);
      const result=get(code,id);db.exec('COMMIT');return result;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function publication(code,id,body,actorId){return write(code,id,'publication',body,actorId,({owner})=>{
    const evidence=text(body.evidence,1000,true);
    if(body.postId===null)return {postId:null,title:null,evidence};
    if(!Number.isSafeInteger(body.postId)||body.postId<1)fail(400,'Выберите публикацию');
    const post=db.prepare('SELECT id,title,status FROM autoposting_posts WHERE id=? AND company_id=?').get(body.postId,owner.id);
    if(!post)fail(404,'Публикация этой компании не найдена');
    const receipt=db.prepare('SELECT id FROM autoposting_publication_receipts WHERE post_id=? LIMIT 1').get(post.id);
    if(post.status!=='published'&&!receipt)fail(409,'Публикация ещё не подтверждена');
    return {postId:post.id,title:post.title,evidence};
  });}
  function payment(code,id,body,actorId){return write(code,id,'payment',body,actorId,({owner,lead,current})=>{
    if(!['received','refund'].includes(body.type))fail(400,'Выберите оплату или возврат');
    if(typeof body.amount!=='number'||!Number.isFinite(body.amount)||body.amount<=0||body.amount>100000000||Math.abs(body.amount*100-Math.round(body.amount*100))>0.000001)
      fail(400,'Укажите сумму с точностью до сотых');
    if(typeof body.currency!=='string'||!/^[A-Z]{3}$/.test(body.currency))fail(400,'Укажите трёхбуквенный код валюты');
    const reference=text(body.reference,200,true),evidence=text(body.evidence,1000,true),occurredAt=utcDate(body.occurredAt);
    if(occurredAt!==body.occurredAt.replace(/Z$/,body.occurredAt.includes('.')?'Z':'.000Z'))fail(400,'Несуществующая дата платежа');
    if(Date.parse(occurredAt)>now()||Date.parse(occurredAt)<Date.parse(lead.created_at))fail(400,'Проверьте дату состоявшегося платежа');
    if(db.prepare('SELECT 1 FROM studio_payment_references WHERE company_id=? AND reference=?').get(owner.id,reference))fail(409,'Этот платёж уже учтён у компании');
    const amountCents=Math.round(body.amount*100);let refundOf=null;
    if(body.type==='refund'){
      if(!Number.isSafeInteger(body.refundOf))fail(400,'Выберите исходную оплату');
      const original=current.payments.find(row=>row.id===body.refundOf&&row.data.type==='received');
      if(!original||original.data.currency!==body.currency)fail(409,'Оплата этой заявки в указанной валюте не найдена');
      const refunded=current.payments.filter(row=>row.data.refundOf===body.refundOf).reduce((sum,row)=>sum+row.data.amountCents,0);
      if(amountCents+refunded>original.data.amountCents)fail(409,'Возврат превышает остаток оплаты');
      if(occurredAt<original.data.occurredAt)fail(400,'Возврат не может быть раньше оплаты');refundOf=original.id;
    }else if(body.refundOf!==undefined&&body.refundOf!==null)fail(400,'У оплаты не бывает исходного возврата');
    return {type:body.type,amountCents,currency:body.currency,reference,evidence,occurredAt,refundOf};
  });}
  function voidPayment(code,id,body,actorId){return write(code,id,'void',body,actorId,({current})=>{
    const evidence=text(body.evidence,1000,true);
    if(!Number.isSafeInteger(body.paymentId)||body.paymentId<1)fail(400,'Выберите запись для исправления');
    const original=current.payments.find(row=>row.id===body.paymentId);
    if(!original)fail(409,'Действующая запись этой заявки не найдена');
    if(current.payments.some(row=>row.data.refundOf===original.id))fail(409,'Сначала исправьте связанные возвраты. Оплату с действующими возвратами аннулировать нельзя.');
    return {paymentId:original.id,reference:original.data.reference,evidence};
  });}
  function cohort(code,leads,byLead){
    const owner=company(db,code),ids=new Set(leads.map(lead=>lead.id)),histories=new Map();
    const rows=db.prepare(`SELECT e.id,e.lead_id,e.kind,e.data FROM studio_commerce_events e JOIN leads l ON l.id=e.lead_id
      WHERE e.company_id=? AND l.company_code=? COLLATE NOCASE ORDER BY e.id`).all(owner.id,owner.code);
    for(const row of rows){if(!ids.has(row.lead_id))continue;if(!histories.has(row.lead_id))histories.set(row.lead_id,[]);histories.get(row.lead_id).push({id:row.id,kind:row.kind,...JSON.parse(row.data)});}
    const groups=new Map();
    for(const lead of leads){
      const history=histories.get(lead.id)||[],source=history.filter(row=>row.kind==='publication').at(-1),postId=source?.postId??null;
      if(!groups.has(postId))groups.set(postId,{postId,title:postId?source.title:'Публикация не установлена',leads:0,booked:0,visited:0,paidLeads:0,totals:new Map()});
      const group=groups.get(postId),stages=byLead.get(lead.id)||[];group.leads++;
      if(stages.some(type=>['booked','rescheduled'].includes(type)))group.booked++;
      if(stages.includes('visited'))group.visited++;
      const voided=new Set(history.filter(row=>row.kind==='void').map(row=>row.paymentId)),payments=history.filter(row=>row.kind==='payment'&&!voided.has(row.id));if(payments.some(row=>row.type==='received'))group.paidLeads++;
      for(const p of payments){if(!group.totals.has(p.currency))group.totals.set(p.currency,{currency:p.currency,receivedCents:0,refundedCents:0,netCents:0});
        const total=group.totals.get(p.currency);total[p.type==='received'?'receivedCents':'refundedCents']+=p.amountCents;total.netCents=total.receivedCents-total.refundedCents;}
    }
    return [...groups.values()].map(group=>({...group,totals:[...group.totals.values()]}));
  }
  return {get,publication,payment,voidPayment,cohort};
}
module.exports={createStudioCommerce};
