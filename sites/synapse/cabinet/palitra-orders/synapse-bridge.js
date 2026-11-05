/* Palitra Love Заказы — мост к существующим контрактам Synapse (14.10.2026).

   Здесь нет своей БД, входа, ролей и сетевого доступа по умолчанию. Мост знает только замороженный реестр
   именованных операций (descriptor allowlist) с относительными путями принятых пакетов:
     - кабинет Synapse: GET /content/whoami (cookie + CSRF), /content/palitra/orders…, client-dialogs, customer-threads;
     - portal CRM Palitra: обмен crm-session → memory Bearer, /api/crm/*;
     - магазин: POST /api/orders (siteOrders), чат сайта E/R1: POST /api/customer-chat/*.
   Транспорт внедряется снаружи. В локальном предпросмотре — только in-memory mock. Native-транспорт создаётся
   фабрикой с внедрённым fetch и проверенным host context; без явного allowNetwork он не делает ни одного запроса.
   URL, роль из макета, localStorage и пользовательский JSON не включают native и не задают path/method/body. */
'use strict';

(function factory(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(root, 'SynapseBridge', { value: api, writable: false, configurable: false });
}(typeof globalThis !== 'undefined' ? globalThis : this, function build(companyCode = 'palitra-love') {
  const Companies = typeof module === 'object' && module.exports ? require('./company-context.js') : globalThis.SynapseCompanies;
  const company = Companies ? Companies.profile(companyCode) : companyCode === 'palitra-love' ? { code: 'palitra-love', site: 'palitra', name: 'Палитра', origin: 'https://palitra-love.ru' } : null;
  if (!company) throw new TypeError('Компания не поддерживается приложением');
  const COMPANY_CODE = company.code;
  const CONTENT_SITE = company.site;
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const POSITIVE = /^[1-9]\d{0,14}$/;
  const NAMESPACES = Object.freeze(['native-order', 'crm-order', 'crm-inquiry', 'crm-customer', 'legacy', 'thread']);
  const WORK_STATUSES = Object.freeze(['new', 'in_work', 'done', 'cancelled']);
  const WORK_LABELS = Object.freeze({ new: 'Новая', in_work: 'В работе', done: 'Выполнена', cancelled: 'Отменена' });
  const CRM_STAGES = Object.freeze(['new', 'agreeing', 'awaiting_payment', 'preparing', 'photo', 'delivering', 'done']);
  const CRM_STAGE_LABELS = Object.freeze({ new: 'Новый заказ', agreeing: 'Согласование', awaiting_payment: 'Ожидаем оплату',
    preparing: 'Готовим заказ', photo: 'Фото на согласовании', delivering: 'Доставка / выдача', done: 'Заказ выполнен' });
  const CHECKLIST_ITEMS = Object.freeze({ photo: 'Фото готового заказа отправлено', guide: 'Памятка по шарам отправлена' });
  const PORTAL_ROLES = Object.freeze(['owner', 'admin', 'customer']);
  const CABINET_ROLES = Object.freeze(['owner', 'editor']);
  const NATIVE_CHANNELS = Object.freeze({ phone: 'Звонок', telegram: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' });
  const UTM_KEYS = Object.freeze(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);

  class BridgeError extends Error {
    constructor(message, code, status = 0, extra = {}) { super(message); this.name = 'BridgeError'; this.code = code; this.status = status; Object.assign(this, extra); }
  }
  const fail = (message, code, status = 0, extra) => { throw new BridgeError(message, code, status, extra); };
  const own = (object, key) => object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
  const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  const frozenMap = (entries) => Object.freeze(Object.assign(Object.create(null), entries));

  /* ---------- типизированные идентификаторы ---------- */
  // Строгое положительное целое: не NaN/0/отрицательное/дробь/переполнение/«1e3»/«01»/строка с префиксом.
  function parsePositiveId(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
    if (typeof value === 'string' && POSITIVE.test(value)) { const n = Number(value); return Number.isSafeInteger(n) ? n : null; }
    return null;
  }
  function makeRef(namespace, id) {
    if (!NAMESPACES.includes(namespace)) return null;
    const n = parsePositiveId(id);
    return n === null ? null : Object.freeze({ ns: namespace, id: n });
  }
  const refKey = (ref) => `${ref.ns}:${ref.id}`;
  // «native-order:5» → ref; любой другой формат, лишний префикс или чужой namespace — null.
  function parseRef(text, expectedNamespace) {
    if (typeof text !== 'string') return null;
    const match = /^([a-z-]+):([1-9]\d{0,14})$/.exec(text);
    if (!match) return null;
    const ref = makeRef(match[1], match[2]);
    if (!ref || (expectedNamespace && ref.ns !== expectedNamespace)) return null;
    return ref;
  }
  const sameRef = (a, b) => Boolean(a && b && a.ns === b.ns && a.id === b.id);
  // account/cookie — непрозрачные ссылки: не превращаются в число и не сравниваются с id сущностей.
  const accountRef = (opaque) => (typeof opaque === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(opaque) ? Object.freeze({ ns: 'account', opaque }) : null);
  function newRequestId(random) {
    const bytes = typeof random === 'function' ? random(16) : (globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(16)) : null);
    if (!bytes || bytes.length !== 16) fail('Нет безопасного генератора requestId', 'NO_RANDOM');
    const b = Array.from(bytes);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const hex = b.map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /* ---------- поля и сериализаторы (точные списки ключей) ---------- */
  function exactKeys(body, required, optional = []) {
    if (!plainObject(body)) fail('Ожидался объект', 'VALIDATION');
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(body)) if (!allowed.has(key)) fail(`Поле ${key} не разрешено`, 'VALIDATION');
    for (const key of required) if (!own(body, key)) fail(`Нет поля ${key}`, 'VALIDATION');
  }
  const cleanText = (value, max, field, required = true) => {
    if (typeof value !== 'string') fail(`Поле «${field}» должно быть текстом`, 'VALIDATION');
    const text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    if (required && !text) fail(`Заполните «${field}»`, 'VALIDATION');
    if (text.length > max) fail(`«${field}» длиннее ${max} символов`, 'VALIDATION');
    return text;
  };
  const requestIdOf = (value) => { if (typeof value !== 'string' || !UUID_V4.test(value)) fail('Некорректный requestId', 'REQUEST_ID'); return value; };
  const S = {
    empty: (body = {}) => { exactKeys(body, []); return {}; },
    chatThreadPage: (body = {}) => {
      exactKeys(body, [], ['before', 'limit']);
      const out = {};
      if (own(body, 'before')) { if (typeof body.before !== 'number' || parsePositiveId(body.before) === null) fail('Некорректный курсор', 'VALIDATION'); out.before = body.before; }
      if (own(body, 'limit')) { if (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 100) fail('limit 1–100', 'VALIDATION'); out.limit = body.limit; }
      return out;
    },
    work: (body) => {
      exactKeys(body, ['status'], ['expected']);
      if (!WORK_STATUSES.includes(body.status)) fail('Неизвестный статус обработки', 'VALIDATION');
      if (own(body, 'expected') && !WORK_STATUSES.includes(body.expected)) fail('Неизвестный ожидаемый статус', 'VALIDATION');
      return own(body, 'expected') ? { status: body.status, expected: body.expected } : { status: body.status };
    },
    checklist: (body) => {
      exactKeys(body, ['item', 'checked', 'revision']);
      if (!own(CHECKLIST_ITEMS, body.item)) fail('Пункт только photo или guide', 'VALIDATION');
      if (typeof body.checked !== 'boolean') fail('checked — да/нет', 'VALIDATION');
      if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail('Некорректная ревизия', 'VALIDATION');
      return { item: body.item, checked: body.checked, revision: body.revision };
    },
    legacyReply: (body) => { exactKeys(body, ['requestId', 'text']); return { requestId: requestIdOf(body.requestId), text: cleanText(body.text, 8000, 'Ответ') }; },
    threadReply: (body) => { exactKeys(body, ['requestId', 'text']); return { requestId: requestIdOf(body.requestId), text: cleanText(body.text, 4000, 'Ответ') }; },
    // CRM: минимальная подмножина — следующий серверный этап (с version) и заметка. Произвольный этап не принимается.
    orderAction: (body, context = {}) => {
      if (!plainObject(body)) fail('Ожидался объект', 'VALIDATION');
      if (body.action === 'stage') {
        exactKeys(body, ['requestId', 'action', 'version', 'value']);
        const current = context.order;
        if (!current || !CRM_STAGES.includes(current.stage) || !Number.isSafeInteger(current.version)) fail('Нет свежей карточки заказа', 'STALE');
        const next = CRM_STAGES[CRM_STAGES.indexOf(current.stage) + 1];
        if (!next || body.value !== next) fail('Можно перейти только к следующему этапу сервера', 'STAGE_NOT_NEXT');
        if (body.version !== current.version) fail('Карточка изменилась — обновите', 'STALE');
        return { requestId: requestIdOf(body.requestId), action: 'stage', version: body.version, value: next };
      }
      if (body.action === 'note') {
        exactKeys(body, ['requestId', 'action', 'text']);
        return { requestId: requestIdOf(body.requestId), action: 'note', text: cleanText(body.text, 2000, 'Заметка') };
      }
      return fail('Это действие CRM не подключено к оболочке', 'ACTION_NOT_CONNECTED');
    },
    chatMessages: (body) => {
      exactKeys(body, ['threadId'], ['before', 'limit']);
      if (parsePositiveId(body.threadId) === null || typeof body.threadId !== 'number') fail('Некорректный threadId', 'VALIDATION');
      const out = { threadId: body.threadId };
      if (own(body, 'before')) { if (parsePositiveId(body.before) === null || typeof body.before !== 'number') fail('Некорректный курсор', 'VALIDATION'); out.before = body.before; }
      if (own(body, 'limit')) { if (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 100) fail('limit 1–100', 'VALIDATION'); out.limit = body.limit; }
      return out;
    },
    chatMessage: (body) => {
      exactKeys(body, ['threadId', 'requestId', 'text']);
      if (typeof body.threadId !== 'number' || parsePositiveId(body.threadId) === null) fail('Некорректный threadId', 'VALIDATION');
      return { threadId: body.threadId, requestId: requestIdOf(body.requestId), text: cleanText(body.text, 4000, 'Сообщение') };
    },
    shopRequest: (body) => validateShopRequest(body),
  };

  // Только готовая сводка CRM выбранной компании; это не статистика native-заявок сайта.
  function reportDate(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) fail('Укажите дату в формате ГГГГ-ММ-ДД', 'VALIDATION');
    const date = new Date(`${value}T12:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('Такой календарной даты нет', 'VALIDATION');
    return value;
  }
  function crmReportQuery(query) {
    exactKeys(query, ['from', 'to'], ['companyCode']);
    if (own(query, 'companyCode') && query.companyCode !== COMPANY_CODE) fail('Сводка только CRM Palitra Love', 'VALIDATION');
    const from = reportDate(query.from), to = reportDate(query.to);
    if (from > to) fail('Дата начала должна быть не позже даты окончания', 'VALIDATION');
    return { companyCode: COMPANY_CODE, from, to };
  }
  const canCrmSummary = (cab) => Boolean(cab && cab.member && (cab.role === 'owner' || (Array.isArray(cab.permissions) && (cab.permissions.includes('analytics.view') || cab.permissions.includes('crm.view')))));
  // Отдельное opt-in чтение: пользователь не задаёт view или произвольные параметры адреса.
  function conversationQuery(query = {}) {
    exactKeys(query, [], ['before', 'limit', 'adviceAfter']);
    const out = { view: 'conversation-v1' };
    if (own(query, 'before')) { if (typeof query.before !== 'number' || parsePositiveId(query.before) === null) fail('Некорректный курсор', 'VALIDATION'); out.before = String(query.before); }
    if (own(query, 'limit')) { if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) fail('limit 1–100', 'VALIDATION'); out.limit = String(query.limit); }
    if (own(query, 'adviceAfter')) { if (typeof query.adviceAfter !== 'number' || parsePositiveId(query.adviceAfter) === null) fail('Некорректный курсор подсказок', 'VALIDATION'); out.adviceAfter = String(query.adviceAfter); }
    return out;
  }
  // Staff advice is an authorized staff-reader current-state DTO, never a message or send receipt.
  function parseStaffAdvisories(value, scopeKey, after = null) {
    const bad = () => fail('Сервер не подтвердил подсказки Хью. Обновите переписку.', 'STAFF_ADVISORIES_INVALID');
    const keys = (object, expected) => plainObject(object) && Object.keys(object).length === expected.length && expected.every(k => own(object, k));
    if (!keys(value, ['schema', 'scopeKey', 'status', 'items', 'nextAfterThreadId']) || value.schema !== 1 || !['ready', 'unavailable'].includes(value.status) || value.scopeKey !== scopeKey || !/^[a-f0-9]{64}$/.test(scopeKey || '') ||
      !Array.isArray(value.items) || value.items.length > 60 || (after !== null && (typeof after !== 'number' || parsePositiveId(after) === null))) bad();
    if (value.status === 'unavailable' && value.items.length) bad();
    const cursor = value.nextAfterThreadId;
    if (!(cursor === null || typeof cursor === 'number' && parsePositiveId(cursor) !== null && (after === null || cursor > after))) bad();
    const seen = new Set(), items = [];
    for (const item of value.items) {
      if (!keys(item, ['key', 'kind', 'threadId', 'orderId', 'author', 'audience', 'state', 'text', 'basisAt', 'basis', 'actions']) ||
        typeof item.threadId !== 'number' || parsePositiveId(item.threadId) === null || typeof item.orderId !== 'number' || parsePositiveId(item.orderId) === null ||
        (after !== null && item.threadId <= after) || (cursor !== null && item.threadId > cursor) || item.author !== 'hugh' || item.audience !== 'staff' || item.state !== 'current' ||
        !['contact-followup', 'workflow'].includes(item.kind) || typeof item.key !== 'string' || item.key.length > 250 || seen.has(item.key) ||
        typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.text) ||
        typeof item.basisAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.basisAt) || !Number.isFinite(Date.parse(item.basisAt)) || new Date(item.basisAt).toISOString() !== item.basisAt ||
        !Array.isArray(item.actions) || item.actions.length < 1 || item.actions.length > 2) bad();
      const prefix = item.kind + ':thread:' + item.threadId + ':order:' + item.orderId;
      if (item.kind === 'contact-followup' ? item.basis !== 'due-at' || item.key !== prefix + ':due:' + Date.parse(item.basisAt) :
        !['stage-entered', 'order-created'].includes(item.basis) || !new RegExp('^' + prefix + ':stage:[a-z][a-z0-9_-]{0,39}:revision:[0-9]{1,10}$').test(item.key)) bad();
      const [order, contact] = item.actions;
      if (!keys(order, ['kind', 'ref']) || order.kind !== 'order' || order.ref !== 'native-order:' + item.orderId) bad();
      if (contact) {
        if (!keys(contact, ['kind', 'channel', 'value']) || contact.kind !== 'contact' || !['phone', 'telegram', 'whatsapp', 'max'].includes(contact.channel) ||
          typeof contact.value !== 'string' || !contact.value || contact.value !== contact.value.trim() || contact.value.length > 256 || /[\x00-\x1f\x7f]/.test(contact.value) ||
          (['phone', 'whatsapp'].includes(contact.channel) && !/^\+\d{10,15}$/.test(contact.value)) ||
          (contact.channel === 'telegram' && !/^(?:@|(?:https:\/\/)?t\.me\/)?[a-zA-Z][a-zA-Z0-9_]{4,31}\/?$/.test(contact.value) && !/^\+?\d{10,15}$/.test(contact.value)) || !contactLink(contact.channel, contact.value)) bad();
      }
      seen.add(item.key);
      items.push(Object.freeze({ ...item, actions: Object.freeze(item.actions.map(action => Object.freeze({ ...action }))) }));
    }
    items.sort((a, b) => a.basisAt.localeCompare(b.basisAt) || a.key.localeCompare(b.key));
    return Object.freeze({ schema: 1, scopeKey, status: value.status, items: Object.freeze(items), nextAfterThreadId: cursor });
  }
  function threadListQuery(input = {}) {
    const page = S.chatThreadPage(input), result = {};
    for (const key of ['before', 'limit']) if (own(page, key)) result[key] = String(page[key]);
    return result;
  }
  function conversationBody(body) { return { ...S.chatMessages(body), view: 'conversation-v1' }; }
  function parseCrmSummary(data, query) {
    const range = crmReportQuery(query);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
    const dateOf = (value) => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('Период CRM не распознан', 'BAD_RESPONSE'); return day.format(new Date(value)); };
    if (!plainObject(data) || dateOf(data.from) !== range.from || dateOf(data.to) !== range.to || Date.parse(data.from) > Date.parse(data.to) || data.expenses !== null || data.romi !== null || data.expensesScope !== 'global_unavailable' || !Array.isArray(data.sourceStats)) fail('Сводка CRM не относится к выбранному периоду или компании', 'BAD_RESPONSE');
    const number = (value, count = false) => { if (typeof value !== 'number' || !Number.isFinite(value) || (count && (!Number.isSafeInteger(value) || value < 0))) fail('Показатели CRM не распознаны', 'BAD_RESPONSE'); return value; };
    const sources = data.sourceStats.map((source) => {
      if (!plainObject(source) || typeof source.source !== 'string' || source.expenses !== null || source.romi !== null) fail('Источники CRM не распознаны', 'BAD_RESPONSE');
      return Object.freeze({ source: source.source, leads: number(source.leads, true), booked: number(source.booked, true), visited: number(source.visited, true), sales: number(source.sales, true), revenue: number(source.revenue), visits: number(source.visits, true), clicks: number(source.clicks, true), expenses: null, romi: null });
    });
    return Object.freeze({ from: range.from, to: range.to, revenue: number(data.revenue), visits: number(data.visits, true), clicks: number(data.clicks, true), expenses: null, romi: null, sourceStats: Object.freeze(sources) });
  }

  /* ---------- реестр операций: имя → относительный путь, auth-пространство, typed entity ----------
     proof: installed-read — ранее подтверждённое чтение установленного рабочего места; accepted-local — принят локально,
     native0; reviewed-not-enabled — проверенный модуль, включение на live не подтверждено. Это не разрешение на live. */
  const op = (o) => Object.freeze({ mutating: false, entity: null, body: null, query: null, ...o });
  const pathId = (ref) => encodeURIComponent(String(ref.id));
  const OPERATIONS = frozenMap({
    'staff.identity': op({ auth: 'cabinet', probe: true, method: 'GET', path: () => '/content/whoami', proof: 'installed-read', source: 'synapse ops/content/server.js:430' }),
    'native.orders.list': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', path: () => `/content/${CONTENT_SITE}/orders`,
      query: (q = {}) => { const out = {}; if (q.limit !== undefined) { if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > 100) fail('limit 1–100', 'VALIDATION'); out.limit = String(q.limit); }
        if (q.beforeId !== undefined) { const ref = q.beforeId; if (!ref || ref.ns !== 'native-order') fail('Курсор — native-order', 'NAMESPACE'); out.beforeId = String(ref.id); } return out; },
      proof: 'installed-read', source: 'E/server.js:1422' }),
    // Existing exact order read; checklistOrder performs SELECT only, no initialization or writes.
    'native.order.read': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', entity: 'native-order', path: (r) => `/content/${CONTENT_SITE}/orders/${pathId(r)}/checklist`, proof: 'installed-read', source: 'site-orders.js:583-589/server.js:1494-1495' }),
    'native.order.work': op({ auth: 'cabinet', cabinetPermission: 'crm.edit', method: 'PUT', entity: 'native-order', mutating: true, path: (r) => `/content/${CONTENT_SITE}/orders/${pathId(r)}/work`, body: S.work, proof: 'installed-read', source: 'E/server.js:1438' }),
    'native.order.checklist': op({ auth: 'cabinet', cabinetPermission: 'crm.edit', method: 'PUT', entity: 'native-order', mutating: true, path: (r) => `/content/${CONTENT_SITE}/orders/${pathId(r)}/checklist`, body: S.checklist, proof: 'installed-read', source: 'E/server.js:1426' }),
    'native.order.dialog': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', entity: 'native-order', path: (r) => `/content/${CONTENT_SITE}/orders/${pathId(r)}/dialog`, proof: 'installed-read', source: 'E/server.js:1451' }),
    // Готовый legacy aggregate непрочитанных менеджера (E/BASE/client-dialogs.js:940–948): { unread, … }. Единственный реальный unread.
    'legacy.bot.summary': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', path: () => `/content/${CONTENT_SITE}/client-bot`, proof: 'installed-read', source: 'E/BASE/client-dialogs.js:940' }),
    'legacy.list': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', path: () => `/content/${CONTENT_SITE}/client-dialogs`, proof: 'installed-read', source: 'E/palitra-work.js:55' }),
    'legacy.list.page': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', path: () => `/content/${CONTENT_SITE}/client-dialogs`, query: input => {
      const page = threadListQuery(input), result = {};
      if (own(page, 'before')) result.beforeId = page.before;
      if (own(page, 'limit')) result.limit = page.limit;
      return result;
    }, proof: 'reviewed-local', source: 'company-scoped-legacy-chat-list' }),
    'legacy.read': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', entity: 'legacy', path: (r) => `/content/${CONTENT_SITE}/client-dialogs/${pathId(r)}`, proof: 'installed-read', source: 'E/palitra-work.js:56' }),
    'legacy.reply': op({ auth: 'cabinet', cabinetPermission: 'crm.edit', method: 'POST', entity: 'legacy', mutating: true, path: (r) => `/content/${CONTENT_SITE}/client-dialogs/${pathId(r)}/reply`, body: S.legacyReply, proof: 'installed-read', source: 'E/server.js:1525' }),
    'thread.list': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', path: () => `/content/${CONTENT_SITE}/customer-threads`, proof: 'accepted-local', nativeDisabled: true, source: 'E/server.js:1466' }),
    'thread.list.page': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', path: () => `/content/${CONTENT_SITE}/customer-threads`, query: threadListQuery, proof: 'installed-read', nativeDisabled: true, source: 'site-widget-shared-thread-list' }),
    'thread.read': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', entity: 'thread', path: (r) => `/content/${CONTENT_SITE}/customer-threads/${pathId(r)}`, proof: 'accepted-local', nativeDisabled: true, source: 'E/server.js:1469' }),
    'thread.conversation': op({ auth: 'cabinet', cabinetPermission: 'crm.view', method: 'GET', entity: 'thread', path: (r) => `/content/${CONTENT_SITE}/customer-threads/${pathId(r)}`, query: conversationQuery, proof: 'accepted-local', nativeDisabled: true, source: 'conversation-v1' }),
    'thread.reply': op({ auth: 'cabinet', cabinetPermission: 'crm.edit', method: 'POST', entity: 'thread', mutating: true, path: (r) => `/content/${CONTENT_SITE}/customer-threads/${pathId(r)}/reply`, body: S.threadReply, proof: 'accepted-local', nativeDisabled: true, source: 'E/server.js:1472' }),
    'cabinet.crm.summary': op({ auth: 'cabinet', cabinetSummary: true, method: 'GET', path: () => '/content/crm/summary', query: crmReportQuery, proof: 'accepted-local', source: 'content/server.js:774-788; crm/server.js:3333-3364' }),
    'portal.bootstrap': op({ auth: 'portal', probe: true, method: 'GET', path: () => '/api/crm/bootstrap', proof: 'reviewed-not-enabled', source: 'P/api-routes.js:22' }),
    'portal.order.detail': op({ auth: 'portal', method: 'GET', entity: 'crm-order', path: (r) => `/api/crm/orders/${pathId(r)}`, proof: 'reviewed-not-enabled', source: 'P/api-routes.js:57' }),
    'portal.order.action': op({ auth: 'portal', portalRole: ['owner', 'admin'], method: 'POST', entity: 'crm-order', mutating: true, path: (r) => `/api/crm/orders/${pathId(r)}/action`, body: S.orderAction, proof: 'reviewed-not-enabled', source: 'P/workspace.js:719' }),
    'portal.inquiry.detail': op({ auth: 'portal', portalRole: ['owner', 'admin'], method: 'GET', entity: 'crm-inquiry', path: (r) => `/api/crm/inquiries/${pathId(r)}`, proof: 'reviewed-not-enabled', source: 'P/api-routes.js:49' }),
    'portal.customer.detail': op({ auth: 'portal', portalRole: ['owner', 'admin'], method: 'GET', entity: 'crm-customer', path: (r) => `/api/crm/customers/${pathId(r)}`, proof: 'reviewed-not-enabled', source: 'P/api-routes.js:64' }),
    'portal.summary': op({ auth: 'portal', portalRole: ['owner'], method: 'GET', path: () => '/api/crm/summary', proof: 'reviewed-not-enabled', source: 'P/workspace.js:902' }),
    'shop.request.create': op({ auth: 'shop', method: 'POST', mutating: true, path: () => '/api/orders', body: S.shopRequest, proof: 'installed-read', source: 'E/BASE/site-orders.js:172' }),
    // Сессия аккаунта магазина (гость или вошедший покупатель): { user|null, csrf } — тот же маршрут, что crm-session.js siteCsrf.
    'account.session': op({ auth: 'shop', method: 'GET', path: () => '/api/draft-account/session', proof: 'installed-read', source: 'E/BASE/draft-account-service.cjs:65' }),
    'customer.chat.session': op({ auth: 'account', method: 'POST', mutating: true, path: () => '/api/customer-chat/session', body: S.empty, proof: 'accepted-local', nativeDisabled: true, source: 'E/customer-chat-http.cjs:190' }),
    'customer.chat.threads': op({ auth: 'chat', method: 'POST', path: () => '/api/customer-chat/threads', body: S.empty, proof: 'accepted-local', nativeDisabled: true, source: 'E/customer-chat-http.cjs:204' }),
    'customer.chat.threads.page': op({ auth: 'chat', method: 'POST', path: () => '/api/customer-chat/threads', body: S.chatThreadPage, proof: 'accepted-local', nativeDisabled: true, source: 'E/customer-chat-http.cjs:204' }),
    'customer.chat.messages': op({ auth: 'chat', method: 'POST', path: () => '/api/customer-chat/messages', body: S.chatMessages, proof: 'accepted-local', nativeDisabled: true, source: 'E/customer-chat-http.cjs:205' }),
    'customer.chat.conversation': op({ auth: 'chat', method: 'POST', path: () => '/api/customer-chat/messages', body: conversationBody, proof: 'accepted-local', nativeDisabled: true, source: 'conversation-v1' }),
    'customer.chat.send': op({ auth: 'chat', method: 'POST', mutating: true, path: () => '/api/customer-chat/message', body: S.chatMessage, proof: 'accepted-local', nativeDisabled: true, source: 'E/customer-chat-http.cjs:206' }),
  });
  // Ссылки на штатные экраны (не вызовы API): редакторы — origin Synapse, каталог и сайт — origin магазина.
  const LINKS = frozenMap({
    'customer.chat.open': Object.freeze({ origin: 'shop', path: '/chat/widget', title: 'Чат с Palitra Love', capability: 'customer.chat' }),
    'editor.catalog.open': Object.freeze({ origin: 'synapse', path: COMPANY_CODE === 'palitra-love' ? '/price-editor-palitra.html?site=https%3A%2F%2Fpalitra-love.ru&v=20261022-category-photo-r1' : `/price-editor.html?site=${CONTENT_SITE}`, title: 'Товары и прайс Palitra', capability: 'editor.catalog' }),
    'editor.photos.open': Object.freeze({ origin: 'synapse', path: `/cabinet/site-photos.html?company=${COMPANY_CODE}&site=${CONTENT_SITE}`, title: 'Фото сайта Palitra', capability: 'editor.photos' }),
    'catalog.open': Object.freeze({ origin: 'shop', path: COMPANY_CODE === 'palitra-love' ? '/catalog' : '/price.html', title: 'Каталог Palitra Love', capability: 'shop' }),
    'site.open': Object.freeze({ origin: 'shop', path: '/', title: 'Сайт Palitra Love', capability: 'shop' }),
  });
  const ORIGINS = frozenMap({ synapse: 'https://synapse.synapsebusiness.ru', shop: company.origin });
  const linkUrl = (name) => { if (!own(LINKS, name)) fail('Неизвестная ссылка', 'UNKNOWN_LINK'); const l = LINKS[name]; return `${ORIGINS[l.origin]}${l.path}`; };

  /* ---------- разбор ответов ---------- */
  function parseIdentity(data) {
    if (!plainObject(data) || typeof data.userId !== 'string' && typeof data.userId !== 'number') fail('Ответ whoami не распознан', 'BAD_RESPONSE');
    if (!CABINET_ROLES.includes(data.role)) fail('Неизвестная роль кабинета', 'BAD_ROLE');
    // Канонический whoami (auth-store decorate): companies[] = { id: code, ... }. Строка — явная совместимость; .code не читается.
    const companies = Array.isArray(data.companies) ? data.companies.map((c) => (c && typeof c === 'object' && typeof c.id === 'string' ? c.id : typeof c === 'string' ? c : null)).filter((c) => typeof c === 'string' && c) : [];
    const permissions = Array.isArray(data.permissions) ? data.permissions.filter((p) => typeof p === 'string') : [];
    if (typeof data.csrfToken !== 'string' || !data.csrfToken) fail('Нет CSRF кабинета', 'NO_CSRF');
    return Object.freeze({ userId: String(data.userId), login: typeof data.login === 'string' ? data.login : '', displayName: typeof data.displayName === 'string' ? data.displayName : '',
      role: data.role, companies: Object.freeze(companies), permissions: Object.freeze(permissions), member: companies.includes(COMPANY_CODE), csrfToken: data.csrfToken });
  }
  // { user: {id}|null, csrf } → непрозрачная ссылка аккаунта (вошедший — UUID пользователя, гость — без идентификатора) и CSRF.
  function parseAccountSession(data) {
    if (!plainObject(data) || typeof data.csrf !== 'string' || !data.csrf) fail('Сессия магазина не распознана', 'BAD_RESPONSE');
    const user = plainObject(data.user) && typeof data.user.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.user.id) ? data.user : null;
    return Object.freeze({ signedIn: Boolean(user), opaque: user ? user.id : 'guest-session', csrf: data.csrf });
  }
  function parsePortalActor(data) {
    const actor = plainObject(data) ? data.actor : null;
    if (!plainObject(actor) || !PORTAL_ROLES.includes(actor.role) || (typeof actor.id !== 'string' && typeof actor.id !== 'number')) fail('Ответ portal не распознан', 'BAD_ROLE');
    return Object.freeze({ id: String(actor.id), name: typeof actor.name === 'string' ? actor.name : '', role: actor.role });
  }
  /* Канонические ответы CRM (P workspace.js:880, :855): GET /orders/N → { order }; POST /orders/N/action →
     { ok:true, replayed, order }. Разворачиваются только с проверкой: order — объект, id ровно запрошенный crm-order:N,
     stage из серверного списка. Сырой order без обёртки, чужой id или битая форма — отказ. */
  function checkedCrmOrder(order, ref) {
    if (!ref || ref.ns !== 'crm-order') fail('Ожидался crm-order', 'NAMESPACE');
    if (!plainObject(order) || order.id !== ref.id || !CRM_STAGES.includes(order.stage) || typeof order.status !== 'string') fail('Ответ CRM не относится к запрошенному заказу', 'BAD_RESPONSE');
    return order;
  }
  function parseCrmOrder(data, ref) {
    if (!plainObject(data) || !own(data, 'order')) fail('Ответ CRM без обёртки { order }', 'BAD_RESPONSE');
    return checkedCrmOrder(data.order, ref);
  }
  function parseCrmAction(data, ref) {
    if (!plainObject(data) || data.ok !== true || typeof data.replayed !== 'boolean' || !own(data, 'order')) fail('Квитанция действия CRM не распознана', 'BAD_RESPONSE');
    return { replayed: data.replayed, order: checkedCrmOrder(data.order, ref) };
  }
  // GET orders/:id/dialog → только согласованные пары; legacy без dialogRef допустим (прежний формат, E palitra-work.js:582–600).
  function parseOrderLinks(data) {
    const out = { thread: null, legacy: null, error: '' };
    if (!plainObject(data)) { out.error = 'Ответ не распознан'; return out; }
    const given = (value) => value !== null && value !== undefined;
    if (given(data.threadId) || given(data.threadRef)) {
      const ref = typeof data.threadId === 'number' ? makeRef('thread', data.threadId) : null;
      if (ref && data.threadRef === refKey(ref)) out.thread = ref;
      else out.error = 'Сервер вернул несогласованную ссылку на чат сайта — переписка не открыта.';
    }
    if (given(data.dialogId) || given(data.dialogRef)) {
      const ref = typeof data.dialogId === 'number' ? makeRef('legacy', data.dialogId) : null;
      if (ref && (!given(data.dialogRef) || data.dialogRef === refKey(ref))) out.legacy = ref;
      else out.error = 'Сервер вернул несогласованную ссылку на переписку в боте — переписка не открыта.';
    }
    return out;
  }
  // Квитанция — только точная: legacy {ok, dialogId, messageId}; thread/чат сайта {ok, threadId, message.id}; заявка {orderId, requestId}.
  /* Квитанция общей заявки (E submitWithChat): { ok, orderId, requestId[, chat:{threadId}] } → typed native-order и thread.
     requestId обязан совпасть с отправленным. Чат — только если его threadId корректен; иначе thread=null (заявка уже могла
     записаться: повторной отправки нет, данные перечитываются). */
  function parseShopReceipt(data, requestId) {
    if (!plainObject(data) || data.ok !== true || data.requestId !== requestId || !Number.isSafeInteger(data.orderId) || data.orderId < 1) fail('Квитанция заявки не распознана', 'BAD_RESPONSE');
    const chat = plainObject(data.chat) && typeof data.chat.threadId === 'number' ? makeRef('thread', data.chat.threadId) : null;
    return Object.freeze({ order: makeRef('native-order', data.orderId), thread: chat, chatMissing: !chat, duplicate: data.duplicate === true });
  }
  /* Собственные заявки покупателя (P bootstrap.requests): { id, createdAt, status } → crm-inquiry; siteOrderId — только если
     backend его вернул (кандидат native-delta), иначе связи с native/чатом нет. */
  function parsePortalRequests(data) {
    const list = plainObject(data) && Array.isArray(data.requests) ? data.requests : [];
    return list.filter((r) => plainObject(r) && typeof r.id === 'number' && parsePositiveId(r.id) !== null).map((r) => Object.freeze({
      ref: makeRef('crm-inquiry', r.id), createdAt: typeof r.createdAt === 'string' ? r.createdAt : '', status: typeof r.status === 'string' ? r.status : '',
      site: typeof r.siteOrderId === 'number' ? makeRef('native-order', r.siteOrderId) : null }));
  }
  // Legacy unread: конечное целое ≥ 0, иначе 0.
  const parseUnread = (data) => (plainObject(data) && Number.isSafeInteger(data.unread) && data.unread > 0 ? data.unread : 0);
  function receiptOk(kind, target, data, requestId) {
    if (!plainObject(data) || data.ok !== true) return false;
    if (kind === 'legacy') return data.dialogId === target.id && Number.isSafeInteger(data.messageId) && data.messageId > 0;
    if (kind === 'thread' || kind === 'chat') return data.threadId === target.id && plainObject(data.message) && Number.isSafeInteger(data.message.id) && data.message.id > 0;
    if (kind === 'shop') return Number.isSafeInteger(data.orderId) && data.orderId > 0 && data.requestId === requestId;
    return false;
  }

  /* ---------- форма K01 → POST /api/orders (kind=request) ----------
     Канонические поля: name, channel, contact, consent. UI «Звонок» = native phone. Telegram в native — только @ник;
     телефон в Telegram и ВКонтакте пока не поддерживаются native-контрактом: значение остаётся в черновике формы,
     отправка блокируется с подсказкой (need-contract-extension). Согласие не угадывается — только явное true. */
  const FORM_CHANNEL_TO_NATIVE = frozenMap({ call: 'phone', telegram: 'telegram', whatsapp: 'whatsapp', max: 'max', vk: null });
  const SHOP_BODY_FIELDS = new Set(['requestId', 'kind', 'name', 'phone', 'comment', 'consent', 'items', 'occasion', 'date', 'page', 'utm', 'website',
    'contactChannel', 'contact', 'telegramUsername', 'deliveryAddress', 'deliveryDate', 'deliveryInterval']);
  const phoneDigits = (value) => { const d = String(value).replace(/\D/g, ''); return d.length === 11 && d.startsWith('8') ? `7${d.slice(1)}` : d; };
  const validPhone = (value) => typeof value === 'string' && value.length <= 32 && /^[+\d\s().-]+$/.test(value) && /^\d{10,15}$/.test(phoneDigits(value));
  const TELEGRAM_NICK = /^@?[a-z][a-z0-9_]{4,31}$/i;
  function validateShopRequest(body) {
    if (!plainObject(body)) fail('Ожидался объект', 'VALIDATION');
    for (const key of Object.keys(body)) if (!SHOP_BODY_FIELDS.has(key)) fail(`Неизвестное поле ${key}`, 'VALIDATION');
    requestIdOf(body.requestId);
    if (body.kind !== 'request') fail('Оболочка отправляет только заявку kind=request', 'VALIDATION');
    if (!Array.isArray(body.items) || body.items.length) fail('Для заявки с формы состав не передаётся', 'VALIDATION');
    cleanText(body.name, 80, 'Имя');
    if (own(body, 'comment') && (typeof body.comment !== 'string' || body.comment.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(body.comment)))
      fail('Ответы формы должны быть текстом не длиннее 1000 символов.', 'VALIDATION');
    if (!own(NATIVE_CHANNELS, body.contactChannel)) fail('Выберите способ связи', 'VALIDATION');
    if (body.consent !== true) fail('Нужно согласие на обработку данных', 'CONSENT');
    if ((body.contactChannel === 'phone' || body.contactChannel === 'whatsapp') && !validPhone(body.contact)) fail('Укажите телефон', 'VALIDATION');
    if (body.contactChannel === 'telegram' && !TELEGRAM_NICK.test(String(body.contact)) && !validPhone(String(body.contact))) fail('Укажите номер телефона или Telegram @ник', 'VALIDATION');
    return { ...body };
  }
  function sanitizeUtm(raw) {
    const out = {};
    if (!plainObject(raw)) return out;
    for (const key of UTM_KEYS) {
      const value = typeof raw[key] === 'string' ? raw[key].trim().slice(0, 200) : '';
      // Без контактов и адресов: «@», «:»/«/» (URL), 7+ цифр в сумме (телефон в любом оформлении).
      if (value && /^[\w.\-~ а-яА-ЯёЁ]+$/.test(value) && !value.includes('@') && value.replace(/\D/g, '').length < 7) out[key] = value;
    }
    return out;
  }
  /**
   * @param {object} form  { name, channel, contact, consent, extra? }  — значения формы (черновик не меняется)
   * @param {object} opts  { requestId, utm, page }
   * @returns {{ok:true, body} | {ok:false, reasons:string[], codes:string[], unmapped:string[]}}
   */
  function buildShopRequest(form, { requestId, utm, page } = {}) {
    const reasons = [], codes = [], unmapped = [];
    const f = plainObject(form) ? form : {};
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name) { reasons.push('Напишите, как вас зовут.'); codes.push('NAME'); }
    else if (name.length > 80) { reasons.push('Имя длиннее 80 символов.'); codes.push('NAME'); }
    const contact = typeof f.contact === 'string' ? f.contact.trim() : '';
    const channel = own(FORM_CHANNEL_TO_NATIVE, f.channel) ? f.channel : '';
    const native = channel ? FORM_CHANNEL_TO_NATIVE[channel] : null;
    if (!channel) { reasons.push('Выберите способ связи.'); codes.push('CHANNEL'); }
    else if (native === null) { reasons.push('ВКонтакте пока не поддерживается заявкой Synapse. Контакт сохранён в форме; выберите другой способ связи или дождитесь подключения.'); codes.push('NEED_CONTRACT_EXTENSION'); }
    if (!contact) { reasons.push('Укажите контакт.'); codes.push('CONTACT'); }
    else if (native === 'telegram' && !TELEGRAM_NICK.test(contact) && !validPhone(contact)) {
      reasons.push('Укажите номер телефона (10–15 цифр) или Telegram @ник (от 5 символов).'); codes.push('CONTACT');
    } else if ((native === 'phone' || native === 'whatsapp') && !validPhone(contact)) { reasons.push('Укажите номер телефона: 10–15 цифр.'); codes.push('CONTACT'); }
    else if (native === 'max' && (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(contact) || (/:/.test(contact) && !/^https:\/\//i.test(contact)))) { reasons.push('Укажите контакт MAX без e-mail и небезопасных ссылок.'); codes.push('CONTACT'); }
    if (f.consent !== true) { reasons.push('Отметьте согласие на обработку данных.'); codes.push('CONSENT'); }
    let comment = '';
    if (own(f, 'comment')) {
      if (typeof f.comment !== 'string' || f.comment.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(f.comment)) {
        reasons.push('Ответы формы должны быть текстом не длиннее 1000 символов. Введённые данные сохранены.'); codes.push('COMMENT');
      } else comment = f.comment.trim();
    }
    if (plainObject(f.extra)) for (const [key, value] of Object.entries(f.extra)) if (value !== '' && value !== undefined && value !== null) unmapped.push(key);
    if (unmapped.length) { reasons.push(`Дополнительные поля пока не связаны с заявкой Synapse и не отправляются: ${unmapped.join(', ')}. Они сохранены в форме.`); codes.push('UNMAPPED_FIELDS'); }
    if (reasons.length) return { ok: false, reasons, codes, unmapped };
    if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) return { ok: false, reasons: ['Нет requestId попытки'], codes: ['REQUEST_ID'], unmapped };
    const telegramPhone = native === 'telegram' && validPhone(contact);
    const body = { requestId, kind: 'request', name, contactChannel: native,
      contact: native === 'telegram' ? (telegramPhone ? `+${phoneDigits(contact)}` : `@${contact.replace(/^@/, '')}`.toLowerCase()) : contact,
      consent: true, items: [] };
    if (comment) body.comment = comment;
    if (native === 'phone' || native === 'whatsapp') body.phone = contact;
    if (telegramPhone) body.phone = body.contact;
    if (native === 'telegram' && !telegramPhone) body.telegramUsername = body.contact;
    const cleanUtm = sanitizeUtm(utm);
    if (Object.keys(cleanUtm).length) body.utm = cleanUtm;
    if (typeof page === 'string' && /^\/[\w\-./]{0,200}$/.test(page)) body.page = page;
    validateShopRequest(body);
    return { ok: true, body };
  }
  // Отпечаток смысла попытки: тот же requestId допустим только для того же содержимого.
  const fingerprintOf = (body) => JSON.stringify(Object.keys(body).filter((k) => k !== 'requestId').sort().map((k) => [k, body[k]]));

  /* ---------- безопасные ссылки связи (по явному нажатию) ---------- */
  function contactLink(channel, raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return null;
    const digits = validPhone(value) ? phoneDigits(value) : '';
    if (channel === 'telegram' || channel === 'telegram_id') {
      const nick = /^(?:@|(?:https:\/\/)?t\.me\/)?([a-zA-Z][a-zA-Z0-9_]{4,31})\/?$/.exec(value);
      if (nick) return { kind: 'url', href: `https://t.me/${nick[1]}` };
      return digits ? { kind: 'url', href: `https://t.me/+${digits}` } : null;
    }
    if (channel === 'whatsapp') return digits ? { kind: 'url', href: `https://wa.me/${digits}` } : null;
    if (channel === 'phone' || channel === 'call') return digits ? { kind: 'tel', href: `tel:+${digits}` } : null;
    if (channel === 'vk') { const vk = /^(?:(?:https:\/\/)?(?:www\.|m\.)?vk\.com\/)?([a-zA-Z][a-zA-Z0-9_.]{1,63})\/?$/.exec(value); return vk ? { kind: 'url', href: `https://vk.com/${vk[1]}` } : null; }
    if (channel === 'max') return { kind: 'copy', text: value };
    return null;
  }

  /* ---------- права и доступность (только из ответов backend) ---------- */
  function capabilities(auth = {}) {
    const cab = auth.cabinet || null, portal = auth.portal || null, chat = auth.chat || null;
    const cabMember = Boolean(cab && cab.member);
    const has = (p) => Boolean(cab && (cab.role === 'owner' || cab.permissions.includes(p)));
    return Object.freeze({
      'cabinet.summary': canCrmSummary(cab),
      'native.orders': cabMember && has('crm.view'),
      'native.write': cabMember && has('crm.edit'),          // принятый backend: заявки/диалоги — только owner кабинета
      // Чат сайта E/R1 принят локально, native0: до установки — «accepted-local», не «подключено».
      'native.threads': COMPANY_CODE === 'palitra-love' && cabMember && has('crm.view') ? (auth.e1Native === true ? true : 'accepted-local') : false,
      'portal.staff': Boolean(portal && ['owner', 'admin'].includes(portal.role)),
      'portal.customer': Boolean(portal && portal.role === 'customer'),
      'portal.summary': Boolean(portal && portal.role === 'owner'), // отчёт — только portal owner, не owner кабинета
      'editor.catalog': cabMember && (has('price.view') || has('price.edit')),
      'editor.photos': COMPANY_CODE === 'palitra-love' && cabMember ? 'delegated' : false,             // редактор фото сам проверяет per-site grant
      'customer.chat': Boolean(chat && chat.ready),
      shop: true,
    });
  }

  /* ---------- мост: проверки до транспорта ---------- */
  function createBridge({ transport, getAuth } = {}) {
    if (!transport || typeof transport.send !== 'function') fail('Нужен внедрённый транспорт', 'NO_TRANSPORT');
    if (typeof getAuth !== 'function') fail('Нужен источник auth-контекста', 'NO_AUTH');
    async function call(name, { ref = null, body, query } = {}, context = {}) {
      if (typeof name !== 'string' || !own(OPERATIONS, name)) fail('Операция не подключена к оболочке', 'UNKNOWN_OPERATION');
      const operation = OPERATIONS[name];
      if (COMPANY_CODE !== 'palitra-love' && (operation.auth !== 'cabinet' || name.startsWith('thread.') || name === 'legacy.reply')) fail('Эта функция ещё не подключена для выбранной компании', 'NOT_CONNECTED');
      if (operation.entity) {
        // Только typed ref из makeRef/parseRef: id — число, не строка и не «голое» значение.
        if (!ref || typeof ref !== 'object' || ref.ns !== operation.entity || typeof ref.id !== 'number' || parsePositiveId(ref.id) === null) fail(`Нужен идентификатор ${operation.entity}`, 'NAMESPACE');
      } else if (ref) fail('Операция не принимает идентификатор', 'NAMESPACE');
      if (!operation.body && body !== undefined) fail('Операция без тела', 'VALIDATION');
      const auth = getAuth();
      // Пробные операции (whoami, bootstrap) требуют только сессию своего пространства: роль приходит из их ответа.
      const space = operation.probe ? (auth[`${operation.auth}Session`] ? {} : null) : auth[operation.auth];
      if (operation.auth !== 'shop' && !space) fail('Нет подключённого доступа для этой операции', 'NOT_CONNECTED');
      if (operation.cabinetRole && (!space.member || space.role !== operation.cabinetRole)) fail('Доступно только владельцу кабинета Palitra', 'FORBIDDEN');
      if (operation.cabinetPermission && (!space.member || (space.role !== 'owner' && (!Array.isArray(space.permissions) || !space.permissions.includes(operation.cabinetPermission))))) fail('Нет нужного права CRM Palitra Love', 'FORBIDDEN');
      if (operation.cabinetSummary && !canCrmSummary(space)) fail('Нет права просмотра сводки CRM Palitra Love', 'FORBIDDEN', 403);
      if (operation.portalRole && !operation.portalRole.includes(space.role)) fail('Недоступно для этой роли portal', 'FORBIDDEN');
      const request = { operation: name, method: operation.method, path: operation.path(ref), auth: operation.auth, mutating: operation.mutating,
        ref, body: operation.body ? operation.body(body === undefined ? {} : body, context) : undefined,
        query: operation.query ? operation.query(query) : undefined, proof: operation.proof, nativeDisabled: Boolean(operation.nativeDisabled) };
      return transport.send(Object.freeze(request), auth);
    }
    return Object.freeze({ call });
  }

  /* ---------- транспорт: mock (только память) ---------- */
  function createMockTransport(service) {
    if (!service || typeof service.handle !== 'function') fail('Нужен mock-сервис', 'NO_MOCK');
    return Object.freeze({ kind: 'mock', send: (request, auth) => service.handle(request, auth) });
  }

  /* ---------- транспорт: native (внедрённый fetch и проверенный host context) ----------
     host: { origin, allowNetwork, e1Native, cabinet:{csrfToken}, portal:{token()}, account:{csrf}, chat:{csrf} }.
     Без allowNetwork===true и без совпадения origin с разрешённым адресом функции — отказ до fetch. */
  function createNativeTransport({ fetch: injectedFetch, host } = {}) {
    if (typeof injectedFetch !== 'function') fail('Native-транспорт требует внедрённый fetch', 'NO_FETCH');
    if (!host || typeof host !== 'object') fail('Native-транспорт требует host context', 'NO_HOST');
    const expectedOrigin = (auth) => (auth === 'cabinet' ? ORIGINS.synapse : auth === 'portal' ? host.portalOrigin : ORIGINS.shop);
    /* Транспорт — не универсальный прокси: каждый запрос заново сверяется с замороженным реестром ДО сети и заголовков.
       Операция обязана существовать; auth/method/mutating — ровно из реестра; путь — ровно op.path(typed ref), только
       относительный; query — limit/beforeId цифрами либо фиксированные компания/даты cabinet.crm.summary; тело — снова через serializer операции (точные ключи). */
    function verified(request) {
      if (!plainObject(request) || typeof request.operation !== 'string' || !own(OPERATIONS, request.operation)) fail('Операция не из реестра', 'UNKNOWN_OPERATION');
      const operation = OPERATIONS[request.operation];
      if (request.auth !== operation.auth || request.method !== operation.method || Boolean(request.mutating) !== operation.mutating) fail('Запрос не совпадает с описанием операции', 'DESCRIPTOR_MISMATCH');
      let ref = null;
      if (operation.entity) {
        const r = request.ref;
        if (!r || typeof r !== 'object' || r.ns !== operation.entity || typeof r.id !== 'number' || parsePositiveId(r.id) === null) fail(`Нужен идентификатор ${operation.entity}`, 'NAMESPACE');
        ref = makeRef(r.ns, r.id);
      } else if (request.ref) fail('Операция не принимает идентификатор', 'NAMESPACE');
      const path = operation.path(ref);
      if (typeof request.path !== 'string' || request.path !== path || !path.startsWith('/') || path.startsWith('//') || /[\\:]/.test(path.split('?')[0])) fail('Адрес запроса не совпадает с реестром', 'DESCRIPTOR_MISMATCH');
      let query;
      if (request.operation === 'cabinet.crm.summary' && request.query === undefined) fail('Для сводки обязательны компания и период', 'DESCRIPTOR_MISMATCH');
      if (request.operation === 'thread.conversation' && request.query === undefined) fail('Не указан вид переписки', 'DESCRIPTOR_MISMATCH');
      if (request.query !== undefined) {
        if (!operation.query || !plainObject(request.query)) fail('Операция без параметров адреса', 'DESCRIPTOR_MISMATCH');
        if (request.operation === 'cabinet.crm.summary') {
          query = crmReportQuery(request.query);
          if (!own(request.query, 'companyCode')) fail('Нет фиксированной компании CRM', 'DESCRIPTOR_MISMATCH');
        } else if (request.operation === 'thread.list.page') {
          exactKeys(request.query, [], ['before', 'limit']);
          const parsed = {};
          for (const [key, value] of Object.entries(request.query)) {
            if (typeof value !== 'string' || !/^[1-9]\d{0,14}$/.test(value) || parsePositiveId(value) === null) fail('Недопустимый курсор переписки', 'DESCRIPTOR_MISMATCH');
            parsed[key] = Number(value);
          }
          query = threadListQuery(parsed);
        } else if (request.operation === 'thread.conversation') {
          exactKeys(request.query, ['view'], ['before', 'limit', 'adviceAfter']);
          if (request.query.view !== 'conversation-v1') fail('Неизвестный вид переписки', 'DESCRIPTOR_MISMATCH');
          const parsed = {};
          for (const field of ['before', 'limit', 'adviceAfter']) if (own(request.query, field)) {
            const value = request.query[field];
            if (typeof value !== 'string' || !/^[1-9]\d{0,14}$/.test(value) || parsePositiveId(value) === null) fail('Недопустимый параметр адреса', 'DESCRIPTOR_MISMATCH');
            parsed[field] = Number(value);
          }
          query = conversationQuery(parsed);
        } else {
          for (const [k, v] of Object.entries(request.query)) if (!['limit', 'beforeId'].includes(k) || typeof v !== 'string' || !/^[1-9]\d{0,14}$/.test(v)) fail('Недопустимый параметр адреса', 'DESCRIPTOR_MISMATCH');
          query = { ...request.query };
        }
      }
      let body;
      if (operation.body) {
        if (request.body === undefined) fail('Нет тела запроса', 'DESCRIPTOR_MISMATCH');
        // orderAction: повторная проверка ключей без контекста карточки (контекст уже проверен мостом).
        if (request.operation === 'customer.chat.conversation') {
          exactKeys(request.body, ['threadId', 'view'], ['before', 'limit']);
          if (request.body.view !== 'conversation-v1') fail('Неизвестный вид переписки', 'DESCRIPTOR_MISMATCH');
          const { view, ...input } = request.body;
          body = conversationBody(input);
        } else body = request.operation === 'portal.order.action' ? recheckOrderAction(request.body) : operation.body(request.body);
      } else if (request.body !== undefined) fail('Операция без тела', 'DESCRIPTOR_MISMATCH');
      return Object.freeze({ operation: request.operation, auth: operation.auth, method: operation.method, mutating: operation.mutating, path, query, body,
        nativeDisabled: Boolean(operation.nativeDisabled) });
    }
    function recheckOrderAction(body) {
      if (!plainObject(body)) fail('Ожидался объект', 'VALIDATION');
      if (body.action === 'stage') { exactKeys(body, ['requestId', 'action', 'version', 'value']); requestIdOf(body.requestId); if (!CRM_STAGES.includes(body.value) || !Number.isSafeInteger(body.version)) fail('Некорректный этап', 'VALIDATION'); return { ...body }; }
      if (body.action === 'note') { exactKeys(body, ['requestId', 'action', 'text']); requestIdOf(body.requestId); return { requestId: body.requestId, action: 'note', text: cleanText(body.text, 2000, 'Заметка') }; }
      return fail('Это действие CRM не подключено к оболочке', 'ACTION_NOT_CONNECTED');
    }
    async function send(raw) {
      const request = verified(raw);
      if (COMPANY_CODE !== 'palitra-love' && (request.auth !== 'cabinet' || request.operation.startsWith('thread.') || request.operation === 'legacy.reply')) fail('Эта функция ещё не подключена для выбранной компании', 'NOT_CONNECTED');   // до allowNetwork/origin/заголовков: посторонний адрес не доходит даже до подготовки
      if (host.allowNetwork !== true) fail('Сеть выключена в этой сборке: native-подключение — отдельная интеграция Root', 'NATIVE_DISABLED');
      if (request.nativeDisabled && host.e1Native !== true) fail('Чат сайта E/R1 ещё не установлен на сервере (native0)', 'NATIVE_DISABLED');
      const origin = expectedOrigin(request.auth);
      if (!origin || host.origin !== origin) fail('Страница открыта не на разрешённом адресе этой функции', 'ORIGIN');
      // Portal через штатный crm-session.js (window.PalitraSession): токен остаётся в его замыкании, путь /api/crm/X → /api/X.
      if (request.auth === 'portal' && host.portal && typeof host.portal.request === 'function') {
        try { return await host.portal.request(request.path.replace(/^\/api\/crm\//, '/api/'), { method: request.method, body: request.body }); }
        catch (error) {
          const status = Number(error && error.status) || 0;
          if (status === 401) fail('Сессия завершена', 'SESSION_ENDED', 401);
          if (status === 403) fail('Доступ закрыт', 'FORBIDDEN', 403);
          if (status === 409) fail((error && error.message) || 'Данные изменились', 'CONFLICT', 409);
          if (request.mutating && (status === 0 || status >= 500 || (error && /unknown|unreadable/.test(String(error.code))))) fail('Исход записи неизвестен', 'UNKNOWN_OUTCOME', status);
          fail((error && error.message) || 'Ошибка portal', 'FAILED', status);
        }
      }
      const headers = { Accept: 'application/json' };
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';
      if (request.auth === 'cabinet' && request.mutating) { if (!host.cabinet || !host.cabinet.csrfToken) fail('Нет CSRF кабинета', 'NO_CSRF'); headers['X-CSRF-Token'] = host.cabinet.csrfToken; }
      if (request.auth === 'portal') { const token = host.portal && typeof host.portal.token === 'function' ? host.portal.token() : ''; if (!/^pcrm\.[A-Za-z0-9_-]{43}$/.test(token)) fail('Нет сессии portal', 'NO_SESSION'); headers.Authorization = `Bearer ${token}`; }
      if (request.auth === 'account') { if (!host.account || !host.account.csrf) fail('Нет CSRF аккаунта магазина', 'NO_CSRF'); headers['X-CSRF-Token'] = host.account.csrf; }
      if (request.auth === 'chat') { if (!host.chat || !host.chat.csrf) fail('Нет сессии чата', 'NO_SESSION'); headers['X-Palitra-Chat-CSRF'] = host.chat.csrf; }
      /* Общая заявка (POST /api/orders): та же отправка несёт контекст вошедшего покупателя и его чата —
         X-CSRF-Token аккаунта (P buyerSession) и X-Palitra-Chat-CSRF (E orderContext → submitWithChat). Без обоих — отказ до сети:
         гостевая/без-чата заявка молча не уходит под видом общей. Токены только в заголовках, не в теле/URL. */
      if (request.operation === 'shop.request.create') {
        if (!host.account || !host.account.csrf) fail('Войдите в аккаунт магазина: без него заявка не появится в вашем кабинете', 'ACCOUNT_REQUIRED');
        if (host.e1Native !== true || !host.chat || !host.chat.csrf) fail('Чат сайта не готов: общая заявка с перепиской пока не отправляется', 'CHAT_REQUIRED');
        headers['X-CSRF-Token'] = host.account.csrf;
        headers['X-Palitra-Chat-CSRF'] = host.chat.csrf;
      }
      const search = request.query && Object.keys(request.query).length ? `?${new URLSearchParams(request.query).toString()}` : '';
      let res;
      try {
        res = await injectedFetch(`${request.path}${search}`, { method: request.method, headers, body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin' });
      } catch (_) {
        // Исход записи неизвестен: тот же requestId и тело остаются у вызывающего.
        fail(request.mutating ? 'Нет ответа сервера — исход неизвестен. Проверьте и повторите ту же отправку.' : 'Нет связи с сервером', request.mutating ? 'UNKNOWN_OUTCOME' : 'NETWORK');
      }
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (res.status === 401 || res.status === 403) fail(res.status === 401 ? 'Сессия завершена' : 'Доступ закрыт', res.status === 401 ? 'SESSION_ENDED' : 'FORBIDDEN', res.status);
      if (res.status === 409) fail((data && typeof data.error === 'string' && data.error.slice(0, 300)) || 'Данные изменились', 'CONFLICT', 409);
      if (res.status >= 500 && request.mutating) fail('Сервер не подтвердил запись — исход неизвестен', 'UNKNOWN_OUTCOME', res.status);
      if (res.ok && request.mutating && !plainObject(data)) fail('Ответ не подтвердил запись — исход неизвестен', 'UNKNOWN_OUTCOME', res.status);
      if (!res.ok || !data) fail((data && typeof data.error === 'string' && data.error.slice(0, 300)) || `Ошибка ${res.status}`, 'FAILED', res.status);
      return data;
    }
    return Object.freeze({ kind: 'native', send });
  }

  /* ---------- билеты контекста: поздний ответ A не применяется к B ----------
     Контекст = auth epoch + актор + экран + typed параметры + поколение навигации; seq по полю — только новее. */
  function createTickets() {
    const t = { epoch: 0, nav: 0, seq: 0, applied: Object.create(null) };
    return Object.freeze({
      bumpEpoch() { t.epoch += 1; t.applied = Object.create(null); },
      bumpNav() { t.nav += 1; },
      take(contextKey) { const ticket = { epoch: t.epoch, nav: t.nav, seq: ++t.seq, key: contextKey }; return ticket; },
      live(ticket, contextKey) { return ticket.epoch === t.epoch && ticket.nav === t.nav && ticket.key === contextKey; },
      accept(ticket, field) { if (ticket.seq < (t.applied[field] || 0)) return false; t.applied[field] = ticket.seq; return true; },
      commitNow(field) { t.applied[field] = ++t.seq; },
      get epoch() { return t.epoch; },
    });
  }

  /* Файлы: отдельный узкий transport; прежний JSON-мост/операции не расширяются произвольным fetch. */
  const FILE_LIMIT = 20 * 1024 * 1024;
  const FILE_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const FILE_UPLOAD = new RegExp(`^upload:${FILE_UUID}$`);
  const FILE_REQUEST = new RegExp(`^${FILE_UUID}$`);
  function fileTarget(value) {
    if (!value || typeof value !== 'object' || !['thread', 'legacy'].includes(value.ns) ||
        typeof value.id !== 'number' || parsePositiveId(value.id) === null || Object.keys(value).some(k => !['ns', 'id'].includes(k))) fail('Нужен чат или диалог с typed-номером', 'NAMESPACE');
    return Object.freeze({ ns: value.ns, id: value.id });
  }
  function fileRef(value, target) {
    if (typeof value === 'string' && FILE_UPLOAD.test(value)) return value;
    if (target.ns === 'thread' && typeof value === 'string' && /^thread:[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value.slice(7)))) return value;
    if (target.ns === 'legacy' && (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value))) return String(value);
    fail('Некорректное вложение', 'NAMESPACE');
  }
  function fileInput(body) {
    if (!body || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'caption,name,requestId,sha256,size' ||
        typeof body.requestId !== 'string' || !FILE_REQUEST.test(body.requestId) || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > FILE_LIMIT ||
        typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 180 || /[\x00-\x1f\x7f]/.test(body.name) ||
        typeof body.caption !== 'string' || body.caption.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.caption)) fail('Проверьте файл, имя и подпись (до 20 МБ и 4000 символов)', 'VALIDATION');
    const name = body.name.split(/[\\/]/).pop().replace(/^[.\s]+/, '').trim();
    if (!name) fail('Нужно имя файла', 'VALIDATION');
    return Object.freeze({ requestId: body.requestId, name, size: body.size, sha256: body.sha256, caption: body.caption.trim() ? body.caption : '' });
  }
  function createAttachmentTransport({ fetch: injectedFetch, host } = {}) {
    if (typeof injectedFetch !== 'function' || !host || typeof host.getCsrf !== 'function') fail('Файлы не подключены', 'NO_TRANSPORT');
    const allowed = () => host.allowNetwork === true && host.e1Native === true &&
      ((host.entry === 'cabinet' && host.origin === ORIGINS.synapse) || (host.entry === 'shop' && host.origin === ORIGINS.shop));
    const path = (target) => {
      if (!allowed() || (host.entry === 'shop' && target.ns !== 'thread')) fail('Файлы недоступны для этого входа', 'FORBIDDEN', 403);
      return host.entry === 'shop' ? `/api/customer-chat/threads/${target.id}` : target.ns === 'thread' ? `/content/palitra/customer-threads/${target.id}` : `/content/palitra/client-dialogs/${target.id}`;
    };
    const check = (target) => { const base = path(fileTarget(target)), csrf = host.getCsrf(); if (typeof csrf !== 'string' || !csrf) fail('Войдите снова для работы с файлами', 'SESSION_ENDED', 401); return { base, csrf }; };
    const url = (target, ref) => {
      target = fileTarget(target); const { base } = check(target); ref = fileRef(ref, target);
      return target.ns === 'legacy' && !FILE_UPLOAD.test(ref) ? `/content/palitra/client-dialogs/attachments/${ref}` : `${base}/attachments/${ref}`;
    };
    async function request(operation, options = {}) {
      if (!['prepare', 'status', 'bytes'].includes(operation)) fail('Неизвестное действие с файлом', 'UNKNOWN_OPERATION');
      const target = fileTarget(options.target), { base, csrf } = check(target);
      const body = operation === 'prepare' ? fileInput(options.body) : null;
      if (operation !== 'prepare' && (typeof options.ref !== 'string' || !FILE_UPLOAD.test(options.ref))) fail('Нужен номер загрузки', 'NAMESPACE');
      if (operation === 'bytes' && (!options.file || !Number.isSafeInteger(options.file.size) || options.file.size < 1 || options.file.size > FILE_LIMIT || typeof options.file.arrayBuffer !== 'function')) fail('Повторите выбор того же файла до 20 МБ', 'VALIDATION');
      const method = operation === 'status' ? 'GET' : 'POST';
      const endpoint = operation === 'prepare' ? `${base}/uploads` : `${base}/uploads/${options.ref}${operation === 'bytes' ? '/bytes' : ''}`;
      const controller = new AbortController(); const caller = options.signal;
      const abort = () => controller.abort(); if (caller) { if (caller.aborted) abort(); else caller.addEventListener('abort', abort, { once: true }); }
      const timer = setTimeout(abort, operation === 'bytes' ? 120000 : 30000);
      try {
        const response = await injectedFetch(endpoint, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'same-origin', signal: controller.signal,
          headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': operation === 'bytes' ? 'application/octet-stream' : 'application/json', [host.entry === 'cabinet' ? 'X-CSRF-Token' : 'X-Palitra-Chat-CSRF']: csrf } : {}) },
          ...(method === 'POST' ? { body: operation === 'bytes' ? options.file : JSON.stringify(body) } : {}) });
        let value; try { value = await response.json(); } catch (_) { throw Object.assign(new Error('Сервер не подтвердил результат файла. Проверьте ту же отправку.'), { code: 'UNKNOWN_OUTCOME', unknown: method !== 'GET' }); }
        if (!allowed() || host.getCsrf() !== csrf) fail('Сессия изменилась', 'SESSION_ENDED', 401);
        if (!response.ok) throw Object.assign(new Error(value && typeof value.error === 'string' ? value.error.slice(0, 300) : 'Файл не принят сервером'), { status: response.status, code: value && typeof value.code === 'string' ? value.code.slice(0, 64) : 'HTTP_ERROR', unknown: method !== 'GET' && response.status >= 500 });
        return value;
      } catch (error) {
        if (error && (error.status || error.code === 'UNKNOWN_OUTCOME')) throw error;
        throw Object.assign(new Error('Нет подтверждения сервера. Проверьте и повторите ту же отправку файла.'), { code: 'UNKNOWN_OUTCOME', unknown: method !== 'GET' });
      } finally { clearTimeout(timer); if (caller) caller.removeEventListener('abort', abort); }
    }
    return Object.freeze({ kind: 'native-attachments', request, url });
  }
  function createAttachmentClient({ transport, getAuth } = {}) {
    if (!transport || transport.kind !== 'native-attachments' || typeof transport.request !== 'function' || typeof transport.url !== 'function' || typeof getAuth !== 'function') fail('Файлы не подключены', 'NO_TRANSPORT');
    const authorized = (target, write) => {
      target = fileTarget(target); const auth = getAuth() || {}, c = capabilities(auth);
      if (auth.cabinet) {
        if (!c['native.orders'] || (write && !c['native.write']) || (target.ns === 'thread' && auth.e1Native !== true)) fail('Недостаточно доступа к файлам чата', 'FORBIDDEN', 403);
      } else if (target.ns !== 'thread' || !c['customer.chat']) fail('Войдите в свой чат', 'SESSION_ENDED', 401);
      return target;
    };
    const stamp = () => { const a = getAuth() || {}, c = a.cabinet; return JSON.stringify([c ? [c.userId, c.role, c.member, c.permissions] : null, a.account && a.account.opaque, a.chat && a.chat.ready, a.e1Native]); };
    const call = async (operation, target, options) => {
      target = authorized(target, operation !== 'status'); const before = stamp();
      const result = await transport.request(operation, { target, ...options });
      authorized(target, operation !== 'status'); if (before !== stamp()) fail('Сессия изменилась', 'SESSION_ENDED', 401);
      return result;
    };
    const can = (target, write) => { try { authorized(target, write); return true; } catch (_) { return false; } };
    return Object.freeze({
      prepare: (target, body, signal) => call('prepare', target, { body: fileInput(body), signal }),
      status: (target, ref, signal) => call('status', target, { ref, signal }),
      bytes: (target, ref, file, signal) => call('bytes', target, { ref, file, signal }),
      fileUrl: (target, ref) => transport.url(authorized(target, false), ref),
      canRead: target => can(target, false), canWrite: target => can(target, true),
      normalizeInput: fileInput,
    });
  }

  return Object.freeze({
    forCompany: code => build(code), COMPANY: company,
    COMPANY_CODE, CONTENT_SITE, NAMESPACES, WORK_STATUSES, WORK_LABELS, CRM_STAGES, CRM_STAGE_LABELS, CHECKLIST_ITEMS, PORTAL_ROLES, CABINET_ROLES,
    NATIVE_CHANNELS, OPERATIONS, LINKS, ORIGINS, BridgeError,
    parsePositiveId, makeRef, refKey, parseRef, sameRef, accountRef, newRequestId, sanitizeUtm, validPhone, phoneDigits,
    crmReportQuery, parseCrmSummary, parseStaffAdvisories, parseIdentity, parsePortalActor, parseAccountSession, parseShopReceipt, parsePortalRequests, parseUnread, parseCrmOrder, parseCrmAction, parseOrderLinks, receiptOk, buildShopRequest, validateShopRequest, fingerprintOf, contactLink, linkUrl,
    capabilities, createBridge, createMockTransport, createNativeTransport, createTickets, createAttachmentClient, createAttachmentTransport,
    serializers: S,
  });
}));
