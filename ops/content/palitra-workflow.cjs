'use strict';
// Состояние и настройки — версии в существующей documents. Новых таблиц, прав и очередей нет.
const crypto = require('node:crypto');
const SITE = 'palitra', COMPANY = 'palitra-love', KEY = 'palitra-love/order-workflow';
const WIDGET_KEY = 'palitra-love/site-chat-widget';
const REQUIREMENTS = Object.freeze(['contact_confirmed', 'details_confirmed', 'payment_confirmed', 'photo_sent', 'handover_confirmed', 'feedback_requested']);
const CHANNELS = Object.freeze(['app', 'phone', 'telegram', 'whatsapp']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[a-z][a-z0-9_-]{0,39}$/;
const fail = (status, message, code = 'VALIDATION') => { throw Object.assign(new Error(message), { status, code }); };
const clone = (v) => JSON.parse(JSON.stringify(v));
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, required, optional = []) => { if (!obj(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail(400, 'Неверный набор полей'); };
const text = (v, max, empty = false) => { if (typeof v !== 'string' || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v) || (!empty && !v.trim())) fail(400, 'Некорректный текст'); return v.trim(); };
const numericId = (v) => { if (!['number', 'string'].includes(typeof v) || (typeof v === 'string' && !/^[1-9]\d{0,14}$/.test(v))) fail(404, 'Заявка не найдена', 'ORDER'); const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) fail(404, 'Заявка не найдена', 'ORDER'); return n; };
const DEFAULT = Object.freeze({
  autoReply: { enabled: true, text: 'Здравствуйте! Спасибо, что написали в Palitra Love. Менеджер скоро подключится. Расскажите, для кого и на какое событие подбираете шары.', questions: [] },
  stages: [
    { id: 'new', label: 'Новый заказ', hint: 'Свяжитесь с клиентом и начните согласование.', requirements: [] },
    { id: 'agreement', label: 'Согласование', hint: 'Согласуйте состав, дату, получение и стоимость заказа.', requirements: ['details_confirmed'] },
    { id: 'payment', label: 'Оплата', hint: 'Дождитесь чека и подтвердите фактически полученную оплату.', requirements: ['payment_confirmed'] },
    { id: 'paid', label: 'Оплачен', hint: 'Оплата подтверждена менеджером; передайте заказ в работу.', requirements: [] },
    { id: 'preparing', label: 'Готовим заказ', hint: 'Отправьте фото фактического заказа клиенту.', requirements: ['photo_sent'] },
    { id: 'waiting', label: 'Ожидает доставки/самовывоза', hint: 'Подтвердите фактическую передачу заказа.', requirements: ['handover_confirmed'] },
    { id: 'issued', label: 'Выдан', hint: 'Заказ передан клиенту; переписка и история сохраняются.', requirements: [] },
  ],
});
const COMPLETION_KEY = `${KEY}/completion-settings`;
const DEFAULT_COMPLETION = Object.freeze({ reviewText: 'Спасибо за заказ в Palitra Love! Будем рады вашему отзыву.', memoText: '', memoAttachmentRef: null });
const CANCELLED = Object.freeze({ id: 'cancelled', label: 'Отказ', hint: 'Сохраните короткую причину отказа.', requirements: [], entryRequirement: 'reason' });
const ENTRY = Object.freeze({ paid: 'paymentReceived', waiting: 'photoSent', issued: 'handedOver' });
const LEGACY_STAGE = Object.freeze({ handover: 'waiting', feedback: 'waiting', done: 'issued' });
const REF = /^(?:thread:[1-9]\d{0,14}|(?:upload|memo):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
function validateCompletion(value) {
  exact(value, ['reviewText', 'memoText', 'memoAttachmentRef']);
  const reviewText = text(value.reviewText, 4000, true), memoText = text(value.memoText, 4000, true);
  if ([reviewText, memoText].filter(Boolean).join('\n\n').length > 4000) fail(400, 'Сообщение и памятка вместе должны быть не длиннее 4000 символов');
  if (value.memoAttachmentRef !== null && (typeof value.memoAttachmentRef !== 'string' || !REF.test(value.memoAttachmentRef))) fail(400, 'Нужен защищённый файл компании', 'MEDIA_REFERENCE');
  return { reviewText, memoText, memoAttachmentRef: value.memoAttachmentRef };
}
const DEFAULT_WIDGET = Object.freeze({
  welcomeText: 'Здравствуйте! Поможем подобрать шары и оформление для вашего праздника. Напишите нам.',
  autoReply: { enabled: true, text: DEFAULT.autoReply.text },
  contact: { enabled: true, text: 'Оставьте номер, чтобы менеджер мог связаться с вами.' },
  invitation: { enabled: true, text: 'Нужна помощь с выбором шаров? Напишите нам.', delaySeconds: 15 },
  appearance: { width: 360, height: 520, radius: 28, accent: '#69723e' },
});
function validateWidgetSettings(value) {
  exact(value, ['welcomeText', 'autoReply', 'contact', 'invitation', 'appearance']);
  exact(value.autoReply, ['enabled', 'text']);
  exact(value.contact, ['enabled', 'text']);
  exact(value.invitation, ['enabled', 'text', 'delaySeconds']);
  exact(value.appearance, ['width', 'height', 'radius', 'accent']);
  if (typeof value.autoReply.enabled !== 'boolean' || typeof value.contact.enabled !== 'boolean'
    || typeof value.invitation.enabled !== 'boolean') fail(400, 'Некорректное включение настройки чата');
  const size = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
  if (!size(value.invitation.delaySeconds, 0, 3600)) fail(400, 'Некорректная задержка приглашения');
  if (!size(value.appearance.width, 280, 440) || !size(value.appearance.height, 360, 680)
    || !size(value.appearance.radius, 12, 40) || typeof value.appearance.accent !== 'string'
    || !/^#[0-9a-fA-F]{6}$/.test(value.appearance.accent)) fail(400, 'Некорректное оформление чата');
  return {
    welcomeText: text(value.welcomeText, 1200, true),
    autoReply: { enabled: value.autoReply.enabled, text: text(value.autoReply.text, 3000, !value.autoReply.enabled) },
    contact: { enabled: value.contact.enabled, text: text(value.contact.text, 300, !value.contact.enabled) },
    invitation: { enabled: value.invitation.enabled, text: text(value.invitation.text, 300, !value.invitation.enabled),
      delaySeconds: value.invitation.delaySeconds },
    appearance: { width: value.appearance.width, height: value.appearance.height,
      radius: value.appearance.radius, accent: value.appearance.accent.toLowerCase() },
  };
}
function validateConfig(value) {
  exact(value, ['autoReply', 'stages']); exact(value.autoReply, ['enabled', 'text', 'questions']);
  if (typeof value.autoReply.enabled !== 'boolean') fail(400, 'Включение автоответа должно быть логическим');
  const autoReply = { enabled: value.autoReply.enabled, text: text(value.autoReply.text, 3000, !value.autoReply.enabled), questions: [] };
  if (!Array.isArray(value.autoReply.questions) || value.autoReply.questions.length > 6) fail(400, 'Не больше шести вопросов');
  const questionIds = new Set();
  for (const q of value.autoReply.questions) {
    exact(q, ['id', 'label', 'options']);
    if (!ID.test(q.id) || questionIds.has(q.id) || !Array.isArray(q.options) || q.options.length > 8) fail(400, 'Некорректный вопрос');
    questionIds.add(q.id); autoReply.questions.push({ id: q.id, label: text(q.label, 180), options: q.options.map(v => text(v, 100)) });
  }
  if (!Array.isArray(value.stages) || value.stages.length < 2 || value.stages.length > 20) fail(400, 'Нужно от двух до двадцати этапов');
  const stageIds = new Set();
  const stages = value.stages.map(s => {
    exact(s, ['id', 'label', 'hint', 'requirements']);
    if (!ID.test(s.id) || stageIds.has(s.id) || !Array.isArray(s.requirements) || s.requirements.some(r => !REQUIREMENTS.includes(r)) || new Set(s.requirements).size !== s.requirements.length) fail(400, 'Некорректные этапы или условия');
    stageIds.add(s.id); return { id: s.id, label: text(s.label, 100), hint: text(s.hint, 500, true), requirements: [...s.requirements] };
  });
  if (stages.at(-1).requirements.length) fail(400, 'Последний этап не должен требовать перехода дальше');
  const fullReply = [autoReply.text, ...autoReply.questions.map(q => `${q.label}${q.options.length ? ` (${q.options.join(' / ')})` : ''}`)].filter(Boolean).join('\n\n');
  if (fullReply.length > 4000) fail(400, 'Автоответ вместе с вопросами не должен превышать 4000 символов');
  return { autoReply, stages };
}
function canAccess(user, permission) {
  return Boolean(user && (user.role === 'owner' || (Array.isArray(user.companyCodes) && user.companyCodes.includes(COMPANY) && Array.isArray(user.permissions) && user.permissions.includes(permission))));
}
function createWorkflow({ db, transaction, siteOrders, getUser, now = Date.now, validateCompletionMedia = null, prepareCompletion = null, appendCompletion = null }) {
  if (!db || typeof transaction !== 'function' || !siteOrders || typeof getUser !== 'function') throw new TypeError('Нужен штатный хост workflow');
  const latest = db.prepare('SELECT version, body FROM documents WHERE key=? ORDER BY version DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO documents(key,version,created_at,author,body) VALUES(?,?,?,?,?)');
  const at = () => new Date(now()).toISOString();
  function actor(who, write = false, ownerOnly = false) {
    if (!who || !Number.isSafeInteger(who.id) || who.id < 1 || !Number.isSafeInteger(who.sessionVersion)) fail(403, 'Требуется действующая сессия', 'ACCESS');
    const user = getUser(who.id);
    if (!user || user.sessionVersion !== who.sessionVersion || !canAccess(user, write ? 'crm.edit' : 'crm.view') || (ownerOnly && user.role !== 'owner')) fail(403, 'Доступ изменился', 'ACCESS');
    return { id: user.id, label: String(user.displayName || user.login || user.id).slice(0, 100), role: user.role };
  }
  function load(key) {
    const row = latest.get(key); if (!row) return null;
    try { const value = JSON.parse(row.body); if (!obj(value) || value.schema !== 1) throw new Error(); return { ...value, revision: row.version }; }
    catch (_) { fail(503, 'Сохранённые этапы повреждены; обратитесь к администратору', 'STATE'); }
  }
  function save(key, previous, value, by) {
    const revision = (previous?.revision || 0) + 1;
    insert.run(key, revision, at(), `workflow:${by.id}:${by.label}`, JSON.stringify({ ...value, revision: undefined, schema: 1 }));
    return { ...value, revision, schema: 1 };
  }
  const configRecord = () => load(KEY) || { schema: 1, revision: 0, ...clone(DEFAULT), receipts: [] };
  function canonicalStages(record) {
    // Old custom/legacy snapshots remain stored byte-for-byte. The current funnel is a read projection.
    const stages = Array.isArray(record.stages) ? record.stages : [];
    const modern = stages.length === DEFAULT.stages.length && DEFAULT.stages.every((stage, i) => stages[i]?.id === stage.id);
    return modern ? DEFAULT.stages.map((stage, i) => ({ ...clone(stages[i]), requirements: [...stage.requirements] })) : clone(DEFAULT.stages);
  }
  const configView = r => ({ revision: r.revision, autoReply: clone(r.autoReply), stages: canonicalStages(r) });
  function getConfig(who) { actor(who); return configView(configRecord()); }
  const widgetRecord = () => {
    const stored = load(WIDGET_KEY);
    if (!stored) return { schema: 1, revision: 0, ...clone(DEFAULT_WIDGET), receipts: [] };
    // Старые schema:1 документы читаются без миграционной записи и без потери receipt/revision.
    return Object.hasOwn(stored, 'invitation') ? stored : { ...stored, invitation: clone(DEFAULT_WIDGET.invitation) };
  };
  const widgetView = r => ({ revision: r.revision, welcomeText: r.welcomeText,
    autoReply: clone(r.autoReply), contact: clone(r.contact), invitation: clone(r.invitation), appearance: clone(r.appearance) });
  function getWidgetSettings(who) { actor(who, false, true); return widgetView(widgetRecord()); }
  function getPublicWidgetSettings() {
    const current = widgetRecord();
    return { revision: current.revision, welcomeText: current.welcomeText,
      contact: clone(current.contact), invitation: clone(current.invitation), appearance: clone(current.appearance) };
  }
  function mutation(body, required, optional = []) {
    exact(body, ['expectedRevision', 'requestId', ...required], optional);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || typeof body.requestId !== 'string' || !UUID.test(body.requestId)) fail(400, 'Нужны revision и requestId');
  }
  function replay(record, who, body, action, conflictMessage = 'Этапы уже изменились. Обновите карточку.') {
    const hash = digest({ action, body });
    const old = (record.receipts || []).find(r => r.actorId === who.id && r.requestId === body.requestId);
    if (old && old.hash !== hash) fail(409, 'requestId уже использован для другого действия', 'REQUEST_CONFLICT');
    if (old) return { duplicate: true, hash };
    if (record.revision !== body.expectedRevision) fail(409, conflictMessage, 'REVISION');
    return { duplicate: false, hash };
  }
  function receipt(record, by, body, hash) { return [...(record.receipts || []), { actorId: by.id, requestId: body.requestId, hash }].slice(-256); }
  function putConfig(who, body) {
    mutation(body, ['config']); const config = validateConfig(body.config); actor(who, true, true);
    return transaction(() => {
      const by = actor(who, true, true), old = configRecord(), known = replay(old, by, body, 'config');
      if (known.duplicate) return { ...configView(old), duplicate: true };
      const saved = save(KEY, old, { ...config, receipts: receipt(old, by, body, known.hash) }, by);
      actor(who, true, true); return { ...configView(saved), duplicate: false };
    });
  }
  function putWidgetSettings(who, body) {
    mutation(body, ['welcomeText', 'autoReply', 'contact', 'invitation', 'appearance']);
    const value = validateWidgetSettings({ welcomeText: body.welcomeText, autoReply: body.autoReply,
      contact: body.contact, invitation: body.invitation, appearance: body.appearance });
    actor(who, true, true);
    return transaction(() => {
      const by = actor(who, true, true), old = widgetRecord();
      const known = replay(old, by, body, 'widget-settings', 'Настройки чата уже изменились. Обновите их.');
      if (known.duplicate) return { ...widgetView(old), duplicate: true };
      const saved = save(WIDGET_KEY, old, { ...value, receipts: receipt(old, by, body, known.hash) }, by);
      actor(who, true, true);
      return { ...widgetView(saved), duplicate: false };
    });
  }
  function threadContext(raw) {
    const threadId = numericId(raw.slice(7));
    const thread = orderThread(`thread:${threadId}`);
    if (!thread) fail(404, 'Переписка не найдена', 'THREAD');
    // Once checkout links this exact thread, both entry paths use the same order.
    if (thread.order_id !== null) return {...orderContext(thread.order_id),requestedThreadRef:raw};
    const id = `thread:${threadId}`, key = `${KEY}/threads/${threadId}`, stored = load(key), config = configRecord(), stages = canonicalStages(config);
    const currentStageId = stored?.currentStageId || (humanEvidence(id).bilateral ? 'agreement' : 'new');
    if (![...stages.map(stage=>stage.id),'cancelled'].includes(currentStageId)) fail(503,'Сохранённый этап переписки повреждён','STATE');
    const current = {...(stored || {schema:1,revision:0,configRevision:config.revision,confirmations:[],history:[],receipts:[]}),stages,currentStageId};
    if (!Array.isArray(current.confirmations)||!Array.isArray(current.history)||!Array.isArray(current.receipts)) fail(503,'Сохранённые этапы повреждены','STATE');
    const contact = db.prepare('SELECT phone FROM chat_thread_contacts WHERE thread_id=?').get(threadId);
    return {id,threadId,thread,key,current,order:{work:{status:currentStageId==='issued'?'done':currentStageId==='cancelled'?'cancelled':'in_work'}},contactPhone:contact?.phone||'',source:stored?'workflow':'chat-evidence',originalStageId:currentStageId};
  }
  function orderContext(raw) {
    if (typeof raw==='string' && /^thread:[1-9]\d{0,14}$/.test(raw)) return threadContext(raw);
    const id = numericId(raw), order = siteOrders.orderSummary(SITE, id);
    const canonical = db.prepare('SELECT id,phone FROM site_orders WHERE id=? AND site=? AND company_code=?').get(id, SITE, COMPANY);
    if (!canonical || !order || order.id !== id) fail(404, 'Заявка не найдена', 'ORDER');
    const key = `${KEY}/orders/${id}`, config = configRecord(), linkedThread = orderThread(id), stored = load(key) || (linkedThread ? load(`${KEY}/threads/${linkedThread.id}`) : null);
    const stages = canonicalStages(config), originalStageId = stored?.currentStageId || 'new';
    let currentStageId = LEGACY_STAGE[originalStageId] || originalStageId;
    if (!stages.some(s => s.id === currentStageId) && currentStageId !== 'cancelled') currentStageId = 'new';
    if (order.work?.status === 'done') currentStageId = 'issued';
    if (order.work?.status === 'cancelled') currentStageId = 'cancelled';
    const source = !stored ? 'native' : originalStageId !== currentStageId ? 'legacy-mapping' : 'workflow';
    const current = { ...(stored || { schema: 1, revision: 0, configRevision: config.revision, confirmations: [], history: [], receipts: [] }), stages, currentStageId };
    if (!Array.isArray(current.confirmations) || !Array.isArray(current.history) || !Array.isArray(current.receipts)) fail(503, 'Сохранённые этапы повреждены', 'STATE');
    // Existing real conversations acquire a canonical display without a migration write or invented history.
    if (currentStageId === 'new' && humanEvidence(id).bilateral) current.currentStageId = 'agreement';
    return { id, order, key, current, contactPhone: canonical.phone, source: current.currentStageId !== currentStageId ? 'chat-evidence' : source, originalStageId };
  }
  function orderThread(orderId) {
    if (typeof orderId==='string' && /^thread:[1-9]\d{0,14}$/.test(orderId)) return db.prepare('SELECT * FROM chat_threads WHERE id=? AND site=? AND company_code=?').get(numericId(orderId.slice(7)),SITE,COMPANY) || null;
    const rows = db.prepare('SELECT id,site,company_code,order_id FROM chat_threads WHERE site=? AND company_code=? AND order_id=? LIMIT 2').all(SITE, COMPANY, orderId);
    return rows.length === 1 ? rows[0] : null;
  }
  function humanEvidence(orderId, currentEvent = null) {
    const thread = orderThread(orderId);
    if (!thread) return { bilateral: false, thread: null, lastManager: null, lastCustomer: null };
    const rows = db.prepare(`SELECT m.* FROM chat_thread_messages m WHERE m.thread_id=? AND (
      (m.direction='in' AND m.author_kind='customer' AND m.source_channel IN ('web','telegram')) OR
      (m.direction='out' AND ((m.author_kind='owner' AND m.source_channel='app' AND m.owner_user_id>0) OR
       (m.author_kind='manager' AND m.source_channel='manager_telegram' AND m.tg_message_id IS NOT NULL))))
      AND NOT EXISTS(SELECT 1 FROM chat_thread_requests r WHERE r.thread_id=m.thread_id AND r.message_id=m.id
        AND (r.request_id=('checkout-order:' || ?) OR r.actor_ref=('workflow-issued:' || ?)))
      AND NOT EXISTS(SELECT 1 FROM chat_thread_media_events e WHERE e.message_id=m.id)
      ORDER BY m.id`).all(thread.id, String(orderId), String(orderId));
    // The checkout marker is written after insertMessage; its internal human=false event closes that window.
    const human = rows.filter(row => !currentEvent || row.id !== currentEvent.messageId || currentEvent.human === true);
    const incoming = human.filter(row => row.direction === 'in'), outgoing = human.filter(row => row.direction === 'out');
    return { thread, bilateral: incoming.length > 0 && outgoing.length > 0, messageIds: human.map(row=>row.id), lastManager: outgoing.at(-1) || null, lastCustomer: incoming.at(-1) || null };
  }
  function responseAdvice(ctx) {
    if (['issued', 'cancelled'].includes(ctx.current.currentStageId)) return null;
    const evidence = humanEvidence(ctx.id), message = evidence.lastManager;
    if (!message || evidence.lastCustomer?.id > message.id) return null;
    const timestamp = Date.parse(message.created_at), due = timestamp + 60000;
    if (!Number.isFinite(timestamp) || now() < due) return null;
    const phone = String(ctx.contactPhone || '').trim(), rawDigits = phone.replace(/\D/g, '');
    const digits = rawDigits.length === 11 && rawDigits.startsWith('8') ? `7${rawDigits.slice(1)}` : rawDigits;
    const contact = /^[+\d\s().-]+$/.test(phone) && /^\d{10,15}$/.test(digits)
      ? { channel: 'phone', href: `tel:+${digits}`, label: 'Позвонить клиенту' } : null;
    return { key: `manager-no-reply:${ctx.id}:${message.id}`, kind: 'manager-no-reply', orderId: ctx.id,
      threadId: evidence.thread.id, messageId: message.id, dueAt: new Date(due).toISOString(),
      text: contact ? 'Клиент не ответил на сообщение менеджера в течение минуты. Позвоните по указанному номеру.' : 'Клиент не ответил на сообщение менеджера в течение минуты. Свяжитесь удобным для него способом.', contact };
  }
  function getCompletionSettings(who) {
    actor(who, true);
    const record = load(COMPLETION_KEY) || { revision: 0, ...clone(DEFAULT_COMPLETION) };
    const value = validateCompletion({ reviewText: record.reviewText, memoText: record.memoText, memoAttachmentRef: record.memoAttachmentRef });
    actor(who, true); return { revision: record.revision, ...value, canEdit: true };
  }
  function putCompletionSettings(who, body) {
    mutation(body, ['reviewText', 'memoText', 'memoAttachmentRef']);
    const value = validateCompletion({ reviewText: body.reviewText, memoText: body.memoText, memoAttachmentRef: body.memoAttachmentRef });
    actor(who, true);
    return transaction(() => {
      const by = actor(who, true), old = load(COMPLETION_KEY) || { revision: 0, receipts: [] };
      const known = replay(old, by, body, 'completion-settings');
      if (known.duplicate) {
        const previous=(old.receipts || []).find(item=>item.actorId===by.id && item.requestId===body.requestId);
        if (!Number.isSafeInteger(previous?.appliedRevision)) fail(503,'Квитанция настроек повреждена','STATE');
        return { ...getCompletionSettings(who), duplicate:true, completionReceipt:{requestId:body.requestId,revision:previous.appliedRevision} };
      }
      if (value.memoAttachmentRef !== null) {
        if (typeof validateCompletionMedia !== 'function' || validateCompletionMedia({ owner: who, attachmentRef: value.memoAttachmentRef }) !== true)
          fail(409, 'Файл памятки недоступен. Выберите файл компании заново.', 'MEDIA_REFERENCE');
      }
      actor(who, true);
      const receipts=receipt(old,by,body,known.hash);receipts.at(-1).appliedRevision=old.revision+1;
      save(COMPLETION_KEY, old, { ...value, receipts }, by);
      actor(who, true); return { ...getCompletionSettings(who), duplicate:false, completionReceipt:{requestId:body.requestId,revision:old.revision+1} };
    });
  }
  function prepareIssued(ctx, who) {
    const key = `${KEY}/issued-followup/${ctx.id}`;
    if (load(key)) return null;
    const settings = getCompletionSettings(who), thread = orderThread(ctx.id);
    const message = settings.memoText;
    if (!settings.memoAttachmentRef) return null;
    if (!thread || typeof prepareCompletion !== 'function') fail(409,'Файл памятки пока нельзя подготовить','COMPLETION_UNAVAILABLE');
    const eventId = `workflow-issued:${ctx.id}`;
    const preparedCompletion = prepareCompletion({owner:who,orderId:ctx.id,threadId:thread.id,eventId,text:message,memoAttachmentRef:settings.memoAttachmentRef});
    actor(who,true);
    if (!preparedCompletion) fail(503,'Готовый файл памятки не подтверждён','COMPLETION_PREPARED');
    return {configRevision:settings.revision,eventId,threadId:thread.id,text:message,memoAttachmentRef:settings.memoAttachmentRef,preparedCompletion};
  }
  function issueFollowup(ctx, who, by, prepared) {
    if (db.isTransaction !== true) fail(503, 'Завершение требует общей транзакции', 'COMPLETION_TRANSACTION');
    const key = `${KEY}/issued-followup/${ctx.id}`, known = load(key);
    if (known) return known;
    const settings = getCompletionSettings(who), thread = orderThread(ctx.id);
    const message = settings.memoText;
    const eventId = `workflow-issued:${ctx.id}`;
    let result = null;
    if (message || settings.memoAttachmentRef) {
      if (!thread || typeof appendCompletion !== 'function') fail(409, 'Чат для сообщения после выдачи недоступен', 'COMPLETION_UNAVAILABLE');
      if (settings.memoAttachmentRef && (typeof validateCompletionMedia !== 'function' || validateCompletionMedia({ owner: who, attachmentRef: settings.memoAttachmentRef }) !== true))
        fail(409, 'Файл памятки недоступен', 'MEDIA_REFERENCE');
      actor(who, true);
      if (settings.memoAttachmentRef && (!prepared || prepared.configRevision!==settings.revision || prepared.eventId!==eventId
        || prepared.threadId!==thread.id || prepared.text!==message || prepared.memoAttachmentRef!==settings.memoAttachmentRef))
        fail(409,'Настройки памятки изменились; обновите карточку','COMPLETION_PREPARED');
      result = appendCompletion({ owner: who, orderId: ctx.id, threadId: thread.id, eventId, text: message,
        memoAttachmentRef: settings.memoAttachmentRef, preparedCompletion: prepared?.preparedCompletion || null });
      if (!result || result.stored !== true || result.threadId !== thread.id || result.eventId !== eventId || !Number.isSafeInteger(result.messageId) || result.messageId < 1)
        fail(503, 'Не подтверждена запись сообщения после выдачи', 'COMPLETION_RECEIPT');
      const stored = db.prepare('SELECT id,thread_id,direction FROM chat_thread_messages WHERE id=?').get(result.messageId);
      if (!stored || stored.thread_id !== thread.id || stored.direction !== 'out') fail(503, 'Сообщение завершения не подтверждено историей', 'COMPLETION_RECEIPT');
    }
    // Same transaction and existing request journal: memo first, review second.
    // Older issued-followup receipts return above and never receive a retrospective send.
    let review = null;
    if (settings.reviewText) {
      if (!thread || typeof appendCompletion !== 'function') fail(409, 'Чат для отзыва недоступен', 'COMPLETION_UNAVAILABLE');
      actor(who, true);
      const reviewEventId = `${eventId}:review`;
      review = appendCompletion({ owner: who, orderId: ctx.id, threadId: thread.id, eventId: reviewEventId,
        text: settings.reviewText, memoAttachmentRef: null, preparedCompletion: null });
      if (!review || review.stored !== true || review.threadId !== thread.id || review.eventId !== reviewEventId || !Number.isSafeInteger(review.messageId) || review.messageId < 1)
        fail(503, 'Не подтверждена запись просьбы об отзыве', 'COMPLETION_RECEIPT');
      const stored = db.prepare('SELECT id,thread_id,direction FROM chat_thread_messages WHERE id=?').get(review.messageId);
      if (!stored || stored.thread_id !== thread.id || stored.direction !== 'out' || result && review.messageId <= result.messageId)
        fail(503, 'Порядок памятки и отзыва не подтверждён', 'COMPLETION_RECEIPT');
    }
    actor(who, true);
    return save(key, null, { orderId: ctx.id, threadId: thread?.id || null, eventId, configRevision: settings.revision,
      outcome: result || review ? 'stored' : 'empty', messageId: result?.messageId || review?.messageId || null,
      reviewMessageId: review?.messageId || null, at: at() }, by);
  }
  function getFunnelReport(who) {
    actor(who);
    const stages = [...clone(DEFAULT.stages), clone(CANCELLED)], counts = new Map(stages.map(stage => [stage.id, 0])), reasons = new Map();
    let total = 0, cancelled = 0, withoutReason = 0;
    const resources=[...db.prepare('SELECT id FROM site_orders WHERE site=? AND company_code=? ORDER BY id').all(SITE,COMPANY).map(row=>row.id),...db.prepare('SELECT id FROM chat_threads WHERE site=? AND company_code=? AND order_id IS NULL ORDER BY id').all(SITE,COMPANY).map(row=>`thread:${row.id}`)];
    for (const resource of resources) {
      const ctx = orderContext(resource), stageId = ctx.current.currentStageId;
      total++; counts.set(stageId, (counts.get(stageId) || 0) + 1);
      if (stageId === 'cancelled') {
        cancelled++; const reason = typeof ctx.current.refusal?.reason === 'string' ? ctx.current.refusal.reason : '';
        if (reason) reasons.set(reason, (reasons.get(reason) || 0) + 1); else withoutReason++;
      }
    }
    actor(who);
    return { schema: 1, total, cancelled, byStage: stages.map(stage => ({ stageId: stage.id, label: stage.label, count: counts.get(stage.id) || 0 })),
      refusals: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a,b) => b.count-a.count || a.reason.localeCompare(b.reason)), withoutReason };
  }
  function onMessageStored(event = {}) {
    if (db.isTransaction !== true || event.human !== true) return;
    const thread = event.thread?.order_id === null && Number.isSafeInteger(event.thread.id) ? orderThread(`thread:${event.thread.id}`) : canonicalOrderThread(event.thread);
    if (!thread || !Number.isSafeInteger(event.messageId)) return;
    const row=db.prepare('SELECT thread_id,direction,author_kind,source_channel FROM chat_thread_messages WHERE id=?').get(event.messageId);
    if (!row || row.thread_id!==thread.id || row.direction!==event.direction || row.author_kind!==event.author || row.source_channel!==event.source) return;
    const resource = thread.order_id === null ? `thread:${thread.id}` : thread.order_id;
    const evidence = humanEvidence(resource, event);
    if (!evidence.bilateral || !evidence.messageIds.includes(event.messageId)) return;
    const ctx = orderContext(resource);
    if (ctx.order.work?.status === 'done' || ctx.order.work?.status === 'cancelled') return;
    const stored = load(ctx.key);
    const previousStage = stored ? (LEGACY_STAGE[stored.currentStageId] || stored.currentStageId) : 'new';
    if (previousStage !== 'new') return;
    // The optional chat hook is caught by the host: isolate our own writes so a failed
    // projection never leaves a partial native status while retaining the real message.
    db.exec('SAVEPOINT palitra_workflow_dialogue');
    try {
      const value = clone(ctx.current); value.currentStageId = 'agreement';
      value.history.push({ action: 'human-dialogue', stageId: 'new', nextStageId: 'agreement', at: at(), messageId: event.messageId });
      value.history = value.history.slice(-500);
      if (!ctx.threadId) siteOrders.setWorkStatus(SITE, ctx.id, 'in_work', 'Диалог с клиентом', { expected: ctx.order.work?.status || 'new' });
      save(ctx.key, ctx.current, value, { id: 0, label: 'Диалог с клиентом' });
      db.exec('RELEASE palitra_workflow_dialogue');
    } catch (error) { db.exec('ROLLBACK TO palitra_workflow_dialogue'); db.exec('RELEASE palitra_workflow_dialogue'); throw error; }
  }
  function photos(orderId) {
    const direct = typeof orderId==='string' ? orderThread(orderId) : null;
    const threads = direct ? [direct] : db.prepare('SELECT id FROM chat_threads WHERE site=? AND company_code=? AND order_id=? LIMIT 2').all(SITE, COMPANY, orderId);
    if (threads.length !== 1) return [];
    const threadId = threads[0].id;
    const native = db.prepare("SELECT a.id,m.id AS messageId,m.created_at AS createdAt FROM chat_thread_attachments a JOIN chat_thread_messages m ON m.id=a.message_id WHERE a.thread_id=? AND a.site=? AND a.company_code=? AND a.kind='photo' AND a.status='stored' AND m.thread_id=? AND m.direction='out' AND m.author_kind IN ('owner','manager') ORDER BY m.id DESC LIMIT 30").all(threadId, SITE, COMPANY, threadId)
      .map(r => ({ attachmentRef: `thread:${r.id}`, messageId: r.messageId, createdAt: r.createdAt, label: 'Отправленное фото в чате' }));
    const web = db.prepare("SELECT u.upload_uuid,m.id AS messageId,m.created_at AS createdAt FROM chat_web_uploads u JOIN chat_thread_messages m ON m.id=u.thread_message_id WHERE u.thread_id=? AND u.site=? AND u.company_code=? AND u.target_kind='thread' AND u.state='committed' AND u.kind='photo' AND m.thread_id=? AND m.direction='out' AND m.author_kind IN ('owner','manager') ORDER BY m.id DESC LIMIT 30").all(threadId, SITE, COMPANY, threadId)
      .map(r => ({ attachmentRef: `upload:${r.upload_uuid}`, messageId: r.messageId, createdAt: r.createdAt, label: 'Отправленное фото в приложении' }));
    return [...native, ...web].sort((a, b) => b.messageId - a.messageId).slice(0, 50);
  }
  function view(ctx, who) {
    const by = actor(who), state = ctx.current, cancelled = state.currentStageId === 'cancelled';
    const index = state.stages.findIndex(stage => stage.id === state.currentStageId);
    const stage = cancelled ? CANCELLED : state.stages[index];
    if (!stage) fail(503, 'Текущий этап не найден', 'STATE');
    const confirmations = state.confirmations.filter(c => (LEGACY_STAGE[c.stageId] || c.stageId) === stage.id);
    const missing = stage.requirements.filter(r => !confirmations.some(c => c.requirement === r));
    const nextStage = !cancelled ? state.stages[index + 1] : null;
    const completed = ctx.order.work?.status === 'done', canEdit = canAccess(getUser(by.id), 'crm.edit');
    const manualStageIds = !canEdit || cancelled ? [] : completed || !nextStage ? ['cancelled'] : [nextStage.id, 'cancelled'];
    return { ...(ctx.requestedThreadRef ? {threadRef:ctx.requestedThreadRef} : {}), orderRef: typeof ctx.id==='string' ? ctx.id : `native-order:${ctx.id}`, revision: state.revision, configRevision: state.configRevision, currentStageId: state.currentStageId,
      stages: [...clone(state.stages).map(item => ({ ...item, entryRequirement: ENTRY[item.id] || null })), clone(CANCELLED)],
      confirmations: clone(state.confirmations), history: clone(state.history), nextStage: nextStage ? { id: nextStage.id, label: nextStage.label } : null,
      terminal: !nextStage || cancelled || completed, cancelled, canEdit, allowed: Boolean(nextStage && !cancelled && !completed && !missing.length && canEdit), missing,
      manualStageIds, availablePhotos: photos(ctx.id), staffResponseAdvice: responseAdvice(ctx),
      funnel: { schema: 1, stageId: state.currentStageId, completed, cancelled,
        refusal: cancelled && state.refusal ? { reason: state.refusal.reason, at: state.refusal.at } : null, source: ctx.source } };
  }
  function getOrder(who, id) { actor(who); const ctx = orderContext(id), result = view(ctx, who); actor(who); return result; }
  // Server-only customer projection. The HTTP caller must verify the exact order binding first.
  // Reuses the canonical read projection, without staff notes, identities, refusal reason or writes.
  function customerOrder(id) {
    const ctx=orderContext(id),state=ctx.current;
    const stage=state.currentStageId==='cancelled'?CANCELLED:state.stages.find(s=>s.id===state.currentStageId);
    if(!stage)fail(503,'Текущий этап не найден','STATE');
    return Object.freeze({orderRef:`native-order:${ctx.id}`,revision:state.revision,
      currentStageId:stage.id,label:stage.label,cancelled:stage.id==='cancelled',
      terminal:stage.id==='cancelled'||stage.id==='issued'});
  }
  function workflowAdvice(who, id) { return getOrder(who, id).staffResponseAdvice; }
  function checkPhoto(ctx, body) {
    if (!CHANNELS.includes(body.channel)) fail(400, 'Выберите способ отправки фото');
    const note = text(body.note, 1000, body.channel === 'app');
    if (body.channel === 'app') {
      if (!photos(ctx.id).some(photo => photo.attachmentRef === body.attachmentRef)) fail(409, 'Выберите фактическое фото, отправленное в этот чат', 'PHOTO_NOT_SENT');
    } else if (Object.hasOwn(body, 'attachmentRef')) fail(400, 'Вложение допустимо только для фото из чата');
    return { channel: body.channel, note, ...(body.attachmentRef ? { attachmentRef: body.attachmentRef } : {}) };
  }
  function applyStage(ctx, value, target, who, by, prepared) {
    if (target === 'issued') issueFollowup(ctx, who, by, prepared);
    actor(who, true);
    if (!ctx.threadId) siteOrders.setWorkStatus(SITE, ctx.id, target === 'issued' ? 'done' : target === 'cancelled' ? 'cancelled' : target === 'new' ? 'new' : 'in_work', by.label,
      { expected: ctx.order.work?.status || 'new' });
    actor(who, true);
    value.currentStageId = target;
    // Refresh the same order after the native CAS; response and completion projection agree immediately.
    ctx.order = ctx.threadId ? {work:{status:target==='issued'?'done':target==='cancelled'?'cancelled':'in_work'}} : siteOrders.orderSummary(SITE, ctx.id);
    if (!ctx.order || !ctx.threadId && ctx.order.id !== ctx.id) fail(409, 'Заявка изменилась', 'ORDER');
  }
  function change(who, raw, body, action) {
    mutation(body, action === 'confirm' ? ['requirement', 'channel', 'note'] : [], action === 'confirm' ? ['attachmentRef'] : []); actor(who, true);
    let prepared = null;
    if (action === 'advance') {
      const before = orderContext(raw), by=actor(who,true), known=replay(before.current,by,body,action);
      const index=before.current.stages.findIndex(stage=>stage.id===before.current.currentStageId),stage=before.current.stages[index];
      if (!known.duplicate && stage && before.current.stages[index+1]?.id==='issued') {
        if (stage.requirements.some(requirement=>!before.current.confirmations.some(c=>(LEGACY_STAGE[c.stageId]||c.stageId)===stage.id && c.requirement===requirement)))
          fail(409,'Сначала подтвердите условия текущего этапа','REQUIREMENTS');
        prepared=prepareIssued(before,who);
      }
    }
    return transaction(() => {
      const by = actor(who, true), ctx = orderContext(raw), old = ctx.current, known = replay(old, by, body, action);
      if (known.duplicate) return { ...view(ctx, who), duplicate: true };
      if (['cancelled','issued'].includes(old.currentStageId) || ['cancelled','done'].includes(ctx.order.work?.status)) fail(409, 'Завершённую заявку нельзя продвигать', 'TERMINAL');
      const index = old.stages.findIndex(s => s.id === old.currentStageId), stage = old.stages[index], value = clone(old);
      if (action === 'confirm') {
        if (!stage.requirements.includes(body.requirement) || !CHANNELS.includes(body.channel)) fail(400, 'Условие не относится к текущему этапу');
        const note = text(body.note, 1000, body.channel === 'app');
        const photo = body.requirement === 'photo_sent' ? checkPhoto(ctx, body) : null;
        if (!photo && Object.hasOwn(body, 'attachmentRef')) fail(400, 'Вложение допустимо только для фото из чата');
        if (value.confirmations.some(c => c.stageId === stage.id && c.requirement === body.requirement)) fail(409, 'Это условие уже подтверждено', 'ALREADY_CONFIRMED');
        value.confirmations.push({ stageId: stage.id, requirement: body.requirement, channel: body.channel, note, at: at(), actor: { id: by.id, label: by.label }, ...(photo?.attachmentRef ? { attachmentRef: photo.attachmentRef } : {}) });
      } else {
        const missing = stage.requirements.filter(r => !value.confirmations.some(c => (LEGACY_STAGE[c.stageId] || c.stageId) === stage.id && c.requirement === r));
        if (missing.length) fail(409, 'Сначала подтвердите условия текущего этапа', 'REQUIREMENTS');
        if (stage.id === 'preparing') {
          const confirmed = value.confirmations.find(c => c.stageId === stage.id && c.requirement === 'photo_sent');
          checkPhoto(ctx, confirmed);
        }
        const target = old.stages[index + 1]?.id;
        if (!target) fail(409, 'Заказ уже завершён', 'TERMINAL');
        applyStage(ctx, value, target, who, by, prepared);
      }
      value.history.push({ action, stageId: stage.id, nextStageId: value.currentStageId, at: at(), actor: { id: by.id, label: by.label } });
      value.history = value.history.slice(-500); value.receipts = receipt(old, by, body, known.hash);
      actor(who, true); ctx.current = save(ctx.key, old, value, by); actor(who, true);
      return { ...view(ctx, who), duplicate: false };
    });
  }
  function stageConfirmation(ctx, body) {
    const target = body.stageId;
    if (target === 'cancelled') { if (Object.hasOwn(body, 'confirmation')) fail(400, 'Подтверждение не относится к отказу'); return { reason: text(body.reason, 300) }; }
    if (Object.hasOwn(body, 'reason')) fail(400, 'Причина допустима только для отказа');
    if (target === 'paid') { exact(body.confirmation, ['paymentReceived']); if (body.confirmation.paymentReceived !== true) fail(400, 'Подтвердите полученную оплату'); return { paymentReceived: true }; }
    if (target === 'waiting') { exact(body.confirmation, ['photoSent','channel','note'], ['attachmentRef']); if (body.confirmation.photoSent !== true) fail(400, 'Подтвердите отправку фото'); return { photoSent: true, ...checkPhoto(ctx, body.confirmation) }; }
    if (target === 'issued') { exact(body.confirmation, ['handedOver']); if (body.confirmation.handedOver !== true) fail(400, 'Подтвердите фактическую передачу заказа'); return { handedOver: true }; }
    if (Object.hasOwn(body, 'confirmation')) fail(400, 'Подтверждение не относится к этапу');
    return null;
  }
  function setStage(who, raw, body) {
    mutation(body, ['stageId'], ['reason','confirmation']);
    if (typeof body.stageId !== 'string' || !ID.test(body.stageId)) fail(400, 'Некорректный этап', 'STAGE');
    actor(who, true);
    let prepared=null;
    if (body.stageId==='issued') {
      const before=orderContext(raw), by=actor(who,true), known=replay(before.current,by,body,'set-stage');
      // A successful retry binds only its original request, never newer memo settings.
      if (!known.duplicate) {
        if (['cancelled','done'].includes(before.order.work?.status)) fail(409,'Завершённую заявку нельзя менять','TERMINAL');
        const index=before.current.stages.findIndex(stage=>stage.id===before.current.currentStageId);
        if (before.current.stages[index+1]?.id!==body.stageId) fail(409,'Переходите к следующему этапу по порядку','STAGE_SEQUENCE');
        stageConfirmation(before,body); prepared=prepareIssued(before,who);
      }
    }
    return transaction(() => {
      const by = actor(who, true), ctx = orderContext(raw), old = ctx.current, known = replay(old, by, body, 'set-stage');
      const previous = old.receipts.find(r => r.actorId === by.id && r.requestId === body.requestId);
      if (known.duplicate) {
        if (!Number.isSafeInteger(previous?.appliedRevision) || previous.appliedRevision < 1) fail(503, 'Квитанция этапа повреждена', 'STATE');
        return { ...view(ctx, who), duplicate: true, stageReceipt: { requestId: body.requestId, stageId: body.stageId, revision: previous.appliedRevision } };
      }
      if (old.currentStageId === 'cancelled' || (ctx.order.work?.status === 'done' && body.stageId !== 'cancelled')) fail(409, 'Завершённую или отменённую заявку нельзя менять', 'TERMINAL');
      if (body.stageId !== 'cancelled' && !old.stages.some(stage => stage.id === body.stageId)) fail(409, 'Этап не относится к заявке', 'STAGE');
      if (old.currentStageId === body.stageId) fail(409, 'Заявка уже на этом этапе', 'SAME_STAGE');
      const index=old.stages.findIndex(stage=>stage.id===old.currentStageId);
      if (body.stageId!=='cancelled' && old.stages[index+1]?.id!==body.stageId) fail(409,'Переходите к следующему этапу по порядку','STAGE_SEQUENCE');
      const confirmation = stageConfirmation(ctx, body), value = clone(old), appliedRevision = old.revision + 1;
      if (body.stageId === 'cancelled') value.refusal = { reason: confirmation.reason, at: at(), actor: { id: by.id, label: by.label } };
      if (confirmation && body.stageId !== 'cancelled') value.confirmations.push({ stageId: body.stageId, entry: clone(confirmation), at: at(), actor: { id: by.id, label: by.label } });
      value.history.push({ action: 'set-stage', stageId: old.currentStageId, nextStageId: body.stageId, at: at(), actor: { id: by.id, label: by.label },
        ...(confirmation ? { confirmation: clone(confirmation) } : {}), ...(body.stageId==='cancelled' ? {reason:confirmation.reason} : {}) });
      value.history = value.history.slice(-500); value.receipts = receipt(old, by, body, known.hash);
      value.receipts.at(-1).appliedRevision = appliedRevision;
      applyStage(ctx, value, body.stageId, who, by, prepared);
      actor(who, true); ctx.current = save(ctx.key, old, value, by); actor(who, true);
      return { ...view(ctx, who), duplicate: false, stageReceipt: { requestId: body.requestId, stageId: body.stageId, revision: appliedRevision } };
    });
  }
  const threadReplyKey = threadId => `${KEY}/chat-autoreply/${threadId}`;
  const orderReplyKey = orderId => `${KEY}/order-autoreply/${orderId}`;
  const replyActor = { id: 0, label: 'Автоответ Palitra Love' };
  const replyText = reply => [reply.text, ...reply.questions.map(q => `${q.label}${q.options.length ? ` (${q.options.join(' / ')})` : ''}`)].filter(Boolean).join('\n\n');
  const orderReceivedText = orderId => `Заявка №${orderId} получена. Если нужно что-то добавить, напишите здесь.`;
  function canonicalOrderThread(thread) {
    if (!thread || thread.site !== SITE || thread.company_code !== COMPANY || !Number.isSafeInteger(thread.id) || thread.id < 1
      || !Number.isSafeInteger(thread.order_id) || thread.order_id < 1) return null;
    const current = db.prepare('SELECT id,site,company_code,order_id FROM chat_threads WHERE id=?').get(thread.id);
    if (!current || current.site !== SITE || current.company_code !== COMPANY || current.order_id !== thread.order_id) return null;
    const order = siteOrders.orderSummary(SITE, current.order_id);
    return order && order.id === current.order_id ? current : null;
  }
  // Read-only display projection: retained canonical text, ids and history are never rewritten.
  function orderReplyDisplay(message) {
    if (!message || !Number.isSafeInteger(message.id) || message.id < 1 || !Number.isSafeInteger(message.thread_id) || message.thread_id < 1
      || message.direction !== 'out' || message.author_kind !== 'manager' || message.source_channel !== 'app') return null;
    const thread = canonicalOrderThread(db.prepare('SELECT id,site,company_code,order_id FROM chat_threads WHERE id=?').get(message.thread_id));
    if (!thread) return null;
    const stored = db.prepare('SELECT id,thread_id,direction,author_kind,source_channel FROM chat_thread_messages WHERE id=?').get(message.id);
    if (!stored || stored.thread_id !== thread.id || stored.direction !== 'out' || stored.author_kind !== 'manager' || stored.source_channel !== 'app') return null;
    const orderReceipt = load(orderReplyKey(thread.order_id));
    if (orderReceipt) {
      if (orderReceipt.orderId !== thread.order_id || orderReceipt.threadId !== thread.id || orderReceipt.replyMessageId !== message.id
        || !['stored', 'legacy'].includes(orderReceipt.outcome)) return null;
    } else {
      const legacy = load(threadReplyKey(thread.id));
      if (!legacy || legacy.replyMessageId !== message.id || (legacy.orderId !== undefined && legacy.orderId !== thread.order_id)
        || (legacy.threadId !== undefined && legacy.threadId !== thread.id)) return null;
    }
    return { automaticReplyKind: 'order-received', displayText: orderReceivedText(thread.order_id) };
  }
  // Только новый canonical чат принятой заявки, в общей транзакции заявки/thread/grant.
  function onOrderThreadCreated({ thread, orderId, append } = {}) {
    if (db.isTransaction !== true) fail(503, 'Автоответ требует общей транзакции заявки', 'ORDER_REPLY_TRANSACTION');
    if (!thread || thread.site !== SITE || thread.company_code !== COMPANY || !Number.isSafeInteger(orderId) || orderId < 1
      || !Number.isSafeInteger(thread.id) || thread.id < 1 || thread.order_id !== orderId || typeof append !== 'function') fail(409, 'Заявка и чат автоответа не совпали', 'ORDER_REPLY_SCOPE');
    const canonical = db.prepare('SELECT id,site,company_code,order_id FROM chat_threads WHERE id=?').get(thread.id);
    const order = siteOrders.orderSummary(SITE, orderId);
    if (!canonical || canonical.site !== SITE || canonical.company_code !== COMPANY || canonical.order_id !== orderId
      || !order || order.id !== orderId) fail(409, 'Заявка и чат автоответа не совпали', 'ORDER_REPLY_SCOPE');
    const key = orderReplyKey(orderId), known = load(key);
    if (known) {
      if (known.orderId !== orderId || known.threadId !== thread.id) fail(409, 'Квитанция автоответа относится к другому чату', 'ORDER_REPLY_SCOPE');
      return { duplicate: true, outcome: known.outcome, replyMessageId: known.replyMessageId };
    }
    const previous = load(threadReplyKey(thread.id));
    if (previous) {
      const message = db.prepare('SELECT thread_id,direction,author_kind,source_channel FROM chat_thread_messages WHERE id=?').get(previous.replyMessageId);
      if (!message || message.thread_id !== thread.id || message.direction !== 'out' || message.author_kind !== 'manager' || message.source_channel !== 'app') fail(503, 'Сохранённый автоответ не подтверждён историей', 'STATE');
      save(key, null, { orderId, threadId: thread.id, outcome: 'legacy', replyMessageId: previous.replyMessageId, questions: clone(previous.questions || []) }, replyActor);
      return { duplicate: true, outcome: 'legacy', replyMessageId: previous.replyMessageId };
    }
    const config = configRecord(), reply = config.autoReply;
    const decision = { orderId, threadId: thread.id, configRevision: config.revision,
      outcome: reply.enabled ? 'stored' : 'disabled', replyMessageId: null, questions: [] };
    if (reply.enabled) {
      decision.replyMessageId = append(orderReceivedText(orderId));
      save(threadReplyKey(thread.id), null, { replyMessageId: decision.replyMessageId, questions: decision.questions,
        orderId, configRevision: config.revision, trigger: 'order-created' }, replyActor);
    }
    // Выключенное правило тоже фиксируется: позднее включение не переигрывает прежнюю заявку.
    save(key, null, decision, replyActor);
    return { duplicate: false, outcome: decision.outcome, replyMessageId: decision.replyMessageId };
  }
  // Совместимость старых чатов: первый web-входящий, если по заявке ещё не было решения/автоответа.
  function onCustomerMessage({ thread, messageId, source, append }) {
    if (!thread || thread.site !== SITE || thread.company_code !== COMPANY || source !== 'web' || typeof append !== 'function') return;
    if (load(threadReplyKey(thread.id)) || (Number.isSafeInteger(thread.order_id) && thread.order_id > 0 && load(orderReplyKey(thread.order_id)))) return;
    const first = db.prepare("SELECT id FROM chat_thread_messages WHERE thread_id=? AND direction='in' AND author_kind='customer' ORDER BY id LIMIT 1").get(thread.id);
    if (!first || first.id !== messageId) return;
    const orderThread = Number.isSafeInteger(thread.order_id) && thread.order_id > 0;
    if (orderThread && !canonicalOrderThread(thread)) return;
    const reply = orderThread ? configRecord().autoReply : widgetRecord().autoReply;
    if (!reply.enabled) return;
    const questions = [];
    const replyMessageId = append(orderThread ? orderReceivedText(thread.order_id) : reply.text);
    save(threadReplyKey(thread.id), null, { replyMessageId, questions }, replyActor);
  }
  function customerQuestions(thread) {
    if (!thread || thread.site !== SITE || thread.company_code !== COMPANY) return [];
    if (canonicalOrderThread(thread)) return [];
    const snapshot = load(threadReplyKey(thread.id));
    return snapshot && Array.isArray(snapshot.questions) ? clone(snapshot.questions) : [];
  }
  return Object.freeze({ getConfig, putConfig, getWidgetSettings, putWidgetSettings, getPublicWidgetSettings,
    getOrder, customerOrder, getCompletionSettings, putCompletionSettings, getFunnelReport, workflowAdvice, onMessageStored, confirm: (who, id, body) => change(who, id, body, 'confirm'), advance: (who, id, body) => change(who, id, body, 'advance'),
    setStage, onCustomerMessage, onOrderThreadCreated, customerQuestions, orderReplyDisplay });
}
function createWorkflowHttp({ workflow, requireSession, requireCsrf, readJson, origin }) {
  return async function handle(request, url, reply) {
    if (url.pathname === '/content/palitra/workflow/completion-settings' || url.pathname === '/content/palitra/workflow/funnel-report') {
      const headers = { 'cache-control': 'no-store' }, before = requireSession(request), settings = url.pathname.endsWith('/completion-settings');
      const who = session => ({ id: session.user.id, sessionVersion: session.user.sessionVersion });
      if (!canAccess(before.user, settings ? 'crm.edit' : 'crm.view')) fail(403, 'Нет доступа к настройкам Palitra Love', 'ACCESS');
      if (url.search) fail(400, 'Параметры адреса не поддерживаются');
      if (request.method === 'GET') { reply(200, settings ? workflow.getCompletionSettings(who(before)) : workflow.getFunnelReport(who(before)), headers); return true; }
      if (!settings || request.method !== 'PUT') fail(405, 'Метод не поддерживается', 'METHOD');
      if (request.headers.origin !== origin) fail(403, 'Запрос с другого адреса запрещён', 'ORIGIN');
      requireCsrf(request, before);
      if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) fail(415, 'Ожидался JSON');
      const body = await readJson(request), fresh = requireSession(request);
      if (fresh.user.id !== before.user.id || fresh.user.sessionVersion !== before.user.sessionVersion) fail(403, 'Доступ изменился', 'ACCESS');
      requireCsrf(request, fresh);
      reply(200, workflow.putCompletionSettings(who(fresh), body), headers); return true;
    }
    if (url.pathname === '/content/palitra/workflow/widget-settings') {
      const headers = { 'cache-control': 'no-store' }, before = requireSession(request);
      const who = s => ({ id: s.user.id, sessionVersion: s.user.sessionVersion });
      if (!canAccess(before.user, request.method === 'PUT' ? 'crm.edit' : 'crm.view') || before.user.role !== 'owner') fail(403, 'Нет доступа к настройкам чата Palitra Love', 'ACCESS');
      if (url.search) fail(400, 'Параметры адреса не поддерживаются');
      if (request.method === 'GET') { reply(200, workflow.getWidgetSettings(who(before)), headers); return true; }
      if (request.method !== 'PUT') fail(405, 'Метод не поддерживается', 'METHOD');
      if (request.headers.origin !== origin) fail(403, 'Запрос с другого адреса запрещён', 'ORIGIN');
      requireCsrf(request, before);
      if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) fail(415, 'Ожидался JSON');
      const body = await readJson(request), fresh = requireSession(request);
      if (fresh.user.id !== before.user.id || fresh.user.sessionVersion !== before.user.sessionVersion) fail(403, 'Доступ изменился', 'ACCESS');
      requireCsrf(request, fresh);
      reply(200, workflow.putWidgetSettings(who(fresh), body), headers); return true;
    }
    const threadRoute = /^\/content\/palitra\/workflow\/threads\/[1-9]\d{0,14}(?:\/(?:confirm|advance|stage))?$/.test(url.pathname);
    const match = /^\/content\/palitra\/workflow(?:\/orders\/([1-9]\d{0,14})(?:\/(confirm|advance|stage))?)?$/.exec(threadRoute ? url.pathname.replace('/threads/','/orders/') : url.pathname);
    if (!match) return false;
    const resourceId = threadRoute ? `thread:${match[1]}` : match[1];
    const headers = { 'cache-control': 'no-store' }, before = requireSession(request), who = s => ({ id: s.user.id, sessionVersion: s.user.sessionVersion });
    const write = !['GET', 'HEAD'].includes(request.method);
    if (!canAccess(before.user, write ? 'crm.edit' : 'crm.view') || (write && !match[1] && before.user.role !== 'owner')) fail(403, 'Нет доступа к этапам Palitra Love', 'ACCESS');
    if (url.search) fail(400, 'Параметры адреса не поддерживаются');
    if (request.method === 'GET' && !match[2]) { reply(200, match[1] ? workflow.getOrder(who(before), resourceId) : workflow.getConfig(who(before)), headers); return true; }
    const method = match[1] ? 'POST' : 'PUT';
    if (request.method !== method || (match[1] && !match[2])) fail(405, 'Метод не поддерживается', 'METHOD');
    if (request.headers.origin !== origin) fail(403, 'Запрос с другого адреса запрещён', 'ORIGIN');
    requireCsrf(request, before);
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) fail(415, 'Ожидался JSON');
    const body = await readJson(request), fresh = requireSession(request);
    if (fresh.user.id !== before.user.id || fresh.user.sessionVersion !== before.user.sessionVersion) fail(403, 'Доступ изменился', 'ACCESS');
    requireCsrf(request, fresh);
    const result = !match[1] ? workflow.putConfig(who(fresh), body)
      : match[2] === 'stage' ? workflow.setStage(who(fresh), resourceId, body) : workflow[match[2]](who(fresh), resourceId, body);
    reply(200, result, headers); return true;
  };
}
module.exports = { createWorkflow, createWorkflowHttp, validateConfig, validateWidgetSettings, canAccess, REQUIREMENTS, CHANNELS, DEFAULT, DEFAULT_WIDGET, DEFAULT_COMPLETION, validateCompletion };
