'use strict';

const { actorOf } = require('./palitra-push.cjs');
const STAFF = '/content/palitra/push/';
const CUSTOMER = '/api/customer-chat/push/';
const PATHS = ['capability', 'subscription', 'subscription/status'];
const error = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const exact = (value, key) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value,key);
function createPalitraPushHttp({ push, resolveStaff, resolveCustomer } = {}) {
  if (!push || typeof resolveStaff !== 'function' || typeof resolveCustomer !== 'function') throw new TypeError('Existing host authorization required');
  const matches = (pathname) => [STAFF, CUSTOMER].some((prefix) => pathname.startsWith(prefix) && PATHS.includes(pathname.slice(prefix.length)));
  async function read(req) {
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') error(415,'PUSH_JSON_REQUIRED');
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8192) error(413,'PUSH_BODY_LIMIT'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { error(400,'PUSH_JSON'); }
  }
  function reply(res, status, value, extra = {}) {
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra });
    res.end(JSON.stringify(value));
  }
  async function handle(req, res, url, hostname) {
    if (!matches(url.pathname)) return false;
    try {
      if (url.search) error(404,'NOT_FOUND');
      const staff = url.pathname.startsWith(STAFF), prefix = staff ? STAFF : CUSTOMER, route = url.pathname.slice(prefix.length);
      const origin = staff ? 'https://synapse.synapsebusiness.ru' : 'https://palitra-love.ru';
      if ('https://' + hostname !== origin || (req.headers.origin !== undefined && req.headers.origin !== origin)) error(403,'PUSH_ORIGIN');
      const allowed = route === 'capability' ? ['GET'] : route === 'subscription/status' ? ['POST'] : ['GET','POST','DELETE'];
      if (!allowed.includes(req.method)) { reply(res,405,{ok:false,code:'METHOD'},{Allow:allowed.join(', ')}); return true; }
      const mutating = req.method !== 'GET';
      if (mutating && req.headers.origin !== origin) error(403,'PUSH_ORIGIN');
      const resolve = staff ? resolveStaff : resolveCustomer;
      // Resolver must reuse current cookie + host CSRF and existing permission/company guard; never body identity.
      const actor = actorOf(await resolve(req, { mutating, origin }));
      if (actor.kind !== (staff ? 'staff' : 'customer')) error(403,'PUSH_ACTOR');
      if (route === 'capability') { reply(res,200,push.capability(actor)); return true; }
      if (req.method === 'GET') { reply(res,200,push.status(actor)); return true; }
      const body = await read(req);
      // Revalidate after asynchronous body read; expired/revoked/current identity changes cannot save subscriptions.
      const again = actorOf(await resolve(req, { mutating, origin }));
      if (JSON.stringify(actor) !== JSON.stringify(again)) error(403,'PUSH_ACTOR_CHANGED');
      if (route === 'subscription/status') {
        if (!exact(body,'endpoint')) error(422,'PUSH_FIELDS');
        reply(res,200,push.status(again,body.endpoint));
      } else if (req.method === 'POST') {
        if (!exact(body,'subscription')) error(422,'PUSH_FIELDS');
        reply(res,200,push.subscribe(again,body.subscription));
      } else {
        if (!exact(body,'endpoint')) error(422,'PUSH_FIELDS');
        reply(res,200,push.unsubscribe(again,body.endpoint));
      }
    } catch (failure) {
      const status = Number.isInteger(failure?.status) && failure.status >= 400 && failure.status < 600 ? failure.status : 503;
      const code = typeof failure?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'PUSH_UNAVAILABLE';
      reply(res,status,{ok:false,code});
    }
    return true;
  }
  return Object.freeze({ matches, handle });
}
module.exports = { createPalitraPushHttp, STAFF, CUSTOMER };
