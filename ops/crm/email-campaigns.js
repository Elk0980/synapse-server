'use strict';

const crypto = require('node:crypto');
const {emailErrorCode} = require('./email-notifications');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LEASE_MS = 120000;
const RETRIES = [30000, 120000, 600000, 1800000, 3600000];
const SAFE_SMTP_CODES = new Set(['SMTP_NOT_CONFIGURED','EMAIL_RECIPIENT_MISSING','EMAIL_RECIPIENT_REJECTED',
  'SMTP_AUTH','SMTP_CONNECTION','SMTP_SENDER','SMTP_RECIPIENT','SMTP_ENVELOPE','SMTP_SEND_FAILED']);
function fail(status, message, code = 'VALIDATION_ERROR') { throw Object.assign(Error(message), {status, details: {code}}); }
function string(value, max, field, required = false) {
  if (typeof value !== 'string' || value.length > max || /\x00/.test(value)) fail(400, `Проверьте поле «${field}»`);
  const clean = value.trim();
  if (required && !clean) fail(400, `Заполните поле «${field}»`);
  return clean;
}
function email(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\s\r\n\x00,;<>]/.test(value.trim())) return null;
  const clean = value.trim(), parts = clean.split('@');
  if (parts.length !== 2 || parts[0].length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0]) ||
      !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(parts[1])) return null;
  return clean.toLowerCase();
}
function bodyFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Некорректные поля запроса');
}
function createEmailCampaigns(db, {transport, limiter, now = Date.now, hasPriorityWork = () => false,
  publicBaseUrl = 'https://synapse.synapsebusiness.ru', logger = console} = {}) {
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('Invalid public email URL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_subscriptions (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('unknown','subscribed','unsubscribed')),
      source TEXT NOT NULL DEFAULT '', consented_at TEXT, updated_at TEXT NOT NULL, UNIQUE(company_id,email));
    CREATE TABLE IF NOT EXISTS email_subscription_events (
      id INTEGER PRIMARY KEY, subscription_id INTEGER NOT NULL REFERENCES email_subscriptions(id), status TEXT NOT NULL,
      source TEXT NOT NULL, consented_at TEXT, changed_at TEXT NOT NULL, actor_id INTEGER);
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','paused','completed')),
      sender_email TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by INTEGER, last_error_code TEXT);
    CREATE TABLE IF NOT EXISTS email_campaign_deliveries (
      id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES email_campaigns(id), subscription_id INTEGER NOT NULL REFERENCES email_subscriptions(id),
      email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_attempt_at INTEGER,
      sent_at TEXT, last_error_code TEXT, UNIQUE(campaign_id,email));
    CREATE INDEX IF NOT EXISTS email_campaign_delivery_due_idx ON email_campaign_deliveries(status,next_attempt_at);
    CREATE TABLE IF NOT EXISTS email_unsubscribe_tokens (
      token_hash TEXT PRIMARY KEY, subscription_id INTEGER NOT NULL REFERENCES email_subscriptions(id), created_at TEXT NOT NULL);
  `);
  const iso = () => new Date(now()).toISOString();
  function company(code) {
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(code)) fail(400, 'Выберите компанию');
    const row = db.prepare('SELECT id,code,name FROM companies WHERE code=? COLLATE NOCASE AND is_deleted=0').get(code);
    if (!row) fail(404, 'Компания не найдена', 'NOT_FOUND');
    return row;
  }
  function campaign(id, code) {
    const owner = company(code);
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) fail(404, 'Рассылка не найдена', 'NOT_FOUND');
    const row = db.prepare('SELECT * FROM email_campaigns WHERE id=? AND company_id=?').get(Number(id), owner.id);
    if (!row) fail(404, 'Рассылка не найдена', 'NOT_FOUND');
    return {row, owner};
  }
  function counts(id) {
    const result = {pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0};
    db.prepare('SELECT status,COUNT(*) count FROM email_campaign_deliveries WHERE campaign_id=? GROUP BY status').all(id)
      .forEach(row => result[row.status] = row.count);
    return result;
  }
  function dto(row, owner) {
    return {id: row.id, companyCode: owner.code, name: row.name, subject: row.subject, text: row.text,
      status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, counts: counts(row.id), lastErrorCode: row.last_error_code};
  }
  function get(id, code) { const {row, owner} = campaign(id, code); return dto(row, owner); }
  function list(code) {
    const owner = company(code);
    return {campaigns: db.prepare('SELECT * FROM email_campaigns WHERE company_id=? ORDER BY id DESC LIMIT 200').all(owner.id).map(row => dto(row, owner))};
  }
  function create(code, body, actorId = null) {
    const owner = company(code);
    bodyFields(body, ['companyCode', 'name', 'subject', 'text']);
    if (body.companyCode && body.companyCode !== code) fail(400, 'Компания запроса не совпадает');
    const name = string(body.name, 120, 'Название', true), subject = string(body.subject ?? '', 180, 'Тема'), text = string(body.text ?? '', 20000, 'Текст');
    if (/[\x00-\x1f\x7f]/.test(subject)) fail(400, 'Тема должна быть одной строкой');
    const time = iso();
    const id = db.prepare('INSERT INTO email_campaigns(company_id,name,subject,text,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?)')
      .run(owner.id, name, subject, text, time, time, actorId).lastInsertRowid;
    return get(Number(id), code);
  }
  function update(id, code, body) {
    const {row} = campaign(id, code);
    if (row.status !== 'draft') fail(409, 'После запуска текст зафиксирован. Создайте новый черновик.', 'CAMPAIGN_STATE');
    bodyFields(body, ['name', 'subject', 'text']);
    const next = {...row};
    for (const [field, max] of [['name',120], ['subject',180], ['text',20000]]) if (Object.hasOwn(body, field)) next[field] = string(body[field], max, field, field === 'name');
    if (/[\x00-\x1f\x7f]/.test(next.subject)) fail(400, 'Тема должна быть одной строкой');
    db.prepare("UPDATE email_campaigns SET name=?,subject=?,text=?,updated_at=? WHERE id=? AND status='draft'").run(next.name,next.subject,next.text,iso(),row.id);
    return get(row.id,code);
  }
  function audience(owner) {
    const result = new Map(); let invalid = 0, duplicate = 0;
    const records = db.prepare(`SELECT c.email,c.name FROM contacts c JOIN contact_companies r ON r.contact_id=c.id
      WHERE r.company_id=? AND r.is_deleted=0 AND c.is_deleted=0 ORDER BY c.id`).all(owner.id);
    for (const row of records) {
      const address = email(row.email);
      if (!address) { invalid++; continue; }
      if (result.has(address)) { duplicate++; continue; }
      result.set(address,{id:null,email:address,name:row.name || '',status:'unknown',source:'',consentedAt:null,updatedAt:null});
    }
    for (const row of db.prepare('SELECT * FROM email_subscriptions WHERE company_id=? ORDER BY id').all(owner.id)) {
      result.set(row.email,{id:row.id,email:row.email,name:row.name || result.get(row.email)?.name || '',status:row.status,
        source:row.source,consentedAt:row.consented_at,updatedAt:row.updated_at});
    }
    return {rows:[...result.values()],invalid,duplicate};
  }
  function subscriptions(code) { const result=audience(company(code)); return {subscriptions:result.rows,total:result.rows.length}; }
  function subscribe(code, body, actorId = null) {
    const owner=company(code);
    bodyFields(body,['email','name','status','source','consentedAt']);
    const address=email(body.email);
    if (!address) fail(400,'Укажите один корректный email');
    if (!['unknown','subscribed','unsubscribed'].includes(body.status)) fail(400,'Неизвестный статус подписки');
    const source=string(body.source,500,'Источник',true), name=body.name===undefined?null:string(body.name,120,'Имя');
    const time=iso();
    let consentedAt=null;
    if (body.status==='subscribed') {
      if (typeof body.consentedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T.+Z$/.test(body.consentedAt)||!Number.isFinite(Date.parse(body.consentedAt))||Date.parse(body.consentedAt)>now()) fail(400,'Укажите фактическую дату и время согласия');
      consentedAt=new Date(body.consentedAt).toISOString();
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const old=db.prepare('SELECT * FROM email_subscriptions WHERE company_id=? AND email=?').get(owner.id,address);
      const lastUnsubscribe=old && db.prepare("SELECT MAX(changed_at) AS at FROM email_subscription_events WHERE subscription_id=? AND status='unsubscribed'").get(old.id).at;
      const unsubscribedAt=lastUnsubscribe || (old?.status==='unsubscribed' ? old.updated_at : null);
      if (body.status==='subscribed' && unsubscribedAt && consentedAt<=unsubscribedAt) fail(400,'Для повторной подписки нужно новое согласие после отписки');
      const row=db.prepare(`INSERT INTO email_subscriptions(company_id,email,name,status,source,consented_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(company_id,email) DO UPDATE SET name=excluded.name,status=excluded.status,source=excluded.source,consented_at=excluded.consented_at,updated_at=excluded.updated_at RETURNING *`)
        .get(owner.id,address,name??old?.name??'',body.status,source,consentedAt,time);
      db.prepare('INSERT INTO email_subscription_events(subscription_id,status,source,consented_at,changed_at,actor_id) VALUES(?,?,?,?,?,?)').run(row.id,row.status,source,consentedAt,time,actorId);
      db.exec('COMMIT');
      return {id:row.id,email:row.email,name:row.name,status:row.status,source:row.source,consentedAt:row.consented_at,updatedAt:row.updated_at};
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  function previewInternal(row,owner) {
    let data;
    if (row.status==='draft') data=audience(owner);
    else data={invalid:0,duplicate:0,rows:db.prepare(`SELECT s.id,d.email,d.name,s.status,s.source,s.consented_at consentedAt,s.updated_at updatedAt
      FROM email_campaign_deliveries d JOIN email_subscriptions s ON s.id=d.subscription_id
      WHERE d.campaign_id=? AND d.status IN ('pending','sending') ORDER BY d.id`).all(row.id)};
    const eligible=data.rows.filter(r=>r.status==='subscribed'&&r.source&&r.consentedAt);
    const summary={eligible:eligible.length,unknown:data.rows.filter(r=>r.status==='unknown').length,
      unsubscribed:data.rows.filter(r=>r.status==='unsubscribed').length,invalid:data.invalid,duplicate:data.duplicate};
    const sender={address:transport.sender(),configured:transport.configured()};
    const previewToken=crypto.createHash('sha256').update(JSON.stringify({id:row.id,status:row.status,subject:row.subject,text:row.text,
      sender:sender.address,recipients:eligible.map(r=>[r.id,r.email,r.updatedAt])})).digest('hex');
    return {eligible,preview:{campaign:dto(row,owner),recipients:eligible.slice(0,200).map(r=>({email:r.email,name:r.name,status:r.status})),
      counts:summary,sender,previewToken,canLaunch:['draft','paused'].includes(row.status)&&!!row.subject&&!!row.text&&sender.configured&&eligible.length>0}};
  }
  function preview(id,code) {const {row,owner}=campaign(id,code);return previewInternal(row,owner).preview;}
  function launch(id,code,body) {
    bodyFields(body,['confirm','previewToken']);
    if(body.confirm!==true||typeof body.previewToken!=='string')fail(400,'Подтвердите текст и получателей');
    db.exec('BEGIN IMMEDIATE');
    try {
      const {row,owner}=campaign(id,code);
      if(!['draft','paused'].includes(row.status))fail(409,'Рассылка уже запущена или завершена','CAMPAIGN_STATE');
      const data=previewInternal(row,owner), p=data.preview;
      if(p.previewToken!==body.previewToken)fail(409,'Текст или получатели изменились. Обновите предпросмотр.','PREVIEW_CHANGED');
      if(!p.sender.configured)fail(409,'Сначала настройте почту отправителя','SMTP_NOT_CONFIGURED');
      if(!row.subject||!row.text)fail(400,'Укажите тему и текст');
      if(!data.eligible.length)fail(409,'Нет получателей с подтверждённым согласием','NO_RECIPIENTS');
      if(row.status==='draft') {
        const insert=db.prepare('INSERT INTO email_campaign_deliveries(campaign_id,subscription_id,email,name,next_attempt_at) VALUES(?,?,?,?,?)');
        for(const recipient of data.eligible)insert.run(row.id,recipient.id,recipient.email,recipient.name,now());
      }
      db.prepare("UPDATE email_campaigns SET status='running',sender_email=?,updated_at=?,last_error_code=NULL WHERE id=?").run(p.sender.address,iso(),row.id);
      db.exec('COMMIT');
      return get(row.id,code);
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function pause(id,code) {
    const {row}=campaign(id,code);
    if(!['running','paused'].includes(row.status))fail(409,'Приостановить можно запущенную рассылку','CAMPAIGN_STATE');
    db.prepare("UPDATE email_campaigns SET status='paused',updated_at=? WHERE id=?").run(iso(),row.id);
    return get(row.id,code);
  }
  const hash=token=>crypto.createHash('sha256').update(token).digest('hex');
  function tokenSubscription(token) {
    if(typeof token!=='string'||!TOKEN.test(token))return null;
    return db.prepare('SELECT s.* FROM email_unsubscribe_tokens t JOIN email_subscriptions s ON s.id=t.subscription_id WHERE t.token_hash=?').get(hash(token));
  }
  function unsubscribe(token,mutate=false) {
    const row=tokenSubscription(token);
    if(!row)return {valid:false,unsubscribed:false};
    if(mutate&&row.status!=='unsubscribed') {
      const time=iso();
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed=db.prepare("UPDATE email_subscriptions SET status='unsubscribed',source='email_unsubscribe',updated_at=? WHERE id=? AND status!='unsubscribed'").run(time,row.id);
        if(changed.changes)db.prepare("INSERT INTO email_subscription_events(subscription_id,status,source,changed_at) VALUES(?,'unsubscribed','email_unsubscribe',?)").run(row.id,time);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    return {valid:true,unsubscribed:mutate||row.status==='unsubscribed'};
  }
  function unsubscribeUrl(subscriptionId) {
    const token=crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO email_unsubscribe_tokens(token_hash,subscription_id,created_at) VALUES(?,?,?)').run(hash(token),subscriptionId,iso());
    return base.origin+'/email-unsubscribe/'+token;
  }
  const due=db.prepare(`SELECT d.*,c.company_id,c.subject,c.text,c.sender_email,co.code company_code FROM email_campaign_deliveries d
    JOIN email_campaigns c ON c.id=d.campaign_id JOIN companies co ON co.id=c.company_id
    WHERE c.status='running' AND co.is_deleted=0 AND ((d.status='pending' AND d.next_attempt_at<=?) OR (d.status='sending' AND d.last_attempt_at<=?))
    ORDER BY d.next_attempt_at,d.id LIMIT 1`);
  const claim=db.prepare(`UPDATE email_campaign_deliveries SET status='sending',attempts=attempts+1,last_attempt_at=?,last_error_code=NULL
    WHERE id=? AND ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND last_attempt_at<=?))
    AND EXISTS(SELECT 1 FROM email_campaigns c WHERE c.id=campaign_id AND c.status='running') RETURNING attempts`);
  function complete(id) {
    db.prepare(`UPDATE email_campaigns SET status='completed',updated_at=? WHERE id=? AND status IN ('running','paused')
      AND NOT EXISTS(SELECT 1 FROM email_campaign_deliveries WHERE campaign_id=? AND status IN ('pending','sending'))`).run(iso(),id,id);
  }
  let running=null,stopped=false;
  async function processDue() {
    if(stopped||hasPriorityWork())return;
    const time=now(), row=due.get(time,time-LEASE_MS);
    if(!row)return;
    const subscription=db.prepare('SELECT * FROM email_subscriptions WHERE id=?').get(row.subscription_id);
    if(!subscription||subscription.status!=='subscribed'||subscription.email!==row.email) {
      db.prepare("UPDATE email_campaign_deliveries SET status='skipped',last_error_code='UNSUBSCRIBED' WHERE id=? AND (status='pending' OR (status='sending' AND last_attempt_at<=?))").run(row.id,time-LEASE_MS);
      complete(row.campaign_id);return;
    }
    if(!transport.configured()||transport.sender()!==row.sender_email) {
      db.prepare("UPDATE email_campaigns SET status='paused',last_error_code='SMTP_NOT_CONFIGURED',updated_at=? WHERE id=? AND status='running'").run(iso(),row.campaign_id);return;
    }
    if(!limiter.acquire().ok)return;
    const lease=claim.get(time,row.id,time,time-LEASE_MS);
    if(!lease)return;
    // No await between the last subscription check, lease, and starting SMTP.
    const fresh=db.prepare('SELECT status,email FROM email_subscriptions WHERE id=?').get(row.subscription_id);
    if(fresh?.status!=='subscribed'||fresh.email!==row.email) {
      db.prepare("UPDATE email_campaign_deliveries SET status='skipped',last_error_code='UNSUBSCRIBED' WHERE id=? AND status='sending' AND attempts=?").run(row.id,lease.attempts);
      complete(row.campaign_id);return;
    }
    try {
      const accepted=await transport.send({to:row.email,subject:row.subject,text:row.text,companyCode:row.company_code.toLowerCase(),
        messageId:`<synapse-campaign-${row.campaign_id}-${row.id}@synapsebusiness.ru>`,unsubscribeUrl:unsubscribeUrl(row.subscription_id)});
      if(!accepted)throw Object.assign(Error('SMTP unavailable'),{code:'SMTP_NOT_CONFIGURED'});
      db.prepare("UPDATE email_campaign_deliveries SET status='sent',sent_at=?,last_error_code=NULL WHERE id=? AND status='sending' AND attempts=?").run(iso(),row.id,lease.attempts);
    }catch(error){
      const code=SAFE_SMTP_CODES.has(error?.code)?error.code:emailErrorCode(error), terminal=['SMTP_RECIPIENT','EMAIL_RECIPIENT_REJECTED','SMTP_ENVELOPE'].includes(code)||lease.attempts>=5;
      const changed=db.prepare("UPDATE email_campaign_deliveries SET status=?,next_attempt_at=?,last_error_code=? WHERE id=? AND status='sending' AND attempts=?")
        .run(terminal?'failed':'pending',now()+RETRIES[Math.min(lease.attempts-1,RETRIES.length-1)],code,row.id,lease.attempts);
      if(changed.changes&&['SMTP_AUTH','SMTP_SENDER','SMTP_NOT_CONFIGURED'].includes(code))db.prepare("UPDATE email_campaigns SET status='paused',last_error_code=?,updated_at=? WHERE id=? AND status='running'").run(code,iso(),row.campaign_id);
      if(changed.changes)logger.warn(`[crm] campaign email attempt code=${code}`);
    }
    complete(row.campaign_id);
  }
  function drain(){if(stopped)return Promise.resolve();if(!running)running=processDue().finally(()=>running=null);return running;}
  function stop(){stopped=true;return running||Promise.resolve();}
  return {list,get,create,update,subscriptions,subscribe,preview,launch,pause,unsubscribe,drain,stop};
}
module.exports={createEmailCampaigns,email,TOKEN,LEASE_MS};
