'use strict';
const crypto = require('node:crypto');
const PROVIDERS = ['metrika', 'yclients'];
const fail = (code = 'VALIDATION_ERROR', status = 400) => { throw Object.assign(new Error(code), {code, status}); };
const company = v => { if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v)) fail(); return v; };
const provider = v => { if (!PROVIDERS.includes(v)) fail(); return v; };
const id = v => { if (!/^[1-9]\d{0,14}$/.test(String(v)) || !Number.isSafeInteger(Number(v))) fail(); return String(v); };
const day = v => { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0,10) !== v) fail('BAD_PERIOD'); return v; };
const range = (from, to) => { day(from); day(to); if (from > to || (Date.parse(to)-Date.parse(from))/86400000 > 7300) fail('BAD_PERIOD'); return {from,to}; };
const localDay = (at, timezone) => new Intl.DateTimeFormat('en-CA', {timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
const shiftDay = (d, n) => new Date(Date.parse(day(d)) + n*86400000).toISOString().slice(0,10);
function credential(name, value) {
  const oauth = name === 'metrika' && value?.refreshToken !== undefined;
  const keys = name === 'metrika' ? oauth ? ['token','refreshToken','clientId','clientSecret','expiresAt','refreshedAt'] : ['token'] : ['partnerToken','userToken'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',')) fail();
  for (const key of keys) if (typeof value[key] !== 'string' || !value[key].length || value[key].length > 4096 || /[\s\x00-\x1f\x7f]/.test(value[key])) fail();
  if (oauth) {
    if (!/^[a-f0-9]{32}$/.test(value.clientId)) fail();
    for (const key of ['expiresAt','refreshedAt']) if (!Number.isFinite(Date.parse(value[key])) || new Date(value[key]).toISOString() !== value[key]) fail();
    if (Date.parse(value.expiresAt) <= Date.parse(value.refreshedAt)) fail();
  }
  return value;
}
function configuration(name, input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') fail();
  const allowed = name === 'metrika' ? ['externalId','historyFrom','timezone','goals'] : ['externalId','historyFrom','timezone','cashRules'];
  if (Object.keys(input).some(k => !allowed.includes(k))) fail();
  const c = {externalId:id(input.externalId),historyFrom:day(input.historyFrom),timezone:input.timezone || 'Asia/Irkutsk'};
  try { localDay(Date.now(), c.timezone); } catch { fail('BAD_TIMEZONE'); }
  if (!['Asia/Irkutsk','Asia/Bangkok','Europe/Moscow','UTC'].includes(c.timezone)) fail('BAD_TIMEZONE');
  if (name === 'metrika') {
    if (!Array.isArray(input.goals || []) || (input.goals || []).length > 30) fail();
    c.goals = (input.goals || []).map(g => {
      if (!g || Object.keys(g).some(k => !['id','label'].includes(k)) || typeof g.label !== 'string' || !g.label.trim() || g.label.length > 120) fail();
      return {id:id(g.id),label:g.label.trim()};
    });
    if (new Set(c.goals.map(g => g.id)).size !== c.goals.length) fail();
  } else {
    if (!Array.isArray(input.cashRules || []) || (input.cashRules || []).length > 50) fail();
    c.cashRules = (input.cashRules || []).map(r => {
      if (!r || Object.keys(r).some(k => !['expenseId','kind'].includes(k)) || !['signed','payment','refund','exclude'].includes(r.kind)) fail();
      return {expenseId:id(r.expenseId),kind:r.kind};
    });
    if (new Set(c.cashRules.map(r => r.expenseId)).size !== c.cashRules.length) fail();
  }
  return c;
}
function createRevenueAccess(db, {apiKey, now = Date.now}) {
  if (!apiKey) throw new Error('Analytics encryption key missing');
  db.exec('CREATE TABLE IF NOT EXISTS revenue_access (company TEXT NOT NULL, provider TEXT NOT NULL, config TEXT NOT NULL, secret TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(company,provider))');
  db.exec('CREATE TABLE IF NOT EXISTS revenue_oauth_refresh(grant_key TEXT PRIMARY KEY,state TEXT NOT NULL,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0)');
  function crypt(code, name, value, decrypt = false) {
    const aad = Buffer.from('synapse/revenue-analytics/v1/' + code + '/' + name);
    const e = decrypt ? JSON.parse(value) : {v:1,salt:crypto.randomBytes(16).toString('base64'),iv:crypto.randomBytes(12).toString('base64')};
    if (e.v !== 1) fail('CREDENTIAL_UNREADABLE',409);
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey), Buffer.from(e.salt,'base64'),aad,32));
    const cipher = decrypt ? crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64')) : crypto.createCipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));
    cipher.setAAD(aad);
    if (decrypt) { cipher.setAuthTag(Buffer.from(e.tag,'base64')); return JSON.parse(Buffer.concat([cipher.update(Buffer.from(e.data,'base64')),cipher.final()]).toString()); }
    e.data = Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]).toString('base64'); e.tag = cipher.getAuthTag().toString('base64'); return JSON.stringify(e);
  }
  const row = (code, name) => db.prepare('SELECT * FROM revenue_access WHERE company=? AND provider=?').get(company(code),provider(name));
  const dto = (code,name,r) => ({companyCode:code,provider:name,configured:Boolean(r?.secret),enabled:Boolean(r?.enabled),revision:r?.revision || 0,config:r ? JSON.parse(r.config) : null,updatedAt:r?.updated_at || null});
  const get = (code,name) => dto(company(code),provider(name),row(code,name));
  function save(code,name,b) {
    company(code); provider(name);
    if (!b || Object.keys(b).some(k => !['revision','config','credential','enabled'].includes(k)) || !Number.isSafeInteger(b.revision) || b.revision < 0 || typeof b.enabled !== 'boolean') fail();
    const old = row(code,name); if ((old?.revision || 0) !== b.revision) fail('REVISION_CONFLICT',409);
    const c = configuration(name,b.config);
    // Данные филиала не смешиваются при смене внешнего идентификатора. Нужна новая привязка компании.
    if (old && JSON.parse(old.config).externalId !== c.externalId) fail('BINDING_CHANGED',409);
    let secret = old?.secret || '';
    if (b.credential !== undefined) {
      secret = crypt(code,name,credential(name,b.credential));
    }
    if (!secret) fail('MISSING_ACCESS',409);
    db.prepare('INSERT INTO revenue_access VALUES(?,?,?,?,?,?,?) ON CONFLICT(company,provider) DO UPDATE SET config=excluded.config,secret=excluded.secret,revision=excluded.revision,enabled=excluded.enabled,updated_at=excluded.updated_at')
      .run(code,name,JSON.stringify(c),secret,b.revision+1,b.enabled?1:0,new Date(now()).toISOString());
    return get(code,name);
  }
  function resolve(code,name) {
    const r = row(code,name); if (!r?.secret || !r.enabled) fail('MISSING_ACCESS',409);
    let credential; try { credential = crypt(code,name,r.secret,true); } catch { fail('CREDENTIAL_UNREADABLE',409); }
    return {...dto(code,name,r),credential};
  }
  const list = () => db.prepare('SELECT * FROM revenue_access WHERE enabled=1').all().map(r => dto(r.company,r.provider,r));
  const grantKey = c => crypto.createHmac('sha256',apiKey).update(JSON.stringify(['metrika-grant/v1',c.clientId,c.refreshToken])).digest('hex');
  function beginRefresh(binding) {
    const current=resolve(binding.companyCode,'metrika');
    if(current.revision!==binding.revision || current.credential.token!==binding.credential.token || current.credential.refreshToken!==binding.credential.refreshToken) fail('REVISION_CONFLICT',409);
    const key=grantKey(credential('metrika',binding.credential));
    const old=db.prepare('SELECT * FROM revenue_oauth_refresh WHERE grant_key=?').get(key);
    if(old?.state==='refreshing' && old.lease_until<=now()) {
      db.prepare("UPDATE revenue_oauth_refresh SET state='uncertain' WHERE grant_key=? AND state='refreshing' AND lease_until<=?").run(key,now());
      fail('TOKEN_REFRESH_UNCERTAIN',502);
    }
    if(old && ['uncertain','complete','revoked'].includes(old.state)) fail(old.state==='uncertain'?'TOKEN_REFRESH_UNCERTAIN':'TOKEN_REAUTH_REQUIRED',502);
    const lease=crypto.randomUUID();
    const acquired=db.prepare("INSERT INTO revenue_oauth_refresh VALUES(?,'refreshing',?,?) ON CONFLICT(grant_key) DO UPDATE SET state='refreshing',lease=excluded.lease,lease_until=excluded.lease_until WHERE revenue_oauth_refresh.state='ready'").run(key,lease,now()+120000).changes;
    if(!acquired)fail('TOKEN_REFRESH_BUSY',409);
    return {key,lease,credential:binding.credential};
  }
  function finishRefresh(context, next) {
    const replacement=credential('metrika',{...context.credential,...next});
    db.exec('BEGIN IMMEDIATE');
    try {
      const held=db.prepare('SELECT * FROM revenue_oauth_refresh WHERE grant_key=?').get(context.key);
      if(held?.lease!==context.lease || !['refreshing','uncertain'].includes(held.state))fail('LEASE_LOST',409);
      // Один grant может обслуживать несколько счётчиков. Только его старые ключи заменяются;
      // текущие настройки, ACL, ревизии и отдельно заменённые владельцем доступы сохраняются.
      for(const r of db.prepare("SELECT * FROM revenue_access WHERE provider='metrika'").all()) {
        let previous;try{previous=crypt(r.company,'metrika',r.secret,true);}catch{continue;}
        if(previous.clientId!==context.credential.clientId || previous.refreshToken!==context.credential.refreshToken)continue;
        const rotated=credential('metrika',{...previous,token:replacement.token,refreshToken:replacement.refreshToken,expiresAt:replacement.expiresAt,refreshedAt:replacement.refreshedAt});
        db.prepare("UPDATE revenue_access SET secret=?,updated_at=? WHERE company=? AND provider='metrika' AND secret=?")
          .run(crypt(r.company,'metrika',rotated),new Date(now()).toISOString(),r.company,r.secret);
      }
      db.prepare('UPDATE revenue_oauth_refresh SET state=?,lease=NULL,lease_until=0 WHERE grant_key=? AND lease=?')
        .run(replacement.refreshToken===context.credential.refreshToken?'ready':'complete',context.key,context.lease);
      db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK');throw e; }
  }
  function abortRefresh(context, error) {
    const state=error==='RATE_LIMITED'||error==='SERVER_STOPPING'?'ready':error==='TOKEN_REAUTH_REQUIRED'?'revoked':'uncertain';
    db.prepare('UPDATE revenue_oauth_refresh SET state=?,lease=NULL,lease_until=0 WHERE grant_key=? AND lease=?').run(state,context.key,context.lease);
  }
  return {get,save,resolve,list,beginRefresh,finishRefresh,abortRefresh};
}
module.exports = {createRevenueAccess,PROVIDERS,configuration,credential,company,provider,id,day,range,localDay,shiftDay,fail};
