'use strict';

/* Локальный обработчик Хью: Windows-компьютер владельца сам приходит на сервер за заданиями.
   Сервер остаётся хранителем чата, вложений, задач и канонической очереди project_chat_ai_jobs;
   здесь — выдача аренды, приём результата, состояние обработчика по heartbeat и метрики.
   Компании из HUGH_LOCAL_WORKER_COMPANIES обслуживаются только этим путём, даже когда компьютер
   выключен или ключ не настроен: серверный обработчик их задания не трогает.
   Тела запросов, статусы и результаты обработчика — недоверенные данные: наружу уходят только
   поля из закрытых списков, а пояснения для участников сервер составляет сам. */

const crypto = require('node:crypto');
const { COMPANIES } = require('./auth-store');

const PREFIX = '/content/project-chat-worker';
const HEARTBEAT_OFFLINE_MS = 60 * 1000;
const LEASE_MS = 180 * 1000;
const CLAIM_RETRY_AFTER = 5;
const MAX_BODY = 256 * 1024;
const LOGIN_CODE_TTL_MS = 15 * 60 * 1000;
const OFFLINE_WINDOW_MS = 24 * 60 * 60 * 1000;
const ERROR_CODES = new Set(['LOGIN_REQUIRED', 'UNAVAILABLE', 'BUSY', 'RATE_LIMITED', 'INVALID_PAYLOAD', 'SAFETY_REJECTED', 'INTERNAL_ERROR']);
const TRANSIENT = new Set(['LOGIN_REQUIRED', 'UNAVAILABLE', 'BUSY', 'RATE_LIMITED']);
const TERMINAL = new Set(['INVALID_PAYLOAD', 'SAFETY_REJECTED']);
const STATES = new Set(['starting', 'connecting', 'login_required', 'login_pending', 'ready', 'connected', 'limited', 'busy', 'unavailable', 'disconnected', 'error']);
const LOGIN_STATES = new Set(['login_required', 'login_pending']);
// Задание ответа адресуется номером из канонической очереди (payload.jobId = project-chat:<номер>),
// команда входа — своим префиксом: у неё отдельная таблица.
const JOB_ID = /^(?:(login):)?(\d{1,12})$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const BOOT_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
// Ровно официальная страница входа, как в hugh-runtime/device-login.js.
const LOGIN_URL = /^https:\/\/auth\.openai\.com\/codex\/device\/?$/;
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const EMPTY_PAYLOAD = '{}';

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const token = (value, max, pattern) => {
  const text = String(value ?? '').slice(0, max);
  return pattern.test(text) ? text : '';
};
const parseIso = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
};
const EXPLAIN = {
  LOGIN_REQUIRED: 'Хью на компьютере ждёт входа владельца в подписку: ответ отправится после входа',
  UNAVAILABLE: 'Хью на компьютере временно недоступен: ответ отправится автоматически',
  BUSY: 'Хью занят другим заданием: ответ отправится автоматически',
  INVALID_PAYLOAD: 'Хью отклонил запрос этого задания как некорректный. Нужна проверка владельцем',
  SAFETY_REJECTED: 'Хью отказался отвечать на это сообщение по правилам безопасности',
  INTERNAL_ERROR: 'Хью не смог подготовить ответ',
};
const DEFAULT_DELAY = { BUSY: 15, LOGIN_REQUIRED: 60, UNAVAILABLE: 60, RATE_LIMITED: 60 };

/* Политика «доверенный внешний исполнитель» (trusted external agent).

   По умолчанию ВЫКЛЮЧЕНА: пустой HUGH_TRUSTED_AGENT_COMPANIES — поведение и проверки прежние,
   изолированный Codex работает ровно как раньше и без proof заданий по-прежнему не получает.

   Режим включает ТОЛЬКО конфигурация сервера, перечисляя компании поимённо. Поле trustedAgent
   в heartbeat само по себе ничего не разрешает: для компании вне списка оно игнорируется.
   В этом режиме сервер НЕ считает изоляцию инструментов подтверждённой и не требует её:
   он сознательно допускает к переписке названной компании внешнего исполнителя, про которого
   известно, что его инструменты не изолированы. Вход Codex при этом не имитируется:
   authenticated остаётся как прислал исполнитель, а readiness называется отдельно.
   Отзыв — удалить компанию из списка и перезапустить сервис: следующая выдача уже не состоится. */
function createLocalWorker({ db, keySha256 = '', companies = [], trustedAgentCompanies = [], tx, insertMessage, buildPayload, sendJson,
  retryAfterSeconds, limitMessage, cleanText, messageLimit, aiAttempts, now = Date.now }) {
  const issues = [];
  const key = String(keySha256 || '').trim().toLowerCase();
  const keyReady = HASH.test(key);
  if (key && !keyReady) issues.push('HUGH_LOCAL_WORKER_KEY_SHA256 должен быть hex SHA256 из 64 символов: локальный обработчик не сможет войти');
  const requested = [...new Set((Array.isArray(companies) ? companies : String(companies || '').split(','))
    .map((code) => String(code || '').trim()).filter(Boolean))];
  const local = requested.filter((code) => Object.hasOwn(COMPANIES, code));
  for (const code of requested) if (!local.includes(code)) issues.push(`HUGH_LOCAL_WORKER_COMPANIES: неизвестная компания ${JSON.stringify(code)} пропущена`);
  if (local.length && !key) issues.push('HUGH_LOCAL_WORKER_COMPANIES задан без HUGH_LOCAL_WORKER_KEY_SHA256: задания этих компаний ждут, пока ключ не настроен');
  const localSet = new Set(local);
  /* Доверенные компании — строгое подмножество локальных: расширить область компаний режим не может. */
  const trustedRequested = [...new Set((Array.isArray(trustedAgentCompanies) ? trustedAgentCompanies : String(trustedAgentCompanies || '').split(','))
    .map((code) => String(code || '').trim()).filter(Boolean))];
  const trusted = trustedRequested.filter((code) => localSet.has(code));
  for (const code of trustedRequested) {
    if (!trusted.includes(code)) issues.push(`HUGH_TRUSTED_AGENT_COMPANIES: ${JSON.stringify(code)} не входит в HUGH_LOCAL_WORKER_COMPANIES и пропущена`);
  }
  if (trusted.length) issues.push(`Режим доверенного внешнего исполнителя включён для: ${trusted.join(', ')}. Изоляция инструментов для них НЕ подтверждается`);
  const trustedSet = new Set(trusted);
  const marks = local.map(() => '?').join(',');
  // Подстановки для массовых SQL: серверный обработчик исключает local companies, локальный — только их.
  const scope = { exclude: local.length ? ` AND company_code NOT IN (${marks})` : '',
    include: local.length ? ` AND company_code IN (${marks})` : ' AND 0', params: local };
  const stamp = (at = now()) => new Date(at).toISOString();

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_chat_local_companies (
      company_code TEXT PRIMARY KEY, activation_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_chat_local_worker (
      id INTEGER PRIMARY KEY CHECK(id=1), boot_id TEXT, last_seen_at TEXT,
      status TEXT NOT NULL DEFAULT '{}', login TEXT NOT NULL DEFAULT '{}', login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS project_chat_local_logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, company_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_expires_at TEXT,
      boot_id TEXT, result_hash TEXT, error_code TEXT NOT NULL DEFAULT '', completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS project_chat_local_offline_events (
      company_code TEXT NOT NULL, message_id INTEGER NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY(company_code,message_id,kind)
    );
  `);
  // Аренда и хеш результата живут в канонической очереди: отдельной таблицы заданий нет.
  const columns = new Set(db.prepare('PRAGMA table_info(project_chat_ai_jobs)').all().map((column) => column.name));
  for (const column of ['lease_token', 'lease_expires_at', 'boot_id', 'result_hash', 'lease_mode']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE project_chat_ai_jobs ADD COLUMN ${column} TEXT`);
  }
  // Момент активации фиксируется один раз: метрики считаются с него, история не импортируется.
  for (const code of local) {
    db.prepare('INSERT OR IGNORE INTO project_chat_local_companies(company_code,activation_at) VALUES(?,?)').run(code, stamp());
  }

  const isLocal = (code) => localSet.has(String(code ?? ''));
  // Режим, по которому компания обслуживается ПРЯМО СЕЙЧАС. Аренда помнит свой режим отдельно.
  const policyMode = (code) => (trustedSet.has(String(code ?? '')) ? 'trusted-agent' : 'isolated-codex');
  const workerRow = () => db.prepare('SELECT * FROM project_chat_local_worker WHERE id=1').get() || null;
  const parseJSON = (text) => { try { return JSON.parse(text || '{}') || {}; } catch { return {}; } };
  const isOffline = (row, at = now()) => {
    const seen = row ? parseIso(row.last_seen_at) : null;
    return seen === null || at - seen > HEARTBEAT_OFFLINE_MS;
  };

  /* Публичные поля runtime из закрытого списка. Текстов исключений, адресов и кодов здесь нет;
     ссылка и код входа принимаются только из результата команды login и только для pending-входа. */
  function publicStatus(raw, { login = false, at = now() } = {}) {
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const state = token(data.state, 40, /^[a-z_]+$/);
    // Подтверждение изоляции инструментов приходит объектом: без него ответы не выдаются.
    const safety = data.safety && typeof data.safety === 'object' && !Array.isArray(data.safety) ? data.safety : {};
    const status = {
      state: STATES.has(state) ? state : 'unknown',
      authenticated: data.authenticated === true, connected: data.connected === true,
      available: data.available === true, limited: data.limited === true,
      retryAfter: retryAfterSeconds(data.retryAfter),
      provider: token(data.provider, 40, /^[\w.-]*$/), model: token(data.model, 60, /^[\w.:/-]*$/),
      safety: { toolIsolationVerified: safety.toolIsolationVerified === true, reason: token(safety.reason, 64, /^[a-z][a-z0-9_]*$/) },
      /* Самообъявление внешнего исполнителя. Разрешения не даёт: смотри trustedSet ниже. */
      trustedAgent: data.trustedAgent === true,
      readiness: token(data.readiness, 32, /^[a-z][a-z0-9_]*$/),
      errorCode: ERROR_CODES.has(String(data.errorCode ?? '')) ? String(data.errorCode) : '',
    };
    if (!login) return status;
    const loginUrl = token(data.loginUrl, 300, LOGIN_URL), userCode = token(data.userCode, 9, USER_CODE);
    const pending = LOGIN_STATES.has(status.state) && !status.authenticated && loginUrl && userCode;
    if (!pending) return { ...status, loginUrl: '', userCode: '', expiresAt: '' };
    const reported = parseIso(data.expiresAt);
    const expires = Math.min(reported === null ? at + LOGIN_CODE_TTL_MS : reported, at + LOGIN_CODE_TTL_MS);
    if (expires <= at) return { ...status, loginUrl: '', userCode: '', expiresAt: '' };
    return { ...status, loginUrl, userCode, expiresAt: stamp(expires) };
  }
  function pendingLogin(row, at = now()) {
    const login = row ? parseJSON(row.login) : {};
    const expires = parseIso(login.expiresAt);
    if (!login.userCode || !login.loginUrl || expires === null || expires <= at) return null;
    return { loginUrl: login.loginUrl, userCode: login.userCode, expiresAt: login.expiresAt };
  }
  function explain(code, seconds) {
    if (code === 'RATE_LIMITED') return limitMessage(seconds);
    return EXPLAIN[code] || EXPLAIN.INTERNAL_ERROR;
  }

  /* Ключ проверяется до чтения тела; хеш сравнивается постоянным временем. */
  function authorized(request) {
    if (!keyReady) return false;
    const match = String(request.headers?.authorization || '').match(/^Bearer\s+([A-Za-z0-9._~+/=-]{16,512})$/);
    if (!match) return false;
    return crypto.timingSafeEqual(Buffer.from(sha256(match[1]), 'hex'), Buffer.from(key, 'hex'));
  }
  async function readBody(request) {
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) fail(413, 'Слишком большое тело запроса');
      chunks.push(chunk);
    }
    if (!chunks.length) fail(400, 'Ожидался JSON-объект');
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Некорректный JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Ожидался JSON-объект');
    return value;
  }
  const bootOf = (value) => token(value, 80, BOOT_ID) || fail(400, 'Некорректный bootId');
  const leaseOf = (value) => token(value, 128, TOKEN) || fail(400, 'Некорректный leaseToken');
  const jobRef = (value) => {
    const match = String(value ?? '').match(JOB_ID);
    if (!match) fail(400, 'Некорректный jobId');
    return { kind: match[1] || 'reply', id: Number(match[2]) };
  };

  /* Метрики с момента активации по серверным часам. Один учёт на message id и вид события. */
  function companyStats(code, at = now()) {
    const worker = workerRow();
    const activation = db.prepare('SELECT activation_at FROM project_chat_local_companies WHERE company_code=?').get(code)?.activation_at || null;
    const since = stamp(Math.max(at - OFFLINE_WINDOW_MS, activation ? parseIso(activation) || 0 : 0));
    const pending = db.prepare(`SELECT count(*) AS n, min(m.created_at) AS oldest FROM project_chat_ai_jobs j
      JOIN project_chat_messages m ON m.id=j.message_id
      WHERE j.company_code=? AND j.reply_message_id IS NULL AND j.status IN ('pending','running','blocked')`).get(code);
    const count = (kind) => db.prepare(`SELECT count(*) AS n FROM project_chat_local_offline_events
      WHERE company_code=? AND kind=? AND at>=?`).get(code, kind, since).n;
    const oldest = pending.oldest ? parseIso(pending.oldest) : null;
    return { activationAt: activation, lastSeen: worker?.last_seen_at || null, offline: isOffline(worker, at),
      pendingAi: pending.n, oldestPendingAgeSeconds: oldest === null ? 0 : Math.max(0, Math.round((at - oldest) / 1000)),
      humanMessagesWhileOffline24h: count('human'), aiRequestsWhileOffline24h: count('ai') };
  }
  function stats(at = now()) {
    const worker = workerRow();
    const perCompany = Object.fromEntries(local.map((code) => [code, companyStats(code, at)]));
    const sum = (field) => Object.values(perCompany).reduce((total, item) => total + item[field], 0);
    const oldest = Math.max(0, ...Object.values(perCompany).map((item) => item.oldestPendingAgeSeconds));
    return { lastSeen: worker?.last_seen_at || null, offline: isOffline(worker, at), pendingAi: sum('pendingAi'),
      oldestPendingAgeSeconds: oldest, humanMessagesWhileOffline24h: sum('humanMessagesWhileOffline24h'),
      aiRequestsWhileOffline24h: sum('aiRequestsWhileOffline24h'), companies: perCompany };
  }
  /* Сообщение, пришедшее при выключенном компьютере, учитывается по факту вставки: окно офлайна
     сервер не хранит, а повторный учёт того же message id исключён первичным ключом. */
  function noteMessage(code, messageId, authorType, aiJob) {
    if (!isLocal(code) || !isOffline(workerRow())) return;
    const insert = db.prepare('INSERT OR IGNORE INTO project_chat_local_offline_events(company_code,message_id,kind,at) VALUES(?,?,?,?)');
    if (authorType !== 'assistant') insert.run(code, messageId, 'human', stamp());
    if (aiJob) insert.run(code, messageId, 'ai', stamp());
  }

  function heartbeat(body) {
    const bootId = bootOf(body.bootId);
    const status = publicStatus(body.status);
    const at = stamp();
    tx(() => {
      const previous = workerRow();
      db.prepare(`INSERT INTO project_chat_local_worker(id,boot_id,last_seen_at,status) VALUES(1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET boot_id=excluded.boot_id,last_seen_at=excluded.last_seen_at,status=excluded.status`)
        .run(bootId, at, JSON.stringify(status));
      // Подтверждённый вход делает выданный код ненужным, а новый запуск обработчика — недействительным:
      // код принадлежал прежнему процессу и после перезапуска не воскресает.
      if (status.authenticated || (previous && previous.boot_id !== bootId)) db.prepare("UPDATE project_chat_local_worker SET login='{}' WHERE id=1").run();
    });
    return { ok: true, serverTime: at, stats: stats() };
  }
  // Готовность к ответам: свежий heartbeat той же загрузки, вход, соединение, доступность,
  // отсутствие лимита и подтверждённая изоляция инструментов. Одного available недостаточно.
  const readyForReply = (row, bootId, code = null) => {
    if (!row || isOffline(row) || row.boot_id !== bootId) return false;
    const status = parseJSON(row.status);
    if (status.connected !== true || status.available !== true || status.limited === true) return false;
    /* Доверенный режим: подтверждения изоляции нет и оно не требуется — компанию назвал сервер.
       Вход модели тоже не подтверждается: исполнитель заявляет готовность полем readiness. */
    if (code !== null && trustedSet.has(code)) return status.trustedAgent === true && status.readiness === 'attested';
    return status.authenticated === true && status.safety?.toolIsolationVerified === true;
  };
  // Есть ли хоть одна компания, для которой выдача сейчас разрешена: без этого claim не ищет задания.
  const servableCodes = (row, bootId) => local.filter((code) => readyForReply(row, bootId, code));
  const lease = () => ({ token: crypto.randomBytes(24).toString('base64url'), expires: stamp(now() + LEASE_MS) });
  const idle = () => ({ job: null, retryAfter: CLAIM_RETRY_AFTER });

  /* Атомарная выдача одного задания. Просроченная аренда освобождает задание, но не стирает
     сохранённый результат до тех пор, пока аренду не заменит новая. Выдача и истечение аренды
     (выключенный компьютер, обрыв) попытку не расходуют: попытки считает только отказ обработчика. */
  function claim(body) {
    const bootId = bootOf(body.bootId);
    return tx(() => {
      const at = stamp();
      // Ожидавшие паузу задания — в том числе исторические, оставленные серверным путём — возвращаются в очередь.
      db.prepare(`UPDATE project_chat_ai_jobs SET status='pending',error='' WHERE status='blocked' AND reply_message_id IS NULL
        AND next_attempt_at<=?${scope.include}`).run(at, ...scope.params);
      const busy = db.prepare(`SELECT 1 FROM project_chat_ai_jobs WHERE status='running' AND reply_message_id IS NULL AND lease_expires_at>=?${scope.include} LIMIT 1`)
        .get(at, ...scope.params) || db.prepare("SELECT 1 FROM project_chat_local_logins WHERE status='running' AND lease_expires_at>=? LIMIT 1").get(at);
      if (busy) return idle();
      /* Вход разрешён до авторизации и идёт первым: без него ответы всё равно не выдаются.
         Но исполнитель, объявивший себя внешним (trustedAgent), вход Codex выполнить не может:
         задания входа ему не выдаются вовсе, в том числе по изолированным компаниям. */
      const declaredExternal = parseJSON(workerRow()?.status).trustedAgent === true;
      const login = declaredExternal ? null
        : db.prepare(`SELECT * FROM project_chat_local_logins WHERE (status='pending' OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at<?)))
        ${scope.include} ORDER BY id LIMIT 1`).get(at, ...scope.params);
      if (login) {
        const next = lease();
        db.prepare(`UPDATE project_chat_local_logins SET status='running',lease_token=?,lease_expires_at=?,boot_id=?,result_hash=NULL WHERE id=?`)
          .run(next.token, next.expires, bootId, login.id);
        return { job: { id: `login:${login.id}`, kind: 'login', companyCode: login.company_code, payload: {},
          payloadHash: sha256(EMPTY_PAYLOAD), leaseToken: next.token, leaseExpiresAt: next.expires } };
      }
      /* Готовность считается покомпанийно: обычная компания требует прежних условий,
         доверенная — заявленной готовности внешнего исполнителя. Компании, для которых
         выдача сейчас не разрешена, в выборку не попадают вовсе. */
      const servable = servableCodes(workerRow(), bootId);
      if (!servable.length) return idle();
      const servableMarks = servable.map(() => '?').join(',');
      const candidates = db.prepare(`SELECT * FROM project_chat_ai_jobs WHERE reply_message_id IS NULL AND attempts<? AND next_attempt_at<=?
        AND (status IN ('pending','error') OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at<?))) AND company_code IN (${servableMarks})
        ORDER BY id LIMIT 5`).all(aiAttempts, at, at, ...servable);
      for (const job of candidates) {
        let payload;
        try {
          // Запрос собирается один раз и дальше повторяется дословно; ошибка сборки — терминальная.
          payload = job.payload || buildPayload(job);
        } catch (error) {
          db.prepare(`UPDATE project_chat_ai_jobs SET status='error',attempts=?,error=?,next_attempt_at=? WHERE id=? AND reply_message_id IS NULL`)
            .run(aiAttempts, String(error.message || 'Не удалось собрать запрос к Хью').slice(0, 200), at, job.id);
          continue;
        }
        const next = lease();
        db.prepare(`UPDATE project_chat_ai_jobs SET status='running',error='',payload=?,lease_token=?,lease_expires_at=?,boot_id=?,result_hash=NULL,lease_mode=? WHERE id=?`)
          .run(payload, next.token, next.expires, bootId, policyMode(job.company_code), job.id);
        return { job: { id: String(job.id), kind: 'reply', companyCode: job.company_code, payload: JSON.parse(payload),
          payloadHash: sha256(payload), leaseToken: next.token, leaseExpiresAt: next.expires } };
      }
      return idle();
    });
  }
  function findJob(ref) {
    const row = ref.kind === 'reply'
      ? db.prepare('SELECT * FROM project_chat_ai_jobs WHERE id=?').get(ref.id)
      : db.prepare('SELECT * FROM project_chat_local_logins WHERE id=?').get(ref.id);
    if (!row) fail(404, 'Задание не найдено');
    if (!isLocal(row.company_code)) fail(403, 'Компания не обслуживается локальным обработчиком');
    return row;
  }
  /* Режим, под которым выдана аренда, должен действовать и сейчас. Если компанию убрали из
     доверенного списка между claim и complete, результат по прежней политике не принимается.
     Саму аренду не стираем: задание вернётся в очередь по истечении срока обычным порядком. */
  function policyUnchanged(row) {
    const mode = String(row.lease_mode || 'isolated-codex');
    return mode === policyMode(row.company_code);
  }
  function renew(body) {
    const ref = jobRef(body.jobId), leaseToken = leaseOf(body.leaseToken);
    return tx(() => {
      const row = findJob(ref);
      if (ref.kind === 'reply' && !policyUnchanged(row)) fail(403, 'Режим обслуживания компании изменён: аренда больше не продлевается');
      if (row.status !== 'running' || !same(row.lease_token, leaseToken)) fail(409, 'Аренда задания заменена или завершена');
      const expires = stamp(now() + LEASE_MS);
      db.prepare(`UPDATE ${ref.kind === 'reply' ? 'project_chat_ai_jobs' : 'project_chat_local_logins'} SET lease_expires_at=? WHERE id=?`).run(expires, row.id);
      return { ok: true, leaseExpiresAt: expires };
    });
  }
  /* Результат приводится к закрытому виду до хеширования: повтор того же ACK узнаётся по хешу. */
  function normalizeResult(raw, kind) {
    const result = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : fail(400, 'Некорректное поле result');
    if (result.ok === false) {
      const errorCode = String(result.errorCode ?? '');
      if (!ERROR_CODES.has(errorCode)) fail(400, 'Неизвестный errorCode');
      return { ok: false, errorCode, retryAfter: retryAfterSeconds(result.retryAfter) };
    }
    if (result.ok !== true) fail(400, 'Некорректное поле result');
    if (kind === 'login') return { ok: true, status: publicStatus(result.status, { login: true }) };
    const text = cleanText(result.text ?? '', messageLimit);
    if (!text) fail(400, 'Пустой текст ответа');
    return { ok: true, text, provider: token(result.provider, 100, /^[\w.-]*$/), model: token(result.model, 100, /^[\w.:/-]*$/) };
  }
  function complete(body) {
    const ref = jobRef(body.jobId), leaseToken = leaseOf(body.leaseToken);
    const payloadHash = token(body.payloadHash, 64, HASH) || fail(400, 'Некорректный payloadHash');
    const normalized = normalizeResult(body.result, ref.kind);
    const resultHash = sha256(JSON.stringify(normalized));
    return tx(() => {
      const row = findJob(ref);
      if (ref.kind === 'reply' && !policyUnchanged(row)) fail(403, 'Режим обслуживания компании изменён: результат по прежней политике не принят');
      if (!same(row.lease_token, leaseToken)) fail(409, 'Аренда задания заменена: результат не принят');
      if (payloadHash !== (ref.kind === 'reply' ? sha256(row.payload || '') : sha256(EMPTY_PAYLOAD))) fail(409, 'Хеш запроса не совпадает с сохранённым заданием');
      if (row.status !== 'running') {
        if (row.result_hash && row.result_hash === resultHash) return { ok: true, status: row.status, duplicate: true };
        fail(409, 'Задание уже завершено другим результатом');
      }
      const at = stamp();
      if (ref.kind === 'login') {
        if (normalized.ok) {
          db.prepare(`INSERT INTO project_chat_local_worker(id,login,login_at) VALUES(1,?,?)
            ON CONFLICT(id) DO UPDATE SET login=excluded.login,login_at=excluded.login_at`).run(JSON.stringify(normalized.status), at);
          db.prepare(`UPDATE project_chat_local_logins SET status='done',result_hash=?,completed_at=?,error_code='' WHERE id=?`).run(resultHash, at, row.id);
          return { ok: true, status: 'done' };
        }
        // Неудачный вход не повторяется сам: владелец нажимает кнопку ещё раз.
        db.prepare(`UPDATE project_chat_local_logins SET status='error',result_hash=?,completed_at=?,error_code=? WHERE id=?`)
          .run(resultHash, at, normalized.errorCode, row.id);
        return { ok: true, status: 'error' };
      }
      if (normalized.ok) {
        // Сообщение, исходящая отправка в Telegram и отметка done — одной транзакцией.
        const message = insertMessage({ code: row.company_code, authorId: 'hugh', authorName: 'Хью', authorType: 'assistant', text: normalized.text });
        db.prepare(`UPDATE project_chat_ai_jobs SET status='done',error='',reply_message_id=?,provider=?,model=?,result_hash=? WHERE id=?`)
          .run(message.id, normalized.provider, normalized.model, resultHash, row.id);
        return { ok: true, status: 'done', replyMessageId: message.id };
      }
      const code = normalized.errorCode;
      const delay = normalized.retryAfter || DEFAULT_DELAY[code] || 60;
      const message = explain(code, delay);
      if (TRANSIENT.has(code)) {
        // Офлайн, вход и квота — ожидание без расходования попыток.
        db.prepare(`UPDATE project_chat_ai_jobs SET status='blocked',error=?,next_attempt_at=?,result_hash=? WHERE id=?`)
          .run(message, stamp(now() + delay * 1000), resultHash, row.id);
        return { ok: true, status: 'blocked', retryAfter: delay };
      }
      // Отказ обработчика по существу — единственное, что расходует попытку.
      const attempts = row.attempts + 1;
      if (TERMINAL.has(code) || attempts >= aiAttempts) {
        db.prepare(`UPDATE project_chat_ai_jobs SET status='error',attempts=?,error=?,next_attempt_at=?,result_hash=? WHERE id=?`)
          .run(aiAttempts, TERMINAL.has(code) ? message : `${message}: попытки исчерпаны`, at, resultHash, row.id);
        return { ok: true, status: 'error' };
      }
      db.prepare(`UPDATE project_chat_ai_jobs SET status='error',attempts=?,error=?,next_attempt_at=?,result_hash=? WHERE id=?`)
        .run(attempts, message, stamp(now() + 30000 * attempts), resultHash, row.id);
      return { ok: true, status: 'error', retryAfter: 30 * attempts };
    });
  }
  const ROUTES = { '/heartbeat': heartbeat, '/claim': claim, '/renew': renew, '/complete': complete };
  async function handle(request, response, url) {
    if (!url.pathname.startsWith(`${PREFIX}/`)) return false;
    if (!authorized(request)) fail(401, 'Нет доступа');
    if (request.method !== 'POST') fail(405, 'Только POST');
    const route = ROUTES[url.pathname.slice(PREFIX.length)];
    if (!route) fail(404, 'Маршрут не найден');
    const body = await readBody(request);
    sendJson(response, 200, route(body), { 'cache-control': 'no-store' });
    return true;
  }

  /* Состояние для владельца и снимка комнаты: офлайн, вход и лимит показываются честно.
     Ссылка и код входа попадают только в ответ владельцу, не в снимок участников. */
  function ownerStatus(code, { detailed = true } = {}) {
    const at = now(), worker = workerRow(), status = worker ? publicStatus(parseJSON(worker.status)) : null;
    const offline = isOffline(worker, at);
    const login = pendingLogin(worker, at);
    const command = db.prepare(`SELECT * FROM project_chat_local_logins WHERE status IN ('pending','running')${scope.include} ORDER BY id DESC LIMIT 1`).get(...scope.params);
    const failed = db.prepare(`SELECT * FROM project_chat_local_logins WHERE status='error'${scope.include} ORDER BY id DESC LIMIT 1`).get(...scope.params);
    const loginFailed = failed && (!worker?.login_at || failed.completed_at > worker.login_at) && (!command || failed.id > command.id) ? failed : null;
    const online = !offline && status;
    const trustedMode = trustedSet.has(String(code ?? ''));
    /* В доверенном режиме готовность — это заявленная готовность внешнего исполнителя,
       а не вход Codex: authenticated здесь намеренно не участвует. */
    const ready = trustedMode
      ? Boolean(online && status.trustedAgent && status.readiness === 'attested' && status.connected && status.available && !status.limited)
      : Boolean(online && status.authenticated && status.connected && status.available && !status.limited);
    const state = offline ? 'offline'
      : trustedMode ? (ready ? 'connected' : status.limited ? 'limited' : 'unavailable')
        : login ? 'login_required'
        : command ? 'login_pending'
          : ready ? 'connected'
            : status.limited ? 'limited'
              : status.state === 'unknown' ? 'unavailable' : status.state;
    const error = offline ? (worker?.last_seen_at ? 'Компьютер Хью не на связи' : 'Компьютер Хью ещё ни разу не выходил на связь')
      : trustedMode ? (status.limited ? limitMessage(status.retryAfter || 60)
        : ready ? '' : 'Внешний исполнитель Хью пока не подтвердил готовность')
      : login ? 'Подтвердите вход по коду на официальной странице Codex'
        : command ? 'Команда входа передана компьютеру Хью, ждём ссылку и код'
          : loginFailed ? `Не удалось начать вход: ${explain(loginFailed.error_code, 0)}`
            : status.limited ? limitMessage(status.retryAfter || 60)
              : status.errorCode ? explain(status.errorCode, status.retryAfter || 60)
                : ready ? '' : trustedMode ? 'Внешний исполнитель Хью пока не подтвердил готовность'
                : status.authenticated ? 'Хью на компьютере пока не готов отвечать' : 'Нужен вход владельца в подписку на компьютере Хью';
    const view = { configured: true, local: true, offline, lastSeen: worker?.last_seen_at || null,
      /* В доверенном режиме связь не зависит от входа в подписку Codex: authenticated здесь всегда false. */
      connected: trustedMode ? ready : Boolean(online && status.authenticated && status.connected),
      authenticated: !trustedMode && Boolean(online && status.authenticated),
      state, provider: status?.provider || (trustedMode ? '' : 'codex'), model: status?.model || '',
      limited: Boolean(online && status.limited), retryAfter: online && status.limited ? status.retryAfter || 60 : 0,
      // Вход Codex к доверенному режиму отношения не имеет: кнопки и код там не показываются.
      loginPending: trustedMode ? false : Boolean(command), error, serverTime: stamp(at),
      /* Честная подпись режима для владельца: кто именно отвечает и что не подтверждено. */
      mode: trustedMode ? 'trusted-agent' : 'isolated-codex',
      toolIsolationVerified: trustedMode ? false : Boolean(online && status.safety?.toolIsolationVerified),
      notice: trustedMode ? 'Отвечает внешний доверенный ИИ. Изоляция его инструментов не подтверждена: режим включён владельцем в настройках сервера' : '' };
    if (!detailed) return view;
    if (trustedMode) return { ...view, loginUrl: '', userCode: '', expiresAt: '', stats: companyStats(code, at) };
    return { ...view, loginUrl: login?.loginUrl || '', userCode: login?.userCode || '', expiresAt: login?.expiresAt || '', stats: companyStats(code, at) };
  }
  /* Одна устойчивая команда входа: повторное нажатие переиспользует ожидающую команду
     или действующий код и не плодит запросов к компьютеру. */
  function requestLogin(code) {
    return tx(() => {
      // Доверенная компания обслуживается не Codex: команда входа там бессмысленна и не создаётся.
      if (trustedSet.has(String(code ?? ''))) return { accepted: false, status: ownerStatus(code) };
      const current = ownerStatus(code);
      if (current.userCode || current.loginPending) return { accepted: true, status: current };
      if (current.connected && current.authenticated) return { accepted: false, status: current };
      db.prepare('INSERT INTO project_chat_local_logins(company_code,created_at) VALUES(?,?)').run(code, stamp());
      return { accepted: true, status: ownerStatus(code) };
    });
  }

  return { issues, companies: local, trustedCompanies: trusted, scope, isLocal, handle, heartbeat, claim, renew, complete,
    ownerStatus, requestLogin, stats, companyStats, noteMessage };
}

module.exports = { createLocalWorker, HEARTBEAT_OFFLINE_MS, LEASE_MS, ERROR_CODES };
