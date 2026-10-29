'use strict';
// spec092-vk-events HTTP contract.
//  * /vk-events/callback/<endpointId> — internal target of the public content route /public-vk-callback/<endpointId>.
//    No user identity: authenticity = exact endpoint + group_id + secret (checked in vk-events.js). Plain-text replies only.
//  * every other /vk-events/* route — owner-only, explicit companyCode, no generic VK proxying.
const {VK_EVENTS_ERRORS, CALLBACK_MAX_BYTES} = require('./vk-events');

const fail = (status, code) => { throw Object.assign(new Error(VK_EVENTS_ERRORS[code] || code), {status, code}); };

async function readRaw(request, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function createVkEventsHandler({events, companyModuleContext, readJson, send}) {
  return async function handle(request, response, url, cors = {}) {
    if (!/^\/vk-events(?:\/|$)/.test(url.pathname)) return false;
    const callback = /^\/vk-events\/callback\/([^/]+)$/.exec(url.pathname);
    if (callback) {
      let result;
      if (request.method !== 'POST') result = {status: 405, body: 'rejected'};
      else {
        const raw = await readRaw(request, CALLBACK_MAX_BYTES);
        result = raw === null ? {status: 413, body: 'rejected'} : events.handleCallback(callback[1], raw);
      }
      // VK expects the literal body: "ok" or the confirmation string. Nothing else is echoed.
      response.writeHead(result.status, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        'content-length': Buffer.byteLength(result.body), 'x-content-type-options': 'nosniff'});
      response.end(result.body);
      return true;
    }
    const scoped = () => {
      const value = companyModuleContext(request, url.searchParams.get('companyCode'), 'vk-community.owner');
      if (value.identity.role !== 'owner') fail(403, 'FORBIDDEN');
      return value;
    };
    try {
      const initial = scoped(), code = initial.company.code;
      const body = async () => {
        const value = await readJson(request, 16 * 1024);
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_REQUEST');
        const fresh = scoped();
        // Role or company may change while the body is read; never apply a write to a different scope.
        if (fresh.company.code !== code || fresh.identity.userId !== initial.identity.userId) fail(403, 'FORBIDDEN');
        if (value.companyCode !== undefined && String(value.companyCode).toLowerCase() !== code.toLowerCase()) fail(400, 'INVALID_REQUEST');
        const {companyCode, ...rest} = value;
        return rest;
      };
      const revisionOnly = value => {
        if (Object.keys(value).some(key => !['revision', 'action', 'transport'].includes(key)) || !Number.isSafeInteger(value.revision)) fail(400, 'INVALID_REQUEST');
        return value;
      };
      let result;
      const path = url.pathname, method = request.method;
      if (path === '/vk-events/settings' && method === 'GET') result = events.getSettings(code);
      else if (path === '/vk-events/settings' && method === 'PUT') result = events.saveSettings(code, await body());
      else if (path === '/vk-events/check' && method === 'POST') result = await events.checkConnection(code, revisionOnly(await body()));
      else if (path === '/vk-events/longpoll' && method === 'POST') result = await events.longPoll(code, revisionOnly(await body()));
      else if (path === '/vk-events/revoke' && method === 'POST') result = await events.revoke(code, revisionOnly(await body()));
      else if (path === '/vk-events/journal' && method === 'GET') {
        const limit = url.searchParams.get('limit'), before = url.searchParams.get('before');
        if ((limit !== null && !/^[1-9]\d{0,2}$/.test(limit)) || (before !== null && !/^[1-9]\d{0,15}$/.test(before))) fail(400, 'INVALID_REQUEST');
        result = events.journal(code, {...(limit ? {limit: Number(limit)} : {}), ...(before ? {before: Number(before)} : {})});
      } else fail(405, 'INVALID_REQUEST');
      send(response, 200, result, {...cors, 'cache-control': 'no-store'});
    } catch (error) {
      if (!Object.hasOwn(VK_EVENTS_ERRORS, error.code) && error.code !== 'FORBIDDEN') throw error;
      const status = [400, 403, 404, 405, 409, 413, 502].includes(error.status) ? error.status : 400;
      send(response, status, {code: error.code, error: VK_EVENTS_ERRORS[error.code] || 'Недостаточно прав'}, {...cors, 'cache-control': 'no-store'});
    }
    return true;
  };
}

module.exports = {createVkEventsHandler};
