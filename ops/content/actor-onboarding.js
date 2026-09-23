'use strict';

// Короткий личный опрос участника компании. Он не выдаёт доступ к общему брифу,
// контент-плану, чату, каналам публикации или статистике.
const { COMPANIES } = require('./auth-store');

const CAMERA = Object.freeze(['unknown', 'off_camera', 'small_steps', 'on_camera']);
const VOICE = Object.freeze(['unknown', 'text_only', 'short_voice', 'comfortable']);
const FIELDS = Object.freeze(['direction', 'role', 'cameraComfort', 'voiceComfort', 'boundaries', 'suggestions']);
const EMPTY = Object.freeze({ direction: '', role: '', cameraComfort: 'unknown',
  voiceComfort: 'unknown', boundaries: '', suggestions: '' });
const QUESTIONS = Object.freeze([
  { key: 'direction', label: 'О каком направлении компании вы рассказываете?',
    why: 'Чтобы готовить темы по вашей работе и не смешивать направления.' },
  { key: 'role', label: 'Что вы готовы делать для контента?',
    why: 'Чтобы первые задания соответствовали вашей роли и опыту.' },
  { key: 'cameraComfort', label: 'Насколько вам комфортно быть в кадре?',
    why: 'Чтобы начинать с посильного формата и постепенно привыкать к съёмке.' },
  { key: 'voiceComfort', label: 'Насколько вам комфортно записывать голос?',
    why: 'Чтобы предложить текст, короткую озвучку или разговорный ролик.' },
  { key: 'boundaries', label: 'Какие темы или форматы не следует предлагать?',
    why: 'Чтобы уважать ваши границы при подготовке контента.' },
  { key: 'suggestions', label: 'Что вы предложили бы улучшить?',
    why: 'Чтобы учитывать ваши идеи ещё до составления личного плана.' },
]);

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function cleanText(value, max, name) {
  if (typeof value !== 'string' || value.length > max) fail(400, `Проверьте поле «${name}»`);
  return value.trim();
}
function normalizeProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',')) {
    fail(400, 'Заполните поля личного опроса без дополнительных данных');
  }
  if (!CAMERA.includes(value.cameraComfort) || !VOICE.includes(value.voiceComfort)) {
    fail(400, 'Выберите уровень комфорта для кадра и голоса');
  }
  return { direction: cleanText(value.direction, 200, 'Направление'),
    role: cleanText(value.role, 500, 'Роль'), cameraComfort: value.cameraComfort,
    voiceComfort: value.voiceComfort, boundaries: cleanText(value.boundaries, 2000, 'Ограничения'),
    suggestions: cleanText(value.suggestions, 2000, 'Предложения') };
}

function createActorOnboarding({ db, authStore, requireSession, requireCsrf, readJson, sendJson,
  now = () => new Date().toISOString() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS actor_onboarding_profiles (
    company_code TEXT NOT NULL COLLATE NOCASE,
    user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    profile_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_code, user_id)
  );`);

  // Перечитываем права на каждый запрос: прежняя cookie не сохраняет отозванный доступ.
  function access(request, code, permission) {
    const session = requireSession(request);
    const user = authStore.getById(session.user.id);
    if (!user || user.sessionVersion !== session.user.sessionVersion) fail(401, 'Требуется вход в кабинет');
    if (!Object.hasOwn(COMPANIES, code)) fail(404, 'Компания не найдена');
    if (user.role !== 'owner' && (!user.companyCodes.includes(code) || !user.permissions.includes(permission))) {
      fail(403, 'Нет доступа к этому разделу компании');
    }
    return { session, user };
  }
  function own(code, user) {
    const row = db.prepare(`SELECT revision,profile_json,created_at,updated_at
      FROM actor_onboarding_profiles WHERE company_code=? AND user_id=?`).get(code, user.id);
    return { companyCode: code, actorId: user.id, actorName: user.displayName,
      revision: row?.revision || 0, profile: row ? JSON.parse(row.profile_json) : { ...EMPTY },
      createdAt: row?.created_at || null, updatedAt: row?.updated_at || null, questions: QUESTIONS,
      cameraOptions: CAMERA, voiceOptions: VOICE };
  }
  function summary(code) {
    // Отозванные участники остаются в истории, но не показываются среди текущих.
    const rows = db.prepare(`SELECT p.user_id actorId,u.display_name actorName,p.revision,
      p.profile_json profileJson,p.updated_at updatedAt
      FROM actor_onboarding_profiles p JOIN auth_users u ON u.id=p.user_id
      LEFT JOIN auth_user_companies m ON m.user_id=u.id AND m.company_code=p.company_code
      LEFT JOIN auth_user_permissions a ON a.user_id=u.id AND a.permission='actor-onboarding.self'
      WHERE p.company_code=? AND (u.role='owner' OR (m.user_id IS NOT NULL AND a.user_id IS NOT NULL))
      ORDER BY u.display_name,p.user_id`).all(code);
    const participants = rows.map((row) => {
      const profile = JSON.parse(row.profileJson);
      return { actorId: row.actorId, actorName: row.actorName, revision: row.revision,
        direction: profile.direction, role: profile.role, cameraComfort: profile.cameraComfort,
        voiceComfort: profile.voiceComfort, hasBoundaries: Boolean(profile.boundaries),
        hasSuggestions: Boolean(profile.suggestions), updatedAt: row.updatedAt };
    });
    return { companyCode: code, total: participants.length,
      ready: participants.filter((item) => item.direction && item.role &&
        item.cameraComfort !== 'unknown' && item.voiceComfort !== 'unknown').length,
      participants };
  }
  async function handle(request, response, url) {
    if (!['/content/actor-onboarding', '/content/actor-onboarding/summary'].includes(url.pathname)) return false;
    if ([...url.searchParams.keys()].some((key) => key !== 'companyCode')) fail(400, 'Лишние параметры запроса');
    const code = url.searchParams.get('companyCode');
    if (typeof code !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) fail(400, 'Выберите компанию');
    if (url.pathname.endsWith('/summary')) {
      if (request.method !== 'GET') fail(405, 'Метод не поддерживается');
      access(request, code, 'actor-onboarding.manage');
      sendJson(response, 200, summary(code));
      return true;
    }
    if (!['GET', 'PUT'].includes(request.method)) fail(405, 'Метод не поддерживается');
    const { session, user } = access(request, code, 'actor-onboarding.self');
    if (request.method === 'GET') {
      sendJson(response, 200, own(code, user));
      return true;
    }
    requireCsrf(request, session);
    const body = await readJson(request);
    if (Object.keys(body).sort().join(',') !== 'profile,revision' ||
        !Number.isSafeInteger(body.revision) || body.revision < 0) fail(400, 'Некорректная версия опроса');
    const profile = normalizeProfile(body.profile);
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = db.prepare(`SELECT revision,profile_json FROM actor_onboarding_profiles
        WHERE company_code=? AND user_id=?`).get(code, user.id);
      const revision = old?.revision || 0;
      if (body.revision !== revision) fail(409, 'Ответы уже изменились. Обновите страницу.');
      if (!old || old.profile_json !== JSON.stringify(profile)) {
        const at = now();
        db.prepare(`INSERT INTO actor_onboarding_profiles
          (company_code,user_id,revision,profile_json,created_at,updated_at)
          VALUES(?,?,1,?,?,?) ON CONFLICT(company_code,user_id) DO UPDATE SET
          revision=actor_onboarding_profiles.revision+1,profile_json=excluded.profile_json,
          updated_at=excluded.updated_at`).run(code, user.id, JSON.stringify(profile), at, at);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    sendJson(response, 200, own(code, user));
    return true;
  }
  return { handle };
}

module.exports = { createActorOnboarding };
