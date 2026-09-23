'use strict';

// Личный рабочий стол участника. Общий бриф, общий план и чат проекта сюда не копируются.
// Пока нет назначенного обработчика, сообщения только сохраняются: автоматический ответ не обещается.
const { COMPANIES } = require('./auth-store');

const PLATFORMS = Object.freeze(['instagram', 'tiktok', 'youtube', 'vk', 'telegram']);
const FORMATS = Object.freeze(['reel', 'short', 'clip', 'story', 'post', 'carousel']);
const STATUSES = Object.freeze(['idea', 'script', 'recorded']);

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function keys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function shortText(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit || !value.trim()) {
    fail(400, `Проверьте поле «${label}»`);
  }
  return value.trim();
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    fail(400, 'Проверьте дату материала');
  }
  return value;
}
function normalizeEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 42) fail(400, 'В личном плане допускается до 42 материалов');
  const dateCounts = new Map();
  return entries.map((entry) => {
    if (!keys(entry, ['date', 'platform', 'format', 'topic', 'status'])) {
      fail(400, 'Проверьте поля материала личного плана');
    }
    const date = validDate(entry.date);
    const count = (dateCounts.get(date) || 0) + 1;
    dateCounts.set(date, count);
    if (count > 3 || dateCounts.size > 14) {
      fail(400, 'Личный план: до 14 дней и трёх материалов в день');
    }
    if (!PLATFORMS.includes(entry.platform) || !FORMATS.includes(entry.format) ||
        !STATUSES.includes(entry.status)) fail(400, 'Выберите площадку, формат и состояние материала');
    return { date, platform: entry.platform, format: entry.format,
      topic: shortText(entry.topic, 240, 'Тема'), status: entry.status };
  });
}

function createActorWorkspace({ db, authStore, requireSession, requireCsrf, readJson, sendJson,
  now = () => new Date().toISOString() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS actor_workspace_plans (
    company_code TEXT NOT NULL COLLATE NOCASE,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    entries_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(company_code,user_id)
  );
  CREATE TABLE IF NOT EXISTS actor_workspace_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_code TEXT NOT NULL COLLATE NOCASE,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    client_message_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(company_code,user_id,client_message_id)
  );
  CREATE INDEX IF NOT EXISTS actor_workspace_messages_scope_idx
    ON actor_workspace_messages(company_code,user_id,id DESC);`);

  // Не доверяем роли и правам, записанным в cookie: доступ перечитывается из БД каждый раз.
  function access(request, code, permission) {
    const session = requireSession(request);
    const user = authStore.getById(session.user.id);
    if (!user || user.sessionVersion !== session.user.sessionVersion) fail(401, 'Требуется вход в кабинет');
    if (!Object.hasOwn(COMPANIES, code)) fail(404, 'Компания не найдена');
    if (user.role !== 'owner' && (!user.companyCodes.includes(code) ||
        !user.permissions.includes(permission))) fail(403, 'Нет доступа к этому разделу компании');
    return { session, user };
  }
  function plan(code, user) {
    const row = db.prepare(`SELECT revision,entries_json,updated_at FROM actor_workspace_plans
      WHERE company_code=? AND user_id=?`).get(code, user.id);
    return { companyCode: code, actorId: user.id, revision: row?.revision || 0,
      entries: row ? JSON.parse(row.entries_json) : [], updatedAt: row?.updated_at || null,
      // Этот план независим от общего; его статус не разрешает автоматическую публикацию.
      publicationEnabled: false };
  }
  function message(row) {
    return { id: row.id, text: row.text, createdAt: row.created_at };
  }
  function summary(code) {
    // Управляющий видит лишь объём работы, без тем и текста личной переписки.
    const rows = db.prepare(`SELECT u.id actorId,u.display_name actorName,
      COALESCE(p.revision,0) planRevision,p.entries_json entriesJson,
      (SELECT COUNT(*) FROM actor_workspace_messages m WHERE m.company_code=? AND m.user_id=u.id) requests,
      (SELECT MAX(created_at) FROM actor_workspace_messages m WHERE m.company_code=? AND m.user_id=u.id) lastRequestAt
      FROM auth_users u
      JOIN auth_user_companies c ON c.user_id=u.id AND c.company_code=?
      JOIN auth_user_permissions a ON a.user_id=u.id AND a.permission='actor-onboarding.self'
      LEFT JOIN actor_workspace_plans p ON p.company_code=? AND p.user_id=u.id
      ORDER BY u.display_name,u.id`).all(code, code, code, code);
    return { companyCode: code, participants: rows.map((row) => ({ actorId: row.actorId,
      actorName: row.actorName, planRevision: row.planRevision,
      plannedMaterials: row.entriesJson ? JSON.parse(row.entriesJson).length : 0,
      requests: row.requests, lastRequestAt: row.lastRequestAt })) };
  }
  async function handle(request, response, url) {
    const match = /^\/content\/actor-workspace\/(plan|messages|summary)$/.exec(url.pathname);
    if (!match) return false;
    const allowedParams = match[1] === 'messages' && request.method === 'GET'
      ? new Set(['companyCode', 'before', 'limit']) : new Set(['companyCode']);
    if ([...url.searchParams.keys()].some((key) => !allowedParams.has(key))) {
      fail(400, 'Лишние параметры запроса');
    }
    const code = url.searchParams.get('companyCode');
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) fail(400, 'Выберите компанию');
    if (match[1] === 'summary') {
      if (request.method !== 'GET') fail(405, 'Метод не поддерживается');
      access(request, code, 'actor-onboarding.manage');
      sendJson(response, 200, summary(code));
      return true;
    }
    if (match[1] === 'plan') {
      if (!['GET', 'PUT'].includes(request.method)) fail(405, 'Метод не поддерживается');
      const { session, user } = access(request, code, 'actor-onboarding.self');
      if (request.method === 'GET') { sendJson(response, 200, plan(code, user)); return true; }
      requireCsrf(request, session);
      const body = await readJson(request);
      if (!keys(body, ['revision', 'entries']) || !Number.isSafeInteger(body.revision) ||
          body.revision < 0) fail(400, 'Некорректная версия личного плана');
      const entriesJson = JSON.stringify(normalizeEntries(body.entries));
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = db.prepare(`SELECT revision,entries_json FROM actor_workspace_plans
          WHERE company_code=? AND user_id=?`).get(code, user.id);
        if (body.revision !== (previous?.revision || 0)) fail(409, 'Личный план уже изменился. Обновите страницу.');
        if (!previous || previous.entries_json !== entriesJson) {
          db.prepare(`INSERT INTO actor_workspace_plans(company_code,user_id,revision,entries_json,updated_at)
            VALUES(?,?,1,?,?) ON CONFLICT(company_code,user_id) DO UPDATE SET
            revision=actor_workspace_plans.revision+1,entries_json=excluded.entries_json,
            updated_at=excluded.updated_at`).run(code, user.id, entriesJson, now());
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      sendJson(response, 200, plan(code, user));
      return true;
    }
    if (!['GET', 'POST'].includes(request.method)) fail(405, 'Метод не поддерживается');
    const { session, user } = access(request, code, 'actor-onboarding.self');
    if (request.method === 'GET') {
      const beforeValue = url.searchParams.get('before');
      const limitValue = url.searchParams.get('limit');
      const before = beforeValue === null ? null : Number(beforeValue);
      const limit = limitValue === null ? 50 : Number(limitValue);
      if ((before !== null && (!Number.isSafeInteger(before) || before < 1)) ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'Некорректная страница сообщений');
      const rows = db.prepare(`SELECT id,text,created_at FROM actor_workspace_messages
        WHERE company_code=? AND user_id=? AND (? IS NULL OR id<?)
        ORDER BY id DESC LIMIT ?`).all(code, user.id, before, before, limit);
      sendJson(response, 200, { companyCode: code, actorId: user.id,
        messages: rows.reverse().map(message), oldestMessageId: rows[0]?.id || null,
        automatedReplyAvailable: false });
      return true;
    }
    requireCsrf(request, session);
    const body = await readJson(request);
    if (!keys(body, ['text', 'clientMessageId']) ||
        typeof body.clientMessageId !== 'string' ||
        !/^[A-Za-z0-9_-]{8,100}$/.test(body.clientMessageId)) fail(400, 'Некорректный идентификатор сообщения');
    const content = shortText(body.text, 4000, 'Сообщение');
    const existing = db.prepare(`SELECT id,text,created_at FROM actor_workspace_messages
      WHERE company_code=? AND user_id=? AND client_message_id=?`).get(code, user.id, body.clientMessageId);
    if (existing && existing.text !== content) fail(409, 'Этот идентификатор уже использован для другого сообщения');
    if (!existing) db.prepare(`INSERT INTO actor_workspace_messages(company_code,user_id,client_message_id,text,created_at)
      VALUES(?,?,?,?,?)`).run(code, user.id, body.clientMessageId, content, now());
    const stored = db.prepare(`SELECT id,text,created_at FROM actor_workspace_messages
      WHERE company_code=? AND user_id=? AND client_message_id=?`).get(code, user.id, body.clientMessageId);
    sendJson(response, 200, { message: message(stored), automatedReplyAvailable: false,
      status: 'saved', notice: 'Сообщение сохранено. Автоматический ответ пока не подключён.' });
    return true;
  }
  return { handle };
}

module.exports = { createActorWorkspace };
