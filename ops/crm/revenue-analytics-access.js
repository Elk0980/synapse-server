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
      const keys = name === 'metrika' ? ['token'] : ['partnerToken','userToken'];
      if (!b.credential || Object.keys(b.credential).sort().join(',') !== keys.sort().join(',')) fail();
      for (const key of keys) if (typeof b.credential[key] !== 'string' || !b.credential[key].length || b.credential[key].length > 4096 || /[\s\x00-\x1f\x7f]/.test(b.credential[key])) fail();
      secret = crypt(code,name,b.credential);
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
  return {get,save,resolve,list};
}
module.exports = {createRevenueAccess,PROVIDERS,configuration,company,provider,id,day,range,localDay,shiftDay,fail};
