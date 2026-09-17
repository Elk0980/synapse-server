'use strict';

/* Telegram Mini App общего чата проекта: вход по подписи Telegram, привязка Telegram ID к
   аккаунту участника и узкая room-сессия для маршрутов /content/project-chat/*.
   Секрета бота здесь нет и быть не может: подпись initData проверяется открытым ключом
   Telegram (Ed25519), от бота нужен только его несекретный числовой ID. Room-сессия — это
   всегда права участника, даже для аккаунта владельца; вне комнаты она нигде не принимается.
   initData, коды и заголовки — недоверенные данные: сравнения постоянным временем,
   поля из закрытых списков, никакого username. */

const crypto = require('node:crypto');
const { COMPANIES } = require('./auth-store');

// Production-ключ Telegram для проверки поля signature (core.telegram.org/bots/webapps).
const PRODUCTION_PUBLIC_KEY_HEX = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SESSION_PATH = '/content/project-chat-miniapp/session';
const BODY_LIMIT = 20 * 1024;
const INIT_DATA_LIMIT = 16 * 1024;
const AUTH_MAX_AGE_S = 5 * 60;
const AUTH_FUTURE_S = 60;
const NONCE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
// Повторное открытие возвращает тот же код, поэтому новых кодов у одного Telegram ID немного;
// суточный предел и общий потолок ожидающих кодов защищают от перебора и переполнения.
const CODES_PER_DAY = 20;
const PENDING_CODES_LIMIT = 200;
const TOKEN_PATTERN = /^room\.([A-Za-z0-9_-]{1,2000})\.([A-Za-z0-9_-]{43})$/;
const TELEGRAM_ID = /^[1-9]\d{0,19}$/;
const COMPANY_CODE = /^[a-z0-9_-]{1,40}$/;

const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const same = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const cleanName = (value) => String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
const REOPEN = 'Сессия чата истекла. Закройте и снова откройте чат из Telegram';

function createProjectChatMiniApp({ db, authStore, botId = '', sessionSecret = '', publicKeyHex = PRODUCTION_PUBLIC_KEY_HEX,
  now = Date.now, tx, assigned, isMember, sendJson }) {
  const issues = [];
  const bot = String(botId ?? '').trim();
  const enabled = TELEGRAM_ID.test(bot) && Boolean(sessionSecret);
  if (bot && !TELEGRAM_ID.test(bot)) issues.push('TELEGRAM_BOT_ID должен быть числовым ID бота: вход через Telegram отключён');
  if (!bot) issues.push('TELEGRAM_BOT_ID не задан: вход в чат проекта через Telegram отключён');
  let publicKey = null;
  try {
    publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
  } catch { issues.push('Открытый ключ Telegram не читается: вход через Telegram отключён'); }
  const stamp = (at = now()) => new Date(at).toISOString();

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_chat_telegram_links (
      telegram_user_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, linked_by INTEGER NOT NULL, linked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_chat_telegram_link_versions (
      user_id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS project_chat_miniapp_link_codes (
      code TEXT PRIMARY KEY, telegram_user_id TEXT NOT NULL, first_name TEXT NOT NULL, company_code TEXT,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS project_chat_miniapp_nonces (nonce TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
  `);

  /* Подпись Telegram: bot_id:WebAppData + все пары key=value по ключу, без hash и signature. */
  function verifyInitData(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > INIT_DATA_LIMIT) fail(401, 'Некорректные данные Telegram');
    const params = new URLSearchParams(raw);
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length) fail(401, 'Некорректные данные Telegram');
    const signature = params.get('signature'), authDate = params.get('auth_date'), userRaw = params.get('user');
    if (!signature || !authDate || !userRaw) fail(401, 'Некорректные данные Telegram');
    let sig;
    try { sig = Buffer.from(signature, 'base64url'); } catch { fail(401, 'Некорректные данные Telegram'); }
    if (sig.length !== 64 || !/^[A-Za-z0-9_-]+$/.test(signature)) fail(401, 'Некорректные данные Telegram');
    const lines = keys.filter((key) => key !== 'hash' && key !== 'signature').sort()
      .map((key) => `${key}=${params.get(key)}`);
    const data = Buffer.from(`${bot}:WebAppData\n${lines.join('\n')}`, 'utf8');
    if (!publicKey || !crypto.verify(null, data, publicKey, sig)) fail(401, 'Подпись Telegram не подтверждена');
    if (!/^\d{1,12}$/.test(authDate)) fail(401, 'Некорректные данные Telegram');
    const age = Math.floor(now() / 1000) - Number(authDate);
    if (age > AUTH_MAX_AGE_S || age < -AUTH_FUTURE_S) fail(401, REOPEN, { state: 'expired' });
    let user;
    try { user = JSON.parse(userRaw); } catch { fail(401, 'Некорректные данные Telegram'); }
    if (!user || typeof user !== 'object' || !Number.isSafeInteger(user.id) || user.id <= 0) fail(401, 'Некорректные данные Telegram');
    // Проект берётся только из подписанного start_param: незаверенная подсказка из тела запроса
    // проект не выбирает. Неизвестный или чужой код проекта — как отсутствие проекта.
    const startParam = params.get('start_param') || '';
    const project = COMPANY_CODE.test(startParam) && Object.hasOwn(COMPANIES, startParam) ? startParam : null;
    // Одноразовость считается по тому, что подписано: bot ID и канонический data-check-string.
    // Перестановка параметров, другое percent-кодирование или правка неподписанного hash дают
    // ту же подписанную информацию и обязаны узнаваться как повтор.
    return { telegramUserId: String(user.id), firstName: cleanName(user.first_name) || 'Участник Telegram', project, nonce: sha256(data) };
  }

  const linkVersion = (userId) => db.prepare('SELECT version FROM project_chat_telegram_link_versions WHERE user_id=?').get(userId)?.version || 1;
  const bumpLinkVersion = (userId) => db.prepare(`INSERT INTO project_chat_telegram_link_versions(user_id,version) VALUES(?,2)
    ON CONFLICT(user_id) DO UPDATE SET version=version+1`).run(userId);
  const linkOf = (telegramUserId) => db.prepare('SELECT * FROM project_chat_telegram_links WHERE telegram_user_id=?').get(telegramUserId) || null;
  const rooms = (user) => Object.keys(COMPANIES).filter((code) => assigned(user, code) && isMember(user, code))
    .map((code) => ({ code, title: COMPANIES[code].name }));

  /* Room-токен: HMAC на секрете сессий, но своим префиксом — cookie кабинета из него не собрать. */
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sign = (payload) => crypto.createHmac('sha256', sessionSecret).update(`room.${payload}`).digest('base64url');
  function mintToken(user, telegramUserId, at = now()) {
    const payload = b64({ k: 'room', uid: user.id, sv: user.sessionVersion, lv: linkVersion(user.id), tg: telegramUserId,
      iat: Math.floor(at / 1000), exp: Math.floor((at + TOKEN_TTL_MS) / 1000) });
    return { token: `room.${payload}.${sign(payload)}`, expiresAt: stamp(at + TOKEN_TTL_MS) };
  }
  /* null — заголовка нет (обычный путь кабинета); иначе действующая сессия участника или 401.
     Проверяется всё, что может быть отозвано: аккаунт, пароль, привязка и её версия. */
  function roomSession(request) {
    const header = String(request.headers?.authorization || '');
    if (!header.startsWith('Bearer ')) return null;
    const match = header.slice(7).trim().match(TOKEN_PATTERN);
    if (!match || !sessionSecret || !same(match[2], sign(match[1]))) fail(401, REOPEN);
    let claims;
    try { claims = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); } catch { fail(401, REOPEN); }
    if (!claims || claims.k !== 'room' || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now()) fail(401, REOPEN);
    const user = authStore.getById(claims.uid);
    if (!user || user.sessionVersion !== claims.sv) fail(401, REOPEN);
    const link = typeof claims.tg === 'string' && TELEGRAM_ID.test(claims.tg) ? linkOf(claims.tg) : null;
    if (!link || link.user_id !== user.id || linkVersion(user.id) !== claims.lv) fail(401, REOPEN);
    return { user, telegramUserId: claims.tg };
  }

  /* Код привязки принадлежит ровно одному проекту. Действующий код того же проекта возвращается
     повторно; код другого проекта того же Telegram ID не показывается и не меняется. */
  function issueCode(verified, project, at) {
    const dayAgo = stamp(at - 24 * 3600000);
    const recent = db.prepare('SELECT count(*) AS n FROM project_chat_miniapp_link_codes WHERE telegram_user_id=? AND created_at>=?').get(verified.telegramUserId, dayAgo).n;
    const pending = db.prepare('SELECT count(*) AS n FROM project_chat_miniapp_link_codes WHERE used_at IS NULL AND expires_at>?').get(stamp(at)).n;
    const existing = db.prepare(`SELECT * FROM project_chat_miniapp_link_codes WHERE telegram_user_id=? AND company_code=? AND used_at IS NULL AND expires_at>?
      ORDER BY created_at DESC LIMIT 1`).get(verified.telegramUserId, project, stamp(at));
    if (existing) return { code: existing.code, expiresAt: existing.expires_at };
    if (recent >= CODES_PER_DAY || pending >= PENDING_CODES_LIMIT) return { limited: true };
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Array.from(crypto.randomBytes(6), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
      const expiresAt = stamp(at + CODE_TTL_MS);
      const inserted = db.prepare(`INSERT OR IGNORE INTO project_chat_miniapp_link_codes(code,telegram_user_id,first_name,company_code,created_at,expires_at)
        VALUES(?,?,?,?,?,?)`).run(code, verified.telegramUserId, verified.firstName, project, stamp(at), expiresAt);
      if (inserted.changes) return { code, expiresAt };
    }
    fail(500, 'Не удалось выдать код');
  }

  /* Один вход на одно открытие Mini App: initData используется ровно один раз. Отказы (нет привязки,
     нет комнат, повтор) — тоже результат транзакции: nonce и выданный код должны сохраниться,
     поэтому исключение бросается только после фиксации. */
  function session(body) {
    if (!enabled || !publicKey) fail(503, 'Вход в чат проекта через Telegram пока не настроен');
    const verified = verifyInitData(body?.initData);
    const outcome = tx(() => {
      const at = now();
      db.prepare('DELETE FROM project_chat_miniapp_nonces WHERE seen_at<?').run(stamp(at - NONCE_TTL_MS));
      db.prepare('DELETE FROM project_chat_miniapp_link_codes WHERE expires_at<?').run(stamp(at - 24 * 3600000));
      if (!db.prepare('INSERT OR IGNORE INTO project_chat_miniapp_nonces(nonce,seen_at) VALUES(?,?)').run(verified.nonce, stamp(at)).changes) {
        return { status: 409, message: REOPEN, extra: { state: 'replayed' } };
      }
      const link = linkOf(verified.telegramUserId);
      const user = link ? authStore.getById(link.user_id) : null;
      if (!user) {
        if (link) db.prepare('DELETE FROM project_chat_telegram_links WHERE telegram_user_id=?').run(verified.telegramUserId);
        // Без подписанного проекта код выдать некому: он привязывается владельцем в конкретной комнате.
        if (!verified.project) return { status: 403, message: 'Откройте чат по ссылке своего проекта', extra: { state: 'no_project' } };
        const issued = issueCode(verified, verified.project, at);
        if (issued.limited) return { status: 429, message: 'Слишком много запросов кода. Попробуйте позже', extra: {} };
        return { status: 403, message: 'Ваш Telegram ещё не привязан к аккаунту участника', extra: { state: 'unlinked', linkCode: issued.code, expiresAt: issued.expiresAt, project: verified.project } };
      }
      const companies = rooms(user);
      if (!companies.length) return { status: 403, message: 'Владелец ещё не добавил вас в участники чата проекта', extra: { state: 'no_rooms' } };
      const minted = mintToken(user, verified.telegramUserId, at);
      // Подписанный проект возвращается как подсказка выбора; доступ по нему всё равно решает членство.
      return { ok: { ...minted, companies, startParam: companies.some((c) => c.code === verified.project) ? verified.project : null,
        identity: { userId: user.id, displayName: user.displayName, role: 'member' } } };
    });
    if (outcome.ok) return outcome.ok;
    fail(outcome.status, outcome.message, outcome.extra);
  }

  async function readBody(request) {
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > BODY_LIMIT) fail(413, 'Слишком большой запрос');
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { fail(400, 'Некорректный JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Ожидался JSON-объект');
    return value;
  }
  async function handle(request, response, url) {
    if (url.pathname !== SESSION_PATH) return false;
    if (request.method !== 'POST') fail(405, 'Только POST');
    const body = await readBody(request);
    try {
      sendJson(response, 200, session(body), { 'cache-control': 'no-store' });
    } catch (error) {
      if (!error.status || error.status >= 500) throw error;
      // Состояние экрана (код, повтор, истечение) уходит вместе с ошибкой: клиент показывает понятный шаг.
      sendJson(response, error.status, { error: error.message, ...(error.state ? { state: error.state } : {}),
        ...(error.linkCode ? { linkCode: error.linkCode, expiresAt: error.expiresAt, project: error.project } : {}) }, { 'cache-control': 'no-store' });
    }
    return true;
  }

  /* Владелец: привязки участников этой комнаты и ожидающие коды ровно этого проекта.
     Коды других проектов не показываются и здесь не применяются. */
  function listLinks(code) {
    const at = stamp();
    const people = new Map(authStore.list().map((u) => [u.id, u]));
    const links = db.prepare('SELECT * FROM project_chat_telegram_links ORDER BY linked_at').all()
      .filter((row) => { const u = people.get(row.user_id); return u && assigned(u, code) && isMember(u, code); })
      .map((row) => ({ telegramUserId: row.telegram_user_id, userId: row.user_id, displayName: people.get(row.user_id).displayName, linkedAt: row.linked_at }));
    const pending = db.prepare(`SELECT code,first_name,company_code,created_at,expires_at FROM project_chat_miniapp_link_codes
      WHERE used_at IS NULL AND expires_at>? AND company_code=? ORDER BY created_at DESC LIMIT 50`).all(at, code)
      .map((row) => ({ code: row.code, firstName: row.first_name, createdAt: row.created_at, expiresAt: row.expires_at }));
    return { links, pending };
  }
  function createLink(code, body, actor) {
    if (!body || Object.keys(body).some((k) => !['linkCode', 'userId'].includes(k))) fail(400, 'Неизвестное поле');
    const linkCode = String(body.linkCode ?? '').toUpperCase();
    if (!CODE_PATTERN.test(linkCode)) fail(400, 'Некорректный код привязки');
    if (!Number.isSafeInteger(Number(body.userId)) || Number(body.userId) < 1) fail(400, 'Некорректный идентификатор');
    const userId = Number(body.userId);
    return tx(() => {
      const at = stamp();
      const row = db.prepare('SELECT * FROM project_chat_miniapp_link_codes WHERE code=? AND company_code=? AND used_at IS NULL AND expires_at>?').get(linkCode, code, at);
      if (!row) fail(404, 'Код не найден или устарел');
      const user = authStore.getById(userId);
      // Только действующий участник этой комнаты; аккаунты и членство здесь не создаются.
      if (!user || !assigned(user, code) || !isMember(user, code)) fail(400, 'Привязать можно только действующего участника этого проекта');
      const existing = linkOf(row.telegram_user_id);
      if (existing && existing.user_id !== userId) fail(409, 'Этот Telegram уже привязан к другому участнику');
      if (!existing) db.prepare('INSERT INTO project_chat_telegram_links(telegram_user_id,user_id,linked_by,linked_at) VALUES(?,?,?,?)')
        .run(row.telegram_user_id, userId, actor.id, at);
      db.prepare('UPDATE project_chat_miniapp_link_codes SET used_at=? WHERE code=?').run(at, linkCode);
      return listLinks(code);
    });
  }
  function deleteLink(code, telegramUserId) {
    if (!TELEGRAM_ID.test(String(telegramUserId))) fail(400, 'Некорректный идентификатор');
    return tx(() => {
      const row = linkOf(String(telegramUserId));
      const user = row ? authStore.getById(row.user_id) : null;
      if (!row || !user || !assigned(user, code) || !isMember(user, code)) fail(404, 'Привязка не найдена');
      db.prepare('DELETE FROM project_chat_telegram_links WHERE telegram_user_id=?').run(row.telegram_user_id);
      // Выданные этому участнику room-токены перестают действовать на следующем же запросе.
      bumpLinkVersion(user.id);
      return listLinks(code);
    });
  }

  return { issues, enabled, handle, session, verifyInitData, roomSession, mintToken, listLinks, createLink, deleteLink };
}

module.exports = { createProjectChatMiniApp, PRODUCTION_PUBLIC_KEY_HEX, SESSION_PATH, TOKEN_TTL_MS, CODE_TTL_MS, REOPEN };
