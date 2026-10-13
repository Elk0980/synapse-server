'use strict';

// Неизменяемый журнал принятых HTTP-заявок POST /leads (ветки create и dedup).
// Каждая принятая попытка — отдельный receipt: это не уникальные лиды/люди, не первое касание,
// не native-запись и не деньги. Метки заявлены публичным клиентом (DECLARED_PUBLIC).
// Модуль не пишет в leads/outbox/YCLIENTS и не открывает транзакций: appendAccepted
// вызывается внутри уже открытой вызывающим кодом BEGIN IMMEDIATE (db.isTransaction === true).
//
// Полнота периода доказывается только сохранёнными сессиями писателя (runtime epochs):
// start → heartbeat… → close. Сессия покрывает [start, последнее сохранённое событие];
// текущий активный экземпляр в памяти расширяет свой интервал до server now.
// Промежутки между сессиями, хвост после последнего heartbeat упавшего экземпляра и время
// до первой сессии не покрыты. Одиночный stamp активации полноту не доказывает.

const {randomUUID: defaultRandomUUID} = require('node:crypto');

const WRITER_VERSION = 'lead-receipts/v1';
const COVERAGE_PROTOCOL = 'revenue-lead-writer-sessions/v1';
// Часовые пояса экономического календаря; другой список — только явный внутренний options.timezones.
const DEFAULT_TIMEZONES = Object.freeze(['Asia/Irkutsk', 'Europe/Moscow', 'Asia/Bangkok', 'UTC']);
const OUTCOMES = new Set(['created', 'deduplicated']);
const ORIGIN_STATES = new Set(['matched', 'missing', 'mismatch', 'internal', 'unknown']);
const CONTEXT_KEYS = new Set(['companyCode', 'leadId', 'outcome', 'originState', 'declared']);
const LABEL_FIELDS = Object.freeze({
  source: 'declared_source',
  utmSource: 'utm_source',
  utmMedium: 'utm_medium',
  utmCampaign: 'utm_campaign',
  utmContent: 'utm_content',
  utmTerm: 'utm_term',
});
const DECLARED_KEYS = new Set([...Object.keys(LABEL_FIELDS), 'landingPage']);
const MAX_LABEL_LENGTH = 200;
const MAX_URL_LENGTH = 2048;
const MAX_COMPANY_CODE_LENGTH = 200;
const MAX_REGRESSION_WINDOWS = 64;
const LABEL_PATTERN = /^[\p{L}\p{M}\p{N} _.,+|()~*-]+$/u;
const DIGIT_RUN = /\p{Nd}{7,}/u;
const PHONE_LIKE = /(?:\p{Nd}[ ().+-]*){10}/u;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS revenue_lead_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    received_ms INTEGER NOT NULL CHECK (received_ms > 0),
    company_code TEXT COLLATE NOCASE,
    lead_id INTEGER NOT NULL CHECK (lead_id > 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('created', 'deduplicated')),
    origin_state TEXT NOT NULL
      CHECK (origin_state IN ('matched', 'missing', 'mismatch', 'internal', 'unknown')),
    writer_version TEXT NOT NULL,
    trust TEXT NOT NULL DEFAULT 'declared_public' CHECK (trust = 'declared_public'),
    declared_source TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    landing_host TEXT
  );
  CREATE INDEX IF NOT EXISTS revenue_lead_receipts_company_received_idx
    ON revenue_lead_receipts(company_code, received_ms);
  CREATE INDEX IF NOT EXISTS revenue_lead_receipts_received_idx ON revenue_lead_receipts(received_ms);
  CREATE INDEX IF NOT EXISTS revenue_lead_receipts_lead_idx ON revenue_lead_receipts(lead_id);
  CREATE UNIQUE INDEX IF NOT EXISTS revenue_lead_receipts_created_uidx
    ON revenue_lead_receipts(lead_id) WHERE outcome = 'created';
  CREATE TRIGGER IF NOT EXISTS revenue_lead_receipts_no_replace
    BEFORE INSERT ON revenue_lead_receipts
    WHEN EXISTS (SELECT 1 FROM revenue_lead_receipts WHERE id = NEW.id)
      OR (NEW.outcome = 'created' AND EXISTS (
        SELECT 1 FROM revenue_lead_receipts WHERE lead_id = NEW.lead_id AND outcome = 'created'))
    BEGIN SELECT RAISE(ABORT, 'revenue_lead_receipts is append-only: receipt already exists'); END;
  CREATE TRIGGER IF NOT EXISTS revenue_lead_receipts_no_update
    BEFORE UPDATE ON revenue_lead_receipts
    BEGIN SELECT RAISE(ABORT, 'revenue_lead_receipts is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS revenue_lead_receipts_no_delete
    BEFORE DELETE ON revenue_lead_receipts
    BEGIN SELECT RAISE(ABORT, 'revenue_lead_receipts is append-only'); END;
  CREATE TABLE IF NOT EXISTS revenue_lead_receipt_writer (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version TEXT NOT NULL,
    activated_at TEXT NOT NULL,
    activated_ms INTEGER NOT NULL CHECK (activated_ms > 0)
  );
  CREATE TRIGGER IF NOT EXISTS revenue_lead_receipt_writer_no_replace
    BEFORE INSERT ON revenue_lead_receipt_writer
    WHEN EXISTS (SELECT 1 FROM revenue_lead_receipt_writer)
    BEGIN SELECT RAISE(ABORT, 'revenue_lead_receipt_writer activation is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS revenue_lead_receipt_writer_no_update
    BEFORE UPDATE ON revenue_lead_receipt_writer
    BEGIN SELECT RAISE(ABORT, 'revenue_lead_receipt_writer activation is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS revenue_lead_receipt_writer_no_delete
    BEFORE DELETE ON revenue_lead_receipt_writer
    BEGIN SELECT RAISE(ABORT, 'revenue_lead_receipt_writer activation is immutable'); END;
  CREATE TABLE IF NOT EXISTS revenue_lead_writer_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL CHECK (length(session_id) = 36),
    kind TEXT NOT NULL CHECK (kind IN ('start', 'heartbeat', 'close')),
    version TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    occurred_ms INTEGER NOT NULL CHECK (occurred_ms > 0)
  );
  CREATE INDEX IF NOT EXISTS revenue_lead_writer_events_session_idx
    ON revenue_lead_writer_events(session_id, occurred_ms);
  CREATE INDEX IF NOT EXISTS revenue_lead_writer_events_occurred_idx ON revenue_lead_writer_events(occurred_ms);
  CREATE UNIQUE INDEX IF NOT EXISTS revenue_lead_writer_events_start_uidx
    ON revenue_lead_writer_events(session_id) WHERE kind = 'start';
  CREATE TRIGGER IF NOT EXISTS revenue_lead_writer_events_sequence
    BEFORE INSERT ON revenue_lead_writer_events
    WHEN EXISTS (SELECT 1 FROM revenue_lead_writer_events WHERE id = NEW.id)
      OR EXISTS (SELECT 1 FROM revenue_lead_writer_events WHERE session_id = NEW.session_id
        AND (kind = 'close' OR occurred_ms > NEW.occurred_ms OR NEW.kind = 'start'))
      OR (NEW.kind <> 'start' AND NOT EXISTS (
        SELECT 1 FROM revenue_lead_writer_events WHERE session_id = NEW.session_id AND kind = 'start'))
    BEGIN SELECT RAISE(ABORT, 'revenue_lead_writer_events is append-only: invalid session sequence'); END;
  CREATE TRIGGER IF NOT EXISTS revenue_lead_writer_events_no_update
    BEFORE UPDATE ON revenue_lead_writer_events
    BEGIN SELECT RAISE(ABORT, 'revenue_lead_writer_events is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS revenue_lead_writer_events_no_delete
    BEFORE DELETE ON revenue_lead_writer_events
    BEGIN SELECT RAISE(ABORT, 'revenue_lead_writer_events is append-only'); END;
`;

class RevenueLeadReceiptError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'RevenueLeadReceiptError';
    this.code = code;
    this.status = status;
  }
}

const internalError = (code, message) => new RevenueLeadReceiptError(code, message, 500);
const queryError = (message) => new RevenueLeadReceiptError('LEAD_RECEIPT_QUERY_INVALID', message, 400);

// Короткая заявленная метка; неподходящее значение становится null и не отклоняет принятую форму.
function sanitizeDeclaredLabel(value) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFC').trim();
  if (!text || text.length > MAX_LABEL_LENGTH) return null;
  if (!LABEL_PATTERN.test(text) || DIGIT_RUN.test(text) || PHONE_LIKE.test(text)) return null;
  return text;
}

// От landing остаётся только host: userinfo, путь, query и fragment могут содержать PII.
function sanitizeLandingHost(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || !HOST_PATTERN.test(host) || DIGIT_RUN.test(host)) return null;
  return host;
}

function normalizeCompanyCode(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!text || text.length > MAX_COMPANY_CODE_LENGTH || CONTROL_CHARS.test(text)) return null;
  return text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readContext(context) {
  if (!isPlainObject(context)) throw internalError('LEAD_RECEIPT_CONTEXT_INVALID', 'Нужен объект контекста принятой заявки');
  for (const key of Object.keys(context)) {
    if (!CONTEXT_KEYS.has(key)) {
      throw internalError('LEAD_RECEIPT_CONTEXT_INVALID',
        `Поле «${key}» не принимается: время, касания, native-связи и доказательства не задаются вызывающим кодом`);
    }
  }
  let companyCode = null;
  if (context.companyCode !== null) {
    companyCode = normalizeCompanyCode(context.companyCode);
    if (!companyCode) throw internalError('LEAD_RECEIPT_CONTEXT_INVALID', 'companyCode должен быть строкой кода компании или null');
  }
  if (!Number.isSafeInteger(context.leadId) || context.leadId < 1) {
    throw internalError('LEAD_RECEIPT_CONTEXT_INVALID', 'leadId должен быть положительным целым');
  }
  if (!OUTCOMES.has(context.outcome)) {
    throw internalError('LEAD_RECEIPT_CONTEXT_INVALID', 'outcome должен быть created или deduplicated');
  }
  if (!ORIGIN_STATES.has(context.originState)) {
    throw internalError('LEAD_RECEIPT_CONTEXT_INVALID', 'originState должен быть matched, missing, mismatch, internal или unknown');
  }
  const declared = context.declared === undefined || context.declared === null ? {} : context.declared;
  if (!isPlainObject(declared)) throw internalError('LEAD_RECEIPT_CONTEXT_INVALID', 'declared должен быть объектом меток');
  for (const key of Object.keys(declared)) {
    if (!DECLARED_KEYS.has(key)) {
      throw internalError('LEAD_RECEIPT_CONTEXT_INVALID', `Заявленное поле «${key}» в журнал не принимается`);
    }
  }
  const labels = {};
  for (const [field, column] of Object.entries(LABEL_FIELDS)) labels[column] = sanitizeDeclaredLabel(declared[field]);
  return {
    companyCode,
    leadId: context.leadId,
    outcome: context.outcome,
    originState: context.originState,
    labels,
    landingHost: sanitizeLandingHost(declared.landingPage),
  };
}

function parseDay(value, field) {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) throw queryError(`Поле «${field}» должно быть датой YYYY-MM-DD`);
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw queryError(`Поле «${field}» содержит несуществующую дату`);
  }
  return {year, month, day};
}

function nextDay({year, month, day}) {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate()};
}

function createZoneClock(timezones) {
  const formatters = new Map();
  for (const zone of timezones) {
    if (typeof zone !== 'string' || !zone) throw new TypeError('timezones: нужен список IANA-зон');
    formatters.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  function offsetMs(zone, utcMs) {
    const parts = {};
    for (const part of formatters.get(zone).formatToParts(new Date(utcMs))) parts[part.type] = part.value;
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    return local - Math.floor(utcMs / 1000) * 1000;
  }
  // UTC-момент локальной полуночи; повторный расчёт учитывает смену смещения (DST) в этот день.
  function localMidnightMs(zone, {year, month, day}) {
    const wall = Date.UTC(year, month - 1, day);
    let result = wall - offsetMs(zone, wall);
    const corrected = offsetMs(zone, result);
    if (wall - corrected !== result) result = wall - corrected;
    return result;
  }
  return {has: (zone) => formatters.has(zone), localMidnightMs};
}

// Объединение замкнутых интервалов [a, b]; касающиеся интервалы сливаются, нулевые отбрасываются.
function mergeIntervals(intervals) {
  const sorted = intervals.filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

function clipIntervals(merged, lo, hi) {
  return merged.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => a < b);
}

const toIso = (ms) => new Date(ms).toISOString();

function createRevenueLeadReceipts(db, {now = Date.now, timezones = DEFAULT_TIMEZONES, randomUUID = defaultRandomUUID} = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new TypeError('createRevenueLeadReceipts: нужен node:sqlite DatabaseSync');
  }
  if (typeof now !== 'function') throw new TypeError('createRevenueLeadReceipts: now должен быть функцией');
  if (typeof randomUUID !== 'function') throw new TypeError('createRevenueLeadReceipts: randomUUID должен быть функцией');
  if (!Array.isArray(timezones) || timezones.length < 1) throw new TypeError('timezones: нужен непустой список');
  const zones = createZoneClock(timezones);
  const allowedZones = Object.freeze([...timezones]);

  db.exec(SCHEMA);
  // Из leads читаются только id/company_code (сверка контекста) и COUNT(*) для отдельного legacy-факта.
  const getLeadScope = db.prepare('SELECT id, company_code FROM leads WHERE id = ?');
  const countLeadRows = db.prepare(
    'SELECT COUNT(*) AS count FROM leads WHERE company_code = ? COLLATE NOCASE AND created_at >= ? AND created_at < ?'
  );
  const insertReceipt = db.prepare(`
    INSERT INTO revenue_lead_receipts (
      received_at, received_ms, company_code, lead_id, outcome, origin_state, writer_version,
      declared_source, utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_host
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getWriter = db.prepare(
    'SELECT version, activated_at, activated_ms FROM revenue_lead_receipt_writer WHERE id = 1'
  );
  const insertWriter = db.prepare(
    'INSERT INTO revenue_lead_receipt_writer (id, version, activated_at, activated_ms) VALUES (1, ?, ?, ?)'
  );
  const countReceipts = db.prepare(`
    SELECT outcome, COUNT(*) AS count FROM revenue_lead_receipts
    WHERE company_code = ? AND received_ms >= ? AND received_ms < ?
    GROUP BY outcome
  `);
  const insertEvent = db.prepare(`
    INSERT INTO revenue_lead_writer_events (session_id, kind, version, occurred_at, occurred_ms)
    VALUES (?, ?, ?, ?, ?)
  `);
  const getSessionStart = db.prepare(
    "SELECT occurred_ms FROM revenue_lead_writer_events WHERE session_id = ? AND kind = 'start'"
  );
  const getSessionLast = db.prepare(`
    SELECT MAX(occurred_ms) AS last_ms, MAX(kind = 'close') AS closed
    FROM revenue_lead_writer_events WHERE session_id = ?
  `);
  const getFirstActivation = db.prepare(`
    SELECT MIN(ms) AS ms FROM (
      SELECT activated_ms AS ms FROM revenue_lead_receipt_writer
      UNION ALL SELECT MIN(occurred_ms) FROM revenue_lead_writer_events WHERE kind = 'start'
    )
  `);
  const getLastEvent = db.prepare('SELECT MAX(occurred_ms) AS ms FROM revenue_lead_writer_events');
  const getPersistedMax = db.prepare(`
    SELECT MAX(ms) AS ms FROM (
      SELECT MAX(occurred_ms) AS ms FROM revenue_lead_writer_events
      UNION ALL SELECT MAX(received_ms) FROM revenue_lead_receipts
      UNION ALL SELECT MAX(activated_ms) FROM revenue_lead_receipt_writer
    )
  `);
  // Сессии, начавшиеся до конца периода: [start, последнее сохранённое событие].
  const listSessions = db.prepare(`
    SELECT s.occurred_ms AS started_ms,
      (SELECT MAX(e.occurred_ms) FROM revenue_lead_writer_events e WHERE e.session_id = s.session_id) AS last_ms
    FROM revenue_lead_writer_events s
    WHERE s.kind = 'start' AND s.occurred_ms < ?
    ORDER BY s.occurred_ms, s.id
  `);
  // Сохранённое свидетельство отката часов: receipt позже по id, но раньше по времени предыдущих.
  const countReceiptClockRegressions = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT received_ms, MAX(received_ms) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_max
      FROM revenue_lead_receipts
    ) WHERE prior_max > received_ms AND received_ms < ? AND prior_max > ?
  `);

  const readPersistedMax = () => Number(getPersistedMax.get().ms) || 0;
  // Состояние только этого экземпляра (процесса); другие экземпляры видят лишь сохранённые события.
  const runtime = {sessionId: null, activation: null, closed: false, closeResult: null};
  const regressions = [];
  let maxSeenMs = readPersistedMax();

  function noteRegression(fromMs, toMs) {
    regressions.push([fromMs, toMs]);
    if (regressions.length > MAX_REGRESSION_WINDOWS) {
      // Схлопывание в общий охват только расширяет окно недоверия (fail-closed).
      const envelope = [Math.min(...regressions.map((w) => w[0])), Math.max(...regressions.map((w) => w[1]))];
      regressions.splice(0, regressions.length, envelope);
    }
  }

  function serverNow() {
    const value = Math.floor(Number(now()));
    if (!Number.isSafeInteger(value) || value <= 0 || value > 253402300799999) {
      throw internalError('LEAD_RECEIPT_CLOCK_INVALID', 'Часы сервера вернули недопустимое время');
    }
    if (value < maxSeenMs) noteRegression(value, maxSeenMs);
    else maxSeenMs = value;
    return value;
  }

  function readWriter() {
    const row = getWriter.get();
    return row ? {version: row.version, activatedAt: row.activated_at, activatedMs: Number(row.activated_ms)} : null;
  }

  function readSessionLast(sessionId) {
    const row = getSessionLast.get(sessionId);
    return {lastMs: row.last_ms === null ? null : Number(row.last_ms), closed: Number(row.closed) === 1};
  }

  function newSessionId() {
    const value = randomUUID();
    if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
      throw internalError('LEAD_RECEIPT_WRITER_SESSION_INVALID', 'sessionId должен быть непрозрачным UUID в нижнем регистре');
    }
    if (getSessionStart.get(value)) {
      throw internalError('LEAD_RECEIPT_WRITER_SESSION_INVALID', 'sessionId уже использован другой сессией');
    }
    return value;
  }

  // Root вызывает при startup после установки обоих producer hooks, вне транзакции.
  // Каждый экземпляр фабрики получает новую сессию; повтор в том же экземпляре идемпотентен.
  // Первый глобальный stamp сохраняется историей и в activatedAt, но полноту не доказывает.
  function activateWriter({version} = {}) {
    if (version !== WRITER_VERSION) {
      throw internalError('LEAD_RECEIPT_WRITER_VERSION', `Поддерживается только версия ${WRITER_VERSION}`);
    }
    if (runtime.closed) {
      throw internalError('LEAD_RECEIPT_WRITER_STATE', 'Закрытый экземпляр не активируется повторно: нужен новый startup');
    }
    if (runtime.activation) {
      if (!getSessionStart.get(runtime.sessionId)) {
        throw internalError('LEAD_RECEIPT_WRITER_STATE', 'Сессия писателя не сохранена в базе');
      }
      return runtime.activation;
    }
    if (db.isTransaction !== false) {
      throw internalError('LEAD_RECEIPT_ACTIVATION_IN_TRANSACTION', 'activateWriter вызывается вне транзакции при startup');
    }
    const existing = readWriter();
    if (existing && existing.version !== version) {
      throw internalError('LEAD_RECEIPT_WRITER_VERSION', 'Активирована другая версия журнала заявок');
    }
    const ceiling = Math.max(maxSeenMs, readPersistedMax());
    const stamp = serverNow();
    if (stamp < ceiling) {
      throw internalError('LEAD_RECEIPT_CLOCK_REGRESSION', 'Часы сервера раньше сохранённых событий: сессия не создаётся');
    }
    const sessionId = newSessionId();
    const startedAt = toIso(stamp);
    if (!existing) insertWriter.run(version, startedAt, stamp);
    insertEvent.run(sessionId, 'start', version, startedAt, stamp);
    runtime.sessionId = sessionId;
    runtime.activation = Object.freeze({
      version, activatedAt: readWriter().activatedAt, sessionId, sessionStartedAt: startedAt,
    });
    return runtime.activation;
  }

  function requireActive() {
    if (!runtime.activation || runtime.closed) {
      throw internalError('LEAD_RECEIPT_WRITER_INACTIVE', 'Писатель этого экземпляра не активен');
    }
  }

  function appendSessionEvent(kind) {
    const ms = serverNow();
    const last = readSessionLast(runtime.sessionId);
    if (last.lastMs === null || last.closed) {
      throw internalError('LEAD_RECEIPT_WRITER_STATE', 'Сессия писателя не сохранена или уже закрыта');
    }
    if (ms < last.lastMs) {
      throw internalError('LEAD_RECEIPT_CLOCK_REGRESSION', 'Часы сервера раньше последнего события сессии');
    }
    insertEvent.run(runtime.sessionId, kind, WRITER_VERSION, toIso(ms), ms);
    return toIso(ms);
  }

  // Root вызывает по расписанию каждые 30–60 с: сохраняет конец доказанного активного интервала.
  function heartbeatWriter() {
    requireActive();
    return {sessionId: runtime.sessionId, confirmedAt: appendSessionEvent('heartbeat')};
  }

  // Root вызывает при штатной остановке до закрытия БД; экземпляр становится неактивным даже при ошибке записи.
  function closeWriter() {
    if (runtime.closeResult) return runtime.closeResult;
    if (!runtime.activation) throw internalError('LEAD_RECEIPT_WRITER_INACTIVE', 'Писатель этого экземпляра не активирован');
    runtime.closed = true;
    runtime.closeResult = Object.freeze({sessionId: runtime.sessionId, closedAt: appendSessionEvent('close')});
    return runtime.closeResult;
  }

  // Heartbeat в транзакции вызывающего кода: откатывается вместе с receipt и никогда не отклоняет форму.
  function confirmInCallerTransaction(ms) {
    if (!runtime.activation || runtime.closed) return;
    const last = readSessionLast(runtime.sessionId);
    if (last.lastMs === null || last.closed || ms <= last.lastMs) return;
    insertEvent.run(runtime.sessionId, 'heartbeat', WRITER_VERSION, toIso(ms), ms);
  }

  function appendAccepted(context) {
    const accepted = readContext(context);
    if (db.isTransaction !== true) {
      throw internalError('LEAD_RECEIPT_TRANSACTION_REQUIRED', 'Receipt пишется только внутри транзакции принятой заявки');
    }
    const lead = getLeadScope.get(accepted.leadId);
    if (!lead) throw internalError('LEAD_RECEIPT_LEAD_NOT_FOUND', 'Заявка для receipt не найдена');
    const leadCompany = lead.company_code === null || lead.company_code === undefined
      ? null : String(lead.company_code).toLowerCase();
    if (leadCompany !== accepted.companyCode) {
      throw internalError('LEAD_RECEIPT_COMPANY_MISMATCH', 'Компания принятой заявки не совпадает с компанией строки leads');
    }
    const receivedMs = serverNow();
    const receivedAt = toIso(receivedMs);
    const {labels} = accepted;
    const result = insertReceipt.run(
      receivedAt, receivedMs, accepted.companyCode, accepted.leadId, accepted.outcome, accepted.originState,
      WRITER_VERSION, labels.declared_source, labels.utm_source, labels.utm_medium, labels.utm_campaign,
      labels.utm_content, labels.utm_term, accepted.landingHost
    );
    confirmInCallerTransaction(receivedMs);
    return {receiptId: Number(result.lastInsertRowid), receivedAt};
  }

  // Только SELECT: полуоткрытый период [локальная полночь from, локальная полночь дня после to).
  function journal(input) {
    if (!isPlainObject(input)) throw queryError('Нужны companyCode, from, to и timezone');
    for (const key of Object.keys(input)) {
      if (!['companyCode', 'from', 'to', 'timezone'].includes(key)) throw queryError(`Параметр «${key}» не поддерживается`);
    }
    const companyCode = normalizeCompanyCode(input.companyCode);
    if (!companyCode) throw queryError('Журнал заявок доступен только для выбранной компании');
    const from = parseDay(input.from, 'from');
    const to = parseDay(input.to, 'to');
    if (input.to < input.from) throw queryError('Дата «from» не может быть позже «to»');
    if (typeof input.timezone !== 'string' || !zones.has(input.timezone)) {
      throw queryError(`Часовой пояс должен быть одним из: ${allowedZones.join(', ')}`);
    }
    const startMs = zones.localMidnightMs(input.timezone, from);
    const endMs = zones.localMidnightMs(input.timezone, nextDay(to));
    const nowMs = serverNow();
    // Часы позади уже увиденного/сохранённого времени: «закрытость» и расширение до now недостоверны.
    const clockBehind = nowMs < Math.max(maxSeenMs, readPersistedMax());
    const meta = readWriter();
    const firstRow = getFirstActivation.get();
    const firstActivationMs = firstRow.ms === null ? null : Number(firstRow.ms);

    let currentStartMs = null;
    if (runtime.activation && !runtime.closed) {
      const row = getSessionStart.get(runtime.sessionId);
      if (row) currentStartMs = Number(row.occurred_ms);
    }
    const intervals = listSessions.all(endMs).map((row) => [Number(row.started_ms), Math.min(Number(row.last_ms), nowMs)]);
    if (currentStartMs !== null && !clockBehind) intervals.push([currentStartMs, nowMs]);
    const merged = mergeIntervals(intervals);
    const observedEnd = Math.min(endMs, nowMs);
    const covered = clipIntervals(merged, startMs, observedEnd);
    const coveredMs = covered.reduce((sum, [a, b]) => sum + (b - a), 0);

    const reasons = [];
    let completeness;
    if (firstActivationMs === null) {
      completeness = 'unknown';
      reasons.push('writer_not_activated');
    } else {
      if (startMs < firstActivationMs) reasons.push('period_starts_before_writer_activation');
      if (endMs > nowMs) reasons.push('period_not_closed');
      const lo = Math.max(startMs, firstActivationMs);
      if (lo < observedEnd && !merged.some(([a, b]) => a <= lo && b >= observedEnd)) reasons.push('writer_coverage_gap');
      const regressed = clockBehind
        || regressions.some(([a, b]) => a < endMs && b > startMs)
        || Number(countReceiptClockRegressions.get(endMs, startMs).count) > 0;
      if (regressed) reasons.push('clock_regression');
      if (coveredMs === 0) {
        completeness = 'unknown';
        reasons.push('no_observed_receipt_window');
      } else {
        completeness = reasons.length ? 'partial' : 'captured_since';
      }
    }

    const counts = {total: 0, created: 0, deduplicated: 0};
    for (const row of countReceipts.all(companyCode, startMs, endMs)) {
      counts[row.outcome] = Number(row.count);
      counts.total += Number(row.count);
    }
    const legacy = countLeadRows.get(companyCode, toIso(startMs), toIso(endMs));
    const lastEvent = getLastEvent.get().ms;
    let lastConfirmedMs = lastEvent === null ? null : Math.min(Number(lastEvent), nowMs);
    if (currentStartMs !== null && !clockBehind) lastConfirmedMs = nowMs;

    return {
      companyCode,
      period: {
        from: input.from,
        to: input.to,
        timezone: input.timezone,
        startUtc: toIso(startMs),
        endUtcExclusive: toIso(endMs),
      },
      writer: {
        status: firstActivationMs === null ? 'not_activated' : currentStartMs !== null ? 'active' : 'inactive',
        version: meta ? meta.version : firstActivationMs === null ? null : WRITER_VERSION,
        since: firstActivationMs === null ? null : toIso(firstActivationMs),
        fullPeriodCovered: completeness === 'captured_since',
        protocol: COVERAGE_PROTOCOL,
        currentSessionId: currentStartMs !== null ? runtime.sessionId : null,
        // Последний доказанный момент активного писателя, не uptime сервера и не время последней заявки.
        lastConfirmedActiveAt: lastConfirmedMs === null ? null : toIso(lastConfirmedMs),
        coveredIntervals: covered.map(([a, b]) => ({fromUtc: toIso(a), toUtc: toIso(b)})),
      },
      completeness,
      reasons,
      // Без наблюдаемого окна и без сохранённых receipts — неизвестно, а не ноль.
      knownReceiptCounts: completeness === 'unknown' && counts.total === 0 ? null : counts,
      countsAreLowerBound: completeness !== 'captured_since',
      countBasis: 'accepted_http_attempts_not_unique_leads',
      trust: 'declared_public',
      // Отдельный изменяемый CRM-факт по текущей company_code; не receipts, не первое касание и не native-запись.
      legacyLeadRowsCount: Number(legacy.count),
      legacyLeadRowsBasis: 'crm_leads_current_company_created_at_mutable',
      firstTouch: 'unknown',
      nativeLinks: 'missing',
      leadsWithoutBooking: 'unavailable',
      economics: 'unavailable',
    };
  }

  return Object.freeze({activateWriter, heartbeatWriter, closeWriter, appendAccepted, journal});
}

module.exports = {
  createRevenueLeadReceipts,
  RevenueLeadReceiptError,
  sanitizeDeclaredLabel,
  sanitizeLandingHost,
  TIMEZONES: DEFAULT_TIMEZONES,
  WRITER_VERSION,
  COVERAGE_PROTOCOL,
};
