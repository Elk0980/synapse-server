'use strict';
// Read-only observation of real customer messages and confirmed human replies.
// Only initializeObservation writes one new versioned document at launch.
const SITE = 'palitra', COMPANY = 'palitra-love';
const OBSERVATION_KEY = 'palitra-love/response-time-observation/v1';
const CHANNELS = ['site', 'telegram', 'vk', 'instagram', 'youtube', 'tiktok'];
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const iso = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) fail(400, 'DATE', 'Нужна дата UTC');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(400, 'DATE', 'Некорректная дата UTC');
  return new Date(time).toISOString();
};
const dateMs = (value, label) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(503, 'STATE', `Повреждена дата ${label}`);
  return time;
};
const seconds = (end, start) => Math.max(0, Math.floor((end - start) / 1000));
const median = sorted => {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = values => {
  if (!values.length) return { sampleCount: 0, medianSeconds: null, meanSeconds: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { sampleCount: values.length, medianSeconds: median(sorted),
    meanSeconds: Math.round((values.reduce((sum, item) => sum + item, 0) / values.length) * 10) / 10 };
};
function createResponseReport({ db, transaction, getUser, channelState, now = Date.now } = {}) {
  if (!db || typeof transaction !== 'function' || typeof getUser !== 'function'
    || typeof channelState !== 'function') throw new TypeError('Нужен штатный хост отчёта и состояние каналов');
  const selectObservation = db.prepare('SELECT version,body FROM documents WHERE key=? ORDER BY version');
  const insertObservation = db.prepare('INSERT INTO documents(key,version,created_at,author,body) VALUES(?,?,?,?,?)');
  const readCanonical = db.prepare(`SELECT t.id AS conversation_id,m.id,m.direction,m.author_kind,m.source_channel,
      m.owner_user_id,m.created_at,d.status AS delivery_status,d.updated_at AS delivery_at,
      r.request_id AS checkout_request
    FROM chat_thread_messages m JOIN chat_threads t ON t.id=m.thread_id
    LEFT JOIN chat_message_deliveries d ON d.message_id=m.id AND d.channel='customer_telegram'
    LEFT JOIN chat_thread_requests r ON r.message_id=m.id AND r.actor_kind='web'
      AND r.request_id LIKE 'checkout-order:%'
    WHERE t.site=? AND t.company_code=? ORDER BY t.id,m.created_at,m.id`);
  const readLegacy = db.prepare(`SELECT g.id AS conversation_id,m.id,m.direction,m.author_type,
      m.created_at,m.delivery_status,
      (SELECT MIN(o.finished_at) FROM client_bot_outbox o
        WHERE o.message_id=m.id AND o.dialog_id=g.id AND o.bot_key=g.bot_key
          AND o.company_code=g.company_code AND o.kind='reply' AND o.status='sent'
          AND o.finished_at IS NOT NULL) AS delivered_at
    FROM client_dialog_messages m JOIN client_dialogs g ON g.id=m.dialog_id
    WHERE g.bot_key='palitra' AND g.company_code=? AND m.bot_key=g.bot_key
      AND m.company_code=g.company_code ORDER BY g.id,m.created_at,m.id`);
  function fresh(user) {
    if (!user || !Number.isSafeInteger(user.id) || user.id < 1
      || !Number.isSafeInteger(user.sessionVersion)) fail(403, 'ACCESS', 'Требуется действующая сессия');
    const current = getUser(user.id);
    if (!current || current.sessionVersion !== user.sessionVersion
      || !(current.role === 'owner' || (Array.isArray(current.companyCodes)
        && current.companyCodes.includes(COMPANY) && Array.isArray(current.permissions)
        && current.permissions.includes('crm.view')))) fail(403, 'ACCESS', 'Доступ изменился');
  }
  function observation() {
    const rows = selectObservation.all(OBSERVATION_KEY);
    if (!rows.length) return null;
    if (rows.length !== 1 || rows[0].version !== 1) fail(503, 'STATE', 'Журнал наблюдения повреждён');
    let parsed;
    try { parsed = JSON.parse(rows[0].body); } catch (_) { fail(503, 'STATE', 'Журнал наблюдения повреждён'); }
    if (parsed?.schema !== 1 || typeof parsed.observationStartedAt !== 'string')
      fail(503, 'STATE', 'Журнал наблюдения повреждён');
    let startedAt;
    try { startedAt = iso(parsed.observationStartedAt); }
    catch (_) { fail(503, 'STATE', 'Журнал наблюдения повреждён'); }
    return { startedAt, startedMs: dateMs(startedAt, 'начала наблюдения') };
  }
  function initializeObservation() {
    return transaction(() => {
      const existing = observation();
      if (existing) return { observationStartedAt: existing.startedAt, duplicate: true };
      const observationStartedAt = new Date(now()).toISOString();
      insertObservation.run(OBSERVATION_KEY, 1, observationStartedAt, 'response-report:init',
        JSON.stringify({ schema: 1, observationStartedAt }));
      return { observationStartedAt, duplicate: false };
    });
  }
  function states() {
    const current = channelState();
    if (!current || typeof current !== 'object' || Array.isArray(current)) fail(503, 'CHANNEL_STATE', 'Состояние каналов недоступно');
    return Object.fromEntries(CHANNELS.map(id => {
      const value = current[id] || 'unobserved';
      if (!['connected', 'not_connected', 'unobserved'].includes(value))
        fail(503, 'CHANNEL_STATE', 'Состояние канала недоступно');
      return [id, value];
    }));
  }
  function read(user, from, until) {
    fresh(user);
    const asOf = new Date(now()).toISOString(), asOfMs = dateMs(asOf, 'чтения');
    const started = observation(), connection = states();
    const requestedFrom = from === undefined || from === null || from === '' ? null : iso(from);
    const requestedUntil = until === undefined || until === null || until === '' ? asOf : iso(until);
    const untilMs = dateMs(requestedUntil, 'конца периода');
    if (untilMs > asOfMs) fail(400, 'DATE', 'Конец периода в будущем');
    const requestedFromMs = requestedFrom ? dateMs(requestedFrom, 'начала периода') : null;
    if (requestedFromMs !== null && requestedFromMs >= untilMs) fail(400, 'DATE', 'Начало периода должно быть раньше конца');
    const lowerBound = started ? Math.max(started.startedMs, requestedFromMs === null ? started.startedMs : requestedFromMs) : null;
    const effectiveFromMs = lowerBound !== null && lowerBound < untilMs ? lowerBound : null;
    const data = Object.fromEntries(CHANNELS.map(id => [id, {
      first: [], subsequent: [], waiting: [], beforeObservationWaiting: [] }]));
    if (started) {
      const conversations = new Map();
      const add = (key, channel, event) => {
        const group = `${key}|${channel}`;
        if (!conversations.has(group)) conversations.set(group, { channel, events: [] });
        conversations.get(group).events.push(event);
      };
      for (const row of readCanonical.all(SITE, COMPANY)) {
        if (row.checkout_request !== null) continue;
        const authoredMs = dateMs(row.created_at, 'сообщения');
        if (authoredMs > asOfMs) continue;
        const key = `web:${row.conversation_id}`;
        if (row.direction === 'in' && row.author_kind === 'customer') {
          if (row.source_channel === 'web' || row.source_channel === 'telegram')
            add(key, row.source_channel === 'web' ? 'site' : 'telegram',
              { kind: 'in', effectiveMs: authoredMs, authoredMs, id: row.id });
        } else if (row.direction === 'out'
          && (row.author_kind === 'owner' && Number.isSafeInteger(row.owner_user_id) && row.owner_user_id > 0
            || row.author_kind === 'manager' && row.source_channel === 'manager_telegram')) {
          // A canonical human message is visible on the website as soon as it is stored.
          add(key, 'site', { kind: 'out', effectiveMs: authoredMs, authoredMs, id: row.id });
          // Telegram is answered only after a confirmed customer-side delivery.
          if (row.delivery_status === 'sent' && row.delivery_at) {
            const deliveredMs = dateMs(row.delivery_at, 'подтверждения доставки');
            if (deliveredMs >= authoredMs && deliveredMs <= asOfMs)
              add(key, 'telegram', { kind: 'out', effectiveMs: deliveredMs, authoredMs, id: row.id });
          }
        }
      }
      for (const row of readLegacy.all(COMPANY)) {
        const authoredMs = dateMs(row.created_at, 'старого диалога');
        if (authoredMs > asOfMs) continue;
        const key = `legacy:${row.conversation_id}`;
        if (row.direction === 'in' && row.author_type === 'client')
          add(key, 'telegram', { kind: 'in', effectiveMs: authoredMs, authoredMs, id: row.id });
        else if (row.direction === 'out' && row.author_type === 'operator'
          && row.delivery_status === 'sent' && row.delivered_at) {
          const deliveredMs = dateMs(row.delivered_at, 'доставки старого ответа');
          if (deliveredMs >= authoredMs && deliveredMs <= asOfMs)
            add(key, 'telegram', { kind: 'out', effectiveMs: deliveredMs, authoredMs, id: row.id });
        }
      }
      for (const { channel, events } of conversations.values()) {
        events.sort((a, b) => a.effectiveMs - b.effectiveMs || a.id - b.id);
        let pending = [], answered = false;
        for (const event of events) {
          if (event.kind === 'in') {
            // Keep all incoming messages: delivery may be confirmed after a newer
            // customer message that the older authored reply could not answer.
            pending.push({ at: event.effectiveMs, id: event.id });
          } else {
            const eligible = item => item.at < event.authoredMs
              || item.at === event.authoredMs && item.id < event.id;
            const firstEligible = pending.find(eligible);
            if (!firstEligible) continue;
            pending = pending.filter(item => !eligible(item));
            if (effectiveFromMs !== null && firstEligible.at >= started.startedMs && event.effectiveMs >= effectiveFromMs
              && event.effectiveMs < untilMs)
              data[channel][answered ? 'subsequent' : 'first'].push(seconds(event.effectiveMs, firstEligible.at));
            answered = true;
          }
        }
        if (pending.length) {
          const oldest = pending[0].at;
          data[channel][oldest >= started.startedMs ? 'waiting' : 'beforeObservationWaiting'].push(oldest);
        }
      }
    }
    fresh(user);
    const channels = CHANNELS.map(id => {
      const item = data[id], waiting = item.waiting;
      const oldest = waiting.reduce((minimum, value) => minimum === null ? value : Math.min(minimum, value), null);
      const old = item.beforeObservationWaiting;
      const oldOldest = old.reduce((minimum, value) => minimum === null ? value : Math.min(minimum, value), null);
      return { id, status: connection[id], first: summary(item.first), subsequent: summary(item.subsequent),
        waiting: { count: waiting.length, oldestSince: oldest === null ? null : new Date(oldest).toISOString(),
          oldestSeconds: oldest === null ? null : seconds(asOfMs, oldest) },
        beforeObservationWaiting: { count: old.length, oldestSince: oldOldest === null ? null : new Date(oldOldest).toISOString() } };
    });
    return { schema: 'palitra-response-report/v1', companyCode: COMPANY, asOf,
      observationStartedAt: started?.startedAt || null,
      range: { from: effectiveFromMs === null ? null : new Date(effectiveFromMs).toISOString(), until: requestedUntil,
        truncatedAtStart: Boolean(started && requestedFrom && dateMs(requestedFrom, 'начала периода') < started.startedMs) },
      coverage: { status: started ? 'observing' : 'not_started', beforeObservation: 'excluded',
        period: started ? effectiveFromMs === null ? 'before_observation' : 'observed' : 'not_started',
        canonicalTelegramSentAt: 'latest-confirmed-delivery-update', legacyTelegramSentAt: 'outbox-finished-at' },
      channels };
  }
  return Object.freeze({ initializeObservation, read });
}
module.exports = { createResponseReport };
