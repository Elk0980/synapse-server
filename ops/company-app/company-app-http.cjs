'use strict';
const C = require('./company-context');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const STUDIOS = new Map(C.profiles.filter(p => p.code !== 'palitra-love').map(p => [p.site, p]));
function permitted(user, company, write) {
  return Boolean(user && ['owner', 'editor'].includes(user.role) && Array.isArray(user.companyCodes) && user.companyCodes.includes(company.code)
    && (user.role === 'owner' || Array.isArray(user.permissions) && user.permissions.includes(write ? 'crm.edit' : 'crm.view')));
}
// Only the two studio routes are added. Palitra's existing handlers are untouched.
// No recipient, transport, operator, push, uploads, customer grants or workflow route.
async function handle({ request, url, reply, requireSession, requireCsrf, readJson, origin, orders, dialogs }) {
  const match = /^\/content\/(alvi|avokado)\/(orders|client-dialogs|client-bot)(?:\/([1-9]\d{0,14})(?:\/(work|checklist|dialog))?)?$/.exec(url.pathname);
  if (!match) return false;
  const company = STUDIOS.get(match[1]), type = match[2], id = match[3], action = match[4], method = request.method;
  const read = method === 'GET', write = method === 'PUT';
  const supported = read ? (!id || type === 'orders' ? !id || ['checklist', 'dialog'].includes(action) : type === 'client-dialogs' && !action)
    : write && type === 'orders' && id && ['work', 'checklist'].includes(action);
  if (!supported) fail(405, 'Действие ещё не подключено для выбранной компании');
  if (!read && !write) fail(405, 'Метод не поддерживается');
  const allowedQuery = new Set(!id && type !== 'client-bot' ? ['limit', 'beforeId'] : []);
  for (const key of url.searchParams.keys()) if (!allowedQuery.has(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'Некорректные параметры');
  const session = requireSession(request);
  if (!permitted(session.user, company, write)) fail(403, 'Нет доступа к выбранной компании');
  const headers = { 'cache-control': 'no-store' };
  if (read) {
    let result;
    if (type === 'orders' && !id) result = orders.listOrders(company.site, { limit: url.searchParams.get('limit'), beforeId: url.searchParams.get('beforeId') });
    else if (type === 'orders' && action === 'checklist') result = orders.checklistOrder(company.site, id);
    else if (type === 'orders' && action === 'dialog') {
      orders.checklistOrder(company.site, id); // The order belongs to this exact site before looking up any relation.
      const legacy = dialogs.orderDialog(company.site, id);
      result = { ...legacy, dialogRef: legacy && legacy.dialogId ? `legacy:${legacy.dialogId}` : null, threadId: null, threadRef: null };
    } else if (type === 'client-bot' && !id) result = dialogs.status(company.site);
    else if (!id) result = dialogs.listDialogs(company.site, { limit: url.searchParams.get('limit'), beforeId: url.searchParams.get('beforeId') });
    else result = dialogs.dialogView(company.site, id);
    reply(200, result, headers); return true;
  }
  if (!origin || request.headers.origin !== origin) fail(403, 'Запрос с другого адреса запрещён');
  requireCsrf(request, session);
  const body = await readJson(request);
  const fresh = requireSession(request);
  if (fresh.user.id !== session.user.id || fresh.user.sessionVersion !== session.user.sessionVersion || !permitted(fresh.user, company, true)) fail(403, 'Доступ изменился');
  requireCsrf(request, fresh);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Ожидался объект');
  let result;
  const actor = { type: fresh.user.role === 'owner' ? 'owner' : 'manager', id: fresh.user.id, label: fresh.user.displayName || fresh.user.login };
  if (action === 'work') {
    if (!Object.hasOwn(body, 'status') || Object.keys(body).some(k => !['status', 'expected'].includes(k))) fail(400, 'Нужны только status и expected');
    result = orders.setWorkStatus(company.site, id, body.status, `${actor.type}: ${actor.label}`, body.expected === undefined ? {} : { expected: body.expected });
  } else {
    if (Object.keys(body).sort().join(',') !== 'checked,item,revision') fail(400, 'Нужны только item, checked и revision');
    result = orders.setChecklist(company.site, id, body, actor);
  }
  reply(200, result, headers); return true;
}
module.exports = { handle, permitted };
