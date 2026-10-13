'use strict';
/*
 * Единая карта маршрутов приложения Palitra: одна и та же для защищённого HTTP (crm-http.js, проверенная
 * сессия Telegram/сайта) и локальной демонстрации (server.cjs, вымышленные участники). Здесь нет входа и
 * проверки подлинности — вызывающий слой передаёт getActor(), который при каждом вызове заново проверяет
 * сессию. Для изменений getActor() вызывается ПОСЛЕ чтения тела: отзыв права во время загрузки тела действует.
 */
const { owner, staff, fail } = require('./workspace');

const ID = /^[1-9]\d{0,14}$/;
const ok = (body, status = 200) => ({ status, body });

function createApiRoutes({ workspace, fallback, submitCustomerOrder }) {
  if (!workspace || !fallback || typeof submitCustomerOrder !== 'function') throw new TypeError('Требуются модули приложения');
  return async function route({ method, path, getActor, readBody, context = {} }) {
    const parts = path.split('/').filter(Boolean);
    const [head, rawId, tail] = parts;
    // Числовой номер проверяется только для карточек; именованные маршруты (/settings/email) идут раньше.
    const id = ['inquiries', 'orders', 'customers'].includes(head) && rawId !== undefined && ID.test(rawId) ? Number(rawId) : null;
    if (parts.length > 3) fail(404, 'Действие не найдено');

    if (method === 'GET' && path === '/bootstrap') return ok(workspace.bootstrap(getActor()));
    if (method === 'GET' && path === '/summary') return ok(workspace.summary(getActor()));
    if (method === 'GET' && path === '/price') { getActor(); return ok(workspace.priceDoc); }
    if (path === '/settings/email') {
      owner(getActor());
      if (method === 'GET') return ok(fallback.settings(getActor()));
      if (method === 'PUT') { const input = await readBody(); const actor = getActor(); owner(actor); return ok(fallback.configure(input, actor)); }
      fail(405, 'Метод не поддерживается');
    }
    if (method === 'POST' && path === '/orders') {
      // Только покупатель оформляет заказ через тот же контракт, что и форма сайта. Сотрудник записывает обращение.
      if (getActor().role !== 'customer') fail(403, 'Сотрудник добавляет обращение, а заказ оформляет из него');
      const input = await readBody(); const actor = getActor();
      if (actor.role !== 'customer') fail(403, 'Доступ закрыт');
      const result = submitCustomerOrder(input, actor, context);
      return ok(result.body, result.status);
    }
    if (method === 'POST' && path === '/inquiries') {
      staff(getActor());
      const input = await readBody(); const actor = getActor();
      const result = workspace.createInquiry(input, actor);
      return ok({ ok: true, duplicate: result.duplicate, inquiry: result.inquiry }, result.status);
    }
    if (head === 'inquiries' && id !== null) {
      if (method === 'GET' && tail === undefined) return ok(workspace.inquiry(id, getActor()));
      if (method === 'POST' && tail === 'action' && parts.length === 3) {
        staff(getActor());
        const input = await readBody(); const actor = getActor();
        return ok(workspace.inquiryAction(id, input, actor));
      }
    }
    if (head === 'orders' && id !== null) {
      if (method === 'GET' && tail === undefined) return ok(workspace.order(id, getActor()));
      if (method === 'POST' && tail === 'action' && parts.length === 3) {
        getActor();
        const input = await readBody(); const actor = getActor();
        return ok(workspace.orderAction(id, input, actor));
      }
    }
    if (head === 'customers' && id !== null && method === 'GET' && tail === undefined) return ok(workspace.customer(id, getActor()));
    fail(404, 'Действие не найдено');
  };
}

module.exports = { createApiRoutes };
